import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockValidateChannel = vi.hoisted(() => vi.fn());
const mockValidateChapter = vi.hoisted(() => vi.fn());
const mockComputeDiff = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackChannel: mockValidateChannel,
	validateSolidarityChapter: mockValidateChapter,
}));
vi.mock('$lib/server/channel-chapter-diff', () => ({
	computeChannelChapterDiff: mockComputeDiff,
}));

const authed = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true };
const nonAdmin = { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false };

const OK_QUERY = 'channel=C1&chapter=7';

const event = (session: unknown, query: string) =>
	({
		locals: { session },
		url: new URL(`https://app.example/api/channel-chapter-diff?${query}`),
	}) as never;

const DIFF = {
	inSlackOnly: ['a@example.org'],
	inChapterOnly: ['b@example.org'],
	inBothCount: 3,
	slackNoEmailCount: 0,
	chapterNoEmailCount: 1,
	inChapterOnlyHiddenCount: null,
};

describe('GET /api/channel-chapter-diff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockValidateChannel.mockResolvedValue({ ok: true, name: 'general' });
		mockValidateChapter.mockResolvedValue({ ok: true, name: 'Brooklyn' });
		mockComputeDiff.mockResolvedValue(DIFF);
	});

	it('returns 401 when not signed in', async () => {
		const res = await GET(event(null, OK_QUERY));
		expect(res.status).toBe(401);
		expect(mockComputeDiff).not.toHaveBeenCalled();
	});

	it('returns 403 for a signed-in non-admin', async () => {
		const res = await GET(event(nonAdmin, OK_QUERY));
		expect(res.status).toBe(403);
		expect(mockComputeDiff).not.toHaveBeenCalled();
	});

	it('returns 400 when the channel is missing', async () => {
		const res = await GET(event(authed, 'chapter=7'));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'channel is required' });
	});

	it.each([
		'channel=C1',
		'channel=C1&chapter=',
		'channel=C1&chapter=abc',
		'channel=C1&chapter=7.5',
	])('returns 400 for a non-integer chapter (%s)', async (query) => {
		const res = await GET(event(authed, query));
		expect(res.status).toBe(400);
		expect(mockComputeDiff).not.toHaveBeenCalled();
	});

	it('returns 400 when the channel id is not a real channel', async () => {
		mockValidateChannel.mockResolvedValue({
			ok: false,
			error: 'Not a valid Slack channel choice.',
			transient: false,
		});
		const res = await GET(event(authed, OK_QUERY));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Not a valid Slack channel choice.' });
	});

	it('returns 400 when the chapter id is not a real chapter', async () => {
		mockValidateChapter.mockResolvedValue({
			ok: false,
			error: 'Not a valid Solidarity chapter choice.',
			transient: false,
		});
		const res = await GET(event(authed, OK_QUERY));
		expect(res.status).toBe(400);
	});

	// A list outage means "ask again", not "your pick was wrong" — so 503.
	it('returns 503 when a validation source is temporarily unavailable', async () => {
		mockValidateChapter.mockResolvedValue({
			ok: false,
			error: 'Solidarity chapter list is temporarily unavailable. Try again in a moment.',
			transient: true,
		});
		const res = await GET(event(authed, OK_QUERY));
		expect(res.status).toBe(503);
	});

	it('returns 502 when the diff itself fails', async () => {
		mockComputeDiff.mockRejectedValue(new Error('slack exploded'));
		const res = await GET(event(authed, OK_QUERY));
		expect(res.status).toBe(502);
		expect((await res.json()).error).toContain('slack exploded');
	});

	it('returns the diff for a valid pair', async () => {
		const res = await GET(event(authed, OK_QUERY));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(DIFF);
		expect(mockComputeDiff).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: 'C1', chapterId: 7, token: 'tok' }),
		);
	});

	it('passes no activity window when activeDays is absent', async () => {
		await GET(event(authed, OK_QUERY));
		expect(mockComputeDiff).toHaveBeenCalledWith(expect.objectContaining({ activeSinceMs: null }));
	});

	it('turns activeDays into a cutoff instant', async () => {
		const before = Date.now();
		await GET(event(authed, `${OK_QUERY}&activeDays=30`));

		const { activeSinceMs } = mockComputeDiff.mock.calls[0]![0] as { activeSinceMs: number };
		expect(activeSinceMs).toBeGreaterThanOrEqual(before - 30 * 86_400_000);
		expect(activeSinceMs).toBeLessThanOrEqual(Date.now() - 30 * 86_400_000);
	});

	it.each(['0', '-5', '366', '7.5', 'thirty'])(
		'returns 400 for an out-of-range activeDays (%s)',
		async (days) => {
			const res = await GET(event(authed, `${OK_QUERY}&activeDays=${days}`));
			expect(res.status).toBe(400);
			expect(mockComputeDiff).not.toHaveBeenCalled();
		},
	);
});
