// HTTP client for the NGP VAN v4 API.
//
// Auth is HTTP Basic with an unusual password: `{apiKey}|{databaseMode}`,
// where mode 0 is "My Voters" and 1 is "My Campaign". Getting the mode wrong
// does not fail loudly — it authenticates fine and returns a different, mostly
// empty database — so van-env.ts treats it as required rather than defaulted.
//
// Same import discipline as door-knock/openfield/client.ts and solidarity.ts:
// no $env or $lib/server imports, config and fetch injected, so the whole file
// is testable without a network and reusable by scripts/van-check.ts running
// outside the Vite bundle.
//
// Two deliberate conservatisms, both from plan.md Story 1.3: VAN publishes no
// rate limit, so we cap concurrency at 2 across the whole client and back off
// hard on 429/5xx. A canvass launch is the wrong moment to discover a limit by
// hitting it.

// Relative, not `$lib/...`: scripts/van-check.ts runs this file under tsx,
// outside the Vite bundle, where the alias does not resolve.
import { errMessage } from '../../err-message.js';
import type {
	VanExportJob,
	VanExportJobType,
	VanFolder,
	VanMapRegion,
	VanMinivanExport,
	VanPage,
	VanPrintedList,
	VanSavedList,
} from './types.js';

export const VAN_BASE_URL = 'https://api.securevan.com/v4';

/** 0 = My Voters, 1 = My Campaign. */
export type VanDatabaseMode = 0 | 1;

export interface VanConfig {
	/** The Application Name EveryAction issued with the key. This is the Basic
	 *  auth *username*, not a display string. */
	appName: string;
	apiKey: string;
	databaseMode: VanDatabaseMode;
	/** Overridable for tests and for any future sandbox host. */
	baseUrl?: string;
}

/** An error from VAN, carrying the HTTP status and any codes from the standard
 *  `{errors: [{code, text}]}` envelope.
 *
 *  Modelled on MobilizeError / describeFailure in the migrator: callers care
 *  about the distinction between "wrong key" (401), "key lacks this tier"
 *  (403), and "VAN is having a bad day" (5xx), and a bare Error makes each of
 *  those look like the others at 3am. */
export class VanError extends Error {
	readonly status: number;
	readonly codes: string[];
	readonly path: string;

	constructor(path: string, status: number, codes: string[], text: string) {
		super(`VAN ${path} returned ${status}${text ? `: ${text}` : ''}`);
		this.name = 'VanError';
		this.status = status;
		this.codes = codes;
		this.path = path;
	}

	/** True for the two statuses that mean "this will never work as configured"
	 *  — a bad key or a tier the key was not granted. Callers surface these to
	 *  a human instead of retrying tonight. */
	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

type FetchFn = typeof fetch;

// Retry budget per request. VAN publishes no limit, so these are guesses on
// the safe side: ~1s, 2s, 4s, 8s, capped by Retry-After when VAN sends one.
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// Concurrency across the whole client, not per call site.
const MAX_CONCURRENCY = 2;
// VAN's documented maximum $top for /printedLists. Other endpoints allow more,
// but this one 400s rather than clamping.
const PRINTED_LISTS_PAGE_SIZE = 50;
// /minivanExports caps $top at 50 too — verified: 100 and above 400 with
// INVALID_PARAMETER. Its DEFAULT is 10.
const MINIVAN_EXPORTS_PAGE_SIZE = 50;
const SAVED_LISTS_PAGE_SIZE = 100;
// Safety cap on a paginated walk. VAN pages at 50-200 depending on endpoint,
// so this is far above any real folder while still bounding a server that
// hands back a self-referencing nextPageLink.
const MAX_PAGES = 200;

/**
 * A paginated walk that could not be finished.
 *
 * Deliberately NOT a VanError: nothing here is an HTTP status, and it must
 * never read as an auth failure, which callers treat as "this will never work
 * as configured" rather than "try again next tick".
 */
export class VanIncompleteError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`VAN ${path} pagination did not complete: ${reason}`);
		this.name = 'VanIncompleteError';
		this.path = path;
	}
}

export interface VanClient {
	/** Every folder the key can see. */
	folders(): Promise<VanFolder[]>;
	/** Map regions in a folder, each with its routes. */
	mapRegions(folderId: number): Promise<VanMapRegion[]>;
	/** Printed lists, optionally scoped to folders. Cross-check and backfill
	 *  for `mapRoutes[].printedList.number` (plan.md Story 2.3). */
	printedLists(folderIds?: number[]): Promise<VanPrintedList[]>;
	savedLists(folderId?: number): Promise<VanSavedList[]>;
	/** MiniVAN exports generated on or after `generatedAfter` (a `YYYY-MM-DD`
	 *  date), oldest-first, canvassers expanded — evidence of turf assigned by
	 *  hand outside this app (plan.md Story 8.1). Tier 3.
	 *
	 *  Reads at most `maxPages` pages of 50. `complete` is false when that cap
	 *  stopped the walk, so the caller can resume from the last date it got. */
	minivanExportsSince(
		generatedAfter: string,
		maxPages: number,
	): Promise<{ items: VanMinivanExport[]; complete: boolean }>;
	/** Ask VAN to re-cut a region against current data. Asynchronous on VAN's
	 *  side: counts must be re-read later, never in the same request. */
	refreshMapRegion(folderId: number, mapRegionId?: number): Promise<void>;
	/** Export job types this key actually has. Ids are per-developer, so the
	 *  `101` in VAN's docs is an example and hardcoding it fails. */
	exportJobTypes(): Promise<VanExportJobType[]>;
	/** `webhookUrl` is REQUIRED by VAN, not optional as the docs imply — a POST
	 *  without it 400s with three INVALID_PARAMETER errors. It must be HTTPS,
	 *  and VAN posts the finished job envelope (downloadUrl included) to it, so
	 *  it has to be a host we control. */
	createExportJob(input: {
		savedListId: number;
		exportJobTypeId: number;
		webhookUrl: string;
	}): Promise<VanExportJob>;
	exportJob(exportJobId: number): Promise<VanExportJob>;
	/** Escape hatch for one-off reads (scripts/van-check.ts). */
	get<T>(path: string): Promise<T>;
}

function authHeader(config: VanConfig): string {
	const password = `${config.apiKey}|${config.databaseMode}`;
	return `Basic ${Buffer.from(`${config.appName}:${password}`).toString('base64')}`;
}

/** Codes and text out of VAN's `{errors: [...]}` envelope. Never throws — a
 *  non-JSON error body (an HTML 502 from a proxy) still has to produce a
 *  usable message. */
function parseErrorBody(body: string): { codes: string[]; text: string } {
	try {
		const parsed = JSON.parse(body) as { errors?: Array<{ code?: string; text?: string }> };
		const errors = parsed.errors ?? [];
		if (errors.length > 0) {
			return {
				codes: errors.map((e) => e.code ?? '').filter(Boolean),
				text: errors
					.map((e) => e.text ?? e.code ?? '')
					.filter(Boolean)
					.join('; '),
			};
		}
	} catch {
		// fall through to the raw body
	}
	return { codes: [], text: body.slice(0, 300) };
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	const parsed = parseInt(retryAfter ?? '', 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		return Math.min(parsed * 1000, MAX_BACKOFF_MS);
	}
	return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

export function createVanClient(config: VanConfig, fetchFn: FetchFn = fetch): VanClient {
	const baseUrl = (config.baseUrl ?? VAN_BASE_URL).replace(/\/+$/, '');
	const headers = {
		Authorization: authHeader(config),
		Accept: 'application/json',
	};

	// Simple FIFO semaphore. Every request — paginated walks included — passes
	// through here, so a caller that fans out over 200 turfs still only has two
	// requests in flight.
	let active = 0;
	const waiting: Array<() => void> = [];

	/**
	 * At most MAX_CONCURRENCY calls in flight.
	 *
	 * The slot is TRANSFERRED to a waiter rather than released and re-taken.
	 * Decrementing first and waking a waiter afterwards opens a gap: the woken
	 * waiter's `active++` runs a microtask later, so a fresh caller arriving in
	 * between sees a free slot, takes it, and the waiter then takes one too —
	 * three in flight against a limit of two.
	 */
	async function withSlot<T>(run: () => Promise<T>): Promise<T> {
		if (active >= MAX_CONCURRENCY) {
			// Resuming here means a slot was handed over, already counted.
			await new Promise<void>((resolve) => waiting.push(resolve));
		} else {
			active++;
		}
		try {
			return await run();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	}

	/** One request with retry on 429 and 5xx. 4xx other than 429 throws
	 *  immediately — a 403 means the key lacks the tier, and retrying it four
	 *  more times just delays the error a human needs to see. */
	async function request(path: string, init: RequestInit = {}): Promise<Response> {
		const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
		return withSlot(async () => {
			let lastError: unknown = null;
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				const isLast = attempt === MAX_ATTEMPTS - 1;
				let res: Response;
				try {
					res = await fetchFn(url, { ...init, headers: { ...headers, ...init.headers } });
				} catch (err) {
					// Network-level failure (DNS, reset, timeout). Retryable.
					lastError = err;
					if (!isLast) await new Promise((r) => setTimeout(r, backoffMs(attempt, null)));
					continue;
				}
				if (res.ok) return res;
				if (res.status === 429 || res.status >= 500) {
					const body = await res.text().catch(() => '');
					lastError = new VanError(
						path,
						res.status,
						parseErrorBody(body).codes,
						body.slice(0, 300),
					);
					if (!isLast) {
						const wait = backoffMs(attempt, res.headers.get('Retry-After'));
						console.warn(`[van] ${path} ${res.status} — retrying in ${Math.round(wait / 1000)}s`);
						await new Promise((r) => setTimeout(r, wait));
					}
					continue;
				}
				const body = await res.text().catch(() => '');
				const { codes, text } = parseErrorBody(body);
				throw new VanError(path, res.status, codes, text);
			}
			if (lastError instanceof VanError) throw lastError;
			throw new VanError(path, 0, [], `request failed: ${errMessage(lastError)}`);
		});
	}

	async function getJson<T>(path: string): Promise<T> {
		const res = await request(path);
		const body = await res.text();
		if (!body.trim()) return undefined as T;
		try {
			return JSON.parse(body) as T;
		} catch (err) {
			throw new VanError(path, res.status, [], `non-JSON response: ${errMessage(err)}`);
		}
	}

	/**
	 * Walk `{items, nextPageLink}` pages. `nextPageLink` is an absolute URL, so
	 * it is passed through `request` unchanged.
	 *
	 * Both ways of stopping early THROW rather than returning what was read so
	 * far, because a short array and a complete one are indistinguishable to
	 * every caller. That ambiguity is dangerous on `mapRegions`: the catalog
	 * sync treats a folder it read as authoritative and retires every turf it
	 * did not see, so a truncated walk stamps `retiredAt` on live routes and
	 * releases the claims of volunteers already out walking them. Failing is
	 * what the sync's per-folder error path is for — it skips the folder and
	 * leaves its turf exactly as it was.
	 */
	async function paginate<T>(path: string): Promise<T[]> {
		const all: T[] = [];
		// Cycle guard. Comparing each link to the previous one is not enough —
		// the first `next` is a relative path while `nextPageLink` is absolute,
		// so a server pointing at itself would slip through the first check and
		// only stop a page later. Resolving before comparing also catches
		// longer cycles (A → B → A) that a one-step check never would.
		const visited = new Set<string>();
		let next: string | null = path;
		for (let page = 0; page < MAX_PAGES && next; page++) {
			const absolute = next.startsWith('http') ? next : `${baseUrl}${next}`;
			if (visited.has(absolute)) {
				throw new VanIncompleteError(path, `pagination cycled back to ${absolute}`);
			}
			visited.add(absolute);
			const body: VanPage<T> = await getJson<VanPage<T>>(next);
			const items = body?.items ?? [];
			all.push(...items);
			// An empty page is the end, whatever nextPageLink says. Verified live:
			// /savedLists with 89 records answers `$skip=100` with no items and a
			// link to `$skip=150`, and so on forever — every walk of it ran into
			// MAX_PAGES and threw. Pages are $skip offsets, so nothing can follow
			// an empty one.
			next = items.length > 0 ? (body?.nextPageLink ?? null) : null;
		}
		if (next) {
			throw new VanIncompleteError(path, `more than ${MAX_PAGES} pages`);
		}
		return all;
	}

	function query(params: Record<string, string | number | undefined>): string {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== '') search.set(key, String(value));
		}
		const qs = search.toString();
		return qs ? `?${qs}` : '';
	}

	return {
		folders: () => paginate<VanFolder>('/folders'),

		mapRegions: (folderId) => paginate<VanMapRegion>(`/folders/${folderId}/mapRegions`),

		printedLists: (folderIds) =>
			paginate<VanPrintedList>(
				// $top is capped at 50 on this endpoint — asking for more is a
				// 400 (INVALID_PARAMETER), not a silent clamp. `paginate` walks
				// nextPageLink, so the only cost of the smaller page is more
				// round trips.
				//
				// folderIds is DEDUPLICATED because a repeated id makes VAN
				// return 500. Verified against the live API: `folderIds=2731`
				// answers 200, `folderIds=2731,2731` answers 500 — one duplicate
				// is enough, and the id itself is perfectly valid.
				//
				// Callers hit this without doing anything obviously wrong. The
				// catalog sync builds the list from the chapter → folder
				// mapping, and mapping two chapters to one folder (a shared
				// county folder, or a half-finished edit in /settings) yields
				// the same id twice. It presents as VAN being down: a 500 that
				// burns the whole retry budget before degrading, ~15 seconds of
				// backoff for a request that could never have succeeded.
				//
				// Deduplicated here rather than in sync.ts so every caller is
				// covered — this is a property of the endpoint, and the next
				// caller should not have to rediscover it. A Set keeps first-seen
				// order, so the URL stays stable across runs.
				`/printedLists${query({
					folderIds: folderIds && [...new Set(folderIds)].join(','),
					$top: PRINTED_LISTS_PAGE_SIZE,
				})}`,
			),

		// $top=100 is this endpoint's maximum (200 is a 400), versus a default of 50.
		savedLists: (folderId) =>
			paginate<VanSavedList>(`/savedLists${query({ folderId, $top: SAVED_LISTS_PAGE_SIZE })}`),

		/**
		 * Read /minivanExports forward from a date.
		 *
		 * `generatedAfter` is the only way to reach recent exports. The table
		 * holds 645,000+ records and the unfiltered endpoint serves them in no
		 * date order — verified live on 2026-09-23: page one is 2012, offset
		 * 300,000 is late 2024, offset 600,000 is 2018, and the last page is
		 * 2014. The walk this replaces assumed the tail was the newest and read
		 * the last 1,000, which was an effectively random slice that moved as
		 * rows were added, so turf flickered in and out of "assigned in VAN" from
		 * one sync to the next.
		 *
		 * The code once concluded the date filters were ignored. It had tried
		 * `createdAfter` and `createdSince`; VAN's parameter is `generatedAfter`
		 * (and `generatedBefore`), and it does filter. Filtered results come back
		 * oldest-first and page with `$skip`, so a capped walk can be resumed.
		 *
		 * Date only, no time. A time with `Z` is shifted by what looks like the
		 * campaign's UTC offset, because `dateCreated` is local time wearing a
		 * `Z`. A bare date is compared against that same local date, so the
		 * caller re-reads its newest day rather than reasoning about timezones.
		 *
		 * An empty body THROWS rather than reading as "nothing new": the caller
		 * marks the store caught up on `complete`, and a blank 200 must not do
		 * that.
		 */
		async minivanExportsSince(generatedAfter, maxPages) {
			const path = `/minivanExports${query({
				$expand: 'canvassers',
				$top: MINIVAN_EXPORTS_PAGE_SIZE,
				generatedAfter,
			})}`;
			const items: VanMinivanExport[] = [];
			const visited = new Set<string>();
			let next: string | null = path;
			for (let page = 0; page < maxPages && next; page++) {
				const absolute = next.startsWith('http') ? next : `${baseUrl}${next}`;
				if (visited.has(absolute)) {
					throw new VanIncompleteError(path, `pagination cycled back to ${absolute}`);
				}
				visited.add(absolute);
				const body: VanPage<VanMinivanExport> | undefined = await getJson<
					VanPage<VanMinivanExport> | undefined
				>(next);
				if (!body) throw new VanIncompleteError(path, 'empty response body');
				const pageItems: VanMinivanExport[] = body.items ?? [];
				items.push(...pageItems);
				// As in `paginate`: an empty page is the end, whatever
				// nextPageLink says.
				next = pageItems.length > 0 ? (body.nextPageLink ?? null) : null;
			}
			return { items, complete: next === null };
		},

		async refreshMapRegion(folderId, mapRegionId) {
			const path =
				mapRegionId === undefined
					? `/folders/${folderId}/mapRegions/refresh`
					: `/folders/${folderId}/mapRegions/${mapRegionId}/refresh`;
			await request(path, { method: 'POST' });
		},

		exportJobTypes: () => paginate<VanExportJobType>('/exportJobTypes'),

		async createExportJob({ savedListId, exportJobTypeId, webhookUrl }) {
			const res = await request('/exportJobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ savedListId, type: exportJobTypeId, webhookUrl }),
			});
			return (await res.json()) as VanExportJob;
		},

		exportJob: (exportJobId) => getJson<VanExportJob>(`/exportJobs/${exportJobId}`),

		get: <T>(path: string) => getJson<T>(path),
	};
}
