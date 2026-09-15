// Read side: Solidarity's public v1 API. Only the pieces the migration needs.
//
// Note the shape mismatch that drives the whole transform: a Solidarity event
// owns many *sessions*, and each session carries its own location and time. A
// Mobilize event has ONE address plus many timeslots. So one Solidarity event
// can become several Mobilize events.

import { requireEnv } from './env.js';
import { fetchPaginated } from '../../src/lib/server/solidarity-paginate.js';

export interface SolidarityLocationData {
	full_address?: string | null;
	address_line_1?: string | null;
	address_city?: string | null;
	address_state?: string | null;
	address_postal_code?: string | null;
	address_country?: string | null;
	/** JSON-encoded: {"lat":42.98,"lng":-83.67} */
	coordinates?: string | null;
}

export interface SolidaritySession {
	id: number;
	title: string | null;
	start_time: string;
	end_time: string;
	location_name: string | null;
	location_address: string | null;
	location_data: SolidarityLocationData | null;
	max_capacity: number | null;
	event_type: string;
}

export interface SolidarityEvent {
	id: number;
	title: string;
	event_type: string;
	scope_id: number;
	scope_type: string;
	/** Flattened plain text — the formatted original lives on the linked page. */
	description: string | null;
	event_page_id: number | null;
	event_page_url: string | null;
	/** Solidarity-hosted S3 image, public. Mobilize will not accept it directly. */
	image_url: string | null;
	hide_address_until_rsvp: boolean;
	is_co_hosted_mirror: boolean;
	primary_event_id: number;
	/** Free-text organizer tags — "wayne", "doorshift", "slack-exclude". */
	tags?: string[] | null;
	event_sessions: SolidaritySession[];
}

/** Tagging an event with this in Solidarity keeps it off mobilize.us. Mirrors
 *  `slack-exclude`, which keeps an event out of the Slack announcements. */
export const MOBILIZE_EXCLUDE_TAG = 'mobilize-exclude';

/** Tags are compared case- and space-insensitively: they are typed by hand, and
 *  Solidarity preserves whatever was typed ("Student", "volunteer event"). */
export function hasTag(event: Pick<SolidarityEvent, 'tags'>, tag: string): boolean {
	return (event.tags ?? []).some((t) => t.trim().toLowerCase() === tag);
}

/**
 * `apiToken` is passed explicitly by the server (which reads $env) and falls
 * back to the .env.local loader for the standalone CLI scripts — the same
 * dual-use pattern as src/lib/server/solidarity-paginate.ts, whose paginator
 * this delegates to for the bounded 429 retry. This is the first read of both
 * Mobilize jobs, so a rate limit it could not give up on would strand the job
 * holding its lock.
 */
export async function fetchAllEvents(apiToken?: string): Promise<SolidarityEvent[]> {
	const token = apiToken || requireEnv('SOLIDARITY_API_TOKEN', 'set it in .env.local');
	return fetchPaginated<SolidarityEvent>(token, '/v1/events', 'events', '', 'mobilize-migrator');
}

export function parseCoordinates(
	data: SolidarityLocationData | null,
): { lat: number; lon: number } | null {
	if (!data?.coordinates) return null;
	try {
		const parsed = JSON.parse(data.coordinates) as { lat?: number; lng?: number };
		if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') return null;
		return { lat: parsed.lat, lon: parsed.lng };
	} catch {
		return null;
	}
}
