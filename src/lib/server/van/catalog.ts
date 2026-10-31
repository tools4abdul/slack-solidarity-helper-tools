// Pure catalog diff: VAN's map regions and printed lists in, van_turfs writes
// out. No network, no DB, no clock of its own — every interesting decision
// (which route owns which list number, what counts as a re-cut, when a turf is
// retired) is made here so it can be unit-tested without either.
//
// The orchestration that fetches the inputs and applies the outputs lives in
// sync.ts.

import type { NewVanTurfRow, VanTurfRow } from '../schema.js';
import type { VanMapRegion, VanMinivanExport, VanPrintedList } from './types.js';
import {
	campaignDayBounds,
	campaignDayKey,
	campaignHour,
	campaignWallClockToUtc,
} from '../../campaign-time.js';
import { NIGHTLY_WINDOW_END_HOUR } from '../../van/refresh-policy.js';
import { listExpiresAt } from '../../van/list-expiry.js';

/** One folder's worth of fetched data, already resolved to a chapter. */
export interface CatalogFolder {
	folderId: number;
	folderName: string;
	chapterId: number;
	chapterName: string;
	regions: VanMapRegion[];
	/** The campaign's requested-turf folder: its turf's label comes from
	 *  `placements` (van/turf-placement.ts), and `chapterId`/`chapterName`
	 *  here are only the label until then — a chapter it is also mapped to,
	 *  or the not-yet-placed placeholder. */
	requested?: true;
}

export interface CatalogInput {
	/** The van_campaigns row every folder here was read with. */
	campaignId: number;
	folders: CatalogFolder[];
	/** Cross-check and backfill for route-level printed lists. */
	printedLists: VanPrintedList[];
	/** This campaign's van_turfs rows, including retired ones. Another
	 *  campaign's rows must not be here: retirement is decided against this
	 *  list, and VAN's route ids only mean something within one campaign. */
	existing: VanTurfRow[];
	/** The turfIds in use, across ALL campaigns, among this sync's route ids,
	 *  and the highest in use. A new turf takes its VAN route id as its turfId
	 *  unless that id is already taken; then it gets one above every id in
	 *  use and every VAN id in this sync. */
	takenTurfIds?: ReadonlySet<number>;
	/** Optional — Tier 3, and a key without it should still sync a catalog. */
	minivanExports?: VanMinivanExport[];
	/** This app's own claims, recent enough to overlap the stored exports. An
	 *  export inside one of these is our volunteer loading the list, not the
	 *  turf being handed out elsewhere. */
	claims?: CatalogClaim[];
	/** Also queue turfs whose van_turf_roster is missing or from an older saved
	 *  list. Off unless VAN_ID_HASH_SECRET is configured: with nothing able to
	 *  build a roster, queuing for one would re-submit the same export every
	 *  sync, forever. */
	roster?: boolean;
	/** Requested turf's placements, by turfId: its display label, kept rather
	 *  than overwritten with the folder's placeholder. */
	placements?: ReadonlyMap<number, { chapterId: number; chapterName: string }>;
	now: Date;
}

/** One of our checkouts, as the export attribution needs it. */
export interface CatalogClaim {
	checkoutId: number;
	turfId: number;
	claimedAt: string;
	/** completedAt ?? releasedAt ?? expiresAt — when the claim stopped (or will
	 *  stop) covering the turf. */
	endedAt: string;
	loadedInMinivanAt: string | null;
}

export interface CatalogPlan {
	/** Every turf VAN listed, as it should now be stored. */
	upserts: NewVanTurfRow[];
	/** The upserts that differ from the stored row — the only ones the sync
	 *  writes (see turfRowChanged). */
	writes: NewVanTurfRow[];
	/** turfIds to stamp `retiredAt` on. */
	retirements: number[];
	/** turfIds whose `retiredAt` should be cleared — a route that vanished
	 *  and came back (an organizer un-archiving a folder, most often). */
	unretirements: number[];
	/** Turfs needing an export: no hull, one the route outgrew, or (with
	 *  `roster` on) no roster for the current saved list. `roster` marks the
	 *  last case, which is what lets the sync re-arm a finished queue row.
	 *
	 *  Keyed by VAN's route id, which is what the queue is planned from; the
	 *  sync resolves each to its turf after writing the upserts. */
	geometryQueue: Array<{ vanMapRouteId: number; savedListId: number; roster: boolean }>;
	/** Claims whose list was just seen loaded in MiniVAN, to stamp
	 *  `loadedInMinivanAt` on. Only claims not already stamped. */
	claimsLoaded: Array<{ checkoutId: number; loadedAt: string }>;
	/** turfIds VAN no longer returns whose retirement waits for midnight, and
	 *  which have no `vanChangedAt` yet — the sync stamps it with now. */
	holdsStarted: number[];
	/** The retirements whose hold ran out: turf kept live through the day
	 *  after VAN dropped it. Its claims are released quietly, with nothing
	 *  handed over in their place — the day those volunteers were out for is
	 *  over, and a midnight DM moving them onto new turf would only wake them. */
	holdsEnded: number[];
	/** Every turf whose change is held, gone or not. VAN may already have
	 *  deleted the saved list such a turf still has, so its waiting exports
	 *  are dropped and none are queued until the change lands. */
	heldTurfIds: number[];
	/** Held turf VAN no longer returns whose outside assignment moved — the
	 *  route loop never sees it, so it is written apart from the upserts. */
	heldAssignments: Array<{
		turfId: number;
		vanDistributedTo: string | null;
		vanAssignedAt: string | null;
	}>;
	/** What this run kept back until midnight (changeHeld): stored turf whose
	 *  VAN change is held — gone, or its list changed — and new routes not
	 *  added because they replace turf being held. */
	held: { turfs: number; newRoutes: number };
	/** Operator-facing conditions. Logged under `[van]`; the sync route
	 *  forwards them to Slack the way the door-knock snapshot does. */
	warnings: string[];
}

// A change VAN makes to turf already handed out — a re-cut that replaces its
// routes, or a new list on the same route — waits for the campaign's
// midnight. Until then the turf stays as volunteers were given it: on the map,
// claimable, with its old list number, which goes on loading in MiniVAN for
// the rest of the day. The routes that replace it are left out until then too,
// or the same doors would be on the map twice, claimable by two people.
//
// Not for a change first seen before HOLD_FROM_HOUR: that is the nightly
// re-cut window (refresh-policy.ts), when nobody is out, and a change seen
// then would otherwise wait out the whole day it was made for. Nor for turf
// with no list a volunteer can load (holdable), and not for new counts on an
// unchanged list: those describe the list volunteers already have.
export const HOLD_FROM_HOUR = NIGHTLY_WINDOW_END_HOUR;

/** Whether a VAN change first seen at `since` (ISO) is still held at `now`. */
export function changeHeld(since: string, now: Date): boolean {
	const hour = campaignHour(since);
	if (hour === null || hour < HOLD_FROM_HOUR) return false;
	const day = campaignDayBounds(campaignDayKey(since));
	return day !== null && now < day.end;
}

/** Whether turf has a list worth keeping until midnight: a number and a saved
 *  list, and the list not expired. Held without one, a newly printed turf
 *  would stay unclaimable all day, and an expired one would go on handing out
 *  a number that loads nothing. An unreadable date is "can't tell", and holds. */
function holdable(prior: VanTurfRow, now: Date): boolean {
	if (!prior.printedListNumber || prior.savedListId === null) return false;
	if (!prior.printedListCreatedAt) return true;
	const expires = listExpiresAt(prior.printedListCreatedAt);
	return expires === null || now < expires;
}

/**
 * Whether a planned row says anything the stored one does not.
 *
 * The catalog runs 37 times a day over every live turf, and an upsert rewrites
 * its row whether or not a value moved — 12,000-odd rows a run, nearly all of
 * them identical, and Turso bills each one as written. So a row is written
 * only when some column other than `lastSeenAt` differs. `lastSeenAt` changes
 * every run by construction and nothing reads it; it is stamped whenever the
 * row is written for another reason, so it says when the row last changed, not
 * when VAN last listed it.
 *
 * An `undefined` key is skipped: drizzle leaves it out of `set`, so it cannot
 * change the stored row, and counting it would rewrite the turf every run.
 */
export function turfRowChanged(row: NewVanTurfRow, prior: VanTurfRow | undefined): boolean {
	if (!prior) return true;
	for (const [key, value] of Object.entries(row)) {
		if (key === 'lastSeenAt' || value === undefined) continue;
		if (value !== (prior[key as keyof VanTurfRow] ?? null)) return true;
	}
	return false;
}

/** The fields a held turf keeps from before VAN changed it: the list a
 *  volunteer was given, its counts, and the shape drawn from it. */
function heldFields(prior: VanTurfRow): Partial<NewVanTurfRow> {
	return {
		name: prior.name,
		savedListId: prior.savedListId,
		printedListNumber: prior.printedListNumber,
		printedListCreatedAt: prior.printedListCreatedAt,
		routeNumber: prior.routeNumber,
		routeSize: prior.routeSize,
		doorCount: prior.doorCount,
		phoneCount: prior.phoneCount,
		centroidLat: prior.centroidLat,
		centroidLng: prior.centroidLng,
		hullJson: prior.hullJson,
		hullSourceRouteSize: prior.hullSourceRouteSize,
		lastRefreshedAt: prior.lastRefreshedAt,
		cutAt: prior.cutAt,
	};
}

/** The region keys a turf belongs to, for holding back the routes that
 *  replace it. By name as well as id, given a name: an organizer may
 *  regenerate a region as a new one under the same name rather than refresh
 *  it in place. */
function regionKeys(folderId: number, mapRegionId: number, regionName: string | null): string[] {
	const keys = [`${folderId}:id:${mapRegionId}`];
	const name = nameKey(regionName);
	if (name) keys.push(`${folderId}:name:${name}`);
	return keys;
}

// A hull is computed from the addresses in a route. Routes SHRINK as a matter
// of course — that is the entire remaining-doors mechanism (plan.md §2
// Constraint C), and the addresses that remain sit inside the hull we already
// drew, so a shrinking route does not invalidate its geometry. Two things do:
//
//   - GROWTH, at all. New addresses entered the route and they may lie outside
//     the old hull, so the shape now understates the turf. Small tolerance
//     only, to absorb VAN re-counting the same route by one or two.
//   - A COLLAPSE, past the threshold below. The hull is still a superset, but
//     one so much larger than what it contains that it stops describing where
//     a volunteer would actually walk.
//
// Naively treating any material change as a re-cut would re-queue an export
// job for every turf after every refresh — hundreds of jobs a night to redraw
// shapes that were already correct.
const HULL_GROWTH_TOLERANCE = 2;
const HULL_COLLAPSE_RATIO = 0.5;

function iso(now: Date): string {
	return now.toISOString();
}

/** Loose match for turf names across VAN surfaces: a printed list generated
 *  from a route carries the route's name, but casing and inner whitespace
 *  drift as organizers rename things. */
function nameKey(name: string | null | undefined): string {
	return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when a route has outgrown — or collapsed away from — the hull we
 *  drew for it. Exported for the geometry backfill, which asks the same
 *  question about rows it did not just sync. */
export function needsGeometry(row: {
	hullJson: string | null;
	hullSourceRouteSize: number | null;
	routeSize: number;
}): boolean {
	if (!row.hullJson) return true;
	const source = row.hullSourceRouteSize;
	if (source === null || source <= 0) return true;
	if (row.routeSize > source + HULL_GROWTH_TOLERANCE) return true;
	return row.routeSize < source * HULL_COLLAPSE_RATIO;
}

/** When each printed list was generated, by number. Covers both sources of a
 *  number: a route-level `printedList` may omit `dateCreated`, and a backfilled
 *  number only has one here. */
function listCreatedIndex(printedLists: VanPrintedList[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const list of printedLists) {
		if (list.number && list.dateCreated) index.set(list.number.trim(), list.dateCreated);
	}
	return index;
}

/** Every printed-list number by turf name, for backfilling routes that don't
 *  carry their own. Scoped per folder because two counties can both have a
 *  "Turf 01".
 *
 *  A set, because one name can own several lists. A regenerated list appears
 *  alongside the old one, and two regions in one folder can share a name —
 *  verified live 2026-09-30 in folder 68295, where
 *  R03C_Ottawa_HollandCityWd04Pct006_9.11 was cut twice five minutes apart
 *  and both cuts printed, so each "Turf 01" through "Turf 05" had two
 *  different, equally valid lists. The name alone cannot say which one a
 *  route owns. */
function printedListIndex(printedLists: VanPrintedList[]): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	for (const list of printedLists) {
		const number = list.number?.trim();
		if (!number) continue;
		for (const folder of list.folders ?? []) {
			const key = `${folder.folderId}:${nameKey(list.name)}`;
			const numbers = index.get(key) ?? new Set<string>();
			numbers.add(number);
			index.set(key, numbers);
		}
	}
	return index;
}

/**
 * A canvasser's name, however this VAN spells it.
 *
 * Verified live: `/minivanExports?$expand=canvassers` returns
 * `{canvassserId, firstName, lastName}` and no `name` at all. Reading only
 * `name` — which this did — yielded an empty string for every canvasser, so
 * every export was discarded as "nobody assigned" and `van_distributed_to`
 * came out null for the whole catalog. `name` is still preferred when present
 * so an instance that sends one is not broken by the fix.
 */
function canvasserName(c: {
	name?: string | null;
	firstName?: string | null;
	lastName?: string | null;
}): string {
	const direct = (c.name ?? '').trim();
	if (direct) return direct;
	return [c.firstName, c.lastName]
		.map((part) => (part ?? '').trim())
		.filter(Boolean)
		.join(' ');
}

/**
 * The printed list number an export refers to.
 *
 * VAN names an export for the list it came from — `"List 58817996-30305"` —
 * NOT for the turf. This index used to key on the export's name and be read
 * with the ROUTE's name (`"R04C_Livingston_…_9.11 Turf 01"`), which cannot
 * match, so nothing was ever found. Verified live: 610 of 703 exports in the
 * recent window are named this way.
 *
 * Returns null for the rest — exports an organizer hand-named
 * ("downtown LO Turf 01", "My List 5/30/18 5:04 PM"). Those are deliberately
 * NOT matched by turf name: the window spans 2014 to today, turf names are
 * reused across that whole period, and a 2014 export sharing a name with turf
 * cut last week would attribute a stranger to it. A list number identifies one
 * cut and cannot collide that way, so an unmatched hand-named export is the
 * safer failure.
 */
export function listNumberFromExportName(name: string | null | undefined): string | null {
	const match = (name ?? '').trim().match(/^List\s+(\S+)$/i);
	return match ? match[1]!.trim() : null;
}

/**
 * One of VAN's own timestamps — a region's `dateRefreshed`, a printed list's
 * `dateCreated` — as a real UTC ISO string.
 *
 * VAN writes campaign-local wall-clock time and appends a `Z`. Verified live
 * 2026-09-24: a region refreshed at about 21:40 Eastern reported
 * `dateRefreshed: 21:40Z`, and lists printed a few minutes after a sync that ran
 * at 01:40 UTC reported `dateCreated: 21:45Z`. Read as UTC, every one of them
 * is four hours in the past, and three readers compare them with our own clock:
 * the refresh settle check, the door-delta evidence check, and the list-expiry
 * warning. Converted here, once, so all of them get the real instant.
 *
 * Null for anything unparseable, which each reader already treats as "VAN did
 * not say".
 */
export function vanTimestamp(value: string | null | undefined): string | null {
	if (!value) return null;
	return campaignWallClockToUtc(value)?.toISOString() ?? null;
}

/** What a turf shows for a canvasser VAN names only by id. */
export const UNKNOWN_CANVASSER = 'unknown canvasser';

/**
 * How far before a claim an export still counts as that claim's volunteer
 * loading the list. Covers a volunteer who types the number into MiniVAN a
 * moment before the claim lands, and clock skew between VAN and us.
 */
export const CLAIM_LOAD_GRACE_MS = 30 * 60 * 1000;

/** An export we can place in time, with the names to show for it. */
interface DatedExport {
	at: number;
	minivanExportId: number;
	names: string;
}

/**
 * Exports by PRINTED LIST NUMBER, oldest first, from exports made in VAN.
 *
 * An export with no canvassers at all is skipped: it names nobody, so it is no
 * evidence the list was handed to anyone. So is one whose date cannot be read,
 * because every decision below is about WHEN it happened.
 *
 * Some canvassers come back as an id with null names, which VAN does for most
 * MiniVAN users. They are still someone holding the list, so they show as
 * UNKNOWN_CANVASSER rather than being dropped. `dateCreated` is VAN's local
 * wall clock wearing a `Z` (see vanTimestamp).
 */
function exportsByList(exports: VanMinivanExport[]): Map<string, DatedExport[]> {
	const index = new Map<string, DatedExport[]>();
	for (const exp of exports) {
		if ((exp.canvassers ?? []).length === 0) continue;
		const key = listNumberFromExportName(exp.name);
		if (!key) continue;
		const at = campaignWallClockToUtc(exp.dateCreated ?? '')?.getTime();
		if (at === undefined) continue;
		// Deduplicated, so two canvassers VAN names only by id read as one
		// "unknown canvasser" rather than the same phrase twice.
		const names = [
			...new Set((exp.canvassers ?? []).map((c) => canvasserName(c) || UNKNOWN_CANVASSER)),
		].join(', ');
		const list = index.get(key) ?? [];
		list.push({ at, minivanExportId: exp.minivanExportId, names });
		index.set(key, list);
	}
	// By time, then by export id, which VAN hands out in increasing order — so
	// two exports in the same second still have an order that does not depend
	// on the order they arrived in.
	for (const list of index.values()) {
		list.sort((a, b) => a.at - b.at || a.minivanExportId - b.minivanExportId);
	}
	return index;
}

/** Our own volunteers loading the list: the first export inside each claim
 *  that has not been stamped yet. */
function claimLoads(
	exports: readonly DatedExport[],
	claims: readonly CatalogClaim[],
): CatalogPlan['claimsLoaded'] {
	const loads: CatalogPlan['claimsLoaded'] = [];
	for (const claim of claims) {
		if (claim.loadedInMinivanAt) continue;
		const loaded = exports.find((e) => insideClaim(e.at, [claim]));
		if (loaded) {
			loads.push({ checkoutId: claim.checkoutId, loadedAt: new Date(loaded.at).toISOString() });
		}
	}
	return loads;
}

/** Whether an export falls inside one of our claims on the route. */
function insideClaim(at: number, claims: readonly CatalogClaim[]): boolean {
	return claims.some(
		(c) => at >= Date.parse(c.claimedAt) - CLAIM_LOAD_GRACE_MS && at <= Date.parse(c.endedAt),
	);
}

/**
 * Who holds this route outside the app, and since when — or null.
 *
 * Loading a list number into MiniVAN is what creates an export (verified
 * 2026-09-24: most carry the loading volunteer as a nameless canvasser, and one
 * was created BY its own canvasser). So an export means SOMEONE opened the list,
 * and the question is who:
 *
 *   - inside one of our claims on this route → our volunteer. Not an outside
 *     assignment; it is recorded on the claim instead (`claimsLoaded`).
 *   - anywhere else → the turf was handed out outside this app.
 *
 * An outside assignment is carried forward on every sync once seen, name and
 * all, even after the export ages out of the store or the list is reprinted.
 * It does not hold the turf forever, though: `vanAssignmentBlocks` in
 * turf-view.ts lets it go VAN_ASSIGNMENT_TTL_HOURS after `vanAssignedAt`, once
 * the uncontacted count can show what the holder left.
 *
 * `vanAssignedAt` is the LATEST outside export, not the first: re-exporting a
 * list hands it to someone (or back to the same someone) again, and that
 * restarts the clock. The latest export also names the holder. It never moves
 * backwards, so an export ageing out of the store cannot rewind it. Carrying
 * forward is keyed on `vanAssignedAt` rather than on `vanDistributedTo`,
 * because rows written before this rule may carry a name that came from our
 * own volunteer's export.
 */
function outsideAssignment(
	exports: readonly DatedExport[],
	claims: readonly CatalogClaim[],
	prior: VanTurfRow | undefined,
): { vanDistributedTo: string | null; vanAssignedAt: string | null } {
	const latest = exports.filter((e) => !insideClaim(e.at, claims)).at(-1);
	const latestAt = latest ? new Date(latest.at).toISOString() : null;
	if (latest && latestAt && !(prior?.vanAssignedAt && prior.vanAssignedAt > latestAt)) {
		return { vanDistributedTo: latest.names, vanAssignedAt: latestAt };
	}
	if (prior?.vanAssignedAt) {
		return {
			vanDistributedTo: prior.vanDistributedTo ?? UNKNOWN_CANVASSER,
			vanAssignedAt: prior.vanAssignedAt,
		};
	}
	return { vanDistributedTo: null, vanAssignedAt: null };
}

/** First five names, then a count of the rest — a warning names the turf an
 *  organizer has to go and fix, not every turf in the folder. */
function sampleNames(names: readonly string[]): string {
	const sample = names.slice(0, 5).join(', ');
	return names.length > 5 ? `${sample}, +${names.length - 5} more` : sample;
}

/**
 * Diff VAN's current catalog against what we have stored.
 *
 * Retirement is scoped to the folders actually fetched this run: a folder that
 * errored, or one an admin has not mapped to a chapter, leaves its turf
 * untouched rather than retiring the lot. Retiring turf we simply didn't look
 * at would release live checkouts under volunteers standing on the doorstep.
 */
export function planCatalogSync(input: CatalogInput): CatalogPlan {
	const { campaignId, folders, printedLists, existing, now } = input;
	const takenTurfIds = input.takenTurfIds ?? new Set<number>();
	// Where ids for colliding new turf start: above every id in use AND every
	// VAN id this sync could hand out as a turf id. VAN issues route ids in
	// sequence, so "one past the highest in use" — what the database would
	// pick — is very likely the next new route's own VAN id, and the two would
	// collide inside one batch. That batch rolls back and the next run plans
	// the same ids, so the campaign would never sync again.
	let nextFreeTurfId = 1;
	for (const id of takenTurfIds) nextFreeTurfId = Math.max(nextFreeTurfId, id + 1);
	for (const folder of folders) {
		for (const region of folder.regions) {
			for (const route of region.mapRoutes ?? []) {
				if (typeof route.mapRouteId === 'number') {
					nextFreeTurfId = Math.max(nextFreeTurfId, route.mapRouteId + 1);
				}
			}
		}
	}
	const nowIso = iso(now);
	const warnings: string[] = [];
	const listIndex = printedListIndex(printedLists);
	const createdIndex = listCreatedIndex(printedLists);
	const exportIndex = exportsByList(input.minivanExports ?? []);
	const claimsByRoute = new Map<number, CatalogClaim[]>();
	for (const claim of input.claims ?? []) {
		const list = claimsByRoute.get(claim.turfId) ?? [];
		list.push(claim);
		claimsByRoute.set(claim.turfId, list);
	}
	const claimsLoaded: CatalogPlan['claimsLoaded'] = [];
	// By VAN's id, which is what the region response carries. Rows from
	// another campaign never get here, so a route id another committee also
	// uses cannot match the wrong turf.
	const existingByRoute = new Map(existing.map((row) => [row.vanMapRouteId, row]));

	const upserts: NewVanTurfRow[] = [];
	const writes: NewVanTurfRow[] = [];
	const missingListNumbers: string[] = [];
	const listNumberDisagreements: string[] = [];
	const sharedRegionNames: string[] = [];
	const unretirements: number[] = [];
	const geometryQueue: CatalogPlan['geometryQueue'] = [];
	const seen = new Set<number>();
	for (const folder of folders) {
		for (const region of folder.regions) {
			for (const route of region.mapRoutes ?? []) {
				if (typeof route.mapRouteId === 'number') seen.add(route.mapRouteId);
			}
		}
	}
	const syncedFolderIds = new Set(folders.map((f) => f.folderId));
	const regionsRead = new Set(
		folders.flatMap((f) => f.regions.map((r) => `${f.folderId}:${r.mapRegionId}`)),
	);

	// Live turf VAN no longer returns, in a folder read this run. Retired —
	// unless its change is held until midnight, and then the routes replacing
	// it wait too (see changeHeld).
	const gone = existing.filter(
		(row) =>
			row.retiredAt === null && syncedFolderIds.has(row.folderId) && !seen.has(row.vanMapRouteId),
	);
	const goneHeld = gone.filter(
		(row) => holdable(row, now) && changeHeld(row.vanChangedAt ?? nowIso, now),
	);
	// By name only for a region VAN no longer returns. One still there was
	// refreshed in place, and its id says which routes replace it; matched by
	// name too, it would also hold back another region that shares the name.
	const heldRegions = new Set(
		goneHeld.flatMap((row) =>
			regionKeys(
				row.folderId,
				row.mapRegionId,
				regionsRead.has(`${row.folderId}:${row.mapRegionId}`) ? null : row.regionName,
			),
		),
	);
	const heldTurfIds = goneHeld.map((row) => row.turfId);
	let heldNewRoutes = 0;

	for (const folder of folders) {
		// Two regions under one name means their turfs share names too — the
		// same "Turf 01" listed twice, often the same ground cut twice. That is
		// for an organizer to sort out in VAN; all this can do is say so.
		const regionIdsByName = new Map<string, { name: string; ids: Set<number> }>();
		for (const region of folder.regions) {
			const key = nameKey(region.name);
			if (!key) continue;
			const entry = regionIdsByName.get(key) ?? { name: region.name!.trim(), ids: new Set() };
			entry.ids.add(region.mapRegionId);
			regionIdsByName.set(key, entry);
		}
		for (const { name, ids } of regionIdsByName.values()) {
			if (ids.size > 1)
				sharedRegionNames.push(`${name} (${ids.size} regions in ${folder.folderName})`);
		}

		for (const region of folder.regions) {
			for (const route of region.mapRoutes ?? []) {
				if (typeof route.mapRouteId !== 'number') continue;
				const prior = existingByRoute.get(route.mapRouteId);
				if (
					prior === undefined &&
					regionKeys(folder.folderId, region.mapRegionId, region.name ?? null).some((key) =>
						heldRegions.has(key),
					)
				) {
					heldNewRoutes++;
					continue;
				}

				// The Map Region response is authoritative for the list number;
				// /printedLists only fills a gap, and only when the name points
				// at exactly one list — with several, guessing could hand a
				// volunteer another turf's doors. A route whose own number is
				// not among its name's lists is flagged rather than trusted
				// silently. The numbers themselves stay out of the warning: it
				// is posted to a channel, and a list number is the credential
				// that pulls a turf's doors down in MiniVAN.
				const routeNumber = route.printedList?.number?.trim() || null;
				const listNumbers = listIndex.get(`${folder.folderId}:${nameKey(route.name)}`);
				const backfill = listNumbers?.size === 1 ? [...listNumbers][0]! : null;
				const printedListNumber = routeNumber ?? backfill;
				const listNumberDisagrees =
					routeNumber !== null && listNumbers !== undefined && !listNumbers.has(routeNumber);
				// The date belongs to whichever number is being issued, so it is
				// looked up by that number rather than taken from the route alone.
				const printedListCreatedAt = vanTimestamp(
					(routeNumber !== null ? route.printedList?.dateCreated : null) ??
						(printedListNumber ? createdIndex.get(printedListNumber) : undefined),
				);

				const routeSize = route.routeSize ?? 0;
				// VAN's list for this route is not the one volunteers were given.
				// Held until midnight, the turf keeps what it had (heldFields).
				// Counts alone are not a change: they describe the same list.
				const listChanged =
					prior !== undefined &&
					prior.retiredAt === null &&
					(prior.savedListId !== (route.savedListId ?? null) ||
						prior.printedListNumber !== printedListNumber);
				const changedSince = prior?.vanChangedAt ?? nowIso;
				const held = listChanged && holdable(prior, now) && changeHeld(changedSince, now);
				if (held) heldTurfIds.push(prior.turfId);
				const hullSourceRouteSize = prior?.hullSourceRouteSize ?? null;
				const staleHull =
					!held &&
					prior !== undefined &&
					prior.hullJson !== null &&
					needsGeometry({
						hullJson: prior.hullJson,
						hullSourceRouteSize,
						routeSize,
					});

				// Joined on the list number, which is what the export names — the
				// one volunteers have, while a change is held.
				const issuedListNumber = held ? (prior?.printedListNumber ?? null) : printedListNumber;
				const routeExports = issuedListNumber ? (exportIndex.get(issuedListNumber) ?? []) : [];
				// The turf keeps the id it has. A new one takes VAN's route id,
				// which keeps ids in logs matching VAN, unless another campaign's
				// turf already has that id — then it gets the next free one.
				const turfId =
					prior?.turfId ??
					(takenTurfIds.has(route.mapRouteId) ? nextFreeTurfId++ : route.mapRouteId);

				// Claims are on turfIds. A newly numbered turf has none yet.
				const routeClaims = claimsByRoute.get(turfId) ?? [];
				const assignment = outsideAssignment(routeExports, routeClaims, prior);
				claimsLoaded.push(...claimLoads(routeExports, routeClaims));

				const row: NewVanTurfRow = {
					turfId,
					campaignId,
					vanMapRouteId: route.mapRouteId,
					mapRegionId: region.mapRegionId,
					folderId: folder.folderId,
					...(folder.requested && prior && input.placements?.has(prior.turfId)
						? {
								chapterId: input.placements.get(prior.turfId)!.chapterId,
								chapterName: input.placements.get(prior.turfId)!.chapterName,
							}
						: { chapterId: folder.chapterId, chapterName: folder.chapterName }),
					regionName: region.name ?? '',
					name: route.name ?? `Turf ${route.routeNumber ?? route.mapRouteId}`,
					savedListId: route.savedListId ?? null,
					printedListNumber,
					printedListCreatedAt,
					routeNumber: route.routeNumber ?? null,
					routeSize,
					doorCount: route.doorCount ?? 0,
					phoneCount: route.phoneCount ?? 0,
					// Geometry is owned by the export-job pipeline, not by this
					// sync. Carry the prior values through untouched unless the
					// turf was re-cut, in which case drop the hull so the UI
					// draws a pin instead of a shape that no longer fits.
					centroidLat: staleHull ? null : (prior?.centroidLat ?? null),
					centroidLng: staleHull ? null : (prior?.centroidLng ?? null),
					hullJson: staleHull ? null : (prior?.hullJson ?? null),
					hullSourceRouteSize: staleHull ? null : hullSourceRouteSize,
					vanDistributedTo: assignment.vanDistributedTo,
					vanAssignedAt: assignment.vanAssignedAt,
					firstSeenAt: prior?.firstSeenAt ?? nowIso,
					lastSeenAt: nowIso,
					// VAN's own refresh timestamp when it offers one, so the UI's
					// staleness label reflects when the counts were recomputed
					// rather than when we last asked for them. Converted from VAN's
					// local clock; see vanTimestamp.
					lastRefreshedAt: vanTimestamp(region.dateRefreshed) ?? prior?.lastRefreshedAt ?? null,
					// What "since the turf was cut" means for the uncontacted
					// count. A refresh re-cuts the region, so it wins over the
					// original creation date.
					cutAt:
						vanTimestamp(region.dateRefreshed) ??
						vanTimestamp(region.dateCreated) ??
						prior?.cutAt ??
						null,
					retiredAt: null,
				};
				if (held && prior) Object.assign(row, heldFields(prior), { vanChangedAt: changedSince });
				else row.vanChangedAt = null;
				upserts.push(row);
				if (turfRowChanged(row, prior)) writes.push(row);

				if (prior?.retiredAt) unretirements.push(prior.turfId);

				// From the row rather than the route: a held turf is exported for
				// the list it still has, and VAN's new one waits with the rest.
				const savedListId = row.savedListId ?? null;
				const rowRouteSize = row.routeSize ?? 0;
				const wantsGeometry = needsGeometry({
					hullJson: row.hullJson ?? null,
					hullSourceRouteSize: row.hullSourceRouteSize ?? null,
					routeSize: rowRouteSize,
				});
				const wantsRoster = input.roster === true && prior?.rosterSavedListId !== savedListId;
				// A route with no doors has nothing to draw or roster, and VAN never
				// finishes exporting its empty list: queued, it held its place for
				// hours of resubmits before dead-lettering. runCatalogSync unqueues one
				// already waiting. Nor a held turf: VAN may have deleted its list.
				if (!held && savedListId && rowRouteSize > 0 && (wantsGeometry || wantsRoster)) {
					geometryQueue.push({
						vanMapRouteId: route.mapRouteId,
						savedListId,
						roster: wantsRoster,
					});
				}
				// Collected rather than warned per-turf: a folder cut but not yet
				// printed would otherwise post one Slack line per route.
				if (!printedListNumber) missingListNumbers.push(row.name);
				if (listNumberDisagrees) listNumberDisagreements.push(row.name);
			}
		}
	}

	if (missingListNumbers.length > 0) {
		warnings.push(
			`${missingListNumbers.length} turf(s) have no MiniVAN list number and are not claimable ` +
				`until someone generates their printed lists in VAN: ${sampleNames(missingListNumbers)}.`,
		);
	}

	if (sharedRegionNames.length > 0) {
		warnings.push(
			`${sharedRegionNames.length} map region name(s) are used by more than one region in the ` +
				`same folder, so their turfs are listed twice under the same names. Check VAN for a ` +
				`region cut twice: ${sampleNames(sharedRegionNames)}.`,
		);
	}

	if (listNumberDisagreements.length > 0) {
		warnings.push(
			`${listNumberDisagreements.length} turf(s) have a different MiniVAN list number on the ` +
				`route than in /printedLists — the route's number is the one being issued. Check the ` +
				`printed list in VAN if that is the wrong one: ${sampleNames(listNumberDisagreements)}.`,
		);
	}

	// Held turf VAN no longer returns is still handed out on its old list
	// number, so loads of that list go on being matched to it: our volunteers'
	// (claimsLoaded, which the Packet Tracker reads) and anyone else's.
	const heldAssignments: CatalogPlan['heldAssignments'] = [];
	for (const row of goneHeld) {
		const exports = row.printedListNumber ? (exportIndex.get(row.printedListNumber) ?? []) : [];
		const claims = claimsByRoute.get(row.turfId) ?? [];
		claimsLoaded.push(...claimLoads(exports, claims));
		const assignment = outsideAssignment(exports, claims, row);
		if (assignment.vanAssignedAt !== row.vanAssignedAt) {
			heldAssignments.push({ turfId: row.turfId, ...assignment });
		}
	}

	const goneHeldIds = new Set(goneHeld.map((row) => row.turfId));
	const retirements = gone.filter((row) => !goneHeldIds.has(row.turfId)).map((row) => row.turfId);
	const holdsStarted = goneHeld.filter((row) => !row.vanChangedAt).map((row) => row.turfId);
	const holdsEnded = gone
		.filter((row) => row.vanChangedAt && !changeHeld(row.vanChangedAt, now))
		.map((row) => row.turfId);

	return {
		upserts,
		writes,
		retirements,
		unretirements,
		geometryQueue,
		claimsLoaded,
		holdsStarted,
		holdsEnded,
		heldTurfIds,
		heldAssignments,
		held: { turfs: heldTurfIds.length, newRoutes: heldNewRoutes },
		warnings,
	};
}
