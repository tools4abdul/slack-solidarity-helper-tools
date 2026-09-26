import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';
import { TURFS_PER_PAYLOAD } from '$lib/van/turf-paging.js';
import { MAX_CHAPTER_SWITCHES } from '$lib/van/chapter-rate-limit.js';

const mockBlockedIds = vi.hoisted(() => vi.fn());
const mockSettings = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());

// Walk reports have their own tests on real SQLite (checkout-store.test.ts);
// the stubbed db here answers only the chains this module's tests script.
vi.mock('$lib/server/van/checkout-store.js', () => ({ latestWalkReports: async () => new Map() }));
vi.mock('$lib/server/db.js', () => ({ db: { select: () => mockSelect() } }));
vi.mock('$lib/server/env.js', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));
// Partial: the turf query still needs the real visibleToChapter. The folder
// lookup is stubbed so it does not take a turn in the scripted db; a folder
// per chapter keeps every new chapter charged.
vi.mock('$lib/server/van/chapter-visibility.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/van/chapter-visibility.js')>()),
	foldersForChapter: async (_db: unknown, chapterId: number) => [1000 + chapterId],
}));
vi.mock('$lib/server/settings.js', () => ({
	loadVanBlockedIds: mockBlockedIds,
	loadSettings: mockSettings,
}));

function turfRow(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
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
		lastRefreshedAt: null,
		...over,
	};
}

function stubQueries(turfRows: unknown[], claimRows: unknown[] = []) {
	const results = [turfRows, claimRows];
	let call = 0;
	mockSelect.mockImplementation(() => ({
		from: () => ({ where: async () => results[call++] ?? [] }),
	}));
}

const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false };

const event = (session: unknown, query: string) =>
	({ locals: { session }, url: new URL(`https://app.example/api/turfs?${query}`) }) as never;

const INSIDE = 'chapter=71&bbox=42,-84,43,-83';

describe('GET /api/turfs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({
			chapterChannelMap: [{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' }],
		});
		stubQueries([turfRow()]);
	});

	it('returns 401 when not signed in', async () => {
		const res = await GET(event(null, INSIDE));
		expect(res.status).toBe(401);
	});

	// The endpoint returns the same data the page load does, so a weaker guard
	// here would simply be the way around the page's guard.
	it('returns 403 for a blocked user', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_VOL']));
		const res = await GET(event(VOLUNTEER, INSIDE));
		expect(res.status).toBe(403);
	});

	it('returns turf inside the box', async () => {
		const res = await GET(event(VOLUNTEER, INSIDE));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.turfs).toHaveLength(1);
		expect(body.turfs[0].mapRouteId).toBe(100);
	});

	it('excludes turf outside the box', async () => {
		stubQueries([turfRow({ centroidLat: 48, centroidLng: -100 })]);
		const body = await (await GET(event(VOLUNTEER, INSIDE))).json();
		expect(body.turfs).toEqual([]);
	});

	it('rejects a chapter that is not a real chapter', async () => {
		const res = await GET(event(VOLUNTEER, 'chapter=999&bbox=42,-84,43,-83'));
		expect(res.status).toBe(400);
	});

	it.each([
		['a missing bbox', 'chapter=71'],
		['a malformed bbox', 'chapter=71&bbox=nope'],
		['an inverted bbox', 'chapter=71&bbox=43,-84,42,-83'],
		['an out-of-range bbox', 'chapter=71&bbox=42,-84,91,-83'],
	])('rejects %s with 400 rather than matching everything', async (_label, query) => {
		const res = await GET(event(VOLUNTEER, query));
		expect(res.status).toBe(400);
	});

	it('withholds the list number on turf the viewer does not hold', async () => {
		const body = await (await GET(event(VOLUNTEER, INSIDE))).json();
		expect(body.turfs[0].printedListNumber).toBeNull();
	});

	describe('rate limiting', () => {
		// The hole this closes: for a while this route had no rate limit at all,
		// so a loop over ?chapter= pulled the whole state while the page's
		// limiter sat there looking authoritative.
		it('refuses a sweep across chapters, on the same budget as the page', async () => {
			const many = Array.from({ length: 30 }, (_, i) => ({
				chapterId: 8000 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({ chapterChannelMap: many });
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const sweeper = { ...VOLUNTEER, slackUserId: 'U_API_SWEEP' };

			const statuses: number[] = [];
			for (const chapter of many) {
				const res = await GET(event(sweeper, `chapter=${chapter.chapterId}&bbox=42,-84,43,-83`));
				statuses.push(res.status);
			}

			expect(statuses).toContain(429);
			expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(MAX_CHAPTER_SWITCHES);
		});

		it('sends Retry-After so a client can back off', async () => {
			const many = Array.from({ length: 30 }, (_, i) => ({
				chapterId: 9000 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({ chapterChannelMap: many });
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const sweeper = { ...VOLUNTEER, slackUserId: 'U_API_RETRY' };

			let limited: Response | null = null;
			for (const chapter of many) {
				const res = await GET(event(sweeper, `chapter=${chapter.chapterId}&bbox=42,-84,43,-83`));
				if (res.status === 429) {
					limited = res;
					break;
				}
			}
			expect(limited).not.toBeNull();
			expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0);
		});

		// Panning is the endpoint's whole job — it must stay free.
		it('does not charge a chapter slot for panning within one chapter', async () => {
			const panner = { ...VOLUNTEER, slackUserId: 'U_PANNER' };
			for (let i = 0; i < 30; i++) {
				stubQueries([turfRow()]);
				const res = await GET(event(panner, `chapter=71&bbox=42,-84,43,-8${i % 4}`));
				expect(res.status).toBe(200);
			}
		});

		it('still stops a bbox walk once the request budget runs out', async () => {
			// The payload cap is a budget, not an access control: without
			// this, walking the grid pulls a whole chapter a screen at a time.
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const walker = { ...VOLUNTEER, slackUserId: 'U_WALKER' };
			const statuses: number[] = [];
			for (let i = 0; i < 80; i++) {
				stubQueries([turfRow()]);
				const res = await GET(event(walker, `chapter=71&bbox=42,-84,43,-83`));
				statuses.push(res.status);
			}
			expect(statuses).toContain(429);
		});
	});

	it('caps the response and reports the chapter total', async () => {
		const total = TURFS_PER_PAYLOAD + 50;
		stubQueries(
			Array.from({ length: total }, (_, i) =>
				turfRow({ mapRouteId: i, name: `Turf ${String(i).padStart(4, '0')}` }),
			),
		);
		const body = await (await GET(event(VOLUNTEER, INSIDE))).json();
		expect(body.turfs).toHaveLength(TURFS_PER_PAYLOAD);
		expect(body.total).toBe(total);
	});
});
