// Finding the drift worth announcing, posting it, and remembering.
//
// The rules live in $lib/van/drift-alert.ts and are pure; this is the part that
// touches rows and Slack. Called from /api/internal/van-sync, immediately after
// the catalog sync — which matters more here than for the expiry warning, and for
// a reason specific to this signal: `van_distributed_to` is VAN's half of the
// comparison and the catalog sync is what writes it. Alerting before the sync
// would announce drift computed against the previous run's view of VAN, which is
// exactly the window in which an organizer's bulk export lands.
//
// One message per run, not one per row. Drift arrives in batches — an organizer
// cuts a region and forgets to export the whole thing — and twelve separate posts
// about one mistake buries the channel it is trying to inform.
//
// Never throws. The sync's rows are already written by the time this runs, and a
// Slack outage must not turn a good sync into a failed workflow run.

import { inArray, isNotNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfs } from '../schema.js';
import { chunked } from './sql-chunk.js';
import { postAlert } from '../slack.js';
import { errMessage } from '../../err-message.js';
import { driftReport, type DriftKind } from '../../van/turf-drift.js';
import {
	newDriftAlerts,
	renderDriftAlert,
	staleDriftStamps,
	type AlertableDrift,
} from '../../van/drift-alert.js';
import { loadDriftClaims, loadDriftTurfs, loadDriftVisibility } from './drift-store.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface DriftAlertResult {
	/** Rows named in a message Slack accepted. */
	announced: number;
	/** Stamps cleared because the turf stopped drifting. */
	cleared: number;
	/** True when the alert was composed but Slack rejected it, so the same rows
	 *  are announced again on the next run. */
	failed: boolean;
	/** Why nothing was posted, when nothing was. Distinguishes "checked, all
	 *  agreed" from "could not check" — the same trap `DriftVisibility` exists for
	 *  one layer down. */
	skipped?: 'van-side-unavailable' | 'no-channel' | 'nothing-new';
}

function isDriftKind(value: string | null): value is DriftKind {
	return value === 'claimed-not-in-minivan' || value === 'in-minivan-not-claimed';
}

interface Stamps {
	/** What the channel was last told, for stamps we can interpret. */
	kinds: Map<number, DriftKind>;
	/** Every stamped route, interpretable or not — the set the stale sweep clears
	 *  from. Wider than `kinds` on purpose, so a junk value on turf that has
	 *  stopped drifting is cleaned up rather than left behind forever. */
	routeIds: number[];
}

/**
 * What the channel was last told about each turf.
 *
 * One query serves both halves of the job. Read off `van_turfs` rather than
 * joined into `loadDriftTurfs`, so the drift report's own query stays the shape
 * the organizer page needs.
 *
 * A stamp with an unrecognised kind — a value written by an older version, or by
 * hand — is kept out of `kinds` rather than trusted. It then reads as "never
 * announced", so the worst case is one duplicate message rather than a route that
 * can never be announced again.
 */
async function loadStamps(db: Db): Promise<Stamps> {
	const rows = await db
		.select({ mapRouteId: vanTurfs.mapRouteId, kind: vanTurfs.driftAlertedKind })
		.from(vanTurfs)
		.where(isNotNull(vanTurfs.driftAlertedKind));
	const kinds = new Map<number, DriftKind>();
	for (const row of rows) {
		if (isDriftKind(row.kind)) kinds.set(row.mapRouteId, row.kind);
	}
	return { kinds, routeIds: rows.map((r) => r.mapRouteId) };
}

/** Stamp the routes named in a message that landed. */
async function markAlerted(
	db: Db,
	routeIds: readonly number[],
	kind: DriftKind,
	at: string,
): Promise<void> {
	for (const batch of chunked([...routeIds])) {
		await db
			.update(vanTurfs)
			.set({ driftAlertedAt: at, driftAlertedKind: kind })
			.where(inArray(vanTurfs.mapRouteId, batch));
	}
}

/** Drop stamps for turf that no longer drifts. */
async function clearStamps(db: Db, routeIds: readonly number[]): Promise<void> {
	for (const batch of chunked([...routeIds])) {
		await db
			.update(vanTurfs)
			.set({ driftAlertedAt: null, driftAlertedKind: null })
			.where(inArray(vanTurfs.mapRouteId, batch));
	}
}

/**
 * Announce new drift in the turf channel.
 *
 * Every chapter, not one: the channel is campaign-wide (`slackTurfChannelId`), and
 * a per-chapter scope would need a per-chapter channel to post into. Each row
 * names its region, so an organizer can still tell whose problem it is.
 *
 * The order of the two writes is deliberate. Stamps are cleared FIRST, before the
 * post, because clearing is correct whether or not Slack answers — a turf that
 * stopped drifting stopped drifting, and the clear is what makes a later
 * recurrence audible. The new stamps are written only after Slack accepts, so an
 * outage retries rather than silently burning the one message about two people on
 * one doorstep.
 */
export async function sendDriftAlerts(
	db: Db,
	input: { now: Date; channelId: string; appUrl: string },
): Promise<DriftAlertResult> {
	const { now, channelId, appUrl } = input;
	const empty: DriftAlertResult = { announced: 0, cleared: 0, failed: false };

	// Checked before the reads rather than after: with no channel configured there
	// is nothing this function can do, and stamping rows for a message nobody
	// received would leave that drift permanently silent once a channel IS set.
	if (!channelId) return { ...empty, skipped: 'no-channel' };

	let items: AlertableDrift[];
	let stampedRouteIds: number[];
	try {
		const query = { chapterId: null };
		const [turfs, claims, visibility, stamps] = await Promise.all([
			loadDriftTurfs(db, query),
			loadDriftClaims(db, query),
			loadDriftVisibility(db),
			loadStamps(db),
		]);

		// An empty report would post nothing anyway — but returning here keeps the
		// stale sweep from running too. On a key that cannot read /minivanExports
		// every stamp looks stale, and clearing the lot would re-announce all of it
		// the day the tier is granted.
		if (visibility === 'van-side-unavailable') {
			return { ...empty, skipped: 'van-side-unavailable' };
		}

		items = driftReport(turfs, claims, now, visibility).items.map((item) => ({
			...item,
			alertedKind: stamps.kinds.get(item.mapRouteId) ?? null,
		}));
		stampedRouteIds = stamps.routeIds;
	} catch (err) {
		console.error(`${LOG} could not read drift-alert candidates:`, errMessage(err));
		return empty;
	}

	let cleared = 0;
	const stale = staleDriftStamps(stampedRouteIds, items);
	if (stale.length > 0) {
		try {
			await clearStamps(db, stale);
			cleared = stale.length;
		} catch (err) {
			// Not fatal: the stamps stay, so a recurrence on those routes goes
			// unannounced until a later run clears them. Logged because that is a
			// missing alert rather than a cosmetic problem.
			console.error(
				`${LOG} could not clear ${stale.length} stale drift stamp(s):`,
				errMessage(err),
			);
		}
	}

	const fresh = newDriftAlerts(items);
	const text = renderDriftAlert(fresh, appUrl);
	if (text === null) {
		if (cleared > 0) console.log(`${LOG} drift alerts: cleared=${cleared}`);
		return { announced: 0, cleared, failed: false, skipped: 'nothing-new' };
	}

	if (!(await postAlert(channelId, text, LOG))) {
		console.warn(`${LOG} drift alert not posted; ${fresh.length} row(s) will retry next run`);
		return { announced: 0, cleared, failed: true };
	}

	try {
		// Grouped by kind because that is what the stamp records: two updates at
		// most, rather than one per route.
		const byKind = new Map<DriftKind, number[]>();
		for (const item of fresh) {
			const list = byKind.get(item.kind);
			if (list) list.push(item.mapRouteId);
			else byKind.set(item.kind, [item.mapRouteId]);
		}
		const at = now.toISOString();
		for (const [kind, routeIds] of byKind) await markAlerted(db, routeIds, kind, at);
	} catch (err) {
		// The message landed but the stamps did not, so the next run repeats it.
		// Logged loudly because a duplicated alert is the visible symptom and this
		// is its only cause.
		console.error(`${LOG} drift alert posted but not stamped:`, errMessage(err));
	}

	console.log(`${LOG} drift alerts: announced=${fresh.length} cleared=${cleared}`);
	return { announced: fresh.length, cleared, failed: false };
}
