import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { acquireSyncLock, releaseSyncLock, withSyncLock } from './sync-lock.js';

// Deliberately a real in-memory libsql rather than the chained-db fake used
// elsewhere in this directory. The entire value of this module is that acquiring
// is atomic — a single INSERT .. ON CONFLICT DO UPDATE .. WHERE that two racing
// callers cannot both win. A fake db could only assert the query was shaped a
// certain way, which would keep passing if the guarantee broke.

let db: LibSQLDatabase<Record<string, unknown>>;
/** Held so afterEach can close it; see the note there. */
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await client.execute(`
		CREATE TABLE sync_locks (
			name text PRIMARY KEY NOT NULL,
			token text NOT NULL,
			acquired_at text NOT NULL,
			expires_at text NOT NULL
		);
	`);
	db = drizzle(client);
});

const MINUTE = 60_000;

// Each test opens its own in-memory client. Closing it keeps one per test
// from leaking for the life of the worker — which never shows up while this
// file is run on its own.
afterEach(() => {
	client.close();
});

describe('acquireSyncLock', () => {
	it('grants a free lock', async () => {
		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toEqual(expect.any(String));
	});

	it('refuses a lock someone else holds', async () => {
		await acquireSyncLock(db, 'attendee-sync', MINUTE);
		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toBeNull();
	});

	it('does not let one sync block a different one', async () => {
		await acquireSyncLock(db, 'attendee-sync', MINUTE);
		expect(await acquireSyncLock(db, 'event-sync', MINUTE)).toEqual(expect.any(String));
	});

	// Without expiry a process that dies mid-sync wedges the job permanently.
	it('takes over a lock whose holder has expired', async () => {
		expect(await acquireSyncLock(db, 'attendee-sync', -MINUTE)).toEqual(expect.any(String));
		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toEqual(expect.any(String));
	});
});

describe('releaseSyncLock', () => {
	it('frees the lock for the next caller', async () => {
		const token = await acquireSyncLock(db, 'attendee-sync', MINUTE);
		await releaseSyncLock(db, 'attendee-sync', token!);
		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toEqual(expect.any(String));
	});

	// A run that overran its TTL has already lost the lock. If its cleanup could
	// still delete the row, it would free a lock the current holder is relying
	// on and admit a third run — reopening the race from the other end.
	it('ignores a release from a holder that already lost the lock', async () => {
		const stale = await acquireSyncLock(db, 'attendee-sync', -MINUTE);
		await acquireSyncLock(db, 'attendee-sync', MINUTE);

		await releaseSyncLock(db, 'attendee-sync', stale!);

		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toBeNull();
	});
});

describe('withSyncLock', () => {
	it('runs the body and reports the result', async () => {
		const run = await withSyncLock(db, 'attendee-sync', MINUTE, async () => 'done');
		expect(run).toEqual({ skipped: false, result: 'done' });
	});

	it('skips instead of running concurrently', async () => {
		await acquireSyncLock(db, 'attendee-sync', MINUTE);
		const body = vi.fn();
		const run = await withSyncLock(db, 'attendee-sync', MINUTE, async () => {
			body();
			return 'done';
		});
		expect(run).toEqual({ skipped: true });
		expect(body).not.toHaveBeenCalled();
	});

	it('releases the lock on the way out', async () => {
		await withSyncLock(db, 'attendee-sync', MINUTE, async () => 'ok');
		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toEqual(expect.any(String));
	});

	// A sync that throws must not strand the lock for the full 90-minute TTL.
	it('releases the lock when the body throws', async () => {
		await expect(
			withSyncLock(db, 'attendee-sync', MINUTE, async () => {
				throw new Error('sync blew up');
			}),
		).rejects.toThrow('sync blew up');

		expect(await acquireSyncLock(db, 'attendee-sync', MINUTE)).toEqual(expect.any(String));
	});
});
