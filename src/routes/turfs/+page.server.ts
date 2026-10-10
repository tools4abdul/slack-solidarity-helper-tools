import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import {
	APP_URL,
	FLY_APP_NAME,
	MAP_TILE_API_KEY,
	MAP_TILE_ATTRIBUTION,
	MAP_TILE_URL_TEMPLATE,
	SLACK_SUPERUSER_ID,
} from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfChapters } from '$lib/chapter-list.js';
import { lookupZipCentroid, normalizeZip, resolveLocation } from '$lib/server/van/zip-centroid.js';
import {
	loadNearbySummary,
	loadTurfCentre,
	type NearbySummary,
} from '$lib/server/van/nearby-summary.js';
import { parseCoordinates, type NearbyPlace } from '$lib/van/nearby-summary.js';
import {
	loginRedirectPath,
	sanitizeRedirectTarget,
	withRedirectTo,
} from '$lib/server/post-login-redirect.js';
import { visitorAddress } from '$lib/server/visitor-address.js';
import { turfAccess } from '$lib/van/access.js';
import { chaptersSeen, recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { PUBLIC_LOOKUPS_PER_MINUTE, recordRequest } from '$lib/van/request-budget.js';
import {
	chapterVisits,
	publicLookups,
	pruneRateLimitStores,
	turfRequests,
} from '$lib/server/van/rate-limit-store.js';
import { loadChapterTurfs } from '$lib/server/van/turf-query.js';
import { dismissHolderNotice, loadHolderNotices } from '$lib/server/van/holder-notices.js';
import { noticeLines, type NoticeLine } from '$lib/van/notice-text.js';
import { errMessage } from '$lib/err-message.js';
import { tidyDisplayName } from '$lib/server/display-name.js';
import { setDisplayNameOnce } from '$lib/server/outside-volunteers.js';
import { updateSession } from '$lib/server/session.js';
import { foldersForChapter } from '$lib/server/van/chapter-visibility.js';
import type { CampaignBadges, TurfView } from '$lib/van/turf-view.js';
import { TILE_ATTRIBUTION, TILE_URL_TEMPLATE, withTileApiKey } from '$lib/van/tiles.js';
import type { LatLng } from '$lib/van/geometry.js';
import { parseTurfSort, type TurfSort } from '$lib/van/turf-paging.js';

// The volunteer turf page.
//
// Signed out, it is a teaser for people who might canvass: a blurred map and
// three coarse numbers about the turf near a point they give us (the `nearby`
// action below), plus links to join the Slack or sign in. That branch returns
// before any of the gates that follow and reads nothing but the join link and
// the tile source — no chapter, no turf rows, no claims. /turfs is public by
// exact path for this reason only; see server/public-paths.ts.
//
// Signed in, four gates, in order, all server-side:
//
//   1. Session. Checked here rather than leaning on +layout.server.ts, because
//      layout and page loads run CONCURRENTLY — an unauthenticated request
//      still reaches this function. Same reasoning as routes/pending.
//   2. Access. van/access.ts, which gates reads as well as writes. A blocked
//      user must not see the map at all: blocking only the claim button would
//      leave the targeting picture — where the campaign is knocking, and how
//      hard — visible to exactly the person who was just removed.
//   3. Chapter. Turf is served one chapter at a time and the FILTER RUNS HERE,
//      before serialising. Shipping every chapter and filtering in the browser
//      would make the compartment purely cosmetic; the payload is the boundary.
//   4. Rate limits: the per-request budget, and the limit on switching between
//      chapters, so paging through every county is slow and noisy rather than
//      a loop.
//
// No chapter picked means no turf data at all, rather than a default chapter's
// worth. The picker is a gate, not a pre-filter.
//
// The turf itself comes from loadChapterTurfs, the same query /api/turfs and
// the /turfs Slack command use, so the three cannot disagree about a turf.

/** Which limit stopped the load, so the page can say the right thing: the
 *  chapter limiter clears for chapters already seen, the budget does not. */
export type RateLimitReason = 'chapters' | 'requests';

/** Longest address we will pass to the geocoder. */
const MAX_QUERY_LENGTH = 200;

export type PublicNearby = NearbySummary & { place: NearbyPlace };

function tileSource() {
	return {
		urlTemplate: withTileApiKey(MAP_TILE_URL_TEMPLATE || TILE_URL_TEMPLATE, MAP_TILE_API_KEY),
		attribution: MAP_TILE_ATTRIBUTION || TILE_ATTRIBUTION,
	};
}

/** The chapters /turfs offers, by id — for the signed-out teaser, which spans
 *  chapters but must count only turf one of them can claim. */
function offeredChapterIds(settings: {
	chapterChannelMap: Array<{ chapterId: number; name: string }>;
	turfHiddenChapterIds: ReadonlySet<number>;
	turfCustomChapters: Array<{ chapterId: number; name: string }>;
}): number[] {
	return turfChapters(
		settings.chapterChannelMap,
		settings.turfHiddenChapterIds,
		settings.turfCustomChapters,
	).map((c) => c.chapterId);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = locals.session;
	const tiles = tileSource();

	if (!session) {
		const visitorSettings = await loadSettings(db);
		const { publicJoinUrl } = visitorSettings;
		// Centred on turf a chapter /turfs offers can see, like the summary.
		const turfCentre = await loadTurfCentre(db, offeredChapterIds(visitorSettings));
		return {
			mode: 'public' as const,
			pageTitle: 'Canvass near you',
			tiles,
			turfCentre,
			joinUrl: publicJoinUrl || null,
			// Carries /turfs through OAuth, so signing in lands on the real map.
			signInHref: loginRedirectPath(url),
		};
	}

	const [blockedIds, settings] = await Promise.all([loadVanBlockedIds(db), loadSettings(db)]);

	// Set by the turf-only gate (server/turf-only-access.ts) when it turned a
	// Google or Apple sign-in away from a Slack-only page: the page explains, and offers
	// Slack sign-in straight back to where they were going. Shipped on every
	// member branch below so the notice shows whatever else this page says.
	const needsSlack = url.searchParams.get('needsSlack');
	const needsSlackHref =
		session.authProvider !== undefined && needsSlack !== null
			? withRedirectTo('/auth/slack', sanitizeRedirectTarget(needsSlack))
			: null;

	// The admin-tunable TTL and per-volunteer cap (Story 7.4), already resolved
	// and clamped by loadSettings. Computed here rather than beside the claim
	// logic so every branch below ships the SAME number: a payload that told a
	// volunteer "48 hours" on one code path and 72 on another would be lying on
	// one of them, and which branch renders the claim copy is a fact about the
	// markup that can change without anyone thinking about this file.
	// An outside volunteer with no name yet (see SessionData.needsName): the page
	// asks for one, and the claim route refuses until they give it. Like
	// needsSlackHref, shipped on every member branch below.
	const needsName = session.needsName === true;

	const options = {
		ttlHours: settings.vanTurfClaimTtlHours,
		maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
		vanAssignmentTtlHours: settings.vanAssignmentTtlHours,
	};

	const access = turfAccess(
		{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		blockedIds,
		SLACK_SUPERUSER_ID,
	);
	if (!access.allowed) {
		// A plain explanation, not a 404 and not an error page. Returned rather
		// than thrown so the page can render it calmly — and with no turf data
		// alongside it.
		return {
			mode: 'member' as const,
			pageTitle: 'Turf checkout',
			blocked: access.message,
			needsSlackHref,
			// Not asked: setName refuses a blocked volunteer, so the prompt
			// would only lead to a refusal after they had typed and confirmed.
			needsName: false,
			// Nothing about turf for a blocked user, these included.
			notices: [] as TurfNoticeView[],
			rateLimited: 0,
			rateLimitReason: null as RateLimitReason | null,
			chapters: [],
			chapter: null,
			turfs: [] as TurfView[],
			total: 0,
			campaignBadges: null as CampaignBadges | null,
			location: null as LatLng | null,
			zip: null as string | null,
			sort: 'nearest' as TurfSort,
			tiles,
			claimTtlHours: options.ttlHours,
		};
	}

	// The picker lists every chapter the campaign has a Slack channel for, NOT
	// the chapters that have turf. Listing only the latter would be a
	// cross-chapter aggregate: one request revealing where the field operation
	// is running, which is exactly what the compartment exists to prevent.
	// Deduplicated by chapterId — see chaptersFromChannelMap, which this page's
	// inline version became. Leaving it inline is what let /turfs/organizer and
	// /turfs/activity reintroduce the bug in a form that broke hydration. Less
	// the chapters an admin has hidden from turf, which then read as unknown
	// below — a `?chapter=` link to one opens the picker, not the chapter.
	const chapters = turfChapters(
		settings.chapterChannelMap,
		settings.turfHiddenChapterIds,
		settings.turfCustomChapters,
	);

	// What the turf sweeps would have DMed a Google or Apple holder, who has no
	// Slack (User Story 5 of specs/013-google-sso-login). Slack holders got theirs as
	// DMs, so there is nothing to read for them. Like needsSlackHref, shipped on
	// every branch below.
	const notices =
		session.authProvider !== undefined ? await turfNoticesFor(session.slackUserId) : [];

	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;

	const empty = {
		mode: 'member' as const,
		pageTitle: 'Turf checkout',
		blocked: null,
		needsSlackHref,
		needsName,
		notices,
		rateLimited: 0,
		rateLimitReason: null as RateLimitReason | null,
		chapters,
		chapter: null,
		turfs: [] as TurfView[],
		total: 0,
		campaignBadges: null as CampaignBadges | null,
		location: null as LatLng | null,
		zip: null as string | null,
		sort: 'nearest' as TurfSort,
		tiles,
		claimTtlHours: options.ttlHours,
	};

	if (!chapter) return empty;

	const now = Date.now();
	pruneRateLimitStores(now);

	// Both limiters are shared with /api/turfs, so the budget follows the user
	// rather than the URL — see rate-limit-store.ts for why that matters.
	//
	// The per-request budget is spent HERE as well as on the API. This load
	// returns the nearest TURFS_PER_PAYLOAD turfs to whatever `zip` is passed,
	// and a different ZIP is a different set, so a loop over
	// `?chapter=N&zip=XXXXX` walks a whole chapter through the page alone. Each uncached ZIP also costs an
	// unthrottled third-party geocode. The API route's header promises every
	// gate it applies is applied here too; leaving this one off the page made
	// the promise true in only one direction.
	const budget = recordRequest(turfRequests, session.slackUserId, now, {
		exempt: session.isAdmin,
	});
	if (!budget.allowed) {
		console.warn(`[van] turf request budget exhausted (page): user=${session.slackUserId}`);
		return {
			...empty,
			rateLimited: budget.retryAfterSeconds,
			rateLimitReason: 'requests' as RateLimitReason,
		};
	}

	const limit = recordChapterView(chapterVisits, session.slackUserId, chapter.chapterId, now, {
		exempt: session.isAdmin,
		folderIds: await foldersForChapter(db, chapter.chapterId),
	});
	if (!limit.allowed) {
		console.warn(
			`[van] chapter switch rate-limited: user=${session.slackUserId} ` +
				`chapter=${chapter.chapterId} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
		return {
			...empty,
			rateLimited: limit.retryAfterSeconds,
			rateLimitReason: 'chapters' as RateLimitReason,
		};
	}

	// Logged only once someone has opened an unusual NUMBER of chapters, not on
	// every view — a volunteer reopening their own county all morning is the
	// bulk of the traffic and carries no information. One line at the threshold
	// names every chapter seen, so it says what a run of per-view lines used to.
	if (limit.shouldLog) {
		console.warn(
			`[van] wide chapter browsing: user=${session.slackUserId} ` +
				`chapters=${limit.chargedChapters} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
	}

	// Geolocation is the browser's job; this is the fallback for when it is
	// declined or unavailable. Never throws — a geocoder outage costs distance
	// sorting, not the page.
	const zip = url.searchParams.get('zip');
	const location = zip ? await lookupZipCentroid(db, zip) : null;
	// Applied before the payload cut, not just in the browser: a chapter of
	// 2,000 turfs sends 600, and the densest might be in neither the nearest
	// 600 nor the first 600 by name.
	const sort = parseTurfSort(url.searchParams.get('sort'));

	// Retired turf is excluded except when the viewer still holds it, and the
	// viewer's own turf is pinned to the payload whatever the distance sort
	// says: it carries their MiniVAN list number, and a volunteer who claimed
	// turf on the far side of the chapter would otherwise open the page to no
	// card at all. Both are loadChapterTurfs' `includeHeldByViewer`.
	const { turfs, total, campaignBadges } = await loadChapterTurfs(db, {
		chapterId: chapter.chapterId,
		viewer: { slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		location,
		sort,
		includeHeldByViewer: true,
		// So `claimable` and the at-the-limit message reflect what the claim
		// route will actually enforce — the map and the button must not
		// disagree with the thing they lead to.
		claimOptions: options,
		now: new Date(now),
	});

	return {
		mode: 'member' as const,
		pageTitle: `Turf checkout — ${chapter.name}`,
		blocked: null,
		needsSlackHref,
		needsName,
		notices,
		rateLimited: 0,
		rateLimitReason: null as RateLimitReason | null,
		chapters,
		chapter,
		turfs,
		// The chapter's total, not this payload's remainder. Reporting the
		// remainder made the page's own message drift as soon as someone
		// panned: the count of loaded turf grew while the "N more" figure kept
		// describing whichever viewport answered last, so the two numbers
		// stopped referring to the same set. A total never moves.
		total,
		// Badge text per campaign, for TurfView.campaignId — null while only one
		// campaign is enabled. Signed-in only: the teaser branch never has it.
		campaignBadges,
		location,
		zip: location ? zip : null,
		sort,
		tiles,
		// What the page tells a volunteer they are getting. Sourced from the same
		// setting the claim route enforces, so the promise on the button and the
		// expiry actually written to the ledger cannot drift apart. Every branch
		// above ships the same value, for the reason given where `options` is
		// built.
		claimTtlHours: options.ttlHours,
	};
};

/** A holder notice as the page renders it — see $lib/van/notice-text.ts. */
export interface TurfNoticeView {
	id: number;
	lines: NoticeLine[];
}

/**
 * A Google or Apple holder's notices, rendered. Never throws: a failed read costs the
 * notices for this visit, not the turf map, and the rows are still there for
 * the next one.
 */
async function turfNoticesFor(holderId: string): Promise<TurfNoticeView[]> {
	try {
		const rows = await loadHolderNotices(db, holderId);
		return rows.map((n) => ({ id: n.id, lines: noticeLines(n.text, APP_URL) }));
	} catch (err) {
		console.error('[van] could not read holder notices:', errMessage(err));
		return [];
	}
}

export const actions: Actions = {
	/**
	 * Dismiss one of your own notices. Only a Google or Apple sign-in has any; anyone
	 * else gets a quiet no-op, and the delete is scoped to the holder, so a
	 * guessed id dismisses nothing of anyone else's.
	 */
	dismissNotice: async ({ request, locals }) => {
		const session = locals.session;
		// `dismissError`, not `error`: the teaser's `nearby` action owns `error`,
		// and this page tells the two apart by key.
		if (!session) return fail(401, { dismissError: 'Not signed in' });
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id)) return fail(400, { dismissError: 'Unknown notice' });
		if (session.authProvider === undefined) return { dismissed: id };
		try {
			await dismissHolderNotice(db, session.slackUserId, id);
		} catch (err) {
			console.error('[van] could not dismiss a holder notice:', errMessage(err));
			return fail(500, { dismissError: 'Could not dismiss that. Please try again.' });
		}
		return { dismissed: id };
	},

	/**
	 * Give the name /turfs asked for — an outside volunteer whose provider sent
	 * none (specs/014-apple-sso-login, FR-011). Two steps, because the name can
	 * never be changed afterwards (FR-011b): the first submit tidies it and
	 * shows it back, and only a second, with `confirm=1`, saves it.
	 *
	 * Saved once: if a name was already set (another tab, a replayed form), that
	 * one stands and the session catches up to it. If there is no record to
	 * save it on — cleared, or the sign-in could not write it — it still names
	 * this session, and they are asked again on their next sign-in.
	 *
	 * Results use `name*` keys: `error` belongs to the teaser's `nearby` action.
	 */
	setName: async ({ request, locals, cookies }) => {
		const session = locals.session;
		if (!session) return fail(401, { nameError: 'Not signed in' });
		// Slack members and anyone already named: nothing to do.
		if (!session.needsName) return { nameSaved: session.slackUserName };

		const form = await request.formData();
		const raw = form.get('name');
		const name = typeof raw === 'string' ? tidyDisplayName(raw) : '';
		if (name === '') {
			return fail(400, { nameError: 'Enter the name organizers should know you by.' });
		}
		if (form.get('confirm') !== '1') return { confirmName: name };

		// Someone blocked from turf checkout has nothing to name themselves
		// for, and a name set now would change how they appear to the admin
		// who blocked them.
		const access = turfAccess(
			{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
			await loadVanBlockedIds(db),
			SLACK_SUPERUSER_ID,
		);
		if (!access.allowed) return fail(403, { nameError: access.message });

		// Everything but the placeholder and its flag.
		const rest = { ...session };
		delete rest.needsName;
		const named = (displayName: string) => ({ ...rest, slackUserName: displayName });

		// The session first: if it has ended — signed out, revoked by a block —
		// nothing is stored for it. The record second, which may say a name was
		// already saved (another tab), in which case the session follows that.
		if (!(await updateSession(cookies, named(name)))) {
			return fail(401, { nameError: 'Your sign-in has expired. Please sign in again.' });
		}
		let finalName = name;
		try {
			const result = await setDisplayNameOnce(db, session.slackUserId, name);
			if (result.status === 'taken') {
				finalName = result.displayName;
				await updateSession(cookies, named(finalName));
			}
			if (result.status === 'no-record') {
				console.warn(`[auth] no record to name for ${session.slackUserId}; session only`);
			}
		} catch (err) {
			console.error('[auth] could not save a typed name:', errMessage(err));
			// Back to asking: a session named by a name that was never stored
			// would be asked again at the next sign-in, under a different name.
			await updateSession(cookies, session).catch(() => {});
			return fail(500, { nameError: 'Could not save your name. Please try again.' });
		}

		// And for the rest of this request: without JavaScript the page's load
		// runs straight after this action, on the same `locals`, and would
		// otherwise ask for the name it was just given.
		locals.session = named(finalName);
		console.log(`[auth] named: ${finalName} (${session.slackUserId})`);
		return finalName === name ? { nameSaved: finalName } : { nameTaken: finalName };
	},

	/**
	 * The signed-out teaser's lookup: an address or ZIP (`q`), or device
	 * coordinates (`lat`, `lng`), in; coarse aggregates out.
	 *
	 * A POST rather than query parameters so a typed street address never lands
	 * in a URL, and with it in browser history, a shared link or an access log.
	 * Open to signed-in users too; nothing here is more than the teaser shows.
	 */
	nearby: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		const rawQuery = form.get('q');
		const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
		const coords = parseCoordinates(form.get('lat'), form.get('lng'));

		if (!coords && query === '') {
			return fail(400, { error: 'Enter an address or ZIP code, or use your location.' });
		}
		if (!coords && query.length > MAX_QUERY_LENGTH) {
			return fail(400, { error: 'That address is too long. Try just the street and ZIP code.' });
		}

		const now = Date.now();
		pruneRateLimitStores(now);
		const budget = recordRequest(
			publicLookups,
			visitorAddress(request, getClientAddress, FLY_APP_NAME !== ''),
			now,
			{ max: PUBLIC_LOOKUPS_PER_MINUTE },
		);
		if (!budget.allowed) {
			return fail(429, {
				error: `That's a lot of lookups. Try again in ${budget.retryAfterSeconds} seconds.`,
			});
		}

		let point: LatLng;
		let place: NearbyPlace;
		if (coords) {
			point = coords;
			place = { kind: 'here' };
		} else {
			// Never throws, never logs or stores the address — see zip-centroid.ts.
			const resolved = await resolveLocation(db, query);
			if (!resolved) {
				return fail(422, {
					error: "We couldn't find that place. Try a five-digit ZIP code or a full street address.",
				});
			}
			point = resolved.point;
			const zip = normalizeZip(query);
			place = zip ? { kind: 'zip', zip } : { kind: 'address' };
		}

		// The admin's hand-out TTL and the chapters /turfs offers, so the summary
		// counts the same turf as claimable that a signed-in volunteer's map
		// would — not turf only a chapter hidden from /turfs can see.
		const settings = await loadSettings(db);
		const summary = await loadNearbySummary(
			db,
			point,
			new Date(now),
			settings.vanAssignmentTtlHours,
			offeredChapterIds(settings),
		);
		return { nearby: { ...summary, place } satisfies PublicNearby };
	},
};
