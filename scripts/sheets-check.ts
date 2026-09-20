/**
 * Prove the Google Sheets credential works and that every configured
 * spreadsheet is actually reachable. Read-only — this script never writes a row
 * or creates a tab.
 *
 * Run it after adding the routing rules under Settings → Checkout spreadsheets
 * and after sharing each spreadsheet with the service account. It answers the
 * three questions that block the checkout log, in order:
 *   1. Does the service-account key parse and mint a token at all?
 *   2. Is each spreadsheet SHARED with it? An unshared sheet answers 403, and
 *      that is by far the most common way this is half-configured — a dozen
 *      spreadsheets means a dozen chances to miss one.
 *   3. Does each already have the app's tab? Not having one is fine: the first
 *      sync creates it. Knowing which is which beats guessing at 8am on a
 *      canvass day.
 *
 * Usage (from project root):
 *   npm run sheets:check
 *
 * Required env vars:
 *   GOOGLE_SHEETS_SERVICE_ACCOUNT — the whole service-account JSON key
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:) —
 *   the routing rules and the tab name are read from the database, so that this
 *   checks what the sync will actually do rather than a second copy of it.
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createSheetsClient } from '../src/lib/server/google/sheets.js';
import { vanSheetTargets, appConfig } from '../src/lib/server/schema.js';
import { DEFAULT_SHEET_TAB_NAME } from '../src/lib/van/sheet-log.js';

const raw = process.env['GOOGLE_SHEETS_SERVICE_ACCOUNT'] ?? '';
if (!raw) {
	console.error('Missing required env var: GOOGLE_SHEETS_SERVICE_ACCOUNT');
	process.exit(1);
}

let clientEmail = '';
let privateKey = '';
try {
	const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
	clientEmail = parsed.client_email ?? '';
	// Literal \n escapes survive a trip through a shell; unescape them the same
	// way google-env.ts does, so this script and the app agree about the key.
	privateKey = (parsed.private_key ?? '').replace(/\\n/g, '\n');
} catch {
	console.error('GOOGLE_SHEETS_SERVICE_ACCOUNT is not valid JSON.');
	process.exit(1);
}
if (!clientEmail || !privateKey) {
	console.error('GOOGLE_SHEETS_SERVICE_ACCOUNT needs both client_email and private_key.');
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));
const sheets = createSheetsClient({ clientEmail, privateKey });

async function main(): Promise<void> {
	console.log(`\nService account: ${clientEmail}`);

	const targets = await db.select().from(vanSheetTargets);
	if (targets.length === 0) {
		console.log(
			'\nNo routing rules are configured, so the checkout log is off.\n' +
				'Add them under Settings → Checkout spreadsheets.\n',
		);
		return;
	}

	const [cfg] = await db.select().from(appConfig).limit(1);
	const tabName = cfg?.vanSheetTabName?.trim() || DEFAULT_SHEET_TAB_NAME;
	console.log(`Tab: ${tabName}`);

	// Several rules routinely point at one spreadsheet — the campaign's two
	// Downriver rules do — so check each sheet once and list its rules beside it.
	const bySheet = new Map<string, { label: string; prefixes: string[] }>();
	for (const row of targets) {
		const entry = bySheet.get(row.spreadsheetId);
		if (entry) entry.prefixes.push(row.prefix);
		else bySheet.set(row.spreadsheetId, { label: row.label, prefixes: [row.prefix] });
	}

	console.log(`\nChecking ${bySheet.size} spreadsheet(s):\n`);
	let unreachable = 0;
	let missingTab = 0;

	for (const [spreadsheetId, { label, prefixes }] of bySheet) {
		const res = await sheets.describe({ spreadsheetId, tabName });
		if (!res.ok) {
			unreachable += 1;
			const hint =
				res.status === 403
					? ` — share it with ${clientEmail} as an Editor`
					: res.status === 404
						? ' — no spreadsheet with that id'
						: '';
			console.log(`  ✗ ${label}`);
			console.log(`      ${spreadsheetId}`);
			console.log(`      ${res.status || 'network'}: ${res.error}${hint}`);
		} else if (!res.value.hasTab) {
			missingTab += 1;
			console.log(`  • ${label} — reachable, no "${tabName}" tab yet (the sync will create it)`);
			console.log(`      tabs: ${res.value.tabs.join(', ') || '(none)'}`);
		} else {
			console.log(`  ✓ ${label} — reachable, has the "${tabName}" tab`);
		}
		console.log(`      rules: ${prefixes.join(', ')}`);
	}

	console.log('');
	if (unreachable > 0) {
		console.log(
			`  ${unreachable} spreadsheet(s) cannot be written to. Checkouts for them will be\n` +
				'  held — not lost — and the turf channel gets one alert per problem.\n',
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		`  All reachable${missingTab > 0 ? `, ${missingTab} awaiting their tab` : ''}.\n` +
			'  Check the routing itself at /turfs/sheet-map, then POST\n' +
			'  /api/internal/van-sync?key=$INTERNAL_CRON_SECRET to drain.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
