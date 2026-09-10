// Pushing the drift report into Slack instead of waiting for someone to open it.
//
// `turf-drift.ts` decides what counts as drift. This module decides what is
// worth *saying*, which is a narrower question: the organizer page can afford to
// re-render the same twelve rows every load, and a channel cannot. Two people on
// one doorstep is urgent the first time it is announced and noise the fortieth.
//
// So the unit of idempotency is (turf, kind) — see `needsDriftAlert`. It is a
// pair rather than a plain "already told them" flag because a turf can drift one
// way, get half-fixed, and start drifting the other way: an organizer who
// bulk-exports turf that was claimed here resolves
// `claimed-not-in-minivan` and, if the claim then lapses, creates
// `in-minivan-not-claimed` on the same route. That is genuinely new information
// and the more dangerous of the two directions, so it has to get through.
//
// Pure — no DB, no Slack, no clock of its own. drift-alert-store.ts does the
// rows and the posting.

import { driftAdvice, driftLabel, type DriftItem, type DriftKind } from './turf-drift.js';

/**
 * How many rows of one kind to name before summarising the rest.
 *
 * The first sync after a campaign starts cutting turf can produce a drift row
 * for every route in a folder — a few hundred — and a Slack message that long is
 * both truncated by Slack and useless to the organizer who has to act on it. Ten
 * is enough to see the pattern (one region, one afternoon's cut) and short
 * enough to read on a phone; the count in the header is what conveys scale, and
 * the report itself is one click away for the full list.
 */
export const DRIFT_ALERT_MAX_ROWS = 10;

/** A drift item plus what the channel was last told about this turf. */
export interface AlertableDrift extends DriftItem {
	/** The kind last announced for this route, or null if nothing ever was. */
	alertedKind: DriftKind | null;
}

/**
 * Whether this row says something the channel has not already been told.
 *
 * Deliberately not time-based. A "re-announce after 24h" rule was the obvious
 * alternative and it is wrong for this signal: drift that nobody has fixed is
 * not new information, it is the same information, and a channel that repeats
 * itself daily gets muted — which costs the campaign the FIRST alert about the
 * next real collision. Unresolved drift stays visible on the organizer page,
 * which is the right surface for a standing problem.
 */
export function needsDriftAlert(item: AlertableDrift): boolean {
	return item.alertedKind !== item.kind;
}

/** The rows worth announcing, in the order `driftReport` ranked them. */
export function newDriftAlerts(items: readonly AlertableDrift[]): DriftItem[] {
	return items.filter(needsDriftAlert);
}

/**
 * Stamps that no longer describe anything, given the drift that currently
 * exists.
 *
 * Clearing these is what makes a recurrence audible. Without it, a turf that
 * drifted in March, got fixed, and drifts again in October stays silent forever
 * because its stamp still matches. The stamp means "the channel knows about this
 * ongoing problem", so it has to be dropped the moment the problem stops.
 *
 * Retired turf is included in the sweep for free: `driftReport` skips it, so it
 * simply stops appearing in `items` and its stamp clears on the next run.
 */
export function staleDriftStamps(
	stampedRouteIds: readonly number[],
	items: readonly AlertableDrift[],
): number[] {
	const drifting = new Map<number, DriftKind>();
	for (const item of items) drifting.set(item.mapRouteId, item.kind);
	// A route whose drift changed kind is NOT stale — the alert path rewrites its
	// stamp in the same run, and clearing it here as well would mean two writes
	// racing to describe one route.
	return stampedRouteIds.filter((id) => !drifting.has(id));
}

/** One row, as a bullet. */
function renderRow(item: DriftItem): string {
	const where = item.regionName ? `${item.regionName}` : item.chapterName;
	const doors = `${item.doorCount.toLocaleString('en-US')} doors`;
	const who =
		item.kind === 'in-minivan-not-claimed'
			? `VAN says ${item.distributedTo}`
			: `held by ${item.heldBy}`;
	// Only meaningful on `claimed-not-in-minivan`, where `canClaim` should have
	// made it impossible — so it is an upstream fault worth naming inline rather
	// than a variant of the normal advice.
	const anomaly = item.hasListNumber ? '' : ' · :question: no MiniVAN list number';
	return `• *${item.turfName}* — ${where} · ${doors} · ${who}${anomaly}`;
}

/**
 * The channel message, as Slack mrkdwn.
 *
 * Grouped by kind with `driftLabel`/`driftAdvice` doing the wording, so the
 * organizer page and the alert cannot describe the same row two different ways —
 * the whole value of an alert is that it means what the report means.
 *
 * Returns null for an empty list rather than an empty string, so a caller cannot
 * accidentally post a header with nothing under it.
 */
export function renderDriftAlert(
	items: readonly DriftItem[],
	appUrl: string,
	maxRows: number = DRIFT_ALERT_MAX_ROWS,
): string | null {
	if (items.length === 0) return null;

	const kinds: DriftKind[] = ['in-minivan-not-claimed', 'claimed-not-in-minivan'];
	const lines: string[] = [];
	const n = items.length;

	lines.push(
		`:warning: *Turf drift — ${n} new disagreement${n === 1 ? '' : 's'} between the checkout ` +
			'ledger and VAN.*',
	);

	for (const kind of kinds) {
		const group = items.filter((i) => i.kind === kind);
		if (group.length === 0) continue;
		lines.push('', `*${driftLabel(kind)}* (${group.length})`, `_${driftAdvice(kind)}_`);
		for (const item of group.slice(0, maxRows)) lines.push(renderRow(item));
		if (group.length > maxRows) {
			lines.push(`• _… +${group.length - maxRows} more_`);
		}
	}

	lines.push('', `<${appUrl}/turfs/organizer|Open the drift report>`);
	return lines.join('\n');
}
