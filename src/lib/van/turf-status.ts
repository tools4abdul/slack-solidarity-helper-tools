// What a given viewer is allowed to know about a turf's state.
//
// Two rules live here, and they live in ONE place on purpose: this is the
// function the load function calls before serialising, so the payload itself
// is the boundary. Hiding a name in a template is not hiding it — it ships in
// the SSR payload and anyone can read it in devtools.
//
// Rule 1 — collapse. VAN and our ledger distinguish "a volunteer checked this
// out through the app" from "an organizer sent it straight to someone's
// MiniVAN". Organizers need that difference (it's the drift report in Story
// 8.2). A volunteer cannot act on it: either way the turf is taken. So they
// see one state, "checked out".
//
// Rule 2 — redact. Who holds a turf is organizer information. A volunteer
// browsing the map has no reason to learn that a particular named person is
// out knocking a particular block this afternoon, and in a workspace that may
// include people outside the campaign that is a needless disclosure.

/** How VAN and our ledger actually see a turf. Organizer-facing. */
export type TurfStatus = 'available' | 'held-by-you' | 'held-by-other' | 'assigned-in-van';

/** What a volunteer sees. Note the two "taken" states have collapsed. */
export type VolunteerStatus = 'available' | 'held-by-you' | 'checked-out';

export interface TurfStateSource {
	status: TurfStatus;
	/** Display name of whoever holds it, from the checkout ledger or from
	 *  `/minivanExports?$expand=canvassers`. */
	heldBy: string | null;
	/** Hours until an app claim lapses. Null for VAN-side assignments, which
	 *  have no TTL of ours. */
	expiresInHours: number | null;
}

export interface VisibleTurfState {
	status: VolunteerStatus;
	heldBy: string | null;
	expiresInHours: number | null;
}

export interface Viewer {
	isAdmin: boolean;
}

/** The volunteer-facing status for a raw one. */
export function volunteerStatus(status: TurfStatus): VolunteerStatus {
	switch (status) {
		case 'available':
			return 'available';
		case 'held-by-you':
			return 'held-by-you';
		default:
			return 'checked-out';
	}
}

/**
 * Reduce a turf's real state to what `viewer` may see.
 *
 * Everyone gets the collapsed status — `VolunteerStatus` is the only status
 * that reaches a browser. Admins additionally get the holder's name and the
 * claim's expiry, and the two together still tell them what was collapsed: a
 * holder with no expiry is an assignment made in VAN. Everyone else gets no
 * holder identity.
 *
 * `expiresInHours` is suppressed for non-admins too, which is worth spelling
 * out because it costs a genuinely useful "frees up in 11 hours" hint. The
 * reason: only app claims carry a TTL, so a countdown on some checked-out
 * turfs and not others tells a volunteer exactly which ones an organizer
 * assigned by hand — reconstructing the distinction Rule 1 just collapsed. If
 * the campaign decides the hint is worth that, this is the one line to change.
 */
export function visibleTurfState(source: TurfStateSource, viewer: Viewer): VisibleTurfState {
	if (viewer.isAdmin) {
		return {
			status: volunteerStatus(source.status),
			heldBy: source.heldBy,
			expiresInHours: source.expiresInHours,
		};
	}

	const status = volunteerStatus(source.status);
	return {
		status,
		heldBy: null,
		// Your own claim's expiry is yours to know — that one is not a leak,
		// it's the countdown on your own turf.
		expiresInHours: status === 'held-by-you' ? source.expiresInHours : null,
	};
}

/** Label shown on a turf card or badge. */
export function statusLabel(status: VolunteerStatus): string {
	switch (status) {
		case 'available':
			return 'Available';
		case 'held-by-you':
			// "Yours", not "Checked out by you": it renders as a badge beside the
			// turf name, where the short form reads at a glance and the long one
			// wrapped onto two lines. The distinction from "Checked out" is
			// carried by the badge's colour as well as its text.
			return 'Yours';
		case 'checked-out':
			return 'Checked out';
	}
}
