// Writing RSVPs and attendance records into Solidarity.
//
// Path naming trap: the real endpoints use UNDERSCORES — /v1/event_rsvps and
// /v1/event_attendances. The documentation URLs use hyphens
// (reference/post_event-rsvps), and the hyphenated API paths 404.
//
// Id naming trap: Solidarity's `event_id` here is a SOLIDARITY event id. Its API
// calls its own event entity a "mobilize_event" (event sessions carry a
// `mobilize_event_id` pointing at a Solidarity event), which has nothing to do
// with mobilize.us. Passing a mobilize.us event id would attach RSVPs to an
// unrelated event.

import { fetchWithRetry } from '../../src/lib/server/solidarity-paginate.js';
import type { ParticipationStatus } from './attendees.js';

const API = 'https://api.solidarity.tech/v1';

export type AttendingValue = 'yes' | 'no' | 'maybe' | 'waitlisted';

export interface RsvpTarget {
	/** Solidarity event id. */
	eventId: number;
	/** Solidarity event session id. */
	sessionId: number;
	userId: number;
}

export interface ExistingRsvp {
	id: number;
	user_id: number;
	event_session_id: number;
	is_attending: string;
	/**
	 * Where the RSVP came from — `mobilize` for the ones this sync writes, and
	 * `web`, `mobile`, `dashboard` and friends for everything else. Load-bearing
	 * for the capacity math: see countSolidaritySeats in seats.ts, which must not
	 * charge a Mobilize signup against the cap it hands back to Mobilize.
	 */
	source_system?: string | null;
}

/**
 * How a Mobilize signup status lands in Solidarity.
 *
 * A cancellation updates the RSVP to "no" rather than deleting it, so organizers
 * see that someone pulled out instead of the person silently disappearing, and
 * turnout history survives.
 */
export function attendingFor(status: ParticipationStatus): AttendingValue | null {
	switch (status) {
		// CONFIRMED means the person reconfirmed a registration — the same intent
		// as REGISTERED, a firmer yes rather than a different one.
		case 'REGISTERED':
		case 'CONFIRMED':
			return 'yes';
		case 'CANCELLED':
			return 'no';
		default:
			// Unrecognized Mobilize status — reported by the caller, never guessed.
			return null;
	}
}

/** Existing RSVPs on a session, so signups entered directly in Solidarity aren't duplicated. */
export async function listSessionRsvps(token: string, sessionId: number): Promise<ExistingRsvp[]> {
	const all: ExistingRsvp[] = [];
	for (let offset = 0; offset < 2000; offset += 100) {
		const res = await fetchWithRetry(
			`${API}/event_rsvps?session_id=${sessionId}&_limit=100&_offset=${offset}`,
			{ headers: { Authorization: `Bearer ${token}` } },
			`rsvp list for session ${sessionId}`,
			'attendee-sync',
			{ retriesUsed: 0 },
		);
		if (!res.ok) throw new Error(`Solidarity rsvp list returned ${res.status}`);
		const body = (await res.json()) as { data?: ExistingRsvp[] };
		const rows = body.data ?? [];
		all.push(...rows);
		if (rows.length < 100) break;
	}
	return all;
}

/**
 * Create an RSVP.
 *
 * `skip_email_confirmation` is not optional in practice: without it Solidarity
 * emails a confirmation to every person the sync touches, which on a backfill
 * means thousands of unexpected emails about events they already signed up for.
 *
 * `agent_user_id` is required — a null one is rejected with
 * `422 {"errors":["Agent must exist"]}`. It records *who* filed the RSVP, and
 * Solidarity's own self-signups (`source: web_form`) set it to the attendee.
 * A Mobilize signup is the same thing: the person registered themselves, so the
 * agent is them, not an organizer.
 */
export async function createRsvp(
	token: string,
	target: RsvpTarget,
	isAttending: AttendingValue,
	isConfirmed = false,
): Promise<number> {
	const res = await fetchWithRetry(
		`${API}/event_rsvps`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event_id: target.eventId,
				event_session_id: target.sessionId,
				user_id: target.userId,
				is_attending: isAttending,
				is_confirmed: isConfirmed,
				agent_user_id: target.userId,
				source: 'mobilize',
				source_system: 'mobilize',
				skip_email_confirmation: true,
			}),
		},
		'rsvp create',
		'attendee-sync',
		{ retriesUsed: 0 },
	);
	if (!res.ok) {
		throw new Error(
			`Solidarity rsvp create returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
		);
	}
	const body = (await res.json()) as { data?: { id?: number } };
	const id = body.data?.id;
	if (typeof id !== 'number') throw new Error('Solidarity rsvp create returned no id');
	return id;
}

/** Update an existing RSVP — used to record a cancellation. */
export async function updateRsvp(
	token: string,
	rsvpId: number,
	isAttending: AttendingValue,
): Promise<void> {
	const res = await fetchWithRetry(
		`${API}/event_rsvps/${rsvpId}`,
		{
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ is_attending: isAttending, skip_email_confirmation: true }),
		},
		'rsvp update',
		'attendee-sync',
		{ retriesUsed: 0 },
	);
	if (!res.ok) {
		throw new Error(
			`Solidarity rsvp update returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
		);
	}
}

/** Record that someone actually showed up. Separate from RSVP by design. */
export async function createAttendance(token: string, target: RsvpTarget): Promise<void> {
	const res = await fetchWithRetry(
		`${API}/event_attendances`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event_id: target.eventId,
				event_session_id: target.sessionId,
				user_id: target.userId,
				attended: true,
			}),
		},
		'attendance create',
		'attendee-sync',
		{ retriesUsed: 0 },
	);
	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);
		// Solidarity enforces one attendance row per (event, session, user), so a
		// 422 "User has already been taken" means the row we were about to create
		// already exists — the exact state this call wanted. Treating it as an
		// error made deliberate re-runs page on success: the ledger write lands
		// after this call, so any run interrupted between the two leaves the
		// participation looking unrecorded, and the next run collides here.
		// Narrow on purpose — every other 4xx still throws.
		if (res.status === 422 && /already been taken/i.test(body)) return;
		throw new Error(`Solidarity attendance create returned ${res.status}: ${body}`);
	}
}
