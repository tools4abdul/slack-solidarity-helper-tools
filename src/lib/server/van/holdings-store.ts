// Reading what turf is out right now, and which completions look unsynced.
//
// The present-tense sibling of activity-store.ts. That one filters on the
// terminal stamps to reconstruct history; this one filters on their ABSENCE —
// `released_at IS NULL AND completed_at IS NULL` is the definition of a live
// claim, and it is the same predicate the partial unique index on
// van_turf_checkouts enforces.
//
// As there, the chapter filter IS the join: the ledger has no chapter column,
// so every query joins van_turfs and filters on the denormalised one.
//
// Live claims are not capped. The cap on the history page exists because a
// season's ledger is unbounded; the set of claims outstanding at one moment is
// bounded by how many volunteers are out, which is a number an organizer wants
// to see all of. If a campaign ever has more live turf than fits a page, that
// is worth knowing rather than truncating.

import { and, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import type { CompletionRow, HoldingRow } from '../../van/turf-holdings.js';
import { visibleToChapter } from './chapter-visibility.js';

type Db = ReturnType<typeof drizzle>;

/** How many recent completions to examine for a missing sync. Bounded because
 *  completions accumulate forever, and a month-old unsynced turf is not
 *  something anyone is going to chase. */
export const COMPLETION_LOOKBACK = 200;

export interface HoldingsQuery {
	/** Null means every chapter. Admin-only page, so unscoped is the intended
	 *  default rather than a leak. */
	chapterId: number | null;
}

function chapterFilter(chapterId: number | null): SQL | undefined {
	// The chapter's FOLDERS, not the label on the row: a folder mapped to
	// several chapters is visible to all of them (chapter-visibility.ts).
	return visibleToChapter(chapterId);
}

/**
 * Every claim currently outstanding.
 *
 * "Outstanding" here means only that the ledger has not closed the row — a
 * claim whose TTL has passed but which the sweep has not yet stamped still
 * comes back, and `currentHoldings` drops it via `isActive`. That split is
 * deliberate: the sweep runs on a cron, so between ticks the database and the
 * truth disagree, and the pure rule is the one that should win. Filtering
 * expiry in SQL as well would mean two definitions of "live" that drift.
 */
export async function loadCurrentHoldings(db: Db, query: HoldingsQuery): Promise<HoldingRow[]> {
	return db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			expiryWarnedAt: vanTurfCheckouts.expiryWarnedAt,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
			doorCount: vanTurfs.doorCount,
			// Not selected, deliberately: printedListNumber is the credential
			// issued to the holder, and an organizer looking at a board is not the
			// holder.
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

/** One of the caller's own claims, as `/turfs-mine` renders it. */
export interface MyHoldingRow {
	mapRouteId: number;
	claimedAt: string;
	expiresAt: string;
	releasedAt: string | null;
	completedAt: string | null;
	turfName: string;
	regionName: string;
	chapterId: number;
	doorCount: number;
	/** The number this volunteer was issued. */
	issuedListNumber: string | null;
}

/**
 * The claims one volunteer is holding right now.
 *
 * Separate from `loadCurrentHoldings` rather than a parameter on it, because
 * the two differ in what they are allowed to return: that one feeds an
 * organizer board and deliberately omits the printed list number, since an
 * organizer is not the holder. Here the caller IS the holder — the query is
 * scoped to their own Slack id — so the number they were issued is theirs to
 * see, exactly as it is in the claim message and on their own turf page.
 *
 * Folding the two together behind a flag would put that distinction one
 * mistaken argument away from leaking a credential to a board.
 *
 * Expiry is NOT filtered here, matching loadCurrentHoldings: the sweep runs on
 * a cron, so between ticks a lapsed claim is still unstamped, and `isActive` is
 * the rule that decides. Two definitions of "live" would drift.
 */
export async function loadHoldingsFor(db: Db, slackUserId: string): Promise<MyHoldingRow[]> {
	return db
		.select({
			mapRouteId: vanTurfCheckouts.mapRouteId,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			issuedListNumber: vanTurfCheckouts.issuedListNumber,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			doorCount: vanTurfs.doorCount,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				eq(vanTurfCheckouts.slackUserId, slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		)
		.orderBy(vanTurfCheckouts.expiresAt);
}

/**
 * Recent completions, for the missed-sync check.
 *
 * Returns rows whose delta is still null as well as measured ones, because the
 * page has to tell "nothing to worry about" apart from "nothing has been
 * checked" — and with Story 5.6 still blocked on the VAN key, every row is
 * currently the latter.
 */
export async function loadRecentCompletions(
	db: Db,
	query: HoldingsQuery & { limit?: number },
): Promise<CompletionRow[]> {
	const rows = await db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			completedAt: vanTurfCheckouts.completedAt,
			confirmedDoorDelta: vanTurfCheckouts.confirmedDoorDelta,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(and(isNotNull(vanTurfCheckouts.completedAt), chapterFilter(query.chapterId)))
		.orderBy(desc(vanTurfCheckouts.completedAt))
		.limit(query.limit ?? COMPLETION_LOOKBACK);

	// `completedAt` is non-null by the WHERE above, but drizzle types it from the
	// column, which is nullable. Narrowed here rather than asserted at every use.
	return rows.map((r) => ({ ...r, completedAt: r.completedAt ?? '' }));
}
