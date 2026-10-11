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
 * It takes the campaign's sync lock, the same lock the endpoint takes. That is the whole
 * safety story: without it a cron run could pick up the same queue rows this is
 * working on and submit a second export job for each. The lock is taken per
 * one-minute slice, not for the whole run: the first roster pass is hours of
 * exports, and holding the lock that long would make every scheduled sync skip
 * — no expired claims swept, no warnings sent. A slice that finds the lock
 * taken waits for the sync to finish and carries on.
 *
 * With VAN_ID_HASH_SECRET set, each export also builds the turf's roster for
 * the uncontacted-door count; `npm run van:sync` first queues every turf that
 * lacks one. Each slice recounts the turfs it rostered in one go at its end,
 * rather than one query per turf. The run then ends by pulling VAN's
 * ContactHistory up to now — even when nothing was queued — which recounts
 * the turfs whose people it saw contacted, so `van:sync` then `van:drain`
 * leaves the doors-left numbers current.
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
 * One campaign per run: `--campaign <key>` (default `primary`) — its key, its
 * queue, its lock (scripts/campaign-arg.ts). Its export job type is the one on
 * its van_campaigns row, or for `primary` VAN_EXPORT_JOB_TYPE_ID as a fallback.
 *
 * Required env vars:
 *   VAN_CAMPAIGN_<KEY>, or for `primary` the legacy VAN_APP_NAME, VAN_API_KEY,
 *   VAN_DATABASE_MODE (and VAN_EXPORT_JOB_TYPE_ID if the row has none);
 *   APP_URL, INTERNAL_CRON_SECRET, VAN_ID_HASH_SECRET (optional: rosters),
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createVanClient } from '../src/lib/server/van/client.js';
import { runGeometryQueue, type GeometryTimings } from '../src/lib/server/van/geometry-worker.js';
import type { VanClientStats } from '../src/lib/server/van/client.js';
import { vanContactLock, vanSyncLock } from '../src/lib/server/van/locks.js';
import { PRIMARY_CAMPAIGN_KEY } from '../src/lib/server/van/campaign-credentials.js';
import {
	campaignCredential,
	campaignExportJobTypeId,
	campaignKeyArg,
	campaignRow,
} from './campaign-arg.js';
import { acquireSyncLock, extendSyncLock, releaseSyncLock } from '../src/lib/server/sync-lock.js';
import { exportCallbackUrl } from '../src/lib/server/van/webhook-token.js';
import { createPersonHasher } from '../src/lib/server/van/person-hash.js';
import {
	contactPullDone,
	recomputeUncontacted,
	rosterProgress,
	runContactSync,
} from '../src/lib/server/van/contact-sync.js';
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

const CAMPAIGN_KEY = campaignKeyArg(args);
const credential = campaignCredential(CAMPAIGN_KEY);
const appUrl = process.env.APP_URL ?? '';
const cronSecret = process.env.INTERNAL_CRON_SECRET ?? '';
const hashSecret = process.env.VAN_ID_HASH_SECRET ?? '';
const roster = hashSecret ? createPersonHasher(hashSecret) : null;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// VAN requires an HTTPS webhook on POST /exportJobs and rejects the request
// without one, so this is a hard requirement rather than a nicety — even though
// every job here is polled rather than waited for.
if (!appUrl.startsWith('https://')) fail('APP_URL must be an https:// URL for the export webhook.');
if (!cronSecret) fail('INTERNAL_CRON_SECRET must be set — it signs the per-turf webhook token.');

const db = drizzle(createClient(dbConfig));
const client = createVanClient({
	appName: credential.appName,
	apiKey: credential.apiKey,
	databaseMode: credential.databaseMode,
});

/** Set by main() once the campaign row is read. */
let campaignId = 0;

/** How long turfs already under way at the end of a slice may keep going.
 *  Without it the slice's deadline aborts their downloads, which counts as a
 *  failed attempt and discards the export job — every slice, for every turf in
 *  flight. Long enough for a download plus a couple of Census batches. */
const FINISH_GRACE_MS = 2 * 60 * 1000;
/** Lock TTL, kept alive by a heartbeat for as long as a slice runs. A slice
 *  has no fixed length — the grace bounds downloads, not a VAN call stuck in
 *  429 backoff — so no fixed TTL is safe: one that lapsed mid-slice would let
 *  the scheduled sync take a row this run is in the middle of submitting, and
 *  export it a second time. Short, so a crashed run frees the lock soon. */
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
/** Pause after each slice, longer than the sync route's lock poll. */
const SLICE_GAP_MS = 10 * 1000;
/** How long to wait for a scheduled sync to let go of the lock. */
const LOCK_RETRY_MS = 15 * 1000;

/** "1h 05m" / "12m" / "<1m". */
function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return '<1m';
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * When the queue should be empty, at the rate it has drained so far this run.
 *
 * The rate is over the run's working time: wall clock less the time spent
 * waiting for a scheduled sync to give up the lock. Those waits come in
 * minutes-long lumps every half hour, so counting them would swing the
 * estimate by however recently one happened — a wait in the first slice made
 * the whole run look several times slower than it was. The cost is that the
 * estimate leaves out the syncs still to come, which is a few percent. Slice
 * gaps do count: they are steady, and part of the real speed.
 *
 * Net of rows a scheduled sync queued meanwhile, which is the number that
 * matters. Empty until something has cleared.
 */
function eta(workingMs: number, startPending: number, pending: number, deadline: number): string {
	const cleared = startPending - pending;
	if (cleared <= 0 || pending === 0 || workingMs <= 0) return '';
	const leftMs = (pending * workingMs) / cleared;
	const at = new Date(Date.now() + leftMs).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
	});
	const pastBudget = Date.now() + leftMs > deadline ? ' (past this run’s budget)' : '';
	return ` · done ~${at}, in ${formatDuration(leftMs)}${pastBudget}`;
}

const ZERO_STATS: VanClientStats = { slotWaitMs: 0, retryWaitMs: 0, retries: 0 };
const clientStats = (): VanClientStats => client.stats?.() ?? ZERO_STATS;

/** "1.2s" — per-turf stage times are seconds, not minutes. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Where a turf's time went, on average: the stages from the worker, and from
 * the VAN client how much of the VAN time was queueing behind its own limit of
 * two calls or backing off from VAN — the two readings that say whether the
 * limiter or VAN is what to change. `share` adds each stage's percentage, for
 * the end-of-run summary.
 */
function formatTimings(t: GeometryTimings, van: VanClientStats, share = false): string {
	if (t.turfs === 0) return 'no turfs';
	const total = t.vanMs + t.pollWaitMs + t.downloadMs + t.geocodeMs + t.dbMs;
	const stage = (label: string, ms: number) =>
		`${label} ${secs(ms / t.turfs)}${share && total > 0 ? ` (${Math.round((100 * ms) / total)}%)` : ''}`;
	return [
		`${stage('van', t.vanMs)} [queued ${secs(van.slotWaitMs / t.turfs)}, ` +
			`backoff ${secs(van.retryWaitMs / t.turfs)}${van.retries ? `, ${van.retries} retries` : ''}]`,
		stage('poll', t.pollWaitMs),
		stage('download+parse', t.downloadMs),
		stage('geocode', t.geocodeMs),
		stage('db', t.dbMs),
	].join(' · ');
}

/** Fewest batches worth fitting a line to. */
const MIN_FIT_WRITES = 10;

/**
 * What the db stage is made of: each finished turf's one batch of writes, per
 * finished turf; then per turf picked up, the end-of-slice recount and the
 * rest — the job id stored after each POST, a resumed turf's claim, a failed
 * turf's record, and the time of any batch that failed. Then a line fitted through the batches, write time against
 * roster rows: a big fixed part says each transaction costs the same whatever
 * it carries, so writing a slice's turfs in one batch would pay; a big per-row
 * part says the rows are the cost, and it would not.
 *
 * Several turfs writing at once each wait behind the others, which lands in
 * the fixed part. For a clean reading run a few minutes at --concurrency 1.
 */
function formatDbBreakdown(t: GeometryTimings): string {
	if (t.turfs === 0) return 'no turfs';
	const other = Math.max(0, t.dbMs - t.writeMs - t.recountMs);
	const parts = [
		t.writes > 0
			? `write ${secs(t.writeMs / t.writes)} per finished turf (${Math.round(t.writeRows / t.writes)} roster rows)`
			: 'no writes',
		`recount ${secs(t.recountMs / t.turfs)}`,
		`other ${secs(other / t.turfs)}`,
	];
	const n = t.writes;
	const spread = n * t.writeRowsSq - t.writeRows * t.writeRows;
	if (n >= MIN_FIT_WRITES && spread > 0) {
		const perRow = (n * t.writeRowsMs - t.writeRows * t.writeMs) / spread;
		const fixed = (t.writeMs - perRow * t.writeRows) / n;
		parts.push(`fit: ${secs(fixed)} + ${secs(perRow * 100)} per 100 rows`);
	}
	return parts.join(' · ');
}

const timingTotals: GeometryTimings = {
	turfs: 0,
	vanMs: 0,
	pollWaitMs: 0,
	downloadMs: 0,
	geocodeMs: 0,
	dbMs: 0,
	writeMs: 0,
	writes: 0,
	writeRows: 0,
	writeRowsSq: 0,
	writeRowsMs: 0,
	recountMs: 0,
};

const totals = {
	attempted: 0,
	hullsStored: 0,
	centroidsOnly: 0,
	noGeometry: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	hullsTooLarge: 0,
	rostersStored: 0,
	rostersUnavailable: 0,
};

/**
 * Retry the recounts slices could not finish. Outside the sync lock, as the
 * contact pull's recounts are: it rewrites only counts. A failure here is
 * reported, not thrown, so the contact pull still runs.
 */
async function recountMissed(turfIds: number[]): Promise<void> {
	if (turfIds.length === 0) return;
	try {
		await recomputeUncontacted(db, { now: new Date(), campaignId, turfIds });
		console.log(`\n  Recounted the ${turfIds.length} turf(s) a slice could not.`);
	} catch (err) {
		console.error(
			`\n  ! Could not recount ${turfIds.length} turf(s); they show VAN's door count:`,
			err,
		);
	}
}

/**
 * Pull VAN's ContactHistory up to now and recount the turfs whose people it
 * saw contacted — every counted turf on the campaign's first pull, only those
 * after (runContactSync). What the scheduled sync does ~45 seconds at a time,
 * done here in one sitting so that van:sync followed by van:drain leaves the
 * counts current. Takes the contact pull's own lock, not the sync lock, per
 * call.
 */
async function pullContacts(deadline: number, isStopping: () => boolean): Promise<void> {
	if (!roster) return;
	console.log('\nContacts — pulling VAN ContactHistory up to now');
	// Always leave room for this, even if the drain used the whole budget.
	const until = Math.max(deadline, Date.now() + 15 * 60 * 1000);
	// See contactPullDone: without it this chases "now" until `until`.
	const pullStartedAt = Date.now();
	let windows = 0;
	let contacts = 0;
	while (!isStopping() && Date.now() < until) {
		const lock = vanContactLock(campaignId);
		const token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
		if (!token) {
			console.log('  … a scheduled sync is pulling contacts; waiting for it');
			await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
			continue;
		}
		// Kept alive like the slice's: a pass runs well past its time budget
		// — the recount and stamping come after it — and one that outlived a
		// fixed TTL would let the scheduled pull read the same window too.
		const heartbeat = setInterval(() => {
			extendSyncLock(db, lock, token, LOCK_TTL_MS)
				.then((held) => {
					if (!held) console.warn('  ! lost the contact lock mid-pass — a sync may overlap');
				})
				.catch((err) => console.warn('  ! could not extend the contact lock:', err));
		}, LOCK_HEARTBEAT_MS);
		let result: Awaited<ReturnType<typeof runContactSync>>;
		try {
			result = await runContactSync(db, client, {
				campaignId,
				hasher: roster,
				timeBudgetMs: Math.min(SLICE_MS, until - Date.now()),
			});
		} finally {
			clearInterval(heartbeat);
			await releaseSyncLock(db, lock, token);
		}
		windows += result.windowsApplied;
		contacts += result.contactsRead;
		console.log(
			`  through ${result.cursor ?? '—'} · +${result.windowsApplied} day(s), ` +
				`${result.contactsRead} contacts · ${result.turfsRecomputed} turfs recounted` +
				(result.error ? ` · ${result.error}` : ''),
		);
		if (contactPullDone(result, pullStartedAt)) {
			if (result.error) console.log('  Stopped on the error above; the scheduled sync will retry.');
			break;
		}
		if (result.pending) await new Promise((r) => setTimeout(r, 5_000));
	}
	console.log(`  ${windows} day window(s), ${contacts} in-person contact(s) read.`);
}

async function main(): Promise<void> {
	const campaign = await campaignRow(db, CAMPAIGN_KEY);
	campaignId = campaign.id;
	// The app's own rule (exportJobTypeIdFor), so the drain and the sync agree.
	const exportJobTypeId = campaignExportJobTypeId(campaign);
	if (exportJobTypeId === null) {
		fail(
			`No export job type for ${CAMPAIGN_KEY} — set it on the campaign` +
				(CAMPAIGN_KEY === PRIMARY_CAMPAIGN_KEY ? ' or in VAN_EXPORT_JOB_TYPE_ID' : '') +
				' (5 = VoterCircle on the primary key).',
		);
	}
	console.log(`\nGeometry drain — ${dbConfig.url}`);
	console.log(`Campaign: ${campaign.label ?? CAMPAIGN_KEY} (id ${campaign.id})`);
	console.log(
		`VAN app: ${credential.appName}, mode ${credential.databaseMode}, export job type ${exportJobTypeId}`,
	);
	console.log(roster ? 'Rosters: on' : 'Rosters: off (VAN_ID_HASH_SECRET unset)');
	console.log(
		`Budget: ${MINUTES} min · ${CONCURRENCY} at a time${MAX_ITEMS ? ` · max ${MAX_ITEMS} item(s)` : ''}\n`,
	);

	// This campaign's turf only: the queue this run works, and nothing another
	// campaign — or another drain running on it — does to its own.
	const before = await loadGeometryProgress(db, campaignId);
	console.log(
		`  Starting at ${percentShaped(before)}% — ${before.shaped} shaped, ${before.pending} queued, ${before.failed} failed\n`,
	);
	if (before.pending === 0) {
		console.log('  Nothing queued. Run npm run van:sync first if turf is missing shapes.');
		await pullContacts(Date.now() + MINUTES * 60 * 1000, () => false);
		console.log('');
		return;
	}

	// Ctrl-C releases the lock rather than leaving it to expire; whatever row is
	// mid-flight keeps its export job id and resumes on the next run.
	//
	// The first press lets the slice finish, which with its grace can be a few
	// minutes. A second quits at once, releasing the lock on the way out. Rows
	// in flight are left `running`: one with a job id resumes by polling, and
	// one caught mid-POST resubmits — at worst one orphaned export in VAN.
	// The slice's end-of-slice recount is skipped too, so turfs it rostered
	// show VAN's door count instead of doors left until a recount reaches them.
	let stopping = false;
	/** The sync lock while a slice holds it, for a forced quit to release. */
	let heldToken: string | null = null;
	const onSignal = () => {
		if (!stopping) {
			stopping = true;
			console.log('\n  Stopping after this slice… (Ctrl-C again to quit now)');
			return;
		}
		console.log('\n  Quitting now.');
		const release = heldToken
			? releaseSyncLock(db, vanSyncLock(campaignId), heldToken).catch(() => {})
			: Promise.resolve();
		// Bounded: a database that is not answering must not hold the exit up.
		void Promise.race([release, new Promise((r) => setTimeout(r, 3000))]).then(() =>
			process.exit(130),
		);
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	const startedAt = Date.now();
	const deadline = startedAt + MINUTES * 60 * 1000;
	let geometryVanStats: VanClientStats;
	/** Time spent waiting for a scheduled sync to let go of the lock — kept
	 *  out of the ETA's rate; see eta(). */
	let syncWaitMs = 0;
	let syncWaitStarted: number | null = null;
	/** Turfs a slice's end-of-slice recount failed for, retried once at the
	 *  end — nothing else would reach them. */
	const unrecounted: number[] = [];
	try {
		let slice = 0;
		while (!stopping && Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const token = await acquireSyncLock(db, vanSyncLock(campaignId), LOCK_TTL_MS);
			if (!token) {
				if (syncWaitStarted === null) {
					syncWaitStarted = Date.now();
					console.log('  … a scheduled sync holds the lock; waiting for it');
				}
				await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
				continue;
			}
			if (syncWaitStarted !== null) {
				const waited = Date.now() - syncWaitStarted;
				syncWaitMs += waited;
				syncWaitStarted = null;
				console.log(`  … the sync finished after ${formatDuration(waited)}; carrying on`);
			}
			heldToken = token;
			const heartbeat = setInterval(() => {
				extendSyncLock(db, vanSyncLock(campaignId), token, LOCK_TTL_MS)
					.then((held) => {
						if (!held) console.warn('  ! lost the sync lock mid-slice — another run may overlap');
					})
					.catch((err) => console.warn('  ! could not extend the sync lock:', err));
			}, LOCK_HEARTBEAT_MS);
			const vanBefore = clientStats();
			let result: Awaited<ReturnType<typeof runGeometryQueue>>;
			try {
				result = await runGeometryQueue(db, client, {
					campaignId,
					exportJobTypeId,
					webhookUrlFor: (turfId) => exportCallbackUrl(appUrl, cronSecret, turfId),
					timeBudgetMs: Math.min(SLICE_MS, remaining),
					finishGraceMs: FINISH_GRACE_MS,
					// The database is most of a turf's time; see batchRecount.
					batchRecount: true,
					concurrency: CONCURRENCY,
					maxItems: MAX_ITEMS,
					roster,
					// No Slack alert: an operator is watching this run, and the
					// channel does not need a line per dead letter from a backfill.
				});
			} finally {
				clearInterval(heartbeat);
				heldToken = null;
				await releaseSyncLock(db, vanSyncLock(campaignId), token);
			}
			// Let a scheduled sync in. It polls for the lock while this holds it,
			// and without a pause the next slice re-takes the lock before the
			// sync's next poll — every scheduled sync then skips for the whole
			// drain, which is what froze the counts during the first roster pass.
			if (!stopping) await new Promise((r) => setTimeout(r, SLICE_GAP_MS));
			totals.rostersStored += result.rostersStored;
			totals.rostersUnavailable += result.rostersUnavailable;

			totals.attempted += result.attempted;
			totals.hullsStored += result.hullsStored;
			totals.centroidsOnly += result.centroidsOnly;
			totals.noGeometry += result.noGeometry;
			totals.geocodedFromAddress += result.geocodedFromAddress;
			totals.retried += result.retried;
			totals.deadLettered += result.deadLettered;
			totals.hullsTooLarge += result.hullsTooLarge;

			slice += 1;
			const progress = await loadGeometryProgress(db, campaignId);
			console.log(
				`  [${String(slice).padStart(3)}] +${String(result.hullsStored).padStart(3)} hulls · ` +
					`${percentShaped(progress)}% · ${progress.shaped}/${progress.eligible} shaped · ` +
					`${progress.pending} left · +${result.rostersStored} rosters` +
					`${result.deadLettered > 0 ? ` · ${result.deadLettered} dead-lettered` : ''}` +
					eta(Date.now() - startedAt - syncWaitMs, before.pending, progress.pending, deadline),
			);
			for (const line of result.deadLetters) console.log(`        ${line}`);
			if (result.unrecounted.length > 0) {
				unrecounted.push(...result.unrecounted);
				console.log(
					`        ! ${result.unrecounted.length} turf(s) not recounted; retrying at the end`,
				);
			}
			const vanAfter = clientStats();
			console.log(
				`        per turf: ${formatTimings(result.timings, {
					slotWaitMs: vanAfter.slotWaitMs - vanBefore.slotWaitMs,
					retryWaitMs: vanAfter.retryWaitMs - vanBefore.retryWaitMs,
					retries: vanAfter.retries - vanBefore.retries,
				})}`,
			);
			console.log(`        db: ${formatDbBreakdown(result.timings)}`);
			for (const key of Object.keys(timingTotals) as Array<keyof GeometryTimings>) {
				timingTotals[key] += result.timings[key];
			}

			// Nothing attempted means the queue is empty — or every row left is
			// one this run already failed, which retrying now will not fix.
			if (result.attempted === 0 || progress.pending === 0) break;
			if (MAX_ITEMS) break;
		}
		// A run that ended while still waiting on a sync still waited.
		if (syncWaitStarted !== null) syncWaitMs += Date.now() - syncWaitStarted;
		// Before the contact pull, whose VAN calls are not the turfs'.
		geometryVanStats = clientStats();
		await recountMissed(unrecounted);
		await pullContacts(deadline, () => stopping);
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	}

	const after = await loadGeometryProgress(db, campaignId);
	console.log('\nDone');
	console.log(`  turfs attempted     ${totals.attempted}`);
	console.log(`  hulls stored        ${totals.hullsStored}`);
	console.log(`  centroid only       ${totals.centroidsOnly}   (drawn as a pin, by design)`);
	console.log(`  no geometry at all  ${totals.noGeometry}`);
	console.log(`  geocoded by address ${totals.geocodedFromAddress}`);
	console.log(`  retried             ${totals.retried}`);
	console.log(`  dead-lettered       ${totals.deadLettered}`);
	console.log(`  rosters built       ${totals.rostersStored}`);
	if (totals.rostersUnavailable > 0) {
		console.log(
			`  no roster (no VanID) ${totals.rostersUnavailable}   (check VAN_EXPORT_JOB_TYPE_ID is type 5)`,
		);
	}
	if (totals.hullsTooLarge > 0) {
		console.log(`  implausibly large   ${totals.hullsTooLarge}   (stored, but worth a look)`);
	}
	if (syncWaitMs > 0) {
		console.log(`  waited for syncs    ${formatDuration(syncWaitMs)}`);
	}
	console.log(`\n  Time per turf, averaged over ${timingTotals.turfs}:`);
	console.log(`    ${formatTimings(timingTotals, geometryVanStats, true)}`);
	console.log(`    db: ${formatDbBreakdown(timingTotals)}`);
	console.log(
		`\n  Now at ${percentShaped(after)}% — ${after.shaped}/${after.eligible} shaped, ` +
			`${after.pending} queued, ${after.failed} failed.`,
	);
	if (roster) {
		const rosters = await rosterProgress(db, campaignId);
		console.log(`  Rosters: ${rosters.rostered}/${rosters.live} live turfs.`);
	}
	console.log('  npm run van:geometry shows this any time.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
