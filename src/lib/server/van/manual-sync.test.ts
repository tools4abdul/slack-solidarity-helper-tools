import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import type { Caller } from '../scheduler.js';
import { VAN_LEDGER_LOCK, vanSyncLock } from './locks.js';
import { MANUAL_VAN_SYNC_LOCK, lastVanSyncs, startManualVanSync } from './manual-sync.js';

// A real in-memory libsql with the real schema, like scheduler.test.ts: what
// stops two presses running two passes is the lock's atomic upsert, and the
// pass itself reads which campaigns are enabled (the migrations seed the
// primary one, enabled).
let db: LibSQLDatabase<Record<string, unknown>>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const MINUTE = 60_000;
/** A lock that is free again can be taken; one still held cannot. */
const lockIsFree = async () => (await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, MINUTE)) !== null;
const expiresAt = async () =>
	(
		await client.execute({
			sql: 'SELECT expires_at FROM sync_locks WHERE name = ?',
			args: [MANUAL_VAN_SYNC_LOCK],
		})
	).rows[0]?.expires_at as string | undefined;

function recorder() {
	const calls: Record<string, string>[] = [];
	const call: Caller = async (_path, params) => {
		calls.push(params);
		return {};
	};
	return { calls, call };
}

/** A call that hangs until `finish` is called. */
function hanging() {
	let finish: (() => void) | undefined;
	const call: Caller = () => new Promise((resolve) => (finish = () => resolve({})));
	return { call, finish: () => finish?.(), reached: () => finish !== undefined };
}

describe('startManualVanSync', () => {
	it('runs the scheduled pass and frees the lock after', async () => {
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call);
		expect(result.status).toBe('started');
		if (result.status !== 'busy') await result.done;
		expect(calls).toEqual([{ campaign: '1' }]);
		expect(await lockIsFree()).toBe(true);
	});

	it('refuses a second press while the first is running', async () => {
		const pass = hanging();
		const first = await startManualVanSync(db, pass.call);
		expect(first.status).toBe('started');
		expect(await startManualVanSync(db, pass.call)).toEqual({ status: 'busy' });
		await vi.waitFor(() => expect(pass.reached()).toBe(true));
		pass.finish();
		if (first.status !== 'busy') await first.done;
	});

	it('frees the lock when the pass fails', async () => {
		const call: Caller = async () => {
			throw new Error('HTTP 500');
		};
		const result = await startManualVanSync(db, call);
		if (result.status !== 'busy') await expect(result.done).resolves.toBeUndefined();
		expect(await lockIsFree()).toBe(true);
	});

	// Started at once, the endpoint would give up on the held campaign lock
	// and skip the catalog the organizer's new turf is in.
	it('waits for a sync already running, then runs', async () => {
		const scheduled = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10 });
		expect(result.status).toBe('queued');
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, vanSyncLock(1), scheduled);
		if (result.status !== 'busy') await result.done;
		expect(calls).toEqual([{ campaign: '1' }]);
	});

	// A scheduled pass syncs campaigns one after another. One look landing
	// between two of them must not count as finished.
	it('does not start in the gap between two campaigns of a running sync', async () => {
		const first = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		const { calls, call } = recorder();
		// Looks land at ~100ms, ~200ms, …: the first sees the gap, the second
		// sees the next campaign. 50ms of margin either side of each.
		const result = await startManualVanSync(db, call, { pollMs: 100 });
		await releaseSyncLock(db, vanSyncLock(1), first);
		await new Promise((r) => setTimeout(r, 150));
		const second = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		await new Promise((r) => setTimeout(r, 150));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, vanSyncLock(1), second);
		if (result.status !== 'busy') await result.done;
		expect(calls).toEqual([{ campaign: '1' }]);
	});

	// Each request expires claims and sends due reminders under the ledger
	// lock before it takes its campaign's: that stretch is a sync running too.
	it('waits while a sync holds only the ledger lock', async () => {
		const ledger = (await acquireSyncLock(db, VAN_LEDGER_LOCK, 10 * MINUTE))!;
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10 });
		expect(result.status).toBe('queued');
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, VAN_LEDGER_LOCK, ledger);
		if (result.status !== 'busy') await result.done;
		expect(calls).toEqual([{ campaign: '1' }]);
	});

	it('runs anyway once it has waited long enough', async () => {
		await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE);
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10, maxWaitMs: 30 });
		if (result.status !== 'busy') await result.done;
		expect(calls).toEqual([{ campaign: '1' }]);
	});

	it('ignores a disabled campaign’s lock', async () => {
		await client.execute(
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'other', 0, 's', 's', 'x')`,
		);
		await acquireSyncLock(db, vanSyncLock(2), 10 * MINUTE);
		const result = await startManualVanSync(db, recorder().call);
		expect(result.status).toBe('started');
		if (result.status !== 'busy') await result.done;
	});

	// Short-lived so a crash frees it quickly, so a long pass has to keep it.
	it('keeps its lock alive while the pass runs', async () => {
		const pass = hanging();
		const result = await startManualVanSync(db, pass.call, { heartbeatMs: 20 });
		await vi.waitFor(() => expect(pass.reached()).toBe(true));
		const before = (await expiresAt())!;
		await vi.waitFor(async () => expect((await expiresAt())! > before).toBe(true), {
			timeout: 2000,
		});
		pass.finish();
		if (result.status !== 'busy') await result.done;
		expect(await lockIsFree()).toBe(true);
	});
});

describe('lastVanSyncs', () => {
	it('lists each enabled campaign, synced or not', async () => {
		await client.batch([
			"INSERT INTO van_sync_state (campaign_id, last_sync_at, last_error) VALUES (1, '2026-10-06T10:00:00.000Z', 'HTTP 401')",
			`INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'other', 'Partner', 1, 's', 's', 'x')`,
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (3, 'off', 0, 's', 's', 'x')`,
			"INSERT INTO van_sync_state (campaign_id, last_sync_at) VALUES (3, '2026-10-06T11:00:00.000Z')",
		]);
		const syncs = await lastVanSyncs(db);
		expect(syncs).toEqual([
			{ id: 1, name: expect.any(String), lastSyncAt: '2026-10-06T10:00:00.000Z', failed: true },
			{ id: 2, name: 'Partner', lastSyncAt: null, failed: false },
		]);
	});
});
