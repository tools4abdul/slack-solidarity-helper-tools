import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobilizeApiConfig, MobilizeEvent } from './mobilize.js';
import {
	describeChanges,
	reconcileTimeslots,
	runSync,
	type Ledger,
	type LedgerRecord,
	type PushedCap,
} from './sync.js';
import type { EventContact } from './payload.js';
import type { PlannedEvent } from './transform.js';

const HOUR = 3600_000;
const START = Date.parse('2026-08-01T22:00:00Z'); // 18:00 America/New_York
// Pinned so the past/upcoming split in reconcileTimeslots doesn't depend on the
// wall clock the suite happens to run at.
const NOW = START - 7 * 24 * HOUR;

function plan(overrides: Partial<PlannedEvent> = {}): PlannedEvent {
	const starts = [START];
	return {
		key: 'solidarity:1:venue',
		solidarityEventId: 1,
		solidaritySessionIds: [10],
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
		coordinates: { lat: 42.3806, lng: -83.0658 },
		timeslots: starts.map((s) => ({
			startDate: Math.floor(s / 1000),
			endDate: Math.floor((s + 2 * HOUR) / 1000),
			maxAttendees: null,
		})),
		startInstants: starts,
		endInstants: starts.map((s) => s + 2 * HOUR),
		sourceUrl: null,
		sourceImageUrl: null,
		...overrides,
	};
}

function live(
	slots: { id: number; start: number; end?: number }[],
	overrides: Partial<MobilizeEvent> = {},
): MobilizeEvent {
	return {
		id: 900,
		title: 'Detroit Canvass',
		event_type: 'COMMUNITY_CANVASS',
		description: 'Knock doors',
		timeslots: slots.map((s) => ({
			id: s.id,
			start_date: Math.floor(s.start / 1000),
			end_date: Math.floor((s.end ?? s.start + 2 * HOUR) / 1000),
		})),
		location: { locality: 'Detroit', postal_code: '48202' },
		...overrides,
	};
}

describe('reconcileTimeslots', () => {
	it('reuses the existing id when the shift is unchanged', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots).toEqual([
			{
				id: 5001,
				startDate: Math.floor(START / 1000),
				endDate: Math.floor((START + 2 * HOUR) / 1000),
				maxAttendees: null,
			},
		]);
		expect(result.changed).toBe(false);
		expect(result.orphanCount).toBe(0);
	});

	it('sends a genuinely new session without an id so Mobilize creates it', () => {
		const twoSlots = plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
				{
					startDate: Math.floor((START + 24 * HOUR) / 1000),
					endDate: Math.floor((START + 26 * HOUR) / 1000),
					maxAttendees: null,
				},
			],
			startInstants: [START, START + 24 * HOUR],
			endInstants: [START + 2 * HOUR, START + 26 * HOUR],
		});
		const result = reconcileTimeslots(twoSlots, live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.timeslots[1].id).toBeUndefined();
		expect(result.changed).toBe(true);
	});

	it('KEEPS an upcoming shift that has no counterpart, rather than deleting its signups', () => {
		// A session cancelled in Solidarity. Omitting it from the PUT would
		// destroy the shift and its RSVPs.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 4000, start: START + 72 * HOUR },
			]),
			NOW,
		);
		expect(result.timeslots.map((s) => s.id)).toEqual([5001, 4000]);
		expect(result.orphanCount).toBe(1);
	});

	it('drops a PAST orphan instead of re-sending it', () => {
		// The v1 endpoint does not modify past timeslots, so sending them is at
		// best noise. Omitting them is safe precisely because it cannot delete
		// them either.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 4000, start: NOW - 72 * HOUR },
			]),
			NOW,
		);
		expect(result.timeslots.map((s) => s.id)).toEqual([5001]);
		expect(result.orphanCount).toBe(0);
	});

	it('drops an orphan that has STARTED but not ended', () => {
		// A long session — a week-long exhibit — is under way for days. Mobilize
		// calls that shift past and answers 400 "Cannot modify past timeslot" for
		// the whole PUT, so the boundary is the start, not the end.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 4000, start: NOW - HOUR, end: NOW + 72 * HOUR },
			]),
			NOW,
		);
		expect(result.timeslots.map((s) => s.id)).toEqual([5001]);
		expect(result.orphanCount).toBe(0);
	});

	it('matches within a minute of tolerance', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START + 30_000 }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.changed).toBe(false);
	});

	it('treats a moved start time as a new shift, keeping the old one', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START + 3 * HOUR }]), NOW);
		expect(result.timeslots[0].id).toBeUndefined();
		expect(result.timeslots[1].id).toBe(5001);
		expect(result.changed).toBe(true);
	});

	it('detects an end-time change even when the start still matches', () => {
		const result = reconcileTimeslots(
			plan(),
			live([{ id: 5001, start: START, end: START + 5 * HOUR }]),
			NOW,
		);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.changed).toBe(true);
	});

	it('does not reuse one live shift for two planned shifts', () => {
		const duplicate = plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
			],
			startInstants: [START, START],
			endInstants: [START + 2 * HOUR, START + 2 * HOUR],
		});
		const result = reconcileTimeslots(duplicate, live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.timeslots[1].id).toBeUndefined();
	});
});

describe('reconcileTimeslots capacity', () => {
	const capped = (cap: number | null) =>
		plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: cap,
				},
			],
		});

	it('flags a cap that differs from the one last pushed', () => {
		const result = reconcileTimeslots(
			capped(12),
			live([{ id: 5001, start: START }]),
			NOW,
			new Map([[5001, 20]]),
		);
		expect(result.capacityChanged).toBe(true);
		expect(result.timeslots[0]!.maxAttendees).toBe(12);
	});

	it('leaves a cap alone when it matches what was last pushed', () => {
		const result = reconcileTimeslots(
			capped(12),
			live([{ id: 5001, start: START }]),
			NOW,
			new Map([[5001, 12]]),
		);
		expect(result.capacityChanged).toBe(false);
	});

	it('treats zero as a real cap, not as "no record"', () => {
		// A full shift is pushed as 0. Confusing it with null would re-open it.
		const result = reconcileTimeslots(
			capped(0),
			live([{ id: 5001, start: START }]),
			NOW,
			new Map([[5001, 0]]),
		);
		expect(result.capacityChanged).toBe(false);
	});

	it('establishes a cap on a shift that has no record of one', () => {
		const result = reconcileTimeslots(capped(12), live([{ id: 5001, start: START }]), NOW);
		expect(result.capacityChanged).toBe(true);
	});

	it('stays quiet when there is no record and no cap is wanted', () => {
		const result = reconcileTimeslots(capped(null), live([{ id: 5001, start: START }]), NOW);
		expect(result.capacityChanged).toBe(false);
	});

	it('re-sends an orphan with the cap it was last given, not null', () => {
		// Every PUT carries every upcoming slot, so sending null here silently
		// un-capped orphaned shifts on every unrelated edit.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 5002, start: START + 3 * HOUR },
			]),
			NOW,
			new Map([[5002, 8]]),
		);
		const orphan = result.timeslots.find((slot) => slot.id === 5002);
		expect(result.orphanCount).toBe(1);
		expect(orphan!.maxAttendees).toBe(8);
	});
});

describe('describeChanges', () => {
	it('reports nothing when everything matches', () => {
		expect(describeChanges(plan(), live([{ id: 1, start: START }]), false, false)).toEqual([]);
	});

	it('detects title and description edits', () => {
		const changed = live([{ id: 1, start: START }], {
			title: 'Old title',
			description: 'Old body',
		});
		expect(describeChanges(plan(), changed, false, false)).toEqual(['title', 'description']);
	});

	it('flags a missing image only when the source has one', () => {
		const noImage = live([{ id: 1, start: START }], { featured_image_url: null });
		expect(describeChanges(plan(), noImage, true, false)).toEqual(['image']);
		expect(describeChanges(plan(), noImage, false, false)).toEqual([]);
	});

	it('does not re-upload when Mobilize already has an image', () => {
		const withImage = live([{ id: 1, start: START }], {
			featured_image_url: 'https://mobilizeamerica.imgix.net/x.png',
		});
		expect(describeChanges(plan(), withImage, true, false)).toEqual([]);
	});

	it('ignores whitespace-only differences', () => {
		const padded = live([{ id: 1, start: START }], {
			title: '  Detroit Canvass  ',
			description: 'Knock doors\n',
		});
		expect(describeChanges(plan(), padded, false, false)).toEqual([]);
	});

	it('detects a city change', () => {
		const moved = live([{ id: 1, start: START }], {
			location: { locality: 'Ypsilanti', postal_code: '48202' },
		});
		expect(describeChanges(plan(), moved, false, false)).toEqual(['location']);
	});

	it('backfills a postal code onto an event migrated without one', () => {
		// Everything created before the v1 switch went in with no zip — the old
		// dashboard API accepted that, and v1 will not.
		const noZip = live([{ id: 1, start: START }], { location: { locality: 'Detroit' } });
		expect(describeChanges(plan(), noZip, false, false)).toEqual(['postal code']);
	});

	it('does not ask for an update when we have no zip to offer either', () => {
		const noZip = live([{ id: 1, start: START }], { location: { locality: 'Detroit' } });
		expect(describeChanges(plan({ zipcode: '' }), noZip, false, false)).toEqual([]);
	});
});

describe('describeChanges capacity', () => {
	it('names capacity apart from timeslots', () => {
		const changes = describeChanges(plan(), live([{ id: 5001, start: START }]), false, false, true);
		expect(changes).toEqual(['capacity']);
	});
});

describe('runSync dry run', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/** Records every ledger write so the test can assert there were none. */
	function spyLedger(known: { key: string; mobilizeEventId: number; title: string }[]) {
		const writes: string[] = [];
		const ledger: Ledger = {
			async all() {
				return known;
			},
			async record() {
				writes.push('record');
			},
			async imageFor() {
				return null;
			},
			async recordImage() {
				writes.push('recordImage');
			},
			async zipFor() {
				return null;
			},
			async recordZip() {
				writes.push('recordZip');
			},
			async recordTimeslots() {
				writes.push('recordTimeslots');
			},
		};
		return { ledger, writes };
	}

	it('writes nothing to the ledger, not even timeslot pairings', async () => {
		// Regression: recordTimeslots sat outside the apply branch, so a dry run
		// persisted pairings — on the server, straight into production Turso.
		const planned = plan();
		// The client reads the body with text() and parses it itself, so the stub
		// has to return a real JSON string rather than a json() shortcut.
		const body = JSON.stringify({
			data: [
				{
					id: 900,
					title: planned.title,
					event_type: 'COMMUNITY_CANVASS',
					description: 'different, so an update is warranted',
					timeslots: [{ id: 5001, start_date: Math.floor(START / 1000), end_date: 0 }],
					location: { locality: 'Detroit' },
				},
			],
			next: null,
		});
		vi.stubGlobal('fetch', async () => ({
			ok: true,
			status: 200,
			text: async () => body,
			headers: new Headers(),
		}));

		const { ledger, writes } = spyLedger([
			{ key: planned.key, mobilizeEventId: 900, title: planned.title },
		]);

		const report = await runSync(
			[planned],
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 100,
				apply: false,
				pauseMs: 0,
			},
			ledger,
			() => null,
		);

		expect(report.updated).toBe(1);
		expect(writes).toEqual([]);
	});
});

describe('runSync postal codes', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/**
	 * Both services on one stub, routed by URL: the Mobilize client reads its
	 * responses with text(), the Census geocoder with json().
	 */
	function stubApis(zip: string | null) {
		const calls: { url: string; method: string; body: unknown }[] = [];
		vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({
				url,
				method: init.method ?? 'GET',
				body: init.body ? JSON.parse(String(init.body)) : null,
			});
			if (url.includes('census.gov')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						result: {
							geographies: {
								'Zip Code Tabulation Areas': zip ? [{ ZCTA5: zip, BASENAME: zip }] : [],
							},
						},
					}),
				};
			}
			const body =
				init.method === 'POST'
					? JSON.stringify({
							data: { event: { id: 901, title: 'Detroit Canvass', timeslots: [] } },
						})
					: JSON.stringify({ data: [], next: null });
			return { ok: true, status: 200, text: async () => body, headers: new Headers() };
		});
		return calls;
	}

	function ledgerWith(zips: Record<string, string> = {}) {
		const recorded: Record<string, string> = {};
		const ledger: Ledger = {
			async all() {
				return [];
			},
			async record() {},
			async imageFor() {
				return null;
			},
			async recordImage() {},
			async zipFor(point) {
				return zips[point] ?? null;
			},
			async recordZip(point, postalCode) {
				recorded[point] = postalCode;
			},
		};
		return { ledger, recorded };
	}

	const run = (planned: PlannedEvent, ledger: Ledger, apply = true) =>
		runSync(
			[planned],
			{ api: API, contact: CONTACT, maxCreatesPerRun: 100, apply, pauseMs: 0 },
			ledger,
			() => null,
		);

	it('geocodes a missing postal code and sends it, because Mobilize requires one', async () => {
		const calls = stubApis('48507');
		const { ledger, recorded } = ledgerWith();

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
		);

		expect(report.created).toBe(1);
		expect(report.failed).toBe(0);
		const create = calls.find((c) => c.method === 'POST')!;
		expect((create.body as { location: { postal_code: string } }).location.postal_code).toBe(
			'48507',
		);
		// Cached by point, so the same venue is not looked up again tomorrow.
		expect(recorded).toEqual({ '42.98372,-83.67487': '48507' });
	});

	it('reuses a cached zip instead of calling the geocoder', async () => {
		const calls = stubApis(null);
		const { ledger } = ledgerWith({ '42.98372,-83.67487': '48507' });

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
		);

		expect(report.created).toBe(1);
		expect(calls.some((c) => c.url.includes('census.gov'))).toBe(false);
	});

	it('reports the event instead of sending a create Mobilize will reject', async () => {
		// A blank postal_code is a 400 every night; saying so once is more useful.
		const calls = stubApis(null);
		const { ledger } = ledgerWith();

		const report = await run(plan({ zipcode: '', coordinates: null }), ledger);

		expect(report.created).toBe(0);
		expect(report.failed).toBe(1);
		expect(report.errors[0]).toMatch(/no postal code/);
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('does not cache a lookup made during a dry run', async () => {
		stubApis('48507');
		const { ledger, recorded } = ledgerWith();

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
			false,
		);

		expect(report.created).toBe(1);
		expect(recorded).toEqual({});
	});
});

describe('runSync image cache', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};
	const LEGACY =
		'https://mobilize-uploads-prod.s3.us-east-2.amazonaws.com/uploads/event/x_20260727020913704660.png';
	const FRESH = 'https://mobilizeamerica.imgix.net/uploads/event/x_20260729021012538951.png';

	/** Mobilize plus the Solidarity image download, routed by URL. */
	function stubApis() {
		const calls: { url: string; method: string; body: unknown }[] = [];
		vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			const method = init.method ?? 'GET';
			calls.push({ url, method, body: null });
			if (url.startsWith('https://solidarity.example')) {
				return {
					ok: true,
					status: 200,
					headers: new Headers({ 'content-type': 'image/png' }),
					arrayBuffer: async () => new ArrayBuffer(8),
				};
			}
			const body = url.endsWith('/images')
				? JSON.stringify({ data: { url: FRESH } })
				: method === 'POST'
					? JSON.stringify({ data: { event: { id: 901, title: 'x', timeslots: [] } } })
					: JSON.stringify({ data: [], next: null });
			return { ok: true, status: 200, text: async () => body, headers: new Headers() };
		});
		return calls;
	}

	function imageLedger(cachedUrl: string | null) {
		const recorded: string[] = [];
		const ledger: Ledger = {
			async all() {
				return [];
			},
			async record() {},
			async imageFor() {
				return cachedUrl;
			},
			async recordImage(_source, mobilizeUrl) {
				recorded.push(mobilizeUrl);
			},
			async zipFor() {
				return null;
			},
			async recordZip() {},
		};
		return { ledger, recorded };
	}

	const withImage = () => plan({ sourceImageUrl: 'https://solidarity.example/fist.png' });

	const run = (ledger: Ledger) =>
		runSync(
			[withImage()],
			{ api: API, contact: CONTACT, maxCreatesPerRun: 100, apply: true, pauseMs: 0 },
			ledger,
			() => null,
		);

	it('re-uploads when the cached URL is one v1 rejects, and records the new one', async () => {
		// The dashboard-era rows: reusing one fails the create with
		// {"featured_image_url":["Invalid featured image url"]}.
		const calls = stubApis();
		const { ledger, recorded } = imageLedger(LEGACY);

		const report = await run(ledger);

		expect(report.created).toBe(1);
		expect(calls.some((c) => c.url.endsWith('/images') && c.method === 'POST')).toBe(true);
		expect(recorded).toEqual([FRESH]);
	});

	it('still reuses a good cached URL without uploading again', async () => {
		const calls = stubApis();
		const { ledger, recorded } = imageLedger(FRESH);

		const report = await run(ledger);

		expect(report.created).toBe(1);
		expect(calls.some((c) => c.url.endsWith('/images'))).toBe(false);
		expect(recorded).toEqual([]);
	});
});

describe('runSync write budget', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/** Counts POSTs and PUTs so a test can see exactly where a run stopped. */
	function stubMobilize(liveEvents: unknown[] = []) {
		const writes: string[] = [];
		vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
			const method = init.method ?? 'GET';
			if (method !== 'GET') writes.push(`${method} ${String(input).replace(/\?.*/, '')}`);
			const body =
				method === 'POST'
					? JSON.stringify({ data: { event: { id: 901, title: 'x', timeslots: [] } } })
					: JSON.stringify({ data: liveEvents, next: null });
			return { ok: true, status: 200, text: async () => body, headers: new Headers() };
		});
		return writes;
	}

	function countingLedger(known: LedgerRecord[] = []) {
		return {
			async all() {
				return known;
			},
			async record() {},
			async imageFor() {
				return null;
			},
			async recordImage() {},
			async zipFor() {
				return null;
			},
			async recordZip() {},
		} satisfies Ledger;
	}

	const threePlans = [
		plan({ key: 'a', title: 'A' }),
		plan({ key: 'b', title: 'B' }),
		plan({ key: 'c', title: 'C' }),
	];

	it('stops starting creates once the deadline passes and says what is left', async () => {
		const writes = stubMobilize();
		const report = await runSync(
			threePlans,
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 100,
				apply: true,
				// Each write costs a 40ms pause here, so the budget runs out mid-way.
				pauseMs: 40,
				writeDeadline: Date.now() + 50,
			},
			countingLedger(),
			() => null,
		);

		expect(report.incomplete).toBe(true);
		expect(report.created).toBeLessThan(3);
		expect(report.created + report.pending).toBe(3);
		// The point of the budget: fewer writes attempted than planned.
		expect(writes.length).toBe(report.created);
	});

	it('reports complete when the whole plan fits', async () => {
		stubMobilize();
		const report = await runSync(
			threePlans,
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 100,
				apply: true,
				pauseMs: 0,
				writeDeadline: Date.now() + 60_000,
			},
			countingLedger(),
			() => null,
		);

		expect(report.created).toBe(3);
		expect(report.incomplete).toBe(false);
		expect(report.pending).toBe(0);
	});

	it('runs to completion with no deadline at all, which is what the CLI wants', async () => {
		stubMobilize();
		const report = await runSync(
			threePlans,
			{ api: API, contact: CONTACT, maxCreatesPerRun: 100, apply: true, pauseMs: 0 },
			countingLedger(),
			() => null,
		);

		expect(report.created).toBe(3);
		expect(report.incomplete).toBe(false);
	});

	it('counts unreached updates as pending, not as unchanged', async () => {
		// Miscounting here would be worse than the interruption: the workflow would
		// stop looping while events still needed pushing.
		const live = threePlans.map((p, index) => ({
			id: 900 + index,
			title: 'stale title, so an update is warranted',
			event_type: 'COMMUNITY_CANVASS',
			description: p.description,
			timeslots: [
				{
					id: 5000 + index,
					start_date: p.timeslots[0].startDate,
					end_date: p.timeslots[0].endDate,
				},
			],
			location: { locality: p.city, postal_code: p.zipcode },
		}));
		stubMobilize(live);
		const known = threePlans.map((p, index) => ({
			key: p.key,
			mobilizeEventId: 900 + index,
			title: p.title,
		}));

		const report = await runSync(
			threePlans,
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 100,
				apply: true,
				pauseMs: 40,
				writeDeadline: Date.now() + 50,
			},
			countingLedger(known),
			() => null,
		);

		expect(report.incomplete).toBe(true);
		expect(report.updated).toBeLessThan(3);
		expect(report.updated + report.pending).toBe(3);
		expect(report.unchanged).toBe(0);
	});
});

describe('runSync capacity push', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/** A capped shift already mirrored to Mobilize, with a cap recorded as pushed. */
	function setup(options: { pushedCap: number | null; seatsTaken: number }) {
		const planned = plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: 20,
				},
			],
		});
		const body = JSON.stringify({
			data: [
				{
					id: 900,
					title: planned.title,
					event_type: 'COMMUNITY_CANVASS',
					description: planned.description,
					timeslots: [
						{
							id: 5001,
							start_date: Math.floor(START / 1000),
							end_date: Math.floor((START + 2 * HOUR) / 1000),
						},
					],
					location: { locality: 'Detroit', postal_code: '48202' },
				},
			],
			next: null,
		});
		const puts: Record<string, unknown>[] = [];
		vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
			if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
			return { ok: true, status: 200, text: async () => body, headers: new Headers() };
		});

		const recordedCaps: PushedCap[] = [];
		const ledger: Ledger = {
			async all() {
				return [{ key: planned.key, mobilizeEventId: 900, title: planned.title }];
			},
			async record() {},
			async imageFor() {
				return null;
			},
			async recordImage() {},
			async zipFor() {
				return null;
			},
			async recordZip() {},
			async recordTimeslots() {},
			async pushedCaps() {
				return new Map([[5001, options.pushedCap]]);
			},
			async recordPushedCaps(entries) {
				recordedCaps.push(...entries);
			},
		};

		const asked: number[][] = [];
		const seatsTaken = async (ids: number[]) => {
			asked.push(ids);
			return new Map(ids.map((id) => [id, options.seatsTaken]));
		};

		return { planned, ledger, puts, recordedCaps, asked, seatsTaken };
	}

	const run = (fixture: ReturnType<typeof setup>) =>
		runSync(
			[fixture.planned],
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 10,
				apply: true,
				pauseMs: 0,
				seatsTaken: fixture.seatsTaken,
			},
			fixture.ledger,
			() => null,
		);

	it('hands Mobilize the cap minus the seats Solidarity already spent', async () => {
		const fixture = setup({ pushedCap: 20, seatsTaken: 7 });

		const report = await run(fixture);

		expect(report.updated).toBe(1);
		expect(report.updatedTitles[0]).toContain('capacity');
		expect(fixture.puts[0]).toMatchObject({ timeslots: [{ id: 5001, max_attendees: 13 }] });
	});

	it('records the cap only once the PUT has landed', async () => {
		const fixture = setup({ pushedCap: 20, seatsTaken: 7 });

		await run(fixture);

		expect(fixture.recordedCaps).toEqual([{ mobilizeTimeslotId: 5001, maxAttendees: 13 }]);
	});

	it('leaves the event alone when the cap has not moved', async () => {
		// Nothing else differs, so without this the seat count would trigger a PUT
		// on every capped event on every pass.
		const fixture = setup({ pushedCap: 13, seatsTaken: 7 });

		const report = await run(fixture);

		expect(report.unchanged).toBe(1);
		expect(fixture.puts).toEqual([]);
	});

	it('asks only about sessions whose shift carries a cap', async () => {
		const fixture = setup({ pushedCap: 20, seatsTaken: 7 });

		await run(fixture);

		expect(fixture.asked).toEqual([[10]]);
	});

	it('pushes the cap unadjusted when the seat count fails', async () => {
		const fixture = setup({ pushedCap: null, seatsTaken: 0 });
		fixture.seatsTaken = async () => {
			throw new Error('Solidarity rsvp list returned 500');
		};

		const report = await run(fixture);

		expect(fixture.puts[0]).toMatchObject({ timeslots: [{ id: 5001, max_attendees: 20 }] });
		expect(report.errors[0]).toContain('seat count');
	});
});
