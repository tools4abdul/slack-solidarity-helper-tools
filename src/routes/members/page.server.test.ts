import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load } from './+page.server.js';
import { load as layoutLoad } from './+layout.server.js';
import type { MembersLayoutData } from './+layout.server.js';

const mockResolveMember = vi.hoisted(() => vi.fn());
const mockGetSlackUsers = vi.hoisted(() => vi.fn());
const mockGetSolidarityMembers = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/member-lookup', () => ({ resolveMember: mockResolveMember }));
vi.mock('$lib/server/autocomplete-sources', () => ({
	getSlackUsers: mockGetSlackUsers,
	getSolidarityMembers: mockGetSolidarityMembers,
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/solidarity', () => ({
	findUserByEmailStrict: vi.fn(),
	getRecentUserActions: vi.fn(),
	getRecentEventRsvps: vi.fn(),
}));
vi.mock('$lib/server/member-notes', () => ({ listNotes: vi.fn() }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));

const adminSession = { slackUserId: 'U_ADMIN', slackUserName: 'Admin', isAdmin: true };
const moderatorSession = {
	slackUserId: 'U_MOD',
	slackUserName: 'Mo',
	isAdmin: false,
	isModerator: true,
};

function event(session: unknown, user?: string) {
	return {
		locals: { session },
		url: new URL(`http://localhost/members${user ? `?user=${user}` : ''}`),
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockResolveMember.mockResolvedValue({ slack: { id: 'U0TARGET1' } });
	mockGetSlackUsers.mockResolvedValue({
		items: [{ id: 'U0TARGET1', name: 'jordan', realName: 'Jordan Rivera', email: 'j@example.org' }],
		stale: false,
		fetchedAt: 0,
	});
	mockGetSolidarityMembers.mockResolvedValue({ items: [], stale: false, fetchedAt: 0 });
});

describe('page load', () => {
	it.each([
		['no session', null],
		['a non-admin', { ...adminSession, isAdmin: false }],
	])('redirects %s to the dashboard', (_label, session) => {
		expect(() => load(event(session))).toThrow();
	});

	it('returns no member when ?user= is absent', () => {
		const data = load(event(adminSession)) as {
			member: unknown;
			selectedSlackUserId: string | null;
		};

		expect(data.member).toBeNull();
		expect(data.selectedSlackUserId).toBeNull();
		expect(mockResolveMember).not.toHaveBeenCalled();
	});

	it('resolves the member named in ?user=', () => {
		const data = load(event(adminSession, 'U0TARGET1')) as { selectedSlackUserId: string };

		expect(data.selectedSlackUserId).toBe('U0TARGET1');
		expect(mockResolveMember).toHaveBeenCalledWith(expect.anything(), 'U0TARGET1');
	});

	// Returned unawaited so SvelteKit streams it and the shell renders at once.
	it('returns the member as an unawaited promise', () => {
		const data = load(event(adminSession, 'U0TARGET1')) as { member: Promise<unknown> };
		expect(data.member).toBeInstanceOf(Promise);
	});

	it('sets the page title', () => {
		expect((load(event(adminSession)) as { pageTitle: string }).pageTitle).toBe('Volunteer lookup');
	});

	// The Slack "View member record" shortcut links moderators here.
	it('lets a moderator look a member up, without the linking controls', () => {
		const data = load(event(moderatorSession, 'U0TARGET1')) as { canLink: boolean };

		expect(mockResolveMember).toHaveBeenCalledWith(expect.anything(), 'U0TARGET1');
		expect(data.canLink).toBe(false);
	});

	it('gives an admin the linking controls', () => {
		expect((load(event(adminSession)) as { canLink: boolean }).canLink).toBe(true);
	});
});

describe('layout load', () => {
	it.each([
		['no session', null],
		['a non-admin', { ...adminSession, isAdmin: false }],
	])('redirects %s', async (_label, session) => {
		await expect(layoutLoad(event(session))).rejects.toBeDefined();
	});

	it('admits a moderator', async () => {
		const data = (await layoutLoad(event(moderatorSession))) as MembersLayoutData;
		expect(data.slackUsers).toHaveLength(1);
	});

	it('maps Slack users into picker items', async () => {
		const data = (await layoutLoad(event(adminSession))) as MembersLayoutData;

		expect(data.slackUsers).toEqual([
			{ id: 'U0TARGET1', label: 'jordan', sublabel: 'Jordan Rivera' },
		]);
		expect(data.slackUsersError).toBeUndefined();
	});

	it('falls back to the email as a sublabel when there is no real name', async () => {
		mockGetSlackUsers.mockResolvedValue({
			items: [{ id: 'U1', name: 'x', realName: '', email: 'x@example.org' }],
			stale: false,
			fetchedAt: 0,
		});

		const data = (await layoutLoad(event(adminSession))) as MembersLayoutData;

		expect(data.slackUsers[0]!.sublabel).toBe('x@example.org');
	});

	it('degrades to an error message when the Slack list is unavailable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockGetSlackUsers.mockRejectedValue(new Error('slack down'));

		const data = (await layoutLoad(event(adminSession))) as MembersLayoutData;

		expect(data.slackUsers).toEqual([]);
		expect(data.slackUsersError).toContain('unavailable');
	});

	it('surfaces the stale flag', async () => {
		mockGetSlackUsers.mockResolvedValue({ items: [], stale: true, fetchedAt: 0 });
		expect(((await layoutLoad(event(adminSession))) as MembersLayoutData).slackUsersStale).toBe(
			true,
		);
	});

	it('prewarms the Solidarity roster', async () => {
		await layoutLoad(event(adminSession));
		expect(mockGetSolidarityMembers).toHaveBeenCalledWith('tok');
	});

	// The prewarm is an optimization; the search endpoint reports its own
	// failures, so a rejection here must not break the page.
	it('does not fail the load when the roster prewarm rejects', async () => {
		mockGetSolidarityMembers.mockRejectedValue(new Error('cold'));

		await expect(layoutLoad(event(adminSession))).resolves.toBeDefined();
	});
});
