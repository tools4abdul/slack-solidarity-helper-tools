import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { PRIMARY_CAMPAIGN_ID, vanCampaigns, type VanCampaignRow } from '$lib/server/schema.js';
import { vanClientFor } from '$lib/server/van-env.js';
import { campaignName, loadCampaign } from '$lib/server/van/campaigns.js';
import { loadTurfCustomChapters, loadVanChapterFolders } from '$lib/server/settings.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import { labelCustomChapters } from '$lib/chapter-list.js';
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
	ALL_STATES,
	countyIndexFor,
	inferCountyIndex,
	parseCampaignStates,
	type CountyIndex,
} from '$lib/server/geo/counties.js';
import { boundingBox, padBounds, type BoundingBox, type LatLng } from '$lib/van/geometry.js';
import type { VanMapRegion } from '$lib/server/van/types.js';

// Which VAN folder covers which part of the state — the page for deciding what
// a folder should be mapped to on its campaign's page under Settings → VAN
// campaigns.
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
//
// Only the VAN read is cached. Which state the counties are read in is decided
// per request — `?state=XX`, else CAMPAIGN_STATES, else inferred from the names
// — so picking a state on the page re-reads the cached regions, not VAN.
//
// The slow part is returned unawaited, so SvelteKit streams it: the page
// renders its header and state picker at once and fills in when VAN answers.

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

/** What VAN returned for one campaign — the expensive part, cached as-is so
 *  the county lookup can be redone against any state without asking again. */
interface Snapshot {
	/** Folders with at least one map region, with those regions. */
	fetched: Array<{ folderId: number; name: string; regions: VanMapRegion[] }>;
	/** Folders the key can see with no map region cut in them yet. Listed so
	 *  they can be mapped to chapters ahead of the cut — the mapping is an input
	 *  to the sync, not something it discovers — and so a campaign whose
	 *  folders are shared but empty does not look like a page that failed. */
	emptyFolders: Array<{ folderId: number; name: string }>;
	fetchedAt: string;
	/** Folders VAN would not show us, by name — one line per failure. */
	errors: string[];
}

/** Where the states the counties were read in came from. Shown on the page,
 *  because a guessed state is something an operator should be able to see and
 *  correct. */
export type StatesSource = 'picked' | 'configured' | 'inferred';

interface Placement {
	folders: FolderSummary[];
	states: string[];
	statesSource: StatesSource;
	/** Frame for the map when no folder resolved to anywhere — the states in
	 *  scope, rather than a hardcoded corner of the country. */
	fallbackBounds: BoundingBox | null;
}

/** Per campaign: each reads its own folders with its own key. */
const cache = new Map<number, { snapshot: Snapshot; at: number }>();
/** In-flight fetch per campaign, so two admins opening the page do not each
 *  spend 19 VAN round trips building the same snapshot. */
const inFlight = new Map<number, Promise<Snapshot>>();

async function buildSnapshot(campaign: VanCampaignRow): Promise<Snapshot> {
	// The campaign's own folders, with its own key — the ids in its mapping
	// mean nothing to another campaign's key.
	const configured = vanClientFor(campaign);
	if (!configured.ok) throw new Error(configured.error);
	const client = configured.client;

	const fetched: Snapshot['fetched'] = [];
	const emptyFolders: Snapshot['emptyFolders'] = [];
	const errors: string[] = [];

	for (const folder of await client.folders()) {
		try {
			const regions = await client.mapRegions(folder.folderId);
			if (regions.length > 0) {
				fetched.push({ folderId: folder.folderId, name: folder.name, regions });
			} else {
				emptyFolders.push({ folderId: folder.folderId, name: folder.name });
			}
		} catch (err) {
			errors.push(`${folder.name} (${folder.folderId}): ${errMessage(err)}`);
		}
	}

	emptyFolders.sort((a, b) => a.name.localeCompare(b.name));
	return { fetched, emptyFolders, fetchedAt: new Date().toISOString(), errors };
}

/** Place every folder's regions on counties. `picked` is a state chosen on the
 *  page; it wins over CAMPAIGN_STATES, which wins over inference. */
function placeFolders(fetched: Snapshot['fetched'], picked: string | null): Placement {
	const configuredStates = parseCampaignStates(CAMPAIGN_STATES);
	// The county lookup is built from every region name at once: which states
	// are in play is a property of the whole catalog, not of the folder that
	// happens to be read first.
	const regionNames = fetched.flatMap((f) => f.regions.map((r) => r.name ?? ''));
	const statesSource: StatesSource = picked
		? 'picked'
		: configuredStates.length > 0
			? 'configured'
			: 'inferred';
	const counties: CountyIndex = picked
		? countyIndexFor([picked])
		: configuredStates.length > 0
			? countyIndexFor(configuredStates)
			: inferCountyIndex(regionNames.flatMap(countyCandidates));

	const folders: FolderSummary[] = [];
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
		states: counties.states,
		statesSource,
		fallbackBounds: scopeBox ? padBounds(scopeBox, 0.08) : null,
	};
}

async function snapshot(campaign: VanCampaignRow, force: boolean): Promise<Snapshot> {
	const cached = cache.get(campaign.id);
	if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snapshot;
	const pending = inFlight.get(campaign.id);
	if (pending) return pending;
	const started = buildSnapshot(campaign)
		.then((result) => {
			cache.set(campaign.id, { snapshot: result, at: Date.now() });
			return result;
		})
		.finally(() => {
			inFlight.delete(campaign.id);
		});
	inFlight.set(campaign.id, started);
	return started;
}

type ChapterRef = { chapterId: number; chapterName: string };

/** Everything that waits on VAN or the chapter list — streamed to the page. */
export interface FolderData {
	folders: FolderSummary[];
	emptyFolders: Snapshot['emptyFolders'];
	fetchedAt: string | null;
	errors: string[];
	/** Set when the folders could not be read at all. */
	error: string | null;
	states: string[];
	statesSource: StatesSource;
	fallbackBounds: BoundingBox | null;
	chapters: Array<{ id: number; name: string }>;
	chaptersError: string | null;
	mappingError: string | null;
	mapping: Array<{ folderId: number; chapters: ChapterRef[] }>;
}

/** Never rejects: every failure becomes a field the page renders, so a
 *  streamed promise cannot take the page down with it. */
async function loadFolderData(
	campaign: VanCampaignRow,
	force: boolean,
	picked: string | null,
): Promise<FolderData> {
	// The mapping the page edits, and the chapters it can be edited to. Both
	// degrade rather than failing the page: with no chapter list the map and the
	// counties still answer the question the page is for, and the editor says
	// why it is empty instead of offering an empty dropdown.
	const [mappingResult, chapterResult, customResult, snapshotResult] = await Promise.allSettled([
		loadVanChapterFolders(db, campaign.id),
		getSolidarityChapters(SOLIDARITY_API_TOKEN),
		loadTurfCustomChapters(db),
		snapshot(campaign, force),
	]);

	// folderId → the chapters that see it, which is the direction this page edits.
	const chaptersByFolder = new Map<number, ChapterRef[]>();
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

	// Solidarity's chapters plus the admin's turf-only ones, which still list
	// when Solidarity is down — they are ours, not its.
	const solidarity =
		chapterResult.status === 'fulfilled'
			? chapterResult.value.items.map((c) => ({ id: c.id, name: c.name }))
			: [];
	const chapters = [
		...solidarity,
		...(customResult.status === 'fulfilled'
			? labelCustomChapters(
					customResult.value,
					solidarity.map((c) => c.name),
				).map((c) => ({ id: c.chapterId, name: c.name }))
			: []),
	].sort((a, b) => a.name.localeCompare(b.name));
	// Either list failing is said, not swallowed: a custom chapter missing from
	// the picker with no reason given reads as one that was deleted.
	const chaptersError =
		[
			chapterResult.status === 'rejected' ? errMessage(chapterResult.reason) : null,
			customResult.status === 'rejected'
				? `custom chapters: ${errMessage(customResult.reason)}`
				: null,
		]
			.filter((e) => e !== null)
			.join('; ') || null;
	const mappingError =
		mappingResult.status === 'rejected' ? errMessage(mappingResult.reason) : null;

	if (snapshotResult.status === 'rejected') {
		// The page renders the reason rather than 500ing: "the key cannot read
		// folders" is exactly the sort of thing someone opens this page to find.
		return {
			folders: [],
			emptyFolders: [],
			fetchedAt: null,
			errors: [],
			error: errMessage(snapshotResult.reason),
			states: [],
			statesSource: picked ? 'picked' : 'inferred',
			fallbackBounds: null,
			chapters,
			chaptersError,
			mappingError,
			mapping: [],
		};
	}

	const { fetched, emptyFolders, fetchedAt, errors } = snapshotResult.value;
	const { folders, states, statesSource, fallbackBounds } = placeFolders(fetched, picked);
	return {
		folders,
		emptyFolders,
		fetchedAt,
		errors,
		error: null,
		states,
		statesSource,
		fallbackBounds,
		chapters,
		chaptersError,
		mappingError,
		// Only the folders on the page: a mapping row for a folder VAN no longer
		// shows is real and stays in the table, but this page cannot edit it.
		mapping: [...folders, ...emptyFolders].map((folder) => ({
			folderId: folder.folderId,
			chapters: chaptersByFolder.get(folder.folderId) ?? [],
		})),
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// Same gate as the other organizer pages: a bare 302 for a missing session
	// and for a signed-in non-admin alike.
	if (!locals.session?.isAdmin) redirect(302, '/');

	// `?campaign=<id>`, the primary campaign by default: the page shows and
	// edits one campaign's folders at a time.
	const requested = Number(url.searchParams.get('campaign') ?? PRIMARY_CAMPAIGN_ID);
	const campaign =
		Number.isInteger(requested) && requested > 0 ? await loadCampaign(db, requested) : null;
	if (!campaign) error(404, 'No such campaign');
	const campaigns = (await db.select().from(vanCampaigns).orderBy(vanCampaigns.id)).map((c) => ({
		id: c.id,
		name: campaignName(c),
	}));

	// `?state=XX` confines the county lookup to one state. Anything that is not
	// a state in the table is ignored rather than 400ing — it is a picker, and
	// a stale link should still show the page.
	const stateParam = (url.searchParams.get('state') ?? '').trim().toUpperCase();
	const pickedState = ALL_STATES.includes(stateParam) ? stateParam : null;

	// Same basemap the volunteer turf page uses, keyed the same way: the keyless
	// CARTO endpoint watermarks every tile with "API Key required".
	const tiles = {
		urlTemplate: withTileApiKey(MAP_TILE_URL_TEMPLATE || TILE_URL_TEMPLATE, MAP_TILE_API_KEY),
		attribution: MAP_TILE_ATTRIBUTION || TILE_ATTRIBUTION,
	};

	return {
		campaign: { id: campaign.id, name: campaignName(campaign) },
		campaigns,
		tiles,
		stateOptions: ALL_STATES,
		pickedState,
		configuredStates: parseCampaignStates(CAMPAIGN_STATES),
		// Returned unawaited so SvelteKit streams it.
		folderData: loadFolderData(campaign, url.searchParams.get('refresh') === '1', pickedState),
	};
};
