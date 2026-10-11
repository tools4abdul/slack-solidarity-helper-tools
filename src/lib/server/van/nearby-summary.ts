// The signed-out /turfs teaser's one database read.
//
// Reads every live turf near a point — across all chapters, since a visitor
// has no chapter yet — and reduces it to the three coarse answers in
// $lib/van/nearby-summary.ts. Nothing per-turf is returned: no id, name, hull,
// list number, holder or door total. See that module's header for why each
// answer is shaped the way it is.
//
// The door count is doors nobody has taken: turf a newcomer could pick up
// today. Whether a turf qualifies is decided by `canClaim` — the same rule the
// claim button enforces — with the per-volunteer cap switched off, which is
// how the Slack list's `claimableOnly` asks the same question. So claimed turf,
// turf handed out in VAN or the Packet Tracker, turf reported walked, and turf
// with no MiniVAN list number are all left out. The background grid still
// draws every live turf, taken or not, so a busy neighbourhood does not look
// empty.
//
// Who counts as "canvassing nearby", within NEARBY_RADIUS_MILES:
//
//   - anyone holding a live claim there;
//   - anyone who marked turf there walked, or had it walked out from under
//     them by a VAN refresh, in the last RECENT_ACTIVITY_HOURS;
//   - one person per turf VAN first saw loaded in MiniVAN outside our claims
//     in that same window — an organizer handing a list out directly.
//
// People are counted once however many turfs they hold. The Packet Tracker's
// `sheetAssignedTo` is left out: it carries no date and covers packets the
// campaign marked Complete long ago, so it would count people who are not out.

import { and, avg, between, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanCampaigns, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { turfCampaignEnabled } from './campaigns.js';
import { visibleToAnyChapter } from './chapter-visibility.js';
import { chunked } from './sql-chunk.js';
import { canClaim, isActive } from '../../van/checkout.js';
import { latestWalkReports } from './checkout-store.js';
import { haversineMeters, type LatLng } from '../../van/geometry.js';
import { doorsLeft, parseHull, turfSnapshot } from '../../van/turf-view.js';
import {
	canvasserLevel,
	coarsePoint,
	densityGrid,
	doorsHeadline,
	GRID_RADIUS_MILES,
	METRES_PER_MILE,
	NEARBY_RADIUS_MILES,
	RECENT_ACTIVITY_HOURS,
	type DensityCell,
	type DoorsHeadline,
} from '../../van/nearby-summary.js';

type Db = ReturnType<typeof drizzle>;

export interface NearbySummary {
	/** The point the summary is about, rounded to ~100 m. */
	centre: LatLng;
	doors: DoorsHeadline;
	/** Index into CANVASSER_LEVELS. */
	canvassers: number;
	cells: DensityCell[];
}

// Turf is selected by centroid. A hull can reach past its centroid, so the
// box is widened by this much to catch a turf centred just outside the grid
// whose edge still lands inside it.
const HULL_REACH_MILES = 1;

/** No viewer: the question is whether ANYONE could take a turf, so the
 *  per-volunteer cap is lifted and no claim can be this id's own. */
const ANYONE = '';
const NO_CAP = { maxConcurrentClaims: Number.MAX_SAFE_INTEGER };

export async function loadNearbySummary(
	db: Db,
	point: LatLng,
	now: Date = new Date(),
	/** The admin's hand-out TTL, so this counts the same turf as claimable
	 *  that the map does. */
	vanAssignmentTtlHours?: number,
	/** The chapters /turfs offers (turfChapters). Turf no one of them can see —
	 *  in folders mapped only to chapters hidden from /turfs — adds no doors
	 *  and is not drawn: a visitor told about it would sign in to find no
	 *  chapter that offers it. Null leaves turf unrestricted by chapter. */
	turfChapterIds: readonly number[] | null = null,
): Promise<NearbySummary> {
	const reach = GRID_RADIUS_MILES + HULL_REACH_MILES;
	const dLat = reach / 69.05;
	const dLng = reach / (69.17 * Math.max(0.05, Math.cos((point.lat * Math.PI) / 180)));

	// Each turf with whether it is on offer: its campaign enabled, not hidden
	// by an admin, and a chapter /turfs lists able to see it. Turf that is not
	// adds no doors and is not drawn — the signed-in map hides it the same
	// way — but anyone still walking it is still out canvassing, and still
	// counted.
	const reachable =
		turfChapterIds === null
			? sql<number>`1`
			: sql<number>`case when ${visibleToAnyChapter(turfChapterIds)} then 1 else 0 end`;
	const rows = await db
		.select({ turf: vanTurfs, campaignEnabled: vanCampaigns.enabled, reachable })
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(
			and(
				isNull(vanTurfs.retiredAt),
				isNotNull(vanTurfs.centroidLat),
				isNotNull(vanTurfs.centroidLng),
				between(vanTurfs.centroidLat, point.lat - dLat, point.lat + dLat),
				between(vanTurfs.centroidLng, point.lng - dLng, point.lng + dLng),
			),
		);

	const nearbyLimit = NEARBY_RADIUS_MILES * METRES_PER_MILE;
	const turfs = rows.map(({ turf, campaignEnabled, reachable }) => {
		const centre = { lat: turf.centroidLat!, lng: turf.centroidLng! };
		return {
			...turf,
			offered: campaignEnabled && Number(reachable) === 1 && turf.hiddenAt === null,
			centre,
			nearby: haversineMeters(point, centre) <= nearbyLimit,
		};
	});
	const nearby = turfs.filter((t) => t.nearby);
	const offered = turfs.filter((t) => t.offered);
	const nearbyOffered = nearby.filter((t) => t.offered);

	const nearbyIds = nearby.map((t) => t.turfId);
	const claims: (typeof vanTurfCheckouts.$inferSelect)[] = [];
	for (const batch of chunked(nearbyIds)) {
		claims.push(
			...(await db.select().from(vanTurfCheckouts).where(inArray(vanTurfCheckouts.turfId, batch))),
		);
	}
	const walkReports = await latestWalkReports(db, nearbyIds);

	const available = nearbyOffered.filter(
		(t) =>
			canClaim(
				turfSnapshot(t, now, { walkReports, vanAssignmentTtlHours }),
				claims,
				ANYONE,
				now,
				NO_CAP,
			).ok,
	);
	const doors = available.reduce((sum, t) => sum + Math.max(0, doorsLeft(t)), 0);

	const cutoff = now.getTime() - RECENT_ACTIVITY_HOURS * 3600 * 1000;
	const recent = (iso: string | null) => iso !== null && Date.parse(iso) >= cutoff;

	const people = new Set<string>();
	for (const claim of claims) {
		const walkedOut = claim.releaseReason === 'walked-out' && recent(claim.releasedAt);
		if (isActive(claim, now) || recent(claim.completedAt) || walkedOut) {
			people.add(`slack:${claim.slackUserId}`);
		}
	}
	for (const turf of nearby) {
		if (recent(turf.vanAssignedAt)) people.add(`van:${turf.turfId}`);
	}

	return {
		centre: coarsePoint(point),
		doors: doorsHeadline(doors, nearbyOffered.length > 0),
		canvassers: canvasserLevel(people.size),
		cells: densityGrid(
			offered.map((t) => ({ doors: doorsLeft(t), centre: t.centre, hull: parseHull(t.hullJson) })),
			point,
		),
	};
}

/**
 * Where to point the teaser's map before the visitor has said where they are:
 * the average of all live turf, rounded to a tenth of a degree (~10 km). That
 * says which region the campaign works in, which its own website already does,
 * and nothing finer. Null when there is no mapped turf.
 */
export async function loadTurfCentre(
	db: Db,
	/** As loadNearbySummary's: only turf a chapter /turfs lists can see. */
	turfChapterIds: readonly number[] | null = null,
): Promise<LatLng | null> {
	const [row] = await db
		.select({ lat: avg(vanTurfs.centroidLat), lng: avg(vanTurfs.centroidLng) })
		.from(vanTurfs)
		.where(
			and(
				isNull(vanTurfs.retiredAt),
				isNull(vanTurfs.hiddenAt),
				turfCampaignEnabled(),
				turfChapterIds === null ? undefined : visibleToAnyChapter(turfChapterIds),
				isNotNull(vanTurfs.centroidLat),
				isNotNull(vanTurfs.centroidLng),
			),
		);
	const lat = Number(row?.lat);
	const lng = Number(row?.lng);
	if (row?.lat === null || row?.lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return null;
	}
	return { lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 };
}
