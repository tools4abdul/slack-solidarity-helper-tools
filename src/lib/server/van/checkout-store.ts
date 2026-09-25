// The database side of checking turf in and out.
//
// The rules live in $lib/van/checkout.ts and are pure; this file is the part
// that touches rows. It exists as a module rather than inside the route
// handlers because all three endpoints need the same load-decide-write shape,
// and three copies of it would eventually disagree about one of the checks.
//
// Neither guarantee a claim rests on is enforced in JavaScript. One turf to one
// volunteer is the partial unique index on van_turf_checkouts (map_route_id)
// WHERE released_at IS NULL AND completed_at IS NULL. The per-volunteer cap is
// the count subquery inside the INSERT in `claimTurf` — the index cannot
// express it, since it constrains a set of rows rather than one. `canClaim` is
// the friendly layer that refuses with a reason a volunteer can act on; both
// storage-level checks are what make simultaneous clicks resolve correctly even
// when the friendly layer is bypassed or raced.

import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { chunked } from './sql-chunk.js';
import { requestRegionRefresh } from './refresh.js';
import {
	canClaim,
	DEFAULT_MAX_CONCURRENT_CLAIMS,
	parseReportedPercent,
	type ClaimOptions,
	type ClaimSnapshot,
	type TurfSnapshot,
} from '../../van/checkout.js';

type Db = ReturnType<typeof drizzle>;

export type ClaimResult =
	| { ok: true; expiresAt: string; printedListNumber: string }
	| { ok: false; status: 404 | 409; message: string };

export type ReleaseResult = { ok: true } | { ok: false; status: 400 | 404 | 409; message: string };

/** What a volunteer last reported for a route: MiniVAN's percentage when they
 *  marked it walked, and when. */
export interface WalkReport {
	percent: number;
	at: string;
}

/**
 * The latest walk report for each route, from completed checkouts.
 *
 * Keyed by route id, which is what makes it "trusted until the next cut": a
 * re-cut issues new route ids, and the new routes start with no report.
 */
export async function latestWalkReports(
	db: Db,
	mapRouteIds: readonly number[],
): Promise<Map<number, WalkReport>> {
	const reports = new Map<number, WalkReport>();
	for (const batch of chunked([...new Set(mapRouteIds)])) {
		const rows = await db
			.select({
				mapRouteId: vanTurfCheckouts.mapRouteId,
				percent: vanTurfCheckouts.reportedPercent,
				at: vanTurfCheckouts.completedAt,
			})
			.from(vanTurfCheckouts)
			.where(
				and(
					inArray(vanTurfCheckouts.mapRouteId, batch),
					isNotNull(vanTurfCheckouts.completedAt),
					isNotNull(vanTurfCheckouts.reportedPercent),
				),
			)
			.orderBy(desc(vanTurfCheckouts.completedAt));
		for (const row of rows) {
			// Newest first, so the first row per route is the one that counts.
			if (!reports.has(row.mapRouteId) && row.percent !== null && row.at !== null) {
				reports.set(row.mapRouteId, { percent: row.percent, at: row.at });
			}
		}
	}
	return reports;
}

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
		/** A live look at the campaign's Packet Tracker: who it says has this
		 *  turf, null for nobody, undefined for "could not tell". See
		 *  packet-tracker-live.ts. Omitted, the last sync's record stands. */
		sheetCheck?: (turf: {
			mapRouteId: number;
			regionName: string;
			printedListNumber: string | null;
		}) => Promise<string | null | undefined>;
	},
): Promise<ClaimResult> {
	const { mapRouteId, slackUserId, slackUserName, now } = input;

	const [row] = await db.select().from(vanTurfs).where(eq(vanTurfs.mapRouteId, mapRouteId));
	if (!row) return { ok: false, status: 404, message: 'That turf no longer exists.' };

	const snapshot: TurfSnapshot = {
		mapRouteId: row.mapRouteId,
		printedListNumber: row.printedListNumber,
		retiredAt: row.retiredAt,
		vanDistributedTo: row.vanDistributedTo ?? row.sheetAssignedTo,
		doorCount: row.doorCount,
		reportedPercent: (await latestWalkReports(db, [mapRouteId])).get(mapRouteId)?.percent ?? null,
	};

	const options = input.options ?? {};
	const claims = await relevantClaims(db, mapRouteId, slackUserId);
	const decision = canClaim(snapshot, claims, slackUserId, now, options);
	if (!decision.ok) return { ok: false, status: 409, message: decision.message };

	// The tracker double-check, only once everything else says yes: it is a
	// round trip to Google, and a claim refused for another reason should not
	// wait on one. The sync reads the tracker every half hour; an organizer
	// may have written this turf down since.
	if (input.sheetCheck) {
		const assignedTo = await input.sheetCheck({
			mapRouteId,
			regionName: row.regionName,
			printedListNumber: row.printedListNumber,
		});
		if (assignedTo) {
			const refused = canClaim(
				{ ...snapshot, vanDistributedTo: assignedTo },
				claims,
				slackUserId,
				now,
				options,
			);
			if (!refused.ok) return { ok: false, status: 409, message: refused.message };
		}
	}

	// Same default canClaim destructures, so the SQL below caps at the number
	// the volunteer was just told about rather than a second opinion.
	const { maxConcurrentClaims = DEFAULT_MAX_CONCURRENT_CLAIMS } = options;

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

	// Both race resolvers, in one statement.
	//
	// ON CONFLICT DO NOTHING is the turf-level one: the partial unique index
	// rejects the second of two simultaneous inserts on the same route, and the
	// loser gets zero rows back rather than an exception to parse.
	//
	// The count subquery is the volunteer-level one. `canClaim` read the claims
	// a moment ago and is a check-then-act: a volunteer one under the cap who
	// fires two claims on DIFFERENT turf passes both checks, and both inserts
	// land, because the index constrains one route and says nothing about how
	// many a person holds. Evaluating the count inside the INSERT makes SQLite
	// settle it — the two statements serialise, and the second sees the first's
	// row. Repeating that is how one person takes a neighbourhood, which is the
	// whole reason the cap exists.
	//
	// The `expires_at >` predicate mirrors `isActive`, so a lapsed claim the
	// nightly sweep has not stamped yet does not count against the holder here
	// any more than it does on the page.
	//
	// The column list is written out because SELECT ... WHERE is what carries
	// the condition; SQLite needs that WHERE for a following ON CONFLICT to
	// parse at all, which is convenient rather than a constraint here.
	const inserted = (await db.all(sql`
		INSERT INTO van_turf_checkouts
			(map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
			 claim_door_count, issued_list_number)
		SELECT ${mapRouteId}, ${slackUserId}, ${slackUserName}, ${nowIso}, ${decision.expiresAt},
		       ${row.doorCount}, ${row.printedListNumber}
		WHERE (
			SELECT count(*) FROM van_turf_checkouts
			WHERE slack_user_id = ${slackUserId}
			  AND released_at IS NULL
			  AND completed_at IS NULL
			  AND expires_at > ${nowIso}
		) < ${maxConcurrentClaims}
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as { id: number }[];

	if (inserted.length === 0) {
		// Zero rows means one of two refusals and the statement cannot say
		// which, so re-derive it from current state. One extra read, only ever
		// on the losing path, and the wording comes from the same `canClaim`
		// the volunteer would have seen a moment earlier.
		const fresh = await relevantClaims(db, mapRouteId, slackUserId);
		const reason = canClaim(snapshot, fresh, slackUserId, now, options);
		return {
			ok: false,
			status: 409,
			message: reason.ok
				? 'Someone claimed this turf a moment before you did. Try another nearby.'
				: reason.message,
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
 *  records that the doors were actually knocked.
 *
 *  Marking walked REQUIRES `reportedPercent`, what MiniVAN shows as done: it
 *  is the only progress figure the app will ever have for this turf (see
 *  van_turf_checkouts.reportedPercent). Handing it back unwalked does not ask. */
export async function endClaim(
	db: Db,
	input: {
		mapRouteId: number;
		slackUserId: string;
		now: Date;
		kind: 'release' | 'complete';
		/** 0-100. Required when `kind` is 'complete'; ignored otherwise. */
		reportedPercent?: number | null;
	},
): Promise<ReleaseResult> {
	const { mapRouteId, slackUserId, now, kind } = input;
	const reportedPercent = parseReportedPercent(input.reportedPercent);
	if (kind === 'complete' && reportedPercent === null) {
		return {
			ok: false,
			status: 400,
			message: 'Enter the % MiniVAN shows as done for this turf (0 to 100).',
		};
	}
	const stamp =
		kind === 'complete'
			? { completedAt: now.toISOString(), reportedPercent }
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

	// A completed turf is the one moment we know VAN's door counts are wrong:
	// the volunteer just knocked doors that are still on the list. Ask for a
	// re-cut of the region so the next person to look sees what is actually
	// left (Story 4.2's on-demand path).
	//
	// A want, not a call. The refresh sweep decides when to send it — it may
	// defer while other volunteers are still out in that region — and the
	// volunteer's request must not wait on a VAN round-trip to return. The
	// helper never throws, so a completion that is already written cannot fail
	// on its bookkeeping.
	if (kind === 'complete') {
		const [turf] = await db
			.select({ folderId: vanTurfs.folderId, mapRegionId: vanTurfs.mapRegionId })
			.from(vanTurfs)
			.where(eq(vanTurfs.mapRouteId, mapRouteId));
		if (turf) {
			await requestRegionRefresh(db, {
				folderId: turf.folderId,
				mapRegionId: turf.mapRegionId,
				now,
			});
		}
	}

	console.log(
		`[van] ${kind}: user=${slackUserId} route=${mapRouteId}` +
			(kind === 'complete' ? ` reported=${reportedPercent}%` : ''),
	);
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
