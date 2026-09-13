// Applying what refresh-reconcile.ts decided: rows, and the DMs that go with
// them.
//
// The rules and the wording live in $lib/van/refresh-reconcile.ts and are pure;
// this file loads the state they judge and writes the result. Called from
// /api/internal/van-sync straight after the catalog, because the catalog read
// is what makes the comparison possible — it is the moment VAN's current answer
// and our record of what we told a volunteer sit side by side.
//
// Ordering rules, which differ per action and deliberately so:
//
//   - **A list-number change DMs first, then stamps.** The DM is the entire
//     product: nothing else tells a volunteer their number stopped working.
//     Leaving `issuedListNumber` alone until Slack accepts it means a Slack
//     outage retries half an hour later, in the shape expiry-warning-store.ts
//     already uses.
//   - **Everything else writes first, then DMs.** A ledger that only settles
//     when Slack is up is a ledger that can be held open by a deactivated
//     account, and for these actions the turf page already shows the outcome —
//     the DM is a courtesy on top of a state change, not the state change.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { sendDm } from '../slack-dm.js';
import { expiryFor, DEFAULT_CLAIM_TTL_HOURS } from '../../van/checkout.js';
import {
	planReconciliation,
	renderRecutGone,
	type ReconcileClaim,
	type RecutClaim,
	type ReplacementTurf,
} from '../../van/refresh-reconcile.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface ReconcileResult {
	/** Holders told their MiniVAN list number changed. */
	listNumbersChanged: number;
	/** Claims that had no record of an issued number and now do. Silent. */
	numbersAdopted: number;
	/** Claims released because the turf came back with no doors in it. */
	walkedOut: number;
	/** Live claims released because their route is retired. */
	retiredReleased: number;
	/** Re-cut claims handed the route that replaced theirs. */
	recutReplaced: number;
	/** Re-cut claims with nothing to hand back. */
	recutGone: number;
	/** Re-cut claims too old to be worth a message. Stamped only. */
	recutStale: number;
	/** DMs Slack would not take. The row state still stands; see the header. */
	dmFailed: number;
	/** Live claims on turf VAN has no printed list for. Counted rather than
	 *  messaged — see planReconciliation. */
	missingListNumber: number;
}

const EMPTY: ReconcileResult = {
	listNumbersChanged: 0,
	numbersAdopted: 0,
	walkedOut: 0,
	retiredReleased: 0,
	recutReplaced: 0,
	recutGone: 0,
	recutStale: 0,
	dmFailed: 0,
	missingListNumber: 0,
};

export interface ReconcileOptions {
	now: Date;
	appUrl: string;
	/** TTL for a claim moved onto a replacement route. Defaults to the same
	 *  value a fresh claim gets, because that is what it is: the volunteer has
	 *  new turf, new doors and the whole window to walk it. */
	ttlHours?: number;
}

/** Live claims, with the turf they point at. */
async function loadLiveClaims(db: Db): Promise<ReconcileClaim[]> {
	const rows = await db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			issuedListNumber: vanTurfCheckouts.issuedListNumber,
			mapRegionId: vanTurfs.mapRegionId,
			chapterId: vanTurfs.chapterId,
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
			printedListNumber: vanTurfs.printedListNumber,
			doorCount: vanTurfs.doorCount,
			retiredAt: vanTurfs.retiredAt,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt)));

	return rows.map((row) => ({
		checkoutId: row.checkoutId,
		mapRouteId: row.mapRouteId,
		slackUserId: row.slackUserId,
		slackUserName: row.slackUserName,
		issuedListNumber: row.issuedListNumber,
		turf: {
			mapRouteId: row.mapRouteId,
			mapRegionId: row.mapRegionId,
			chapterId: row.chapterId,
			name: row.name,
			regionName: row.regionName,
			printedListNumber: row.printedListNumber,
			doorCount: row.doorCount,
			retiredAt: row.retiredAt,
		},
	}));
}

/**
 * Claims the catalog sync released because VAN stopped returning their route.
 *
 * Unstamped only. `recutNotifiedAt` is what keeps this from being a permanent
 * backlog: a released claim stays released forever, and the sync runs 37 times
 * a day.
 */
async function loadRecutClaims(db: Db): Promise<RecutClaim[]> {
	const rows = await db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			releasedAt: vanTurfCheckouts.releasedAt,
			mapRegionId: vanTurfs.mapRegionId,
			chapterId: vanTurfs.chapterId,
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(eq(vanTurfCheckouts.releaseReason, 'retired'), isNull(vanTurfCheckouts.recutNotifiedAt)),
		);

	return rows
		.filter((row): row is typeof row & { releasedAt: string } => row.releasedAt !== null)
		.map((row) => ({
			checkoutId: row.checkoutId,
			mapRouteId: row.mapRouteId,
			slackUserId: row.slackUserId,
			slackUserName: row.slackUserName,
			releasedAt: row.releasedAt,
			turf: {
				mapRegionId: row.mapRegionId,
				chapterId: row.chapterId,
				name: row.name,
				regionName: row.regionName,
			},
		}));
}

/** Candidate replacements, scoped to the regions that actually lost a claim. */
async function loadReplacements(db: Db, mapRegionIds: number[]): Promise<ReplacementTurf[]> {
	if (mapRegionIds.length === 0) return [];

	const rows = await db
		.select()
		.from(vanTurfs)
		.where(and(inArray(vanTurfs.mapRegionId, mapRegionIds), isNull(vanTurfs.retiredAt)));
	if (rows.length === 0) return [];

	const claimed = await db
		.select({ mapRouteId: vanTurfCheckouts.mapRouteId })
		.from(vanTurfCheckouts)
		.where(
			and(
				inArray(
					vanTurfCheckouts.mapRouteId,
					rows.map((r) => r.mapRouteId),
				),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	const claimedIds = new Set(claimed.map((c) => c.mapRouteId));

	return rows.map((row) => ({
		mapRouteId: row.mapRouteId,
		mapRegionId: row.mapRegionId,
		name: row.name,
		printedListNumber: row.printedListNumber,
		doorCount: row.doorCount,
		retiredAt: row.retiredAt,
		claimed: claimedIds.has(row.mapRouteId),
	}));
}

/** Stamp a re-cut claim as dealt with, whether or not its DM landed. */
async function markRecutNotified(db: Db, checkoutId: number, at: string): Promise<void> {
	await db
		.update(vanTurfCheckouts)
		.set({ recutNotifiedAt: at })
		.where(eq(vanTurfCheckouts.id, checkoutId));
}

/**
 * Bring every live claim back into line with what VAN now says.
 *
 * Never throws. This runs inside the catalog sync, after rows are already
 * written; a reconciliation that failed the whole request would turn a
 * cosmetic problem into a red cron run and a catalog that looks unsynced.
 */
export async function reconcileClaims(db: Db, options: ReconcileOptions): Promise<ReconcileResult> {
	const { now, appUrl } = options;
	const ttlHours = options.ttlHours ?? DEFAULT_CLAIM_TTL_HOURS;
	const nowIso = now.toISOString();
	const result: ReconcileResult = { ...EMPTY };

	let claims: ReconcileClaim[];
	let recut: RecutClaim[];
	let replacements: ReplacementTurf[];
	try {
		claims = await loadLiveClaims(db);
		recut = await loadRecutClaims(db);
		// Inside the guard with the other two: this function is documented as
		// never throwing, and the sync that calls it has already written its
		// catalog rows.
		replacements = await loadReplacements(db, [...new Set(recut.map((c) => c.turf.mapRegionId))]);
	} catch (err) {
		console.error(`${LOG} could not read claims to reconcile:`, errMessage(err));
		return result;
	}

	result.missingListNumber = claims.filter(
		(c) => c.turf.retiredAt === null && c.turf.printedListNumber === null,
	).length;

	const actions = planReconciliation({ claims, recut, replacements, now, appUrl });

	for (const action of actions) {
		try {
			switch (action.kind) {
				case 'adopt-list-number': {
					await db
						.update(vanTurfCheckouts)
						.set({ issuedListNumber: action.listNumber })
						.where(eq(vanTurfCheckouts.id, action.checkoutId));
					result.numbersAdopted += 1;
					break;
				}

				case 'list-number-changed': {
					// DM first: the stamp is what stops the message repeating, so
					// stamping before a failed send would swallow the one thing the
					// volunteer needs to know.
					if (!(await sendDm(action.slackUserId, action.text, LOG))) {
						result.dmFailed += 1;
						break;
					}
					await db
						.update(vanTurfCheckouts)
						.set({ issuedListNumber: action.listNumber })
						.where(eq(vanTurfCheckouts.id, action.checkoutId));
					result.listNumbersChanged += 1;
					console.log(
						`${LOG} list number changed: checkout=${action.checkoutId} number=${action.listNumber}`,
					);
					break;
				}

				case 'walked-out': {
					// Released whether or not the DM lands. There are no doors left in
					// this turf, so nobody is waiting on it — but a claim that can only
					// be closed by a successful Slack call is one a deactivated account
					// holds until its TTL runs out.
					await db
						.update(vanTurfCheckouts)
						.set({ releasedAt: nowIso, releaseReason: 'walked-out' })
						.where(eq(vanTurfCheckouts.id, action.checkoutId));
					result.walkedOut += 1;
					if (!(await sendDm(action.slackUserId, action.text, LOG))) result.dmFailed += 1;
					console.log(`${LOG} walked out: checkout=${action.checkoutId}`);
					break;
				}

				case 'release-retired': {
					await db
						.update(vanTurfCheckouts)
						.set({ releasedAt: nowIso, releaseReason: 'retired' })
						.where(eq(vanTurfCheckouts.id, action.checkoutId));
					result.retiredReleased += 1;
					break;
				}

				case 'recut-replaced': {
					// The insert can lose two ways, and the partial unique index
					// settles both: someone browsing the page took the replacement
					// between the catalog write and here, or two re-cut claims in one
					// region paired to the same route (two retirements of the same turf
					// name, waiting since different syncs). Losing is not an error — it
					// just means the honest message is the other one.
					//
					// The per-volunteer claim cap is deliberately NOT re-checked. This
					// is the claim they already had, pointed at the route that replaced
					// it; refusing it because an admin lowered the cap since would take
					// turf off someone mid-walk to enforce a limit they were inside
					// when they started.
					const inserted = await db
						.insert(vanTurfCheckouts)
						.values({
							mapRouteId: action.replacement.mapRouteId,
							slackUserId: action.slackUserId,
							slackUserName: action.slackUserName,
							claimedAt: nowIso,
							expiresAt: expiryFor(now, ttlHours),
							issuedListNumber: action.replacement.printedListNumber,
							// Its own baseline, not the retired route's: this is a
							// different cut with a different set of doors, and measuring
							// the new turf against the old one's count would report a
							// delta nobody walked.
							claimDoorCount: action.replacement.doorCount,
						})
						.onConflictDoNothing()
						.returning({ id: vanTurfCheckouts.id });

					await markRecutNotified(db, action.checkoutId, nowIso);

					if (inserted.length === 0) {
						const claim = recut.find((c) => c.checkoutId === action.checkoutId);
						const text = claim ? renderRecutGone({ turf: claim.turf, appUrl }) : action.text;
						if (!(await sendDm(action.slackUserId, text, LOG))) result.dmFailed += 1;
						result.recutGone += 1;
						break;
					}

					result.recutReplaced += 1;
					if (!(await sendDm(action.slackUserId, action.text, LOG))) result.dmFailed += 1;
					console.log(
						`${LOG} re-cut: checkout=${action.checkoutId} moved to route=${action.replacement.mapRouteId}`,
					);
					break;
				}

				case 'recut-gone': {
					await markRecutNotified(db, action.checkoutId, nowIso);
					result.recutGone += 1;
					if (!(await sendDm(action.slackUserId, action.text, LOG))) result.dmFailed += 1;
					break;
				}

				case 'recut-stale': {
					await markRecutNotified(db, action.checkoutId, nowIso);
					result.recutStale += 1;
					break;
				}
			}
		} catch (err) {
			// One claim's reconciliation must not take the rest down with it.
			console.error(`${LOG} reconcile step failed (${action.kind}):`, errMessage(err));
		}
	}

	const touched =
		result.listNumbersChanged +
		result.walkedOut +
		result.retiredReleased +
		result.recutReplaced +
		result.recutGone;
	if (touched > 0 || result.dmFailed > 0) {
		console.log(
			`${LOG} reconcile: numbers=${result.listNumbersChanged} walkedOut=${result.walkedOut} ` +
				`retired=${result.retiredReleased} recut=${result.recutReplaced}/${result.recutGone} ` +
				`dmFailed=${result.dmFailed}`,
		);
	}
	return result;
}
