// Weekly per-chapter Slack-signup growth report. Reads slack_joins, splits each
// chapter's members into "existing" (joined before the window) and "new" (joined
// within the window), ranks by growth percentage, and posts the top 5 to a
// Slack channel with extra fanfare for #1.
//
// Same import-discipline as solidarity-snapshot.ts: no $env/$lib imports so this
// module stays trivially importable from a standalone script if we add one later.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { sql, and, count, eq, desc, gte, lt } from 'drizzle-orm';
import { loadChapterNames } from './chapter-names.js';
import { weeklyGrowthWindows, weeklyChapterGrowth, slackJoins } from './schema.js';
// Ranking math lives in a client-safe module so the /settings alpha-slider
// preview can re-rank the same data in the browser. The app_config setting
// (env fallback SLACK_GROWTH_REPORT_RANKING_ALPHA) overrides the default.
import { TOP_N, DEFAULT_RANKING_ALPHA, sortByRanking } from '../growth-ranking.js';

const WINDOW_DAYS = 7;

export interface ChapterGrowth {
	chapterId: number;
	chapterName: string;
	/** Slack channel ID for this chapter, when the chapter↔channel settings map
	 * has an entry — used to render a clickable channel mention in the Slack post. */
	slackChannelId: string | null;
	newJoins: number;
	existing: number;
	/** Raw growth percentage shown in the post: newJoins / existing * 100.
	 * Ranking uses a separate power-law score (see rankingAlpha) — sort order
	 * does not match pct order. 0 when existing is 0 (chapter is brand new). */
	pct: number;
}

export interface WeeklyGrowthResult {
	windowStart: string;
	windowEnd: string;
	chaptersWithGrowth: number;
	totalNewJoins: number;
	topChapters: ChapterGrowth[];
	posted: boolean;
	/** False when this window was already computed and the stored snapshot was
	 *  returned untouched. See the write-once note on runWeeklyGrowthReport. */
	persisted: boolean;
}

/**
 * Collapse the many-to-many chapter↔channel entry list to one channel per
 * chapter for the report's clickable channel mention. First entry wins so the
 * linked channel is stable regardless of how many channels a chapter maps to.
 */
export function firstChannelByChapter(
	entries: ReadonlyArray<{ chapterId: number; channelId: string }>,
): Map<number, string> {
	const map = new Map<number, string>();
	for (const e of entries) {
		if (!map.has(e.chapterId)) map.set(e.chapterId, e.channelId);
	}
	return map;
}

// Pin the window to UTC midnight at the start of the most recent Monday. This
// keeps the dashboard leaderboard stable Mon-to-Mon (matching what the cron
// posts) instead of sliding by a day every UTC midnight. The cron itself fires
// Monday 14:00 UTC, where "most recent Monday" is just-past midnight — so the
// cron's reported window is unchanged.
export function computeWindow(now: Date): { start: Date; end: Date } {
	const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const daysBackToMonday = day === 0 ? 6 : day - 1;
	const todayMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const endMs = todayMidnightMs - daysBackToMonday * 24 * 60 * 60 * 1000;
	const end = new Date(endMs);
	const start = new Date(endMs - WINDOW_DAYS * 24 * 60 * 60 * 1000);
	return { start, end };
}

function roundPct(p: number): number {
	return Math.round(p * 10) / 10;
}

function fmtDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

// Render a chapter as a clickable Slack channel mention when we have its
// channel ID; otherwise bold the chapter name as plain text. `<#C…>` is auto-
// rendered by Slack with the current channel name and stays correct on rename.
function chapterMention(c: ChapterGrowth): string {
	return c.slackChannelId ? `<#${c.slackChannelId}>` : `*${c.chapterName}*`;
}

function buildBlocks(top: ChapterGrowth[], windowStart: Date, windowEnd: Date): KnownBlock[] {
	const winner = top[0]!;
	const winnerSummary =
		winner.existing > 0
			? `Grew their Slack chapter by *${roundPct(winner.pct)}%* with *${winner.newJoins} new* member${winner.newJoins === 1 ? '' : 's'} this week.`
			: `Welcomed *${winner.newJoins}* new Slack member${winner.newJoins === 1 ? '' : 's'} — and they're brand new on Slack!`;

	const blocks: KnownBlock[] = [
		{ type: 'header', text: { type: 'plain_text', text: '📈 Weekly Growth Report', emoji: true } },
		{
			type: 'context',
			elements: [
				{ type: 'mrkdwn', text: `Slack signups, ${fmtDate(windowStart)} → ${fmtDate(windowEnd)}` },
			],
		},
		{ type: 'divider' },
		{
			type: 'header',
			text: { type: 'plain_text', text: '🏆  Chapter of the Week  🏆', emoji: true },
		},
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `${chapterMention(winner)}\n\n${winnerSummary}\n\nA huge shoutout to the ${chapterMention(winner)} organisers — keep up the incredible momentum! :raised_hands: :rocket:`,
			},
		},
	];

	if (top.length > 1) {
		const lines = top.slice(1).map((r, i) => {
			const place = i + 2;
			const detail =
				r.existing > 0
					? `+${r.newJoins} (${roundPct(r.pct)}% growth)`
					: `+${r.newJoins} (brand new on Slack)`;
			return `*${place}.* ${chapterMention(r)} — ${detail}`;
		});
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: `*Runners up*\n${lines.join('\n')}` },
		});
	}

	return blocks;
}

export interface WeeklyLeaderboard {
	windowStart: string;
	windowEnd: string;
	/** All chapters with newJoins > 0 in the window (post-exclusion), pre-slice. */
	chaptersWithGrowth: number;
	/** Distinct users who joined Slack in the window (excluded chapters still count). */
	totalNewJoins: number;
	/** Top TOP_N entries by ranking score, descending. */
	topChapters: ChapterGrowth[];
}

/** A leaderboard load that either succeeded or failed with a user-facing message. */
export type LeaderboardResult =
	{ ok: true; leaderboard: WeeklyLeaderboard } | { ok: false; error: string };

/** The two leaderboard views the dashboard renders behind a tab toggle:
 * `saved` is the last cron snapshot, `live` is the in-progress week. */
export interface LeaderboardPair {
	saved: LeaderboardResult;
	live: LeaderboardResult;
}

/**
 * Reads the most recent snapshot written by the Monday cron and reconstructs
 * the leaderboard from it. Returns an empty leaderboard if no snapshot exists
 * yet (e.g., cron has never run). Deliberately does NOT recompute from live
 * data: the whole point of the snapshot is to preserve the chapter-size
 * (`existing`) figures captured at window-end, so the dashboard doesn't drift
 * as live num_members grows.
 *
 * `rankingAlpha` and `chapterChannelIds` are accepted so the caller can re-sort
 * with a different α than the cron used, and refresh the channel mention map
 * if the chapter↔channel settings map changed since the snapshot was written.
 */
export async function computeWeeklyLeaderboard(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: {
		excludedChapterIds?: ReadonlySet<number>;
		chapterChannelIds?: ReadonlyMap<number, string>;
		rankingAlpha?: number;
		/** How many chapters to return in topChapters. Defaults to TOP_N; the
		 * /settings alpha-slider preview passes Infinity so it can re-rank the
		 * full list client-side. */
		topN?: number;
	} = {},
): Promise<WeeklyLeaderboard> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds;
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;

	const latestWindow = await db
		.select()
		.from(weeklyGrowthWindows)
		.orderBy(desc(weeklyGrowthWindows.windowEnd))
		.limit(1);

	if (latestWindow.length === 0) {
		const now = new Date();
		const { start, end } = computeWindow(now);
		return {
			windowStart: start.toISOString(),
			windowEnd: end.toISOString(),
			chaptersWithGrowth: 0,
			totalNewJoins: 0,
			topChapters: [],
		};
	}

	const win = latestWindow[0]!;
	const rows = await db
		.select()
		.from(weeklyChapterGrowth)
		.where(eq(weeklyChapterGrowth.windowEnd, win.windowEnd));

	const leaderboard: ChapterGrowth[] = rows
		.filter((r) => !excluded.has(r.chapterId))
		.map((r) => ({
			chapterId: r.chapterId,
			chapterName: r.chapterName,
			// Prefer the live channel map if provided (handles renames / new
			// mappings since the snapshot was written), otherwise fall back to
			// the channel id captured at compute time.
			slackChannelId: chapterChannelIds?.get(r.chapterId) ?? r.slackChannelId,
			newJoins: r.newJoins,
			existing: r.existing,
			pct: r.existing > 0 ? (r.newJoins / r.existing) * 100 : 0,
		}));

	sortByRanking(leaderboard, rankingAlpha);

	return {
		windowStart: win.windowStart,
		windowEnd: win.windowEnd,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins: win.totalNewJoins,
		topChapters: leaderboard.slice(0, options.topN ?? TOP_N),
	};
}

// In-memory cache of Slack channel member counts, shared across dashboard
// loads in the (single) adapter-node process. The live leaderboard is read
// far more often than channel sizes meaningfully change, so a short TTL keeps
// the dashboard from fanning out a `conversations.info` call per chapter on
// every page load. Only successful lookups are cached — failures fall through
// so the next load retries. The cron deliberately does NOT use this; it wants
// fresh ground truth.
/** Distinct count of users who joined the workspace in [start, end). Each
 *  slack_joins row is one user, so multi-chapter users aren't double-counted,
 *  and excluded chapters don't drop anyone — this answers "how many joined
 *  Slack this window?" overall. Shared by the cron report and the live tab,
 *  which must agree on the headline number. */
async function countNewJoins(
	db: LibSQLDatabase<Record<string, unknown>>,
	windowStartIso: string,
	windowEndIso: string,
): Promise<number> {
	const rows = await db
		.select({ cnt: count() })
		.from(slackJoins)
		.where(and(gte(slackJoins.joinedAt, windowStartIso), lt(slackJoins.joinedAt, windowEndIso)));
	return Number(rows[0]?.cnt ?? 0);
}

const CHANNEL_COUNT_TTL_MS = 5 * 60 * 1000;
const channelCountCache = new Map<string, { numMembers: number; fetchedAt: number }>();

/** Clears the channel-count cache. Exported for tests only. */
export function clearChannelCountCache(): void {
	channelCountCache.clear();
}

/**
 * Current Slack `num_members` for a channel, memoised for CHANNEL_COUNT_TTL_MS.
 * Returns null when the channel reports no `num_members` or the lookup fails
 * (the caller then falls back to the snapshot / slack_joins counts).
 */
async function getChannelMemberCount(slack: WebClient, channelId: string): Promise<number | null> {
	const now = Date.now();
	const cached = channelCountCache.get(channelId);
	if (cached && now - cached.fetchedAt < CHANNEL_COUNT_TTL_MS) {
		return cached.numMembers;
	}
	try {
		const info = await slack.conversations.info({
			channel: channelId,
			include_num_members: true,
		});
		const num = info.channel?.num_members;
		if (typeof num === 'number') {
			channelCountCache.set(channelId, { numMembers: num, fetchedAt: now });
			return num;
		}
		return null;
	} catch (err) {
		console.warn(
			`[leaderboard] conversations.info failed for channel ${channelId}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Live leaderboard for the in-progress week — the data the next cron run
 * will eventually snapshot. The window runs from the latest snapshot's
 * `windowEnd` (or, if no snapshot exists yet, the most recent UTC Monday
 * midnight via `computeWindow`) up to `now`.
 *
 * `newJoins` come from `slack_joins`. For the `existing` baseline, when a
 * `slack` client is supplied the chapter's *current* Slack channel size is
 * fetched (`conversations.info`) and this window's new joins subtracted —
 * matching how the cron computes it. Each fetch is best-effort: on a missing
 * channel mapping or API error it falls back to the snapshot's captured
 * `numMembers`, then to a `slack_joins`-derived pre-window count.
 */
export async function computeLiveLeaderboardSinceSnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: {
		now?: Date;
		excludedChapterIds?: ReadonlySet<number>;
		chapterChannelIds?: ReadonlyMap<number, string>;
		rankingAlpha?: number;
		/** When provided, the live leaderboard fetches each chapter's current
		 * Slack channel `num_members` instead of relying on the snapshot. */
		slack?: WebClient;
		/** How many chapters to return in topChapters. Defaults to TOP_N; the
		 * /settings alpha-slider preview passes Infinity so it can re-rank the
		 * full list client-side. */
		topN?: number;
	} = {},
): Promise<WeeklyLeaderboard> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds;
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;
	const now = options.now ?? new Date();
	const slack = options.slack;

	const latestWindow = await db
		.select()
		.from(weeklyGrowthWindows)
		.orderBy(desc(weeklyGrowthWindows.windowEnd))
		.limit(1);

	// Anchor the window at the most recent snapshot's `windowEnd` when one
	// exists, otherwise fall back to the most recent UTC Monday midnight so
	// the live tab still shows something useful (and meaningfully distinct
	// from the saved tab's empty-state Mon-to-Mon range) before the first
	// cron has run.
	const win = latestWindow[0];
	const windowStartIso = win ? win.windowEnd : computeWindow(now).end.toISOString();
	const windowEndIso = now.toISOString();

	const snapshotRows = win
		? await db
				.select()
				.from(weeklyChapterGrowth)
				.where(eq(weeklyChapterGrowth.windowEnd, win.windowEnd))
		: [];

	const snapshotByChapter = new Map<
		number,
		{ chapterName: string; slackChannelId: string | null; numMembers: number | null }
	>();
	for (const r of snapshotRows) {
		snapshotByChapter.set(r.chapterId, {
			chapterName: r.chapterName,
			slackChannelId: r.slackChannelId,
			numMembers: r.numMembers,
		});
	}

	// Same json_each aggregation the cron uses (runWeeklyGrowthReport), but
	// for the new [snapshotEnd, now) window. `existing` here is the slack_joins-
	// derived count of pre-window members and is used as a fallback when the
	// snapshot didn't capture a numMembers for this chapter.
	const aggRows = (await db.all(sql`
		SELECT
			CAST(je.value AS INTEGER) AS chapter_id,
			SUM(CASE WHEN joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso} THEN 1 ELSE 0 END) AS new_joins,
			SUM(CASE WHEN joined_at IS NULL OR joined_at < ${windowStartIso}              THEN 1 ELSE 0 END) AS existing
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		GROUP BY chapter_id
	`)) as Array<{ chapter_id: number; new_joins: number; existing: number }>;

	const names = await loadChapterNames(db);

	const candidates = aggRows
		.map((row) => ({
			chapterId: Number(row.chapter_id),
			newJoins: Number(row.new_joins),
			sqlExisting: Number(row.existing),
		}))
		.filter((c) => c.newJoins > 0 && !excluded.has(c.chapterId));

	const leaderboard: ChapterGrowth[] = await Promise.all(
		candidates.map(async (c) => {
			const snap = snapshotByChapter.get(c.chapterId);
			const chapterName = snap?.chapterName ?? names.get(c.chapterId) ?? `Chapter #${c.chapterId}`;
			const slackChannelId = chapterChannelIds?.get(c.chapterId) ?? snap?.slackChannelId ?? null;

			// Baseline chapter size. Prefer the *current* Slack channel count
			// (minus this window's new joins, since num_members already includes
			// them); fall back to the snapshot's captured count, then the
			// slack_joins-derived pre-window count. The lookup is cached and
			// best-effort, so one bad channel can't break the dashboard.
			let existing = snap?.numMembers ?? c.sqlExisting;
			if (slack && slackChannelId) {
				const num = await getChannelMemberCount(slack, slackChannelId);
				if (num !== null) {
					existing = Math.max(0, num - c.newJoins);
				}
			}

			const pct = existing > 0 ? (c.newJoins / existing) * 100 : 0;
			return {
				chapterId: c.chapterId,
				chapterName,
				slackChannelId,
				newJoins: c.newJoins,
				existing,
				pct,
			};
		}),
	);

	sortByRanking(leaderboard, rankingAlpha);

	const totalNewJoins = await countNewJoins(db, windowStartIso, windowEndIso);

	return {
		windowStart: windowStartIso,
		windowEnd: windowEndIso,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins,
		topChapters: leaderboard.slice(0, options.topN ?? TOP_N),
	};
}

/**
 * Write the per-chapter leaderboard to the snapshot tables. Idempotent: a
 * re-run for the same window (manual cron retry, dry-run flip) replaces the
 * previous rows.
 */
async function persistSnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	windowStartIso: string,
	windowEndIso: string,
	totalNewJoins: number,
	rows: Array<ChapterGrowth & { numMembers: number | null }>,
): Promise<void> {
	const computedAt = new Date().toISOString();

	// One batch, which libsql applies as a single transaction.
	//
	// The delete and the inserts are a replacement, not two independent edits,
	// and what they replace cannot be recomputed: `numMembers` is the channel
	// size Slack reported at window-end, and asking again next week returns a
	// different number (which is the whole reason the snapshot exists). Run as
	// separate statements, a machine stopped between them — Fly autostops
	// idle ones — leaves the window row claiming a leaderboard whose chapter
	// rows are missing or half-written, and nothing can rebuild it.
	const statements = [
		db
			.insert(weeklyGrowthWindows)
			.values({
				windowEnd: windowEndIso,
				windowStart: windowStartIso,
				totalNewJoins,
				computedAt,
			})
			.onConflictDoUpdate({
				target: weeklyGrowthWindows.windowEnd,
				set: { windowStart: windowStartIso, totalNewJoins, computedAt },
			}),
		// Wipe any prior rows for this window before re-inserting — keeps the
		// table clean if a chapter dropped out of the leaderboard on a re-run.
		db.delete(weeklyChapterGrowth).where(eq(weeklyChapterGrowth.windowEnd, windowEndIso)),
		...rows.map((row) =>
			db.insert(weeklyChapterGrowth).values({
				windowEnd: windowEndIso,
				chapterId: row.chapterId,
				chapterName: row.chapterName,
				slackChannelId: row.slackChannelId,
				newJoins: row.newJoins,
				existing: row.existing,
				numMembers: row.numMembers,
			}),
		),
	];
	await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
}

/**
 * The stored snapshot for one window, or null when it has not been computed.
 *
 * Because persistSnapshot writes atomically, the window row existing means the
 * chapter rows exist too — so this can be trusted as "that week is done".
 */
async function readSnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	windowEndIso: string,
	rankingAlpha: number,
): Promise<{ totalNewJoins: number; leaderboard: ChapterGrowth[] } | null> {
	const [win] = await db
		.select()
		.from(weeklyGrowthWindows)
		.where(eq(weeklyGrowthWindows.windowEnd, windowEndIso))
		.limit(1);
	if (!win) return null;

	const rows = await db
		.select()
		.from(weeklyChapterGrowth)
		.where(eq(weeklyChapterGrowth.windowEnd, windowEndIso));

	const leaderboard: ChapterGrowth[] = rows.map((r) => ({
		chapterId: r.chapterId,
		chapterName: r.chapterName,
		slackChannelId: r.slackChannelId,
		newJoins: r.newJoins,
		existing: r.existing,
		pct: r.existing > 0 ? (r.newJoins / r.existing) * 100 : 0,
	}));
	sortByRanking(leaderboard, rankingAlpha);
	return { totalNewJoins: win.totalNewJoins, leaderboard };
}

export async function runWeeklyGrowthReport(
	db: LibSQLDatabase<Record<string, unknown>>,
	slack: WebClient,
	channelId: string,
	options: {
		now?: Date;
		dryRun?: boolean;
		excludedChapterIds?: ReadonlySet<number>;
		/** chapterId → Slack channel ID. When mapped, that channel's num_members
		 * is used as ground truth for chapter size; otherwise we fall back to
		 * the slack_joins-derived count. */
		chapterChannelIds?: ReadonlyMap<number, string>;
		/** Power-law exponent for the ranking score. Defaults to
		 * DEFAULT_RANKING_ALPHA. */
		rankingAlpha?: number;
		/** Recompute and overwrite a window that already has a snapshot. */
		force?: boolean;
	} = {},
): Promise<WeeklyGrowthResult> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds ?? new Map<number, string>();
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;
	const now = options.now ?? new Date();
	const { start: windowStart, end: windowEnd } = computeWindow(now);
	const windowStartIso = windowStart.toISOString();
	const windowEndIso = windowEnd.toISOString();

	// A window is computed once, and a re-run inside the same week returns what
	// was stored rather than recomputing it.
	//
	// `computeWindow` pins windowEnd to the most recent Monday, so every run for
	// the rest of the week addresses the same row — but `existing` comes from a
	// LIVE conversations.info against a fixed newJoins, so it grows each day.
	// Recomputing on Thursday lowers every pct, reorders the ranking, and leaves
	// the dashboard disagreeing with the message the channel was sent on Monday.
	// A Slack lookup that failed on the re-run would swap in a different basis
	// again (`sqlExisting`, `numMembers: null`) and overwrite with that.
	//
	// Checked before the conversations.info fan-out below, so a no-op re-run
	// costs one read rather than a call per chapter.
	if (!options.dryRun && !options.force) {
		const stored = await readSnapshot(db, windowEndIso, rankingAlpha);
		if (stored) {
			console.log(`[growth] ${windowEndIso} already computed — returning the stored snapshot`);
			return {
				windowStart: windowStartIso,
				windowEnd: windowEndIso,
				chaptersWithGrowth: stored.leaderboard.length,
				totalNewJoins: stored.totalNewJoins,
				topChapters: stored.leaderboard.slice(0, TOP_N),
				posted: false,
				persisted: false,
			};
		}
	}

	// Aggregate per-chapter counts in SQL via json_each so we never round-trip
	// every slack_joins row across the wire. Rows with chapter_ids = '[]' produce
	// no json_each rows and are naturally excluded. NULL joined_at counts as
	// "existing" — those are backfilled rows from before the live join handler
	// existed, where Slack's API doesn't expose the original join date.
	const aggRows = (await db.all(sql`
		SELECT
			CAST(je.value AS INTEGER) AS chapter_id,
			SUM(CASE WHEN joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso} THEN 1 ELSE 0 END) AS new_joins,
			SUM(CASE WHEN joined_at IS NULL OR joined_at < ${windowStartIso}              THEN 1 ELSE 0 END) AS existing
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		GROUP BY chapter_id
	`)) as Array<{ chapter_id: number; new_joins: number; existing: number }>;

	const names = await loadChapterNames(db);

	// Build candidate list, then fetch ground-truth chapter size from Slack
	// (channel num_members) where a channel mapping is configured. Slack reports
	// the *current* channel size, which already includes this week's new joins,
	// so subtract newJoins to recover the start-of-window size.
	const candidates = aggRows
		.map((row) => ({
			chapterId: Number(row.chapter_id),
			newJoins: Number(row.new_joins),
			sqlExisting: Number(row.existing),
		}))
		.filter((c) => c.newJoins > 0 && !excluded.has(c.chapterId));

	const enriched = await Promise.all(
		candidates.map(async (c) => {
			const slackChannelId = chapterChannelIds.get(c.chapterId) ?? null;
			if (!slackChannelId) {
				console.warn(
					`[growth] no channel mapping for chapter ${c.chapterId} — using slack_joins count (${c.sqlExisting})`,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName: null as string | null,
				};
			}
			try {
				const info = await slack.conversations.info({
					channel: slackChannelId,
					include_num_members: true,
				});
				const num = info.channel?.num_members;
				const slackChannelName = info.channel?.name ?? null;
				if (typeof num === 'number') {
					return {
						...c,
						existing: Math.max(0, num - c.newJoins),
						numMembers: num,
						slackChannelId,
						slackChannelName,
					};
				}
				console.warn(
					`[growth] conversations.info returned no num_members for chapter ${c.chapterId} (channel ${slackChannelId})`,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName,
				};
			} catch (err) {
				console.warn(
					`[growth] conversations.info failed for chapter ${c.chapterId} (channel ${slackChannelId}):`,
					err instanceof Error ? err.message : err,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName: null as string | null,
				};
			}
		}),
	);

	const leaderboard: Array<ChapterGrowth & { numMembers: number | null }> = enriched.map((c) => {
		const chapterName = c.slackChannelName
			? `#${c.slackChannelName}`
			: (names.get(c.chapterId) ?? `Chapter #${c.chapterId}`);
		const pct = c.existing > 0 ? (c.newJoins / c.existing) * 100 : 0;
		return {
			chapterId: c.chapterId,
			chapterName,
			slackChannelId: c.slackChannelId,
			newJoins: c.newJoins,
			existing: c.existing,
			numMembers: c.numMembers,
			pct,
		};
	});
	sortByRanking(leaderboard, rankingAlpha);

	const topChapters = leaderboard.slice(0, TOP_N);
	const totalNewJoins = await countNewJoins(db, windowStartIso, windowEndIso);

	if (!options.dryRun) {
		await persistSnapshot(db, windowStartIso, windowEndIso, totalNewJoins, leaderboard);
	}

	let posted = false;
	if (topChapters.length > 0 && !options.dryRun) {
		const blocks = buildBlocks(topChapters, windowStart, windowEnd);
		await slack.chat.postMessage({
			channel: channelId,
			text: `Weekly growth report — chapter of the week: ${topChapters[0]!.chapterName}`,
			blocks,
		});
		posted = true;
	}

	return {
		windowStart: windowStartIso,
		windowEnd: windowEndIso,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins,
		topChapters,
		posted,
		persisted: !options.dryRun,
	};
}
