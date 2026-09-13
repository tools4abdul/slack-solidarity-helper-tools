// Reading turf checkout history out of the ledger.
//
// Two queries, deliberately: an aggregate that counts every event in the
// period, and a detail query that fetches only the rows the page will render.
// Counting in SQL rather than by expanding rows in memory is what lets the
// page say "showing the most recent 500 of 1,240" honestly — the total is
// exact even though the list is capped, and neither number depends on how many
// rows we happened to fetch.
//
// The chapter filter IS the join. `van_turf_checkouts` has no chapter column
// (schema.ts keeps the ledger narrow and denormalises chapter onto `van_turfs`
// instead), so every query here joins the turf row and filters there.
//
// Retired turf is deliberately NOT excluded. A turf VAN no longer has still
// happened, and a history that dropped it would quietly rewrite the record of a
// canvass that really took place.

import { and, desc, eq, gte, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import {
	emptyCounts,
	EVENT_CAP,
	type ActivityCounts,
	type ActivityRange,
	type ActivityRow,
} from '../../van/turf-activity.js';

type Db = ReturnType<typeof drizzle>;

/** Reasons that mean the claim was ended by something other than the
 *  volunteer. Mirrors `endKind` in turf-activity.ts — the two must agree, or
 *  the summary counts and the list below them tell different stories. */
const INVOLUNTARY_REASONS = ['expired', 'blocked', 'retired', 'walked-out'] as const;

export interface ActivityQuery {
	/** Null means every chapter. Admin-only page, so an unscoped read is the
	 *  intended default rather than a leak — see the route's header. */
	chapterId: number | null;
	range: ActivityRange;
}

/** Is this timestamp column inside the range? Null columns are excluded by the
 *  comparison itself, which is what we want: an unreleased claim has no
 *  `released_at` and so contributes no release event. */
function stampInRange(column: AnyColumn, range: ActivityRange): SQL {
	const upper = lt(column, range.end);
	return (range.start === null ? upper : and(gte(column, range.start), upper)) as SQL;
}

/** Rows touched by this range at all — any of the three stamps inside it. */
function scopeWhere(query: ActivityQuery): SQL {
	const touched = or(
		stampInRange(vanTurfCheckouts.claimedAt, query.range),
		stampInRange(vanTurfCheckouts.releasedAt, query.range),
		stampInRange(vanTurfCheckouts.completedAt, query.range),
	) as SQL;

	return (
		query.chapterId === null ? touched : and(eq(vanTurfs.chapterId, query.chapterId), touched)
	) as SQL;
}

/** `sum(case when … then 1 else 0 end)`, which counts events rather than rows —
 *  the distinction that matters, since one row can carry two of them. */
function countWhen(condition: SQL): SQL<number> {
	return sql<number>`sum(case when ${condition} then 1 else 0 end)`;
}

/**
 * How many of each event happened in the period.
 *
 * Exact, and independent of the detail query's cap. A row claimed and completed
 * inside the window is counted twice here, once under each kind, which is the
 * same fan-out `activityEvents` performs — the two are the same rule expressed
 * in SQL and in TypeScript, so they are tested against each other.
 */
export async function loadActivityCounts(db: Db, query: ActivityQuery): Promise<ActivityCounts> {
	const released = stampInRange(vanTurfCheckouts.releasedAt, query.range);
	const involuntary = sql`${vanTurfCheckouts.releaseReason} in (${sql.join(
		INVOLUNTARY_REASONS.map((r) => sql`${r}`),
		sql`, `,
	)})`;

	const [row] = await db
		.select({
			claimed: countWhen(stampInRange(vanTurfCheckouts.claimedAt, query.range)),
			completed: countWhen(stampInRange(vanTurfCheckouts.completedAt, query.range)),
			// Anything not on the involuntary list — 'volunteer', 'admin', a NULL,
			// or a reason a later migration adds — reads as a deliberate hand-back,
			// matching endKind's default branch.
			givenBack: countWhen(
				sql`${released} and (${vanTurfCheckouts.releaseReason} is null or not ${involuntary})`,
			),
			expired: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'expired'`),
			blocked: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'blocked'`),
			retired: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'retired'`),
			walkedOut: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'walked-out'`),
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(scopeWhere(query));

	// `sum()` over no rows is NULL, not 0.
	return {
		...emptyCounts(),
		claimed: Number(row?.claimed ?? 0),
		completed: Number(row?.completed ?? 0),
		'given-back': Number(row?.givenBack ?? 0),
		expired: Number(row?.expired ?? 0),
		blocked: Number(row?.blocked ?? 0),
		retired: Number(row?.retired ?? 0),
		'walked-out': Number(row?.walkedOut ?? 0),
	};
}

/**
 * The checkout rows behind the most recent events.
 *
 * Ordered by each row's own newest stamp, which is `coalesce(completed_at,
 * released_at, claimed_at)` — SQLite's `max()` is no good here because it
 * returns NULL if any argument is NULL, and an active claim has neither
 * terminal stamp. A row is either active (claimed only) or ended (claimed plus
 * exactly one of the two), so the coalesce is exactly its latest activity.
 *
 * **Fetching `limit` rows is enough for `limit` events**, which reads like an
 * off-by-one until you follow it: rows are sorted by their newest event, and
 * every row yields at least one event, so the N newest events are all carried
 * by the N newest rows. A row further down the ordering cannot hold an event
 * newer than one already in hand.
 */
export async function loadActivityRows(
	db: Db,
	query: ActivityQuery & { limit?: number },
): Promise<ActivityRow[]> {
	const limit = query.limit ?? EVENT_CAP;
	const newest = sql`coalesce(${vanTurfCheckouts.completedAt}, ${vanTurfCheckouts.releasedAt}, ${vanTurfCheckouts.claimedAt})`;

	return db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			claimedAt: vanTurfCheckouts.claimedAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			releaseReason: vanTurfCheckouts.releaseReason,
			confirmedDoorDelta: vanTurfCheckouts.confirmedDoorDelta,
			// From the turf row. Note what is NOT selected: printedListNumber is
			// the holder's credential and an admin is not the holder, so it never
			// enters the payload in the first place.
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
			doorCount: vanTurfs.doorCount,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(scopeWhere(query))
		.orderBy(desc(newest))
		.limit(limit);
}

/** Whether any turf exists at all, so the page can tell "nothing happened this
 *  week" apart from "no turf has ever been loaded" — which, with no VAN key
 *  yet, is the state anyone actually hits today. */
export async function hasAnyTurf(db: Db): Promise<boolean> {
	const rows = await db.select({ mapRouteId: vanTurfs.mapRouteId }).from(vanTurfs).limit(1);
	return rows.length > 0;
}
