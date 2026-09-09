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

import { eq, inArray, sql } from 'drizzle-orm';
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
 *  entirely, so the cap is repeated here over whole items. */
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

export interface GeometryWorkerOptions {
	/** VAN's per-developer export job type id — 5 (VoterCircle) on this key.
	 *  Type 4 has no coordinate columns and produces a loud extract failure. */
	exportJobTypeId: number;
	/** Absolute HTTPS URL on a host we control, built for ONE turf.
	 *
	 *  Per turf rather than one URL for the whole run because VAN stores this
	 *  string against the job and echoes it back on every later read, so it
	 *  carries a capability token scoped to that turf instead of a shared
	 *  secret — see webhook-token.ts. Called immediately before each POST. */
	webhookUrlFor: (mapRouteId: number) => string;
	now?: Date;
	timeBudgetMs?: number;
	/** Cap on items per run. Null means "as many as the budget allows". */
	maxItems?: number | null;
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
	/** Advisory notes about turfs that SUCCEEDED — no usable coordinates, or a
	 *  hull far too large to be a walking route. Never carries a dead letter;
	 *  those are in `deadLetters`. */
	warnings: string[];
}

interface QueueItem {
	mapRouteId: number;
	savedListId: number;
	exportJobId: number | null;
	attempts: number;
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
		retried: 0,
		deadLettered: 0,
		deadLetters,
		stillRunning: 0,
		budgetLapsed: false,
		warnings,
	};

	// Resumable rows first — they already cost an export job, so finishing one
	// is cheaper than starting a new one, and leaving them behind a backlog of
	// fresh work is how a turf ends up stranded without a shape forever.
	// A `running` row with no job id is a crash between the status write and
	// the POST; it is indistinguishable from pending, so treat it as such.
	const items = (await db
		.select({
			mapRouteId: vanGeometryQueue.mapRouteId,
			savedListId: vanGeometryQueue.savedListId,
			exportJobId: vanGeometryQueue.exportJobId,
			attempts: vanGeometryQueue.attempts,
		})
		.from(vanGeometryQueue)
		// `running` is included whether or not it has a job id: with one it is
		// resumable by polling, without one it is a crash between the status
		// write and the POST and is indistinguishable from pending. The ORDER BY
		// below is what separates the two, not the filter.
		.where(inArray(vanGeometryQueue.status, ['pending', 'running']))
		.orderBy(
			// Resumable (has a job id) before fresh, then fewest attempts first
			// so a poison row cannot monopolise every run.
			sql`case when ${vanGeometryQueue.exportJobId} is null then 1 else 0 end`,
			vanGeometryQueue.attempts,
			vanGeometryQueue.mapRouteId,
		)) as QueueItem[];

	const queue = options.maxItems == null ? items : items.slice(0, options.maxItems);
	if (queue.length === 0) return result;

	/** One turf, start to finish. Returns nothing; records its own outcome. */
	async function processItem(item: QueueItem): Promise<void> {
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

		await db
			.update(vanGeometryQueue)
			.set({
				status: 'running',
				attempts,
				requestedAt: now.toISOString(),
				lastError: null,
			})
			.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));

		try {
			// Resume by polling; otherwise submit. Both paths converge on a job
			// that either carries a downloadUrl or does not yet.
			let job: VanExportJob;
			if (item.exportJobId !== null) {
				job = await client.exportJob(item.exportJobId);
			} else {
				job = await client.createExportJob({
					savedListId: item.savedListId,
					exportJobTypeId: options.exportJobTypeId,
					webhookUrl: options.webhookUrlFor(item.mapRouteId),
				});
				// Persisted before the download so a crash mid-download resumes
				// by polling instead of submitting a second job.
				exportJobId = job.exportJobId;
				await db
					.update(vanGeometryQueue)
					.set({ exportJobId })
					.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));
			}

			// Small lists are already Completed here and skip the loop entirely.
			for (let poll = 0; poll < MAX_POLLS && !job.downloadUrl; poll++) {
				if (isTerminal(job.status, 'error')) break;
				if (Date.now() >= deadline) break;
				await sleep(POLL_INTERVAL_MS);
				job = await client.exportJob(job.exportJobId);
			}

			if (isTerminal(job.status, 'error')) {
				throw new Error(`VAN reported the export job failed (${job.errorCode ?? 'no code'})`);
			}

			if (!job.downloadUrl) {
				// Not a failure — the job is simply still running. Leave it
				// resumable and DO NOT count the attempt against it, or a slow
				// export would dead-letter itself by being polled four times.
				await db
					.update(vanGeometryQueue)
					.set({ status: 'running', attempts: priorAttempts })
					.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));
				result.stillRunning++;
				return;
			}

			// The poll loop above can return with the budget spent or nearly so.
			// Starting a download-and-extract we cannot finish would overrun the
			// request the scheduled sync is allowed; the job id is already
			// stored, so leaving the row resumable costs one GET on the next run.
			if (deadline - Date.now() < MIN_DOWNLOAD_MS) {
				await db
					.update(vanGeometryQueue)
					.set({ status: 'running', attempts: priorAttempts })
					.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));
				result.stillRunning++;
				result.budgetLapsed = true;
				return;
			}

			// Plain fetch, deliberately not client.get(): the blob host is not
			// api.securevan.com, and the URL carries its own signature. Sending
			// the VAN Basic header here would hand our credentials to Azure.
			// The signal is the only thing bounding this: a blob that trickles
			// is otherwise outside every budget in the file, and it aborts the
			// body stream as well as the request.
			const res = await fetchFn(job.downloadUrl, {
				signal: AbortSignal.timeout(deadline - Date.now()),
			});
			if (!res.ok) {
				// Drain the body before abandoning it, or the connection is held
				// until GC gets round to it.
				await res.body?.cancel().catch(() => {});
				throw new Error(`downloadUrl returned HTTP ${res.status}`);
			}
			// `undefined` means "use the default geocoder"; an explicit `null`
			// means "do not geocode at all". `??` would collapse those two, so
			// the distinction is spelled out.
			//
			// The default is wrapped rather than passed bare so the run's
			// deadline reaches it: MAX_BATCHES requests at the geocoder's own
			// timeout is five minutes for ONE turf, which is longer than the
			// whole request the scheduled sync gets.
			const extract = await extractHull(responseChunks(res), {
				geocode:
					options.geocode === undefined
						? (rows) => geocodeAddresses(rows, fetch, { deadline })
						: options.geocode,
			});

			// routeSize is read now rather than carried from the queue row: the
			// hull is only valid against the route as it stands at extraction
			// time, and that is exactly what hullSourceRouteSize records.
			const [turf] = await db
				.select({ routeSize: vanTurfs.routeSize })
				.from(vanTurfs)
				.where(eq(vanTurfs.mapRouteId, item.mapRouteId))
				.limit(1);

			const hasHull = extract.hull.length >= 3;
			await db
				.update(vanTurfs)
				.set({
					hullJson: hasHull ? JSON.stringify(extract.hull) : null,
					centroidLat: extract.centre?.lat ?? null,
					centroidLng: extract.centre?.lng ?? null,
					// Null when there is no geometry at all, so `needsGeometry`
					// re-queues it rather than treating "no hull" as settled.
					hullSourceRouteSize: extract.centre ? (turf?.routeSize ?? 0) : null,
				})
				.where(eq(vanTurfs.mapRouteId, item.mapRouteId));

			await db
				.update(vanGeometryQueue)
				.set({ status: 'done', completedAt: new Date().toISOString(), lastError: null })
				.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));

			result.geocodedFromAddress += extract.geocodedFromAddress;
			if (hasHull) result.hullsStored++;
			else if (extract.centre) result.centroidsOnly++;
			else result.noGeometry++;

			if (!extract.centre) {
				warnings.push(
					`Turf ${item.mapRouteId}: export returned ${extract.rowCount} row(s) but no usable ` +
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
						? `Turf ${item.mapRouteId}: addresses span ~${km} km across only ` +
								`${extract.pointCount} coordinate(s) — too few to tell a mis-scoped saved list ` +
								`from a map region that is simply sparsely populated. The shape is stored; ` +
								`treat it as approximate rather than as a turf boundary.`
						: `Turf ${item.mapRouteId}: addresses span ~${km} km across ` +
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
				status: dead ? 'failed' : 'pending',
				// A dead-lettered row keeps its job id for forensics; a retrying
				// one drops it so the next attempt submits a fresh job rather
				// than polling one that already errored.
				exportJobId: dead ? exportJobId : null,
				lastError: message.slice(0, 500),
				completedAt: dead ? new Date().toISOString() : null,
			})
			.where(eq(vanGeometryQueue.mapRouteId, item.mapRouteId));

		if (dead) {
			result.deadLettered++;
			deadLetters.push(
				`Turf ${item.mapRouteId} geometry gave up after ${attempts} attempt(s): ${message}`,
			);
		} else {
			result.retried++;
		}
	}

	// Fixed-size pool over a shared cursor, rather than chunking into batches of
	// two — a batch waits for its slowest member before starting the next pair,
	// which on a queue of 200 with one slow export wastes most of the budget.
	let cursor = 0;
	const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
		while (cursor < queue.length) {
			if (Date.now() >= deadline) {
				result.budgetLapsed = true;
				return;
			}
			const item = queue[cursor++]!;
			await processItem(item);
		}
	});
	await Promise.all(workers);

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
