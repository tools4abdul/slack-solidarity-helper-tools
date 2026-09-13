// Turning the checkout ledger into a readable history.
//
// Pure — no DB, no clock of its own, no Slack. Everything the organizer page
// shows is decided here, so the rules are testable without a fixture database
// and the page is left with markup.
//
// The one idea worth stating up front: **an event is a column transition, not a
// row.** `van_turf_checkouts` is append-only and stamps `claimedAt`, then one of
// `releasedAt` / `completedAt`. So a single row that was claimed at 09:10 and
// completed at 09:30 is TWO things that happened, and a history that showed it
// once would be answering a different question from the one asked. Expanding a
// row into its events is a fan-out, which is why it lives in a function with
// tests rather than inline in a `{#each}`.
//
// `releaseReason` is the discriminator for how a claim ended, and the labels
// keep its distinctions rather than flattening them. A release the volunteer
// chose, a claim that lapsed, and a claim cut short by an admin block are three
// different facts about three different people, and an organizer chasing a
// flaky volunteer should not be chasing the nightly sweep.

/** How a turf checkout changed. */
export type ActivityKind =
	'claimed' | 'completed' | 'given-back' | 'expired' | 'blocked' | 'retired' | 'walked-out';

/** The joined `van_turf_checkouts` + `van_turfs` columns this module reads.
 *  Narrow on purpose: neither table's row type can widen what the page shows
 *  without a change here, and the MiniVAN list number is deliberately absent —
 *  it is the holder's credential, and an admin is not the holder. */
export interface ActivityRow {
	checkoutId: number;
	mapRouteId: number;
	/** Turf name from van_turfs. */
	name: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	slackUserId: string;
	slackUserName: string;
	claimedAt: string;
	releasedAt: string | null;
	completedAt: string | null;
	releaseReason: string | null;
	/** Doors that left the turf between claim and the post-completion refresh.
	 *  Null until Story 5.6 fills it in; rendered only when present. */
	confirmedDoorDelta: number | null;
}

export interface ActivityEvent {
	/** Stable within a render: one checkout row can produce several events, so
	 *  the row id alone is not a key. */
	id: string;
	kind: ActivityKind;
	at: string;
	checkoutId: number;
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	slackUserId: string;
	slackUserName: string;
	confirmedDoorDelta: number | null;
}

/**
 * Events per page load.
 *
 * A history is for reading, not for exporting: past a few hundred rows nobody
 * scrolls, and the honest move is to say how many were left out and let the
 * period filter do the narrowing. Also bounds the payload — the same concern
 * measured for the turf map in plan.md 6.2b, at a much smaller scale.
 */
export const EVENT_CAP = 500;

export type Period = '1' | '7' | '30' | 'all';

export const DEFAULT_PERIOD: Period = '7';

export const PERIOD_OPTIONS: readonly { value: Period; label: string }[] = [
	{ value: '1', label: 'Last 24 hours' },
	{ value: '7', label: 'Last 7 days' },
	{ value: '30', label: 'Last 30 days' },
	{ value: 'all', label: 'All time' },
];

/** Read `?days=`. Anything unrecognised falls back to the default rather than
 *  erroring — a mistyped query string should show a page, not a 400. */
export function parsePeriod(raw: string | null | undefined): Period {
	const value = (raw ?? '').trim();
	return PERIOD_OPTIONS.some((o) => o.value === value) ? (value as Period) : DEFAULT_PERIOD;
}

export interface ActivityRange {
	/** ISO lower bound, or null for "all time". */
	start: string | null;
	/** ISO upper bound. Captured by the caller so the two queries that make up a
	 *  page agree on where "now" was. */
	end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function rangeFor(period: Period, now: Date): ActivityRange {
	const end = now.toISOString();
	if (period === 'all') return { start: null, end };
	return { start: new Date(now.getTime() - Number(period) * DAY_MS).toISOString(), end };
}

/** Whether an ISO timestamp falls in the range. Half-open at the top so an
 *  event exactly at `end` belongs to the next window rather than being counted
 *  twice by two adjacent page loads. */
function inRange(iso: string | null, range: ActivityRange): iso is string {
	if (!iso) return false;
	if (range.start !== null && iso < range.start) return false;
	return iso < range.end;
}

/** How a claim that ended in `releaseReason` should be labelled. `null` is the
 *  completion path, which stamps `completedAt` and no reason at all. */
function endKind(releaseReason: string | null): ActivityKind {
	switch (releaseReason) {
		case 'expired':
			return 'expired';
		case 'blocked':
			return 'blocked';
		case 'retired':
			return 'retired';
		// Story 4.5's reconciliation: VAN refreshed the region and the turf came
		// back with no doors in it, so the app checked it back in. Kept apart
		// from 'given-back' for the reason in this file's header — the volunteer
		// did not hand it back, and an organizer reading the history should not
		// see them as having dropped it.
		case 'walked-out':
			return 'walked-out';
		// 'volunteer', 'admin', and anything a later migration adds read as a
		// deliberate hand-back rather than throwing: an unknown reason should
		// still appear in the history, since a missing row is the one outcome
		// an audit trail cannot afford.
		default:
			return 'given-back';
	}
}

/**
 * Expand ledger rows into the events that fall inside `range`, newest first.
 *
 * A row contributes its claim, its completion, and its release independently —
 * each only if that stamp is inside the window. A turf claimed last week and
 * completed today shows once in a one-day range and twice in a monthly one,
 * which is the correct answer to both questions.
 */
export function activityEvents(
	rows: readonly ActivityRow[],
	range: ActivityRange,
): ActivityEvent[] {
	const events: ActivityEvent[] = [];

	for (const row of rows) {
		const base = {
			checkoutId: row.checkoutId,
			mapRouteId: row.mapRouteId,
			turfName: row.name,
			regionName: row.regionName,
			chapterId: row.chapterId,
			chapterName: row.chapterName,
			doorCount: row.doorCount,
			slackUserId: row.slackUserId,
			slackUserName: row.slackUserName,
			confirmedDoorDelta: row.confirmedDoorDelta,
		};

		if (inRange(row.claimedAt, range)) {
			events.push({ ...base, id: `${row.checkoutId}:claimed`, kind: 'claimed', at: row.claimedAt });
		}
		if (inRange(row.completedAt, range)) {
			events.push({
				...base,
				id: `${row.checkoutId}:completed`,
				kind: 'completed',
				at: row.completedAt,
			});
		}
		if (inRange(row.releasedAt, range)) {
			const kind = endKind(row.releaseReason);
			events.push({ ...base, id: `${row.checkoutId}:${kind}`, kind, at: row.releasedAt });
		}
	}

	// Newest first, with the checkout id as a tiebreak so two events stamped in
	// the same millisecond render in a stable order rather than shuffling
	// between loads.
	events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.checkoutId - a.checkoutId));
	return events;
}

/** Human label for an event. One place decides this, so the list, the summary
 *  counts, and anything added later cannot disagree about what to call a
 *  release nobody chose. */
export function activityLabel(kind: ActivityKind): string {
	switch (kind) {
		case 'claimed':
			return 'Claimed';
		case 'completed':
			return 'Completed';
		case 'given-back':
			return 'Given back';
		case 'expired':
			return 'Expired';
		case 'blocked':
			return 'Released (blocked)';
		case 'retired':
			return 'Released (turf retired)';
		case 'walked-out':
			return 'Released (no doors left)';
	}
}

/** Order the summary reads in: the two that mean work happened, then the ways a
 *  claim ends without it — the one the volunteer chose, then the four nobody
 *  chose. 'walked-out' sits with those last four because the app ended the
 *  claim, even though the outcome is a good one. */
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
	'claimed',
	'completed',
	'given-back',
	'expired',
	'blocked',
	'retired',
	'walked-out',
];

export type ActivityCounts = Record<ActivityKind, number>;

export function emptyCounts(): ActivityCounts {
	return {
		claimed: 0,
		completed: 0,
		'given-back': 0,
		expired: 0,
		blocked: 0,
		retired: 0,
		'walked-out': 0,
	};
}

/** Total events across every kind — the "of M" in the page's "showing N of M". */
export function totalEvents(counts: ActivityCounts): number {
	return ACTIVITY_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

/**
 * Group events into calendar days for rendering.
 *
 * The day key is supplied per event by the caller rather than derived here,
 * because "which day" is a campaign-local question (America/Detroit) and this
 * module has no timezone of its own — deriving it from the ISO string would
 * silently bucket a 9pm knock into tomorrow.
 */
export function groupByDay<T extends { dayKey: string }>(
	events: readonly T[],
): { dayKey: string; events: T[] }[] {
	const groups: { dayKey: string; events: T[] }[] = [];
	for (const event of events) {
		const last = groups[groups.length - 1];
		if (last && last.dayKey === event.dayKey) last.events.push(event);
		else groups.push({ dayKey: event.dayKey, events: [event] });
	}
	return groups;
}
