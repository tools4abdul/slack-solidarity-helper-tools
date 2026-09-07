// Reads event signups out of the Mobilize v1 API.
//
//   GET /v1/organizations/:orgId/events/:eventId/attendances
//
// One request per event covers every timeslot on it, so the sync groups its
// work by event rather than by shift. Status and attendance come back as
// documented values — no decoding numeric codes or inferring attendance from a
// check-in timestamp, both of which the dashboard scrape this replaced had to do.

import {
	listEventAttendances,
	type MobilizeApiConfig,
	type MobilizeAttendance,
} from './mobilize.js';

/** Documented values. UNKNOWN covers anything Mobilize adds later — reported
 *  rather than guessed at, because mapping one wrong marks real attendees
 *  cancelled. */
export type ParticipationStatus = 'REGISTERED' | 'CANCELLED' | 'CONFIRMED' | 'UNKNOWN';

const KNOWN_STATUSES = new Set<ParticipationStatus>(['REGISTERED', 'CANCELLED', 'CONFIRMED']);

export interface MobilizeParticipation {
	/** Attendance id — stable key for the sync ledger. */
	id: number;
	timeslotId: number;
	status: ParticipationStatus;
	/** null when Mobilize hasn't recorded an outcome yet — not "did not attend". */
	attended: boolean | null;
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	phone: string | null;
	zipcode: string | null;
	/** Unix seconds; lets a re-run skip rows that haven't changed. */
	modifiedDate: number;
	/**
	 * When the person signed up, in unix seconds. 0 when Mobilize did not send
	 * one — never observed, but the ordering must stay defined if it happens.
	 *
	 * This decides who gets the last seat on a capped shift, so it is not
	 * cosmetic: see the sort in attendee-sync.ts.
	 */
	createdDate: number;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toStatus(raw: unknown): ParticipationStatus {
	const value = typeof raw === 'string' ? raw.toUpperCase() : '';
	return KNOWN_STATUSES.has(value as ParticipationStatus)
		? (value as ParticipationStatus)
		: 'UNKNOWN';
}

/** Mobilize returns these as arrays, in practice of length one, with the wanted
 *  entry flagged `primary`. */
function primary<T extends { primary?: boolean }>(list: T[] | null | undefined): T | undefined {
	if (!list?.length) return undefined;
	return list.find((entry) => entry.primary) ?? list[0];
}

export function normalizeAttendance(row: MobilizeAttendance): MobilizeParticipation | null {
	const timeslotId = row.timeslot?.id;
	if (typeof row.id !== 'number' || typeof timeslotId !== 'number') return null;
	const person = row.person ?? {};

	return {
		id: row.id,
		timeslotId,
		status: toStatus(row.status),
		attended: typeof row.attended === 'boolean' ? row.attended : null,
		firstName: str(person.given_name),
		lastName: str(person.family_name),
		email: str(primary(person.email_addresses)?.address),
		phone: str(primary(person.phone_numbers)?.number),
		zipcode: str(primary(person.postal_addresses)?.postal_code),
		modifiedDate: typeof row.modified_date === 'number' ? row.modified_date : 0,
		createdDate: typeof row.created_date === 'number' ? row.created_date : 0,
	};
}

/** Every signup on one Mobilize event, across all of its timeslots. */
export async function fetchEventParticipations(
	eventId: number,
	config: MobilizeApiConfig,
): Promise<MobilizeParticipation[]> {
	const rows = await listEventAttendances(config, eventId);
	const out: MobilizeParticipation[] = [];
	for (const row of rows) {
		const normalized = normalizeAttendance(row);
		if (normalized) out.push(normalized);
	}
	return out;
}
