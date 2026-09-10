// The database side of checking turf in and out.
//
// The rules live in $lib/van/checkout.ts and are pure; this file is the part
// that touches rows. It exists as a module rather than inside the route
// handlers because all three endpoints need the same load-decide-write shape,
// and three copies of it would eventually disagree about one of the checks.
//
// The collision guarantee is NOT here. It is the partial unique index on
// van_turf_checkouts (map_route_id) WHERE released_at IS NULL AND completed_at
// IS NULL. `canClaim` is the friendly layer that refuses with a reason a
// volunteer can act on; the index is what makes two simultaneous clicks
// resolve to exactly one winner even if the friendly layer is bypassed.

import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { chunked } from './sql-chunk.js';
import {
	canClaim,
	type ClaimOptions,
	type ClaimSnapshot,
	type TurfSnapshot,
} from '../../van/checkout.js';

type Db = ReturnType<typeof drizzle>;

export type ClaimResult =
	| { ok: true; expiresAt: string; printedListNumber: string }
	| { ok: false; status: 404 | 409; message: string };

export type ReleaseResult = { ok: true } | { ok: false; status: 404 | 409; message: string };

/** The claims `canClaim` needs to judge this request.
 *
 *  Two sets, both required: every active claim on the turf being asked for
 *  (is it already taken?), and every active claim held by this user anywhere
 *  (are they at their limit?). The second is deliberately NOT chapter-scoped —
 *  someone holding turf in two counties is holding two turfs, and the cap is
 *  per person.
 *
 *  Filtered in SQL rather than in memory. The predicate is narrow and both
 *  columns are indexed, and the alternative — reading every active claim in
 *  the campaign on every claim attempt — grows with the size of a canvass day
 *  for no benefit. */
async function relevantClaims(
	db: Db,
	mapRouteId: number,
	slackUserId: string,
): Promise<ClaimSnapshot[]> {
	const rows = await db
		.select()
		.from(vanTurfCheckouts)
		.where(
			and(
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				or(
					eq(vanTurfCheckouts.mapRouteId, mapRouteId),
					eq(vanTurfCheckouts.slackUserId, slackUserId),
				),
			),
		);
	return rows.map((r) => ({
		mapRouteId: r.mapRouteId,
		slackUserId: r.slackUserId,
		slackUserName: r.slackUserName,
		claimedAt: r.claimedAt,
		expiresAt: r.expiresAt,
		releasedAt: r.releasedAt,
		completedAt: r.completedAt,
	}));
}

/** Claim `mapRouteId` for `session`. */
export async function claimTurf(
	db: Db,
	input: {
		mapRouteId: number;
		slackUserId: string;
		slackUserName: string;
		now: Date;
		options?: ClaimOptions;
	},
): Promise<ClaimResult> {
	const { mapRouteId, slackUserId, slackUserName, now } = input;

	const [row] = await db.select().from(vanTurfs).where(eq(vanTurfs.mapRouteId, mapRouteId));
	if (!row) return { ok: false, status: 404, message: 'That turf no longer exists.' };

	const snapshot: TurfSnapshot = {
		mapRouteId: row.mapRouteId,
		printedListNumber: row.printedListNumber,
		retiredAt: row.retiredAt,
		vanDistributedTo: row.vanDistributedTo,
		doorCount: row.doorCount,
	};

	const claims = await relevantClaims(db, mapRouteId, slackUserId);
	const decision = canClaim(snapshot, claims, slackUserId, now, input.options ?? {});
	if (!decision.ok) return { ok: false, status: 409, message: decision.message };

	// Clear a lapsed claim before inserting over it.
	//
	// The partial unique index is `WHERE released_at IS NULL AND completed_at
	// IS NULL` — it knows nothing about expiry. `isActive` does. So a claim
	// that has expired but has not yet been swept is invisible to `canClaim`
	// (which just said this turf is free, and to every read path, which renders
	// it green and claimable) while still occupying the index. Without this the
	// insert below collides and the volunteer is told "someone claimed this a
	// moment before you did" about a person who went home hours ago — and it
	// keeps happening until the next sweep, which overnight is up to an hour
	// away. That is the failure the read-time expiry check exists to prevent,
	// leaking in through the write path.
	//
	// `relevantClaims` already filtered to unreleased, uncompleted rows, so any
	// row still holding this turf after `canClaim` approved is necessarily
	// expired — the check below is just to keep the write off the hot path.
	//
	// The `lte` on expiresAt is what makes this safe against a concurrent
	// claim: a fresh one inserted since our read has expiresAt in the future
	// and is left alone, so that race still resolves to an honest 409 rather
	// than us releasing a live claim. ISO-8601 UTC compares correctly as text,
	// and every writer here uses toISOString(). A corrupt timestamp is not
	// cleared and is left to sweepExpiredClaims, which parses in JS.
	const nowIso = now.toISOString();
	if (claims.some((c) => c.mapRouteId === mapRouteId)) {
		await db
			.update(vanTurfCheckouts)
			.set({ releasedAt: nowIso, releaseReason: 'expired' })
			.where(
				and(
					eq(vanTurfCheckouts.mapRouteId, mapRouteId),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
					lte(vanTurfCheckouts.expiresAt, nowIso),
				),
			);
	}

	// onConflictDoNothing + returning() is the race resolver: the partial
	// unique index rejects the second of two simultaneous inserts, and the
	// loser gets zero rows back rather than an exception to parse.
	const inserted = await db
		.insert(vanTurfCheckouts)
		.values({
			mapRouteId,
			slackUserId,
			slackUserName,
			claimedAt: nowIso,
			expiresAt: decision.expiresAt,
		})
		.onConflictDoNothing()
		.returning({ id: vanTurfCheckouts.id });

	if (inserted.length === 0) {
		return {
			ok: false,
			status: 409,
			message: 'Someone claimed this turf a moment before you did. Try another nearby.',
		};
	}

	console.log(`[van] claim: user=${slackUserId} route=${mapRouteId} expires=${decision.expiresAt}`);
	// The list number is issued here and nowhere else — see the note on
	// TurfView.printedListNumber. `canClaim` has already refused a turf without
	// one, so this is non-null by construction.
	return {
		ok: true,
		expiresAt: decision.expiresAt,
		printedListNumber: row.printedListNumber!,
	};
}

/** Give turf back, or mark it walked. `reason` distinguishes the two in the
 *  ledger; 'complete' stamps completedAt instead of releasedAt so the row
 *  records that the doors were actually knocked. */
export async function endClaim(
	db: Db,
	input: {
		mapRouteId: number;
		slackUserId: string;
		now: Date;
		kind: 'release' | 'complete';
	},
): Promise<ReleaseResult> {
	const { mapRouteId, slackUserId, now, kind } = input;
	const stamp =
		kind === 'complete'
			? { completedAt: now.toISOString() }
			: { releasedAt: now.toISOString(), releaseReason: 'volunteer' as const };

	// Scoped to this user's own active claim, so one volunteer cannot release
	// another's turf by posting their route id.
	const updated = await db
		.update(vanTurfCheckouts)
		.set(stamp)
		.where(
			and(
				eq(vanTurfCheckouts.mapRouteId, mapRouteId),
				eq(vanTurfCheckouts.slackUserId, slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		)
		.returning({ id: vanTurfCheckouts.id });

	if (updated.length === 0) {
		return {
			ok: false,
			status: 409,
			message: "You don't currently hold that turf.",
		};
	}

	console.log(`[van] ${kind}: user=${slackUserId} route=${mapRouteId}`);
	return { ok: true };
}

/**
 * Stamp claims that lapsed without anyone releasing them.
 *
 * Reads never needed this — `isActive` already ignores an expired claim, which
 * is why an unswept ledger looks correct on screen. What it costs is the
 * ledger's own record: without the sweep, a lapsed claim is indistinguishable
 * from a live one in the table, so "gave the turf back" and "let it run out"
 * collapse into the same row shape. Story 8.2's drift report and Story 9's
 * per-canvasser attribution both read that distinction.
 *
 * Called from /api/internal/van-sync, which already runs on a schedule and
 * already holds a lock.
 */
export async function sweepExpiredClaims(db: Db, now: Date): Promise<number> {
	const rows = await db
		.select({ id: vanTurfCheckouts.id, expiresAt: vanTurfCheckouts.expiresAt })
		.from(vanTurfCheckouts)
		.where(and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt)));

	// Same rule as isActive(): an unparseable timestamp counts as long past,
	// so a corrupt row is freed rather than holding turf nobody can reclaim.
	const lapsed = rows
		.filter((r) => {
			const t = Date.parse(r.expiresAt);
			return Number.isNaN(t) || t <= now.getTime();
		})
		.map((r) => r.id);
	if (lapsed.length === 0) return 0;

	for (const batch of chunked(lapsed)) {
		await db
			.update(vanTurfCheckouts)
			.set({ releasedAt: now.toISOString(), releaseReason: 'expired' })
			.where(inArray(vanTurfCheckouts.id, batch));
	}
	return lapsed.length;
}
