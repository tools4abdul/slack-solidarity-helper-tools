/**
 * Run the VAN turf catalog sync once, from the command line.
 *
 * Same code path as `POST /api/internal/van-sync` — it calls `runCatalogSync`
 * directly — but needs no running server and no INTERNAL_CRON_SECRET, which
 * makes it the right tool for setting a key up and for debugging a sync that
 * misbehaved in production.
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/van-sync-once.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/van-sync-once.ts
 *
 * Run --dry-run first. It fetches and plans but writes nothing, so you can see
 * the blast radius — above all the retirements, which release live checkouts —
 * before committing to it.
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createVanClient, type VanDatabaseMode } from '../src/lib/server/van/client.js';
import { runCatalogSync } from '../src/lib/server/van/sync.js';
import { vanChapterFolders, vanTurfs } from '../src/lib/server/schema.js';

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

const appName = process.env.VAN_APP_NAME ?? '';
const apiKey = process.env.VAN_API_KEY ?? '';
const rawMode = (process.env.VAN_DATABASE_MODE ?? '').trim();

if (!appName || !apiKey) {
	console.error('Missing required env vars: VAN_APP_NAME, VAN_API_KEY');
	process.exit(1);
}
if (rawMode !== '0' && rawMode !== '1') {
	console.error(
		`VAN_DATABASE_MODE must be 0 (My Voters) or 1 (My Campaign), got "${rawMode}".\n` +
			'Run `npm run van:check -- --both` to find out which one holds your turf.',
	);
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));
const client = createVanClient({
	appName,
	apiKey,
	databaseMode: Number(rawMode) as VanDatabaseMode,
});

async function main(): Promise<void> {
	// Printed up front and unredacted-by-design: the auth token is never shown,
	// but WHICH database is about to be written is the one thing an operator
	// must not have to guess before a write.
	console.log(`\nTarget database: ${dbConfig.url}`);
	console.log(`VAN app: ${appName}, mode ${rawMode}`);
	console.log(DRY_RUN ? 'Mode: DRY RUN — nothing will be written\n' : 'Mode: WRITING\n');

	// Read the chapter → folder mapping straight from the table rather than
	// through settings.ts, which imports ./env.js and with it $env/dynamic/private
	// — that module only exists inside the Vite bundle, never under tsx.
	const mappingRows = await db.select().from(vanChapterFolders);
	const byChapter = new Map<
		number,
		{ chapterId: number; chapterName: string; folderIds: number[] }
	>();
	for (const row of mappingRows) {
		const entry = byChapter.get(row.chapterId);
		if (entry) entry.folderIds.push(row.folderId);
		else
			byChapter.set(row.chapterId, {
				chapterId: row.chapterId,
				chapterName: row.chapterName,
				folderIds: [row.folderId],
			});
	}
	const mappings = [...byChapter.values()];
	console.log(
		`Chapter → folder mapping: ${
			mappings.length === 0
				? 'NONE — add one under Settings → Chapter → VAN folders'
				: mappings.map((m) => `${m.chapterName} → ${m.folderIds.join(', ')}`).join(' · ')
		}\n`,
	);

	const result = await runCatalogSync(db, client, mappings, { dryRun: DRY_RUN });

	console.log('Result');
	console.log(`  folders synced      ${result.foldersSynced}`);
	console.log(`  folders skipped     ${result.foldersSkipped}`);
	console.log(`  turfs upserted      ${result.turfsUpserted}`);
	console.log(`  turfs retired       ${result.turfsRetired}`);
	console.log(`  turfs unretired     ${result.turfsUnretired}`);
	console.log(`  queued for geometry ${result.geometryQueued}`);
	console.log(`  geometry dropped    ${result.geometryQueueDropped}`);
	console.log(`  claims released     ${result.claimsReleased}`);

	if (result.degraded.length > 0) {
		console.log('\nDegraded (endpoints this key cannot reach)');
		for (const line of result.degraded) console.log(`  • ${line}`);
	}
	if (result.warnings.length > 0) {
		console.log('\nWarnings');
		for (const line of result.warnings) console.log(`  • ${line}`);
	}

	const rows = result.plan?.upserts ?? [];
	if (rows.length > 0) {
		console.log(`\n${DRY_RUN ? 'Would write' : 'Wrote'} ${rows.length} turf row(s)`);
		for (const row of rows.slice(0, 20)) {
			console.log(
				`  [${row.mapRouteId}] ${row.name}\n` +
					`        chapter ${row.chapterId} ${row.chapterName} · region ${row.mapRegionId} ${row.regionName}\n` +
					`        ${row.doorCount} doors, ${row.routeSize} people · list ${row.printedListNumber ?? '(none — NOT claimable)'}\n` +
					`        savedListId ${row.savedListId ?? '—'} · hull ${row.hullJson ? 'yes' : 'none (renders as a pin)'}`,
			);
		}
		if (rows.length > 20) console.log(`  … +${rows.length - 20} more`);
	}

	if (!DRY_RUN) {
		// Read back rather than trusting the return value — the point of a
		// verification run is to prove the rows are in the database.
		const stored = await db.select().from(vanTurfs);
		console.log(`\nvan_turfs now holds ${stored.length} row(s).`);
	} else {
		console.log('\nNothing was written. Re-run without --dry-run to apply.');
	}
	console.log('');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
