// Catalog sync orchestration: read the chapter → folder mapping, pull each
// folder's map regions from VAN, hand everything to the pure planner in
// catalog.ts, and apply the result.
//
// The interesting decisions are deliberately NOT here — this file fetches,
// writes, and budgets time. Anything that has to be reasoned about lives in
// catalog.ts with tests.
//
// Time budget: Fly auto-stops the machine, and a folder with a slow region
// must not hold a request open until the platform kills it mid-write. When the
// budget lapses we stop fetching, apply what we have, and report the folders
// we skipped — a partial sync is safe because retirement is scoped to the
// folders actually fetched (see planCatalogSync).

import { and, inArray, isNull, ne } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
// Relative, not `$lib/...`: scripts/van-sync-once.ts runs this under tsx,
// outside the Vite bundle, where the alias does not resolve.
import { errMessage } from '../../err-message.js';
import { vanGeometryQueue, vanTurfs, vanTurfCheckouts, vanSyncState } from '../schema.js';
import { planCatalogSync, type CatalogFolder, type CatalogPlan } from './catalog.js';
import { chunked } from './sql-chunk.js';
import { VanError, type VanClient } from './client.js';
import type { VanMinivanExport, VanPrintedList } from './types.js';

// Matches the alias in settings.ts, which this file calls into — the
// narrower LibSQLDatabase<...> lacks the $client those helpers require.
type Db = ReturnType<typeof drizzle>;

const DEFAULT_TIME_BUDGET_MS = 4 * 60 * 1000;

export interface CatalogSyncResult {
	foldersSynced: number;
	foldersSkipped: number;
	turfsUpserted: number;
	turfsRetired: number;
	turfsUnretired: number;
	geometryQueued: number;
	claimsReleased: number;
	/** Queue rows deleted because their turf was retired. Reported rather than
	 *  silent: it is the only signal that geometry work was abandoned, as
	 *  distinct from having failed. */
	geometryQueueDropped: number;
	/** Every region this run actually read, with VAN's own `dateRefreshed`.
	 *
	 *  The confirmation half of the refresh cycle (Story 4.1): a refresh is
	 *  asynchronous and VAN never says it finished, so the evidence is that a
	 *  region's dateRefreshed has moved on a LATER read. Reported from here
	 *  rather than re-fetched because this is the read — asking again would be
	 *  a second call for an answer we already have. */
	regionsRead: Array<{ folderId: number; mapRegionId: number; dateRefreshed: string | null }>;
	/** True when /minivanExports or /printedLists were unavailable — the sync
	 *  still ran, with less cross-checking. */
	degraded: string[];
	warnings: string[];
	/** The computed plan. Present so a dry run can show the actual rows; a real
	 *  run carries it too, which is handy when reading a failed sync's log. */
	plan?: CatalogPlan;
}

/** Chapter → VAN folders, as an input. Structurally compatible with
 *  settings.ts's `VanChapterFolderEntry`, but declared here so this module
 *  does not depend on the settings layer — that import pulled in `./env.js`
 *  and with it `$env/dynamic/private`, which made the sync unloadable from a
 *  plain node script (scripts/van-sync-once.ts). Taking the mapping as an
 *  argument is also the honest shape: this is an input the caller chooses. */
export interface ChapterFolders {
	chapterId: number;
	chapterName: string;
	folderIds: number[];
}

export interface CatalogSyncOptions {
	timeBudgetMs?: number;
	now?: Date;
	/** Fetch and plan, but write nothing. The returned counts describe what
	 *  WOULD have happened, so an operator can see the blast radius of a first
	 *  run — particularly the retirements — before committing to it. */
	dryRun?: boolean;
}

/**
 * Pull the turf catalog for every chapter that has a folder mapping.
 *
 * Optional-tier endpoints degrade instead of failing: a demo or sandbox key
 * without Tier 3 gets no /minivanExports and no /printedLists backfill, but
 * still gets a full catalog — which is the difference between "we can try this
 * today" and "we wait for the review to clear".
 */
export async function runCatalogSync(
	db: Db,
	client: VanClient,
	mappings: ChapterFolders[],
	options: CatalogSyncOptions = {},
): Promise<CatalogSyncResult> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const degraded: string[] = [];

	if (mappings.length === 0) {
		return {
			foldersSynced: 0,
			foldersSkipped: 0,
			turfsUpserted: 0,
			turfsRetired: 0,
			turfsUnretired: 0,
			geometryQueued: 0,
			claimsReleased: 0,
			// Nothing is mapped, so nothing was read and nothing can be retired —
			// this branch never reaches the queue sweep.
			geometryQueueDropped: 0,
			regionsRead: [],
			degraded,
			warnings: [
				'No chapters are mapped to VAN folders — add them under Settings → Chapter → VAN folders.',
			],
		};
	}

	// Folder names are cosmetic here (they only reach logs), so a key that
	// cannot list folders is not a failure.
	const folderNames = new Map<number, string>();
	try {
		for (const folder of await client.folders()) {
			folderNames.set(folder.folderId, folder.name);
		}
	} catch (err) {
		degraded.push(`/folders unavailable (${errMessage(err)}) — folder names will be blank`);
	}

	const folders: CatalogFolder[] = [];
	let foldersSkipped = 0;
	const warnings: string[] = [];

	for (const mapping of mappings) {
		for (const folderId of mapping.folderIds) {
			if (Date.now() > deadline) {
				foldersSkipped++;
				continue;
			}
			try {
				const regions = await client.mapRegions(folderId);
				folders.push({
					folderId,
					folderName: folderNames.get(folderId) ?? '',
					chapterId: mapping.chapterId,
					chapterName: mapping.chapterName,
					regions,
				});
			} catch (err) {
				// One unreadable folder must not retire another chapter's turf,
				// so it is skipped rather than contributing an empty region list.
				foldersSkipped++;
				const detail =
					err instanceof VanError && err.isAuthFailure
						? `${err.message} — check the key's tier for this folder`
						: errMessage(err);
				warnings.push(`Folder ${folderId} (${mapping.chapterName}) failed to sync: ${detail}`);
				console.error(`[van] folder ${folderId} sync failed:`, detail);
			}
		}
	}

	const folderIds = folders.map((f) => f.folderId);

	let printedLists: VanPrintedList[] = [];
	if (folderIds.length > 0) {
		try {
			printedLists = await client.printedLists(folderIds);
		} catch (err) {
			degraded.push(`/printedLists unavailable (${errMessage(err)}) — no list-number backfill`);
		}
	}

	let minivanExports: VanMinivanExport[] = [];
	// Recorded, not just logged: when this fails the plan below writes
	// van_distributed_to = NULL for every turf, so afterwards the column cannot
	// say whether VAN reported nothing or was never asked. The drift report
	// (Story 8.2) needs that difference, and this is the only moment anyone
	// knows it.
	let minivanExportsOk = true;
	try {
		minivanExports = await client.minivanExports();
	} catch (err) {
		minivanExportsOk = false;
		degraded.push(
			`/minivanExports unavailable (${errMessage(err)}) — turf assigned by hand in VAN will not be flagged`,
		);
	}

	const existing = await db.select().from(vanTurfs);
	const plan = planCatalogSync({ folders, printedLists, existing, minivanExports, now });

	const regionsRead = folders.flatMap((folder) =>
		folder.regions.map((region) => ({
			folderId: folder.folderId,
			mapRegionId: region.mapRegionId,
			dateRefreshed: region.dateRefreshed ?? null,
		})),
	);

	if (options.dryRun) {
		return {
			foldersSynced: folders.length,
			foldersSkipped,
			turfsUpserted: plan.upserts.length,
			turfsRetired: plan.retirements.length,
			turfsUnretired: plan.unretirements.length,
			geometryQueued: plan.geometryQueue.length,
			claimsReleased: 0,
			// A dry run cannot know how many queue rows exist without reading them,
			// and the retirement count already shows the blast radius.
			geometryQueueDropped: 0,
			regionsRead,
			degraded,
			warnings: [...warnings, ...plan.warnings],
			plan,
		};
	}

	for (const row of plan.upserts) {
		await db
			.insert(vanTurfs)
			.values(row)
			.onConflictDoUpdate({ target: vanTurfs.mapRouteId, set: row });
	}

	// The retirement group, written as ONE atomic batch.
	//
	// Three writes belong together — stamp `retiredAt`, release the claims on
	// those routes, drop their queued geometry — and Story 4.5.3 is about what a
	// reader sees while they are in flight. Applied separately, there is a
	// window where a turf is retired but a volunteer is still recorded as
	// holding it (the drift report reads that pair and would call it a
	// collision), and a longer one where a claim is released while its turf
	// still looks live, which is a turf two people can hold. libsql runs a batch
	// as an implicit transaction, so a reader sees all of it or none of it.
	//
	// The upserts above are deliberately NOT in the batch. There are hundreds of
	// them on a real catalog, and the exposure they carry is a page that shows
	// some turfs' new door counts alongside others' old ones — which the UI
	// already labels with the timestamp those counts came from. Atomicity there
	// would cost a multi-megabyte statement to fix a cosmetic problem.
	//
	// Chunking is still per statement, not per batch: the parameter cap applies
	// to one inArray(), and a batch of several capped statements is fine.
	const retiredAt = now.toISOString();

	// Retirement also abandons any geometry work still queued for that turf.
	//
	// VAN deletes a route's saved list along with the route, so an export queued
	// against it can no longer succeed — observed live as `'savedListId' must be
	// a valid saved list ID in this context`. Left in place, each such row burns
	// all MAX_ATTEMPTS retries and then dead-letters, and every dead letter is
	// posted to the tracking channel. That is a Slack alert per retired turf,
	// describing turf nobody can see, for a failure with no action behind it.
	//
	// Deleted rather than marked `failed` so the queue keeps meaning "work that
	// could still succeed".
	//
	// Scoped to every turf that is retired once this run has finished, NOT just
	// the ones retired ON this run. Draining only `plan.retirements` would leave
	// rows already stranded by earlier syncs to go on failing forever — three of
	// them were sitting in production when this was written — and would make the
	// cleanup depend on catching each retirement in the one run that performed
	// it. As a sweep it is idempotent and self-healing: the second run finds
	// nothing left to delete and reports zero.
	//
	// Unretirements are excluded: the upsert above cleared their `retiredAt`, and
	// the geometry insert below is about to re-queue them on this same run.
	const unretired = new Set(plan.unretirements);
	const retiredRouteIds = [
		...new Set([
			...plan.retirements,
			...existing
				.filter((row) => row.retiredAt !== null && !unretired.has(row.mapRouteId))
				.map((row) => row.mapRouteId),
		]),
	];

	const retireStatements = chunked(plan.retirements).map((batch) =>
		db.update(vanTurfs).set({ retiredAt }).where(inArray(vanTurfs.mapRouteId, batch)),
	);

	// Retirement releases live claims: a volunteer holding turf that no longer
	// exists in VAN has a list number that will not load in MiniVAN, and leaving
	// the claim in place hides that from both of them. The volunteer is told by
	// reconcile-store.ts on this same run, which pairs the dead route to
	// whatever VAN cut in its place.
	const releaseStatements = chunked(plan.retirements).map((batch) =>
		db
			.update(vanTurfCheckouts)
			.set({ releasedAt: retiredAt, releaseReason: 'retired' })
			.where(
				and(
					inArray(vanTurfCheckouts.mapRouteId, batch),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
				),
			)
			.returning({ id: vanTurfCheckouts.id }),
	);

	const dropStatements = chunked(retiredRouteIds).map((batch) =>
		db
			.delete(vanGeometryQueue)
			.where(inArray(vanGeometryQueue.mapRouteId, batch))
			.returning({ mapRouteId: vanGeometryQueue.mapRouteId }),
	);

	let claimsReleased = 0;
	let geometryQueueDropped = 0;
	const statements = [...retireStatements, ...releaseStatements, ...dropStatements];
	if (statements.length > 0) {
		const results = (await db.batch(
			statements as unknown as Parameters<typeof db.batch>[0],
		)) as unknown as unknown[][];
		const releaseFrom = retireStatements.length;
		const dropFrom = releaseFrom + releaseStatements.length;
		for (let i = releaseFrom; i < dropFrom; i++) claimsReleased += results[i]?.length ?? 0;
		for (let i = dropFrom; i < results.length; i++) geometryQueueDropped += results[i]?.length ?? 0;
	}

	// plan.unretirements needs no write of its own — the upsert above already
	// set `retiredAt: null` on every route VAN returned. It is reported because
	// a route coming back from retirement is worth seeing in the log.

	// Queue geometry work.
	//
	// This was `onConflictDoNothing`, to keep a turf that is queued or
	// mid-flight from being reset to pending under the worker's feet. That
	// protected the right thing and broke re-cut detection while doing it: the
	// row is keyed by mapRouteId, so once a turf had ANY queue row, a later
	// sync could never correct it. A re-cut turf keeps its mapRouteId and gets
	// a NEW savedListId (observed live: "Orlando Turf 01" moved from 585052 to
	// 585484 when the demo region was re-cut), so the stale row kept pointing
	// at a saved list VAN now rejects with `'savedListId' must be a valid saved
	// list ID in this context`. Story 2.5's whole re-cut path — invalidate the
	// hull, queue a fresh export — stopped at the queue.
	//
	// So: re-arm the row, but ONLY when the saved list actually changed. That
	// is the signal that this is genuinely new work rather than the same job
	// coming round again, and gating on it matters more than it looks. A turf
	// with no hull is queued by `needsGeometry` on EVERY sync (it has no
	// hullJson, so there is nothing to compare), and this endpoint runs 37
	// times a day. Re-arming unconditionally would submit an export job per
	// turf per run, forever, for exactly the turf least likely to ever produce
	// a hull — the demo database, for instance, populates Address and ZipCode
	// but leaves VAddressLatitude/VAddressLongitude empty on every row, so no
	// amount of retrying will geocode it.
	//
	// A settled row therefore stays settled until VAN re-cuts the turf, and
	// clearing a `failed` row by hand is the deliberate way to force a retry.
	for (const item of plan.geometryQueue) {
		await db
			.insert(vanGeometryQueue)
			.values({
				mapRouteId: item.mapRouteId,
				savedListId: item.savedListId,
				status: 'pending',
				attempts: 0,
			})
			.onConflictDoUpdate({
				target: vanGeometryQueue.mapRouteId,
				set: {
					savedListId: item.savedListId,
					status: 'pending',
					attempts: 0,
					// Cleared together: a job id, error or timestamp from the
					// previous saved list describes work that no longer exists.
					exportJobId: null,
					lastError: null,
					requestedAt: null,
					completedAt: null,
				},
				// Refers to the EXISTING row, so this is "the stored saved list
				// differs from the one VAN just reported".
				where: ne(vanGeometryQueue.savedListId, item.savedListId),
			});
	}

	// Written last, and only on a real run: a dry run reports what WOULD happen,
	// so recording it as what the catalog now reflects would make the drift
	// report trust a comparison that never took place.
	await db
		.insert(vanSyncState)
		.values({ id: 1, lastSyncAt: now.toISOString(), minivanExportsOk })
		.onConflictDoUpdate({
			target: vanSyncState.id,
			set: { lastSyncAt: now.toISOString(), minivanExportsOk },
		});

	return {
		foldersSynced: folders.length,
		foldersSkipped,
		turfsUpserted: plan.upserts.length,
		turfsRetired: plan.retirements.length,
		turfsUnretired: plan.unretirements.length,
		geometryQueued: plan.geometryQueue.length,
		claimsReleased,
		geometryQueueDropped,
		regionsRead,
		degraded,
		warnings: [...warnings, ...plan.warnings],
		plan,
	};
}
