/**
 * Prove the Google Sheets credential works and that every configured
 * spreadsheet is actually reachable. Read-only — this script never writes a row
 * or creates a tab.
 *
 * Run it after adding the routing rules under Settings → Checkout spreadsheets
 * and after sharing each spreadsheet with the service account. It answers the
 * three questions that block the Packet Tracker sync, in order:
 *   1. Does the service-account key parse and mint a token at all?
 *   2. Is each spreadsheet SHARED with it? An unshared sheet answers 403, and
 *      that is by far the most common way this is half-configured — a dozen
 *      spreadsheets means a dozen chances to miss one.
 *   3. Does each have the campaign's Packet Tracker tab, with every column the
 *      app writes? The tab is the campaign's and the app never creates it, and
 *      columns are found by header name — so a renamed header is a sync that
 *      cannot write. Knowing which beats guessing at 8am on a canvass day.
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
import { createSheetsClient, type SheetsResult } from '../src/lib/server/google/sheets.js';
import { vanSheetTargets, appConfig } from '../src/lib/server/schema.js';
import { DEFAULT_SHEET_TAB_NAME, findLayout } from '../src/lib/van/packet-tracker.js';

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

// Google allows this service account 60 read requests a minute — a hard cap —
// and the check makes one per spreadsheet (two when the tab is missing, to list
// what is there). With a few dozen spreadsheets, sending them back to back
// can run through the quota, and the client's own backoff (8s at most) cannot
// outwait a one-minute window.
// So reads are paced under the limit, and a 429 that still gets through — the
// app's own sync shares this quota — waits out the whole window before retrying.
const READ_INTERVAL_MS = 1_100;
const QUOTA_WINDOW_MS = 61_000;
const QUOTA_RETRIES = 2;

let nextReadAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, which makes `reads` read requests, no faster than the quota
 *  allows. */
async function paced<V>(
	reads: number,
	fn: () => Promise<SheetsResult<V>>,
): Promise<SheetsResult<V>> {
	for (let attempt = 0; ; attempt++) {
		const wait = nextReadAt - Date.now();
		if (wait > 0) await sleep(wait);
		nextReadAt = Date.now() + reads * READ_INTERVAL_MS;
		const res = await fn();
		if (res.ok || res.status !== 429 || attempt >= QUOTA_RETRIES) return res;
		console.log(`  … read quota used up — waiting ${QUOTA_WINDOW_MS / 1000}s for it to reset`);
		nextReadAt = Date.now() + QUOTA_WINDOW_MS;
	}
}

async function main(): Promise<void> {
	console.log(`\nService account: ${clientEmail}`);

	const targets = await db.select().from(vanSheetTargets);
	if (targets.length === 0) {
		console.log(
			'\nNo routing rules are configured, so the Packet Tracker sync is off.\n' +
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

	console.log(
		`\nChecking ${bySheet.size} spreadsheet(s) — about ${Math.ceil((bySheet.size * READ_INTERVAL_MS) / 60_000)} min, paced under Google's read quota:\n`,
	);
	let unreachable = 0;
	let missingTab = 0;

	for (const [spreadsheetId, { label, prefixes }] of bySheet) {
		const tab = await paced(1, () => sheets.readTab({ spreadsheetId, tabName }));
		if (tab.ok) {
			// The columns are found by header name, so check they are all there
			// before the sync tries to write.
			const layout = findLayout(tab.value);
			if (layout.ok) {
				console.log(`  ✓ ${label} — reachable, "${tabName}" has every column`);
			} else {
				missingTab += 1;
				console.log(`  ✗ ${label} — "${tabName}" is missing: ${layout.missing.join(', ')}`);
			}
		} else if (tab.status === 404) {
			// Either no such spreadsheet or no such tab; describe says which.
			const res = await paced(1, () => sheets.describe({ spreadsheetId, tabName }));
			if (res.ok) {
				missingTab += 1;
				console.log(
					`  ✗ ${label} — reachable, but has no "${tabName}" tab (the app never creates it)`,
				);
				console.log(`      tabs: ${res.value.tabs.join(', ') || '(none)'}`);
			} else {
				unreachable += 1;
				console.log(`  ✗ ${label}`);
				console.log(`      ${spreadsheetId}`);
				console.log(`      ${res.status || 'network'}: ${res.error} — no spreadsheet with that id`);
			}
		} else {
			unreachable += 1;
			const hint = tab.status === 403 ? ` — share it with ${clientEmail} as an Editor` : '';
			console.log(`  ✗ ${label}`);
			console.log(`      ${spreadsheetId}`);
			console.log(`      ${tab.status || 'network'}: ${tab.error}${hint}`);
		}
		console.log(`      rules: ${prefixes.join(', ')}`);
	}

	console.log('');
	if (unreachable + missingTab > 0) {
		console.log(
			`  ${unreachable + missingTab} spreadsheet(s) cannot be written to. Checkouts for them will be\n` +
				'  held — not lost — and the turf channel gets one alert per problem.\n',
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		'  All reachable.\n' +
			'  Check the routing itself at /turfs/sheet-map, then POST\n' +
			'  /api/internal/van-sync?key=$INTERNAL_CRON_SECRET to sync.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
