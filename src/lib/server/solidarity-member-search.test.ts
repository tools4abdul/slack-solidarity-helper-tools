import { describe, it, expect } from 'vitest';
import { searchSolidarityMembers } from './solidarity-member-search.js';
import type { SolidarityMemberEntry } from './autocomplete-sources.js';

const member = (
	id: number,
	name: string,
	email = '',
	otherEmails: string[] = [],
): SolidarityMemberEntry => ({ id, name, email, otherEmails, chapterIds: [] });

const ROSTER: SolidarityMemberEntry[] = [
	member(1, 'Jordan Rivera', 'jordan.rivera@example.org'),
	member(2, 'Jordana Blake', 'jblake@example.org'),
	member(3, 'Alex Jordan', 'alex@example.org'),
	member(4, 'Sam Okafor', 'sam@example.org', ['sam.okafor@work.example.org']),
	member(5, 'Riley Chen', 'riley@example.org'),
];

describe('searchSolidarityMembers', () => {
	it('returns [] for a blank query', () => {
		expect(searchSolidarityMembers(ROSTER, '')).toEqual([]);
		expect(searchSolidarityMembers(ROSTER, '   ')).toEqual([]);
	});

	it('matches names case-insensitively', () => {
		expect(searchSolidarityMembers(ROSTER, 'JORDAN').map((h) => h.id)).toContain(1);
	});

	it('ranks name prefixes above name substrings', () => {
		const ids = searchSolidarityMembers(ROSTER, 'jordan').map((h) => h.id);
		// Jordan Rivera and Jordana Blake start with the query; Alex Jordan only
		// contains it, so it must come last.
		expect(ids.indexOf(3)).toBe(ids.length - 1);
		expect(ids.slice(0, 2).sort()).toEqual([1, 2]);
	});

	it('sorts alphabetically within a rank band', () => {
		expect(
			searchSolidarityMembers(ROSTER, 'jordan')
				.slice(0, 2)
				.map((h) => h.label),
		).toEqual(['Jordan Rivera', 'Jordana Blake']);
	});

	it('ranks email matches below all name matches', () => {
		const roster = [
			member(1, 'Zeta Zulu', 'jordan@example.org'),
			member(2, 'Jordan Ali', 'a@b.org'),
		];
		expect(searchSolidarityMembers(roster, 'jordan').map((h) => h.id)).toEqual([2, 1]);
	});

	it('matches on email', () => {
		expect(searchSolidarityMembers(ROSTER, 'riley@').map((h) => h.id)).toEqual([5]);
	});

	it('matches on an alternate email', () => {
		expect(searchSolidarityMembers(ROSTER, 'work.example').map((h) => h.id)).toEqual([4]);
	});

	// The invariant that keeps the server-side match and the client-side
	// re-filter in AutocompletePicker in agreement.
	it('returns the email that matched, not always the primary', () => {
		const [hit] = searchSolidarityMembers(ROSTER, 'sam.okafor');
		expect(hit!.sublabel).toBe('sam.okafor@work.example.org');
	});

	it('uses the primary email as the sublabel for a name match', () => {
		const [hit] = searchSolidarityMembers(ROSTER, 'Riley');
		expect(hit!.sublabel).toBe('riley@example.org');
	});

	it('falls back to the Solidarity id when a member has no email', () => {
		const [hit] = searchSolidarityMembers([member(9, 'No Email')], 'no email');
		expect(hit!.sublabel).toBe('Solidarity ID 9');
	});

	it('never returns the same member twice when name and email both match', () => {
		const roster = [member(1, 'Jordan', 'jordan@example.org')];
		expect(searchSolidarityMembers(roster, 'jordan')).toHaveLength(1);
	});

	it('honors the limit', () => {
		const roster = Array.from({ length: 100 }, (_, i) => member(i, `Test Person ${i}`));
		expect(searchSolidarityMembers(roster, 'test')).toHaveLength(25);
		expect(searchSolidarityMembers(roster, 'test', 3)).toHaveLength(3);
	});

	it('returns [] when nothing matches', () => {
		expect(searchSolidarityMembers(ROSTER, 'zzzznomatch')).toEqual([]);
	});

	it('tolerates entries with missing email fields', () => {
		const roster = [{ id: 1, name: 'Partial' } as unknown as SolidarityMemberEntry];
		expect(() => searchSolidarityMembers(roster, 'partial')).not.toThrow();
		expect(searchSolidarityMembers(roster, 'partial')).toHaveLength(1);
	});
});
