import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import {
	hasAnyTurf,
	loadActivityCounts,
	loadActivityRows,
} from '$lib/server/van/activity-store.js';
import {
	activityEvents,
	EVENT_CAP,
	parsePeriod,
	rangeFor,
	totalEvents,
	type ActivityEvent,
} from '$lib/van/turf-activity.js';
import { campaignDayKey, campaignDayLabel, campaignTimeLabel } from '$lib/campaign-time.js';
import { relativeSince } from '$lib/components/settings/format-relative.js';

// Turf checkout history, for organizers.
//
// The organizer side of a line the volunteer page draws deliberately. /turfs
// refuses an "all chapters" view and hides holder names — turf-status.ts
// collapses `held-by-other` and nulls `heldBy` for non-admins — because a
// volunteer cannot act on that and has no reason to learn who is knocking which
// block. This page is the other side of it: names are shown, every chapter is
// the default, and the gate is admin-only. That asymmetry is the design, not a
// gap in it.
//
// Two things are still withheld, from admins as much as anyone:
//
//   - The MiniVAN list number. It is the credential issued to whoever holds the
//     turf, and an admin is not the holder. activity-store.ts never selects it,
//     so it cannot reach the payload by omission.
//   - Anything per-voter. Nothing of the kind is stored in the first place, but
//     the test asserts it rather than trusting the pipeline upstream to stay
//     that way.
//
// Timestamps are formatted here rather than in the component. Formatting in the
// browser would render each row in the reader's own timezone — two organizers
// comparing notes would see different times for one event — and would risk a
// hydration mismatch on every row.

export interface ActivityEventView extends ActivityEvent {
	/** Campaign-local grouping key, `YYYY-MM-DD`. */
	dayKey: string;
	/** Campaign-local time of day, e.g. "9:41 AM". */
	timeLabel: string;
	/** "20m ago", against this load's `now`. Formatted here for the same reason
	 *  `timeLabel` is — the component computed it from `Date.now()` at render
	 *  time, so SSR and hydration disagreed on every row. */
	agoLabel: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// Checked here, not just in +layout.server.ts — layout and page loads run
	// concurrently, so an unauthenticated request still reaches this function.
	// One check covers both cases: a missing session and a signed-in non-admin
	// both get the same bare 302, per the constitution's Principle I.
	if (!locals.session?.isAdmin) redirect(302, '/');

	const settings = await loadSettings(db);
	// Deduplicated, not just sorted — the channel map lists a chapter once per
	// channel. Mapping the rows directly put a duplicate key in the picker's
	// `{#each}` and took the whole page's hydration down with it. See
	// chaptersFromChannelMap.
	const chapters = chaptersFromChannelMap(settings.chapterChannelMap);

	// Validated against the chapter list rather than trusted from the query
	// string, the same way /turfs does it: an unknown id falls back to "every
	// chapter" instead of erroring, because a mistyped URL should show a page.
	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;
	const period = parsePeriod(url.searchParams.get('days'));

	// One `now` for both queries, so the counts and the list describe the same
	// window even if a claim lands between them. Named rather than inlined into
	// rangeFor because the per-event "ago" labels below measure against it too,
	// and a second `new Date()` would let the window and the labels disagree.
	const now = new Date();
	const range = rangeFor(period, now);
	const query = { chapterId: chapter?.chapterId ?? null, range };

	const [counts, rows, anyTurf] = await Promise.all([
		loadActivityCounts(db, query),
		loadActivityRows(db, { ...query, limit: EVENT_CAP }),
		hasAnyTurf(db),
	]);

	// The rows are already the newest EVENT_CAP rows, and each yields at least
	// one event, so slicing here can only trim events the page was never going
	// to show — see loadActivityRows for why fetching more would not help.
	const events: ActivityEventView[] = activityEvents(rows, range)
		.slice(0, EVENT_CAP)
		.map((event) => ({
			...event,
			dayKey: campaignDayKey(event.at),
			timeLabel: campaignTimeLabel(event.at),
			agoLabel: relativeSince(event.at, now),
		}));

	// Day headings come from the events themselves, so a day with no activity
	// simply does not appear.
	const dayLabels: Record<string, string> = {};
	for (const event of events) {
		if (!dayLabels[event.dayKey]) dayLabels[event.dayKey] = campaignDayLabel(event.at);
	}

	return {
		pageTitle: 'Turf activity',
		chapters,
		chapter,
		period,
		events,
		dayLabels,
		counts,
		// The exact total across the period, counted in SQL — so "showing N of M"
		// stays honest even though the list is capped. Both halves describe the
		// same set, which is why it is phrased that way rather than as "M more".
		total: totalEvents(counts),
		shown: events.length,
		anyTurf,
	};
};
