import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockSendDm = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/slack-dm.js', () => ({ sendDm: mockSendDm }));
vi.mock('$lib/server/env.js', () => ({ APP_URL: 'https://app.example.org' }));

const { sendExpiryWarnings } = await import('./expiry-warning-store.js');

// Real in-memory libsql rather than a chained fake, as in activity-store.test.ts
// and sync-lock.test.ts. The guarantee under test is that a volunteer gets ONE
// reminder however many times the sweep runs, and that guarantee lives in a
// column being stamped and then read back by the next query. A fake db could
// assert the update was issued; only an engine can show the second run finding
// nothing to do.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-08-24T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockSendDm.mockResolvedValue(true);

	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	// The REAL schema, applied from drizzle/, rather than a hand-copied CREATE
	// TABLE. That matters here beyond tidiness: van_turf_checkouts carries a
	// partial unique index allowing only ONE active claim per route, and a
	// hand-written fixture without it happily accepts three — a state production
	// forbids, which is exactly the kind of impossible setup that makes a test
	// pass while the code under it is wrong.
	await migrate(db, { migrationsFolder: 'drizzle' });

	// Three turfs, because the partial unique index means three simultaneous
	// claims must be on three different routes.
	for (const [id, name] of [
		[100, 'Turf 01'],
		[200, 'Turf 02'],
		[300, 'Turf 03'],
	] as const) {
		await client.execute(
			`INSERT INTO van_turfs (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, first_seen_at, last_seen_at)
			 VALUES (${id}, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', '${name}', 250, '${iso(NOW.getTime())}', '${iso(NOW.getTime())}')`,
		);
	}
});

/** Insert a checkout. Defaults to one expiring in four hours — inside the
 *  six-hour lead window — held by an unwarned volunteer. */
async function checkout(over: Record<string, string | number | null> = {}) {
	const row = {
		map_route_id: 100,
		slack_user_id: 'U_VOL',
		slack_user_name: 'Dana',
		claimed_at: iso(NOW.getTime() - 20 * HOUR),
		expires_at: iso(NOW.getTime() + 4 * HOUR),
		released_at: null,
		completed_at: null,
		expiry_warned_at: null,
		...over,
	};
	const q = (v: string | number | null) => (v === null ? 'NULL' : `'${v}'`);
	await client.execute(
		`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, completed_at, expiry_warned_at)
		 VALUES (${row.map_route_id}, '${row.slack_user_id}', '${row.slack_user_name}', '${row.claimed_at}', '${row.expires_at}', ${q(row.released_at)}, ${q(row.completed_at)}, ${q(row.expiry_warned_at)})`,
	);
}

async function warnedStamps(): Promise<(string | null)[]> {
	const res = await client.execute('SELECT expiry_warned_at FROM van_turf_checkouts ORDER BY id');
	return res.rows.map((r) => r.expiry_warned_at as string | null);
}

// Each test opens its own in-memory client and replaces console. Both leak for
// the life of the worker otherwise — `clearAllMocks` resets a spy's recorded
// calls but leaves it installed. Neither is visible while this file is run on
// its own, which is the shape of a test that fails once in a full suite and
// passes every time you go looking for it.
afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('sendExpiryWarnings', () => {
	it('DMs the holder of turf inside the lead window', async () => {
		await checkout();
		const result = await sendExpiryWarnings(db, NOW);
		expect(result).toEqual({ sent: 1, failed: 0 });
		expect(mockSendDm).toHaveBeenCalledTimes(1);
		expect(mockSendDm.mock.calls[0]![0]).toBe('U_VOL');
	});

	it('writes the turf detail into the message', async () => {
		await checkout();
		await sendExpiryWarnings(db, NOW);
		const text = mockSendDm.mock.calls[0]![1] as string;
		expect(text).toContain('Turf 01');
		expect(text).toContain('Ann Arbor');
		expect(text).toContain('250 doors');
		expect(text).toContain('chapter=71');
		expect(text).toContain('about 4 hours');
	});

	it('stays quiet about turf that is not due yet', async () => {
		await checkout({ expires_at: iso(NOW.getTime() + 30 * HOUR) });
		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
		expect(mockSendDm).not.toHaveBeenCalled();
	});

	// The whole point of the column.
	it('warns once, however many times the sweep runs', async () => {
		await checkout();
		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 1, failed: 0 });
		expect(await sendExpiryWarnings(db, new Date(NOW.getTime() + 30 * 60_000))).toEqual({
			sent: 0,
			failed: 0,
		});
		expect(await sendExpiryWarnings(db, new Date(NOW.getTime() + 60 * 60_000))).toEqual({
			sent: 0,
			failed: 0,
		});
		expect(mockSendDm).toHaveBeenCalledTimes(1);
	});

	it('stamps the row when the DM lands', async () => {
		await checkout();
		await sendExpiryWarnings(db, NOW);
		expect(await warnedStamps()).toEqual([NOW.toISOString()]);
	});

	// A Slack outage must not burn the one message that stops turf being lost.
	describe('when the DM fails', () => {
		it('leaves the row unstamped and reports the failure', async () => {
			await checkout();
			mockSendDm.mockResolvedValue(false);
			expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 1 });
			expect(await warnedStamps()).toEqual([null]);
		});

		it('retries on the next sweep', async () => {
			await checkout();
			mockSendDm.mockResolvedValue(false);
			await sendExpiryWarnings(db, NOW);

			mockSendDm.mockResolvedValue(true);
			expect(await sendExpiryWarnings(db, new Date(NOW.getTime() + 30 * 60_000))).toEqual({
				sent: 1,
				failed: 0,
			});
			expect(mockSendDm).toHaveBeenCalledTimes(2);
		});
	});

	describe('claims it must not warn about', () => {
		it.each([
			['already released', { released_at: iso(NOW.getTime() - HOUR) }],
			['already completed', { completed_at: iso(NOW.getTime() - HOUR) }],
			['already warned', { expiry_warned_at: iso(NOW.getTime() - HOUR) }],
			['already lapsed', { expires_at: iso(NOW.getTime() - HOUR) }],
		])('skips a claim %s', async (_label, over) => {
			await checkout(over);
			expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
			expect(mockSendDm).not.toHaveBeenCalled();
		});

		// The SQL narrows; the pure predicate decides. These two values are chosen
		// to land on either side of that split: '0000-bad' sorts BELOW the ISO
		// horizon so it survives the SQL filter and must be refused by isActive's
		// unparseable-timestamp rule, while 'not a date' sorts above it and never
		// gets that far. Testing only the second would prove nothing about the
		// guard — it would pass even with the predicate deleted.
		it.each([
			['one that survives the SQL filter', '0000-bad'],
			['one the SQL filter already excludes', 'not a date'],
		])('skips a claim with an unparseable expiry, %s', async (_label, expires) => {
			await checkout({ expires_at: expires });
			expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
			expect(mockSendDm).not.toHaveBeenCalled();
		});

		it('skips a checkout whose turf row is missing', async () => {
			await client.execute(
				`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at)
				 VALUES (999, 'U_GHOST', 'Ghost', '${iso(NOW.getTime() - HOUR)}', '${iso(NOW.getTime() + HOUR)}')`,
			);
			expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
		});
	});

	it('warns several holders in one sweep', async () => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_A', slack_user_name: 'A' });
		await checkout({ map_route_id: 200, slack_user_id: 'U_B', slack_user_name: 'B' });
		await checkout({
			map_route_id: 300,
			slack_user_id: 'U_C',
			slack_user_name: 'C',
			expires_at: iso(NOW.getTime() + 30 * HOUR),
		});

		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 2, failed: 0 });
		expect(mockSendDm.mock.calls.map((c) => c[0])).toEqual(['U_A', 'U_B']);
	});

	it('reports sent and failed separately in a mixed sweep', async () => {
		await checkout({ map_route_id: 100, slack_user_id: 'U_A', slack_user_name: 'A' });
		await checkout({ map_route_id: 200, slack_user_id: 'U_B', slack_user_name: 'B' });
		mockSendDm.mockImplementation(async (userId: string) => userId !== 'U_B');

		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 1, failed: 1 });
		expect(await warnedStamps()).toEqual([NOW.toISOString(), null]);
	});

	it('honours a custom lead time', async () => {
		await checkout({ expires_at: iso(NOW.getTime() + 10 * HOUR) });
		expect(await sendExpiryWarnings(db, NOW, 6)).toEqual({ sent: 0, failed: 0 });
		expect(await sendExpiryWarnings(db, NOW, 12)).toEqual({ sent: 1, failed: 0 });
	});

	it('does nothing on an empty ledger', async () => {
		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
	});

	// A failure to warn must not fail the sync that already wrote its rows.
	it('never throws when the query fails', async () => {
		await client.execute('DROP TABLE van_turf_checkouts');
		expect(await sendExpiryWarnings(db, NOW)).toEqual({ sent: 0, failed: 0 });
	});
});
