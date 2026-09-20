// Which turf a chapter can see.
//
// A folder may be mapped to several chapters, and then every turf in it belongs
// to all of them: a folder cut by region can span a dozen counties, and the
// chapters that canvass them overlap. So visibility is a property of the FOLDER
// MAPPING, read at query time, not of a chapter id stamped on the turf.
//
// `van_turfs.chapterId` still exists and still names one chapter — the first one
// mapped to that folder. It is a label for display and for anything that has to
// attribute a turf to a single chapter (the doors board, the activity feed);
// it is NOT what decides who may see or claim a turf. Using it for that is the
// bug this module replaces: the catalog wrote one row per route per chapter,
// every row keyed by route alone, so the last chapter written silently won and
// the other chapters saw none of that folder's turf.
//
// A correlated subquery rather than a join, so callers keep their existing
// `select()` shape and cannot accidentally multiply rows: a turf visible to
// three chapters is still one row.

import { sql, type SQL } from 'drizzle-orm';
import { vanTurfs, vanChapterFolders } from '../schema.js';

/**
 * A `where` fragment restricting turf to what `chapterId` may see.
 *
 * `null` means "every chapter" — the organizer-wide view — and returns
 * undefined so it composes with `and(...)` like any other optional filter.
 *
 * A chapter with no folders mapped sees nothing, which is correct and is also
 * the state every chapter starts in.
 */
export function visibleToChapter(chapterId: number | null): SQL | undefined {
	if (chapterId === null) return undefined;
	return sql`${vanTurfs.folderId} in (
		select ${vanChapterFolders.folderId} from ${vanChapterFolders}
		where ${vanChapterFolders.chapterId} = ${chapterId}
	)`;
}
