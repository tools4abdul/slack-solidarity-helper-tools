import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { POST } from './+server.js';
import { BLOCK } from '$lib/server/slack-modal.js';
import {
	encodeTurfAction,
	TURF_CLAIM_ACTION_ID,
	TURF_PAGE_ACTION_ID,
	TURF_RELEASE_ACTION_ID,
} from '$lib/server/van/turf-command.js';

const mockViewsOpen = vi.hoisted(() => vi.fn());
const mockViewsUpdate = vi.hoisted(() => vi.fn());
const mockConversationsOpen = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockPostEphemeral = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockInsertNote = vi.hoisted(() => vi.fn());
const mockRecordDmOutcome = vi.hoisted(() => vi.fn());
const mockChannelNameToId = vi.hoisted(() => vi.fn());
const mockClaimFromSlack = vi.hoisted(() => vi.fn());
const mockReleaseFromSlack = vi.hoisted(() => vi.fn());
const mockTurfListMessage = vi.hoisted(() => vi.fn());
const mockRespondToSlack = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({
	slack: {
		views: { open: mockViewsOpen, update: mockViewsUpdate },
		conversations: { open: mockConversationsOpen },
		chat: { postMessage: mockPostMessage, postEphemeral: mockPostEphemeral },
		users: { info: mockUsersInfo },
	},
}));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/member-notes', () => ({
	insertNote: mockInsertNote,
	recordDmOutcome: mockRecordDmOutcome,
}));
vi.mock('$lib/server/slack-channel-names', () => ({ channelNameToId: mockChannelNameToId }));
vi.mock('$lib/server/van/turf-slack', () => ({
	claimFromSlack: mockClaimFromSlack,
	releaseFromSlack: mockReleaseFromSlack,
	turfListMessage: mockTurfListMessage,
}));
vi.mock('$lib/server/slack-response-url', () => ({ respondToSlack: mockRespondToSlack }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({
	SLACK_SIGNING_SECRET: 'test-signing-secret',
	SLACK_SUPERUSER_ID: 'U_SUPER',
	APP_URL: 'https://app.example.test',
}));

const SECRET = 'test-signing-secret';

function signedPayload(payload: unknown, opts: { secret?: string } = {}) {
	const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
	const secret = opts.secret ?? SECRET;
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
	return new Request('http://localhost/api/slack/interactivity', {
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

/** Detached work (the DM path, response_url posts) runs after the response. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function submissionPayload(
	over: Record<string, unknown> = {},
	values: Record<string, unknown> = {},
) {
	return {
		type: 'view_submission',
		user: { id: 'U_ADMIN' },
		view: {
			callback_id: 'member_note_modal',
			private_metadata: JSON.stringify({ channelId: 'C_CHAN', source: 'slash' }),
			state: {
				values: {
					[BLOCK.member]: { value: { selected_user: 'U_TARGET' } },
					[BLOCK.kind]: { value: { selected_option: { value: 'note' } } },
					[BLOCK.body]: { value: { value: 'Some details' } },
					[BLOCK.link]: { value: { value: '' } },
					[BLOCK.warningText]: { value: { value: '' } },
					[BLOCK.dm]: { value: { selected_options: [] } },
					...values,
				},
			},
		},
		...over,
	};
}

const warningValues = (over: Record<string, unknown> = {}) => ({
	[BLOCK.kind]: { value: { selected_option: { value: 'warning' } } },
	[BLOCK.warningText]: { value: { value: 'This is your {{nth}} warning.' } },
	[BLOCK.dm]: { value: { selected_options: [{ value: 'send' }] } },
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadSettings.mockResolvedValue({
		allowedSlackUserIds: new Set(['U_ADMIN']),
		moderatorSlackUserIds: new Set(['U_MOD']),
		warningDmMessage: 'This is your {{nth}} warning.',
		slackMemberNoteChannelId: 'C_ADMIN_LOG',
	});
	mockViewsOpen.mockResolvedValue({ ok: true });
	mockViewsUpdate.mockResolvedValue({ ok: true });
	mockInsertNote.mockResolvedValue({ id: 7, warningNumber: null });
	mockRecordDmOutcome.mockResolvedValue(undefined);
	mockChannelNameToId.mockResolvedValue(new Map());
	mockConversationsOpen.mockResolvedValue({ channel: { id: 'D_TARGET' } });
	mockPostMessage.mockResolvedValue({ ok: true });
	mockPostEphemeral.mockResolvedValue({ ok: true });
	mockUsersInfo.mockResolvedValue({ user: { profile: { display_name: 'Admin Person' } } });
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('signature', () => {
	it('rejects a bad signature', async () => {
		const res = await call(signedPayload({ type: 'message_action' }, { secret: 'wrong' }));
		expect(res.status).toBe(401);
	});

	it('acknowledges an unparseable payload without erroring', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const body = new URLSearchParams({ payload: 'not json' }).toString();
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
		const res = await call(
			new Request('http://localhost/api/slack/interactivity', {
				method: 'POST',
				body,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'x-slack-signature': sig,
					'x-slack-request-timestamp': timestamp,
				},
			}),
		);
		expect(res.status).toBe(200);
	});

	it('acknowledges unknown payload types (view_closed and friends)', async () => {
		const res = await call(signedPayload({ type: 'view_closed' }));
		expect(res.status).toBe(200);
	});
});

describe('log_member_note shortcut', () => {
	const shortcut = (over: Record<string, unknown> = {}) => ({
		type: 'message_action',
		callback_id: 'log_member_note',
		trigger_id: 'trigger.abc',
		response_url: 'https://hooks.slack.test/r/1',
		user: { id: 'U_ADMIN' },
		team: { domain: 'myworkspace' },
		channel: { id: 'C_CHAN' },
		message: { user: 'U_TARGET', ts: '1712345678.123456' },
		...over,
	});

	it('prefills both the member and the message link', async () => {
		await call(signedPayload(shortcut()));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const byId = (id: string) => view.blocks.find((b: { block_id: string }) => b.block_id === id);
		expect(byId('member').element.initial_user).toBe('U_TARGET');
		expect(byId('link').element.initial_value).toBe(
			'https://myworkspace.slack.com/archives/C_CHAN/p1712345678123456',
		);
	});

	// A getPermalink call would sit in front of a trigger_id that expires in
	// about three seconds, and the payload already has everything needed.
	it('builds the permalink without any extra Slack call', async () => {
		await call(signedPayload(shortcut()));
		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it('adds the thread suffix for a threaded reply', async () => {
		await call(
			signedPayload(
				shortcut({
					message: { user: 'U_T', ts: '1712345999.000100', thread_ts: '1712345678.123456' },
				}),
			),
		);

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const link = view.blocks.find((b: { block_id: string }) => b.block_id === 'link');
		expect(link.element.initial_value).toContain('thread_ts=1712345678.123456');
	});

	it('opens unprefilled for a bot message with no author', async () => {
		await call(signedPayload(shortcut({ message: { bot_id: 'B1', ts: '1712345678.123456' } })));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const member = view.blocks.find((b: { block_id: string }) => b.block_id === 'member');
		expect(member.element.initial_user).toBeUndefined();
	});

	it('leaves the link blank when the team domain is missing', async () => {
		await call(signedPayload(shortcut({ team: {} })));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const link = view.blocks.find((b: { block_id: string }) => b.block_id === 'link');
		expect(link.element.initial_value).toBeUndefined();
	});

	it('opens the modal for a moderator', async () => {
		await call(signedPayload(shortcut({ user: { id: 'U_MOD' } })));
		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	it('refuses a non-admin via response_url and opens nothing', async () => {
		await call(signedPayload(shortcut({ user: { id: 'U_RANDOM' } })));
		await flush();

		expect(mockViewsOpen).not.toHaveBeenCalled();
		const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(url).toBe('https://hooks.slack.test/r/1');
		expect(JSON.parse((init as { body: string }).body).text).toContain('not authorized');
	});
});

describe('view_member_record shortcut', () => {
	const shortcut = (over: Record<string, unknown> = {}) => ({
		type: 'message_action',
		callback_id: 'view_member_record',
		response_url: 'https://hooks.slack.test/r/2',
		user: { id: 'U_ADMIN' },
		channel: { id: 'C_CHAN' },
		message: { user: 'U_TARGET', ts: '1712345678.123456' },
		...over,
	});

	it('posts a link button pointing at that member’s page', async () => {
		const res = await call(signedPayload(shortcut()));
		await flush();

		expect(res.status).toBe(200);
		const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
		const posted = JSON.parse((init as { body: string }).body);
		expect(posted.blocks[0].accessory.url).toBe('https://app.example.test/members?user=U_TARGET');
	});

	it('explains itself on a bot message rather than linking nowhere', async () => {
		await call(signedPayload(shortcut({ message: { bot_id: 'B1' } })));
		await flush();

		const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
		const posted = JSON.parse((init as { body: string }).body);
		expect(posted.text).toContain("Couldn't identify");
		expect(posted.blocks).toBeUndefined();
	});

	it('gives a moderator the link too', async () => {
		await call(signedPayload(shortcut({ user: { id: 'U_MOD' } })));
		await flush();

		const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
		const posted = JSON.parse((init as { body: string }).body);
		expect(posted.blocks[0].accessory.url).toBe('https://app.example.test/members?user=U_TARGET');
	});

	it('refuses a non-admin', async () => {
		await call(signedPayload(shortcut({ user: { id: 'U_RANDOM' } })));
		await flush();

		const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
		expect(JSON.parse((init as { body: string }).body).text).toContain('not authorized');
	});
});

describe('block_actions — Note/Warning toggle', () => {
	const toggle = (values: Record<string, unknown>) => ({
		type: 'block_actions',
		user: { id: 'U_ADMIN' },
		actions: [{ action_id: 'value' }],
		view: {
			id: 'V1',
			hash: 'hash-1',
			callback_id: 'member_note_modal',
			private_metadata: JSON.stringify({ channelId: 'C_CHAN', source: 'shortcut' }),
			state: { values },
		},
	});

	it('adds the warning-text block when Warning is picked', async () => {
		await call(signedPayload(toggle(warningValues({ [BLOCK.warningText]: { value: {} } }))));

		const view = mockViewsUpdate.mock.calls[0]![0].view;
		expect(view.blocks.map((b: { block_id: string }) => b.block_id)).toContain('warning_text');
	});

	it('removes it again when Note is picked', async () => {
		await call(
			signedPayload(toggle({ [BLOCK.kind]: { value: { selected_option: { value: 'note' } } } })),
		);

		const view = mockViewsUpdate.mock.calls[0]![0].view;
		expect(view.blocks.map((b: { block_id: string }) => b.block_id)).not.toContain('warning_text');
	});

	// views.update replaces the entire view, so anything not re-supplied is
	// silently wiped. This is the failure mode most likely to annoy an admin.
	it('preserves everything already typed', async () => {
		await call(
			signedPayload(
				toggle(
					warningValues({
						[BLOCK.member]: { value: { selected_user: 'U_TYPED' } },
						[BLOCK.body]: { value: { value: 'details typed so far' } },
						[BLOCK.link]: {
							value: { value: 'https://w.slack.com/archives/C1/p1712345678123456' },
						},
					}),
				),
			),
		);

		const view = mockViewsUpdate.mock.calls[0]![0].view;
		const byId = (id: string) => view.blocks.find((b: { block_id: string }) => b.block_id === id);
		expect(byId('member').element.initial_user).toBe('U_TYPED');
		expect(byId('body').element.initial_value).toBe('details typed so far');
		expect(byId('link').element.initial_value).toBe(
			'https://w.slack.com/archives/C1/p1712345678123456',
		);
		expect(byId('dm').element.initial_options).toHaveLength(1);
	});

	it('preserves the private_metadata across the update', async () => {
		await call(signedPayload(toggle(warningValues())));

		const view = mockViewsUpdate.mock.calls[0]![0].view;
		expect(JSON.parse(view.private_metadata)).toEqual({
			channelId: 'C_CHAN',
			source: 'shortcut',
		});
	});

	it('passes the view hash so a stale update is rejected', async () => {
		await call(signedPayload(toggle(warningValues())));
		expect(mockViewsUpdate.mock.calls[0]![0].hash).toBe('hash-1');
	});

	it('ignores actions from other blocks', async () => {
		await call(
			signedPayload({
				type: 'block_actions',
				user: { id: 'U_ADMIN' },
				actions: [{ action_id: 'something_else' }],
				view: { id: 'V1', callback_id: 'member_note_modal', state: { values: {} } },
			}),
		);
		expect(mockViewsUpdate).not.toHaveBeenCalled();
	});
});

describe('view_submission', () => {
	it('saves a note and closes the modal', async () => {
		const res = await call(signedPayload(submissionPayload()));

		expect(await res.json()).toEqual({});
		expect(mockInsertNote).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				slackUserId: 'U_TARGET',
				kind: 'note',
				body: 'Some details',
				authorSlackUserId: 'U_ADMIN',
				authorSlackUserName: 'Admin Person',
				source: 'slash',
			}),
		);
	});

	it('stores the parsed message link alongside the raw URL', async () => {
		await call(
			signedPayload(
				submissionPayload(
					{},
					{
						[BLOCK.link]: {
							value: { value: 'https://w.slack.com/archives/C0ABC123/p1712345678123456' },
						},
					},
				),
			),
		);

		expect(mockInsertNote).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				messageLink: 'https://w.slack.com/archives/C0ABC123/p1712345678123456',
				messageChannelId: 'C0ABC123',
				messageTs: '1712345678.123456',
			}),
		);
	});

	it('returns block errors for an invalid link and writes nothing', async () => {
		const res = await call(
			signedPayload(
				submissionPayload({}, { [BLOCK.link]: { value: { value: 'https://example.com/x' } } }),
			),
		);

		const parsed = await res.json();
		expect(parsed.response_action).toBe('errors');
		expect(parsed.errors).toHaveProperty(BLOCK.link);
		expect(mockInsertNote).not.toHaveBeenCalled();
	});

	it('returns block errors for an empty body', async () => {
		const res = await call(
			signedPayload(submissionPayload({}, { [BLOCK.body]: { value: { value: '  ' } } })),
		);

		expect((await res.json()).errors).toHaveProperty(BLOCK.body);
		expect(mockInsertNote).not.toHaveBeenCalled();
	});

	it('saves a moderator’s note under their own name', async () => {
		const res = await call(signedPayload(submissionPayload({ user: { id: 'U_MOD' } })));

		expect(await res.json()).toEqual({});
		expect(mockInsertNote).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ authorSlackUserId: 'U_MOD' }),
		);
	});

	it('rejects a submission from someone no longer an admin', async () => {
		const res = await call(signedPayload(submissionPayload({ user: { id: 'U_RANDOM' } })));

		expect((await res.json()).response_action).toBe('errors');
		expect(mockInsertNote).not.toHaveBeenCalled();
	});

	it('does not DM for a plain note', async () => {
		await call(signedPayload(submissionPayload()));
		await flush();

		// Narrowed to the member's DM channel — the admin tracking channel does
		// get a post, and that isn't what this test is about.
		expect(mockPostMessage.mock.calls.map((c) => c[0].channel)).not.toContain('D_TARGET');
		expect(mockRecordDmOutcome).toHaveBeenCalledWith({}, 7, { status: 'not-a-warning' });
	});

	it('DMs the member for a warning and records what was sent', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 2 });

		await call(signedPayload(submissionPayload({}, warningValues())));
		await flush();

		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U_TARGET' });
		const sent = mockPostMessage.mock.calls[0]![0];
		expect(sent.channel).toBe('D_TARGET');
		expect(sent.text).toContain('This is your second warning.');

		expect(mockRecordDmOutcome).toHaveBeenCalledWith(
			{},
			9,
			expect.objectContaining({ body: expect.stringContaining('second') }),
		);
		expect(mockRecordDmOutcome.mock.calls[0]![2].sentAt).toBeTruthy();
	});

	// The reason the route resolves the blank case itself: renderWarningDm's own
	// fallback is the hardcoded DEFAULT_WARNING_DM, which would quietly ignore
	// whatever the admin configured on /settings.
	it('falls back to the Settings template when the warning box is left blank', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['U_ADMIN']),
			moderatorSlackUserIds: new Set(['U_MOD']),
			warningDmMessage: 'Configured in settings: {{nth}} warning.',
		});

		await call(
			signedPayload(
				submissionPayload({}, warningValues({ [BLOCK.warningText]: { value: { value: '   ' } } })),
			),
		);
		await flush();

		expect(mockPostMessage.mock.calls[0]![0].text).toBe('Configured in settings: first warning.');
	});

	it('uses the admin’s edited warning text, not the stored template', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });

		await call(
			signedPayload(
				submissionPayload(
					{},
					warningValues({
						[BLOCK.warningText]: { value: { value: 'Custom {{nth}} notice, please stop.' } },
					}),
				),
			),
		);
		await flush();

		expect(mockPostMessage.mock.calls[0]![0].text).toBe('Custom first notice, please stop.');
	});

	it('records suppression and sends nothing when the DM box is unchecked', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });

		await call(
			signedPayload(
				submissionPayload({}, warningValues({ [BLOCK.dm]: { value: { selected_options: [] } } })),
			),
		);
		await flush();

		expect(mockPostMessage.mock.calls.map((c) => c[0].channel)).not.toContain('D_TARGET');
		expect(mockRecordDmOutcome).toHaveBeenCalledWith({}, 9, { status: 'suppressed' });
	});

	// The whole point of writing the row before attempting the DM.
	it('keeps the note when the DM fails, and records why', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });
		mockConversationsOpen.mockRejectedValue(new Error('user_not_found'));

		const res = await call(signedPayload(submissionPayload({}, warningValues())));
		await flush();

		// Modal still closed cleanly, note still written.
		expect(await res.json()).toEqual({});
		expect(mockInsertNote).toHaveBeenCalledTimes(1);
		expect(mockRecordDmOutcome).toHaveBeenCalledWith(
			{},
			9,
			expect.objectContaining({ status: 'user_not_found' }),
		);
	});

	it('reports a save failure back into the modal', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInsertNote.mockRejectedValue(new Error('db down'));

		const res = await call(signedPayload(submissionPayload()));

		expect((await res.json()).response_action).toBe('errors');
	});

	it('confirms to the author in the invoking channel', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 3 });

		await call(signedPayload(submissionPayload({}, warningValues())));
		await flush();

		expect(mockPostEphemeral).toHaveBeenCalledWith(
			expect.objectContaining({ channel: 'C_CHAN', user: 'U_ADMIN' }),
		);
	});

	it('records the shortcut as the source when the modal came from one', async () => {
		await call(
			signedPayload(
				submissionPayload({
					view: {
						callback_id: 'member_note_modal',
						private_metadata: JSON.stringify({ channelId: 'C_C', source: 'shortcut' }),
						state: {
							values: {
								[BLOCK.member]: { value: { selected_user: 'U_TARGET' } },
								[BLOCK.kind]: { value: { selected_option: { value: 'note' } } },
								[BLOCK.body]: { value: { value: 'x' } },
							},
						},
					},
				}),
			),
		);

		expect(mockInsertNote).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ source: 'shortcut' }),
		);
	});

	it('ignores a submission from an unrelated modal', async () => {
		const res = await call(
			signedPayload({ type: 'view_submission', view: { callback_id: 'something_else' } }),
		);

		expect(res.status).toBe(200);
		expect(mockInsertNote).not.toHaveBeenCalled();
	});
});

describe('admin tracking channel', () => {
	const postedTo = (channel: string) =>
		mockPostMessage.mock.calls.find((c) => c[0].channel === channel)?.[0];

	it('announces a note, with no "sent to them" clause', async () => {
		await call(signedPayload(submissionPayload()));
		await flush();

		expect(postedTo('C_ADMIN_LOG')!.text).toBe(
			'Note “Some details” added to user <@U_TARGET> by <@U_ADMIN>',
		);
	});

	it('announces a warning including the message the member received', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 2 });

		await call(signedPayload(submissionPayload({}, warningValues())));
		await flush();

		expect(postedTo('C_ADMIN_LOG')!.text).toBe(
			'Warning “Some details” added to user <@U_TARGET> ' +
				'and warning “This is your second warning.” sent to them by <@U_ADMIN>',
		);
	});

	it('links back to the message the note was filed against', async () => {
		const permalink = 'https://example.slack.com/archives/C0CHAN/p1712345678123456';

		await call(
			signedPayload(submissionPayload({}, { [BLOCK.link]: { value: { value: permalink } } })),
		);
		await flush();

		expect(postedTo('C_ADMIN_LOG')!.text).toContain(`<${permalink}|regarding this message>`);
	});

	it('omits the sent clause when the DM was suppressed', async () => {
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });

		await call(
			signedPayload(
				submissionPayload({}, warningValues({ [BLOCK.dm]: { value: { selected_options: [] } } })),
			),
		);
		await flush();

		expect(postedTo('C_ADMIN_LOG')!.text).not.toContain('sent to them');
	});

	// A failed DM must not be announced as delivered.
	it('omits the sent clause when the DM failed', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInsertNote.mockResolvedValue({ id: 9, warningNumber: 1 });
		mockConversationsOpen.mockRejectedValue(new Error('user_not_found'));

		await call(signedPayload(submissionPayload({}, warningValues())));
		await flush();

		expect(postedTo('C_ADMIN_LOG')!.text).not.toContain('sent to them');
	});

	it('posts nothing when no channel is configured', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['U_ADMIN']),
			moderatorSlackUserIds: new Set(['U_MOD']),
			warningDmMessage: '',
			slackMemberNoteChannelId: '',
		});

		await call(signedPayload(submissionPayload()));
		await flush();

		expect(postedTo('C_ADMIN_LOG')).toBeUndefined();
	});

	// The note is already committed; a broken admin channel cannot be allowed to
	// look like a failure to the person who filed it.
	it('swallows a posting failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockPostMessage.mockRejectedValue(new Error('channel_not_found'));

		const res = await call(signedPayload(submissionPayload()));
		await flush();

		expect(await res.json()).toEqual({});
	});
});

describe('POST /api/slack/interactivity — turf buttons', () => {
	const RESPONSE_URL = 'https://hooks.slack.test/response';

	const buttonPress = (actionId: string, value: string, over: Record<string, unknown> = {}) =>
		signedPayload({
			type: 'block_actions',
			user: { id: 'U_VOL' },
			channel: { id: 'C_WASHTENAW' },
			response_url: RESPONSE_URL,
			actions: [{ action_id: actionId, value }],
			...over,
		});

	const VALUE = encodeTurfAction({
		mapRouteId: 100,
		chapterId: 71,
		offset: 0,
		location: { lat: 42.28, lng: -83.74 },
	});

	beforeEach(() => {
		mockClaimFromSlack.mockResolvedValue({ text: 'claimed', blocks: [] });
		mockReleaseFromSlack.mockResolvedValue({ text: 'released', blocks: [] });
		mockTurfListMessage.mockResolvedValue({ text: 'listed', blocks: [] });
	});

	// A turf button comes from a message, so payload.view is undefined. Before
	// this dispatch existed the note-modal guard swallowed it silently.
	it('reaches the turf handler despite carrying no view', async () => {
		const res = await call(buttonPress(TURF_CLAIM_ACTION_ID, VALUE));
		await flush();
		expect(res.status).toBe(200);
		expect(mockClaimFromSlack).toHaveBeenCalled();
	});

	it('claims the turf named in the button value', async () => {
		await call(buttonPress(TURF_CLAIM_ACTION_ID, VALUE));
		await flush();
		expect(mockClaimFromSlack).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				slackUserId: 'U_VOL',
				mapRouteId: 100,
				chapterId: 71,
				location: { lat: 42.28, lng: -83.74 },
			}),
		);
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			RESPONSE_URL,
			{ text: 'claimed', blocks: [] },
			expect.objectContaining({ replaceOriginal: true }),
		);
	});

	it('releases the turf named in the button value', async () => {
		await call(buttonPress(TURF_RELEASE_ACTION_ID, VALUE));
		await flush();
		expect(mockReleaseFromSlack).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mapRouteId: 100 }),
		);
	});

	it('pages the list at the offset in the button value', async () => {
		const value = encodeTurfAction({ chapterId: 71, offset: 5 });
		await call(buttonPress(TURF_PAGE_ACTION_ID, value));
		await flush();
		expect(mockTurfListMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71, offset: 5 }),
		);
		expect(mockClaimFromSlack).not.toHaveBeenCalled();
	});

	// Replacing rather than appending: three presses of "Show next 5" must not
	// leave three stale lists to claim from.
	it('replaces the message in place', async () => {
		await call(buttonPress(TURF_PAGE_ACTION_ID, encodeTurfAction({ chapterId: 71, offset: 5 })));
		await flush();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			RESPONSE_URL,
			expect.anything(),
			expect.objectContaining({ replaceOriginal: true }),
		);
	});

	// The value round-trips through a client, so it is untrusted input.
	it.each([
		['malformed', 'not json'],
		['missing', undefined],
		['an array', '[1,2,3]'],
		['chapterless', '{"o":0}'],
	])('refuses %s button state without acting', async (_label, value) => {
		await call(buttonPress(TURF_CLAIM_ACTION_ID, value as string));
		await flush();
		expect(mockClaimFromSlack).not.toHaveBeenCalled();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			RESPONSE_URL,
			expect.objectContaining({ text: expect.stringContaining('expired') }),
			expect.anything(),
		);
	});

	// A claim value with no route id would otherwise fall through to the list.
	it('does not claim without a route id', async () => {
		await call(buttonPress(TURF_CLAIM_ACTION_ID, encodeTurfAction({ chapterId: 71, offset: 0 })));
		await flush();
		expect(mockClaimFromSlack).not.toHaveBeenCalled();
		expect(mockTurfListMessage).toHaveBeenCalled();
	});

	it('still requires a valid signature', async () => {
		const res = await call(
			signedPayload(
				{
					type: 'block_actions',
					user: { id: 'U_VOL' },
					response_url: RESPONSE_URL,
					actions: [{ action_id: TURF_CLAIM_ACTION_ID, value: VALUE }],
				},
				{ secret: 'wrong' },
			),
		);
		expect(res.status).toBe(401);
		expect(mockClaimFromSlack).not.toHaveBeenCalled();
	});

	it('tells the volunteer when the action fails rather than going quiet', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockClaimFromSlack.mockRejectedValue(new Error('turso is down'));
		await call(buttonPress(TURF_CLAIM_ACTION_ID, VALUE));
		await flush();
		expect(mockRespondToSlack).toHaveBeenCalledWith(
			RESPONSE_URL,
			expect.objectContaining({ text: expect.stringContaining('did not go through') }),
			expect.anything(),
		);
		error.mockRestore();
	});

	it('leaves the note modal’s radio toggle alone', async () => {
		mockLoadSettings.mockResolvedValue({ warningDmMessage: 'x' });
		await call(
			signedPayload({
				type: 'block_actions',
				user: { id: 'U_ADMIN' },
				actions: [{ action_id: 'note_kind' }],
				view: { id: 'V1', callback_id: 'note_modal', hash: 'h', state: { values: {} } },
			}),
		);
		await flush();
		expect(mockClaimFromSlack).not.toHaveBeenCalled();
		expect(mockTurfListMessage).not.toHaveBeenCalled();
	});
});
