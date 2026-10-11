// Drain van_geometry_queue: one export job per turf, reduced to a hull.
//
// Shaped like sync.ts on purpose — injected client, injected clock, a time
// budget, no $env and no settings import, so scripts/ can run it under tsx
// outside the Vite bundle. The decisions worth reasoning about live in
// hull-extract.ts (what comes out of the CSV) and catalog.ts (what gets
// queued); this file fetches, waits, writes and gives up in a controlled way.
//
// Three properties the live API forced (see the probe notes in client.ts):
//
//   - `webhookUrl` is REQUIRED on POST /exportJobs, and VAN posts the finished
//     job — downloadUrl included — to it. It must therefore point at a host we
//     control, never a third party's.
//   - A small list comes back `status: "Completed"` with `downloadUrl` already
//     populated ON THE POST RESPONSE. The common case does zero polling, and a
//     worker that assumed Pending would do a needless round trip and, worse,
//     wait for a webhook that already fired.
//   - `dateExpired` is not trustworthy: POST and GET disagreed about the same
//     job (POST +3h, GET a timestamp already in the past). So a downloadUrl is
//     consumed in the same tick it is seen, never stored for later.
//
// Resumability is the reason `exportJobId` is persisted before the download.
// Fly stops the machine mid-run routinely; a row left `running` with a job id
// is picked up by the next run and POLLED rather than re-submitted, so a
// killed worker costs one HTTP GET, not a duplicate export job.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { vanGeometryQueue, vanTurfs } from '../schema.js';
import { VanError, type VanClient } from './client.js';
import {
	extractHull,
	responseChunks,
	HullExtractError,
	MIN_POINTS_FOR_SPAN_VERDICT,
	type GeocodeFn,
} from './hull-extract.js';
import { geocodeAddresses } from './geocode-batch.js';
import { needsGeometry } from './catalog.js';
import { recomputeUncontacted, recountStatement, rosterStatements } from './contact-sync.js';
import type { PersonHasher } from './person-hash.js';
import type { VanExportJob } from './types.js';

type Db = ReturnType<typeof drizzle>;
type FetchFn = typeof fetch;

/** Attempts before a row is dead-lettered. Deliberately small: the failures
 *  this hits in practice (wrong export job type, a key without export access)
 *  are configuration errors that no amount of retrying fixes, and burning a
 *  hundred export jobs to rediscover that is worse than surfacing it. */
export const MAX_ATTEMPTS = 4;

/** Work items in flight. The VAN client already caps ITS OWN concurrency at 2,
 *  but the blob download goes straight to Azure and bypasses that limiter
 *  entirely, so the cap is repeated here over whole items.
 *
 *  The default for the scheduled sync, where politeness matters more than
 *  speed. `options.concurrency` raises it for a one-off backlog drain run from
 *  a script — the VAN client's own limiter still bounds calls to VAN itself. */
const MAX_CONCURRENCY = 2;

/** Whole-run budget, under the 10-minute lock in the van-sync route and well
 *  under Fly's patience. A run that lapses leaves its rows resumable. */
const DEFAULT_TIME_BUDGET_MS = 3 * 60 * 1000;

/** Per-job polling. Most jobs never poll at all; these bound the ones that do
 *  rather than trying to outwait a genuinely slow export, which is what the
 *  next scheduled run is for. */
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 5;

/** Time that must remain before a download-and-extract is started at all.
 *
 *  A turf begun with a sliver of budget aborts mid-stream and burns an attempt,
 *  and four of those dead-letter a turf whose only problem was arriving last in
 *  a busy run. Below this the row is left resumable instead — it already has a
 *  job id, so the next run polls rather than re-submitting. */
const MIN_DOWNLOAD_MS = 5_000;

/** How long a submitted job may go without a downloadUrl before it is given
 *  up on and resubmitted. A turf's export normally finishes in seconds; one
 *  still pending after this is not coming, and leaving it resumable forever
 *  would keep it at the head of every run's queue. */
export const STALE_JOB_MS = 60 * 60 * 1000;

/** How long after submission a job reading Completed with no downloadUrl is
 *  taken to have expired. Not zero: a job just submitted may say Completed a
 *  moment before its link is filled in, and failing it there would spend an
 *  attempt and a duplicate export on a job that was about to be fine. */
export const EXPIRED_LINK_GRACE_MS = 5 * 60 * 1000;

export interface GeometryWorkerOptions {
	/** The campaign whose queue this run drains, with that campaign's client.
	 *  Export jobs are created and read with a campaign's own key, so a run
	 *  never touches another campaign's turf. */
	campaignId: number;
	/** VAN's per-developer export job type id — 5 (VoterCircle) on this key.
	 *  Type 4 has no coordinate columns and produces a loud extract failure. */
	exportJobTypeId: number;
	/** Absolute HTTPS URL on a host we control, built for ONE turf.
	 *
	 *  Per turf rather than one URL for the whole run because VAN stores this
	 *  string against the job and echoes it back on every later read, so it
	 *  carries a capability token scoped to that turf instead of a shared
	 *  secret — see webhook-token.ts. Called immediately before each POST. */
	webhookUrlFor: (turfId: number) => string;
	now?: Date;
	/** When to stop STARTING turfs. */
	timeBudgetMs?: number;
	/** Extra time past `timeBudgetMs` that turfs already started may take to
	 *  finish their download, geocode and extract. Zero (the default) cuts them
	 *  off at the budget, which the scheduled sync needs: it runs inside a
	 *  request with its own hard limit. A drain script working in short slices
	 *  sets this, because a turf cut off mid-download is recorded as a failed
	 *  attempt and its export job thrown away — at a slice boundary every
	 *  minute, that re-exports and eventually dead-letters turfs that were
	 *  only slow. */
	finishGraceMs?: number;
	/** Cap on items per run. Null means "as many as the budget allows". */
	maxItems?: number | null;
	/** Items in flight. Defaults to MAX_CONCURRENCY; a drain script raises it.
	 *  Clamped to at least 1, so a bad value cannot stall the run entirely. */
	concurrency?: number;
	/** Injected for tests, and used for the Azure download — which must NOT go
	 *  through the VAN client, since that would attach our Basic credentials to
	 *  a request to a different host. */
	fetchFn?: FetchFn;
	/** Best-effort operator alert for dead-lettered turfs. */
	alert?: (text: string) => Promise<void>;
	/** Injected so tests do not actually wait out the poll interval. */
	sleep?: (ms: number) => Promise<void>;
	/** Resolve addresses VAN never geocoded. Defaults to the US Census batch
	 *  geocoder; injected in tests.
	 *
	 *  Only rows whose `VAddressLatitude`/`VAddressLongitude` are empty ever
	 *  reach it, and the call is skipped entirely when there are none — so a
	 *  turf VAN has already geocoded sends nothing anywhere. Passing `null`
	 *  disables it outright, which also stops the extractor reading address
	 *  columns at all (see the mask note in hull-extract.ts). */
	geocode?: GeocodeFn | null;
	/** Also reduce the export to a roster of hashed people and doors for the
	 *  uncontacted-door count. Null or omitted: VanID is never read. */
	roster?: PersonHasher | null;
	/** Recount uncontacted doors once, after the last turf, for every turf
	 *  given a roster this run — instead of with each turf's own writes. One
	 *  query per 200 turfs rather than one per turf, for the drain script,
	 *  where the database is most of a turf's time. The cost is that a run
	 *  killed partway leaves its rostered turfs' counts stale until something
	 *  recounts them. Off by default. */
	batchRecount?: boolean;
}

export interface GeometryWorkerResult {
	/** Rows picked up this run. */
	attempted: number;
	/** Turfs that now have a hull polygon. */
	hullsStored: number;
	/** Turfs that got a centroid but no usable shape — too few points, or
	 *  collinear. These are successes: the UI draws a pin. */
	centroidsOnly: number;
	/** Turfs whose export produced no usable coordinate at all. */
	noGeometry: number;
	/** Turfs whose hull spans more than MAX_HULL_EXTENT_M. These are counted in
	 *  `hullsStored` too — the shape is kept; this is the "and it looks wrong"
	 *  signal alongside it. */
	hullsTooLarge: number;
	/** Coordinates recovered by geocoding addresses VAN had not geocoded,
	 *  across every turf this run. Zero when VAN had already geocoded
	 *  everything, which is also the case where nothing was sent to a third
	 *  party — so "did any address leave our servers this run" is answerable
	 *  from the sync response rather than from the logs. */
	geocodedFromAddress: number;
	/** Turfs whose roster was (re)built this run. */
	rostersStored: number;
	/** Turfs whose roster was asked for but could not be built from the
	 *  export (no VanID column). Their hulls are stored as normal. */
	rostersUnavailable: number;
	/** Rows returned to `pending` to try again later. */
	retried: number;
	/** Rows that hit MAX_ATTEMPTS and are now `failed`. */
	deadLettered: number;
	/** One line per dead-lettered turf. Kept apart from `warnings` because the
	 *  operator alert speaks only about turfs that have STOPPED retrying, and a
	 *  list that also carried "this hull looks big" lines would claim more turfs
	 *  had given up than actually did. The caller posts one or the other, never
	 *  both, so nothing reaches Slack twice. */
	deadLetters: string[];
	/** Rows left `running` with a job id, for the next run to poll. */
	stillRunning: number;
	/** True when the time budget stopped the run early. */
	budgetLapsed: boolean;
	/** Turfs whose batchRecount recount failed: stored, but showing no
	 *  doors-left count until the caller recounts them — nothing else will
	 *  reliably reach them. Empty otherwise. */
	unrecounted: number[];
	/** Where the turfs' time went, summed over every turf this run. */
	timings: GeometryTimings;
	/** Advisory notes about turfs that SUCCEEDED — no usable coordinates, or a
	 *  hull far too large to be a walking route. Never carries a dead letter;
	 *  those are in `deadLetters`. */
	warnings: string[];
}

/**
 * Milliseconds per stage, summed across turfs — so with several in flight the
 * total exceeds the run's wall clock. The shares are what to read: they say
 * which stage a turf spends its life in.
 */
export interface GeometryTimings {
	/** Turfs these timings cover: every one picked up, finished or not. */
	turfs: number;
	/** VAN export job calls, including any wait for a client slot. */
	vanMs: number;
	/** Sleeping between polls of a job VAN has not finished. */
	pollWaitMs: number;
	/** The Azure download and the CSV parse and hull, which stream together. */
	downloadMs: number;
	/** The Census geocoder, for rows VAN had no coordinates for. */
	geocodeMs: number;
	/** Everything else: the database reads and writes, roster included. */
	dbMs: number;

	// Inside dbMs, not added to it: what the database time is made of, to
	// tell a cost per transaction (fixed per write) from a cost per row.

	/** Each finished turf's one batch of writes — hull, roster, done row.
	 *  Only batches that succeeded: a failed one's time stays in dbMs alone,
	 *  so the fit below is over complete writes. */
	writeMs: number;
	/** How many of those batches. */
	writes: number;
	/** Roster rows inserted by them. With writeRowsSq and writeRowsMs, enough
	 *  to fit write time against rows: ms ≈ fixed + perRow × rows. */
	writeRows: number;
	writeRowsSq: number;
	writeRowsMs: number;
	/** batchRecount's recount at the end of the run. */
	recountMs: number;
}

/** One turf's share of GeometryTimings, before it is added to the run's. */
type ItemClock = Pick<GeometryTimings, 'vanMs' | 'pollWaitMs' | 'downloadMs' | 'geocodeMs'>;

interface QueueItem {
	turfId: number;
	savedListId: number;
	exportJobId: number | null;
	attempts: number;
	/** When the row's current export job was submitted. */
	requestedAt: string | null;
	/** The turf's own columns that decide what the export is for, read with
	 *  the queue rather than per turf. The scheduled catalog sync, their only
	 *  writer, takes the same lock as a run, so they hold for its length.
	 *  scripts/van-sync-once.ts does not take it; a re-cut it lands mid-run
	 *  stamps the hull with the old routeSize, which `needsGeometry` then sees
	 *  as stale and queues again. */
	routeSize: number;
	hullJson: string | null;
	hullSourceRouteSize: number | null;
}

function isTerminal(status: string | null, wanted: 'completed' | 'error'): boolean {
	return (status ?? '').trim().toLowerCase() === wanted;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the queue.
 *
 * Never throws for a per-turf failure — one turf with a broken export must not
 * stop the other 199. A thrown error here means the run itself could not
 * proceed (the database is gone), which the caller should surface.
 */
export async function runGeometryQueue(
	db: Db,
	client: VanClient,
	options: GeometryWorkerOptions,
): Promise<GeometryWorkerResult> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	/** Hard limit for a turf already under way; `deadline` only stops new ones. */
	const finishBy = deadline + Math.max(0, options.finishGraceMs ?? 0);
	const fetchFn = options.fetchFn ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const warnings: string[] = [];
	const deadLetters: string[] = [];

	const result: GeometryWorkerResult = {
		attempted: 0,
		hullsStored: 0,
		centroidsOnly: 0,
		hullsTooLarge: 0,
		geocodedFromAddress: 0,
		noGeometry: 0,
		rostersStored: 0,
		rostersUnavailable: 0,
		retried: 0,
		deadLettered: 0,
		deadLetters,
		stillRunning: 0,
		budgetLapsed: false,
		unrecounted: [],
		timings: {
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
		},
		warnings,
	};
	const { timings } = result;
	/** Turfs given a roster this run, for batchRecount to recount at the end. */
	const rostered: number[] = [];

	// Resumable rows first — they already cost an export job, so finishing one
	// is cheaper than starting a new one, and leaving them behind a backlog of
	// fresh work is how a turf ends up stranded without a shape forever.
	// A `running` row with no job id is a crash between the status write and
	// the POST; it is indistinguishable from pending, so treat it as such.
	const items = (await db
		.select({
			turfId: vanGeometryQueue.turfId,
			savedListId: vanGeometryQueue.savedListId,
			exportJobId: vanGeometryQueue.exportJobId,
			attempts: vanGeometryQueue.attempts,
			requestedAt: vanGeometryQueue.requestedAt,
			routeSize: vanTurfs.routeSize,
			hullJson: vanTurfs.hullJson,
			hullSourceRouteSize: vanTurfs.hullSourceRouteSize,
		})
		.from(vanGeometryQueue)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanGeometryQueue.turfId))
		// `running` is included whether or not it has a job id: with one it is
		// resumable by polling, without one it is a crash between the status
		// write and the POST and is indistinguishable from pending. The ORDER BY
		// below is what separates the two, not the filter.
		.where(
			and(
				eq(vanTurfs.campaignId, options.campaignId),
				inArray(vanGeometryQueue.status, ['pending', 'running']),
			),
		)
		.orderBy(
			// Resumable (has a job id) before fresh, then fewest attempts first
			// so a poison row cannot monopolise every run.
			sql`case when ${vanGeometryQueue.exportJobId} is null then 1 else 0 end`,
			vanGeometryQueue.attempts,
			vanGeometryQueue.turfId,
		)) as QueueItem[];

	const queue = options.maxItems == null ? items : items.slice(0, options.maxItems);
	if (queue.length === 0) return result;

	/** processItem, timed. Each turf keeps its own clock, since the shared
	 *  totals also move with every other turf in flight. The database gets
	 *  whatever the other stages did not account for, rather than a timer
	 *  around each of a dozen queries. */
	async function processTimedItem(item: QueueItem): Promise<void> {
		const started = Date.now();
		const clock: ItemClock = { vanMs: 0, pollWaitMs: 0, downloadMs: 0, geocodeMs: 0 };
		try {
			await processItem(item, clock);
		} finally {
			// downloadMs already includes the geocoder, which ran inside it.
			const staged = clock.vanMs + clock.pollWaitMs + clock.downloadMs;
			timings.turfs++;
			timings.vanMs += clock.vanMs;
			timings.pollWaitMs += clock.pollWaitMs;
			timings.downloadMs += clock.downloadMs - clock.geocodeMs;
			timings.geocodeMs += clock.geocodeMs;
			timings.dbMs += Math.max(0, Date.now() - started - staged);
		}
	}

	/** One turf, start to finish. Returns nothing; records its own outcome. */
	async function processItem(item: QueueItem, clock: ItemClock): Promise<void> {
		/** Run `work`, adding its duration to one of this turf's stages. */
		async function timed<T>(stage: keyof ItemClock, work: () => Promise<T>): Promise<T> {
			const started = Date.now();
			try {
				return await work();
			} finally {
				clock[stage] += Date.now() - started;
			}
		}

		// Captured once. Every later reference is to these locals rather than to
		// `item`, so the two writes below cannot read back a value one of them
		// just changed.
		const priorAttempts = item.attempts;
		const attempts = priorAttempts + 1;
		// Follows the job this turf owns as it changes: null until we submit, the
		// new id from the moment we do. `recordFailure` reads THIS rather than
		// `item`, which is still holding the null the row was selected with.
		let exportJobId = item.exportJobId;
		result.attempted++;

		// A fresh row is marked running in the same write that stores its job
		// id, after the POST: one round trip rather than two. A crash during
		// the POST leaves it pending, which is what a running row with no job
		// id was treated as anyway. A resumed row already has its job, so it is
		// marked before the GET, as a claim on it.
		if (item.exportJobId !== null) {
			await db
				.update(vanGeometryQueue)
				.set({ status: 'running', attempts, lastError: null })
				.where(eq(vanGeometryQueue.turfId, item.turfId));
		}

		try {
			// Resume by polling; otherwise submit. Both paths converge on a job
			// that either carries a downloadUrl or does not yet.
			let job: VanExportJob;
			if (item.exportJobId !== null) {
				const resumed = item.exportJobId;
				job = await timed('vanMs', () => client.exportJob(resumed));
			} else {
				job = await timed('vanMs', () =>
					client.createExportJob({
						savedListId: item.savedListId,
						exportJobTypeId: options.exportJobTypeId,
						webhookUrl: options.webhookUrlFor(item.turfId),
					}),
				);
				// Persisted before the download so a crash mid-download resumes
				// by polling instead of submitting a second job.
				exportJobId = job.exportJobId;
				await db
					.update(vanGeometryQueue)
					.set({
						status: 'running',
						attempts,
						exportJobId,
						// Stamped when a job is submitted, never on a resume: it is
						// what tells a slow job from one that is never going to finish.
						requestedAt: now.toISOString(),
						lastError: null,
					})
					.where(eq(vanGeometryQueue.turfId, item.turfId));
			}

			// Small lists are already Completed here and skip the loop entirely.
			// Only a job submitted this pass is waited on. A resumed one has had
			// at least a run already, so it gets the single GET above: polling
			// it would spend the budget on rows that sort ahead of all the
			// fresh work, and a handful of slow jobs would starve the queue.
			const polls = item.exportJobId === null ? MAX_POLLS : 0;
			for (let poll = 0; poll < polls && !job.downloadUrl; poll++) {
				if (isTerminal(job.status, 'error')) break;
				if (Date.now() >= deadline) break;
				await timed('pollWaitMs', () => sleep(POLL_INTERVAL_MS));
				const polled = job.exportJobId;
				job = await timed('vanMs', () => client.exportJob(polled));
			}

			if (isTerminal(job.status, 'error')) {
				throw new Error(`VAN reported the export job failed (${job.errorCode ?? 'no code'})`);
			}

			// Only a resumed job is judged here. One submitted this pass is never
			// expired or stale, however it reads — and `item.requestedAt` would
			// be the previous job's anyway. A retry clears the job id, so the
			// next pass submits afresh.
			if (!job.downloadUrl && item.exportJobId !== null) {
				const age = now.getTime() - (item.requestedAt ? Date.parse(item.requestedAt) : NaN);
				// Finished, but the link is gone: VAN drops downloadUrl once the
				// job expires, and a finished job never grows a new one. Left
				// "running", these were re-polled every run and, sorting first,
				// starved the fresh rows behind them.
				if (isTerminal(job.status, 'completed') && age >= EXPIRED_LINK_GRACE_MS) {
					throw new Error('VAN export job completed but its download link has expired');
				}
				// Pending far longer than any export takes. Resubmitting costs an
				// attempt, so a list VAN can never export still dead-letters
				// rather than holding its place at the head of the queue forever.
				if (age >= STALE_JOB_MS) {
					throw new Error(
						`VAN export job still had no download link ${Math.round(age / 60_000)} min after it was submitted`,
					);
				}
			}

			if (!job.downloadUrl) {
				// Not a failure — the job is simply still running. Leave it
				// resumable and DO NOT count the attempt against it, or a slow
				// export would dead-letter itself by being polled four times.
				await db
					.update(vanGeometryQueue)
					.set({ status: 'running', attempts: priorAttempts })
					.where(eq(vanGeometryQueue.turfId, item.turfId));
				result.stillRunning++;
				return;
			}

			// The poll loop above can return with the budget spent or nearly so.
			// Starting a download-and-extract we cannot finish would overrun the
			// request the scheduled sync is allowed; the job id is already
			// stored, so leaving the row resumable costs one GET on the next run.
			if (finishBy - Date.now() < MIN_DOWNLOAD_MS) {
				await db
					.update(vanGeometryQueue)
					.set({ status: 'running', attempts: priorAttempts })
					.where(eq(vanGeometryQueue.turfId, item.turfId));
				result.stillRunning++;
				result.budgetLapsed = true;
				return;
			}

			// Decided before the download, because it decides what the download
			// is for. A turf queued only for its roster keeps its hull, and —
			// more to the point — sends nothing to the geocoder: re-geocoding a
			// turf whose shape is already right would ship addresses to a third
			// party for no reason.
			const wantsHull = needsGeometry({
				hullJson: item.hullJson,
				hullSourceRouteSize: item.hullSourceRouteSize,
				routeSize: item.routeSize,
			});
			const hasher = options.roster ?? null;

			const downloadUrl = job.downloadUrl;
			// `undefined` means "use the default geocoder"; an explicit `null`
			// means "do not geocode at all". `??` would collapse those two, so
			// the distinction is spelled out.
			//
			// The default is wrapped rather than passed bare so the run's
			// deadline reaches it: MAX_BATCHES requests at the geocoder's own
			// timeout is five minutes for ONE turf, which is longer than the
			// whole request the scheduled sync gets.
			const geocode: GeocodeFn | null =
				options.geocode === undefined
					? (rows) => geocodeAddresses(rows, fetch, { deadline: finishBy })
					: options.geocode;
			// One timer over the download and the extract: the parse consumes
			// the stream as it arrives, so the two cannot be timed apart. The
			// geocoder runs inside it and is taken back out per turf.
			const extract = await timed('downloadMs', async () => {
				// Plain fetch, deliberately not client.get(): the blob host is not
				// api.securevan.com, and the URL carries its own signature. Sending
				// the VAN Basic header here would hand our credentials to Azure.
				// The signal is the only thing bounding this: a blob that trickles
				// is otherwise outside every budget in the file, and it aborts the
				// body stream as well as the request.
				const res = await fetchFn(downloadUrl, {
					signal: AbortSignal.timeout(finishBy - Date.now()),
				});
				if (!res.ok) {
					// Drain the body before abandoning it, or the connection is held
					// until GC gets round to it.
					await res.body?.cancel().catch(() => {});
					throw new Error(`downloadUrl returned HTTP ${res.status}`);
				}
				return extractHull(responseChunks(res), {
					geocode:
						!wantsHull || geocode === null
							? null
							: (rows) => timed('geocodeMs', () => geocode(rows)),
					roster: hasher,
				});
			});

			const hasHull = extract.hull.length >= 3;
			// Every write the turf's result makes, in one batch: one round trip
			// rather than one each, and all or nothing — a failure part way can
			// no longer leave a stored hull on a row about to be retried.
			const writes: unknown[] = [];
			if (wantsHull) {
				// routeSize as read with the queue: the hull is only valid against
				// the route as it stood then, and that is exactly what
				// hullSourceRouteSize records.
				writes.push(
					db
						.update(vanTurfs)
						.set({
							hullJson: hasHull ? JSON.stringify(extract.hull) : null,
							centroidLat: extract.centre?.lat ?? null,
							centroidLng: extract.centre?.lng ?? null,
							// Null when there is no geometry at all, so `needsGeometry`
							// re-queues it rather than treating "no hull" as settled.
							hullSourceRouteSize: extract.centre ? item.routeSize : null,
						})
						.where(eq(vanTurfs.turfId, item.turfId)),
				);
			}

			// Stamped with the QUEUE row's saved list, which is the one this
			// export was cut from. If VAN has re-cut since, the planner sees the
			// mismatch and queues again. The recount reads the new roster, so it
			// comes after it.
			if (extract.roster) {
				writes.push(...rosterStatements(db, item.turfId, item.savedListId, extract.roster));
				writes.push(
					options.batchRecount
						? // Until the end-of-run recount, no count rather than the old
							// cut's: NULL is what readers already fall back from, to
							// VAN's doorCount. A run killed before the recount leaves
							// it so, which is degraded rather than wrong.
							db
								.update(vanTurfs)
								.set({ uncontactedDoors: null, uncontactedDoorsAt: null })
								.where(eq(vanTurfs.turfId, item.turfId))
						: recountStatement(db, [item.turfId], new Date()),
				);
			}

			// A roster that could not be built leaves its reason on the done
			// row. The sync re-queues a done row for a missing roster only when
			// it has no error — otherwise every turf would be re-exported every
			// run for a roster the export type can never give.
			writes.push(
				db
					.update(vanGeometryQueue)
					.set({
						status: 'done',
						completedAt: new Date().toISOString(),
						lastError: extract.rosterUnavailable,
					})
					.where(eq(vanGeometryQueue.turfId, item.turfId)),
			);
			const writeStarted = Date.now();
			await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
			const writeMs = Date.now() - writeStarted;
			const rows = extract.roster?.length ?? 0;
			timings.writeMs += writeMs;
			timings.writes++;
			timings.writeRows += rows;
			timings.writeRowsSq += rows * rows;
			timings.writeRowsMs += rows * writeMs;
			if (extract.roster) {
				result.rostersStored++;
				// Only once its roster is stored: there is nothing new to count
				// for a turf whose batch failed.
				if (options.batchRecount) rostered.push(item.turfId);
			}
			if (extract.rosterUnavailable) result.rostersUnavailable++;

			result.geocodedFromAddress += extract.geocodedFromAddress;
			// A roster-only pass says nothing new about the shape, so it counts
			// toward none of the geometry outcomes or their warnings.
			if (!wantsHull) return;
			if (hasHull) result.hullsStored++;
			else if (extract.centre) result.centroidsOnly++;
			else result.noGeometry++;

			if (!extract.centre) {
				warnings.push(
					`Turf ${item.turfId}: export returned ${extract.rowCount} row(s) but no usable ` +
						`coordinates (${extract.rowsWithoutCoordinates} ungeocoded) — it will render without a pin.`,
				);
			} else if (extract.hullTooLarge) {
				result.hullsTooLarge++;
				const km = Math.round((extract.hullExtentMeters ?? 0) / 1000);
				// Two readings of the same wide span, and the point count is what
				// tells them apart — see MIN_POINTS_FOR_SPAN_VERDICT. Saying "the
				// saved list is probably not a cut map region" on six points was
				// stating a conclusion the evidence could not support, and pointed
				// at re-cutting turf that was already correct.
				warnings.push(
					extract.pointCount < MIN_POINTS_FOR_SPAN_VERDICT
						? `Turf ${item.turfId}: addresses span ~${km} km across only ` +
								`${extract.pointCount} coordinate(s) — too few to tell a mis-scoped saved list ` +
								`from a map region that is simply sparsely populated. The shape is stored; ` +
								`treat it as approximate rather than as a turf boundary.`
						: `Turf ${item.turfId}: addresses span ~${km} km across ` +
								`${extract.pointCount} coordinates, far past a walkable turf. The shape is ` +
								`stored but is almost certainly not a turf boundary — the saved list is ` +
								`probably not a cut map region.`,
				);
			}
		} catch (err) {
			await recordFailure(item, attempts, exportJobId, err);
		}
	}

	async function recordFailure(
		item: QueueItem,
		attempts: number,
		exportJobId: number | null,
		err: unknown,
	): Promise<void> {
		const message = errMessage(err);
		// A wrong export job type or a key without export access fails
		// identically on every turf, so it is dead-lettered immediately rather
		// than four times over across hundreds of rows.
		const permanent =
			err instanceof HullExtractError || (err instanceof VanError && err.isAuthFailure);
		const dead = permanent || attempts >= MAX_ATTEMPTS;

		await db
			.update(vanGeometryQueue)
			.set({
				// Written here as well as when the row was marked running: a
				// fresh row whose POST failed has had no earlier write to carry it.
				attempts,
				status: dead ? 'failed' : 'pending',
				// A dead-lettered row keeps its job id for forensics; a retrying
				// one drops it so the next attempt submits a fresh job rather
				// than polling one that already errored.
				exportJobId: dead ? exportJobId : null,
				lastError: message.slice(0, 500),
				completedAt: dead ? new Date().toISOString() : null,
			})
			.where(eq(vanGeometryQueue.turfId, item.turfId));

		if (dead) {
			result.deadLettered++;
			deadLetters.push(
				`Turf ${item.turfId} geometry gave up after ${attempts} attempt(s): ${message}`,
			);
		} else {
			result.retried++;
		}
	}

	// Fixed-size pool over a shared cursor, rather than chunking into batches of
	// two — a batch waits for its slowest member before starting the next pair,
	// which on a queue of 200 with one slow export wastes most of the budget.
	let cursor = 0;
	const width = Math.max(1, Math.floor(options.concurrency ?? MAX_CONCURRENCY));
	const workers = Array.from({ length: Math.min(width, queue.length) }, async () => {
		while (cursor < queue.length) {
			if (Date.now() >= deadline) {
				result.budgetLapsed = true;
				return;
			}
			const item = queue[cursor++]!;
			await processTimedItem(item);
		}
	});
	await Promise.all(workers);

	// batchRecount: the counts every per-turf write above left for now.
	// Caught rather than thrown: the turfs themselves are stored, and their
	// counts are already NULL — what readers fall back from to VAN's door
	// count — so one dropped connection here must not end a drain hours long.
	// The caller gets their ids, to try again.
	if (rostered.length > 0) {
		const started = Date.now();
		try {
			await recomputeUncontacted(db, {
				now: new Date(),
				campaignId: options.campaignId,
				turfIds: rostered,
			});
		} catch (err) {
			result.unrecounted = rostered;
			warnings.push(
				`Recounting doors left for ${rostered.length} turf(s) failed (${errMessage(err)}); ` +
					'they show VAN’s door count until they are recounted.',
			);
		}
		// The run's, not any one turf's — but the database's all the same, and
		// spread over the turfs it was for, it is what each of them cost.
		timings.recountMs += Date.now() - started;
		timings.dbMs += Date.now() - started;
	}

	// Once per run, not per turf: the cause is configuration and identical
	// for every row.
	if (result.rostersUnavailable > 0) {
		warnings.push(
			`${result.rostersUnavailable} turf(s) got a hull but no roster: the export CSV has no VanID ` +
				'column, so the uncontacted-door count needs export job type 5 (VoterCircle). Check ' +
				'VAN_EXPORT_JOB_TYPE_ID.',
		);
	}

	// Dead letters only. The advisory `warnings` go back to the caller, which
	// posts them alongside the rest of the sync's notices — sending both from
	// here would put every one of them into Slack twice.
	if (deadLetters.length > 0 && options.alert) {
		await options.alert(
			`[van] ${result.deadLettered} turf(s) could not get map geometry and have stopped ` +
				`retrying:\n${deadLetters.map((w) => `• ${w}`).join('\n')}`,
		);
	}

	return result;
}
