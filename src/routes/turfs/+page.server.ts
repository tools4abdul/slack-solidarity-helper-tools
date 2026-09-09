import { redirect } from '@sveltejs/kit';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import {
	MAP_TILE_API_KEY,
	MAP_TILE_ATTRIBUTION,
	MAP_TILE_URL_TEMPLATE,
	SLACK_SUPERUSER_ID,
} from '$lib/server/env.js';
import { vanTurfCheckouts, vanTurfs } from '$lib/server/schema.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import { lookupZipCentroid } from '$lib/server/van/zip-centroid.js';
import { turfAccess } from '$lib/van/access.js';
import { chaptersSeen, recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { chapterVisits, pruneRateLimitStores } from '$lib/server/van/rate-limit-store.js';
import { selectNearest, TURFS_PER_PAYLOAD } from '$lib/van/turf-paging.js';
import { toTurfView, type TurfView } from '$lib/van/turf-view.js';
import { DEFAULT_CLAIM_TTL_HOURS } from '$lib/van/checkout.js';
import { demoTurfs, DEMO_CHAPTERS, DEMO_LOCATIONS } from '$lib/van/demo-turfs.js';
import { TILE_ATTRIBUTION, TILE_URL_TEMPLATE, withTileApiKey } from '$lib/van/tiles.js';
import type { ClaimSnapshot } from '$lib/van/checkout.js';
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
//   4. Rate limit on switching between chapters, so paging through every county
//      is slow and noisy rather than a loop.
//
// No chapter picked means no turf data at all, rather than a default chapter's
// worth. The picker is a gate, not a pre-filter.

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) redirect(302, '/');

	const tiles = {
		urlTemplate: withTileApiKey(MAP_TILE_URL_TEMPLATE || TILE_URL_TEMPLATE, MAP_TILE_API_KEY),
		attribution: MAP_TILE_ATTRIBUTION || TILE_ATTRIBUTION,
	};

	// The organizer walkthrough, and the FIRST thing this function does — it
	// returns before any database access, so demo mode cannot read real turf
	// even if a later gate were wrong. That ordering is the safety property;
	// everything below it is unreachable in demo mode by construction rather
	// than by a flag being checked correctly in several places.
	//
	// Admin-only, as the standalone demo page was. A non-admin passing ?demo
	// falls through to the real page rather than getting an error: the
	// parameter is a preview affordance, not a mode anyone can be locked out
	// of, and a confusing refusal would just generate a support thread.
	if (url.searchParams.has('demo') && session.isAdmin) {
		const requestedDemo = Number(url.searchParams.get('chapter'));
		const demoChapter = DEMO_CHAPTERS.find((c) => c.chapterId === requestedDemo) ?? null;
		// Everyone here is an admin, so the walkthrough needs an explicit switch
		// to show what a volunteer sees — otherwise organizers would review the
		// page while looking at strictly more than any volunteer ever will. It
		// feeds visibleTurfState, so the PAYLOAD differs, not just the display.
		const asAdmin = url.searchParams.get('view') === 'admin';
		const demoAll = demoChapter ? demoTurfs(demoChapter.chapterId, { isAdmin: asAdmin }) : [];
		const demoLocation = demoChapter ? (DEMO_LOCATIONS[demoChapter.chapterId] ?? null) : null;
		const demoRows = selectNearest(demoAll, {
			location: demoLocation,
			limit: TURFS_PER_PAYLOAD,
		});
		return {
			pageTitle: 'Turf checkout (demo)',
			demo: true,
			blocked: null,
			rateLimited: 0,
			chapters: DEMO_CHAPTERS.map((c) => ({ chapterId: c.chapterId, name: c.name })),
			chapter: demoChapter,
			asAdmin,
			// Paged exactly like the real page. The walkthrough is the only place
			// anyone will see a chapter big enough to need it before launch, so a
			// demo that shipped all thousand rows would be previewing a page we
			// do not serve — and would hide the one behaviour (pan to load more)
			// that organizers most need to recognise when volunteers ask about it.
			turfs: demoRows.selected,
			total: demoAll.length,
			location: demoLocation,
			zip: null as string | null,
			tiles,
			// The built-in default, not the configured one: this branch returns
			// before any database access on purpose (see above), and the walkthrough
			// runs on fabricated turf nobody can actually claim.
			claimTtlHours: DEFAULT_CLAIM_TTL_HOURS,
		};
	}

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
			demo: false,
			blocked: access.message,
			rateLimited: 0,
			asAdmin: false,
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
		demo: false,
		blocked: null,
		rateLimited: 0,
		asAdmin: false,
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
	// Shared with /api/turfs, so the budget follows the user rather than the
	// URL — see rate-limit-store.ts for why that matters.
	const limit = recordChapterView(chapterVisits, session.slackUserId, chapter.chapterId, now, {
		exempt: session.isAdmin,
	});
	if (!limit.allowed) {
		console.warn(
			`[van] chapter switch rate-limited: user=${session.slackUserId} ` +
				`chapter=${chapter.chapterId} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
		return { ...empty, rateLimited: limit.retryAfterSeconds };
	}

	// Logged only once someone has opened an unusual NUMBER of chapters, not on
	// every view — a volunteer reopening their own county all morning is the
	// bulk of the traffic and carries no information. One line at the threshold
	// names every chapter seen, so it says what a run of per-view lines used to.
	if (limit.shouldLog) {
		console.warn(
			`[van] wide chapter browsing: user=${session.slackUserId} ` +
				`chapters=${limit.distinctChapters} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
	}

	// Geolocation is the browser's job; this is the fallback for when it is
	// declined or unavailable. Never throws — a geocoder outage costs distance
	// sorting, not the page.
	const zip = url.searchParams.get('zip');
	const location = zip ? await lookupZipCentroid(db, zip) : null;

	// The viewer's own live claims, fetched first because they widen the turf
	// query below. Not chapter-scoped: the claim is what matters, and a turf
	// they hold is a turf they need to see.
	const myClaims = await db
		.select({ mapRouteId: vanTurfCheckouts.mapRouteId })
		.from(vanTurfCheckouts)
		.where(
			and(
				eq(vanTurfCheckouts.slackUserId, session.slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	const myRouteIds = myClaims.map((c) => c.mapRouteId);

	// Retired turf is excluded — EXCEPT when the viewer is still holding it.
	// schema.ts keeps those rows precisely so a live checkout still renders;
	// dropping them would take a volunteer's turf and its MiniVAN list number
	// off their own page while they are out walking it. The catalog sync
	// releases such claims, but not before the next sync runs.
	const rows = await db
		.select()
		.from(vanTurfs)
		.where(
			and(
				eq(vanTurfs.chapterId, chapter.chapterId),
				myRouteIds.length > 0
					? or(isNull(vanTurfs.retiredAt), inArray(vanTurfs.mapRouteId, myRouteIds))
					: isNull(vanTurfs.retiredAt),
			),
		);

	// Cut rows BEFORE building views: a turf left out of the payload should
	// never be serialised at all, not serialised and then filtered.
	const { selected } = selectNearest(rows, { location, limit: TURFS_PER_PAYLOAD });

	// Claims are fetched for exactly the turf being served. Scoping by
	// mapRouteId rather than pulling the whole ledger keeps a chapter's page
	// from carrying evidence of activity in other chapters.
	const routeIds = selected.map((r) => r.mapRouteId);
	const claimRows =
		routeIds.length === 0
			? []
			: await db
					.select()
					.from(vanTurfCheckouts)
					.where(
						and(
							inArray(vanTurfCheckouts.mapRouteId, routeIds),
							isNull(vanTurfCheckouts.releasedAt),
							isNull(vanTurfCheckouts.completedAt),
						),
					);

	const claims: ClaimSnapshot[] = claimRows.map((c) => ({
		mapRouteId: c.mapRouteId,
		slackUserId: c.slackUserId,
		slackUserName: c.slackUserName,
		claimedAt: c.claimedAt,
		expiresAt: c.expiresAt,
		releasedAt: c.releasedAt,
		completedAt: c.completedAt,
	}));

	const asOf = new Date();
	const viewer = { slackUserId: session.slackUserId, isAdmin: session.isAdmin };
	// Passed to toTurfView so `claimable` and the at-the-limit message reflect
	// what the claim route will actually enforce — the map and the button must
	// not disagree with the thing they lead to.

	return {
		pageTitle: `Turf checkout — ${chapter.name}`,
		demo: false,
		blocked: null,
		rateLimited: 0,
		asAdmin: false,
		chapters,
		chapter,
		// toTurfView is the single gate on what reaches the browser; see its
		// header. Nothing below it should ever be spread from a raw row.
		turfs: selected.map((row) => toTurfView(row, claims, viewer, asOf, options)),
		// The chapter's total, not this payload's remainder. Reporting the
		// remainder made the page's own message drift as soon as someone
		// panned: the count of loaded turf grew while the "N more" figure kept
		// describing whichever viewport answered last, so the two numbers
		// stopped referring to the same set. A total never moves.
		total: rows.length,
		location,
		zip: location ? zip : null,
		tiles,
		// What the page tells a volunteer they are getting. Sourced from the same
		// setting the claim route enforces, so the promise on the button and the
		// expiry actually written to the ledger cannot drift apart. The branches
		// above never reach a claim, so they keep the built-in default.
		claimTtlHours: options.ttlHours,
	};
};
