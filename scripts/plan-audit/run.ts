// The plan audit: does any statement the app sends read a whole large table,
// as production's planner would run it?
//
//   npm run test:plans
//
// Runs the tests with record.ts, which plans every statement they send
// against a database with production's planner statistics (stats.json, from
// pull-stats.ts), then reports each plan that reads every row of a table of
// LARGE_TABLE_ROWS or more. One the code means to make goes in allow.ts with
// its reason. Exits non-zero for any other, for an app statement the planner
// refused, or when the tests fail.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED } from './allow.js';
import type { Recording } from './record.js';
import { largeScans, sizesFrom, type StatRow } from './rules.js';

const STATS = 'scripts/plan-audit/stats.json';
if (!existsSync(STATS)) {
	console.error(`${STATS} is missing: pull it with scripts/plan-audit/pull-stats.ts`);
	process.exit(1);
}
const stats = JSON.parse(readFileSync(STATS, 'utf8')) as {
	pulledAt: string;
	rows: StatRow[];
	/** Indexes production has no statistics for yet, given estimates by hand
	 *  so the audit can plan with them. The next pull replaces them. */
	estimated?: string[];
};
const sizes = sizesFrom(stats.rows);

const dir = mkdtempSync(join(tmpdir(), 'plan-audit-'));
const tests = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
	stdio: 'inherit',
	env: { ...process.env, PLAN_AUDIT: dir },
});

// Each SQL text once, with every source any test file saw send it.
const planned = new Map<string, { sql: string; plan: string[]; sources: Set<string> }>();
const skipped = new Map<string, { sql: string; error: string; sources: Set<string> }>();
for (const file of readdirSync(dir)) {
	const recording = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Recording;
	for (const stmt of recording.planned) {
		const known = planned.get(stmt.sql) ?? { ...stmt, sources: new Set<string>() };
		for (const source of stmt.sources) known.sources.add(source);
		planned.set(stmt.sql, known);
	}
	for (const stmt of recording.skipped) {
		const known = skipped.get(stmt.sql) ?? { ...stmt, sources: new Set<string>() };
		for (const source of stmt.sources) known.sources.add(source);
		skipped.set(stmt.sql, known);
	}
}
rmSync(dir, { recursive: true, force: true });

/** What sent it, leaving out tests with no app code below them. */
const appSources = (sources: Set<string>) => [...sources].filter((s) => s !== 'test').sort();

const allowed = (source: string, table: string) =>
	ALLOWED.some((a) => a.source === source && a.table === table);
const used = new Set<string>();
const findings: Array<{
	source: string;
	table: string;
	rows: number;
	detail: string;
	sql: string;
}> = [];
const fromApp = [...planned.values()].filter((stmt) => appSources(stmt.sources).length > 0);
for (const stmt of fromApp) {
	for (const scan of largeScans(stmt.plan, stmt.sql, sizes)) {
		// Every app source on its own: the same SQL allowed for one function is
		// not allowed for another.
		for (const source of appSources(stmt.sources)) {
			if (allowed(source, scan.table)) used.add(`${source} ${scan.table}`);
			else findings.push({ source, ...scan, sql: stmt.sql });
		}
	}
}
// A statement the planner refused is a gap in the audit, unless it names a
// table only a test makes.
const unplanned = [...skipped.values()].filter(
	(stmt) =>
		!planned.has(stmt.sql) &&
		appSources(stmt.sources).length > 0 &&
		!/no such table/.test(stmt.error),
);

console.log(
	`\nplan audit: ${fromApp.length} statements from app code planned with production's statistics of ${stats.pulledAt.slice(0, 10)}`,
);
if (stats.estimated?.length) {
	console.log(
		`  estimated, not production's: ${stats.estimated.join(', ')} (pull again once production has run ANALYZE on them)`,
	);
}
const stale = ALLOWED.filter((a) => !used.has(`${a.source} ${a.table}`));
for (const a of stale) {
	console.log(`  allowed but not seen (remove from allow.ts?): ${a.source} ${a.table}`);
}
for (const stmt of unplanned) {
	console.log(
		`\n  could not plan, from ${appSources(stmt.sources).join(', ')}: ${stmt.error}\n` +
			`    ${stmt.sql.replace(/\s+/g, ' ').slice(0, 160)}`,
	);
}
findings.sort((a, b) => a.source.localeCompare(b.source) || b.rows - a.rows);
for (const f of findings) {
	console.log(
		`\n  ${f.source}\n    ${f.detail}  (${f.table}, ${f.rows.toLocaleString('en-US')} rows)\n` +
			`    ${f.sql.replace(/\s+/g, ' ').slice(0, 160)}`,
	);
}
console.log(
	findings.length === 0
		? '\nno statement reads a whole large table'
		: `\n${findings.length} plan(s) read a whole large table`,
);
if (unplanned.length > 0)
	console.log(`${unplanned.length} statement(s) from app code could not be planned`);
process.exit(findings.length > 0 || unplanned.length > 0 || tests.status !== 0 ? 1 : 0);
