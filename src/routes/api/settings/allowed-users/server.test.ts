import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSaveUser = vi.hoisted(() => vi.fn());
const mockDeleteUser = vi.hoisted(() => vi.fn());
const mockValidateUser = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SLACK_SUPERUSER_ID: 'USUPER' }));
vi.mock('$lib/server/settings', () => ({
	saveAllowedUser: mockSaveUser,
	deleteAllowedUser: mockDeleteUser,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackUser: mockValidateUser,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const superuserSession = {
	locals: { session: { slackUserId: 'USUPER', slackUserName: 'Root', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(
	session: typeof authed | typeof unauthed | typeof nonAdmin | typeof superuserSession,
	body: unknown,
) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/settings/allowed-users', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveUser.mockResolvedValue(undefined);
		mockDeleteUser.mockResolvedValue('deleted');
		mockValidateUser.mockResolvedValue({ ok: true, displayName: 'Dana' });
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(401);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(403);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('returns 400 for an unknown action and for a missing/blank userId', async () => {
		for (const body of [
			{ action: 'toggle', userId: 'UDANA' },
			{ action: 'add', userId: '' },
			{ action: 'add', userId: '   ' },
			{ action: 'add', userId: 7 },
			{ action: 'add' },
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveUser).not.toHaveBeenCalled();
		expect(mockDeleteUser).not.toHaveBeenCalled();
	});

	it('add: validates, then saves the validated name', async () => {
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		expect(mockValidateUser).toHaveBeenCalledWith(expect.anything(), 'UDANA');
		expect(mockSaveUser).toHaveBeenCalledWith(
			expect.anything(),
			{ slackUserId: 'UDANA', displayName: 'Dana' },
			{ id: 'U123', name: 'Alice' },
		);
	});

	it('add: 400 for an unknown user id, nothing written', async () => {
		mockValidateUser.mockResolvedValue({
			ok: false,
			error: 'Not a valid Slack user choice.',
			transient: false,
		});
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UNOPE' }) as never);
		expect(res.status).toBe(400);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('add: 503 when the user list is transiently unavailable', async () => {
		mockValidateUser.mockResolvedValue({ ok: false, error: 'unavailable', transient: true });
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(503);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('remove: deletes without live-list validation', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'UDANA' }) as never);
		expect(res.status).toBe(200);
		expect(mockValidateUser).not.toHaveBeenCalled();
		expect(mockDeleteUser).toHaveBeenCalledWith(expect.anything(), 'UDANA', {
			id: 'U123',
			name: 'Alice',
		});
		expect(mockValidateUser).not.toHaveBeenCalled();
	});

	it('remove: refuses to remove your own id', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'U123' }) as never);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/your own admin access/);
		expect(mockDeleteUser).not.toHaveBeenCalled();
	});

	it('remove: the superuser may remove their own id (they stay admin via env)', async () => {
		const res = await POST(
			makeEvent(superuserSession, { action: 'remove', userId: 'USUPER' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockDeleteUser).toHaveBeenCalledWith(expect.anything(), 'USUPER', {
			id: 'USUPER',
			name: 'Root',
		});
	});

	it('remove: 409 when the store refuses to remove the last admin', async () => {
		mockDeleteUser.mockResolvedValue('last-admin');
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'UDANA' }) as never);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/only admin/);
	});

	it('remove: a row that was already gone still reports success', async () => {
		mockDeleteUser.mockResolvedValue('not-found');
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'UGONE' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns 400 for a non-JSON body', async () => {
		const event = {
			...authed,
			request: {
				json: async () => {
					throw new SyntaxError('bad');
				},
			} as unknown as Request,
		};
		const res = await POST(event as never);
		expect(res.status).toBe(400);
	});
});
