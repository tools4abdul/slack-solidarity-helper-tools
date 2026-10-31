// The plan audit's vitest setup, loaded only when PLAN_AUDIT names a directory
// (see run.ts and vite.config.ts).
//
// Every libSQL client a test creates is wrapped to note each statement it
// sends and the app code that sent it. After the file's tests, each statement
// is planned with EXPLAIN QUERY PLAN against a database migrated as production
// is and given production's planner statistics, and the plans are written to
// the directory for run.ts to judge. The tests' own databases are tiny, so
// their plans say nothing about production's; this one plans as production
// would.

import { afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Client, InArgs, InStatement } from '@libsql/client';
import type { StatRow } from './rules.js';

export interface PlannedStatement {
	sql: string;
	/** Everything that sent it: `path#function` of the first app frame, or the
	 *  path alone; `test` for a test with no app code below it. One SQL text
	 *  can come from a test fixture and from the app, or from two functions,
	 *  and each is judged on its own. */
	sources: string[];
	plan: string[];
}

/** A statement EXPLAIN QUERY PLAN refused, and why. */
export interface SkippedStatement {
	sql: string;
	sources: string[];
	error: string;
}

/** What one test file's run writes for run.ts. */
export interface Recording {
	planned: PlannedStatement[];
	skipped: SkippedStatement[];
}

const recorded = vi.hoisted(
	() => new Map<string, { sql: string; args: InArgs | undefined; sources: Set<string> }>(),
);

const APP_FRAME = /\/(src|mobilize-migrator|scripts)\//;
const NOT_APP = /node_modules|\.test\.|\.spec\.|\/scripts\/plan-audit\/|request-timing/;

/** The first frame of app code below the call, as `path#function`; `test`
 *  when only a test sent it (fixtures and assertions, which production never
 *  runs). */
function caller(): string {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	const stack = new Error().stack ?? '';
	Error.stackTraceLimit = limit;
	let fromTest = false;
	for (const line of stack.split('\n').slice(1)) {
		const m = /at (?:async )?(?:(\S+) \()?(?:file:\/\/)?([^()]+?):\d+:\d+\)?$/.exec(line.trim());
		if (!m) continue;
		const [, fn, path] = m;
		if (path && /\.(test|spec)\./.test(path)) fromTest = true;
		if (!path || !APP_FRAME.test(path) || NOT_APP.test(path)) continue;
		const file = relative(process.cwd(), path);
		const name = fn?.split('.').pop();
		return name && name !== '<anonymous>' ? `${file}#${name}` : file;
	}
	return fromTest ? 'test' : 'unknown';
}

/**
 * The app code that built the drizzle query now running. A query awaited as
 * it is built (`await db.select()…`) reaches the client a microtask later,
 * from a stack with no app frame left on it, but it was built synchronously
 * from one that has. So each query is tagged with its builder's caller as it
 * is built, and the tag is current while its `then` runs, which is when it
 * calls the client.
 */
const BUILT_BY = Symbol('plan-audit built by');
let running: string | undefined;
{
	const sqlite = await import('drizzle-orm/sqlite-core');
	const { QueryPromise } = await import('drizzle-orm');
	const tagging = (proto: object, names: readonly string[]) => {
		const methods = proto as Record<string, (...args: unknown[]) => unknown>;
		for (const name of names) {
			const original = methods[name]!;
			methods[name] = function (this: unknown, ...args: unknown[]) {
				const query = original.apply(this, args);
				if (query && typeof query === 'object') {
					(query as Record<symbol, string>)[BUILT_BY] = caller();
				}
				return query;
			};
		}
	};
	tagging(sqlite.SQLiteSelectBuilder.prototype, ['from']);
	tagging(sqlite.SQLiteInsertBuilder.prototype, ['values', 'select']);
	tagging(sqlite.SQLiteUpdateBuilder.prototype, ['set']);
	tagging(sqlite.BaseSQLiteDatabase.prototype, ['delete']);
	for (const proto of [QueryPromise.prototype, sqlite.SQLiteSelectBase.prototype]) {
		const methods = proto as unknown as Record<string, (...args: unknown[]) => unknown>;
		const then = methods.then!;
		methods.then = function (this: Record<symbol, string>, ...args: unknown[]) {
			const outer = running;
			running = this[BUILT_BY];
			try {
				return then.apply(this, args);
			} finally {
				running = outer;
			}
		};
	}
}

/** Statements whose plan is worth reading: reads and writes of rows. */
const PLANNED = /^\s*(with|select|insert|update|delete|replace)\b/i;

function note(stmt: InStatement): void {
	const { sql, args } = typeof stmt === 'string' ? { sql: stmt, args: undefined } : stmt;
	if (!PLANNED.test(sql) || /sqlite_|__drizzle_migrations/.test(sql)) return;
	const found = caller();
	const source = found === 'unknown' ? (running ?? found) : found;
	const known = recorded.get(sql);
	if (known) known.sources.add(source);
	else recorded.set(sql, { sql, args, sources: new Set([source]) });
}

function recording<T extends object>(target: T): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value: unknown = Reflect.get(obj, prop, obj);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			if (prop === 'execute') {
				return (stmt: InStatement, ...rest: unknown[]) => {
					note(stmt);
					return method.apply(obj, [stmt, ...rest]);
				};
			}
			if (prop === 'batch') {
				return (stmts: InStatement[], ...rest: unknown[]) => {
					for (const stmt of stmts) note(stmt);
					return method.apply(obj, [stmts, ...rest]);
				};
			}
			if (prop === 'transaction') {
				return async (...args: unknown[]) => recording((await method.apply(obj, args)) as object);
			}
			return method.bind(obj);
		},
	});
}

vi.mock('@libsql/client', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@libsql/client')>();
	return {
		...mod,
		createClient: (config: Parameters<typeof mod.createClient>[0]) =>
			recording(mod.createClient(config)),
	};
});

/** A database migrated as production is, planning with production's
 *  statistics. */
async function plannerLikeProduction(): Promise<Client> {
	const { createClient } = await vi.importActual<typeof import('@libsql/client')>('@libsql/client');
	const { drizzle } = await import('drizzle-orm/libsql');
	const { migrate } = await import('drizzle-orm/libsql/migrator');
	const client = createClient({ url: ':memory:' });
	await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
	const stats = JSON.parse(
		readFileSync(join(process.cwd(), 'scripts/plan-audit/stats.json'), 'utf8'),
	) as { rows: StatRow[] };
	// ANALYZE creates sqlite_stat1; its rows are then production's, and
	// `ANALYZE sqlite_schema` has the planner read them.
	await client.execute('ANALYZE');
	await client.execute('DELETE FROM sqlite_stat1');
	for (const row of stats.rows) {
		await client.execute({
			sql: 'INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)',
			args: [row.tbl, row.idx, row.stat],
		});
	}
	await client.execute('ANALYZE sqlite_schema');
	return client;
}

afterAll(async () => {
	const dir = process.env.PLAN_AUDIT;
	if (!dir || recorded.size === 0) return;
	const planner = await plannerLikeProduction();
	const recording: Recording = { planned: [], skipped: [] };
	for (const { sql, args, sources } of recorded.values()) {
		try {
			const result = await planner.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args ?? [] });
			recording.planned.push({
				sql,
				sources: [...sources],
				plan: result.rows.map((row) => String(row.detail)),
			});
		} catch (err) {
			// run.ts decides which matter: a table a test made for itself is
			// nothing production runs; anything else leaves the audit short.
			recording.skipped.push({
				sql,
				sources: [...sources],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	planner.close();
	writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify(recording));
});
