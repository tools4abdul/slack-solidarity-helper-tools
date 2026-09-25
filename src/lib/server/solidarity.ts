import { errMessage } from '../err-message.js';
import { SOLIDARITY_API_TOKEN } from './env.js';
import { fetchPaginated, fetchWithRetry } from './solidarity-paginate.js';
import {
	normalizeActivityList,
	type NormalizedActivity,
	type NormalizeOptions,
} from './activity-feed.js';
import {
	getSolidarityPages,
	getSolidarityEvents,
	getSolidarityChapters,
} from './autocomplete-sources.js';

export interface SolidarityUser {
	id: number;
	chapter_id: number | null;
	chapter_ids: number[];
	address: {
		city: string | null;
		state: string | null;
		zip_code?: string | null;
	} | null;
}

/**
 * Look up a Solidarity user by email. THROWS on network/HTTP failures instead
 * of returning null — null strictly means "no account with this email". The
 * reconciliation diff depends on that distinction (a swallowed 500 must not
 * misclassify someone as account-less); lenient callers wrap it, see
 * getUserByEmail.
 */
export async function findUserByEmailStrict(
	token: string,
	email: string,
): Promise<SolidarityUser | null> {
	const url = `https://api.solidarity.tech/v1/users?email=${encodeURIComponent(email)}&_limit=1`;
	const response = await fetchWithRetry(
		url,
		{ headers: { Authorization: `Bearer ${token}` } },
		`user lookup for ${email}`,
		'solidarity',
		{ retriesUsed: 0 },
	);
	if (!response.ok) {
		throw new Error(`Solidarity user lookup returned ${response.status} for ${email}`);
	}
	const data = (await response.json()) as { data?: SolidarityUser[] };
	return data.data?.[0] ?? null;
}

/**
 * Fetch one Solidarity user by id. Returns null when no such user exists;
 * throws on any other failure.
 *
 * The response envelope is unpublished and `GET /v1/users` (plural, filtered)
 * wraps its result in `data: []` while a by-id GET plausibly returns either a
 * bare object or `data: {}`, so all three shapes are accepted rather than
 * betting on one.
 */
export async function getUserById(token: string, userId: number): Promise<SolidarityUser | null> {
	const response = await fetchWithRetry(
		`https://api.solidarity.tech/v1/users/${userId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
		`user lookup for ${userId}`,
		'solidarity',
		{ retriesUsed: 0 },
	);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`Solidarity user lookup returned ${response.status} for ${userId}`);
	}

	const body: unknown = await response.json();
	if (body === null || typeof body !== 'object') return null;

	const payload = 'data' in body ? (body as { data: unknown }).data : body;
	const user = Array.isArray(payload) ? payload[0] : payload;
	if (user === null || typeof user !== 'object') return null;
	return typeof (user as SolidarityUser).id === 'number' ? (user as SolidarityUser) : null;
}

/**
 * Lenient wrapper for flows where a failed lookup should degrade to "treat as
 * no account" rather than abort (the team_join welcome flow). Logs and
 * returns null on any failure.
 */
export async function getUserByEmail(email: string): Promise<SolidarityUser | null> {
	try {
		return await findUserByEmailStrict(SOLIDARITY_API_TOKEN, email);
	} catch (err) {
		console.error(`[solidarity] user lookup failed for ${email}:`, errMessage(err));
		return null;
	}
}

// ---------------------------------------------------------------------------
// Coalition reconciliation support
// ---------------------------------------------------------------------------

export interface SolidarityListUser {
	id: number;
	email: string | null;
	first_name?: string | null;
	last_name?: string | null;
}

/** Every member of a Solidarity user list (the per-coalition dynamic list). */
export function getUsersInList(token: string, listId: number): Promise<SolidarityListUser[]> {
	return fetchPaginated<SolidarityListUser>(
		token,
		'/v1/users',
		`/v1/users?user_list_ids=${listId}`,
		`&user_list_ids=${listId}`,
		'reconcile',
	);
}

/**
 * Mark a user as in a coalition: set the coalition's custom property.
 * `append_custom_user_properties: true` merges with whatever is already on the
 * user, so other properties (and other coalitions) are never clobbered.
 */
export async function setUserCustomProperty(
	token: string,
	userId: number,
	internalName: string,
	value: string,
): Promise<void> {
	const response = await fetchWithRetry(
		`https://api.solidarity.tech/v1/users/${userId}`,
		{
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				custom_user_properties: { [internalName]: value },
				append_custom_user_properties: true,
			}),
		},
		`user update for ${userId}`,
		'solidarity',
		{ retriesUsed: 0 },
	);
	if (!response.ok) {
		throw new Error(`Solidarity user update returned ${response.status}: ${await response.text()}`);
	}
}

// ---------------------------------------------------------------------------
// Member activity (the member lookup page)
// ---------------------------------------------------------------------------

export interface ActivityFeed {
	items: NormalizedActivity[];
	/** `meta.total_count` when the API reports it. */
	totalCount: number | null;
	/** The API filled a whole page, so there may be rows we never saw. Since
	 *  the default sort order is undocumented, those could in principle be more
	 *  recent than what we're showing — surfaced as a footnote rather than
	 *  silently trusted. */
	truncated: boolean;
}

// One max-size page rather than `_limit=5`. The sort order of both endpoints is
// undocumented, so asking for 5 could hand back the five *oldest* rows; we take
// a full page and sort locally instead. 100 is the API maximum and covers every
// member with fewer than 100 lifetime rows in a single request.
const ACTIVITY_PAGE_LIMIT = 100;

// Logged at most once per process per endpoint. The response schemas aren't
// published, so the first real payload is the only way to confirm the field
// probes in activity-feed.ts are looking for the right names. Keys only —
// never values, which would put member data in the logs.
const loggedShapes = new Set<string>();

function logShapeOnce(resource: string, rows: unknown[]): void {
	if (loggedShapes.has(resource) || rows.length === 0) return;
	const first = rows[0];
	if (typeof first !== 'object' || first === null) return;
	loggedShapes.add(resource);
	console.log(`[member-page] ${resource} sample keys: ${Object.keys(first).join(', ')}`);
}

/** Test-only: forget which shapes have been logged. */
export function _resetShapeLogForTests(): void {
	loggedShapes.clear();
}

async function fetchActivity(
	token: string,
	resource: string,
	query: string,
	limit: number,
	opts: NormalizeOptions = {},
): Promise<ActivityFeed> {
	const url = `https://api.solidarity.tech/v1/${resource}?${query}&_limit=${ACTIVITY_PAGE_LIMIT}&_offset=0`;
	const response = await fetchWithRetry(
		url,
		{ headers: { Authorization: `Bearer ${token}` } },
		`${resource} lookup`,
		'member-page',
		{ retriesUsed: 0 },
	);
	if (!response.ok) {
		throw new Error(`Solidarity ${resource} returned ${response.status}`);
	}

	const body = (await response.json()) as {
		data?: unknown[];
		meta?: { total_count?: number };
	};
	const rows = Array.isArray(body.data) ? body.data : [];
	logShapeOnce(resource, rows);

	const truncated = rows.length >= ACTIVITY_PAGE_LIMIT;
	if (truncated) {
		console.warn(
			`[member-page] ${resource} returned a full page (${rows.length}) — sort order unverified`,
		);
	}

	return {
		items: normalizeActivityList(rows, limit, opts),
		totalCount: typeof body.meta?.total_count === 'number' ? body.meta.total_count : null,
		truncated,
	};
}

/**
 * Build an id -> name map, tolerating a lookup failure. A missing map only
 * costs labels; the activity itself still renders with its dates, which is far
 * better than failing the whole feed because one auxiliary list was down.
 */
async function safeNameMap(
	fetcher: (token: string) => Promise<{ items: { id: number; name: string }[] }>,
	token: string,
	label: string,
): Promise<Map<number, string>> {
	try {
		const { items } = await fetcher(token);
		return new Map(items.map((i) => [i.id, i.name]));
	} catch (err) {
		console.error(`[member-page] ${label} lookup unavailable:`, errMessage(err));
		return new Map();
	}
}

function numeric(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The member's chapter names, for the header line on the member page.
 *
 * `chapter_ids` is the authoritative list — plenty of members belong to more
 * than one — but `chapter_id` is folded in too, since a member with exactly one
 * chapter has been observed carrying only the singular field. Ids with no name
 * in the chapter list still render as `Chapter 12`: knowing they're in *a*
 * chapter we can't name beats showing nothing.
 */
export async function getUserChapterNames(
	token: string,
	solidarityUserId: number,
): Promise<string[]> {
	const user = await getUserById(token, solidarityUserId);
	if (!user) return [];

	const ids = new Set<number>();
	for (const id of user.chapter_ids ?? []) {
		if (numeric(id) !== null) ids.add(id);
	}
	if (numeric(user.chapter_id) !== null) ids.add(user.chapter_id!);
	if (ids.size === 0) return [];

	const chapters = await safeNameMap(getSolidarityChapters, token, 'chapters');
	return [...ids]
		.map((id) => chapters.get(id) ?? `Chapter ${id}`)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * The member's most recent form/page submissions.
 *
 * Rows carry `action_page_id` and no label of their own, so the page names are
 * resolved from the cached /v1/pages list — otherwise every entry would read
 * "Untitled" and the feed would answer nothing about what the member did.
 */
export async function getRecentUserActions(
	token: string,
	solidarityUserId: number,
	limit = 5,
): Promise<ActivityFeed> {
	const pages = await safeNameMap(getSolidarityPages, token, 'action pages');
	return fetchActivity(token, 'user_actions', `user_id=${solidarityUserId}`, limit, {
		resolveTitle: (row) => {
			const id = numeric(row['action_page_id']);
			if (id === null) return null;
			return pages.get(id) ?? `Action page ${id}`;
		},
		// One row per submission, so signing up for six sessions through the same
		// page reads as six identical entries. Group on the page, not the title:
		// two distinct pages can share a name, and an id can't be missing a match
		// in the cache the way a name can.
		resolveGroupKey: (row) => {
			const id = numeric(row['action_page_id']);
			return id === null ? null : `page:${id}`;
		},
	});
}

/**
 * The member's most recent event RSVPs.
 *
 * `full_user_payload=false` is explicit rather than relying on the default: the
 * alternative embeds the member's complete personal record in every row, which
 * is exactly what this page is built to avoid handling.
 */
export async function getRecentEventRsvps(
	token: string,
	solidarityUserId: number,
	limit = 5,
): Promise<ActivityFeed> {
	const events = await safeNameMap(getSolidarityEvents, token, 'events');
	return fetchActivity(
		token,
		'event_rsvps',
		`user_id=${solidarityUserId}&full_user_payload=false`,
		limit,
		{
			resolveTitle: (row) => {
				const id = numeric(row['event_id']);
				if (id === null) return null;
				return events.get(id) ?? `Event ${id}`;
			},
			// A row is one *session* RSVP (`event_session_id`), so a weekly event
			// someone committed to for six weeks is six rows under one title.
			// Grouping on the event turns that back into one entry with a count.
			resolveGroupKey: (row) => {
				const id = numeric(row['event_id']);
				return id === null ? null : `event:${id}`;
			},
			// Whether they actually turned up is the most useful thing on an
			// RSVP row, and it's the difference between "signed up" and "showed
			// up" when an admin is judging engagement.
			resolveDetail: (row) => {
				if (row['is_attending'] === false) return 'RSVP canceled';
				if (row['is_confirmed'] === true) return 'Attended';
				return 'RSVP’d';
			},
		},
	);
}
