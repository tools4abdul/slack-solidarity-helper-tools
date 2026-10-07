// The campaign's Walk Ins tab: one row per turf checkout, beside the Packet
// Tracker in the same spreadsheet.
//
// Unlike the Packet Tracker, nothing is listed in advance. The campaign fills
// rows in from the top down and empties the tab every day, so a checkout takes
// the first empty row below the header, and the store records which row that
// was so it can find it again later — it need not be the last by then.
//
// What the app fills in:
//   Name              the volunteer's display name
//   Shift Start Time  a drop-down ("10am", "1pm", …): the latest shift start
//                     at or before the claim, the first when it is earlier
//   Final Status      a drop-down: "Completed" once the turf is marked walked;
//                     otherwise the campaign's to set
// Phone, Email and Zip Code stay blank — the app holds no phone or zip for a
// volunteer, and PRIVACY.md promises their email never reaches the campaign's
// spreadsheets. Notes, In VAN? and Reshifted? are the campaign's.
//
// A row is there exactly while the checkout keeps a Packet Tracker entry
// (`desiredCells`): a give-back clears it, an expiry clears it once no doors
// were knocked. Clearing empties the cells we wrote and takes the highlight
// off; the row is never deleted, so nothing below it moves.
//
// Pure — no DB, no network. The store is packet-tracker-store.ts.

import { campaignDayKey, campaignTimeLabel } from '../campaign-time.js';
import { HEADER_SEARCH_ROWS, normaliseHeader } from './packet-tracker.js';

export const WALK_IN_TAB_NAME = 'Walk Ins';

/** Every column of the tab, in the campaign's order. All are highlighted on
 *  our row, and a row is empty only when all of them are. */
export const WALK_IN_COLUMNS = [
	'Name',
	'Shift Start Time',
	'Phone',
	'Email',
	'Zip Code',
	'Notes',
	'Final Status',
	'In VAN?',
	'Reshifted?',
] as const;

export type WalkInColumn = (typeof WALK_IN_COLUMNS)[number];

/** One option of the Shift Start Time drop-down: what it shows, and whether
 *  the cell holds it as text (written with an apostrophe to stay text) or as
 *  a real time (written as typed, for Sheets to read as one). */
export interface ShiftOption {
	label: string;
	text: boolean;
}

/** The shift starts the campaign's drop-down offered when this was written,
 *  used when the drop-down itself cannot be read. Typed into the rule, so
 *  text. */
export const DEFAULT_SHIFT_STARTS: readonly ShiftOption[] = ['10am', '1pm', '4pm', '6pm'].map(
	(label) => ({ label, text: true }),
);

/** Final Status for a turf marked walked — one of the drop-down's options. */
export const COMPLETED_STATUS = 'Completed';

/**
 * When a canvass day ends, in campaign hours past midnight. A claim at 11pm
 * handed back at 12:30am is the same day's walk-in, and the campaign does not
 * empty the tab in the small hours.
 */
const DAY_ROLLOVER_HOURS = 4;

/** The canvass day a moment belongs to, as `YYYY-MM-DD`. */
export function walkInDay(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return '';
	return campaignDayKey(new Date(ms - DAY_ROLLOVER_HOURS * 60 * 60 * 1000).toISOString());
}

export interface WalkInLayout {
	headerRowIndex: number;
	/** 0-based index per column the tab has. Name and Shift Start Time always. */
	columns: Partial<Record<WalkInColumn, number>> & Record<'Name' | 'Shift Start Time', number>;
}

/**
 * Find the header row: the one, within the first few, naming the most of the
 * tab's columns. Null when it lacks Name or Shift Start Time.
 */
export function findWalkInLayout(values: readonly (readonly string[])[]): WalkInLayout | null {
	let best: { row: number; found: Map<WalkInColumn, number> } | null = null;
	for (let row = 0; row < Math.min(values.length, HEADER_SEARCH_ROWS); row++) {
		const byName = new Map<string, number>();
		(values[row] ?? []).forEach((cell, i) => {
			const key = normaliseHeader(cell ?? '');
			if (key && !byName.has(key)) byName.set(key, i);
		});
		const found = new Map<WalkInColumn, number>();
		for (const column of WALK_IN_COLUMNS) {
			const index = byName.get(normaliseHeader(column));
			if (index !== undefined) found.set(column, index);
		}
		if (!best || found.size > best.found.size) best = { row, found };
	}
	if (!best?.found.has('Name') || !best.found.has('Shift Start Time')) return null;
	return {
		headerRowIndex: best.row,
		columns: Object.fromEntries(best.found) as WalkInLayout['columns'],
	};
}

/** Every column of ours the tab has, for the highlight. */
export function walkInColumnIndexes(layout: WalkInLayout): number[] {
	return WALK_IN_COLUMNS.flatMap((c) => {
		const index = layout.columns[c];
		return index === undefined ? [] : [index];
	});
}

function cell(row: readonly string[] | undefined, layout: WalkInLayout, column: WalkInColumn) {
	const index = layout.columns[column];
	return index === undefined ? '' : (row?.[index] ?? '').trim();
}

/** Whether nobody has written in this row: every known column blank. An
 *  unpicked drop-down reads as blank. */
export function isEmptyWalkIn(row: readonly string[] | undefined, layout: WalkInLayout): boolean {
	return WALK_IN_COLUMNS.every((c) => cell(row, layout, c) === '');
}

/**
 * The first empty row below the header, skipping `taken` — rows this run has
 * already filled in or found in use, which the tab as read does not show.
 * Past the last row read when every one is in use: the values API leaves
 * trailing blank rows out.
 */
export function firstEmptyWalkInRow(
	values: readonly (readonly string[])[],
	layout: WalkInLayout,
	taken: ReadonlySet<number> = new Set(),
): number {
	let row = layout.headerRowIndex + 1;
	while (row < values.length && (taken.has(row) || !isEmptyWalkIn(values[row], layout))) row++;
	while (taken.has(row)) row++;
	return row;
}

/** Minutes past midnight for a time as people write it: "10am", "1 pm",
 *  "10:30 AM", "16:00", "10:00:00 AM". Null for anything else. */
export function shiftMinutes(text: string): number | null {
	const m = /^\s*(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(text);
	if (!m) return null;
	let hour = Number(m[1]);
	const minute = Number(m[2] ?? 0);
	const half = m[3]?.toLowerCase();
	if (minute > 59 || hour > 23 || (half && (hour < 1 || hour > 12))) return null;
	if (half === 'p' && hour !== 12) hour += 12;
	if (half === 'a' && hour === 12) hour = 0;
	return hour * 60 + minute;
}

/**
 * The shift a claim belongs to: the latest option starting at or before the
 * claim, in the campaign's clock, or the earliest when the claim comes before
 * every one. Null when no option reads as a time.
 */
export function shiftFor(claimedAt: string, options: readonly ShiftOption[]): ShiftOption | null {
	const claimed = shiftMinutes(campaignTimeLabel(claimedAt));
	const timed = options
		.map((option) => ({ option, minutes: shiftMinutes(option.label) }))
		.filter((o): o is { option: ShiftOption; minutes: number } => o.minutes !== null)
		.sort((a, b) => a.minutes - b.minutes);
	if (timed.length === 0) return null;
	if (claimed === null) return timed[0]!.option;
	let pick = timed[0]!;
	for (const o of timed) if (o.minutes <= claimed) pick = o;
	return pick.option;
}

/** The cells a checkout fills in on its row: Name, and Shift Start Time
 *  when it has one. Final Status comes later, once walked. */
export function walkInCells(
	checkout: { slackUserName: string },
	shift: string | null,
): Array<[WalkInColumn, string]> {
	const cells: Array<[WalkInColumn, string]> = [['Name', checkout.slackUserName]];
	if (shift !== null) cells.push(['Shift Start Time', shift]);
	return cells;
}

/**
 * `[column index, value]` per cell, as the values API wants them. Written
 * USER_ENTERED, so text carries Sheets' leading apostrophe: a name cannot be
 * a formula, and a drop-down option that is text ("10am") stays the text the
 * drop-down lists instead of becoming a time that no longer matches it. A
 * shift the drop-down holds as a real time is written as typed, for Sheets to
 * read the same way (`shiftAsTyped`). Blanks are blanks.
 */
export function walkInWrites(
	cells: ReadonlyArray<readonly [WalkInColumn, string]>,
	layout: WalkInLayout,
	options: { shiftAsTyped?: boolean } = {},
): Array<[number, string]> {
	return cells.flatMap(([column, value]) => {
		const index = layout.columns[column];
		if (index === undefined) return [];
		const asText = value !== '' && !(column === 'Shift Start Time' && options.shiftAsTyped);
		return [[index, asText ? `'${value}` : value] as [number, string]];
	});
}

/** What tells a checkout's row from anyone else's: the Name it wrote, and
 *  the shift when it wrote one. */
export interface WalkInMark {
	name: string;
	shift: string | null;
}

function sameText(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether the row holds this entry: our Name and, when we wrote one, our
 *  shift. Once someone has typed over either, the row is theirs. */
export function isOurWalkIn(
	row: readonly string[] | undefined,
	layout: WalkInLayout,
	ours: WalkInMark,
): boolean {
	if (cell(row, layout, 'Name') !== ours.name.trim()) return false;
	return ours.shift === null || sameText(cell(row, layout, 'Shift Start Time'), ours.shift);
}

/** The row's Final Status, as displayed. */
export function walkInStatus(row: readonly string[] | undefined, layout: WalkInLayout): string {
	return cell(row, layout, 'Final Status');
}

/**
 * Where our row went, when it is no longer at the row recorded: the campaign
 * may have deleted, inserted or sorted rows since. The one row with our Name
 * — and our Shift Start Time, when we wrote one — that is not `exclude`d (the
 * rows other checkouts hold). Null when there is none, or more than one: a
 * guess could clear somebody else's walk-in.
 */
export function findOurWalkIn(
	values: readonly (readonly string[])[],
	layout: WalkInLayout,
	ours: WalkInMark,
	exclude: ReadonlySet<number>,
): number | null {
	const matches: number[] = [];
	for (let i = layout.headerRowIndex + 1; i < values.length; i++) {
		if (!exclude.has(i) && isOurWalkIn(values[i], layout, ours)) matches.push(i);
	}
	return matches.length === 1 ? matches[0]! : null;
}
