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

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
// Relative, not `$lib/...`: scripts/van-sync-once.ts runs this under tsx,
// outside the Vite bundle, where the alias does not resolve.
import { errMessage } from '../../err-message.js';
import {
	vanGeometryQueue,
	vanTurfs,
	vanTurfCheckouts,
	vanTurfPlacements,
	vanSyncState,
	vanTurfRoster,
} from '../schema.js';
import { UNPLACED_LABEL } from './turf-placement.js';
import { planCatalogSync, vanTimestamp, type CatalogFolder, type CatalogPlan } from './catalog.js';
import { chunked, idRows } from './sql-chunk.js';
import { RETIRED_ROSTER_KEEP_MS } from './contact-sync.js';
import { VanError, type VanClient } from './client.js';
import {
	loadClaimsForExports,
	loadMinivanExports,
	pullMinivanExports,
	stampClaimsLoaded,
} from './minivan-export-store.js';
import type { VanPrintedList } from './types.js';

// Matches the alias in settings.ts, which this file calls into — the
// narrower LibSQLDatabase<...> lacks the $client those helpers require.
type Db = ReturnType<typeof drizzle>;

const DEFAULT_TIME_BUDGET_MS = 4 * 60 * 1000;

/** Statements per libsql batch on the catalog's two hot write paths. Big enough
 *  that a statewide sync is tens of round trips rather than thousands, small
 *  enough that one request stays a sane size — a batch is held in memory whole
 *  at both ends. */
const WRITE_BATCH_SIZE = 100;

export interface CatalogSyncResult {
	foldersSynced: number;
	foldersSkipped: number;
	/** Turfs VAN listed this run, written or not. */
	turfsUpserted: number;
	/** Of those, the ones whose row actually changed and was written. The rest
	 *  matched what was stored and cost no write (turfRowChanged). */
	turfsWritten: number;
	turfsRetired: number;
	turfsUnretired: number;
	/** Stored turf whose VAN change waits for midnight — gone from VAN, or
	 *  its list changed — kept as volunteers were given it (changeHeld in
	 *  catalog.ts). */
	turfsHeld: number;
	/** New routes not added yet because they replace turf being held. */
	newTurfsHeld: number;
	geometryQueued: number;
	claimsReleased: number;
	/** Queue rows deleted because their turf was retired, or has no doors and
	 *  was still waiting. Reported rather than silent: it is the only signal
	 *  that geometry work was abandoned, as distinct from having failed. */
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
	/** Queue turfs for a roster export too (see CatalogInput.roster). */
	roster?: boolean;
	/** The campaign's requested-turf folder: read too, though no chapter is
	 *  mapped to it. Its turf is placed by van/turf-placement.ts. */
	requestedFolderId?: number | null;
}

/** Every printed list number this run's catalog could assign a turf: the
 *  route's own, and every number /printedLists offered as a backfill. A
 *  superset of what the planner picks, which is all the export lookup needs. */
function candidateListNumbers(folders: CatalogFolder[], printedLists: VanPrintedList[]): string[] {
	const numbers: string[] = [];
	for (const folder of folders) {
		for (const region of folder.regions) {
			for (const route of region.mapRoutes ?? []) {
				if (route.printedList?.number) numbers.push(route.printedList.number);
			}
		}
	}
	for (const list of printedLists) if (list.number) numbers.push(list.number);
	return numbers;
}

/**
 * Pull one campaign's turf catalog: every folder its chapters are mapped to,
 * read with that campaign's key.
 *
 * Everything read and written is scoped to `campaignId`. Another campaign's
 * turf is neither matched nor retired here — the folder ids in `mappings` are
 * this campaign's, and VAN's ids mean nothing outside the committee that
 * issued them.
 *
 * Optional-tier endpoints degrade instead of failing: a demo or sandbox key
 * without Tier 3 gets no /minivanExports and no /printedLists backfill, but
 * still gets a full catalog — which is the difference between "we can try this
 * today" and "we wait for the review to clear".
 */
export async function runCatalogSync(
	db: Db,
	client: VanClient,
	campaignId: number,
	mappings: ChapterFolders[],
	options: CatalogSyncOptions = {},
): Promise<CatalogSyncResult> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const degraded: string[] = [];

	const requestedFolderId = options.requestedFolderId ?? null;
	if (mappings.length === 0 && requestedFolderId === null) {
		return {
			foldersSynced: 0,
			foldersSkipped: 0,
			turfsUpserted: 0,
			turfsWritten: 0,
			turfsRetired: 0,
			turfsUnretired: 0,
			turfsHeld: 0,
			newTurfsHeld: 0,
			geometryQueued: 0,
			claimsReleased: 0,
			// Nothing is mapped, so nothing was read and nothing can be retired —
			// this branch never reaches the queue sweep.
			geometryQueueDropped: 0,
			regionsRead: [],
			degraded,
			warnings: [
				'No chapters are mapped to VAN folders — add them on the campaign’s page under Settings → VAN campaigns.',
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

	// One entry per FOLDER, not per chapter-folder pair.
	//
	// A folder mapped to eleven chapters used to be fetched eleven times and to
	// produce eleven upserts per route — all keyed by `turfId` alone, so the
	// last chapter written won and the other ten saw none of that folder's turf.
	// Visibility now comes from the mapping at query time (chapter-visibility.ts),
	// so the catalog reads each folder once and stores one row per turf.
	//
	// The chapter carried here is the first one mapped to the folder, in mapping
	// order. It is the row's display label — who can SEE the turf is every
	// chapter in `chapters`, which this loop no longer has to care about.
	//
	// A real chapter outranks an admin's turf-only one (negative id, see
	// turf_custom_chapters) whatever the order: the label is what the doors
	// board credits, and mapping a custom entry onto a chapter's folder must
	// not move that chapter's doors to it. A custom entry labels only a folder
	// no real chapter is mapped to.
	const folderOwners = new Map<
		number,
		{ chapterId: number; chapterName: string; requested?: true }
	>();
	for (const mapping of mappings) {
		for (const folderId of mapping.folderIds) {
			const current = folderOwners.get(folderId);
			if (!current || (current.chapterId < 0 && mapping.chapterId > 0)) {
				folderOwners.set(folderId, {
					chapterId: mapping.chapterId,
					chapterName: mapping.chapterName,
				});
			}
		}
	}

	// Placed turf by turf (turf-placement.ts), and labelled with the chapter it
	// is placed in. Mapped to chapters as well, those chapters see all of it
	// too, and the first of them labels turf not placed yet; otherwise it is
	// labelled "not placed yet" until it is.
	if (requestedFolderId !== null) {
		const mapped = folderOwners.get(requestedFolderId);
		folderOwners.set(requestedFolderId, {
			chapterId: mapped?.chapterId ?? 0,
			chapterName: mapped?.chapterName ?? UNPLACED_LABEL,
			requested: true,
		});
	}

	for (const [folderId, owner] of folderOwners) {
		if (Date.now() > deadline) {
			foldersSkipped++;
			continue;
		}
		try {
			const regions = await client.mapRegions(folderId);
			folders.push({
				folderId,
				folderName: folderNames.get(folderId) ?? '',
				chapterId: owner.chapterId,
				chapterName: owner.chapterName,
				regions,
				...(owner.requested ? { requested: true as const } : {}),
			});
		} catch (err) {
			// One unreadable folder must not retire another chapter's turf,
			// so it is skipped rather than contributing an empty region list.
			foldersSkipped++;
			const detail =
				err instanceof VanError && err.isAuthFailure
					? `${err.message} — check the key's tier for this folder`
					: errMessage(err);
			warnings.push(`Folder ${folderId} (${owner.chapterName}) failed to sync: ${detail}`);
			console.error(`[van] folder ${folderId} sync failed:`, detail);
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

	// Top up the stored exports, then read the ones this catalog could match.
	//
	// Recorded, not just logged: when the store is not current —
	// /minivanExports refused, or still backfilling — van_distributed_to is
	// incomplete for reasons that say nothing about VAN, and the column alone
	// cannot tell that apart from "nothing is distributed". The drift report
	// (Story 8.2) needs that difference, and this is the only moment anyone
	// knows it.
	//
	// The index is built from the STORE whether or not this run's read worked.
	// One failed read used to write NULL over every turf VAN had distributed;
	// now it leaves what the last good read established, and the flag above
	// keeps the drift report from trusting it.
	//
	// Skipped on a dry run, which must write nothing — it plans against what is
	// already stored.
	let minivanExportsOk = false;
	if (!options.dryRun) {
		try {
			const pulled = await pullMinivanExports(db, client, { campaignId, now });
			minivanExportsOk = pulled.complete;
			if (!pulled.complete) {
				// Logged rather than reported as `degraded`: that list goes to the
				// turf channel on every sync, and a backfill that finishes by
				// itself within a few runs is not something anyone needs to act on.
				console.log(
					`[van] /minivanExports: still catching up — read ${pulled.fetched} from ${pulled.from}; drift is not checked until the store is current`,
				);
			}
		} catch (err) {
			degraded.push(
				`/minivanExports unavailable (${errMessage(err)}) — turf assigned by hand in VAN will not be flagged`,
			);
		}
	}
	// Live turf in full; retired turf only as far as each use needs it.
	//
	// Every re-cut retires a region's routes and keeps the rows, so retired turf
	// outgrows live turf many times over — 29,251 retired against 12,245 live on
	// 2026-10-17, R10 alone re-cut six times in two weeks. Loaded whole, with
	// hulls and every other column, the catalog went past the machine's 512 MB
	// and was killed mid-sync on every run: no error recorded, lock left to
	// lapse, the catalog frozen. The planner needs a retired row only when VAN lists its
	// route again (an unretirement), so only those are read in full.
	const live = await db
		.select()
		.from(vanTurfs)
		.where(and(eq(vanTurfs.campaignId, campaignId), isNull(vanTurfs.retiredAt)));
	const retired = await db
		.select({
			turfId: vanTurfs.turfId,
			vanMapRouteId: vanTurfs.vanMapRouteId,
			retiredAt: vanTurfs.retiredAt,
		})
		.from(vanTurfs)
		.where(and(eq(vanTurfs.campaignId, campaignId), isNotNull(vanTurfs.retiredAt)));
	const routesRead = new Set(
		folders.flatMap((f) => f.regions.flatMap((r) => (r.mapRoutes ?? []).map((m) => m.mapRouteId))),
	);
	const returning = retired.filter((row) => routesRead.has(row.vanMapRouteId)).map((r) => r.turfId);
	const existing = [...live];
	for (const batch of chunked(returning)) {
		existing.push(...(await db.select().from(vanTurfs).where(inArray(vanTurfs.turfId, batch))));
	}
	// With the numbers live turf has, which VAN may no longer list: a turf
	// held until midnight is still handed out on its old one (catalog.ts,
	// changeHeld).
	const minivanExports = await loadMinivanExports(db, campaignId, [
		...candidateListNumbers(folders, printedLists),
		...live.flatMap((row) => (row.printedListNumber ? [row.printedListNumber] : [])),
	]);
	// Our own claims, so an export made while one of our volunteers held the
	// turf reads as them loading it rather than as the turf being handed out
	// elsewhere (catalog.ts, outsideAssignment).
	const claims = await loadClaimsForExports(db, campaignId, now);

	// What a new turf's id is checked against, across every campaign: whether
	// its own route id is held already, and the highest id in use, which the
	// ids for those that are start above. Each by key, in one request; not
	// every id in the table.
	const routeIds = [...routesRead].filter((id): id is number => typeof id === 'number');
	const takenTurfIds = new Set(
		(
			await db
				.select({ turfId: vanTurfs.turfId })
				.from(vanTurfs)
				.where(
					or(
						sql`${vanTurfs.turfId} in (${idRows(routeIds)})`,
						sql`${vanTurfs.turfId} = (select max(${vanTurfs.turfId}) from ${vanTurfs})`,
					),
				)
		).map((r) => r.turfId),
	);
	const placements = new Map(
		(
			await db
				.select({
					turfId: vanTurfPlacements.turfId,
					chapterId: vanTurfPlacements.chapterId,
					chapterName: vanTurfPlacements.chapterName,
				})
				.from(vanTurfPlacements)
		).map((p) => [p.turfId, p]),
	);
	const plan = planCatalogSync({
		campaignId,
		placements,
		takenTurfIds,
		folders,
		printedLists,
		existing,
		minivanExports,
		claims,
		roster: options.roster === true,
		now,
	});

	const regionsRead = folders.flatMap((folder) =>
		folder.regions.map((region) => ({
			folderId: folder.folderId,
			mapRegionId: region.mapRegionId,
			// Real UTC, not VAN's local clock: settleRefreshes compares it with
			// the time WE sent the request (see vanTimestamp).
			dateRefreshed: vanTimestamp(region.dateRefreshed),
		})),
	);

	if (options.dryRun) {
		return {
			foldersSynced: folders.length,
			foldersSkipped,
			turfsUpserted: plan.upserts.length,
			turfsWritten: plan.writes.length,
			turfsRetired: plan.retirements.length,
			turfsUnretired: plan.unretirements.length,
			turfsHeld: plan.held.turfs,
			newTurfsHeld: plan.held.newRoutes,
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

	// Written in batches, not one statement at a time.
	//
	// A statewide catalog is a couple of thousand routes, and the database is
	// remote: one round trip per row spent the endpoint's whole request budget
	// before geometry got a turn, which showed up as a queue that stopped
	// draining ("skipping geometry this run — the catalog used the request
	// budget") and, on the worst runs, as folders skipped entirely. libsql sends
	// a batch as one round trip, so the same writes cost tens of trips instead
	// of thousands.
	//
	// Batched in chunks rather than all at once: a batch is an implicit
	// transaction and the whole thing is held in memory on both ends, so one
	// statement per route across 2,000+ routes is a multi-megabyte request. The
	// exposure a chunk boundary creates is unchanged from before — a reader can
	// see some turfs' new door counts beside others' old ones, which the UI
	// already labels with the timestamp those counts came from.
	//
	// Only the rows that changed: rewriting an identical row still bills as a
	// row written, and on most runs nearly every turf is identical.
	for (const rows of chunked(plan.writes, WRITE_BATCH_SIZE)) {
		// Matched on VAN's id within the campaign, never on turfId: that is the
		// route's identity, and a colliding turf's turfId is not VAN's. Two
		// campaigns' syncs planning the same free id at the same instant fail one
		// batch on the primary key; that sync errors, and its next run, seeing
		// the id taken, plans another.
		const statements = rows.map((row) =>
			db
				.insert(vanTurfs)
				.values(row)
				.onConflictDoUpdate({ target: [vanTurfs.campaignId, vanTurfs.vanMapRouteId], set: row }),
		);
		await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
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
			...retired.filter((row) => !unretired.has(row.turfId)).map((row) => row.turfId),
		]),
	];

	const retireStatements = chunked(plan.retirements).map((batch) =>
		// A hold that ran out ends here: the change it held is the retirement.
		db
			.update(vanTurfs)
			.set({ retiredAt, vanChangedAt: null })
			.where(inArray(vanTurfs.turfId, batch)),
	);

	// Retirement releases live claims: a volunteer holding turf that no longer
	// exists in VAN has a list number that will not load in MiniVAN, and leaving
	// the claim in place hides that from both of them. The volunteer is told by
	// reconcile-store.ts on this same run, which pairs the dead route to
	// whatever VAN cut in its place.
	//
	// Except where a hold ran out (plan.holdsEnded): released at midnight with
	// the re-cut already stamped as dealt with, so reconcile-store neither
	// hands them new turf nor DMs them.
	const quiet = new Set(plan.holdsEnded);
	const release = (batch: number[], fields: { recutNotifiedAt?: string }) =>
		db
			.update(vanTurfCheckouts)
			.set({ releasedAt: retiredAt, releaseReason: 'retired', ...fields })
			.where(
				and(
					inArray(vanTurfCheckouts.turfId, batch),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
				),
			)
			.returning({ id: vanTurfCheckouts.id });
	const releaseStatements = [
		...chunked(plan.retirements.filter((id) => !quiet.has(id))).map((batch) => release(batch, {})),
		...chunked(plan.retirements.filter((id) => quiet.has(id))).map((batch) =>
			release(batch, { recutNotifiedAt: retiredAt }),
		),
	];

	// Turf with no doors is no longer queued (planCatalogSync), and VAN never
	// finishes exporting its empty list. Any row still waiting — queued before
	// that rule, or for a route VAN has since emptied — is dropped too, so the
	// next run does not spend an hour per resubmit on it before it dead-letters.
	// Only waiting rows: a done or failed one is the record of what happened.
	// Deleted rather than settled, so one that gains doors is queued afresh.
	const emptyTurfIds = plan.upserts.flatMap((row) =>
		(row.routeSize ?? 0) <= 0 && row.turfId !== undefined ? [row.turfId] : [],
	);
	const dropStatements = [
		...chunked(retiredRouteIds).map((batch) =>
			db
				.delete(vanGeometryQueue)
				.where(inArray(vanGeometryQueue.turfId, batch))
				.returning({ turfId: vanGeometryQueue.turfId }),
		),
		// And held turf's: VAN may already have deleted the saved list it keeps
		// until midnight, and the planner queues none for it meanwhile.
		...chunked([...emptyTurfIds, ...plan.heldTurfIds]).map((batch) =>
			db
				.delete(vanGeometryQueue)
				.where(
					and(
						inArray(vanGeometryQueue.turfId, batch),
						inArray(vanGeometryQueue.status, ['pending', 'running']),
					),
				)
				.returning({ turfId: vanGeometryQueue.turfId }),
		),
	];
	// A retired route's people are a cut nobody can walk any more — but not
	// straight away: a completion on it still derives its % walked from its
	// count for RETIRED_ROSTER_KEEP_MS (see contact-sync.ts), and marking walked
	// is itself what asks VAN for the re-cut that retires it. So only routes
	// retired longer ago than that; one retired on this run keeps its roster.
	// Last in the batch, and not counted, so the result indexes above are
	// unchanged.
	const rosterCutoff = new Date(now.getTime() - RETIRED_ROSTER_KEEP_MS).toISOString();
	const rosterExpired = retired
		.filter(
			(row) => row.retiredAt !== null && row.retiredAt < rosterCutoff && !unretired.has(row.turfId),
		)
		.map((row) => row.turfId);
	const rosterStatements = chunked(rosterExpired).map((batch) =>
		db.delete(vanTurfRoster).where(inArray(vanTurfRoster.turfId, batch)),
	);
	// Turf VAN has dropped, kept live until midnight: when the hold began, which
	// is what says which midnight. Only where none is stamped, so a later run
	// cannot push it back. Last, and not counted, like the roster deletes.
	const holdStatements = chunked(plan.holdsStarted).map((batch) =>
		db
			.update(vanTurfs)
			.set({ vanChangedAt: now.toISOString() })
			.where(and(inArray(vanTurfs.turfId, batch), isNull(vanTurfs.vanChangedAt))),
	);
	// Held turf VAN no longer returns gets no upsert, so who has it outside the
	// app is written here. Last and not counted, with the holds.
	const assignmentStatements = plan.heldAssignments.map(({ turfId, ...assignment }) =>
		db.update(vanTurfs).set(assignment).where(eq(vanTurfs.turfId, turfId)),
	);

	let claimsReleased = 0;
	let geometryQueueDropped = 0;
	const statements = [
		...retireStatements,
		...releaseStatements,
		...dropStatements,
		...rosterStatements,
		...holdStatements,
		...assignmentStatements,
	];
	if (statements.length > 0) {
		const results = (await db.batch(
			statements as unknown as Parameters<typeof db.batch>[0],
		)) as unknown as unknown[][];
		const releaseFrom = retireStatements.length;
		const dropFrom = releaseFrom + releaseStatements.length;
		for (let i = releaseFrom; i < dropFrom; i++) claimsReleased += results[i]?.length ?? 0;
		const dropTo = dropFrom + dropStatements.length;
		for (let i = dropFrom; i < dropTo; i++) geometryQueueDropped += results[i]?.length ?? 0;
	}

	// plan.unretirements needs no write of its own — the upsert above already
	// set `retiredAt: null` on every route VAN returned. It is reported because
	// a route coming back from retirement is worth seeing in the log.

	// Queue geometry work.
	//
	// This was `onConflictDoNothing`, to keep a turf that is queued or
	// mid-flight from being reset to pending under the worker's feet. That
	// protected the right thing and broke re-cut detection while doing it: the
	// row is keyed by turfId, so once a turf had ANY queue row, a later
	// sync could never correct it. A re-cut turf keeps its VAN route id and gets
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
	//
	// The one other re-arm: a `done` row whose turf has no roster for its
	// current saved list (the uncontacted-door count's first pass, or a turf
	// hulled before rosters existed). Only `done` — a `failed` row stays failed
	// for the reason above, and a pending or running one will build the roster
	// anyway. Once the worker writes the roster the planner stops asking. And
	// only a `done` row with no error: one that says why no roster could be
	// built (the wrong export type) would fail the same way every run.
	// Batched for the same reason as the upserts above: one queue row per turf
	// is another round trip per turf, on the same hot path.
	// The plan names turf by VAN id; the upserts above have written each
	// one's turfId.
	const turfIdByRoute = new Map(
		(
			await db
				.select({ turfId: vanTurfs.turfId, vanMapRouteId: vanTurfs.vanMapRouteId })
				.from(vanTurfs)
				.where(eq(vanTurfs.campaignId, campaignId))
		).map((r) => [r.vanMapRouteId, r.turfId]),
	);
	const queueItems = plan.geometryQueue.flatMap((item) => {
		const turfId = turfIdByRoute.get(item.vanMapRouteId);
		return turfId === undefined ? [] : [{ ...item, turfId }];
	});
	for (const items of chunked(queueItems, WRITE_BATCH_SIZE)) {
		const statements = items.map((item) =>
			db
				.insert(vanGeometryQueue)
				.values({
					turfId: item.turfId,
					savedListId: item.savedListId,
					status: 'pending',
					attempts: 0,
				})
				.onConflictDoUpdate({
					target: vanGeometryQueue.turfId,
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
					where: item.roster
						? or(
								ne(vanGeometryQueue.savedListId, item.savedListId),
								and(eq(vanGeometryQueue.status, 'done'), isNull(vanGeometryQueue.lastError)),
							)
						: ne(vanGeometryQueue.savedListId, item.savedListId),
				}),
		);
		await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
	}

	await stampClaimsLoaded(db, plan.claimsLoaded);

	// Written last, and only on a real run: a dry run reports what WOULD happen,
	// so recording it as what the catalog now reflects would make the drift
	// report trust a comparison that never took place.
	//
	// A completed sync also clears this campaign's recorded failure, so the
	// next one is announced afresh rather than taken for the old one.
	await db
		.insert(vanSyncState)
		.values({ campaignId, lastSyncAt: now.toISOString(), minivanExportsOk })
		.onConflictDoUpdate({
			target: vanSyncState.campaignId,
			set: { lastSyncAt: now.toISOString(), minivanExportsOk, lastError: null, alertedError: null },
		});

	return {
		foldersSynced: folders.length,
		foldersSkipped,
		turfsUpserted: plan.upserts.length,
		turfsWritten: plan.writes.length,
		turfsRetired: plan.retirements.length,
		turfsUnretired: plan.unretirements.length,
		turfsHeld: plan.held.turfs,
		newTurfsHeld: plan.held.newRoutes,
		geometryQueued: plan.geometryQueue.length,
		claimsReleased,
		geometryQueueDropped,
		regionsRead,
		degraded,
		warnings: [...warnings, ...plan.warnings],
		plan,
	};
}
