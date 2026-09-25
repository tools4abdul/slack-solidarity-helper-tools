// Where the Packet Tracker meets configuration: the Sheets client, the rules
// in /settings, and the lock.
//
// packet-tracker-store.ts takes all of those injected so it can be tested
// against an in-memory database and a fake client. This is the one place that
// resolves them, for the three callers: the scheduled sync, the nudge after a
// volunteer acts, and the claim's live double-check.

import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { sheetsClient } from '../google-env.js';
import { loadSettings, loadVanSheetTargets } from '../settings.js';
import { withSyncLock } from '../sync-lock.js';
import { liveAssignment, syncPacketTracker, type TrackerResult } from './packet-tracker-store.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[sheets]';

/** Held by whichever of the sync and the nudge is writing, so the two cannot
 *  both insert a row for one checkout. Short: a run is bounded by its own
 *  budget, and a crashed holder should not stall the tracker for long. */
const TRACKER_LOCK = 'packet-tracker';
const TRACKER_LOCK_TTL_MS = 2 * 60 * 1000;

/** A nudge is one volunteer's turf: one spreadsheet, a few calls. */
const NUDGE_BUDGET_MS = 20 * 1000;
/** Waits between nudge attempts when the sync holds the lock. The sync may have
 *  read the ledger before this claim existed, so a skipped nudge tries again
 *  rather than leaving the row for the next half-hourly run. */
const NUDGE_RETRY_MS = [5_000, 15_000, 45_000];

/** The most the claim waits for the live check before trusting the last sync.
 *  Normally a fraction of this — two parallel reads. Not lower: the Sheets
 *  client will not start a request with under 3s left. Slack's reply is already
 *  acknowledged and the page shows a spinner, so this is not against a hard
 *  deadline — but it is a volunteer standing on a porch. */
const LIVE_CHECK_BUDGET_MS = 6_000;

/**
 * One tracker run, under the lock. Null when the tracker is not configured or
 * another run holds the lock.
 */
export async function runPacketTracker(
	db: Db,
	input: { timeBudgetMs: number; channelId: string; onlyMapRouteId?: number },
): Promise<TrackerResult | null> {
	const configured = sheetsClient();
	if (!configured.ok) return null;
	const targets = await loadVanSheetTargets(db);
	if (targets.length === 0) return null;
	const { vanSheetTabName } = await loadSettings(db);

	const run = await withSyncLock(db, TRACKER_LOCK, TRACKER_LOCK_TTL_MS, () =>
		syncPacketTracker(db, {
			now: new Date(),
			client: configured.client,
			targets,
			tabName: vanSheetTabName,
			timeBudgetMs: input.timeBudgetMs,
			channelId: input.channelId,
			onlyMapRouteId: input.onlyMapRouteId,
		}),
	);
	return run.skipped ? null : run.result;
}

/**
 * Bring this turf's row up to date now, in the background.
 *
 * Called after a claim, a completion or a hand-back. Fire-and-forget: the
 * volunteer's reply never waits on Google, and anything this misses the
 * scheduled sync picks up. Failures are alerted by that sync, not here — a
 * nudge that alerted too would say everything twice.
 */
export function nudgePacketTracker(db: Db, mapRouteId: number): void {
	void (async () => {
		for (let attempt = 0; ; attempt++) {
			if (!sheetsClient().ok) return;
			const result = await runPacketTracker(db, {
				timeBudgetMs: NUDGE_BUDGET_MS,
				// Alerts belong to the scheduled sync; see above.
				channelId: '',
				onlyMapRouteId: mapRouteId,
			});
			if (result !== null) return;
			const wait = NUDGE_RETRY_MS[attempt];
			if (wait === undefined) return;
			await new Promise((r) => setTimeout(r, wait));
		}
	})().catch((err) => console.error(`${LOG} packet tracker nudge failed:`, errMessage(err)));
}

/**
 * The claim's live look at the tracker: who the campaign's own rows say has
 * this turf, null if nobody, undefined if it could not be read in time (or the
 * tracker is not configured) — in which case the claim falls back to what the
 * last sync recorded.
 */
export function packetTrackerCheck(db: Db) {
	return async (turf: {
		mapRouteId: number;
		regionName: string;
		printedListNumber: string | null;
	}): Promise<string | null | undefined> => {
		try {
			const configured = sheetsClient();
			if (!configured.ok) return undefined;
			const targets = await loadVanSheetTargets(db);
			if (targets.length === 0) return undefined;
			const { vanSheetTabName } = await loadSettings(db);
			return await liveAssignment(db, {
				client: configured.client,
				targets,
				tabName: vanSheetTabName,
				turf,
				timeBudgetMs: LIVE_CHECK_BUDGET_MS,
			});
		} catch (err) {
			console.warn(`${LOG} live packet tracker check failed:`, errMessage(err));
			return undefined;
		}
	};
}
