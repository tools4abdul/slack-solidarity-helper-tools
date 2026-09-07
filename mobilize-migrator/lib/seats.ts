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
// subtracted, which is what `countSeats` is careful about.
//
// Those mirrored rows earn their keep twice over, though: they are also the
// only free estimate of Mobilize's own attendee count, which is a floor no cap
// we push may go under. See `remainingSeats`.
//
// Pure: no I/O, so the arithmetic is testable without either API.

import type { PlannedEvent } from './transform.js';
import type { ExistingRsvp } from './rsvp.js';

/** `source_system` on the RSVPs this sync writes. See createRsvp. */
export const MOBILIZE_SOURCE_SYSTEM = 'mobilize';

/** A session's spent seats, split by the system each signup came from. */
export interface SeatCount {
	/** Signups that did NOT come from Mobilize — the ones to subtract from the cap. */
	solidarity: number;
	/**
	 * Signups Mobilize is already holding, as mirrored back by the attendee sync.
	 * Approximate by nature: it misses anyone who signed up in Mobilize since that
	 * sync last ran. It is only ever used as a floor, where running low costs one
	 * rejected PUT and running high would close a shift early.
	 */
	mobilize: number;
}

/**
 * Split a session's RSVPs into the two counts above.
 *
 * Only `yes` occupies a Solidarity seat: `no` is a cancellation, `maybe` was
 * never a commitment, and `waitlisted` is by definition someone who did not get
 * one. The Mobilize side counts `waitlisted` as well — that row is someone
 * Mobilize did take a signup from, and Mobilize goes on counting them whatever
 * Solidarity files them as. Only a cancellation gives that seat back.
 */
export function countSeats(rows: ExistingRsvp[]): SeatCount {
	let solidarity = 0;
	let mobilize = 0;
	for (const row of rows) {
		if (row.source_system === MOBILIZE_SOURCE_SYSTEM) {
			if (row.is_attending === 'yes' || row.is_attending === 'waitlisted') mobilize++;
		} else if (row.is_attending === 'yes') {
			solidarity++;
		}
	}
	return { solidarity, mobilize };
}

/**
 * What to send as a Mobilize timeslot's `max_attendees`.
 *
 * `null` in means uncapped in Solidarity, and stays uncapped — never turn "no
 * limit" into a limit. Otherwise it is the seats left for Mobilize to fill,
 * floored at zero: a full shift is pushed as `0`, which Mobilize reads as
 * "nobody may sign up" and which is why transform.ts is careful never to let a
 * genuine 0 mean "unlimited".
 *
 * The floor is really `seats.mobilize` rather than zero. Both sides take signups
 * at the same time, so a session can genuinely end up over its cap: 15 seats
 * spent in Solidarity and 6 already taken in Mobilize, against a cap of 20,
 * leaves 5 — fewer than Mobilize is holding. Mobilize rejects that PUT outright
 * ("Timeslot capacity cannot be less than 6 (current attendees)") and takes the
 * rest of the event's update down with it, so the cap goes out as what Mobilize
 * already has: the shift stops taking signups, which is as close to the cap as
 * anyone can get without throwing people out of an event they signed up for.
 */
export function remainingSeats(capacity: number | null, seats: SeatCount): number | null {
	if (capacity === null) return null;
	return Math.max(capacity - seats.solidarity, seats.mobilize);
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
export function applySeatsTaken(
	plan: PlannedEvent,
	seatsTaken: Map<number, SeatCount>,
): PlannedEvent {
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
