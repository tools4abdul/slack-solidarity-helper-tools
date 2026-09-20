// The rows the drift report compares, and whether the comparison is legible.
//
// Both sides come from our own database: `van_turfs.van_distributed_to` (which
// the catalog sync writes, Story 8.1) and the checkout ledger. No VAN call —
// which matters, because this runs on a page load and the sync's cadence is
// already the right place to talk to VAN.
//
// Unlike the holdings board, this reads turf that nobody has claimed as well as
// turf that somebody has: half the drift is turf VAN says is out and our ledger
// says is free, and that row has no checkout to find it by.

import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanSyncState, vanTurfCheckouts, vanTurfs } from '../schema.js';
import type { ClaimSnapshot } from '../../van/checkout.js';
import type { DriftTurfRow, DriftVisibility } from '../../van/turf-drift.js';
import { visibleToChapter } from './chapter-visibility.js';

type Db = ReturnType<typeof drizzle>;

export interface DriftQuery {
	/** Null means every chapter. */
	chapterId: number | null;
}

function chapterFilter(chapterId: number | null): SQL | undefined {
	// The chapter's FOLDERS, not the label on the row: a folder mapped to
	// several chapters is visible to all of them (chapter-visibility.ts).
	return visibleToChapter(chapterId);
}

/** Every turf in scope, claimed or not. Retired rows come back and the pure
 *  rule drops them, so the "skip retired" decision stays in one place next to
 *  the reasoning for it. */
export async function loadDriftTurfs(db: Db, query: DriftQuery): Promise<DriftTurfRow[]> {
	return db
		.select({
			mapRouteId: vanTurfs.mapRouteId,
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
			doorCount: vanTurfs.doorCount,
			printedListNumber: vanTurfs.printedListNumber,
			vanDistributedTo: vanTurfs.vanDistributedTo,
			retiredAt: vanTurfs.retiredAt,
		})
		.from(vanTurfs)
		.where(chapterFilter(query.chapterId));
}

/**
 * Claims the ledger has not closed, across the turf in scope.
 *
 * Scoped by the join rather than by turf id list: the caller wants "claims on
 * this chapter's turf", and passing several hundred route ids into an `IN` to
 * express that would be the same query written worse.
 */
export async function loadDriftClaims(db: Db, query: DriftQuery): Promise<ClaimSnapshot[]> {
	return db
		.select({
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				chapterFilter(query.chapterId),
			),
		);
}

/**
 * Whether the last catalog sync could read `/minivanExports`.
 *
 * Without this the report cannot tell "VAN reports nothing distributed" from
 * "we never got to ask", because the sync writes NULL into
 * `van_distributed_to` in both cases.
 *
 * An absent row — no sync has ever completed — reads as unavailable rather than
 * visible. Before the first sync there is genuinely nothing to compare against,
 * and an empty report at that point would be reassurance drawn from an empty
 * table.
 */
export async function loadDriftVisibility(db: Db): Promise<DriftVisibility> {
	const [row] = await db
		.select({ minivanExportsOk: vanSyncState.minivanExportsOk })
		.from(vanSyncState)
		.where(eq(vanSyncState.id, 1))
		.limit(1);
	return row?.minivanExportsOk === true ? 'visible' : 'van-side-unavailable';
}
