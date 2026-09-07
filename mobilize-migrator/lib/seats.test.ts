import { describe, expect, it } from 'vitest';

import { applySeatsTaken, cappedSessionIds, countSeats, remainingSeats } from './seats.js';
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

describe('countSeats', () => {
	it('keeps the RSVPs this sync wrote from Mobilize out of the Solidarity count', () => {
		// The whole point: these people already occupy a Mobilize seat, so counting
		// them against the cap would charge them twice and close the shift at half
		// capacity.
		const rows = [
			rsvp({ id: 1, source_system: 'web' }),
			rsvp({ id: 2, source_system: 'mobilize' }),
			rsvp({ id: 3, source_system: 'mobilize' }),
		];
		expect(countSeats(rows)).toEqual({ solidarity: 1, mobilize: 2 });
	});

	it('counts only yes towards Solidarity — a cancellation or a waitlist holds no seat', () => {
		const rows = [
			rsvp({ id: 1, is_attending: 'yes' }),
			rsvp({ id: 2, is_attending: 'no' }),
			rsvp({ id: 3, is_attending: 'maybe' }),
			rsvp({ id: 4, is_attending: 'waitlisted' }),
		];
		expect(countSeats(rows).solidarity).toBe(1);
	});

	it('counts a waitlisted Mobilize signup as one Mobilize is still holding', () => {
		// We waitlist an over-cap signup in Solidarity; Mobilize knows nothing of
		// that and goes on counting them as an attendee. Miss this and the cap we
		// push lands under Mobilize's own count, which it rejects outright.
		const rows = [
			rsvp({ id: 1, source_system: 'mobilize', is_attending: 'yes' }),
			rsvp({ id: 2, source_system: 'mobilize', is_attending: 'waitlisted' }),
			rsvp({ id: 3, source_system: 'mobilize', is_attending: 'no' }),
		];
		expect(countSeats(rows).mobilize).toBe(2);
	});

	it('counts rows with no source at all, which predate source tracking', () => {
		expect(countSeats([rsvp({ source_system: null }), rsvp({ id: 2 })])).toEqual({
			solidarity: 2,
			mobilize: 0,
		});
	});
});

describe('remainingSeats', () => {
	it('leaves an uncapped shift uncapped', () => {
		expect(remainingSeats(null, { solidarity: 12, mobilize: 3 })).toBeNull();
	});

	it('subtracts the seats Solidarity has spent', () => {
		expect(remainingSeats(20, { solidarity: 8, mobilize: 0 })).toBe(12);
	});

	it('floors at zero rather than going negative', () => {
		// Mobilize reads 0 as "nobody may sign up", which is what an over-full
		// shift wants; a negative would be nonsense to send.
		expect(remainingSeats(10, { solidarity: 25, mobilize: 0 })).toBe(0);
	});

	it('never goes below what Mobilize is already holding', () => {
		// 15 spent in Solidarity leaves 5 of a cap of 20, but Mobilize has already
		// taken 6. It refuses a cap under its own attendee count and fails the
		// whole event with it, so the shift goes out closed at 6 instead.
		expect(remainingSeats(20, { solidarity: 15, mobilize: 6 })).toBe(6);
	});

	it('still hands over the seats left when Mobilize holds fewer', () => {
		expect(remainingSeats(20, { solidarity: 5, mobilize: 3 })).toBe(15);
	});
});

describe('applySeatsTaken', () => {
	it('adjusts each shift by its own session count', () => {
		const result = applySeatsTaken(
			plan([10, 11], [20, 5]),
			new Map([
				[10, { solidarity: 8, mobilize: 0 }],
				[11, { solidarity: 1, mobilize: 0 }],
			]),
		);
		expect(result.timeslots.map((s) => s.maxAttendees)).toEqual([12, 4]);
	});

	it('leaves a session it has no count for at its full cap', () => {
		// A failed read must not read as "the shift is full".
		const result = applySeatsTaken(
			plan([10, 11], [20, 5]),
			new Map([[10, { solidarity: 8, mobilize: 0 }]]),
		);
		expect(result.timeslots.map((s) => s.maxAttendees)).toEqual([12, 5]);
	});

	it('never turns an uncapped shift into a capped one', () => {
		const result = applySeatsTaken(
			plan([10], [null]),
			new Map([[10, { solidarity: 9, mobilize: 4 }]]),
		);
		expect(result.timeslots[0]!.maxAttendees).toBeNull();
	});

	it('returns the plan untouched when nothing is capped', () => {
		const original = plan([10, 11], [null, null]);
		expect(applySeatsTaken(original, new Map([[10, { solidarity: 3, mobilize: 0 }]]))).toBe(
			original,
		);
	});
});

describe('cappedSessionIds', () => {
	it('names only the sessions worth spending a read on', () => {
		expect(cappedSessionIds(plan([10, 11, 12], [20, null, 3]))).toEqual([10, 12]);
	});
});
