import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { vanClient } from '$lib/server/van-env.js';
import { loadVanChapterFolders } from '$lib/server/settings.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import {
	CAMPAIGN_STATES,
	MAP_TILE_API_KEY,
	MAP_TILE_ATTRIBUTION,
	MAP_TILE_URL_TEMPLATE,
	SOLIDARITY_API_TOKEN,
} from '$lib/server/env.js';
import { TILE_ATTRIBUTION, TILE_URL_TEMPLATE, withTileApiKey } from '$lib/van/tiles.js';
import { errMessage } from '$lib/err-message.js';
import { countyCandidates, parseRegionName } from '$lib/van/region-name.js';
import {
	countyIndexFor,
	inferCountyIndex,
	parseCampaignStates,
	type CountyIndex,
} from '$lib/server/geo/counties.js';
import { boundingBox, padBounds, type BoundingBox, type LatLng } from '$lib/van/geometry.js';
import type { VanMapRegion } from '$lib/server/van/types.js';

// Which VAN folder covers which part of the state — the page for deciding what
// a folder should be mapped to under Settings → Chapter → VAN folders.
//
// It answers that from region NAMES, not geometry. A turf's real shape costs
// one VAN export job, and a statewide cut is 2,000+ turfs; a county centroid
// off the region name is free, needs no key tier beyond the catalog's own, and
// is accurate to the only resolution this question has (see region-name.ts).
// So every dot here is a county, never a block, and the page says so.
//
// Reads VAN live rather than van_turfs, deliberately: nothing is synced until a
// mapping exists, and a mapping is what this page exists to decide. That makes
// it the one place outside scripts/ that talks to VAN on a page load, so the
// result is cached in module memory and refreshed on demand.

const CACHE_TTL_MS = 10 * 60 * 1000;

export interface FolderCounty {
	county: string;
	centre: LatLng;
	regions: number;
	routes: number;
}

export interface FolderSummary {
	folderId: number;
	name: string;
	regions: number;
	routes: number;
	counties: FolderCounty[];
	/** Regions whose name gave no county — named so they can be fixed in VAN
	 *  rather than quietly dropped from the map. */
	unplaced: string[];
}

interface Snapshot {
	folders: FolderSummary[];
	fetchedAt: string;
	/** Folders VAN would not show us, by name — one line per failure. */
	errors: string[];
	/** The states the counties were read in, and whether that was configured or
	 *  worked out from the names. Shown on the page, because a guessed state is
	 *  something an operator should be able to see and correct. */
	states: string[];
	statesInferred: boolean;
	/** Frame for the map when no folder resolved to anywhere — the states in
	 *  scope, rather than a hardcoded corner of the country. */
	fallbackBounds: BoundingBox | null;
}

let cache: Snapshot | null = null;
let cacheAt = 0;
/** In-flight fetch, so two admins opening the page do not each spend 19 VAN
 *  round trips building the same snapshot. */
let inFlight: Promise<Snapshot> | null = null;

async function buildSnapshot(): Promise<Snapshot> {
	const configured = vanClient();
	if (!configured.ok) throw new Error(configured.error);
	const client = configured.client;

	const folders: FolderSummary[] = [];
	const errors: string[] = [];

	// Fetched first, so the county lookup can be built from every region name at
	// once: which states are in play is a property of the whole catalog, not of
	// the folder that happens to be read first.
	const fetched: Array<{ folderId: number; name: string; regions: VanMapRegion[] }> = [];
	for (const folder of await client.folders()) {
		try {
			const regions = await client.mapRegions(folder.folderId);
			if (regions.length > 0)
				fetched.push({ folderId: folder.folderId, name: folder.name, regions });
		} catch (err) {
			errors.push(`${folder.name} (${folder.folderId}): ${errMessage(err)}`);
		}
	}

	const configuredStates = parseCampaignStates(CAMPAIGN_STATES);
	const regionNames = fetched.flatMap((f) => f.regions.map((r) => r.name ?? ''));
	const counties: CountyIndex =
		configuredStates.length > 0
			? countyIndexFor(configuredStates)
			: inferCountyIndex(regionNames.flatMap(countyCandidates));

	for (const folder of fetched) {
		const regions = folder.regions;

		const byCounty = new Map<string, FolderCounty>();
		const unplaced: string[] = [];
		let routes = 0;

		for (const region of regions) {
			const routeCount = region.mapRoutes?.length ?? 0;
			routes += routeCount;
			const parsed = parseRegionName(region.name, counties);
			if (!parsed.county || !parsed.centre) {
				unplaced.push(region.name ?? `region ${region.mapRegionId}`);
				continue;
			}
			const entry = byCounty.get(parsed.county);
			if (entry) {
				entry.regions += 1;
				entry.routes += routeCount;
			} else {
				byCounty.set(parsed.county, {
					county: parsed.county,
					centre: parsed.centre,
					regions: 1,
					routes: routeCount,
				});
			}
		}

		folders.push({
			folderId: folder.folderId,
			name: folder.name,
			regions: regions.length,
			routes,
			// Biggest first: the county a folder is really about leads its row.
			counties: [...byCounty.values()].sort((a, b) => b.routes - a.routes),
			unplaced,
		});
	}

	// Most turf first — the folders worth mapping to a chapter are at the top.
	folders.sort((a, b) => b.routes - a.routes);
	const scopeBox = boundingBox(counties.entries.map((e) => e.centre));
	return {
		folders,
		fetchedAt: new Date().toISOString(),
		errors,
		states: counties.states,
		statesInferred: configuredStates.length === 0,
		fallbackBounds: scopeBox ? padBounds(scopeBox, 0.08) : null,
	};
}

async function snapshot(force: boolean): Promise<Snapshot> {
	if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
	if (inFlight) return inFlight;
	inFlight = buildSnapshot()
		.then((result) => {
			cache = result;
			cacheAt = Date.now();
			return result;
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// Same gate as the other organizer pages: a bare 302 for a missing session
	// and for a signed-in non-admin alike.
	if (!locals.session?.isAdmin) redirect(302, '/');

	// Same basemap the volunteer turf page uses, keyed the same way: the keyless
	// CARTO endpoint watermarks every tile with "API Key required".
	const tiles = {
		urlTemplate: withTileApiKey(MAP_TILE_URL_TEMPLATE || TILE_URL_TEMPLATE, MAP_TILE_API_KEY),
		attribution: MAP_TILE_ATTRIBUTION || TILE_ATTRIBUTION,
	};

	// The mapping the page edits, and the chapters it can be edited to. Both
	// degrade rather than failing the page: with no chapter list the map and the
	// counties still answer the question the page is for, and the editor says
	// why it is empty instead of offering an empty dropdown.
	const [mappingResult, chapterResult, snapshotResult] = await Promise.allSettled([
		loadVanChapterFolders(db),
		getSolidarityChapters(SOLIDARITY_API_TOKEN),
		snapshot(url.searchParams.get('refresh') === '1'),
	]);

	// folderId → the chapters that see it, which is the direction this page edits.
	const chaptersByFolder = new Map<number, Array<{ chapterId: number; chapterName: string }>>();
	if (mappingResult.status === 'fulfilled') {
		for (const row of mappingResult.value) {
			for (const folderId of row.folderIds) {
				const list = chaptersByFolder.get(folderId);
				const entry = { chapterId: row.chapterId, chapterName: row.chapterName };
				if (list) list.push(entry);
				else chaptersByFolder.set(folderId, [entry]);
			}
		}
	}

	const chapters =
		chapterResult.status === 'fulfilled'
			? chapterResult.value.items.map((c) => ({ id: c.id, name: c.name }))
			: [];
	const chaptersError =
		chapterResult.status === 'rejected' ? errMessage(chapterResult.reason) : null;
	const mappingError =
		mappingResult.status === 'rejected' ? errMessage(mappingResult.reason) : null;

	if (snapshotResult.status === 'rejected') {
		// The page renders the reason rather than 500ing: "the key cannot read
		// folders" is exactly the sort of thing someone opens this page to find.
		return {
			folders: [],
			fetchedAt: null,
			errors: [],
			error: errMessage(snapshotResult.reason),
			tiles,
			states: [] as string[],
			statesInferred: true,
			fallbackBounds: null as BoundingBox | null,
			chapters,
			chaptersError,
			mappingError,
			mapping: [] as Array<{
				folderId: number;
				chapters: Array<{ chapterId: number; chapterName: string }>;
			}>,
		};
	}

	const { folders, fetchedAt, errors, states, statesInferred, fallbackBounds } =
		snapshotResult.value;
	return {
		folders,
		fetchedAt,
		errors,
		error: null,
		tiles,
		states,
		statesInferred,
		fallbackBounds,
		chapters,
		chaptersError,
		mappingError,
		// Only the folders on the page: a mapping row for a folder VAN no longer
		// shows is real and stays in the table, but this page cannot edit it.
		mapping: folders.map((folder) => ({
			folderId: folder.folderId,
			chapters: chaptersByFolder.get(folder.folderId) ?? [],
		})),
	};
};
