import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { acquireSyncLock, releaseSyncLock } from '$lib/server/sync-lock.js';
import { alertFor } from '$lib/server/slack.js';
import { vanClient, vanExportJobTypeId } from '$lib/server/van-env.js';
import { runGeometryQueue } from '$lib/server/van/geometry-worker.js';
import { VAN_SYNC_LOCK } from '$lib/server/van/locks.js';
import { exportCallbackUrl, verifyWebhookToken } from '$lib/server/van/webhook-token.js';
import { APP_URL, INTERNAL_CRON_SECRET } from '$lib/server/env.js';

// VAN's export-job webhook. `webhookUrl` is REQUIRED on POST /exportJobs (a
// POST without it 400s), so this URL is registered on every geometry job we
// submit and VAN posts the finished job envelope here.
//
// It exists for two reasons beyond tidiness. Fly auto-stops the machine, and an
// inbound request wakes it — so a job that finishes while nothing is running
// gets picked up in seconds rather than waiting up to half an hour for the next
// cron tick. And a job that finishes slowly is left `running` by the worker's
// own budget; without this it would wait for that same tick.
//
// The body is deliberately NOT trusted as the source of the download. It is
// used only as a signal to drain the queue, and the worker then re-reads the
// job through the authenticated API. Anyone holding this URL can therefore
// cause a queue drain and nothing else — no attacker-supplied URL is ever
// fetched, and no attacker-supplied coordinate is ever stored.
//
// Auth is a per-turf HMAC (`?turf=&token=`), NOT `?key=<INTERNAL_CRON_SECRET>`
// as the other internal endpoints use. VAN stores whatever we put here against
// the export job and echoes it back on every read, so putting the shared secret
// in it would hand a third party a credential for the catalog sync, both
// snapshots, the mobilize sync, the invite audit and the growth report. See
// webhook-token.ts.

// Short: this is a wake-up, not a batch window. A drain that needs longer is
// the cron's job. The TTL is per acquisition, so taking VAN_SYNC_LOCK for a
// minute here does not extend the catalog sync's own ten.
const LOCK_TTL_MS = 2 * 60 * 1000;
const BUDGET_MS = 60 * 1000;

export const POST: RequestHandler = async ({ url, request }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[van] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	// The turf whose export job carried this URL. Only used to check the token —
	// the drain that follows covers the whole queue, so a valid token for turf A
	// arriving while turf B is what finished is still a correct wake-up.
	const mapRouteId = Number(url.searchParams.get('turf'));
	const signature = url.searchParams.get('token') ?? '';
	if (!verifyWebhookToken(INTERNAL_CRON_SECRET, mapRouteId, signature)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Logged for correlation only. Never dereferenced — see the note above.
	let exportJobId: unknown = null;
	try {
		const body = (await request.json()) as { exportJobId?: unknown };
		exportJobId = body?.exportJobId ?? null;
	} catch {
		// VAN has posted an empty body before; that is still a valid wake-up.
	}

	const exportJobTypeId = vanExportJobTypeId();
	const configured = vanClient();
	if (exportJobTypeId === null || !configured.ok) {
		// 200, not an error: VAN retries non-2xx, and retrying will not make the
		// server configured. The next cron run reports the misconfiguration.
		console.warn('[van] export callback received but geometry is not configured');
		return json({ skipped: 'geometry not configured' });
	}

	const token = await acquireSyncLock(db, VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (!token) {
		// A drain is already running and will collect this job on its own pass.
		return json({ skipped: 'a geometry drain is already in progress' });
	}

	try {
		const { slackTurfChannelId } = await loadSettings(db);
		const result = await runGeometryQueue(db, configured.client, {
			exportJobTypeId,
			webhookUrlFor: (id) => exportCallbackUrl(APP_URL, INTERNAL_CRON_SECRET, id),
			timeBudgetMs: BUDGET_MS,
			alert: alertFor('[van]', slackTurfChannelId),
		});
		console.log(`[van] export callback (job ${String(exportJobId)}):`, {
			hullsStored: result.hullsStored,
			centroidsOnly: result.centroidsOnly,
			stillRunning: result.stillRunning,
			geocodedFromAddress: result.geocodedFromAddress,
		});
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[van] export callback failed:', message);
		// Still 200 — a retry storm from VAN helps nobody, and the cron will
		// pick the queue up regardless.
		return json({ error: message });
	} finally {
		await releaseSyncLock(db, VAN_SYNC_LOCK, token);
	}
};
