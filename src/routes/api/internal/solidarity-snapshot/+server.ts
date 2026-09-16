import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runSolidaritySnapshot } from '$lib/server/solidarity-snapshot.js';
import { INTERNAL_CRON_SECRET, SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// Internal endpoint called by a scheduler (GitHub Actions / Fly cron) to write
// the previous day's Solidarity signup snapshot. Auth via ?key=<INTERNAL_CRON_SECRET>.
// Optional ?date=YYYY-MM-DD for backfill.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[snapshot] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}

	const date = url.searchParams.get('date') ?? undefined;

	try {
		const result = await runSolidaritySnapshot(db, SOLIDARITY_API_TOKEN, { date });
		console.log(
			`[snapshot] ${result.date}: ${result.usersInRange}/${result.usersScanned} users → ${result.rows.length} rows`,
		);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[snapshot] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};
