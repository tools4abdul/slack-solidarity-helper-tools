// The one place a van_turfs row becomes something the browser may see.
//
// Every field the volunteer page renders is built here, and nothing reaches
// the payload that does not pass through this function. That is the whole
// point: hiding a field in a template does not hide it — SvelteKit serialises
// the load function's return value into the SSR payload, where anyone can read
// it in devtools. The payload is the boundary, so the boundary needs one
// gate, not a rule each route remembers to follow.
//
// Three things are deliberately withheld:
//
//   1. Anything address-like. Nothing per-person is stored in the first place
//      (the export job requests coordinates only, reduces them to a hull, and
//      drops the rows), so there is nothing here to leak — but the test file
//      asserts it rather than trusting the pipeline upstream to stay that way.
//   2. The holder's name, for non-admins. See turf-status.ts.
//   3. The MiniVAN list number, unless you hold the turf. See below.

import { boundingBox, type BoundingBox, type LatLng } from './geometry.js';
import {
	canClaim,
	hoursRemaining,
	turfStatus,
	activeClaimFor,
	type ClaimOptions,
	type ClaimSnapshot,
} from './checkout.js';
import { visibleTurfState, type VolunteerStatus } from './turf-status.js';

/** The van_turfs columns this module reads. Narrow on purpose: the row type
 *  can grow without widening what the browser can be shown. */
export interface TurfRowInput {
	mapRouteId: number;
	mapRegionId: number;
	chapterId: number;
	name: string;
	regionName: string;
	printedListNumber: string | null;
	routeSize: number;
	doorCount: number;
	centroidLat: number | null;
	centroidLng: number | null;
	hullJson: string | null;
	vanDistributedTo: string | null;
	retiredAt: string | null;
	lastRefreshedAt: string | null;
}

export interface TurfView {
	mapRouteId: number;
	chapterId: number;
	name: string;
	regionName: string;
	/**
	 * The MiniVAN list number — **only on turf you currently hold**, null on
	 * everything else.
	 *
	 * This is access control, not tidiness. The number is the credential: it is
	 * what a volunteer types into MiniVAN to pull the doors down. Shipping it
	 * for every turf on the map would let anyone load any turf regardless of
	 * who holds it, which makes the checkout ledger advisory — two people on
	 * the same block is precisely the failure this feature exists to prevent.
	 * So the number is issued at claim time and withdrawn on release.
	 */
	printedListNumber: string | null;
	/** People in the list. */
	routeSize: number;
	/** Doors VAN still shows as uncontacted, as of `refreshedMinutesAgo`. */
	doorsRemaining: number;
	/** Hull vertices, or [] when geometry is missing or was degenerate. */
	hull: LatLng[];
	/** Null when the turf has no geometry at all — it is still listed, just
	 *  not mappable. See `mappableTurfs`. */
	centre: LatLng | null;
	bounds: BoundingBox | null;
	status: VolunteerStatus;
	/** Non-null only for admins. */
	heldBy: string | null;
	/** Hours until the claim lapses — yours, or any claim if you're an admin. */
	expiresInHours: number | null;
	/** How stale the door count is, from VAN's own region refresh timestamp.
	 *  Null when VAN has never reported one. */
	refreshedMinutesAgo: number | null;
	/** Whether the claim button should be live. */
	claimable: boolean;
	/**
	 * Why it isn't, when the turf looks available but still can't be taken —
	 * no list number, no doors left, or you're at your claim limit. The message
	 * is written for the volunteer; see canClaim in checkout.ts.
	 *
	 * OMITTED, not null, when there is nothing to say. On turf that is visibly
	 * checked out the status already explains itself, and `JSON.stringify`
	 * drops an undefined property entirely — which on a thousand-turf chapter
	 * is the key name saved a thousand times. Per-row keys are about half the
	 * payload weight at that scale (plan.md 6.2b), so this is where the bytes
	 * actually are.
	 */
	claimBlockedReason?: string;
	/**
	 * True when VAN is re-cutting the region this turf is in.
	 *
	 * A soft, per-turf state, and deliberately not a block. Story 4.5 rejects
	 * freezing the page during a refresh: the instinct protects only the people
	 * who would have claimed during the window, while the stale-number exposure
	 * spans the whole claim — and an on-demand refresh fires on completion, so a
	 * Saturday morning of volunteers finishing turf would keep the page dark
	 * exactly when it is busiest. The turf stays claimable; this says only that
	 * its door count is about to move.
	 *
	 * Omitted rather than false when it does not apply, like `retired` below:
	 * a refresh touches one region at a time and every other row should not pay
	 * a key name for it.
	 */
	updating?: true;
	/**
	 * True when VAN no longer has this route — an organizer re-cut the area.
	 *
	 * Retired turf is normally filtered out of the payload entirely. It reaches
	 * the browser in exactly one case: you are still holding a claim on it. The
	 * schema keeps the row for that reason ("stamped, never deleted, so a live
	 * checkout pointing at it still renders"), because the alternative is a
	 * volunteer's turf and its list number silently vanishing from their own
	 * page while they are standing on the street with it.
	 *
	 * Omitted rather than false when it does not apply, like
	 * `claimBlockedReason` — this is the rare case, and the common one should
	 * not pay for it on every row.
	 */
	retired?: true;
}

/** Claim rules, plus the one piece of state that is about the turf rather than
 *  about the viewer: which regions VAN is currently re-cutting. */
export type TurfViewOptions = ClaimOptions & {
	/** Map region ids with a refresh in flight. See `TurfView.updating`. */
	refreshingRegions?: ReadonlySet<number>;
};

/** A turf that can actually be drawn. */
export type MappableTurf = TurfView & { centre: LatLng; bounds: BoundingBox };

/** Turfs with geometry, for the map. The list view takes the unfiltered set —
 *  it is the accessible path, the mobile-data-saving path, and the one that
 *  still works before the geometry pipeline has run (or at all, on a key
 *  without export-job access). */
export function mappableTurfs(turfs: readonly TurfView[]): MappableTurf[] {
	return turfs.filter((t): t is MappableTurf => t.centre !== null && t.bounds !== null);
}

/** Parse a stored hull. Never throws: a corrupt or hand-edited hullJson must
 *  degrade to "no shape, draw a pin", not take the whole page down. */
export function parseHull(hullJson: string | null): LatLng[] {
	if (!hullJson) return [];
	try {
		const parsed: unknown = JSON.parse(hullJson);
		if (!Array.isArray(parsed)) return [];
		const points: LatLng[] = [];
		for (const item of parsed) {
			const point = item as { lat?: unknown; lng?: unknown };
			if (typeof point?.lat !== 'number' || typeof point?.lng !== 'number') return [];
			if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return [];
			points.push({ lat: point.lat, lng: point.lng });
		}
		return points;
	} catch {
		return [];
	}
}

function minutesSince(iso: string | null, now: Date): number | null {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	// Clamped at zero: a clock skew between VAN and us must not render as
	// "refreshed in -3 minutes".
	return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

/** Centre and bounds for a turf, from its hull when it has one and its stored
 *  centroid otherwise. A centroid alone still places a pin. */
function geometryFor(
	row: TurfRowInput,
	hull: LatLng[],
): { centre: LatLng | null; bounds: BoundingBox | null } {
	const bounds = boundingBox(hull);
	if (bounds) {
		return {
			centre: {
				lat: (bounds.minLat + bounds.maxLat) / 2,
				lng: (bounds.minLng + bounds.maxLng) / 2,
			},
			bounds,
		};
	}
	if (row.centroidLat !== null && row.centroidLng !== null) {
		const centre = { lat: row.centroidLat, lng: row.centroidLng };
		return { centre, bounds: boundingBox([centre]) };
	}
	return { centre: null, bounds: null };
}

/**
 * Build the browser-visible view of one turf.
 *
 * `claims` is every claim relevant to the chapter being served, not just this
 * turf's — the claim-limit rule needs to know how much the viewer is already
 * holding.
 */
export function toTurfView(
	row: TurfRowInput,
	claims: readonly ClaimSnapshot[],
	viewer: { slackUserId: string; isAdmin: boolean },
	now: Date,
	options: TurfViewOptions = {},
): TurfView {
	const snapshot = {
		mapRouteId: row.mapRouteId,
		printedListNumber: row.printedListNumber,
		retiredAt: row.retiredAt,
		vanDistributedTo: row.vanDistributedTo,
		doorCount: row.doorCount,
	};

	const rawStatus = turfStatus(snapshot, claims, viewer.slackUserId, now);
	const active = activeClaimFor(row.mapRouteId, claims, now);
	const visible = visibleTurfState(
		{
			status: rawStatus,
			heldBy: active?.slackUserName ?? row.vanDistributedTo,
			expiresInHours: active ? hoursRemaining(active, now) : null,
		},
		viewer,
	);

	const decision = canClaim(snapshot, claims, viewer.slackUserId, now, options);
	const hull = parseHull(row.hullJson);
	const { centre, bounds } = geometryFor(row, hull);

	return {
		mapRouteId: row.mapRouteId,
		chapterId: row.chapterId,
		name: row.name,
		regionName: row.regionName,
		// Issued only while you hold it — see the field's own note.
		printedListNumber: visible.status === 'held-by-you' ? row.printedListNumber : null,
		routeSize: row.routeSize,
		doorsRemaining: row.doorCount,
		hull,
		centre,
		bounds,
		status: visible.status,
		heldBy: visible.heldBy,
		expiresInHours: visible.expiresInHours,
		refreshedMinutesAgo: minutesSince(row.lastRefreshedAt, now),
		claimable: decision.ok,
		...(decision.ok || visible.status !== 'available'
			? {}
			: { claimBlockedReason: decision.message }),
		...(options.refreshingRegions?.has(row.mapRegionId) ? { updating: true as const } : {}),
		...(row.retiredAt ? { retired: true as const } : {}),
	};
}
