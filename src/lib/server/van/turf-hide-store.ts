// Hiding one turf from volunteers, from its card on /turfs, and listing what
// is hidden for /turfs/organizer, where it can be shown again.
//
// For turf an organizer does not want handed out — a bad cut, a list being
// handled offline — without waiting on VAN. What hiding does is enforced
// elsewhere: loadChapterTurfs leaves it out for everyone but admins, and
// canClaim refuses it. This module only writes the stamp.
//
// A live claim on hidden turf is left alone. Hiding stops new claims, the way
// disabling a campaign does, and the volunteer holding it keeps their list.

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfs } from '../schema.js';
import { visibleToChapter } from './chapter-visibility.js';
import { inCampaign } from './campaigns.js';
import { doorsLeftColumn, type HoldingsQuery } from './holdings-store.js';

type Db = ReturnType<typeof drizzle>;

/** Hide `turfId` from volunteers, or show it again. False when there is no
 *  such turf. */
export async function setTurfHidden(
	db: Db,
	turfId: number,
	hidden: boolean,
	editor: { id: string; name: string },
	now: Date,
): Promise<boolean> {
	const updated = await db
		.update(vanTurfs)
		.set(
			hidden
				? { hiddenAt: now.toISOString(), hiddenBy: editor.name }
				: { hiddenAt: null, hiddenBy: null },
		)
		.where(eq(vanTurfs.turfId, turfId))
		.returning({ turfId: vanTurfs.turfId });
	if (updated.length === 0) return false;
	console.log(
		`[van] turf ${turfId} ${hidden ? 'hidden from' : 'shown to'} volunteers by ${editor.id} (${editor.name})`,
	);
	return true;
}

export interface HiddenTurfRow {
	turfId: number;
	turfName: string;
	regionName: string;
	chapterName: string;
	campaignId: number;
	/** Doors left, as the volunteer card counts them. */
	doorCount: number;
	hiddenAt: string;
	hiddenBy: string | null;
}

/**
 * Hidden turf in the organizer page's scope, most recently hidden first.
 *
 * Retired turf is left out: VAN has replaced it, so there is nothing to show
 * again, and its replacement routes start visible.
 */
export async function loadHiddenTurfs(db: Db, query: HoldingsQuery): Promise<HiddenTurfRow[]> {
	const rows = await db
		.select({
			turfId: vanTurfs.turfId,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterName: vanTurfs.chapterName,
			campaignId: vanTurfs.campaignId,
			doorCount: doorsLeftColumn,
			hiddenAt: vanTurfs.hiddenAt,
			hiddenBy: vanTurfs.hiddenBy,
		})
		.from(vanTurfs)
		.where(
			and(
				isNotNull(vanTurfs.hiddenAt),
				isNull(vanTurfs.retiredAt),
				// The chapter's folders, as the rest of the page scopes it.
				visibleToChapter(query.chapterId),
				inCampaign(query.campaignId),
			),
		)
		.orderBy(desc(vanTurfs.hiddenAt));
	return rows.map((r) => ({ ...r, hiddenAt: r.hiddenAt! }));
}
