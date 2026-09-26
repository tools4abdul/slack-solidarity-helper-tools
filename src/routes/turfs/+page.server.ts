import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import {
	MAP_TILE_API_KEY,
	MAP_TILE_ATTRIBUTION,
	MAP_TILE_URL_TEMPLATE,
	SLACK_SUPERUSER_ID,
} from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import { lookupZipCentroid } from '$lib/server/van/zip-centroid.js';
import { turfAccess } from '$lib/van/access.js';
import { chaptersSeen, recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { recordRequest } from '$lib/van/request-budget.js';
import {
	chapterVisits,
	pruneRateLimitStores,
	turfRequests,
} from '$lib/server/van/rate-limit-store.js';
import { loadChapterTurfs } from '$lib/server/van/turf-query.js';
import { foldersForChapter } from '$lib/server/van/chapter-visibility.js';
import type { TurfView } from '$lib/van/turf-view.js';
import { TILE_ATTRIBUTION, TILE_URL_TEMPLATE, withTileApiKey } from '$lib/van/tiles.js';
import type { LatLng } from '$lib/van/geometry.js';

// The volunteer turf page.
//
// Four gates, in order, all server-side:
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

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) redirect(302, '/');

	const tiles = {
		urlTemplate: withTileApiKey(MAP_TILE_URL_TEMPLATE || TILE_URL_TEMPLATE, MAP_TILE_API_KEY),
		attribution: MAP_TILE_ATTRIBUTION || TILE_ATTRIBUTION,
	};

	const [blockedIds, settings] = await Promise.all([loadVanBlockedIds(db), loadSettings(db)]);

	// The admin-tunable TTL and per-volunteer cap (Story 7.4), already resolved
	// and clamped by loadSettings. Computed here rather than beside the claim
	// logic so every branch below ships the SAME number: a payload that told a
	// volunteer "48 hours" on one code path and 72 on another would be lying on
	// one of them, and which branch renders the claim copy is a fact about the
	// markup that can change without anyone thinking about this file.
	const options = {
		ttlHours: settings.vanTurfClaimTtlHours,
		maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
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
			pageTitle: 'Turf checkout',
			blocked: access.message,
			rateLimited: 0,
			rateLimitReason: null as RateLimitReason | null,
			chapters: [],
			chapter: null,
			turfs: [] as TurfView[],
			total: 0,
			location: null as LatLng | null,
			zip: null as string | null,
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
	// /turfs/activity reintroduce the bug in a form that broke hydration.
	const chapters = chaptersFromChannelMap(settings.chapterChannelMap);

	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;

	const empty = {
		pageTitle: 'Turf checkout',
		blocked: null,
		rateLimited: 0,
		rateLimitReason: null as RateLimitReason | null,
		chapters,
		chapter: null,
		turfs: [] as TurfView[],
		total: 0,
		location: null as LatLng | null,
		zip: null as string | null,
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

	// Retired turf is excluded except when the viewer still holds it, and the
	// viewer's own turf is pinned to the payload whatever the distance sort
	// says: it carries their MiniVAN list number, and a volunteer who claimed
	// turf on the far side of the chapter would otherwise open the page to no
	// card at all. Both are loadChapterTurfs' `includeHeldByViewer`.
	const { turfs, total } = await loadChapterTurfs(db, {
		chapterId: chapter.chapterId,
		viewer: { slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		location,
		includeHeldByViewer: true,
		// So `claimable` and the at-the-limit message reflect what the claim
		// route will actually enforce — the map and the button must not
		// disagree with the thing they lead to.
		claimOptions: options,
		now: new Date(now),
	});

	return {
		pageTitle: `Turf checkout — ${chapter.name}`,
		blocked: null,
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
		location,
		zip: location ? zip : null,
		tiles,
		// What the page tells a volunteer they are getting. Sourced from the same
		// setting the claim route enforces, so the promise on the button and the
		// expiry actually written to the ledger cannot drift apart. Every branch
		// above ships the same value, for the reason given where `options` is
		// built.
		claimTtlHours: options.ttlHours,
	};
};
