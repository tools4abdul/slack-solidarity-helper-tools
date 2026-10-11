import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
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
import { loadGeometryProgress } from '$lib/server/van/geometry-progress-store.js';
import { geometryProgressLabel } from '$lib/van/geometry-progress.js';
import { driftReport } from '$lib/van/turf-drift.js';
import { campaignDayLabel, campaignTimeLabel } from '$lib/campaign-time.js';
import { relativeSince } from '$lib/components/settings/format-relative.js';
import { campaignFilter, campaignRefreshSwitches } from '$lib/server/van/campaigns.js';
import { loadHolderAccounts } from '$lib/server/outside-volunteers.js';
import type { HolderAccount } from '$lib/holder-account.js';
import { INTERNAL_CRON_SECRET, PORT } from '$lib/server/env.js';
import { localCaller } from '$lib/server/scheduler.js';
import {
	loadHiddenTurfs,
	setTurfHidden,
	type HiddenTurfRow,
} from '$lib/server/van/turf-hide-store.js';
import {
	lastVanSyncs,
	startManualVanSync,
	type CampaignLastSync,
} from '$lib/server/van/manual-sync.js';

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
	/** The Slack, Google or Apple mark beside the holder, and an outside holder's email
	 *  so an organizer can reach someone who is not in the Slack. */
	account: HolderAccount | null;
	/** Campaign-local "until" stamp, formatted server-side so two organizers
	 *  comparing notes see the same time — and so SSR and hydration agree. */
	expiresLabel: string;
	/** "3h ago", against this load's `now`. Server-side for the same reason
	 *  `expiresLabel` is: the component used to compute this from `Date.now()`
	 *  while rendering, which disagreed with SSR on every row. */
	claimedAgoLabel: string;
}

export interface SuspectView extends SuspectCompletion {
	/** See HoldingView.account. */
	account: HolderAccount | null;
	completedLabel: string;
	/** "2 days ago", against this load's `now`. See HoldingView.claimedAgoLabel. */
	completedAgoLabel: string;
}

export interface HiddenTurfView extends HiddenTurfRow {
	/** "2 days ago", against this load's `now`. See HoldingView.claimedAgoLabel. */
	hiddenAgoLabel: string;
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
	const chapters = chaptersFromChannelMap(settings.chapterChannelMap, settings.turfCustomChapters);

	// Validated against the chapter list rather than trusted from the query
	// string, as the activity page does it: an unknown id falls back to "every
	// chapter" instead of erroring, because a mistyped URL should show a page.
	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;
	// The same for the campaign: every one unless a known one is picked.
	const campaigns = await campaignFilter(db, url.searchParams.get('campaign'));
	const query = {
		chapterId: chapter?.chapterId ?? null,
		campaignId: campaigns.campaign?.id ?? null,
	};

	// One `now` for both halves, so the board and the summary above it describe
	// the same instant even if a claim lands between the queries.
	const now = new Date();

	const [
		holdingRows,
		completionRows,
		driftTurfs,
		driftClaims,
		driftVisibility,
		geometry,
		lastSyncs,
		hiddenRows,
	] = await Promise.all([
		loadCurrentHoldings(db, query),
		loadRecentCompletions(db, { ...query, limit: COMPLETION_LOOKBACK }),
		loadDriftTurfs(db, query),
		loadDriftClaims(db, query),
		loadDriftVisibility(db, query.campaignId),
		// Campaign-wide rather than per chapter: the queue is drained in one
		// pass for everyone, so scoping it to the selected chapter would
		// report a different denominator than the work actually left.
		loadGeometryProgress(db),
		lastVanSyncs(db),
		loadHiddenTurfs(db, query),
	]);

	// Story 8.2. Both sides of the comparison are our own columns — the sync
	// lands VAN's half — so this costs two reads and no VAN call.
	const drift = driftReport(driftTurfs, driftClaims, now, driftVisibility);

	const current = currentHoldings(holdingRows, now);
	const suspected = suspectCompletions(completionRows);
	// Every holder this page names, in one read.
	const accounts = await loadHolderAccounts(db, [
		...current.map((h) => h.slackUserId),
		...suspected.map((c) => c.slackUserId),
		...drift.items.map((i) => i.heldByUserId),
	]);

	const holdings: HoldingView[] = current.map((h) => ({
		...h,
		account: accounts.get(h.slackUserId) ?? null,
		expiresLabel: `${campaignDayLabel(h.expiresAt)} at ${campaignTimeLabel(h.expiresAt)}`,
		claimedAgoLabel: relativeSince(h.claimedAt, now),
	}));

	const suspects: SuspectView[] = suspected.map((c) => ({
		...c,
		account: accounts.get(c.slackUserId) ?? null,
		completedLabel: `${campaignDayLabel(c.completedAt)} at ${campaignTimeLabel(c.completedAt)}`,
		completedAgoLabel: relativeSince(c.completedAt, now),
	}));

	const hidden: HiddenTurfView[] = hiddenRows.map((t) => ({
		...t,
		hiddenAgoLabel: relativeSince(t.hiddenAt, now),
	}));

	return {
		pageTitle: 'Turf right now',
		drift: {
			...drift,
			items: drift.items.map((item) => ({
				...item,
				account: accounts.get(item.heldByUserId) ?? null,
			})),
		},
		chapters,
		chapter,
		campaigns: campaigns.campaigns,
		campaign: campaigns.campaign,
		// Badge text per campaign id, for rows whose campaign shows one.
		campaignBadges: campaigns.badges,
		holdings,
		summary: summarise(holdings),
		suspects,
		// Turf an admin hid from volunteers on its /turfs card, to show again.
		hidden,
		// Why the map is part shapes and part pins after a big sync — the line is
		// only shown while there is something to explain (see the page).
		geometry: {
			...geometry,
			label: geometryProgressLabel(geometry),
		},
		// Distinguishes "every completion checked out fine" from "no completion
		// has been checked yet" — opposite messages that must not share an empty
		// state. It stays false until a re-cut lands after a completion (see
		// door-delta-store.ts) — so the empty state has to keep saying "not
		// checked" rather than "all clear".
		deltaChecked: anyDeltaMeasured(completionRows),
		// What sets that re-cut off, so the empty state can say what it is
		// waiting on: the sync asking VAN, or an organizer doing it by hand. Each
		// campaign has its own switch, so the page names which is which.
		regionRefresh: await campaignRefreshSwitches(db),
		completionsExamined: completionRows.length,
		// Beside the "Sync VAN now" button: how stale the catalog is, so an
		// organizer can tell whether the turf they just cut has landed yet.
		lastVanSync: lastSyncSummary(lastSyncs, now),
	};
};

/**
 * One label while every enabled campaign reads the same ("3m ago"), or one
 * per campaign once they differ or any last sync failed — a campaign whose
 * syncs keep failing must not hide behind another's "just now", and an
 * organizer told their turf is on its way should see when it is not coming.
 * Compared as shown, not as timestamps, so two syncs seconds apart still read
 * as one line. Null labels mean "not synced yet".
 */
function lastSyncSummary(
	syncs: CampaignLastSync[],
	now: Date,
): {
	label: string | null;
	perCampaign: { id: number; name: string; label: string | null; failed: boolean }[] | null;
} {
	const labelled = syncs.map((s) => ({
		id: s.id,
		name: s.name,
		label: s.lastSyncAt ? relativeSince(s.lastSyncAt, now) : null,
		failed: s.failed,
	}));
	const labels = new Set(labelled.map((s) => s.label));
	if (labels.size <= 1 && !labelled.some((s) => s.failed))
		return { label: labelled[0]?.label ?? null, perCampaign: null };
	return { label: null, perCampaign: labelled };
}

export const actions: Actions = {
	/**
	 * Show hidden turf to volunteers again — the organizer-page side of the
	 * "Hide from volunteers" box on a /turfs card.
	 */
	unhide: async ({ locals, request }) => {
		const session = locals.session;
		if (!session?.isAdmin) return fail(403, { unhideError: 'Organizers only.' });
		const turfId = Number((await request.formData()).get('turfId'));
		if (!Number.isInteger(turfId)) return fail(400, { unhideError: 'Unknown turf.' });
		try {
			const found = await setTurfHidden(
				db,
				turfId,
				false,
				{ id: session.slackUserId, name: session.slackUserName },
				new Date(),
			);
			// Gone since the page loaded — the board reloads without it.
			if (!found) return fail(404, { unhideError: 'That turf no longer exists.' });
		} catch (err) {
			console.error('[van] could not unhide turf:', err);
			return fail(500, { unhideError: 'Could not show that turf again. Please try again.' });
		}
		return { unhidden: turfId };
	},

	/**
	 * Run the VAN sync now rather than at the next slot — for turf an organizer
	 * has just cut to answer a request. Started, not awaited: a pass takes
	 * minutes. See van/manual-sync.ts.
	 */
	syncVan: async ({ locals }) => {
		if (!locals.session?.isAdmin) return fail(403, { syncError: 'Organizers only.' });
		if (!INTERNAL_CRON_SECRET) {
			console.error('[van] manual sync: INTERNAL_CRON_SECRET is not set');
			return fail(500, { syncError: 'The sync is not configured on this server.' });
		}
		let result: Awaited<ReturnType<typeof startManualVanSync>>;
		try {
			result = await startManualVanSync(db, localCaller(PORT, INTERNAL_CRON_SECRET));
		} catch (err) {
			// A failure here is the lock's database read, before anything ran.
			// Answered on the form, so the board stays up around it.
			console.error('[van] manual sync: could not start:', err);
			return fail(500, { syncError: 'Could not start the sync. Please try again.' });
		}
		if (result.status === 'busy') {
			return fail(409, {
				syncError:
					"Someone already started a sync and it's still running. Try again in a few minutes.",
			});
		}
		return result.status === 'queued' ? { syncQueued: true } : { syncStarted: true };
	},
};
