/**
 * Fill van_minivan_exports in one go, instead of over the first few syncs.
 *
 * The catalog sync reads at most MAX_EXPORT_PAGES_PER_SYNC pages of exports a
 * run, so an empty table takes two or three syncs (an hour or so) to catch up,
 * and the drift report says "can't check" until it has. This runs the same
 * `pullMinivanExports` with no page cap until VAN says there is nothing newer.
 *
 * Safe to run alongside a live sync: both upsert on the export id, so the worst
 * a collision does is write the same row twice. Safe to re-run: a caught-up
 * table reads its newest day again and stops.
 *
 * The table has to exist first — merge and let the deploy run migration 0043,
 * or this fails on "no such table".
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/van-exports-backfill.ts
 *
 * The next catalog sync then finds the store current and switches the drift
 * report on; this script does not touch van_turfs or van_sync_state itself.
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createVanClient, type VanDatabaseMode } from '../src/lib/server/van/client.js';
import { pullMinivanExports } from '../src/lib/server/van/minivan-export-store.js';

// Per call, not overall: each call resumes from the newest date the last one
// stored, so a crash partway through loses at most one call's work.
const PAGES_PER_CALL = 200;
// A backstop against a cursor that stops moving (one day holding more than
// PAGES_PER_CALL pages). Thirty days has never needed more than three.
const MAX_CALLS = 20;

const appName = process.env.VAN_APP_NAME ?? '';
const apiKey = process.env.VAN_API_KEY ?? '';
const rawMode = (process.env.VAN_DATABASE_MODE ?? '').trim();

if (!appName || !apiKey) {
	console.error('Missing required env vars: VAN_APP_NAME, VAN_API_KEY');
	process.exit(1);
}
if (rawMode !== '0' && rawMode !== '1') {
	console.error(`VAN_DATABASE_MODE must be 0 (My Voters) or 1 (My Campaign), got "${rawMode}".`);
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));
const client = createVanClient({
	appName,
	apiKey,
	databaseMode: Number(rawMode) as VanDatabaseMode,
});

async function main(): Promise<void> {
	// Which database is about to be written is the one thing an operator must
	// not have to guess — same as van-sync-once.ts.
	console.log(`\nTarget database: ${dbConfig.url}`);
	console.log(`VAN app: ${appName}, mode ${rawMode}\n`);

	let previousFrom: string | null = null;
	for (let call = 1; call <= MAX_CALLS; call++) {
		const started = Date.now();
		const result = await pullMinivanExports(db, client, {
			now: new Date(),
			maxPages: PAGES_PER_CALL,
		});
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(
			`  from ${result.from}: ${result.fetched} export(s) in ${seconds}s${result.complete ? ' — caught up' : ''}`,
		);
		if (result.complete) {
			console.log('\nDone. The next catalog sync will switch the drift report on.');
			return;
		}
		if (result.from === previousFrom) {
			console.error(
				`\nStuck: ${result.from} alone holds more than ${PAGES_PER_CALL} pages. Raise PAGES_PER_CALL.`,
			);
			process.exit(1);
		}
		previousFrom = result.from;
	}
	console.error(`\nStopped after ${MAX_CALLS} calls without catching up.`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
