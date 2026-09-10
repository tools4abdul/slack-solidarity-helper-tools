import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { claimTurf, endClaim, sweepExpiredClaims } from './checkout-store.js';

// A real in-memory libsql rather than a chained-db fake, for the same reason
// activity-store.test.ts uses one: the behaviour under test is a collaboration
// between application code and the PARTIAL UNIQUE INDEX on van_turf_checkouts.
// A fake cannot reproduce the index, and the index is precisely what these
// tests are about.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const CLAIMED = '2026-08-20T12:00:00.000Z';
/** Long past, and never swept — the state the nightly sweep has not reached. */
const LAPSED = '2026-08-22T12:00:00.000Z';
const NOW = new Date('2026-08-24T18:00:00.000Z');

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	// The real schema, so the partial unique index is present.
	await migrate(db, { migrationsFolder: 'drizzle' });

	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
		         region_name, name, printed_list_number, door_count, first_seen_at, last_seen_at)
		      VALUES (100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 01', 'L-100', 250, ?, ?)`,
		args: [NOW.toISOString(), NOW.toISOString()],
	});
});

async function insertClaim(over: Record<string, string | number | null> = {}) {
	const row = {
		map_route_id: 100,
		slack_user_id: 'U_FIRST',
		slack_user_name: 'Dana',
		claimed_at: CLAIMED,
		expires_at: LAPSED,
		released_at: null,
		completed_at: null,
		release_reason: null,
		...over,
	};
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, release_reason)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			row.map_route_id,
			row.slack_user_id,
			row.slack_user_name,
			row.claimed_at,
			row.expires_at,
			row.released_at,
			row.completed_at,
			row.release_reason,
		],
	});
}

async function rows() {
	const res = await client.execute(
		'SELECT slack_user_id, expires_at, released_at, release_reason FROM van_turf_checkouts ORDER BY id',
	);
	return res.rows as unknown as {
		slack_user_id: string;
		expires_at: string;
		released_at: string | null;
		release_reason: string | null;
	}[];
}

describe('claimTurf', () => {
	it('lets a volunteer claim turf whose previous claim expired but was never swept', async () => {
		// The regression this test exists for. The partial unique index is
		// `WHERE released_at IS NULL AND completed_at IS NULL` and knows nothing
		// about expiry, while every READ path treats an expired claim as gone.
		// So the turf rendered as available and the insert collided with the
		// stale row, telling the volunteer someone had just taken it.
		await insertClaim();

		const result = await claimTurf(db, {
			mapRouteId: 100,
			slackUserId: 'U_SECOND',
			slackUserName: 'Sam',
			now: NOW,
		});

		expect(result).toMatchObject({ ok: true, printedListNumber: 'L-100' });

		const all = await rows();
		expect(all).toHaveLength(2);
		// The lapsed row is closed out with the same reason the sweep uses, so
		// the ledger reads identically whether the sweep or a claim got there
		// first.
		expect(all[0]).toMatchObject({
			slack_user_id: 'U_FIRST',
			released_at: NOW.toISOString(),
			release_reason: 'expired',
		});
		expect(all[1]).toMatchObject({ slack_user_id: 'U_SECOND', released_at: null });
	});

	it('still refuses turf held by a LIVE claim, and does not release it', async () => {
		// The guard on the fix above: releasing "the stale row" must never
		// release a claim that is simply still running.
		await insertClaim({ expires_at: '2026-08-26T12:00:00.000Z' });

		const result = await claimTurf(db, {
			mapRouteId: 100,
			slackUserId: 'U_SECOND',
			slackUserName: 'Sam',
			now: NOW,
		});

		expect(result).toMatchObject({ ok: false, status: 409 });

		const all = await rows();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ slack_user_id: 'U_FIRST', released_at: null });
	});

	it('leaves an already-released row alone rather than stamping it twice', async () => {
		await insertClaim({ released_at: CLAIMED, release_reason: 'volunteer' });

		const result = await claimTurf(db, {
			mapRouteId: 100,
			slackUserId: 'U_SECOND',
			slackUserName: 'Sam',
			now: NOW,
		});

		expect(result).toMatchObject({ ok: true });
		const all = await rows();
		expect(all[0]).toMatchObject({ released_at: CLAIMED, release_reason: 'volunteer' });
	});

	it('agrees with sweepExpiredClaims about what "expired" means', async () => {
		// Both paths close the same row the same way; whichever runs first, the
		// other finds nothing left to do.
		await insertClaim();
		const swept = await sweepExpiredClaims(db, NOW);
		expect(swept).toBe(1);

		const result = await claimTurf(db, {
			mapRouteId: 100,
			slackUserId: 'U_SECOND',
			slackUserName: 'Sam',
			now: NOW,
		});
		expect(result).toMatchObject({ ok: true });
	});
});

describe('endClaim', () => {
	it('will not let one volunteer release another volunteer’s turf', async () => {
		await insertClaim({ expires_at: '2026-08-26T12:00:00.000Z' });

		const result = await endClaim(db, {
			mapRouteId: 100,
			slackUserId: 'U_SOMEONE_ELSE',
			now: NOW,
			kind: 'release',
		});

		expect(result).toMatchObject({ ok: false });
		const all = await rows();
		expect(all[0]).toMatchObject({ released_at: null });
	});
});
