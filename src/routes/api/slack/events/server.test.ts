import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { POST, _verifySlackSignature as verifySlackSignature } from './+server.js';

// vi.mock factories are hoisted — use vi.hoisted() so the fn refs are ready.
const mockGetUserByEmail = vi.hoisted(() => vi.fn());
const mockConversationsInvite = vi.hoisted(() => vi.fn());
const mockConversationsOpen = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockOnConflictDoNothing = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInsertValues = vi.hoisted(() =>
	vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing })),
);
const mockInsert = vi.hoisted(() => vi.fn(() => ({ values: mockInsertValues })));
const mockLoadSettings = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/solidarity', () => ({ getUserByEmail: mockGetUserByEmail }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/autocomplete-sources', () => ({
	getSlackChannels: vi.fn(async () => ({ items: [], fetchedAt: 0 })),
}));
vi.mock('$lib/server/slack', () => ({
	slack: {
		users: { info: mockUsersInfo },
		conversations: {
			invite: mockConversationsInvite,
			open: mockConversationsOpen,
		},
		chat: { postMessage: mockPostMessage },
	},
}));
vi.mock('$lib/server/db', () => ({ db: { insert: mockInsert } }));
vi.mock('$lib/server/env', () => ({
	SLACK_SIGNING_SECRET: 'test-signing-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
}));

// --- Helpers ---

const SECRET = 'test-signing-secret';

function makeSignedRequest(body: string, opts: { secret?: string; ageSeconds?: number } = {}) {
	const secret = opts.secret ?? SECRET;
	const timestamp = Math.floor(Date.now() / 1000 - (opts.ageSeconds ?? 0)).toString();
	const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
	return new Request('http://localhost/api/slack/events', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'x-slack-signature': sig,
			'x-slack-request-timestamp': timestamp,
		},
	});
}

function teamJoinPayload(userId = 'U_NEW') {
	return JSON.stringify({
		type: 'event_callback',
		event: { type: 'team_join', user: { id: userId } },
	});
}

// The DM is the last Slack call the handler makes — waiting on it confirms the
// fire-and-forget handler has fully completed.
function waitForDm() {
	return vi.waitFor(() =>
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channel: 'DM_CHANNEL' }),
		),
	);
}

// --- Tests ---

describe('verifySlackSignature', () => {
	it('returns true for a valid signature', async () => {
		const body = '{"type":"url_verification"}';
		const req = makeSignedRequest(body);
		expect(await verifySlackSignature(req, body)).toBe(true);
	});

	it('returns false when signature is missing', async () => {
		const req = new Request('http://localhost', {
			method: 'POST',
			body: '{}',
			headers: { 'x-slack-request-timestamp': '12345' },
		});
		expect(await verifySlackSignature(req, '{}')).toBe(false);
	});

	it('returns false when timestamp is missing', async () => {
		const req = new Request('http://localhost', {
			method: 'POST',
			body: '{}',
			headers: { 'x-slack-signature': 'v0=abc' },
		});
		expect(await verifySlackSignature(req, '{}')).toBe(false);
	});

	it('returns false for a replay attack (timestamp > 5 min old)', async () => {
		const body = '{}';
		const req = makeSignedRequest(body, { ageSeconds: 301 });
		expect(await verifySlackSignature(req, body)).toBe(false);
	});

	it('returns false when secret is wrong', async () => {
		const body = '{}';
		const req = makeSignedRequest(body, { secret: 'wrong-secret' });
		expect(await verifySlackSignature(req, body)).toBe(false);
	});
});

describe('POST /api/slack/events', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUsersInfo.mockResolvedValue({ user: { profile: { email: 'new@example.com' } } });
		mockConversationsInvite.mockResolvedValue({ ok: true });
		mockConversationsOpen.mockResolvedValue({ channel: { id: 'DM_CHANNEL' } });
		mockPostMessage.mockResolvedValue({ ok: true });
		mockLoadSettings.mockResolvedValue({
			chapterChannelMap: [{ chapterId: 42, channelId: 'C_COUNTY', name: 'Test County' }],
			welcomeDisabledChannelIds: new Set<string>(),
			welcomeDmMessage: '',
		});
	});

	it('returns 401 for an invalid signature', async () => {
		const req = makeSignedRequest('{}', { secret: 'wrong' });
		const res = await POST({ request: req } as never);
		expect(res.status).toBe(401);
	});

	it('responds to the url_verification challenge', async () => {
		const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
		const res = await POST({ request: makeSignedRequest(body) } as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ challenge: 'abc123' });
	});

	it('returns 200 for unknown event types without calling Slack', async () => {
		const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
		const res = await POST({ request: makeSignedRequest(body) } as never);
		expect(res.status).toBe(200);
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('ignores file_change events, which nothing watches any more', async () => {
		// The Openfield canvas watcher lived here and retired with it (Story 9).
		// Kept as a test rather than deleted outright: Slack will go on sending
		// these while the event subscription exists, and they must stay a quiet
		// 200 rather than an unhandled branch.
		const body = JSON.stringify({
			type: 'event_callback',
			event: { type: 'file_change', file_id: 'F0B3E3SNU01' },
		});
		const res = await POST({ request: makeSignedRequest(body) } as never);
		expect(res.status).toBe(200);
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('invites user to county channel and sends DM on team_join', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });

		const res = await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		expect(res.status).toBe(200);

		// Wait for the entire async fire-and-forget handler to complete (the DM is last)
		await waitForDm();

		expect(mockUsersInfo).toHaveBeenCalledWith({ user: 'U_NEW' });
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_COUNTY', users: 'U_NEW' });
		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U_NEW' });
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channel: 'DM_CHANNEL' }),
		);
	});

	it('posts a creative welcome mentioning the user in the chapter channel', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await waitForDm();

		const channelCall = mockPostMessage.mock.calls.find((c) => c[0]?.channel === 'C_COUNTY');
		expect(channelCall).toBeDefined();
		expect(channelCall![0].text).toContain('<@U_NEW>');
	});

	it('invites to every channel mapped to the chapter, deduped across chapters', async () => {
		// Chapter 42 maps to two channels; chapters 42 and 43 share C_SHARED,
		// which must be invited only once.
		mockLoadSettings.mockResolvedValue({
			chapterChannelMap: [
				{ chapterId: 42, channelId: 'C_COUNTY', name: 'Test County' },
				{ chapterId: 42, channelId: 'C_SHARED', name: 'Test County' },
				{ chapterId: 43, channelId: 'C_SHARED', name: 'Other County' },
			],
			welcomeDisabledChannelIds: new Set<string>(),
			welcomeDmMessage: '',
		});
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42, 43] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await waitForDm();

		expect(mockConversationsInvite).toHaveBeenCalledTimes(2);
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_COUNTY', users: 'U_NEW' });
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_SHARED', users: 'U_NEW' });
	});

	it('still invites but skips the channel welcome post for welcome-disabled channels', async () => {
		mockLoadSettings.mockResolvedValue({
			chapterChannelMap: [
				{ chapterId: 42, channelId: 'C_COUNTY', name: 'Test County' },
				{ chapterId: 42, channelId: 'C_QUIET', name: 'Test County' },
			],
			welcomeDisabledChannelIds: new Set(['C_QUIET']),
			welcomeDmMessage: '',
		});
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await waitForDm();

		// Invited to both channels…
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_COUNTY', users: 'U_NEW' });
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_QUIET', users: 'U_NEW' });
		// …but the welcome post only lands in the non-disabled channel.
		const welcomeChannels = mockPostMessage.mock.calls
			.map((c) => (c[0] as { channel: string }).channel)
			.filter((ch) => ch !== 'DM_CHANNEL');
		expect(welcomeChannels).toEqual(['C_COUNTY']);
		// The DM still mentions both channels.
		const dmCall = mockPostMessage.mock.calls.find(
			(c) => (c[0] as { channel: string }).channel === 'DM_CHANNEL',
		);
		expect((dmCall![0] as { text: string }).text).toContain('<#C_QUIET>');
	});

	it('falls back to chapter_id when chapter_ids is empty', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: 42, chapter_ids: [] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await waitForDm();

		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_COUNTY', users: 'U_NEW' });
	});

	it('does nothing when users.info returns no email', async () => {
		mockUsersInfo.mockResolvedValue({ user: { profile: {} } });
		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await new Promise((r) => setTimeout(r, 10));
		expect(mockGetUserByEmail).not.toHaveBeenCalled();
	});

	it('does nothing when user is not in solidarity', async () => {
		mockGetUserByEmail.mockResolvedValue(null);
		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await new Promise((r) => setTimeout(r, 10));
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('does nothing when no channel is mapped for the user chapters', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [999] });
		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await new Promise((r) => setTimeout(r, 10));
		expect(mockConversationsInvite).not.toHaveBeenCalled();
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it('records the slack_join row on a happy-path team_join', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await waitForDm();

		expect(mockInsertValues).toHaveBeenCalledWith({
			slackUserId: 'U_NEW',
			email: 'new@example.com',
			joinedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			chapterIds: JSON.stringify([42]),
		});
		expect(mockOnConflictDoNothing).toHaveBeenCalledOnce();
	});

	it('still records the slack_join row when no channel is mapped', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [999] });

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await vi.waitFor(() => expect(mockInsertValues).toHaveBeenCalledOnce());

		expect(mockInsertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				slackUserId: 'U_NEW',
				email: 'new@example.com',
				chapterIds: JSON.stringify([999]),
			}),
		);
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('skips DM when all channel invites fail', async () => {
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });
		mockConversationsInvite.mockRejectedValue(new Error('already_in_channel'));

		await POST({ request: makeSignedRequest(teamJoinPayload()) } as never);
		await new Promise((r) => setTimeout(r, 10));
		expect(mockPostMessage).not.toHaveBeenCalled();
	});
});
