/**
 * Copy a slice of the production database into a local SQLite file, for
 * testing against real data and rehearsing migrations on it.
 *
 * What it copies:
 *   - The schema exactly as production has it — every table, index, trigger
 *     and view — and `__drizzle_migrations`, so `npm run db:migrate` against
 *     the copy applies the same pending migrations a deploy would.
 *   - Turf for the chapters you name (`--chapters`): the turf in their mapped
 *     VAN folders, and only the rows hanging off that turf — checkouts,
 *     geometry jobs, rosters, contact marks, MiniVAN exports.
 *   - Every other table whole: settings, chapter maps, reference data.
 *
 * What it leaves out, schema kept but no rows:
 *   - `sessions` and `slack_user_tokens` — logins and OAuth tokens. Sign in
 *     locally to get a session of your own.
 *   - `sync_locks` — a lock copied mid-run would stall the local sync.
 *   - `outside_volunteers` (and the retired `google_volunteers`)
 *     and `turf_notices` — the emails and messages of volunteers who signed
 *     in with Google or Apple.
 *
 * What it changes on the way: every Google or Apple volunteer's id becomes a
 * stand-in (`apple:replica-3`), their name becomes "Apple volunteer 3" on
 * checkouts and blocks and wherever else it appears as a canvasser name, and
 * the reason on their blocks is dropped. See replica-scrub.ts for exactly
 * which columns, and what it cannot see.
 *
 * Safety:
 *   - The source is only ever read. Every statement sent to it is checked to
 *     be a SELECT or a `PRAGMA table_info(...)` first, and anything else —
 *     including a PRAGMA that sets something — throws before it leaves this
 *     machine. It is opened as a plain remote client, never as an
 *     embedded replica, which would forward local writes to production.
 *   - The destination must be a new local file; an existing one is refused
 *     unless `--force`. `*.db` is gitignored.
 *   - The copy is built as `<out>.partial` and renamed into place only once
 *     every table has copied, so a run that fails part way — a wrong URL, an
 *     expired token — leaves no file behind. An empty file at `<out>` would
 *     otherwise look like a copy, and `db:migrate` would build a fresh, empty
 *     database in it without complaint.
 *
 * Usage (from project root), with the PRODUCTION database's URL and token in
 * the environment — REPLICA_SOURCE_URL / REPLICA_SOURCE_AUTH_TOKEN, or else
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN:
 *
 *   npm run db:replica -- --list-chapters
 *   npm run db:replica -- --chapters 71,72
 *   npm run db:replica -- --chapters 71 --out other.db --force
 *
 * A source that is a local file is refused, so a `.env.local` pointing at a
 * dev database cannot be copied onto itself by mistake.
 *
 * Then, against the copy (the env var wins over .env.local):
 *   TURSO_DATABASE_URL=file:local-replica.db npm run db:migrate
 *   TURSO_DATABASE_URL=file:local-replica.db npm run dev
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import { createClient, type InArgs, type InValue, type ResultSet } from '@libsql/client';
import { OUTSIDE_VOLUNTEER_TABLES, OutsideIdScrubber } from './replica-scrub.js';
import { insertRows } from './replica-insert.js';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = args[i + 1];
	return value && !value.startsWith('--') ? value : '';
}

const LIST_CHAPTERS = args.includes('--list-chapters');
const FORCE = args.includes('--force');
const OUT = flag('out') || 'local-replica.db';
const rawChapters = flag('chapters');

/** Tables whose rows are never copied. */
const SKIPPED = new Set([
	'sessions',
	'slack_user_tokens',
	'sync_locks',
	...OUTSIDE_VOLUNTEER_TABLES,
]);

/** One for the whole run, so a volunteer gets the same stand-in in every table. */
const scrubber = new OutsideIdScrubber();

const sourceUrl = process.env.REPLICA_SOURCE_URL ?? process.env.TURSO_DATABASE_URL ?? '';
const sourceToken = process.env.REPLICA_SOURCE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

if (!sourceUrl) fail('Set REPLICA_SOURCE_URL (or TURSO_DATABASE_URL) to the production database.');
// REPLICA_ALLOW_FILE_SOURCE is for rehearsing this script against a local
// stand-in for production; nothing else sets it.
if (sourceUrl.startsWith('file:') && process.env.REPLICA_ALLOW_FILE_SOURCE !== '1') {
	fail(`The source is a local file (${sourceUrl}) — point it at the production database.`);
}

const remote = createClient({ url: sourceUrl, authToken: sourceToken });

/** Statements this script may send to the source: a SELECT, or reading a
 *  table's columns. Nothing that writes, and no PRAGMA that sets anything. */
const READ_ONLY = /^\s*(select\b|pragma\s+table_info\s*\()/i;

/** An error with its causes: undici's "fetch failed" says nothing on its own,
 *  and the reason — a reset socket, a timeout — is on `cause`. */
function describe(err: unknown): string {
	const parts: string[] = [];
	for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
		if (e instanceof Error) {
			const code = (e as { code?: unknown }).code;
			parts.push(code ? `${e.message} (${String(code)})` : e.message);
		} else {
			parts.push(String(e));
			break;
		}
	}
	return parts.join(' ← ');
}

/** A SQL error from the database, which retrying cannot fix — as opposed to the
 *  network failing under a long run. */
function isSqlError(err: unknown): boolean {
	const code = (err as { code?: unknown }).code;
	return typeof code === 'string' && code.startsWith('SQLITE_');
}

const READ_ATTEMPTS = 5;

/** The only way this script talks to the source: reads, checked first, and
 *  retried with backoff when the network drops one. */
async function read(sql: string, params: InArgs = []): Promise<ResultSet> {
	if (!READ_ONLY.test(sql)) {
		throw new Error(`Refusing to send a non-read statement to the source: ${sql.slice(0, 60)}`);
	}
	for (let attempt = 1; ; attempt++) {
		try {
			return await remote.execute({ sql, args: params });
		} catch (err) {
			if (attempt >= READ_ATTEMPTS || isSqlError(err)) throw err;
			// The usual failure is a pooled connection Turso closed while it sat
			// idle: the request dies on the dead socket and a fresh one works. Retry
			// that once straight away, and quietly; anything after is reported.
			if (attempt === 1 && isClosedSocket(err)) continue;
			const wait = 1000 * 2 ** (attempt - 1);
			console.warn(`    read failed (${describe(err)}) — retrying in ${wait / 1000}s`);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
}

/** The request went out on a connection the server had already closed. */
function isClosedSocket(err: unknown): boolean {
	for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
		if ((e as { code?: unknown }).code === 'UND_ERR_SOCKET') return true;
	}
	return false;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function columnsOf(table: string): Promise<string[]> {
	const res = await read(`PRAGMA table_info(${quote(table)})`);
	return res.rows.map((r) => String(r.name));
}

/** The turf id column: `turf_id` since the rename, `map_route_id` before it. */
function turfIdColumn(columns: readonly string[]): string | null {
	if (columns.includes('turf_id')) return 'turf_id';
	if (columns.includes('map_route_id')) return 'map_route_id';
	return null;
}

async function listChapters(): Promise<void> {
	const turfCols = await columnsOf('van_turfs');
	const turfId = turfIdColumn(turfCols);
	if (!turfId) fail('van_turfs has neither turf_id nor map_route_id — unexpected schema.');
	const campaignJoin = turfCols.includes('campaign_id') ? 'and t.campaign_id = f.campaign_id' : '';
	const res = await read(
		`select f.chapter_id, f.chapter_name, count(distinct f.folder_id) as folders,
		        count(t.${turfId}) as turfs
		 from van_chapter_folders f
		 left join van_turfs t on t.folder_id = f.folder_id ${campaignJoin} and t.retired_at is null
		 group by f.chapter_id, f.chapter_name
		 order by turfs desc`,
	);
	console.log('\nChapters with mapped folders (live turf):\n');
	for (const r of res.rows) {
		console.log(
			`  ${String(r.chapter_id).padStart(6)}  ${String(r.chapter_name).padEnd(32)} ` +
				`${String(r.folders).padStart(3)} folder(s)  ${String(r.turfs).padStart(6)} turf`,
		);
	}
	console.log('\nThen: --chapters <id>,<id>\n');
}

/** Rows per request. A whole table, or every roster row of a few hundred turf,
 *  in one response is enough to make Turso drop the connection. */
const PAGE_ROWS = 2000;
/** Values per `in (...)`, under SQLite's parameter limit. */
const IN_CHUNK = 500;

/** A condition on the rows to copy. */
interface Filter {
	sql: string;
	args: InValue[];
}

/** A value's identity by content. Blobs — `person_hash` is one — come back as
 *  ArrayBuffers, which a Set or `===` tells apart by reference, so the same
 *  hash read from two turfs' rosters would otherwise count as two values. */
function valueKey(value: InValue): string {
	if (value instanceof ArrayBuffer) return `b:${Buffer.from(value).toString('hex')}`;
	if (ArrayBuffer.isView(value)) {
		return `b:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}`;
	}
	return `${typeof value}:${String(value)}`;
}

/** Values with duplicates removed by content (see valueKey). */
function distinct(values: Iterable<InValue>): InValue[] {
	const byKey = new Map<string, InValue>();
	for (const value of values) byKey.set(valueKey(value), value);
	return [...byKey.values()];
}

/**
 * `column in (values)`, split into conditions small enough to send.
 *
 * Values are de-duplicated first: a value in two chunks would match its row
 * twice, and the second copy fails the destination's primary key.
 */
function inFilters(column: string, values: Iterable<InValue>): Filter[] {
	const unique = distinct(values);
	const filters: Filter[] = [];
	for (let i = 0; i < unique.length; i += IN_CHUNK) {
		const chunk = unique.slice(i, i + IN_CHUNK);
		filters.push({
			sql: `${quote(column)} in (${chunk.map(() => '?').join(', ')})`,
			args: [...chunk],
		});
	}
	return filters;
}

/**
 * The rows of `table` matching any of `filters` (all rows when null), a page at
 * a time in rowid order. Every table here has a rowid: none is declared
 * WITHOUT ROWID.
 */
async function* pages(
	table: string,
	filters: readonly Filter[] | null,
): AsyncGenerator<ResultSet['rows']> {
	const page = (filter: Filter | null, after: number | null) => {
		const where: string[] = [];
		const args: InValue[] = [];
		if (filter) {
			where.push(`(${filter.sql})`);
			args.push(...filter.args);
		}
		if (after !== null) {
			where.push('rowid > ?');
			args.push(after);
		}
		return read(
			`select rowid as "__rowid", * from ${quote(table)}` +
				(where.length > 0 ? ` where ${where.join(' and ')}` : '') +
				` order by rowid limit ${PAGE_ROWS}`,
			args,
		);
	};
	for (const filter of filters ?? [null]) {
		let pending = page(filter, null);
		for (;;) {
			const res = await pending;
			if (res.rows.length === 0) break;
			// The next page is asked for before this one is written locally, so
			// the source connection never sits idle long enough to be closed.
			const more = res.rows.length === PAGE_ROWS;
			const next = more ? page(filter, Number(res.rows[res.rows.length - 1]!.__rowid)) : null;
			// Awaited on the next turn; if the caller stops first, its failure
			// must not surface as an unhandled rejection.
			next?.catch(() => {});
			yield res.rows;
			if (!next) break;
			pending = next;
		}
	}
}

async function main(): Promise<void> {
	console.log(`\nSource (read only): ${sourceUrl}`);
	if (LIST_CHAPTERS) return listChapters();

	const chapterIds = (rawChapters ?? '')
		.split(',')
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isInteger(n) && n > 0);
	if (chapterIds.length === 0) {
		fail('Name the chapters to copy turf for: --chapters 71,72 (see --list-chapters).');
	}
	if (existsSync(OUT) && !FORCE) fail(`${OUT} exists — pass --force to replace it.`);
	const partial = `${OUT}.partial`;
	if (existsSync(partial)) rmSync(partial);
	console.log(`Destination: file:${OUT}\nChapters: ${chapterIds.join(', ')}\n`);
	const local = createClient({ url: `file:${partial}` });
	try {
		await copyInto(local, chapterIds);
	} catch (err) {
		local.close();
		rmSync(partial, { force: true });
		throw err;
	}
	local.close();
	if (existsSync(OUT)) rmSync(OUT);
	renameSync(partial, OUT);
	console.log(
		`\nDone: file:${OUT}.\n` + `Next: TURSO_DATABASE_URL=file:${OUT} npm run db:migrate\n`,
	);
}

/** Where an outside volunteer's id sits beside their name: the sign-in
 *  records (never copied themselves) and the turf rows that name holders. */
const OUTSIDE_NAME_SOURCES: Array<{ table: string; id: string; name: string }> = [
	{ table: 'outside_volunteers', id: 'user_id', name: 'display_name' },
	{ table: 'google_volunteers', id: 'user_id', name: 'display_name' },
	{ table: 'van_turf_checkouts', id: 'slack_user_id', name: 'slack_user_name' },
	{ table: 'van_blocked_users', id: 'slack_user_id', name: 'display_name' },
];

async function learnOutsideNames(tables: readonly string[]): Promise<void> {
	for (const source of OUTSIDE_NAME_SOURCES) {
		if (!tables.includes(source.table)) continue;
		const res = await read(
			`select distinct ${quote(source.id)} as id, ${quote(source.name)} as name
			 from ${quote(source.table)}
			 where ${quote(source.id)} like 'google:%' or ${quote(source.id)} like 'apple:%'`,
		);
		for (const row of res.rows) {
			scrubber.learn(String(row.id), row.name === null ? null : String(row.name));
		}
	}
}

/** Schema and rows, from the source into `local`. Throws rather than calling
 *  `fail`, so the caller can remove the partial file on the way out. */
async function copyInto(
	local: ReturnType<typeof createClient>,
	chapterIds: readonly number[],
): Promise<void> {
	// The schema, as production has it. Tables first, so indexes, triggers and
	// views have something to attach to; SQLite's own tables are made for us.
	// Triggers wait until the rows are in: they guard the app's writes, and
	// tables are copied in no particular order, so one checking another table
	// (van_chapter_folders → turf_custom_chapters) would refuse rows that are
	// fine once both are copied.
	const schema = await read(
		`select type, name, sql from sqlite_master
		 where sql is not null and name not like 'sqlite_%'
		 order by case type when 'table' then 0 when 'index' then 1 else 2 end, rowid`,
	);
	const triggers = schema.rows.filter((r) => r.type === 'trigger');
	for (const row of schema.rows) {
		if (row.type !== 'trigger') await local.execute(String(row.sql));
	}
	const tables = schema.rows.filter((r) => r.type === 'table').map((r) => String(r.name));

	// Every Google or Apple volunteer's real name, before any row is copied,
	// so it can be replaced in the canvasser columns that carry no id — some
	// of which are copied before the rows that tie the name to them.
	await learnOutsideNames(tables);

	// The chapters' turf: everything in the folders they are mapped to, which is
	// how the app decides what a chapter sees. Joined on campaign too, once
	// production has campaigns.
	const turfCols = await columnsOf('van_turfs');
	const turfId = turfIdColumn(turfCols);
	if (!turfId)
		throw new Error('van_turfs has neither turf_id nor map_route_id — unexpected schema.');
	const folderCols = await columnsOf('van_chapter_folders');
	const folderKey = folderCols.includes('campaign_id') ? 'campaign_id, folder_id' : 'folder_id';
	const turfRows: ResultSet['rows'] = [];
	for await (const page of pages('van_turfs', [
		{
			sql: `(${folderKey}) in (
			   select ${folderKey} from van_chapter_folders
			   where chapter_id in (${chapterIds.map(() => '?').join(', ')}))`,
			args: [...chapterIds],
		},
	])) {
		turfRows.push(...page);
	}
	console.log(`  ${turfRows.length} turf in those chapters\n`);
	const turfIds = turfRows.map((r) => r[turfId] as InValue);
	const listNumbers = turfRows
		.map((r) => r.printed_list_number)
		.filter((v): v is string => typeof v === 'string' && v !== '');

	const counts: Array<[string, number, string]> = [];
	let rosterHashes: InValue[] = [];
	// Roster before contacts: contact marks are copied for the roster's people.
	const ordered = [...tables].sort(
		(a, b) => Number(b === 'van_turf_roster') - Number(a === 'van_turf_roster'),
	);
	for (const table of ordered) {
		const columns = await columnsOf(table);
		// What to copy: nothing, given rows, or the source rows matching filters
		// (null = every row).
		let source: { rows: ResultSet['rows'] } | { filters: Filter[] | null } | null;
		let how: string;
		if (SKIPPED.has(table)) {
			source = null;
			how = 'left out';
		} else if (table === 'van_turfs') {
			source = { rows: turfRows };
			how = 'chapters';
		} else if (table === 'van_person_contacts' && columns.includes('person_hash')) {
			source = { filters: inFilters('person_hash', rosterHashes) };
			how = "the turf's people";
		} else if (table === 'van_minivan_exports' && columns.includes('list_number')) {
			source = { filters: inFilters('list_number', listNumbers) };
			how = "the turf's lists";
		} else if (table.startsWith('van_') && turfIdColumn(columns)) {
			source = { filters: inFilters(turfIdColumn(columns)!, turfIds) };
			how = "the chapters' turf";
		} else {
			source = { filters: null };
			how = 'whole';
		}

		let copied = 0;
		let duplicates = 0;
		const hashes: InValue[] = [];
		const take = async (rows: ResultSet['rows']) => {
			const skipped = await insertRows(local, table, columns, rows, scrubber);
			copied += rows.length - skipped;
			duplicates += skipped;
			if (table === 'van_turf_roster' && columns.includes('person_hash')) {
				for (const r of rows) hashes.push(r.person_hash as InValue);
			}
		};
		try {
			if (source && 'rows' in source) await take(source.rows);
			else if (source) for await (const page of pages(table, source.filters)) await take(page);
		} catch (err) {
			throw new Error(`copying ${table} (${copied} row(s) in)`, { cause: err });
		}
		if (table === 'van_turf_roster') rosterHashes = distinct(hashes);
		console.log(
			`  ${table.padEnd(34)} ${String(copied).padStart(7)}  ${how}` +
				(duplicates > 0 ? ` (${duplicates} skipped: two spellings of one stand-in)` : ''),
		);
		counts.push([table, copied, how]);
	}
	for (const row of triggers) await local.execute(String(row.sql));
	const count = (table: string) => counts.find(([t]) => t === table)?.[1] ?? 0;
	console.log(`\n${count('__drizzle_migrations')} migration(s) recorded as applied.`);
	console.log(`${scrubber.count} Google or Apple volunteer(s) replaced with stand-ins.`);
	// Production always has its settings row and a migration history. Without
	// them this is not production — most likely the URL points somewhere else.
	if (count('app_config') === 0 || count('__drizzle_migrations') === 0) {
		console.warn(
			'\nWARNING: the source has no app_config row or no migration history — is ' +
				'REPLICA_SOURCE_URL really the production database?',
		);
	}
}

main().catch((err) => {
	console.error(`\nFailed: ${describe(err)}`);
	process.exit(1);
});
