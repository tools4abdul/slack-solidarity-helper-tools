import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCatalogSync } from './sync.js';
import { VanError, type VanClient } from './client.js';
import type { VanMapRegion } from './types.js';
import { vanGeometryQueue } from '../schema.js';

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
		minivanExports: async () => [],
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
			makeClient({ minivanExports: forbidden, printedLists: forbidden }),
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
});
