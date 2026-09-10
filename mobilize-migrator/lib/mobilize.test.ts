import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createEvent,
	listEventAttendances,
	MobilizeError,
	type MobilizeApiConfig,
} from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };

function stubResponse(status: number, body: unknown) {
	vi.stubGlobal('fetch', async () => ({
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	}));
}

/** Raw bodies, so a non-JSON challenge page can be replayed verbatim. */
function stubSequence(...responses: { status: number; text: string }[]) {
	const fetchMock = vi.fn(async () => {
		const next = responses.shift();
		if (!next) throw new Error('fetch called more times than the test stubbed');
		return {
			ok: next.status >= 200 && next.status < 300,
			status: next.status,
			text: async () => next.text,
			headers: new Headers(),
		};
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

// The page that actually came back for event 1025563, trimmed.
const CHALLENGE_PAGE =
	'<!DOCTYPE html><html lang="en"><head> <meta charset="UTF-8"> <title>Please wait...</title>' +
	' <script> function redirectBasedOnURL() { var currentURL = window.location.href; }</script>';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('edge challenge pages', () => {
	// An edge layer in front of api.mobilize.us answers the odd request with a
	// challenge page under a 5xx. Before this retried, one blip cost a whole
	// event's signups for the run.
	it('retries a read through a 530 instead of failing the event', async () => {
		const fetchMock = stubSequence(
			{ status: 530, text: CHALLENGE_PAGE },
			{
				status: 200,
				text: JSON.stringify({ data: [{ id: 5, status: 'REGISTERED' }], next: null }),
			},
		);
		vi.useFakeTimers();

		const pending = listEventAttendances(API, 1025563);
		await vi.runAllTimersAsync();

		expect(await pending).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// A 530 never reached Mobilize, but a 5xx on a write can mean the origin
	// processed it and only the reply was lost — replaying that creates a
	// second event, so writes stay on 429-only.
	it('does not replay a write, and says the API was never reached', async () => {
		const fetchMock = stubSequence({ status: 530, text: CHALLENGE_PAGE });

		await expect(createEvent(API, {})).rejects.toThrow(/never reached the API/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('still reports a real rejection body rather than swallowing it', async () => {
		stubSequence({
			status: 400,
			text: JSON.stringify({ error: { description: 'This field may not be blank.' } }),
		});
		await expect(createEvent(API, {})).rejects.toThrow(/may not be blank/);
	});
});

describe('createEvent envelope', () => {
	// Verified against the live API: create nests the event one level deeper
	// than every other endpoint. Reading data.id returns undefined and every
	// create fails — which is exactly what happened the first time this ran.
	it('reads the id out of the nested data.event the API actually returns', async () => {
		stubResponse(200, {
			data: {
				event: {
					id: 997953,
					title: 'Detroit Canvass',
					timeslots: [{ id: 6196910, start_date: 1816715959, end_date: 1816723159 }],
				},
			},
			error: null,
		});

		const result = await createEvent(API, {});

		expect(result.id).toBe(997953);
		// The created event comes back with its new timeslot ids, so the caller
		// can pair them without a read-back.
		expect(result.event?.timeslots[0].id).toBe(6196910);
	});

	it('still accepts a flat data.event shape', async () => {
		stubResponse(200, { data: { id: 12345, title: 'X', timeslots: [] }, error: null });
		expect((await createEvent(API, {})).id).toBe(12345);
	});

	it('throws rather than recording a bogus ledger row when no id comes back', async () => {
		stubResponse(200, { data: { event: { title: 'no id here' } }, error: null });
		await expect(createEvent(API, {})).rejects.toThrow(/no event id/);
	});

	it('surfaces a 403 as a MobilizeError so the sync can report authFailed', async () => {
		stubResponse(403, { data: null, error: { detail: 'nope' } });
		await expect(createEvent(API, {})).rejects.toBeInstanceOf(MobilizeError);
		stubResponse(403, { data: null, error: { detail: 'nope' } });
		await expect(createEvent(API, {})).rejects.toThrow(/lacks the write access/);
	});

	it('treats an error in a 200 body as a failure', async () => {
		// The API answers 200 with {"data":null,"error":{…}} for validation
		// failures like a timeslot more than five years out.
		stubResponse(200, {
			data: null,
			error: {
				timeslots: [
					{ non_field_errors: ['Cannot create timeslots more than 5 years in the future'] },
				],
			},
		});
		await expect(createEvent(API, {})).rejects.toThrow(/5 years/);
	});
});
