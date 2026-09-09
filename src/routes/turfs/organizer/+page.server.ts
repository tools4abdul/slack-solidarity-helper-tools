import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import {
	COMPLETION_LOOKBACK,
	loadCurrentHoldings,
	loadRecentCompletions,
} from '$lib/server/van/holdings-store.js';
import {
	anyDeltaMeasured,
	currentHoldings,
	suspectCompletions,
	summarise,
	type Holding,
	type SuspectCompletion,
} from '$lib/van/turf-holdings.js';
import {
	loadDriftClaims,
	loadDriftTurfs,
	loadDriftVisibility,
} from '$lib/server/van/drift-store.js';
import { driftReport } from '$lib/van/turf-drift.js';
import { campaignDayLabel, campaignTimeLabel } from '$lib/campaign-time.js';
import { relativeSince } from '$lib/components/settings/format-relative.js';

// Who holds what right now, what is about to lapse, and which completions look
// like a missed MiniVAN sync.
//
// The present-tense half of the organizer surface. /turfs/activity answers
// "what happened"; this answers "what is happening", and they are deliberately
// two pages because they are two different questions asked at different times —
// one while planning a follow-up, one while a canvass is running.
//
// Admin-only, on the same terms as the activity page: holder names are
// organizer information, and the whole point here is to name them. The
// volunteer-facing compartment rules (no all-chapters view, no holder names)
// are the other side of that line and deliberately do not apply.
//
// Still withheld, from admins too: the MiniVAN list number. It is the
// credential issued to whoever holds the turf, and holdings-store.ts never
// selects it.

export interface HoldingView extends Holding {
	/** Campaign-local "until" stamp, formatted server-side so two organizers
	 *  comparing notes see the same time — and so SSR and hydration agree. */
	expiresLabel: string;
	/** "3h ago", against this load's `now`. Server-side for the same reason
	 *  `expiresLabel` is: the component used to compute this from `Date.now()`
	 *  while rendering, which disagreed with SSR on every row. */
	claimedAgoLabel: string;
}

export interface SuspectView extends SuspectCompletion {
	completedLabel: string;
	/** "2 days ago", against this load's `now`. See HoldingView.claimedAgoLabel. */
	completedAgoLabel: string;
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
	// string, as the activity page does it: an unknown id falls back to "every
	// chapter" instead of erroring, because a mistyped URL should show a page.
	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;
	const query = { chapterId: chapter?.chapterId ?? null };

	// One `now` for both halves, so the board and the summary above it describe
	// the same instant even if a claim lands between the queries.
	const now = new Date();

	const [holdingRows, completionRows, driftTurfs, driftClaims, driftVisibility] = await Promise.all(
		[
			loadCurrentHoldings(db, query),
			loadRecentCompletions(db, { ...query, limit: COMPLETION_LOOKBACK }),
			loadDriftTurfs(db, query),
			loadDriftClaims(db, query),
			loadDriftVisibility(db),
		],
	);

	const holdings: HoldingView[] = currentHoldings(holdingRows, now).map((h) => ({
		...h,
		expiresLabel: `${campaignDayLabel(h.expiresAt)} at ${campaignTimeLabel(h.expiresAt)}`,
		claimedAgoLabel: relativeSince(h.claimedAt, now),
	}));

	const suspects: SuspectView[] = suspectCompletions(completionRows).map((c) => ({
		...c,
		completedLabel: `${campaignDayLabel(c.completedAt)} at ${campaignTimeLabel(c.completedAt)}`,
		completedAgoLabel: relativeSince(c.completedAt, now),
	}));

	// Story 8.2. Both sides of the comparison are our own columns — the sync
	// lands VAN's half — so this costs two reads and no VAN call.
	const drift = driftReport(driftTurfs, driftClaims, now, driftVisibility);

	return {
		pageTitle: 'Turf right now',
		drift,
		chapters,
		chapter,
		holdings,
		summary: summarise(holdings),
		suspects,
		// Distinguishes "every completion checked out fine" from "no completion
		// has been checked yet" — opposite messages that must not share an empty
		// state. Today it is always false: Story 5.6 fills confirmedDoorDelta and
		// is still blocked on the VAN key.
		deltaChecked: anyDeltaMeasured(completionRows),
		completionsExamined: completionRows.length,
	};
};
