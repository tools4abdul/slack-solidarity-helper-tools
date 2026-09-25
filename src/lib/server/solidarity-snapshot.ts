// Pure shared logic for the nightly Solidarity signup snapshot. Both the
// SvelteKit endpoint (api/internal/solidarity-snapshot) and the standalone
// script (scripts/solidarity-snapshot.ts) call runSolidaritySnapshot().
//
// Intentionally has no `$env/*` or `$lib/*` imports so the script (which runs
// outside the Vite bundle via tsx) can import this module via relative path.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { solidarityDailySnapshots } from './schema.js';
import { fetchPaginated } from './solidarity-paginate.js';
import { chapterIdsOf } from './solidarity-chapter-ids.js';

interface SolidarityUserPage {
	chapter_id: number | null;
	chapter_ids: number[];
	created_at: string; // ISO 8601
}

interface SolidarityChapter {
	id: number;
	name: string;
}

export interface SnapshotRow {
	date: string;
	chapterId: number;
	chapterName: string | null;
	count: number;
}

export interface SnapshotResult {
	date: string;
	rangeStartUnix: number;
	rangeEndUnix: number;
	usersScanned: number;
	usersInRange: number;
	rows: SnapshotRow[];
}

const NULL_CHAPTER_SENTINEL = -1;
// Sentinel chapter_id for the per-day distinct-user count row. Stored alongside
// the per-chapter buckets so the dashboard can show the true daily total
// without double-counting users who belong to multiple chapters. Readers
// MUST filter this out before treating rows as real chapters.
export const DISTINCT_TOTAL_SENTINEL = -2;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTC midnight-to-midnight range for the given YYYY-MM-DD date,
 * or for "yesterday" relative to now if no date is given.
 */
export function dateRangeUtc(date?: string): {
	dateStr: string;
	startUnix: number;
	endUnix: number;
} {
	let target: Date;
	if (date) {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
		if (!match) throw new Error(`Invalid date (want YYYY-MM-DD): ${date}`);
		const [, y, m, d] = match;
		target = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
	} else {
		const now = new Date();
		const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		target = new Date(todayUtc - 24 * 60 * 60 * 1000);
	}
	const dateStr = target.toISOString().slice(0, 10);
	const startUnix = Math.floor(target.getTime() / 1000);
	const endUnix = startUnix + 24 * 60 * 60;
	return { dateStr, startUnix, endUnix };
}

// ---------------------------------------------------------------------------
// Solidarity fetch
// ---------------------------------------------------------------------------

// Solidarity's /v1/users supports _since (updated_at filter, Unix seconds),
// _limit, and _offset — but no _sort and no created_at filter. We use _since
// as a superset filter (every user created in our window also has
// updated_at >= startUnix), then narrow client-side on created_at. There's no
// safe way to early-terminate without sort guarantees, so we walk to the end.
function fetchUsersUpdatedSince(apiToken: string, startUnix: number) {
	return fetchPaginated<SolidarityUserPage>(
		apiToken,
		'/v1/users',
		'/v1/users',
		`&_since=${startUnix}`,
		'snapshot',
	);
}

async function fetchAllChapters(apiToken: string): Promise<Map<number, string>> {
	const chapters = await fetchPaginated<SolidarityChapter>(
		apiToken,
		'/v1/chapters',
		'/v1/chapters',
		'',
		'snapshot',
	);
	return new Map(chapters.map((c) => [c.id, c.name]));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function bucketByChapter(
	users: SolidarityUserPage[],
	chapterNames: Map<number, string>,
	dateStr: string,
): SnapshotRow[] {
	const counts = new Map<number, number>();
	for (const user of users) {
		const ids = chapterIdsOf(user);
		if (ids.length === 0) {
			counts.set(NULL_CHAPTER_SENTINEL, (counts.get(NULL_CHAPTER_SENTINEL) ?? 0) + 1);
		} else {
			for (const id of ids) {
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
	}
	const rows: SnapshotRow[] = [...counts.entries()]
		.sort(([a], [b]) => a - b)
		.map(([chapterId, count]) => ({
			date: dateStr,
			chapterId,
			chapterName:
				chapterId === NULL_CHAPTER_SENTINEL ? null : (chapterNames.get(chapterId) ?? null),
			count,
		}));
	// Distinct-user count for the day — emitted only when at least one user
	// landed in range so we don't gratuitously create zero rows on empty days.
	// Sorts first because -2 < -1 < any real chapter id.
	if (users.length > 0) {
		rows.unshift({
			date: dateStr,
			chapterId: DISTINCT_TOTAL_SENTINEL,
			chapterName: null,
			count: users.length,
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSolidaritySnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	apiToken: string,
	options: { date?: string; dryRun?: boolean } = {},
): Promise<SnapshotResult> {
	const { dateStr, startUnix, endUnix } = dateRangeUtc(options.date);

	const chapterNames = await fetchAllChapters(apiToken);
	const fetched = await fetchUsersUpdatedSince(apiToken, startUnix);

	if (options.dryRun && fetched.length > 0) {
		console.log('--- sample user (first returned) ---');
		console.log(JSON.stringify(fetched[0], null, 2));
		console.log('--- end sample ---');
		const dates = fetched.map((u) => u.created_at).filter(Boolean);
		if (dates.length) {
			console.log(`created_at values seen: min=${dates.reduce((a, b) => (a < b ? a : b))}`);
			console.log(`                       max=${dates.reduce((a, b) => (a > b ? a : b))}`);
		}
	}

	const inRange = fetched.filter((u) => {
		const t = Math.floor(new Date(u.created_at).getTime() / 1000);
		return t >= startUnix && t < endUnix;
	});

	const rows = bucketByChapter(inRange, chapterNames, dateStr);

	if (!options.dryRun) {
		for (const row of rows) {
			await db
				.insert(solidarityDailySnapshots)
				.values(row)
				.onConflictDoUpdate({
					target: [solidarityDailySnapshots.date, solidarityDailySnapshots.chapterId],
					set: { chapterName: row.chapterName, count: row.count },
				});
		}
	}

	return {
		date: dateStr,
		rangeStartUnix: startUnix,
		rangeEndUnix: endUnix,
		usersScanned: fetched.length,
		usersInRange: inRange.length,
		rows,
	};
}
