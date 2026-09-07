import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load } from './+page.server.js';

const mockChannels = vi.hoisted(() => vi.fn());
const mockChapters = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/autocomplete-sources', () => ({
	getSlackChannels: mockChannels,
	getSolidarityChapters: mockChapters,
}));

const authed = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true };
const nonAdmin = { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false };

const event = (session: unknown) => ({ locals: { session } }) as never;

const result = <T>(items: T[]) => ({ items, stale: false, fetchedAt: 0 });

// `load` is typed as possibly returning void because the admin gate throws a
// redirect; the success-path tests all go through here.
async function run(ev: never) {
	const data = await load(ev);
	if (!data) throw new Error('expected the load function to return data');
	return data;
}

describe('load /channel-chapter-diff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChannels.mockResolvedValue(
			result([
				{ id: 'C1', name: 'general', isPrivate: false },
				{ id: 'C2', name: 'organizers', isPrivate: true },
			]),
		);
		mockChapters.mockResolvedValue(result([{ id: 7, name: 'Brooklyn' }]));
	});

	it.each([
		['no session', null],
		['a non-admin', nonAdmin],
	])('redirects %s to /', async (_label, session) => {
		await expect(load(event(session))).rejects.toMatchObject({ status: 302 });
	});

	it('maps both lists into picker items', async () => {
		const data = await run(event(authed));

		expect(data.channels).toEqual([
			{ id: 'C1', label: '#general', sublabel: undefined },
			{ id: 'C2', label: '#organizers', sublabel: 'private' },
		]);
		expect(data.chapters).toEqual([{ id: 7, label: 'Brooklyn' }]);
		expect(data.errors).toEqual({});
	});

	// One source failing must not cost the admin the other picker.
	it('keeps the channel list when the chapter list fails', async () => {
		mockChapters.mockRejectedValue(new Error('solidarity down'));

		const data = await run(event(authed));

		expect(data.channels).toHaveLength(2);
		expect(data.chapters).toEqual([]);
		expect(data.errors.chapters).toContain('solidarity down');
		expect(data.errors.channels).toBeUndefined();
	});

	it('keeps the chapter list when the channel list fails', async () => {
		mockChannels.mockRejectedValue(new Error('slack down'));

		const data = await run(event(authed));

		expect(data.chapters).toHaveLength(1);
		expect(data.channels).toEqual([]);
		expect(data.errors.channels).toContain('slack down');
	});
});
