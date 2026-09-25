import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockFindForSlack = vi.hoisted(() => vi.fn());
const mockGetSlackChannels = vi.hoisted(() => vi.fn());
const mockConversationsOpen = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/slack-solidarity-user', () => ({
	findSolidarityUserForSlack: mockFindForSlack,
}));
vi.mock('$lib/server/autocomplete-sources', () => ({ getSlackChannels: mockGetSlackChannels }));
vi.mock('$lib/server/slack', () => ({
	slack: {
		conversations: { open: mockConversationsOpen },
		chat: { postMessage: mockPostMessage },
	},
}));

const authed = {
	locals: { session: { slackUserId: 'U_ME', slackUserName: 'Admin', isAdmin: true } },
};

function makeEvent(session: unknown, body: unknown) {
	return { ...(session as object), request: { json: async () => body } as Request };
}

function lastBlocks(): Array<{
	type: string;
	text?: { text: string };
	elements?: Array<{ text: string }>;
}> {
	return (mockPostMessage.mock.calls.at(-1)![0] as { blocks: ReturnType<typeof lastBlocks> })
		.blocks;
}

/** The mrkdwn section block's text — where {{channels}} lands. */
function sectionText(): string {
	return lastBlocks().find((b) => b.type === 'section')!.text!.text;
}

/** The context block's note — states which preview mode was used. */
function contextNote(): string {
	return lastBlocks().find((b) => b.type === 'context')!.elements![0]!.text;
}

describe('POST /api/settings/welcome-dm-test', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({
			welcomeDmMessage: 'Welcome to {{channels}}!',
			chapterChannelMap: [
				{ chapterId: 42, channelId: 'C_MINE', name: 'Mine' },
				{ chapterId: 99, channelId: 'C_OTHER', name: 'Other' },
			],
		});
		mockFindForSlack.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });
		mockGetSlackChannels.mockResolvedValue({ items: [], fetchedAt: 0 });
		mockConversationsOpen.mockResolvedValue({ channel: { id: 'DM_ME' } });
		mockPostMessage.mockResolvedValue({ ok: true });
	});

	it('401/403 for unauthenticated / non-admin', async () => {
		expect((await POST(makeEvent({ locals: { session: null } }, {}) as never)).status).toBe(401);
		expect(
			(
				await POST(
					makeEvent({ locals: { session: { slackUserId: 'U', isAdmin: false } } }, {}) as never,
				)
			).status,
		).toBe(403);
	});

	it("fills {{channels}} with the admin's OWN chapter channels, not others", async () => {
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		expect(mockFindForSlack).toHaveBeenCalledWith(expect.anything(), 'U_ME');
		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U_ME' });
		const text = sectionText();
		expect(text).toContain('<#C_MINE>');
		expect(text).not.toContain('<#C_OTHER>');
	});

	it('previews the unsaved textarea value when provided', async () => {
		const res = await POST(
			makeEvent(authed, { welcomeDmMessage: 'Draft for {{channels}}' }) as never,
		);
		expect(res.status).toBe(200);
		expect(sectionText()).toContain('Draft for <#C_MINE>');
	});

	it('personalized mode labels the preview as showing your own channels', async () => {
		await POST(makeEvent(authed, {}) as never);
		expect(contextNote()).toContain('your');
	});

	it('falls back to a SAMPLE of real channels (labeled) when not a mapped member', async () => {
		mockFindForSlack.mockResolvedValue(null);
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		const text = sectionText();
		// Real, clickable channels from the map — not a bare placeholder.
		expect(text).toContain('<#C_MINE>');
		expect(text).toContain('<#C_OTHER>');
		expect(text).not.toContain('#your-chapter-channel(s)');
		expect(contextNote()).toContain('example');
	});

	it('shows a placeholder only when no chapter channels are configured', async () => {
		mockFindForSlack.mockResolvedValue(null);
		mockLoadSettings.mockResolvedValue({
			welcomeDmMessage: 'Welcome to {{channels}}!',
			chapterChannelMap: [],
		});
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		expect(sectionText()).toContain('#your-chapter-channel(s)');
		expect(contextNote()).toContain('placeholder');
	});

	it('still sends when the account lookup throws (sample fallback, no crash)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockFindForSlack.mockRejectedValue(new Error('scope'));
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		expect(sectionText()).toContain('<#C_MINE>');
	});
});
