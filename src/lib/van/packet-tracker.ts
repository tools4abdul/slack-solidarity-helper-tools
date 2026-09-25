// The campaign's Packet Tracker tab: what our row for a checkout should say,
// and what the campaign's own rows say about who already has which turf.
//
// The campaign records every turf handed out — by us or by an organizer with a
// clipboard — in one tab it owns, one row per turf taken. So this is not a log.
// A checkout has at most ONE row, and that row is kept current:
//
//   claimed                  → row appended, Status Unwalked
//   list loaded in MiniVAN   → Time Departed filled, Status Out
//   marked walked            → Doors Knocked and Knocked % filled,
//                              Status Complete (100%) or Incomplete
//   released, never loaded   → row cleared (see below)
//   released after loading   → Status Incomplete
//
// "Cleared", not deleted. The Sheets API deletes rows by position only, and a
// position read a moment earlier can belong to someone else's row by the time
// the delete lands — tested 2026-09-24, and no guard request makes that batch
// fail. Clearing is done by the row's hidden developer-metadata tag, which
// Google resolves itself, so it cannot touch a row the campaign typed. A
// campaign-entered row is never modified by this app, in any way.
//
// Columns are found by header name, not position, because the tab is the
// campaign's and they rearrange it. Pure — no DB, no network. The store is
// packet-tracker-store.ts.

import { campaignTimeLabel, CAMPAIGN_TIME_ZONE } from '../campaign-time.js';

/** The tab, when an admin has not named another. */
export const DEFAULT_SHEET_TAB_NAME = 'Packet Tracker';

/** The developer-metadata key on every row this app wrote; the value is the
 *  checkout id. Invisible in the sheet, and it stays with the row through
 *  sorts and inserts. It is the ONLY thing that makes a row ours. */
export const ROW_TAG_KEY = 'solidarity-helper-checkout';

export const PACKET_COLUMNS = [
	'Packet Name',
	'Voters',
	'Doors',
	'List Number',
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Time Departed',
	'Walk Mode',
	'Phone Number',
	'Doors Knocked',
	'Status',
	'Knocked %',
] as const;

export type PacketColumn = (typeof PACKET_COLUMNS)[number];

/** Written once, when the row is appended, and never again. Everything else
 *  is re-derived every run and rewritten only when it changes — so a campaign
 *  edit to one of these (a corrected name, say) is not reverted by a re-cut
 *  moving VAN's door count. */
const WRITE_ONCE: ReadonlySet<PacketColumn> = new Set([
	'Packet Name',
	'Voters',
	'Doors',
	'List Number',
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Walk Mode',
]);

/** The two cells checked before clearing a row. If either no longer holds what
 *  we wrote, somebody has typed over our row and it is theirs now. */
const OWNERSHIP_COLUMNS: readonly PacketColumn[] = ['List Number', 'Canvasser'];

/** A Status on a campaign row that means the turf is taken. Incomplete is
 *  not: that turf is back in play. */
const BLOCKING_STATUSES: ReadonlySet<string> = new Set(['unwalked', 'out', 'complete']);

export type PacketStatus = 'Unwalked' | 'Out' | 'Complete' | 'Incomplete';

export type PacketCells = Partial<Record<PacketColumn, string>>;

/** What a checkout row and its turf offer. Structurally satisfied by the
 *  store's candidate query. */
export interface PacketCheckout {
	checkoutId: number;
	claimedAt: string;
	releasedAt: string | null;
	completedAt: string | null;
	reportedPercent: number | null;
	loadedInMinivanAt: string | null;
	slackUserName: string;
	issuedListNumber: string | null;
	/** VAN's door count when claimed. Null on claims older than the column. */
	claimDoorCount: number | null;
	turfName: string;
	regionName: string;
	/** People on the list (VAN's routeSize). */
	routeSize: number;
	/** VAN's door count now — the fallback for `claimDoorCount`. */
	doorCount: number;
}

const DATE_SENT = new Intl.DateTimeFormat('en-US', {
	timeZone: CAMPAIGN_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** MM/DD/YYYY in the campaign's clock, as the campaign asked. '' for an
 *  unparseable timestamp. */
export function sheetDate(iso: string): string {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? '' : DATE_SENT.format(new Date(ms));
}

function statusFor(checkout: PacketCheckout): PacketStatus | null {
	if (checkout.completedAt) {
		return (checkout.reportedPercent ?? 0) >= 100 ? 'Complete' : 'Incomplete';
	}
	if (checkout.releasedAt) {
		// Handed back without the list ever opening: the turf was never taken
		// in any sense the campaign counts, so it has no row.
		return checkout.loadedInMinivanAt ? 'Incomplete' : null;
	}
	return checkout.loadedInMinivanAt ? 'Out' : 'Unwalked';
}

/**
 * The row this checkout should have, or null when it should have none.
 *
 * Every column is present in the result, blanks included, so that "this cell
 * should now be empty" is a change the diff can see.
 */
export function desiredRow(checkout: PacketCheckout): PacketCells | null {
	const status = statusFor(checkout);
	if (status === null) return null;

	const doors = checkout.claimDoorCount ?? checkout.doorCount;
	const walked = checkout.completedAt !== null && checkout.reportedPercent !== null;
	const percent = walked ? checkout.reportedPercent! : null;

	return {
		'Packet Name': checkout.turfName,
		Voters: String(checkout.routeSize),
		Doors: String(doors),
		// The number the volunteer was issued, not whatever VAN says today — a
		// re-cut regenerates printed lists under live claims.
		'List Number': checkout.issuedListNumber ?? '',
		Canvasser: checkout.slackUserName,
		// When they claimed it, in Slack or on the site: the moment they were
		// at the canvass and taking turf.
		'Shift Time': campaignTimeLabel(checkout.claimedAt),
		'Date Sent Out': sheetDate(checkout.claimedAt),
		'Time Departed': checkout.loadedInMinivanAt
			? campaignTimeLabel(checkout.loadedInMinivanAt)
			: '',
		// This app only ever issues MiniVAN list numbers.
		'Walk Mode': 'MiniVAN',
		// Deliberately never sent. See PRIVACY.md.
		'Phone Number': '',
		// From the volunteer's reported percentage: VAN's API gives us no
		// contact counts at the access level the campaign has.
		'Doors Knocked': percent === null ? '' : String(Math.round((percent / 100) * doors)),
		Status: status,
		'Knocked %': percent === null ? '' : `${percent}%`,
	};
}

/** Where each of our columns sits in the tab, and which row is the header. */
export interface ColumnLayout {
	headerRowIndex: number;
	/** 0-based column index per column. */
	columns: Record<PacketColumn, number>;
	/** One past the rightmost column we write. */
	width: number;
}

function normaliseHeader(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9%]/g, '');
}

/** How far down the header is looked for — room for a title row or two. */
const HEADER_SEARCH_ROWS = 10;

/**
 * Find the header row and every column in it.
 *
 * Returns the columns it could not find instead of a layout when any are
 * missing: writing a partial row into a tab whose shape we do not understand
 * is how cells land in the wrong column.
 */
export function findLayout(
	values: readonly (readonly string[])[],
): { ok: true; layout: ColumnLayout } | { ok: false; missing: PacketColumn[] } {
	let best: { row: number; found: Map<PacketColumn, number> } | null = null;
	for (let row = 0; row < Math.min(values.length, HEADER_SEARCH_ROWS); row++) {
		const byName = new Map<string, number>();
		(values[row] ?? []).forEach((cell, i) => {
			const key = normaliseHeader(cell ?? '');
			if (key && !byName.has(key)) byName.set(key, i);
		});
		const found = new Map<PacketColumn, number>();
		for (const column of PACKET_COLUMNS) {
			const index = byName.get(normaliseHeader(column));
			if (index !== undefined) found.set(column, index);
		}
		if (!best || found.size > best.found.size) best = { row, found };
	}

	const missing = PACKET_COLUMNS.filter((c) => !best?.found.has(c));
	if (!best || missing.length > 0) return { ok: false, missing };

	const columns = Object.fromEntries(best.found) as Record<PacketColumn, number>;
	return {
		ok: true,
		layout: {
			headerRowIndex: best.row,
			columns,
			width: Math.max(...Object.values(columns)) + 1,
		},
	};
}

/** Columns holding free text. Everything else is a number, date, time or
 *  percentage we formatted ourselves. */
const TEXT_COLUMNS: ReadonlySet<PacketColumn> = new Set([
	'Packet Name',
	'List Number',
	'Canvasser',
	'Walk Mode',
	'Phone Number',
	'Status',
]);

/**
 * A row as the values API wants it, with `null` for every cell to leave alone.
 *
 * Null is what the Sheets values API treats as "skip", which is what lets an
 * update touch only the cells that changed and leave the campaign's own notes
 * in the rest of our row where they are.
 *
 * Written USER_ENTERED so the campaign's date, time and percent columns get
 * real values rather than strings. That would also parse a canvasser named
 * `=IMPORTXML(...)` as a formula, or a list number as a date, so every text
 * cell carries Sheets' leading apostrophe — which forces text and is not
 * displayed.
 */
export function rowValues(cells: PacketCells, layout: ColumnLayout): (string | null)[] {
	const row: (string | null)[] = Array.from({ length: layout.width }, () => null);
	for (const column of PACKET_COLUMNS) {
		const value = cells[column];
		if (value === undefined) continue;
		row[layout.columns[column]] = TEXT_COLUMNS.has(column) && value !== '' ? `'${value}` : value;
	}
	return row;
}

/** The cells to write to bring `last` (what we last wrote) up to `desired`.
 *  Write-once columns are never rewritten. Empty when nothing changed. */
export function changedCells(last: PacketCells, desired: PacketCells): PacketCells {
	const changes: PacketCells = {};
	for (const column of PACKET_COLUMNS) {
		if (WRITE_ONCE.has(column)) continue;
		const value = desired[column] ?? '';
		if ((last[column] ?? '') !== value) changes[column] = value;
	}
	return changes;
}

/** Every column blank — how a row is "removed". */
export function blankCells(): PacketCells {
	return Object.fromEntries(PACKET_COLUMNS.map((c) => [c, ''])) as PacketCells;
}

/**
 * Whether a tagged row still holds what we wrote to it.
 *
 * The check before clearing. The tag says we created the row; this says nobody
 * has since typed a different turf or canvasser over it. Blank cells pass — a
 * row we already cleared still counts as ours.
 */
export function stillOurs(
	row: readonly string[] | undefined,
	layout: ColumnLayout,
	written: PacketCells,
): boolean {
	return OWNERSHIP_COLUMNS.every((column) => {
		const actual = (row?.[layout.columns[column]] ?? '').trim();
		return actual === '' || actual === (written[column] ?? '').trim();
	});
}

/**
 * Turf the campaign has handed out itself, by list number → canvasser.
 *
 * Only rows WITHOUT our tag count: our own rows describe claims the ledger
 * already knows about. A row with no canvasser still blocks, labelled as the
 * tracker, because an unnamed assignment is still an assignment.
 */
export function campaignAssignments(
	values: readonly (readonly string[])[],
	layout: ColumnLayout,
	taggedRowIndexes: ReadonlySet<number>,
): Map<string, string> {
	const assigned = new Map<string, string>();
	for (let i = layout.headerRowIndex + 1; i < values.length; i++) {
		if (taggedRowIndexes.has(i)) continue;
		const row = values[i] ?? [];
		const listNumber = normaliseListNumber(row[layout.columns['List Number']] ?? '');
		if (!listNumber) continue;
		const status = (row[layout.columns.Status] ?? '').trim().toLowerCase();
		if (!BLOCKING_STATUSES.has(status)) continue;
		const canvasser = (row[layout.columns.Canvasser] ?? '').trim();
		assigned.set(listNumber, canvasser || 'Packet Tracker');
	}
	return assigned;
}

/** Hand-typed list numbers pick up stray spaces; nothing else is forgiven. */
export function normaliseListNumber(value: string): string {
	return value.replace(/\s+/g, '');
}
