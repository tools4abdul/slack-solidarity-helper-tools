import { json } from '@sveltejs/kit';
import { and, isNull, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { vanTurfCheckouts, vanTurfs } from '$lib/server/schema.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfAccess } from '$lib/van/access.js';
import { chaptersSeen, recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { recordRequest } from '$lib/van/request-budget.js';
import {
	chapterVisits,
	pruneRateLimitStores,
	turfRequests,
} from '$lib/server/van/rate-limit-store.js';
import {
	parseBounds,
	selectNearest,
	TURFS_PER_PAYLOAD,
	withinBounds,
} from '$lib/van/turf-paging.js';
import { toTurfView } from '$lib/van/turf-view.js';
import type { ClaimSnapshot } from '$lib/van/checkout.js';
import { demoTurfs, DEMO_CHAPTERS } from '$lib/van/demo-turfs.js';
import { visibleToChapter } from '$lib/server/van/chapter-visibility.js';
import { latestWalkReports } from '$lib/server/van/checkout-store.js';

// Turf inside a map viewport, for paging a chapter too large to serialise in
// one payload (plan.md 6.2b — a 1,000-turf chapter is ~800 KB).
//
// Every gate the page load applies is applied again here, in the same order,
// AND against the same shared counters. This endpoint returns the same data
// the load function does, so a weaker guard on it is simply the way around the
// page's guard — for a while this route had no rate limit at all, which made
// the page's chapter limiter decorative: a loop over `?chapter=` pulled the
// whole state, unthrottled and unlogged.
//
// Two limits, doing different jobs. The chapter limiter is shared with the
// page, so switching chapters costs the same whether you do it in a browser or
// with curl, and panning around one chapter stays free. The request budget
// covers what the chapter limiter cannot see: the 150-row cap is a payload
// budget, so walking the bbox grid pulls a whole chapter down a screen at a
// time without ever switching chapters.

export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });

	const bounds = parseBounds(url.searchParams.get('bbox'));

	// Demo paging, and — like the page load's demo branch — the first thing
	// that happens, returning before any database access. Same admin gate, same
	// fabricated source.
	//
	// It deliberately skips both rate limiters. An organizer rehearsing the
	// flow must not spend the budget they need for real work, and there is
	// nothing here to enumerate: the data is invented and the chapter list is
	// a constant.
	if (url.searchParams.has('demo') && session.isAdmin) {
		const demoChapterId = Number(url.searchParams.get('chapter'));
		if (!DEMO_CHAPTERS.some((c) => c.chapterId === demoChapterId)) {
			return json({ error: 'Unknown chapter' }, { status: 400 });
		}
		if (!bounds) return json({ error: 'Invalid bbox' }, { status: 400 });
		const all = demoTurfs(demoChapterId, { isAdmin: url.searchParams.get('view') === 'admin' });
		const { selected } = selectNearest(withinBounds(all, bounds), { limit: TURFS_PER_PAYLOAD });
		return json({ turfs: selected, total: all.length });
	}

	const now = Date.now();
	pruneRateLimitStores(now);

	const budget = recordRequest(turfRequests, session.slackUserId, now, {
		exempt: session.isAdmin,
	});
	if (!budget.allowed) {
		console.warn(`[van] turf API request budget exhausted: user=${session.slackUserId}`);
		return json(
			{ error: 'Too many requests. Slow down and try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
		);
	}

	const access = turfAccess(
		{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		await loadVanBlockedIds(db),
		SLACK_SUPERUSER_ID,
	);
	if (!access.allowed) return json({ error: access.message }, { status: 403 });

	const chapterId = Number(url.searchParams.get('chapter'));
	if (!Number.isInteger(chapterId)) {
		return json({ error: 'Unknown chapter' }, { status: 400 });
	}

	// Re-derived from settings rather than trusted from the query string, so a
	// chapter id that is not a real chapter returns nothing instead of probing
	// the table.
	const settings = await loadSettings(db);
	if (!settings.chapterChannelMap.some((c) => c.chapterId === chapterId)) {
		return json({ error: 'Unknown chapter' }, { status: 400 });
	}

	// Counted against the SAME budget as the page. Panning within one chapter is
	// free (a repeat chapter never costs a slot), so this only bites someone
	// sweeping chapters through the API.
	const limit = recordChapterView(chapterVisits, session.slackUserId, chapterId, now, {
		exempt: session.isAdmin,
	});
	if (!limit.allowed) {
		console.warn(
			`[van] chapter switch rate-limited (api): user=${session.slackUserId} ` +
				`chapter=${chapterId} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
		return json(
			{ error: 'Too many chapters opened recently. Try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
		);
	}
	if (limit.shouldLog) {
		console.warn(
			`[van] wide chapter browsing (api): user=${session.slackUserId} ` +
				`chapters=${limit.distinctChapters} seen=${chaptersSeen(chapterVisits, session.slackUserId, now).join(',')}`,
		);
	}

	// A bad box must 400 rather than silently matching the whole world — that
	// would hand back the entire chapter in one request and undo the paging
	// this endpoint exists to provide.
	if (!bounds) return json({ error: 'Invalid bbox' }, { status: 400 });

	const rows = await db
		.select()
		.from(vanTurfs)
		.where(and(visibleToChapter(chapterId), isNull(vanTurfs.retiredAt)));

	// Bounded twice: by the viewport, then by the payload budget. A volunteer
	// zoomed out to the whole county is still asking for a box, and without the
	// second cap that box is the chapter.
	const inView = withinBounds(rows, bounds);
	const { selected } = selectNearest(inView, { limit: TURFS_PER_PAYLOAD });

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

	const viewer = { slackUserId: session.slackUserId, isAdmin: session.isAdmin };
	// Same walk reports as the page load, or a turf walked to 100% would read
	// as claimable on pan and be refused on click.
	const walkReports = await latestWalkReports(
		db,
		selected.map((r) => r.mapRouteId),
	);

	return json({
		// Same claim options as the page load. Before 7.4 both used the built-in
		// defaults and agreed by accident; now that they are configurable, an
		// endpoint that skipped them would mark turf claimable on pan that the
		// page had greyed out — and the claim would then be refused on click.
		turfs: selected.map((row) =>
			toTurfView(row, claims, viewer, new Date(now), {
				ttlHours: settings.vanTurfClaimTtlHours,
				maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
				walkReports,
			}),
		),
		// The chapter's total, matching the page load. A per-viewport remainder
		// would disagree with the figure the page already showed the moment the
		// volunteer panned.
		total: rows.length,
	});
};
