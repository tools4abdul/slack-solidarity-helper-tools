import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockGetSolidarityMembers = vi.hoisted(() => vi.fn());
const mockOnConflictDoUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockValues = vi.hoisted(() => vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate })));
const mockInsert = vi.hoisted(() => vi.fn(() => ({ values: mockValues })));
const mockDeleteWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDelete = vi.hoisted(() => vi.fn(() => ({ where: mockDeleteWhere })));

vi.mock('$lib/server/autocomplete-sources', () => ({
	getSolidarityMembers: mockGetSolidarityMembers,
}));
vi.mock('$lib/server/db', () => ({ db: { insert: mockInsert, delete: mockDelete } }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));

const adminSession = { slackUserId: 'U_ADMIN', slackUserName: 'Admin Person', isAdmin: true };

function call(body: unknown, session: unknown = adminSession) {
	return POST({
		request: new Request('http://localhost/api/members/link', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
		locals: { session },
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mockGetSolidarityMembers.mockResolvedValue({
		items: [{ id: 500, name: 'Jordan Rivera', email: 'jordan@example.org', otherEmails: [] }],
		stale: false,
		fetchedAt: 0,
	});
});

describe('auth', () => {
	it('401s with no session', async () => {
		expect((await call({ action: 'link' }, null)).status).toBe(401);
	});

	it('403s for a non-admin', async () => {
		const res = await call({ action: 'link' }, { ...adminSession, isAdmin: false });
		expect(res.status).toBe(403);
	});

	// Moderators may read /members but not change whose account is whose; the
	// page hides the controls, and this is the guard that actually holds.
	it('403s for a moderator', async () => {
		const res = await call(
			{ action: 'unlink', slackUserId: 'U_TARGET' },
			{ ...adminSession, isAdmin: false, isModerator: true },
		);
		expect(res.status).toBe(403);
	});
});

describe('validation', () => {
	it('400s on invalid JSON', async () => {
		expect((await call('{ not json')).status).toBe(400);
	});

	it.each([
		['missing', {}],
		['not a string', { slackUserId: 42 }],
		['wrong shape', { slackUserId: 'nope' }],
	])('400s when slackUserId is %s', async (_label, body) => {
		expect((await call({ action: 'link', ...body })).status).toBe(400);
	});

	it('400s on an unknown action', async () => {
		expect((await call({ action: 'explode', slackUserId: 'U0TARGET1' })).status).toBe(400);
	});

	it.each([
		['missing', undefined],
		['a string', '500'],
		['fractional', 1.5],
	])('400s when solidarityUserId is %s', async (_label, value) => {
		const res = await call({ action: 'link', slackUserId: 'U0TARGET1', solidarityUserId: value });
		expect(res.status).toBe(400);
	});
});

describe('link', () => {
	it('upserts the link with editor attribution', async () => {
		const res = await call({ action: 'link', slackUserId: 'U0TARGET1', solidarityUserId: 500 });

		expect(res.status).toBe(200);
		expect(mockValues).toHaveBeenCalledWith(
			expect.objectContaining({
				slackUserId: 'U0TARGET1',
				solidarityUserId: 500,
				solidarityEmail: 'jordan@example.org',
				linkedBy: 'U_ADMIN',
				linkedByName: 'Admin Person',
			}),
		);
		expect(mockOnConflictDoUpdate).toHaveBeenCalled();
	});

	it('falls back to the id when the session has no display name', async () => {
		await call(
			{ action: 'link', slackUserId: 'U0TARGET1', solidarityUserId: 500 },
			{ ...adminSession, slackUserName: null },
		);

		expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ linkedByName: 'U_ADMIN' }));
	});

	// The id came from the cached roster, so validating against it costs no
	// API calls while still rejecting a hand-crafted request.
	it('400s for a Solidarity id that is not in the roster', async () => {
		const res = await call({ action: 'link', slackUserId: 'U0TARGET1', solidarityUserId: 999 });

		expect(res.status).toBe(400);
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('503s when the roster is unavailable, so the admin can retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockGetSolidarityMembers.mockRejectedValue(new Error('cold and failing'));

		const res = await call({ action: 'link', slackUserId: 'U0TARGET1', solidarityUserId: 500 });

		expect(res.status).toBe(503);
		expect(mockInsert).not.toHaveBeenCalled();
	});
});

describe('unlink', () => {
	it('deletes the link', async () => {
		const res = await call({ action: 'unlink', slackUserId: 'U0TARGET1' });

		expect(res.status).toBe(200);
		expect(mockDelete).toHaveBeenCalled();
		expect(mockDeleteWhere).toHaveBeenCalled();
	});

	it('does not need a solidarityUserId or the roster', async () => {
		await call({ action: 'unlink', slackUserId: 'U0TARGET1' });
		expect(mockGetSolidarityMembers).not.toHaveBeenCalled();
	});

	it('still requires admin', async () => {
		const res = await call(
			{ action: 'unlink', slackUserId: 'U0TARGET1' },
			{ ...adminSession, isAdmin: false },
		);
		expect(res.status).toBe(403);
		expect(mockDelete).not.toHaveBeenCalled();
	});
});
