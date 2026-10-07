// Where the Packet Tracker meets configuration: the Sheets client, the rules
// in /settings, and the lock.
//
// packet-tracker-store.ts takes all of those injected so it can be tested
// against an in-memory database and a fake client. This is the one place that
// resolves them, for the three callers: the scheduled sync, the nudge after a
// volunteer acts, and the claim's live double-check.
//
// Per campaign (specs/012-multi-van-campaigns): only a campaign with
// `sheets_enabled` has a Packet Tracker, each with its own rules and tab. A
// turf in a campaign without one never costs a Google call — not on the claim,
// not on the nudge, not on the sync.

import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { sheetsClient } from '../google-env.js';
import { vanCampaigns, vanTurfs } from '../schema.js';
import { loadSettings, loadVanSheetTargets } from '../settings.js';
import { postAlert } from '../slack.js';
import { withSyncLock } from '../sync-lock.js';
import { liveAssignment, syncPacketTracker, type TrackerResult } from './packet-tracker-store.js';
import type { SheetTarget } from '../../van/sheet-routing.js';

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

/** A campaign that keeps a Packet Tracker, as a run needs it. */
interface TrackedCampaign {
	id: number;
	sheetTabName: string | null;
}

/** Campaigns with sheets on — disabled ones included, so the claims they still
 *  have running are recorded to the end. */
async function trackedCampaigns(db: Db): Promise<TrackedCampaign[]> {
	return db
		.select({ id: vanCampaigns.id, sheetTabName: vanCampaigns.sheetTabName })
		.from(vanCampaigns)
		.where(eq(vanCampaigns.sheetsEnabled, true))
		.orderBy(vanCampaigns.id);
}

/** The turf's campaign when that campaign keeps a Packet Tracker; null when it
 *  does not, or the turf is gone. */
async function trackedCampaignOf(db: Db, turfId: number): Promise<TrackedCampaign | null> {
	const [row] = await db
		.select({ id: vanCampaigns.id, sheetTabName: vanCampaigns.sheetTabName })
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(and(eq(vanTurfs.turfId, turfId), eq(vanCampaigns.sheetsEnabled, true)));
	return row ?? null;
}

/** Two runs' results as one, for a sync that covered several campaigns. */
function mergeResults(a: TrackerResult, b: TrackerResult): TrackerResult {
	return {
		filled: a.filled + b.filled,
		updated: a.updated + b.updated,
		failed: a.failed + b.failed,
		walkInsFilled: a.walkInsFilled + b.walkInsFilled,
		walkInsCleared: a.walkInsCleared + b.walkInsCleared,
		deferred: a.deferred + b.deferred,
		unrouted: a.unrouted + b.unrouted,
		unroutedRegions: [...a.unroutedRegions, ...b.unroutedRegions],
		assignmentsChanged: a.assignmentsChanged + b.assignmentsChanged,
		budgetLapsed: a.budgetLapsed || b.budgetLapsed,
		warnings: [...a.warnings, ...b.warnings],
	};
}

/**
 * One tracker run, under the lock: every campaign with sheets on, each with its
 * own rules and tab, or just the one turf's campaign for a nudge. Null when the
 * tracker is not configured, no such campaign has any rules, or another run
 * holds the lock.
 */
export async function runPacketTracker(
	db: Db,
	input: { timeBudgetMs: number; channelId: string; onlyTurfId?: number },
): Promise<TrackerResult | null> {
	const configured = sheetsClient();
	if (!configured.ok) return null;
	const campaigns =
		input.onlyTurfId === undefined
			? await trackedCampaigns(db)
			: [await trackedCampaignOf(db, input.onlyTurfId)].filter(
					(c): c is TrackedCampaign => c !== null,
				);
	const work: Array<{ campaign: TrackedCampaign; targets: SheetTarget[] }> = [];
	for (const campaign of campaigns) {
		const targets = await loadVanSheetTargets(db, campaign.id);
		if (targets.length > 0) work.push({ campaign, targets });
	}
	if (work.length === 0) return null;

	const deadline = Date.now() + input.timeBudgetMs;
	const run = await withSyncLock(db, TRACKER_LOCK, TRACKER_LOCK_TTL_MS, async () => {
		let merged: TrackerResult | null = null;
		for (const { campaign, targets } of work) {
			const result = await syncPacketTracker(db, {
				now: new Date(),
				client: configured.client,
				campaignId: campaign.id,
				targets,
				tabName: campaign.sheetTabName ?? undefined,
				// What is left of the run's budget: the campaigns share it, and a
				// campaign it does not reach waits for the next run.
				timeBudgetMs: Math.max(0, deadline - Date.now()),
				channelId: input.channelId,
				onlyTurfId: input.onlyTurfId,
			});
			merged = merged ? mergeResults(merged, result) : result;
		}
		return merged!;
	});
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
export function nudgePacketTracker(db: Db, turfId: number): void {
	void (async () => {
		// Checked once, up front: a null from runPacketTracker otherwise reads
		// as "the sync holds the lock" and the nudge would wait and retry for a
		// minute over a turf whose campaign keeps no tracker at all.
		if (!sheetsClient().ok || !(await trackedCampaignOf(db, turfId))) return;
		for (let attempt = 0; ; attempt++) {
			if (!sheetsClient().ok) return;
			const result = await runPacketTracker(db, {
				timeBudgetMs: NUDGE_BUDGET_MS,
				// Alerts belong to the scheduled sync; see above.
				channelId: '',
				onlyTurfId: turfId,
			});
			if (result !== null) {
				// Notes about this checkout — a packet the tracker does not list,
				// say — are recorded as told once written, so they are posted here
				// rather than dropped: the sync will not say them again.
				if (result.warnings.length > 0) {
					const { slackTurfChannelId } = await loadSettings(db);
					if (slackTurfChannelId) {
						await postAlert(slackTurfChannelId, result.warnings.join('\n'), LOG);
					}
				}
				return;
			}
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
		turfId: number;
		regionName: string;
		printedListNumber: string | null;
	}): Promise<string | null | undefined> => {
		try {
			const configured = sheetsClient();
			if (!configured.ok) return undefined;
			// No Packet Tracker for this turf's campaign: nothing to check, and
			// the volunteer on the porch does not wait on Google for it.
			const campaign = await trackedCampaignOf(db, turf.turfId);
			if (!campaign) return undefined;
			const targets = await loadVanSheetTargets(db, campaign.id);
			if (targets.length === 0) return undefined;
			return await liveAssignment(db, {
				client: configured.client,
				targets,
				tabName: campaign.sheetTabName ?? undefined,
				turf,
				timeBudgetMs: LIVE_CHECK_BUDGET_MS,
			});
		} catch (err) {
			console.warn(`${LOG} live packet tracker check failed:`, errMessage(err));
			return undefined;
		}
	};
}
