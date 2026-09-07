import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	runAttendeeSync,
	type AttendeeLedger,
	type RsvpRecord,
	type TimeslotLink,
} from './attendee-sync.js';
import type { MobilizeApiConfig, MobilizeAttendance } from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };

const LINK: TimeslotLink = {
	mobilizeTimeslotId: 6157028,
	mobilizeEventId: 812345,
	solidarityEventId: 27463,
	solidaritySessionId: 80929,
	eventChapterId: 1330,
	startsAt: Date.now() + 3600_000,
	sessionCapacity: null,
};

function attendance(overrides: Partial<MobilizeAttendance> = {}): MobilizeAttendance {
	return {
		id: 1,
		status: 'REGISTERED',
		attended: null,
		modified_date: 1785000000,
		event: { id: LINK.mobilizeEventId },
		timeslot: { id: LINK.mobilizeTimeslotId },
		person: {
			given_name: 'A',
			family_name: 'B',
			email_addresses: [{ primary: true, address: 'a@example.com' }],
			phone_numbers: [{ primary: true, number: '6165551234' }],
			postal_addresses: [{ primary: true, postal_code: '49504' }],
		},
		...overrides,
	};
}

/** The live 422 Solidarity returns for a number it cannot text. */
const PHONE_REJECTED = {
	error: 'Failed to save user',
	details: [
		{
			field_name: 'phone_number',
			message: 'Please enter a valid phone number capable of receiving text messages',
		},
	],
};

/** Routes by URL: Mobilize v1 API, Solidarity RSVP list, Solidarity user search. */
function mockApis(options: {
	attendances: MobilizeAttendance[];
	userFound?: boolean;
	/**
	 * Answer every user lookup with more than one row — what a filter that has
	 * stopped filtering looks like, since it returns the unfiltered list.
	 */
	userLookupAmbiguous?: boolean;
	/** Refuse any user create that carries a phone, the way Solidarity does. */
	rejectPhoneOnCreate?: boolean;
	/** RSVPs Solidarity already holds for the session, for the capacity tests. */
	sessionRsvps?: { id: number; user_id: number; is_attending: string }[];
}) {
	const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		const writing = init?.method === 'POST' || init?.method === 'PUT';
		if (options.rejectPhoneOnCreate && writing && href.includes('/v1/users')) {
			const sent = JSON.parse(String(init?.body ?? '{}')) as { phone_number?: string | null };
			if (sent.phone_number) {
				return {
					ok: false,
					status: 422,
					json: async () => PHONE_REJECTED,
					text: async () => JSON.stringify(PHONE_REJECTED),
					headers: new Headers(),
				} as unknown as Response;
			}
		}
		let body: unknown = {};
		if (href.includes('api.mobilize.us')) {
			body = { data: options.attendances, next: null };
		} else if (writing) {
			// Solidarity returns the created row; the sync reads its id.
			body = { data: { id: 999 } };
		} else if (href.includes('/v1/event_rsvps')) {
			body = { data: options.sessionRsvps ?? [] };
		} else if (href.includes('/v1/users')) {
			if (options.userLookupAmbiguous) body = { data: [{ id: 998 }, { id: 999 }] };
			else body = { data: options.userFound ? [{ id: 999 }] : [] };
		}
		return {
			ok: true,
			status: 200,
			json: async () => body,
			text: async () => JSON.stringify(body),
			headers: new Headers(),
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

/**
 * The 404 case: an event deleted in Mobilize whose timeslot pairings stayed
 * behind. `eventStillThere` controls the read-back the sync uses to tell a
 * deleted event from an unexplained 404 on its attendances.
 */
function mockGoneEvent(options: { eventStillThere: boolean }) {
	const spy = vi.fn(async (url: string | URL) => {
		const href = String(url);
		const reply = (status: number, body: unknown) =>
			({
				ok: status < 400,
				status,
				json: async () => body,
				text: async () => JSON.stringify(body),
				headers: new Headers(),
			}) as unknown as Response;

		if (href.includes('/attendances')) {
			// The live body, verbatim.
			return reply(404, { data: null, error: { detail: 'Not found.' } });
		}
		if (/\/organizations\/\d+\/events\/\d+$/.test(href)) {
			return options.eventStillThere
				? reply(200, { data: { id: LINK.mobilizeEventId, timeslots: [] } })
				: reply(404, { data: null, error: { detail: 'Not found.' } });
		}
		return reply(200, { data: [] });
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

function ledgerWith(records: RsvpRecord[] = []): AttendeeLedger & { forgotten: number[] } {
	const map = new Map(records.map((r) => [r.mobilizeAttendanceId, r]));
	const forgotten: number[] = [];
	return {
		forgotten,
		async rsvpsByAttendanceId() {
			return map;
		},
		async recordRsvp(record) {
			map.set(record.mobilizeAttendanceId, record);
		},
		async forgetEvent(mobilizeEventId) {
			forgotten.push(mobilizeEventId);
		},
	};
}

function run(ledger: AttendeeLedger, apply = false, links: TimeslotLink[] = [LINK]) {
	return runAttendeeSync(
		links,
		{ api: API, solidarityToken: 't', apply, maxNewProfiles: 1000, pauseMs: 0 },
		ledger,
		new Map(),
		1330,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('runAttendeeSync dry-run accounting', () => {
	it('counts the RSVP for someone who would also need a new profile', async () => {
		// Regression: the dry run used to `continue` after counting the profile,
		// so it reported far fewer RSVPs than the real run would write — and that
		// number is what a human uses to decide whether to proceed.
		mockApis({ attendances: [attendance()], userFound: false });

		const report = await run(ledgerWith());

		expect(report.profilesCreated).toBe(1);
		expect(report.rsvpsCreated).toBe(1);
	});

	it('reconciles: every signup is matched, created, or explicitly skipped', async () => {
		mockApis({
			attendances: [
				attendance({ id: 1 }),
				attendance({ id: 2 }),
				attendance({ id: 3, person: { given_name: 'No', family_name: 'Contact' } }),
				attendance({ id: 4, status: 'SOMETHING_NEW' }),
			],
			userFound: false,
		});

		const report = await run(ledgerWith());

		expect(report.participations).toBe(4);
		expect(
			report.matchedByEmail +
				report.matchedByPhone +
				report.profilesCreated +
				report.skippedNoContact +
				report.skippedUnknownStatus,
		).toBe(4);
	});

	it('does not double-count a profile in apply mode', async () => {
		mockApis({ attendances: [attendance()], userFound: false });

		const report = await run(ledgerWith(), true);

		expect(report.profilesCreated).toBe(1);
	});
});

describe('runAttendeeSync phone numbers Solidarity will not accept', () => {
	// Regression: Solidarity checks that a new profile's number can receive texts
	// and Mobilize does not, so landlines and typos came through and 422'd the
	// create. That failed the whole signup, so their RSVP never landed and the
	// same person alerted on every run forever.

	it('creates the profile without the phone when there is an email to keep', async () => {
		const spy = mockApis({
			attendances: [attendance()],
			userFound: false,
			rejectPhoneOnCreate: true,
		});

		const report = await run(ledgerWith(), true);

		expect(report.failed).toBe(0);
		expect(report.errors).toEqual([]);
		expect(report.profilesCreated).toBe(1);
		expect(report.profilesCreatedWithoutPhone).toBe(1);
		expect(report.rsvpsCreated).toBe(1);

		// The retry keeps everything else the signup gave us.
		const retry = spy.mock.calls
			.filter(([url, init]) => String(url).includes('/v1/users') && (init as RequestInit)?.body)
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)))
			.at(-1);
		expect(retry).toMatchObject({ email: 'a@example.com', phone_number: null, first_name: 'A' });
	});

	it('skips the signup, without failing, when the phone was all we had', async () => {
		mockApis({
			attendances: [
				attendance({
					person: {
						given_name: 'No',
						family_name: 'Email',
						phone_numbers: [{ primary: true, number: '6165551234' }],
					},
				}),
			],
			userFound: false,
			rejectPhoneOnCreate: true,
		});

		const report = await run(ledgerWith(), true);

		expect(report.skippedInvalidPhone).toBe(1);
		expect(report.failed).toBe(0);
		expect(report.errors).toEqual([]);
		expect(report.profilesCreated).toBe(0);
		expect(report.rsvpsCreated).toBe(0);
	});

	it('still fails on a 422 that is not about the phone', async () => {
		const rejected = { error: 'Failed to save user', details: [{ field_name: 'chapter_id' }] };
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const href = String(url);
				const writing = init?.method === 'POST';
				const bad = writing && href.includes('/v1/users');
				const body = href.includes('api.mobilize.us')
					? { data: [attendance()], next: null }
					: bad
						? rejected
						: { data: [] };
				return {
					ok: !bad,
					status: bad ? 422 : 200,
					json: async () => body,
					text: async () => JSON.stringify(body),
					headers: new Headers(),
				} as unknown as Response;
			}),
		);

		const report = await run(ledgerWith(), true);

		expect(report.failed).toBe(1);
		expect(report.errors[0]).toContain('chapter_id');
	});
});

describe('runAttendeeSync event grouping', () => {
	it('reads each event once, however many of its shifts are in scope', async () => {
		// The whole point of moving off the per-timeslot dashboard route: an event
		// with several shifts used to cost one request per shift.
		const second: TimeslotLink = {
			...LINK,
			mobilizeTimeslotId: 6157029,
			solidaritySessionId: 80930,
		};
		const spy = mockApis({ attendances: [attendance()], userFound: true });

		const report = await run(ledgerWith(), false, [LINK, second]);

		const mobilizeCalls = spy.mock.calls.filter(([url]) => String(url).includes('api.mobilize.us'));
		expect(mobilizeCalls).toHaveLength(1);
		expect(report.events).toBe(1);
		expect(report.timeslots).toBe(2);
	});

	it('drops signups for shifts outside the requested window', async () => {
		// One request returns every shift on the event, including ones the caller's
		// window excluded. Those must not be filed.
		mockApis({
			attendances: [attendance({ id: 1 }), attendance({ id: 2, timeslot: { id: 999999 } })],
			userFound: true,
		});

		const report = await run(ledgerWith());

		expect(report.participations).toBe(1);
	});
});

describe('runAttendeeSync deleted Mobilize events', () => {
	it('drops the pairings for an event Mobilize no longer has, without failing', async () => {
		// Regression: a Mobilize event deleted there leaves its timeslot pairings in
		// the ledger, so every run re-requested /events/<id>/attendances, got 404,
		// and reported a failure — the same alert, nightly, forever.
		mockGoneEvent({ eventStillThere: false });
		const ledger = ledgerWith();

		const report = await run(ledger, true);

		expect(report.eventsGone).toBe(1);
		expect(report.failed).toBe(0);
		expect(report.errors).toEqual([]);
		expect(ledger.forgotten).toEqual([LINK.mobilizeEventId]);
	});

	it('keeps the pairings on a dry run', async () => {
		mockGoneEvent({ eventStillThere: false });
		const ledger = ledgerWith();

		const report = await run(ledger, false);

		expect(report.eventsGone).toBe(1);
		expect(ledger.forgotten).toEqual([]);
	});

	it('still reports a failure when the event itself reads back fine', async () => {
		// 404 on the attendances of a live event is not a deletion — it is something
		// unexplained, and dropping the pairings would silently stop syncing a real
		// event's signups.
		mockGoneEvent({ eventStillThere: true });
		const ledger = ledgerWith();

		const report = await run(ledger, true);

		expect(report.eventsGone).toBe(0);
		expect(report.failed).toBe(1);
		expect(ledger.forgotten).toEqual([]);
	});
});

describe('runAttendeeSync change detection', () => {
	const prior: RsvpRecord = {
		mobilizeAttendanceId: 1,
		solidarityRsvpId: 500,
		solidarityUserId: 999,
		solidaritySessionId: LINK.solidaritySessionId,
		status: 'REGISTERED',
		attended: false,
		modifiedDate: 1785000000,
	};

	it('skips a signup that has not changed', async () => {
		mockApis({ attendances: [attendance()], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(1);
		expect(report.rsvpsCreated).toBe(0);
	});

	it('reprocesses a row Mobilize has touched since we last mirrored it', async () => {
		mockApis({ attendances: [attendance({ modified_date: 1785009999 })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
	});

	it('skips a previously-recorded attendance instead of reprocessing it forever', async () => {
		// Regression: the skip checked only `!participation.attended`, so everyone
		// who showed up was re-matched on every run while the event stayed inside
		// the lookback window.
		mockApis({ attendances: [attendance({ attended: true })], userFound: true });

		const report = await run(ledgerWith([{ ...prior, attended: true }]));

		expect(report.unchanged).toBe(1);
	});

	it('still processes a newly-recorded attendance', async () => {
		mockApis({ attendances: [attendance({ attended: true })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
	});

	it('processes a cancellation of an existing RSVP', async () => {
		mockApis({ attendances: [attendance({ status: 'CANCELLED' })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
		expect(report.rsvpsUpdated).toBe(1);
	});
});

describe('runAttendeeSync rsvp payload', () => {
	it('files the RSVP against a real agent', async () => {
		// Regression: `agent_user_id: null` is rejected with
		// 422 {"errors":["Agent must exist"]}, so every create failed. A Mobilize
		// signup is self-service, so the agent is the attendee — the same thing
		// Solidarity records for its own web-form signups.
		const spy = mockApis({ attendances: [attendance()], userFound: true });

		await run(ledgerWith(), true);

		const create = spy.mock.calls.find(
			([url, init]) =>
				String(url).includes('/v1/event_rsvps') &&
				(init as RequestInit | undefined)?.method === 'POST',
		);
		expect(create).toBeDefined();
		const body = JSON.parse(String((create![1] as RequestInit).body));
		expect(body.agent_user_id).toBe(999);
		expect(body.user_id).toBe(999);
	});
});

describe('runAttendeeSync match-health counters', () => {
	it('counts one lookup per person resolved, and none for ledgered rows', async () => {
		// The match rate divides by this, so a run that skips the API entirely
		// must not report a 0% match rate.
		mockApis({ attendances: [attendance({ id: 1 })] });
		const ledger = ledgerWith([
			{
				mobilizeAttendanceId: 1,
				solidarityRsvpId: 500,
				solidarityUserId: 999,
				solidaritySessionId: LINK.solidaritySessionId,
				status: 'REGISTERED',
				attended: false,
				modifiedDate: 1785000000,
			},
		]);

		const report = await run(ledger);

		expect(report.unchanged).toBe(1);
		expect(report.lookupsPerformed).toBe(0);
		expect(report.lookupsAmbiguous).toBe(0);
	});

	it('counts a match without counting it ambiguous', async () => {
		mockApis({ attendances: [attendance()], userFound: true });

		const report = await run(ledgerWith());

		expect(report.lookupsPerformed).toBe(1);
		expect(report.matchedByEmail).toBe(1);
		expect(report.lookupsAmbiguous).toBe(0);
	});

	it('counts a never-seen person as a lookup but not as ambiguous', async () => {
		// The genuine-surge shape: misses, but clean ones.
		mockApis({ attendances: [attendance()] });

		const report = await run(ledgerWith());

		expect(report.lookupsPerformed).toBe(1);
		expect(report.lookupsAmbiguous).toBe(0);
		expect(report.profilesCreated).toBe(1);
	});

	it('counts an ambiguous lookup and still creates the profile', async () => {
		// Deliberate: skipping would lose the RSVP and report nothing wrong. The
		// counter is what surfaces it, and maxNewProfiles still caps the damage.
		mockApis({ attendances: [attendance()], userLookupAmbiguous: true });

		const report = await run(ledgerWith(), true);

		expect(report.lookupsPerformed).toBe(1);
		expect(report.lookupsAmbiguous).toBe(1);
		expect(report.matchedByEmail).toBe(0);
		expect(report.matchedByPhone).toBe(0);
		expect(report.profilesCreated).toBe(1);
	});
});

/** The RSVP writes a run made, newest last: [method, is_attending]. */
function rsvpWrites(spy: ReturnType<typeof mockApis>): { method: string; attending: string }[] {
	return spy.mock.calls
		.filter(
			([url, init]) =>
				String(url).includes('/v1/event_rsvps') &&
				(init?.method === 'POST' || init?.method === 'PUT'),
		)
		.map(([, init]) => ({
			method: String(init?.method),
			attending: (JSON.parse(String(init?.body ?? '{}')) as { is_attending?: string })
				.is_attending as string,
		}));
}

const capped = (capacity: number | null): TimeslotLink => ({ ...LINK, sessionCapacity: capacity });

/** Seats held by other people, so the newcomer is the one at the line. */
const seats = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ id: 500 + i, user_id: 1 + i, is_attending: 'yes' }));

describe('runAttendeeSync capacity', () => {
	it('waitlists a new signup for a shift that is already full', async () => {
		const spy = mockApis({ attendances: [attendance()], userFound: false, sessionRsvps: seats(2) });

		const report = await run(ledgerWith(), true, [capped(2)]);

		expect(report.rsvpsCreated).toBe(1);
		expect(report.rsvpsWaitlisted).toBe(1);
		expect(rsvpWrites(spy)).toEqual([{ method: 'POST', attending: 'waitlisted' }]);
	});

	it('seats a new signup while the shift still has room', async () => {
		const spy = mockApis({ attendances: [attendance()], userFound: false, sessionRsvps: seats(2) });

		const report = await run(ledgerWith(), true, [capped(5)]);

		expect(report.rsvpsWaitlisted).toBe(0);
		expect(rsvpWrites(spy)).toEqual([{ method: 'POST', attending: 'yes' }]);
	});

	it('never waitlists on an uncapped shift, however full it is', async () => {
		const spy = mockApis({
			attendances: [attendance()],
			userFound: false,
			sessionRsvps: seats(40),
		});

		const report = await run(ledgerWith(), true, [capped(null)]);

		expect(report.rsvpsWaitlisted).toBe(0);
		expect(rsvpWrites(spy)).toEqual([{ method: 'POST', attending: 'yes' }]);
	});

	it('fills the last seat, then waitlists the next arrival in the same run', async () => {
		// Two people, one seat. The count has to move as the run writes, or both
		// get seated against the same stale number.
		const spy = mockApis({
			attendances: [
				attendance({
					id: 1,
					person: {
						...attendance().person,
						email_addresses: [{ primary: true, address: 'one@example.com' }],
					},
				}),
				attendance({
					id: 2,
					person: {
						...attendance().person,
						email_addresses: [{ primary: true, address: 'two@example.com' }],
					},
				}),
			],
			userFound: false,
			sessionRsvps: seats(1),
		});

		const report = await run(ledgerWith(), true, [capped(2)]);

		expect(report.rsvpsCreated).toBe(2);
		expect(report.rsvpsWaitlisted).toBe(1);
		expect(rsvpWrites(spy).map((w) => w.attending)).toEqual(['yes', 'waitlisted']);
	});

	it('does not demote someone who already holds a seat', async () => {
		// Their RSVP predates the cap being reached. Taking it away because a later
		// run happened to read them second is not the sync's call to make.
		const spy = mockApis({
			attendances: [attendance()],
			userFound: true,
			sessionRsvps: [{ id: 500, user_id: 999, is_attending: 'yes' }],
		});

		const report = await run(ledgerWith(), true, [capped(1)]);

		expect(report.rsvpsUpdated).toBe(0);
		expect(rsvpWrites(spy)).toEqual([]);
	});

	it('leaves a waitlisted RSVP alone rather than promoting it every run', async () => {
		// Mobilize still says `yes` — `waitlisted` IS this sync's answer to that on
		// a full shift, so re-promoting would churn the queue nightly.
		const spy = mockApis({
			attendances: [attendance()],
			userFound: true,
			sessionRsvps: [{ id: 500, user_id: 999, is_attending: 'waitlisted' }],
		});

		const report = await run(ledgerWith(), true, [capped(1)]);

		expect(report.rsvpsUpdated).toBe(0);
		expect(rsvpWrites(spy)).toEqual([]);
	});

	it('still records a cancellation for someone on the waitlist', async () => {
		const spy = mockApis({
			attendances: [attendance({ status: 'CANCELLED' })],
			userFound: true,
			sessionRsvps: [{ id: 500, user_id: 999, is_attending: 'waitlisted' }],
		});

		const report = await run(ledgerWith(), true, [capped(1)]);

		expect(report.rsvpsUpdated).toBe(1);
		expect(rsvpWrites(spy)).toEqual([{ method: 'PUT', attending: 'no' }]);
	});

	it('reports a shift that was already over capacity before the run', async () => {
		mockApis({ attendances: [attendance()], userFound: true, sessionRsvps: seats(5) });

		const report = await run(ledgerWith(), true, [capped(2)]);

		expect(report.overCapacity).toEqual([
			{ solidaritySessionId: LINK.solidaritySessionId, capacity: 2, attending: 5 },
		]);
	});

	it('says nothing about a shift sitting inside its cap', async () => {
		mockApis({ attendances: [attendance()], userFound: true, sessionRsvps: seats(1) });

		const report = await run(ledgerWith(), true, [capped(4)]);

		expect(report.overCapacity).toEqual([]);
	});
});

describe('runAttendeeSync seat order', () => {
	/** A signup with its own identity, signup time and Mobilize event. */
	function signup(options: {
		id: number;
		created: number;
		email: string;
		mobilizeEventId?: number;
		timeslotId?: number;
	}) {
		return attendance({
			id: options.id,
			created_date: options.created,
			event: { id: options.mobilizeEventId ?? LINK.mobilizeEventId },
			timeslot: { id: options.timeslotId ?? LINK.mobilizeTimeslotId },
			person: {
				...attendance().person,
				email_addresses: [{ primary: true, address: options.email }],
			},
		});
	}

	/** Which email got a seat and which was queued, by write order. */
	const seatedThenWaitlisted = (spy: ReturnType<typeof mockApis>) =>
		spy.mock.calls
			.filter(([url, init]) => String(url).includes('/v1/event_rsvps') && init?.method === 'POST')
			.map(
				([, init]) =>
					(JSON.parse(String(init?.body ?? '{}')) as { is_attending?: string }).is_attending,
			);

	it('gives the last seat to the earliest signup, whatever order Mobilize lists them in', async () => {
		// Returned newest-first, the reverse of what the live API does today. The
		// earlier signup must still take the seat.
		const spy = mockApis({
			attendances: [
				signup({ id: 2, created: 1_787_000_500, email: 'late@example.com' }),
				signup({ id: 1, created: 1_787_000_100, email: 'early@example.com' }),
			],
			userFound: false,
			sessionRsvps: [],
		});

		const report = await run(ledgerWith(), true, [capped(1)]);

		expect(report.rsvpsWaitlisted).toBe(1);
		expect(seatedThenWaitlisted(spy)).toEqual(['yes', 'waitlisted']);
		// The seated one is the earlier signup, not merely the first row returned.
		const created = spy.mock.calls.filter(
			([url, init]) => String(url).includes('/v1/users') && init?.method === 'POST',
		);
		expect(String(created[0]?.[1]?.body)).toContain('early@example.com');
	});

	it('orders across Mobilize events, not one event at a time', async () => {
		// Twelve Solidarity sessions are mirrored by timeslots on two Mobilize
		// events. Reading one event at a time seated all of the first event's
		// signups before any of the second's, whoever actually signed up first.
		const other = { mobilizeEventId: 812346, timeslotId: 6157029 };
		const spy = mockApis({
			attendances: [
				signup({ id: 9, created: 1_787_000_900, email: 'first-event-late@example.com' }),
				signup({
					id: 3,
					created: 1_787_000_200,
					email: 'second-event-early@example.com',
					...other,
				}),
			],
			userFound: false,
			sessionRsvps: [],
		});

		const links: TimeslotLink[] = [
			capped(1),
			{
				...capped(1),
				mobilizeTimeslotId: other.timeslotId,
				mobilizeEventId: other.mobilizeEventId,
			},
		];
		const report = await run(ledgerWith(), true, links);

		expect(report.rsvpsWaitlisted).toBe(1);
		const created = spy.mock.calls.filter(
			([url, init]) => String(url).includes('/v1/users') && init?.method === 'POST',
		);
		expect(String(created[0]?.[1]?.body)).toContain('second-event-early@example.com');
	});

	it('puts a signup with no created_date last rather than at the front of the queue', async () => {
		const spy = mockApis({
			attendances: [
				signup({ id: 7, created: 0, email: 'unknown-time@example.com' }),
				signup({ id: 8, created: 1_787_000_400, email: 'known-time@example.com' }),
			],
			userFound: false,
			sessionRsvps: [],
		});

		await run(ledgerWith(), true, [capped(1)]);

		const created = spy.mock.calls.filter(
			([url, init]) => String(url).includes('/v1/users') && init?.method === 'POST',
		);
		expect(String(created[0]?.[1]?.body)).toContain('known-time@example.com');
	});

	it('falls back to the attendance id when two signups share a timestamp', async () => {
		const spy = mockApis({
			attendances: [
				signup({ id: 20, created: 1_787_000_300, email: 'higher-id@example.com' }),
				signup({ id: 4, created: 1_787_000_300, email: 'lower-id@example.com' }),
			],
			userFound: false,
			sessionRsvps: [],
		});

		await run(ledgerWith(), true, [capped(1)]);

		const created = spy.mock.calls.filter(
			([url, init]) => String(url).includes('/v1/users') && init?.method === 'POST',
		);
		expect(String(created[0]?.[1]?.body)).toContain('lower-id@example.com');
	});
});
