import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildZipChapterMap,
	normalizeZipKey,
	createUser,
	findExistingUser,
	normalizeEmail,
	normalizePhone,
	resolveChapterId,
	SolidarityUserCreateError,
} from './people.js';
import { attendingFor } from './rsvp.js';

const TOKEN = 'test-token';

function mockFetch(handler: (url: string) => { ok?: boolean; body: unknown }) {
	const spy = vi.fn(async (url: string | URL) => {
		const { ok = true, body } = handler(String(url));
		return {
			ok,
			status: ok ? 200 : 500,
			json: async () => body,
			text: async () => JSON.stringify(body),
			headers: new Headers(),
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('normalizePhone', () => {
	it('promotes a bare 10-digit US number to the stored form', () => {
		// Mobilize hands us "6169539282"; Solidarity stores "16169539282".
		expect(normalizePhone('6169539282')).toBe('16169539282');
	});

	it('accepts an already-prefixed number and strips punctuation', () => {
		expect(normalizePhone('+1 (616) 953-9282')).toBe('16169539282');
		expect(normalizePhone('16169539282')).toBe('16169539282');
	});

	it('refuses anything not safely matchable', () => {
		expect(normalizePhone('12345')).toBeNull();
		expect(normalizePhone('')).toBeNull();
		expect(normalizePhone(null)).toBeNull();
	});

	it('refuses filler that is the right length but not a real NANP number', () => {
		// Mobilize does not validate what people type, and Solidarity 422s these
		// at create time — which used to fail the signup and alert every run.
		expect(normalizePhone('0000000000')).toBeNull();
		expect(normalizePhone('1111111111')).toBeNull();
		expect(normalizePhone('1234567890')).toBeNull(); // exchange starts with 1
		expect(normalizePhone('616-011-1234')).toBeNull(); // exchange starts with 0
		expect(normalizePhone('911-555-1234')).toBeNull(); // N11 area code
	});
});

describe('normalizeEmail', () => {
	it('lowercases and trims', () => {
		expect(normalizeEmail('  Kathryn@Example.COM ')).toBe('kathryn@example.com');
	});

	it('rejects non-addresses', () => {
		expect(normalizeEmail('not-an-email')).toBeNull();
		expect(normalizeEmail(null)).toBeNull();
	});
});

describe('findExistingUser', () => {
	const person = {
		firstName: 'A',
		lastName: 'B',
		email: 'a@example.com',
		phone: '6169539282',
		zipcode: '49504',
	};

	it('uses phone_number, never phone, when falling back to phone lookup', async () => {
		// Regression guard. Solidarity ACCEPTS ?phone= and silently ignores it,
		// returning an unfiltered user list — matching on that would attach
		// signups to arbitrary strangers.
		const spy = mockFetch((url) =>
			url.includes('email=') ? { body: { data: [] } } : { body: { data: [{ id: 42 }] } },
		);

		const result = await findExistingUser(TOKEN, person);

		expect(result).toEqual({ outcome: 'matched', user: { id: 42 }, method: 'phone' });
		const phoneCall = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('phone'));
		expect(phoneCall).toContain('phone_number=');
		expect(phoneCall).not.toMatch(/[?&]phone=/);
	});

	it('prefers an email match and does not fall through to phone', async () => {
		const spy = mockFetch(() => ({ body: { data: [{ id: 7 }] } }));

		const result = await findExistingUser(TOKEN, person);

		expect(result).toEqual({ outcome: 'matched', user: { id: 7 }, method: 'email' });
		expect(spy.mock.calls).toHaveLength(1);
		expect(String(spy.mock.calls[0]![0])).toContain('email=');
	});

	it('sends the normalized phone, not what Mobilize gave us', async () => {
		const spy = mockFetch((url) =>
			url.includes('email=') ? { body: { data: [] } } : { body: { data: [] } },
		);

		await findExistingUser(TOKEN, person);

		const phoneCall = spy.mock.calls
			.map((c) => String(c[0]))
			.find((u) => u.includes('phone_number'));
		expect(phoneCall).toContain('phone_number=16169539282');
	});

	it('refuses to match when an identifier hits more than one person', async () => {
		// Ambiguity must not resolve to "the first one" — that files someone
		// else's RSVP against a real member.
		mockFetch(() => ({ body: { data: [{ id: 1 }, { id: 2 }] } }));

		expect(await findExistingUser(TOKEN, person)).toEqual({ outcome: 'ambiguous' });
	});

	it('reports ambiguous separately from never-seen', async () => {
		// The two are what tell a genuine signup surge apart from a lookup that
		// has stopped filtering, so they must not collapse into one "no match".
		mockFetch(() => ({ body: { data: [] } }));

		expect(await findExistingUser(TOKEN, person)).toEqual({ outcome: 'none' });
	});

	it('reports ambiguous when only the phone lookup is the ambiguous one', async () => {
		mockFetch((url) =>
			url.includes('email=') ? { body: { data: [] } } : { body: { data: [{ id: 1 }, { id: 2 }] } },
		);

		expect(await findExistingUser(TOKEN, person)).toEqual({ outcome: 'ambiguous' });
	});

	it('skips lookups entirely when there is nothing to match on', async () => {
		const spy = mockFetch(() => ({ body: { data: [] } }));

		const result = await findExistingUser(TOKEN, {
			firstName: 'A',
			lastName: 'B',
			email: null,
			phone: null,
			zipcode: null,
		});

		expect(result).toEqual({ outcome: 'none' });
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('createUser', () => {
	const person = {
		firstName: 'A',
		lastName: 'B',
		email: 'a@example.com',
		phone: '6165551234',
		zipcode: '49504',
	};

	// Regression: `/v1/users` returns a single user BARE while the rest of the API
	// wraps in `data`. Reading only `data.id` threw "returned no id" on profiles
	// Solidarity had really created — the person existed, their RSVP did not.
	it('reads the id from a bare response', async () => {
		mockFetch(() => ({ body: { id: 15404367, email: 'a@example.com' } }));

		expect(await createUser(TOKEN, person, 1330)).toEqual({ id: 15404367 });
	});

	it('still reads the id from a data-wrapped response', async () => {
		mockFetch(() => ({ body: { data: { id: 15404367 } } }));

		expect(await createUser(TOKEN, person, 1330)).toEqual({ id: 15404367 });
	});

	it('names the shape it got without echoing contact details into Slack', async () => {
		mockFetch(() => ({ body: { user: { id: 1, email: 'a@example.com' } } }));

		await expect(createUser(TOKEN, person, 1330)).rejects.toThrow(/response keys: user/);
		await expect(createUser(TOKEN, person, 1330)).rejects.not.toThrow(/example\.com/);
	});

	it('reports which fields Solidarity rejected, so the caller can react', async () => {
		// The live 422 for a number Solidarity cannot text.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				const body = {
					error: 'Failed to save user',
					details: [
						{
							field_name: 'phone_number',
							message: 'Please enter a valid phone number capable of receiving text messages',
						},
					],
				};
				return {
					ok: false,
					status: 422,
					json: async () => body,
					text: async () => JSON.stringify(body),
					headers: new Headers(),
				} as unknown as Response;
			}),
		);

		const err = await createUser(TOKEN, person, 1330).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(SolidarityUserCreateError);
		const failure = err as SolidarityUserCreateError;
		expect(failure.phoneRejected).toBe(true);
		expect(failure.fields).toEqual(['phone_number']);
		// The old message is preserved: it is what reaches the logs.
		expect(failure.message).toContain('returned 422');
	});

	it('does not claim the phone was at fault when Solidarity says nothing about it', async () => {
		mockFetch(() => ({ ok: false, body: { error: 'nope' } }));

		const err = (await createUser(TOKEN, person, 1330).catch(
			(e: unknown) => e,
		)) as SolidarityUserCreateError;

		expect(err.phoneRejected).toBe(false);
		expect(err.fields).toEqual([]);
	});
});

describe('buildZipChapterMap', () => {
	it('picks the chapter most existing members in that zip belong to', () => {
		const map = buildZipChapterMap([
			{ address: { zip_code: '48104' }, chapter_ids: [1305] },
			{ address: { zip_code: '48104' }, chapter_ids: [1305] },
			{ address: { zip_code: '48104' }, chapter_ids: [1322] },
			{ address: { zip_code: '49504' }, chapter_ids: [1315] },
		]);
		expect(map.get('48104')).toEqual({ chapterId: 1305, memberCount: 2 });
		expect(map.get('49504')).toEqual({ chapterId: 1315, memberCount: 1 });
	});

	it('ignores members with no zip', () => {
		const map = buildZipChapterMap([
			{ address: null, chapter_ids: [1305] },
			{ address: { zip_code: null }, chapter_ids: [1305] },
		]);
		expect(map.size).toBe(0);
	});

	it('counts a member in every chapter they belong to', () => {
		const map = buildZipChapterMap([{ address: { zip_code: '48104' }, chapter_ids: [1, 2] }]);
		// Tie broken deterministically by lower chapter id.
		expect(map.get('48104')?.chapterId).toBe(1);
	});

	// Solidarity's zip_code is free text. Every lookup normalizes to five digits,
	// so a member stored under a ZIP+4 key used to be absent from the tally that
	// places their own neighbours.
	it('folds ZIP+4 onto the five-digit key it is looked up by', () => {
		const map = buildZipChapterMap([
			{ address: { zip_code: '48104-1234' }, chapter_ids: [1305] },
			{ address: { zip_code: '48104' }, chapter_ids: [1305] },
		]);
		expect(map.get('48104')).toEqual({ chapterId: 1305, memberCount: 2 });
		expect(map.get('48104-1234')).toBeUndefined();
	});

	it.each([
		['a Canadian postcode', 'N1H2N7'],
		['a phone number', '6169148324'],
		['six digits', '200000'],
		['four digits', '2140'],
		['a stray letter', 'x'],
		['pasted prose', 'I want to gather information from people to learn how to help'],
	])('skips %s rather than keying a row on it', (_label, zip) => {
		expect(buildZipChapterMap([{ address: { zip_code: zip }, chapter_ids: [1305] }]).size).toBe(0);
	});

	// The same fallback chapter-reconcile.ts and the team_join handler use. When
	// this module disagreed with them, a member carrying chapter_id but an empty
	// chapter_ids counted everywhere except in their own zip's tally.
	it('falls back to chapter_id when chapter_ids is empty', () => {
		const map = buildZipChapterMap([
			{ address: { zip_code: '48104' }, chapter_id: 1305, chapter_ids: [] },
			{ address: { zip_code: '48104' }, chapter_id: 1305 },
		]);
		expect(map.get('48104')).toEqual({ chapterId: 1305, memberCount: 2 });
	});

	it('prefers chapter_ids over chapter_id when both are present', () => {
		const map = buildZipChapterMap([
			{ address: { zip_code: '48104' }, chapter_id: 9999, chapter_ids: [1305] },
		]);
		expect(map.get('48104')).toEqual({ chapterId: 1305, memberCount: 1 });
	});

	// A superseded statewide chapter whose leftover members out-vote the counties
	// carved out of it. The zip must go to the county, not to nobody — filtering
	// after a winner was picked would blank it.
	it('hands the zip to the runner-up when the winner is excluded', () => {
		const users = [
			{ address: { zip_code: '48104' }, chapter_ids: [1008] },
			{ address: { zip_code: '48104' }, chapter_ids: [1008] },
			{ address: { zip_code: '48104' }, chapter_ids: [1008] },
			{ address: { zip_code: '48104' }, chapter_ids: [1330] },
		];
		expect(buildZipChapterMap(users).get('48104')).toEqual({ chapterId: 1008, memberCount: 3 });
		expect(buildZipChapterMap(users, new Set([1008])).get('48104')).toEqual({
			chapterId: 1330,
			memberCount: 1,
		});
	});

	it('leaves a zip unmapped when every member is in an excluded chapter', () => {
		const map = buildZipChapterMap(
			[{ address: { zip_code: '48104' }, chapter_ids: [1008] }],
			new Set([1008]),
		);
		expect(map.size).toBe(0);
	});

	// Dropping the person rather than the chapter would discard evidence about
	// where they actually live.
	it('still counts a member of both an excluded and a live chapter', () => {
		const map = buildZipChapterMap(
			[{ address: { zip_code: '48104' }, chapter_ids: [1008, 1330] }],
			new Set([1008]),
		);
		expect(map.get('48104')).toEqual({ chapterId: 1330, memberCount: 1 });
	});

	it('excludes on the chapter_id fallback too', () => {
		const map = buildZipChapterMap(
			[{ address: { zip_code: '48104' }, chapter_id: 1008, chapter_ids: [] }],
			new Set([1008]),
		);
		expect(map.size).toBe(0);
	});

	it('changes nothing when the exclusion set is empty', () => {
		const users = [{ address: { zip_code: '48104' }, chapter_ids: [1008] }];
		expect(buildZipChapterMap(users, new Set())).toEqual(buildZipChapterMap(users));
	});

	it('ignores a member with no chapter either way', () => {
		expect(
			buildZipChapterMap([{ address: { zip_code: '48104' }, chapter_id: null, chapter_ids: [] }])
				.size,
		).toBe(0);
	});
});

describe('normalizeZipKey', () => {
	it.each([
		['five digits', '48104', '48104'],
		['ZIP+4', '48104-1234', '48104'],
		['surrounding whitespace', '  48104 ', '48104'],
	])('maps %s to the lookup key', (_label, raw, expected) => {
		expect(normalizeZipKey(raw)).toBe(expected);
	});

	it.each([
		['empty', ''],
		['null', null],
		['undefined', undefined],
		['four digits', '4810'],
		['six digits', '481041'],
		['a partial ZIP+4', '48104-12'],
		['letters', 'N1H2N7'],
	])('rejects %s', (_label, raw) => {
		expect(normalizeZipKey(raw)).toBeNull();
	});
});

describe('resolveChapterId', () => {
	const resolver = {
		byZip: (zip: string | null) => (zip === '48104' ? 1305 : null),
		eventChapterId: 1330,
		defaultChapterId: 999,
	};

	it('prefers the zip match', () => {
		expect(resolveChapterId(resolver, '48104')).toBe(1305);
	});

	it('falls back to the chapter that owns the event', () => {
		expect(resolveChapterId(resolver, '99999')).toBe(1330);
		expect(resolveChapterId(resolver, null)).toBe(1330);
	});

	it('falls back to the default when the event has no chapter', () => {
		expect(resolveChapterId({ ...resolver, eventChapterId: null }, null)).toBe(999);
	});

	it('returns null rather than inventing a chapter', () => {
		expect(
			resolveChapterId({ ...resolver, eventChapterId: null, defaultChapterId: null }, null),
		).toBeNull();
	});
});

describe('attendingFor', () => {
	it('maps registered and confirmed to yes, cancelled to no', () => {
		expect(attendingFor('REGISTERED')).toBe('yes');
		// CONFIRMED is a reconfirmed registration — the same intent, firmer.
		expect(attendingFor('CONFIRMED')).toBe('yes');
		expect(attendingFor('CANCELLED')).toBe('no');
	});

	it('refuses to guess an unrecognized status', () => {
		expect(attendingFor('UNKNOWN')).toBeNull();
	});
});
