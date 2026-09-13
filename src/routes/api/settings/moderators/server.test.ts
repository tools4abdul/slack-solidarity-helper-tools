import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSaveModerator = vi.hoisted(() => vi.fn());
const mockDeleteModerator = vi.hoisted(() => vi.fn());
const mockValidateUser = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/settings', () => ({
	saveModerator: mockSaveModerator,
	deleteModerator: mockDeleteModerator,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackUser: mockValidateUser,
}));

type Session = {
	slackUserId: string;
	slackUserName: string;
	isAdmin: boolean;
	isModerator?: boolean;
} | null;

const ADMIN: Session = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true };
const MODERATOR: Session = {
	slackUserId: 'UMOD',
	slackUserName: 'Mo',
	isAdmin: false,
	isModerator: true,
};

const post = (session: Session, body: unknown) =>
	POST({ locals: { session }, request: { json: async () => body } as Request } as never);

describe('POST /api/settings/moderators', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveModerator.mockResolvedValue(undefined);
		mockDeleteModerator.mockResolvedValue(undefined);
		mockValidateUser.mockResolvedValue({ ok: true, displayName: 'Dana' });
	});

	it('returns 401 when not authenticated', async () => {
		const res = await post(null, { action: 'add', userId: 'UDANA' });
		expect(res.status).toBe(401);
		expect(mockSaveModerator).not.toHaveBeenCalled();
	});

	// The list that grants moderator access must not be editable by moderators.
	it('returns 403 for a moderator', async () => {
		const res = await post(MODERATOR, { action: 'add', userId: 'UDANA' });
		expect(res.status).toBe(403);
		expect(mockSaveModerator).not.toHaveBeenCalled();
	});

	it('returns 400 for an unknown action and for a missing/blank userId', async () => {
		for (const body of [
			{ action: 'toggle', userId: 'UDANA' },
			{ action: 'add', userId: '' },
			{ action: 'add', userId: '   ' },
			{ action: 'add', userId: 7 },
			{ action: 'add' },
		]) {
			const res = await post(ADMIN, body);
			expect(res.status).toBe(400);
		}
		expect(mockSaveModerator).not.toHaveBeenCalled();
	});

	it('adds a validated user with the display name Slack reports', async () => {
		const res = await post(ADMIN, { action: 'add', userId: 'UDANA' });

		expect(res.status).toBe(200);
		expect(mockSaveModerator).toHaveBeenCalledWith(
			{},
			{ slackUserId: 'UDANA', displayName: 'Dana' },
			{ id: 'U123', name: 'Alice' },
		);
	});

	it('returns 400 for an id Slack does not know', async () => {
		mockValidateUser.mockResolvedValue({ ok: false, error: 'unknown user', transient: false });
		const res = await post(ADMIN, { action: 'add', userId: 'UNOPE' });
		expect(res.status).toBe(400);
		expect(mockSaveModerator).not.toHaveBeenCalled();
	});

	it('returns 503 when the Slack user list is briefly unavailable', async () => {
		mockValidateUser.mockResolvedValue({ ok: false, error: 'slack down', transient: true });
		const res = await post(ADMIN, { action: 'add', userId: 'UDANA' });
		expect(res.status).toBe(503);
	});

	it('removes without validating, so a deactivated user can always be removed', async () => {
		const res = await post(ADMIN, { action: 'remove', userId: 'UGONE' });

		expect(res.status).toBe(200);
		expect(mockValidateUser).not.toHaveBeenCalled();
		expect(mockDeleteModerator).toHaveBeenCalledWith({}, 'UGONE', { id: 'U123', name: 'Alice' });
	});

	it('lets an admin remove themselves — they stay an admin', async () => {
		const res = await post(ADMIN, { action: 'remove', userId: 'U123' });
		expect(res.status).toBe(200);
		expect(mockDeleteModerator).toHaveBeenCalled();
	});
});
