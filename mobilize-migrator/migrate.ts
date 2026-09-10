// Syncs upcoming in-person Solidarity events into Mobilize, from the CLI.
//
//   npx tsx mobilize-migrator/migrate.ts              # dry run, writes a plan
//   npx tsx mobilize-migrator/migrate.ts --apply      # create and update events
//   npx tsx mobilize-migrator/migrate.ts --apply --limit 3
//
// A thin wrapper over lib/sync.ts — the same engine the scheduled endpoint runs,
// against the same Turso ledger. Both matter: this script once had its own copy
// of the create loop (and silently missed features added to the shared one), and
// its own JSON ledger (which drifted from the server's the moment either ran).
//
// Dry run is the default on purpose: creating an event is publicly visible and
// there is no bulk undo. Prefer the endpoint
// (POST /api/internal/mobilize-sync) for scheduled work; this is for dry runs
// and local inspection.

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TursoLedger } from '../src/lib/server/mobilize-ledger.js';
import { findDuplicate } from './lib/dedupe.js';
import { env, requireEnv } from './lib/env.js';
import { fetchPageDescriptions } from './lib/pages.js';
import { loadApiConfig } from './lib/mobilize.js';
import { fetchAllEvents } from './lib/solidarity.js';
import { runSync } from './lib/sync.js';
import { CAMPAIGN_TIMEZONE } from './lib/payload.js';
import { planMigration } from './lib/transform.js';

const here = dirname(fileURLToPath(import.meta.url));
// Run artifact, not source: rewritten every run, so it lives in gitignored private/.
const PRIVATE_DIR = resolve(here, '../private');
const PLAN_PATH = resolve(PRIVATE_DIR, 'migration-plan.json');

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const createLimit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
// `--limit` with a missing or non-numeric value yields NaN, and `report.created
// >= NaN` is always false — so the run would create EVERY planned event
// publicly, which is the exact opposite of what someone typing `--limit` wants.
// A cap that cannot be understood has to stop the run, not lift itself.
if (limitArg >= 0 && (!Number.isInteger(createLimit) || createLimit! < 0)) {
	console.error(
		`--limit needs a non-negative whole number, got: ${args[limitArg + 1] ?? '(nothing)'}`,
	);
	process.exit(1);
}

// Fail fast on missing credentials rather than after a long read phase.
const api = loadApiConfig();
// The v1 API requires a contact on every create and update. The server reads
// this from /settings; the CLI has no db, so it is env-only here.
const contact = {
	name: env('MOBILIZE_CONTACT_NAME'),
	emailAddress: requireEnv('MOBILIZE_CONTACT_EMAIL', 'set it in .env.local'),
	phoneNumber: env('MOBILIZE_CONTACT_PHONE'),
};
// The same ledger the server writes, so the two can never disagree about what
// has already been created.
const ledger = new TursoLedger(
	drizzle(
		createClient({
			url: requireEnv('TURSO_DATABASE_URL', 'set it in .env.local'),
			authToken: env('TURSO_AUTH_TOKEN') || undefined,
		}),
	),
);

console.log('Fetching Solidarity events…');
const solidarityEvents = await fetchAllEvents();
// The events endpoint flattens descriptions to plain text; the linked
// ActionPages carry the formatted originals.
console.log('Fetching Solidarity event pages (formatted descriptions)…');
const pageDescriptions = await fetchPageDescriptions();
console.log(`  ${pageDescriptions.size} pages with descriptions`);

const { planned, skipped, excludedByTag } = planMigration(
	solidarityEvents,
	Date.now(),
	pageDescriptions,
);
console.log(
	`  ${solidarityEvents.length} events fetched → ${planned.length} candidate Mobilize events, ` +
		`${skipped.length} skipped, ${excludedByTag.length} excluded by tag`,
);

const report = await runSync(
	planned,
	{
		api,
		contact,
		// The CLI is interactive, so the runaway guard is loose here; --limit is
		// the knob you actually reach for.
		maxCreatesPerRun: Number.MAX_SAFE_INTEGER,
		createLimit,
		apply,
		log: (message) => console.log(`  ${message}`),
	},
	ledger,
	findDuplicate,
);

console.log(`\n=== ALREADY IN MOBILIZE — SKIPPING (${report.skippedExisting}) ===`);
for (const detail of report.skippedDetails) {
	console.log(`  - "${detail.title}" → ${detail.reason}`);
}

if (excludedByTag.length > 0) {
	console.log(`\n=== EXCLUDED BY TAG (${excludedByTag.length}) ===`);
	for (const s of excludedByTag) {
		console.log(`  - [solidarity #${s.solidarityEventId}] ${s.title}`);
	}
}

if (skipped.length > 0) {
	console.log(`\n=== NEEDS MANUAL ATTENTION (${skipped.length}) ===`);
	for (const s of skipped) {
		console.log(`  - [solidarity #${s.solidarityEventId}] ${s.title}: ${s.reason}`);
	}
}

console.log(`\n=== ${apply ? 'CREATED' : 'WILL CREATE'} (${report.created}) ===`);
for (const title of report.createdTitles) console.log(`  - ${title}`);

console.log(`\n=== ${apply ? 'UPDATED' : 'WILL UPDATE'} (${report.updated}) ===`);
for (const title of report.updatedTitles) console.log(`  - ${title}`);

for (const err of report.errors) console.error(`  ! ${err}`);

// private/ is gitignored, so it won't exist in a fresh clone.
mkdirSync(PRIVATE_DIR, { recursive: true });
writeJson(PLAN_PATH, {
	generatedAt: new Date().toISOString(),
	timezone: CAMPAIGN_TIMEZONE,
	apply,
	report,
	plannedEvents: planned,
	skippedNoAddress: skipped,
	excludedByTag,
});
console.log(`\nFull plan written to ${PLAN_PATH}`);

if (report.abortedReason) console.error(`\nABORTED: ${report.abortedReason}`);
if (report.authFailed) {
	console.error(
		'\nMobilize rejected the API key — check MOBILIZE_API_KEY and that it has write access, ' +
			'then re-run; progress is saved.',
	);
}

console.log(
	`\n${apply ? 'Done' : 'Dry run'}: ${report.created} created, ${report.updated} updated, ` +
		`${report.unchanged} unchanged, ${report.failed} failed.`,
);
if (!apply) console.log('Re-run with --apply to write these.');

// Exit non-zero on a run that did not do what it was asked. Without this a
// revoked API key, an aborted guardrail, or a run where every create was
// rejected all exit 0 — and any wrapper (a cron, a CI step) reads that as
// success and never surfaces it.
if (report.failed > 0 || report.authFailed || report.abortedReason) {
	process.exitCode = 1;
}
