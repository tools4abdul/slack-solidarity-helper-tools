// The organizers' "Sync VAN now" button.
//
// An organizer who cuts new turf to answer a request should not have to wait
// out the half hour until the next scheduled sync before the volunteer can see
// it. This runs the scheduler's own VAN pass (runVanSync) between slots, so the
// endpoint stays the one place that decides what a sync does.
//
// The pass can take several minutes, longer than anyone should wait on a form
// submit, so it is started and left running; the page says so and the
// "last synced" line shows when it lands. Fly keeps the machine up, so a
// promise left running here finishes.
//
// A press while a scheduled sync is running waits for it, then runs. Started
// straight away, the endpoint would wait 75s for each campaign's lock, give up
// and skip the catalog — and the scheduled run may have read VAN before the
// organizer's new turf existed, leaving it for the next slot. Waiting first
// means the turf always lands without anyone having to press again.
//
// Its own lock, not the scheduler's: `schedule:<job>` is held until just
// before the next slot, so it is nearly always taken. Short and kept alive
// while the pass runs, so a crash frees it in minutes while no pass, however
// many campaigns it walks, outlives it.

import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { acquireSyncLock, extendSyncLock, heldSyncLocks, releaseSyncLock } from '../sync-lock.js';
import { runVanSync, type Caller } from '../scheduler.js';
import { vanCampaigns, vanSyncState } from '../schema.js';
import { campaignName } from './campaigns.js';
import { VAN_LEDGER_LOCK, vanSyncLock } from './locks.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

export const MANUAL_VAN_SYNC_LOCK = 'manual:van-sync';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The lock's life without a heartbeat — how long a crashed press blocks the
 *  next. */
const LOCK_TTL_MS = 2 * MINUTE;
const HEARTBEAT_MS = 30 * SECOND;
/** How often a waiting press looks again for the running sync to finish. */
const WAIT_POLL_MS = 5 * SECOND;
/** The longest a press waits for a running sync. A scheduled pass finishes
 *  well inside this; what holds a campaign lock for longer is a command-line
 *  drain, and the pass then runs anyway and syncs what it can. */
const MAX_WAIT_MS = 15 * MINUTE;

export interface ManualSyncOptions {
	/** For tests. */
	pollMs?: number;
	maxWaitMs?: number;
	heartbeatMs?: number;
}

export type ManualSyncStart =
	/** `started`: running now. `queued`: a sync was already running, and this
	 *  one runs as soon as it finishes. `done` settles when the pass ends — for
	 *  tests; the page does not wait on it. */
	| { status: 'started' | 'queued'; done: Promise<void> }
	/** A pressed sync is still running or waiting. */
	| { status: 'busy' };

/**
 * The VAN sync locks held right now: each enabled campaign's catalog lock, and
 * the ledger lock. The ledger one covers the housekeeping each request does
 * before it takes its campaign's lock — sending any due expiry reminders over
 * Slack, which can take seconds — so the moment between one campaign of a
 * scheduled pass and the next does not read as "finished".
 */
async function vanSyncsRunning(db: Db): Promise<string[]> {
	const enabled = await db
		.select({ id: vanCampaigns.id })
		.from(vanCampaigns)
		.where(eq(vanCampaigns.enabled, true));
	return heldSyncLocks(db, [...enabled.map((c) => vanSyncLock(c.id)), VAN_LEDGER_LOCK]);
}

/** Start a VAN sync pass in the background. */
export async function startManualVanSync(
	db: Db,
	call: Caller,
	options: ManualSyncOptions = {},
): Promise<ManualSyncStart> {
	const pollMs = options.pollMs ?? WAIT_POLL_MS;
	const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

	const token = await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (!token) return { status: 'busy' };

	let running: string[];
	try {
		running = await vanSyncsRunning(db);
	} catch (err) {
		await releaseSyncLock(db, MANUAL_VAN_SYNC_LOCK, token);
		throw err;
	}

	const queued = running.length > 0;
	const heartbeat = setInterval(() => {
		extendSyncLock(db, MANUAL_VAN_SYNC_LOCK, token, LOCK_TTL_MS).catch((err) =>
			console.error('[van] manual sync: could not extend the lock:', err),
		);
	}, heartbeatMs);
	heartbeat.unref();

	const done = (async () => {
		try {
			if (queued) {
				console.log('[van] manual sync: waiting for the running sync to finish');
				// Finished means clear on two looks in a row. A scheduled pass
				// syncs campaigns one request after another, and one look landing
				// between two requests would start this pass on top of the next
				// campaign — whose catalog the endpoint would then skip.
				const until = Date.now() + maxWaitMs;
				let clearLooks = 0;
				while (clearLooks < 2 && Date.now() < until) {
					await new Promise((r) => setTimeout(r, pollMs));
					running = await vanSyncsRunning(db);
					clearLooks = running.length === 0 ? clearLooks + 1 : 0;
				}
			}
			console.log('[van] manual sync: started');
			const started = Date.now();
			await runVanSync(call, db);
			console.log(`[van] manual sync: done in ${Math.round((Date.now() - started) / 1000)}s`);
		} catch (err) {
			console.error('[van] manual sync: failed:', err instanceof Error ? err.message : err);
		} finally {
			clearInterval(heartbeat);
			try {
				await releaseSyncLock(db, MANUAL_VAN_SYNC_LOCK, token);
			} catch (err) {
				// The TTL frees it anyway.
				console.error('[van] manual sync: could not release the lock:', err);
			}
		}
	})();
	return { status: queued ? 'queued' : 'started', done };
}

export interface CampaignLastSync {
	id: number;
	name: string;
	/** Null before the campaign's first completed sync. */
	lastSyncAt: string | null;
	/** The most recent sync failed. A success clears it (sync.ts). */
	failed: boolean;
}

/** When each enabled campaign's catalog last synced, oldest campaign first. */
export async function lastVanSyncs(db: Db): Promise<CampaignLastSync[]> {
	const rows = await db
		.select({
			id: vanCampaigns.id,
			label: vanCampaigns.label,
			credentialKey: vanCampaigns.credentialKey,
			lastSyncAt: vanSyncState.lastSyncAt,
			lastError: vanSyncState.lastError,
		})
		.from(vanCampaigns)
		.leftJoin(vanSyncState, eq(vanSyncState.campaignId, vanCampaigns.id))
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(vanCampaigns.id);
	return rows.map((r) => ({
		id: r.id,
		name: campaignName(r),
		lastSyncAt: r.lastSyncAt ?? null,
		failed: r.lastError !== null,
	}));
}
