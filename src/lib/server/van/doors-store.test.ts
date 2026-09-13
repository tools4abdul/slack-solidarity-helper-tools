import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	computeDoorsLeaderboardPair,
	loadClearedRows,
	loadCutoverAt,
	loadDoorsClearedSignups,
	loadDoorsDayTotals,
	loadDoorsTicker,
	doorsHealthWarning,
} from './doors-store.js';

// A real in-memory libsql: the join, the "completed only" filter and the
// campaign-day windows are the behaviour under test, and a chained fake would
// let the SQL and the pure predicates drift apart without failing.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

/** A Thursday. The campaign week it belongs to starts Monday 2026-09-07. */
const NOW = new Date('2026-09-10T18:00:00.000Z');

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

async function turf(over: { mapRouteId?: number; chapterId?: number; chapterName?: string } = {}) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name,
		         name, door_count, first_seen_at, last_seen_at)
		      VALUES (?, 1, 1, ?, ?, 'Region', 'Turf', 100, 'x', 'x')`,
		args: [over.mapRouteId ?? 100, over.chapterId ?? 71, over.chapterName ?? 'Washtenaw County'],
	});
}

async function checkout(over: {
	mapRouteId?: number;
	slackUserId?: string;
	slackUserName?: string;
	completedAt?: string | null;
	releasedAt?: string | null;
	doors?: number | null;
}) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         completed_at, released_at, confirmed_door_delta)
		      VALUES (?, ?, ?, '2026-09-01T12:00:00.000Z', '2026-09-30T12:00:00.000Z', ?, ?, ?)`,
		args: [
			over.mapRouteId ?? 100,
			over.slackUserId ?? 'U1',
			over.slackUserName ?? 'Dana',
			over.completedAt ?? null,
			over.releasedAt ?? null,
			over.doors ?? null,
		],
	});
}

describe('loadClearedRows', () => {
	it('reads completed checkouts with the turf they were on', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: 60 });

		const rows = await loadClearedRows(db);
		expect(rows).toEqual([
			{
				mapRouteId: 100,
				chapterId: 71,
				chapterName: 'Washtenaw County',
				slackUserId: 'U1',
				slackUserName: 'Dana',
				completedAt: '2026-09-09T18:00:00.000Z',
				doorsCleared: 60,
			},
		]);
	});

	it('ignores claims that were never completed', async () => {
		// A live claim is work in progress; a released one is work that did not
		// happen. Neither belongs in a canvassing total.
		await turf();
		await checkout({ completedAt: null });
		await checkout({ completedAt: null, releasedAt: '2026-09-09T18:00:00.000Z' });

		expect(await loadClearedRows(db)).toEqual([]);
	});

	it('keeps a completion VAN has not counted yet, as a null rather than a zero', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: null });

		const [row] = await loadClearedRows(db);
		expect(row.doorsCleared).toBeNull();
	});

	it('drops chapters the report excludes', async () => {
		await turf({ mapRouteId: 100, chapterId: 71 });
		await turf({ mapRouteId: 200, chapterId: 99, chapterName: 'Test Chapter' });
		await checkout({ mapRouteId: 100, completedAt: '2026-09-09T18:00:00.000Z', doors: 10 });
		await checkout({ mapRouteId: 200, completedAt: '2026-09-09T18:00:00.000Z', doors: 10 });

		const rows = await loadClearedRows(db, { excludedChapterIds: new Set([99]) });
		expect(rows.map((r) => r.chapterId)).toEqual([71]);
	});
});

describe('loadCutoverAt', () => {
	it('is the first completion this app ever recorded', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-09T18:00:00.000Z' });
		await checkout({ completedAt: '2026-08-30T18:00:00.000Z' });

		expect(await loadCutoverAt(db)).toBe('2026-08-30T18:00:00.000Z');
	});

	it('is null before anyone has completed anything', async () => {
		expect(await loadCutoverAt(db)).toBeNull();
	});
});

describe('computeDoorsLeaderboardPair', () => {
	it('splits completions into this week and last week on campaign Mondays', async () => {
		await turf();
		// Tuesday of this week.
		await checkout({ completedAt: '2026-09-08T18:00:00.000Z', doors: 40 });
		// Saturday of last week.
		await checkout({ completedAt: '2026-09-05T18:00:00.000Z', doors: 25 });

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });
		if (!pair.thisWeek.ok || !pair.lastWeek.ok) throw new Error('expected both boards');
		expect(pair.thisWeek.leaderboard.totalDoorsCleared).toBe(40);
		expect(pair.lastWeek.leaderboard.totalDoorsCleared).toBe(25);
	});

	it('files a late-evening canvass under the campaign day it belongs to', async () => {
		// 01:30Z Monday is 21:30 Sunday in Detroit — the last night of the
		// previous week, not the first hour of this one.
		await turf();
		await checkout({ completedAt: '2026-09-07T01:30:00.000Z', doors: 30 });

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });
		if (!pair.thisWeek.ok || !pair.lastWeek.ok) throw new Error('expected both boards');
		expect(pair.thisWeek.leaderboard.totalDoorsCleared).toBe(0);
		expect(pair.lastWeek.leaderboard.totalDoorsCleared).toBe(30);
	});

	it('marks the first VAN week and suppresses its comparison', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-08T18:00:00.000Z', doors: 40 });

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });
		if (!pair.thisWeek.ok) throw new Error('expected a board');
		expect(pair.thisWeek.leaderboard.firstVanWeek).toBe(true);
		expect(pair.thisWeek.leaderboard.topChapters[0].comparable).toBe(false);
	});
});

describe('loadDoorsTicker', () => {
	it('ranks the latest active day and names each canvasser once', async () => {
		await turf();
		await checkout({
			slackUserId: 'U1',
			slackUserName: 'Dana',
			completedAt: '2026-09-10T18:00:00.000Z',
			doors: 40,
		});
		await checkout({
			slackUserId: 'U2',
			slackUserName: 'Sam',
			completedAt: '2026-09-10T19:00:00.000Z',
			doors: 90,
		});
		// Yesterday — not the latest active day, so it is not shown.
		await checkout({
			slackUserId: 'U3',
			slackUserName: 'Alex',
			completedAt: '2026-09-09T18:00:00.000Z',
			doors: 500,
		});

		const ticker = await loadDoorsTicker(db, { now: NOW });
		expect(ticker.date).toBe('2026-09-10');
		expect(ticker.entries.map((e) => [e.canvasser, e.doors, e.rank])).toEqual([
			['Sam', 90, 1],
			['Dana', 40, 2],
		]);
	});

	it('carries turf counts for a canvasser whose doors are not counted yet', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-10T18:00:00.000Z', doors: null });

		const ticker = await loadDoorsTicker(db, { now: NOW });
		expect(ticker.entries[0]).toMatchObject({ doors: 0, turfs: 1 });
	});

	it('is empty with no completions at all', async () => {
		expect(await loadDoorsTicker(db, { now: NOW })).toEqual({ date: null, entries: [] });
	});
});

describe('loadDoorsClearedSignups and loadDoorsDayTotals', () => {
	it('shapes the chart series by campaign day and chapter', async () => {
		await turf({ mapRouteId: 100, chapterId: 71, chapterName: 'Washtenaw County' });
		await turf({ mapRouteId: 200, chapterId: 12, chapterName: 'Oakland County' });
		await checkout({ mapRouteId: 100, completedAt: '2026-09-09T18:00:00.000Z', doors: 60 });
		await checkout({ mapRouteId: 200, completedAt: '2026-09-09T19:00:00.000Z', doors: 15 });

		const series = await loadDoorsClearedSignups(db, { days: 30, now: NOW });
		expect(series).toEqual([
			{
				date: '2026-09-09',
				total: 75,
				byChapter: [
					{ chapterId: 12, chapterName: 'Oakland County', count: 15 },
					{ chapterId: 71, chapterName: 'Washtenaw County', count: 60 },
				],
			},
		]);
	});

	it('gives the projection one total per day', async () => {
		await turf();
		await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: 60 });
		await checkout({ completedAt: '2026-09-10T18:00:00.000Z', doors: 20 });

		expect(await loadDoorsDayTotals(db)).toEqual([
			{ date: '2026-09-09', total: 60 },
			{ date: '2026-09-10', total: 20 },
		]);
	});
});

describe('doorsHealthWarning', () => {
	it('warns when a week of completions cleared nothing', async () => {
		await turf();
		for (let i = 0; i < 5; i++) {
			await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: 0 });
		}

		const warning = await doorsHealthWarning(db, NOW);
		expect(warning).toContain('not yet contacted');
	});

	it('says nothing while doors are moving', async () => {
		await turf();
		for (let i = 0; i < 5; i++) {
			await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: 0 });
		}
		await checkout({ completedAt: '2026-09-09T18:00:00.000Z', doors: 30 });

		expect(await doorsHealthWarning(db, NOW)).toBeNull();
	});

	it('ignores zero-door completions from before the window', async () => {
		await turf();
		for (let i = 0; i < 5; i++) {
			await checkout({ completedAt: '2026-07-01T18:00:00.000Z', doors: 0 });
		}

		expect(await doorsHealthWarning(db, NOW)).toBeNull();
	});
});
