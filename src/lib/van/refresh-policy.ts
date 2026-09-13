// When to ask VAN to re-cut a region, and when to leave it alone.
//
// VAN owns "which doors are left" (plan.md §2 Constraint C): a Map Region
// refresh re-runs the region against current data, contacted doors fall out of
// its routes, and the door counts we read afterwards are the answer. This
// module decides which refreshes to send on a given tick. Pure — no DB, no
// client, no clock of its own — so the rules an organizer would ask about
// ("why is this county's count from yesterday?") are answerable from a unit
// test.
//
// Three inputs shape every decision:
//
//   1. A refresh is not free and VAN publishes no cost or rate limit for it, so
//      we self-impose one: never more than once an hour per region (Story 4.2).
//   2. A refresh rotates route ids (Story 4.6, verified live) — it is closer to
//      "replace this region's turf" than to "update these numbers". That makes
//      it something to do on a schedule and after a completion, not something
//      to do eagerly.
//   3. Re-cutting a region under a volunteer who is walking it is the failure
//      worth avoiding, which is what the deferral below is for.

import { campaignHour } from '../campaign-time.js';

/** Never re-cut the same region more often than this, by either path. VAN
 *  publishes no limit, so this is ours to pick and ours to keep. */
export const MIN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** How stale a region's last refresh must be before the nightly sweep takes an
 *  interest. Twenty hours rather than twenty-four so the sweep does not drift
 *  a little later every night and eventually fall out of its window. */
export const NIGHTLY_REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;

/**
 * The campaign-local hours the nightly sweep is allowed to run in, `[start, end)`.
 *
 * A refresh rotates route ids, so anyone holding turf in that region loses
 * their claim to the retirement path and has to be told (see
 * refresh-reconcile.ts). Doing that at 02:00 costs a volunteer a DM they read
 * over breakfast; doing it at 14:00 on a Saturday costs them the block they are
 * standing on.
 */
export const NIGHTLY_WINDOW_START_HOUR = 1;
export const NIGHTLY_WINDOW_END_HOUR = 5;

/**
 * Refresh requests one tick may send.
 *
 * The sync endpoint runs 37 times a day and shares one five-minute budget with
 * the catalog and the geometry queue, so this is a fairness cap rather than a
 * throughput target: anything not sent stays wanted and goes out on the next
 * tick, half an hour later at worst.
 */
export const MAX_REFRESH_REQUESTS_PER_RUN = 6;

/**
 * How long a refresh may stay "in flight" before we stop waiting for it.
 *
 * The in-flight flag clears when VAN's own `dateRefreshed` moves past the
 * request, which is the honest signal. But nothing guarantees VAN populates
 * that field on every key — the demo key returns regions without it — and a
 * flag that can only be cleared by evidence that may never arrive would mark a
 * region as updating forever. Six hours is long enough that a slow re-cut still
 * clears itself the honest way.
 */
export const IN_FLIGHT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** One region, as this module needs to see it. */
export interface RegionRefreshState {
	folderId: number;
	mapRegionId: number;
	/** When we last POSTed a refresh for this region, by either path. */
	lastRequestAt: string | null;
	/** Set when a volunteer completed turf here and the region has not been
	 *  re-cut since. Null means nothing is pending on demand. */
	requestedAt: string | null;
	/** Set while a POST is awaiting evidence it landed. */
	inFlightSince: string | null;
	/** Live claims on turf in this region. The deferral turns on this. */
	activeClaims: number;
}

export interface RefreshSweepPlan {
	/** Folder-wide POSTs — the nightly sweep. */
	nightlyFolderIds: number[];
	/** The regions those folder-wide POSTs cover, so the caller can stamp them
	 *  all as requested. VAN re-cuts every region in the folder, and a stamp on
	 *  only some of them would let the throttle fire twice for one call. */
	nightlyRegions: Array<{ folderId: number; mapRegionId: number }>;
	/** Per-region POSTs — the on-demand path, after a completion. */
	onDemandRegions: Array<{ folderId: number; mapRegionId: number }>;
	/** Wanted, but held back because volunteers are still out in them. Reported
	 *  rather than silently skipped: a region that defers for days is a region
	 *  whose counts are stale for a reason someone may want to know. */
	deferredRegions: Array<{ folderId: number; mapRegionId: number; activeClaims: number }>;
	/** In-flight flags that have timed out and should be cleared. */
	staleInFlight: Array<{ folderId: number; mapRegionId: number }>;
}

export interface RefreshSweepOptions {
	now: Date;
	minIntervalMs?: number;
	nightlyAfterMs?: number;
	maxRequests?: number;
	inFlightTimeoutMs?: number;
	/** Overrides the campaign-clock check. The nightly sweep is the one rule
	 *  here that depends on what time it is, and a caller that has already
	 *  decided (a manual "refresh now" from an operator, a test) should not have
	 *  to mock a timezone to say so. */
	nightly?: boolean;
}

function msSince(iso: string | null, now: Date): number | null {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	return now.getTime() - then;
}

/** True when this region was refreshed recently enough that asking again would
 *  be churn. An unparseable timestamp counts as "long ago" — the same rule
 *  isActive() uses — so a corrupt row is retried rather than frozen. */
function throttled(region: RegionRefreshState, now: Date, minIntervalMs: number): boolean {
	const age = msSince(region.lastRequestAt, now);
	if (age === null) return false;
	return age < minIntervalMs;
}

/** True when the campaign clock is inside the overnight window. */
export function isNightlyWindow(now: Date): boolean {
	const hour = campaignHour(now);
	if (hour === null) return false;
	return hour >= NIGHTLY_WINDOW_START_HOUR && hour < NIGHTLY_WINDOW_END_HOUR;
}

/**
 * Decide this tick's refresh requests.
 *
 * Two paths, and they are deliberately different shapes:
 *
 * **On demand** — one region, POSTed to `.../mapRegions/{id}/refresh`, because
 * a volunteer just finished walking turf in it and the next volunteer to look
 * should see the doors they cleared. Deferred while anyone else still holds
 * turf in that region: a re-cut retires their route out from under them, and
 * the nightly sweep will pick the region up anyway once they are done. This is
 * Story 4.5's second recommendation, and it is why the volunteer page never
 * needs to block.
 *
 * **Nightly** — the whole folder, POSTed once to `.../mapRegions/refresh`.
 * (Story 4.4 calls these "region-level" and "route-level"; VAN has no
 * route-level refresh, so the honest mapping is folder-wide for the sweep and
 * per-region for the on-demand path. The intent — coarse on a schedule, narrow
 * on demand — survives.) One call re-cuts every region in the folder, so a
 * folder of forty regions costs one request rather than forty.
 *
 * On-demand requests are filled first when the cap bites. Someone is waiting on
 * those; the sweep is happy to run half an hour later.
 */
export function planRefreshSweep(
	regions: readonly RegionRefreshState[],
	options: RefreshSweepOptions,
): RefreshSweepPlan {
	const {
		now,
		minIntervalMs = MIN_REFRESH_INTERVAL_MS,
		nightlyAfterMs = NIGHTLY_REFRESH_AFTER_MS,
		maxRequests = MAX_REFRESH_REQUESTS_PER_RUN,
		inFlightTimeoutMs = IN_FLIGHT_TIMEOUT_MS,
		nightly = isNightlyWindow(now),
	} = options;

	const staleInFlight = regions
		.filter((r) => {
			const age = msSince(r.inFlightSince, now);
			return r.inFlightSince !== null && (age === null || age > inFlightTimeoutMs);
		})
		.map((r) => ({ folderId: r.folderId, mapRegionId: r.mapRegionId }));

	const onDemandRegions: Array<{ folderId: number; mapRegionId: number }> = [];
	const deferredRegions: Array<{ folderId: number; mapRegionId: number; activeClaims: number }> =
		[];
	let budget = maxRequests;

	for (const region of regions) {
		if (region.requestedAt === null) continue;
		if (throttled(region, now, minIntervalMs)) continue;
		if (region.activeClaims > 0) {
			deferredRegions.push({
				folderId: region.folderId,
				mapRegionId: region.mapRegionId,
				activeClaims: region.activeClaims,
			});
			continue;
		}
		// Counted against the budget only when it is actually sent, so a tick
		// full of deferrals still leaves room for the nightly sweep.
		if (budget <= 0) continue;
		budget -= 1;
		onDemandRegions.push({ folderId: region.folderId, mapRegionId: region.mapRegionId });
	}

	const nightlyFolderIds: number[] = [];
	const nightlyRegions: Array<{ folderId: number; mapRegionId: number }> = [];

	if (nightly) {
		const byFolder = new Map<number, RegionRefreshState[]>();
		for (const region of regions) {
			const list = byFolder.get(region.folderId);
			if (list) list.push(region);
			else byFolder.set(region.folderId, [region]);
		}

		for (const [folderId, folderRegions] of byFolder) {
			if (budget <= 0) break;
			// One throttled region vetoes the folder-wide call, because the call
			// cannot be narrowed: VAN re-cuts everything in the folder or nothing.
			// Better a folder that waits an hour than one region re-cut twice in
			// ten minutes because another region in it was overdue.
			if (folderRegions.some((r) => throttled(r, now, minIntervalMs))) continue;
			const due = folderRegions.some((r) => {
				const age = msSince(r.lastRequestAt, now);
				return age === null || age >= nightlyAfterMs;
			});
			if (!due) continue;
			budget -= 1;
			nightlyFolderIds.push(folderId);
			for (const region of folderRegions) {
				nightlyRegions.push({ folderId, mapRegionId: region.mapRegionId });
			}
		}
	}

	return { nightlyFolderIds, nightlyRegions, onDemandRegions, deferredRegions, staleInFlight };
}
