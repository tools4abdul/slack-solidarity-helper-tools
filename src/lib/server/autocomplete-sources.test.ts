import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
	getSolidarityCustomProperties,
	getSolidarityUserLists,
	getSolidarityMembers,
	getSolidarityChapterMembers,
	_resetAutocompleteCachesForTests,
} from './autocomplete-sources.js';
import { _resetWalkLockForTests } from './solidarity-walk-lock.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface SlackMockResponse {
	channels?: unknown[];
	members?: unknown[];
	response_metadata?: { next_cursor?: string };
}

function makeSlack(): {
	slack: WebClient;
	conversationsList: ReturnType<typeof vi.fn>;
	usersList: ReturnType<typeof vi.fn>;
} {
	const conversationsList = vi.fn<(args: unknown) => Promise<SlackMockResponse>>();
	const usersList = vi.fn<(args: unknown) => Promise<SlackMockResponse>>();
	const slack = {
		conversations: { list: conversationsList },
		users: { list: usersList },
	} as unknown as WebClient;
	return { slack, conversationsList, usersList };
}

function chaptersPage(items: unknown[]) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({ data: items }),
		text: async () => '',
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Shared setup — each test starts with a cold cache and clean mocks.
// ---------------------------------------------------------------------------

beforeEach(() => {
	_resetAutocompleteCachesForTests();
	_resetWalkLockForTests();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ===========================================================================
// User Story 1 — pickers offer real, current choices
// ===========================================================================

describe('US1: getSlackChannels', () => {
	it('maps Slack channels to ChannelEntry, sorted ascending by name, excluding archived (FR-001, FR-005, FR-006)', async () => {
		const { slack, conversationsList } = makeSlack();
		// `exclude_archived: true` is passed as a request param, so the upstream
		// returns only non-archived rows in the first place — assert via the
		// request shape that the param was set.
		conversationsList.mockResolvedValueOnce({
			channels: [
				{ id: 'C002', name: 'beta', is_private: false },
				{ id: 'C001', name: 'alpha', is_private: true },
			],
		});

		const result = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(conversationsList).toHaveBeenCalledWith(
			expect.objectContaining({
				types: 'public_channel,private_channel',
				exclude_archived: true,
				limit: 1000,
			}),
		);
		expect(result.stale).toBe(false);
		expect(result.items).toEqual([
			{ id: 'C001', name: 'alpha', isPrivate: true },
			{ id: 'C002', name: 'beta', isPrivate: false },
		]);
	});

	it('walks every cursor page until next_cursor is empty (FR-004)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({
				channels: [{ id: 'C1', name: 'a', is_private: false }],
				response_metadata: { next_cursor: 'page2' },
			})
			.mockResolvedValueOnce({
				channels: [{ id: 'C2', name: 'b', is_private: false }],
				response_metadata: { next_cursor: '' },
			});

		const result = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(conversationsList.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page2' });
		expect(result.items.map((c) => c.id)).toEqual(['C1', 'C2']);
	});
});

describe('US1: getSlackUsers', () => {
	it('excludes bots and deactivated users, resolves display name, sorts (FR-002, FR-005)', async () => {
		const { slack, usersList } = makeSlack();
		usersList.mockResolvedValueOnce({
			members: [
				{
					id: 'U_BOT',
					is_bot: true,
					profile: { display_name: 'Bot', real_name: 'Bot Account' },
				},
				{
					id: 'U_DELETED',
					deleted: true,
					profile: { display_name: 'Ghost', real_name: 'Ghost User' },
				},
				{
					id: 'U_BETA',
					name: 'beta_handle',
					profile: { display_name: '', real_name: 'Zeta Real' },
				},
				{
					id: 'U_ALPHA',
					name: 'alpha_handle',
					profile: { display_name: 'alpha display', real_name: 'Alpha Real' },
				},
				{
					id: 'U_GAMMA',
					name: 'gamma_handle',
					profile: { display_name: '', real_name: '' },
				},
			],
		});

		const result = await getSlackUsers(slack);

		expect(result.stale).toBe(false);
		// alpha display → from display_name; Zeta Real → from real_name fallback;
		// gamma_handle → from name fallback (display & real both empty). Bots and
		// deleted users are dropped entirely. Sort is by resolved display name.
		expect(result.items).toEqual([
			{ id: 'U_ALPHA', name: 'alpha display', realName: 'Alpha Real', email: '' },
			{ id: 'U_GAMMA', name: 'gamma_handle', realName: '', email: '' },
			{ id: 'U_BETA', name: 'Zeta Real', realName: 'Zeta Real', email: '' },
		]);
	});

	it('paginates users.list via cursor (FR-004)', async () => {
		const { slack, usersList } = makeSlack();
		usersList
			.mockResolvedValueOnce({
				members: [{ id: 'U1', name: 'a', profile: { display_name: 'a', real_name: 'A' } }],
				response_metadata: { next_cursor: 'next' },
			})
			.mockResolvedValueOnce({
				members: [{ id: 'U2', name: 'b', profile: { display_name: 'b', real_name: 'B' } }],
				response_metadata: { next_cursor: '' },
			});

		const result = await getSlackUsers(slack);

		expect(usersList).toHaveBeenCalledTimes(2);
		expect(usersList.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next' });
		expect(result.items.map((u) => u.id)).toEqual(['U1', 'U2']);
	});
});

describe('US1: getSolidarityChapters', () => {
	it('returns mapped, sorted chapter entries (FR-003, FR-005, FR-006)', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			chaptersPage([
				{ id: 2, name: 'Beta' },
				{ id: 1, name: 'Alpha' },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityChapters('token');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stale).toBe(false);
		expect(result.items).toEqual([
			{ id: 1, name: 'Alpha' },
			{ id: 2, name: 'Beta' },
		]);
	});

	it('paginates /v1/chapters by offset until a short page is returned (FR-004)', async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: `chapter-${String(i + 1).padStart(3, '0')}`,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(chaptersPage(fullPage))
			.mockResolvedValueOnce(chaptersPage([{ id: 200, name: 'chapter-200' }]));
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityChapters('token');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.items).toHaveLength(101);
	});
});

describe('getSolidarityCustomProperties', () => {
	it('maps key/label (real API shape), accepts internal_name fallback, drops keyless, sorts', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			chaptersPage([
				// Real shape: key + label + name.
				{ id: 3, key: 'labor-union', name: 'Labor Union', label: 'Labor Union' },
				// Docs-termed fallback shape.
				{ id: 4, internal_name: 'clergy' },
				// No usable key → dropped.
				{ id: 5, name: 'Orphan Property' },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityCustomProperties('token');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/custom_user_properties');
		expect(result.items).toEqual([
			{ internalName: 'clergy', name: 'clergy' },
			{ internalName: 'labor-union', name: 'Labor Union' },
		]);
	});
});

describe('getSolidarityUserLists', () => {
	it('maps id/name, tolerates missing names, sorts by name', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			chaptersPage([
				{ id: 9, name: 'Zeta list' },
				{ id: 7, name: 'Alpha list' },
				{ id: 8 }, // unnamed → synthesized label
				{ name: 'No id' }, // no numeric id → dropped
			]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityUserLists('token');

		expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/user_lists');
		expect(result.items).toEqual([
			{ id: 7, name: 'Alpha list' },
			{ id: 8, name: 'List 8' },
			{ id: 9, name: 'Zeta list' },
		]);
	});
});

// ===========================================================================
// User Story 2 — lists stay fast without going stale
// ===========================================================================

describe('US2: cache + force + de-dup', () => {
	it('warm call within the 5-minute TTL hits cache, not the API (FR-007, SC-002)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValue({
			channels: [{ id: 'C1', name: 'a', is_private: false }],
		});

		const first = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(1);

		// Advance 4 minutes — still inside the TTL window.
		vi.advanceTimersByTime(4 * 60 * 1000);
		const second = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		expect(second.stale).toBe(false);
	});

	it('refetches after the TTL elapses (FR-008)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		const second = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(second.items[0]?.id).toBe('C2');
	});

	it('force: true bypasses a fresh cache and replaces it (FR-009)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		const forced = await getSlackChannels(slack, { force: true });

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(forced.items[0]?.id).toBe('C2');
		expect(forced.stale).toBe(false);

		// The forced result replaces the cache: a subsequent warm read returns it.
		const warm = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(warm.items[0]?.id).toBe('C2');
	});

	it('an empty upstream response is cached normally; second call hits the cache (edge case: empty workspace)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValueOnce({ channels: [] });

		const first = await getSlackChannels(slack);
		expect(first.items).toEqual([]);
		expect(first.stale).toBe(false);
		expect(conversationsList).toHaveBeenCalledTimes(1);

		const second = await getSlackChannels(slack);
		expect(second.items).toEqual([]);
		expect(second.stale).toBe(false);
		expect(conversationsList).toHaveBeenCalledTimes(1);
	});

	it('two concurrent cold callers share one upstream fetch (FR-007a, SC-002)', async () => {
		const { slack, conversationsList } = makeSlack();
		let resolveFetch!: (v: SlackMockResponse) => void;
		const pending = new Promise<SlackMockResponse>((r) => {
			resolveFetch = r;
		});
		conversationsList.mockReturnValueOnce(pending);

		const p1 = getSlackChannels(slack);
		const p2 = getSlackChannels(slack);

		// Both started before the upstream call resolves — only one call issued.
		expect(conversationsList).toHaveBeenCalledTimes(1);

		resolveFetch({ channels: [{ id: 'C1', name: 'shared', is_private: false }] });
		const [a, b] = await Promise.all([p1, p2]);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
		expect(a.items[0]?.id).toBe('C1');
	});
});

// ===========================================================================
// User Story 4 — upstream outages degrade gracefully
// ===========================================================================

describe('US4: failure handling and stale-serve', () => {
	it('expired cache + failing refetch → resolves { stale: true } with the retained items (FR-010a)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockRejectedValueOnce(new Error('slack 503'))
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		const stale = await getSlackChannels(slack);
		expect(stale.stale).toBe(true);
		expect(stale.items[0]?.id).toBe('C1');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[autocomplete] channels refetch failed/),
		);

		// The entry was NOT updated, so the next call retries the upstream and
		// — when it succeeds — replaces the cache (FR-010a final clause).
		const recovered = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(3);
		expect(recovered.stale).toBe(false);
		expect(recovered.items[0]?.id).toBe('C2');
	});

	it('cold cache + fetch fails → rejects, logs at error level (FR-011)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockRejectedValueOnce(new Error('slack unreachable'));

		await expect(getSlackChannels(slack)).rejects.toThrow(/slack unreachable/);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[autocomplete] channels fetch failed \(no cached data\)/),
		);
	});

	it('Solidarity retry-budget exhaustion surfaces as a fetch failure (FR-004a)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {}); // mute the per-retry [autocomplete] warn
		const rateLimited = {
			ok: false,
			status: 429,
			headers: new Headers({ 'Retry-After': '0' }),
			json: async () => ({}),
			text: async () => 'rate limited',
		} as unknown as Response;
		// 6 consecutive 429s — first hit plus 5 retries — exhausts the budget.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited);
		vi.stubGlobal('fetch', fetchMock);

		await expect(getSolidarityChapters('token')).rejects.toThrow(/retry budget exhausted/);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[autocomplete] chapters fetch failed/),
		);
	});
});

// ===========================================================================
// NAV-3 (007-settings-shell-primitives) — fetchedAt surfaces the cache age
// for the settings page's "Last refreshed Nm ago" indicator.
// ===========================================================================

describe('NAV-3: AutocompleteResult.fetchedAt', () => {
	it('cold successful fetch sets fetchedAt to roughly Date.now()', async () => {
		vi.useFakeTimers();
		const now = new Date('2026-05-26T08:00:00Z').getTime();
		vi.setSystemTime(now);
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValueOnce({
			channels: [{ id: 'C1', name: 'a', is_private: false }],
		});

		const result = await getSlackChannels(slack);

		expect(result.fetchedAt).toBe(now);
	});

	it('warm (within-TTL) call returns the same fetchedAt as the original fetch', async () => {
		vi.useFakeTimers();
		const t0 = new Date('2026-05-26T08:00:00Z').getTime();
		vi.setSystemTime(t0);
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValue({
			channels: [{ id: 'C1', name: 'a', is_private: false }],
		});

		const first = await getSlackChannels(slack);
		expect(first.fetchedAt).toBe(t0);

		// Advance 4 minutes — still inside the 5-minute TTL.
		vi.advanceTimersByTime(4 * 60 * 1000);
		const warm = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(warm.fetchedAt).toBe(t0); // unchanged from the original successful fetch
	});

	it('stale-serve after a refetch failure carries the ORIGINAL successful fetchedAt, not the failed-refetch time', async () => {
		vi.useFakeTimers();
		const t0 = new Date('2026-05-26T08:00:00Z').getTime();
		vi.setSystemTime(t0);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockRejectedValueOnce(new Error('slack 503'));

		const fresh = await getSlackChannels(slack);
		expect(fresh.fetchedAt).toBe(t0);

		// Push past the TTL so the next call attempts a refetch (which is mocked to reject).
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		const stale = await getSlackChannels(slack);
		expect(stale.stale).toBe(true);
		// fetchedAt MUST reflect the original t0, not Date.now() (which is now t0 + 5m + 1ms).
		expect(stale.fetchedAt).toBe(t0);
	});
});

// ===========================================================================
// Solidarity roster — the manual-link picker's search source
// ===========================================================================

/** A `/v1/users` page. `count` rows, so a full 100 keeps the walk going. */
function rosterPage(items: unknown[]) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({ data: items }),
		text: async () => '',
	} as unknown as Response;
}

function rawUser(id: number, over: Record<string, unknown> = {}) {
	return { id, email: `u${id}@example.org`, first_name: 'First', last_name: `Last${id}`, ...over };
}

describe('getSolidarityMembers', () => {
	it('maps raw users to lean id/name/email entries, sorted by name', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				rosterPage([
					rawUser(2, { first_name: 'Zoe', last_name: 'Zulu' }),
					rawUser(1, { first_name: 'Ada', last_name: 'Alpha' }),
				]),
			);
		vi.stubGlobal('fetch', fetchMock);

		const { items } = await getSolidarityMembers('tok');

		expect(items).toEqual([
			{ id: 1, name: 'Ada Alpha', email: 'u1@example.org', otherEmails: [], chapterIds: [] },
			{ id: 2, name: 'Zoe Zulu', email: 'u2@example.org', otherEmails: [], chapterIds: [] },
		]);
	});

	it('lowercases emails and carries other_emails', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					rosterPage([
						rawUser(1, { email: 'MiXeD@Example.ORG', other_emails: ['Alt@Example.ORG', '', null] }),
					]),
				),
		);

		const { items } = await getSolidarityMembers('tok');

		expect(items[0]!.email).toBe('mixed@example.org');
		expect(items[0]!.otherEmails).toEqual(['alt@example.org']);
	});

	it('falls back through alternate_name, email, then the id for a name', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					rosterPage([
						{ id: 1, first_name: null, last_name: null, alternate_name: 'Nickname' },
						{ id: 2, email: 'only-email@example.org' },
						{ id: 3 },
					]),
				),
		);

		const names = (await getSolidarityMembers('tok')).items.map((i) => i.name).sort();

		expect(names).toEqual(['Nickname', 'Solidarity user 3', 'only-email@example.org']);
	});

	it('uses a 60-minute TTL, not the 5-minute default', async () => {
		vi.useFakeTimers();
		const t0 = new Date('2026-05-26T08:00:00Z').getTime();
		vi.setSystemTime(t0);
		const fetchMock = vi.fn().mockResolvedValue(rosterPage([rawUser(1)]));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 10 minutes: well past the shared 5-minute TTL, still fresh for the roster.
		vi.advanceTimersByTime(10 * 60 * 1000);
		const warm = await getSolidarityMembers('tok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warm.fetchedAt).toBe(t0);

		// Past 60 minutes: refetched.
		vi.advanceTimersByTime(51 * 60 * 1000);
		await getSolidarityMembers('tok');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('force bypasses the cache', async () => {
		const fetchMock = vi.fn().mockResolvedValue(rosterPage([rawUser(1)]));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok');
		await getSolidarityMembers('tok', { force: true });

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('serves stale data when a refetch fails', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-26T08:00:00Z').getTime());
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rosterPage([rawUser(1)]))
			.mockRejectedValueOnce(new Error('network down'));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok');
		vi.advanceTimersByTime(61 * 60 * 1000);
		const stale = await getSolidarityMembers('tok');

		expect(stale.stale).toBe(true);
		expect(stale.items).toHaveLength(1);
	});

	it('rejects when the cache is cold and the fetch fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

		await expect(getSolidarityMembers('tok')).rejects.toThrow('network down');
	});

	it('does not serve one token’s roster to a different token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(rosterPage([rawUser(1)]));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('token-a');
		await getSolidarityMembers('token-b');

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('is cleared by _resetAutocompleteCachesForTests', async () => {
		const fetchMock = vi.fn().mockResolvedValue(rosterPage([rawUser(1)]));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok');
		_resetAutocompleteCachesForTests();
		await getSolidarityMembers('tok');

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

// ===========================================================================
// Stale-while-revalidate — the roster's cold walk is ~2 minutes, so callers
// can opt out of ever waiting for it.
// ===========================================================================

describe('getSolidarityMembers with staleWhileRevalidate', () => {
	const SWR = { staleWhileRevalidate: true } as const;

	it('returns immediately with empty items on a cold cache, flagged refreshing', async () => {
		// A walk that never settles during the test — the point is that the call
		// does not wait for it.
		const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityMembers('tok', SWR);

		expect(result.items).toEqual([]);
		expect(result.refreshing).toBe(true);
		expect(result.fetchedAt).toBe(0);
		// The walk was still started.
		expect(fetchMock).toHaveBeenCalled();
	});

	it('serves the previous list while a refresh runs', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-26T08:00:00Z').getTime());
		let resolveSecond: ((r: Response) => void) | null = null;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rosterPage([rawUser(1)]))
			.mockImplementationOnce(() => new Promise<Response>((r) => (resolveSecond = r)));
		vi.stubGlobal('fetch', fetchMock);

		// Warm the cache, then age it past the 60-minute TTL.
		await getSolidarityMembers('tok');
		vi.advanceTimersByTime(61 * 60 * 1000);

		const result = await getSolidarityMembers('tok', SWR);

		// Answered from the old list rather than waiting for the new one.
		expect(result.items).toHaveLength(1);
		expect(result.refreshing).toBe(true);
		expect(resolveSecond).not.toBeNull();
	});

	it('does not report refreshing once the cache is fresh', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rosterPage([rawUser(1)])));

		await getSolidarityMembers('tok');
		const result = await getSolidarityMembers('tok', SWR);

		expect(result.refreshing).toBeFalsy();
		expect(result.items).toHaveLength(1);
	});

	it('does not start a second walk while one is already in flight', async () => {
		const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok', SWR);
		await getSolidarityMembers('tok', SWR);
		await getSolidarityMembers('tok', SWR);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// A background walk that fails must not surface as an unhandled rejection,
	// and must not take the caller down with it.
	it('keeps serving the retained list when the background refresh fails', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-26T08:00:00Z').getTime());
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rosterPage([rawUser(1)]))
			.mockRejectedValueOnce(new Error('network down'));
		vi.stubGlobal('fetch', fetchMock);

		await getSolidarityMembers('tok');
		vi.advanceTimersByTime(61 * 60 * 1000);

		const during = await getSolidarityMembers('tok', SWR);
		expect(during.items).toHaveLength(1);

		// Let the failing refresh settle, then confirm the old list survives.
		await vi.runAllTimersAsync();
		const after = await getSolidarityMembers('tok', SWR);
		expect(after.items).toHaveLength(1);
	});

	it('never rejects on a cold cache, unlike the blocking path', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

		await expect(getSolidarityMembers('tok', SWR)).resolves.toMatchObject({
			items: [],
			refreshing: true,
		});
	});

	it('leaves the blocking path unchanged for callers that omit the flag', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rosterPage([rawUser(1)])));

		const result = await getSolidarityMembers('tok');

		expect(result.refreshing).toBe(false);
		expect(result.items).toHaveLength(1);
	});
});

// ===========================================================================
// Channel-vs-chapter diff — per-chapter membership
// ===========================================================================

describe('getSolidarityChapterMembers', () => {
	it('buckets the roster by chapter and returns lean id/email entries', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					rosterPage([
						rawUser(1, { chapter_ids: [7] }),
						rawUser(2, { chapter_ids: [8, 9] }),
						rawUser(3, { chapter_ids: [] }),
						rawUser(4, {}),
						rawUser(5, { chapter_ids: [9, 7] }),
					]),
				),
		);

		const { items } = await getSolidarityChapterMembers('tok', 7);

		expect(items).toEqual([
			{ id: 1, email: 'u1@example.org' },
			{ id: 5, email: 'u5@example.org' },
		]);
	});

	it('honours the legacy singular chapter_id when chapter_ids is absent', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					rosterPage([rawUser(1, { chapter_id: 7 }), rawUser(2, { chapter_id: 8 })]),
				),
		);

		const { items } = await getSolidarityChapterMembers('tok', 7);

		expect(items).toEqual([{ id: 1, email: 'u1@example.org' }]);
	});

	it('lowercases emails and keeps members with none as an empty string', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					rosterPage([
						rawUser(1, { chapter_ids: [7], email: '  MiXeD@Example.ORG ' }),
						rawUser(2, { chapter_ids: [7], email: null }),
					]),
				),
		);

		const { items } = await getSolidarityChapterMembers('tok', 7);

		expect(items).toEqual([
			{ id: 1, email: 'mixed@example.org' },
			{ id: 2, email: '' },
		]);
	});

	// The reason this is derived from the roster rather than asking upstream per
	// chapter: /v1/users ignores a chapter filter, so a second chapter would
	// otherwise mean a second full-roster walk.
	it('answers a second chapter from the same single roster walk', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				rosterPage([rawUser(1, { chapter_ids: [7] }), rawUser(2, { chapter_ids: [8] })]),
			);
		vi.stubGlobal('fetch', fetchMock);

		const first = await getSolidarityChapterMembers('tok', 7);
		const second = await getSolidarityChapterMembers('tok', 8);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(first.items).toEqual([{ id: 1, email: 'u1@example.org' }]);
		expect(second.items).toEqual([{ id: 2, email: 'u2@example.org' }]);
	});
});
