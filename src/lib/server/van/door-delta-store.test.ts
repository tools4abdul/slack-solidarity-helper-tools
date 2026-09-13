import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockSendDm = vi.hoisted(() =>
	vi.fn(async (slackUserId: string, text: string, logTag: string) =>
		Boolean(slackUserId && text && logTag),
	),
);
vi.mock('../slack-dm.js', () => ({ sendDm: mockSendDm }));

import { stampDoorDeltas } from './door-delta-store.js';

// A real in-memory libsql rather than a chained fake: the interesting part is
// the join between a checkout and the turf it points at, plus a WHERE that has
// to agree with the pure predicate about which completions are candidates. A
// stub would let those two drift without failing.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-09-12T18:00:00.000Z');

beforeEach(async () => {
	vi.clearAllMocks();
	mockSendDm.mockResolvedValue(true);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});

	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

/** A turf as the catalog left it after its post-completion refresh. */
async function turf(over: { doorCount?: number; lastRefreshedAt?: string | null } = {}) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name,
		         name, door_count, last_refreshed_at, first_seen_at, last_seen_at)
		      VALUES (100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 01', ?, ?, ?, ?)`,
		args: [
			over.doorCount ?? 190,
			over.lastRefreshedAt === undefined ? '2026-09-12T14:00:00.000Z' : over.lastRefreshedAt,
			NOW.toISOString(),
			NOW.toISOString(),
		],
	});
}

async function completion(
	over: {
		completedAt?: string;
		claimDoorCount?: number | null;
		confirmedDoorDelta?: number | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         completed_at, claim_door_count, confirmed_door_delta)
		      VALUES (100, 'U1', 'Dana', '2026-09-11T12:00:00.000Z', '2026-09-13T12:00:00.000Z', ?, ?, ?)`,
		args: [
			over.completedAt ?? '2026-09-12T12:00:00.000Z',
			over.claimDoorCount === undefined ? 250 : over.claimDoorCount,
			over.confirmedDoorDelta ?? null,
		],
	});
}

async function deltas() {
	const res = await client.execute(
		'SELECT confirmed_door_delta FROM van_turf_checkouts ORDER BY id',
	);
	return res.rows.map((r) => r.confirmed_door_delta);
}

describe('stampDoorDeltas', () => {
	it('stamps the doors that left and says nothing', async () => {
		await turf({ doorCount: 190 });
		await completion({ claimDoorCount: 250 });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result).toMatchObject({ measured: 1, unsynced: 0, doorsCleared: 60 });
		expect(await deltas()).toEqual([60]);
		expect(mockSendDm).not.toHaveBeenCalled();
	});

	it('stamps a zero and nudges the volunteer about MiniVAN', async () => {
		await turf({ doorCount: 250 });
		await completion({ claimDoorCount: 250 });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result).toMatchObject({ measured: 1, unsynced: 1, doorsCleared: 0 });
		expect(await deltas()).toEqual([0]);
		expect(mockSendDm).toHaveBeenCalledOnce();
		expect(mockSendDm.mock.calls[0][0]).toBe('U1');
		expect(mockSendDm.mock.calls[0][1]).toContain('Sync');
	});

	it('keeps the stamp even when the nudge cannot be delivered', async () => {
		// The measurement is what the organizer view reads; a deactivated account
		// must not leave a completion permanently unchecked.
		mockSendDm.mockResolvedValue(false);
		await turf({ doorCount: 250 });
		await completion({ claimDoorCount: 250 });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result).toMatchObject({ measured: 1, unsynced: 1, dmFailed: 1 });
		expect(await deltas()).toEqual([0]);
	});

	it('waits while no refresh has landed since the completion', async () => {
		await turf({ lastRefreshedAt: '2026-09-12T09:00:00.000Z' });
		await completion();

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result.measured).toBe(0);
		expect(await deltas()).toEqual([null]);
	});

	it('never re-stamps a completion that was already measured', async () => {
		// The stamp is the idempotency key: the sync runs 37 times a day, and
		// without it the nudge would go out on every one of them.
		await turf({ doorCount: 250 });
		await completion({ claimDoorCount: 250, confirmedDoorDelta: 0 });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result.measured).toBe(0);
		expect(mockSendDm).not.toHaveBeenCalled();
	});

	it('leaves a claim that predates the baseline column unmeasured', async () => {
		await turf();
		await completion({ claimDoorCount: null });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		// Null, not zero: zero is an accusation, null is "we did not check".
		expect(result.measured).toBe(0);
		expect(await deltas()).toEqual([null]);
	});

	it('gives up on completions older than the horizon', async () => {
		await turf();
		await completion({ completedAt: '2026-08-01T12:00:00.000Z' });

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result.measured).toBe(0);
		expect(await deltas()).toEqual([null]);
	});

	it('ignores a claim that is still live', async () => {
		await turf();
		await client.execute(
			`INSERT INTO van_turf_checkouts
			   (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at, claim_door_count)
			 VALUES (100, 'U2', 'Sam', '2026-09-12T09:00:00.000Z', '2026-09-14T09:00:00.000Z', 250)`,
		);

		const result = await stampDoorDeltas(db, { now: NOW, appUrl: 'https://app.example' });

		expect(result.measured).toBe(0);
	});

	it('returns empty counts rather than throwing when the read fails', async () => {
		const broken = {
			select: () => {
				throw new Error('database is locked');
			},
		} as never;
		await expect(
			stampDoorDeltas(broken, { now: NOW, appUrl: 'https://app.example' }),
		).resolves.toMatchObject({ measured: 0 });
	});
});
