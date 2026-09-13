// The county canvassing board, rebuilt on VAN.
//
// The ranking is unchanged from the Openfield-era board it replaces (plan.md
// 9.2): Monday-pinned campaign-local weeks, and the same power-law score —
// volume / (previous week's volume + 1)^α — so the board rewards the chapters
// improving the most rather than the biggest ones. `rankingScore` operates on
// one volume number and a previous-window denominator, so swapping doors
// knocked for doors cleared needs no change to the maths.
//
// **The metric set did change, and honestly.** VAN can feed doors cleared,
// turfs completed and canvassers out; it cannot feed attempts or a contact
// rate, because a not-home door stays on the list and leaves no trace
// (plan.md §2, Constraint C). Those two columns are gone rather than filled
// with a number that means something else — putting doors-cleared in both
// columns would render a permanent 100% contact rate, which is worse than an
// absent stat.
//
// Pure: rows in, board out. doors-store.ts does the reading.

import { rankingScore, TOP_N } from '../growth-ranking.js';
import { chapterTotals, type ChapterTotals, type ClearedRow } from './doors-cleared.js';

export interface DoorsChapterEntry {
	chapterId: number;
	chapterName: string;
	doorsCleared: number;
	turfsCompleted: number;
	canvassers: number;
	/** Completions here whose doors VAN has not counted yet. */
	awaitingCount: number;
	/** Doors cleared in the PREVIOUS window — the ranking denominator. */
	prevDoors: number;
	/** Week-over-week change. Only meaningful when `comparable` is true. */
	pct: number;
	/**
	 * Whether the previous window is a fair comparison.
	 *
	 * False for a chapter with no prior-week doors, and false for EVERY chapter
	 * in a window whose predecessor predates the VAN cutover (plan.md 9.9): the
	 * old board counted doors *knocked* from Openfield and this one counts doors
	 * *cleared* from VAN, so a percentage across that boundary is fiction. The
	 * board shows raw volume and suppresses the denominator instead of quietly
	 * dividing by a different metric.
	 */
	comparable: boolean;
}

export interface DoorsLeaderboard {
	windowStart: string;
	windowEnd: string;
	/** Across ALL chapters in the window, not just the top five. */
	totalDoorsCleared: number;
	totalTurfsCompleted: number;
	totalCanvassers: number;
	/** Completions still waiting on VAN's recount. Rendered as a caveat under
	 *  the total, because doors and turfs run on different clocks (9.6). */
	awaitingCount: number;
	/** True when this window's predecessor is wholly before the cutover, so no
	 *  entry in it carries a week-over-week figure. */
	firstVanWeek: boolean;
	topChapters: DoorsChapterEntry[];
}

export type DoorsLeaderboardResult =
	{ ok: true; leaderboard: DoorsLeaderboard } | { ok: false; error: string };

export interface DoorsLeaderboardPair {
	lastWeek: DoorsLeaderboardResult;
	thisWeek: DoorsLeaderboardResult;
}

export interface BuildLeaderboardInput {
	/** Completions inside the window. */
	rows: readonly ClearedRow[];
	/** Completions inside the window before it — the denominator. */
	prevRows: readonly ClearedRow[];
	windowStart: Date;
	windowEnd: Date;
	/**
	 * When VAN-era data begins: the first completion this app ever recorded.
	 * Null when there is none yet, which reads the same as "everything is the
	 * first week".
	 */
	cutoverAt: string | null;
	rankingAlpha: number;
}

/** True when the window before `windowStart` cannot be compared against,
 *  because VAN-era data does not cover all of it. */
function predecessorPredatesCutover(windowStart: Date, cutoverAt: string | null): boolean {
	if (cutoverAt === null) return true;
	const prevStart = new Date(windowStart.getTime() - 7 * 86_400_000);
	const cutover = Date.parse(cutoverAt);
	if (Number.isNaN(cutover)) return true;
	return cutover > prevStart.getTime();
}

export function buildDoorsLeaderboard(input: BuildLeaderboardInput): DoorsLeaderboard {
	const { rows, prevRows, windowStart, windowEnd, cutoverAt, rankingAlpha } = input;

	const totals = chapterTotals(rows);
	const prevByChapter = new Map<number, ChapterTotals>(
		chapterTotals(prevRows).map((t) => [t.chapterId, t]),
	);
	const firstVanWeek = predecessorPredatesCutover(windowStart, cutoverAt);

	const entries = totals
		// A chapter that completed turf but has no doors counted yet still
		// belongs on the board — dropping it would make the busiest county
		// vanish on the evening of its own canvass.
		.filter((t) => t.doorsCleared > 0 || t.turfsCompleted > 0)
		.map((t) => {
			const prevDoors = prevByChapter.get(t.chapterId)?.doorsCleared ?? 0;
			const comparable = !firstVanWeek && prevDoors > 0;
			return {
				chapterId: t.chapterId,
				chapterName: t.chapterName,
				doorsCleared: t.doorsCleared,
				turfsCompleted: t.turfsCompleted,
				canvassers: t.canvassers,
				awaitingCount: t.awaitingCount,
				prevDoors: comparable ? prevDoors : 0,
				pct: comparable ? ((t.doorsCleared - prevDoors) / prevDoors) * 100 : 0,
				comparable,
				// RankableChapter adapter: the same score the Slack board uses,
				// with last week's doors as the size denominator.
				newJoins: t.doorsCleared,
				existing: comparable ? prevDoors : 0,
			};
		});

	// Chapters with a real prior-week comparison rank above chapters without
	// one. Without this, a denominator of 1 floats a brand-new chapter's raw
	// volume straight to the top with no improvement to reward. In a first VAN
	// week nobody is comparable, so this collapses to a raw-volume ranking —
	// which is exactly what 9.9 asks the first week to be.
	entries.sort((a, b) => {
		if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
		const scoreDelta = rankingScore(b, rankingAlpha) - rankingScore(a, rankingAlpha);
		if (scoreDelta !== 0) return scoreDelta;
		return b.doorsCleared - a.doorsCleared || b.turfsCompleted - a.turfsCompleted;
	});

	const topChapters = entries.slice(0, TOP_N).map(({ newJoins, existing, ...entry }) => {
		void newJoins;
		void existing;
		return entry;
	});

	const people = new Set(rows.map((r) => r.slackUserId));
	return {
		windowStart: windowStart.toISOString(),
		windowEnd: windowEnd.toISOString(),
		totalDoorsCleared: totals.reduce((sum, t) => sum + t.doorsCleared, 0),
		totalTurfsCompleted: totals.reduce((sum, t) => sum + t.turfsCompleted, 0),
		totalCanvassers: people.size,
		awaitingCount: totals.reduce((sum, t) => sum + t.awaitingCount, 0),
		firstVanWeek,
		topChapters,
	};
}
