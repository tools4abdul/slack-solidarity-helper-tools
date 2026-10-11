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

import { boundingBox, hullAreaSquareMeters, type BoundingBox, type LatLng } from './geometry.js';
import {
	canClaim,
	hoursRemaining,
	turfStatus,
	activeClaimFor,
	DEFAULT_VAN_ASSIGNMENT_TTL_HOURS,
	VAN_ASSIGNMENT_NEVER_RELEASED,
	type ClaimOptions,
	type ClaimSnapshot,
	type TurfSnapshot,
} from './checkout.js';
import { visibleTurfState, type VolunteerStatus } from './turf-status.js';
import { campaignDayLabel } from '../campaign-time.js';
import type { HolderAccount } from '../holder-account.js';

/** The van_turfs columns this module reads. Narrow on purpose: the row type
 *  can grow without widening what the browser can be shown. */
export interface TurfRowInput {
	turfId: number;
	/** Which campaign the turf was read from. Region ids are VAN's, so a
	 *  region is only identified by the pair (see regionRefreshKey). */
	campaignId: number;
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
	/** When `vanDistributedTo` was last handed the list. Optional so fixtures
	 *  predating the expiry need not name it. */
	vanAssignedAt?: string | null;
	/** Who the campaign's Packet Tracker says has it. Optional so fixtures
	 *  predating the tracker need not name it. */
	sheetAssignedTo?: string | null;
	retiredAt: string | null;
	/** When an admin hid it from volunteers. Optional so fixtures predating
	 *  it need not name it. */
	hiddenAt?: string | null;
	lastRefreshedAt: string | null;
	/** Doors with no in-person contact since the cut, from ContactHistory
	 *  (van/contact-sync.ts). Optional so fixtures predating it need not name
	 *  it; null until the turf has a roster. */
	uncontactedDoors?: number | null;
	uncontactedDoorsAt?: string | null;
	/** The saved list VAN cut this route from, and the one its roster was
	 *  built from. The count only describes this cut when the two agree. */
	savedListId?: number | null;
	rosterSavedListId?: number | null;
}

type CountedRow = Pick<
	TurfRowInput,
	'doorCount' | 'uncontactedDoors' | 'savedListId' | 'rosterSavedListId'
>;

/**
 * The ContactHistory count, or null when there is none or it describes some
 * other cut. Checked here as well as by the recompute, because the recompute
 * only runs on the sync's schedule: between a re-cut and the next run, or
 * after the feature is switched off, the stored number is not this turf's.
 */
export function currentUncontacted(row: CountedRow): number | null {
	if (row.uncontactedDoors == null || row.savedListId == null) return null;
	return row.rosterSavedListId === row.savedListId ? row.uncontactedDoors : null;
}

/**
 * Whether a filled-in Packet Tracker row still keeps this turf from being
 * claimed. Only while we cannot see what is left: once the ContactHistory count
 * says doors remain uncontacted, a name in the campaign's sheet does not mean
 * the doors are being knocked, and the turf goes back in the pool. (VAN's own
 * record of an outside hand-out, `vanDistributedTo`, still blocks.)
 */
export function sheetBlocksClaim(row: CountedRow): boolean {
	const left = currentUncontacted(row);
	return left === null || left <= 0;
}

/**
 * Whether a hand-out outside this app still keeps the turf from being claimed.
 *
 * For `ttlHours` after the last export, always (the admin setting, resolved by
 * resolveClaimOptions), and for good when that is
 * VAN_ASSIGNMENT_NEVER_RELEASED. After that, only
 * while we cannot see what is left: once there is an uncontacted count, the
 * turf goes back in the pool showing just the doors its holder did not reach,
 * so the next volunteer is not sent to re-knock theirs. Without a count it
 * would come back at VAN's full doorCount, so it stays out as before. So does
 * a hand-out with no date, which there is no clock to run on.
 */
export function vanAssignmentBlocks(
	row: CountedRow & Pick<TurfRowInput, 'vanDistributedTo' | 'vanAssignedAt'>,
	now: Date,
	ttlHours = DEFAULT_VAN_ASSIGNMENT_TTL_HOURS,
): boolean {
	if (!row.vanDistributedTo) return false;
	if (ttlHours === VAN_ASSIGNMENT_NEVER_RELEASED) return true;
	if (!row.vanAssignedAt || currentUncontacted(row) === null) return true;
	return now.getTime() - Date.parse(row.vanAssignedAt) < ttlHours * 3_600_000;
}

/**
 * Doors still to knock: our own ContactHistory count when there is a current
 * one, VAN's doorCount when not. VAN's number only shrinks when a region is
 * re-cut with a "not yet contacted" filter, so the count is the fresher of the
 * two whenever it exists.
 */
export function doorsLeft(row: CountedRow): number {
	return currentUncontacted(row) ?? row.doorCount;
}

/**
 * When `doorsLeft` was last true. For the count, how far ContactHistory has
 * been read (`contactsThrough`) — not when it was last recomputed, which runs
 * even when the pull is failing and would call days-old data fresh. VAN's own
 * refresh time otherwise.
 */
function doorsLeftAsOf(row: TurfRowInput, contactsThrough: string | null): string | null {
	return currentUncontacted(row) != null
		? (contactsThrough ?? row.lastRefreshedAt)
		: row.lastRefreshedAt;
}

export interface TurfView {
	turfId: number;
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
	/** Doors with no in-person contact since the cut (see `doorsLeft`), as of
	 *  `refreshedMinutesAgo`. */
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
	/** The account behind `heldBy` — the Slack, Google or Apple mark, and a
	 *  Google or Apple holder's email. Admins only, like `heldBy`, and null too when the holder
	 *  is VAN's (an outside assignment names a person, not an account here). */
	heldByAccount: HolderAccount | null;
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
	 * True when the turf looks available but has no MiniVAN list number, so
	 * nobody can take it until an organizer generates one.
	 *
	 * Says only that the number is missing, never what it is, so it sits
	 * outside the access rule on `printedListNumber`. The list sinks these
	 * below turf that can be claimed and paints them as an alert, because a
	 * volunteer who opens one needs to go to an organizer rather than walk.
	 *
	 * Omitted rather than false when it does not apply, like `updating`.
	 */
	noListNumber?: true;
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
	/**
	 * What MiniVAN showed as done the last time a volunteer marked this turf
	 * walked, and on which campaign day — e.g. 70 and "Tue 23 Sep".
	 *
	 * VAN has no progress figure the app can read, and its door count only
	 * moves on a re-cut, so without this a walked turf looks untouched. Belongs
	 * to this route id, so a re-cut starts it over. Omitted when nobody has
	 * reported, for the same payload reason as `claimBlockedReason`.
	 */
	walkReport?: { percent: number; dayLabel: string };
	/**
	 * The turf's VAN campaign, for its badge — looked up in the payload's
	 * `campaignBadges` rather than repeated as text on every row. Present only
	 * when the badge is shown: while more than one campaign is enabled, and on
	 * turf from a disabled campaign. Omitted otherwise, like `updating`.
	 */
	campaignId?: number;
	/**
	 * True when the turf's campaign has been disabled. Such turf only reaches
	 * the volunteer still holding it: their claim runs to its end, but the
	 * campaign is no longer handing turf out, and they should hear that from
	 * the card. Omitted when it does not apply.
	 */
	campaignDisabled?: true;
	/**
	 * True when an admin has hidden the turf from volunteers. Admins only:
	 * nobody else is sent hidden turf, except a volunteer still holding it, and
	 * their card has nothing to say about it. Omitted when it does not apply.
	 */
	hidden?: true;
}

/** A walk report as the view needs it: the percentage, and when. `percent`
 *  is null until contact-sync derives it — or for good, on a turf with no
 *  count. */
export interface WalkReportInput {
	percent: number | null;
	at: string;
	/** The count has not caught up with this completion yet; see WalkReport
	 *  in checkout-store.ts. Optional so fixtures predating it need not name it. */
	awaitingCount?: boolean;
}

/** Claim rules, plus the state that is about the turf rather than about the
 *  viewer: which regions VAN is currently re-cutting, and what volunteers last
 *  reported walking. */
export type TurfViewOptions = ClaimOptions & {
	/** Regions with a refresh in flight, as `regionRefreshKey`s. See
	 *  `TurfView.updating`. */
	refreshingRegions?: ReadonlySet<string>;
	/** Latest walk report per route id. See `TurfView.walkReport`. */
	walkReports?: ReadonlyMap<number, WalkReportInput>;
	/** How far ContactHistory has been read: the "as of" for any turf showing
	 *  its uncontacted count. Null or omitted when the pull has never run. */
	contactsThrough?: string | null;
	/** Whether this row carries `campaignId` for a badge. See `TurfView.campaignId`. */
	showCampaign?: boolean;
	/** Disabled campaigns. See `TurfView.campaignDisabled`. */
	disabledCampaigns?: ReadonlySet<number>;
	/** Holder id → account, for `TurfView.heldByAccount`. Only ever loaded for
	 *  an admin viewer; and even if passed for anyone else it is not used,
	 *  because it rides on `heldBy`, which only admins get. */
	holderAccounts?: ReadonlyMap<string, HolderAccount>;
};

/** Campaign id → the badge text volunteers see beside its turf. Sent once per
 *  payload alongside the turf, which carry only `campaignId`. */
export type CampaignBadges = Record<number, string>;

/** What the holder of a disabled campaign's turf is told, on their turf card
 *  and in Slack alike (`TurfView.campaignDisabled`). One sentence for both, so
 *  the two places a volunteer checks their turf cannot tell them different
 *  things. */
export function campaignStoppedNote(badge: string | null): string {
	return (
		`${badge ?? 'This campaign'} has stopped handing out turf here. ` +
		'Your claim still runs until it ends — walk it, or give it back, as usual.'
	);
}

/** A map region's identity across campaigns. VAN region ids are unique only
 *  within one committee, so a refresh in flight in one campaign's region 10
 *  must not mark another campaign's region 10 as updating. */
export function regionRefreshKey(campaignId: number, mapRegionId: number): string {
	return `${campaignId}:${mapRegionId}`;
}

/** A turf that can actually be drawn. */
export type MappableTurf = TurfView & { centre: LatLng; bounds: BoundingBox };

/** Turfs with geometry, for the map. The list view takes the unfiltered set —
 *  it is the accessible path, the mobile-data-saving path, and the one that
 *  still works before the geometry pipeline has run (or at all, on a key
 *  without export-job access). */
export function mappableTurfs(turfs: readonly TurfView[]): MappableTurf[] {
	return turfs.filter((t): t is MappableTurf => t.centre !== null && t.bounds !== null);
}

/**
 * The smallest hull given a density at all, in square metres — about one city
 * block. Below it the figure measures how the hull was drawn, not the street:
 * a single apartment building, or a cluster of doors geocoded onto a few
 * points, wraps a sliver that would out-rank every real neighbourhood. Clamping
 * such a hull up to a block still ranked a 150-door building above any street,
 * and a building is a question of access, not walking. So these are left
 * unranked, like turf with no hull. Shown to volunteers in the Densest note.
 */
const MIN_DENSITY_AREA_M2 = 10_000;

/**
 * Doors remaining per square kilometre of hull: how little walking each door
 * costs. Null when the turf has no hull to measure, or one smaller than a block
 * (MIN_DENSITY_AREA_M2) — it sorts after every turf that has one.
 *
 * Approximate on purpose. The hull is convex and drawn around every address in
 * the cut, so it counts ground the turf does not cover, and the doors already
 * knocked are spread across it too. It ranks turf; it does not measure it.
 */
export function doorDensity(turf: Pick<TurfView, 'hull' | 'doorsRemaining'>): number | null {
	const area = hullAreaSquareMeters(turf.hull);
	if (area < MIN_DENSITY_AREA_M2) return null;
	return turf.doorsRemaining / (area / 1_000_000);
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

/** What the claim rules need to know about a row: its own state plus the last
 *  walk report. Shared with turf-query.ts, which judges claimability before
 *  deciding which rows become views. */
export function turfSnapshot(
	row: TurfRowInput,
	now: Date,
	options: {
		walkReports?: ReadonlyMap<number, WalkReportInput>;
		vanAssignmentTtlHours?: number;
	} = {},
): TurfSnapshot {
	const { walkReports, vanAssignmentTtlHours } = options;
	return {
		turfId: row.turfId,
		printedListNumber: row.printedListNumber,
		retiredAt: row.retiredAt,
		hidden: row.hiddenAt != null,
		// Handed out outside this app — through VAN, or written into the
		// campaign's Packet Tracker by an organizer. VAN's lapses after the
		// admin's hand-out TTL and the sheet only counts while no uncontacted
		// doors are known to remain, both once there is a count; see
		// vanAssignmentBlocks and sheetBlocksClaim.
		vanDistributedTo:
			(vanAssignmentBlocks(row, now, vanAssignmentTtlHours) ? row.vanDistributedTo : null) ??
			(sheetBlocksClaim(row) ? row.sheetAssignedTo : null) ??
			null,
		// The claim gate's "no doors left" reads the same number the volunteer
		// sees, so a turf never shows doors it will then refuse to hand out.
		doorCount: doorsLeft(row),
		uncontactedDoors: currentUncontacted(row),
		reportedPercent: walkReports?.get(row.turfId)?.percent ?? null,
		walked: walkReports?.has(row.turfId) ?? false,
		walkAwaitingCount: walkReports?.get(row.turfId)?.awaitingCount ?? false,
	};
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
	const report = options.walkReports?.get(row.turfId) ?? null;
	const snapshot = turfSnapshot(row, now, options);

	const rawStatus = turfStatus(snapshot, claims, viewer.slackUserId, now);
	const active = activeClaimFor(row.turfId, claims, now);
	const visible = visibleTurfState(
		{
			status: rawStatus,
			heldBy: active?.slackUserName ?? snapshot.vanDistributedTo ?? null,
			expiresInHours: active ? hoursRemaining(active, now) : null,
		},
		viewer,
	);

	const decision = canClaim(snapshot, claims, viewer.slackUserId, now, options);
	const hull = parseHull(row.hullJson);
	const { centre, bounds } = geometryFor(row, hull);

	return {
		turfId: row.turfId,
		chapterId: row.chapterId,
		name: row.name,
		regionName: row.regionName,
		// Issued only while you hold it — see the field's own note.
		printedListNumber: visible.status === 'held-by-you' ? row.printedListNumber : null,
		routeSize: row.routeSize,
		doorsRemaining: doorsLeft(row),
		hull,
		centre,
		bounds,
		status: visible.status,
		heldBy: visible.heldBy,
		heldByAccount:
			visible.heldBy !== null && active
				? (options.holderAccounts?.get(active.slackUserId) ?? null)
				: null,
		expiresInHours: visible.expiresInHours,
		refreshedMinutesAgo: minutesSince(doorsLeftAsOf(row, options.contactsThrough ?? null), now),
		claimable: decision.ok,
		...(decision.ok || visible.status !== 'available'
			? {}
			: {
					// canClaim's wording is for a volunteer. An admin is the one
					// person who sees hidden turf, and the fix is theirs to make.
					claimBlockedReason:
						decision.reason === 'hidden' && viewer.isAdmin
							? 'Hidden from volunteers. Untick the box below to hand it out.'
							: decision.message,
				}),
		...(options.refreshingRegions?.has(regionRefreshKey(row.campaignId, row.mapRegionId))
			? { updating: true as const }
			: {}),
		...(visible.status === 'available' && !decision.ok && decision.reason === 'no-list-number'
			? { noListNumber: true as const }
			: {}),
		...(row.retiredAt ? { retired: true as const } : {}),
		...(report && report.percent !== null
			? { walkReport: { percent: report.percent, dayLabel: campaignDayLabel(report.at) } }
			: {}),
		...(options.showCampaign ? { campaignId: row.campaignId } : {}),
		...(options.disabledCampaigns?.has(row.campaignId) ? { campaignDisabled: true as const } : {}),
		...(viewer.isAdmin && row.hiddenAt != null ? { hidden: true as const } : {}),
	};
}
