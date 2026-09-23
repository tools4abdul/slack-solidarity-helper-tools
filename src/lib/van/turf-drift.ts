// Where our checkout ledger and VAN disagree about who is walking what.
//
// Two systems both believe they know where turf is. Ours knows who clicked
// Claim; VAN knows which lists an organizer bulk-exported to somebody's MiniVAN
// (plan.md Constraint B — the app cannot create those exports, so that step
// stays a human one). When the two disagree, somebody is about to knock a door
// twice or not at all.
//
// The disagreement runs in both directions and they are NOT mirror images:
//
//   claimed here, not in MiniVAN → the volunteer holds a list number that
//       loads nothing. They walk out, type it in, and get an empty list. The
//       organizer forgot the bulk export, or did it for a different cut.
//
//   in MiniVAN, not claimed here → the turf is out with a named canvasser, but
//       our board shows it free. The next volunteer to open the map claims turf
//       somebody is already standing on.
//
// The first wastes one person's morning; the second puts two people on the same
// doorstep, which is the failure the whole feature exists to prevent. They are
// ranked accordingly.
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

export type DriftKind = 'claimed-not-in-minivan' | 'in-minivan-not-claimed';

export interface DriftItem {
	kind: DriftKind;
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	/** Who holds it in our ledger, for `claimed-not-in-minivan`. */
	heldBy: string | null;
	/** Who VAN says has it, for `in-minivan-not-claimed`. */
	distributedTo: string | null;
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
 * Verified against the live committee on 2026-09-22: every one of its 2,201
 * printed lists was generated AFTER the most recent MiniVAN export, so nothing
 * could match by construction. Organizers there cut lists and hand out the
 * printed list NUMBER, which loads in MiniVAN without an export record ever
 * existing — `/minivanExports` records a different act, an organizer assigning
 * a list to named canvassers in VAN's UI.
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
	inMinivanNotClaimed: number;
}

const RANK: Record<DriftKind, number> = {
	// Two people on one doorstep outranks one wasted morning.
	'in-minivan-not-claimed': 0,
	'claimed-not-in-minivan': 1,
};

/**
 * Compare the ledger against what VAN reports, one turf at a time.
 *
 * Retired turf is skipped in both directions. VAN no longer has the route, so
 * "not in MiniVAN" is true and meaningless — the catalog sync already releases
 * claims on it with `releaseReason = 'retired'`, and reporting it as drift
 * would bury the real rows under the consequences of a re-cut.
 */
export function driftReport(
	turfs: readonly DriftTurfRow[],
	claims: readonly ClaimSnapshot[],
	now: Date,
	visibility: DriftVisibility = 'visible',
): DriftReport {
	if (visibility === 'van-side-unavailable') {
		return { visibility, items: [], claimedNotInMinivan: 0, inMinivanNotClaimed: 0 };
	}

	// Live turf only: a retired row keeps whatever it was last distributed to,
	// and letting that count as evidence would leave the check switched on by
	// the ghost of a workflow the campaign has since stopped using.
	const usesExports = turfs.some((t) => t.retiredAt === null && t.vanDistributedTo);
	if (!usesExports) {
		return {
			visibility: 'exports-unused',
			items: [],
			claimedNotInMinivan: 0,
			inMinivanNotClaimed: 0,
		};
	}

	const heldBy = new Map<number, ClaimSnapshot>();
	for (const claim of claims) {
		if (isActive(claim, now)) heldBy.set(claim.mapRouteId, claim);
	}

	const items: DriftItem[] = [];
	for (const turf of turfs) {
		if (turf.retiredAt !== null) continue;

		const claim = heldBy.get(turf.mapRouteId) ?? null;
		const distributed = turf.vanDistributedTo;
		const base = {
			mapRouteId: turf.mapRouteId,
			turfName: turf.name,
			regionName: turf.regionName,
			chapterId: turf.chapterId,
			chapterName: turf.chapterName,
			doorCount: turf.doorCount,
			hasListNumber: turf.printedListNumber !== null,
		};

		if (claim && !distributed) {
			items.push({
				...base,
				kind: 'claimed-not-in-minivan',
				heldBy: claim.slackUserName,
				distributedTo: null,
			});
		} else if (!claim && distributed) {
			items.push({
				...base,
				kind: 'in-minivan-not-claimed',
				heldBy: null,
				distributedTo: distributed,
			});
		}
		// Both, or neither, is agreement — not drift. Note that "both" means our
		// holder and VAN's canvasser might still be different people, but the app
		// has no way to match a Slack display name to a VAN canvasser name, and
		// guessing at that would generate false accusations. Left alone
		// deliberately.
	}

	items.sort(
		(a, b) =>
			RANK[a.kind] - RANK[b.kind] || b.doorCount - a.doorCount || a.mapRouteId - b.mapRouteId,
	);

	return {
		visibility,
		items,
		claimedNotInMinivan: items.filter((i) => i.kind === 'claimed-not-in-minivan').length,
		inMinivanNotClaimed: items.filter((i) => i.kind === 'in-minivan-not-claimed').length,
	};
}

/** What to call each kind on screen. One place decides, so the count and the
 *  row beneath it cannot disagree. */
export function driftLabel(kind: DriftKind): string {
	switch (kind) {
		case 'claimed-not-in-minivan':
			return 'Claimed here, not in MiniVAN';
		case 'in-minivan-not-claimed':
			return 'In MiniVAN, not claimed here';
	}
}

/** What an organizer should actually do about it. The report is only useful if
 *  the next action is obvious from the row. */
export function driftAdvice(kind: DriftKind): string {
	switch (kind) {
		case 'claimed-not-in-minivan':
			return 'Their list number will load nothing until this turf is bulk-exported to MiniVAN in VAN.';
		case 'in-minivan-not-claimed':
			return 'Someone already has this in MiniVAN, but the app shows it free — it can be claimed twice.';
	}
}
