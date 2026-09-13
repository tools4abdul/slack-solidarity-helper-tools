// Stamping confirmed door deltas, and nudging the volunteers whose came out at
// zero.
//
// The rules and the wording live in $lib/van/door-delta.ts and are pure; this
// file loads the completions and writes the result. Called from
// /api/internal/van-sync after the catalog and the reconciliation, because both
// halves of the comparison come from that catalog read: van_turfs.doorCount is
// what VAN says now, and van_turfs.lastRefreshedAt is the evidence that a
// re-cut has happened since the turf was marked walked.
//
// Ordering: the stamp is written first, then the DM is sent best-effort. The
// stamp is the measurement — the organizer view reads it, and Story 9 will read
// it again — while the DM is a nudge on top of it. Making the measurement wait
// on Slack would leave a completion permanently unchecked because someone's
// account was deactivated, and the stamp is also what stops the nudge repeating
// on all 37 ticks of the day.

import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { sendDm } from '../slack-dm.js';
import {
	DELTA_HORIZON_MS,
	planDoorDeltas,
	type CompletionCandidate,
} from '../../van/door-delta.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface DoorDeltaResult {
	/** Completions whose delta was measured and stamped. */
	measured: number;
	/** Of those, the ones that came out at zero — the probable missed syncs. */
	unsynced: number;
	/** Doors confirmed cleared across everything stamped this run. */
	doorsCleared: number;
	/** Nudges Slack would not take. The stamp still stands; see the header. */
	dmFailed: number;
}

const EMPTY: DoorDeltaResult = { measured: 0, unsynced: 0, doorsCleared: 0, dmFailed: 0 };

export interface DoorDeltaOptions {
	now: Date;
	appUrl: string;
	horizonMs?: number;
}

/**
 * Completions still waiting on a delta.
 *
 * The SQL filter is deliberately looser than the real rule — completed,
 * unstamped, and inside the horizon — and the pure predicate decides the rest
 * (has a refresh landed since, do we know what the turf started at). Same split
 * as expiry-warning-store.ts, and for the same reason: the rule an organizer
 * would ask about is answerable from a unit test rather than from a query plan.
 */
async function loadCandidates(db: Db, since: string): Promise<CompletionCandidate[]> {
	return db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			completedAt: vanTurfCheckouts.completedAt,
			claimDoorCount: vanTurfCheckouts.claimDoorCount,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			doorCount: vanTurfs.doorCount,
			lastRefreshedAt: vanTurfs.lastRefreshedAt,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				isNotNull(vanTurfCheckouts.completedAt),
				isNull(vanTurfCheckouts.confirmedDoorDelta),
				gte(vanTurfCheckouts.completedAt, since),
			),
		) as unknown as Promise<CompletionCandidate[]>;
}

/**
 * Check every recent completion against VAN, and tell anyone whose knocks have
 * not landed.
 *
 * Never throws. It runs inside the catalog sync, after rows are already
 * written; a verification pass that failed the whole request would turn "we
 * could not check" into a red cron run and a catalog that looks unsynced.
 */
export async function stampDoorDeltas(db: Db, options: DoorDeltaOptions): Promise<DoorDeltaResult> {
	const { now, appUrl } = options;
	const horizonMs = options.horizonMs ?? DELTA_HORIZON_MS;
	const result: DoorDeltaResult = { ...EMPTY };

	let candidates: CompletionCandidate[];
	try {
		candidates = await loadCandidates(db, new Date(now.getTime() - horizonMs).toISOString());
	} catch (err) {
		console.error(`${LOG} could not read completions to verify:`, errMessage(err));
		return result;
	}

	const actions = planDoorDeltas({ completions: candidates, now, appUrl, horizonMs });

	for (const action of actions) {
		try {
			await db
				.update(vanTurfCheckouts)
				.set({ confirmedDoorDelta: action.delta })
				.where(eq(vanTurfCheckouts.id, action.checkoutId));
			result.measured += 1;
			result.doorsCleared += action.delta;

			if (action.kind === 'unsynced') {
				result.unsynced += 1;
				if (!(await sendDm(action.slackUserId, action.text, LOG))) result.dmFailed += 1;
				console.log(`${LOG} completion with no door movement: checkout=${action.checkoutId}`);
			}
		} catch (err) {
			// One completion's check must not take the rest down with it.
			console.error(`${LOG} could not stamp door delta for ${action.checkoutId}:`, errMessage(err));
		}
	}

	if (result.measured > 0) {
		console.log(
			`${LOG} door deltas: measured=${result.measured} cleared=${result.doorsCleared} ` +
				`unsynced=${result.unsynced} dmFailed=${result.dmFailed}`,
		);
	}
	return result;
}
