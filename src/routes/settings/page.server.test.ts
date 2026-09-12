import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock every server import the load function reaches into so the test runs
// without a real db, slack client, or solidarity token. Mirrors the
// `vi.mock('./env.js', …)` pattern from `src/lib/server/settings.test.ts`.
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: vi.fn(),
	loadVanChapterFolders: vi.fn(),
	loadVanBlockedUsers: vi.fn(),
}));

vi.mock('$lib/server/autocomplete-sources.js', () => ({
	getSlackChannels: vi.fn(),
	getSlackUsers: vi.fn(),
	getSolidarityChapters: vi.fn(),
	getSolidarityCustomProperties: vi.fn(),
	getSolidarityUserLists: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/slack.js', () => ({ slack: {} }));
vi.mock('$lib/server/env.js', () => ({ SOLIDARITY_API_TOKEN: 'test-token' }));

import { load, type SettingsPageData } from './+page.server.js';
import { loadSettings, loadVanChapterFolders, loadVanBlockedUsers } from '$lib/server/settings.js';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
	getSolidarityCustomProperties,
	getSolidarityUserLists,
} from '$lib/server/autocomplete-sources.js';

type LoadEvent = Parameters<typeof load>[0];

// SvelteKit's PageServerLoad return type is intentionally loose
// (`void | Record<string, any>`). The actual shape is SettingsPageData;
// narrow at the call sites so the test assertions get real types.
async function loadData(event: LoadEvent): Promise<SettingsPageData> {
	return (await load(event)) as SettingsPageData;
}

const settingsFixture = {
	chapterChannelMap: [],
	coalitionChannelMap: [],
	allowedSlackUserIds: new Set<string>(),
	reportExcludedChapterIds: new Set<number>(),
	zipExcludedChapterIds: new Set<number>(),
	slackTrackingChannelId: 'C_TRACK',
	slackGrowthReportChannelId: 'C_GROWTH',
	slackMobilizeSyncChannelId: 'C_GROWTH',
	slackTurfChannelId: 'C_TRACK',
	slackMemberNoteChannelId: '',
	mobilizeContactName: 'Field Team',
	mobilizeContactEmail: 'field@example.org',
	mobilizeContactPhone: '',
	slackGrowthReportRankingAlpha: 0.5,
	welcomeDisabledChannelIds: new Set<string>(),
	siteName: '',
	countdownLabel: '',
	countdownEndAt: '',
	welcomeDmMessage: '',
	warningDmMessage: '',
	infoCommands: [],
	doorTickerColumnsPerSecond: 30,
	vanTurfClaimTtlHours: 48,
	vanTurfMaxConcurrentClaims: 2,
};

function makeEvent(overrides: {
	isAdmin?: boolean;
	session?: unknown;
	refresh?: string | null;
}): LoadEvent {
	const refresh = overrides.refresh ?? null;
	const session =
		'session' in overrides
			? overrides.session
			: { slackUserId: 'U1', slackUserName: 'Admin', isAdmin: overrides.isAdmin ?? true };
	return {
		locals: { session },
		url: {
			searchParams: new URLSearchParams(refresh === null ? '' : `refresh=${refresh}`),
		},
	} as unknown as LoadEvent;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadSettings).mockResolvedValue(settingsFixture);
	// VAN settings load alongside the rest. Empty is the normal pre-launch
	// state — no chapter mapped yet means no turf published.
	vi.mocked(loadVanChapterFolders).mockResolvedValue([]);
	vi.mocked(loadVanBlockedUsers).mockResolvedValue([]);
	vi.mocked(getSlackChannels).mockResolvedValue({
		items: [{ id: 'C1', name: 'general', isPrivate: false }],
		stale: false,
		fetchedAt: 1_700_000_000_000,
	});
	vi.mocked(getSlackUsers).mockResolvedValue({
		items: [{ id: 'U1', name: 'alice', realName: 'Alice', email: 'alice@example.com' }],
		stale: false,
		fetchedAt: 1_700_000_000_500,
	});
	vi.mocked(getSolidarityChapters).mockResolvedValue({
		items: [{ id: 1, name: 'NYC' }],
		stale: false,
		fetchedAt: 1_700_000_001_000,
	});
	vi.mocked(getSolidarityCustomProperties).mockResolvedValue({
		items: [{ internalName: 'labor', name: 'Labor Unions' }],
		stale: false,
		fetchedAt: 1_700_000_001_500,
	});
	vi.mocked(getSolidarityUserLists).mockResolvedValue({
		items: [{ id: 42, name: 'Labor coalition' }],
		stale: false,
		fetchedAt: 1_700_000_002_000,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// US1 — admin gate
// ---------------------------------------------------------------------------

describe('US1: admin gate', () => {
	it('redirects 302 to / for a non-admin authenticated session', async () => {
		const event = makeEvent({ isAdmin: false });
		// SvelteKit's redirect() throws an object with `status` and `location`.
		await expect(load(event)).rejects.toMatchObject({ status: 302, location: '/' });
		expect(loadSettings).not.toHaveBeenCalled();
	});

	it('redirects 302 to / when the session is missing entirely (defensive default)', async () => {
		const event = makeEvent({ session: null });
		await expect(load(event)).rejects.toMatchObject({ status: 302, location: '/' });
		expect(loadSettings).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// US1 — happy path
// ---------------------------------------------------------------------------

describe('US1: happy path', () => {
	it('returns SettingsPageData with no errors and a numeric oldestFetchedAt when all sources resolve', async () => {
		const data = await loadData(makeEvent({ isAdmin: true }));

		expect(data.pageTitle).toBe('Settings');
		expect(data.settings).toBe(settingsFixture);
		expect(data.errors).toEqual({});
		expect(data.slackChannels).toMatchObject({ stale: false, fetchedAt: 1_700_000_000_000 });
		expect(data.slackUsers).toMatchObject({ stale: false, fetchedAt: 1_700_000_000_500 });
		expect(data.solidarityChapters).toMatchObject({ stale: false, fetchedAt: 1_700_000_001_000 });
		expect(data.customProperties).toMatchObject({ stale: false, fetchedAt: 1_700_000_001_500 });
		expect(data.userLists).toMatchObject({ stale: false, fetchedAt: 1_700_000_002_000 });
		// oldest of the successful fetches.
		expect(data.oldestFetchedAt).toBe(1_700_000_000_000);
	});
});

// ---------------------------------------------------------------------------
// US1 — loadSettings failure is page-level
// ---------------------------------------------------------------------------

describe('US1: loadSettings failure', () => {
	it('throws a 500 and logs at [settings] when loadSettings rejects', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(loadSettings).mockRejectedValueOnce(new Error('db down'));

		await expect(load(makeEvent({ isAdmin: true }))).rejects.toMatchObject({ status: 500 });
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings] loadSettings failed/),
			expect.anything(),
		);
	});
});

// ---------------------------------------------------------------------------
// US3 — per-source live-list degradation
// ---------------------------------------------------------------------------

describe('US3: per-source degradation', () => {
	it('rejects from getSlackUsers degrade only that source; other lists populated', async () => {
		vi.mocked(getSlackUsers).mockRejectedValueOnce(new Error('slack 503'));

		const data = await loadData(makeEvent({ isAdmin: true }));

		expect(data.slackUsers).toBeNull();
		expect(data.errors.slackUsers).toMatch(/slack 503/);
		expect(data.slackChannels).not.toBeNull();
		expect(data.solidarityChapters).not.toBeNull();
		expect(data.errors.slackChannels).toBeUndefined();
		expect(data.errors.solidarityChapters).toBeUndefined();
		// oldestFetchedAt is over the two surviving sources.
		expect(data.oldestFetchedAt).toBe(1_700_000_000_000);
	});

	it('all list fetchers reject → all slots null, errors has all keys, oldestFetchedAt is null', async () => {
		vi.mocked(getSlackChannels).mockRejectedValueOnce(new Error('channels down'));
		vi.mocked(getSlackUsers).mockRejectedValueOnce(new Error('users down'));
		vi.mocked(getSolidarityChapters).mockRejectedValueOnce(new Error('chapters down'));
		vi.mocked(getSolidarityCustomProperties).mockRejectedValueOnce(new Error('properties down'));
		vi.mocked(getSolidarityUserLists).mockRejectedValueOnce(new Error('lists down'));

		const data = await loadData(makeEvent({ isAdmin: true }));

		expect(data.slackChannels).toBeNull();
		expect(data.slackUsers).toBeNull();
		expect(data.solidarityChapters).toBeNull();
		expect(data.customProperties).toBeNull();
		expect(data.userLists).toBeNull();
		expect(data.errors.slackChannels).toMatch(/channels down/);
		expect(data.errors.slackUsers).toMatch(/users down/);
		expect(data.errors.solidarityChapters).toMatch(/chapters down/);
		expect(data.errors.customProperties).toMatch(/properties down/);
		expect(data.errors.userLists).toMatch(/lists down/);
		expect(data.oldestFetchedAt).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// US2 — ?refresh=lists handling
// ---------------------------------------------------------------------------

describe('US2: ?refresh=lists honoring', () => {
	it('invokes all fetchers with { force: true } when refresh=lists is present', async () => {
		await load(makeEvent({ isAdmin: true, refresh: 'lists' }));

		expect(getSlackChannels).toHaveBeenCalledWith(expect.anything(), { force: true });
		expect(getSlackUsers).toHaveBeenCalledWith(expect.anything(), { force: true });
		expect(getSolidarityChapters).toHaveBeenCalledWith(expect.anything(), { force: true });
		expect(getSolidarityCustomProperties).toHaveBeenCalledWith(expect.anything(), { force: true });
		expect(getSolidarityUserLists).toHaveBeenCalledWith(expect.anything(), { force: true });
	});

	it('invokes all fetchers WITHOUT force when refresh is any other value', async () => {
		await load(makeEvent({ isAdmin: true, refresh: 'something-else' }));

		expect(getSlackChannels).toHaveBeenCalledWith(expect.anything(), { force: false });
		expect(getSlackUsers).toHaveBeenCalledWith(expect.anything(), { force: false });
		expect(getSolidarityChapters).toHaveBeenCalledWith(expect.anything(), { force: false });
		expect(getSolidarityCustomProperties).toHaveBeenCalledWith(expect.anything(), { force: false });
		expect(getSolidarityUserLists).toHaveBeenCalledWith(expect.anything(), { force: false });
	});
});
