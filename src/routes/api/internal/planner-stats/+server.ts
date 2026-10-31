import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { errMessage } from '$lib/err-message.js';
import { refreshPlannerStats } from '$lib/server/planner-stats.js';
import { secretMatches } from '$lib/server/secret-compare.js';

const LOG = '[planner-stats]';

// Refreshes the query planner's statistics for the whole database; see
// planner-stats.ts. Called nightly by the in-process scheduler. Auth via
// ?key=<INTERNAL_CRON_SECRET>. No lock: two runs at once write the same
// statistics, and each table's ANALYZE takes the database's write lock for
// itself, so they take turns table by table.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error(`${LOG} INTERNAL_CRON_SECRET is not set`);
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const started = Date.now();
	let refreshed;
	try {
		refreshed = await refreshPlannerStats(db);
	} catch (err) {
		// Only the read of the table list throws here; each table's own
		// failure is in `failed`.
		console.error(`${LOG} could not list the tables:`, errMessage(err));
		return json({ error: 'ANALYZE failed' }, { status: 500 });
	}
	const { analyzed, failed } = refreshed;
	const ms = Date.now() - started;
	for (const { name, error } of failed) {
		console.error(`${LOG} ANALYZE ${name} failed:`, errMessage(error));
	}
	// Each table holds the write lock for its own time: the slowest are what
	// other writes waited on.
	const slowest = [...analyzed]
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 5)
		.map((a) => `${a.name} ${(a.ms / 1000).toFixed(1)}s`)
		.join(', ');
	console.log(
		`${LOG} ${analyzed.length} tables in ${(ms / 1000).toFixed(1)}s` +
			`${failed.length > 0 ? `, ${failed.length} failed` : ''}; slowest: ${slowest}`,
	);
	return json(
		{ ok: failed.length === 0, ms, tables: analyzed.length, failed: failed.map((f) => f.name) },
		{ status: failed.length === 0 ? 200 : 500 },
	);
};
