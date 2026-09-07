// Client for the Mobilize v1 API (https://github.com/mobilizeamerica/api).
//
// Everything the integration needs — reading events, creating and updating
// them, uploading images, and listing signups — is one documented API behind a
// single organization API key. Create/update/delete and image upload are
// "restricted" endpoints: holding a key is not enough, the organization must
// have been granted write access. A 403 means the key is wrong or that grant is
// missing, and no amount of retrying will fix it.
//
// Every response is enveloped as {data, error, count, next, previous}; list
// endpoints are followed through `next` rather than by counting pages.

import { env, requireEnv } from './env.js';

const BASE = 'https://api.mobilize.us/v1';

/** Credentials for every call. The CLI builds this from .env.local, the server
 *  from $env — see src/lib/server/mobilize-api.ts. */
export interface MobilizeApiConfig {
	apiKey: string;
	orgId: number;
}

export function loadApiConfig(): MobilizeApiConfig {
	const apiKey = requireEnv('MOBILIZE_API_KEY', 'set it in .env.local');
	const rawOrgId = env('MOBILIZE_ORG_ID');
	const orgId = parseInt(rawOrgId, 10);
	if (!Number.isFinite(orgId) || orgId <= 0) {
		// No default: syncing into the wrong organization publishes events under
		// someone else's name, which is not something to fail quietly.
		throw new Error(`MOBILIZE_ORG_ID must be a positive integer, got "${rawOrgId}"`);
	}
	return { apiKey, orgId };
}

export class MobilizeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = 'MobilizeError';
	}
}

/**
 * How much of a rejection body to keep on the error. The message carries a
 * short human summary; `body` is kept long enough to stay valid JSON, because
 * parseTimeslotCapacityFloors reads it — an event with a dozen shifts answers
 * with a dozen padded entries, and a body truncated mid-array parses as nothing.
 */
const MAX_ERROR_BODY = 4_000;

/**
 * Floors Mobilize named when it refused to cap a timeslot below the signups it
 * is already holding, keyed by that slot's INDEX in the timeslots we sent:
 *
 *   {"error":{"timeslots":[{"non_field_errors":["Timeslot capacity cannot be
 *     less than 6 (current attendees)"]},{}]}}
 *
 * The array is index-aligned with the request and pads with `{}` for the slots
 * that were fine, which is the only thing that says WHICH shift is over — the
 * message names no id. Anything else, including any other 400, yields an empty
 * map, so a caller can tell "not this problem" from "this problem, and here is
 * the number to use".
 */
export function parseTimeslotCapacityFloors(err: unknown): Map<number, number> {
	const floors = new Map<number, number>();
	if (!(err instanceof MobilizeError) || err.status !== 400) return floors;

	let parsed: unknown;
	try {
		parsed = JSON.parse(err.body);
	} catch {
		return floors;
	}
	const slots = (parsed as { error?: { timeslots?: unknown } } | null)?.error?.timeslots;
	if (!Array.isArray(slots)) return floors;

	slots.forEach((slot, index) => {
		const messages = (slot as { non_field_errors?: unknown } | null)?.non_field_errors;
		if (!Array.isArray(messages)) return;
		for (const message of messages) {
			// Matched loosely on purpose: the wording is Mobilize's to change, and a
			// missed match costs one reported failure rather than a wrong cap.
			const found =
				typeof message === 'string' && /capacity cannot be less than (\d+)/i.exec(message);
			if (found) {
				floors.set(index, Number(found[1]));
				return;
			}
		}
	});
	return floors;
}

interface Envelope<T> {
	data?: T;
	error?: unknown;
	next?: string | null;
	count?: number;
}

/** Documented limits are 15 req/s read and 5 req/s write, answered with 429. */
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
	config: MobilizeApiConfig,
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${config.apiKey}`);
	headers.set('Accept', 'application/json');

	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { ...init, headers });
		if (res.status !== 429 || attempt >= MAX_ATTEMPTS - 1) return res;
		// Mobilize sends Retry-After on some 429s; prefer it over guessing.
		const retryAfter = Number(res.headers.get('retry-after'));
		await sleep(
			Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: BACKOFF_MS * (attempt + 1),
		);
	}
}

/**
 * Mobilize answers a rejected write with 400 and a body naming the offending
 * field — "description: This field may not be blank." The body is the entire
 * diagnosis, so it goes in the message: a nightly run reporting only
 * `/organizations/44679/events returned 400` says nothing a reader can act on,
 * which is exactly how ten failing events went unexplained for a night.
 */
function describeFailure(status: number, url: string, body: string): string {
	const path = url.replace(BASE, '');
	if (status === 403) {
		return `${path} returned 403 — MOBILIZE_API_KEY is rejected, or lacks the write access these endpoints require`;
	}
	const detail = body.trim().replace(/\s+/g, ' ').slice(0, 300);
	return detail ? `${path} returned ${status}: ${detail}` : `${path} returned ${status}`;
}

/** One JSON call. Throws MobilizeError on any non-2xx or an `error` in the body. */
async function callJson<T>(
	config: MobilizeApiConfig,
	url: string,
	init: RequestInit = {},
): Promise<Envelope<T>> {
	const res = await request(config, url, init);
	const text = await res.text();
	if (!res.ok) {
		throw new MobilizeError(
			describeFailure(res.status, url, text),
			res.status,
			text.slice(0, MAX_ERROR_BODY),
		);
	}
	// 204s and the odd empty write response are legitimate.
	if (!text.trim()) return {};

	let body: Envelope<T>;
	try {
		body = JSON.parse(text) as Envelope<T>;
	} catch {
		throw new MobilizeError(`${url} returned non-JSON`, res.status, text.slice(0, 300));
	}
	if (body.error) {
		throw new MobilizeError(
			`${url.replace(BASE, '')}: ${JSON.stringify(body.error).slice(0, 300)}`,
			res.status,
			text.slice(0, MAX_ERROR_BODY),
		);
	}
	return body;
}

/** Follow `next` to the end of a list endpoint. */
async function collect<T>(config: MobilizeApiConfig, firstUrl: string): Promise<T[]> {
	const all: T[] = [];
	let url: string | null = firstUrl;
	while (url) {
		const body: Envelope<T[]> = await callJson<T[]>(config, url);
		all.push(...(body.data ?? []));
		url = body.next ?? null;
	}
	return all;
}

function jsonBody(payload: unknown): RequestInit {
	return {
		body: JSON.stringify(payload),
		headers: { 'Content-Type': 'application/json' },
	};
}

// --- Events -------------------------------------------------------------------

export interface MobilizeEvent {
	id: number;
	title: string;
	event_type: string;
	browser_url?: string;
	visibility?: string;
	description?: string;
	featured_image_url?: string | null;
	instructions?: string | null;
	accessibility_status?: string | null;
	/** Only returned to authenticated callers, which we now always are. */
	contact?: {
		name?: string | null;
		email_address?: string | null;
		phone_number?: string | null;
	} | null;
	timeslots: { id: number; start_date: number; end_date: number }[];
	location: {
		venue?: string | null;
		locality?: string | null;
		region?: string | null;
		postal_code?: string | null;
		address_lines?: string[] | null;
	} | null;
}

/** Every upcoming event for the org — the duplicate-detection corpus, and the
 *  source the update pass diffs against so it needs no per-event read. */
export async function listUpcomingOrgEvents(config: MobilizeApiConfig): Promise<MobilizeEvent[]> {
	return collect<MobilizeEvent>(
		config,
		`${BASE}/organizations/${config.orgId}/events?per_page=100&timeslot_start=gte_now`,
	);
}

/** Read one event. Used for events the bulk list doesn't cover — all timeslots
 *  already past, or not publicly listed — and to pick up timeslot ids after a
 *  create. */
export async function getOrgEvent(
	config: MobilizeApiConfig,
	id: number,
): Promise<MobilizeEvent | null> {
	try {
		const body = await callJson<MobilizeEvent>(
			config,
			`${BASE}/organizations/${config.orgId}/events/${id}`,
		);
		return body.data ?? null;
	} catch (err) {
		if (err instanceof MobilizeError && err.status === 404) return null;
		throw err;
	}
}

/**
 * Create an event. Returns its id and the created event itself.
 *
 * Envelope trap, verified against the live API: create answers
 * `{"data":{"event":{…}}}` — one level deeper than every other endpoint, which
 * return the event flat under `data`. Reading `data.id` here yields undefined
 * and fails every create. The flat shape is accepted as a fallback in case that
 * inconsistency is ever tidied up.
 *
 * The returned event already carries its timeslots WITH their new ids, so
 * callers don't need a read-back to pair them.
 */
export async function createEvent(
	config: MobilizeApiConfig,
	payload: Record<string, unknown>,
): Promise<{ id: number; event: MobilizeEvent | null }> {
	const body = await callJson<{ event?: MobilizeEvent } & Partial<MobilizeEvent>>(
		config,
		`${BASE}/organizations/${config.orgId}/events`,
		{ method: 'POST', ...jsonBody(payload) },
	);
	const event = (body.data?.event ?? body.data) as MobilizeEvent | undefined;
	const id = event?.id;
	if (typeof id !== 'number') {
		throw new MobilizeError(
			'create succeeded but no event id in response',
			200,
			JSON.stringify(body).slice(0, 300),
		);
	}
	return { id, event: event ?? null };
}

/**
 * Replace an event.
 *
 * Timeslot identity is the caller's job: an upcoming slot sent WITHOUT an id is
 * created, and an upcoming slot that is simply absent is deleted along with its
 * signups. Past timeslots are not touched by this endpoint at all, so they must
 * not be sent — see reconcileTimeslots in sync.ts.
 *
 * Notifications are suppressed: this runs nightly and re-pushes the same events,
 * so leaving them on would mail every attendee whenever a description changed.
 */
export async function updateEvent(
	config: MobilizeApiConfig,
	id: number,
	payload: Record<string, unknown>,
): Promise<void> {
	await callJson(
		config,
		`${BASE}/organizations/${config.orgId}/events/${id}?send_update_notifications=false`,
		{ method: 'PUT', ...jsonBody(payload) },
	);
}

export async function deleteEvent(config: MobilizeApiConfig, id: number): Promise<void> {
	try {
		await callJson(config, `${BASE}/organizations/${config.orgId}/events/${id}`, {
			method: 'DELETE',
		});
	} catch (err) {
		// Already gone is the desired end state.
		if (err instanceof MobilizeError && err.status === 404) return;
		throw err;
	}
}

// --- Images -------------------------------------------------------------------

/**
 * Upload image bytes and return the Mobilize-hosted URL for `featured_image_url`.
 *
 * Multipart, not JSON — and deliberately no Content-Type header, so fetch sets
 * the multipart boundary itself.
 */
export async function uploadImage(
	config: MobilizeApiConfig,
	bytes: ArrayBuffer,
	filename: string,
	contentType: string,
): Promise<string> {
	const form = new FormData();
	form.append('file', new Blob([bytes], { type: contentType }), filename);
	form.append('file_name', filename);

	const body = await callJson<{ url?: string }>(config, `${BASE}/images`, {
		method: 'POST',
		body: form,
	});
	// Verified against the live endpoint: {"data":{"url":"https://…"}}. Read it
	// directly rather than hunting for a URL-shaped string — if this shape ever
	// changes, failing here is far better than silently putting some other URL
	// on a public event.
	const url = body.data?.url;
	if (typeof url !== 'string' || !url) {
		throw new MobilizeError(
			'image upload succeeded but no data.url in response',
			200,
			JSON.stringify(body).slice(0, 300),
		);
	}
	return url;
}

// --- Attendances --------------------------------------------------------------

export interface MobilizeAttendance {
	id: number;
	person?: {
		id?: number;
		user_id?: number;
		given_name?: string | null;
		family_name?: string | null;
		email_addresses?: { primary?: boolean; address?: string | null }[] | null;
		phone_numbers?: { primary?: boolean; number?: string | null }[] | null;
		postal_addresses?: { primary?: boolean; postal_code?: string | null }[] | null;
	} | null;
	event?: { id: number } | null;
	timeslot?: { id: number; start_date?: number; end_date?: number } | null;
	/** REGISTERED | CANCELLED | CONFIRMED */
	status: string;
	/** null when Mobilize has not recorded an outcome yet. */
	attended?: boolean | null;
	created_date?: number;
	modified_date?: number;
}

/** Every signup on one event, across all its timeslots. */
export async function listEventAttendances(
	config: MobilizeApiConfig,
	eventId: number,
): Promise<MobilizeAttendance[]> {
	return collect<MobilizeAttendance>(
		config,
		`${BASE}/organizations/${config.orgId}/events/${eventId}/attendances?per_page=100`,
	);
}
