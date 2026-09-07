// Seat accounting between the two systems.
//
// A Solidarity session's `max_capacity` is the real cap, but signups arrive from
// both sides: directly in Solidarity, and through Mobilize. Mobilize enforces
// its own `max_attendees` per timeslot server-side (it flips `is_full` and stops
// taking signups), so the way to keep the total honest is to hand Mobilize only
// the seats Solidarity has NOT already spent.
//
// THE TRAP THIS MODULE EXISTS FOR: the attendee sync mirrors every Mobilize
// signup back into Solidarity as an RSVP. Subtracting *all* Solidarity RSVPs
// would therefore charge each Mobilize signup twice — once against Mobilize's
// own count, once by shrinking the cap we push it — and the shift would close at
// half its capacity. Only RSVPs that did not originate in Mobilize may be
// subtracted, which is what `countSolidaritySeats` is careful about.
//
// Pure: no I/O, so the arithmetic is testable without either API.

import type { PlannedEvent } from './transform.js';
import type { ExistingRsvp } from './rsvp.js';

/** `source_system` on the RSVPs this sync writes. See createRsvp. */
export const MOBILIZE_SOURCE_SYSTEM = 'mobilize';

/**
 * Seats a session has spent on signups that did NOT come from Mobilize.
 *
 * Only `yes` occupies a seat: `no` is a cancellation, `maybe` was never a
 * commitment, and `waitlisted` is by definition someone who did not get one.
 */
export function countSolidaritySeats(rows: ExistingRsvp[]): number {
	return rows.filter(
		(row) => row.is_attending === 'yes' && row.source_system !== MOBILIZE_SOURCE_SYSTEM,
	).length;
}

/**
 * What to send as a Mobilize timeslot's `max_attendees`.
 *
 * `null` in means uncapped in Solidarity, and stays uncapped — never turn "no
 * limit" into a limit. Otherwise it is the seats left, floored at zero: a full
 * shift is pushed as `0`, which Mobilize reads as "nobody may sign up" and which
 * is why transform.ts is careful never to let a genuine 0 mean "unlimited".
 */
export function remainingSeats(capacity: number | null, taken: number): number | null {
	if (capacity === null) return null;
	return Math.max(0, capacity - taken);
}

/**
 * Rewrite a plan's timeslot caps to the seats Mobilize may still fill.
 *
 * Index-aligned with `solidaritySessionIds` — transform.ts builds both from the
 * same ordered session list, and this is the only thing that relates the two, so
 * they must stay in step.
 *
 * Sessions missing from `seatsTaken` are left at their full cap rather than
 * assumed empty-or-full: a failed count must not silently close a shift.
 */
export function applySeatsTaken(plan: PlannedEvent, seatsTaken: Map<number, number>): PlannedEvent {
	if (!plan.timeslots.some((slot) => slot.maxAttendees !== null)) return plan;
	return {
		...plan,
		timeslots: plan.timeslots.map((slot, index) => {
			const sessionId = plan.solidaritySessionIds[index];
			const taken = sessionId === undefined ? undefined : seatsTaken.get(sessionId);
			if (taken === undefined) return slot;
			return { ...slot, maxAttendees: remainingSeats(slot.maxAttendees, taken) };
		}),
	};
}

/** Session ids in a plan whose shift carries a real cap — the only ones worth
 *  spending a Solidarity read on. */
export function cappedSessionIds(plan: PlannedEvent): number[] {
	const ids: number[] = [];
	plan.timeslots.forEach((slot, index) => {
		const sessionId = plan.solidaritySessionIds[index];
		if (slot.maxAttendees !== null && sessionId !== undefined) ids.push(sessionId);
	});
	return ids;
}
