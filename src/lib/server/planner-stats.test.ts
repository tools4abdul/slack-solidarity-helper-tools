// Against a real (in-memory) libSQL database, migrated as production is.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { analyze, refreshPlannerStats } from './planner-stats.js';

let client: Client;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	for (let i = 1; i <= 50; i++) {
		await client.execute({
			sql: `INSERT INTO van_turf_roster (turf_id, person_hash, door_hash) VALUES (?, ?, ?)`,
			args: [i % 5, Buffer.from(String(i).padStart(16, '0')), Buffer.from('door'.padEnd(16))],
		});
	}
});

afterEach(() => client.close());

const stats = async () =>
	(await client.execute('SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx')).rows.map(
		(r) => ({
			tbl: String(r.tbl),
			idx: r.idx === null ? null : String(r.idx),
			stat: String(r.stat),
		}),
	);

describe('refreshPlannerStats', () => {
	it('records the size of every index, one table at a time', async () => {
		const { analyzed, failed } = await refreshPlannerStats(db);
		expect(failed).toEqual([]);
		expect(analyzed.map((a) => a.name)).toContain('van_turf_roster');
		expect(analyzed.some((a) => a.name.startsWith('sqlite_'))).toBe(false);
		const person = (await stats()).find((s) => s.idx === 'van_turf_roster_person');
		expect(person?.stat.split(' ')[0]).toBe('50');
	});

	it('carries on past a table that fails, and names it', async () => {
		const execute = client.execute.bind(client);
		const failing = new Proxy(client, {
			get(target, prop) {
				if (prop === 'execute') {
					return (stmt: Parameters<Client['execute']>[0]) =>
						stmt === 'ANALYZE "van_turfs"' ? Promise.reject(new Error('refused')) : execute(stmt);
				}
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const { analyzed, failed } = await refreshPlannerStats(drizzle(failing));
		expect(failed.map((f) => f.name)).toEqual(['van_turfs']);
		expect(analyzed.map((a) => a.name)).toContain('van_turf_roster');
	});
});

describe('analyze', () => {
	it('refreshes one index alone', async () => {
		await analyze(db, 'van_turf_roster_person');
		expect((await stats()).map((s) => s.idx)).toEqual(['van_turf_roster_person']);
	});

	it('refuses a name that is not one', async () => {
		await expect(analyze(db, 'x"; DROP TABLE van_turfs; --')).rejects.toThrow(
			'not a table or index name',
		);
	});
});
