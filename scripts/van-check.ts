/**
 * Prove a VAN API key works, and show what the catalog sync will see through
 * it. Read-only — this script never writes to VAN or to the database.
 *
 * Run it first whenever a new key arrives. It answers, in order, the four
 * questions that actually block the turf feature:
 *   1. Do the credentials authenticate at all?
 *   2. WHICH DATABASE holds the turf — My Voters or My Campaign? The mode is a
 *      selector appended to the key (`{apiKey}|{mode}`), not a property of it,
 *      so one key can address both. With VAN_DATABASE_MODE unset this script
 *      probes both and tells you which to use.
 *   3. Which folders can the key see (the ids to map to chapters in /settings)?
 *   4. Which endpoint tiers were granted — the sync degrades rather than fails
 *      without Tier 3, so knowing which parts are missing beats guessing. And
 *      which export job type id does THIS key have? EveryAction issues them per
 *      developer, so the `101` in VAN's docs is an example, and hardcoding it
 *      produces a 400 at 3am (plan.md Story 1.5).
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/van-check.ts
 *   npx tsx --env-file=.env.local scripts/van-check.ts --folder 1152
 *   npx tsx --env-file=.env.local scripts/van-check.ts --both
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY
 *   VAN_DATABASE_MODE (0 = My Voters, 1 = My Campaign) — optional here; leave
 *   it unset to have the script work out which one your turf is in.
 */

import {
	createVanClient,
	VanError,
	type VanClient,
	type VanDatabaseMode,
} from '../src/lib/server/van/client.js';

const args = process.argv.slice(2);
const folderIdx = args.indexOf('--folder');
const FOLDER_ARG = folderIdx >= 0 ? Number(args[folderIdx + 1]) : undefined;
const FORCE_BOTH = args.includes('--both');

const appName = process.env.VAN_APP_NAME ?? '';
const apiKey = process.env.VAN_API_KEY ?? '';
const rawMode = (process.env.VAN_DATABASE_MODE ?? '').trim();

if (!appName || !apiKey) {
	console.error('Missing required env vars: VAN_APP_NAME, VAN_API_KEY');
	process.exit(1);
}
if (rawMode !== '' && rawMode !== '0' && rawMode !== '1') {
	console.error(
		`VAN_DATABASE_MODE must be 0 (My Voters), 1 (My Campaign), or unset. Got "${rawMode}".`,
	);
	process.exit(1);
}

// Unset means "I don't know which database the turf is in" — the common case
// on a fresh demo key. Probing both is cheap and read-only, and it turns the
// question into an answer instead of a coin flip.
const MODES: VanDatabaseMode[] =
	FORCE_BOTH || rawMode === '' ? [0, 1] : [Number(rawMode) as VanDatabaseMode];

const OK = '  ok  ';
const NO = ' FAIL ';
const SKIP = ' n/a  ';

const MODE_NAMES: Record<VanDatabaseMode, string> = { 0: 'My Voters', 1: 'My Campaign' };

interface ModeSummary {
	mode: VanDatabaseMode;
	authenticated: boolean;
	/** null when /folders could not be read at all. */
	folderCount: number | null;
	regionCount: number;
	routeCount: number;
	tiers: { printedLists: boolean; savedLists: boolean; minivanExports: boolean };
}

/** Run one probe, printing a one-line verdict. Never throws: the point of the
 *  script is a complete picture of what the key can do, so a 403 on one
 *  endpoint must not hide the answer for the next. */
async function probe<T>(label: string, run: () => Promise<T>): Promise<T | null> {
	try {
		const result = await run();
		console.log(`[${OK}] ${label}`);
		return result;
	} catch (err) {
		if (err instanceof VanError) {
			const why =
				err.status === 401
					? 'credentials rejected — check VAN_APP_NAME and the key'
					: err.status === 403
						? 'not granted to this key’s tier'
						: err.message;
			console.log(`[${NO}] ${label} — ${why}`);
			if (err.codes.length > 0) console.log(`         codes: ${err.codes.join(', ')}`);
		} else {
			console.log(`[${NO}] ${label} — ${err instanceof Error ? err.message : String(err)}`);
		}
		return null;
	}
}

/** Walk folders looking for map regions. Stops at the first folder holding
 *  turf so the common case needs no arguments; `--folder` targets one. */
async function surveyTurf(
	client: VanClient,
	folderIds: number[],
	verbose: boolean,
): Promise<{ regionCount: number; routeCount: number }> {
	let regionCount = 0;
	let routeCount = 0;
	const candidates = FOLDER_ARG ? [FOLDER_ARG] : folderIds.slice(0, 10);
	if (candidates.length === 0) {
		console.log(`[${SKIP}] GET /folders/{id}/mapRegions — no folder to try`);
		return { regionCount, routeCount };
	}

	for (const folderId of candidates) {
		const regions = await probe(`GET /folders/${folderId}/mapRegions`, () =>
			client.mapRegions(folderId),
		);
		if (!regions || regions.length === 0) continue;
		regionCount += regions.length;
		for (const region of regions) {
			const routes = region.mapRoutes ?? [];
			routeCount += routes.length;
			if (!verbose) continue;
			console.log(
				`         region ${region.mapRegionId} "${region.name ?? ''}" — ${routes.length} route(s)`,
			);
			for (const route of routes.slice(0, 10)) {
				const listNumber = route.printedList?.number ?? '(no printed list)';
				console.log(
					`           ${route.name ?? route.mapRouteId}: ${route.doorCount ?? 0} doors, ` +
						`${route.routeSize ?? 0} people, list ${listNumber}, savedListId ${route.savedListId ?? '—'}`,
				);
			}
			if (routes.length > 10) console.log(`           … +${routes.length - 10} more route(s)`);
		}
		if (!FOLDER_ARG) break;
	}
	return { regionCount, routeCount };
}

/** Probe one database mode end to end. `verbose` is off when comparing both
 *  modes, so the comparison verdict isn't buried under two full dumps. */
async function checkMode(mode: VanDatabaseMode, verbose: boolean): Promise<ModeSummary> {
	console.log(`\n${'═'.repeat(64)}\nmode ${mode} — ${MODE_NAMES[mode]}\n${'═'.repeat(64)}`);
	const client = createVanClient({ appName, apiKey, databaseMode: mode });

	console.log('Tier 1');
	const folders = await probe('GET /folders', () => client.folders());
	if (folders) {
		if (folders.length === 0) {
			console.log('         (no folders — the key authenticates but sees nothing here)');
		}
		const shown = verbose ? 40 : 10;
		for (const folder of folders.slice(0, shown)) {
			console.log(`         ${String(folder.folderId).padStart(7)}  ${folder.name}`);
		}
		if (folders.length > shown) console.log(`         … +${folders.length - shown} more`);
	}

	console.log('\nTier 2');
	const printedLists = await probe('GET /printedLists', async () => {
		const lists = await client.printedLists();
		console.log(`         ${lists.length} printed list(s)`);
		if (verbose) {
			for (const list of lists.slice(0, 5)) {
				console.log(`         ${list.number}  ${list.name ?? ''}`);
			}
		}
		return lists;
	});

	console.log('\nTier 3');
	const savedLists = await probe('GET /savedLists', async () => {
		const lists = await client.savedLists();
		console.log(`         ${lists.length} saved list(s)`);
		return lists;
	});
	const minivanExports = await probe('GET /minivanExports', async () => {
		const exports = await client.minivanExports();
		console.log(`         ${exports.length} MiniVAN export(s)`);
		// Each export names the database it was cut from. When it's populated
		// this is VAN telling you the answer directly, rather than us inferring
		// it from where the turf turned up.
		const modes = [...new Set(exports.map((e) => e.databaseMode).filter(Boolean))];
		if (modes.length > 0) console.log(`         databaseMode on exports: ${modes.join(', ')}`);
		return exports;
	});

	console.log('\nExport jobs (geometry)');
	const jobTypes = await probe('GET /exportJobTypes', () => client.exportJobTypes());
	if (jobTypes && verbose) {
		for (const type of jobTypes) {
			console.log(`         ${String(type.exportJobTypeId).padStart(7)}  ${type.name ?? ''}`);
		}
		// Name the type rather than describing it. The old wording said only
		// "the type that can export VAddressLatitude / VAddressLongitude" and
		// left the reader to guess between two plausible names — and
		// SavedListExport is by far the likelier guess, which is exactly the
		// misconfiguration that makes every turf dead-letter as a pin. Verified
		// live: VoterCircle is the only type carrying coordinates, and
		// SavedListExport carries none at all (hull-extract.ts header).
		const voterCircle = jobTypes.find((t) => (t.name ?? '').toLowerCase() === 'votercircle');
		if (voterCircle) {
			console.log(
				`         → set VAN_EXPORT_JOB_TYPE_ID=${voterCircle.exportJobTypeId}  (VoterCircle)\n` +
					'           It is the only type whose export carries VAddressLatitude /\n' +
					'           VAddressLongitude. Do NOT use SavedListExport — it has no\n' +
					'           coordinate columns, so every turf dead-letters and renders as a pin.',
			);
		} else {
			console.log(
				'         → set VAN_EXPORT_JOB_TYPE_ID to the id of the type that can\n' +
					'           export VAddressLatitude / VAddressLongitude. On this key that has\n' +
					'           always been VoterCircle, which is NOT in the list above — so check\n' +
					'           with EveryAction which of these types carries coordinates.',
			);
		}
	}

	console.log('\nTurf catalog');
	const { regionCount, routeCount } = await surveyTurf(
		client,
		(folders ?? []).map((f) => f.folderId),
		verbose,
	);
	if (regionCount === 0) console.log('         no map regions found in the folders checked');

	return {
		mode,
		// /folders is Tier 1 and needed regardless, so it doubles as the auth
		// probe: a 401 there means the credentials themselves were rejected.
		authenticated: folders !== null,
		folderCount: folders?.length ?? null,
		regionCount,
		routeCount,
		tiers: {
			printedLists: printedLists !== null,
			savedLists: savedLists !== null,
			minivanExports: minivanExports !== null,
		},
	};
}

/** Which mode to actually configure, given what both turned up. */
function verdict(summaries: ModeSummary[]): string[] {
	const authed = summaries.filter((s) => s.authenticated);
	if (authed.length === 0) {
		return [
			'Neither database accepted these credentials.',
			'',
			'VAN_APP_NAME must be the Application Name EveryAction issued with the key —',
			'it is the HTTP Basic username, not a display string. A 401 in both modes is',
			'almost always that, or a mistyped key.',
		];
	}

	const withTurf = authed.filter((s) => s.routeCount > 0);
	if (withTurf.length === 1) {
		const win = withTurf[0]!;
		return [
			`→ Set VAN_DATABASE_MODE=${win.mode}  (${MODE_NAMES[win.mode]})`,
			'',
			`It is the only database holding turf: ${win.routeCount} route(s) across ` +
				`${win.regionCount} map region(s).`,
		];
	}
	if (withTurf.length > 1) {
		const win = [...withTurf].sort((a, b) => b.routeCount - a.routeCount)[0]!;
		return [
			`→ Set VAN_DATABASE_MODE=${win.mode}  (${MODE_NAMES[win.mode]})`,
			'',
			'Both databases hold turf, which is unusual. Picking the one with more routes ' +
				`(${win.routeCount} vs ${withTurf.find((s) => s.mode !== win.mode)!.routeCount}), but ` +
				'confirm with whoever administers the VAN committee — the app serves one database ' +
				'and turf in the other will be invisible.',
		];
	}

	// Authenticated, but no turf anywhere. Say which database is live and what
	// is most likely missing, rather than implying the key is broken.
	const live = authed.map((s) => `mode ${s.mode} (${MODE_NAMES[s.mode]})`).join(' and ');
	return [
		`Authenticated in ${live}, but neither has any map regions.`,
		'',
		'The credentials are fine — there is just no turf cut yet, or none in the folders',
		'checked. Turf is a My Voters concept (it is cut against the voter file), so',
		'VAN_DATABASE_MODE=0 is the near-certain answer once someone cuts some.',
		'',
		'Try --folder <id> against a specific folder if you know one holds turf.',
	];
}

async function main(): Promise<void> {
	console.log(`\nVAN check — app "${appName}"`);
	if (MODES.length > 1) {
		console.log(
			'No VAN_DATABASE_MODE set — probing both databases.\n' +
				'The mode is a selector appended to the key, not a property of it, so one key\n' +
				'can address both. What matters is which database holds your turf.',
		);
	}

	const summaries: ModeSummary[] = [];
	for (const mode of MODES) {
		summaries.push(await checkMode(mode, MODES.length === 1));
	}

	if (summaries.length > 1) {
		console.log(`\n${'═'.repeat(64)}\nVerdict\n${'═'.repeat(64)}`);
		for (const s of summaries) {
			const tiers = [
				s.tiers.printedLists ? 'printedLists' : null,
				s.tiers.savedLists ? 'savedLists' : null,
				s.tiers.minivanExports ? 'minivanExports' : null,
			].filter(Boolean);
			console.log(
				`  mode ${s.mode} (${MODE_NAMES[s.mode].padEnd(11)}) ` +
					`auth ${s.authenticated ? 'yes' : 'NO '}  ` +
					`folders ${String(s.folderCount ?? '—').padStart(4)}  ` +
					`regions ${String(s.regionCount).padStart(4)}  ` +
					`routes ${String(s.routeCount).padStart(5)}  ` +
					`tiers: ${tiers.length > 0 ? tiers.join(', ') : 'Tier 1 only'}`,
			);
		}
		console.log('');
		for (const line of verdict(summaries)) console.log(`  ${line}`);
		console.log('\n  Then re-run with that mode set for the full detail:');
		console.log('    npm run van:check\n');
		return;
	}

	console.log(
		'\nNext: map the folder ids above to chapters under Settings → Chapter → VAN folders,\n' +
			'then POST /api/internal/van-sync?key=$INTERNAL_CRON_SECRET to fill van_turfs.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
