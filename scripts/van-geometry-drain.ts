/**
 * Drain van_geometry_queue in one long run, from the command line.
 *
 * Same worker the scheduled sync uses (`runGeometryQueue`), with the one thing
 * a Fly request cannot give it: time. The endpoint budgets ~3 minutes per run
 * because it runs inside an HTTP request on a machine that auto-stops, so a
 * first catalog sync of a statewide cut — a couple of thousand turfs, one VAN
 * export job each — takes about a day of scheduled runs to render as shapes.
 * This finishes it in one sitting.
 *
 * It takes VAN_SYNC_LOCK, the same lock the endpoint takes. That is the whole
 * safety story: without it a cron run could pick up the same queue rows this is
 * working on and submit a second export job for each.
 *
 * Usage (from project root):
 *   npm run van:drain                      # 30 minutes, 2 at a time
 *   npm run van:drain -- --minutes 60
 *   npm run van:drain -- --concurrency 4   # raise if VAN is keeping up
 *   npm run van:drain -- --max 50          # a taste, then stop
 *
 * Stop it with Ctrl-C: the lock is released, the row being worked stays
 * resumable (it already has its export job id), and nothing is lost.
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE, VAN_EXPORT_JOB_TYPE_ID,
 *   APP_URL, INTERNAL_CRON_SECRET,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createVanClient, type VanDatabaseMode } from '../src/lib/server/van/client.js';
import { runGeometryQueue } from '../src/lib/server/van/geometry-worker.js';
import { VAN_SYNC_LOCK } from '../src/lib/server/van/locks.js';
import { acquireSyncLock, releaseSyncLock } from '../src/lib/server/sync-lock.js';
import { exportCallbackUrl } from '../src/lib/server/van/webhook-token.js';
import { loadGeometryProgress } from '../src/lib/server/van/geometry-progress-store.js';
import { percentShaped } from '../src/lib/van/geometry-progress.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const value = Number(args[i + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

const MINUTES = flag('minutes', 30);
const CONCURRENCY = flag('concurrency', 2);
// `|| null` so `--max` with a junk value means "no cap" rather than "do nothing".
const MAX_ITEMS = args.includes('--max') ? flag('max', 0) || null : null;
/** Work is done in slices so the run reports progress as it goes, rather than
 *  going quiet for half an hour. Each slice is one `runGeometryQueue` call. */
const SLICE_MS = 60 * 1000;

const appName = process.env.VAN_APP_NAME ?? '';
const apiKey = process.env.VAN_API_KEY ?? '';
const rawMode = (process.env.VAN_DATABASE_MODE ?? '').trim();
const exportJobTypeId = Number(process.env.VAN_EXPORT_JOB_TYPE_ID ?? '');
const appUrl = process.env.APP_URL ?? '';
const cronSecret = process.env.INTERNAL_CRON_SECRET ?? '';

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

if (!appName || !apiKey) fail('Missing required env vars: VAN_APP_NAME, VAN_API_KEY');
if (rawMode !== '0' && rawMode !== '1') fail(`VAN_DATABASE_MODE must be 0 or 1, got "${rawMode}".`);
if (!Number.isFinite(exportJobTypeId) || exportJobTypeId <= 0) {
	fail('VAN_EXPORT_JOB_TYPE_ID must be set (5 = VoterCircle on this key).');
}
// VAN requires an HTTPS webhook on POST /exportJobs and rejects the request
// without one, so this is a hard requirement rather than a nicety — even though
// every job here is polled rather than waited for.
if (!appUrl.startsWith('https://')) fail('APP_URL must be an https:// URL for the export webhook.');
if (!cronSecret) fail('INTERNAL_CRON_SECRET must be set — it signs the per-turf webhook token.');

const db = drizzle(createClient(dbConfig));
const client = createVanClient({
	appName,
	apiKey,
	databaseMode: Number(rawMode) as VanDatabaseMode,
});

/** Lock TTL covers the whole run plus a slice, so a cron tick cannot start
 *  while this is working; released in `finally` either way. */
const LOCK_TTL_MS = MINUTES * 60 * 1000 + SLICE_MS;

const totals = {
	attempted: 0,
	hullsStored: 0,
	centroidsOnly: 0,
	noGeometry: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	hullsTooLarge: 0,
};

async function main(): Promise<void> {
	console.log(`\nGeometry drain — ${dbConfig.url}`);
	console.log(`VAN app: ${appName}, mode ${rawMode}, export job type ${exportJobTypeId}`);
	console.log(
		`Budget: ${MINUTES} min · ${CONCURRENCY} at a time${MAX_ITEMS ? ` · max ${MAX_ITEMS} item(s)` : ''}\n`,
	);

	const before = await loadGeometryProgress(db);
	console.log(
		`  Starting at ${percentShaped(before)}% — ${before.shaped} shaped, ${before.pending} queued, ${before.failed} failed\n`,
	);
	if (before.pending === 0) {
		console.log('  Nothing queued. Run npm run van:sync first if turf is missing shapes.\n');
		return;
	}

	const token = await acquireSyncLock(db, VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (!token) {
		console.error(
			'  A sync already holds the lock. Wait for it to finish (the scheduled run\n' +
				'  takes a few minutes) and try again — two drains would submit duplicate\n' +
				'  export jobs for the same turf.',
		);
		process.exit(1);
	}

	// Ctrl-C releases the lock rather than leaving it to expire; whatever row is
	// mid-flight keeps its export job id and resumes on the next run.
	let stopping = false;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		console.log('\n  Stopping after this slice…');
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	const deadline = Date.now() + MINUTES * 60 * 1000;
	try {
		let slice = 0;
		while (!stopping && Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const result = await runGeometryQueue(db, client, {
				exportJobTypeId,
				webhookUrlFor: (mapRouteId) => exportCallbackUrl(appUrl, cronSecret, mapRouteId),
				timeBudgetMs: Math.min(SLICE_MS, remaining),
				concurrency: CONCURRENCY,
				maxItems: MAX_ITEMS,
				// No Slack alert: an operator is watching this run, and the
				// channel does not need a line per dead letter from a backfill.
			});

			totals.attempted += result.attempted;
			totals.hullsStored += result.hullsStored;
			totals.centroidsOnly += result.centroidsOnly;
			totals.noGeometry += result.noGeometry;
			totals.geocodedFromAddress += result.geocodedFromAddress;
			totals.retried += result.retried;
			totals.deadLettered += result.deadLettered;
			totals.hullsTooLarge += result.hullsTooLarge;

			slice += 1;
			const progress = await loadGeometryProgress(db);
			console.log(
				`  [${String(slice).padStart(3)}] +${String(result.hullsStored).padStart(3)} hulls · ` +
					`${percentShaped(progress)}% · ${progress.shaped}/${progress.eligible} shaped · ` +
					`${progress.pending} left${result.deadLettered > 0 ? ` · ${result.deadLettered} dead-lettered` : ''}`,
			);
			for (const line of result.deadLetters) console.log(`        ${line}`);

			// Nothing attempted means the queue is empty — or every row left is
			// one this run already failed, which retrying now will not fix.
			if (result.attempted === 0 || progress.pending === 0) break;
			if (MAX_ITEMS) break;
		}
	} finally {
		await releaseSyncLock(db, VAN_SYNC_LOCK, token);
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	}

	const after = await loadGeometryProgress(db);
	console.log('\nDone');
	console.log(`  turfs attempted     ${totals.attempted}`);
	console.log(`  hulls stored        ${totals.hullsStored}`);
	console.log(`  centroid only       ${totals.centroidsOnly}   (drawn as a pin, by design)`);
	console.log(`  no geometry at all  ${totals.noGeometry}`);
	console.log(`  geocoded by address ${totals.geocodedFromAddress}`);
	console.log(`  retried             ${totals.retried}`);
	console.log(`  dead-lettered       ${totals.deadLettered}`);
	if (totals.hullsTooLarge > 0) {
		console.log(`  implausibly large   ${totals.hullsTooLarge}   (stored, but worth a look)`);
	}
	console.log(
		`\n  Now at ${percentShaped(after)}% — ${after.shaped}/${after.eligible} shaped, ` +
			`${after.pending} queued, ${after.failed} failed.`,
	);
	console.log('  npm run van:geometry shows this any time.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
