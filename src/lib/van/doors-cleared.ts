// What the campaign actually cleared, from the checkout ledger.
//
// This is the source every door-knock number on the dashboard now comes from,
// and it is a different measurement from the one Openfield fed. Worth being
// precise about, because the words on the page changed with it:
//
//   - **Doors cleared** — doors that left a turf between the moment a volunteer
//     claimed it and VAN's first recount after they marked it walked
//     (`confirmed_door_delta`, stamped by door-delta-store.ts). NOT "doors
//     knocked": a not-home door stays on the list, so an unanswered knock leaves
//     no trace VAN will ever show us (plan.md §2, Constraint C).
//   - **Turfs completed** and **canvassers out** — straight off the ledger,
//     exact and instant.
//
// Two clocks, and the UI has to keep them apart (plan.md 9.6): a completion is
// known the second a volunteer taps the button, while its doors are unknown
// until VAN re-cuts the region — usually that night. So a completion whose
// delta is still NULL counts as a completed turf and contributes no doors, and
// anything that totals doors says how many turfs are still waiting on VAN.
//
// **The ledger is the whole world here.** Turf an organizer assigned by hand in
// VAN never passes through a checkout row, so none of these numbers see it.
// That is the deliberate trade recorded in plan.md 9.5 — every figure on the
// board reconciles with every other one, at the cost of undercounting a
// campaign that also assigns turf outside this app. Any surface built on this
// module has to say so rather than implying full coverage.
//
// Pure: no DB, no clock of its own beyond the campaign calendar.

import { campaignDayKey } from '../campaign-time.js';

/** One completed checkout, joined to the turf it was on. */
export interface ClearedRow {
	mapRouteId: number;
	chapterId: number;
	chapterName: string;
	slackUserId: string;
	slackUserName: string;
	/** ISO-8601 UTC. Bucketed into campaign-local days, so an evening canvass
	 *  lands on the day the volunteer was actually out. */
	completedAt: string;
	/** Doors confirmed cleared, or null while VAN has not recounted yet. Null
	 *  is not zero: see the header. */
	doorsCleared: number | null;
}

export interface ChapterDayTotals {
	chapterId: number;
	chapterName: string;
	doorsCleared: number;
	turfsCompleted: number;
}

export interface DoorsDay {
	/** Campaign-local calendar day, `YYYY-MM-DD`. */
	date: string;
	doorsCleared: number;
	turfsCompleted: number;
	/** Completions on this day whose doors VAN has not counted yet. */
	awaitingCount: number;
	byChapter: ChapterDayTotals[];
}

export interface ChapterTotals {
	chapterId: number;
	chapterName: string;
	doorsCleared: number;
	turfsCompleted: number;
	/** Distinct volunteers who completed turf here in the window. */
	canvassers: number;
	awaitingCount: number;
}

export interface CanvasserTotals {
	slackUserId: string;
	slackUserName: string;
	doorsCleared: number;
	turfsCompleted: number;
	/** The chapter they cleared the most doors in — a ticker cell has room for
	 *  one. Ties and door-less days fall back to the chapter they completed the
	 *  most turf in, then to the first seen, so the field is never blank for
	 *  someone who was out. */
	chapterName: string;
}

/** Doors on a row, treating "not counted yet" as no doors rather than as zero
 *  doors — the difference is carried by `awaitingCount` alongside it. */
function doorsOf(row: ClearedRow): number {
	return row.doorsCleared ?? 0;
}

function keyFor(row: ClearedRow): string {
	return campaignDayKey(row.completedAt);
}

/**
 * Per-day totals with a per-chapter breakdown, oldest first.
 *
 * Days with no completions are absent rather than zero-filled: the chart's own
 * range logic decides what an empty day looks like, and the pace projection
 * treats a missing day differently from a quiet one.
 */
export function dailyDoorsCleared(rows: readonly ClearedRow[]): DoorsDay[] {
	const days = new Map<string, DoorsDay>();
	const chapters = new Map<string, Map<number, ChapterDayTotals>>();

	for (const row of rows) {
		const date = keyFor(row);
		if (!date) continue;

		let day = days.get(date);
		if (!day) {
			day = { date, doorsCleared: 0, turfsCompleted: 0, awaitingCount: 0, byChapter: [] };
			days.set(date, day);
			chapters.set(date, new Map());
		}
		day.doorsCleared += doorsOf(row);
		day.turfsCompleted += 1;
		if (row.doorsCleared === null) day.awaitingCount += 1;

		const byChapter = chapters.get(date)!;
		let chapter = byChapter.get(row.chapterId);
		if (!chapter) {
			chapter = {
				chapterId: row.chapterId,
				chapterName: row.chapterName,
				doorsCleared: 0,
				turfsCompleted: 0,
			};
			byChapter.set(row.chapterId, chapter);
		}
		chapter.doorsCleared += doorsOf(row);
		chapter.turfsCompleted += 1;
	}

	for (const [date, byChapter] of chapters) {
		days.get(date)!.byChapter = [...byChapter.values()].sort((a, b) =>
			a.chapterName.localeCompare(b.chapterName),
		);
	}

	return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Chapter rollup across the whole set — the weekly board's input. */
export function chapterTotals(rows: readonly ClearedRow[]): ChapterTotals[] {
	const totals = new Map<number, ChapterTotals & { people: Set<string> }>();

	for (const row of rows) {
		let entry = totals.get(row.chapterId);
		if (!entry) {
			entry = {
				chapterId: row.chapterId,
				chapterName: row.chapterName,
				doorsCleared: 0,
				turfsCompleted: 0,
				canvassers: 0,
				awaitingCount: 0,
				people: new Set<string>(),
			};
			totals.set(row.chapterId, entry);
		}
		entry.doorsCleared += doorsOf(row);
		entry.turfsCompleted += 1;
		if (row.doorsCleared === null) entry.awaitingCount += 1;
		entry.people.add(row.slackUserId);
	}

	return [...totals.values()]
		.map(({ people, ...rest }) => ({ ...rest, canvassers: people.size }))
		.sort((a, b) => a.chapterName.localeCompare(b.chapterName));
}

/**
 * Per-person totals, ranked — the LED ticker's standings.
 *
 * Ranked by doors first and turfs second, which matters because of the two
 * clocks: someone who finished three turfs an hour ago has no doors to their
 * name yet, and ordering on doors alone would leave them off a board they are
 * currently topping. Ties break by name so the order is stable between refreshes.
 */
export function canvasserTotals(rows: readonly ClearedRow[]): CanvasserTotals[] {
	const byPerson = new Map<
		string,
		CanvasserTotals & { chapterDoors: Map<string, number>; chapterTurfs: Map<string, number> }
	>();

	for (const row of rows) {
		let entry = byPerson.get(row.slackUserId);
		if (!entry) {
			entry = {
				slackUserId: row.slackUserId,
				slackUserName: row.slackUserName,
				doorsCleared: 0,
				turfsCompleted: 0,
				chapterName: row.chapterName,
				chapterDoors: new Map(),
				chapterTurfs: new Map(),
			};
			byPerson.set(row.slackUserId, entry);
		}
		entry.doorsCleared += doorsOf(row);
		entry.turfsCompleted += 1;
		entry.chapterDoors.set(
			row.chapterName,
			(entry.chapterDoors.get(row.chapterName) ?? 0) + doorsOf(row),
		);
		entry.chapterTurfs.set(row.chapterName, (entry.chapterTurfs.get(row.chapterName) ?? 0) + 1);
	}

	return [...byPerson.values()]
		.map(({ chapterDoors, chapterTurfs, ...rest }) => ({
			...rest,
			chapterName: busiestChapter(chapterDoors, chapterTurfs, rest.chapterName),
		}))
		.sort(
			(a, b) =>
				b.doorsCleared - a.doorsCleared ||
				b.turfsCompleted - a.turfsCompleted ||
				a.slackUserName.localeCompare(b.slackUserName),
		);
}

function busiestChapter(
	doors: Map<string, number>,
	turfs: Map<string, number>,
	fallback: string,
): string {
	let best = fallback;
	let bestDoors = -1;
	let bestTurfs = -1;
	for (const [name, count] of doors) {
		const turfCount = turfs.get(name) ?? 0;
		if (count > bestDoors || (count === bestDoors && turfCount > bestTurfs)) {
			best = name;
			bestDoors = count;
			bestTurfs = turfCount;
		}
	}
	return best;
}

/** The most recent campaign day with any completion on it. What the ticker
 *  shows: on a canvass day that is today, and overnight it holds the day that
 *  just finished rather than blanking out. */
export function latestActiveDay(rows: readonly ClearedRow[]): string | null {
	let latest: string | null = null;
	for (const row of rows) {
		const date = keyFor(row);
		if (!date) continue;
		if (latest === null || date > latest) latest = date;
	}
	return latest;
}

/** Rows completed on one campaign day. */
export function rowsOnDay(rows: readonly ClearedRow[], date: string): ClearedRow[] {
	return rows.filter((row) => keyFor(row) === date);
}

/**
 * How many measured completions in a row must read zero before we say
 * something. Small enough to catch a mis-cut region in its first weekend, big
 * enough that one volunteer forgetting to sync is not a campaign-wide alarm.
 */
export const UNMOVED_WARNING_SAMPLE = 5;

/**
 * The health check behind plan.md 9.4, and the biggest risk in the whole story.
 *
 * Every doors number here depends on a turf-cutting rule nobody in this
 * codebase controls: the map region's criteria must filter to *not yet
 * contacted*. Cut without that filter, `doorCount` never shrinks, every delta
 * is zero, and the board reads as a campaign that knocked nothing — which looks
 * like a bug in this app and is not one. The symptom is indistinguishable from
 * "nobody synced MiniVAN", so the message names both causes rather than
 * guessing.
 *
 * Returns null when the sample is too small to mean anything, which is the
 * common case on a quiet week.
 */
export function unmovedDoorsWarning(
	rows: readonly ClearedRow[],
	sample: number = UNMOVED_WARNING_SAMPLE,
): string | null {
	const measured = rows.filter((row) => row.doorsCleared !== null);
	if (measured.length < sample) return null;
	if (measured.some((row) => (row.doorsCleared ?? 0) > 0)) return null;

	return (
		`${measured.length} completed turfs in a row cleared zero doors. Either MiniVAN is not being ` +
		'synced, or the map regions were cut without a "not yet contacted" filter — in which case ' +
		'doorCount never shrinks and the canvassing board will read as zero however many doors are knocked.'
	);
}
