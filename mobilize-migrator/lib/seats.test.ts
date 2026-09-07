import { describe, expect, it } from 'vitest';

import {
	applySeatsTaken,
	cappedSessionIds,
	countSolidaritySeats,
	remainingSeats,
} from './seats.js';
import type { ExistingRsvp } from './rsvp.js';
import type { PlannedEvent } from './transform.js';

const HOUR = 3600_000;
const START = Date.parse('2026-08-01T22:00:00Z');

function rsvp(overrides: Partial<ExistingRsvp> = {}): ExistingRsvp {
	return {
		id: 1,
		user_id: 100,
		event_session_id: 10,
		is_attending: 'yes',
		source_system: 'web',
		...overrides,
	};
}

function plan(
	sessionIds: number[],
	caps: (number | null)[],
	overrides: Partial<PlannedEvent> = {},
): PlannedEvent {
	return {
		key: 'solidarity:1:venue',
		solidarityEventId: 1,
		solidaritySessionIds: sessionIds,
		title: 'Detroit Canvass',
		description: 'Knock doors',
		eventType: 'COMMUNITY_CANVASS',
		locationName: 'Field Office',
		addressLine1: '2857 East Grand Boulevard',
		city: 'Detroit',
		state: 'MI',
		zipcode: '48202',
		country: 'US',
		locationIsPrivate: false,
		coordinates: null,
		timeslots: caps.map((maxAttendees, i) => ({
			startDate: Math.floor((START + i * HOUR) / 1000),
			endDate: Math.floor((START + (i + 2) * HOUR) / 1000),
			maxAttendees,
		})),
		startInstants: caps.map((_, i) => START + i * HOUR),
		endInstants: caps.map((_, i) => START + (i + 2) * HOUR),
		sourceUrl: null,
		sourceImageUrl: null,
		...overrides,
	};
}

describe('countSolidaritySeats', () => {
	it('ignores RSVPs this sync wrote from Mobilize', () => {
		// The whole point: these people already occupy a Mobilize seat, so counting
		// them here would charge them twice and close the shift at half capacity.
		const rows = [
			rsvp({ id: 1, source_system: 'web' }),
			rsvp({ id: 2, source_system: 'mobilize' }),
			rsvp({ id: 3, source_system: 'mobilize' }),
		];
		expect(countSolidaritySeats(rows)).toBe(1);
	});

	it('counts only yes — a cancellation or a waitlist holds no seat', () => {
		const rows = [
			rsvp({ id: 1, is_attending: 'yes' }),
			rsvp({ id: 2, is_attending: 'no' }),
			rsvp({ id: 3, is_attending: 'maybe' }),
			rsvp({ id: 4, is_attending: 'waitlisted' }),
		];
		expect(countSolidaritySeats(rows)).toBe(1);
	});

	it('counts rows with no source at all, which predate source tracking', () => {
		expect(countSolidaritySeats([rsvp({ source_system: null }), rsvp({ id: 2 })])).toBe(2);
	});
});

describe('remainingSeats', () => {
	it('leaves an uncapped shift uncapped', () => {
		expect(remainingSeats(null, 12)).toBeNull();
	});

	it('subtracts the seats Solidarity has spent', () => {
		expect(remainingSeats(20, 8)).toBe(12);
	});

	it('floors at zero rather than going negative', () => {
		// Mobilize reads 0 as "nobody may sign up", which is what an over-full
		// shift wants; a negative would be nonsense to send.
		expect(remainingSeats(10, 25)).toBe(0);
	});
});

describe('applySeatsTaken', () => {
	it('adjusts each shift by its own session count', () => {
		const result = applySeatsTaken(
			plan([10, 11], [20, 5]),
			new Map([
				[10, 8],
				[11, 1],
			]),
		);
		expect(result.timeslots.map((s) => s.maxAttendees)).toEqual([12, 4]);
	});

	it('leaves a session it has no count for at its full cap', () => {
		// A failed read must not read as "the shift is full".
		const result = applySeatsTaken(plan([10, 11], [20, 5]), new Map([[10, 8]]));
		expect(result.timeslots.map((s) => s.maxAttendees)).toEqual([12, 5]);
	});

	it('never turns an uncapped shift into a capped one', () => {
		const result = applySeatsTaken(plan([10], [null]), new Map([[10, 9]]));
		expect(result.timeslots[0]!.maxAttendees).toBeNull();
	});

	it('returns the plan untouched when nothing is capped', () => {
		const original = plan([10, 11], [null, null]);
		expect(applySeatsTaken(original, new Map([[10, 3]]))).toBe(original);
	});
});

describe('cappedSessionIds', () => {
	it('names only the sessions worth spending a read on', () => {
		expect(cappedSessionIds(plan([10, 11, 12], [20, null, 3]))).toEqual([10, 12]);
	});
});
