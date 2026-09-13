// Asking VAN to re-cut regions, and keeping track of what we asked for.
//
// The rules live in $lib/van/refresh-policy.ts and are pure; this file is the
// part that touches rows and the VAN client. Called from
// /api/internal/van-sync, which already runs on a schedule and already holds a
// lock — a second cron would mean a second lock and two runs re-cutting the
// same region at once.
//
// The awkward property this module exists to manage: **a refresh is
// asynchronous and VAN never tells us it finished.** `POST .../refresh` returns
// 200 immediately, the re-cut happens on VAN's side at its own pace, and the
// only evidence it landed is that the region's `dateRefreshed` moves — which we
// see on a LATER catalog read. So the request and its confirmation happen in
// different ticks, and the bookkeeping between them is van_region_refreshes.
//
// Story 4.1 is explicit about the trap: do not re-read counts in the same
// request. Nothing here does.

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { vanRegionRefreshes, vanTurfCheckouts, vanTurfs } from '../schema.js';
import type { VanClient } from './client.js';
import {
	planRefreshSweep,
	type RefreshSweepPlan,
	type RegionRefreshState,
} from '../../van/refresh-policy.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

/** Below this there is no point starting: a POST that the request budget kills
 *  mid-flight would be stamped as sent without VAN having heard it. */
const MIN_SWEEP_BUDGET_MS = 5 * 1000;

export interface RefreshSweepResult {
	/** Folder-wide nightly calls that VAN accepted. */
	nightlyFolders: number[];
	/** Per-region on-demand calls that VAN accepted. */
	regionsRefreshed: number;
	/** Wanted, but volunteers are still out in them. */
	regionsDeferred: number;
	/** Calls VAN rejected. Each is throttled like a success, so a region VAN
	 *  keeps refusing is retried hourly rather than every tick. */
	failed: number;
	/** In-flight flags cleared because VAN never showed evidence of the re-cut. */
	staleCleared: number;
	warnings: string[];
}

export interface RefreshSweepOptions {
	now?: Date;
	timeBudgetMs?: number;
	/** Force the nightly sweep regardless of the campaign clock. The manual
	 *  "refresh everything now" an operator runs from a script. */
	nightly?: boolean;
	maxRequests?: number;
}

/**
 * Every region we know about, with the state the policy judges it on.
 *
 * Regions come from van_turfs rather than from a table of their own: a region
 * exists, as far as this app is concerned, exactly when it has turf in it.
 * Retired turf is excluded, so a region whose routes have all been retired
 * stops being swept — which is right, because a folder-wide refresh would
 * resurrect nothing and the region may not exist in VAN any more either.
 */
export async function loadRegionStates(db: Db): Promise<RegionRefreshState[]> {
	const regions = await db
		.selectDistinct({ folderId: vanTurfs.folderId, mapRegionId: vanTurfs.mapRegionId })
		.from(vanTurfs)
		.where(isNull(vanTurfs.retiredAt));
	if (regions.length === 0) return [];

	const bookkeeping = await db.select().from(vanRegionRefreshes);
	const byKey = new Map(bookkeeping.map((r) => [`${r.folderId}:${r.mapRegionId}`, r]));

	// One grouped count rather than a query per region: a chapter can run to
	// dozens of regions and this is on the sync's hot path.
	const claimCounts = await db
		.select({ mapRegionId: vanTurfs.mapRegionId, claims: sql<number>`count(*)` })
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt)))
		.groupBy(vanTurfs.mapRegionId);
	const claimsByRegion = new Map(claimCounts.map((r) => [r.mapRegionId, Number(r.claims)]));

	return regions.map((region) => {
		const row = byKey.get(`${region.folderId}:${region.mapRegionId}`);
		return {
			folderId: region.folderId,
			mapRegionId: region.mapRegionId,
			lastRequestAt: row?.lastRequestAt ?? null,
			requestedAt: row?.requestedAt ?? null,
			inFlightSince: row?.inFlightSince ?? null,
			activeClaims: claimsByRegion.get(region.mapRegionId) ?? 0,
		};
	});
}

/**
 * Ask for an on-demand refresh of one region.
 *
 * Called when a volunteer marks turf complete: the doors they cleared should
 * leave the count before the next person looks at that region. It records a
 * want rather than sending anything, for two reasons — the volunteer's request
 * must not wait on a VAN round-trip, and the policy may decide to defer it
 * because other people are still out in that region (Story 4.5.2).
 *
 * Never throws. A completion that has already been written to the ledger must
 * not fail because the bookkeeping around it did.
 */
export async function requestRegionRefresh(
	db: Db,
	input: { folderId: number; mapRegionId: number; now: Date },
): Promise<void> {
	const { folderId, mapRegionId, now } = input;
	try {
		await db
			.insert(vanRegionRefreshes)
			.values({ folderId, mapRegionId, requestedAt: now.toISOString() })
			.onConflictDoUpdate({
				target: [vanRegionRefreshes.folderId, vanRegionRefreshes.mapRegionId],
				// Only the want is set. Deliberately NOT clearing lastRequestAt or
				// inFlightSince: a second completion in the same hour is the same
				// want, and resetting the throttle would let a busy Saturday morning
				// re-cut one region every few minutes.
				set: { requestedAt: now.toISOString() },
			});
	} catch (err) {
		console.error(
			`${LOG} could not record a refresh request for region ${mapRegionId}:`,
			errMessage(err),
		);
	}
}

/** Regions with a refresh in flight. The turf page marks their turf as
 *  updating — a soft per-turf state, never a page-wide block (Story 4.5.4). */
export async function refreshingRegionIds(db: Db): Promise<Set<number>> {
	const rows = await db
		.select({ mapRegionId: vanRegionRefreshes.mapRegionId })
		.from(vanRegionRefreshes)
		.where(isNotNull(vanRegionRefreshes.inFlightSince));
	return new Set(rows.map((r) => r.mapRegionId));
}

/**
 * Close out refreshes VAN has finished.
 *
 * `dateRefreshed` is VAN's own answer to "when were these counts recomputed"
 * (see the field's note in types.ts). When it moves past the moment we asked,
 * the re-cut has landed: the in-flight flag clears, the turf page stops saying
 * "updating", and the freshness label the volunteer reads is VAN's timestamp
 * rather than ours. It is not copied into this table — van_turfs.lastRefreshedAt
 * already carries it per turf, and a second copy would be one more thing to
 * keep in step.
 *
 * A key that never populates `dateRefreshed` — the demo key does not — simply
 * never clears a flag this way, which is what the policy's timeout is for.
 *
 * Takes the regions the catalog just read, so this is free of extra VAN calls:
 * the confirmation rides along on the read the sync was doing anyway.
 */
export async function settleRefreshes(
	db: Db,
	observed: ReadonlyArray<{ folderId: number; mapRegionId: number; dateRefreshed: string | null }>,
): Promise<number> {
	if (observed.length === 0) return 0;

	const rows = await db
		.select()
		.from(vanRegionRefreshes)
		.where(isNotNull(vanRegionRefreshes.inFlightSince));
	if (rows.length === 0) return 0;
	const inFlight = new Map(rows.map((r) => [`${r.folderId}:${r.mapRegionId}`, r]));

	let settled = 0;
	for (const region of observed) {
		const row = inFlight.get(`${region.folderId}:${region.mapRegionId}`);
		if (!row?.inFlightSince || !region.dateRefreshed) continue;

		const refreshedAt = Date.parse(region.dateRefreshed);
		const requestedAt = Date.parse(row.inFlightSince);
		// Strictly after the request. A region reporting the same dateRefreshed
		// it had before we asked has not been re-cut yet, and clearing the flag on
		// that would say "up to date" about counts VAN has not touched.
		if (Number.isNaN(refreshedAt) || Number.isNaN(requestedAt) || refreshedAt <= requestedAt) {
			continue;
		}

		await db
			.update(vanRegionRefreshes)
			.set({ inFlightSince: null })
			.where(
				and(
					eq(vanRegionRefreshes.folderId, region.folderId),
					eq(vanRegionRefreshes.mapRegionId, region.mapRegionId),
				),
			);
		settled += 1;
		console.log(
			`${LOG} refresh landed: region=${region.mapRegionId} requested=${row.inFlightSince} ` +
				`refreshed=${region.dateRefreshed}`,
		);
	}

	return settled;
}

/** Stamp a request against every region a call covered. */
async function stampRequested(
	db: Db,
	regions: ReadonlyArray<{ folderId: number; mapRegionId: number }>,
	kind: 'nightly' | 'completion',
	now: Date,
	error: string | null,
): Promise<void> {
	const nowIso = now.toISOString();
	for (const region of regions) {
		// A failed call stamps lastRequestAt exactly as a successful one does, so
		// the hourly throttle applies to failures too — otherwise a region VAN
		// refuses would be asked 37 times a day forever. What it does NOT do is
		// clear `requestedAt`: the want survives, and the retry happens an hour
		// later rather than never.
		const set = error
			? { lastRequestAt: nowIso, lastRequestKind: kind, lastError: error, lastErrorAt: nowIso }
			: {
					lastRequestAt: nowIso,
					lastRequestKind: kind,
					requestedAt: null,
					inFlightSince: nowIso,
					lastError: null,
					lastErrorAt: null,
				};
		await db
			.insert(vanRegionRefreshes)
			.values({ folderId: region.folderId, mapRegionId: region.mapRegionId, ...set })
			.onConflictDoUpdate({
				target: [vanRegionRefreshes.folderId, vanRegionRefreshes.mapRegionId],
				set,
			});
	}
}

/** Regions in a folder, for stamping a folder-wide call. */
function regionsInFolder(
	plan: RefreshSweepPlan,
	folderId: number,
): Array<{ folderId: number; mapRegionId: number }> {
	return plan.nightlyRegions.filter((r) => r.folderId === folderId);
}

/**
 * Send this tick's refresh requests.
 *
 * Failures are per-call and never throw: a folder whose refresh VAN rejects
 * leaves every other folder's alone, and the sync that already wrote its
 * catalog rows still returns 200. Refreshing is how counts get better, not how
 * they get written.
 */
export async function runRefreshSweep(
	db: Db,
	client: VanClient,
	options: RefreshSweepOptions = {},
): Promise<RefreshSweepResult> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.timeBudgetMs ?? 30_000);
	const warnings: string[] = [];

	const regions = await loadRegionStates(db);
	const plan = planRefreshSweep(regions, {
		now,
		nightly: options.nightly,
		maxRequests: options.maxRequests,
	});

	let staleCleared = 0;
	for (const region of plan.staleInFlight) {
		await db
			.update(vanRegionRefreshes)
			.set({ inFlightSince: null })
			.where(
				and(
					eq(vanRegionRefreshes.folderId, region.folderId),
					eq(vanRegionRefreshes.mapRegionId, region.mapRegionId),
				),
			);
		staleCleared += 1;
		console.warn(
			`${LOG} refresh for region ${region.mapRegionId} never showed up in VAN's dateRefreshed — ` +
				'clearing the in-flight flag',
		);
	}

	let regionsRefreshed = 0;
	let failed = 0;
	const nightlyFolders: number[] = [];

	// On demand first, matching the policy's ordering: somebody is waiting on
	// these, and the sweep is happy to run half an hour later.
	for (const region of plan.onDemandRegions) {
		if (Date.now() + MIN_SWEEP_BUDGET_MS > deadline) break;
		try {
			await client.refreshMapRegion(region.folderId, region.mapRegionId);
			await stampRequested(db, [region], 'completion', now, null);
			regionsRefreshed += 1;
			console.log(`${LOG} refresh requested: region=${region.mapRegionId} (completion)`);
		} catch (err) {
			failed += 1;
			const detail = errMessage(err);
			await stampRequested(db, [region], 'completion', now, detail);
			warnings.push(`Refresh of region ${region.mapRegionId} failed: ${detail}`);
			console.error(`${LOG} refresh of region ${region.mapRegionId} failed:`, detail);
		}
	}

	for (const folderId of plan.nightlyFolderIds) {
		if (Date.now() + MIN_SWEEP_BUDGET_MS > deadline) break;
		const covered = regionsInFolder(plan, folderId);
		try {
			// No region id: the folder-wide form re-cuts every region in it, which
			// is one call instead of one per region (Story 4.4).
			await client.refreshMapRegion(folderId);
			await stampRequested(db, covered, 'nightly', now, null);
			nightlyFolders.push(folderId);
			console.log(`${LOG} nightly refresh requested: folder=${folderId} regions=${covered.length}`);
		} catch (err) {
			failed += 1;
			const detail = errMessage(err);
			await stampRequested(db, covered, 'nightly', now, detail);
			warnings.push(`Nightly refresh of folder ${folderId} failed: ${detail}`);
			console.error(`${LOG} nightly refresh of folder ${folderId} failed:`, detail);
		}
	}

	if (plan.deferredRegions.length > 0) {
		console.log(
			`${LOG} deferred ${plan.deferredRegions.length} refresh(es) — volunteers are still out in those regions`,
		);
	}

	return {
		nightlyFolders,
		regionsRefreshed,
		regionsDeferred: plan.deferredRegions.length,
		failed,
		staleCleared,
		warnings,
	};
}
