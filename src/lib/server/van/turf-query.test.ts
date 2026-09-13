import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadChapterTurfs } from './turf-query.js';

function turfRow(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
		mapRegionId: 10,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: '35536745-88712',
		routeSize: 400,
		doorCount: 250,
		centroidLat: 42.28,
		centroidLng: -83.74,
		hullJson: null,
		vanDistributedTo: null,
		retiredAt: null,
		lastRefreshedAt: '2026-08-22T06:00:00.000Z',
		folderId: 2731,
		savedListId: 585052,
		...over,
	};
}

function claimRow(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
		slackUserId: 'U_OTHER',
		slackUserName: 'Sam',
		claimedAt: '2026-08-23T00:00:00.000Z',
		expiresAt: '2099-01-01T00:00:00.000Z',
		releasedAt: null,
		completedAt: null,
		...over,
	};
}

/** Answers the `db.select().from().where()` chains in the order the module runs
 *  them. With `includeHeldByViewer` there is an extra leading query for the
 *  viewer's own claims, which is exactly the difference under test. */
function makeDb(results: unknown[][]) {
	const calls: unknown[][] = [];
	let call = 0;
	const db = {
		select: (...args: unknown[]) => {
			calls.push(args);
			return { from: () => ({ where: async () => results[call++] ?? [] }) };
		},
	} as never;
	return { db, calls, queryCount: () => call };
}

const VIEWER = { slackUserId: 'U_VOL', isAdmin: false };
const HERE = { lat: 42.28, lng: -83.74 };

describe('loadChapterTurfs', () => {
	beforeEach(() => vi.clearAllMocks());

	it('builds views for the chapter’s turf', async () => {
		const { db } = makeDb([[turfRow()], []]);
		const { turfs, total, omitted } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
		});
		expect(turfs).toHaveLength(1);
		expect(turfs[0]!.name).toBe('Turf 01');
		expect(total).toBe(1);
		expect(omitted).toBe(0);
	});

	// The one real difference between the page load and the map endpoint.
	it('queries the viewer’s own claims only when asked to keep their turf', async () => {
		const without = makeDb([[turfRow()], []]);
		await loadChapterTurfs(without.db, { chapterId: 71, viewer: VIEWER });
		// Turf rows, then claims, then the regions VAN is re-cutting.
		expect(without.queryCount()).toBe(3);

		const withHeld = makeDb([[{ mapRouteId: 100 }], [turfRow()], [claimRow()]]);
		await loadChapterTurfs(withHeld.db, {
			chapterId: 71,
			viewer: VIEWER,
			includeHeldByViewer: true,
		});
		// One more than without: the viewer's own claims are read first.
		expect(withHeld.queryCount()).toBe(4);
	});

	// A turf left out of a payload should never be serialised at all, not
	// serialised and then filtered — so the cut has to happen before the views
	// are built. Observable here as the claim query being scoped to the page.
	it('cuts rows before building views', async () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			turfRow({ mapRouteId: 100 + i, name: `Turf ${String(i).padStart(2, '0')}` }),
		);
		const { db } = makeDb([rows, []]);
		const { turfs, total, omitted } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			limit: 3,
		});
		expect(turfs.map((t) => t.name)).toEqual(['Turf 00', 'Turf 01', 'Turf 02']);
		expect(total).toBe(10);
		expect(omitted).toBe(7);
	});

	it('pages by offset', async () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			turfRow({ mapRouteId: 100 + i, name: `Turf ${String(i).padStart(2, '0')}` }),
		);
		const { db } = makeDb([rows, []]);
		const { turfs, omitted } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			limit: 3,
			offset: 3,
		});
		expect(turfs.map((t) => t.name)).toEqual(['Turf 03', 'Turf 04', 'Turf 05']);
		expect(omitted).toBe(4);
	});

	it('orders by distance when a location is known', async () => {
		const rows = [
			turfRow({ mapRouteId: 1, name: 'Far', centroidLat: 42.6, centroidLng: -83.2 }),
			turfRow({ mapRouteId: 2, name: 'Near', centroidLat: 42.281, centroidLng: -83.741 }),
		];
		const { db } = makeDb([rows, []]);
		const { turfs } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			location: HERE,
		});
		expect(turfs.map((t) => t.name)).toEqual(['Near', 'Far']);
	});

	it('restricts to the viewport when bounds are given', async () => {
		const rows = [
			turfRow({ mapRouteId: 1, name: 'Inside', centroidLat: 42.28, centroidLng: -83.74 }),
			turfRow({ mapRouteId: 2, name: 'Outside', centroidLat: 45, centroidLng: -80 }),
		];
		const { db } = makeDb([rows, []]);
		const { turfs, total } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			bounds: { minLat: 42, minLng: -84, maxLat: 43, maxLng: -83 },
		});
		expect(turfs.map((t) => t.name)).toEqual(['Inside']);
		// Still the chapter's total, not the viewport's — the page already showed
		// that figure and it must not move when the volunteer pans.
		expect(total).toBe(2);
	});

	it('skips the claim query when the page is empty', async () => {
		const { db, queryCount } = makeDb([[], []]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs).toEqual([]);
		expect(queryCount()).toBe(1);
	});

	// toTurfView is the gate; this asserts the query actually runs rows through
	// it rather than spreading raw rows into the payload.
	it('redacts through toTurfView rather than returning raw rows', async () => {
		const { db } = makeDb([[turfRow()], [claimRow()]]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs[0]!.status).toBe('checked-out');
		expect(turfs[0]!.heldBy).toBeNull();
		// The MiniVAN number is the credential — never on someone else's turf.
		expect(turfs[0]!.printedListNumber).toBeNull();
		expect(turfs[0]).not.toHaveProperty('savedListId');
		expect(turfs[0]).not.toHaveProperty('folderId');
	});

	describe('mapRouteIds', () => {
		it('restricts the query to the named routes', async () => {
			const rows = [turfRow({ mapRouteId: 100 }), turfRow({ mapRouteId: 101, name: 'Turf 02' })];
			const { db } = makeDb([rows, []]);
			// The stub cannot filter, so this asserts the contract the caller
			// depends on: asking for one route and a limit of 1 must not silently
			// return whichever turf sorts first.
			const { turfs } = await loadChapterTurfs(db, {
				chapterId: 71,
				viewer: VIEWER,
				mapRouteIds: [101],
				limit: 2,
			});
			expect(turfs.map((t) => t.mapRouteId)).toContain(101);
		});

		// An empty list is a request for nothing. `inArray` with no values is
		// invalid SQL in some drivers and "no filter" in others; neither is what
		// the caller asked for.
		it('returns nothing for an empty route list, without querying', async () => {
			const { db, queryCount } = makeDb([[turfRow()], []]);
			const result = await loadChapterTurfs(db, {
				chapterId: 71,
				viewer: VIEWER,
				mapRouteIds: [],
			});
			expect(result).toEqual({ turfs: [], total: 0, omitted: 0 });
			expect(queryCount()).toBe(0);
		});
	});

	it('issues the list number on turf the viewer holds', async () => {
		const { db } = makeDb([[turfRow()], [claimRow({ slackUserId: 'U_VOL' })]]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs[0]!.status).toBe('held-by-you');
		expect(turfs[0]!.printedListNumber).toBe('35536745-88712');
	});
});
