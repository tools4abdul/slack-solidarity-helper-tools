import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load } from './+page.server.js';

const mockSettings = vi.hoisted(() => vi.fn());
const mockHoldings = vi.hoisted(() => vi.fn());
const mockCompletions = vi.hoisted(() => vi.fn());
const mockDriftTurfs = vi.hoisted(() => vi.fn());
const mockDriftClaims = vi.hoisted(() => vi.fn());
const mockDriftVisibility = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/settings.js', () => ({ loadSettings: mockSettings }));
vi.mock('$lib/server/van/drift-store.js', () => ({
	loadDriftTurfs: mockDriftTurfs,
	loadDriftClaims: mockDriftClaims,
	loadDriftVisibility: mockDriftVisibility,
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
		mapRouteId: 100,
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
		mapRouteId: 900,
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
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), { chapterId: null });
	});

	it('scopes both queries to a chosen chapter', async () => {
		await run(event(ADMIN, 'chapter=71'));
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), { chapterId: 71 });
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
		expect(mockHoldings).toHaveBeenCalledWith(expect.anything(), { chapterId: null });
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
			holdingRow({ checkoutId: 1, mapRouteId: 1, slackUserId: 'U_A', doorCount: 100 }),
			holdingRow({ checkoutId: 2, mapRouteId: 2, slackUserId: 'U_A', doorCount: 200 }),
			holdingRow({
				checkoutId: 3,
				mapRouteId: 3,
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
		const serialised = JSON.stringify(await run(event(ADMIN))).toLowerCase();
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
			mapRouteId: 100,
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
		mapRouteId: 100,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: iso(NOW.getTime() - HOUR),
		expiresAt: iso(NOW.getTime() + 40 * HOUR),
		releasedAt: null,
		completedAt: null,
	};

	it('flags turf claimed here but absent from MiniVAN', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf()]);
		mockDriftClaims.mockResolvedValue([liveClaim]);
		const data = await run(event(ADMIN));
		expect(data.drift.claimedNotInMinivan).toBe(1);
		expect(data.drift.items[0]).toMatchObject({ kind: 'claimed-not-in-minivan', heldBy: 'Dana' });
	});

	it('flags turf in MiniVAN that nobody claimed here', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf({ vanDistributedTo: 'Sam Rivera' })]);
		const data = await run(event(ADMIN));
		expect(data.drift.inMinivanNotClaimed).toBe(1);
		expect(data.drift.items[0]!.distributedTo).toBe('Sam Rivera');
	});

	it('says nothing when the two agree', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf({ vanDistributedTo: 'Dana' })]);
		mockDriftClaims.mockResolvedValue([liveClaim]);
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
		expect(mockDriftTurfs).toHaveBeenCalledWith(expect.anything(), { chapterId: 71 });
		expect(mockDriftClaims).toHaveBeenCalledWith(expect.anything(), { chapterId: 71 });
	});

	// Same instant as the holdings board, or a claim expiring between the two
	// reads shows as held in one pane and drifted in the other.
	it('judges drift against the same clock as the board', async () => {
		mockDriftTurfs.mockResolvedValue([driftTurf()]);
		mockDriftClaims.mockResolvedValue([{ ...liveClaim, expiresAt: iso(NOW.getTime() - HOUR) }]);
		expect((await run(event(ADMIN))).drift.items).toEqual([]);
	});
});
