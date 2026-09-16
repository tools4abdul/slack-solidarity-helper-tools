// The rules of checking turf in and out. Pure — no DB, no VAN, no clock of its
// own; `now` is always passed in.
//
// The storage layer enforces the one rule that must never be violated: a
// partial unique index on van_turf_checkouts (map_route_id) WHERE released_at
// IS NULL AND completed_at IS NULL, so two racing claims cannot both win even
// if this module's checks are somehow bypassed. Everything here is the
// *friendly* layer on top of that — deciding what to show, and refusing a
// claim with a reason a volunteer can act on rather than letting the insert
// blow up.
//
// Expiry is evaluated on READ as well as by the nightly sweep. If it were only
// swept, a claim that lapsed at 3am would still render as held until the sweep
// ran, and a volunteer standing in front of that turf would be told it was
// taken by someone who has long since gone home.

import type { TurfStatus } from './turf-status.js';

/** The turf fields the rules actually depend on. Deliberately narrow so the
 *  DB row shape can change without touching this file. */
export interface TurfSnapshot {
	mapRouteId: number;
	/** The MiniVAN list number. Null means VAN has the route but nobody has
	 *  generated its printed list — see `canClaim`. */
	printedListNumber: string | null;
	retiredAt: string | null;
	/** Canvassers VAN reports for this turf, when an organizer distributed it
	 *  outside this app. Non-null = already in someone's hands. */
	vanDistributedTo: string | null;
	/** Doors VAN still shows as uncontacted. */
	doorCount: number;
}

export interface ClaimSnapshot {
	mapRouteId: number;
	slackUserId: string;
	slackUserName: string;
	claimedAt: string;
	expiresAt: string;
	releasedAt: string | null;
	completedAt: string | null;
}

export const DEFAULT_CLAIM_TTL_HOURS = 48;
export const DEFAULT_MAX_CONCURRENT_CLAIMS = 2;

// Bounds for the admin-tunable versions of the two above (Story 7.4). They sit
// here rather than in a settings module for the same reason ticker-speed.ts
// keeps its own: this file is outside $lib/server, so the settings editor, the
// volunteer page and the claim route can all import them without dragging
// drizzle into the client bundle.

/** Below an hour nobody can walk a turf before it lapses, which makes the whole
 *  checkout pointless rather than merely strict. */
export const MIN_CLAIM_TTL_HOURS = 1;
/** A week. Past this a claim stops being a checkout and becomes an assignment
 *  nobody revisits — and the turf sits out of the pool that whole time. */
export const MAX_CLAIM_TTL_HOURS = 168;

/** Zero would mean nobody may claim anything, which is a way to break turf
 *  checkout by typing in a settings box rather than a setting anyone wants. */
export const MIN_CONCURRENT_CLAIMS = 1;
/** Generous. The cap exists so one volunteer cannot take a neighbourhood; past
 *  ten it is not capping anything. */
export const MAX_CONCURRENT_CLAIMS = 10;

/**
 * Turn the admin-configured values into options `canClaim` can use.
 *
 * Every caller of `canClaim` and `claimTurf` goes through this, so the page,
 * the map's viewport endpoint, the claim route and the `/turfs` Slack command
 * cannot disagree about how long a claim lasts or how many a volunteer may
 * hold. With real settings a disagreement is visible: turf that shows claimable
 * and refuses on click, or the same person getting different rules depending on
 * whether they opened the page or typed the command.
 *
 * Clamps rather than rejects. These arrive from a validated settings write, so
 * an out-of-range value means a row predating the bounds or hand-edited SQL,
 * and neither is worth failing a volunteer's page load over.
 */
export function resolveClaimOptions(
	config: { ttlHours?: number | null; maxConcurrentClaims?: number | null } = {},
): Required<ClaimOptions> {
	return {
		ttlHours: clamp(
			config.ttlHours,
			MIN_CLAIM_TTL_HOURS,
			MAX_CLAIM_TTL_HOURS,
			DEFAULT_CLAIM_TTL_HOURS,
		),
		maxConcurrentClaims: clamp(
			config.maxConcurrentClaims,
			MIN_CONCURRENT_CLAIMS,
			MAX_CONCURRENT_CLAIMS,
			DEFAULT_MAX_CONCURRENT_CLAIMS,
		),
	};
}

function clamp(
	value: number | null | undefined,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function toTime(iso: string): number {
	const t = Date.parse(iso);
	// An unparseable timestamp must not read as "not yet expired" — that would
	// make a corrupt row into a turf nobody can ever reclaim. Treat it as long
	// past instead, so the sweep and the read path both free it.
	return Number.isNaN(t) ? -Infinity : t;
}

/** True when a claim is still holding the turf at `now`: not released, not
 *  completed, not lapsed. */
export function isActive(claim: ClaimSnapshot, now: Date): boolean {
	if (claim.releasedAt !== null || claim.completedAt !== null) return false;
	return toTime(claim.expiresAt) > now.getTime();
}

/** The one claim currently holding `mapRouteId`, if any.
 *
 *  Returns the most recent when several qualify. That should be impossible —
 *  the partial unique index forbids it — but a defensive pick beats returning
 *  an arbitrary row if a migration ever lands the index late. */
export function activeClaimFor(
	mapRouteId: number,
	claims: readonly ClaimSnapshot[],
	now: Date,
): ClaimSnapshot | null {
	let best: ClaimSnapshot | null = null;
	for (const claim of claims) {
		if (claim.mapRouteId !== mapRouteId) continue;
		if (!isActive(claim, now)) continue;
		if (best === null || toTime(claim.claimedAt) > toTime(best.claimedAt)) best = claim;
	}
	return best;
}

/** Claims `slackUserId` is currently holding, across all turf. */
export function activeClaimsFor(
	slackUserId: string,
	claims: readonly ClaimSnapshot[],
	now: Date,
): ClaimSnapshot[] {
	return claims.filter((c) => c.slackUserId === slackUserId && isActive(c, now));
}

/**
 * The raw status of a turf for a given viewer.
 *
 * Raw meaning organizer-facing: `held-by-other` and `assigned-in-van` are still
 * distinct here. Collapsing them for volunteers and stripping the holder's name
 * is `visibleTurfState`'s job in turf-status.ts, and it happens later, in the
 * load function, right before serialising.
 */
export function turfStatus(
	turf: TurfSnapshot,
	claims: readonly ClaimSnapshot[],
	viewerSlackUserId: string,
	now: Date,
): TurfStatus {
	const active = activeClaimFor(turf.mapRouteId, claims, now);
	if (active) {
		return active.slackUserId === viewerSlackUserId ? 'held-by-you' : 'held-by-other';
	}
	// Checked after our own ledger: if a volunteer holds it here, that's the
	// truth we want to show them, even if VAN also lists a canvasser.
	if (turf.vanDistributedTo) return 'assigned-in-van';
	return 'available';
}

export type ClaimRefusalReason =
	| 'retired'
	| 'no-list-number'
	| 'no-doors-left'
	| 'already-held'
	| 'assigned-in-van'
	| 'at-claim-limit';

export type ClaimDecision =
	{ ok: true; expiresAt: string } | { ok: false; reason: ClaimRefusalReason; message: string };

export interface ClaimOptions {
	ttlHours?: number;
	maxConcurrentClaims?: number;
}

/** When a claim made at `now` should lapse. */
export function expiryFor(now: Date, ttlHours = DEFAULT_CLAIM_TTL_HOURS): string {
	return new Date(now.getTime() + ttlHours * 3_600_000).toISOString();
}

/**
 * Whether `slackUserId` may claim `turf` right now, and why not if not.
 *
 * Every refusal carries a message written for the volunteer, because these are
 * the strings that appear on screen — a claim that fails with "error" sends
 * someone to an organizer, and the whole point is to stop doing that.
 */
export function canClaim(
	turf: TurfSnapshot,
	claims: readonly ClaimSnapshot[],
	slackUserId: string,
	now: Date,
	options: ClaimOptions = {},
): ClaimDecision {
	const {
		ttlHours = DEFAULT_CLAIM_TTL_HOURS,
		maxConcurrentClaims = DEFAULT_MAX_CONCURRENT_CLAIMS,
	} = options;

	if (turf.retiredAt !== null) {
		return {
			ok: false,
			reason: 'retired',
			message: "This turf isn't in VAN any more — an organizer has re-cut the area.",
		};
	}

	// A turf without a list number gives the volunteer nothing to type into
	// MiniVAN, so claiming it would be a dead end. Refuse early and clearly
	// rather than handing out a blank code.
	if (!turf.printedListNumber) {
		return {
			ok: false,
			reason: 'no-list-number',
			message: "This turf doesn't have a MiniVAN list number yet. An organizer needs to export it.",
		};
	}

	if (turf.doorCount <= 0) {
		return {
			ok: false,
			reason: 'no-doors-left',
			message: 'Every door on this turf has already been knocked.',
		};
	}

	const active = activeClaimFor(turf.mapRouteId, claims, now);
	if (active) {
		return active.slackUserId === slackUserId
			? { ok: false, reason: 'already-held', message: "You've already got this one." }
			: {
					ok: false,
					reason: 'already-held',
					message: "Someone's already walking this one. Try another nearby.",
				};
	}

	if (turf.vanDistributedTo) {
		return {
			ok: false,
			reason: 'assigned-in-van',
			message: 'An organizer has already sent this turf to someone directly.',
		};
	}

	// Checked last: it's the only refusal the volunteer can immediately fix, so
	// they shouldn't hit it while the turf was unclaimable anyway.
	if (activeClaimsFor(slackUserId, claims, now).length >= maxConcurrentClaims) {
		return {
			ok: false,
			reason: 'at-claim-limit',
			message: `You can hold ${maxConcurrentClaims} turfs at once. Finish or give one back first.`,
		};
	}

	return { ok: true, expiresAt: expiryFor(now, ttlHours) };
}

/** Claims that have lapsed and need a `released_at` stamp. The nightly sweep's
 *  input; the read path doesn't need it, because `isActive` already ignores
 *  them. */
export function lapsedClaims(claims: readonly ClaimSnapshot[], now: Date): ClaimSnapshot[] {
	return claims.filter(
		(c) => c.releasedAt === null && c.completedAt === null && toTime(c.expiresAt) <= now.getTime(),
	);
}

/** Whole hours left on a claim, rounded up, floored at zero. What the UI shows
 *  as "yours for N more hours". */
export function hoursRemaining(claim: ClaimSnapshot, now: Date): number {
	const ms = toTime(claim.expiresAt) - now.getTime();
	return ms <= 0 ? 0 : Math.ceil(ms / 3_600_000);
}
