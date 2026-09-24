// Where our checkout ledger and VAN disagree about who is walking what.
//
// Two systems both believe they know where turf is. Ours knows who clicked
// Claim; VAN knows which lists have been loaded into somebody's MiniVAN, by an
// organizer exporting them or a volunteer typing in the list number (plan.md
// Constraint B — the app cannot create those exports itself). When the two
// disagree, somebody is about to knock a door twice or not at all.
//
// Reported in ONE direction only:
//
//   claimed here, not in MiniVAN → the volunteer claimed the turf but has not
//       loaded its list in MiniVAN. Loading a list number is what creates the
//       export VAN reports (most exports carry the loading volunteer as a
//       nameless canvasser, and one checked 2026-09-24 was created BY its own
//       canvasser), so a claim with no export means the list was never opened.
//       This used to read as "the organizer forgot the bulk export", from
//       before that was understood.
//
// The other direction — in MiniVAN, not claimed here — used to be reported too,
// ranked first, as "the app shows it free, so it can be claimed twice". That
// stopped being true once `vanDistributedTo` was read correctly: `canClaim`
// refuses turf VAN holds, and the board shows it as assigned in VAN. What was
// left was the normal state of every turf handed out outside the app — 1,315
// rows on the first correct sync, 2026-09-24 — so it was dropped rather than
// reworded. Stamps an older version wrote with that kind read as unrecognised
// in drift-alert-store.ts and are cleared by its stale sweep.
//
// Pure — no DB, no VAN, no clock of its own.
//
// **This report needs no VAN call.** Story 8.1's catalog sync already writes
// `vanDistributedTo` onto each turf row, so the comparison is between two
// columns we own. That has one consequence the caller must handle: on a key
// without `/minivanExports` the column is null everywhere, which is
// indistinguishable from "nothing is distributed" unless you ask separately.
// See `driftVisibility`.

import { isActive, type ClaimSnapshot } from './checkout.js';

export interface DriftTurfRow {
	mapRouteId: number;
	name: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	printedListNumber: string | null;
	/** Canvassers VAN reports for this turf via /minivanExports, or null when
	 *  VAN has no export for it — or when the tier that reads them is missing. */
	vanDistributedTo: string | null;
	retiredAt: string | null;
}

/** A claim, plus whether the sync has seen its list loaded in MiniVAN. */
export type DriftClaim = ClaimSnapshot & { loadedInMinivanAt: string | null };

export type DriftKind = 'claimed-not-in-minivan';

/**
 * How long a claim has before "hasn't loaded it yet" is drift.
 *
 * A volunteer claims turf at home and opens MiniVAN when they get there. The
 * sync runs every half hour, and a claim made minutes before one used to go
 * straight to the turf channel as a problem — for someone who had simply not
 * left the house. Two hours covers getting to the turf without letting a
 * claim that is genuinely stuck sit unnoticed for the whole 48-hour hold.
 */
export const DRIFT_LOAD_GRACE_HOURS = 2;

export interface DriftItem {
	kind: DriftKind;
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	/** Who holds it in our ledger. */
	heldBy: string;
	/** Whether the turf has a MiniVAN list number at all. A claim on turf
	 *  without one cannot happen (canClaim refuses it), so this being false on a
	 *  drift row means something is wrong upstream rather than with the export. */
	hasListNumber: boolean;
}

/**
 * Whether VAN's side of the comparison is legible at all.
 *
 * `vanDistributedTo` is null both when VAN has no export for a turf and when
 * the key cannot read `/minivanExports` (Tier 3, and 403 on a demo key). Those
 * mean opposite things — "nothing is double-booked" versus "we have not looked"
 * — and a report that showed an empty list for the second would be reassuring
 * about a check that never ran.
 *
 * The caller passes what the sync recorded, because only the sync knows whether
 * the endpoint answered.
 *
 * `exports-unused` is a third state, decided here rather than passed in: the
 * endpoint answered, and NO turf in the catalog appears in any export. That is
 * not a campaign whose turf is all undistributed — it is a campaign that does
 * not use the export workflow at all.
 *
 * Organizers can cut lists and hand out the printed list NUMBER, which loads in
 * MiniVAN without an export record ever existing — `/minivanExports` records a
 * different act, an organizer assigning a list to named canvassers in VAN's UI.
 *
 * (An earlier note here said the live committee's exports all predated its
 * printed lists. That came from a read of `/minivanExports` that took an
 * effectively random slice of 645,000 records, not the recent ones — see
 * `minivanExportsSince` in client.ts. Read by date, the committee does export:
 * e.g. Royal Oak lists to a named canvasser on 2026-09-13 and 09-22.)
 *
 * Reporting `claimed-not-in-minivan` under that workflow flags every claim the
 * app has ever taken, which is noise that buries the direction that matters.
 * Suppressing it is the same judgement `van-side-unavailable` already makes —
 * say the check did not happen rather than imply it passed — and it reverses
 * itself the moment one export matches.
 */
export type DriftVisibility = 'visible' | 'van-side-unavailable' | 'exports-unused';

export interface DriftReport {
	visibility: DriftVisibility;
	items: DriftItem[];
	claimedNotInMinivan: number;
}

/**
 * Compare the ledger against what VAN reports, one turf at a time.
 *
 * Retired turf is skipped. VAN no longer has the route, so
 * "not in MiniVAN" is true and meaningless — the catalog sync already releases
 * claims on it with `releaseReason = 'retired'`, and reporting it as drift
 * would bury the real rows under the consequences of a re-cut.
 */
export function driftReport(
	turfs: readonly DriftTurfRow[],
	claims: readonly DriftClaim[],
	now: Date,
	visibility: DriftVisibility = 'visible',
): DriftReport {
	if (visibility === 'van-side-unavailable') {
		return { visibility, items: [], claimedNotInMinivan: 0 };
	}

	// Live turf only: a retired row keeps whatever it was last distributed to,
	// and letting that count as evidence would leave the check switched on by
	// the ghost of a workflow the campaign has since stopped using.
	//
	// Our own claims count too: an export inside one of them is recorded on
	// the claim (`loadedInMinivanAt`), not on the turf, and it is the same
	// evidence that lists are being loaded.
	const usesExports =
		turfs.some((t) => t.retiredAt === null && t.vanDistributedTo) ||
		claims.some((c) => c.loadedInMinivanAt !== null);
	if (!usesExports) {
		return {
			visibility: 'exports-unused',
			items: [],
			claimedNotInMinivan: 0,
		};
	}

	const heldBy = new Map<number, DriftClaim>();
	for (const claim of claims) {
		if (isActive(claim, now)) heldBy.set(claim.mapRouteId, claim);
	}

	const items: DriftItem[] = [];
	for (const turf of turfs) {
		if (turf.retiredAt !== null) continue;

		// Loaded means THIS claim's list was seen in MiniVAN. The turf-level
		// `vanDistributedTo` no longer carries our own volunteers' loads — see
		// outsideAssignment in catalog.ts — so it cannot answer this.
		const claim = heldBy.get(turf.mapRouteId) ?? null;
		if (
			claim &&
			!claim.loadedInMinivanAt &&
			now.getTime() - Date.parse(claim.claimedAt) >= DRIFT_LOAD_GRACE_HOURS * 3_600_000
		) {
			items.push({
				kind: 'claimed-not-in-minivan',
				mapRouteId: turf.mapRouteId,
				turfName: turf.name,
				regionName: turf.regionName,
				chapterId: turf.chapterId,
				chapterName: turf.chapterName,
				doorCount: turf.doorCount,
				heldBy: claim.slackUserName,
				hasListNumber: turf.printedListNumber !== null,
			});
		}
		// Claimed here AND loaded is agreement, not drift.
	}

	items.sort((a, b) => b.doorCount - a.doorCount || a.mapRouteId - b.mapRouteId);

	return { visibility, items, claimedNotInMinivan: items.length };
}

/** What to call each kind on screen. One place decides, so the count and the
 *  row beneath it cannot disagree. */
export function driftLabel(kind: DriftKind): string {
	switch (kind) {
		case 'claimed-not-in-minivan':
			return 'Claimed here, not in MiniVAN';
	}
}

/** What an organizer should actually do about it. The report is only useful if
 *  the next action is obvious from the row. */
export function driftAdvice(kind: DriftKind): string {
	switch (kind) {
		case 'claimed-not-in-minivan':
			return "They haven't loaded this list in MiniVAN yet — check they have the list number and have started.";
	}
}
