import { describe, it, expect, vi, beforeEach } from 'vitest';
import { load } from './+page.server.js';
import { campaignFilter } from '$lib/server/van/campaigns.js';

const mockSettings = vi.hoisted(() => vi.fn());
const mockCounts = vi.hoisted(() => vi.fn());
const mockRows = vi.hoisted(() => vi.fn());
const mockHasAnyTurf = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/settings.js', () => ({ loadSettings: mockSettings }));
// One campaign: no picker, no badges.
vi.mock('$lib/server/van/campaigns.js', () => ({
	campaignFilter: vi.fn(async () => ({ campaigns: [], campaign: null, badges: {} })),
}));
vi.mock('$lib/server/van/activity-store.js', () => ({
	loadActivityCounts: mockCounts,
	loadActivityRows: mockRows,
	hasAnyTurf: mockHasAnyTurf,
}));

const { emptyCounts } = await import('$lib/van/turf-activity.js');

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

const event = (session: unknown, query?: string) =>
	({
		locals: { session },
		url: new URL(`https://app.example/turfs/activity${query ? `?${query}` : ''}`),
	}) as never;

function row(over: Record<string, unknown> = {}) {
	return {
		checkoutId: 1,
		turfId: 100,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		doorCount: 250,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		// Chosen relative to the test clock below so it lands inside every period.
		claimedAt: '2026-08-24T13:10:00.000Z',
		releasedAt: null,
		completedAt: null,
		releaseReason: null,
		confirmedDoorDelta: null,
		reportedPercent: null,
		...over,
	};
}

/** `load` is typed `void | PageData` because the non-admin path redirects
 *  (which throws). Every caller below expects data, so narrow once here. */
async function run(ev: never) {
	const result = await load(ev);
	if (!result) throw new Error('expected the load function to return data');
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-08-24T18:00:00.000Z'));
	mockSettings.mockResolvedValue({ chapterChannelMap: CHAPTERS });
	mockCounts.mockResolvedValue({ ...emptyCounts(), claimed: 1 });
	mockRows.mockResolvedValue([row()]);
	mockHasAnyTurf.mockResolvedValue(true);
});

describe('/turfs/activity access', () => {
	// One check covers both, per the constitution's Principle I: a bare 302 to
	// the dashboard, never an error page and never a flash of content.
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
		expect(mockRows).not.toHaveBeenCalled();
		expect(mockCounts).not.toHaveBeenCalled();
	});
});

describe('/turfs/activity filters', () => {
	it('defaults to every chapter and the default period', async () => {
		const data = await run(event(ADMIN));
		expect(data.chapter).toBeNull();
		expect(data.period).toBe('7');
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: null }),
		);
	});

	it('scopes to a chapter when one is chosen', async () => {
		const data = await run(event(ADMIN, 'chapter=71'));
		expect(data.chapter).toEqual({ chapterId: 71, name: 'Washtenaw County' });
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71 }),
		);
	});

	// An admin's turf-only chapter is listed and scopes like a real one.
	it('lists and scopes to a turf-only chapter', async () => {
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHAPTERS,
			turfCustomChapters: [{ chapterId: -1, name: 'Ann Arbor outreach' }],
		});
		const data = await run(event(ADMIN, 'chapter=-1'));
		expect(data.chapters[0]).toEqual({ chapterId: -1, name: 'Ann Arbor outreach' });
		expect(data.chapter).toEqual({ chapterId: -1, name: 'Ann Arbor outreach' });
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: -1 }),
		);
	});

	// A mistyped URL should show a page, not a 400 — and must not be passed
	// through to the query, where it would silently return nothing at all.
	it.each([
		['an unknown chapter', 'chapter=4242'],
		['a non-numeric chapter', 'chapter=banana'],
		['an empty chapter', 'chapter='],
	])('falls back to every chapter for %s', async (_label, query) => {
		const data = await run(event(ADMIN, query));
		expect(data.chapter).toBeNull();
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: null }),
		);
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
		for (const mock of [mockRows, mockCounts]) {
			expect(mock).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ campaignId: 2 }),
			);
		}
	});

	it('applies the period to the query range', async () => {
		await run(event(ADMIN, 'days=1'));
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				range: { start: '2026-08-23T18:00:00.000Z', end: '2026-08-24T18:00:00.000Z' },
			}),
		);
	});

	it('leaves the range open for all time', async () => {
		await run(event(ADMIN, 'days=all'));
		expect(mockRows).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ range: expect.objectContaining({ start: null }) }),
		);
	});

	it('falls back to the default period for junk', async () => {
		expect((await run(event(ADMIN, 'days=banana'))).period).toBe('7');
	});

	// Both queries must describe the same window, or the summary and the list
	// disagree about a claim that landed between them.
	it('uses one range for both queries', async () => {
		await run(event(ADMIN));
		expect(mockCounts.mock.calls[0]![1].range).toEqual(mockRows.mock.calls[0]![1].range);
	});

	it('sorts the chapter picker by name', async () => {
		const data = await run(event(ADMIN));
		expect(data.chapters.map((c: { name: string }) => c.name)).toEqual([
			'Washtenaw County',
			'Wayne County',
		]);
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

describe('/turfs/activity payload', () => {
	it('expands rows into events with campaign-local labels', async () => {
		const data = await run(event(ADMIN));
		expect(data.events).toHaveLength(1);
		expect(data.events[0]).toMatchObject({
			kind: 'claimed',
			turfName: 'Turf 01',
			slackUserName: 'Dana',
			// 13:10Z is 9:10 AM in Detroit under EDT.
			timeLabel: '9:10 AM',
			dayKey: '2026-08-24',
			// Relative label too, measured against the load's own `now` (18:00Z)
			// rather than a clock read while rendering. The component used to
			// compute this from Date.now(), so SSR and hydration disagreed on
			// every row; asserting the string here is what keeps it server-side.
			agoLabel: '4h ago',
		});
	});

	it('reports one row claimed and completed in range as two events', async () => {
		mockRows.mockResolvedValue([row({ completedAt: '2026-08-24T15:30:00.000Z' })]);
		const data = await run(event(ADMIN));
		expect(data.events.map((e: { kind: string }) => e.kind)).toEqual(['completed', 'claimed']);
	});

	it('supplies a day heading for every day present', async () => {
		mockRows.mockResolvedValue([
			row(),
			row({ checkoutId: 2, claimedAt: '2026-08-22T14:00:00.000Z' }),
		]);
		const data = await run(event(ADMIN));
		for (const e of data.events) expect(data.dayLabels[e.dayKey]).toBeTruthy();
		expect(data.dayLabels['2026-08-22']).toBe('Saturday, Aug 22');
	});

	// The total comes from SQL, not from the capped list, so "showing N of M"
	// stays honest.
	it('reports the counted total alongside what it is showing', async () => {
		mockCounts.mockResolvedValue({ ...emptyCounts(), claimed: 900, completed: 340 });
		const data = await run(event(ADMIN));
		expect(data.total).toBe(1240);
		expect(data.shown).toBe(1);
	});

	it('distinguishes an empty catalog from a quiet period', async () => {
		mockRows.mockResolvedValue([]);
		mockCounts.mockResolvedValue(emptyCounts());

		mockHasAnyTurf.mockResolvedValue(false);
		expect((await run(event(ADMIN))).anyTurf).toBe(false);

		mockHasAnyTurf.mockResolvedValue(true);
		expect((await run(event(ADMIN))).anyTurf).toBe(true);
	});

	// The credential rule and the PII rule, asserted on the payload itself
	// rather than on the template — a redaction that only exists in markup
	// still ships in the SSR payload.
	it('carries no list number and nothing address-like', async () => {
		const data = await run(event(ADMIN));
		// `account` is the holder's own Slack/Google mark, with a Google
		// volunteer's email for organizers by design (spec 013, FR-015). It is
		// left out here so this keeps guarding what it is for: nothing about a
		// voter, and no list number, reaching the payload.
		const serialised = JSON.stringify(data, (key, value) =>
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
		expect((await run(event(ADMIN))).pageTitle).toBe('Turf activity');
	});
});
