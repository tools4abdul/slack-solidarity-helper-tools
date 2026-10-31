// Saves production's planner statistics for the plan audit (run.ts).
//
//   npx tsx --env-file=.env.local scripts/plan-audit/pull-stats.ts
//
// Reads sqlite_stat1 only: table and index names and row counts, no data. It
// is empty until ANALYZE has run in production (planner-stats.ts). Pull again
// when a table grows or shrinks by a lot, or an index is added, so the audit
// plans with today's proportions.

import { writeFileSync } from 'node:fs';
import { createClient, type Row } from '@libsql/client';
import { dbConfig } from '../../bin/db-config.js';

const client = createClient(dbConfig);
let rows: Row[];
try {
	rows = (await client.execute('SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx')).rows;
} catch {
	rows = [];
}
if (rows.length === 0) {
	console.error(
		'sqlite_stat1 is empty or missing: run ANALYZE in production first ' +
			'(the planner-stats job, or ANALYZE in turso db shell).',
	);
	process.exit(1);
}
const stats = {
	pulledAt: new Date().toISOString(),
	rows: rows.map((r) => ({
		tbl: String(r.tbl),
		idx: r.idx === null ? null : String(r.idx),
		stat: String(r.stat),
	})),
};
writeFileSync('scripts/plan-audit/stats.json', `${JSON.stringify(stats, null, '\t')}\n`);
console.log(`saved ${stats.rows.length} rows of planner statistics`);
client.close();
