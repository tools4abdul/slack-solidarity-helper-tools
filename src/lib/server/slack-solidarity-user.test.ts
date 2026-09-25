import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockFindByEmail = vi.hoisted(() => vi.fn());
const mockGetUserById = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/env.js', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/slack.js', () => ({ slack: { users: { info: mockUsersInfo } } }));
vi.mock('$lib/server/solidarity.js', () => ({
	findUserByEmailStrict: mockFindByEmail,
	getUserById: mockGetUserById,
}));

const { findSolidarityUserForSlack } = await import('./slack-solidarity-user.js');

/** Answers the one query this module runs itself: the admin-made link. */
function makeDb(linkedSolidarityId: number | null = null) {
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () =>
						linkedSolidarityId === null ? [] : [{ solidarityUserId: linkedSolidarityId }],
				}),
			}),
		}),
	} as never;
}

const BY_EMAIL = { id: 5 };
const BY_LINK = { id: 9 };

describe('findSolidarityUserForSlack', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUsersInfo.mockResolvedValue({ user: { profile: { email: 'dana@example.org' } } });
		mockFindByEmail.mockResolvedValue(BY_EMAIL);
		mockGetUserById.mockResolvedValue(BY_LINK);
	});

	it('matches the Slack email to a Solidarity account', async () => {
		expect(await findSolidarityUserForSlack(makeDb(), 'U1')).toBe(BY_EMAIL);
		expect(mockUsersInfo).toHaveBeenCalledWith({ user: 'U1' });
		expect(mockFindByEmail).toHaveBeenCalledWith('tok', 'dana@example.org');
	});

	it('prefers an admin-made link over the email match', async () => {
		expect(await findSolidarityUserForSlack(makeDb(9), 'U1')).toBe(BY_LINK);
		expect(mockGetUserById).toHaveBeenCalledWith('tok', 9);
		expect(mockUsersInfo).not.toHaveBeenCalled();
	});

	it('is null when Slack has no email for the user', async () => {
		mockUsersInfo.mockResolvedValue({ user: { profile: {} } });
		expect(await findSolidarityUserForSlack(makeDb(), 'U1')).toBeNull();
		expect(mockFindByEmail).not.toHaveBeenCalled();
	});

	it('is null when no Solidarity account matches', async () => {
		mockFindByEmail.mockResolvedValue(null);
		expect(await findSolidarityUserForSlack(makeDb(), 'U1')).toBeNull();
	});

	it('throws when Solidarity is down, so callers can tell it from "no account"', async () => {
		mockFindByEmail.mockRejectedValue(new Error('503'));
		await expect(findSolidarityUserForSlack(makeDb(), 'U1')).rejects.toThrow('503');
	});
});
