// What the plan audit counts as a problem: a statement whose plan, under
// production's planner statistics, reads a whole large table. See run.ts.
//
// No `$` imports: the runner and the vitest setup both load this.

/** A row of sqlite_stat1, as pull-stats.ts saves it. */
export interface StatRow {
	tbl: string;
	idx: string | null;
	stat: string;
}

/** Tables this size or larger are worth an index on every query. */
export const LARGE_TABLE_ROWS = 10_000;

export interface Sizes {
	tables: Map<string, number>;
	/** A partial index holds only the rows it covers, so it has its own. */
	indexes: Map<string, number>;
}

/** Row counts, from the first figure of each row of statistics. */
export function sizesFrom(stats: readonly StatRow[]): Sizes {
	const tables = new Map<string, number>();
	const indexes = new Map<string, number>();
	for (const { tbl, idx, stat } of stats) {
		const rows = Number.parseInt(stat.split(' ')[0] ?? '', 10);
		if (!Number.isFinite(rows)) continue;
		if (idx !== null) indexes.set(idx, rows);
		if (idx === null || !isPartial(idx, stats)) {
			tables.set(tbl, Math.max(tables.get(tbl) ?? 0, rows));
		}
	}
	return { tables, indexes };
}

/** An index with fewer rows than another on its table covers only some of
 *  them; the table's size is the largest. */
function isPartial(idx: string, stats: readonly StatRow[]): boolean {
	const row = stats.find((s) => s.idx === idx)!;
	const rows = (s: StatRow) => Number.parseInt(s.stat.split(' ')[0] ?? '', 10);
	return stats.some((s) => s.tbl === row.tbl && rows(s) > rows(row));
}

const NOT_ALIASES = new Set([
	'where',
	'on',
	'inner',
	'left',
	'right',
	'cross',
	'join',
	'using',
	'group',
	'order',
	'limit',
	'set',
	'values',
	'natural',
	'outer',
	'full',
	'indexed',
	'not',
	'union',
	'except',
	'intersect',
	'window',
	'having',
	'returning',
]);

/** The table behind each alias in `from` and `join` clauses, so a plan's
 *  `SCAN r` can be read as `SCAN van_turf_roster`. */
export function aliases(sql: string): Map<string, string> {
	const found = new Map<string, string>();
	const clause = /\b(?:from|join|update|into)\s+[`"]?(\w+)[`"]?(?:\s+(?:as\s+)?[`"]?(\w+)[`"]?)?/gi;
	for (const m of sql.matchAll(clause)) {
		const table = m[1]!;
		found.set(table, table);
		const alias = m[2];
		if (alias && !NOT_ALIASES.has(alias.toLowerCase())) found.set(alias, table);
	}
	return found;
}

export interface Scan {
	table: string;
	rows: number;
	detail: string;
}

/**
 * The plan's reads of a whole large table: a `SCAN` of it, with or without an
 * index (a covering index scanned end to end is still every row), or an
 * automatic index, which SQLite builds by reading every row first.
 */
export function largeScans(
	plan: readonly string[],
	sql: string,
	sizes: Sizes,
	minRows = LARGE_TABLE_ROWS,
): Scan[] {
	const names = aliases(sql);
	return plan.flatMap((detail) => {
		const m = /^(?:SCAN (\S+)|SEARCH (\S+) USING AUTOMATIC)/.exec(detail);
		const name = m?.[1] ?? m?.[2];
		if (!name) return [];
		const table = names.get(name) ?? name;
		// A scan of an index reads the index: all of a partial one is only the
		// rows it covers.
		const index = m?.[1] ? /USING (?:COVERING )?INDEX (\w+)/.exec(detail)?.[1] : undefined;
		// An index production has no statistics for is taken at its table's
		// size: unknown is not small. One it counted as empty is.
		const rows =
			(index === undefined ? undefined : sizes.indexes.get(index)) ?? sizes.tables.get(table) ?? 0;
		return rows >= minRows ? [{ table, rows, detail }] : [];
	});
}
