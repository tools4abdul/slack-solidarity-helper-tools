import { describe, it, expect, vi, beforeEach } from 'vitest';
import { actions, load } from './+page.server.js';
import { PUBLIC_LOOKUPS_PER_MINUTE } from '$lib/van/request-budget.js';
import { TURFS_PER_PAYLOAD } from '$lib/van/turf-paging.js';

const mockBlockedIds = vi.hoisted(() => vi.fn());
const mockSettings = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockZipLookup = vi.hoisted(() => vi.fn());
const mockResolveLocation = vi.hoisted(() => vi.fn());
const mockNearby = vi.hoisted(() => vi.fn());
const mockTurfCentre = vi.hoisted(() => vi.fn());
const mockLoadNotices = vi.hoisted(() => vi.fn());
const mockDismissNotice = vi.hoisted(() => vi.fn());
const mockSetNameOnce = vi.hoisted(() => vi.fn());
const mockUpdateSession = vi.hoisted(() => vi.fn());

// Both have their own tests (outside-volunteers.test.ts on real SQLite).
vi.mock('$lib/server/outside-volunteers.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/outside-volunteers.js')>()),
	setDisplayNameOnce: mockSetNameOnce,
}));
vi.mock('$lib/server/session.js', () => ({ updateSession: mockUpdateSession }));

// Has its own tests on real SQLite (holder-notices.test.ts).
vi.mock('$lib/server/van/holder-notices.js', () => ({
	loadHolderNotices: mockLoadNotices,
	dismissHolderNotice: mockDismissNotice,
}));

// Walk reports have their own tests on real SQLite (checkout-store.test.ts);
// the stubbed db here answers only the chains this module's tests script.
vi.mock('$lib/server/van/checkout-store.js', () => ({ latestWalkReports: async () => new Map() }));
vi.mock('$lib/server/db.js', () => ({ db: { select: () => mockSelect() } }));
vi.mock('$lib/server/env.js', () => ({
	SLACK_SUPERUSER_ID: 'U_SUPER',
	MAP_TILE_URL_TEMPLATE: '',
	MAP_TILE_ATTRIBUTION: '',
	MAP_TILE_API_KEY: '',
	FLY_APP_NAME: '',
	APP_URL: 'https://app.example',
}));
vi.mock('$lib/server/van/zip-centroid.js', async (importOriginal) => ({
	normalizeZip: (await importOriginal<typeof import('$lib/server/van/zip-centroid.js')>())
		.normalizeZip,
	lookupZipCentroid: mockZipLookup,
	resolveLocation: mockResolveLocation,
}));
// The query has its own tests on real SQLite (nearby-summary.test.ts).
vi.mock('$lib/server/van/nearby-summary.js', () => ({
	loadNearbySummary: mockNearby,
	loadTurfCentre: mockTurfCentre,
}));
// Partial: the turf query still needs the real visibleToChapter. The folder
// lookup is stubbed so it does not take a turn in stubQueries' ordered script;
// a folder per chapter keeps every new chapter charged, as before.
vi.mock('$lib/server/van/chapter-visibility.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/van/chapter-visibility.js')>()),
	foldersForChapter: async (_db: unknown, chapterId: number) => [1000 + chapterId],
}));
vi.mock('$lib/server/settings.js', () => ({
	loadVanBlockedIds: mockBlockedIds,
	loadSettings: mockSettings,
}));

const CHAPTERS = [
	{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
	{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
];

function turfRow(over: Record<string, unknown> = {}) {
	return {
		turfId: 100,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		printedListNumber: '35536745-88712',
		routeSize: 400,
		doorCount: 250,
		centroidLat: null,
		centroidLng: null,
		hullJson: null,
		vanDistributedTo: null,
		retiredAt: null,
		lastRefreshedAt: '2026-08-22T06:00:00.000Z',
		folderId: 2731,
		campaignId: 1,
		savedListId: 585052,
		...over,
	};
}

/** Stubs the `db.select().from().where()` chains the loader runs, in order:
 *  the viewer's own live claims (which widen the turf query so retired turf
 *  they still hold is included), then turf rows, then the claims on those
 *  rows. The viewer's claims and the row claims are the same set in these
 *  tests, which is the realistic case. */
function stubQueries(turfRows: unknown[], claimRows: unknown[] = []) {
	const results = [claimRows, turfRows, claimRows];
	let call = 0;
	mockSelect.mockImplementation(() => ({
		// Awaited without `.where()` — every campaign's contact-pull marks — it
		// reads as empty and does not use up one of the scripted results.
		from: () => Object.assign(Promise.resolve([]), { where: async () => results[call++] ?? [] }),
	}));
}

const event = (session: unknown, query?: string) =>
	({
		locals: { session },
		url: new URL(`https://app.example/turfs${query ? `?${query}` : ''}`),
	}) as never;

const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Dana', isAdmin: false };

/** `load` returns either the member page or the signed-out teaser. Every
 *  caller below expects the member page, so narrow once here rather than at
 *  each use. */
async function run(ev: never) {
	const result = await load(ev);
	if (!result || result.mode !== 'member') throw new Error('expected the member page');
	return result;
}

async function runPublic(ev: never) {
	const result = await load(ev);
	if (!result || result.mode !== 'public') throw new Error('expected the signed-out teaser');
	return result;
}

describe('/turfs load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockBlockedIds.mockResolvedValue(new Set<string>());
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});
		mockZipLookup.mockResolvedValue(null);
		stubQueries([turfRow()]);
	});

	// chapter_channel_map is keyed by CHANNEL, so a chapter with two Slack
	// channels has two rows. Observed live: 64 rows, 32 chapters, and the picker
	// rendered every one of them twice.
	it('lists a chapter once even when it has several Slack channels', async () => {
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: [
				{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' },
				{ chapterId: 71, channelId: 'C1b', name: 'Washtenaw County' },
				{ chapterId: 72, channelId: 'C2', name: 'Wayne County' },
				{ chapterId: 72, channelId: 'C2b', name: 'Wayne County' },
			],
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});

		const data = await run(event({ slackUserId: 'U1', isAdmin: false }) as never);
		expect(data.chapters).toEqual([
			{ chapterId: 71, name: 'Washtenaw County' },
			{ chapterId: 72, name: 'Wayne County' },
		]);
	});

	// Turf-only chapters an admin named in settings sit in the same picker,
	// sorted in, and open by their negative id like any other chapter.
	it('lists and opens a turf-only chapter', async () => {
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: CHAPTERS,
			turfCustomChapters: [{ chapterId: -1, name: 'Ann Arbor outreach' }],
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});

		const data = await run(event({ slackUserId: 'U1', isAdmin: false }, 'chapter=-1') as never);
		expect(data.chapters[0]).toEqual({ chapterId: -1, name: 'Ann Arbor outreach' });
		expect(data.chapter).toEqual({ chapterId: -1, name: 'Ann Arbor outreach' });
	});

	describe('signed out', () => {
		beforeEach(() => {
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: CHAPTERS,
				publicJoinUrl: 'https://join.example/slack',
			});
			mockTurfCentre.mockResolvedValue({ lat: 42.3, lng: -83.7 });
		});

		it('serves the teaser instead of redirecting', async () => {
			const data = await runPublic(event(null));
			expect(data.joinUrl).toBe('https://join.example/slack');
			expect(data.turfCentre).toEqual({ lat: 42.3, lng: -83.7 });
		});

		it('centres the teaser on turf a chapter /turfs offers can see', async () => {
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set([72]),
				chapterChannelMap: CHAPTERS,
				publicJoinUrl: '',
			});
			await runPublic(event(null));
			expect(mockTurfCentre).toHaveBeenCalledWith(expect.anything(), [71]);
		});

		it('sends sign-in back to /turfs', async () => {
			const data = await runPublic(event(null));
			expect(data.signInHref).toBe('/signin?redirectTo=%2Fturfs');
		});

		it('hides the join button when no link is configured', async () => {
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: CHAPTERS,
				publicJoinUrl: '',
			});
			const data = await runPublic(event(null));
			expect(data.joinUrl).toBeNull();
		});

		// The member gates never run for a visitor, and nothing from them ships.
		it('reads no turf, claims, blocklist or chapter list', async () => {
			const data = await runPublic(event(null, 'chapter=71'));
			expect(mockSelect).not.toHaveBeenCalled();
			expect(mockBlockedIds).not.toHaveBeenCalled();
			expect(Object.keys(data).sort()).toEqual(
				['joinUrl', 'mode', 'pageTitle', 'signInHref', 'tiles', 'turfCentre'].sort(),
			);
		});

		// R13 (specs/012-multi-van-campaigns): which campaigns cut turf here is
		// for signed-in volunteers only — no badge, id or name in the teaser.
		it('names no campaign', async () => {
			const data = await runPublic(event(null, 'chapter=71'));
			expect(JSON.stringify(data)).not.toMatch(/campaign/i);
		});
	});

	it('returns no turf data before a chapter is picked', async () => {
		const result = await run(event(VOLUNTEER));
		expect(result.turfs).toEqual([]);
		expect(result.chapter).toBeNull();
		expect(result.chapters).toHaveLength(2);
	});

	it('serves the picked chapter’s turf', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.chapter?.chapterId).toBe(71);
		expect(result.turfs).toHaveLength(1);
		expect(result.turfs[0]!.name).toBe('Turf 01');
	});

	// A chapter an admin hid from /turfs keeps its Slack channels, but is neither
	// offered nor reachable here — a link to it opens the picker.
	it('leaves a hidden chapter out of the picker, and treats a link to it as unknown', async () => {
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set([72]),
			chapterChannelMap: CHAPTERS,
		});
		const listed = await run(event(VOLUNTEER));
		expect(listed.chapters.map((c: { chapterId: number }) => c.chapterId)).toEqual([71]);
		const linked = await run(event(VOLUNTEER, 'chapter=72'));
		expect(linked.chapter).toBeNull();
		expect(linked.turfs).toEqual([]);
	});

	it('ignores a chapter id that is not a real chapter', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=999'));
		expect(result.chapter).toBeNull();
		expect(result.turfs).toEqual([]);
	});

	// The plan calls a leaking load function the most likely way this design
	// fails its own promise, so the filter is asserted at the query level.
	it('filters by chapter on the SERVER, not in the browser', async () => {
		const where = vi.fn(async () => [turfRow()]);
		mockSelect.mockImplementation(() => ({
			from: () => Object.assign(Promise.resolve([]), { where }),
		}));
		await run(event(VOLUNTEER, 'chapter=71'));
		// A load that returned every chapter and let the client filter would
		// never call .where() on the turf query.
		expect(where).toHaveBeenCalled();
	});

	// What the turf sweeps would have DMed a Google holder (User Story 5).
	describe('holder notices', () => {
		const GOOGLE = {
			slackUserId: 'google:1093',
			slackUserName: 'Ana',
			isAdmin: false,
			authProvider: 'google' as const,
		};
		const NOTICE = {
			id: 5,
			kind: 'expiry',
			text: ':hourglass: *Your turf expires soon.*\n<https://app.example/turfs?chapter=71|Open turf checkout>',
			createdAt: '2026-10-04T10:00:00Z',
		};

		beforeEach(() => {
			mockLoadNotices.mockResolvedValue([NOTICE]);
			mockDismissNotice.mockResolvedValue(undefined);
		});

		it('ships a Google holder their notices, rendered, on the picker and a chapter', async () => {
			const expected = [
				{
					id: 5,
					lines: [
						[{ text: 'Your turf expires soon.', bold: true }],
						[{ text: 'Open turf checkout', href: '/turfs?chapter=71' }],
					],
				},
			];
			expect((await run(event(GOOGLE))).notices).toEqual(expected);
			expect((await run(event(GOOGLE, 'chapter=71'))).notices).toEqual(expected);
			expect(mockLoadNotices).toHaveBeenCalledWith(expect.anything(), 'google:1093');
		});

		it('reads nothing for a Slack session, whose notices went as DMs', async () => {
			expect((await run(event(VOLUNTEER))).notices).toEqual([]);
			expect(mockLoadNotices).not.toHaveBeenCalled();
		});

		it('shows a blocked holder none of them', async () => {
			mockBlockedIds.mockResolvedValue(new Set(['google:1093']));
			expect((await run(event(GOOGLE))).notices).toEqual([]);
		});

		it('still serves the map when the notices cannot be read', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			mockLoadNotices.mockRejectedValue(new Error('db down'));
			const result = await run(event(GOOGLE, 'chapter=71'));
			expect(result.notices).toEqual([]);
			expect(result.chapter).not.toBeNull();
		});

		const dismiss = (session: unknown, id: string) =>
			({
				locals: { session },
				request: { formData: async () => new Map([['id', id]]) },
			}) as never;

		it('dismisses a notice, scoped to the holder', async () => {
			expect(await actions.dismissNotice(dismiss(GOOGLE, '5'))).toEqual({ dismissed: 5 });
			expect(mockDismissNotice).toHaveBeenCalledWith(expect.anything(), 'google:1093', 5);
		});

		it('refuses a dismiss without a session or a numeric id', async () => {
			// `dismissError`, so the page can show it without the teaser's
			// `error` (from the nearby action) picking it up.
			expect(await actions.dismissNotice(dismiss(null, '5'))).toMatchObject({
				status: 401,
				data: { dismissError: expect.any(String) },
			});
			expect(await actions.dismissNotice(dismiss(GOOGLE, 'abc'))).toMatchObject({ status: 400 });
			expect(mockDismissNotice).not.toHaveBeenCalled();
		});

		it('reports a failed dismiss so the page can say so', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			mockDismissNotice.mockRejectedValue(new Error('db down'));
			expect(await actions.dismissNotice(dismiss(GOOGLE, '5'))).toMatchObject({
				status: 500,
				data: { dismissError: expect.stringContaining('Could not dismiss') },
			});
		});

		it('does nothing for a Slack session, which has no notices here', async () => {
			expect(await actions.dismissNotice(dismiss(VOLUNTEER, '5'))).toEqual({ dismissed: 5 });
			expect(mockDismissNotice).not.toHaveBeenCalled();
		});
	});

	// A Google or Apple sign-in turned away from a Slack-only page lands here
	// with ?needsSlack=<where it was going> (server/turf-only-access.ts).
	describe('the needs-Slack notice', () => {
		const GOOGLE = {
			slackUserId: 'google:1093',
			slackUserName: 'Ana',
			isAdmin: false,
			authProvider: 'google' as const,
		};

		it('offers a Google session Slack sign-in back to the page it wanted', async () => {
			const result = await run(event(GOOGLE, 'needsSlack=%2Fmembers%3Fuser%3DU1'));
			expect(result.needsSlackHref).toBe('/auth/slack?redirectTo=%2Fmembers%3Fuser%3DU1');
		});

		it('still shows on a chapter page, and on the blocked page', async () => {
			const chapter = await run(event(GOOGLE, 'chapter=71&needsSlack=%2Fsettings'));
			expect(chapter.needsSlackHref).toBe('/auth/slack?redirectTo=%2Fsettings');

			mockBlockedIds.mockResolvedValue(new Set(['google:1093']));
			const blocked = await run(event(GOOGLE, 'needsSlack=%2Fsettings'));
			expect(blocked.blocked).toBeTruthy();
			expect(blocked.needsSlackHref).toBe('/auth/slack?redirectTo=%2Fsettings');
		});

		it('drops an unsafe destination but keeps the offer', async () => {
			const result = await run(event(GOOGLE, 'needsSlack=1'));
			expect(result.needsSlackHref).toBe('/auth/slack');
			const offsite = await run(event(GOOGLE, 'needsSlack=https%3A%2F%2Fevil.example'));
			expect(offsite.needsSlackHref).toBe('/auth/slack');
		});

		it('is offered to an Apple session too', async () => {
			const apple = { ...GOOGLE, slackUserId: 'apple:001.abc', authProvider: 'apple' as const };
			const result = await run(event(apple, 'needsSlack=%2Fsettings'));
			expect(result.needsSlackHref).toBe('/auth/slack?redirectTo=%2Fsettings');
		});

		it('is absent without the parameter, and never shown to a Slack session', async () => {
			expect((await run(event(GOOGLE))).needsSlackHref).toBeNull();
			expect((await run(event(VOLUNTEER, 'needsSlack=%2Fsettings'))).needsSlackHref).toBeNull();
		});
	});

	// specs/014-apple-sso-login FR-011: an outside volunteer with no name.
	describe('the name prompt', () => {
		const UNNAMED = {
			slackUserId: 'apple:001.abc',
			slackUserName: '',
			isAdmin: false,
			authProvider: 'apple' as const,
			needsName: true as const,
		};

		beforeEach(() => {
			mockSetNameOnce.mockResolvedValue({ status: 'saved' });
			mockUpdateSession.mockResolvedValue(true);
			vi.spyOn(console, 'log').mockImplementation(() => {});
		});

		it('asks on the picker and on a chapter — but serves the map', async () => {
			expect((await run(event(UNNAMED))).needsName).toBe(true);
			const chapter = await run(event(UNNAMED, 'chapter=71'));
			expect(chapter.needsName).toBe(true);
			expect(chapter.chapter).not.toBeNull();
		});

		// setName would refuse them anyway, after they had typed and confirmed.
		it('does not ask a blocked volunteer', async () => {
			mockBlockedIds.mockResolvedValue(new Set(['apple:001.abc']));
			const blocked = await run(event(UNNAMED));
			expect(blocked.blocked).toBeTruthy();
			expect(blocked.needsName).toBe(false);
		});

		it('does not ask anyone who has a name', async () => {
			expect((await run(event(VOLUNTEER))).needsName).toBe(false);
			expect(
				(await run(event({ ...UNNAMED, needsName: undefined, slackUserName: 'Bo' }))).needsName,
			).toBe(false);
		});

		const post = (session: unknown, fields: Record<string, string>) =>
			({
				locals: { session },
				cookies: {},
				request: { formData: async () => new Map(Object.entries(fields)) },
			}) as never;

		it('shows a tidied name back first, saving nothing', async () => {
			expect(await actions.setName(post(UNNAMED, { name: '  *Bo*  Lee ' }))).toEqual({
				confirmName: 'Bo Lee',
			});
			expect(mockSetNameOnce).not.toHaveBeenCalled();
			expect(mockUpdateSession).not.toHaveBeenCalled();
		});

		it('saves it once confirmed, and names the session with it', async () => {
			const confirmed = post(UNNAMED, { name: 'Bo Lee', confirm: '1' });
			expect(await actions.setName(confirmed)).toEqual({ nameSaved: 'Bo Lee' });
			// The no-JS reload's load runs on these locals: it must not ask again.
			const locals = (confirmed as unknown as { locals: App.Locals }).locals;
			expect(locals.session).toMatchObject({ slackUserName: 'Bo Lee' });
			expect(locals.session?.needsName).toBeUndefined();
			expect(mockSetNameOnce).toHaveBeenCalledWith(expect.anything(), 'apple:001.abc', 'Bo Lee');
			expect(mockUpdateSession).toHaveBeenCalledWith(expect.anything(), {
				slackUserId: 'apple:001.abc',
				slackUserName: 'Bo Lee',
				isAdmin: false,
				authProvider: 'apple',
			});
		});

		it('keeps the first name when one was already set, and catches the session up', async () => {
			mockSetNameOnce.mockResolvedValue({ status: 'taken', displayName: 'Bo' });
			expect(await actions.setName(post(UNNAMED, { name: 'Robert', confirm: '1' }))).toEqual({
				nameTaken: 'Bo',
			});
			// Named as typed first, then caught up to the name that stands.
			expect(mockUpdateSession.mock.calls.at(-1)?.[1].slackUserName).toBe('Bo');
		});

		it('names the session even when there is no record to save it on', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			mockSetNameOnce.mockResolvedValue({ status: 'no-record' });
			expect(await actions.setName(post(UNNAMED, { name: 'Bo', confirm: '1' }))).toEqual({
				nameSaved: 'Bo',
			});
			expect(mockUpdateSession).toHaveBeenCalled();
		});

		it('refuses a name that tidies down to nothing', async () => {
			expect(await actions.setName(post(UNNAMED, { name: ' ** ', confirm: '1' }))).toMatchObject({
				status: 400,
				data: { nameError: expect.any(String) },
			});
			expect(mockSetNameOnce).not.toHaveBeenCalled();
		});

		it('changes nothing for someone who already has a name', async () => {
			const named = { ...UNNAMED, needsName: undefined, slackUserName: 'Bo' };
			expect(await actions.setName(post(named, { name: 'Robert', confirm: '1' }))).toEqual({
				nameSaved: 'Bo',
			});
			expect(await actions.setName(post(VOLUNTEER, { name: 'X', confirm: '1' }))).toEqual({
				nameSaved: 'Dana',
			});
			expect(mockSetNameOnce).not.toHaveBeenCalled();
		});

		it('refuses without a session, and when the session has run out', async () => {
			expect(await actions.setName(post(null, { name: 'Bo' }))).toMatchObject({ status: 401 });
			mockUpdateSession.mockResolvedValue(false);
			expect(await actions.setName(post(UNNAMED, { name: 'Bo', confirm: '1' }))).toMatchObject({
				status: 401,
			});
			// Ended by a sign-out or a block: nothing is stored for it.
			expect(mockSetNameOnce).not.toHaveBeenCalled();
		});

		it('refuses a blocked volunteer, storing nothing', async () => {
			mockBlockedIds.mockResolvedValue(new Set(['apple:001.abc']));
			expect(await actions.setName(post(UNNAMED, { name: 'Bo', confirm: '1' }))).toMatchObject({
				status: 403,
				data: { nameError: expect.any(String) },
			});
			expect(mockSetNameOnce).not.toHaveBeenCalled();
			expect(mockUpdateSession).not.toHaveBeenCalled();
		});

		it('says so when the save fails', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			mockSetNameOnce.mockRejectedValue(new Error('db down'));
			expect(await actions.setName(post(UNNAMED, { name: 'Bo', confirm: '1' }))).toMatchObject({
				status: 500,
			});
			// Back to asking, rather than a session named by an unsaved name.
			expect(mockUpdateSession.mock.calls.at(-1)?.[1]).toEqual(UNNAMED);
		});
	});

	it('shows a blocked user a plain message and no turf', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_VOL']));
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.blocked).toMatch(/isn't available for your account/i);
		expect(result.turfs).toEqual([]);
		// Not even the chapter list, which would confirm the feature exists and
		// name every county the campaign organises in.
		expect(result.chapters).toEqual([]);
	});

	it('does not block an admin', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_ADMIN']));
		const result = await run(
			event({ ...VOLUNTEER, slackUserId: 'U_ADMIN', isAdmin: true }, 'chapter=71'),
		);
		expect(result.blocked).toBeNull();
		expect(result.turfs).toHaveLength(1);
	});

	it('does not block the superuser', async () => {
		mockBlockedIds.mockResolvedValue(new Set(['U_SUPER']));
		const result = await run(event({ ...VOLUNTEER, slackUserId: 'U_SUPER' }, 'chapter=71'));
		expect(result.blocked).toBeNull();
	});

	it('withholds the list number on turf the viewer does not hold', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.turfs[0]!.status).toBe('available');
		expect(result.turfs[0]!.printedListNumber).toBeNull();
	});

	it('issues the list number on turf the viewer holds', async () => {
		stubQueries(
			[turfRow()],
			[
				{
					turfId: 100,
					slackUserId: 'U_VOL',
					slackUserName: 'Dana',
					claimedAt: '2026-08-22T09:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z',
					releasedAt: null,
					completedAt: null,
				},
			],
		);
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.turfs[0]!.status).toBe('held-by-you');
		expect(result.turfs[0]!.printedListNumber).toBe('35536745-88712');
	});

	it('lists every chapter, not only those with turf', async () => {
		// Listing only chapters that have turf would be a cross-chapter
		// aggregate: one request revealing where the field operation runs.
		const result = await run(event(VOLUNTEER));
		expect(result.chapters.map((c: { chapterId: number }) => c.chapterId)).toEqual([71, 72]);
	});

	it('does not ship the Slack channel id with the chapter list', async () => {
		const result = await run(event(VOLUNTEER));
		expect(Object.keys(result.chapters[0]!).sort()).toEqual(['chapterId', 'name']);
	});

	describe('payload budget', () => {
		it('caps the payload and reports the chapter total', async () => {
			// Sized off the constant, so raising the budget does not turn this
			// into a test of a number nobody chose.
			const total = TURFS_PER_PAYLOAD + 50;
			stubQueries(
				Array.from({ length: total }, (_, i) =>
					turfRow({ turfId: i, name: `Turf ${String(i).padStart(4, '0')}` }),
				),
			);
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.turfs).toHaveLength(TURFS_PER_PAYLOAD);
			expect(result.total).toBe(total);
		});

		// The bug this closes: a volunteer claims turf, the page reloads, and the
		// turf they are holding sorts past the cut — so the card carrying their
		// MiniVAN list number is simply absent, and stays absent until they pan
		// the map back over it.
		it('keeps the viewer’s own turf in the payload however far down it sorts', async () => {
			const mine = 99_999;
			const rows = [
				...Array.from({ length: TURFS_PER_PAYLOAD + 50 }, (_, i) =>
					turfRow({ turfId: i, name: `Turf ${String(i).padStart(4, '0')}` }),
				),
				// Last by name, so the cap would drop it.
				turfRow({ turfId: mine, name: 'Zzz far-away turf' }),
			];
			stubQueries(rows, [
				{
					turfId: mine,
					slackUserId: 'U_VOL',
					slackUserName: 'Dana',
					claimedAt: '2026-08-22T09:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z',
					releasedAt: null,
					completedAt: null,
				},
			]);

			const result = await run(event(VOLUNTEER, 'chapter=71'));
			const held = result.turfs.find((t: { turfId: number; status: string }) => t.turfId === mine);
			expect(held?.status).toBe('held-by-you');
			// It is pinned to the front, and the payload still respects the cap.
			expect(result.turfs[0]!.turfId).toBe(mine);
			expect(result.turfs).toHaveLength(TURFS_PER_PAYLOAD);
		});

		// A total, not a remainder: "showing N of T" cannot drift as the
		// volunteer pans, whereas "M more" describes whichever viewport
		// answered last.
		it('reports a total equal to what it served when the chapter fits', async () => {
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.total).toBe(result.turfs.length);
		});
	});

	describe('ZIP fallback', () => {
		it('sorts from a resolved ZIP and echoes it back', async () => {
			mockZipLookup.mockResolvedValue({ lat: 42.28, lng: -83.74 });
			const result = await run(event(VOLUNTEER, 'chapter=71&zip=48104'));
			expect(result.location).toEqual({ lat: 42.28, lng: -83.74 });
			expect(result.zip).toBe('48104');
		});

		// Never-throw: losing distance sorting must not cost the turf list.
		it('serves the list anyway when the ZIP cannot be resolved', async () => {
			mockZipLookup.mockResolvedValue(null);
			const result = await run(event(VOLUNTEER, 'chapter=71&zip=00000'));
			expect(result.location).toBeNull();
			expect(result.zip).toBeNull();
			expect(result.turfs).toHaveLength(1);
		});

		it('does not call the geocoder when no ZIP was given', async () => {
			await run(event(VOLUNTEER, 'chapter=71'));
			expect(mockZipLookup).not.toHaveBeenCalled();
		});
	});

	describe('turf request budget', () => {
		it('throttles repeated loads of ONE chapter, which the chapter limiter lets through', async () => {
			// Re-opening a chapter already seen is free by design, so the chapter
			// limiter never fires here. Without the request budget on this load,
			// `?chapter=N&zip=XXXXX` in a loop walks a whole chapter a payload at
			// a time for nothing — the API route has always charged for it.
			const { MAX_REQUESTS } = await import('$lib/van/request-budget.js');
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: CHAPTERS,
			});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const scraper = { ...VOLUNTEER, slackUserId: 'U_BUDGET' };

			const results = [];
			for (let i = 0; i < MAX_REQUESTS + 2; i++) {
				stubQueries([turfRow({ chapterId: 71 })]);
				results.push(await run(event(scraper, 'chapter=71')));
			}

			const stopped = results.find((r) => r.rateLimited > 0);
			expect(stopped).toBeDefined();
			expect(stopped!.turfs).toEqual([]);
			// Told apart from the chapter limit, whose message promises that
			// chapters already seen still open — which is not true here.
			expect(stopped!.rateLimitReason).toBe('requests');
			// A wait, not a block — the chapter list still renders.
			expect(stopped!.blocked).toBeNull();
			expect(stopped!.chapters.length).toBeGreaterThan(0);
		});

		it('never charges an admin for it', async () => {
			const { MAX_REQUESTS } = await import('$lib/van/request-budget.js');
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: CHAPTERS,
			});
			const organizer = { slackUserId: 'U_BUDGET_ADMIN', isAdmin: true };

			for (let i = 0; i < MAX_REQUESTS + 2; i++) {
				stubQueries([turfRow({ chapterId: 71 })]);
				const result = await run(event(organizer, 'chapter=71'));
				expect(result.rateLimited).toBe(0);
			}
		});
	});

	describe('chapter-switch rate limit', () => {
		it('refuses turf after too many distinct chapters, without blocking the user', async () => {
			// The limiter is module state, so this test uses its own user and its
			// own chapter ids and does not disturb the others.
			const many = Array.from({ length: 20 }, (_, i) => ({
				chapterId: 500 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: many,
			});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const scraper = { ...VOLUNTEER, slackUserId: 'U_SCRAPER' };

			const results = [];
			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				results.push(await run(event(scraper, `chapter=${chapter.chapterId}`)));
			}

			expect(results.filter((r) => r.rateLimited > 0).length).toBeGreaterThan(0);
			const stopped = results.find((r) => r.rateLimited > 0)!;
			expect(stopped.turfs).toEqual([]);
			expect(stopped.rateLimitReason).toBe('chapters');
			// Not a block: the chapter list is still there and the message is a
			// wait, not a refusal.
			expect(stopped.blocked).toBeNull();
			expect(stopped.chapters.length).toBeGreaterThan(0);
		});

		// An organizer checking turf across a state on launch night does exactly
		// what this limiter is shaped to catch, and already sees every chapter at
		// once on /turfs/organizer — so the cap protected nothing and broke real
		// work.
		it('never rate-limits an admin, however many chapters they open', async () => {
			const many = Array.from({ length: 20 }, (_, i) => ({
				chapterId: 700 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: many,
			});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const organizer = { slackUserId: 'U_ORGANIZER', isAdmin: true };

			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				const result = await run(event(organizer, `chapter=${chapter.chapterId}`));
				expect(result.rateLimited).toBe(0);
				expect(result.turfs.length).toBeGreaterThan(0);
			}
		});

		it('never rate-limits re-opening the same chapter', async () => {
			const loyal = { ...VOLUNTEER, slackUserId: 'U_LOYAL' };
			for (let i = 0; i < 40; i++) {
				const result = await run(event(loyal, 'chapter=71'));
				expect(result.rateLimited).toBe(0);
			}
		});
	});

	it('passes a basemap source the component can use', async () => {
		const result = await run(event(VOLUNTEER, 'chapter=71'));
		expect(result.tiles.urlTemplate).toContain('{z}');
		expect(result.tiles.attribution).toBeTruthy();
	});

	describe('retired turf', () => {
		const RETIRED = turfRow({
			turfId: 200,
			name: 'Retired 01',
			retiredAt: '2026-08-01T00:00:00.000Z',
		});
		const MY_CLAIM = {
			turfId: 200,
			slackUserId: 'U_VOL',
			slackUserName: 'Dana',
			claimedAt: '2026-08-22T09:00:00.000Z',
			expiresAt: '2099-01-01T00:00:00.000Z',
			releasedAt: null,
			completedAt: null,
		};

		// schema.ts keeps retired rows precisely so a live checkout still
		// renders. Dropping them takes a volunteer's turf AND its MiniVAN list
		// number off their own page while they are out walking it.
		it('is still served, and flagged, when the viewer holds it', async () => {
			stubQueries([RETIRED], [MY_CLAIM]);
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect(result.turfs).toHaveLength(1);
			expect(result.turfs[0]!.retired).toBe(true);
			expect(result.turfs[0]!.status).toBe('held-by-you');
			expect(result.turfs[0]!.printedListNumber).toBe('35536745-88712');
		});

		it('widens the turf query only when the viewer holds something', async () => {
			const where = vi.fn(async () => []);
			mockSelect.mockImplementation(() => ({
				from: () => Object.assign(Promise.resolve([]), { where }),
			}));
			await run(event(VOLUNTEER, 'chapter=71'));
			// Two calls: the viewer's claims, then the turf query. No third,
			// because no rows came back to fetch claims for.
			expect(where).toHaveBeenCalledTimes(2);
		});

		it('carries no retired flag on ordinary turf', async () => {
			const result = await run(event(VOLUNTEER, 'chapter=71'));
			expect('retired' in result.turfs[0]!).toBe(false);
		});
	});

	describe('logging', () => {
		it('stays silent for an ordinary session', async () => {
			// The point of the threshold: a volunteer reopening their own county
			// all morning is the bulk of the traffic and says nothing.
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const quiet = { ...VOLUNTEER, slackUserId: 'U_QUIET' };
			for (let i = 0; i < 10; i++) await run(event(quiet, 'chapter=71'));
			const lines = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
			expect(lines).not.toContain('U_QUIET');
		});

		it('logs once someone has opened an unusual number of chapters', async () => {
			const many = Array.from({ length: 6 }, (_, i) => ({
				chapterId: 7000 + i,
				channelId: `C${i}`,
				name: `Chapter ${i}`,
			}));
			mockSettings.mockResolvedValue({
				turfHiddenChapterIds: new Set<number>(),
				chapterChannelMap: many,
			});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const wide = { ...VOLUNTEER, slackUserId: 'U_WIDE' };

			for (const chapter of many) {
				stubQueries([turfRow({ chapterId: chapter.chapterId })]);
				await run(event(wide, `chapter=${chapter.chapterId}`));
			}

			const lines = warn.mock.calls.flat().join(' ');
			expect(lines).toContain('wide chapter browsing');
			expect(lines).toContain('user=U_WIDE');
			// One line carries the whole picture, rather than a run of them.
			expect(lines).toContain('seen=');
		});
	});
});

// Story 7.4. The page promises a volunteer a number of hours and the claim
// route writes an expiry; both now come from /settings, and they have to be the
// same number. This shipped wrong once: every branch but the last returned the
// built-in 48 regardless of what an admin had configured.
describe('/turfs load — configured claim options', () => {
	// A fresh Slack id per test. The chapter rate limiter is process-wide module
	// state and earlier tests in this file deliberately exhaust it, so reusing
	// VOLUNTEER here would land on the rate-limited branch and return no turf at
	// all — which looks exactly like a broken payload.
	let viewer: { slackUserId: string; slackUserName: string; isAdmin: boolean };
	let seq = 0;

	beforeEach(() => {
		viewer = { slackUserId: `U_CFG_${++seq}`, slackUserName: 'Dana', isAdmin: false };
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 4,
		});
	});

	it.each([
		['with no chapter chosen', undefined],
		['on a chapter', 'chapter=71'],
	])('ships the configured TTL %s', async (_label, query) => {
		const data = await run(event(viewer, query));
		expect(data.claimTtlHours).toBe(72);
	});

	it('ships it on the blocked branch too', async () => {
		mockBlockedIds.mockResolvedValue(new Set([viewer.slackUserId]));
		const data = await run(event(viewer));
		expect(data.blocked).toBeTruthy();
		expect(data.claimTtlHours).toBe(72);
	});

	// Every branch has to agree: which one renders the claim copy is a fact
	// about the markup, and markup moves.
	it('never mixes the configured value with the built-in default', async () => {
		const seen = await Promise.all(
			[undefined, 'chapter=71', 'chapter=9999'].map(
				async (q) => (await run(event(viewer, q))).claimTtlHours,
			),
		);
		expect(new Set(seen)).toEqual(new Set([72]));
	});

	it('greys out a turf once the volunteer is at the configured cap', async () => {
		const heldElsewhere = {
			turfId: 900,
			slackUserId: viewer.slackUserId,
			slackUserName: viewer.slackUserName,
			claimedAt: '2026-08-24T09:00:00.000Z',
			expiresAt: '2099-01-01T00:00:00.000Z',
			releasedAt: null,
			completedAt: null,
		};

		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 1,
		});
		stubQueries([turfRow()], [heldElsewhere]);
		const atLimit = await run(event(viewer, 'chapter=71'));
		expect(atLimit.turfs[0]!.claimable).toBe(false);
		expect(atLimit.turfs[0]!.claimBlockedReason).toContain('1 turf');

		// Same ledger, a roomier cap: now claimable.
		mockSettings.mockResolvedValue({
			turfHiddenChapterIds: new Set<number>(),
			chapterChannelMap: CHAPTERS,
			vanTurfClaimTtlHours: 72,
			vanTurfMaxConcurrentClaims: 5,
		});
		stubQueries([turfRow()], [heldElsewhere]);
		const roomy = await run(event(viewer, 'chapter=71'));
		expect(roomy.turfs[0]!.claimable).toBe(true);
	});
});

describe('/turfs nearby action', () => {
	const SUMMARY = {
		centre: { lat: 42.281, lng: -83.743 },
		doors: { kind: 'over', atLeast: 350 },
		canvassers: 2,
		cells: [{ lat: 42.28, lng: -83.74, w: 3 }],
	};
	// The public limiter is process-wide, so each test gets its own address.
	let ip = 0;
	let address: string;

	beforeEach(() => {
		vi.clearAllMocks();
		address = `198.51.100.${++ip}`;
		mockNearby.mockResolvedValue(SUMMARY);
		mockResolveLocation.mockResolvedValue({ point: { lat: 42.2808, lng: -83.743 }, zip: '48104' });
		// Wayne is hidden from /turfs, so only Washtenaw's turf is on offer.
		mockSettings.mockResolvedValue({
			vanAssignmentTtlHours: 72,
			chapterChannelMap: CHAPTERS,
			turfHiddenChapterIds: new Set([72]),
		});
	});

	function post(fields: Record<string, string>) {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		return {
			request: new Request('https://app.example/turfs?/nearby', { method: 'POST', body }),
			getClientAddress: () => address,
		} as never;
	}

	it('answers a ZIP with the summary and names the ZIP', async () => {
		const result = await actions.nearby(post({ q: '48104' }));
		expect(result).toEqual({ nearby: { ...SUMMARY, place: { kind: 'zip', zip: '48104' } } });
	});

	it('never echoes a street address back', async () => {
		const result = await actions.nearby(post({ q: '123 Main St, Ann Arbor MI' }));
		expect(result).toMatchObject({ nearby: { place: { kind: 'address' } } });
		expect(JSON.stringify(result)).not.toContain('Main St');
	});

	it('uses device coordinates without geocoding, rounded', async () => {
		const result = await actions.nearby(post({ lat: '42.280812', lng: '-83.743038' }));
		expect(mockResolveLocation).not.toHaveBeenCalled();
		// With the admin's hand-out TTL and the chapters /turfs offers, so it
		// counts what the map would — not turf only a hidden chapter can see.
		expect(mockNearby).toHaveBeenCalledWith(
			expect.anything(),
			{ lat: 42.281, lng: -83.743 },
			expect.any(Date),
			72,
			[71],
		);
		expect(result).toMatchObject({ nearby: { place: { kind: 'here' } } });
	});

	it('asks for input when given none', async () => {
		const result = await actions.nearby(post({ q: '  ' }));
		expect(result).toMatchObject({ status: 400 });
		expect(mockNearby).not.toHaveBeenCalled();
	});

	it('says so when the place cannot be found', async () => {
		mockResolveLocation.mockResolvedValue(null);
		const result = await actions.nearby(post({ q: 'nowhere at all' }));
		expect(result).toMatchObject({ status: 422 });
		expect(mockNearby).not.toHaveBeenCalled();
	});

	it('refuses an overlong query before geocoding it', async () => {
		const result = await actions.nearby(post({ q: 'x'.repeat(201) }));
		expect(result).toMatchObject({ status: 400 });
		expect(mockResolveLocation).not.toHaveBeenCalled();
	});

	it('rate-limits one visitor without touching another', async () => {
		for (let i = 0; i < PUBLIC_LOOKUPS_PER_MINUTE; i++) {
			await actions.nearby(post({ q: '48104' }));
		}
		const refused = await actions.nearby(post({ q: '48104' }));
		expect(refused).toMatchObject({ status: 429 });
		expect(mockResolveLocation).toHaveBeenCalledTimes(PUBLIC_LOOKUPS_PER_MINUTE);

		address = '203.0.113.200';
		expect(await actions.nearby(post({ q: '48104' }))).toHaveProperty('nearby');
	});
});
