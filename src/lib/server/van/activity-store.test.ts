import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { hasAnyTurf, loadActivityCounts, loadActivityRows } from './activity-store.js';
import { activityEvents, rangeFor, totalEvents } from '../../van/turf-activity.js';

// A real in-memory libsql, not the chained-db fake used elsewhere in this
// directory, for the same reason sync-lock.test.ts uses one: the value of this
// module IS the SQL. A fake could only assert the query was shaped a certain
// way, which would keep passing if `coalesce` ordered wrongly, if the `case
// when` counted rows instead of events, or if the OR-of-three-ranges quietly
// matched everything. Those are the failures worth catching, and only an engine
// can catch them.

// Typed as drizzle's own return so it matches the `Db` the van modules take
// (which carries `$client`), rather than the looser LibSQLDatabase alias.
let db: ReturnType<typeof drizzle>;

const NOW = new Date('2026-08-24T18:00:00.000Z');
const WEEK = rangeFor('7', NOW);
const ALL = rangeFor('all', NOW);

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	db = drizzle(client);
	// The REAL schema from drizzle/, not a hand-copied CREATE TABLE. It carries
	// the partial unique index that allows only one ACTIVE claim per route, so a
	// fixture cannot set up a state production forbids and quietly prove nothing.
	await migrate(db, { migrationsFolder: 'drizzle' });

	await client.execute({
		sql: `INSERT INTO van_turfs (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, first_seen_at, last_seen_at)
		      VALUES (100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 01', 250, ?, ?),
		             (200, 1, 1, 72, 'Wayne County', 'Detroit East', 'Turf 02', 180, ?, ?),
		             (300, 1, 1, 71, 'Washtenaw County', 'Ypsilanti', 'Retired turf', 90, ?, ?),
		             (400, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 04', 200, ?, ?),
		             (500, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 05', 210, ?, ?)`,
		args: Array.from({ length: 10 }, () => NOW.toISOString()),
	});
	// The third turf is retired — history about it must still read.
	await client.execute(
		`UPDATE van_turfs SET retired_at = '2026-08-20T00:00:00.000Z' WHERE map_route_id = 300`,
	);
});

async function checkout(over: Record<string, string | number | null> = {}) {
	const row = {
		map_route_id: 100,
		slack_user_id: 'U_VOL',
		slack_user_name: 'Dana',
		claimed_at: '2026-08-24T13:10:00.000Z',
		expires_at: '2026-08-26T13:10:00.000Z',
		released_at: null,
		completed_at: null,
		release_reason: null,
		confirmed_door_delta: null,
		...over,
	};
	await db.run(
		`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, completed_at, release_reason, confirmed_door_delta)
		 VALUES (${row.map_route_id}, '${row.slack_user_id}', '${row.slack_user_name}', '${row.claimed_at}', '${row.expires_at}',
		         ${row.released_at === null ? 'NULL' : `'${row.released_at}'`},
		         ${row.completed_at === null ? 'NULL' : `'${row.completed_at}'`},
		         ${row.release_reason === null ? 'NULL' : `'${row.release_reason}'`},
		         ${row.confirmed_door_delta === null ? 'NULL' : row.confirmed_door_delta})` as never,
	);
}

const allChapters = { chapterId: null, range: WEEK };

describe('loadActivityRows', () => {
	it('joins the turf detail an organizer reads', async () => {
		await checkout();
		const [row] = await loadActivityRows(db, allChapters);
		expect(row).toMatchObject({
			mapRouteId: 100,
			name: 'Turf 01',
			regionName: 'Ann Arbor',
			chapterId: 71,
			chapterName: 'Washtenaw County',
			doorCount: 250,
			slackUserName: 'Dana',
		});
	});

	// The credential rule: an admin is not the holder, so the number never even
	// enters the payload.
	it('never selects the MiniVAN list number', async () => {
		await db.run(
			`UPDATE van_turfs SET printed_list_number = '35536745-88712' WHERE map_route_id = 100` as never,
		);
		await checkout();
		const rows = await loadActivityRows(db, allChapters);
		expect(JSON.stringify(rows)).not.toContain('35536745-88712');
		expect(rows[0]).not.toHaveProperty('printedListNumber');
	});

	it('filters to one chapter', async () => {
		await checkout({ map_route_id: 100 });
		await checkout({ map_route_id: 200 });
		const rows = await loadActivityRows(db, { chapterId: 72, range: WEEK });
		expect(rows.map((r) => r.mapRouteId)).toEqual([200]);
	});

	it('returns every chapter when none is given', async () => {
		await checkout({ map_route_id: 100 });
		await checkout({ map_route_id: 200 });
		const rows = await loadActivityRows(db, allChapters);
		expect(rows).toHaveLength(2);
	});

	// A turf VAN no longer has still happened; dropping it would rewrite the
	// record of a canvass that really took place.
	it('keeps history for retired turf', async () => {
		await checkout({ map_route_id: 300 });
		const rows = await loadActivityRows(db, allChapters);
		expect(rows.map((r) => r.name)).toEqual(['Retired turf']);
	});

	describe('ordering', () => {
		// The reason for coalesce rather than SQLite's max(): max() returns NULL
		// if any argument is NULL, and an active claim has no terminal stamp — so
		// max() would sort every live claim to one end regardless of its age.
		it('orders by each row’s newest stamp, not by claim time', async () => {
			// Distinct routes: only one claim per route may be active at a time.
			await checkout({ map_route_id: 100, claimed_at: '2026-08-24T09:00:00.000Z' }); // active, oldest claim
			await checkout({
				map_route_id: 200,
				claimed_at: '2026-08-24T08:00:00.000Z',
				completed_at: '2026-08-24T17:00:00.000Z',
			}); // older claim, newest activity
			await checkout({ map_route_id: 300, claimed_at: '2026-08-24T10:00:00.000Z' });

			const rows = await loadActivityRows(db, allChapters);
			expect(rows.map((r) => r.checkoutId)).toEqual([2, 3, 1]);
		});

		it('sorts an active claim by its claim time', async () => {
			await checkout({ map_route_id: 100, claimed_at: '2026-08-24T09:00:00.000Z' });
			await checkout({ map_route_id: 200, claimed_at: '2026-08-24T16:00:00.000Z' });
			const rows = await loadActivityRows(db, allChapters);
			expect(rows.map((r) => r.checkoutId)).toEqual([2, 1]);
		});

		it('treats a release like a completion for ordering', async () => {
			await checkout({
				claimed_at: '2026-08-24T08:00:00.000Z',
				released_at: '2026-08-24T17:00:00.000Z',
				release_reason: 'volunteer',
			});
			await checkout({ claimed_at: '2026-08-24T12:00:00.000Z' });
			const rows = await loadActivityRows(db, allChapters);
			expect(rows.map((r) => r.checkoutId)).toEqual([1, 2]);
		});
	});

	describe('range', () => {
		it('excludes rows entirely outside the window', async () => {
			await checkout({ claimed_at: '2026-01-01T00:00:00.000Z' });
			expect(await loadActivityRows(db, allChapters)).toEqual([]);
		});

		// The row is old but the completion is recent — the OR across all three
		// stamps is what catches it.
		it('includes a row whose only recent stamp is the completion', async () => {
			await checkout({
				claimed_at: '2026-01-01T00:00:00.000Z',
				completed_at: '2026-08-24T15:00:00.000Z',
			});
			expect(await loadActivityRows(db, allChapters)).toHaveLength(1);
		});

		it('includes everything for all time', async () => {
			await checkout({ claimed_at: '2020-01-01T00:00:00.000Z' });
			expect(await loadActivityRows(db, { chapterId: null, range: ALL })).toHaveLength(1);
		});
	});

	it('applies the limit in SQL', async () => {
		for (const [i, route] of [100, 200, 300, 400, 500].entries()) {
			await checkout({ map_route_id: route, claimed_at: `2026-08-24T1${i}:00:00.000Z` });
		}
		const rows = await loadActivityRows(db, { ...allChapters, limit: 2 });
		expect(rows).toHaveLength(2);
		// The newest two, not an arbitrary two.
		expect(rows.map((r) => r.checkoutId)).toEqual([5, 4]);
	});
});

describe('loadActivityCounts', () => {
	it('is all zeroes on an empty ledger', async () => {
		const counts = await loadActivityCounts(db, allChapters);
		expect(totalEvents(counts)).toBe(0);
		// sum() over no rows is NULL, so this also pins the coalesce-to-zero.
		expect(counts.claimed).toBe(0);
	});

	// The property that makes the "N of M" line trustworthy: one row that was
	// claimed and completed in the window is two events, not one.
	it('counts events, not rows', async () => {
		await checkout({ completed_at: '2026-08-24T15:30:00.000Z' });
		const counts = await loadActivityCounts(db, allChapters);
		expect(counts.claimed).toBe(1);
		expect(counts.completed).toBe(1);
		expect(totalEvents(counts)).toBe(2);
	});

	it.each([
		['volunteer', 'given-back'],
		['expired', 'expired'],
		['blocked', 'blocked'],
		['retired', 'retired'],
		['walked-out', 'walked-out'],
		['admin', 'given-back'],
	] as const)('counts a %s release as %s', async (reason, kind) => {
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: reason });
		const counts = await loadActivityCounts(db, allChapters);
		expect(counts[kind]).toBe(1);
	});

	// The split that keeps the summary honest.
	it('does not fold blocked, retired or walked-out into given-back', async () => {
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: 'volunteer' });
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: 'blocked' });
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: 'retired' });
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: 'walked-out' });
		const counts = await loadActivityCounts(db, allChapters);
		expect(counts['given-back']).toBe(1);
		expect(counts.blocked).toBe(1);
		expect(counts.retired).toBe(1);
		// The reconciliation checked this one back in because VAN said the doors
		// were gone. Reading it as a hand-back would have an organizer chasing a
		// volunteer who did nothing wrong.
		expect(counts['walked-out']).toBe(1);
	});

	it('counts a release with a NULL reason as given back', async () => {
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: null });
		expect((await loadActivityCounts(db, allChapters))['given-back']).toBe(1);
	});

	it('filters to one chapter', async () => {
		await checkout({ map_route_id: 100 });
		await checkout({ map_route_id: 200 });
		expect((await loadActivityCounts(db, { chapterId: 71, range: WEEK })).claimed).toBe(1);
		expect((await loadActivityCounts(db, allChapters)).claimed).toBe(2);
	});

	it('excludes stamps outside the window', async () => {
		await checkout({
			claimed_at: '2026-01-01T00:00:00.000Z',
			completed_at: '2026-08-24T15:00:00.000Z',
		});
		const counts = await loadActivityCounts(db, allChapters);
		// The row is in range because of its completion, but the claim itself is
		// not — the per-stamp CASE has to be narrower than the row-level WHERE.
		expect(counts.completed).toBe(1);
		expect(counts.claimed).toBe(0);
	});
});

// The counts and the list are the same rule written twice, once in SQL and once
// in TypeScript. This is the test that keeps them honest.
describe('counts agree with the expanded events', () => {
	it.each([
		['a plain claim', {}],
		['a completion', { completed_at: '2026-08-24T15:30:00.000Z' }],
		['a hand-back', { released_at: '2026-08-24T16:00:00.000Z', release_reason: 'volunteer' }],
		['an expiry', { released_at: '2026-08-24T16:00:00.000Z', release_reason: 'expired' }],
		['a block', { released_at: '2026-08-24T16:00:00.000Z', release_reason: 'blocked' }],
		[
			'a claim outside the window with a completion inside it',
			{ claimed_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-08-24T15:00:00.000Z' },
		],
	])('agree for %s', async (_label, over) => {
		await checkout(over as Record<string, string | number | null>);
		const counts = await loadActivityCounts(db, allChapters);
		const events = activityEvents(await loadActivityRows(db, allChapters), WEEK);
		expect(events).toHaveLength(totalEvents(counts));
		for (const event of events) expect(counts[event.kind]).toBeGreaterThan(0);
	});

	it('agree across a mixed ledger', async () => {
		await checkout();
		await checkout({ completed_at: '2026-08-24T15:30:00.000Z' });
		await checkout({ released_at: '2026-08-24T16:00:00.000Z', release_reason: 'expired' });
		await checkout({
			map_route_id: 200,
			released_at: '2026-08-24T16:00:00.000Z',
			release_reason: 'blocked',
		});
		const counts = await loadActivityCounts(db, allChapters);
		const events = activityEvents(await loadActivityRows(db, allChapters), WEEK);
		expect(events).toHaveLength(totalEvents(counts));
		expect(totalEvents(counts)).toBe(7);
	});
});

describe('hasAnyTurf', () => {
	it('is true when the catalog has rows', async () => {
		expect(await hasAnyTurf(db)).toBe(true);
	});

	// Distinguishes "nothing happened this week" from "no turf has ever been
	// loaded" — which, with no VAN key yet, is the state anyone actually hits.
	it('is false on an empty catalog', async () => {
		await db.run(`DELETE FROM van_turfs` as never);
		expect(await hasAnyTurf(db)).toBe(false);
	});
});
