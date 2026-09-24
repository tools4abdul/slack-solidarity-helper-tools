import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfAccess } from '$lib/van/access.js';
import { chaptersSeen, recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { recordRequest } from '$lib/van/request-budget.js';
import {
	chapterVisits,
	pruneRateLimitStores,
	turfRequests,
} from '$lib/server/van/rate-limit-store.js';
import { parseBounds } from '$lib/van/turf-paging.js';
import { loadChapterTurfs } from '$lib/server/van/turf-query.js';

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
// covers what the chapter limiter cannot see: the TURFS_PER_PAYLOAD cap is a
// payload budget, so walking the bbox grid pulls a whole chapter down a screen
// at a time without ever switching chapters.
//
// The rows themselves come from loadChapterTurfs, the same query the page load
// and the Slack command use, so a turf reads the same on pan as it did on load.

export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });

	const bounds = parseBounds(url.searchParams.get('bbox'));

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

	const { turfs, total } = await loadChapterTurfs(db, {
		chapterId,
		viewer: { slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		bounds,
		now: new Date(now),
		// Same claim options as the page load. An endpoint that skipped them
		// would mark turf claimable on pan that the page had greyed out — and
		// the claim would then be refused on click.
		claimOptions: {
			ttlHours: settings.vanTurfClaimTtlHours,
			maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
		},
	});

	// `total` is the chapter's, matching the page load. A per-viewport remainder
	// would disagree with the figure the page already showed the moment the
	// volunteer panned.
	return json({ turfs, total });
};
