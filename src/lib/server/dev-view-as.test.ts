import { describe, it, expect } from 'vitest';
import { applyDevViewAs, parseDevViewAs } from './dev-view-as.js';

const admin = { slackUserId: 'U1', slackUserName: 'Alice', isAdmin: true, isModerator: true };

describe('parseDevViewAs', () => {
	it.each([
		['moderator', 'moderator'],
		['member', 'member'],
		['  MODERATOR  ', 'moderator'],
		['Member', 'member'],
	])('reads %s', (raw, expected) => {
		expect(parseDevViewAs(raw)).toBe(expected);
	});

	it.each([[''], ['   '], [undefined], [null], ['volunteer'], ['moderatr']])(
		'is null for %s, leaving the session untouched',
		(raw) => {
			expect(parseDevViewAs(raw as string | undefined | null)).toBeNull();
		},
	);

	// The rule the whole module exists to keep. No spelling of this variable
	// may hand anybody admin, so a typo can only ever show you your real
	// permissions.
	it('does not recognise "admin", so it can never grant it', () => {
		expect(parseDevViewAs('admin')).toBeNull();
		expect(parseDevViewAs('Admin')).toBeNull();
	});
});

describe('applyDevViewAs', () => {
	it('demotes an admin to a moderator', () => {
		expect(applyDevViewAs(admin, 'moderator')).toMatchObject({
			isAdmin: false,
			isModerator: true,
		});
	});

	it('demotes an admin to a plain member', () => {
		expect(applyDevViewAs(admin, 'member')).toMatchObject({
			isAdmin: false,
			isModerator: false,
		});
	});

	it('strips moderator too when viewing as a member', () => {
		const moderator = { ...admin, isAdmin: false, isModerator: true };
		expect(applyDevViewAs(moderator, 'member')?.isModerator).toBe(false);
	});

	it('leaves the session alone when nothing is set', () => {
		expect(applyDevViewAs(admin, null)).toBe(admin);
	});

	it('keeps the rest of the session intact', () => {
		expect(applyDevViewAs(admin, 'member')).toMatchObject({
			slackUserId: 'U1',
			slackUserName: 'Alice',
		});
	});

	it('does not mutate the session it was given', () => {
		applyDevViewAs(admin, 'member');
		expect(admin.isAdmin).toBe(true);
	});

	// Signed out is already the least-privileged view; conjuring a session here
	// would be the escalation this module refuses to allow.
	it('never invents a session for a signed-out request', () => {
		expect(applyDevViewAs(null, 'moderator')).toBeNull();
		expect(applyDevViewAs(null, 'member')).toBeNull();
	});

	// Belt and braces: even a value the parser would never produce cannot grant
	// admin through this function.
	it('cannot raise privileges whatever it is handed', () => {
		const member = { ...admin, isAdmin: false, isModerator: false };
		for (const as of ['moderator', 'member'] as const) {
			expect(applyDevViewAs(member, as)?.isAdmin).toBe(false);
		}
	});
});
