import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('./db.js', () => ({ db: {} }));
vi.mock('./settings.js', () => ({ loadSettings: mockLoadSettings }));
vi.mock('./env.js', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));

import { slackRole, isSlackAdmin, canUseSlackCommands } from './slack-admin.js';

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadSettings.mockResolvedValue({
		allowedSlackUserIds: new Set(['U_ADMIN', 'U_BOTH']),
		moderatorSlackUserIds: new Set(['U_MOD', 'U_BOTH']),
	});
});

describe('slackRole', () => {
	it('reads both lists', async () => {
		expect(await slackRole('U_ADMIN')).toBe('admin');
		expect(await slackRole('U_MOD')).toBe('moderator');
		expect(await slackRole('U_RANDOM')).toBeNull();
	});

	it('ranks admin above moderator for someone on both lists', async () => {
		expect(await slackRole('U_BOTH')).toBe('admin');
	});

	it('makes the superuser an admin without reading the DB', async () => {
		expect(await slackRole('U_SUPER')).toBe('admin');
		expect(mockLoadSettings).not.toHaveBeenCalled();
	});

	it('fails closed when settings cannot be read', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));

		expect(await slackRole('U_ADMIN')).toBeNull();
		expect(await slackRole('U_MOD')).toBeNull();
		expect(await slackRole('U_SUPER')).toBe('admin');
	});
});

describe('isSlackAdmin', () => {
	// The turf view in Slack keys holder names and the rate-limit exemption off
	// this. A moderator is for the moderation commands, not the organizer view.
	it('is false for a moderator', async () => {
		expect(await isSlackAdmin('U_MOD')).toBe(false);
		expect(await isSlackAdmin('U_ADMIN')).toBe(true);
	});
});

describe('canUseSlackCommands', () => {
	it('admits admins and moderators, and no one else', async () => {
		expect(await canUseSlackCommands('U_ADMIN')).toBe(true);
		expect(await canUseSlackCommands('U_MOD')).toBe(true);
		expect(await canUseSlackCommands('U_RANDOM')).toBe(false);
	});
});
