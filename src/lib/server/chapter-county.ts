// Chapter -> Michigan county, derived from zip_chapter_map (itself derived
// from member addresses — see attendee-sync.ts) joined against the Michigan
// zip-to-county lookup. Keyed by chapter *name* rather than chapter id so it
// applies safely to every dashboard source, including door-knock data whose
// chapter ids are synthetic per-window indices rather than real Solidarity ids.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { countyForZip } from '../data/michigan-zip-counties.js';
import { zipChapterMap } from './schema.js';
import { loadChapterNames } from './chapter-names.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

/** Chapter id -> county with the most members among that chapter's mapped
 *  zips. Ties broken by county name so the result is deterministic. */
function countyByChapterId(rows: { zipCode: string; chapterId: number; memberCount: number }[]) {
	const votes = new Map<number, Map<string, number>>();
	for (const row of rows) {
		const county = countyForZip(row.zipCode);
		if (!county) continue;
		const perChapter = votes.get(row.chapterId) ?? new Map<string, number>();
		perChapter.set(county, (perChapter.get(county) ?? 0) + row.memberCount);
		votes.set(row.chapterId, perChapter);
	}

	const result = new Map<number, string>();
	for (const [chapterId, perChapter] of votes) {
		let best: { county: string; count: number } | null = null;
		for (const [county, count] of perChapter) {
			if (!best || count > best.count || (count === best.count && county < best.county)) {
				best = { county, count };
			}
		}
		if (best) result.set(chapterId, best.county);
	}
	return result;
}

/** Chapter name (lowercased) -> Michigan county, for grouping the dashboard's
 *  county heatmap by real geography instead of guessing from the chapter's
 *  name string. Chapters with no mapped zips are simply absent from the map,
 *  so callers fall back to their existing name-based heuristic for them. */
export async function loadCountyByChapterName(db: Db): Promise<Map<string, string>> {
	const [zipRows, chapterNames] = await Promise.all([
		db.select().from(zipChapterMap),
		loadChapterNames(db),
	]);

	const byChapterId = countyByChapterId(zipRows);
	const byName = new Map<string, string>();
	for (const [chapterId, county] of byChapterId) {
		const name = chapterNames.get(chapterId);
		if (name) byName.set(name.toLowerCase(), county);
	}
	return byName;
}
