// Pure catalog diff: VAN's map regions and printed lists in, van_turfs writes
// out. No network, no DB, no clock of its own — every interesting decision
// (which route owns which list number, what counts as a re-cut, when a turf is
// retired) is made here so it can be unit-tested without either.
//
// The orchestration that fetches the inputs and applies the outputs lives in
// sync.ts.

import type { NewVanTurfRow, VanTurfRow } from '../schema.js';
import type { VanMapRegion, VanMinivanExport, VanPrintedList } from './types.js';
import { campaignWallClockToUtc } from '../../campaign-time.js';

/** One folder's worth of fetched data, already resolved to a chapter. */
export interface CatalogFolder {
	folderId: number;
	folderName: string;
	chapterId: number;
	chapterName: string;
	regions: VanMapRegion[];
}

export interface CatalogInput {
	folders: CatalogFolder[];
	/** Cross-check and backfill for route-level printed lists. */
	printedLists: VanPrintedList[];
	/** Every van_turfs row currently in the DB, including retired ones. */
	existing: VanTurfRow[];
	/** Optional — Tier 3, and a key without it should still sync a catalog. */
	minivanExports?: VanMinivanExport[];
	/** This app's own claims, recent enough to overlap the stored exports. An
	 *  export inside one of these is our volunteer loading the list, not the
	 *  turf being handed out elsewhere. */
	claims?: CatalogClaim[];
	now: Date;
}

/** One of our checkouts, as the export attribution needs it. */
export interface CatalogClaim {
	checkoutId: number;
	mapRouteId: number;
	claimedAt: string;
	/** completedAt ?? releasedAt ?? expiresAt — when the claim stopped (or will
	 *  stop) covering the turf. */
	endedAt: string;
	loadedInMinivanAt: string | null;
}

export interface CatalogPlan {
	upserts: NewVanTurfRow[];
	/** mapRouteIds to stamp `retiredAt` on. */
	retirements: number[];
	/** mapRouteIds whose `retiredAt` should be cleared — a route that vanished
	 *  and came back (an organizer un-archiving a folder, most often). */
	unretirements: number[];
	/** Turfs needing hull geometry: no hull, or one the route outgrew. */
	geometryQueue: Array<{ mapRouteId: number; savedListId: number }>;
	/** Claims whose list was just seen loaded in MiniVAN, to stamp
	 *  `loadedInMinivanAt` on. Only claims not already stamped. */
	claimsLoaded: Array<{ checkoutId: number; loadedAt: string }>;
	/** Operator-facing conditions. Logged under `[van]`; the sync route
	 *  forwards them to Slack the way the door-knock snapshot does. */
	warnings: string[];
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

/** Printed-list numbers by turf name, for backfilling routes that don't carry
 *  their own. Scoped per folder because two counties can both have a
 *  "Turf 01". */
function printedListIndex(printedLists: VanPrintedList[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const list of printedLists) {
		if (!list.number) continue;
		for (const folder of list.folders ?? []) {
			const key = `${folder.folderId}:${nameKey(list.name)}`;
			// First writer wins: a regenerated list appears alongside the old
			// one, and picking arbitrarily between them would flip the number a
			// volunteer sees from sync to sync.
			if (!index.has(key)) index.set(key, list.number);
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
 * An outside assignment is STICKY for the life of the route: once
 * `vanAssignedAt` is set it is carried forward on every sync, and so is the
 * name, even after the export ages out of the store or the list is reprinted.
 * Turf handed out elsewhere is managed elsewhere, and never comes back into this
 * app's pool. A re-cut issues new route ids, which is the one thing that starts
 * a route over.
 *
 * The LATEST outside export names the holder: re-exporting a list hands it to
 * someone else. Stickiness is keyed on `vanAssignedAt` rather than on
 * `vanDistributedTo`, because rows written before this rule may carry a name
 * that came from our own volunteer's export.
 */
function outsideAssignment(
	exports: readonly DatedExport[],
	claims: readonly CatalogClaim[],
	prior: VanTurfRow | undefined,
): { vanDistributedTo: string | null; vanAssignedAt: string | null } {
	const outside = exports.filter((e) => !insideClaim(e.at, claims));
	const latest = outside.at(-1);
	if (prior?.vanAssignedAt) {
		return {
			vanDistributedTo: latest?.names ?? prior.vanDistributedTo ?? UNKNOWN_CANVASSER,
			vanAssignedAt: prior.vanAssignedAt,
		};
	}
	if (!latest) return { vanDistributedTo: null, vanAssignedAt: null };
	return {
		vanDistributedTo: latest.names,
		// The FIRST outside export: when the route left the pool.
		vanAssignedAt: new Date(outside[0]!.at).toISOString(),
	};
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
	const { folders, printedLists, existing, now } = input;
	const nowIso = iso(now);
	const warnings: string[] = [];
	const listIndex = printedListIndex(printedLists);
	const createdIndex = listCreatedIndex(printedLists);
	const exportIndex = exportsByList(input.minivanExports ?? []);
	const claimsByRoute = new Map<number, CatalogClaim[]>();
	for (const claim of input.claims ?? []) {
		const list = claimsByRoute.get(claim.mapRouteId) ?? [];
		list.push(claim);
		claimsByRoute.set(claim.mapRouteId, list);
	}
	const claimsLoaded: CatalogPlan['claimsLoaded'] = [];
	const existingById = new Map(existing.map((row) => [row.mapRouteId, row]));

	const upserts: NewVanTurfRow[] = [];
	const missingListNumbers: string[] = [];
	const listNumberDisagreements: string[] = [];
	const unretirements: number[] = [];
	const geometryQueue: Array<{ mapRouteId: number; savedListId: number }> = [];
	const seen = new Set<number>();
	const syncedFolderIds = new Set(folders.map((f) => f.folderId));

	for (const folder of folders) {
		for (const region of folder.regions) {
			for (const route of region.mapRoutes ?? []) {
				if (typeof route.mapRouteId !== 'number') continue;
				seen.add(route.mapRouteId);
				const prior = existingById.get(route.mapRouteId);

				// The Map Region response is authoritative for the list number;
				// /printedLists only fills a gap. When both exist and disagree,
				// someone regenerated the list — take VAN's route-level answer
				// and flag the turf, rather than silently handing out a stale
				// number. The numbers themselves stay out of the warning: it is
				// posted to a channel, and a list number is the credential that
				// pulls a turf's doors down in MiniVAN.
				const routeNumber = route.printedList?.number?.trim() || null;
				const backfill = listIndex.get(`${folder.folderId}:${nameKey(route.name)}`) ?? null;
				const printedListNumber = routeNumber ?? backfill;
				const listNumberDisagrees =
					routeNumber !== null && backfill !== null && routeNumber !== backfill;
				// The date belongs to whichever number is being issued, so it is
				// looked up by that number rather than taken from the route alone.
				const printedListCreatedAt = vanTimestamp(
					(routeNumber !== null ? route.printedList?.dateCreated : null) ??
						(printedListNumber ? createdIndex.get(printedListNumber) : undefined),
				);

				const routeSize = route.routeSize ?? 0;
				const hullSourceRouteSize = prior?.hullSourceRouteSize ?? null;
				const staleHull =
					prior !== undefined &&
					prior.hullJson !== null &&
					needsGeometry({
						hullJson: prior.hullJson,
						hullSourceRouteSize,
						routeSize,
					});

				// Joined on the list number, which is what the export names.
				const routeExports = printedListNumber ? (exportIndex.get(printedListNumber) ?? []) : [];
				const routeClaims = claimsByRoute.get(route.mapRouteId) ?? [];
				const assignment = outsideAssignment(routeExports, routeClaims, prior);
				// Our own volunteer loading the list: the first export inside
				// each claim that has not been stamped yet.
				for (const claim of routeClaims) {
					if (claim.loadedInMinivanAt) continue;
					const loaded = routeExports.find((e) => insideClaim(e.at, [claim]));
					if (loaded) {
						claimsLoaded.push({
							checkoutId: claim.checkoutId,
							loadedAt: new Date(loaded.at).toISOString(),
						});
					}
				}

				const row: NewVanTurfRow = {
					mapRouteId: route.mapRouteId,
					mapRegionId: region.mapRegionId,
					folderId: folder.folderId,
					chapterId: folder.chapterId,
					chapterName: folder.chapterName,
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
					retiredAt: null,
				};
				upserts.push(row);

				if (prior?.retiredAt) unretirements.push(route.mapRouteId);

				const wantsGeometry = needsGeometry({
					hullJson: row.hullJson ?? null,
					hullSourceRouteSize: row.hullSourceRouteSize ?? null,
					routeSize,
				});
				if (route.savedListId && wantsGeometry) {
					geometryQueue.push({ mapRouteId: route.mapRouteId, savedListId: route.savedListId });
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

	if (listNumberDisagreements.length > 0) {
		warnings.push(
			`${listNumberDisagreements.length} turf(s) have a different MiniVAN list number on the ` +
				`route than in /printedLists — the route's number is the one being issued. Check the ` +
				`printed list in VAN if that is the wrong one: ${sampleNames(listNumberDisagreements)}.`,
		);
	}

	const retirements = existing
		.filter(
			(row) =>
				row.retiredAt === null && syncedFolderIds.has(row.folderId) && !seen.has(row.mapRouteId),
		)
		.map((row) => row.mapRouteId);

	return { upserts, retirements, unretirements, geometryQueue, claimsLoaded, warnings };
}
