import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadCurrentHoldings, loadHoldingsFor, loadRecentCompletions } from './holdings-store.js';
import { currentHoldings, suspectCompletions } from '../../van/turf-holdings.js';

// A real in-memory libsql applying the REAL migrations, as in
// activity-store.test.ts. Two things only an engine can show: that "live claim"
// means the same thing here as the partial unique index means by it, and that
// the completions query orders and limits in SQL rather than in memory.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-02T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });

	// Several turfs, because the partial unique index allows only one ACTIVE
	// claim per route — a fixture with three live claims needs three turfs.
	for (const [id, folder, chapter, chapterName, name] of [
		[100, 1, 71, 'Washtenaw County', 'Turf 01'],
		[200, 1, 71, 'Washtenaw County', 'Turf 02'],
		[300, 2, 72, 'Wayne County', 'Turf 03'],
	] as const) {
		await client.execute(
			`INSERT INTO van_turfs (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, first_seen_at, last_seen_at)
			 VALUES (${id}, 1, ${folder}, ${chapter}, '${chapterName}', 'Ann Arbor', '${name}', 250, '${iso(NOW.getTime())}', '${iso(NOW.getTime())}')`,
		);
	}

	// Chapter 71 sees folder 1, chapter 72 sees folder 2 — visibility comes from
	// this mapping now, not from van_turfs.chapter_id (chapter-visibility.ts).
	await client.execute(
		`INSERT INTO van_chapter_folders (chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (71, 1, 'Washtenaw County', 'U_ADMIN', 'Alice', '2026-01-01T00:00:00.000Z'),
		        (72, 2, 'Wayne County', 'U_ADMIN', 'Alice', '2026-01-01T00:00:00.000Z')`,
	);
});

async function checkout(over: Record<string, string | number | null> = {}) {
	const row = {
		map_route_id: 100,
		slack_user_id: 'U_VOL',
		slack_user_name: 'Dana',
		claimed_at: iso(NOW.getTime() - 10 * HOUR),
		expires_at: iso(NOW.getTime() + 30 * HOUR),
		released_at: null,
		completed_at: null,
		release_reason: null,
		confirmed_door_delta: null,
		expiry_warned_at: null,
		...over,
	};
	const q = (v: string | number | null) => (v === null ? 'NULL' : `'${v}'`);
	await client.execute(
		`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, completed_at, release_reason, confirmed_door_delta, expiry_warned_at)
		 VALUES (${row.map_route_id}, '${row.slack_user_id}', '${row.slack_user_name}', '${row.claimed_at}', '${row.expires_at}',
		         ${q(row.released_at)}, ${q(row.completed_at)}, ${q(row.release_reason)}, ${q(row.confirmed_door_delta)}, ${q(row.expiry_warned_at)})`,
	);
}

const allChapters = { chapterId: null };

describe('loadCurrentHoldings', () => {
	it('joins the turf and holder detail the board shows', async () => {
		await checkout();
		const [row] = await loadCurrentHoldings(db, allChapters);
		expect(row).toMatchObject({
			mapRouteId: 100,
			turfName: 'Turf 01',
			chapterName: 'Washtenaw County',
			doorCount: 250,
			slackUserName: 'Dana',
			expiryWarnedAt: null,
		});
	});

	// An organizer looking at a board is not the holder.
	it('never selects the MiniVAN list number', async () => {
		await client.execute(
			`UPDATE van_turfs SET printed_list_number = '35536745-88712' WHERE map_route_id = 100`,
		);
		await checkout();
		const rows = await loadCurrentHoldings(db, allChapters);
		expect(JSON.stringify(rows)).not.toContain('35536745-88712');
		expect(rows[0]).not.toHaveProperty('printedListNumber');
	});

	it.each([
		['released', { released_at: iso(NOW.getTime() - HOUR), release_reason: 'volunteer' }],
		['completed', { completed_at: iso(NOW.getTime() - HOUR) }],
	])('excludes a claim that was %s', async (_label, over) => {
		await checkout(over);
		expect(await loadCurrentHoldings(db, allChapters)).toEqual([]);
	});

	// The split that matters: SQL returns anything the ledger has not closed,
	// and the pure rule decides what is still live. Between cron ticks a lapsed
	// claim is still an open row, and the board must not show it.
	it('returns a lapsed-but-unswept claim, which the pure rule then drops', async () => {
		await checkout({ expires_at: iso(NOW.getTime() - HOUR) });
		const rows = await loadCurrentHoldings(db, allChapters);
		expect(rows).toHaveLength(1);
		expect(currentHoldings(rows, NOW)).toEqual([]);
	});

	it('filters to one chapter', async () => {
		await checkout({ map_route_id: 100 });
		await checkout({ map_route_id: 300 });
		const wayne = await loadCurrentHoldings(db, { chapterId: 72 });
		expect(wayne.map((r) => r.mapRouteId)).toEqual([300]);
		expect(await loadCurrentHoldings(db, allChapters)).toHaveLength(2);
	});

	it('reports the expiry-warning stamp so the board can show who was told', async () => {
		await checkout({ expiry_warned_at: iso(NOW.getTime() - HOUR) });
		const [row] = await loadCurrentHoldings(db, allChapters);
		expect(row!.expiryWarnedAt).not.toBeNull();
	});

	it('handles an empty ledger', async () => {
		expect(await loadCurrentHoldings(db, allChapters)).toEqual([]);
	});
});

describe('loadRecentCompletions', () => {
	it('returns only completed rows', async () => {
		await checkout({ map_route_id: 100 }); // live
		await checkout({ map_route_id: 200, completed_at: iso(NOW.getTime() - HOUR) });
		const rows = await loadRecentCompletions(db, allChapters);
		expect(rows.map((r) => r.mapRouteId)).toEqual([200]);
	});

	it('orders most recent first', async () => {
		await checkout({ map_route_id: 100, completed_at: iso(NOW.getTime() - 5 * HOUR) });
		await checkout({ map_route_id: 200, completed_at: iso(NOW.getTime() - HOUR) });
		const rows = await loadRecentCompletions(db, allChapters);
		expect(rows.map((r) => r.mapRouteId)).toEqual([200, 100]);
	});

	it('applies the limit in SQL', async () => {
		for (const route of [100, 200, 300]) {
			await checkout({ map_route_id: route, completed_at: iso(NOW.getTime() - route * 1000) });
		}
		expect(await loadRecentCompletions(db, { ...allChapters, limit: 2 })).toHaveLength(2);
	});

	it('filters to one chapter', async () => {
		await checkout({ map_route_id: 100, completed_at: iso(NOW.getTime() - HOUR) });
		await checkout({ map_route_id: 300, completed_at: iso(NOW.getTime() - HOUR) });
		expect(await loadRecentCompletions(db, { chapterId: 72 })).toHaveLength(1);
	});

	// The pane's whole premise: an unmeasured delta must reach the caller as
	// null so it can be told apart from a measured zero.
	it('preserves a null delta rather than defaulting it to zero', async () => {
		await checkout({ completed_at: iso(NOW.getTime() - HOUR), confirmed_door_delta: null });
		const rows = await loadRecentCompletions(db, allChapters);
		expect(rows[0]!.confirmedDoorDelta).toBeNull();
		expect(suspectCompletions(rows)).toEqual([]);
	});

	it('surfaces a measured zero as suspect', async () => {
		await checkout({ completed_at: iso(NOW.getTime() - HOUR), confirmed_door_delta: 0 });
		const rows = await loadRecentCompletions(db, allChapters);
		expect(suspectCompletions(rows)).toHaveLength(1);
	});

	it('leaves a completion that cleared doors alone', async () => {
		await checkout({ completed_at: iso(NOW.getTime() - HOUR), confirmed_door_delta: 120 });
		expect(suspectCompletions(await loadRecentCompletions(db, allChapters))).toEqual([]);
	});

	it('handles no completions', async () => {
		expect(await loadRecentCompletions(db, allChapters)).toEqual([]);
	});
});

describe('loadHoldingsFor', () => {
	/** The claim-message path fills issued_list_number; the fixture above does
	 *  not, so set it explicitly where the test is about the number. */
	async function withList(mapRouteId: number, slackUserId: string, listNumber: string | null) {
		await checkout({ map_route_id: mapRouteId, slack_user_id: slackUserId });
		await client.execute(
			`UPDATE van_turf_checkouts SET issued_list_number = ${
				listNumber === null ? 'NULL' : `'${listNumber}'`
			} WHERE map_route_id = ${mapRouteId} AND slack_user_id = '${slackUserId}'`,
		);
	}

	// The property the whole command rests on. A command called "mine" that
	// returned somebody else's claim would be handing out their list number.
	it('returns only the caller’s own claims', async () => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_VOL' });
		await checkout({ map_route_id: 200, slack_user_id: 'U_OTHER' });

		const mine = await loadHoldingsFor(db, 'U_VOL');

		expect(mine.map((r) => r.mapRouteId)).toEqual([100]);
	});

	it('crosses chapters, because holding turf in two counties is holding two turfs', async () => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_VOL' });
		await checkout({ map_route_id: 300, slack_user_id: 'U_VOL' });

		const mine = await loadHoldingsFor(db, 'U_VOL');

		expect(mine.map((r) => r.chapterId).sort()).toEqual([71, 72]);
	});

	it('carries the list number the holder was issued', async () => {
		await withList(100, 'U_VOL', '35536745-88712');
		expect((await loadHoldingsFor(db, 'U_VOL'))[0]?.issuedListNumber).toBe('35536745-88712');
	});

	it('returns null for a claim made before list numbers were recorded', async () => {
		await withList(100, 'U_VOL', null);
		expect((await loadHoldingsFor(db, 'U_VOL'))[0]?.issuedListNumber).toBeNull();
	});

	it.each([
		['released', { released_at: iso(NOW.getTime() - HOUR), release_reason: 'volunteer' }],
		['completed', { completed_at: iso(NOW.getTime() - HOUR) }],
	])('leaves out a claim already %s', async (_label, over) => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_VOL', ...over });
		expect(await loadHoldingsFor(db, 'U_VOL')).toEqual([]);
	});

	// Matches loadCurrentHoldings: the sweep runs on a cron, so a lapsed claim
	// is still unstamped between ticks and `isActive` is what decides. The query
	// must not grow a second opinion.
	it('still returns a lapsed-but-unswept claim, leaving isActive to judge it', async () => {
		await checkout({
			map_route_id: 100,
			slack_user_id: 'U_VOL',
			expires_at: iso(NOW.getTime() - HOUR),
		});
		expect(await loadHoldingsFor(db, 'U_VOL')).toHaveLength(1);
	});

	it('names the turf and its region so the reply needs no second read', async () => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_VOL' });
		const [row] = await loadHoldingsFor(db, 'U_VOL');
		expect(row).toMatchObject({ turfName: 'Turf 01', regionName: 'Ann Arbor', doorCount: 250 });
	});

	it('is empty for somebody holding nothing', async () => {
		expect(await loadHoldingsFor(db, 'U_NOBODY')).toEqual([]);
	});
});
