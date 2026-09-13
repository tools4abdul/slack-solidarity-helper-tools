import { describe, it, expect, vi } from 'vitest';
import {
	getDashboardSignups,
	loadSlackSignups,
	loadSolidaritySignups,
} from './dashboard-signups.js';

// The aggregation function makes several kinds of db calls:
//   - a latest-date probe per source (MAX(date) / MAX(DATE(joined_at))) that
//     anchors the window to the newest data rather than to "today"
//   - select().from().where().orderBy() and select().from() for Solidarity
//     snapshot rows and chapter-name lookup
//   - db.all(sql`...`) for the three Slack queries (per-chapter,
//     null-chapter, total)
//
// We model the chained select with a queue so we can return different rows for
// the max-date probe / snapshot query / chapter-name query, and a separate
// queue for db.all. Both queues are FIFO; the loaders consume them in a fixed
// order (see each test's push sequence).

interface MockDb {
	select: ReturnType<typeof vi.fn>;
	all: ReturnType<typeof vi.fn>;
	_pushSelect: (rows: unknown[]) => void;
	_pushAll: (rows: unknown[]) => void;
	/** All values passed to any `.where()` call across every select chain, in
	 *  call order. Each entry is the single SQL object drizzle was handed. */
	_whereArgs: () => unknown[];
}

// A latest-date probe result row (`MAX(...) AS max`). Anchors the window.
function maxDateRows(date: string | null): Array<{ max: string | null }> {
	return [{ max: date }];
}

// Drizzle's SQL objects contain circular references (column → table → column),
// so plain JSON.stringify throws. WeakSet-based replacer is enough for our needs.
function safeStringify(obj: unknown): string {
	const seen = new WeakSet();
	return JSON.stringify(obj, (_key, value: unknown) => {
		if (typeof value === 'object' && value !== null) {
			if (seen.has(value as object)) return '[Circular]';
			seen.add(value as object);
		}
		return value;
	});
}

function makeDb(): MockDb {
	const selectQueue: unknown[][] = [];
	const allQueue: unknown[][] = [];
	const whereArgs: unknown[] = [];

	function chain(rows: unknown[]) {
		const thenable = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
		const orderBy = vi.fn().mockResolvedValue(rows);
		const groupBy = vi.fn(() => ({ orderBy, then: thenable }));
		const where = vi.fn((arg: unknown) => {
			whereArgs.push(arg);
			return { orderBy, groupBy, then: thenable };
		});
		const from = vi.fn(() => ({ where, orderBy, groupBy, then: thenable }));
		return { from };
	}

	const select = vi.fn(() => {
		const rows = selectQueue.shift() ?? [];
		return chain(rows);
	});
	const all = vi.fn(async () => allQueue.shift() ?? []);

	return {
		select,
		all,
		_pushSelect: (rows) => selectQueue.push(rows),
		_pushAll: (rows) => allQueue.push(rows),
		_whereArgs: () => whereArgs,
	};
}

// The doors series moved to van/doors-store.ts with Story 9 — it now reads the
// turf checkout ledger, and its tests run against a real database there.

describe('getDashboardSignups', () => {
	it('groups Solidarity snapshot rows by date and sums total', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows('2026-05-10')); // Solidarity latest-date probe
		// Snapshot select
		db._pushSelect([
			{ date: '2026-05-09', chapterId: 100, chapterName: 'Alpha', count: 3 },
			{ date: '2026-05-09', chapterId: 200, chapterName: 'Beta', count: 5 },
			{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 7 },
		]);
		db._pushAll(maxDateRows(null)); // Slack empty → short-circuits

		const result = await getDashboardSignups(db as never, { days: 90 });

		expect(result.solidarity).toEqual([
			{
				date: '2026-05-09',
				total: 8,
				byChapter: [
					{ chapterId: 100, chapterName: 'Alpha', count: 3 },
					{ chapterId: 200, chapterName: 'Beta', count: 5 },
				],
			},
			{
				date: '2026-05-10',
				total: 7,
				byChapter: [{ chapterId: 100, chapterName: 'Alpha', count: 7 }],
			},
		]);
	});

	it('maps Solidarity sentinel chapterId=-1 to null/null in the response', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows('2026-05-10'));
		db._pushSelect([
			{ date: '2026-05-10', chapterId: -1, chapterName: null, count: 4 },
			{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 2 },
		]);
		db._pushAll(maxDateRows(null));

		const result = await getDashboardSignups(db as never, { days: 90 });

		expect(result.solidarity[0]!.byChapter).toEqual([
			{ chapterId: 100, chapterName: 'Alpha', count: 2 },
			{ chapterId: null, chapterName: null, count: 4 },
		]);
		expect(result.solidarity[0]!.total).toBe(6);
	});

	it('builds Slack days from per-chapter, null-chapter, and total queries', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null)); // no Solidarity data → short-circuits
		db._pushSelect([{ chapterId: 100, chapterName: 'Alpha' }]); // chapter names
		db._pushAll(maxDateRows('2026-05-10')); // Slack latest-date probe
		db._pushAll([
			{ date: '2026-05-10', chapter_id: 100, count: 4 },
			{ date: '2026-05-10', chapter_id: 200, count: 1 },
		]);
		db._pushAll([{ date: '2026-05-10', count: 2 }]); // null-chapter bucket
		// Distinct user total — less than 4+1+2=7 because some users belong to
		// multiple chapters and are counted once here.
		db._pushAll([{ date: '2026-05-10', total: 5 }]);

		const result = await getDashboardSignups(db as never, { days: 90 });

		expect(result.slack).toEqual([
			{
				date: '2026-05-10',
				total: 5,
				byChapter: [
					{ chapterId: 100, chapterName: 'Alpha', count: 4 },
					{ chapterId: 200, chapterName: 'Chapter #200', count: 1 },
					{ chapterId: null, chapterName: null, count: 2 },
				],
			},
		]);
	});

	it('falls back to "Chapter #N" when no snapshot row carries the name', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null)); // no Solidarity data
		db._pushSelect([]); // no chapter names known
		db._pushAll(maxDateRows('2026-05-10'));
		db._pushAll([{ date: '2026-05-10', chapter_id: 999, count: 3 }]);
		db._pushAll([]);
		db._pushAll([{ date: '2026-05-10', total: 3 }]);

		const result = await getDashboardSignups(db as never, { days: 90 });

		expect(result.slack[0]!.byChapter[0]).toEqual({
			chapterId: 999,
			chapterName: 'Chapter #999',
			count: 3,
		});
	});

	it('anchors the Slack window to the latest join date − (days − 1), not today', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null)); // Solidarity unused here
		db._pushSelect([]);
		db._pushAll(maxDateRows('2026-05-10')); // latest join date
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		await getDashboardSignups(db as never, { days: 7 });

		// latest join date 2026-05-10; days=7 → window start 2026-05-04. The three
		// Slack data queries (calls after the latest-date probe) carry that start.
		const dataSql = db.all.mock.calls.slice(1).map((c) => JSON.stringify(c[0]));
		expect(dataSql).toHaveLength(3);
		for (const s of dataSql) {
			expect(s).toContain('2026-05-04');
		}
	});

	it('days=1 covers only the latest data date', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null));
		db._pushSelect([]);
		db._pushAll(maxDateRows('2026-05-10'));
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		await getDashboardSignups(db as never, { days: 1 });

		const dataSql = db.all.mock.calls.slice(1).map((c) => JSON.stringify(c[0]));
		for (const s of dataSql) {
			expect(s).toContain('2026-05-10');
		}
	});

	it('returns empty arrays when there is no data', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null)); // Solidarity empty
		db._pushAll(maxDateRows(null)); // Slack empty

		const result = await getDashboardSignups(db as never, { days: 90 });
		expect(result).toEqual({ solidarity: [], slack: [] });
	});

	it('sorts Slack days ascending by date', async () => {
		const db = makeDb();
		db._pushSelect(maxDateRows(null));
		db._pushSelect([]);
		db._pushAll(maxDateRows('2026-05-10'));
		db._pushAll([
			{ date: '2026-05-10', chapter_id: 100, count: 1 },
			{ date: '2026-05-08', chapter_id: 100, count: 1 },
			{ date: '2026-05-09', chapter_id: 100, count: 1 },
		]);
		db._pushAll([]);
		db._pushAll([
			{ date: '2026-05-10', total: 1 },
			{ date: '2026-05-08', total: 1 },
			{ date: '2026-05-09', total: 1 },
		]);

		const result = await getDashboardSignups(db as never, { days: 90 });
		expect(result.slack.map((d) => d.date)).toEqual(['2026-05-08', '2026-05-09', '2026-05-10']);
	});

	describe('distinct-total sentinel', () => {
		it('uses the -2 sentinel row as the daily total instead of summing chapter buckets', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10'));
			// Two users, both in chapters 100 and 200. Sum-of-buckets = 4; distinct = 2.
			db._pushSelect([
				{ date: '2026-05-10', chapterId: -2, chapterName: null, count: 2 },
				{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 2 },
				{ date: '2026-05-10', chapterId: 200, chapterName: 'Beta', count: 2 },
			]);
			db._pushAll(maxDateRows(null));

			const result = await getDashboardSignups(db as never, { days: 90 });

			expect(result.solidarity).toEqual([
				{
					date: '2026-05-10',
					total: 2,
					byChapter: [
						{ chapterId: 100, chapterName: 'Alpha', count: 2 },
						{ chapterId: 200, chapterName: 'Beta', count: 2 },
					],
				},
			]);
		});

		it('falls back to sum-of-bands when no sentinel row exists (legacy data)', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10'));
			db._pushSelect([
				{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 3 },
				{ date: '2026-05-10', chapterId: 200, chapterName: 'Beta', count: 4 },
			]);
			db._pushAll(maxDateRows(null));

			const result = await getDashboardSignups(db as never, { days: 90 });
			expect(result.solidarity[0]!.total).toBe(7);
		});

		it('ignores the sentinel and uses sum-of-(non-excluded)-bands when exclusion is active', async () => {
			const db = makeDb();
			// 3 distinct users; chapter 100 has 3, chapter 200 has 1.
			// With chapter 100 excluded, sum-of-non-excluded-bands = 1.
			// The sentinel (3) would include the excluded users, so we must skip it.
			db._pushSelect(maxDateRows('2026-05-10'));
			db._pushSelect([
				{ date: '2026-05-10', chapterId: -2, chapterName: null, count: 3 },
				{ date: '2026-05-10', chapterId: 200, chapterName: 'Beta', count: 1 },
			]);
			db._pushAll(maxDateRows(null));

			const result = await getDashboardSignups(db as never, {
				days: 90,
				excludedChapterIds: new Set([100]),
			});
			expect(result.solidarity[0]!.total).toBe(1);
		});

		it('never surfaces the -2 sentinel as a byChapter entry', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10'));
			db._pushSelect([
				{ date: '2026-05-10', chapterId: -2, chapterName: null, count: 1 },
				{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 1 },
			]);
			db._pushAll(maxDateRows(null));

			const result = await getDashboardSignups(db as never, { days: 90 });
			for (const day of result.solidarity) {
				for (const c of day.byChapter) {
					expect(c.chapterId).not.toBe(-2);
				}
			}
		});
	});

	describe('excludedChapterIds', () => {
		it('omits a NOT IN clause from every query when the set is empty', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10')); // Solidarity probe
			db._pushSelect([]); // snapshot rows
			db._pushSelect([]); // Slack chapter names
			db._pushAll(maxDateRows('2026-05-10')); // Slack probe
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await getDashboardSignups(db as never, { days: 90 });

			const allSql = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
			for (const s of allSql) {
				expect(s).not.toContain('NOT IN');
				expect(s).not.toContain('EXISTS');
			}
		});

		it('passes the exclusion through to every query when the set is non-empty', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10')); // Solidarity probe
			db._pushSelect([]); // snapshot rows
			db._pushSelect([]); // Slack chapter names
			db._pushAll(maxDateRows('2026-05-10')); // Slack probe
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await getDashboardSignups(db as never, {
				days: 90,
				excludedChapterIds: new Set([1008, 1999]),
			});

			// Slack issues three data queries after the latest-date probe (per-chapter,
			// null-chapter, total). chapter and total queries get a NOT IN clause;
			// null-chapter doesn't, because those rows have no chapter IDs to match.
			const dataSql = db.all.mock.calls.slice(1).map((c) => JSON.stringify(c[0]));
			expect(dataSql).toHaveLength(3);
			expect(dataSql[0]).toContain('NOT IN');
			expect(dataSql[0]).toContain('1008');
			expect(dataSql[0]).toContain('1999');
			expect(dataSql[1]).not.toContain('NOT IN');
			expect(dataSql[2]).toContain('EXISTS');
			expect(dataSql[2]).toContain('NOT IN');
			expect(dataSql[2]).toContain('1008');
			expect(dataSql[2]).toContain('1999');

			// The Solidarity query is built via drizzle's query builder, so the
			// exclusion lands in the `.where()` call as an AND of (gte, notInArray).
			// The exact internal shape is opaque, so we only assert the SQL produced
			// references the excluded ID — drizzle stringifies notInArray with a
			// `not in` clause and inlines the chapter_id column.
			const whereSql = db._whereArgs().map((arg) => safeStringify(arg));
			expect(whereSql.length).toBeGreaterThan(0);
			const solidarityWhere = whereSql[0]!;
			expect(solidarityWhere).toMatch(/not in/i);
			expect(solidarityWhere).toContain('1008');
			expect(solidarityWhere).toContain('1999');
		});

		it('loadSolidaritySignups receives the exclusion (top-level entry point)', async () => {
			const db = makeDb();
			db._pushSelect(maxDateRows('2026-05-10')); // latest-date probe
			db._pushSelect([]); // snapshot rows

			await loadSolidaritySignups(db as never, {
				days: 30,
				excludedChapterIds: new Set([42]),
			});

			const whereSql = db._whereArgs().map((arg) => safeStringify(arg));
			expect(whereSql.length).toBeGreaterThan(0);
			expect(whereSql[0]).toMatch(/not in/i);
			expect(whereSql[0]).toContain('42');
		});

		it('loadSlackSignups receives the exclusion (top-level entry point)', async () => {
			const db = makeDb();
			db._pushAll(maxDateRows('2026-05-10')); // latest-date probe
			db._pushSelect([]); // chapter-name lookup
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await loadSlackSignups(db as never, {
				days: 30,
				excludedChapterIds: new Set([42]),
			});

			const dataSql = db.all.mock.calls.slice(1).map((c) => JSON.stringify(c[0]));
			expect(dataSql[0]).toContain('NOT IN');
			expect(dataSql[0]).toContain('42');
			expect(dataSql[2]).toContain('EXISTS');
			expect(dataSql[2]).toContain('42');
		});
	});
});
