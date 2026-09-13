import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, loadVanChapterFolders } from '$lib/server/settings.js';
import { acquireSyncLock, releaseSyncLock } from '$lib/server/sync-lock.js';
import { vanClient, vanExportJobTypeId } from '$lib/server/van-env.js';
import { runCatalogSync } from '$lib/server/van/sync.js';
import { VAN_SYNC_LOCK } from '$lib/server/van/locks.js';
import { runGeometryQueue } from '$lib/server/van/geometry-worker.js';
import { exportCallbackUrl } from '$lib/server/van/webhook-token.js';
import { sweepExpiredClaims } from '$lib/server/van/checkout-store.js';
import { sendExpiryWarnings } from '$lib/server/van/expiry-warning-store.js';
import { sendDriftAlerts } from '$lib/server/van/drift-alert-store.js';
import { runRefreshSweep, settleRefreshes } from '$lib/server/van/refresh.js';
import { reconcileClaims } from '$lib/server/van/reconcile-store.js';
import { stampDoorDeltas } from '$lib/server/van/door-delta-store.js';
import { doorsHealthWarning } from '$lib/server/van/doors-store.js';
import { alertFor } from '$lib/server/slack.js';
import { APP_URL, INTERNAL_CRON_SECRET } from '$lib/server/env.js';

// VAN turf catalog sync, plus the turf ledger's housekeeping. Called on a
// schedule (see .github/workflows/van-catalog-sync.yml) and by hand during
// setup. Auth via ?key=<INTERNAL_CRON_SECRET>, same as every other internal
// endpoint.
//
// Two halves with different dependencies: expiring lapsed claims and sending
// six-hour warnings need only our own ledger, while the catalog half needs a
// VAN key. The first half therefore runs before the key is checked — see the
// comment in the handler.

// The workflow calls this with `curl --max-time 300`, so the whole request —
// catalog plus geometry — has to finish inside five minutes or the run is
// recorded as a failure however much work it actually did. Budget 4m30s and
// split it: the catalog first, because turf nobody can see is worse than turf
// drawn as a pin, then whatever is left goes to geometry.
const REQUEST_BUDGET_MS = 4 * 60 * 1000 + 30 * 1000;
const CATALOG_BUDGET_MS = 3 * 60 * 1000;
// The refresh sweep sends at most a handful of POSTs and each returns
// immediately — VAN does the re-cut afterwards on its own time. It gets its own
// slice ahead of geometry rather than sharing geometry's leftovers: a sweep
// that never runs means door counts that never move, which is the whole point
// of the feature, while a geometry run cut short is a turf drawn as a pin.
const REFRESH_BUDGET_MS = 30 * 1000;
// Below this there is no point starting a turf we cannot finish — the export
// job would be submitted and then abandoned mid-download.
const MIN_GEOMETRY_BUDGET_MS = 20 * 1000;
// Longer than the sync's own time budget, so a run killed mid-flight by Fly
// still frees the lock within a cadence rather than blocking until someone
// notices.
const LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Drain the geometry queue with whatever time the catalog left.
 *
 * Returns null — rather than throwing or reporting zeros — when geometry
 * cannot run at all, so "not configured" stays distinguishable from "ran and
 * found nothing to do". A key without an export job type id still syncs a
 * perfectly good catalog; only the shapes are missing.
 */
async function runGeometry(
	queued: number,
	requestDeadline: number,
): Promise<Awaited<ReturnType<typeof runGeometryQueue>> | null> {
	const exportJobTypeId = vanExportJobTypeId();
	if (exportJobTypeId === null) {
		if (queued > 0) {
			console.warn(
				`[van] ${queued} turf(s) queued for geometry but VAN_EXPORT_JOB_TYPE_ID is unset — ` +
					'they will render as pins until it is configured (5 = VoterCircle on this key)',
			);
		}
		return null;
	}
	const timeBudgetMs = requestDeadline - Date.now();
	if (timeBudgetMs < MIN_GEOMETRY_BUDGET_MS) {
		console.warn('[van] skipping geometry this run — the catalog used the request budget');
		return null;
	}

	const configured = vanClient();
	if (!configured.ok) return null;

	try {
		const { slackTurfChannelId } = await loadSettings(db);
		return await runGeometryQueue(db, configured.client, {
			exportJobTypeId,
			// VAN requires this and posts the finished job to it, so it must be
			// our own host. It carries a per-turf HMAC rather than
			// INTERNAL_CRON_SECRET: VAN stores this string forever and echoes it
			// back on every read of the job, and that secret opens seven other
			// internal endpoints. See webhook-token.ts.
			webhookUrlFor: (mapRouteId) => exportCallbackUrl(APP_URL, INTERNAL_CRON_SECRET, mapRouteId),
			timeBudgetMs,
			alert: alertFor('[van]', slackTurfChannelId),
			// `geocode` deliberately omitted: the worker defaults to the Census
			// batch geocoder, which fires only for rows VAN left without
			// coordinates.
		});
	} catch (err) {
		// Geometry is decoration. A failure here must not fail a sync whose
		// catalog rows are already written and correct.
		console.error('[van] geometry queue failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[van] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const token = await acquireSyncLock(db, VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (!token) {
		// Not an error: overlapping cron attempts are expected (the workflow
		// fires staggered runs), and the second one has nothing to do.
		return json({ skipped: 'another catalog sync is in progress' }, { status: 200 });
	}

	// Stamped before ANY work, housekeeping included. Taking it after the sweep
	// would give the request `REQUEST_BUDGET_MS` on top of however long that took,
	// which is precisely the overrun the budget exists to prevent.
	const requestDeadline = Date.now() + REQUEST_BUDGET_MS;

	try {
		// Ledger housekeeping first, and genuinely independent of VAN — which is
		// why it now runs BEFORE the vanClient() check rather than after it. An
		// expired claim needs stamping and a volunteer needs their six-hour
		// warning whether or not the catalog fetch below succeeds, and while a
		// missing key means no new turf, it does not mean the turf volunteers are
		// already holding stops mattering. Rotate the key badly on a Friday and
		// the old order silently stopped both for the whole weekend.
		//
		// Running here also means both inherit this route's schedule and lock
		// rather than needing a second cron of their own.
		const now = new Date();
		const claimsExpired = await sweepExpiredClaims(db, now);
		if (claimsExpired > 0) console.log(`[van] swept ${claimsExpired} expired claim(s)`);

		// Sweep first, then warn: the sweep releases anything already past its
		// TTL, so nobody is warned about turf that expired moments ago.
		const warnings = await sendExpiryWarnings(db, now);

		// The catalog half needs VAN. Still a 500 so a misconfigured key is
		// visible in the workflow run rather than passing quietly.
		const configured = vanClient();
		if (!configured.ok) {
			return json(
				{
					error: configured.error,
					claimsExpired,
					expiryWarningsSent: warnings.sent,
					expiryWarningsFailed: warnings.failed,
				},
				{ status: 500 },
			);
		}

		const mappings = await loadVanChapterFolders(db);
		const result = await runCatalogSync(db, configured.client, mappings, {
			timeBudgetMs: CATALOG_BUDGET_MS,
		});
		console.log(
			`[van] catalog sync: ${result.turfsUpserted} turfs across ${result.foldersSynced} folder(s), ` +
				`${result.turfsRetired} retired, ${result.geometryQueued} queued for geometry`,
			{ skipped: result.foldersSkipped, degraded: result.degraded },
		);

		// Story 4's confirmation half. The catalog read is the only place VAN's
		// `dateRefreshed` shows up, so a refresh we asked for on an earlier tick
		// is confirmed here, using the read that already happened.
		const refreshesSettled = await settleRefreshes(db, result.regionsRead);

		// Reconciliation, before the drift report and before geometry: it is the
		// half of Story 4.5 that touches volunteers. A re-cut region has just
		// retired somebody's route and released their claim (the catalog did that
		// atomically), and this is what pairs the dead route to its replacement,
		// hands it back, and says so. Drift then reads a settled ledger rather
		// than one mid-repair.
		// One read for both: the reconciliation needs the claim TTL and the drift
		// alert needs the channel, and they run back to back.
		const { vanTurfClaimTtlHours, slackTurfChannelId: turfChannelId } = await loadSettings(db);
		const reconciled = await reconcileClaims(db, {
			now,
			appUrl: APP_URL,
			ttlHours: vanTurfClaimTtlHours,
		});

		// Story 5.6: the sync-back check. After the reconciliation, because that
		// is what releases claims a re-cut invalidated — verifying those as
		// completions would measure a delta against turf that no longer exists.
		const doorDeltas = await stampDoorDeltas(db, { now, appUrl: APP_URL });

		// Story 9.4's health check, and the biggest risk in the canvassing board:
		// every doors number depends on map regions being cut with a "not yet
		// contacted" filter, which nothing in this codebase can enforce. A week of
		// completions that cleared nothing is the only signal we get, and it rides
		// out with the sync's other notices.
		let doorsWarning: string | null = null;
		try {
			doorsWarning = await doorsHealthWarning(db, now);
		} catch (err) {
			console.error('[van] doors health check failed:', err instanceof Error ? err.message : err);
		}

		// Story 8.2's report, pushed instead of pulled. After the catalog because
		// the catalog writes VAN's half of the comparison (`van_distributed_to`),
		// and before geometry because geometry is the half that gets cut short by
		// the time budget — an unannounced collision costs more than a missing hull.
		const drift = await sendDriftAlerts(db, {
			now,
			channelId: turfChannelId,
			appUrl: APP_URL,
		});

		// Ask VAN to re-cut what is due (Story 4.2/4.4). Last of the VAN calls
		// that matter, because its effect lands on a later tick: the POST returns
		// straight away and the new counts arrive with a future catalog read.
		const refresh = await runRefreshSweep(db, configured.client, {
			now,
			timeBudgetMs: Math.min(REFRESH_BUDGET_MS, requestDeadline - Date.now()),
		});

		// Geometry runs after the catalog because the catalog is what fills the
		// queue: a turf cut minutes ago gets its shape on this run rather than
		// the next one. It is also the half that is safe to cut short — an
		// unfinished queue is turf rendered as a pin, and the rows stay
		// resumable, whereas an unfinished catalog is turf nobody can see.
		const geometry = await runGeometry(result.geometryQueued, requestDeadline);

		// Best-effort, exactly as in the door-knock snapshot: a Slack outage
		// must not fail a sync that already wrote its rows.
		// `geometry.warnings` carries advisory notes only. Dead letters are in
		// `geometry.deadLetters`, which runGeometryQueue has already posted through
		// its own `alert` — including them here would put each one in the channel
		// twice.
		const notices = [
			...result.degraded,
			...result.warnings,
			...refresh.warnings,
			...(doorsWarning ? [doorsWarning] : []),
			...(geometry?.warnings ?? []),
		];
		if (notices.length > 0) {
			try {
				const { slackTurfChannelId } = await loadSettings(db);
				await slack.chat.postMessage({
					channel: slackTurfChannelId,
					text: `[van] catalog sync notices:\n${notices.map((n) => `• ${n}`).join('\n')}`,
				});
			} catch (err) {
				console.error(
					'[van] failed to post sync notices to Slack:',
					err instanceof Error ? err.message : err,
				);
			}
		}

		return json({
			...result,
			geometry,
			claimsExpired,
			expiryWarningsSent: warnings.sent,
			expiryWarningsFailed: warnings.failed,
			drift,
			refreshesSettled,
			reconciled,
			doorDeltas,
			doorsWarning,
			refresh,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[van] catalog sync failed:', msg);
		return json({ error: msg }, { status: 500 });
	} finally {
		await releaseSyncLock(db, VAN_SYNC_LOCK, token);
	}
};
