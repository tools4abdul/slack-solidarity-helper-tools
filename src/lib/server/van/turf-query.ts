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
// serialised and then filtered. Every row is judged claimable or not before the
// cut, so the payload fills with turf a volunteer can take first, and
// `claimableOnly` can leave out the rest.

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanChapterFolders, vanTurfCheckouts, vanTurfPlacements, vanTurfs } from '../schema.js';

import {
	badgeShown,
	loadTurfCampaigns,
	turfCampaignEnabled,
	type CampaignBadges,
	type TurfCampaigns,
} from './campaigns.js';
import { refreshingRegionIds } from './refresh.js';
import { latestWalkReports } from './checkout-store.js';
import { loadContactMarks, marksFor, type ContactMarks } from './contact-sync.js';
import { chunked, idRows } from './sql-chunk.js';
import {
	activeClaimFor,
	canClaim,
	type ClaimOptions,
	type ClaimSnapshot,
	withoutClaimCap,
} from '../../van/checkout.js';
import type { BoundingBox, LatLng } from '../../van/geometry.js';
import {
	selectNearest,
	TURFS_PER_PAYLOAD,
	withinBounds,
	type TurfSort,
} from '../../van/turf-paging.js';
import {
	doorDensity,
	doorsLeft,
	hasContactHistory,
	parseHull,
	toTurfView,
	turfSnapshot,
	type CampaignTotals,
	type TurfView,
} from '../../van/turf-view.js';
import { visibleToChapter } from './chapter-visibility.js';
import { loadHolderAccounts } from '../outside-volunteers.js';
import type { VanTurfRow } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

export interface TurfQueryInput {
	chapterId: number;
	viewer: { slackUserId: string; isAdmin: boolean };
	/** Where the volunteer is, when we know. Null means name-ordered. */
	location?: LatLng | null;
	/** `densest` puts the most doors per area first, ahead of distance — and
	 *  before the payload cut, so the densest turf in a large chapter is in
	 *  the payload at all. Nearest (or by name) when omitted. */
	sort?: TurfSort;
	limit?: number;
	/** Where in the ordering this page starts, counting unpinned rows only.
	 *  The Slack command's "Show next 5"; both web callers leave it at zero.
	 *  Take the next value from `nextOffset` rather than computing it. */
	offset?: number;
	/** Restrict to a map viewport before paging. The map endpoint's bbox. */
	bounds?: BoundingBox | null;
	/** Restrict to specific routes. Used to read one turf back through the same
	 *  gate the list uses, rather than reaching past it to the raw row. */
	turfIds?: number[];
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
	/**
	 * Badge text for the campaigns behind `turfs`, keyed by `TurfView.campaignId`
	 * — only those whose badge this page shows (badgeShown: more than one
	 * campaign enabled, or a disabled campaign's held turf). Null when no turf
	 * here shows one. Once per payload rather than per row.
	 */
	campaignBadges: CampaignBadges | null;
	/** `total` split by campaign, keyed like `campaignBadges` and sent when it
	 *  is. Null otherwise. */
	campaignTotals: CampaignTotals | null;
}

/**
 * The rows `loadChapterTurfs` works from: the chapter's live turf, and the
 * viewer's own wherever the chapter can see it.
 *
 * The chapter's turf ids are picked first, each half of its visibility by an
 * index — its live turf by folder (`van_turfs_live_folder`), its placed turf
 * from the placements — and the rows are then read by key. Written as one
 * `where` over van_turfs instead, the `or`s rule out every index: the
 * viewer's own turf stays visible retired, hidden or in a disabled campaign,
 * and `retired_at is null or turf_id in (…)` makes the read every turf in the
 * table, retired routes and outlines included, for anyone holding a turf.
 */
function chapterTurfsWhere(input: {
	chapterId: number | null;
	turfIds: readonly number[] | undefined;
	myRouteIds: readonly number[];
	isAdmin: boolean;
}): SQL | undefined {
	const { chapterId, turfIds, myRouteIds, isAdmin } = input;
	const mine = myRouteIds.length > 0 ? inArray(vanTurfs.turfId, [...myRouteIds]) : undefined;
	const offered = and(
		isNull(vanTurfs.retiredAt),
		// A disabled campaign's turf is not handed out, and turf an admin hid is
		// for admins alone, who un-hide it from the card. Turf the viewer holds
		// stays visible to them until the claim ends: these stop new claims,
		// not the ones in progress.
		turfCampaignEnabled(),
		isAdmin ? undefined : isNull(vanTurfs.hiddenAt),
	);
	const chapterTurf =
		chapterId === null
			? undefined
			: sql`${vanTurfs.turfId} in (
				select ${vanTurfs.turfId} from ${vanTurfs}
				where (${vanTurfs.campaignId}, ${vanTurfs.folderId}) in (
					select ${vanChapterFolders.campaignId}, ${vanChapterFolders.folderId}
					from ${vanChapterFolders} where ${vanChapterFolders.chapterId} = ${chapterId}
				) and ${vanTurfs.retiredAt} is null
				union all
				select ${vanTurfPlacements.turfId} from ${vanTurfPlacements}
				where ${vanTurfPlacements.chapterId} = ${chapterId}
				${myRouteIds.length > 0 ? sql`union all ${idRows(myRouteIds)}` : sql``}
			)`;
	return and(
		chapterTurf,
		// Every folder this chapter is mapped to, so turf in a folder shared by
		// several chapters appears for each of them. Checked on every row, as
		// the viewer's own turf comes in above whatever chapter it is in.
		visibleToChapter(chapterId),
		turfIds ? inArray(vanTurfs.turfId, [...turfIds]) : undefined,
		mine ? or(offered, mine) : offered,
	);
}

/** The turf a viewer may see in one chapter, ordered, cut, and serialisable. */
export async function loadChapterTurfs(db: Db, input: TurfQueryInput): Promise<TurfQueryResult> {
	const {
		chapterId,
		viewer,
		location = null,
		sort = 'nearest',
		limit = TURFS_PER_PAYLOAD,
		offset = 0,
		bounds = null,
		turfIds,
		includeHeldByViewer = false,
		claimableOnly = false,
		now = new Date(),
		claimOptions = {},
	} = input;

	// The viewer's own live claims, fetched first because they widen the turf
	// query below. Deliberately not chapter-scoped: the claim is what matters,
	// and a turf they hold is a turf they need to see.
	const myRouteIds = includeHeldByViewer ? await activeRouteIdsFor(db, viewer.slackUserId) : [];

	// An empty `turfIds` is a request for nothing, not a request for
	// everything — `inArray` with an empty list is invalid SQL in some drivers
	// and "no filter" in others, and neither is what the caller asked for.
	if (turfIds?.length === 0) {
		return {
			turfs: [],
			total: 0,
			omitted: 0,
			start: 0,
			nextOffset: 0,
			unavailable: 0,
			campaignBadges: null,
			campaignTotals: null,
		};
	}

	const rows = await db
		.select()
		.from(vanTurfs)
		.where(chapterTurfsWhere({ chapterId, turfIds, myRouteIds, isAdmin: viewer.isAdmin }));

	// Bounded twice when a viewport is given: by the box, then by the payload
	// budget. A volunteer zoomed out to the whole county is still asking for a
	// box, and without the second cap that box is the chapter.
	const boxed = bounds ? withinBounds(rows, bounds) : rows;

	// Claimability depends on the claims and walk reports, so both are read for
	// every candidate before the cut: the payload is filled with turf a
	// volunteer can take first, and `claimableOnly` leaves the rest out.
	const boxedIds = boxed.map((r) => r.turfId);
	const claims = await claimsFor(db, boxedIds, viewer.slackUserId);
	const walkReports = await latestWalkReports(db, boxedIds);
	// No cap: being at the limit is about the viewer, not the turf — see
	// `claimableOnly` — and would otherwise rank every turf as taken.
	const ignoringCap = withoutClaimCap(claimOptions);
	const takeable = new Set(
		boxed
			.filter((row) => {
				const snapshot = turfSnapshot(row, now, { ...claimOptions, walkReports });
				return canClaim(snapshot, claims, viewer.slackUserId, now, ignoringCap).ok;
			})
			.map((r) => r.turfId),
	);
	const candidates: VanTurfRow[] = claimableOnly
		? boxed.filter(
				(row) =>
					takeable.has(row.turfId) ||
					activeClaimFor(row.turfId, claims, now)?.slackUserId === viewer.slackUserId,
			)
		: boxed;

	// The viewer's own turf is pinned to the first page: it carries their list
	// number, and it must not be sorted — or boxed — out of the one view that
	// shows it. `myRouteIds` is only populated when the caller asked for held
	// turf, so this changes nothing for callers that did not.
	const { selected, omitted, start, nextOffset } = selectNearest(candidates, {
		location,
		limit,
		offset,
		alwaysInclude: myRouteIds,
		// From the same hull and doors-left the browser ranks by, so the turf
		// picked here is the turf the list puts first.
		density:
			sort === 'densest'
				? (row) => doorDensity({ hull: parseHull(row.hullJson), doorsRemaining: doorsLeft(row) })
				: undefined,
		// Whichever sort: turf a volunteer can take that nobody has been to,
		// then takeable turf knocked recently, then turf checked out, handed
		// out in VAN, without doors left or without a list number — the same
		// bands the list orders by.
		band: (row) => (!takeable.has(row.turfId) ? 2 : hasContactHistory(row) ? 1 : 0),
	});

	// One small read for the whole payload rather than a lookup per row. The
	// table holds one row per region and only in-flight ones are returned, so
	// this is usually empty and never more than a handful — and an empty page
	// skips it entirely, like the claim query above.
	const refreshingRegions = selected.length > 0 ? await refreshingRegionIds(db) : new Set<string>();
	// The uncontacted count's "as of" — per campaign, since each pulls its own
	// ContactHistory. One small read, skipped for an empty page.
	const contactMarks =
		selected.length > 0 ? await loadContactMarks(db) : new Map<number, ContactMarks>();
	// Badges and disabled campaigns: one read of a table with a row per campaign.
	const campaigns: TurfCampaigns =
		selected.length > 0
			? await loadTurfCampaigns(db)
			: { badges: {}, showBadges: false, disabled: new Set<number>() };
	// The campaigns whose badge this page shows, and only those: a payload
	// names no campaign it shows no badged turf from.
	const badged = new Set(
		selected.map((r) => r.campaignId).filter((id) => badgeShown(campaigns, id)),
	);

	// The Slack, Google or Apple mark (and an outside holder's email) beside each holder
	// name. Admins only — nobody else is shown who holds anything, so nobody
	// else needs the read.
	// What `total` counts, and the same split by campaign.
	const counted = claimableOnly ? candidates : rows;
	const totalsByCampaign = new Map<number, number>();
	for (const row of counted) {
		totalsByCampaign.set(row.campaignId, (totalsByCampaign.get(row.campaignId) ?? 0) + 1);
	}

	// Only this page's holders: `claims` covers every candidate.
	const selectedIds = new Set(selected.map((r) => r.turfId));
	const holderAccounts = viewer.isAdmin
		? await loadHolderAccounts(
				db,
				claims.filter((c) => selectedIds.has(c.turfId)).map((c) => c.slackUserId),
			)
		: undefined;

	return {
		// toTurfView is the single gate on what reaches a viewer; see its header.
		// Nothing here should ever be spread from a raw row instead.
		turfs: selected.map((row) =>
			toTurfView(row, claims, viewer, now, {
				...claimOptions,
				refreshingRegions,
				walkReports,
				contactsThrough: marksFor(contactMarks, row.campaignId).cursor,
				showCampaign: badged.has(row.campaignId),
				disabledCampaigns: campaigns.disabled,
				holderAccounts,
			}),
		),
		total: counted.length,
		omitted,
		start,
		nextOffset,
		unavailable: claimableOnly ? boxed.length - candidates.length : 0,
		campaignBadges:
			badged.size > 0
				? Object.fromEntries([...badged].map((id) => [id, campaigns.badges[id] ?? '']))
				: null,
		campaignTotals:
			badged.size > 0
				? Object.fromEntries([...badged].map((id) => [id, totalsByCampaign.get(id) ?? 0]))
				: null,
	};
}

/** Map routes this user is actively holding, across every chapter. */
async function activeRouteIdsFor(db: Db, slackUserId: string): Promise<number[]> {
	const rows = await db
		.select({ turfId: vanTurfCheckouts.turfId })
		.from(vanTurfCheckouts)
		.where(
			and(
				eq(vanTurfCheckouts.slackUserId, slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	return rows.map((r) => r.turfId);
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
 * Everyone else's stays scoped by turfId, so a chapter's payload still
 * carries no evidence of activity in other chapters.
 */
async function claimsFor(
	db: Db,
	turfIds: number[],
	viewerSlackUserId: string,
): Promise<ClaimSnapshot[]> {
	if (turfIds.length === 0) return [];
	// Chunked because the `claimableOnly` path asks about a whole chapter. The
	// viewer's own claims come back in every chunk, so they are de-duplicated —
	// by route, which is safe because the partial unique index allows only one
	// open claim per route.
	const byRoute = new Map<number, typeof vanTurfCheckouts.$inferSelect>();
	for (const batch of chunked(turfIds)) {
		const rows = await db
			.select()
			.from(vanTurfCheckouts)
			.where(
				and(
					or(
						inArray(vanTurfCheckouts.turfId, batch),
						eq(vanTurfCheckouts.slackUserId, viewerSlackUserId),
					),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
				),
			);
		for (const row of rows) byRoute.set(row.turfId, row);
	}
	return [...byRoute.values()].map((c) => ({
		turfId: c.turfId,
		slackUserId: c.slackUserId,
		slackUserName: c.slackUserName,
		claimedAt: c.claimedAt,
		expiresAt: c.expiresAt,
		releasedAt: c.releasedAt,
		completedAt: c.completedAt,
	}));
}
