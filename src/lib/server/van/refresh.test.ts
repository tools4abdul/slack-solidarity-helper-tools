import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	loadRegionStates,
	refreshingRegionIds,
	requestRegionRefresh,
	runRefreshSweep,
	settleRefreshes,
} from './refresh.js';
import type { VanClient } from './client.js';

const NOW = new Date('2026-09-12T18:00:00.000Z');
/** 02:00 in Detroit — the nightly window. */
const NIGHT = new Date('2026-09-12T06:00:00.000Z');

/**
 * A recording stub of the drizzle chains this module uses.
 *
 * `select`/`selectDistinct` answer from `reads` in call order, and every chain
 * method returns the same thenable, so `.from()`, `.where()`, `.innerJoin()`
 * and `.groupBy()` can appear in any combination. Writes are recorded rather
 * than applied; the storage-level guarantees are not what these tests are
 * about.
 */
function makeDb(reads: unknown[][] = []) {
	const queue = [...reads];
	const upserts: Array<{ values: unknown; set: unknown }> = [];
	const updates: unknown[] = [];

	function query(rows: unknown[]) {
		const thenable = Promise.resolve(rows) as unknown as Record<string, unknown>;
		for (const method of ['from', 'where', 'innerJoin', 'groupBy']) {
			thenable[method] = () => thenable;
		}
		return thenable;
	}

	const db = {
		select: () => query(queue.shift() ?? []),
		selectDistinct: () => query(queue.shift() ?? []),
		insert: () => ({
			values: (values: unknown) => ({
				onConflictDoUpdate: async ({ set }: { set: unknown }) => {
					upserts.push({ values, set });
				},
			}),
		}),
		update: () => ({
			set: (patch: unknown) => {
				updates.push(patch);
				return { where: async () => undefined };
			},
		}),
	};
	return { db: db as never, upserts, updates };
}

function makeClient(over: Partial<VanClient> = {}): VanClient {
	return {
		folders: async () => [],
		mapRegions: async () => [],
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

/** The three reads loadRegionStates makes, in order. */
function regionReads(input: {
	regions?: Array<{ folderId: number; mapRegionId: number }>;
	bookkeeping?: unknown[];
	claims?: Array<{ mapRegionId: number; claims: number }>;
}) {
	return [input.regions ?? [], input.bookkeeping ?? [], input.claims ?? []];
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadRegionStates', () => {
	it('joins bookkeeping and live claims onto the regions that have turf', async () => {
		const { db } = makeDb(
			regionReads({
				regions: [
					{ folderId: 1, mapRegionId: 10 },
					{ folderId: 1, mapRegionId: 11 },
				],
				bookkeeping: [
					{
						folderId: 1,
						mapRegionId: 10,
						requestedAt: '2026-09-12T17:00:00.000Z',
						lastRequestAt: '2026-09-12T10:00:00.000Z',
						inFlightSince: null,
					},
				],
				claims: [{ mapRegionId: 11, claims: 3 }],
			}),
		);

		const states = await loadRegionStates(db);
		expect(states).toEqual([
			{
				folderId: 1,
				mapRegionId: 10,
				lastRequestAt: '2026-09-12T10:00:00.000Z',
				requestedAt: '2026-09-12T17:00:00.000Z',
				inFlightSince: null,
				activeClaims: 0,
			},
			{
				folderId: 1,
				mapRegionId: 11,
				lastRequestAt: null,
				requestedAt: null,
				inFlightSince: null,
				activeClaims: 3,
			},
		]);
	});

	it('reads nothing else when no region has live turf', async () => {
		const { db } = makeDb([[]]);
		expect(await loadRegionStates(db)).toEqual([]);
	});
});

describe('runRefreshSweep — on demand', () => {
	it('POSTs the one region and records it as in flight', async () => {
		const refreshMapRegion = vi.fn(async () => undefined);
		const { db, upserts } = makeDb(
			regionReads({
				regions: [{ folderId: 1152, mapRegionId: 10 }],
				bookkeeping: [
					{
						folderId: 1152,
						mapRegionId: 10,
						requestedAt: '2026-09-12T17:50:00.000Z',
						lastRequestAt: null,
						inFlightSince: null,
					},
				],
			}),
		);

		const result = await runRefreshSweep(db, makeClient({ refreshMapRegion }), { now: NOW });

		expect(refreshMapRegion).toHaveBeenCalledWith(1152, 10);
		expect(result.regionsRefreshed).toBe(1);
		expect(upserts[0].set).toEqual({
			lastRequestAt: NOW.toISOString(),
			lastRequestKind: 'completion',
			// The want is satisfied and the wait begins.
			requestedAt: null,
			inFlightSince: NOW.toISOString(),
			lastError: null,
			lastErrorAt: null,
		});
	});

	it('keeps the want but starts the clock when VAN refuses', async () => {
		const refreshMapRegion = vi.fn(async () => {
			throw new Error('FORBIDDEN');
		});
		const { db, upserts } = makeDb(
			regionReads({
				regions: [{ folderId: 1152, mapRegionId: 10 }],
				bookkeeping: [
					{
						folderId: 1152,
						mapRegionId: 10,
						requestedAt: '2026-09-12T17:50:00.000Z',
						lastRequestAt: null,
						inFlightSince: null,
					},
				],
			}),
		);

		const result = await runRefreshSweep(db, makeClient({ refreshMapRegion }), { now: NOW });

		expect(result.failed).toBe(1);
		expect(result.warnings[0]).toContain('FORBIDDEN');
		// requestedAt survives, so the region is retried — but lastRequestAt is
		// stamped, so the retry waits out the hourly throttle rather than firing
		// on all 37 ticks of the day.
		expect(upserts[0].set).toEqual({
			lastRequestAt: NOW.toISOString(),
			lastRequestKind: 'completion',
			lastError: 'FORBIDDEN',
			lastErrorAt: NOW.toISOString(),
		});
	});

	it('holds a region back while volunteers are still out in it', async () => {
		const refreshMapRegion = vi.fn(async () => undefined);
		const { db } = makeDb(
			regionReads({
				regions: [{ folderId: 1152, mapRegionId: 10 }],
				bookkeeping: [
					{
						folderId: 1152,
						mapRegionId: 10,
						requestedAt: '2026-09-12T17:50:00.000Z',
						// Outside the hourly throttle, so the only thing holding it
						// back is the volunteer who is still out there.
						lastRequestAt: '2026-09-12T16:00:00.000Z',
						inFlightSince: null,
					},
				],
				claims: [{ mapRegionId: 10, claims: 1 }],
			}),
		);

		const result = await runRefreshSweep(db, makeClient({ refreshMapRegion }), { now: NOW });
		expect(refreshMapRegion).not.toHaveBeenCalled();
		expect(result.regionsDeferred).toBe(1);
	});
});

describe('runRefreshSweep — nightly', () => {
	it('sends one folder-wide call and stamps every region it covered', async () => {
		const refreshMapRegion = vi.fn(async () => undefined);
		const { db, upserts } = makeDb(
			regionReads({
				regions: [
					{ folderId: 1152, mapRegionId: 10 },
					{ folderId: 1152, mapRegionId: 11 },
				],
			}),
		);

		const result = await runRefreshSweep(db, makeClient({ refreshMapRegion }), { now: NIGHT });

		// No region id: the folder-wide form.
		expect(refreshMapRegion).toHaveBeenCalledTimes(1);
		expect(refreshMapRegion).toHaveBeenCalledWith(1152);
		expect(result.nightlyFolders).toEqual([1152]);
		expect(upserts).toHaveLength(2);
	});

	it('stays out of the way during the day', async () => {
		const refreshMapRegion = vi.fn(async () => undefined);
		const { db } = makeDb(regionReads({ regions: [{ folderId: 1152, mapRegionId: 10 }] }));
		const result = await runRefreshSweep(db, makeClient({ refreshMapRegion }), { now: NOW });
		expect(refreshMapRegion).not.toHaveBeenCalled();
		expect(result.nightlyFolders).toEqual([]);
	});

	it('clears an in-flight flag VAN never confirmed', async () => {
		const { db, updates } = makeDb(
			regionReads({
				regions: [{ folderId: 1152, mapRegionId: 10 }],
				bookkeeping: [
					{
						folderId: 1152,
						mapRegionId: 10,
						requestedAt: null,
						lastRequestAt: '2026-09-12T10:00:00.000Z',
						inFlightSince: '2026-09-12T00:00:00.000Z',
					},
				],
			}),
		);

		const result = await runRefreshSweep(db, makeClient(), { now: NOW });
		expect(result.staleCleared).toBe(1);
		expect(updates).toEqual([{ inFlightSince: null }]);
	});
});

describe('settleRefreshes', () => {
	const inFlightRow = {
		folderId: 1152,
		mapRegionId: 10,
		inFlightSince: '2026-09-12T12:00:00.000Z',
	};

	it('closes a refresh out once VAN reports a newer dateRefreshed', async () => {
		const { db, updates } = makeDb([[inFlightRow]]);
		const settled = await settleRefreshes(db, [
			{ folderId: 1152, mapRegionId: 10, dateRefreshed: '2026-09-12T12:30:00.000Z' },
		]);
		expect(settled).toBe(1);
		expect(updates).toEqual([{ inFlightSince: null }]);
	});

	it('keeps waiting when the region reports the timestamp it already had', async () => {
		const { db, updates } = makeDb([[inFlightRow]]);
		const settled = await settleRefreshes(db, [
			{ folderId: 1152, mapRegionId: 10, dateRefreshed: '2026-09-12T11:00:00.000Z' },
		]);
		expect(settled).toBe(0);
		expect(updates).toEqual([]);
	});

	it('keeps waiting for a key that never reports dateRefreshed at all', async () => {
		// The demo key does exactly this. The policy's timeout is what eventually
		// clears the flag; nothing here should guess.
		const { db, updates } = makeDb([[inFlightRow]]);
		expect(
			await settleRefreshes(db, [{ folderId: 1152, mapRegionId: 10, dateRefreshed: null }]),
		).toBe(0);
		expect(updates).toEqual([]);
	});

	it('does nothing when the catalog read nothing', async () => {
		const { db } = makeDb([]);
		expect(await settleRefreshes(db, [])).toBe(0);
	});
});

describe('requestRegionRefresh', () => {
	it('records the want and touches nothing else', async () => {
		const { db, upserts } = makeDb();
		await requestRegionRefresh(db, { folderId: 1152, mapRegionId: 10, now: NOW });
		expect(upserts).toEqual([
			{
				values: { folderId: 1152, mapRegionId: 10, requestedAt: NOW.toISOString() },
				// Not the throttle, not the in-flight flag: a second completion in
				// the same hour is the same want.
				set: { requestedAt: NOW.toISOString() },
			},
		]);
	});

	it('never throws — a completion is already written by the time it runs', async () => {
		const db = {
			insert: () => ({
				values: () => ({
					onConflictDoUpdate: async () => {
						throw new Error('database is locked');
					},
				}),
			}),
		} as never;
		await expect(
			requestRegionRefresh(db, { folderId: 1152, mapRegionId: 10, now: NOW }),
		).resolves.toBeUndefined();
	});
});

describe('refreshingRegionIds', () => {
	it('is the set the turf page marks as updating', async () => {
		const { db } = makeDb([[{ mapRegionId: 10 }, { mapRegionId: 12 }]]);
		expect(await refreshingRegionIds(db)).toEqual(new Set([10, 12]));
	});
});
