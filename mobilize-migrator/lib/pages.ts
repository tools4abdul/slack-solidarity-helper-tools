// Solidarity ActionPages — the source of the *formatted* event description.
//
// /v1/events returns a flattened plain-text `description`; the linked page
// (event.event_page_id) holds the same content as HTML with the bold, links and
// lists intact. Fetched in one paginated sweep and indexed by id rather than
// one request per event, which keeps us well inside the 60-per-30s rate limit.
//
// Paced all the same: there are thousands of pages, so the sweep is dozens of
// requests, and fired flat-out alongside the events walk it can go over the
// limit and drain fetchPaginated's shared retry budget ("rate-limit retry
// budget exhausted"), failing the whole sync.

import { requireEnv } from './env.js';
import { fetchPaginated } from '../../src/lib/server/solidarity-paginate.js';

/** Under Solidarity's 60-per-30s limit, matching the other long walks. */
const PACE_MS = 600;

interface ActionPage {
	id: number;
	description: string | null;
}

export async function fetchPageDescriptions(apiToken?: string): Promise<Map<number, string>> {
	const token = apiToken || requireEnv('SOLIDARITY_API_TOKEN', 'set it in .env.local');
	const pages = await fetchPaginated<ActionPage>(
		token,
		'/v1/pages',
		'pages',
		'',
		'mobilize-migrator',
		PACE_MS,
	);

	const byId = new Map<number, string>();
	for (const page of pages) {
		if (page.description) byId.set(page.id, page.description);
	}
	return byId;
}
