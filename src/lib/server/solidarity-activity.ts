// "Who has actually done something on Solidarity lately?"
//
// Solidarity user records carry no last-active field — only `created_at` and an
// `updated_at` that bulk processes touch (a 300-record sample on 2026-09-06 had
// two thirds "updated" within six days), so it says nothing about the person.
// Real engagement lives in two other collections, and this module reduces both
// to one map of user id → most recent activity.
//
//   /v1/user_actions   form and petition page submissions. Honours
//                      `sort=created_at&order=desc`, so a window is read
//                      newest-first and stopped at the cutoff.
//   /v1/event_rsvps    event RSVPs. Ignores every sort and filter spelling
//                      tried against the live API, and comes back oldest-first
//                      — so the window is found by binary-searching the offset
//                      space for the cutoff date, then reading to the end.
//
// Both collections also accept `?user_id=`, one id at a time — `user_ids` is
// silently ignored and returns everybody, so it must never be used. That makes
// a second, targeted strategy possible: when only a handful of people's
// activity can change the answer, ask about exactly those people instead of
// reading the collections. `resolveActiveIds` picks between the two.
//
// Walks run one after the other, never together: Solidarity allows 60 requests
// per 30s and a single paced walk already sits at ~1.67/s.

import { fetchWithRetry, type RetryBudget } from './solidarity-paginate.js';
import { startWalk, finishWalk } from './walk-progress.js';
import { withSolidarityWalkLock } from './solidarity-walk-lock.js';

const PAGE_LIMIT = 100;
// Same pacing rationale as the roster walk — see ROSTER_PACE_MS.
const DEFAULT_PACE_MS = 600;
// Mutable only so tests don't spend real seconds asleep proving sequencing.
let PACE_MS = DEFAULT_PACE_MS;

export function _setPaceForTests(ms: number): void {
	PACE_MS = ms;
}
// Generous safety cap on any single walk, mirroring fetchPaginated's.
const MAX_PAGES = 800;
const TTL_MS = 30 * 60 * 1000;

/** One activity row, reduced to the only two fields this module needs. */
interface ActivityRow {
	user_id?: number | null;
	created_at?: string | null;
}

export interface ActivityWindow {
	/** Solidarity user id → unix ms of their most recent recorded activity. */
	byUser: ReadonlyMap<number, number>;
	/** The oldest instant this map is complete back to. A caller asking about a
	 *  shorter window can filter it; a longer one needs a fresh walk. */
	coveredSince: number;
}

function rowTime(row: ActivityRow): number | null {
	const ms = Date.parse(row.created_at ?? '');
	return Number.isNaN(ms) ? null : ms;
}

/** A page reader, so the walk logic can be tested without HTTP. */
export type PageReader = (offset: number) => Promise<ActivityRow[]>;

/**
 * The smallest page-aligned offset whose page could hold a row at or after
 * `sinceMs`, in a collection ordered oldest-first.
 *
 * Gallops to bracket the crossing, then bisects — around 18 requests against a
 * 47k-row collection, versus 474 to read it all.
 *
 * Returns null for exactly one reason: the collection ends before the cutoff,
 * so nothing is recent enough. Running past the page ceiling instead throws,
 * because "we couldn't look" and "we looked and found nothing" must not reduce
 * to the same answer — the second would quietly hide active people from the
 * filter.
 */
export async function findFirstPageAtOrAfter(
	readPage: PageReader,
	sinceMs: number,
	pageSize = PAGE_LIMIT,
): Promise<number | null> {
	// Every probe is an HTTP request, and both the gallop and the bisect revisit
	// offsets, so each one is read at most once.
	const seen = new Map<number, { empty: boolean; reached: boolean }>();
	const probe = async (offset: number) => {
		const memo = seen.get(offset);
		if (memo) return memo;
		const page = await readPage(offset);
		const last = page.length === 0 ? null : rowTime(page[page.length - 1]!);
		// An empty page means the collection ended; treat it as "reached" so both
		// searches below stay monotone in offset, and check emptiness separately
		// wherever it changes the answer.
		const result = {
			empty: page.length === 0,
			reached: page.length === 0 || last === null || last >= sinceMs,
		};
		seen.set(offset, result);
		return result;
	};

	const first = await probe(0);
	if (first.empty) return null;
	if (first.reached) return 0;

	let lo = 0;
	let hi = pageSize;
	for (;;) {
		const at = await probe(hi);
		if (at.reached) break;
		lo = hi;
		hi *= 2;
		if (hi > MAX_PAGES * pageSize) {
			throw new Error(
				`Solidarity collection exceeded ${MAX_PAGES * pageSize} rows while searching for the activity cutoff`,
			);
		}
	}

	// Bisect on page boundaries: lo has not reached the cutoff, hi has.
	while (hi - lo > pageSize) {
		const mid = lo + Math.floor((hi - lo) / (2 * pageSize)) * pageSize;
		if (mid === lo) break;
		if ((await probe(mid)).reached) hi = mid;
		else lo = mid;
	}

	return (await probe(hi)).empty ? null : hi;
}

/** Fold rows at or after the cutoff into the running latest-activity map. */
function record(
	byUser: Map<number, number>,
	rows: readonly ActivityRow[],
	sinceMs: number,
): number {
	let kept = 0;
	for (const row of rows) {
		const ms = rowTime(row);
		if (ms === null || ms < sinceMs) continue;
		if (typeof row.user_id !== 'number') continue;
		kept++;
		const seen = byUser.get(row.user_id);
		if (seen === undefined || ms > seen) byUser.set(row.user_id, ms);
	}
	return kept;
}

function pageUrl(path: string, offset: number, extraQuery: string): string {
	return `https://api.solidarity.tech${path}?_limit=${PAGE_LIMIT}&_offset=${offset}${extraQuery}`;
}

function makeReader(
	token: string,
	path: string,
	extraQuery: string,
	budget: RetryBudget,
): PageReader {
	return async (offset) => {
		const res = await fetchWithRetry(
			pageUrl(path, offset, extraQuery),
			{ headers: { Authorization: `Bearer ${token}` } },
			path,
			'channel-chapter-diff',
			budget,
		);
		if (!res.ok) {
			throw new Error(`Solidarity ${path} returned ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as { data?: ActivityRow[] };
		return body.data ?? [];
	};
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read forward from `startOffset` to the end, recording in-window rows. */
async function readForward(
	readPage: PageReader,
	startOffset: number,
	sinceMs: number,
	byUser: Map<number, number>,
	report: (fetched: number, total: number | null) => void,
): Promise<void> {
	let fetched = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		if (page > 0) await pause(PACE_MS);
		const rows = await readPage(startOffset + page * PAGE_LIMIT);
		if (rows.length === 0) return;
		fetched += record(byUser, rows, sinceMs);
		report(fetched, null);
		if (rows.length < PAGE_LIMIT) return;
	}
}

/** Read newest-first from the start, stopping once a page falls past the cutoff. */
async function readNewestFirst(
	readPage: PageReader,
	sinceMs: number,
	byUser: Map<number, number>,
	report: (fetched: number, total: number | null) => void,
): Promise<void> {
	let fetched = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		if (page > 0) await pause(PACE_MS);
		const rows = await readPage(page * PAGE_LIMIT);
		if (rows.length === 0) return;
		fetched += record(byUser, rows, sinceMs);
		report(fetched, null);
		const oldest = rowTime(rows[rows.length - 1]!);
		// The page crossed the cutoff, so every later page is older still.
		if (oldest !== null && oldest < sinceMs) return;
		if (rows.length < PAGE_LIMIT) return;
	}
}

interface Cached extends ActivityWindow {
	byUser: Map<number, number>;
	fetchedAt: number;
	token: string;
}

let cache: Cached | null = null;
let inFlight: { promise: Promise<ActivityWindow>; sinceMs: number; token: string } | null = null;

export function _resetActivityCacheForTests(): void {
	cache = null;
	inFlight = null;
	PACE_MS = DEFAULT_PACE_MS;
}

async function walk(token: string, sinceMs: number): Promise<ActivityWindow> {
	const byUser = new Map<number, number>();
	const budget: RetryBudget = { retriesUsed: 0 };

	const actions = makeReader(token, '/v1/user_actions', '&sort=created_at&order=desc', budget);
	const report = startWalk('solidarity-user-actions', 'Reading recent Solidarity actions');
	try {
		await readNewestFirst(actions, sinceMs, byUser, report);
	} finally {
		finishWalk('solidarity-user-actions');
	}

	// Sequential, not parallel: two paced walks at once would breach the
	// 60-requests-per-30s ceiling and spend the retry budget on self-inflicted
	// 429s.
	const rsvps = makeReader(token, '/v1/event_rsvps', '', budget);
	const rsvpReport = startWalk('solidarity-event-rsvps', 'Reading recent Solidarity RSVPs');
	try {
		const start = await findFirstPageAtOrAfter(rsvps, sinceMs);
		if (start !== null) {
			await readForward(rsvps, start, sinceMs, byUser, rsvpReport);
		}
	} finally {
		finishWalk('solidarity-event-rsvps');
	}

	return { byUser, coveredSince: sinceMs };
}

/**
 * Everyone with recorded Solidarity activity since `sinceMs`.
 *
 * One cached window serves every shorter window too — a 90-day walk answers a
 * 30-day question by filtering, so changing the input from 90 to 30 costs
 * nothing. Only reaching further back than the cached window re-walks.
 */
function usableCache(token: string, sinceMs: number): ActivityWindow | null {
	if (cache === null || cache.token !== token) return null;
	if (Date.now() - cache.fetchedAt >= TTL_MS) return null;
	if (cache.coveredSince > sinceMs) return null;
	return { byUser: cache.byUser, coveredSince: cache.coveredSince };
}

export async function getRecentActivity(token: string, sinceMs: number): Promise<ActivityWindow> {
	const cached = usableCache(token, sinceMs);
	if (cached) return cached;

	// De-duplicate concurrent callers, but only when the walk already running
	// reaches back at least as far as this caller needs. A caller wanting to
	// reach *further* back can't use it, and queues behind it instead.
	if (inFlight && inFlight.token === token && inFlight.sinceMs <= sinceMs) {
		return inFlight.promise;
	}

	const promise = withSolidarityWalkLock(async () => {
		// Our turn may have come long after we asked. Whoever went first may
		// already have covered this window — the common case when an admin
		// widens the window mid-walk — so re-check before paying again.
		const nowCached = usableCache(token, sinceMs);
		if (nowCached) return nowCached;

		const result = await walk(token, sinceMs);
		cache = {
			byUser: result.byUser as Map<number, number>,
			coveredSince: result.coveredSince,
			fetchedAt: Date.now(),
			token,
		};
		return result;
	});
	inFlight = { promise, sinceMs, token };
	const cleanup = () => {
		if (inFlight?.promise === promise) inFlight = null;
	};
	promise.then(cleanup, cleanup);
	return promise;
}

/** Solidarity user ids active at or after `sinceMs`, from a fetched window. */
export function activeIdsSince(window: ActivityWindow, sinceMs: number): Set<number> {
	const ids = new Set<number>();
	for (const [userId, ms] of window.byUser) {
		if (ms >= sinceMs) ids.add(userId);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Targeted per-user lookups
// ---------------------------------------------------------------------------

/**
 * Above this many people, reading the collections beats asking about each of
 * them. A lookup costs two paced requests (~1.2s), so 150 people is about three
 * minutes — roughly what a 30-day scan costs, and the scan result is shared
 * across every chapter and window afterwards.
 */
export const PER_USER_LOOKUP_LIMIT = 150;

/** userId → their most recent activity, or null for none found. */
const perUser = new Map<number, { latestMs: number | null; fetchedAt: number }>();

function isFresh(hit: { fetchedAt: number } | undefined): boolean {
	return hit !== undefined && Date.now() - hit.fetchedAt < TTL_MS;
}

export function _resetPerUserCacheForTests(): void {
	perUser.clear();
}

/** Newest `created_at` across every row for one user, or null. */
async function latestFor(
	token: string,
	userId: number,
	budget: RetryBudget,
): Promise<number | null> {
	let latest: number | null = null;
	const consider = (rows: readonly ActivityRow[]) => {
		for (const row of rows) {
			const ms = rowTime(row);
			if (ms !== null && (latest === null || ms > latest)) latest = ms;
		}
	};

	// Actions sort newest-first, so one row is the answer.
	const actions = makeReader(
		token,
		'/v1/user_actions',
		`&user_id=${userId}&sort=created_at&order=desc`,
		budget,
	);
	consider(await actions(0));

	// RSVPs don't sort, so every row for this person has to be seen — but that
	// is a handful of rows, not the whole collection. Paged anyway, since a
	// prolific volunteer could exceed one page.
	await pause(PACE_MS);
	const rsvps = makeReader(token, '/v1/event_rsvps', `&user_id=${userId}`, budget);
	for (let page = 0; page < MAX_PAGES; page++) {
		const rows = await rsvps(page * PAGE_LIMIT);
		consider(rows);
		if (rows.length < PAGE_LIMIT) break;
		await pause(PACE_MS);
	}
	return latest;
}

/**
 * Which of `candidateIds` were active since `sinceMs`.
 *
 * Prefers, in order: an already-cached scan that reaches back far enough (free);
 * per-user lookups when few enough people are in question; otherwise a scan.
 *
 * Per-user results are cached as an absolute "latest activity" instant rather
 * than a yes/no, so changing the window afterwards re-answers from cache
 * instead of asking again.
 */
export async function resolveActiveIds(
	token: string,
	candidateIds: readonly number[],
	sinceMs: number,
): Promise<Set<number>> {
	if (candidateIds.length === 0) return new Set();

	// A warm scan already knows about everyone; nothing to pay.
	const scanned = usableCache(token, sinceMs);
	if (scanned) return activeIdsSince(scanned, sinceMs);

	const unknown = candidateIds.filter((id) => !isFresh(perUser.get(id)));

	if (unknown.length > PER_USER_LOOKUP_LIMIT) {
		return activeIdsSince(await getRecentActivity(token, sinceMs), sinceMs);
	}

	if (unknown.length > 0) {
		await withSolidarityWalkLock(async () => {
			// Re-check now that it is our turn: a pass queued ahead of us may have
			// looked these same people up already, which is what happens when an
			// admin re-runs the same comparison mid-flight.
			const stillUnknown = unknown.filter((id) => !isFresh(perUser.get(id)));
			if (stillUnknown.length === 0) return;

			const budget: RetryBudget = { retriesUsed: 0 };
			const report = startWalk(
				'solidarity-per-user-activity',
				'Checking recent Solidarity activity',
			);
			// Publish the denominator before the first lookup, so the bar is
			// determinate immediately rather than after the first person lands.
			report(0, stillUnknown.length);
			try {
				for (const [i, id] of stillUnknown.entries()) {
					if (i > 0) await pause(PACE_MS);
					perUser.set(id, { latestMs: await latestFor(token, id, budget), fetchedAt: Date.now() });
					report(i + 1, stillUnknown.length);
				}
			} finally {
				finishWalk('solidarity-per-user-activity');
			}
		});
	}

	const active = new Set<number>();
	for (const id of candidateIds) {
		const hit = perUser.get(id);
		if (hit && hit.latestMs !== null && hit.latestMs >= sinceMs) active.add(id);
	}
	return active;
}
