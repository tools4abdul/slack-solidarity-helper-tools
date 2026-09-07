// Shared offset paginator for Solidarity's `/v1/*` endpoints. Both the nightly
// snapshot job and the settings-page autocomplete fetchers call this.
//
// Intentionally has no `$env/*` or `$lib/*` imports so the standalone
// scripts/solidarity-snapshot.ts (which runs outside the Vite bundle via tsx)
// can resolve it by relative path. Only `fetch`, `console`, and `setTimeout`.

const PAGE_LIMIT = 100;
// Generous safety cap; callers early-terminate via a short final page.
const MAX_PAGES = 500;
// Retry budget for 429s. For fetchPaginated, one budget spans an entire
// paginated walk, not a single page — the previous per-page implementation
// (`page--; continue;`, uncapped) could spin forever on a persistent rate
// limit (FR-004a). For single-request callers (see fetchWithRetry), each
// call gets its own fresh budget instead.
const MAX_RETRIES = 5;
// Upper bound on Retry-After honoring — a hostile or buggy upstream returning
// a huge value must not block the loader indefinitely. The retry budget still
// applies on top of this.
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

function parseRetryAfter(raw: string | null): number {
	const parsed = parseInt(raw ?? '', 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETRY_AFTER_SECONDS;
	return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
}

/** Tracks retries used against a MAX_RETRIES budget. Pass the same object
 *  to share across an entire walk or pass a fresh `{ retriesUsed: 0 }` to budget
 *  per call.
 */
export interface RetryBudget {
	retriesUsed: number;
}

/**
 * Fetch with bounded retry on 429, honoring `Retry-After`. Throws once
 * `budget` is exhausted; any other status is returned as-is.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	label: string,
	logTag: string,
	budget: RetryBudget,
): Promise<Response> {
	for (;;) {
		const res = await fetch(url, init);
		if (res.status !== 429) return res;
		if (budget.retriesUsed >= MAX_RETRIES) {
			throw new Error(
				`Solidarity ${label} rate-limit retry budget exhausted (${MAX_RETRIES} retries)`,
			);
		}
		budget.retriesUsed++;
		const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
		console.warn(`[${logTag}] solidarity rate limited — waiting ${retryAfter}s`);
		await new Promise((r) => setTimeout(r, retryAfter * 1000));
	}
}

/**
 * Walk every offset page of a Solidarity `/v1/*` resource and return the
 * concatenated `data` arrays. Honors `Retry-After` on 429 with a bounded
 * retry budget shared across the whole walk; throws once the budget is
 * exhausted or on any non-429 error.
 *
 * `logTag` prefixes the rate-limit warn line so callers (snapshot vs.
 * autocomplete) can be distinguished in logs.
 *
 * `paceMs` sleeps between pages. Defaults to 0 (unchanged for every existing
 * caller), but a long walk needs it: the retry budget above is shared across
 * the *whole* walk, so a caller paginating hundreds of pages flat-out will
 * exceed Solidarity's 60-requests-per-30-seconds limit far more than
 * MAX_RETRIES times and abort partway through. Pacing under the limit means
 * such a walk never gets a 429 in the first place, leaving the budget for
 * genuine contention.
 */
/**
 * Called as each page lands, with the rows read so far and how many exist.
 *
 * `total` is `null` whenever upstream won't say. Solidarity's `meta.total_count`
 * is only a real collection total on some resources — on /v1/user_actions it
 * just echoes back the page limit — so it is trusted only when it exceeds the
 * page just returned, and reported as unknown otherwise. A wrong denominator is
 * worse than none: it draws a progress bar that lies.
 */
export type PageProgress = (fetched: number, total: number | null) => void;

interface PaginatedBody<T> {
	data?: T[];
	meta?: { total_count?: unknown };
}

export async function fetchPaginated<T>(
	apiToken: string,
	path: string,
	resourceLabel: string,
	extraQuery = '',
	logTag = 'solidarity',
	paceMs = 0,
	onProgress?: PageProgress,
): Promise<T[]> {
	const all: T[] = [];
	const budget: RetryBudget = { retriesUsed: 0 };
	for (let page = 0; page < MAX_PAGES; page++) {
		if (paceMs > 0 && page > 0) {
			await new Promise((r) => setTimeout(r, paceMs));
		}
		const offset = page * PAGE_LIMIT;
		const url = `https://api.solidarity.tech${path}?_limit=${PAGE_LIMIT}&_offset=${offset}${extraQuery}`;
		const res = await fetchWithRetry(
			url,
			{ headers: { Authorization: `Bearer ${apiToken}` } },
			resourceLabel,
			logTag,
			budget,
		);
		if (!res.ok) {
			throw new Error(`Solidarity ${resourceLabel} returned ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as PaginatedBody<T>;
		const items = body.data ?? [];
		all.push(...items);
		if (onProgress) {
			const claimed = body.meta?.total_count;
			const total =
				typeof claimed === 'number' && Number.isFinite(claimed) && claimed > items.length
					? claimed
					: null;
			onProgress(all.length, total);
		}
		if (items.length < PAGE_LIMIT) break;
	}
	return all;
}
