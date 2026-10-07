// Cross-process advisory locks for syncs that must not run concurrently.
//
// The motivating failure: the attendee sync writes to Solidarity and only then
// records the participation in its ledger. Two overlapping runs both snapshot
// the ledger before either has written, both see the same signup as unrecorded,
// and both POST it — one wins, the other gets a 422. Cancelling the GitHub
// Actions run does not prevent this, because cancelling kills `curl`, not the
// request already in flight on Fly.
//
// Advisory, not authoritative: it stops overlapping runs of *this* app. It is
// not a substitute for the API-level idempotency in `createAttendance`, which
// still covers a run killed between the write and the ledger record.

import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { syncLocks } from './schema.js';

// Matches the alias in attendee-sync.ts and the rest of this directory.
type Db = LibSQLDatabase<Record<string, unknown>>;

/**
 * Take `name` for up to `ttlMs`, returning a release token, or null if another
 * holder has it and has not expired.
 *
 * Atomic by construction: a single INSERT .. ON CONFLICT DO UPDATE .. WHERE,
 * so two callers racing cannot both succeed. A read-then-write would reintroduce
 * exactly the race this exists to close.
 */
export async function acquireSyncLock(db: Db, name: string, ttlMs: number): Promise<string | null> {
	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	const token = crypto.randomUUID();

	// The WHERE clause is what makes this a lock rather than a last-writer-wins
	// upsert: an unexpired row fails to match, so no row comes back and the
	// caller learns it did not acquire.
	const rows = await db
		.insert(syncLocks)
		.values({ name, token, acquiredAt: nowIso, expiresAt })
		.onConflictDoUpdate({
			target: syncLocks.name,
			set: { token, acquiredAt: nowIso, expiresAt },
			where: lte(syncLocks.expiresAt, nowIso),
		})
		.returning({ token: syncLocks.token });

	return rows.length > 0 ? token : null;
}

/**
 * Release `name`, but only if `token` still holds it. A run that overran its TTL
 * has already lost the lock to someone else; letting it delete on the way out
 * would hand a third run a lock the second still thinks it owns.
 */
export async function releaseSyncLock(db: Db, name: string, token: string): Promise<void> {
	await db.delete(syncLocks).where(and(eq(syncLocks.name, name), eq(syncLocks.token, token)));
}

/**
 * Push `name`'s expiry to `ttlMs` from now, if `token` still holds it. Returns
 * whether it did. For a holder whose run has no fixed length: a short TTL kept
 * alive while it works frees the lock soon after a crash, where one TTL long
 * enough for the slowest run would strand it for that long.
 */
export async function extendSyncLock(
	db: Db,
	name: string,
	token: string,
	ttlMs: number,
): Promise<boolean> {
	const expiresAt = new Date(Date.now() + ttlMs).toISOString();
	const rows = await db
		.update(syncLocks)
		.set({ expiresAt })
		.where(and(eq(syncLocks.name, name), eq(syncLocks.token, token)))
		.returning({ name: syncLocks.name });
	return rows.length > 0;
}

/** Which of `names` someone holds right now. An expired row is free. */
export async function heldSyncLocks(db: Db, names: readonly string[]): Promise<string[]> {
	if (names.length === 0) return [];
	const rows = await db
		.select({ name: syncLocks.name })
		.from(syncLocks)
		.where(
			and(inArray(syncLocks.name, [...names]), gt(syncLocks.expiresAt, new Date().toISOString())),
		);
	return rows.map((r) => r.name);
}

/**
 * Run `fn` under `name`, or return `{ skipped: true }` if it is already held.
 * Releases in a `finally` so a throwing `fn` does not strand the lock for the
 * full TTL.
 */
export async function withSyncLock<T>(
	db: Db,
	name: string,
	ttlMs: number,
	fn: () => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
	const token = await acquireSyncLock(db, name, ttlMs);
	if (token === null) return { skipped: true };
	try {
		return { skipped: false, result: await fn() };
	} finally {
		await releaseSyncLock(db, name, token);
	}
}
