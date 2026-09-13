// Read-side aggregation for the dashboard's signups-per-day chart.
// Returns Solidarity (from solidarity_daily_snapshots) and Slack (from
// slack_joins) counts bucketed by date, each with a per-chapter breakdown.
//
// Same import discipline as solidarity-snapshot.ts and weekly-growth-report.ts:
// no $env/$lib imports so this module stays trivially importable from tests
// and standalone scripts.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, asc, gte, notInArray, sql, type SQL } from 'drizzle-orm';
import { solidarityDailySnapshots } from './schema.js';
import { loadChapterNames } from './chapter-names.js';
import { DISTINCT_TOTAL_SENTINEL } from './solidarity-snapshot.js';

const NULL_CHAPTER_SENTINEL = -1;

export interface ChapterCount {
	chapterId: number | null;
	chapterName: string | null;
	count: number;
}

export interface DaySignups {
	date: string;
	total: number;
	byChapter: ChapterCount[];
}

export interface DashboardSignups {
	solidarity: DaySignups[];
	slack: DaySignups[];
}

export interface GetDashboardSignupsOptions {
	days: number;
	/** Chapter IDs to omit from the result (e.g. test / internal-only chapters).
	 *  Solidarity: drops rows entirely. Slack: drops per-chapter rows and also
	 *  drops users whose chapter_ids contain ONLY excluded chapters (so totals
	 *  stay consistent with the visible bands). */
	excludedChapterIds?: ReadonlySet<number>;
}

// Window covers `days` calendar dates (UTC) ending on `endDate`, inclusive.
// e.g. days=7 → endDate and the 6 prior dates; days=90 → endDate and the 89
// prior dates.
//
// `endDate` is the latest date a source actually has data for — NOT today (see
// the latest*Date helpers). Anchoring to the newest data instead of "today"
// means a 7/30/90-day view always spans that many days of real data even when
// today's nightly snapshot hasn't been written yet. Anchoring to today instead
// dropped a day off the right edge (the chart's x-axis stops at the last day
// with data), so the view rendered `days - 1` days.
function windowStartDate(endDate: string, days: number): string {
	const [y, m, d] = endDate.split('-').map(Number);
	const start = Date.UTC(y!, m! - 1, d! - (days - 1));
	return new Date(start).toISOString().slice(0, 10);
}

// Latest date each source has data for. Returns null when the source is empty,
// in which case the loader short-circuits to [].
async function latestSolidarityDate(
	db: LibSQLDatabase<Record<string, unknown>>,
): Promise<string | null> {
	const rows = await db
		.select({ max: sql<string | null>`MAX(${solidarityDailySnapshots.date})` })
		.from(solidarityDailySnapshots);
	return rows[0]?.max ?? null;
}

async function latestSlackDate(
	db: LibSQLDatabase<Record<string, unknown>>,
): Promise<string | null> {
	const rows = (await db.all(
		sql`SELECT MAX(DATE(joined_at)) AS max FROM slack_joins WHERE joined_at IS NOT NULL`,
	)) as Array<{ max: string | null }>;
	return rows[0]?.max ?? null;
}

// Sort byChapter ascending by chapterId, with the null bucket last.
function sortByChapter(a: ChapterCount, b: ChapterCount): number {
	if (a.chapterId === null) return 1;
	if (b.chapterId === null) return -1;
	return a.chapterId - b.chapterId;
}

export async function loadSolidaritySignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DaySignups[]> {
	return loadSolidarity(db, options.days, options.excludedChapterIds ?? new Set());
}

export async function loadSlackSignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DaySignups[]> {
	return loadSlack(db, options.days, options.excludedChapterIds ?? new Set());
}

async function loadSolidarity(
	db: LibSQLDatabase<Record<string, unknown>>,
	days: number,
	excluded: ReadonlySet<number>,
): Promise<DaySignups[]> {
	const endDate = await latestSolidarityDate(db);
	if (endDate === null) return [];
	const startDate = windowStartDate(endDate, days);
	// User-supplied excluded IDs only contain real chapter IDs, so the SQL
	// filter naturally leaves the DISTINCT_TOTAL_SENTINEL row through. We
	// separate it from real-chapter rows in JS below.
	const conditions: SQL[] = [gte(solidarityDailySnapshots.date, startDate)];
	if (excluded.size > 0) {
		conditions.push(notInArray(solidarityDailySnapshots.chapterId, [...excluded]));
	}
	const rows = await db
		.select({
			date: solidarityDailySnapshots.date,
			chapterId: solidarityDailySnapshots.chapterId,
			chapterName: solidarityDailySnapshots.chapterName,
			count: solidarityDailySnapshots.count,
		})
		.from(solidarityDailySnapshots)
		.where(and(...conditions))
		.orderBy(asc(solidarityDailySnapshots.date), asc(solidarityDailySnapshots.chapterId));

	const byDate = new Map<string, DaySignups>();
	const distinctTotalByDate = new Map<string, number>();
	for (const row of rows) {
		if (row.chapterId === DISTINCT_TOTAL_SENTINEL) {
			distinctTotalByDate.set(row.date, row.count);
			continue;
		}
		let day = byDate.get(row.date);
		if (!day) {
			day = { date: row.date, total: 0, byChapter: [] };
			byDate.set(row.date, day);
		}
		const isNull = row.chapterId === NULL_CHAPTER_SENTINEL;
		day.byChapter.push({
			chapterId: isNull ? null : row.chapterId,
			chapterName: isNull ? null : row.chapterName,
			count: row.count,
		});
		// Running sum-of-bands; overridden below with the distinct count when
		// available and no chapter-level exclusion is in effect.
		day.total += row.count;
	}
	// Prefer the snapshot's distinct-user count over sum-of-bands so multi-
	// chapter members aren't double-counted. With chapter exclusion active we
	// keep sum-of-bands because the sentinel still counts users in excluded
	// chapters — sum-of-(non-excluded)-bands is the right total for that case.
	// Legacy days written before the sentinel existed have no entry here and
	// keep the sum-of-bands fallback.
	if (excluded.size === 0) {
		for (const [date, distinctTotal] of distinctTotalByDate) {
			const day = byDate.get(date);
			if (day) day.total = distinctTotal;
		}
	}
	const result = [...byDate.values()];
	for (const d of result) d.byChapter.sort(sortByChapter);
	result.sort((a, b) => a.date.localeCompare(b.date));
	return result;
}

async function loadSlack(
	db: LibSQLDatabase<Record<string, unknown>>,
	days: number,
	excluded: ReadonlySet<number>,
): Promise<DaySignups[]> {
	const endDate = await latestSlackDate(db);
	if (endDate === null) return [];
	const startDate = windowStartDate(endDate, days);
	// Excluded chapter IDs come from a trusted env var, so inlining as a comma
	// list is safe (drizzle's `sql.raw` skips bind parameters). When empty, the
	// fragments below collapse to `sql``.
	const excludedList = excluded.size > 0 ? sql.raw([...excluded].join(',')) : null;
	const chapterExclusion = excludedList
		? sql`AND CAST(je.value AS INTEGER) NOT IN (${excludedList})`
		: sql``;
	const totalExclusion = excludedList
		? sql`AND (
			chapter_ids = '[]'
			OR EXISTS (
				SELECT 1 FROM json_each(slack_joins.chapter_ids) je2
				WHERE CAST(je2.value AS INTEGER) NOT IN (${excludedList})
			)
		)`
		: sql``;

	// Per-chapter buckets via json_each. Rows with chapter_ids = '[]' produce
	// no json_each rows and are picked up separately below.
	const chapterRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date,
		       CAST(je.value AS INTEGER) AS chapter_id,
		       COUNT(*) AS count
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		WHERE joined_at IS NOT NULL AND DATE(joined_at) >= ${startDate}
		${chapterExclusion}
		GROUP BY date, chapter_id
	`)) as Array<{ date: string; chapter_id: number; count: number }>;

	// No-chapter bucket — rows with chapter_ids = '[]'. Exclusion doesn't apply
	// here since these rows have no chapter IDs to match against.
	const nullChapterRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date, COUNT(*) AS count
		FROM slack_joins
		WHERE joined_at IS NOT NULL
		  AND chapter_ids = '[]'
		  AND DATE(joined_at) >= ${startDate}
		GROUP BY date
	`)) as Array<{ date: string; count: number }>;

	// Distinct daily totals — each slack_joins row is one user, so multi-chapter
	// users aren't double-counted. Users whose chapter_ids contain ONLY excluded
	// chapters drop out so the total stays consistent with the visible bands.
	const totalRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date, COUNT(*) AS total
		FROM slack_joins
		WHERE joined_at IS NOT NULL AND DATE(joined_at) >= ${startDate}
		${totalExclusion}
		GROUP BY date
	`)) as Array<{ date: string; total: number }>;

	const names = await loadChapterNames(db);
	const byDate = new Map<string, DaySignups>();
	const day = (date: string) => {
		let d = byDate.get(date);
		if (!d) {
			d = { date, total: 0, byChapter: [] };
			byDate.set(date, d);
		}
		return d;
	};

	for (const r of chapterRows) {
		day(r.date).byChapter.push({
			chapterId: Number(r.chapter_id),
			chapterName: names.get(Number(r.chapter_id)) ?? `Chapter #${r.chapter_id}`,
			count: Number(r.count),
		});
	}
	for (const r of nullChapterRows) {
		day(r.date).byChapter.push({
			chapterId: null,
			chapterName: null,
			count: Number(r.count),
		});
	}
	for (const r of totalRows) {
		day(r.date).total = Number(r.total);
	}

	const result = [...byDate.values()];
	for (const d of result) d.byChapter.sort(sortByChapter);
	result.sort((a, b) => a.date.localeCompare(b.date));
	return result;
}

/** Doors knocked per day from the nightly door_knock_daily snapshot, bucketed
 *  like the signup sources so the dashboard chart pipeline can reuse
 *  buildDetailFrame. Door-knock chapter names have no Solidarity ids, so bands get
 *  stable synthetic ids (index into the window's sorted chapter names) —
 *  excludedChapterIds deliberately does not apply here. */

export async function getDashboardSignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DashboardSignups> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const [solidarity, slack] = await Promise.all([
		loadSolidarity(db, options.days, excluded),
		loadSlack(db, options.days, excluded),
	]);
	return { solidarity, slack };
}
