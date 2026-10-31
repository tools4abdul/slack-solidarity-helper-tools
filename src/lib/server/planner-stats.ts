// The query planner's statistics (sqlite_stat1).
//
// Without them SQLite guesses each table's size and each index's selectivity,
// and on this schema it guesses badly: it starts joins from the campaign's
// turf rather than the person index, and reads tens of millions of roster rows
// for a lookup that matches a few hundred. With them it picks those plans
// itself. They go stale as tables grow, so they are refreshed nightly. An
// index made since the last refresh — a migration's, or the roster's person
// index a drain rebuilt — has none until the next one, and the planner guesses
// at it meanwhile; a migration adding one runs ANALYZE on its table itself.
//
// Exact, not sampled: Turso refuses `PRAGMA analysis_limit`, so ANALYZE reads
// every row of every index, and holds the write lock while it does. One table
// at a time, so writes queued behind it wait for one table's indexes rather
// than the whole database's.
//
// Nothing here is required for correctness. To return the planner to its
// guesses: `DELETE FROM sqlite_stat1; ANALYZE sqlite_schema;`.

import type { drizzle } from 'drizzle-orm/libsql';

type Db = ReturnType<typeof drizzle>;

const NAME = /^\w+$/;

/** How long one ANALYZE took. */
export interface Analyzed {
	name: string;
	ms: number;
}

/** ANALYZE one table or index. */
export async function analyze(db: Db, name: string): Promise<Analyzed> {
	if (!NAME.test(name)) throw new Error(`not a table or index name: ${name}`);
	const started = Date.now();
	await db.$client.execute(`ANALYZE "${name}"`);
	return { name, ms: Date.now() - started };
}

export interface Refreshed {
	analyzed: Analyzed[];
	/** Tables whose ANALYZE failed. The rest are still done: one table's
	 *  statistics do not depend on another's. */
	failed: Array<{ name: string; error: unknown }>;
}

/** ANALYZE every table, one request each. */
export async function refreshPlannerStats(db: Db): Promise<Refreshed> {
	const tables = await db.$client.execute(
		`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
	);
	const result: Refreshed = { analyzed: [], failed: [] };
	for (const row of tables.rows) {
		const name = String(row.name);
		if (!NAME.test(name)) continue;
		try {
			result.analyzed.push(await analyze(db, name));
		} catch (error) {
			result.failed.push({ name, error });
		}
	}
	return result;
}
