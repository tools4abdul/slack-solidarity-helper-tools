// Reading a chapter's turf, once.
//
// Three surfaces need the same four steps — filter to the chapter, order and
// cut, fetch the claims for exactly what survived, then run every row through
// toTurfView: the volunteer page, the map's viewport endpoint, and the /turfs
// Slack command. All three call this. They used to be three near-identical
// copies that had already drifted — the web two missed the viewer's own claims
// in other chapters (so a volunteer at their limit saw every turf as
// claimable) and never marked turf as updating — which is the situation
// checkout-store.ts was extracted to avoid ("three copies of it would
// eventually disagree about one of the checks").
//
// What is NOT here: the gates. Session, blocklist, chapter validation and the
// rate limiters stay in the routes, because each transport authenticates
// differently — a cookie session, or a Slack signature. This module assumes the
// caller has already decided the viewer may see this chapter, and its job is to
// make sure that once they may, all three see exactly the same thing.
//
// The ordering matters and is deliberate: rows are cut BEFORE views are built,
// so a turf left out of a payload is never serialised at all rather than
// serialised and then filtered. The one exception is `claimableOnly`, which has
// to judge every row before it can know which ones to leave out.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { refreshingRegionIds } from './refresh.js';
import { latestWalkReports } from './checkout-store.js';
import { chunked } from './sql-chunk.js';
import {
	activeClaimFor,
	canClaim,
	type ClaimOptions,
	type ClaimSnapshot,
} from '../../van/checkout.js';
import type { BoundingBox, LatLng } from '../../van/geometry.js';
import { selectNearest, TURFS_PER_PAYLOAD, withinBounds } from '../../van/turf-paging.js';
import { toTurfView, turfSnapshot, type TurfView } from '../../van/turf-view.js';
import { visibleToChapter } from './chapter-visibility.js';
import type { VanTurfRow } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

export interface TurfQueryInput {
	chapterId: number;
	viewer: { slackUserId: string; isAdmin: boolean };
	/** Where the volunteer is, when we know. Null means name-ordered. */
	location?: LatLng | null;
	limit?: number;
	/** Where in the ordering this page starts, counting unpinned rows only.
	 *  The Slack command's "Show next 5"; both web callers leave it at zero.
	 *  Take the next value from `nextOffset` rather than computing it. */
	offset?: number;
	/** Restrict to a map viewport before paging. The map endpoint's bbox. */
	bounds?: BoundingBox | null;
	/** Restrict to specific routes. Used to read one turf back through the same
	 *  gate the list uses, rather than reaching past it to the raw row. */
	mapRouteIds?: number[];
	/**
	 * Keep retired turf the viewer is still holding.
	 *
	 * schema.ts keeps a retired row precisely so a live checkout still renders;
	 * dropping it would take a volunteer's turf and its MiniVAN list number off
	 * their own page while they are out walking it. The map endpoint does not
	 * need this — retired turf has no place on a map — so it is opt-in rather
	 * than the default.
	 */
	includeHeldByViewer?: boolean;
	/**
	 * Leave out turf nobody could take right now: checked out, assigned in VAN,
	 * walked out, retired, or without a list number. The viewer's own turf
	 * stays.
	 *
	 * For the Slack list, which is five rows on a phone and should spend them on
	 * turf a volunteer can act on. The web map keeps taken turf on purpose — a
	 * hole in the map reads as a bug.
	 *
	 * The per-volunteer cap is NOT a reason to leave a turf out. It is about the
	 * viewer, not the turf, and hiding everything from someone at their limit
	 * would read as "no turf here" instead of "give one back first". Those rows
	 * still come back with `claimable: false` and the limit message.
	 */
	claimableOnly?: boolean;
	now?: Date;
	claimOptions?: ClaimOptions;
}

export interface TurfQueryResult {
	turfs: TurfView[];
	/**
	 * The chapter's total, not this payload's remainder — after the
	 * `claimableOnly` filter when it is on.
	 *
	 * Reporting the remainder made the page's own message drift as soon as
	 * someone panned: the count of loaded turf grew while the "N more" figure
	 * kept describing whichever viewport answered last. A total never moves.
	 */
	total: number;
	/** How many rows follow this page. What "Show next 5" reads. */
	omitted: number;
	/** This page's first row, zero-based, in the full ordering. */
	start: number;
	/** The `offset` for the page after this one. */
	nextOffset: number;
	/** Rows `claimableOnly` left out. Zero when it is off. */
	unavailable: number;
}

/** The turf a viewer may see in one chapter, ordered, cut, and serialisable. */
export async function loadChapterTurfs(db: Db, input: TurfQueryInput): Promise<TurfQueryResult> {
	const {
		chapterId,
		viewer,
		location = null,
		limit = TURFS_PER_PAYLOAD,
		offset = 0,
		bounds = null,
		mapRouteIds,
		includeHeldByViewer = false,
		claimableOnly = false,
		now = new Date(),
		claimOptions = {},
	} = input;

	// The viewer's own live claims, fetched first because they widen the turf
	// query below. Deliberately not chapter-scoped: the claim is what matters,
	// and a turf they hold is a turf they need to see.
	const myRouteIds = includeHeldByViewer ? await activeRouteIdsFor(db, viewer.slackUserId) : [];

	// An empty `mapRouteIds` is a request for nothing, not a request for
	// everything — `inArray` with an empty list is invalid SQL in some drivers
	// and "no filter" in others, and neither is what the caller asked for.
	if (mapRouteIds?.length === 0) {
		return { turfs: [], total: 0, omitted: 0, start: 0, nextOffset: 0, unavailable: 0 };
	}

	const rows = await db
		.select()
		.from(vanTurfs)
		.where(
			and(
				// Every folder this chapter is mapped to, so turf in a folder shared
				// by several chapters appears for each of them.
				visibleToChapter(chapterId),
				mapRouteIds ? inArray(vanTurfs.mapRouteId, mapRouteIds) : undefined,
				myRouteIds.length > 0
					? or(isNull(vanTurfs.retiredAt), inArray(vanTurfs.mapRouteId, myRouteIds))
					: isNull(vanTurfs.retiredAt),
			),
		);

	// Bounded twice when a viewport is given: by the box, then by the payload
	// budget. A volunteer zoomed out to the whole county is still asking for a
	// box, and without the second cap that box is the chapter.
	const boxed = bounds ? withinBounds(rows, bounds) : rows;

	// Claimability depends on the claims and walk reports, so the filtered path
	// has to read both for every candidate before it can cut. The unfiltered
	// path reads them for the cut page only.
	let candidates: VanTurfRow[] = boxed;
	let judged: {
		claims: ClaimSnapshot[];
		walkReports: Awaited<ReturnType<typeof latestWalkReports>>;
	} | null = null;
	if (claimableOnly) {
		const ids = boxed.map((r) => r.mapRouteId);
		const claims = await claimsFor(db, ids, viewer.slackUserId);
		const walkReports = await latestWalkReports(db, ids);
		// No cap: see `claimableOnly` for why being at the limit does not hide a turf.
		const ignoringCap = { ...claimOptions, maxConcurrentClaims: Number.MAX_SAFE_INTEGER };
		candidates = boxed.filter(
			(row) =>
				canClaim(turfSnapshot(row, walkReports), claims, viewer.slackUserId, now, ignoringCap).ok ||
				activeClaimFor(row.mapRouteId, claims, now)?.slackUserId === viewer.slackUserId,
		);
		judged = { claims, walkReports };
	}

	// The viewer's own turf is pinned to the first page: it carries their list
	// number, and it must not be sorted — or boxed — out of the one view that
	// shows it. `myRouteIds` is only populated when the caller asked for held
	// turf, so this changes nothing for callers that did not.
	const { selected, omitted, start, nextOffset } = selectNearest(candidates, {
		location,
		limit,
		offset,
		alwaysInclude: myRouteIds,
	});

	const selectedIds = selected.map((r) => r.mapRouteId);
	const claims = judged?.claims ?? (await claimsFor(db, selectedIds, viewer.slackUserId));

	// One small read for the whole payload rather than a lookup per row. The
	// table holds one row per region and only in-flight ones are returned, so
	// this is usually empty and never more than a handful — and an empty page
	// skips it entirely, like the claim query above.
	const refreshingRegions = selected.length > 0 ? await refreshingRegionIds(db) : new Set<number>();
	// What volunteers last reported walking, for this page's turf only.
	const walkReports = judged?.walkReports ?? (await latestWalkReports(db, selectedIds));

	return {
		// toTurfView is the single gate on what reaches a viewer; see its header.
		// Nothing here should ever be spread from a raw row instead.
		turfs: selected.map((row) =>
			toTurfView(row, claims, viewer, now, { ...claimOptions, refreshingRegions, walkReports }),
		),
		total: claimableOnly ? candidates.length : rows.length,
		omitted,
		start,
		nextOffset,
		unavailable: claimableOnly ? boxed.length - candidates.length : 0,
	};
}

/** Map routes this user is actively holding, across every chapter. */
async function activeRouteIdsFor(db: Db, slackUserId: string): Promise<number[]> {
	const rows = await db
		.select({ mapRouteId: vanTurfCheckouts.mapRouteId })
		.from(vanTurfCheckouts)
		.where(
			and(
				eq(vanTurfCheckouts.slackUserId, slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	return rows.map((r) => r.mapRouteId);
}

/**
 * Live claims relevant to this payload: the turf being served, plus the
 * viewer's own wherever it is.
 *
 * The viewer's own are in the set because `canClaim` counts them to decide
 * whether this viewer is at their claim limit. Scoped to the payload alone, a
 * volunteer who pans away from the turf they hold is counted as holding
 * nothing, so every turf renders claimable with no reason given and the click
 * 409s. Adding them discloses nothing new — their own page already shows them.
 *
 * Everyone else's stays scoped by mapRouteId, so a chapter's payload still
 * carries no evidence of activity in other chapters.
 */
async function claimsFor(
	db: Db,
	mapRouteIds: number[],
	viewerSlackUserId: string,
): Promise<ClaimSnapshot[]> {
	if (mapRouteIds.length === 0) return [];
	// Chunked because the `claimableOnly` path asks about a whole chapter. The
	// viewer's own claims come back in every chunk, so they are de-duplicated —
	// by route, which is safe because the partial unique index allows only one
	// open claim per route.
	const byRoute = new Map<number, typeof vanTurfCheckouts.$inferSelect>();
	for (const batch of chunked(mapRouteIds)) {
		const rows = await db
			.select()
			.from(vanTurfCheckouts)
			.where(
				and(
					or(
						inArray(vanTurfCheckouts.mapRouteId, batch),
						eq(vanTurfCheckouts.slackUserId, viewerSlackUserId),
					),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
				),
			);
		for (const row of rows) byRoute.set(row.mapRouteId, row);
	}
	return [...byRoute.values()].map((c) => ({
		mapRouteId: c.mapRouteId,
		slackUserId: c.slackUserId,
		slackUserName: c.slackUserName,
		claimedAt: c.claimedAt,
		expiresAt: c.expiresAt,
		releasedAt: c.releasedAt,
		completedAt: c.completedAt,
	}));
}
