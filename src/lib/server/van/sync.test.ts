import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCatalogSync } from './sync.js';
import { VanError, VanIncompleteError, type VanClient } from './client.js';
import type { VanMapRegion } from './types.js';
import { vanGeometryQueue } from '../schema.js';
import {
	loadClaimsForExports,
	loadMinivanExports,
	pullMinivanExports,
	stampClaimsLoaded,
} from './minivan-export-store.js';

// The export store runs real SQL against its own table, which the recording
// stub below does not model; it has its own tests on in-memory libsql. Here it
// is replaced by a pass-through to the client, so a test can still make VAN
// refuse the endpoint and watch the sync degrade.
vi.mock('./minivan-export-store.js', () => ({
	pullMinivanExports: vi.fn(async (_db: unknown, client: VanClient) => {
		const { items, complete } = await client.minivanExportsSince('2026-09-01', 150);
		return { from: '2026-09-01', fetched: items.length, complete };
	}),
	loadMinivanExports: vi.fn(async () => []),
	loadClaimsForExports: vi.fn(async () => []),
	stampClaimsLoaded: vi.fn(async () => undefined),
}));

// A recording stub of the drizzle chains sync.ts actually uses. Enough to
// assert what was written without standing up SQLite; the storage-level
// guarantees (the partial unique index) are covered by their own tests.
function makeDb(existing: unknown[] = [], deletedRows: unknown[] = [{ mapRouteId: 100 }]) {
	const inserted: unknown[] = [];
	const updates: unknown[] = [];
	/** Tables `.delete()` was called against, so a test can assert that
	 *  retirement clears the geometry queue and not something else. */
	const deletedFrom: unknown[] = [];
	const db = {
		// The retirement group is applied as one libsql batch (see sync.ts), so
		// the stub has to accept one. Drizzle hands `batch` un-awaited builders
		// and returns their results in order; here the builders are already
		// thenables that recorded what they were asked to do when they were
		// built, so awaiting them in order reproduces both the writes and the
		// per-statement `.returning()` rows the caller counts.
		batch: async (statements: PromiseLike<unknown>[]) => Promise.all(statements),
		delete: (table: unknown) => {
			deletedFrom.push(table);
			return {
				where: () =>
					Object.assign(Promise.resolve(undefined), {
						returning: async () => deletedRows,
					}),
			};
		},
		select: () => ({ from: async () => existing }),
		insert: () => ({
			values: (row: unknown) => {
				inserted.push(row);
				return {
					onConflictDoUpdate: async () => undefined,
					onConflictDoNothing: async () => undefined,
				};
			},
		}),
		update: () => ({
			set: (patch: unknown) => {
				updates.push(patch);
				// Drizzle's `.where()` returns a thenable that ALSO carries
				// `.returning()`, so the stub has to be both.
				return {
					where: () =>
						Object.assign(Promise.resolve(undefined), {
							returning: async () => [{ id: 1 }],
						}),
				};
			},
		}),
	};
	return { db: db as never, inserted, updates, deletedFrom };
}

function makeClient(over: Partial<VanClient> = {}): VanClient {
	return {
		folders: async () => [{ folderId: 1152, name: 'Middlesex Turf' }],
		mapRegions: async () => [
			{
				mapRegionId: 10,
				name: 'Cambridge North',
				mapRoutes: [
					{
						mapRouteId: 100,
						name: 'Turf 01',
						savedListId: 900,
						routeNumber: 1,
						routeSize: 400,
						doorCount: 250,
						phoneCount: 0,
						printedList: { number: '35536745-88712' },
					},
				],
			} as VanMapRegion,
		],
		printedLists: async () => [],
		savedLists: async () => [],
		minivanExportsSince: async () => ({ items: [], complete: true }),
		refreshMapRegion: async () => undefined,
		exportJobTypes: async () => [],
		createExportJob: async () => ({}) as never,
		exportJob: async () => ({}) as never,
		get: async () => ({}) as never,
		...over,
	};
}

const MAPPING = [{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152] }];
const FOUR_FOLDERS = [{ chapterId: 71, chapterName: 'Middlesex', folderIds: [1, 2, 3, 4] }];

describe('runCatalogSync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('syncs a mapped folder into turf rows', async () => {
		const { db, inserted } = makeDb();
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.foldersSynced).toBe(1);
		expect(result.turfsUpserted).toBe(1);
		expect(result.geometryQueued).toBe(1);
		expect(inserted[0]).toMatchObject({ mapRouteId: 100, chapterId: 71 });
	});

	// The bug this replaced: a folder mapped to several chapters was fetched
	// once per chapter and upserted once per chapter, every row keyed by
	// mapRouteId alone — so the last chapter written silently owned the folder
	// and the others saw none of its turf. Visibility is a query-time join on
	// the mapping now (chapter-visibility.ts), so the catalog reads each folder
	// exactly once and writes one row per turf.
	it('reads a shared folder once and writes one row per turf', async () => {
		const client = makeClient();
		const spy = vi.spyOn(client, 'mapRegions');
		const { db, inserted } = makeDb();

		const result = await runCatalogSync(db, client, [
			{ chapterId: 71, chapterName: 'Kalamazoo', folderIds: [1152] },
			{ chapterId: 72, chapterName: 'Allegan', folderIds: [1152] },
			{ chapterId: 73, chapterName: 'Calhoun', folderIds: [1152] },
		]);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.foldersSynced).toBe(1);
		expect(result.turfsUpserted).toBe(1);
		// `inserted` also carries the geometry-queue and sync-state writes, so
		// count the turf rows specifically: one, not one per chapter.
		const turfRows = inserted.filter((row) => (row as { chapterId?: number }).chapterId);
		expect(turfRows).toHaveLength(1);
		// The label is the first chapter mapped to the folder; who can SEE it is
		// every chapter in the mapping, which this row does not encode.
		expect(turfRows[0]).toMatchObject({ mapRouteId: 100, chapterId: 71 });
	});

	it('does nothing but warn when no chapter is mapped to a folder', async () => {
		const client = makeClient();
		const spy = vi.spyOn(client, 'mapRegions');
		const { db } = makeDb();

		const result = await runCatalogSync(db, client, []);
		expect(result.turfsUpserted).toBe(0);
		expect(result.warnings[0]).toContain('No chapters are mapped');
		expect(spy).not.toHaveBeenCalled();
	});

	// The whole point for a demo/sandbox key: Tier 3 endpoints 403, and the
	// catalog still lands. Failing the sync here would mean nothing works
	// until the security review clears.
	it('degrades instead of failing when Tier 3 endpoints are not granted', async () => {
		const forbidden = () => {
			throw new VanError('/minivanExports', 403, ['TIER'], 'Not authorized');
		};
		const { db } = makeDb();
		const result = await runCatalogSync(
			db,
			makeClient({ minivanExportsSince: forbidden, printedLists: forbidden }),
			MAPPING,
		);

		expect(result.turfsUpserted).toBe(1);
		expect(result.degraded.join(' ')).toContain('/minivanExports');
		expect(result.degraded.join(' ')).toContain('/printedLists');
	});

	it('degrades when /folders is unreadable but folder ids are known', async () => {
		const { db } = makeDb();
		const result = await runCatalogSync(
			db,
			makeClient({
				folders: () => {
					throw new VanError('/folders', 403, [], 'no');
				},
			}),
			MAPPING,
		);
		expect(result.turfsUpserted).toBe(1);
		expect(result.degraded.join(' ')).toContain('/folders');
	});

	it('skips a folder that errors without retiring its turf', async () => {
		const existing = [
			{
				mapRouteId: 500,
				folderId: 9999,
				retiredAt: null,
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, updates } = makeDb(existing);

		const result = await runCatalogSync(
			db,
			makeClient({
				mapRegions: async (folderId: number) => {
					if (folderId === 9999) throw new VanError('/mapRegions', 500, [], 'boom');
					return makeClient().mapRegions(folderId);
				},
			}),
			[{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152, 9999] }],
		);

		expect(result.foldersSkipped).toBe(1);
		expect(result.turfsRetired).toBe(0);
		expect(updates).toHaveLength(0);
		expect(result.warnings.join(' ')).toContain('Folder 9999');
	});

	it('skips a folder whose page walk did not finish, without retiring its turf', async () => {
		// The dangerous case: a partial read looks exactly like a folder whose
		// turf is gone, and retiring it would release claims under volunteers
		// who are out walking those blocks right now.
		const existing = [
			{
				mapRouteId: 500,
				folderId: 9999,
				retiredAt: null,
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, updates } = makeDb(existing);

		const result = await runCatalogSync(
			db,
			makeClient({
				mapRegions: async (folderId: number) => {
					if (folderId === 9999) {
						throw new VanIncompleteError('/folders/9999/mapRegions', 'more than 200 pages');
					}
					return makeClient().mapRegions(folderId);
				},
			}),
			[{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152, 9999] }],
		);

		expect(result.foldersSkipped).toBe(1);
		expect(result.turfsRetired).toBe(0);
		expect(updates).toHaveLength(0);
		expect(result.warnings.join(' ')).toContain('Folder 9999');
	});

	it('releases live claims on turf that retired', async () => {
		const existing = [
			{
				mapRouteId: 500,
				folderId: 1152,
				retiredAt: null,
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, updates } = makeDb(existing);
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.turfsRetired).toBe(1);
		expect(result.claimsReleased).toBe(1);
		expect(updates).toContainEqual(expect.objectContaining({ releaseReason: 'retired' }));
	});

	it('drops queued geometry for turf that retired', async () => {
		// VAN deletes a retired route's saved list with it, so a queue row left
		// behind can only fail — four times, then dead-letter into Slack. The row
		// goes with the turf.
		const existing = [
			{
				mapRouteId: 500,
				folderId: 1152,
				retiredAt: null,
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, deletedFrom } = makeDb(existing, [{ mapRouteId: 500 }]);
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.turfsRetired).toBe(1);
		expect(result.geometryQueueDropped).toBe(1);
		// The queue, and nothing else: deleting from van_turfs here would destroy
		// the retirement history the drift report reads.
		expect(deletedFrom).toEqual([vanGeometryQueue]);
	});

	it('drops no geometry rows when nothing is retired', async () => {
		const { db, deletedFrom } = makeDb();
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.turfsRetired).toBe(0);
		expect(result.geometryQueueDropped).toBe(0);
		expect(deletedFrom).toEqual([]);
	});

	it('sweeps geometry rows stranded by an EARLIER run, not just this one', async () => {
		// The production case this was written for: turf retired on a previous sync,
		// its queue row still failing against a saved list VAN has deleted. Nothing
		// retires on this run, so a fix scoped to `plan.retirements` would never
		// reach it.
		const existing = [
			{
				// Already retired, and route 100 is the one the client still returns —
				// so this run retires nothing.
				mapRouteId: 900,
				folderId: 1152,
				retiredAt: '2026-09-04T07:07:12.832Z',
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, deletedFrom } = makeDb(existing, [{ mapRouteId: 900 }]);
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.turfsRetired).toBe(0);
		expect(result.geometryQueueDropped).toBe(1);
		expect(deletedFrom).toEqual([vanGeometryQueue]);
	});

	it('keeps the geometry row for a turf coming back from retirement', async () => {
		// Route 100 is retired in our table and present in VAN's response, so this
		// run unretires it and re-queues its geometry. Deleting the row here would
		// race the insert that follows.
		const existing = [
			{
				mapRouteId: 100,
				folderId: 1152,
				retiredAt: '2026-09-04T07:07:12.832Z',
				hullJson: null,
				hullSourceRouteSize: null,
				routeSize: 0,
			},
		];
		const { db, deletedFrom } = makeDb(existing);
		const result = await runCatalogSync(db, makeClient(), MAPPING);

		expect(result.turfsUnretired).toBe(1);
		expect(result.geometryQueueDropped).toBe(0);
		expect(deletedFrom).toEqual([]);
	});

	it('stops fetching folders once the time budget lapses', async () => {
		const { db } = makeDb();
		const result = await runCatalogSync(db, makeClient(), FOUR_FOLDERS, { timeBudgetMs: -1 });

		expect(result.foldersSynced).toBe(0);
		expect(result.foldersSkipped).toBe(4);
		expect(result.turfsUpserted).toBe(0);
	});

	describe('MiniVAN exports', () => {
		const syncState = (inserted: unknown[]) =>
			inserted.find(
				(row) => (row as { id?: number }).id === 1 && 'minivanExportsOk' in (row as object),
			) as { minivanExportsOk: boolean } | undefined;

		it('marks the drift comparison visible once the store has caught up', async () => {
			const { db, inserted } = makeDb();
			await runCatalogSync(db, makeClient(), MAPPING);
			expect(syncState(inserted)?.minivanExportsOk).toBe(true);
		});

		// A backfill that hit its page cap has part of VAN's picture. Reporting
		// drift from it would call every not-yet-read export "not in MiniVAN".
		it('keeps it unavailable while the store is still backfilling, without telling Slack', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const { db, inserted } = makeDb();
			const result = await runCatalogSync(
				db,
				makeClient({ minivanExportsSince: async () => ({ items: [], complete: false }) }),
				MAPPING,
			);
			expect(syncState(inserted)?.minivanExportsOk).toBe(false);
			expect(result.degraded).toEqual([]);
		});

		// The regression this store exists for: one bad read used to null
		// van_distributed_to on every turf. Now the index comes from what is
		// stored, and only the flag says the read failed.
		it('still builds van_distributed_to from stored exports when VAN fails', async () => {
			vi.mocked(loadMinivanExports).mockResolvedValueOnce([
				{
					minivanExportId: 1,
					name: 'List 35536745-88712',
					dateCreated: '2026-09-22T11:52:28.15Z',
					createdBy: null,
					canvassers: [{ firstName: 'Tammy', lastName: 'B' }],
					databaseMode: null,
				},
			]);
			const { db, inserted } = makeDb();
			const result = await runCatalogSync(
				db,
				makeClient({
					minivanExportsSince: async () => {
						throw new VanError('/minivanExports', 503, [], 'down');
					},
				}),
				MAPPING,
			);

			expect(result.degraded.join(' ')).toContain('/minivanExports unavailable');
			expect(syncState(inserted)?.minivanExportsOk).toBe(false);
			expect(inserted[0]).toMatchObject({ mapRouteId: 100, vanDistributedTo: 'Tammy B' });
		});

		it('looks up exports for every list number the catalog could assign', async () => {
			const { db } = makeDb();
			await runCatalogSync(
				db,
				makeClient({
					printedLists: async () => [{ number: '11111111-22222', name: 'Turf 09' }] as never,
				}),
				MAPPING,
			);
			expect(vi.mocked(loadMinivanExports).mock.calls.at(-1)![1]).toEqual(
				expect.arrayContaining(['35536745-88712', '11111111-22222']),
			);
		});

		// The export made while our own volunteer held the turf is theirs: it
		// stamps their claim and does NOT mark the turf as handed out elsewhere.
		it('attributes an export inside our claim to that claim', async () => {
			vi.mocked(loadMinivanExports).mockResolvedValueOnce([
				{
					minivanExportId: 1,
					name: 'List 35536745-88712',
					dateCreated: '2026-09-22T11:52:28.15Z',
					createdBy: null,
					canvassers: [{ canvassserId: 5 }],
					databaseMode: null,
				},
			]);
			vi.mocked(loadClaimsForExports).mockResolvedValueOnce([
				{
					checkoutId: 42,
					mapRouteId: 100,
					claimedAt: '2026-09-22T15:40:00.000Z',
					endedAt: '2026-09-24T15:40:00.000Z',
					loadedInMinivanAt: null,
				},
			]);
			const { db, inserted } = makeDb();
			await runCatalogSync(db, makeClient(), MAPPING);
			expect(inserted[0]).toMatchObject({ mapRouteId: 100, vanAssignedAt: null });
			expect(vi.mocked(stampClaimsLoaded).mock.calls.at(-1)![1]).toEqual([
				{ checkoutId: 42, loadedAt: '2026-09-22T15:52:28.150Z' },
			]);
		});

		it('reads nothing from VAN on a dry run', async () => {
			const { db } = makeDb();
			vi.mocked(pullMinivanExports).mockClear();
			await runCatalogSync(db, makeClient(), MAPPING, { dryRun: true });
			expect(pullMinivanExports).not.toHaveBeenCalled();
		});
	});
});
