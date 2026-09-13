// Reading a chapter's turf, once.
//
// Three surfaces need the same four steps — filter to the chapter, order and
// cut, fetch the claims for exactly what survived, then run every row through
// toTurfView: the volunteer page, the map's viewport endpoint, and the /turfs
// Slack command. They had drifted into two near-identical copies before the
// third arrived, which is the situation checkout-store.ts was extracted to
// avoid ("three copies of it would eventually disagree about one of the
// checks").
//
// What is NOT here: the gates. Session, blocklist, chapter validation and the
// rate limiters stay in the routes, because each transport authenticates
// differently — a cookie session, or a Slack signature. This module assumes the
// caller has already decided the viewer may see this chapter, and its job is to
// make sure that once they may, all three see exactly the same thing.
//
// The ordering matters and is deliberate: rows are cut BEFORE views are built,
// so a turf left out of a payload is never serialised at all rather than
// serialised and then filtered.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { refreshingRegionIds } from './refresh.js';
import type { ClaimOptions, ClaimSnapshot } from '../../van/checkout.js';
import type { BoundingBox, LatLng } from '../../van/geometry.js';
import { selectNearest, TURFS_PER_PAYLOAD, withinBounds } from '../../van/turf-paging.js';
import { toTurfView, type TurfView } from '../../van/turf-view.js';

type Db = ReturnType<typeof drizzle>;

export interface TurfQueryInput {
	chapterId: number;
	viewer: { slackUserId: string; isAdmin: boolean };
	/** Where the volunteer is, when we know. Null means name-ordered. */
	location?: LatLng | null;
	limit?: number;
	/** Where in the ordering this page starts. The Slack command's "Show next
	 *  5"; both web callers leave it at zero. */
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
	now?: Date;
	claimOptions?: ClaimOptions;
}

export interface TurfQueryResult {
	turfs: TurfView[];
	/**
	 * The chapter's total, not this payload's remainder.
	 *
	 * Reporting the remainder made the page's own message drift as soon as
	 * someone panned: the count of loaded turf grew while the "N more" figure
	 * kept describing whichever viewport answered last. A total never moves.
	 */
	total: number;
	/** How many rows follow this page. What "Show next 5" reads. */
	omitted: number;
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
	if (mapRouteIds?.length === 0) return { turfs: [], total: 0, omitted: 0 };

	const rows = await db
		.select()
		.from(vanTurfs)
		.where(
			and(
				eq(vanTurfs.chapterId, chapterId),
				mapRouteIds ? inArray(vanTurfs.mapRouteId, mapRouteIds) : undefined,
				myRouteIds.length > 0
					? or(isNull(vanTurfs.retiredAt), inArray(vanTurfs.mapRouteId, myRouteIds))
					: isNull(vanTurfs.retiredAt),
			),
		);

	// Bounded twice when a viewport is given: by the box, then by the payload
	// budget. A volunteer zoomed out to the whole county is still asking for a
	// box, and without the second cap that box is the chapter.
	const candidates = bounds ? withinBounds(rows, bounds) : rows;
	const { selected, omitted } = selectNearest(candidates, { location, limit, offset });

	// Claims are fetched for exactly the turf being served. Scoping by
	// mapRouteId rather than pulling the whole ledger keeps a chapter's payload
	// from carrying evidence of activity in other chapters.
	const claims = await claimsFor(
		db,
		selected.map((r) => r.mapRouteId),
	);

	// One small read for the whole payload rather than a lookup per row. The
	// table holds one row per region and only in-flight ones are returned, so
	// this is usually empty and never more than a handful — and an empty page
	// skips it entirely, like the claim query above.
	const refreshingRegions = selected.length > 0 ? await refreshingRegionIds(db) : new Set<number>();

	return {
		// toTurfView is the single gate on what reaches a viewer; see its header.
		// Nothing here should ever be spread from a raw row instead.
		turfs: selected.map((row) =>
			toTurfView(row, claims, viewer, now, { ...claimOptions, refreshingRegions }),
		),
		total: rows.length,
		omitted,
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

/** Active claims on the given routes, as the pure rules want them. */
async function claimsFor(db: Db, mapRouteIds: number[]): Promise<ClaimSnapshot[]> {
	if (mapRouteIds.length === 0) return [];
	const rows = await db
		.select()
		.from(vanTurfCheckouts)
		.where(
			and(
				inArray(vanTurfCheckouts.mapRouteId, mapRouteIds),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	return rows.map((c) => ({
		mapRouteId: c.mapRouteId,
		slackUserId: c.slackUserId,
		slackUserName: c.slackUserName,
		claimedAt: c.claimedAt,
		expiresAt: c.expiresAt,
		releasedAt: c.releasedAt,
		completedAt: c.completedAt,
	}));
}
