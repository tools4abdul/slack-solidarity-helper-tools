import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockFetchPaginated = vi.hoisted(() => vi.fn());
vi.mock('./solidarity-paginate.js', () => ({ fetchPaginated: mockFetchPaginated }));
vi.mock('./env.js', () => ({
	ATTENDEE_SYNC_MAX_NEW_PROFILES: 25,
	SOLIDARITY_DEFAULT_CHAPTER_ID: 0,
	SOLIDARITY_API_TOKEN: 'token',
}));
vi.mock('./mobilize-api.js', () => ({ loadMobilizeApi: () => ({}) }));

const { refreshZipChapterMap } = await import('./attendee-sync.js');

// A real in-memory libsql, not a chained fake. What is under test is a DELETE
// whose scope is decided by a timestamp written moments earlier in the same
// function — a fake could assert the delete was issued, but only an engine shows
// which rows survived it.

let db: ReturnType<typeof drizzle>;
let client: Client;

/** A Solidarity user as the walk returns them. */
const user = (zip: string | null, chapterIds: number[]) => ({
	address: { zip_code: zip },
	chapter_ids: chapterIds,
});

async function seed(rows: Array<[string, number, string]>): Promise<void> {
	for (const [zip, chapterId, updatedAt] of rows) {
		await client.execute(
			`INSERT INTO zip_chapter_map (zip_code, chapter_id, member_count, updated_at)
			 VALUES ('${zip}', ${chapterId}, 1, '${updatedAt}')`,
		);
	}
}

async function stored(): Promise<Array<{ zip: string; chapter: number }>> {
	const res = await client.execute(
		'SELECT zip_code, chapter_id FROM zip_chapter_map ORDER BY zip_code',
	);
	return res.rows.map((r) => ({ zip: String(r.zip_code), chapter: Number(r.chapter_id) }));
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

describe('refreshZipChapterMap', () => {
	it('writes the zips members currently map to', async () => {
		mockFetchPaginated.mockResolvedValue([user('48104', [1330]), user('49504', [1313])]);

		expect(await refreshZipChapterMap(db)).toEqual({ mapped: 2, pruned: 0 });
		expect(await stored()).toEqual([
			{ zip: '48104', chapter: 1330 },
			{ zip: '49504', chapter: 1313 },
		]);
	});

	it('moves a zip whose members changed chapter', async () => {
		await seed([['48104', 1008, '2026-07-01T00:00:00.000Z']]);
		mockFetchPaginated.mockResolvedValue([user('48104', [1330])]);

		await refreshZipChapterMap(db);
		expect(await stored()).toEqual([{ zip: '48104', chapter: 1330 }]);
	});

	// The bug this function had: a zip that drops out of the computation — every
	// member there losing their chapter, or the last one moving away — used to
	// keep whatever the map last said about it, forever.
	it('prunes a zip no member maps to any more', async () => {
		await seed([
			['48104', 1330, '2026-07-01T00:00:00.000Z'],
			['49504', 1313, '2026-07-01T00:00:00.000Z'],
			['48201', 1008, '2026-07-01T00:00:00.000Z'],
		]);
		mockFetchPaginated.mockResolvedValue([user('48104', [1330]), user('49504', [1313])]);

		expect(await refreshZipChapterMap(db)).toEqual({ mapped: 2, pruned: 1 });
		expect(await stored()).toEqual([
			{ zip: '48104', chapter: 1330 },
			{ zip: '49504', chapter: 1313 },
		]);
	});

	it('prunes a key no lookup could ever have matched', async () => {
		// Real keys from the live table. Every lookup normalizes to five digits, so
		// these were unreachable rows taking up space and hiding their members.
		// Four good zips against three junk keys, because a fixture that is mostly
		// junk trips the shrink guard — in the live table these are 107 rows in
		// 3,377, nowhere near it.
		await seed([
			['48104', 1330, '2026-07-01T00:00:00.000Z'],
			['48105', 1330, '2026-07-01T00:00:00.000Z'],
			['48106', 1330, '2026-07-01T00:00:00.000Z'],
			['49504', 1313, '2026-07-01T00:00:00.000Z'],
			['N1H2N7', 1719, '2026-07-01T00:00:00.000Z'],
			['48212-3678', 1322, '2026-07-01T00:00:00.000Z'],
			['x', 1719, '2026-07-01T00:00:00.000Z'],
		]);
		mockFetchPaginated.mockResolvedValue([
			user('48104', [1330]),
			user('48105', [1330]),
			user('48106', [1330]),
			user('49504', [1313]),
			// The ZIP+4 member is not lost — they fold onto their five-digit zip.
			user('48212-3678', [1322]),
		]);

		expect(await refreshZipChapterMap(db)).toEqual({ mapped: 5, pruned: 3 });
		expect(await stored()).toEqual([
			{ zip: '48104', chapter: 1330 },
			{ zip: '48105', chapter: 1330 },
			{ zip: '48106', chapter: 1330 },
			{ zip: '48212', chapter: 1322 },
			{ zip: '49504', chapter: 1313 },
		]);
	});

	// The walk stops silently at MAX_PAGES, so a member base that outgrew the cap
	// looks exactly like one that shrank. Deleting against that read would drop
	// real mappings nothing rebuilds until those members are walked again.
	it('refuses to prune when the rebuild shrank implausibly', async () => {
		await seed(
			Array.from({ length: 10 }, (_, i) => [`4810${i}`, 1330, '2026-07-01T00:00:00.000Z']) as Array<
				[string, number, string]
			>,
		);
		mockFetchPaginated.mockResolvedValue([user('48104', [1330]), user('48105', [1330])]);

		expect(await refreshZipChapterMap(db)).toEqual({
			mapped: 2,
			pruned: 0,
			pruneSkipped: 'implausible-shrink',
		});
		// Every row still there, including the eight the read did not cover.
		expect(await stored()).toHaveLength(10);
	});

	it('still writes the zips it did read when it skips the prune', async () => {
		await seed(
			Array.from({ length: 10 }, (_, i) => [`4810${i}`, 1008, '2026-07-01T00:00:00.000Z']) as Array<
				[string, number, string]
			>,
		);
		mockFetchPaginated.mockResolvedValue([user('48104', [1330])]);

		await refreshZipChapterMap(db);
		const rows = await stored();
		// The one it could see is corrected; the rest are left alone rather than deleted.
		expect(rows.find((r) => r.zip === '48104')!.chapter).toBe(1330);
		expect(rows.filter((r) => r.chapter === 1008)).toHaveLength(9);
	});

	// An empty walk is a broken read every time: a campaign with no members has no
	// signups to sync either.
	it('never prunes on an empty result', async () => {
		await seed([['48104', 1330, '2026-07-01T00:00:00.000Z']]);
		mockFetchPaginated.mockResolvedValue([]);

		expect(await refreshZipChapterMap(db)).toEqual({
			mapped: 0,
			pruned: 0,
			pruneSkipped: 'empty-result',
		});
		expect(await stored()).toEqual([{ zip: '48104', chapter: 1330 }]);
	});

	it('prunes a table that shrank for a legitimate reason', async () => {
		// Six stored, four rebuilt — above the ratio floor, so this is a real
		// shrink rather than a truncated read.
		await seed(
			Array.from({ length: 6 }, (_, i) => [`4810${i}`, 1330, '2026-07-01T00:00:00.000Z']) as Array<
				[string, number, string]
			>,
		);
		mockFetchPaginated.mockResolvedValue([
			user('48100', [1330]),
			user('48101', [1330]),
			user('48102', [1330]),
			user('48103', [1330]),
		]);

		expect(await refreshZipChapterMap(db)).toEqual({ mapped: 4, pruned: 2 });
		expect(await stored()).toHaveLength(4);
	});

	it('counts a member whose chapter is on chapter_id alone', async () => {
		mockFetchPaginated.mockResolvedValue([
			{ address: { zip_code: '48104' }, chapter_id: 1330, chapter_ids: [] },
		]);

		expect(await refreshZipChapterMap(db)).toMatchObject({ mapped: 1 });
		expect(await stored()).toEqual([{ zip: '48104', chapter: 1330 }]);
	});

	// The setting that exists because 1008, a superseded statewide chapter, held
	// 178 Michigan zips its county successors should have had.
	it('hands zips to the county when the old statewide chapter is excluded', async () => {
		await seed([['48104', 1008, '2026-07-01T00:00:00.000Z']]);
		mockFetchPaginated.mockResolvedValue([
			user('48104', [1008]),
			user('48104', [1008]),
			user('48104', [1330]),
		]);

		await refreshZipChapterMap(db, new Set([1008]));
		expect(await stored()).toEqual([{ zip: '48104', chapter: 1330 }]);
	});

	it('prunes a zip only the excluded chapter had members in', async () => {
		await seed([
			['48104', 1330, '2026-07-01T00:00:00.000Z'],
			['48105', 1330, '2026-07-01T00:00:00.000Z'],
			['48201', 1008, '2026-07-01T00:00:00.000Z'],
		]);
		mockFetchPaginated.mockResolvedValue([
			user('48104', [1330]),
			user('48105', [1330]),
			user('48201', [1008]),
		]);

		// 48201 falls out entirely: nothing else claims it, so /turfs falls back to
		// the channel rather than naming a chapter nobody canvasses from.
		expect(await refreshZipChapterMap(db, new Set([1008]))).toEqual({ mapped: 2, pruned: 1 });
		expect(await stored()).toEqual([
			{ zip: '48104', chapter: 1330 },
			{ zip: '48105', chapter: 1330 },
		]);
	});

	it('excludes nothing when no chapter is configured', async () => {
		mockFetchPaginated.mockResolvedValue([user('48104', [1008])]);
		await refreshZipChapterMap(db);
		expect(await stored()).toEqual([{ zip: '48104', chapter: 1008 }]);
	});

	it('prunes in batches past the chunk size', async () => {
		await seed(
			Array.from({ length: 250 }, (_, i) => [
				`9${String(i).padStart(4, '0')}`,
				1719,
				'2026-07-01T00:00:00.000Z',
			]) as Array<[string, number, string]>,
		);
		// 250 stored, 200 rebuilt — above the floor, so the prune runs and has to
		// cross the 200-row chunk boundary.
		mockFetchPaginated.mockResolvedValue(
			Array.from({ length: 200 }, (_, i) => user(`9${String(i).padStart(4, '0')}`, [1330])),
		);

		expect(await refreshZipChapterMap(db)).toEqual({ mapped: 200, pruned: 50 });
		expect(await stored()).toHaveLength(200);
	});
});
