import { describe, it, expect } from 'vitest';
import {
	buildChapterPickerBlocks,
	buildClaimedBlocks,
	buildTurfListBlocks,
	decodeTurfAction,
	encodeTurfAction,
	MAX_LOCATION_LENGTH,
	MAX_SLACK_OFFSET,
	parseTurfArgument,
	SLACK_TURF_LIMIT,
	TURF_CLAIM_ACTION_ID,
	TURF_PAGE_ACTION_ID,
	TURF_RELEASE_ACTION_ID,
	turfPageUrl,
	type Block,
} from './turf-command.js';
import type { TurfView } from '../../van/turf-view.js';

const APP_URL = 'https://app.example.org';
const CHAPTER = { chapterId: 71, name: 'Washtenaw County' };
const HERE = { lat: 42.28, lng: -83.74 };

function view(over: Partial<TurfView> = {}): TurfView {
	return {
		mapRouteId: 100,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: null,
		routeSize: 400,
		doorsRemaining: 250,
		hull: [],
		centre: { lat: 42.281, lng: -83.741 },
		bounds: { minLat: 42.28, minLng: -83.75, maxLat: 42.29, maxLng: -83.73 },
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 120,
		claimable: true,
		...over,
	};
}

/** Everything a Slack message would actually transmit, as one string. The
 *  leak tests below search this rather than eyeballing block structure. */
function serialise(blocks: Block[]): string {
	return JSON.stringify(blocks);
}

function buttons(blocks: Block[]): { action_id: string; value?: string }[] {
	const out: { action_id: string; value?: string }[] = [];
	for (const block of blocks) {
		if (block.type === 'actions') out.push(...block.elements);
		if (block.type === 'section' && block.accessory) out.push(block.accessory);
	}
	return out;
}

describe('parseTurfArgument', () => {
	it.each([
		['empty', ''],
		['blank', '   '],
		['null', null],
		['undefined', undefined],
	])('reads %s as no argument', (_label, raw) => {
		expect(parseTurfArgument(raw)).toEqual({ kind: 'none' });
	});

	it.each([
		['a bare ZIP', '48104', '48104'],
		['a padded ZIP', '  48104 ', '48104'],
		['ZIP+4', '48104-1234', '48104'],
	])('reads %s as a ZIP', (_label, raw, zip) => {
		expect(parseTurfArgument(raw)).toEqual({ kind: 'zip', zip });
	});

	it.each([
		['a street address', '100 N Main St, Ann Arbor MI'],
		['a city', 'Ypsilanti MI'],
		['a six-digit number', '481041'],
	])('reads %s as an address', (_label, raw) => {
		expect(parseTurfArgument(raw)).toEqual({ kind: 'address', query: raw.trim() });
	});

	// A paste or an attack, neither of which deserves a geocoder call.
	it('truncates an over-long argument', () => {
		const long = 'a'.repeat(500);
		const parsed = parseTurfArgument(long);
		expect(parsed.kind).toBe('address');
		expect((parsed as { query: string }).query).toHaveLength(MAX_LOCATION_LENGTH);
	});
});

describe('turf action values', () => {
	it('round-trips', () => {
		const value = { mapRouteId: 100, chapterId: 71, offset: 5, location: HERE };
		expect(decodeTurfAction(encodeTurfAction(value))).toEqual({
			mapRouteId: 100,
			chapterId: 71,
			offset: 5,
			location: { lat: 42.28, lng: -83.74 },
		});
	});

	it('omits the route id for a paging button', () => {
		const decoded = decodeTurfAction(encodeTurfAction({ chapterId: 71, offset: 5 }));
		expect(decoded).toEqual({ chapterId: 71, offset: 5 });
		expect(decoded).not.toHaveProperty('mapRouteId');
	});

	// ~100m. Enough to re-sort a list; not a location trace sitting in a message.
	it('rounds coordinates to three decimals', () => {
		const encoded = encodeTurfAction({
			chapterId: 71,
			offset: 0,
			location: { lat: 42.2812345, lng: -83.7419876 },
		});
		expect(decodeTurfAction(encoded)!.location).toEqual({ lat: 42.281, lng: -83.742 });
	});

	// The value comes back from a client, so it is untrusted input.
	it.each([
		['null', null],
		['empty', ''],
		['not JSON', 'not json'],
		['an array', '[1,2,3]'],
		['a bare string', '"hello"'],
		['no chapter', '{"o":0}'],
		['a non-numeric chapter', '{"c":"71","o":0}'],
		['a fractional chapter', '{"c":71.5,"o":0}'],
	])('rejects %s', (_label, raw) => {
		expect(decodeTurfAction(raw)).toBeNull();
	});

	it.each([
		['a negative offset', '{"c":71,"o":-40}', 0],
		['a huge offset', '{"c":71,"o":99999}', MAX_SLACK_OFFSET],
		['a non-numeric offset', '{"c":71,"o":"5"}', 0],
	])('clamps %s', (_label, raw, expected) => {
		expect(decodeTurfAction(raw)!.offset).toBe(expected);
	});

	it('drops out-of-range coordinates rather than trusting them', () => {
		expect(decodeTurfAction('{"c":71,"o":0,"lat":999,"lng":-83.7}')!.location).toBeUndefined();
		expect(decodeTurfAction('{"c":71,"o":0,"lat":"x","lng":"y"}')!.location).toBeUndefined();
	});
});

describe('turfPageUrl', () => {
	it('builds a chapter deep link', () => {
		expect(turfPageUrl(APP_URL, 71)).toBe(`${APP_URL}/turfs?chapter=71`);
	});

	it('carries a zip through so the web page opens on the same location', () => {
		expect(turfPageUrl(APP_URL, 71, '48104')).toBe(`${APP_URL}/turfs?chapter=71&zip=48104`);
	});

	it('falls back to the picker with no chapter', () => {
		expect(turfPageUrl(APP_URL)).toBe(`${APP_URL}/turfs`);
	});
});

describe('buildTurfListBlocks', () => {
	const base = {
		chapter: CHAPTER,
		offset: 0,
		omitted: 0,
		total: 1,
		appUrl: APP_URL,
	};

	it('renders a turf with its counts and status', () => {
		const { blocks, text } = buildTurfListBlocks({ ...base, turfs: [view()] });
		const body = serialise(blocks);
		expect(body).toContain('Turf 01');
		expect(body).toContain('Ann Arbor');
		expect(body).toContain('250 doors');
		expect(body).toContain('Available');
		expect(text).toContain('Washtenaw County');
	});

	it('shows distance only when the volunteer’s location is known', () => {
		const without = buildTurfListBlocks({ ...base, turfs: [view()] });
		expect(serialise(without.blocks)).not.toContain('away');
		const withLoc = buildTurfListBlocks({ ...base, turfs: [view()], location: HERE });
		expect(serialise(withLoc.blocks)).toContain('away');
	});

	it('offers a Claim button on claimable turf only', () => {
		const claimable = buildTurfListBlocks({ ...base, turfs: [view()] });
		expect(buttons(claimable.blocks).map((b) => b.action_id)).toContain(TURF_CLAIM_ACTION_ID);

		const taken = buildTurfListBlocks({
			...base,
			turfs: [view({ status: 'checked-out', claimable: false })],
		});
		expect(buttons(taken.blocks).map((b) => b.action_id)).not.toContain(TURF_CLAIM_ACTION_ID);
	});

	it('offers a Give back button on your own turf', () => {
		const mine = buildTurfListBlocks({
			...base,
			turfs: [view({ status: 'held-by-you', claimable: false })],
		});
		expect(buttons(mine.blocks).map((b) => b.action_id)).toContain(TURF_RELEASE_ACTION_ID);
	});

	it('explains why an available turf cannot be claimed', () => {
		const blocked = buildTurfListBlocks({
			...base,
			turfs: [
				view({
					claimable: false,
					claimBlockedReason: "This turf doesn't have a MiniVAN list number yet.",
				}),
			],
		});
		expect(serialise(blocked.blocks)).toContain('MiniVAN list number yet');
	});

	// Story 4.3: never imply live data.
	it('states how stale the door counts are', () => {
		const { blocks } = buildTurfListBlocks({
			...base,
			turfs: [view({ refreshedMinutesAgo: 30 }), view({ mapRouteId: 2, refreshedMinutesAgo: 360 })],
			total: 2,
		});
		// The oldest of the two, since one line is read as covering the whole list.
		expect(serialise(blocks)).toContain('6 hours ago');
	});

	it('omits the staleness line when VAN has never reported a refresh', () => {
		const { blocks } = buildTurfListBlocks({
			...base,
			turfs: [view({ refreshedMinutesAgo: null })],
		});
		expect(serialise(blocks)).not.toContain('Door counts as of');
	});

	describe('paging', () => {
		it('offers the next page while turf remains', () => {
			const { blocks } = buildTurfListBlocks({
				...base,
				turfs: [view()],
				omitted: 20,
				total: 21,
			});
			const page = buttons(blocks).find((b) => b.action_id === TURF_PAGE_ACTION_ID);
			expect(page).toBeDefined();
			expect(serialise(blocks)).toContain(`Show next ${SLACK_TURF_LIMIT}`);
			expect(decodeTurfAction(page!.value)!.offset).toBe(1);
		});

		it('offers Start over once the chapter is exhausted', () => {
			const { blocks } = buildTurfListBlocks({ ...base, turfs: [view()], omitted: 0 });
			expect(serialise(blocks)).toContain('Start over');
			const page = buttons(blocks).find((b) => b.action_id === TURF_PAGE_ACTION_ID);
			expect(decodeTurfAction(page!.value)!.offset).toBe(0);
		});

		it('reports the range it is showing', () => {
			const { blocks } = buildTurfListBlocks({
				...base,
				turfs: [view(), view({ mapRouteId: 2 })],
				offset: 5,
				omitted: 27,
				total: 34,
			});
			expect(serialise(blocks)).toContain('6–7 of 34');
		});

		it('carries the location into the paging button so page 2 sorts the same', () => {
			const { blocks } = buildTurfListBlocks({
				...base,
				turfs: [view()],
				location: HERE,
				omitted: 9,
				total: 10,
			});
			const page = buttons(blocks).find((b) => b.action_id === TURF_PAGE_ACTION_ID);
			expect(decodeTurfAction(page!.value)!.location).toEqual({ lat: 42.28, lng: -83.74 });
		});

		it('says so plainly when paged past the end', () => {
			const { blocks } = buildTurfListBlocks({
				...base,
				turfs: [],
				offset: 20,
				total: 10,
			});
			expect(serialise(blocks)).toContain("That's all 10 turfs");
		});
	});

	// With no VAN key this is the state a volunteer actually hits, and it must
	// not read as "everything is taken".
	it('distinguishes an unloaded chapter from a full one', () => {
		const { blocks, text } = buildTurfListBlocks({ ...base, turfs: [], total: 0 });
		expect(text).toContain('No turf loaded');
		expect(serialise(blocks)).toContain('cut turf in VAN');
	});

	it('links to the map', () => {
		const { blocks } = buildTurfListBlocks({ ...base, turfs: [view()], zip: '48104' });
		expect(serialise(blocks)).toContain(`${APP_URL}/turfs?chapter=71&amp;zip=48104`);
	});

	// The credential rule, asserted rather than trusted. toTurfView already
	// nulls the number on turf you don't hold; this checks the builder does not
	// reintroduce it, and that nothing address-like rides along.
	it('never puts a list number or anything address-like in the list', () => {
		const held = view({
			status: 'held-by-you',
			claimable: false,
			// Deliberately populated: this is the shape toTurfView returns for
			// turf you hold, and the LIST still must not print it.
			printedListNumber: '35536745-88712',
		});
		const { blocks, text } = buildTurfListBlocks({
			...base,
			turfs: [held, view({ mapRouteId: 2 })],
		});
		const body = serialise(blocks) + text;
		expect(body).not.toContain('35536745-88712');
		for (const field of ['address', 'street', 'firstName', 'lastName', 'vanId', 'phone', 'email']) {
			expect(body.toLowerCase()).not.toContain(field.toLowerCase());
		}
	});

	it('escapes turf names that carry mrkdwn characters', () => {
		const { blocks } = buildTurfListBlocks({
			...base,
			turfs: [view({ name: 'Turf <1> & 2' })],
		});
		expect(serialise(blocks)).toContain('Turf &lt;1&gt; &amp; 2');
	});
});

describe('buildClaimedBlocks', () => {
	const input = {
		turf: { mapRouteId: 100, name: 'Turf 01', regionName: 'Ann Arbor', doorsRemaining: 250 },
		chapter: CHAPTER,
		printedListNumber: '35536745-88712',
		expiresAt: '2026-08-25T06:00:00.000Z',
		now: new Date('2026-08-23T06:00:00.000Z'),
		appUrl: APP_URL,
	};

	it('shows the list number and the three steps', () => {
		const body = serialise(buildClaimedBlocks(input).blocks);
		expect(body).toContain('35536745-88712');
		expect(body).toContain('Open MiniVAN');
		expect(body).toContain('Sync');
	});

	it('states the expiry in hours', () => {
		expect(serialise(buildClaimedBlocks(input).blocks)).toContain('next 48 hours');
	});

	it('reports zero hours rather than a negative countdown on a lapsed claim', () => {
		const lapsed = { ...input, expiresAt: '2026-08-22T06:00:00.000Z' };
		expect(serialise(buildClaimedBlocks(lapsed).blocks)).toContain('next 0 hours');
	});

	// The fallback text renders on a lock screen — the one place the number
	// could be read without the phone being unlocked.
	it('keeps the list number out of the notification fallback', () => {
		expect(buildClaimedBlocks(input).text).not.toContain('35536745-88712');
	});

	it('offers a release button for the turf just claimed', () => {
		const release = buttons(buildClaimedBlocks(input).blocks).find(
			(b) => b.action_id === TURF_RELEASE_ACTION_ID,
		);
		expect(decodeTurfAction(release!.value)!.mapRouteId).toBe(100);
	});
});

describe('buildChapterPickerBlocks', () => {
	it('lists every chapter as a deep link', () => {
		const body = serialise(
			buildChapterPickerBlocks([CHAPTER, { chapterId: 72, name: 'Wayne County' }], APP_URL).blocks,
		);
		expect(body).toContain('chapter=71');
		expect(body).toContain('chapter=72');
		expect(body).toContain('Wayne County');
	});

	it('explains both other ways to ask', () => {
		const body = serialise(buildChapterPickerBlocks([CHAPTER], APP_URL).blocks);
		expect(body).toContain('/turfs 48104');
		expect(body).toContain("county's channel");
	});

	it('handles a workspace with no chapters configured', () => {
		const { text } = buildChapterPickerBlocks([], APP_URL);
		expect(text).toContain('No chapters');
	});
});
