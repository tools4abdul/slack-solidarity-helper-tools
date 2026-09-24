// Did the doors actually move after someone said they walked the turf?
//
// This is the whole of the sync-back story (plan.md §2, "What syncs back to
// VAN"): nothing we build writes canvass results — MiniVAN does that natively
// when the volunteer hits Sync. So our job is not transport, it is
// **verification**. A volunteer marks turf complete, VAN re-cuts the region,
// and the door count either drops or it does not:
//
//   - **It dropped.** The knocks are in VAN. Nothing to say.
//   - **It did not.** Almost always this means MiniVAN was never synced and the
//     results are sitting on a phone in someone's pocket, where they help
//     nobody and will be lost when the app is reinstalled. That is the nudge
//     organizers actually asked for, and it is worth sending the same day.
//
// A re-cut does not update the walked route in place. It RETIRES it and returns
// new routes with new ids (schema.ts, verified live 2026-09-08; the same fact
// refresh-reconcile.ts is built on). So the count to compare against is usually
// on the route that REPLACED the one walked, found the same way the
// reconciliation finds it for a live claim: same map region, same name, and the
// only such route. This check used to read the walked route only, whose row
// stops updating the moment it is retired — so it could never measure anything.
//
// Pure: no DB, no Slack, no clock of its own. The decision of WHICH completions
// can be measured, what the delta is, and what to say is all here;
// door-delta-store.ts does the rows and the sending.

import { turfNameKey } from './refresh-reconcile.js';

/**
 * How long after a completion we keep waiting for a refresh to land.
 *
 * A delta needs evidence — a re-cut landing after the completion (see
 * `measuredAgainst`). With region re-cuts switched on that is usually the same
 * night; with them off it is whenever an organizer re-cuts the region by hand.
 * If a week goes by without one, the region was not re-cut, was archived, or
 * the turf came back renamed; in any of those cases the answer is not coming, and
 * a "did you sync?" nudge about turf someone walked last month is noise rather
 * than help.
 *
 * Unmeasurable completions are left with a NULL delta rather than a zero. Zero
 * is an accusation; null is "we did not check", and the organizer view already
 * tells those two apart.
 */
export const DELTA_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** A completed checkout, with the turf as VAN now reports it. */
export interface CompletionCandidate {
	checkoutId: number;
	mapRouteId: number;
	slackUserId: string;
	slackUserName: string;
	completedAt: string;
	/** VAN's door count when the turf was claimed. NULL on claims that predate
	 *  the column, which makes them unmeasurable rather than zero. */
	claimDoorCount: number | null;
	turfName: string;
	regionName: string;
	chapterId: number;
	/** VAN's door count now — or, on a retired route, when it was retired. */
	doorCount: number;
	/** VAN's `dateRefreshed` for this turf's region, as of the last catalog
	 *  read. The evidence that a re-cut has happened since the completion. */
	lastRefreshedAt: string | null;
	/** Where to look for the route that replaced this one. */
	mapRegionId: number;
	/** Set once VAN stopped returning the route — normally because a re-cut
	 *  replaced it. The count then comes from the replacement. */
	retiredAt: string | null;
}

/** A live route that may have replaced a retired, completed one. */
export interface ReplacementRoute {
	mapRouteId: number;
	mapRegionId: number;
	name: string;
	doorCount: number;
	lastRefreshedAt: string | null;
	/** When the catalog first saw this route id. A route first seen after the
	 *  completion was cut after it, which is evidence of a re-cut even when VAN
	 *  leaves `dateRefreshed` empty. */
	firstSeenAt: string;
}

export type DoorDeltaAction =
	/** A measured delta, with the nudge when it came out at zero. */
	| { kind: 'measured'; checkoutId: number; delta: number }
	| {
			kind: 'unsynced';
			checkoutId: number;
			slackUserId: string;
			delta: 0;
			text: string;
	  };

export interface DoorDeltaInput {
	completions: readonly CompletionCandidate[];
	/** Live routes in the regions of the retired completions. */
	replacements?: readonly ReplacementRoute[];
	now: Date;
	appUrl: string;
	horizonMs?: number;
}

/**
 * The candidate as it should be measured: unchanged for a route VAN still
 * returns, and carrying its replacement's count and evidence for one it
 * retired. Null when a retired route has no single replacement — VAN renamed or
 * split the turf, or nothing came back for it — because then there is nothing
 * honest to compare the claim-time count with. Left unmeasured rather than
 * guessed: a guess either credits doors nobody knocked or nudges someone who
 * synced.
 *
 * The evidence is the later of the replacement's `dateRefreshed` and when it
 * first appeared. Either one after the completion means the cut that produced
 * it came after the volunteer's knocks.
 */
export function measuredAgainst(
	candidate: CompletionCandidate,
	replacements: readonly ReplacementRoute[] = [],
): CompletionCandidate | null {
	if (candidate.retiredAt === null) return candidate;

	const key = turfNameKey(candidate.turfName);
	const matches = replacements.filter(
		(r) =>
			r.mapRegionId === candidate.mapRegionId &&
			r.mapRouteId !== candidate.mapRouteId &&
			turfNameKey(r.name) === key,
	);
	if (matches.length !== 1) return null;
	const replacement = matches[0]!;

	return {
		...candidate,
		doorCount: replacement.doorCount,
		lastRefreshedAt: laterOf(replacement.lastRefreshedAt, replacement.firstSeenAt),
	};
}

function laterOf(a: string | null, b: string | null): string | null {
	const ta = a ? Date.parse(a) : NaN;
	const tb = b ? Date.parse(b) : NaN;
	if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : b;
	if (Number.isNaN(tb)) return a;
	return ta >= tb ? a : b;
}

/**
 * Whether a refresh has landed since this turf was marked walked.
 *
 * Strictly after the completion: a `dateRefreshed` from before it describes a
 * re-cut that could not possibly have seen the volunteer's knocks, and reading
 * a delta off it would report zero for someone who synced perfectly.
 */
export function refreshLandedSince(candidate: CompletionCandidate): boolean {
	if (!candidate.lastRefreshedAt) return false;
	const refreshed = Date.parse(candidate.lastRefreshedAt);
	const completed = Date.parse(candidate.completedAt);
	if (Number.isNaN(refreshed) || Number.isNaN(completed)) return false;
	return refreshed > completed;
}

/**
 * Doors that left the turf across the claim.
 *
 * Clamped at zero. A turf can GROW between claim and completion — an organizer
 * widens the region, or a re-cut pulls in addresses from a neighbouring route —
 * and a negative "doors cleared" is not a thing anyone can act on. Reporting it
 * as zero is honest in the only way that matters here: no doors are confirmed
 * cleared, so the volunteer gets the same nudge as if nothing had moved.
 */
export function doorDelta(candidate: CompletionCandidate): number | null {
	if (candidate.claimDoorCount === null) return null;
	return Math.max(0, candidate.claimDoorCount - candidate.doorCount);
}

/**
 * The DM for a completion where nothing moved.
 *
 * Written as a question, not a verdict. The likeliest cause is an unsynced
 * phone, but "you didn't sync" is wrong often enough — a turf VAN re-cut
 * differently, a refresh that measured the wrong window — that stating it as
 * fact would make the one message a volunteer needs to act on feel like an
 * accusation they have to argue with. So: what we saw, what it usually means,
 * and the one thing to check.
 */
export function renderUnsyncedNudge(input: {
	turfName: string;
	regionName: string;
	chapterId: number;
	appUrl: string;
}): string {
	const { turfName, regionName, chapterId, appUrl } = input;
	const where = regionName ? ` — ${regionName}` : '';
	return [
		':satellite_antenna: *Did MiniVAN finish syncing?*',
		'',
		`*${turfName}*${where}`,
		'',
		"You marked this turf walked, but VAN's door count for it has not moved — which usually " +
			'means the canvass results are still on your phone.',
		'Open MiniVAN and tap *Sync* while you have signal. It takes a few seconds, and until it ' +
			'runs nobody else can see the doors you knocked.',
		'',
		`If you already synced, nothing is wrong — VAN sometimes recounts an area in a way that ` +
			`leaves the number flat. <${appUrl}/turfs?chapter=${chapterId}|Open turf checkout>`,
	].join('\n');
}

/**
 * What to stamp, and who to nudge.
 *
 * Only completions a refresh has actually overtaken are measured. Everything
 * else is left alone — either the refresh has not landed yet (check again next
 * tick) or the horizon has passed and it never will, and neither is a fact
 * worth writing to the ledger.
 */
export function planDoorDeltas(input: DoorDeltaInput): DoorDeltaAction[] {
	const { completions, now, appUrl } = input;
	const horizonMs = input.horizonMs ?? DELTA_HORIZON_MS;
	const actions: DoorDeltaAction[] = [];

	for (const candidate of completions) {
		const completedMs = Date.parse(candidate.completedAt);
		if (Number.isNaN(completedMs) || now.getTime() - completedMs > horizonMs) continue;

		const measured = measuredAgainst(candidate, input.replacements);
		if (!measured || !refreshLandedSince(measured)) continue;

		const delta = doorDelta(measured);
		if (delta === null) continue;

		if (delta > 0) {
			actions.push({ kind: 'measured', checkoutId: candidate.checkoutId, delta });
			continue;
		}

		actions.push({
			kind: 'unsynced',
			checkoutId: candidate.checkoutId,
			slackUserId: candidate.slackUserId,
			delta: 0,
			text: renderUnsyncedNudge({
				turfName: candidate.turfName,
				regionName: candidate.regionName,
				chapterId: candidate.chapterId,
				appUrl,
			}),
		});
	}

	return actions;
}
