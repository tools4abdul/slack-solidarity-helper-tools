// The campaign's Packet Tracker tab: what a checkout should fill in on its
// packet's row, and what the campaign's own entries say about who already has
// which turf.
//
// The campaign lists every packet in advance — Packet Name, Voters, Doors and
// List Number, in protected columns — alongside formula columns of its own
// (`shift_key`, `Today?`, `Knocked %`). Handing a packet out means filling in
// the canvasser columns on that packet's EXISTING row. So the app never adds,
// deletes or moves a row; it finds the packet by List Number and fills in, or
// clears, the columns a canvasser would:
//
//   claimed                  → Canvasser, Shift Time, Date Sent Out,
//                              Walk Mode filled, Status Unwalked
//   list loaded in MiniVAN   → Time Departed filled, Status Out
//   marked walked            → Doors Knocked filled, Status Complete (100%)
//                              or Incomplete; the sheet computes Knocked %
//   released, never loaded   → everything we filled in is cleared
//   released after loading   → Status Incomplete
//
// Whatever the campaign typed is never overwritten or cleared: a packet is
// only filled in when its canvasser columns are empty, and only cleared while
// they still hold what we wrote. Verified against a live tracker 2026-09-24.
//
// Columns are found by header name, not position — the header is on row 2 of
// the campaign's tab, not row 1, and they rearrange it. Pure — no DB, no
// network. The store is packet-tracker-store.ts.

import { campaignTimeLabel, CAMPAIGN_TIME_ZONE } from '../campaign-time.js';

/** The tab, when an admin has not named another. */
export const DEFAULT_SHEET_TAB_NAME = 'Packet Tracker';

/** Every column the app needs to find. */
export const PACKET_COLUMNS = [
	'Doors',
	'List Number',
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Time Departed',
	'Walk Mode',
	'Doors Knocked',
	'Status',
] as const;

export type PacketColumn = (typeof PACKET_COLUMNS)[number];

/** The columns the app writes: a canvasser's half of the row. Not Packet
 *  Name, Voters, Doors or List Number, which the campaign fills in and
 *  protects; not Knocked %, which is the campaign's formula; not Phone Number,
 *  which the app never sends. */
export const FILL_COLUMNS = [
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Time Departed',
	'Walk Mode',
	'Doors Knocked',
	'Status',
] as const satisfies readonly PacketColumn[];

export type FillColumn = (typeof FILL_COLUMNS)[number];

export type PacketCells = Partial<Record<FillColumn, string>>;

/** Written when the packet is first filled in, and never again — so a campaign
 *  correction to one of them sticks. */
const WRITE_ONCE: ReadonlySet<FillColumn> = new Set([
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Walk Mode',
]);

/** A Status on a campaign entry that means the packet is out. Incomplete is
 *  not: that turf is back in play. Unwalked only with a canvasser named — see
 *  isUnfilled. */
const BLOCKING_STATUSES: ReadonlySet<string> = new Set(['unwalked', 'out', 'complete']);

/** What the campaign's Status says about a packet nobody has taken. */
const UNTAKEN_STATUS = 'unwalked';

export type PacketStatus = 'Unwalked' | 'Out' | 'Complete' | 'Incomplete';

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
	/** VAN's door count now — the last fallback for the door total. */
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
		// Handed back without the list ever opening: the packet never really
		// went out, so it is left as though it had not been handed out.
		return checkout.loadedInMinivanAt ? 'Incomplete' : null;
	}
	return checkout.loadedInMinivanAt ? 'Out' : 'Unwalked';
}

/**
 * What this checkout should have filled in on its packet's row, or null when
 * it should have nothing there.
 *
 * `sheetDoors` is the packet's Doors as the campaign listed it. Doors Knocked
 * is computed from that when it is readable, because the sheet's Knocked %
 * formula divides by that cell — so the percentage it shows comes out as the
 * one the volunteer reported.
 *
 * Every fill column is present in the result, blanks included, so that "this
 * cell should now be empty" is a change the diff can see.
 */
export function desiredCells(
	checkout: PacketCheckout,
	sheetDoors?: number | null,
): PacketCells | null {
	const status = statusFor(checkout);
	if (status === null) return null;

	const doors = sheetDoors ?? checkout.claimDoorCount ?? checkout.doorCount;
	const walked = checkout.completedAt !== null && checkout.reportedPercent !== null;
	const percent = walked ? checkout.reportedPercent! : null;

	return {
		Canvasser: checkout.slackUserName,
		// When they claimed it, in Slack or on the site.
		'Shift Time': campaignTimeLabel(checkout.claimedAt),
		'Date Sent Out': sheetDate(checkout.claimedAt),
		'Time Departed': checkout.loadedInMinivanAt
			? campaignTimeLabel(checkout.loadedInMinivanAt)
			: '',
		// This app only ever issues MiniVAN list numbers.
		'Walk Mode': 'MiniVAN',
		// From the volunteer's reported percentage: VAN's API gives us no
		// contact counts at the access level the campaign has.
		'Doors Knocked': percent === null ? '' : String(Math.round((percent / 100) * doors)),
		Status: status,
	};
}

/** Where each column sits in the tab, and which row is the header. */
export interface ColumnLayout {
	headerRowIndex: number;
	/** 0-based column index per column. */
	columns: Record<PacketColumn, number>;
}

function normaliseHeader(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9%]/g, '');
}

/** How far down the header is looked for. The campaign's is on row 2. */
const HEADER_SEARCH_ROWS = 10;

/**
 * Find the header row and every column in it.
 *
 * Returns the columns it could not find instead of a layout when any are
 * missing: writing into a tab whose shape we do not understand is how cells
 * land in the wrong column.
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
	return {
		ok: true,
		layout: {
			headerRowIndex: best.row,
			columns: Object.fromEntries(best.found) as Record<PacketColumn, number>,
		},
	};
}

/** Hand-typed list numbers pick up stray spaces; nothing else is forgiven. */
export function normaliseListNumber(value: string): string {
	return value.replace(/\s+/g, '');
}

/** The rows listing this packet, by List Number. More than one is the
 *  campaign's duplicate, and the caller writes to neither. */
export function packetRows(
	values: readonly (readonly string[])[],
	layout: ColumnLayout,
	listNumber: string,
): number[] {
	const wanted = normaliseListNumber(listNumber);
	if (!wanted) return [];
	const rows: number[] = [];
	for (let i = layout.headerRowIndex + 1; i < values.length; i++) {
		const cell = values[i]?.[layout.columns['List Number']] ?? '';
		if (normaliseListNumber(cell) === wanted) rows.push(i);
	}
	return rows;
}

/** The packet's Doors, when the cell holds a number. */
export function sheetDoors(
	row: readonly string[] | undefined,
	layout: ColumnLayout,
): number | null {
	const raw = (row?.[layout.columns.Doors] ?? '').replace(/,/g, '').trim();
	if (!/^\d+$/.test(raw)) return null;
	return Number(raw);
}

function cell(row: readonly string[] | undefined, layout: ColumnLayout, column: PacketColumn) {
	return (row?.[layout.columns[column]] ?? '').trim();
}

/**
 * Whether nobody has this packet: every canvasser column empty, except a
 * Status of `Unwalked`.
 *
 * The campaign marks packets nobody has taken yet as Unwalked, with no
 * canvasser — verified 2026-09-25, when that default made the app treat a
 * free packet as someone else's. A named Unwalked packet is taken.
 */
export function isUnfilled(row: readonly string[] | undefined, layout: ColumnLayout): boolean {
	return FILL_COLUMNS.every((column) => {
		const value = cell(row, layout, column);
		return value === '' || (column === 'Status' && value.toLowerCase() === UNTAKEN_STATUS);
	});
}

/** The row's own values in our columns before we fill it in — the campaign's
 *  Unwalked default, typically — so that taking an entry back puts the packet
 *  back exactly as it was. */
export function priorCells(row: readonly string[] | undefined, layout: ColumnLayout): PacketCells {
	const prior: PacketCells = {};
	for (const column of FILL_COLUMNS) {
		const value = cell(row, layout, column);
		if (value) prior[column] = value;
	}
	return prior;
}

/**
 * Whether the packet's row still holds our entry.
 *
 * The canvasser name is the mark: if someone has typed a different name there,
 * the packet has been handed to them and the entry is theirs now.
 */
export function stillOurs(
	row: readonly string[] | undefined,
	layout: ColumnLayout,
	written: PacketCells,
): boolean {
	return cell(row, layout, 'Canvasser') === (written.Canvasser ?? '').trim();
}

/** The cells to write to bring `last` (what we last wrote) up to `desired`.
 *  Write-once columns are never rewritten. Empty when nothing changed. */
export function changedCells(last: PacketCells, desired: PacketCells): PacketCells {
	const changes: PacketCells = {};
	for (const column of FILL_COLUMNS) {
		if (WRITE_ONCE.has(column)) continue;
		const value = desired[column] ?? '';
		if ((last[column] ?? '') !== value) changes[column] = value;
	}
	return changes;
}

/** How an entry is taken back: every cell we filled in returns to what the
 *  packet had before (`prior`), or to blank. */
export function clearedCells(last: PacketCells, prior: PacketCells = {}): PacketCells {
	const cleared: PacketCells = {};
	for (const column of FILL_COLUMNS) {
		if (last[column] !== undefined && last[column] !== (prior[column] ?? '')) {
			cleared[column] = prior[column] ?? '';
		}
	}
	return cleared;
}

/**
 * Cells as the values API wants them: one `[column index, value]` per cell.
 *
 * Written USER_ENTERED so the campaign's date, time and number columns get
 * real values rather than strings. That would also parse a canvasser named
 * `=IMPORTXML(...)` as a formula, so the name carries Sheets' leading
 * apostrophe, which forces text and is not displayed. The other columns hold
 * values this app formats itself.
 */
export function cellWrites(cells: PacketCells, layout: ColumnLayout): Array<[number, string]> {
	const writes: Array<[number, string]> = [];
	for (const column of FILL_COLUMNS) {
		const value = cells[column];
		if (value === undefined) continue;
		writes.push([
			layout.columns[column],
			column === 'Canvasser' && value !== '' ? `'${value}` : value,
		]);
	}
	return writes;
}

/**
 * Packets the campaign has handed out itself, by list number → canvasser.
 *
 * `ours` maps a list number to the canvasser name we filled in; a row whose
 * Canvasser matches is our own entry, which the ledger already knows about.
 * An unnamed Out or Complete still blocks, labelled as the tracker, because an
 * unnamed assignment is still an assignment; an unnamed Unwalked is the
 * campaign's default for a free packet and does not.
 */
export function campaignAssignments(
	values: readonly (readonly string[])[],
	layout: ColumnLayout,
	ours: ReadonlyMap<string, string>,
): Map<string, string> {
	const assigned = new Map<string, string>();
	for (let i = layout.headerRowIndex + 1; i < values.length; i++) {
		const row = values[i];
		const listNumber = normaliseListNumber(cell(row, layout, 'List Number'));
		if (!listNumber) continue;
		const status = cell(row, layout, 'Status').toLowerCase();
		if (!BLOCKING_STATUSES.has(status)) continue;
		const canvasser = cell(row, layout, 'Canvasser');
		// The campaign's default for a packet nobody has taken. See isUnfilled.
		if (!canvasser && status === UNTAKEN_STATUS) continue;
		const mine = ours.get(listNumber);
		if (mine !== undefined && mine.trim() === canvasser) continue;
		assigned.set(listNumber, canvasser || 'Packet Tracker');
	}
	return assigned;
}
