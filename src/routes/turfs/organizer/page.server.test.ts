import { describe, it, expect, vi, beforeEach } from 'vitest';
import { actions, load } from './+page.server.js';
import { campaignFilter } from '$lib/server/van/campaigns.js';

const mockSettings = vi.hoisted(() => vi.fn());
const mockHoldings = vi.hoisted(() => vi.fn());
const mockCompletions = vi.hoisted(() => vi.fn());
const mockDriftTurfs = vi.hoisted(() => vi.fn());
const mockDriftClaims = vi.hoisted(() => vi.fn());
const mockDriftVisibility = vi.hoisted(() => vi.fn());

const mockGeometryProgress = vi.hoisted(() => vi.fn());
const mockLastVanSync = vi.hoisted(() => vi.fn());
const mockStartSync = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'secret', PORT: 3000 }));
const mockRefreshSwitches = vi.hoisted(() =>
	vi.fn(async () => ({ on: [] as string[], off: ['One Team Michigan'] })),
);

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => mockEnv);
vi.mock('$lib/server/van/manual-sync.js', () => ({
	lastVanSyncs: mockLastVanSync,
	startManualVanSync: mockStartSync,
}));
vi.mock('$lib/server/settings.js', () => ({ loadSettings: mockSettings }));
vi.mock('$lib/server/van/campaigns.js', () => ({
	campaignRefreshSwitches: mockRefreshSwitches,
	// One campaign: no picker, no badges.
	campaignFilter: vi.fn(async () => ({ campaigns: [], campaign: null, badges: {} })),
}));
vi.mock('$lib/server/van/drift-store.js', () => ({
	loadDriftTurfs: mockDriftTurfs,
	loadDriftClaims: mockDriftClaims,
	loadDriftVisibility: mockDriftVisibility,
}));
// Campaign-wide, so it takes no query and every test gets the same quiet
// "nothing outstanding" answer unless it says otherwise.
vi.mock('$lib/server/van/geometry-progress-store.js', () => ({
	loadGeometryProgress: mockGeometryProgress,
}));
vi.mock('$lib/server/van/holdings-store.js', () => ({
	COMPLETION_LOOKBACK: 200,
	loadCurrentHoldings: mockHoldings,
	loadRecentCompletions: mockCompletions,
}));

// Two rows per chapter, because chapter_channel_map is keyed by CHANNEL and in
// production every chapter has two. The single-row-per-chapter fixture this
// replaces is why the suite never caught the duplicate-key crash.
const CHAPTERS = [
	{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
	{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
	{ chapterId: 72, channelId: 'C4', name: 'Wayne County' },
	{ chapterId: 71, channelId: 'C3', name: 'Washtenaw County' },
];

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Admin', isAdmin: true };
const NOW = new Date('2026-09-02T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const event = (session: unknown, query?: string) =>
	({
		locals: { session },
		url: new URL(`https://app.example/turfs/organizer${query ? `?${query}` : ''}`),
	}) as never;

function holdingRow(over: Record<string, unknown> = {}) {
	return {
		checkoutId: 1,
		turfId: 100,
		turfName: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		doorCount: 250,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: iso(NOW.getTime() - 10 * HOUR),
		expiresAt: iso(NOW.getTime() + 30 * HOUR),
		releasedAt: null,
		completedAt: null,
		expiryWarnedAt: null,
		...over,
	};
}

function completionRow(over: Record<string, unknown> = {}) {
	return {
		checkoutId: 9,
		turfId: 900,
		turfName: 'Turf 09',
		regionName: 'Ypsilanti',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		completedAt: iso(NOW.getTime() - 3 * HOUR),
		confirmedDoorDelta: null,
		...over,
	};
}

async function run(ev: never) {
	const result = await load(ev);
	if (!result) throw new Error('expected the load function to return data');
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	mockSettings.mockResolvedValue({ chapterChannelMap: CHAPTERS });
	mockLastVanSync.mockResolvedValue([]);
	mockEnv.INTERNAL_CRON_SECRET = 'secret';
	mockGeometryProgress.mockResolvedValue({
		eligible: 0,
		shaped: 0,
		centroidOnly: 0,
		pending: 0,
		failed: 0,
	});
	mockHoldings.mockResolvedValue([holdingRow()]);
	mockCompletions.mockResolvedValue([completionRow()]);
	mockDriftTurfs.mockResolvedValue([]);
	mockDriftClaims.mockResolvedValue([]);
	mockDriftVisibility.mockResolvedValue('visible');
});

describe('/turfs/organizer access', () => {
	// One check covers both, per the constitution's Principle I.
	it.each([
		['no session', null],
		['a non-admin', { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false }],
	])('redirects %s to the dashboard', async (_label, session) => {
		await expect(load(event(session))).rejects.toMatchObject({ status: 302, location: '/' });
	});

	// The gate has to come first: a load that queried and then redirected would
	// still have read the ledger for someone who may not see it.
	it('reads nothing for a non-admin', async () => {
		await expect(load(event(null))).rejects.toMatchObject({ status: 302 });
		expect(mockHoldings).not.toHaveBeenCalled();
		expect(mockCompletions).not.toHaveBeenCalled();
	});
});

describe('/turfs/organizer filters', () => {
	it('defaults to every chapter', async () => {
		const data = await run(event(ADMIN));
		expect(data.chapter).toBeNull();
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), {
			chapterId: null,
			campaignId: null,
		});
	});

	// An admin's turf-only chapter is listed and scopes like a real one.
	it('lists and scopes to a turf-only chapter', async () => {
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			turfCustomChapters: [{ chapterId: -1, name: 'Ann Arbor outreach' }],
		});
		const data = await run(event(ADMIN, 'chapter=-1'));
		expect(data.chapters[0]).toEqual({ chapterId: -1, name: 'Ann Arbor outreach' });
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), {
			chapterId: -1,
			campaignId: null,
		});
	});

	it('scopes both queries to a chosen chapter', async () => {
		await run(event(ADMIN, 'chapter=71'));
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), {
			chapterId: 71,
			campaignId: null,
		});
		expect(mockCompletions).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71 }),
		);
	});

	it.each([
		['an unknown chapter', 'chapter=4242'],
		['a non-numeric chapter', 'chapter=banana'],
	])('falls back to every chapter for %s', async (_label, query) => {
		const data = await run(event(ADMIN, query));
		expect(data.chapter).toBeNull();
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), {
			chapterId: null,
			campaignId: null,
		});
	});

	// specs/012-multi-van-campaigns: the picker's choice reaches every query,
	// and the page gets the list and the badges to render.
	it('scopes the queries to a picked campaign', async () => {
		vi.mocked(campaignFilter).mockResolvedValueOnce({
			campaigns: [
				{ id: 1, name: 'One Team Michigan' },
				{ id: 2, name: 'Partner' },
			],
			campaign: { id: 2, name: 'Partner' },
			badges: { 1: 'OTM', 2: 'Partner' },
		});
		const data = await run(event(ADMIN, 'campaign=2'));
		expect(vi.mocked(campaignFilter)).toHaveBeenCalledWith(expect.anything(), '2');
		expect(data.campaign).toEqual({ id: 2, name: 'Partner' });
		expect(data.campaigns).toHaveLength(2);
		expect(data.campaignBadges).toEqual({ 1: 'OTM', 2: 'Partner' });
		for (const mock of [mockHoldings, mockCompletions, mockDriftTurfs, mockDriftClaims]) {
			expect(mock).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ campaignId: 2 }),
			);
		}
		// The drift report's "can we see VAN's side" is about the same campaign.
		expect(mockDriftVisibility).toHaveBeenCalledWith(expect.anything(), 2);
	});

	it('sorts the chapter picker by name', async () => {
		const data = await run(event(ADMIN));
		expect(data.chapters.map((c: { name: string }) => c.name)).toEqual([
			'Washtenaw County',
			'Wayne County',
		]);
	});

	it('formats the relative labels server-side against the load\u2019s own now', async () => {
		// These used to be computed in the component from Date.now() at render
		// time, so SSR stamped the server's clock and hydration the browser's.
		// Asserting the exact strings here is what pins them to the load function:
		// the fixtures are 10h and 3h before NOW, and nothing in the component can
		// reach a clock any more.
		// confirmedDoorDelta: 0 is what makes a completion suspect; the default
		// fixture leaves it null, meaning "not checked yet".
		mockCompletions.mockResolvedValue([completionRow({ confirmedDoorDelta: 0 })]);
		const data = await run(event(ADMIN));

		expect(data.holdings[0].claimedAgoLabel).toBe('10h ago');
		expect(data.suspects[0].completedAgoLabel).toBe('3h ago');
	});

	it('lists each chapter once, whatever the channel map does', async () => {
		// A chapter with two Slack channels has two rows. Passing both through
		// gave the picker's keyed {#each} a duplicate chapterId, which throws
		// each_key_duplicate — an uncaught error during hydration that took the
		// whole page's client-side app down with it: the top bar lost its theme
		// toggle, menu, username and log-out button, and clicking the menu item
		// did nothing until a manual reload.
		const data = await run(event(ADMIN));
		const ids = data.chapters.map((c: { chapterId: number }) => c.chapterId);

		expect(ids).toEqual([71, 72]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('/turfs/organizer board', () => {
	it('lists a live claim with a campaign-local expiry label', async () => {
		const data = await run(event(ADMIN));
		expect(data.holdings).toHaveLength(1);
		expect(data.holdings[0]).toMatchObject({
			turfName: 'Turf 01',
			slackUserName: 'Dana',
			hoursLeft: 30,
			urgency: 'fine',
			warned: false,
		});
		// 2026-09-04T00:00Z is 8:00 PM on the 3rd in Detroit under EDT.
		expect(data.holdings[0]!.expiresLabel).toContain('8:00 PM');
	});

	it('drops a claim the sweep has not stamped but which has lapsed', async () => {
		mockHoldings.mockResolvedValue([holdingRow({ expiresAt: iso(NOW.getTime() - HOUR) })]);
		const data = await run(event(ADMIN));
		expect(data.holdings).toEqual([]);
		expect(data.summary.turfsOut).toBe(0);
	});

	it('summarises what is out', async () => {
		mockHoldings.mockResolvedValue([
			holdingRow({ checkoutId: 1, turfId: 1, slackUserId: 'U_A', doorCount: 100 }),
			holdingRow({ checkoutId: 2, turfId: 2, slackUserId: 'U_A', doorCount: 200 }),
			holdingRow({
				checkoutId: 3,
				turfId: 3,
				slackUserId: 'U_B',
				doorCount: 50,
				expiresAt: iso(NOW.getTime() + 2 * HOUR),
			}),
		]);
		const data = await run(event(ADMIN));
		expect(data.summary).toEqual({
			turfsOut: 3,
			holders: 2,
			doorsOut: 350,
			expiring: 1,
			expiringUnwarned: 1,
		});
	});

	// The number that means someone has to pick up a phone.
	it('does not count an expiring claim as unwarned once the DM went out', async () => {
		mockHoldings.mockResolvedValue([
			holdingRow({
				expiresAt: iso(NOW.getTime() + 2 * HOUR),
				expiryWarnedAt: iso(NOW.getTime() - HOUR),
			}),
		]);
		const data = await run(event(ADMIN));
		expect(data.summary.expiring).toBe(1);
		expect(data.summary.expiringUnwarned).toBe(0);
	});
});

describe('/turfs/organizer missed-sync pane', () => {
	// The distinction the pane hangs on: with Story 5.6 unbuilt, every delta is
	// null, and reporting that as "all clear" would present a check that has
	// never run as a passing one.
	it('reports that nothing has been checked when every delta is null', async () => {
		const data = await run(event(ADMIN));
		expect(data.deltaChecked).toBe(false);
		expect(data.suspects).toEqual([]);
		expect(data.completionsExamined).toBe(1);
	});

	// The empty state says what the check is waiting on, and that depends on
	// whether the sync asks VAN for re-cuts or an organizer has to — which is
	// each campaign's own switch, so the page gets them by name.
	it('passes on which campaigns have region re-cuts switched on', async () => {
		const switches = { on: ['One Team Michigan'], off: ['Partner'] };
		mockRefreshSwitches.mockResolvedValue(switches);
		expect((await run(event(ADMIN))).regionRefresh).toEqual(switches);
	});

	it('flags only a measured zero', async () => {
		mockCompletions.mockResolvedValue([
			completionRow({ checkoutId: 1, confirmedDoorDelta: null }),
			completionRow({ checkoutId: 2, confirmedDoorDelta: 0 }),
			completionRow({ checkoutId: 3, confirmedDoorDelta: 120 }),
		]);
		const data = await run(event(ADMIN));
		expect(data.deltaChecked).toBe(true);
		expect(data.suspects.map((s: { checkoutId: number }) => s.checkoutId)).toEqual([2]);
	});

	it('says all clear when deltas were measured and none was zero', async () => {
		mockCompletions.mockResolvedValue([completionRow({ confirmedDoorDelta: 120 })]);
		const data = await run(event(ADMIN));
		expect(data.deltaChecked).toBe(true);
		expect(data.suspects).toEqual([]);
	});

	it('labels a suspect completion in campaign-local time', async () => {
		mockCompletions.mockResolvedValue([completionRow({ confirmedDoorDelta: 0 })]);
		const data = await run(event(ADMIN));
		expect(data.suspects[0]!.completedLabel).toContain('11:00 AM');
	});
});

describe('/turfs/organizer payload', () => {
	// The credential rule and the PII rule, asserted on the payload rather than
	// the template — a redaction that only exists in markup still ships in SSR.
	it('carries no list number and nothing address-like', async () => {
		mockCompletions.mockResolvedValue([completionRow({ confirmedDoorDelta: 0 })]);
		// `account` is the holder's own Slack/Google mark, with a Google
		// volunteer's email for organizers by design (spec 013, FR-015). It is
		// left out here so this keeps guarding what it is for: nothing about a
		// voter, and no list number, reaching the payload.
		const serialised = JSON.stringify(await run(event(ADMIN)), (key, value) =>
			key === 'account' ? undefined : value,
		).toLowerCase();
		for (const field of [
			'printedlist',
			'35536745',
			'address',
			'street',
			'firstname',
			'lastname',
			'phone',
			'email',
			'vanid',
			'latitude',
			'longitude',
		]) {
			expect(serialised).not.toContain(field);
		}
	});

	it('sets the page title', async () => {
		expect((await run(event(ADMIN))).pageTitle).toBe('Turf right now');
	});
});

// Story 8.2. Both sides of the comparison are columns we own, so the pane costs
// no VAN call — but a null van_distributed_to means either "VAN has no export"
// or "we could not ask", and the pane has to tell those apart.
describe('/turfs/organizer drift pane', () => {
	function driftTurf(over: Record<string, unknown> = {}) {
		return {
			turfId: 100,
			name: 'Turf 01',
			regionName: 'Ann Arbor',
			chapterId: 71,
			chapterName: 'Washtenaw County',
			doorCount: 250,
			printedListNumber: '35536745-88712',
			vanDistributedTo: null,
			retiredAt: null,
			...over,
		};
	}
	const liveClaim = {
		turfId: 100,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: iso(NOW.getTime() - 3 * HOUR), // past the 2-hour grace
		expiresAt: iso(NOW.getTime() + 40 * HOUR),
		releasedAt: null,
		completedAt: null,
		loadedInMinivanAt: null,
	};

	it('flags turf claimed here but absent from MiniVAN', async () => {
		// The second turf is evidence that this campaign exports to MiniVAN at
		// all. With nothing exported anywhere in the catalog the report returns
		// `exports-unused` and says nothing — correct, and a different test.
		mockDriftTurfs.mockResolvedValue([
			driftTurf(),
			driftTurf({ turfId: 999, vanDistributedTo: 'Avery Harbison' }),
		]);
		mockDriftClaims.mockResolvedValue([liveClaim]);
		const data = await run(event(ADMIN));
		expect(data.drift.claimedNotInMinivan).toBe(1);
		expect(
			data.drift.items.find((i: { kind: string }) => i.kind === 'claimed-not-in-minivan'),
		).toMatchObject({
			kind: 'claimed-not-in-minivan',
			heldBy: 'Dana',
		});
	});

	// The workflow this campaign actually uses: printed list numbers handed out
	// directly, nothing ever exported to named canvassers. Flagging every claim
	// as "not in MiniVAN" there is noise, so the check reports that it did not
	// run rather than implying agreement.
	it('does not check at all when nothing in the catalog was ever exported', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf()]);
		mockDriftClaims.mockResolvedValue([liveClaim]);
		const data = await run(event(ADMIN));
		expect(data.drift.visibility).toBe('exports-unused');
		expect(data.drift.items).toEqual([]);
	});

	// Dropped as drift: VAN-held turf is already unclaimable (turf-drift.ts).
	it('does not flag turf in MiniVAN that nobody claimed here', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf({ vanDistributedTo: 'Sam Rivera' })]);
		const data = await run(event(ADMIN));
		expect(data.drift.visibility).toBe('visible');
		expect(data.drift.items).toEqual([]);
	});

	it('says nothing when the two agree', async () => {
		mockDriftTurfs.mockResolvedValue([
			driftTurf(),
			driftTurf({ turfId: 999, vanDistributedTo: 'Avery Harbison' }),
		]);
		mockDriftClaims.mockResolvedValue([{ ...liveClaim, loadedInMinivanAt: iso(NOW.getTime()) }]);
		expect((await run(event(ADMIN))).drift.items).toEqual([]);
	});

	// The honesty case, and the same shape as the zero-delta pane above it.
	it('reports nothing and says why when the VAN side is unreadable', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf()]);
		mockDriftClaims.mockResolvedValue([liveClaim]);
		mockDriftVisibility.mockResolvedValue('van-side-unavailable');
		const data = await run(event(ADMIN));
		expect(data.drift.visibility).toBe('van-side-unavailable');
		expect(data.drift.items).toEqual([]);
	});

	it('scopes the drift queries to the chosen chapter', async () => {
		await run(event(ADMIN, 'chapter=71'));
		expect(mockDriftTurfs).toHaveBeenCalledWith(expect.anything(), {
			chapterId: 71,
			campaignId: null,
		});
		expect(mockDriftClaims).toHaveBeenCalledWith(expect.anything(), {
			chapterId: 71,
			campaignId: null,
		});
	});

	// Same instant as the holdings board, or a claim expiring between the two
	// reads shows as held in one pane and drifted in the other.
	it('judges drift against the same clock as the board', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf()]);
		mockDriftClaims.mockResolvedValue([{ ...liveClaim, expiresAt: iso(NOW.getTime() - HOUR) }]);
		expect((await run(event(ADMIN))).drift.items).toEqual([]);
	});
});

describe('/turfs/organizer geometry line', () => {
	it('carries the counts and a sentence about them', async () => {
		mockGeometryProgress.mockResolvedValue({
			eligible: 2188,
			shaped: 1842,
			centroidOnly: 4,
			pending: 342,
			failed: 0,
		});
		const data = await run(event(ADMIN));
		expect(data.geometry).toMatchObject({ eligible: 2188, shaped: 1842, pending: 342 });
		expect(data.geometry.label).toContain('1,842 of 2,188 turfs mapped as shapes');
	});

	// Campaign-wide: the queue drains in one pass for everyone, so scoping it to
	// the selected chapter would report a denominator the worker does not use.
	it('is not scoped to the chapter filter', async () => {
		await run(event(ADMIN, 'chapter=71'));
		expect(mockGeometryProgress).toHaveBeenCalledWith(expect.anything());
		expect(mockGeometryProgress.mock.calls[0]).toHaveLength(1);
	});
});

describe('/turfs/organizer VAN sync', () => {
	type LastSync = {
		lastVanSync: {
			label: string | null;
			perCampaign: { id: number; name: string; label: string | null; failed: boolean }[] | null;
		};
	};
	const ago = (minutes: number) => iso(NOW.getTime() - minutes * 60_000);

	it('says how long ago VAN last synced', async () => {
		mockLastVanSync.mockResolvedValueOnce([
			{ id: 1, name: 'Primary', lastSyncAt: ago(12), failed: false },
		]);
		const data = (await load(event(ADMIN))) as LastSync;
		expect(data.lastVanSync).toEqual({ label: '12m ago', perCampaign: null });
	});

	it('says nothing has synced yet with no sync on record', async () => {
		const data = (await load(event(ADMIN))) as LastSync;
		expect(data.lastVanSync).toEqual({ label: null, perCampaign: null });
	});

	// Seconds apart is the same line on the page, so it is one line.
	it('keeps one line while every campaign reads the same', async () => {
		mockLastVanSync.mockResolvedValueOnce([
			{ id: 1, name: 'Primary', lastSyncAt: ago(12), failed: false },
			{
				id: 2,
				name: 'Partner',
				lastSyncAt: iso(NOW.getTime() - 12 * 60_000 - 20_000),
				failed: false,
			},
		]);
		const data = (await load(event(ADMIN))) as LastSync;
		expect(data.lastVanSync).toEqual({ label: '12m ago', perCampaign: null });
	});

	// A failing campaign must not hide behind another's fresh sync.
	it('names each campaign once they differ', async () => {
		mockLastVanSync.mockResolvedValueOnce([
			{ id: 1, name: 'Primary', lastSyncAt: ago(3), failed: false },
			{ id: 2, name: 'Partner', lastSyncAt: ago(180), failed: false },
			{ id: 3, name: 'New', lastSyncAt: null, failed: false },
		]);
		const data = (await load(event(ADMIN))) as LastSync;
		expect(data.lastVanSync).toEqual({
			label: null,
			perCampaign: [
				{ id: 1, name: 'Primary', label: '3m ago', failed: false },
				{ id: 2, name: 'Partner', label: '3h ago', failed: false },
				{ id: 3, name: 'New', label: null, failed: false },
			],
		});
	});

	// "Will load automatically" was a promise; a failed sync has to show.
	it('names a campaign whose last sync failed, even when the times agree', async () => {
		mockLastVanSync.mockResolvedValueOnce([
			{ id: 1, name: 'Primary', lastSyncAt: ago(12), failed: false },
			{ id: 2, name: 'Partner', lastSyncAt: ago(12), failed: true },
		]);
		const data = (await load(event(ADMIN))) as LastSync;
		expect(data.lastVanSync).toEqual({
			label: null,
			perCampaign: [
				{ id: 1, name: 'Primary', label: '12m ago', failed: false },
				{ id: 2, name: 'Partner', label: '12m ago', failed: true },
			],
		});
	});

	const press = (session: unknown) => actions.syncVan({ locals: { session } } as never);

	it.each([
		['no session', null],
		['a non-admin', { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false }],
	])('refuses %s without starting anything', async (_label, session) => {
		await expect(press(session)).resolves.toMatchObject({ status: 403 });
		expect(mockStartSync).not.toHaveBeenCalled();
	});

	it('starts a sync for an organizer', async () => {
		mockStartSync.mockResolvedValueOnce({ status: 'started', done: Promise.resolve() });
		await expect(press(ADMIN)).resolves.toEqual({ syncStarted: true });
		expect(mockStartSync).toHaveBeenCalledOnce();
	});

	it('says when it will follow a scheduled sync already running', async () => {
		mockStartSync.mockResolvedValueOnce({ status: 'queued', done: Promise.resolve() });
		await expect(press(ADMIN)).resolves.toEqual({ syncQueued: true });
	});

	it('says so when a pressed sync is still running', async () => {
		mockStartSync.mockResolvedValueOnce({ status: 'busy' });
		await expect(press(ADMIN)).resolves.toMatchObject({
			status: 409,
			data: { syncError: expect.stringContaining('already started') },
		});
	});

	// The board must stay up around a failed press, not give way to the error page.
	it('answers on the form when the sync cannot start', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockStartSync.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
		await expect(press(ADMIN)).resolves.toMatchObject({
			status: 500,
			data: { syncError: expect.stringContaining('Could not start') },
		});
	});

	it('fails plainly without the internal secret', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockEnv.INTERNAL_CRON_SECRET = '';
		await expect(press(ADMIN)).resolves.toMatchObject({ status: 500 });
		expect(mockStartSync).not.toHaveBeenCalled();
	});
});
