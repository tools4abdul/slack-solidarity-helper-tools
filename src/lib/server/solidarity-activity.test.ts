import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	findFirstPageAtOrAfter,
	activeIdsSince,
	resolveActiveIds,
	PER_USER_LOOKUP_LIMIT,
	_resetActivityCacheForTests,
	_resetPerUserCacheForTests,
	_setPaceForTests,
	type PageReader,
} from './solidarity-activity.js';
import { listWalks, _resetWalkProgressForTests } from './walk-progress.js';
import { _resetWalkLockForTests } from './solidarity-walk-lock.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
	_resetActivityCacheForTests();
	_resetWalkLockForTests();
	_resetPerUserCacheForTests();
	_resetWalkProgressForTests();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	_setPaceForTests(0);
});

/** An oldest-first collection of `count` rows, one per hour ending at `endMs`. */
function ascendingCollection(count: number, endMs: number) {
	const rows = Array.from({ length: count }, (_, i) => ({
		user_id: i + 1,
		created_at: iso(endMs - (count - 1 - i) * 3_600_000),
	}));
	const reader = vi.fn(async (offset: number) => rows.slice(offset, offset + 100));
	return { rows, reader: reader as unknown as PageReader, calls: reader };
}

describe('findFirstPageAtOrAfter', () => {
	it('finds the page holding the cutoff without reading the whole collection', async () => {
		// 5,000 rows, one per hour — the last ~720 are inside a 30-day window.
		const { reader, calls } = ascendingCollection(5000, NOW);

		const offset = await findFirstPageAtOrAfter(reader, NOW - 30 * DAY);

		expect(offset).not.toBeNull();
		// The crossing row is 720 from the end, i.e. index 4280 -> page 4200.
		expect(offset).toBe(4200);
		// The point of the search: a fraction of the 50 pages it would take to
		// read the collection.
		expect(calls.mock.calls.length).toBeLessThan(20);
	});

	it('returns 0 when the whole collection is inside the window', async () => {
		const { reader } = ascendingCollection(350, NOW);
		expect(await findFirstPageAtOrAfter(reader, NOW - 30 * DAY)).toBe(0);
	});

	it('returns null when nothing in the collection is recent enough', async () => {
		const { reader } = ascendingCollection(1000, NOW - 400 * DAY);
		expect(await findFirstPageAtOrAfter(reader, NOW - 30 * DAY)).toBeNull();
	});

	// "We couldn't look" must not reduce to "nothing found" — the second would
	// quietly hide active people from the filter.
	it('throws rather than reporting nothing when the collection outruns the page ceiling', async () => {
		// Never empty, never recent: the gallop can only end by hitting the cap.
		const endless: PageReader = async () =>
			Array.from({ length: 100 }, (_, i) => ({
				user_id: i,
				created_at: iso(NOW - 400 * DAY),
			}));

		await expect(findFirstPageAtOrAfter(endless, NOW - 30 * DAY)).rejects.toThrow(
			/exceeded .* rows/,
		);
	});

	it('returns null for an empty collection', async () => {
		const reader: PageReader = async () => [];
		expect(await findFirstPageAtOrAfter(reader, NOW - 30 * DAY)).toBeNull();
	});

	it('never returns a page that starts after the cutoff row', async () => {
		// Sweep cutoffs across the collection and check the answer is a page that
		// can still see every in-window row.
		const { rows, reader } = ascendingCollection(1200, NOW);
		for (const daysBack of [1, 3, 7, 14, 30, 45]) {
			const since = NOW - daysBack * DAY;
			const offset = await findFirstPageAtOrAfter(reader, since);
			const firstInWindow = rows.findIndex((r) => Date.parse(r.created_at) >= since);
			if (firstInWindow === -1) {
				expect(offset).toBeNull();
			} else {
				expect(offset).not.toBeNull();
				expect(offset!).toBeLessThanOrEqual(firstInWindow);
			}
		}
	});
});

describe('activeIdsSince', () => {
	it('keeps only ids whose latest activity is at or after the cutoff', () => {
		const window = {
			byUser: new Map([
				[1, NOW - 2 * DAY],
				[2, NOW - 40 * DAY],
				[3, NOW],
			]),
			coveredSince: NOW - 90 * DAY,
		};

		expect([...activeIdsSince(window, NOW - 30 * DAY)].sort()).toEqual([1, 3]);
	});

	it('is empty when nobody is recent enough', () => {
		const window = { byUser: new Map([[1, NOW - 90 * DAY]]), coveredSince: NOW - 180 * DAY };
		expect(activeIdsSince(window, NOW - 30 * DAY).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// resolveActiveIds — the per-user vs scan choice
// ---------------------------------------------------------------------------

/** Stub fetch so /v1/user_actions?user_id=N answers from `actionsByUser`. */
function stubPerUserFetch(actionsByUser: Record<number, number | undefined>) {
	const fetchMock = vi.fn(async (url: string) => {
		const userId = Number(new URL(url).searchParams.get('user_id'));
		const isActions = url.includes('/v1/user_actions');
		const at = actionsByUser[userId];
		const data = isActions && at !== undefined ? [{ user_id: userId, created_at: iso(at) }] : [];
		return {
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ data }),
			text: async () => '',
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('resolveActiveIds', () => {
	it('asks about nobody when there are no candidates', async () => {
		const fetchMock = stubPerUserFetch({});
		expect((await resolveActiveIds('tok', [], NOW - 30 * DAY)).size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('looks people up directly when only a few are in question', async () => {
		stubPerUserFetch({ 1: NOW - 2 * DAY, 2: NOW - 200 * DAY });

		const active = await resolveActiveIds('tok', [1, 2, 3], NOW - 30 * DAY);

		expect([...active]).toEqual([1]);
	});

	// The saving that makes this worth doing: changing the window must not send
	// us back to the API for people already looked up.
	it('re-answers a different window from cached lookups', async () => {
		const fetchMock = stubPerUserFetch({ 1: NOW - 2 * DAY, 2: NOW - 45 * DAY });

		await resolveActiveIds('tok', [1, 2], NOW - 30 * DAY);
		const calls = fetchMock.mock.calls.length;
		const wider = await resolveActiveIds('tok', [1, 2], NOW - 90 * DAY);

		expect([...wider].sort()).toEqual([1, 2]);
		expect(fetchMock.mock.calls.length).toBe(calls);
	});

	it('reports determinate progress while looking people up', async () => {
		let seen: { fetched: number; total: number | null } | null = null;
		const fetchMock = vi.fn(async () => {
			seen ??= listWalks()[0] ? { ...listWalks()[0]! } : null;
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => ({ data: [] }),
				text: async () => '',
			} as unknown as Response;
		});
		vi.stubGlobal('fetch', fetchMock);

		await resolveActiveIds('tok', [1, 2], NOW - 30 * DAY);

		expect(seen).toMatchObject({ total: 2 });
		// The bar is taken down once the lookups finish.
		expect(listWalks()).toEqual([]);
	});

	it('scans instead once too many people are in question', async () => {
		const many = Array.from({ length: PER_USER_LOOKUP_LIMIT + 1 }, (_, i) => i + 1);
		// A scan reads collections without a user_id filter; a per-user pass never
		// would. Answering every page empty ends both walks immediately.
		const fetchMock = vi.fn(
			async (url: string) =>
				({
					ok: true,
					status: 200,
					headers: new Headers(),
					json: async () => ({ data: [] }),
					text: async () => '',
					url,
				}) as unknown as Response,
		);
		vi.stubGlobal('fetch', fetchMock);

		await resolveActiveIds('tok', many, NOW - 30 * DAY);

		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.every((u) => !u.includes('user_id='))).toBe(true);
		expect(urls.length).toBeLessThan(many.length);
	});

	// Two comparisons in flight at once used to mean two paced walks against a
	// rate limit that only tolerates one, so the second must find the work done
	// rather than repeat it.
	it('does the lookups once when the same request arrives twice at once', async () => {
		const fetchMock = stubPerUserFetch({ 1: NOW - 2 * DAY, 2: NOW - 200 * DAY });

		const [a, b] = await Promise.all([
			resolveActiveIds('tok', [1, 2], NOW - 30 * DAY),
			resolveActiveIds('tok', [1, 2], NOW - 30 * DAY),
		]);

		expect([...a]).toEqual([1]);
		expect([...b]).toEqual([1]);
		// Two people, two collections each — and not a request more for the
		// second caller.
		expect(fetchMock.mock.calls.length).toBe(4);
	});

	it('serialises overlapping lookups for different people', async () => {
		const fetchMock = stubPerUserFetch({ 1: NOW - 2 * DAY, 3: NOW - 2 * DAY });

		const [a, b] = await Promise.all([
			resolveActiveIds('tok', [1, 2], NOW - 30 * DAY),
			resolveActiveIds('tok', [3, 4], NOW - 30 * DAY),
		]);

		expect([...a]).toEqual([1]);
		expect([...b]).toEqual([3]);
		// Four distinct people looked up exactly once each.
		expect(fetchMock.mock.calls.length).toBe(8);
	});
});
