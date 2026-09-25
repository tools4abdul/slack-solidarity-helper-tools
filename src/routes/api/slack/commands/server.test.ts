import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { POST } from './+server.js';

const mockViewsOpen = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockFindInfoCommand = vi.hoisted(() => vi.fn());
const mockListInfoCommands = vi.hoisted(() => vi.fn());
const mockLoadUserToken = vi.hoisted(() => vi.fn());
const mockChannelNameToId = vi.hoisted(() => vi.fn());
// Captures the token each per-request WebClient is constructed with, which is
// the whole point of the info-command path: it must be the user's, not the bot's.
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockWebClientCtor = vi.hoisted(() => vi.fn());
const mockTurfListMessage = vi.hoisted(() => vi.fn());
const mockRespondToSlack = vi.hoisted(() => vi.fn());
const mockPostToResponseUrl = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({ slack: { views: { open: mockViewsOpen } } }));
vi.mock('$lib/server/settings', () => ({
	loadSettings: mockLoadSettings,
	findInfoCommand: mockFindInfoCommand,
	listInfoCommands: mockListInfoCommands,
}));
vi.mock('$lib/server/user-tokens', () => ({ loadUserToken: mockLoadUserToken }));
vi.mock('$lib/server/slack-channel-names', () => ({ channelNameToId: mockChannelNameToId }));
vi.mock('@slack/web-api', () => ({
	WebClient: class {
		chat = { postMessage: mockPostMessage };
		constructor(token: string) {
			mockWebClientCtor(token);
		}
	},
}));
vi.mock('$lib/server/van/turf-slack', () => ({ turfListMessage: mockTurfListMessage }));
vi.mock('$lib/server/slack-response-url', () => ({
	respondToSlack: mockRespondToSlack,
	postToResponseUrl: mockPostToResponseUrl,
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({
	SLACK_SIGNING_SECRET: 'test-signing-secret',
	SLACK_SUPERUSER_ID: 'U_SUPER',
	APP_URL: 'https://app.example.org',
}));

const SECRET = 'test-signing-secret';

function signedCommand(
	fields: Record<string, string>,
	opts: { secret?: string; ageSeconds?: number } = {},
) {
	const body = new URLSearchParams({
		command: '/member-note',
		user_id: 'U_ADMIN',
		trigger_id: 'trigger.123',
		channel_id: 'C_CHAN',
		text: '',
		...fields,
	}).toString();
	const secret = opts.secret ?? SECRET;
	const timestamp = Math.floor(Date.now() / 1000 - (opts.ageSeconds ?? 0)).toString();
	const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
	return new Request('http://localhost/api/slack/commands', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'x-slack-signature': sig,
			'x-slack-request-timestamp': timestamp,
		},
	});
}

const call = (request: Request) => POST({ request } as never);

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadSettings.mockResolvedValue({
		allowedSlackUserIds: new Set(['U_ADMIN']),
		moderatorSlackUserIds: new Set(['U_MOD']),
		warningDmMessage: 'This is your {{nth}} warning.',
	});
	mockViewsOpen.mockResolvedValue({ ok: true });
	mockFindInfoCommand.mockResolvedValue(null);
	mockListInfoCommands.mockResolvedValue([]);
	mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp-user-token' });
	mockChannelNameToId.mockResolvedValue(new Map([['phone-bank', 'C_PHONE']]));
	mockPostMessage.mockResolvedValue({ ok: true });
	mockTurfListMessage.mockResolvedValue({ text: 'Turf in Washtenaw County', blocks: [] });
	mockPostToResponseUrl.mockResolvedValue(true);
});

/** The /turfs reply is posted after the handler has returned, so tests have
 *  to let the detached promise settle before asserting on it. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('POST /api/slack/commands — signature', () => {
	it('rejects a request signed with the wrong secret', async () => {
		const res = await call(signedCommand({}, { secret: 'wrong' }));
		expect(res.status).toBe(401);
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});

	it('rejects a replayed request older than five minutes', async () => {
		const res = await call(signedCommand({}, { ageSeconds: 400 }));
		expect(res.status).toBe(401);
	});

	it('rejects a request with no signature headers', async () => {
		const res = await call(
			new Request('http://localhost/api/slack/commands', {
				method: 'POST',
				body: 'command=%2Fmember-note',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe('POST /api/slack/commands — authorization', () => {
	it('refuses a non-admin ephemerally without opening the modal', async () => {
		const res = await call(signedCommand({ user_id: 'U_RANDOM' }));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ response_type: 'ephemeral' });
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});

	it('allows an allowlisted admin', async () => {
		await call(signedCommand({ user_id: 'U_ADMIN' }));
		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	it('allows a moderator', async () => {
		await call(signedCommand({ user_id: 'U_MOD' }));
		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	// The superuser id comes from the environment, so a DB outage must not lock
	// the workspace owner out of moderation tooling.
	it('passes the superuser through the admin check when loadSettings throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));

		const res = await call(signedCommand({ user_id: 'U_SUPER' }));

		// They still can't get a modal (the template read is the same failing
		// call), but the failure they see is the DB one — not a refusal.
		const text = (await res.json()).text as string;
		expect(text).toContain('Could not open');
		expect(text).not.toContain('not authorized');
	});

	it('opens the modal for the superuser when the allowlist simply omits them', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set<string>(),
			moderatorSlackUserIds: new Set<string>(),
			warningDmMessage: '',
		});

		await call(signedCommand({ user_id: 'U_SUPER' }));

		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	it('fails closed for a non-superuser when loadSettings throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));

		const res = await call(signedCommand({ user_id: 'U_ADMIN' }));

		expect((await res.json()).text).toContain('not authorized');
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});
});

describe('POST /api/slack/commands — modal', () => {
	it('opens the modal with the payload’s trigger_id', async () => {
		await call(signedCommand({ trigger_id: 'trigger.abc' }));

		expect(mockViewsOpen).toHaveBeenCalledWith(
			expect.objectContaining({ trigger_id: 'trigger.abc' }),
		);
	});

	it('returns an empty 200 so no command echo appears in the channel', async () => {
		const res = await call(signedCommand({}));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('');
	});

	it('prefills the member from an escaped mention', async () => {
		await call(signedCommand({ text: '<@U0TARGET|jordan>' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const memberBlock = view.blocks.find((b: { block_id: string }) => b.block_id === 'member');
		expect(memberBlock.element.initial_user).toBe('U0TARGET');
	});

	it('opens unprefilled when the text has no escaped mention', async () => {
		await call(signedCommand({ text: 'jordan' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const memberBlock = view.blocks.find((b: { block_id: string }) => b.block_id === 'member');
		expect(memberBlock.element.initial_user).toBeUndefined();
	});

	it('carries the invoking channel and source through private_metadata', async () => {
		await call(signedCommand({ channel_id: 'C_HERE' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		expect(JSON.parse(view.private_metadata)).toEqual({ channelId: 'C_HERE', source: 'slash' });
	});

	it('reports an ephemeral error when views.open fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockViewsOpen.mockRejectedValue(new Error('trigger_id expired'));

		const res = await call(signedCommand({}));

		expect(res.status).toBe(200);
		expect((await res.json()).text).toContain('Could not open');
	});

	it('reports an unrecognized command when no info command matches', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFindInfoCommand.mockResolvedValue(null);

		const res = await call(signedCommand({ command: '/something-else' }));

		expect(mockViewsOpen).not.toHaveBeenCalled();
		expect(mockPostMessage).not.toHaveBeenCalled();
		const body = await res.json();
		expect(body.response_type).toBe('ephemeral');
		expect(body.text).toContain('Unrecognized command');
	});
});

// ---------------------------------------------------------------------------
// Admin-defined info commands
// ---------------------------------------------------------------------------

const INFO_ROW = {
	command: '/info-phone',
	message: 'Sign up here: #phone-bank',
};

const infoCall = (fields: Record<string, string> = {}) =>
	call(signedCommand({ command: '/info-phone', user_id: 'U_ADMIN', ...fields }));

describe('POST /api/slack/commands — info commands', () => {
	beforeEach(() => {
		mockFindInfoCommand.mockResolvedValue(INFO_ROW);
	});

	it('posts the message with the user token, not the bot token', async () => {
		const res = await infoCall();

		expect(res.status).toBe(200);
		expect(mockWebClientCtor).toHaveBeenCalledWith('xoxp-user-token');
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
		expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_CHAN' }));
	});

	it('resolves #channel tokens to real links before posting', async () => {
		await infoCall();
		expect(mockPostMessage.mock.calls[0][0].text).toBe('Sign up here: <#C_PHONE>');
	});

	it('returns an empty 200 so nothing extra is echoed into the channel', async () => {
		const res = await infoCall();
		expect(await res.text()).toBe('');
	});

	it('looks the command up in its normalized form', async () => {
		await infoCall();
		expect(mockFindInfoCommand).toHaveBeenCalledWith(expect.anything(), '/info-phone');
	});

	it('posts for a moderator, with their own token', async () => {
		await infoCall({ user_id: 'U_MOD' });

		expect(mockLoadUserToken).toHaveBeenCalledWith(expect.anything(), 'U_MOD');
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
	});

	it('refuses a non-admin without posting', async () => {
		const res = await infoCall({ user_id: 'U_RANDOM' });

		expect(mockPostMessage).not.toHaveBeenCalled();
		expect((await res.json()).response_type).toBe('ephemeral');
	});

	it('tells an admin with no stored token where to authorize', async () => {
		mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'missing' });

		const res = await infoCall();

		expect(mockPostMessage).not.toHaveBeenCalled();
		const text = (await res.json()).text as string;
		expect(text).toContain('https://app.example.org/auth/slack');
	});

	it('explains a pre-chat:write authorization specifically', async () => {
		// Distinguished from "missing" so someone who did log in isn't told to do
		// the thing they already did.
		mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'stale-scope' });

		const text = ((await (await infoCall()).json()) as { text: string }).text;
		expect(text).toContain('predates');
		expect(text).toContain('https://app.example.org/auth/slack');
	});

	it('turns not_in_channel into an instruction rather than a raw Slack error', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockPostMessage.mockRejectedValue(new Error('An API error occurred: not_in_channel'));

		const text = ((await (await infoCall()).json()) as { text: string }).text;
		expect(text).toContain('member of this channel');
	});

	it('tells the admin to re-authorize when Slack says the token was revoked', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockPostMessage.mockRejectedValue(new Error('An API error occurred: token_revoked'));

		const text = ((await (await infoCall()).json()) as { text: string }).text;
		expect(text).toContain('revoked');
	});

	it('surfaces an unexpected Slack error rather than failing silently', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockPostMessage.mockRejectedValue(new Error('ratelimited'));

		const text = ((await (await infoCall()).json()) as { text: string }).text;
		expect(text).toContain('ratelimited');
	});

	it('reports a lookup failure instead of claiming the command is unknown', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockFindInfoCommand.mockRejectedValue(new Error('db down'));

		const text = ((await (await infoCall()).json()) as { text: string }).text;
		expect(text).toContain('Could not look that command up');
	});

	it('still posts when the channel list is unavailable, leaving names literal', async () => {
		// channelNameToId swallows its own failures and returns an empty map; a
		// missing link must not cost the whole message.
		mockChannelNameToId.mockResolvedValue(new Map());

		await infoCall();

		expect(mockPostMessage.mock.calls[0][0].text).toBe('Sign up here: #phone-bank');
	});

	it('does not open the note modal', async () => {
		await infoCall();
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});
});

describe('POST /api/slack/commands — /list-commands', () => {
	const listCall = (fields: Record<string, string> = {}) =>
		call(signedCommand({ command: '/list-commands', user_id: 'U_ADMIN', ...fields }));

	beforeEach(() => {
		mockListInfoCommands.mockResolvedValue([
			{ command: '/info-canvass', message: 'Knock doors: #canvass' },
			INFO_ROW,
		]);
	});

	it('replies ephemerally with every command and its rendered message', async () => {
		const res = await listCall();

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response_type).toBe('ephemeral');
		expect(body.text).toContain('*/info-canvass*\n>Knock doors: #canvass');
		expect(body.text).toContain('*/info-phone*\n>Sign up here: <#C_PHONE>');
	});

	// Ephemeral is the whole point: the list goes back in the response body,
	// never through postMessage, so no one else in the channel sees it.
	it('posts nothing into the channel and needs no user token', async () => {
		await listCall();

		expect(mockPostMessage).not.toHaveBeenCalled();
		expect(mockLoadUserToken).not.toHaveBeenCalled();
	});

	it('is not treated as an info command lookup', async () => {
		await listCall();
		expect(mockFindInfoCommand).not.toHaveBeenCalled();
	});

	it('answers a moderator', async () => {
		const body = await (await listCall({ user_id: 'U_MOD' })).json();
		expect(body.text).toContain('*/info-phone*');
	});

	it('refuses a non-admin without reading the list', async () => {
		const res = await listCall({ user_id: 'U_RANDOM' });

		expect((await res.json()).text).toContain('not authorized');
		expect(mockListInfoCommands).not.toHaveBeenCalled();
	});

	it('says so when no commands exist, without fetching the channel list', async () => {
		mockListInfoCommands.mockResolvedValue([]);

		const text = ((await (await listCall()).json()) as { text: string }).text;

		expect(text).toBe('No info commands have been set up yet.');
		expect(mockChannelNameToId).not.toHaveBeenCalled();
	});

	it('answers a short list in the response body, without response_url', async () => {
		await listCall({ response_url: 'https://hooks.slack.test/list' });
		await flush();
		expect(mockPostToResponseUrl).not.toHaveBeenCalled();
	});

	describe('a list too long for one message', () => {
		beforeEach(() => {
			mockListInfoCommands.mockResolvedValue(
				Array.from({ length: 30 }, (_, i) => ({
					command: `/cmd-${String(i).padStart(2, '0')}`,
					message: 'x'.repeat(3000),
				})),
			);
		});

		// All of them through response_url, one after another: a first message in
		// the body could be overtaken by the follow-ups and land below them.
		it('posts every part through response_url, in order, and acks empty', async () => {
			const res = await listCall({ response_url: 'https://hooks.slack.test/list' });
			await flush();

			expect(await res.text()).toBe('');
			const posted = mockPostToResponseUrl.mock.calls.map((c) => {
				expect(c[0]).toBe('https://hooks.slack.test/list');
				return c[1].text as string;
			});
			expect(posted.length).toBeGreaterThan(1);
			expect(posted[0]).toMatch(/^30 info commands:/);
			expect(posted.join('\n\n').match(/^\*\/cmd-\d+\*$/gm)).toHaveLength(30);
		});

		it('waits for each part before sending the next', async () => {
			let release!: (ok: boolean) => void;
			mockPostToResponseUrl.mockImplementationOnce(
				() => new Promise<boolean>((resolve) => (release = resolve)),
			);

			await listCall({ response_url: 'https://hooks.slack.test/list' });
			await flush();
			expect(mockPostToResponseUrl).toHaveBeenCalledTimes(1);

			release(true);
			await flush();
			expect(mockPostToResponseUrl.mock.calls.length).toBeGreaterThan(1);
		});

		it('stops, and logs, when Slack refuses a part', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockPostToResponseUrl.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

			await listCall({ response_url: 'https://hooks.slack.test/list' });
			await flush();

			expect(mockPostToResponseUrl).toHaveBeenCalledTimes(2);
			expect(error).toHaveBeenCalledWith(expect.stringContaining('stopped at message 2'));
		});
	});

	it('reports a lookup failure ephemerally', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockListInfoCommands.mockRejectedValue(new Error('db down'));

		const body = await (await listCall()).json();

		expect(body.response_type).toBe('ephemeral');
		expect(body.text).toContain('Could not load the command list');
	});
});

describe('POST /api/slack/commands — /turfs', () => {
	const turfs = (fields: Record<string, string> = {}) =>
		signedCommand({
			command: '/turfs',
			user_id: 'U_VOL',
			channel_id: 'C_WASHTENAW',
			response_url: 'https://hooks.slack.test/response',
			...fields,
		});

	it('acknowledges inside Slack’s three-second budget', async () => {
		// The real work — a geocode, a cold Fly boot — cannot be relied on to
		// fit, so the ack goes first and the answer replaces it.
		const res = await call(turfs());
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			response_type: 'ephemeral',
			text: expect.stringContaining('Finding turf'),
		});
	});

	it('posts the turf list back through response_url, replacing the ack', async () => {
		await call(turfs());
		await flush();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			'https://hooks.slack.test/response',
			{ text: 'Turf in Washtenaw County', blocks: [] },
			expect.objectContaining({ replaceOriginal: true }),
		);
	});

	it('passes the typed location through', async () => {
		await call(turfs({ text: '100 N Main St, Ann Arbor MI' }));
		await flush();
		expect(mockTurfListMessage).toHaveBeenCalledWith(expect.anything(), {
			slackUserId: 'U_VOL',
			argument: '100 N Main St, Ann Arbor MI',
		});
	});

	// This is the only slash command open to non-admins, and the gates that do
	// apply live in turf-slack.ts. The route must not add an admin check of its
	// own, or the feature serves nobody it was built for.
	it('does not gate on the admin allowlist', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['U_ADMIN']),
			moderatorSlackUserIds: new Set(['U_MOD']),
		});
		await call(turfs({ user_id: 'U_RANDOM' }));
		await flush();
		expect(mockTurfListMessage).toHaveBeenCalled();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ text: 'Turf in Washtenaw County' }),
			expect.anything(),
		);
	});

	it('never reaches the info-command lookup', async () => {
		await call(turfs());
		await flush();
		expect(mockFindInfoCommand).not.toHaveBeenCalled();
	});

	it('still requires a valid signature', async () => {
		const res = await call(
			signedCommand({ command: '/turfs', user_id: 'U_VOL' }, { secret: 'wrong' }),
		);
		expect(res.status).toBe(401);
		expect(mockTurfListMessage).not.toHaveBeenCalled();
	});

	it('tells the volunteer something went wrong rather than failing silently', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockTurfListMessage.mockRejectedValue(new Error('turso is down'));
		await call(turfs());
		await flush();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			'https://hooks.slack.test/response',
			expect.objectContaining({ text: expect.stringContaining('Could not look up turf') }),
			expect.objectContaining({ replaceOriginal: true }),
		);
		error.mockRestore();
	});
});
