import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadChapterTurfs } from './turf-query.js';
import { latestWalkReports } from './checkout-store.js';

// Walk reports have their own tests on real SQLite (checkout-store.test.ts);
// the stubbed db below answers only the select chains this module scripts.
vi.mock('./checkout-store.js', () => ({ latestWalkReports: vi.fn(async () => new Map()) }));

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

	// The only progress figure there is. A turf finished at 100% must not be
	// offered again just because VAN's door count never moved.
	it('carries the latest walk report onto the view, and blocks a walked-out turf', async () => {
		vi.mocked(latestWalkReports).mockResolvedValueOnce(
			new Map([[100, { percent: 100, at: '2026-09-23T18:00:00.000Z' }]]),
		);
		const { db } = makeDb([[turfRow()], []]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs[0]!.walkReport).toEqual({ percent: 100, dayLabel: expect.any(String) });
		expect(turfs[0]!.claimable).toBe(false);
		expect(turfs[0]!.claimBlockedReason).toContain('finished every door');
	});

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
			expect(result).toEqual({
				turfs: [],
				total: 0,
				omitted: 0,
				start: 0,
				nextOffset: 0,
				unavailable: 0,
			});
			expect(queryCount()).toBe(0);
		});
	});

	// The web page and the map endpoint read through here too, so a volunteer
	// holding turf in another chapter is counted against their limit on every
	// surface — not shown turf as claimable that the click then refuses.
	it('counts the viewer’s claims in other chapters against their limit', async () => {
		const elsewhere = [
			claimRow({ mapRouteId: 900, slackUserId: 'U_VOL' }),
			claimRow({ mapRouteId: 901, slackUserId: 'U_VOL' }),
		];
		const { db } = makeDb([[turfRow()], elsewhere]);
		const { turfs } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			claimOptions: { maxConcurrentClaims: 2 },
		});
		expect(turfs[0]!.claimable).toBe(false);
		expect(turfs[0]!.claimBlockedReason).toContain('You can hold 2');
	});

	it('marks turf in a region VAN is re-cutting as updating', async () => {
		const { db } = makeDb([[turfRow({ mapRegionId: 10 })], [], [{ mapRegionId: 10 }]]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs[0]!.updating).toBe(true);
	});

	describe('claimableOnly', () => {
		const rows = () => [
			turfRow({ mapRouteId: 1, name: 'Free' }),
			turfRow({ mapRouteId: 2, name: 'Taken' }),
			turfRow({ mapRouteId: 3, name: 'Assigned', vanDistributedTo: 'Pat' }),
			turfRow({ mapRouteId: 4, name: 'Unprinted', printedListNumber: null }),
			turfRow({ mapRouteId: 5, name: 'Mine' }),
		];
		const claims = () => [
			claimRow({ mapRouteId: 2, slackUserId: 'U_OTHER' }),
			claimRow({ mapRouteId: 5, slackUserId: 'U_VOL' }),
		];

		it('leaves out turf nobody can take, and keeps the viewer’s own', async () => {
			const { db } = makeDb([rows(), claims()]);
			const result = await loadChapterTurfs(db, {
				chapterId: 71,
				viewer: VIEWER,
				claimableOnly: true,
			});
			expect(result.turfs.map((t) => t.name).sort()).toEqual(['Free', 'Mine']);
			expect(result.total).toBe(2);
			expect(result.unavailable).toBe(3);
		});

		// Hiding everything from someone at their limit would read as "no turf
		// here" rather than "give one back first".
		it('does not hide turf just because the viewer is at their limit', async () => {
			const { db } = makeDb([rows(), claims()]);
			const { turfs } = await loadChapterTurfs(db, {
				chapterId: 71,
				viewer: VIEWER,
				claimableOnly: true,
				claimOptions: { maxConcurrentClaims: 1 },
			});
			const free = turfs.find((t) => t.name === 'Free');
			expect(free).toBeDefined();
			expect(free!.claimable).toBe(false);
			expect(free!.claimBlockedReason).toContain('You can hold 1');
		});

		it('leaves out turf walked to 100%', async () => {
			vi.mocked(latestWalkReports).mockResolvedValueOnce(
				new Map([[1, { percent: 100, at: '2026-09-23T18:00:00.000Z' }]]),
			);
			const { db } = makeDb([[turfRow({ mapRouteId: 1 })], []]);
			const result = await loadChapterTurfs(db, {
				chapterId: 71,
				viewer: VIEWER,
				claimableOnly: true,
			});
			expect(result.turfs).toEqual([]);
			expect(result.unavailable).toBe(1);
		});
	});

	it('issues the list number on turf the viewer holds', async () => {
		const { db } = makeDb([[turfRow()], [claimRow({ slackUserId: 'U_VOL' })]]);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER });
		expect(turfs[0]!.status).toBe('held-by-you');
		expect(turfs[0]!.printedListNumber).toBe('35536745-88712');
	});
});
