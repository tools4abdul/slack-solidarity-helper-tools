// When a turf's MiniVAN list number is about to stop working.
//
// VAN expires a printed list 30 days after it is generated (docs.everyaction.com
// "Printed Lists — Overview"). After that the number a volunteer types into
// MiniVAN loads nothing, but the turf still looks claimable here — the catalog
// has no way to see the expiry, only the creation date. And this app cannot make
// a new list: the API has no endpoint for it, so an organizer has to generate
// one in VAN's Turf Manager. This module decides which turfs to warn about early
// enough for that to happen.
//
// Pure — no DB, no Slack, no clock of its own. list-expiry-alert-store.ts does
// the rows and the posting.

import { campaignDayLabel, campaignWallClockToUtc } from '../campaign-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long VAN keeps a printed list alive after it is generated. */
export const PRINTED_LIST_LIFETIME_DAYS = 30;

/** How far ahead of expiry the turf channel is warned. */
export const LIST_EXPIRY_WARNING_DAYS = 5;

/** Rows shown per message before the rest collapse to a count. */
export const LIST_EXPIRY_ALERT_MAX_ROWS = 15;

/** One live turf, as this module needs to see it. */
export interface ListExpiryTurf {
	mapRouteId: number;
	name: string;
	regionName: string;
	chapterName: string;
	printedListNumber: string | null;
	printedListCreatedAt: string | null;
	/** The creation date the channel was last warned about, if any. */
	listExpiryWarnedFor: string | null;
	retiredAt: string | null;
}

export interface ListExpiryAlert {
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterName: string;
	/** The value to stamp into `listExpiryWarnedFor` once the post lands. */
	createdAt: string;
	expiresAt: string;
	/** Whole days until expiry, rounded down; zero or less once expired. */
	daysLeft: number;
	/** Someone holds this turf right now, so its number is already in a hand. */
	held: boolean;
}

/** When a list generated at `createdAt` expires, or null when the date won't
 *  parse — which is "can't tell", never "expires now". */
export function listExpiresAt(createdAt: string): Date | null {
	const ms = Date.parse(createdAt);
	if (Number.isNaN(ms)) return null;
	return new Date(ms + PRINTED_LIST_LIFETIME_DAYS * DAY_MS);
}

/**
 * Whether the channel was already warned about the list created at `createdAt`.
 *
 * Normally an exact match on the stamp. The second test is for stamps written
 * before the catalog converted VAN's timestamps to UTC (catalog.ts,
 * vanTimestamp): those hold VAN's raw local-time string, and the same list now
 * arrives as a different string for the same instant. Without this, every list
 * already warned about would be warned about again on the first sync after the
 * change.
 */
function alreadyWarned(warnedFor: string | null, createdAt: string): boolean {
	if (!warnedFor) return false;
	if (warnedFor === createdAt) return true;
	const legacy = campaignWallClockToUtc(warnedFor);
	return legacy !== null && legacy.getTime() === Date.parse(createdAt);
}

/**
 * Turfs to warn about on this run.
 *
 * Inside the warning window and not yet announced for THIS list. Lists already
 * past expiry are included when nobody was told — a list first seen on day 31
 * is more urgent than one on day 26, not less. Retired turf is skipped: VAN no
 * longer has the route, and its claims are released by the catalog sync anyway.
 */
export function listExpiryAlerts(
	turfs: readonly ListExpiryTurf[],
	heldRouteIds: ReadonlySet<number>,
	now: Date,
	warningDays: number = LIST_EXPIRY_WARNING_DAYS,
): ListExpiryAlert[] {
	const alerts: ListExpiryAlert[] = [];
	for (const turf of turfs) {
		if (turf.retiredAt || !turf.printedListNumber || !turf.printedListCreatedAt) continue;
		if (alreadyWarned(turf.listExpiryWarnedFor, turf.printedListCreatedAt)) continue;
		const expiresAt = listExpiresAt(turf.printedListCreatedAt);
		if (!expiresAt) continue;
		const msLeft = expiresAt.getTime() - now.getTime();
		if (msLeft > warningDays * DAY_MS) continue;
		alerts.push({
			mapRouteId: turf.mapRouteId,
			turfName: turf.name,
			regionName: turf.regionName,
			chapterName: turf.chapterName,
			createdAt: turf.printedListCreatedAt,
			expiresAt: expiresAt.toISOString(),
			daysLeft: Math.floor(msLeft / DAY_MS),
			held: heldRouteIds.has(turf.mapRouteId),
		});
	}
	// Soonest first, so the rows that survive the cap are the urgent ones.
	return alerts.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

function whenLabel(alert: ListExpiryAlert, now: Date): string {
	const day = campaignDayLabel(alert.expiresAt);
	if (Date.parse(alert.expiresAt) <= now.getTime()) return `*expired* ${day}`;
	if (alert.daysLeft < 1) return `expires *today* (${day})`;
	return `expires ${day} (${alert.daysLeft} day${alert.daysLeft === 1 ? '' : 's'})`;
}

function renderRow(alert: ListExpiryAlert, now: Date): string {
	const where = alert.regionName || alert.chapterName;
	const held = alert.held ? ' · :bust_in_silhouette: someone holds it' : '';
	return `• *${alert.turfName}* — ${where} · ${whenLabel(alert, now)}${held}`;
}

/**
 * The channel message, as Slack mrkdwn. Null for an empty list, so a caller
 * cannot post a header with nothing under it.
 *
 * Never includes the list number: this goes to a channel, and the number is the
 * credential that loads a turf's doors in MiniVAN.
 */
export function renderListExpiryAlert(
	alerts: readonly ListExpiryAlert[],
	now: Date,
	appUrl: string,
	maxRows: number = LIST_EXPIRY_ALERT_MAX_ROWS,
): string | null {
	if (alerts.length === 0) return null;
	const n = alerts.length;
	const lines = [
		`:hourglass_flowing_sand: *MiniVAN list numbers expiring — ${n} turf${n === 1 ? '' : 's'}.*`,
		`_VAN expires a printed list ${PRINTED_LIST_LIFETIME_DAYS} days after it is generated, and ` +
			'this app cannot make a new one. Print a new list for the turf in VAN’s Turf Manager — ' +
			'nothing needs exporting, volunteers load it by typing the number into MiniVAN. The next ' +
			'sync picks up the new number and DMs it to anyone holding the turf._',
		'',
	];
	for (const alert of alerts.slice(0, maxRows)) lines.push(renderRow(alert, now));
	if (n > maxRows) lines.push(`• _… +${n - maxRows} more_`);
	lines.push('', `<${appUrl}/turfs/organizer|Open the organizer view>`);
	return lines.join('\n');
}
