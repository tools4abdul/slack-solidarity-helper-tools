/**
 * List every VAN map region name, across every folder the key can see.
 * Read-only — this script never writes to VAN or to the database.
 *
 * This exists because region names are the input to the checkout log's routing
 * rules (Settings → Checkout spreadsheets), and nothing else prints them all:
 * `van:check` is a probe rather than an inventory — it stops at the first
 * folder holding turf, `--folder` narrows it to one, and the region lines are
 * suppressed entirely unless VAN_DATABASE_MODE pins a single mode.
 * `van:sync --dry-run` reports counts, not names. So writing a prefix rule
 * meant reading names out of VAN's own UI a folder at a time.
 *
 * It reads VAN live rather than `van_turfs`, deliberately: the rules have to be
 * writable BEFORE the first catalog sync, and a sync needs the chapter → folder
 * mapping that this output is often what decides. After a sync,
 * /turfs/sheet-map answers the same question against what was actually stored,
 * and also says where each region currently routes.
 *
 * Usage (from project root):
 *   npm run van:regions               # grouped by folder
 *   npm run van:regions -- --flat     # one name per line, sorted, deduped
 *   npm run van:regions -- --prefixes # the distinct leading codes, with counts
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE (0 = My Voters, 1 = My Campaign)
 */

import { createVanClient, VanError, type VanDatabaseMode } from '../src/lib/server/van/client.js';

const args = process.argv.slice(2);
const FLAT = args.includes('--flat');
const PREFIXES = args.includes('--prefixes');

const appName = process.env['VAN_APP_NAME'] ?? '';
const apiKey = process.env['VAN_API_KEY'] ?? '';
const rawMode = (process.env['VAN_DATABASE_MODE'] ?? '').trim();

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

const client = createVanClient({
	appName,
	apiKey,
	databaseMode: Number(rawMode) as VanDatabaseMode,
});

/** The leading code a region is cut under — `R04C_Livingston_…` → `R04C`.
 *  Null when the name does not start with one, which is worth seeing rather
 *  than hiding: a region nobody can write a code-based rule for is exactly the
 *  one that ends up unrouted. */
function leadingCode(name: string): string | null {
	const first = name.split(/[._]+/)[0]?.trim() ?? '';
	return /^[A-Z]{1,3}\d{1,3}[A-Z]?$/i.test(first) ? first.toUpperCase() : null;
}

async function main(): Promise<void> {
	console.log(`\nVAN regions — app "${appName}", mode ${rawMode}\n`);

	const folders = await client.folders();
	if (folders.length === 0) {
		console.log('No folders visible to this key.\n');
		return;
	}

	const all: string[] = [];
	// One folder at a time, and a folder that fails is reported rather than
	// fatal — the same posture the catalog sync takes. A key that can read
	// eighteen of nineteen folders should print eighteen, not nothing.
	const failures: string[] = [];

	for (const folder of folders) {
		let regions;
		try {
			regions = await client.mapRegions(folder.folderId);
		} catch (err) {
			failures.push(
				`${folder.name} (${folder.folderId}): ${
					err instanceof VanError ? err.message : String(err)
				}`,
			);
			continue;
		}
		if (regions.length === 0) continue;

		const names = regions
			.map((r) => r.name ?? '')
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
		all.push(...names);

		if (!FLAT && !PREFIXES) {
			console.log(`${folder.name} (folder ${folder.folderId}) — ${regions.length} region(s)`);
			for (const name of names) {
				const routes = regions.find((r) => r.name === name)?.mapRoutes?.length ?? 0;
				console.log(`  ${name}  ${routes} turf(s)`);
			}
			console.log('');
		}
	}

	const unique = [...new Set(all)].sort((a, b) => a.localeCompare(b));

	if (FLAT) {
		for (const name of unique) console.log(name);
	}

	if (PREFIXES) {
		const byCode = new Map<string, number>();
		for (const name of unique) {
			const code = leadingCode(name) ?? '(no leading code)';
			byCode.set(code, (byCode.get(code) ?? 0) + 1);
		}
		console.log('Leading codes — each is a candidate rule prefix:\n');
		for (const [code, count] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
			console.log(`  ${code.padEnd(20)} ${count} region(s)`);
		}
		console.log('');
	}

	if (failures.length > 0) {
		console.log('Folders that could not be read:');
		for (const line of failures) console.log(`  ${line}`);
		console.log('');
	}

	console.log(
		`${unique.length} distinct region name(s) across ${folders.length} folder(s).\n` +
			'Write rules covering these under Settings → Checkout spreadsheets,\n' +
			'then check them at /turfs/sheet-map.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
