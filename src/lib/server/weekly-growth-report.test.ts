import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { WebClient } from '@slack/web-api';
import {
	runWeeklyGrowthReport,
	computeWindow,
	computeWeeklyLeaderboard,
	computeLiveLeaderboardSinceSnapshot,
	clearChannelCountCache,
	firstChannelByChapter,
} from './weekly-growth-report.js';

describe('firstChannelByChapter', () => {
	it('keeps the first channel when a chapter maps to several', () => {
		const map = firstChannelByChapter([
			{ chapterId: 1, channelId: 'C_A' },
			{ chapterId: 1, channelId: 'C_B' },
			{ chapterId: 2, channelId: 'C_C' },
		]);
		expect(map.get(1)).toBe('C_A');
		expect(map.get(2)).toBe('C_C');
		expect(map.size).toBe(2);
	});
});

describe('computeWindow', () => {
	function expectWindow(input: string, expectedEnd: string, expectedStart: string) {
		const { start, end } = computeWindow(new Date(input));
		expect(end.toISOString()).toBe(expectedEnd);
		expect(start.toISOString()).toBe(expectedStart);
	}

	it('snaps to the same UTC Monday midnight regardless of which day-of-week now is', () => {
		// All of these dates land in the same Mon-to-Mon week:
		// 2026-05-04 (Mon) 00:00 UTC → 2026-05-11 (Mon) 00:00 UTC
		const expectedEnd = '2026-05-11T00:00:00.000Z';
		const expectedStart = '2026-05-04T00:00:00.000Z';

		// Cron firing Monday 14:00 UTC after the window closes
		expectWindow('2026-05-11T14:00:00Z', expectedEnd, expectedStart);
		// Mid-week dashboard view
		expectWindow('2026-05-13T10:00:00Z', expectedEnd, expectedStart);
		// Saturday afternoon
		expectWindow('2026-05-16T18:30:00Z', expectedEnd, expectedStart);
		// Sunday late evening — still maps to the Monday that *started* the week
		expectWindow('2026-05-17T23:59:00Z', expectedEnd, expectedStart);
	});

	it('rolls forward to the next Monday once the next Monday actually arrives', () => {
		// Monday 00:01 UTC of the *following* Monday is past the window's end,
		// so the window slides forward by exactly one week.
		expectWindow('2026-05-18T00:01:00Z', '2026-05-18T00:00:00.000Z', '2026-05-11T00:00:00.000Z');
	});
});

describe('computeWeeklyLeaderboard', () => {
	function makeDb(opts: {
		windows?: Array<{ windowEnd: string; windowStart: string; totalNewJoins: number }>;
		rows?: Array<{
			chapterId: number;
			chapterName: string;
			slackChannelId: string | null;
			newJoins: number;
			existing: number;
		}>;
	}) {
		const windows = opts.windows ?? [];
		const rows = opts.rows ?? [];
		// The function issues two `select()` chains: first for windows
		// (orderBy().limit()) returning windows, then for chapter rows
		// (where()) returning rows. Queue results in that order.
		const queue: unknown[][] = [windows, rows];
		const select = vi.fn(() => {
			const result = queue.shift() ?? [];
			const terminal = {
				then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
			};
			const limit = vi.fn(() => terminal);
			const orderBy = vi.fn(() => ({ limit, ...terminal }));
			const where = vi.fn(() => terminal);
			const from = vi.fn(() => ({ orderBy, where, limit, ...terminal }));
			return { from };
		});
		return { select } as unknown as Parameters<typeof computeWeeklyLeaderboard>[0];
	}

	it('reads the latest snapshot and reconstructs the leaderboard', async () => {
		const db = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 12,
				},
			],
			rows: [
				{ chapterId: 1, chapterName: '#sf', slackChannelId: 'C1', newJoins: 5, existing: 50 },
				{ chapterId: 2, chapterName: '#la', slackChannelId: null, newJoins: 2, existing: 200 },
			],
		});
		const result = await computeWeeklyLeaderboard(db);
		expect(result.windowEnd).toBe('2026-05-11T00:00:00.000Z');
		expect(result.windowStart).toBe('2026-05-04T00:00:00.000Z');
		expect(result.totalNewJoins).toBe(12);
		expect(result.chaptersWithGrowth).toBe(2);
		// chapter 1 has higher score: 5 / (50+1)^0.7 vs 2 / (200+1)^0.7
		expect(result.topChapters[0]?.chapterId).toBe(1);
		expect(result.topChapters[0]?.pct).toBeCloseTo(10, 5);
		expect(result.topChapters[1]?.chapterId).toBe(2);
	});

	it('filters excluded chapters', async () => {
		const db = makeDb({
			windows: [{ windowEnd: 'w', windowStart: 's', totalNewJoins: 7 }],
			rows: [
				{ chapterId: 1, chapterName: 'a', slackChannelId: null, newJoins: 5, existing: 50 },
				{ chapterId: 99, chapterName: 'excluded', slackChannelId: null, newJoins: 2, existing: 10 },
			],
		});
		const result = await computeWeeklyLeaderboard(db, {
			excludedChapterIds: new Set([99]),
		});
		expect(result.chaptersWithGrowth).toBe(1);
		expect(result.topChapters.map((c) => c.chapterId)).toEqual([1]);
	});

	it('prefers a fresh chapter channel mapping over the snapshotted one', async () => {
		const db = makeDb({
			windows: [{ windowEnd: 'w', windowStart: 's', totalNewJoins: 0 }],
			rows: [{ chapterId: 1, chapterName: 'a', slackChannelId: 'C_OLD', newJoins: 1, existing: 5 }],
		});
		const result = await computeWeeklyLeaderboard(db, {
			chapterChannelIds: new Map([[1, 'C_NEW']]),
		});
		expect(result.topChapters[0]?.slackChannelId).toBe('C_NEW');
	});

	it('returns an empty leaderboard when no snapshot exists', async () => {
		const db = makeDb({ windows: [], rows: [] });
		const result = await computeWeeklyLeaderboard(db);
		expect(result.chaptersWithGrowth).toBe(0);
		expect(result.totalNewJoins).toBe(0);
		expect(result.topChapters).toEqual([]);
	});
});

describe('computeLiveLeaderboardSinceSnapshot', () => {
	type WindowRow = { windowEnd: string; windowStart: string; totalNewJoins: number };
	type SnapshotRow = {
		chapterId: number;
		chapterName: string;
		slackChannelId: string | null;
		newJoins: number;
		existing: number;
		numMembers: number | null;
	};
	type NameRow = { chapterId: number; chapterName: string };
	type AggRow = { chapter_id: number; new_joins: number; existing: number };
	type CountRow = { cnt: number };

	function makeDb(opts: {
		windows?: WindowRow[];
		snapshotRows?: SnapshotRow[];
		nameRows?: NameRow[];
		aggRows?: AggRow[];
		totalNewJoins?: number;
	}) {
		// `select()` is issued in this order: windows → snapshot rows (only
		// when a window row exists) → chapter names (via loadChapterNames) →
		// the new-joins count. Skip the snapshot-rows entry when there's no
		// window so the queue stays aligned with the actual call sequence.
		const countRows = [{ cnt: opts.totalNewJoins ?? 0 }] satisfies CountRow[];
		const selectQueue: unknown[][] =
			(opts.windows?.length ?? 0) > 0
				? [opts.windows ?? [], opts.snapshotRows ?? [], opts.nameRows ?? [], countRows]
				: [opts.windows ?? [], opts.nameRows ?? [], countRows];
		// `db.all()` is only the json_each aggregation now — the count moved to
		// the query builder.
		const allQueue: unknown[][] = [opts.aggRows ?? []];
		const select = vi.fn(() => {
			const result = selectQueue.shift() ?? [];
			const terminal = {
				then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
			};
			const limit = vi.fn(() => terminal);
			const orderBy = vi.fn(() => ({ limit, ...terminal }));
			const where = vi.fn(() => terminal);
			const from = vi.fn(() => ({ orderBy, where, limit, ...terminal }));
			return { from };
		});
		const all = vi.fn(() => Promise.resolve(allQueue.shift() ?? []));
		return {
			db: { select, all } as unknown as Parameters<typeof computeLiveLeaderboardSinceSnapshot>[0],
			allMock: all,
		};
	}

	// Minimal WebClient stand-in: only conversations.info is exercised.
	function makeSlack(opts: {
		numMembers?: Record<string, number>;
		throwFor?: ReadonlySet<string>;
	}): { slack: WebClient; infoMock: ReturnType<typeof vi.fn> } {
		const infoMock = vi.fn(async ({ channel }: { channel: string }) => {
			if (opts.throwFor?.has(channel)) throw new Error('slack unavailable');
			return { channel: { num_members: opts.numMembers?.[channel] } };
		});
		return {
			slack: { conversations: { info: infoMock } } as unknown as WebClient,
			infoMock,
		};
	}

	// The channel-count cache is module-level; reset it so tests don't leak
	// cached counts into one another.
	beforeEach(clearChannelCountCache);

	it('falls back to Monday-to-now when no snapshot exists', async () => {
		// 2026-05-13 is a Wednesday → most recent UTC Monday midnight is 2026-05-11.
		const now = new Date('2026-05-13T10:00:00Z');
		const { db } = makeDb({
			windows: [],
			nameRows: [{ chapterId: 4, chapterName: 'austin' }],
			aggRows: [{ chapter_id: 4, new_joins: 2, existing: 10 }],
			totalNewJoins: 2,
		});
		const result = await computeLiveLeaderboardSinceSnapshot(db, { now });
		// Window must differ from the saved tab's empty fallback (which is
		// Mon→Mon) — start at this Monday, end now.
		expect(result.windowStart).toBe('2026-05-11T00:00:00.000Z');
		expect(result.windowEnd).toBe(now.toISOString());
		expect(result.chaptersWithGrowth).toBe(1);
		expect(result.totalNewJoins).toBe(2);
		expect(result.topChapters[0]?.chapterId).toBe(4);
		// No snapshot → existing is derived from slack_joins, not numMembers.
		expect(result.topChapters[0]?.existing).toBe(10);
	});

	it('uses the snapshot windowEnd as start and now as end', async () => {
		const { db } = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 12,
				},
			],
			snapshotRows: [
				{
					chapterId: 1,
					chapterName: '#sf',
					slackChannelId: 'C1',
					newJoins: 5,
					existing: 50,
					numMembers: 55,
				},
			],
			aggRows: [{ chapter_id: 1, new_joins: 3, existing: 99 }],
			totalNewJoins: 3,
		});
		const now = new Date('2026-05-13T10:00:00Z');
		const result = await computeLiveLeaderboardSinceSnapshot(db, { now });
		expect(result.windowStart).toBe('2026-05-11T00:00:00.000Z');
		expect(result.windowEnd).toBe(now.toISOString());
		expect(result.totalNewJoins).toBe(3);
		expect(result.chaptersWithGrowth).toBe(1);
		// numMembers (55) wins over the slack_joins-derived existing (99).
		expect(result.topChapters[0]?.existing).toBe(55);
		expect(result.topChapters[0]?.newJoins).toBe(3);
		expect(result.topChapters[0]?.pct).toBeCloseTo((3 / 55) * 100, 5);
	});

	it('falls back to slack_joins-derived existing for chapters absent from the snapshot', async () => {
		const { db } = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 0,
				},
			],
			snapshotRows: [], // no per-chapter snapshot rows
			nameRows: [{ chapterId: 7, chapterName: 'phoenix' }],
			aggRows: [{ chapter_id: 7, new_joins: 4, existing: 20 }],
			totalNewJoins: 4,
		});
		const result = await computeLiveLeaderboardSinceSnapshot(db, {
			now: new Date('2026-05-13T10:00:00Z'),
		});
		expect(result.chaptersWithGrowth).toBe(1);
		expect(result.topChapters[0]?.chapterId).toBe(7);
		expect(result.topChapters[0]?.chapterName).toBe('phoenix');
		expect(result.topChapters[0]?.existing).toBe(20);
		expect(result.topChapters[0]?.slackChannelId).toBeNull();
	});

	it('excludes chapters in the excludedChapterIds set', async () => {
		const { db } = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 0,
				},
			],
			aggRows: [
				{ chapter_id: 1, new_joins: 5, existing: 50 },
				{ chapter_id: 99, new_joins: 2, existing: 10 },
			],
			totalNewJoins: 7,
		});
		const result = await computeLiveLeaderboardSinceSnapshot(db, {
			now: new Date('2026-05-13T10:00:00Z'),
			excludedChapterIds: new Set([99]),
		});
		expect(result.chaptersWithGrowth).toBe(1);
		expect(result.topChapters.map((c) => c.chapterId)).toEqual([1]);
		// totalNewJoins is the workspace-wide count; excluded chapters still count.
		expect(result.totalNewJoins).toBe(7);
	});

	it('uses the current Slack channel count for the existing baseline', async () => {
		const { db } = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 12,
				},
			],
			snapshotRows: [
				{
					chapterId: 1,
					chapterName: '#sf',
					slackChannelId: 'C1',
					newJoins: 5,
					existing: 50,
					numMembers: 55,
				},
			],
			aggRows: [{ chapter_id: 1, new_joins: 3, existing: 99 }],
			totalNewJoins: 3,
		});
		const { slack } = makeSlack({ numMembers: { C1: 60 } });
		const result = await computeLiveLeaderboardSinceSnapshot(db, {
			now: new Date('2026-05-13T10:00:00Z'),
			chapterChannelIds: new Map([[1, 'C1']]),
			slack,
		});
		// Current channel size (60) minus this window's new joins (3) → 57.
		// Beats the snapshot's numMembers (55) and the slack_joins count (99).
		expect(result.topChapters[0]?.existing).toBe(57);
		expect(result.topChapters[0]?.pct).toBeCloseTo((3 / 57) * 100, 5);
	});

	it('falls back to the snapshot count when the Slack lookup fails', async () => {
		const { db } = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 12,
				},
			],
			snapshotRows: [
				{
					chapterId: 1,
					chapterName: '#sf',
					slackChannelId: 'C1',
					newJoins: 5,
					existing: 50,
					numMembers: 55,
				},
			],
			aggRows: [{ chapter_id: 1, new_joins: 3, existing: 99 }],
			totalNewJoins: 3,
		});
		const { slack } = makeSlack({ throwFor: new Set(['C1']) });
		const result = await computeLiveLeaderboardSinceSnapshot(db, {
			now: new Date('2026-05-13T10:00:00Z'),
			chapterChannelIds: new Map([[1, 'C1']]),
			slack,
		});
		// Slack lookup threw → fall back to the snapshot's captured numMembers (55).
		expect(result.topChapters[0]?.existing).toBe(55);
	});

	it('caches channel counts across loads within the TTL', async () => {
		const snapshotRows = [
			{
				chapterId: 1,
				chapterName: '#sf',
				slackChannelId: 'C1',
				newJoins: 5,
				existing: 50,
				numMembers: 55,
			},
		];
		const windows = [
			{
				windowEnd: '2026-05-11T00:00:00.000Z',
				windowStart: '2026-05-04T00:00:00.000Z',
				totalNewJoins: 12,
			},
		];
		const aggRows = [{ chapter_id: 1, new_joins: 3, existing: 99 }];
		// A fresh db mock per call — its queues are consumed once each.
		const dbFor = () => makeDb({ windows, snapshotRows, aggRows, totalNewJoins: 3 }).db;
		const { slack, infoMock } = makeSlack({ numMembers: { C1: 60 } });
		const opts = {
			now: new Date('2026-05-13T10:00:00Z'),
			chapterChannelIds: new Map([[1, 'C1']]),
			slack,
		};

		const first = await computeLiveLeaderboardSinceSnapshot(dbFor(), opts);
		const second = await computeLiveLeaderboardSinceSnapshot(dbFor(), opts);

		expect(first.topChapters[0]?.existing).toBe(57);
		expect(second.topChapters[0]?.existing).toBe(57);
		// Second load was served from cache — Slack was hit only once.
		expect(infoMock).toHaveBeenCalledTimes(1);
	});
});

// A real in-memory libsql rather than a chained fake: what these cover is the
// snapshot write — one batch, and written once per window — which is a
// collaboration with SQLite rather than something a fake can show.
describe('runWeeklyGrowthReport — the snapshot is written once per window', () => {
	let db: ReturnType<typeof drizzle>;
	let client: ReturnType<typeof createClient>;
	let postMessage: ReturnType<typeof vi.fn>;
	let numMembers: number;

	// A Thursday inside the Mon 2026-05-04 → Mon 2026-05-11 window.
	const MONDAY_RUN = new Date('2026-05-11T14:00:00Z');
	const WINDOW_END = '2026-05-11T00:00:00.000Z';

	function slackStub() {
		postMessage = vi.fn(async () => ({ ok: true }));
		return {
			conversations: {
				info: async () => ({ channel: { name: 'ann-arbor', num_members: numMembers } }),
			},
			chat: { postMessage },
		} as unknown as WebClient;
	}

	async function joined(slackUserId: string, joinedAt: string | null, chapterIds: number[]) {
		await client.execute({
			sql: `INSERT INTO slack_joins (slack_user_id, email, joined_at, chapter_ids) VALUES (?, ?, ?, ?)`,
			args: [slackUserId, `${slackUserId}@example.invalid`, joinedAt, JSON.stringify(chapterIds)],
		});
	}

	async function storedRows() {
		const res = await client.execute({
			sql: `SELECT chapter_id, new_joins, existing, num_members FROM weekly_chapter_growth
			      WHERE window_end = ? ORDER BY chapter_id`,
			args: [WINDOW_END],
		});
		return res.rows;
	}

	beforeEach(async () => {
		client = createClient({ url: ':memory:' });
		db = drizzle(client);
		await migrate(db, { migrationsFolder: 'drizzle' });
		numMembers = 40;
		// Three joins inside the window, one long before it.
		await joined('U1', '2026-05-05T10:00:00.000Z', [71]);
		await joined('U2', '2026-05-06T10:00:00.000Z', [71]);
		await joined('U3', '2026-05-07T10:00:00.000Z', [71]);
		await joined('U_OLD', '2026-01-01T10:00:00.000Z', [71]);
	});

	const run = (over: Record<string, unknown> = {}) =>
		runWeeklyGrowthReport(db, slackStub(), 'C_REPORT', {
			now: MONDAY_RUN,
			chapterChannelIds: new Map([[71, 'C_ANN_ARBOR']]),
			...over,
		});

	it('writes the window row and its chapter rows together', async () => {
		const result = await run();

		expect(result.persisted).toBe(true);
		expect(result.posted).toBe(true);
		const rows = await storedRows();
		expect(rows).toHaveLength(1);
		// 40 members now, 3 of them joined this week.
		expect(rows[0]).toMatchObject({ chapter_id: 71, new_joins: 3, existing: 37, num_members: 40 });
	});

	it('returns the stored snapshot on a re-run instead of recomputing it', async () => {
		await run();

		// Three days later the channel has grown, which is exactly what would
		// silently rewrite `existing` down and reorder the leaderboard.
		numMembers = 60;
		const second = await run({ now: new Date('2026-05-14T09:00:00Z') });

		expect(second.persisted).toBe(false);
		expect(second.posted).toBe(false);
		expect(second.topChapters[0]).toMatchObject({ newJoins: 3, existing: 37 });
		// The stored row is untouched, so the dashboard still agrees with the
		// message the channel was sent on Monday.
		expect((await storedRows())[0]).toMatchObject({ existing: 37, num_members: 40 });
		// And no second report lands in the channel.
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('recomputes the window when explicitly forced', async () => {
		await run();
		numMembers = 60;

		const forced = await run({ now: new Date('2026-05-14T09:00:00Z'), force: true });

		expect(forced.persisted).toBe(true);
		expect((await storedRows())[0]).toMatchObject({ existing: 57, num_members: 60 });
	});

	it('leaves no stale chapter row when a chapter drops out of a forced re-run', async () => {
		await joined('U4', '2026-05-05T10:00:00.000Z', [72]);
		await run();
		expect(await storedRows()).toHaveLength(2);

		// Chapter 72 is excluded this time, so its row must not survive the
		// delete-and-reinsert the batch performs.
		const forced = await run({ force: true, excludedChapterIds: new Set([72]) });

		expect(forced.persisted).toBe(true);
		const rows = await storedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.chapter_id).toBe(71);
	});

	it('does not write at all on a dry run', async () => {
		const result = await run({ dryRun: true });

		expect(result.persisted).toBe(false);
		expect(result.posted).toBe(false);
		expect(await storedRows()).toHaveLength(0);
	});
});
