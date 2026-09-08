import { describe, expect, it } from 'vitest';

import { findDuplicate, normalizeTitle, titleSimilarity } from './dedupe.js';
import type { MobilizeEvent } from './mobilize.js';
import {
	classifyEventType,
	normalizeLocation,
	planMigration,
	titlesForLocations,
} from './transform.js';
import type { SolidarityEvent } from './solidarity.js';
import { EVENT_TYPE } from './payload.js';

const NOW = Date.parse('2026-07-26T00:00:00Z');

function session(overrides: Partial<SolidarityEvent['event_sessions'][number]> = {}) {
	return {
		id: 1,
		title: 'Session',
		start_time: '2026-07-30T20:00:00.000-04:00',
		end_time: '2026-07-30T22:00:00.000-04:00',
		location_name: 'Venue',
		location_address: '100 N Main St, Ann Arbor, MI 48104, USA',
		location_data: {
			full_address: '100 N Main St, Ann Arbor, MI 48104, USA',
			address_line_1: '100 North Main Street',
			address_city: 'Ann Arbor',
			address_state: 'MI',
			address_postal_code: '48104',
			address_country: 'US',
			coordinates: '{"lat":42.2814215,"lng":-83.7485052}',
		},
		max_capacity: null,
		event_type: 'in_person',
		...overrides,
	};
}

function event(overrides: Partial<SolidarityEvent> = {}): SolidarityEvent {
	return {
		id: 100,
		title: 'Ann Arbor Canvass',
		event_type: 'in_person',
		scope_id: 376,
		scope_type: 'Organization',
		description: 'Come knock doors',
		// Both must be present in the base literal, not just in the interface:
		// a property supplied only by the Partial spread is typed `| undefined`,
		// which the SolidarityEvent return type rejects.
		event_page_id: null,
		event_page_url: null,
		image_url: null,
		hide_address_until_rsvp: false,
		is_co_hosted_mirror: false,
		primary_event_id: 100,
		event_sessions: [session()],
		...overrides,
	};
}

describe('timeslot instants', () => {
	it('resolves the same instant identically regardless of the offset Solidarity used', () => {
		// Solidarity returned this one session both ways across two calls. Unix
		// timestamps make the inconsistent offset a non-issue: only the instant
		// matters, and all three of these are the same instant.
		const at = (start: string) =>
			planMigration(
				[event({ event_sessions: [session({ start_time: start, end_time: start })] })],
				NOW,
			).planned[0].timeslots[0].startDate;
		expect(at('2026-07-30T20:00:00.000-04:00')).toBe(at('2026-07-30T18:00:00.000-06:00'));
		expect(at('2026-07-30T20:00:00.000-04:00')).toBe(at('2026-07-31T00:00:00.000Z'));
	});
});

describe('classifyEventType', () => {
	it('treats canvasses and door knocking as COMMUNITY_CANVASS', () => {
		expect(classifyEventType('Saginaw Canvass for Abdul', '')).toBe(EVENT_TYPE.COMMUNITY_CANVASS);
		expect(classifyEventType('Knock Out the Vote Tour', '')).toBe(EVENT_TYPE.COMMUNITY_CANVASS);
	});

	it('leaves everything else as COMMUNITY', () => {
		expect(classifyEventType('Pontiac Debate Watch Party', '')).toBe(EVENT_TYPE.COMMUNITY);
		expect(classifyEventType('Abdul Rocks: Detroit Concert', '')).toBe(EVENT_TYPE.COMMUNITY);
	});
});

describe('normalizeLocation', () => {
	it('reduces the spellings of one Pontiac office to a single string', () => {
		// All three are the campaign's Pontiac office, as Solidarity stored it on
		// three different days. Compared literally they published three events.
		const forms = [
			'1 South Saginaw Street, Pontiac, MI 48342, USA',
			'1 S Saginaw St, Pontiac, MI 48342, USA',
			'1 South Saginaw Street, Pontiac, MI, USA',
		].map(normalizeLocation);
		expect(new Set(forms).size).toBe(1);
	});

	it('keeps different venues apart', () => {
		const different = [
			// A five-digit house number must survive: only a TRAILING one is a zip.
			'29200 Hoover Road, Warren, MI 48093, USA',
			'29500 Hoover Rd, Warren, MI 48093, USA',
			// Same number and street, opposite directional.
			'1 N Saginaw St, Pontiac, MI, USA',
			'1 S Saginaw St, Pontiac, MI, USA',
			// Same number and street name, different type.
			'100 Main St, Ann Arbor, MI, USA',
			'100 Main Ave, Ann Arbor, MI, USA',
		].map(normalizeLocation);
		expect(new Set(different).size).toBe(6);
	});
});

describe('titlesForLocations', () => {
	const at = (overrides: Partial<Parameters<typeof titlesForLocations>[1][number]>) => ({
		key: 'k',
		sessionTitles: [],
		city: 'Pontiac',
		locationName: 'The Office',
		addressLine1: '1 South Saginaw Street',
		...overrides,
	});

	it('leaves the title of a single-location event alone', () => {
		expect(titlesForLocations('Ann Arbor Canvass', [at({ key: 'a' })])).toEqual([
			'Ann Arbor Canvass',
		]);
	});

	it('falls through to the venue when every group is in one city', () => {
		const titles = titlesForLocations('Saginaw Canvass', [
			at({ key: 'a', city: 'Saginaw', locationName: 'Oracle Brewery' }),
			at({ key: 'b', city: 'Saginaw', locationName: 'SVRC Marketplace' }),
		]);
		expect(titles).toEqual([
			'Saginaw Canvass — Oracle Brewery',
			'Saginaw Canvass — SVRC Marketplace',
		]);
	});

	it('uses the shift label only when the place cannot tell them apart', () => {
		const titles = titlesForLocations('Office Canvass Launch', [
			at({ key: 'a', sessionTitles: ['Fridays'] }),
			at({ key: 'b', sessionTitles: ['Saturdays'] }),
		]);
		expect(titles).toEqual([
			'Office Canvass Launch — Fridays',
			'Office Canvass Launch — Saturdays',
		]);
	});

	it('numbers by location key when nothing distinguishes the groups', () => {
		// Two rows for one venue, addresses spelled differently. Identical titles
		// would read as duplicates in the feed — findDuplicate treats them as such.
		const titles = titlesForLocations('Office Canvass Launch', [
			at({ key: 'b', sessionTitles: ['Launch'] }),
			at({ key: 'a', sessionTitles: ['Launch'] }),
		]);
		expect(titles).toEqual(['Office Canvass Launch (2)', 'Office Canvass Launch (1)']);
	});
});

describe('planMigration', () => {
	it('splits one multi-city event into one Mobilize event per location', () => {
		const flint = session({
			id: 1,
			title: 'Operation GOTV: Flint',
			location_address: '4400 S Saginaw St, Flint, MI 48507, USA',
			location_data: {
				full_address: '4400 S Saginaw St, Flint, MI 48507, USA',
				address_line_1: '4400 South Saginaw Street',
				address_city: 'Flint',
				address_state: 'MI',
				address_postal_code: '48507',
				address_country: 'US',
				coordinates: '{"lat":42.98,"lng":-83.67}',
			},
		});
		const detroit = session({
			id: 2,
			title: 'Operation GOTV: Detroit',
			location_address: '2857 E Grand Blvd, Detroit, MI 48202, USA',
			location_data: {
				full_address: '2857 E Grand Blvd, Detroit, MI 48202, USA',
				address_line_1: '2857 East Grand Boulevard',
				address_city: 'Detroit',
				address_state: 'MI',
				address_postal_code: '48202',
				address_country: 'US',
				coordinates: '{"lat":42.37,"lng":-83.06}',
			},
		});

		const { planned } = planMigration(
			[event({ title: 'Operation GOTV', event_sessions: [flint, detroit] })],
			NOW,
		);

		expect(planned).toHaveLength(2);
		expect(planned.map((p) => p.city).sort()).toEqual(['Detroit', 'Flint']);
		// Distinct titles, so the two don't look identical in the Mobilize feed.
		expect(new Set(planned.map((p) => p.title)).size).toBe(2);
		// Session titles that already name the event are the organizer's own
		// wording, so they are kept verbatim.
		expect(planned.map((p) => p.title).sort()).toEqual([
			'Operation GOTV: Detroit',
			'Operation GOTV: Flint',
		]);
	});

	it('keeps the campaign title when the sessions are only named "Session 2"', async () => {
		// Regression: a multi-location event took its Mobilize title from a session,
		// so "Yallah! Canvassing with Yemenis for Abdul" was published to volunteers
		// as an event called "Session 2" — the campaign's name nowhere on the page.
		const melvindale = session({
			id: 1,
			title: 'Session 2',
			location_name: '3696 Oakwood',
			location_address: '3696 Oakwood Blvd, Melvindale, MI 48122, USA',
			location_data: {
				full_address: '3696 Oakwood Blvd, Melvindale, MI 48122, USA',
				address_line_1: '3696 Oakwood Boulevard',
				address_city: 'Melvindale',
				address_state: 'MI',
				address_postal_code: '48122',
				address_country: 'US',
				coordinates: '{"lat":42.28,"lng":-83.17}',
			},
		});
		const dearborn = session({
			id: 2,
			title: 'Session 3',
			location_name: '14767 Prospect St',
			location_address: '14767 Prospect St, Dearborn, MI 48126, USA',
			location_data: {
				full_address: '14767 Prospect St, Dearborn, MI 48126, USA',
				address_line_1: '14767 Prospect Street',
				address_city: 'Dearborn',
				address_state: 'MI',
				address_postal_code: '48126',
				address_country: 'US',
				coordinates: '{"lat":42.33,"lng":-83.17}',
			},
		});

		const { planned } = planMigration(
			[
				event({
					title: 'Yallah! Canvassing with Yemenis for Abdul',
					event_sessions: [melvindale, dearborn],
				}),
			],
			NOW,
		);

		expect(planned.map((p) => p.title).sort()).toEqual([
			'Yallah! Canvassing with Yemenis for Abdul — Dearborn',
			'Yallah! Canvassing with Yemenis for Abdul — Melvindale',
		]);
	});

	it('merges sessions whose addresses are the same place spelled differently', () => {
		// The campaign's Pontiac office, stored three ways. This published three
		// Mobilize events for one address — two of which volunteers could sign up
		// for by mistake, and which the dedupe pass then treated as duplicates.
		const pontiac = (id: number, address: string) =>
			session({
				id,
				start_time: `2026-07-2${7 + id}T20:00:00Z`,
				end_time: `2026-07-2${7 + id}T22:00:00Z`,
				location_name: '1 S Saginaw St',
				location_address: address,
				location_data: {
					full_address: address,
					address_line_1: '1 South Saginaw Street',
					address_city: 'Pontiac',
					address_state: 'MI',
					address_postal_code: '48342',
					address_country: 'US',
					coordinates: '{"lat":42.63,"lng":-83.29}',
				},
			});
		const sessions = [
			pontiac(0, '1 South Saginaw Street, Pontiac, MI 48342, USA'),
			pontiac(1, '1 S Saginaw St, Pontiac, MI 48342, USA'),
			pontiac(2, '1 South Saginaw Street, Pontiac, MI, USA'),
		];

		const { planned } = planMigration([event({ event_sessions: sessions })], NOW);

		expect(planned).toHaveLength(1);
		expect(planned[0].timeslots).toHaveLength(3);
		// One location again, so the title is the campaign's, unqualified.
		expect(planned[0].title).toBe('Ann Arbor Canvass');
	});

	it('keys a merged group on its lowest address, whatever order the sessions arrive in', () => {
		// The key is the ledger key. If it moved, the sync would lose the event it
		// already created in Mobilize and try to publish it a second time.
		const at = (id: number, address: string) =>
			session({ id, location_address: address, location_data: null });
		const keyFor = (addresses: string[]) =>
			planMigration([event({ event_sessions: addresses.map((a, i) => at(i, a)) })], NOW).planned[0]
				.key;

		const forward = keyFor([
			'1 South Saginaw Street, Pontiac, MI 48342, USA',
			'1 S Saginaw St, Pontiac, MI 48342, USA',
		]);
		const reversed = keyFor([
			'1 S Saginaw St, Pontiac, MI 48342, USA',
			'1 South Saginaw Street, Pontiac, MI 48342, USA',
		]);
		expect(forward).toBe(reversed);
		expect(forward).toBe('solidarity:100:1 s saginaw st, pontiac, mi 48342, usa');
	});

	it('leaves the key of a single-spelling event exactly as it was', () => {
		// Every event already in the ledger is keyed on its raw lowercased address,
		// so normalization must not touch the key of one that never had a variant.
		const { planned } = planMigration([event()], NOW);
		expect(planned[0].key).toBe('solidarity:100:100 n main st, ann arbor, mi 48104, usa');
	});

	it('holds back an event tagged mobilize-exclude, and says so', () => {
		const { planned, excludedByTag, skipped } = planMigration(
			[
				event({ id: 1, tags: ['wayne', 'Mobilize-Exclude '] }),
				event({ id: 2, tags: ['wayne'] }),
				event({ id: 3, tags: null }),
			],
			NOW,
		);

		expect(planned.map((p) => p.solidarityEventId)).toEqual([2, 3]);
		// Deliberate, so it is reported apart from the events that need fixing.
		expect(skipped).toEqual([]);
		expect(excludedByTag).toEqual([
			{
				solidarityEventId: 1,
				title: 'Ann Arbor Canvass',
				reason: 'tagged mobilize-exclude in Solidarity',
			},
		]);
	});

	it('collapses many sessions at one venue into a single event with many timeslots', () => {
		const sessions = [
			session({ id: 1, start_time: '2026-07-28T21:30:00Z', end_time: '2026-07-29T00:00:00Z' }),
			session({ id: 2, start_time: '2026-07-29T19:00:00Z', end_time: '2026-07-29T21:30:00Z' }),
			session({ id: 3, start_time: '2026-07-31T21:30:00Z', end_time: '2026-08-01T00:00:00Z' }),
		];
		const { planned } = planMigration([event({ event_sessions: sessions })], NOW);

		expect(planned).toHaveLength(1);
		expect(planned[0].timeslots).toHaveLength(3);
		// Sorted chronologically.
		expect(planned[0].timeslots.map((t) => t.startDate)).toEqual([
			Date.parse('2026-07-28T21:30:00Z') / 1000,
			Date.parse('2026-07-29T19:00:00Z') / 1000,
			Date.parse('2026-07-31T21:30:00Z') / 1000,
		]);
	});

	it('drops past sessions but keeps the event for its future ones', () => {
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							id: 1,
							start_time: '2026-07-01T20:00:00Z',
							end_time: '2026-07-01T22:00:00Z',
						}),
						session({ id: 2 }),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(1);
		expect(planned[0].solidaritySessionIds).toEqual([2]);
	});

	it('skips virtual events and co-hosted mirrors', () => {
		const { planned } = planMigration(
			[event({ event_type: 'virtual' }), event({ id: 101, is_co_hosted_mirror: true })],
			NOW,
		);
		expect(planned).toHaveLength(0);
	});

	it('reports events with no usable address instead of inventing one', () => {
		const { planned, skipped } = planMigration(
			[event({ event_sessions: [session({ location_data: null, location_address: null })] })],
			NOW,
		);
		expect(planned).toHaveLength(0);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].reason).toMatch(/no usable address/);
	});

	it('falls back to parsing location_address when the structured fields are blank', () => {
		// The common real shape: coordinates only, address in the display string.
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_name: 'Office Inside Insight',
							location_address: '4400 South Saginaw Street, Flint, MI, USA',
							location_data: { coordinates: '{"lat":42.9837207,"lng":-83.6748673}' },
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(1);
		expect(planned[0]).toMatchObject({
			addressLine1: '4400 South Saginaw Street',
			city: 'Flint',
			state: 'MI',
			locationName: 'Office Inside Insight',
		});
	});

	it('skips a city-only address rather than dropping a pin on the city centroid', () => {
		const { planned, skipped } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_address: 'Ann Arbor, MI, USA',
							location_data: { coordinates: '{"lat":42.28,"lng":-83.74}' },
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(0);
		expect(skipped).toHaveLength(1);
	});

	it('keeps a structured postal code even when the record has no city', () => {
		// Real shape from Solidarity: address_city is blank but address_line_1 and
		// address_postal_code are both filled. The all-or-nothing structured branch
		// used to discard the zip here and fall through to the address string,
		// which has none — and Mobilize rejects a create with a blank postal_code.
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_address:
								'Canton Public Library, Canton Center Road, Canton Township, MI, USA',
							location_data: {
								full_address: 'Canton Public Library, Canton Center Road, Canton Township, MI, USA',
								address_line_1: '1200 Canton Center Road',
								address_city: '',
								address_state: 'MI',
								address_postal_code: '48188',
								address_country: 'US',
								coordinates: '{"lat":42.2967192,"lng":-83.488087}',
							},
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(1);
		expect(planned[0].zipcode).toBe('48188');
		expect(planned[0].city).toBe('Canton Township');
	});

	it('takes coordinates from the session the address came from', () => {
		// Grouping guarantees a shared location key, not a shared point — a venue
		// name is the key when no session has an address. Geocoding the wrong
		// session's point would put a zip on an address it does not belong to.
		// Same location key, but only the second session has the structured address
		// resolveLocation ends up publishing — so its point, not the first one's,
		// is the one a geocoded zip has to come from.
		const first = session({
			id: 1,
			location_address: 'Flint Field Office',
			location_data: {
				full_address: 'Flint Field Office',
				coordinates: '{"lat":42.28,"lng":-83.74}',
			},
		});
		const addressBearing = session({
			id: 2,
			location_address: 'Flint Field Office',
			location_data: {
				full_address: 'Flint Field Office',
				address_line_1: '4400 South Saginaw Street',
				address_city: 'Flint',
				address_state: 'MI',
				coordinates: '{"lat":42.9837207,"lng":-83.6748673}',
			},
		});
		const { planned } = planMigration([event({ event_sessions: [first, addressBearing] })], NOW);
		expect(planned).toHaveLength(1);
		expect(planned[0].addressLine1).toBe('4400 South Saginaw Street');
		expect(planned[0].coordinates).toEqual({ lat: 42.9837207, lng: -83.6748673 });
	});

	it('falls back to another session in the group when that one has no coordinates', () => {
		const noCoords = session({ id: 1, location_data: { full_address: 'Somewhere, MI' } });
		const hasCoords = session({
			id: 2,
			location_data: { full_address: 'Somewhere, MI', coordinates: '{"lat":42.28,"lng":-83.74}' },
		});
		const { planned } = planMigration([event({ event_sessions: [noCoords, hasCoords] })], NOW);
		expect(planned[0].coordinates).toEqual({ lat: 42.28, lng: -83.74 });
	});

	it('carries the venue coordinates so a missing zip can be geocoded', () => {
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_address: '4400 South Saginaw Street, Flint, MI, USA',
							location_data: { coordinates: '{"lat":42.9837207,"lng":-83.6748673}' },
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned[0].zipcode).toBe('');
		expect(planned[0].coordinates).toEqual({ lat: 42.9837207, lng: -83.6748673 });
	});

	it('synthesizes a description for an event that has none', () => {
		// Mobilize requires a non-blank description; a handful of Solidarity events
		// have no description, no page HTML and no note anywhere.
		const { planned } = planMigration(
			[
				event({
					title: 'Macomb Defenders Rising',
					description: null,
					event_page_url: 'https://go.example.org/macomb-defenders-rising',
				}),
			],
			NOW,
		);
		expect(planned[0].description).toBe(
			'**Macomb Defenders Rising**\n\nDetails and updates:\nhttps://go.example.org/macomb-defenders-rising',
		);
	});

	it('still synthesizes something when there is no page to link either', () => {
		const { planned } = planMigration(
			[event({ title: 'Macomb Defenders Rising', description: null, event_page_url: null })],
			NOW,
		);
		expect(planned[0].description).toBe('**Macomb Defenders Rising**');
	});

	it('leaves a real description alone', () => {
		const { planned } = planMigration([event({ description: 'Come knock doors' })], NOW);
		expect(planned[0].description).toBe('Come knock doors');
	});

	it('converts a zero capacity to unlimited rather than zero seats', () => {
		const { planned } = planMigration(
			[event({ event_sessions: [session({ max_capacity: 0 })] })],
			NOW,
		);
		expect(planned[0].timeslots[0].maxAttendees).toBeNull();
	});

	it('keeps a real capacity', () => {
		const { planned } = planMigration(
			[event({ event_sessions: [session({ max_capacity: 12 })] })],
			NOW,
		);
		expect(planned[0].timeslots[0].maxAttendees).toBe(12);
	});
});

describe('duplicate detection', () => {
	const planned = planMigration([event()], NOW).planned[0];

	function mobilizeEvent(overrides: Partial<MobilizeEvent> = {}): MobilizeEvent {
		return {
			id: 999,
			title: 'Ann Arbor Canvass',
			event_type: 'COMMUNITY_CANVASS',
			timeslots: [{ id: 1, start_date: Date.parse('2026-07-31T00:00:00Z') / 1000, end_date: 0 }],
			location: { locality: 'Ann Arbor' },
			...overrides,
		};
	}

	it('matches an identical title', () => {
		expect(findDuplicate(planned, [mobilizeEvent()])?.reason).toBe('identical title');
	});

	it('matches a reworded title at the same start time', () => {
		// Real pair: Solidarity vs Mobilize naming of the Negaunee event.
		const match = findDuplicate(planned, [
			mobilizeEvent({ title: 'Ann Arbor Canvass Launch with Max Frost' }),
		]);
		expect(match).not.toBeNull();
	});

	it('does not match the same generic event in a different city', () => {
		// Real case: watch parties in Coldwater, Lansing, Pontiac and Oakland all
		// started at 7:15pm. Title overlap alone made them duplicates of each other.
		const coldwater = planMigration(
			[
				event({
					title: 'Coldwater 7/27 Debate Watch Party',
					event_sessions: [
						session({
							location_data: {
								full_address: '1 Main St, Coldwater, MI 49036, USA',
								address_line_1: '1 Main St',
								address_city: 'Coldwater',
								address_state: 'MI',
								address_postal_code: '49036',
								address_country: 'US',
								coordinates: '{"lat":41.94,"lng":-85.0}',
							},
						}),
					],
				}),
			],
			NOW,
		).planned[0];

		expect(
			findDuplicate(coldwater, [
				mobilizeEvent({ title: 'Oakland Debate Watch Party', location: { locality: 'Pontiac' } }),
			]),
		).toBeNull();
	});

	it('still matches when one city is a longer form of the other', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({
					title: 'Ann Arbor Canvass Launch',
					location: { locality: 'Ann Arbor Township' },
				}),
			]),
		).not.toBeNull();
	});

	it('matches on identical title even when the cities differ', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({ title: 'Ann Arbor Canvass', location: { locality: 'Ypsilanti' } }),
			])?.reason,
		).toBe('identical title');
	});

	it('does not match an unrelated event that merely starts at the same time', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({ title: 'Bay City Concert', location: { locality: 'Bay City' } }),
			]),
		).toBeNull();
	});

	it('does not match a similar title at a different time', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({
					title: 'Ann Arbor Canvass Launch',
					timeslots: [
						{ id: 2, start_date: Date.parse('2026-08-15T00:00:00Z') / 1000, end_date: 0 },
					],
				}),
			]),
		).toBeNull();
	});

	it('normalizes punctuation and case', () => {
		expect(normalizeTitle('🗳️ Finish Strong: Final-Stretch Canvass!')).toBe(
			'finish strong final stretch canvass',
		);
	});

	it('scores overlapping titles above unrelated ones', () => {
		expect(titleSimilarity('Detroit Canvass Launch', 'Canvass Launch in Detroit')).toBe(1);
		expect(titleSimilarity('Detroit Canvass', 'Bay City Concert')).toBe(0);
	});
});

describe('duplicate sessions', () => {
	// Mobilize answers `400 Timeslot with start and end time already exists` and
	// refuses the whole event, so a Solidarity event with a session entered twice
	// at one venue could not be created at all.
	const twin = () => [
		session({ id: 1 }),
		session({ id: 2 }),
		session({
			id: 3,
			start_time: '2026-07-31T20:00:00.000-04:00',
			end_time: '2026-07-31T22:00:00.000-04:00',
		}),
	];

	it('sends one timeslot per distinct start and end', () => {
		const { planned } = planMigration([event({ event_sessions: twin() })], NOW);

		expect(planned).toHaveLength(1);
		expect(planned[0]!.timeslots).toHaveLength(2);
	});

	it('keeps the ids index-aligned with the timeslots that survived', () => {
		// solidaritySessionIds is what decides where a Mobilize signup is mirrored
		// back to. Dropping a timeslot without its id would file signups against
		// the wrong session.
		const { planned } = planMigration([event({ event_sessions: twin() })], NOW);

		expect(planned[0]!.solidaritySessionIds).toEqual([1, 3]);
		expect(planned[0]!.startInstants).toHaveLength(2);
		expect(planned[0]!.endInstants).toHaveLength(2);
	});

	it('reports which session it left out, and which one holds the slot', () => {
		const { duplicateSessions } = planMigration([event({ event_sessions: twin() })], NOW);

		expect(duplicateSessions).toEqual([
			{ solidarityEventId: 100, title: 'Ann Arbor Canvass', sessionId: 2, keptSessionId: 1 },
		]);
	});

	it('governs the shift by the cap of the session that kept the slot', () => {
		// Everyone who signs up in Mobilize is mirrored back to the surviving
		// session, so its cap is the one that has to hold.
		const sessions = [session({ id: 1, max_capacity: 10 }), session({ id: 2, max_capacity: 5 })];

		const { planned } = planMigration([event({ event_sessions: sessions })], NOW);

		expect(planned[0]!.timeslots[0]!.maxAttendees).toBe(10);
	});

	it('leaves sessions that merely start together alone', () => {
		// Same start, different end: two distinct timeslots as far as Mobilize is
		// concerned, and it takes both.
		const sessions = [
			session({ id: 1 }),
			session({ id: 2, end_time: '2026-07-30T23:00:00.000-04:00' }),
		];

		const { planned, duplicateSessions } = planMigration(
			[event({ event_sessions: sessions })],
			NOW,
		);

		expect(planned[0]!.timeslots).toHaveLength(2);
		expect(duplicateSessions).toEqual([]);
	});
});
