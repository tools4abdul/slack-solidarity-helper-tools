// Live-list fetchers for the settings-page pickers (NAV-3) and the save-time
// validators (settings-validation.ts). Each fetcher is fronted by a 5-minute
// module-state cache with in-flight de-duplication and a stale-serve fallback
// when a refetch fails. No DB, no HTTP route, no UI.
//
// Failure model is intentionally narrow: a fetcher returns
// `{ items, stale }` on success or stale-serve, and **rejects only** when the
// cache is cold and the fetch failed (FR-011). That lets the NAV-3 loader use
// `Promise.allSettled` to degrade one section while keeping the others.

import type { WebClient } from '@slack/web-api';
import { fetchPaginated } from './solidarity-paginate.js';
import { startWalk, finishWalk } from './walk-progress.js';
import { withSolidarityWalkLock } from './solidarity-walk-lock.js';

// ---------------------------------------------------------------------------
// Exported value types
// ---------------------------------------------------------------------------

export interface ChannelEntry {
	id: string;
	name: string;
	isPrivate: boolean;
}

export interface UserEntry {
	id: string;
	/** Display name — profile.display_name || profile.real_name || name. */
	name: string;
	/** profile.real_name; may be empty. */
	realName: string;
	/** profile.email; may be empty (bot-less humans without the email scope visible). */
	email: string;
}

export interface SolidarityChapterEntry {
	id: number;
	name: string;
}

export interface CustomPropertyEntry {
	/** The API key used in custom_user_properties payloads. */
	internalName: string;
	/** Display label; falls back to internalName when the API omits one. */
	name: string;
}

export interface UserListEntry {
	id: number;
	name: string;
}

/** One row of the Solidarity roster, used only to let an admin search for an
 *  account by name — which the API itself cannot do. Deliberately just
 *  id/name/email: the member page exists to avoid exposing personal records,
 *  and a lean row also keeps a large roster's memory footprint reasonable. */
export interface SolidarityMemberEntry {
	id: number;
	/** "First Last", falling back to alternate_name, then email, then the id. */
	name: string;
	/** Primary email, lowercased; '' when absent. */
	email: string;
	/** `other_emails`, lowercased. Members are routinely findable only by one
	 *  of these, which is often exactly why the automatic email match failed. */
	otherEmails: string[];
	/** Every chapter this member belongs to. Carried so one roster walk can
	 *  answer "who is in chapter N?" for any N — see
	 *  `getSolidarityChapterMembers`. */
	chapterIds: number[];
}

/** One member of a single Solidarity chapter, for the channel-vs-chapter diff.
 *  Only what an email match needs — the page reports emails and counts, never
 *  names, so nothing else is worth carrying (or worth shipping to a browser). */
export interface SolidarityChapterMemberEntry {
	id: number;
	/** Primary email, lowercased and trimmed; '' when the record has none. */
	email: string;
}

export interface AutocompleteResult<T> {
	/** Sorted ascending by display name. */
	items: T[];
	/** `true` when the items came from a retained cache after a refetch failed. */
	stale: boolean;
	/**
	 * Unix ms when the items in this result were originally fetched successfully.
	 * On a stale-serve (`stale: true`), this reflects the original successful
	 * fetch's timestamp, NOT the failed refetch attempt — so the NAV-3 settings
	 * page's "Last refreshed Nm ago" indicator reports how old the data the
	 * admin is picking against actually is.
	 */
	fetchedAt: number;
	/**
	 * A refresh is running in the background right now. The items returned
	 * alongside it are the previous list — or empty, if this is the very first
	 * fetch — so a caller can render what it has and tell the user that a fuller
	 * list is on its way.
	 *
	 * Optional because only `staleWhileRevalidate` callers can ever see it true;
	 * every blocking path has by definition finished fetching before it returns.
	 * Absent means false — read it as `refreshing === true`.
	 */
	refreshing?: boolean;
}

export interface AutocompleteOptions {
	/** Bypass the freshness check and refetch (the "Refresh lists" path). */
	force?: boolean;
	/**
	 * Never block on a refetch. Return whatever is cached immediately — even
	 * past the TTL, even nothing at all — and refresh in the background,
	 * reporting `refreshing: true` while that runs.
	 *
	 * For lists whose refetch is slow enough that waiting is worse than
	 * briefly-stale data. The Solidarity roster is the case this exists for: a
	 * cold walk measures around two minutes, which is an unacceptable thing to
	 * put in front of an admin mid-search, while a roster up to an hour old
	 * answers their question perfectly well.
	 */
	staleWhileRevalidate?: boolean;
}

// ---------------------------------------------------------------------------
// Cache state (module-private)
// ---------------------------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;

// `credential` is whatever identifies "who fetched this data" — the WebClient
// instance for Slack, the token string for Solidarity. If a request comes in
// with a different credential, the cached data is treated as belonging to a
// different tenant and is not served. Defensive; spec is single-tenant today.
interface CacheEntry<T, C> {
	data: T[] | null;
	fetchedAt: number;
	credential: C | null;
	// In-flight non-forced fetch, deduplicated across concurrent callers.
	// Forced fetches never use this slot — they always run their own request
	// so a forced caller can't piggy-back on a possibly-failing refetch and
	// receive a stale-flagged result (FR-009).
	inFlight: { promise: Promise<AutocompleteResult<T>>; credential: C } | null;
}

function makeEntry<T, C>(): CacheEntry<T, C> {
	return { data: null, fetchedAt: 0, credential: null, inFlight: null };
}

const channelsEntry: CacheEntry<ChannelEntry, WebClient> = makeEntry();
const usersEntry: CacheEntry<UserEntry, WebClient> = makeEntry();
const chaptersEntry: CacheEntry<SolidarityChapterEntry, string> = makeEntry();
const customPropertiesEntry: CacheEntry<CustomPropertyEntry, string> = makeEntry();
const userListsEntry: CacheEntry<UserListEntry, string> = makeEntry();
const membersEntry: CacheEntry<SolidarityMemberEntry, string> = makeEntry();

/**
 * Test-only: drop all cached lists and in-flight state so each test starts
 * from a cold cache without needing `vi.resetModules()` gymnastics. Mirrors
 * the `_resetSlackEmailCache` pattern in `src/routes/api/pending/+server.ts`.
 */
export function _resetAutocompleteCachesForTests(): void {
	Object.assign(channelsEntry, makeEntry<ChannelEntry, WebClient>());
	Object.assign(usersEntry, makeEntry<UserEntry, WebClient>());
	Object.assign(chaptersEntry, makeEntry<SolidarityChapterEntry, string>());
	Object.assign(customPropertiesEntry, makeEntry<CustomPropertyEntry, string>());
	Object.assign(userListsEntry, makeEntry<UserListEntry, string>());
	Object.assign(membersEntry, makeEntry<SolidarityMemberEntry, string>());
	Object.assign(pagesEntry, makeEntry<SolidarityChapterEntry, string>());
	Object.assign(eventsEntry, makeEntry<SolidarityChapterEntry, string>());
}

/**
 * Run one fetch, update the cache on success, or fall back to retained stale
 * data on failure (FR-010 / FR-010a). Stale data is only returned when it was
 * fetched with the *same* credential — never serve a previous tenant's data
 * after a credential change.
 */
async function runFetch<T, C>(
	entry: CacheEntry<T, C>,
	listName: string,
	credential: C,
	fetcher: () => Promise<T[]>,
): Promise<AutocompleteResult<T>> {
	try {
		const result = await fetcher();
		entry.data = result;
		entry.fetchedAt = Date.now();
		entry.credential = credential;
		return { items: result, stale: false, fetchedAt: entry.fetchedAt, refreshing: false };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (entry.data !== null && entry.credential === credential) {
			console.warn(`[autocomplete] ${listName} refetch failed; serving stale: ${msg}`);
			// `fetchedAt` deliberately reflects the original successful fetch,
			// not the failed refetch attempt (NAV-3 R2).
			return { items: entry.data, stale: true, fetchedAt: entry.fetchedAt, refreshing: false };
		}
		console.error(`[autocomplete] ${listName} fetch failed (no cached data): ${msg}`);
		throw err;
	}
}

/**
 * Shared cache state machine — TTL freshness, force bypass, in-flight de-dup,
 * and credential binding (FR-007 / FR-007a / FR-008 / FR-009 / FR-010 /
 * FR-010a / FR-011).
 */
async function getCached<T, C>(
	entry: CacheEntry<T, C>,
	listName: string,
	credential: C,
	fetcher: () => Promise<T[]>,
	opts: AutocompleteOptions = {},
	ttlMs = TTL_MS,
): Promise<AutocompleteResult<T>> {
	const now = Date.now();
	const credentialMatch = entry.credential === credential;
	const fresh = credentialMatch && entry.data !== null && now - entry.fetchedAt < ttlMs;

	if (!opts.force && fresh) {
		// Non-null assertion safe — `fresh` implies `entry.data !== null`.
		return {
			items: entry.data as T[],
			stale: false,
			fetchedAt: entry.fetchedAt,
			refreshing: entry.inFlight !== null,
		};
	}

	// Forced refresh never piggy-backs on an in-flight non-forced fetch — the
	// admin clicked "Refresh lists" precisely to escape a possibly-stale result.
	// Concurrent forced calls each issue their own upstream request (rare).
	if (opts.force) {
		return runFetch(entry, listName, credential, fetcher);
	}

	// Reuse the in-flight only if it was started with the same credential.
	if (entry.inFlight && entry.inFlight.credential === credential) {
		// Stale-while-revalidate: don't join the in-flight fetch, answer now
		// with the previous list and let the refresh finish on its own.
		if (opts.staleWhileRevalidate) {
			return servePending(entry, credential);
		}
		return entry.inFlight.promise;
	}

	const promise = runFetch(entry, listName, credential, fetcher);
	entry.inFlight = { promise, credential };
	// `.then(cleanup, cleanup)` rather than `.finally` so the cleanup branch
	// doesn't surface an unhandled rejection when the original promise rejects.
	const cleanup = () => {
		if (entry.inFlight?.promise === promise) entry.inFlight = null;
	};
	promise.then(cleanup, cleanup);

	if (opts.staleWhileRevalidate) {
		// The refresh is now running detached. Swallow its rejection here so a
		// failure can't surface as an unhandled rejection — runFetch has already
		// logged it, and the next call simply serves the retained list again.
		promise.catch(() => {});
		return servePending(entry, credential);
	}

	return promise;
}

/**
 * The immediate answer while a background refresh runs: whatever is cached,
 * flagged `refreshing`. An empty list here means the very first fetch is still
 * walking — the caller is expected to say so rather than render "no results",
 * which would be a lie.
 */
function servePending<T, C>(entry: CacheEntry<T, C>, credential: C): AutocompleteResult<T> {
	const usable = entry.data !== null && entry.credential === credential;
	return {
		items: usable ? (entry.data as T[]) : [],
		// `stale` stays reserved for its existing meaning — a retained list served
		// because a refetch *failed*. This list is simply being superseded.
		stale: false,
		fetchedAt: usable ? entry.fetchedAt : 0,
		refreshing: true,
	};
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

function byName<T extends { name: string }>(a: T, b: T): number {
	return a.name.localeCompare(b.name);
}

export function getSlackChannels(
	slack: WebClient,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<ChannelEntry>> {
	return getCached(
		channelsEntry,
		'channels',
		slack,
		async () => {
			const items: ChannelEntry[] = [];
			let cursor: string | undefined;
			do {
				const page = await slack.conversations.list({
					types: 'public_channel,private_channel',
					exclude_archived: true,
					limit: 1000,
					cursor,
				});
				for (const ch of page.channels ?? []) {
					if (ch.id && ch.name) {
						items.push({ id: ch.id, name: ch.name, isPrivate: ch.is_private === true });
					}
				}
				cursor = page.response_metadata?.next_cursor || undefined;
			} while (cursor);
			items.sort(byName);
			return items;
		},
		opts,
	);
}

export function getSlackUsers(
	slack: WebClient,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<UserEntry>> {
	return getCached(
		usersEntry,
		'users',
		slack,
		async () => {
			const items: UserEntry[] = [];
			let cursor: string | undefined;
			do {
				const page = await slack.users.list({ limit: 1000, cursor });
				for (const m of page.members ?? []) {
					if (m.is_bot || m.deleted) continue;
					if (!m.id) continue;
					const profile = m.profile;
					const display =
						profile?.display_name?.trim() || profile?.real_name?.trim() || m.name?.trim() || m.id;
					items.push({
						id: m.id,
						name: display,
						realName: profile?.real_name ?? '',
						email: profile?.email ?? '',
					});
				}
				cursor = page.response_metadata?.next_cursor || undefined;
			} while (cursor);
			items.sort(byName);
			return items;
		},
		opts,
	);
}

export function getSolidarityChapters(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityChapterEntry>> {
	return getCached(
		chaptersEntry,
		'chapters',
		token,
		async () => {
			const raw = await fetchPaginated<{ id: number; name: string }>(
				token,
				'/v1/chapters',
				'/v1/chapters',
				'',
				'autocomplete',
			);
			const items: SolidarityChapterEntry[] = raw.map((c) => ({ id: c.id, name: c.name }));
			items.sort(byName);
			return items;
		},
		opts,
	);
}

// Real response shape (verified against the live API 2026-07-05): the
// machine key lives in `key` (e.g. "petitioner-experience"); `internal_name`
// is accepted as a fallback since the write docs use that term. Entries
// without a usable key are dropped.
interface RawCustomProperty {
	id?: number | string;
	key?: string;
	internal_name?: string;
	name?: string;
	label?: string;
}

export function getSolidarityCustomProperties(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<CustomPropertyEntry>> {
	return getCached(
		customPropertiesEntry,
		'custom-properties',
		token,
		async () => {
			const raw = await fetchPaginated<RawCustomProperty>(
				token,
				'/v1/custom_user_properties',
				'/v1/custom_user_properties',
				'',
				'autocomplete',
			);
			const items: CustomPropertyEntry[] = raw
				.map((p) => ({ ...p, resolvedKey: p.key ?? p.internal_name }))
				.filter(
					(p): p is RawCustomProperty & { resolvedKey: string } =>
						typeof p.resolvedKey === 'string' && p.resolvedKey !== '',
				)
				.map((p) => ({
					internalName: p.resolvedKey,
					name: p.label ?? p.name ?? p.resolvedKey,
				}));
			items.sort(byName);
			return items;
		},
		opts,
	);
}

// The roster is the one list here that costs ceil(N/100) requests instead of a
// handful, so it gets its own, much longer TTL. It is also the slowest-changing
// list in the app — a member's name and email barely churn — and its only
// consumer is the manual-link fallback picker, where an account created in the
// last hour being briefly missing is rare and recoverable with a forced
// refresh. Refetching that every 5 minutes would burn the rate-limit budget for
// no practical gain.
const ROSTER_TTL_MS = 60 * 60 * 1000;

// ~1.67 requests/second, comfortably under Solidarity's 60-per-30s ceiling.
// Without pacing, a multi-hundred-page walk exhausts the shared retry budget on
// 429s and aborts partway through (see fetchPaginated's `paceMs`).
const ROSTER_PACE_MS = 600;

const ROSTER_WALK_KEY = 'solidarity-roster';

interface RawSolidarityUser {
	id: number;
	email?: string | null;
	first_name?: string | null;
	last_name?: string | null;
	alternate_name?: string | null;
	other_emails?: string[] | null;
	chapter_id?: number | null;
	chapter_ids?: number[] | null;
}

/** Same `chapter_ids ?? [chapter_id]` fallback the team_join handler,
 *  chapter-reconcile and the nightly snapshot each apply — `chapter_ids` is the
 *  modern field and `chapter_id` the legacy single-chapter one. */
function rawChapterIds(raw: RawSolidarityUser): number[] {
	if (raw.chapter_ids?.length) return raw.chapter_ids;
	if (raw.chapter_id != null) return [raw.chapter_id];
	return [];
}

function toMemberEntry(raw: RawSolidarityUser): SolidarityMemberEntry {
	const email = (raw.email ?? '').trim().toLowerCase();
	const full = [raw.first_name, raw.last_name]
		.map((part) => (part ?? '').trim())
		.filter(Boolean)
		.join(' ');
	// Falling all the way back to the id keeps every roster row selectable —
	// a nameless record is exactly the kind an admin may need to link.
	const name = full || (raw.alternate_name ?? '').trim() || email || `Solidarity user ${raw.id}`;
	return {
		id: raw.id,
		name,
		email,
		otherEmails: (raw.other_emails ?? [])
			.filter((e): e is string => typeof e === 'string')
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
		chapterIds: rawChapterIds(raw),
	};
}

/**
 * The full Solidarity roster, for name/email search on the manual-link picker.
 *
 * Exists because `GET /v1/users` filters by exact email or phone only — there
 * is no name search — so the sole way to answer "which Solidarity account
 * belongs to this person?" by name is to hold the list and search it locally.
 * Never send the result to the browser; use `searchSolidarityMembers` and
 * return only the matches.
 */
export function getSolidarityMembers(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityMemberEntry>> {
	return getCached(
		membersEntry,
		'solidarity-members',
		token,
		() =>
			// Queued against every other Solidarity walk: this one is paced right up
			// to the rate limit, so it must not overlap an activity walk started by
			// a different request.
			withSolidarityWalkLock(async () => {
				// The one walk in the app long enough that an admin needs to see it
				// moving — minutes, on a cold cache.
				const report = startWalk(ROSTER_WALK_KEY, 'Reading the Solidarity roster');
				try {
					const raw = await fetchPaginated<RawSolidarityUser>(
						token,
						'/v1/users',
						'/v1/users roster',
						'',
						'autocomplete',
						ROSTER_PACE_MS,
						report,
					);
					const items = raw.filter((u) => typeof u.id === 'number').map(toMemberEntry);
					items.sort(byName);
					return items;
				} finally {
					finishWalk(ROSTER_WALK_KEY);
				}
			}),
		opts,
		ROSTER_TTL_MS,
	);
}

/**
 * Every member of one Solidarity chapter, by email — the channel-vs-chapter
 * page's Solidarity side.
 *
 * Derived from the single cached roster rather than its own request, because
 * `/v1/users` does **not** honour a `chapter_ids` filter: a filtered walk was
 * measured against the live API on 2026-09-06 and came back with the entire
 * roster, at the full ~3-minute cost. Since a chapter walk is a roster walk
 * whatever we ask for, asking once and bucketing locally means the first pick
 * pays for all of them — and shares that cost with the member-lookup picker,
 * which walks the same roster.
 */
export async function getSolidarityChapterMembers(
	token: string,
	chapterId: number,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityChapterMemberEntry>> {
	const roster = await getSolidarityMembers(token, opts);
	return {
		...roster,
		items: roster.items
			.filter((m) => m.chapterIds.includes(chapterId))
			.map((m) => ({ id: m.id, email: m.email })),
	};
}

// Lookup tables for the member activity feeds. Neither /v1/user_actions nor
// /v1/event_rsvps carries a human-readable label — they reference
// `action_page_id` and `event_id` respectively — so the names have to come from
// these two lists. Both are small (hundreds of rows) and change slowly, so a
// single cached sweep is far cheaper than a per-row lookup, and one member's
// five recent actions can reference five different pages.
const NAMED_TTL_MS = 30 * 60 * 1000;

const pagesEntry: CacheEntry<SolidarityChapterEntry, string> = makeEntry();
const eventsEntry: CacheEntry<SolidarityChapterEntry, string> = makeEntry();

/** Action pages by id — `/v1/pages` exposes the label as `name`. */
export function getSolidarityPages(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityChapterEntry>> {
	return getCached(
		pagesEntry,
		'solidarity-pages',
		token,
		async () => {
			const raw = await fetchPaginated<{ id: number; name?: string | null }>(
				token,
				'/v1/pages',
				'/v1/pages',
				'',
				'member-page',
			);
			return raw
				.filter((p) => typeof p.id === 'number' && !!p.name)
				.map((p) => ({ id: p.id, name: p.name! }));
		},
		opts,
		NAMED_TTL_MS,
	);
}

/** Events by id — `/v1/events` exposes the label as `title`. */
export function getSolidarityEvents(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityChapterEntry>> {
	return getCached(
		eventsEntry,
		'solidarity-events',
		token,
		async () => {
			const raw = await fetchPaginated<{ id: number; title?: string | null }>(
				token,
				'/v1/events',
				'/v1/events',
				'',
				'member-page',
			);
			return raw
				.filter((e) => typeof e.id === 'number' && !!e.title)
				.map((e) => ({ id: e.id, name: e.title! }));
		},
		opts,
		NAMED_TTL_MS,
	);
}

export function getSolidarityUserLists(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<UserListEntry>> {
	return getCached(
		userListsEntry,
		'user-lists',
		token,
		async () => {
			const raw = await fetchPaginated<{ id: number; name?: string }>(
				token,
				'/v1/user_lists',
				'/v1/user_lists',
				'',
				'autocomplete',
			);
			const items: UserListEntry[] = raw
				.filter((l) => typeof l.id === 'number')
				.map((l) => ({ id: l.id, name: l.name ?? `List ${l.id}` }));
			items.sort(byName);
			return items;
		},
		opts,
	);
}
