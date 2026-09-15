// Pure catalog diff: VAN's map regions and printed lists in, van_turfs writes
// out. No network, no DB, no clock of its own — every interesting decision
// (which route owns which list number, what counts as a re-cut, when a turf is
// retired) is made here so it can be unit-tested without either.
//
// The orchestration that fetches the inputs and applies the outputs lives in
// sync.ts.

import type { NewVanTurfRow, VanTurfRow } from '../schema.js';
import type { VanMapRegion, VanMinivanExport, VanPrintedList } from './types.js';

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
	now: Date;
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

/** Canvasser names by turf name, from exports an organizer made by hand in
 *  VAN. Turfs with an entry render as "assigned in VAN" rather than vanishing
 *  (plan.md §4, Story 8.1). */
function distributionIndex(exports: VanMinivanExport[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const exp of exports) {
		const names = (exp.canvassers ?? []).map((c) => (c.name ?? '').trim()).filter(Boolean);
		if (names.length === 0) continue;
		const key = nameKey(exp.name);
		if (!key) continue;
		const existing = index.get(key);
		index.set(key, existing ? `${existing}, ${names.join(', ')}` : names.join(', '));
	}
	return index;
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
	const distributed = distributionIndex(input.minivanExports ?? []);
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
					vanDistributedTo: distributed.get(nameKey(route.name)) ?? null,
					firstSeenAt: prior?.firstSeenAt ?? nowIso,
					lastSeenAt: nowIso,
					// VAN's own refresh timestamp when it offers one, so the UI's
					// staleness label reflects when the counts were recomputed
					// rather than when we last asked for them.
					lastRefreshedAt: region.dateRefreshed ?? prior?.lastRefreshedAt ?? null,
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

	return { upserts, retirements, unretirements, geometryQueue, warnings };
}
