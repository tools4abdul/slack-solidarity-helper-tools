import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from './+server.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockComputeDiff = vi.hoisted(() => vi.fn());
const mockSetProperty = vi.hoisted(() => vi.fn());
const mockInvite = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({
	slack: { conversations: { invite: mockInvite } },
}));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/coalition-reconcile', () => ({ computeCoalitionDiff: mockComputeDiff }));
vi.mock('$lib/server/solidarity', () => ({ setUserCustomProperty: mockSetProperty }));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function getEvent(session: typeof authed | typeof nonAdmin, group: string | null) {
	const url = new URL('http://localhost/api/settings/coalitions/reconcile');
	if (group !== null) url.searchParams.set('group', group);
	return { ...session, url };
}

function postEvent(session: typeof authed | typeof nonAdmin, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

const LABOR_ENTRY = { group: 'labor', channelId: 'C_LABOR', name: 'Labor Unions', userListId: 42 };

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadSettings.mockResolvedValue({
		coalitionChannelMap: [
			LABOR_ENTRY,
			{ group: 'clergy', channelId: 'C_CLERGY', name: 'Clergy', userListId: null },
		],
	});
	mockComputeDiff.mockResolvedValue({
		toMark: [],
		toInvite: [],
		noAccount: [],
		notInSlack: [],
		consistentCount: 5,
		noEmailCount: 0,
	});
	mockSetProperty.mockResolvedValue(undefined);
	mockInvite.mockResolvedValue({ ok: true });
});

describe('GET /api/settings/coalitions/reconcile', () => {
	it('gates non-admins', async () => {
		expect((await GET(getEvent(nonAdmin, 'labor') as never)).status).toBe(403);
		expect(mockComputeDiff).not.toHaveBeenCalled();
	});

	it('400 without group, 404 for an unknown group', async () => {
		expect((await GET(getEvent(authed, null) as never)).status).toBe(400);
		expect((await GET(getEvent(authed, 'ghosts') as never)).status).toBe(404);
	});

	it('409 when the coalition has no user list configured', async () => {
		const res = await GET(getEvent(authed, 'clergy') as never);
		expect(res.status).toBe(409);
		expect(mockComputeDiff).not.toHaveBeenCalled();
	});

	it('computes the diff with the entry’s channel and list', async () => {
		const res = await GET(getEvent(authed, 'labor') as never);
		expect(res.status).toBe(200);
		expect(mockComputeDiff).toHaveBeenCalledWith(
			expect.objectContaining({ token: 'tok', channelId: 'C_LABOR', userListId: 42 }),
		);
		expect(await res.json()).toMatchObject({ consistentCount: 5 });
	});

	it('502 with the reason when the diff fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockComputeDiff.mockRejectedValueOnce(new Error('slack down'));
		const res = await GET(getEvent(authed, 'labor') as never);
		expect(res.status).toBe(502);
		expect((await res.json()).error).toMatch(/slack down/);
	});
});

describe('POST /api/settings/coalitions/reconcile', () => {
	it('validates body shape', async () => {
		for (const body of [
			{ action: 'mark', targets: [{}] }, // no group
			{ group: 'labor', action: 'promote', targets: [{}] }, // bad action
			{ group: 'labor', action: 'mark', targets: [] }, // empty targets
			{ group: 'labor', action: 'mark' }, // missing targets
		]) {
			expect((await POST(postEvent(authed, body) as never)).status).toBe(400);
		}
		expect(mockSetProperty).not.toHaveBeenCalled();
	});

	it('mark: sets the coalition property per target with per-target results', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockSetProperty
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('solidarity 500'));

		const res = await POST(
			postEvent(authed, {
				group: 'labor',
				action: 'mark',
				targets: [
					{ solidarityUserId: 1, email: 'a@x.com' },
					{ solidarityUserId: 2, email: 'b@x.com' },
					{ email: 'c@x.com' }, // missing id → per-target failure, not a 400
				],
			}) as never,
		);

		expect(res.status).toBe(200);
		expect(mockSetProperty).toHaveBeenCalledWith('tok', 1, 'labor', 'true');
		expect(mockSetProperty).toHaveBeenCalledWith('tok', 2, 'labor', 'true');
		expect((await res.json()).results).toEqual([
			{ email: 'a@x.com', ok: true },
			{ email: 'b@x.com', ok: false, error: expect.stringMatching(/solidarity 500/) },
			{ email: 'c@x.com', ok: false, error: 'missing solidarityUserId' },
		]);
	});

	it('invite: sends one batched call for the whole set', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockInvite.mockResolvedValueOnce({ ok: true });

		const res = await POST(
			postEvent(authed, {
				group: 'labor',
				action: 'invite',
				targets: [
					{ slackUserId: 'U_A', email: 'a@x.com' },
					{ slackUserId: 'U_B', email: 'b@x.com' },
				],
			}) as never,
		);

		expect(res.status).toBe(200);
		expect(mockInvite).toHaveBeenCalledTimes(1);
		expect(mockInvite).toHaveBeenCalledWith({ channel: 'C_LABOR', users: 'U_A,U_B' });
		expect((await res.json()).results).toEqual([
			{ email: 'a@x.com', ok: true },
			{ email: 'b@x.com', ok: true },
		]);
	});

	it('invite: retries a failed batch per person, and already_in_channel counts as success', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockInvite
			// Slack reports a partial failure as one error for the whole call, so
			// the batch tells us nothing about who actually got in.
			.mockRejectedValueOnce(new Error('already_in_channel'))
			.mockResolvedValueOnce({ ok: true })
			.mockRejectedValueOnce(new Error('already_in_channel'));

		const res = await POST(
			postEvent(authed, {
				group: 'labor',
				action: 'invite',
				targets: [
					{ slackUserId: 'U_A', email: 'a@x.com' },
					{ slackUserId: 'U_B', email: 'b@x.com' },
				],
			}) as never,
		);

		expect(res.status).toBe(200);
		expect(mockInvite).toHaveBeenCalledWith({ channel: 'C_LABOR', users: 'U_A' });
		expect(mockInvite).toHaveBeenCalledWith({ channel: 'C_LABOR', users: 'U_B' });
		expect((await res.json()).results).toEqual([
			{ email: 'a@x.com', ok: true },
			{ email: 'b@x.com', ok: true },
		]);
	});

	it('invite: a genuinely failing person does not mark the rest failed', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInvite
			.mockRejectedValueOnce(new Error('user_not_found'))
			.mockResolvedValueOnce({ ok: true })
			.mockRejectedValueOnce(new Error('user_not_found'));

		const res = await POST(
			postEvent(authed, {
				group: 'labor',
				action: 'invite',
				targets: [
					{ slackUserId: 'U_A', email: 'a@x.com' },
					{ slackUserId: 'U_GONE', email: 'gone@x.com' },
				],
			}) as never,
		);

		expect((await res.json()).results).toEqual([
			{ email: 'a@x.com', ok: true },
			{ email: 'gone@x.com', ok: false, error: 'user_not_found' },
		]);
	});

	it('404 for an unknown group', async () => {
		const res = await POST(
			postEvent(authed, {
				group: 'ghosts',
				action: 'mark',
				targets: [{ solidarityUserId: 1, email: 'a@x.com' }],
			}) as never,
		);
		expect(res.status).toBe(404);
	});
});
