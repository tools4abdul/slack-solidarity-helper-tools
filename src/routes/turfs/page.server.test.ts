import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load } from './+page.server.js';
import { TURFS_PER_PAYLOAD } from '$lib/van/turf-paging.js';

const mockBlockedIds = vi.hoisted(() => vi.fn());
const mockSettings = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockZipLookup = vi.hoisted(() => vi.fn());

// Walk reports have their own tests on real SQLite (checkout-store.test.ts);
// the stubbed db here answers only the chains this module's tests script.
vi.mock('$lib/server/van/checkout-store.js', () => ({ latestWalkReports: async () => new Map() }));
vi.mock('$lib/server/db.js', () => ({ db: { select: () => mockSelect() } }));
vi.mock('$lib/server/env.js', () => ({
	SLACK_SUPERUSER_ID: 'U_SUPER',
	MAP_TILE_URL_TEMPLATE: '',
	MAP_TILE_ATTRIBUTION: '',
	MAP_TILE_API_KEY: '',
}));
vi.mock('$lib/server/van/zip-centroid.js', () => ({ lookupZipCentroid: mockZipLookup }));
// Partial: the turf query still needs the real visibleToChapter. The folder
// lookup is stubbed so it does not take a turn in stubQueries' ordered script;
// a folder per chapter keeps every new chapter charged, as before.
vi.mock('$lib/server/van/chapter-visibility.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/van/chapter-visibility.js')>()),
	foldersForChapter: async (_db: unknown, chapterId: number) => [1000 + chapterId],
}));
vi.mock('$lib/server/settings.js', () => ({
	loadVanBlockedIds: mockBlockedIds,
	loadSettings: mockSettings,
}));

const CHAPTERS = [
	{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
	{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
];

function turfRow(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: '35536745-88712',
		routeSize: 400,
		doorCount: 250,
		centroidLat: null,
		centroidLng: null,
		hullJson: null,
		vanDistributedTo: null,
		retiredAt: null,
		lastRefreshedAt: '2026-08-22T06:00:00.000Z',
		folderId: 2731,
		savedListId: 585052,
		...over,
	};
}

/** Stubs the `db.select().from().where()` chains the loader runs, in order:
 *  the viewer's own live claims (which widen the turf query so retired turf
 *  they still hold is included), then turf rows, then the claims on those
 *  rows. The viewer's claims and the row claims are the same set in these
 *  tests, which is the realistic case. */
function stubQueries(turfRows: unknown[], claimRows: unknown[] = []) {
	const results = [claimRows, turfRows, claimRows];
	let call = 0;
	mockSelect.mockImplementation(() => ({
		from: () => ({ where: async () => results[call++] ?? [] }),
	}));
}

const event = (session: unknown, query?: string) =>
	({
		locals: { session },
		url: new URL(`https://app.example/turfs${query ? `?${query}` : ''}`),
	}) as never;

const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false };

/** `load` is typed `void | PageData` because the unauthenticated path
 *  redirects (which throws). Every caller below expects data, so narrow once
 *  here rather than asserting non-null at each use. */
async function run(ev: never) {
	const result = await load(ev);
	if (!result) throw new Error('expected the load function to return data');
	return result;
}

describe('/turfs load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});
		mockZipLookup.mockResolvedValue(null);
		stubQueries([turfRow()]);
	});

	// chapter_channel_map is keyed by CHANNEL, so a chapter with two Slack
	// channels has two rows. Observed live: 64 rows, 32 chapters, and the picker
	// rendered every one of them twice.
	it('lists a chapter once even when it has several Slack channels', async () => {
		mockSettings.mockResolvedValue({
			chapterChannelMap: [
				{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
				{ chapterId: 71, channelId: 'C1b', name: 'Washtenaw County' },
				{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
				{ chapterId: 72, channelId: 'C2b', name: 'Wayne County' },
			],
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});

		const data = await run(event({ slackUserId: 'U1', isAdmin: false }) as never);
		expect(data.chapters).toEqual([
			{ chapterId: 71, name: 'Washtenaw County' },
			{ chapterId: 72, name: 'Wayne County' },
		]);
	});

	it('redirects an unauthenticated request', async () => {
		// The layout guard is not enough: layout and page loads run
		// concurrently, so this function is reached either way.
		await expect(load(event(null))).rejects.toMatchObject({ status: 302 });
	});

	it('returns no turf data before a chapter is picked', async () => {
		const result = await run(event(VOLUNTEER));
		expect(result.turfs).toEqual([]);
		expect(result.chapter).toBeNull();
		expect(result.chapters).toHaveLength(2);
	});

	it('serves the picked chapter’s turf', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.chapter?.chapterId).toBe(71);
		expect(result.turfs).toHaveLength(1);
		expect(result.turfs[0]!.name).toBe('Turf 01');
	});

	it('ignores a chapter id that is not a real chapter', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=999'));
		expect(result.chapter).toBeNull();
		expect(result.turfs).toEqual([]);
	});

	// The plan calls a leaking load function the most likely way this design
	// fails its own promise, so the filter is asserted at the query level.
	it('filters by chapter on the SERVER, not in the browser', async () => {
		const where = vi.fn(async () => [turfRow()]);
		mockSelect.mockImplementation(() => ({ from: () => ({ where }) }));
		await run(event(VOLUNTEER, 'chapter=71'));
		// A load that returned every chapter and let the client filter would
		// never call .where() on the turf query.
		expect(where).toHaveBeenCalled();
	});

	it('shows a blocked user a plain message and no turf', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_VOL']));
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.blocked).toMatch(/isn't available for your account/i);
		expect(result.turfs).toEqual([]);
		// Not even the chapter list, which would confirm the feature exists and
		// name every county the campaign organises in.
		expect(result.chapters).toEqual([]);
	});

	it('does not block an admin', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_ADMIN']));
		const result = await run(
			event({ ...VOLUNTEER, slackUserId: 'U_ADMIN', isAdmin: true }, 'chapter=71'),
		);
		expect(result.blocked).toBeNull();
		expect(result.turfs).toHaveLength(1);
	});

	it('does not block the superuser', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_SUPER']));
		const result = await run(event({ ...VOLUNTEER, slackUserId: 'U_SUPER' }, 'chapter=71'));
		expect(result.blocked).toBeNull();
	});

	it('withholds the list number on turf the viewer does not hold', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.turfs[0]!.status).toBe('available');
		expect(result.turfs[0]!.printedListNumber).toBeNull();
	});

	it('issues the list number on turf the viewer holds', async () => {
		stubQueries(
			[turfRow()],
			[
				{
					mapRouteId: 100,
					slackUserId: 'U_VOL',
					slackUserName: 'Dana',
					claimedAt: '2026-08-22T09:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z',
					releasedAt: null,
					completedAt: null,
				},
			],
		);
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.turfs[0]!.status).toBe('held-by-you');
		expect(result.turfs[0]!.printedListNumber).toBe('35536745-88712');
	});

	it('lists every chapter, not only those with turf', async () => {
		// Listing only chapters that have turf would be a cross-chapter
		// aggregate: one request revealing where the field operation runs.
		const result = await run(event(VOLUNTEER));
		expect(result.chapters.map((c: { chapterId: number }) => c.chapterId)).toEqual([71, 72]);
	});

	it('does not ship the Slack channel id with the chapter list', async () => {
		const result = await run(event(VOLUNTEER));
		expect(Object.keys(result.chapters[0]!).sort()).toEqual(['chapterId', 'name']);
	});

	describe('payload budget', () => {
		it('caps the payload and reports the chapter total', async () => {
			// Sized off the constant, so raising the budget does not turn this
			// into a test of a number nobody chose.
			const total = TURFS_PER_PAYLOAD + 50;
			stubQueries(
				Array.from({ length: total }, (_, i) =>
					turfRow({ mapRouteId: i, name: `Turf ${String(i).padStart(4, '0')}` }),
				),
			);
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.turfs).toHaveLength(TURFS_PER_PAYLOAD);
			expect(result.total).toBe(total);
		});

		// The bug this closes: a volunteer claims turf, the page reloads, and the
		// turf they are holding sorts past the cut — so the card carrying their
		// MiniVAN list number is simply absent, and stays absent until they pan
		// the map back over it.
		it('keeps the viewer’s own turf in the payload however far down it sorts', async () => {
			const mine = 99_999;
			const rows = [
				...Array.from({ length: TURFS_PER_PAYLOAD + 50 }, (_, i) =>
					turfRow({ mapRouteId: i, name: `Turf ${String(i).padStart(4, '0')}` }),
				),
				// Last by name, so the cap would drop it.
				turfRow({ mapRouteId: mine, name: 'Zzz far-away turf' }),
			];
			stubQueries(rows, [
				{
					mapRouteId: mine,
					slackUserId: 'U_VOL',
					slackUserName: 'Dana',
					claimedAt: '2026-08-22T09:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z',
					releasedAt: null,
					completedAt: null,
				},
			]);

			const result = await run(event(VOLUNTEER, 'chapter=71'));
			const held = result.turfs.find(
				(t: { mapRouteId: number; status: string }) => t.mapRouteId === mine,
			);
			expect(held?.status).toBe('held-by-you');
			// It is pinned to the front, and the payload still respects the cap.
			expect(result.turfs[0]!.mapRouteId).toBe(mine);
			expect(result.turfs).toHaveLength(TURFS_PER_PAYLOAD);
		});

		// A total, not a remainder: "showing N of T" cannot drift as the
		// volunteer pans, whereas "M more" describes whichever viewport
		// answered last.
		it('reports a total equal to what it served when the chapter fits', async () => {
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.total).toBe(result.turfs.length);
		});
	});

	describe('ZIP fallback', () => {
		it('sorts from a resolved ZIP and echoes it back', async () => {
			mockZipLookup.mockResolvedValue({ lat: 42.28, lng: -83.74 });
			const result = await run(event(VOLUNTEER, 'chapter=71&zip=48104'));
			expect(result.location).toEqual({ lat: 42.28, lng: -83.74 });
			expect(result.zip).toBe('48104');
		});

		// Never-throw: losing distance sorting must not cost the turf list.
		it('serves the list anyway when the ZIP cannot be resolved', async () => {
			mockZipLookup.mockResolvedValue(null);
			const result = await run(event(VOLUNTEER, 'chapter=71&zip=00000'));
			expect(result.location).toBeNull();
			expect(result.zip).toBeNull();
			expect(result.turfs).toHaveLength(1);
		});

		it('does not call the geocoder when no ZIP was given', async () => {
			await run(event(VOLUNTEER, 'chapter=71'));
			expect(mockZipLookup).not.toHaveBeenCalled();
		});
	});

	describe('turf request budget', () => {
		it('throttles repeated loads of ONE chapter, which the chapter limiter lets through', async () => {
			// Re-opening a chapter already seen is free by design, so the chapter
			// limiter never fires here. Without the request budget on this load,
			// `?chapter=N&zip=XXXXX` in a loop walks a whole chapter a payload at
			// a time for nothing — the API route has always charged for it.
			const { MAX_REQUESTS } = await import('$lib/van/request-budget.js');
			mockSettings.mockResolvedValue({ chapterChannelMap: CHAPTERS });
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const scraper = { ...VOLUNTEER, slackUserId: 'U_BUDGET' };

			const results = [];
			for (let i = 0; i < MAX_REQUESTS + 2; i++) {
				stubQueries([turfRow({ chapterId: 71 })]);
				results.push(await run(event(scraper, 'chapter=71')));
			}

			const stopped = results.find((r) => r.rateLimited > 0);
			expect(stopped).toBeDefined();
			expect(stopped!.turfs).toEqual([]);
			// Told apart from the chapter limit, whose message promises that
			// chapters already seen still open — which is not true here.
			expect(stopped!.rateLimitReason).toBe('requests');
			// A wait, not a block — the chapter list still renders.
			expect(stopped!.blocked).toBeNull();
			expect(stopped!.chapters.length).toBeGreaterThan(0);
		});

		it('never charges an admin for it', async () => {
			const { MAX_REQUESTS } = await import('$lib/van/request-budget.js');
			mockSettings.mockResolvedValue({ chapterChannelMap: CHAPTERS });
			const organizer = { slackUserId: 'U_BUDGET_ADMIN', isAdmin: true };

			for (let i = 0; i < MAX_REQUESTS + 2; i++) {
				stubQueries([turfRow({ chapterId: 71 })]);
				const result = await run(event(organizer, 'chapter=71'));
				expect(result.rateLimited).toBe(0);
			}
		});
	});

	describe('chapter-switch rate limit', () => {
		it('refuses turf after too many distinct chapters, without blocking the user', async () => {
			// The limiter is module state, so this test uses its own user and its
			// own chapter ids and does not disturb the others.
			const many = Array.from({ length: 20 }, (_, i) => ({
				chapterId: 500 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({ chapterChannelMap: many });
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const scraper = { ...VOLUNTEER, slackUserId: 'U_SCRAPER' };

			const results = [];
			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				results.push(await run(event(scraper, `chapter=${chapter.chapterId}`)));
			}

			expect(results.filter((r) => r.rateLimited > 0).length).toBeGreaterThan(0);
			const stopped = results.find((r) => r.rateLimited > 0)!;
			expect(stopped.turfs).toEqual([]);
			expect(stopped.rateLimitReason).toBe('chapters');
			// Not a block: the chapter list is still there and the message is a
			// wait, not a refusal.
			expect(stopped.blocked).toBeNull();
			expect(stopped.chapters.length).toBeGreaterThan(0);
		});

		// An organizer checking turf across a state on launch night does exactly
		// what this limiter is shaped to catch, and already sees every chapter at
		// once on /turfs/organizer — so the cap protected nothing and broke real
		// work.
		it('never rate-limits an admin, however many chapters they open', async () => {
			const many = Array.from({ length: 20 }, (_, i) => ({
				chapterId: 700 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({ chapterChannelMap: many });
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const organizer = { slackUserId: 'U_ORGANIZER', isAdmin: true };

			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				const result = await run(event(organizer, `chapter=${chapter.chapterId}`));
				expect(result.rateLimited).toBe(0);
				expect(result.turfs.length).toBeGreaterThan(0);
			}
		});

		it('never rate-limits re-opening the same chapter', async () => {
			const loyal = { ...VOLUNTEER, slackUserId: 'U_LOYAL' };
			for (let i = 0; i < 40; i++) {
				const result = await run(event(loyal, 'chapter=71'));
				expect(result.rateLimited).toBe(0);
			}
		});
	});

	it('passes a basemap source the component can use', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.tiles.urlTemplate).toContain('{z}');
		expect(result.tiles.attribution).toBeTruthy();
	});

	describe('retired turf', () => {
		const RETIRED = turfRow({
			mapRouteId: 200,
			name: 'Retired 01',
			retiredAt: '2026-08-01T00:00:00.000Z',
		});
		const MY_CLAIM = {
			mapRouteId: 200,
			slackUserId: 'U_VOL',
			slackUserName: 'Dana',
			claimedAt: '2026-08-22T09:00:00.000Z',
			expiresAt: '2099-01-01T00:00:00.000Z',
			releasedAt: null,
			completedAt: null,
		};

		// schema.ts keeps retired rows precisely so a live checkout still
		// renders. Dropping them takes a volunteer's turf AND its MiniVAN list
		// number off their own page while they are out walking it.
		it('is still served, and flagged, when the viewer holds it', async () => {
			stubQueries([RETIRED], [MY_CLAIM]);
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.turfs).toHaveLength(1);
			expect(result.turfs[0]!.retired).toBe(true);
			expect(result.turfs[0]!.status).toBe('held-by-you');
			expect(result.turfs[0]!.printedListNumber).toBe('35536745-88712');
		});

		it('widens the turf query only when the viewer holds something', async () => {
			const where = vi.fn(async () => []);
			mockSelect.mockImplementation(() => ({ from: () => ({ where }) }));
			await run(event(VOLUNTEER, 'chapter=71'));
			// Two calls: the viewer's claims, then the turf query. No third,
			// because no rows came back to fetch claims for.
			expect(where).toHaveBeenCalledTimes(2);
		});

		it('carries no retired flag on ordinary turf', async () => {
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect('retired' in result.turfs[0]!).toBe(false);
		});
	});

	describe('logging', () => {
		it('stays silent for an ordinary session', async () => {
			// The point of the threshold: a volunteer reopening their own county
			// all morning is the bulk of the traffic and says nothing.
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const quiet = { ...VOLUNTEER, slackUserId: 'U_QUIET' };
			for (let i = 0; i < 10; i++) await run(event(quiet, 'chapter=71'));
			const lines = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
			expect(lines).not.toContain('U_QUIET');
		});

		it('logs once someone has opened an unusual number of chapters', async () => {
			const many = Array.from({ length: 6 }, (_, i) => ({
				chapterId: 7000 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({ chapterChannelMap: many });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const wide = { ...VOLUNTEER, slackUserId: 'U_WIDE' };

			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				await run(event(wide, `chapter=${chapter.chapterId}`));
			}

			const lines = warn.mock.calls.flat().join(' ');
			expect(lines).toContain('wide chapter browsing');
			expect(lines).toContain('user=U_WIDE');
			// One line carries the whole picture, rather than a run of them.
			expect(lines).toContain('seen=');
		});
	});
});

// Story 7.4. The page promises a volunteer a number of hours and the claim
// route writes an expiry; both now come from /settings, and they have to be the
// same number. This shipped wrong once: every branch but the last returned the
// built-in 48 regardless of what an admin had configured.
describe('/turfs load — configured claim options', () => {
	// A fresh Slack id per test. The chapter rate limiter is process-wide module
	// state and earlier tests in this file deliberately exhaust it, so reusing
	// VOLUNTEER here would land on the rate-limited branch and return no turf at
	// all — which looks exactly like a broken payload.
	let viewer: { slackUserId: string; slackUserName: string; isAdmin: boolean };
	let seq = 0;

	beforeEach(() => {
		viewer = { slackUserId: `U_CFG_${++seq}`, slackUserName: 'Dana', isAdmin: false };
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 4,
		});
	});

	it.each([
		['with no chapter chosen', undefined],
		['on a chapter', 'chapter=71'],
	])('ships the configured TTL %s', async (_label, query) => {
		const data = await run(event(viewer, query));
		expect(data.claimTtlHours).toBe(72);
	});

	it('ships it on the blocked branch too', async () => {
		mockBlockedIds.mockResolvedValue(new Set([viewer.slackUserId]));
		const data = await run(event(viewer));
		expect(data.blocked).toBeTruthy();
		expect(data.claimTtlHours).toBe(72);
	});

	// Every branch has to agree: which one renders the claim copy is a fact
	// about the markup, and markup moves.
	it('never mixes the configured value with the built-in default', async () => {
		const seen = await Promise.all(
			[undefined, 'chapter=71', 'chapter=9999'].map(
				async (q) => (await run(event(viewer, q))).claimTtlHours,
			),
		);
		expect(new Set(seen)).toEqual(new Set([72]));
	});

	it('greys out a turf once the volunteer is at the configured cap', async () => {
		const heldElsewhere = {
			mapRouteId: 900,
			slackUserId: viewer.slackUserId,
			slackUserName: viewer.slackUserName,
			claimedAt: '2026-08-24T09:00:00.000Z',
			expiresAt: '2099-01-01T00:00:00.000Z',
			releasedAt: null,
			completedAt: null,
		};

		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 1,
		});
		stubQueries([turfRow()], [heldElsewhere]);
		const atLimit = await run(event(viewer, 'chapter=71'));
		expect(atLimit.turfs[0]!.claimable).toBe(false);
		expect(atLimit.turfs[0]!.claimBlockedReason).toContain('1 turf');

		// Same ledger, a roomier cap: now claimable.
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 5,
		});
		stubQueries([turfRow()], [heldElsewhere]);
		const roomy = await run(event(viewer, 'chapter=71'));
		expect(roomy.turfs[0]!.claimable).toBe(true);
	});
});
