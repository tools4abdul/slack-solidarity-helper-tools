// Reading the checkout ledger for every door-knock number on the dashboard.
//
// One query shape feeds all four surfaces — the doors-cleared chart, the county
// leaderboard, the LED ticker and the countdown projection — because they are
// four views of the same fact: a volunteer completed a turf, and VAN later said
// how many doors left it. The rules live in $lib/van/doors-cleared.ts and
// $lib/van/doors-leaderboard.ts and are pure; this file does the rows.
//
// **Everything here is bucketed by campaign day, in TypeScript.** SQLite has no
// timezone support, so a `GROUP BY date(completed_at)` would file a Saturday
// evening canvass under Sunday for every knock after 8 pm ET — which is most of
// them. The row counts are small (one per completed turf, campaign-wide), so
// grouping in memory costs nothing and is the only way to get the day right.
//
// This replaces door-knock-leaderboard.ts, door-knock-ticker.ts and
// loadDoorKnockSignups, which read Openfield's nightly snapshot tables. Those
// tables still exist and are no longer read: see plan.md Story 9 for the
// cutover.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, eq, gte, isNotNull, min } from 'drizzle-orm';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { campaignDayKey, campaignWeekStart } from '../../campaign-time.js';
import { DEFAULT_RANKING_ALPHA } from '../../growth-ranking.js';
import {
	canvasserTotals,
	dailyDoorsCleared,
	latestActiveDay,
	rowsOnDay,
	unmovedDoorsWarning,
	type ClearedRow,
} from '../../van/doors-cleared.js';
import { buildDoorsLeaderboard, type DoorsLeaderboardPair } from '../../van/doors-leaderboard.js';
import type { DaySignups } from '../dashboard-signups.js';
import type { DoorsDayTotal } from '../doors-projection.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

/** How many names the ticker carries. Enough to feel alive without the loop
 *  getting so long that nobody sees their own name come round. */
export const TICKER_TOP_N = 10;

export interface TickerEntry {
	canvasser: string;
	/** Doors VAN confirmed cleared. Zero for someone whose turf finished tonight
	 *  and has not been recounted yet — `turfs` is what they show instead. */
	doors: number;
	turfs: number;
	/** The chapter they cleared the most doors in. '' when unknown. */
	chapter: string;
	/** 1-based standing for the day. */
	rank: number;
}

export interface DoorsTicker {
	/** The campaign day these standings cover, or null when there is no data. */
	date: string | null;
	entries: TickerEntry[];
}

const EMPTY_TICKER: DoorsTicker = { date: null, entries: [] };

/** Widen an ISO lower bound by a day, so a campaign-local window's first
 *  evening is not cut off by the UTC comparison used in SQL. */
function isoBoundFor(dayKey: string): string {
	return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) - 86_400_000).toISOString();
}

function dayKeyOf(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Completed checkouts, joined to the turf each was on.
 *
 * Completed only: a live claim is work in progress, and an expired or released
 * one is work that did not happen. `confirmedDoorDelta` may still be null — the
 * completion is known instantly and its doors are not (plan.md 9.6) — and the
 * pure layer keeps those apart rather than reading a null as zero.
 */
export async function loadClearedRows(
	db: Database,
	options: { since?: string; excludedChapterIds?: ReadonlySet<number> } = {},
): Promise<ClearedRow[]> {
	const rows = await db
		.select({
			mapRouteId: vanTurfCheckouts.mapRouteId,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			completedAt: vanTurfCheckouts.completedAt,
			doorsCleared: vanTurfCheckouts.confirmedDoorDelta,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				isNotNull(vanTurfCheckouts.completedAt),
				options.since ? gte(vanTurfCheckouts.completedAt, options.since) : undefined,
			),
		);

	const excluded = options.excludedChapterIds;
	return rows
		.filter(
			(row): row is typeof row & { completedAt: string } =>
				row.completedAt !== null && !(excluded?.has(row.chapterId) ?? false),
		)
		.map((row) => ({
			mapRouteId: row.mapRouteId,
			chapterId: row.chapterId,
			chapterName: row.chapterName,
			slackUserId: row.slackUserId,
			slackUserName: row.slackUserName,
			completedAt: row.completedAt,
			doorsCleared: row.doorsCleared,
		}));
}

/**
 * The first completion this app ever recorded — where the VAN series starts.
 *
 * Derived rather than configured, so nobody has to remember to set it and it
 * cannot drift from the data. It is what stops the board dividing this week's
 * doors CLEARED by a previous week of Openfield's doors KNOCKED (plan.md 9.9).
 */
export async function loadCutoverAt(db: Database): Promise<string | null> {
	const [row] = await db
		.select({ first: min(vanTurfCheckouts.completedAt) })
		.from(vanTurfCheckouts);
	return row?.first ?? null;
}

/** Rows whose campaign day falls in `[startKey, endKey)`. */
function inWindow(rows: readonly ClearedRow[], startKey: string, endKey: string): ClearedRow[] {
	return rows.filter((row) => {
		const key = campaignDayKey(row.completedAt);
		return key !== '' && key >= startKey && key < endKey;
	});
}

/**
 * Both tabs of the county board.
 *
 * `thisWeek` covers the current campaign week so far; `lastWeek` is the last
 * completed week, ranked against the week before it. Four windows in total, so
 * one read covers three weeks back and the slicing happens in memory.
 */
export async function computeDoorsLeaderboardPair(
	db: Database,
	options: { rankingAlpha?: number; now?: Date } = {},
): Promise<DoorsLeaderboardPair> {
	const now = options.now ?? new Date();
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;

	const thisMonday = campaignWeekStart(now);
	const lastMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
	const twoBack = new Date(thisMonday.getTime() - 14 * 86_400_000);
	const threeBack = new Date(thisMonday.getTime() - 21 * 86_400_000);

	const rows = await loadClearedRows(db, { since: isoBoundFor(dayKeyOf(threeBack)) });
	const cutoverAt = await loadCutoverAt(db);

	const nextMonday = new Date(thisMonday.getTime() + 7 * 86_400_000);
	const keys = {
		twoBack: dayKeyOf(twoBack),
		lastMonday: dayKeyOf(lastMonday),
		thisMonday: dayKeyOf(thisMonday),
		nextMonday: dayKeyOf(nextMonday),
	};

	return {
		thisWeek: {
			ok: true,
			leaderboard: buildDoorsLeaderboard({
				rows: inWindow(rows, keys.thisMonday, keys.nextMonday),
				prevRows: inWindow(rows, keys.lastMonday, keys.thisMonday),
				windowStart: thisMonday,
				windowEnd: now,
				cutoverAt,
				rankingAlpha,
			}),
		},
		lastWeek: {
			ok: true,
			leaderboard: buildDoorsLeaderboard({
				rows: inWindow(rows, keys.lastMonday, keys.thisMonday),
				prevRows: inWindow(rows, keys.twoBack, keys.lastMonday),
				windowStart: lastMonday,
				windowEnd: thisMonday,
				cutoverAt,
				rankingAlpha,
			}),
		},
	};
}

/**
 * The day's personal standings for the LED ticker.
 *
 * The day shown is the latest one with any completion on it: during a canvass
 * that is today, and overnight it holds the day that just finished rather than
 * blanking out — the same rule the Openfield ticker used, for the same reason.
 */
export async function loadDoorsTicker(
	db: Database,
	options: { limit?: number; now?: Date } = {},
): Promise<DoorsTicker> {
	const limit = options.limit ?? TICKER_TOP_N;
	const now = options.now ?? new Date();
	// Two days back is plenty to find "the latest active day" and keeps the read
	// off the whole ledger.
	const rows = await loadClearedRows(db, {
		since: isoBoundFor(dayKeyOf(new Date(now.getTime() - 2 * 86_400_000))),
	});

	const date = latestActiveDay(rows);
	if (date === null) return EMPTY_TICKER;

	const entries = canvasserTotals(rowsOnDay(rows, date))
		.slice(0, limit)
		.map((person, index) => ({
			canvasser: person.slackUserName,
			doors: person.doorsCleared,
			turfs: person.turfsCompleted,
			chapter: person.chapterName,
			rank: index + 1,
		}));

	return { date, entries };
}

/**
 * The doors-cleared chart series: one point per campaign day, split by chapter.
 *
 * Shaped as `DaySignups` so it drops into the same chart the Solidarity and
 * Slack series use. Unlike the Openfield version this can honour the report's
 * chapter exclusions, because a checkout row carries a real chapter id rather
 * than a conversation-code name.
 */
export async function loadDoorsClearedSignups(
	db: Database,
	options: { days: number; excludedChapterIds?: ReadonlySet<number>; now?: Date },
): Promise<DaySignups[]> {
	const now = options.now ?? new Date();
	const since = isoBoundFor(dayKeyOf(new Date(now.getTime() - options.days * 86_400_000)));
	const rows = await loadClearedRows(db, {
		since,
		excludedChapterIds: options.excludedChapterIds,
	});

	return dailyDoorsCleared(rows).map((day) => ({
		date: day.date,
		total: day.doorsCleared,
		byChapter: day.byChapter.map((chapter) => ({
			chapterId: chapter.chapterId,
			chapterName: chapter.chapterName,
			count: chapter.doorsCleared,
		})),
	}));
}

/** Per-day doors cleared, ascending — what the countdown projection
 *  extrapolates from. */
export async function loadDoorsDayTotals(db: Database): Promise<DoorsDayTotal[]> {
	const rows = await loadClearedRows(db);
	return dailyDoorsCleared(rows).map((day) => ({ date: day.date, total: day.doorsCleared }));
}

/**
 * Story 9.4's health check, as a sync warning.
 *
 * The single biggest risk in the story: every doors number depends on map
 * regions being cut with a "not yet contacted" filter, and nothing in this
 * codebase can enforce that. A week of completions that cleared nothing is the
 * only signal we get.
 */
export async function doorsHealthWarning(db: Database, now: Date): Promise<string | null> {
	const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
	const rows = await loadClearedRows(db, { since });
	return unmovedDoorsWarning(rows);
}
