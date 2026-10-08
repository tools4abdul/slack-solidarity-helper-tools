import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock every server import the load function reaches into so the test runs
// without a real db, slack client, or solidarity token. Mirrors the
// `vi.mock('./env.js', …)` pattern from `src/lib/server/settings.test.ts`.
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: vi.fn(),
	loadVanBlockedUsers: vi.fn(),
	refreshChapterNames: vi.fn(async () => []),
}));

// The campaign list: one campaign, never synced, credentials not set.
vi.mock('$lib/server/van/campaign-status-store.js', () => ({
	loadCampaignSummaries: vi.fn(async () => [
		{
			campaign: {
				id: 1,
				credentialKey: 'primary',
				label: 'One Team Michigan',
				enabled: true,
				disabledAt: null,
			},
			liveTurfs: 0,
			lastSyncAt: null,
			lastError: null,
		},
	]),
}));
const mockEnsureCampaignRows = vi.hoisted(() => vi.fn(async () => [] as string[]));
vi.mock('$lib/server/van-env.js', () => ({
	ensureCampaignRows: mockEnsureCampaignRows,
	credentialStatus: () => ({
		secretName: 'VAN_CAMPAIGN_PRIMARY',
		state: 'missing',
		error: null,
		appName: null,
		databaseMode: null,
		source: null,
	}),
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
vi.mock('$lib/server/env.js', () => ({
	SOLIDARITY_API_TOKEN: 'test-token',
	googleSignInConfigured: () => false,
	appleSignInConfigured: () => false,
}));
vi.mock('$lib/server/outside-volunteers.js', () => ({
	countOutsideVolunteers: async () => ({ google: 0, apple: 0 }),
	loadBlockableOutsideVolunteers: async () => [],
}));

import { load, type SettingsPageData } from './+page.server.js';
import { loadSettings, loadVanBlockedUsers, refreshChapterNames } from '$lib/server/settings.js';
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
	moderatorSlackUserIds: new Set<string>(),
	reportExcludedChapterIds: new Set<number>(),
	zipExcludedChapterIds: new Set<number>(),
	turfHiddenChapterIds: new Set<number>(),
	turfCustomChapters: [],
	slackTrackingChannelId: 'C_TRACK',
	slackGrowthReportChannelId: 'C_GROWTH',
	slackMobilizeSyncChannelId: 'C_GROWTH',
	slackTurfChannelId: 'C_TRACK',
	slackMemberNoteChannelId: '',
	mobilizeContactName: 'Field Team',
	mobilizeContactEmail: 'field@example.org',
	mobilizeContactPhone: '',
	mobilizeImportTag: '',
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
	vanAssignmentTtlHours: 48,
	vanRegionRefreshEnabled: false,
	vanSheetTabName: 'Packet Tracker',
	publicJoinUrl: '',
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

	it('redirects a moderator — they get the Slack commands, not settings', async () => {
		const event = makeEvent({
			session: { slackUserId: 'U2', slackUserName: 'Mo', isAdmin: false, isModerator: true },
		});
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

describe('VAN campaigns', () => {
	it('lists each campaign by name with what its state is, never its credentials', async () => {
		const data = await loadData(makeEvent({ isAdmin: true }));
		expect(data.vanCampaigns).toEqual([
			{
				id: 1,
				name: 'One Team Michigan',
				chip: 'enabled',
				health: 'no-credentials',
				detail: 'VAN_CAMPAIGN_PRIMARY is not set',
				lastSyncAt: null,
				liveTurfs: 0,
			},
		]);
	});
});

// specs/012-multi-van-campaigns: a secret set since the last sync shows up the
// moment an admin looks — and locally, where no scheduler runs, at all.
describe('campaign discovery', () => {
	it('adds rows for new campaign secrets before listing them', async () => {
		await loadData(makeEvent({ isAdmin: true }));
		expect(mockEnsureCampaignRows).toHaveBeenCalledOnce();
	});

	it('still renders the page when discovery fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockEnsureCampaignRows.mockRejectedValueOnce(new Error('db locked'));
		const data = await loadData(makeEvent({ isAdmin: true }));
		expect(data.vanCampaigns).toHaveLength(1);
	});
});

// Stored chapter names drift when Solidarity renames a chapter, and /turfs
// lists chapters by the stored name; this page has the live list, so it fixes them.
describe('chapter names', () => {
	it('brings stored names up to date from the live list, and shows what changed', async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			...settingsFixture,
			chapterChannelMap: [{ chapterId: 1, channelId: 'C1', name: 'New York' }],
		});
		vi.mocked(refreshChapterNames).mockResolvedValueOnce([
			{ chapterId: 1, from: 'New York', to: 'NYC' },
		]);
		const data = await loadData(makeEvent({ isAdmin: true }));
		expect(refreshChapterNames).toHaveBeenCalledWith(expect.anything(), [{ id: 1, name: 'NYC' }]);
		expect(data.renamedChapters).toEqual([{ chapterId: 1, from: 'New York', to: 'NYC' }]);
		// The rest of this load uses the new name, not the one it just replaced.
		expect(data.settings.chapterChannelMap).toEqual([
			{ chapterId: 1, channelId: 'C1', name: 'NYC' },
		]);
	});

	it('does not try without the live list, and survives a failed refresh', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(refreshChapterNames).mockRejectedValueOnce(new Error('database is locked'));
		const data = await loadData(makeEvent({ isAdmin: true }));
		expect(data.renamedChapters).toEqual([]);

		vi.mocked(refreshChapterNames).mockClear();
		vi.mocked(getSolidarityChapters).mockRejectedValueOnce(new Error('Solidarity is down'));
		await loadData(makeEvent({ isAdmin: true }));
		expect(refreshChapterNames).not.toHaveBeenCalled();
	});
});
