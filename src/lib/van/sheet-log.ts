// Turning checkout rows into spreadsheet rows.
//
// The campaign reads its canvassing out of Google Sheets it owns, and this is
// what decides what lands in them: one row per event, appended, never updated.
// Append-only is not laziness — updating "the row for this turf" would mean
// finding it again, and a turf's mapRouteId changes every time VAN re-cuts the
// region (see the note on van_turfs in schema.ts). A log with a Checkout ID
// column cannot point at the wrong row, because it never points at a row twice.
//
// Events are DERIVED from van_turf_checkouts rather than enqueued by the code
// paths that end a claim. Six paths end one today and a seventh is a matter of
// time; deriving means the seventh is logged without being told this feature
// exists. The two send-stamp columns on the checkout row are the whole of the
// bookkeeping.
//
// Pure — no DB, no network. sheet-store.ts does the rows and the sending.

import { campaignSheetStamp } from '../campaign-time.js';

/** The tab this is written to, when an admin has not named one. */
export const DEFAULT_SHEET_TAB_NAME = 'Turf Checkouts';

/**
 * The header row, and the column order every event row follows.
 *
 * Exported so the header the app writes, the cells it builds and the tests all
 * come from one list. A column added here without a matching cell in
 * `rowFor` is a compile error, which is the point.
 */
export const SHEET_COLUMNS = [
	'When',
	'Event',
	'Turf',
	'Region',
	'List #',
	'Volunteer',
	'Checkout ID',
] as const;

/** What a checkout row has to offer for its events to be built. Structurally
 *  satisfied by the store's candidate query. */
export interface SheetCheckout {
	checkoutId: number;
	claimedAt: string;
	releasedAt: string | null;
	completedAt: string | null;
	releaseReason: string | null;
	slackUserName: string;
	issuedListNumber: string | null;
	turfName: string;
	regionName: string;
	/** Whether each half has already reached the sheet. */
	sheetClaimSentAt: string | null;
	sheetEndSentAt: string | null;
}

export type SheetEventKind = 'claim' | 'end';

export interface SheetEvent {
	checkoutId: number;
	kind: SheetEventKind;
	/** The region name this routes on — carried so the store does not re-read
	 *  the checkout to route it. */
	regionName: string;
	/** Already in column order, ready to append. */
	cells: string[];
}

/**
 * How a checkout that ended in `releaseReason` is labelled.
 *
 * Mirrors `endKind` in turf-activity.ts, including its default: an unrecognised
 * reason still produces a row. A missing row is the one outcome an audit log
 * cannot afford, and a reason added by a later migration is exactly the case
 * that would otherwise vanish silently.
 */
export function endEventLabel(releaseReason: string | null): string {
	switch (releaseReason) {
		case 'expired':
			return 'Expired';
		case 'blocked':
			return 'Released (blocked)';
		case 'retired':
			return 'Released (turf re-cut)';
		// The reconciliation's: VAN refreshed the region and the turf came back
		// with no doors left in it, so the app handed it back. Kept apart from a
		// plain release for the same reason turf-activity.ts keeps them apart —
		// the volunteer did not drop this turf, and the campaign reading the
		// sheet should not see them as having done so.
		case 'walked-out':
			return 'Released (no doors left)';
		case 'admin':
			return 'Released (admin)';
		// 'volunteer', and anything a later migration adds, reads as a deliberate
		// hand-back.
		default:
			return 'Released';
	}
}

/** Whether a checkout has ended, and when. Completion and release are separate
 *  columns; a row can only have one of them. */
function endedAt(checkout: SheetCheckout): { at: string; event: string } | null {
	if (checkout.completedAt) return { at: checkout.completedAt, event: 'Completed' };
	if (checkout.releasedAt) {
		return { at: checkout.releasedAt, event: endEventLabel(checkout.releaseReason) };
	}
	return null;
}

function rowFor(checkout: SheetCheckout, at: string, event: string): string[] {
	return [
		campaignSheetStamp(at),
		event,
		checkout.turfName,
		checkout.regionName,
		// The number the volunteer was actually issued, not what VAN says today.
		// A re-cut regenerates printed lists under claims that are hours old, and
		// the sheet has to show what the person was told to type into MiniVAN.
		checkout.issuedListNumber ?? '',
		checkout.slackUserName,
		String(checkout.checkoutId),
	];
}

/**
 * The events this checkout still owes the sheet, in the order they must be
 * written.
 *
 * The claim event always precedes the ending event. A checkout that starts and
 * ends between two syncs owes both at once, and a "Released" row above its own
 * "Checked out" row is the kind of thing that makes a reader distrust the whole
 * log — so the order is a property of this function rather than of whatever
 * order the rows came back in.
 */
export function pendingEvents(checkout: SheetCheckout): SheetEvent[] {
	const events: SheetEvent[] = [];
	if (!checkout.sheetClaimSentAt) {
		events.push({
			checkoutId: checkout.checkoutId,
			kind: 'claim',
			regionName: checkout.regionName,
			cells: rowFor(checkout, checkout.claimedAt, 'Checked out'),
		});
	}
	const ending = endedAt(checkout);
	if (ending && !checkout.sheetEndSentAt) {
		events.push({
			checkoutId: checkout.checkoutId,
			kind: 'end',
			regionName: checkout.regionName,
			cells: rowFor(checkout, ending.at, ending.event),
		});
	}
	return events;
}

/** Every pending event across a batch of checkouts, oldest claim first. The
 *  store hands these to the routing layer, which groups them by spreadsheet. */
export function pendingEventsFor(checkouts: readonly SheetCheckout[]): SheetEvent[] {
	return checkouts.flatMap(pendingEvents);
}
