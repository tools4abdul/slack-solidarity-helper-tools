import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsSlackAdmin = vi.hoisted(() => vi.fn());
const mockDisplayName = vi.hoisted(() => vi.fn());
const mockBlockedIds = vi.hoisted(() => vi.fn());
const mockSettings = vi.hoisted(() => vi.fn());
const mockLoadChapterTurfs = vi.hoisted(() => vi.fn());
const mockResolveLocation = vi.hoisted(() => vi.fn());
const mockClaimTurf = vi.hoisted(() => vi.fn());
const mockEndClaim = vi.hoisted(() => vi.fn());
const mockLoadHoldingsFor = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/env.js', () => ({
	APP_URL: 'https://app.example.org',
	SLACK_SUPERUSER_ID: 'U_SUPER',
}));
vi.mock('$lib/server/slack-admin.js', () => ({ isSlackAdmin: mockIsSlackAdmin }));
vi.mock('$lib/server/slack-display-name.js', () => ({ displayName: mockDisplayName }));
vi.mock('$lib/server/settings.js', () => ({
	loadVanBlockedIds: mockBlockedIds,
	loadSettings: mockSettings,
}));
vi.mock('$lib/server/van/turf-query.js', () => ({ loadChapterTurfs: mockLoadChapterTurfs }));
// Partial: parseTurfArgument reaches through turf-command to normalizeZip, so
// stubbing the whole module would break argument parsing rather than the
// geocoder it means to stub.
vi.mock('$lib/server/van/zip-centroid.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./zip-centroid.js')>()),
	resolveLocation: mockResolveLocation,
}));
vi.mock('$lib/server/van/checkout-store.js', () => ({
	claimTurf: mockClaimTurf,
	endClaim: mockEndClaim,
}));
vi.mock('$lib/server/van/holdings-store.js', () => ({ loadHoldingsFor: mockLoadHoldingsFor }));

const {
	claimFromSlack,
	completeFromSlack,
	myTurfMessage,
	releaseFromSlack,
	releaseMineFromSlack,
	turfListMessage,
} = await import('./turf-slack.js');
const { chapterVisits, turfRequests } = await import('./rate-limit-store.js');
const { MAX_REQUESTS } = await import('../../van/request-budget.js');
const { MAX_CHAPTER_SWITCHES } = await import('../../van/chapter-rate-limit.js');

const CHANNEL_MAP = [
	{ chapterId: 71, channelId: 'C_WASHTENAW', name: 'Washtenaw County' },
	{ chapterId: 72, channelId: 'C_WAYNE', name: 'Wayne County' },
];

function turfView(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: null,
		routeSize: 400,
		doorsRemaining: 250,
		hull: [],
		centre: { lat: 42.281, lng: -83.741 },
		bounds: null,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 60,
		claimable: true,
		...over,
	};
}

/** Answers the one query turf-slack runs itself: zip -> chapter. */
function makeDb(zipChapterId: number | null = null) {
	return {
		select: () => ({
			from: () => ({
				where: async () => (zipChapterId === null ? [] : [{ chapterId: zipChapterId }]),
			}),
		}),
	} as never;
}

const body = (message: { text: string; blocks?: unknown[] }) =>
	message.text + JSON.stringify(message.blocks ?? []);

let userSeq = 0;
/** A fresh Slack id per test, so the in-memory rate-limit stores — which are
 *  process-wide by design — cannot leak budget between cases. */
const freshUser = () => `U_VOL_${++userSeq}`;

describe('turfListMessage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		chapterVisits.clear();
		turfRequests.clear();
		mockIsSlackAdmin.mockResolvedValue(false);
		mockDisplayName.mockResolvedValue('Dana');
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({ chapterChannelMap: CHANNEL_MAP });
		mockResolveLocation.mockResolvedValue(null);
		mockLoadChapterTurfs.mockResolvedValue({
			turfs: [turfView()],
			total: 1,
			omitted: 0,
			start: 0,
			nextOffset: 1,
			unavailable: 0,
		});
	});

	it('resolves the chapter from the channel it was run in', async () => {
		const msg = await turfListMessage(makeDb(), {
			slackUserId: freshUser(),
			channelId: 'C_WASHTENAW',
		});
		expect(body(msg)).toContain('Washtenaw County');
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71 }),
		);
	});

	it('shows the picker when the channel maps to no chapter', async () => {
		const msg = await turfListMessage(makeDb(), {
			slackUserId: freshUser(),
			channelId: 'C_GENERAL',
		});
		expect(msg.text).toContain('Which county');
		expect(mockLoadChapterTurfs).not.toHaveBeenCalled();
	});

	it('resolves the chapter from a ZIP, overriding the channel', async () => {
		mockResolveLocation.mockResolvedValue({ point: { lat: 42.3, lng: -83.1 }, zip: '48226' });
		await turfListMessage(makeDb(72), {
			slackUserId: freshUser(),
			channelId: 'C_WASHTENAW',
			argument: '48226',
		});
		// What the volunteer typed beats which channel they happen to be reading.
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 72 }),
		);
	});

	it('falls back to the channel when the ZIP maps to no chapter', async () => {
		mockResolveLocation.mockResolvedValue({ point: { lat: 42.3, lng: -83.1 }, zip: '99999' });
		await turfListMessage(makeDb(null), {
			slackUserId: freshUser(),
			channelId: 'C_WASHTENAW',
			argument: '99999',
		});
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71 }),
		);
	});

	it('ignores a zip→chapter mapping that is not a real chapter', async () => {
		mockResolveLocation.mockResolvedValue({ point: { lat: 1, lng: 1 }, zip: '48226' });
		await turfListMessage(makeDb(999), { slackUserId: freshUser(), channelId: 'C_WASHTENAW' });
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chapterId: 71 }),
		);
	});

	it('geocodes a street address and sorts by it', async () => {
		mockResolveLocation.mockResolvedValue({ point: { lat: 42.28, lng: -83.74 }, zip: '48104' });
		await turfListMessage(makeDb(71), {
			slackUserId: freshUser(),
			channelId: 'C_WASHTENAW',
			argument: '100 N Main St, Ann Arbor MI',
		});
		expect(mockResolveLocation).toHaveBeenCalledWith(
			expect.anything(),
			'100 N Main St, Ann Arbor MI',
		);
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ location: { lat: 42.28, lng: -83.74 } }),
		);
	});

	it('says so plainly when a location cannot be found', async () => {
		mockResolveLocation.mockResolvedValue(null);
		const msg = await turfListMessage(makeDb(), {
			slackUserId: freshUser(),
			channelId: 'C_WASHTENAW',
			argument: 'nowhere at all',
		});
		expect(msg.text).toContain("couldn't find that place");
		expect(mockLoadChapterTurfs).not.toHaveBeenCalled();
	});

	// The gate covers reads, not just writes — a blocked user must not see the
	// targeting picture either.
	it('refuses a blocked user before any turf is read', async () => {
		const user = freshUser();
		mockBlockedIds.mockResolvedValue(new Set([user]));
		const msg = await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
		expect(msg.text).toContain("isn't available for your account");
		expect(mockLoadChapterTurfs).not.toHaveBeenCalled();
	});

	it('does not block an admin', async () => {
		const user = freshUser();
		mockIsSlackAdmin.mockResolvedValue(true);
		mockBlockedIds.mockResolvedValue(new Set([user]));
		const msg = await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
		expect(msg.text).not.toContain("isn't available");
	});

	it('does not block the superuser', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_SUPER']));
		const msg = await turfListMessage(makeDb(), {
			slackUserId: 'U_SUPER',
			channelId: 'C_WASHTENAW',
		});
		expect(msg.text).not.toContain("isn't available");
	});

	// isAdmin feeds visibleTurfState through toTurfView, so a wrong answer here
	// ships holder names to volunteers.
	it('passes the re-derived admin flag through to the query', async () => {
		mockIsSlackAdmin.mockResolvedValue(true);
		const user = freshUser();
		await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ viewer: { slackUserId: user, isAdmin: true } }),
		);
	});

	it('keeps turf the volunteer already holds', async () => {
		await turfListMessage(makeDb(), { slackUserId: freshUser(), channelId: 'C_WASHTENAW' });
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ includeHeldByViewer: true }),
		);
	});

	describe('rate limits', () => {
		// Counted against the SAME stores the web page and API spend, so the
		// budget follows the user rather than the surface they came in through.
		it('spends the shared request budget', async () => {
			const user = freshUser();
			await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
			expect(turfRequests.get(user)).toHaveLength(1);
		});

		it('refuses once the request budget is exhausted', async () => {
			const user = freshUser();
			for (let i = 0; i < MAX_REQUESTS; i++) {
				await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
			}
			const msg = await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
			expect(msg.text).toContain('Give it a minute');
		});

		it('spends the shared chapter budget, and paging one chapter is free', async () => {
			const user = freshUser();
			await turfListMessage(makeDb(), { slackUserId: user, channelId: 'C_WASHTENAW' });
			await turfListMessage(makeDb(), { slackUserId: user, chapterId: 71, offset: 5 });
			await turfListMessage(makeDb(), { slackUserId: user, chapterId: 71, offset: 10 });
			expect(chapterVisits.get(user)).toHaveLength(1);
		});

		it('refuses once too many chapters have been opened', async () => {
			const user = freshUser();
			mockSettings.mockResolvedValue({
				chapterChannelMap: Array.from({ length: MAX_CHAPTER_SWITCHES + 2 }, (_, i) => ({
					chapterId: i + 1,
					channelId: `C${i}`,
					name: `County ${i}`,
				})),
			});
			for (let i = 0; i < MAX_CHAPTER_SWITCHES; i++) {
				await turfListMessage(makeDb(), { slackUserId: user, chapterId: i + 1 });
			}
			const msg = await turfListMessage(makeDb(), {
				slackUserId: user,
				chapterId: MAX_CHAPTER_SWITCHES + 1,
			});
			expect(msg.text).toContain('a lot of counties');
		});
	});

	it('ignores a chapter id from a button that is not a real chapter', async () => {
		const msg = await turfListMessage(makeDb(), { slackUserId: freshUser(), chapterId: 4242 });
		expect(msg.text).toContain('Which county');
		expect(mockLoadChapterTurfs).not.toHaveBeenCalled();
	});

	it('pages at the requested offset', async () => {
		mockLoadChapterTurfs.mockResolvedValue({
			turfs: [turfView()],
			total: 30,
			omitted: 24,
			start: 5,
			nextOffset: 6,
			unavailable: 0,
		});
		const msg = await turfListMessage(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			offset: 5,
		});
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ offset: 5, claimableOnly: true }),
		);
		expect(body(msg)).toContain('6–6 of 30');
	});
});

describe('claimFromSlack', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		chapterVisits.clear();
		turfRequests.clear();
		mockIsSlackAdmin.mockResolvedValue(false);
		mockDisplayName.mockResolvedValue('Dana');
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({ chapterChannelMap: CHANNEL_MAP });
		mockResolveLocation.mockResolvedValue(null);
		mockLoadChapterTurfs.mockResolvedValue({
			turfs: [turfView({ status: 'held-by-you', claimable: false })],
			total: 1,
			omitted: 0,
		});
		mockClaimTurf.mockResolvedValue({
			ok: true,
			expiresAt: '2099-01-01T00:00:00.000Z',
			printedListNumber: '35536745-88712',
		});
	});

	it('issues the list number to the claimant', async () => {
		const msg = await claimFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(body(msg)).toContain('35536745-88712');
		expect(body(msg)).toContain('Open MiniVAN');
	});

	it('claims on the terms the admin configured, not the code defaults', async () => {
		// The failure this guards: /settings says 12h and one turf at a time,
		// the web page honours it, and /turfs in Slack quietly hands out 48h and
		// two — the same volunteer getting different rules per surface.
		mockSettings.mockResolvedValue({
			chapterChannelMap: CHANNEL_MAP,
			vanTurfClaimTtlHours: 12,
			vanTurfMaxConcurrentClaims: 1,
		});

		await claimFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
		});

		expect(mockClaimTurf).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				options: { ttlHours: 12, maxConcurrentClaims: 1 },
			}),
		);
		// The list rendered alongside has to agree, or a Claim button offers
		// turf the claim route is about to refuse.
		expect(mockLoadChapterTurfs).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				claimOptions: { ttlHours: 12, maxConcurrentClaims: 1 },
			}),
		);
	});

	it('records the claim under the volunteer’s display name', async () => {
		const user = freshUser();
		await claimFromSlack(makeDb(), { slackUserId: user, chapterId: 71, mapRouteId: 100 });
		expect(mockClaimTurf).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mapRouteId: 100, slackUserId: user, slackUserName: 'Dana' }),
		);
	});

	// A refusal is a normal outcome — someone got there first. Say why, then
	// show the list again so the next turf is one tap away.
	it('explains a refusal and re-renders the list', async () => {
		mockClaimTurf.mockResolvedValue({
			ok: false,
			status: 409,
			message: 'Someone claimed this turf a moment before you did. Try another nearby.',
		});
		const msg = await claimFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(msg.text).toContain('a moment before you did');
		expect(body(msg)).toContain('Turf 01');
	});

	it('refuses a blocked user without writing anything', async () => {
		const user = freshUser();
		mockBlockedIds.mockResolvedValue(new Set([user]));
		const msg = await claimFromSlack(makeDb(), {
			slackUserId: user,
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(msg.text).toContain("isn't available for your account");
		expect(mockClaimTurf).not.toHaveBeenCalled();
	});

	it('refuses a forged chapter id without writing anything', async () => {
		const msg = await claimFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 4242,
			mapRouteId: 100,
		});
		expect(msg.text).toContain('Which county');
		expect(mockClaimTurf).not.toHaveBeenCalled();
	});

	// One button press is one request. Re-running the gates to re-render the list
	// after the claim would silently cost two, halving the budget for the people
	// actually canvassing.
	it('spends exactly one request slot per press', async () => {
		const user = freshUser();
		await claimFromSlack(makeDb(), { slackUserId: user, chapterId: 71, mapRouteId: 100 });
		expect(turfRequests.get(user)).toHaveLength(1);
	});

	it('spends one request slot even when the claim is refused', async () => {
		const user = freshUser();
		mockClaimTurf.mockResolvedValue({ ok: false, status: 409, message: 'Already taken.' });
		await claimFromSlack(makeDb(), { slackUserId: user, chapterId: 71, mapRouteId: 100 });
		expect(turfRequests.get(user)).toHaveLength(1);
	});

	// Without the mapRouteIds filter this reads back whichever turf sorts first
	// in the chapter, so the confirmation names a turf the volunteer did not
	// claim — with the right list number beside the wrong name.
	it('reads the claimed turf back by id, not by sort order', async () => {
		await claimFromSlack(makeDb(), { slackUserId: freshUser(), chapterId: 71, mapRouteId: 100 });
		const readback = mockLoadChapterTurfs.mock.calls.at(-1)![1];
		expect(readback).toMatchObject({ mapRouteIds: [100] });
	});

	it('names the turf that was actually claimed', async () => {
		mockLoadChapterTurfs.mockResolvedValue({
			turfs: [turfView({ mapRouteId: 100, name: 'Turf 07', doorsRemaining: 130 })],
			total: 1,
			omitted: 0,
		});
		const msg = await claimFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(body(msg)).toContain('Turf 07');
		expect(body(msg)).toContain('130 doors');
	});
});

describe('releaseFromSlack', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		chapterVisits.clear();
		turfRequests.clear();
		mockIsSlackAdmin.mockResolvedValue(false);
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({ chapterChannelMap: CHANNEL_MAP });
		mockResolveLocation.mockResolvedValue(null);
		mockLoadChapterTurfs.mockResolvedValue({
			turfs: [turfView()],
			total: 1,
			omitted: 0,
			start: 0,
			nextOffset: 1,
			unavailable: 0,
		});
		mockEndClaim.mockResolvedValue({ ok: true });
	});

	it('gives the turf back and shows the list again', async () => {
		const user = freshUser();
		const msg = await releaseFromSlack(makeDb(), {
			slackUserId: user,
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(mockEndClaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mapRouteId: 100, slackUserId: user, kind: 'release' }),
		);
		expect(msg.text).toContain('Given back');
		expect(body(msg)).toContain('Turf 01');
	});

	it('reports a release of turf you do not hold', async () => {
		mockEndClaim.mockResolvedValue({
			ok: false,
			status: 409,
			message: "You don't currently hold that turf.",
		});
		const msg = await releaseFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
		});
		expect(msg.text).toContain("don't currently hold");
	});

	it('refuses a blocked user without writing anything', async () => {
		const user = freshUser();
		mockBlockedIds.mockResolvedValue(new Set([user]));
		await releaseFromSlack(makeDb(), { slackUserId: user, chapterId: 71, mapRouteId: 100 });
		expect(mockEndClaim).not.toHaveBeenCalled();
	});

	it('spends exactly one request slot per press', async () => {
		const user = freshUser();
		await releaseFromSlack(makeDb(), { slackUserId: user, chapterId: 71, mapRouteId: 100 });
		expect(turfRequests.get(user)).toHaveLength(1);
	});

	// A geocode per button press would be a network round trip for nothing —
	// the location already came back in the button value.
	it('does not re-geocode when re-rendering the list', async () => {
		await releaseFromSlack(makeDb(), {
			slackUserId: freshUser(),
			chapterId: 71,
			mapRouteId: 100,
			location: { lat: 42.28, lng: -83.74 },
		});
		expect(mockResolveLocation).not.toHaveBeenCalled();
	});
});

describe('/turfs-mine actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		turfRequests.clear();
		mockIsSlackAdmin.mockResolvedValue(false);
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockLoadHoldingsFor.mockResolvedValue([]);
		mockEndClaim.mockResolvedValue({ ok: true });
	});

	// The gate runs before the write, not after it: a blocked volunteer used to
	// be able to mark turf walked and only then be told they were blocked.
	it.each([
		[
			'give it back',
			(user: string) => releaseMineFromSlack(makeDb(), { slackUserId: user, mapRouteId: 100 }),
		],
		[
			'mark it done',
			(user: string) =>
				completeFromSlack(makeDb(), { slackUserId: user, mapRouteId: 100, percent: 100 }),
		],
	])('refuses a blocked user before %s writes anything', async (_label, act) => {
		const user = freshUser();
		mockBlockedIds.mockResolvedValue(new Set([user]));
		const msg = await act(user);
		expect(mockEndClaim).not.toHaveBeenCalled();
		expect(msg.text).toContain("isn't available for your account");
	});

	it('refuses once the request budget is spent, without writing', async () => {
		const user = freshUser();
		for (let i = 0; i < MAX_REQUESTS; i++) await myTurfMessage(makeDb(), { slackUserId: user });
		const msg = await completeFromSlack(makeDb(), {
			slackUserId: user,
			mapRouteId: 100,
			percent: 100,
		});
		expect(mockEndClaim).not.toHaveBeenCalled();
		expect(msg.text).toContain('a lot of requests');
	});

	it('spends exactly one request slot per press, redraw included', async () => {
		const user = freshUser();
		await releaseMineFromSlack(makeDb(), { slackUserId: user, mapRouteId: 100 });
		expect(mockEndClaim).toHaveBeenCalledOnce();
		expect(turfRequests.get(user)).toHaveLength(1);
	});
});
