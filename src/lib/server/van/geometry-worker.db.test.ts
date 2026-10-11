// runGeometryQueue against a real (in-memory) libSQL database. The unit tests
// stub drizzle, which cannot show that the one batch a finished turf writes —
// hull, roster, recount and the done row — actually runs, in order, as SQL.
import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { runGeometryQueue } from './geometry-worker.js';
import type { VanClient } from './client.js';
import { createPersonHasher } from './person-hash.js';

let db: ReturnType<typeof drizzle>;
let client: Client;
const AT = '2026-09-20T00:00:00.000Z';

const CSV = [
	'VanID,FirstName,LastName,Address,VAddressLatitude,VAddressLongitude,DOB',
	'1,Ron,Campbell,"4190 S Kirkman Rd , Orlando, FL",28.500,-81.400,1968-08-09',
	'2,Ada,Lovelace,"12 Main St , Orlando, FL",28.510,-81.400,1815-12-10',
	'3,Alan,Turing,"9 Elm St , Orlando, FL",28.510,-81.390,1912-06-23',
	'4,Grace,Hopper,"3 Oak St , Orlando, FL",28.500,-81.390,1906-12-09',
	'',
].join('\r\n');

const job = {
	exportJobId: 900,
	type: 5,
	savedListId: 1100,
	status: 'Completed',
	downloadUrl: 'https://ngpvan.blob.core.windows.net/x.csv',
	dateExpired: null,
	errorCode: null,
};
const van = {
	createExportJob: async () => job,
	exportJob: async () => job,
} as unknown as VanClient;

async function seed(turfId: number): Promise<void> {
	await client.execute(
		`INSERT INTO van_turfs (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id,
			chapter_name, region_name, name, saved_list_id, door_count, route_size,
			first_seen_at, last_seen_at)
		VALUES (${turfId}, ${turfId}, 1, 1, 71, 'Chapter', 'Region', 'Turf ${turfId}', 1100,
			4, 4, '${AT}', '${AT}')`,
	);
	await client.execute(
		`INSERT INTO van_geometry_queue (turf_id, saved_list_id, status, attempts)
		VALUES (${turfId}, 1100, 'pending', 0)`,
	);
}

async function run(batchRecount: boolean, on: typeof db = db) {
	return runGeometryQueue(on, van, {
		campaignId: 1,
		exportJobTypeId: 5,
		webhookUrlFor: () => 'https://example.test/hook',
		sleep: async () => undefined,
		fetchFn: async () => new Response(CSV, { status: 200 }),
		geocode: null,
		roster: createPersonHasher('test-secret'),
		batchRecount,
	});
}

async function turfRow(turfId: number) {
	const { rows } = await client.execute(
		`SELECT hull_json, roster_saved_list_id, uncontacted_doors FROM van_turfs WHERE turf_id = ${turfId}`,
	);
	return rows[0]!;
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
});

describe('runGeometryQueue on a real database', () => {
	for (const batchRecount of [false, true]) {
		it(`stores hull, roster, count and done${batchRecount ? ' with the recount batched' : ''}`, async () => {
			await seed(100);
			await seed(200);

			const result = await run(batchRecount);

			expect(result.hullsStored).toBe(2);
			expect(result.rostersStored).toBe(2);
			// One batch per turf, each carrying its four roster rows; the
			// breakdown sits inside the db stage, never beyond it.
			const t = result.timings;
			expect([t.writes, t.writeRows, t.writeRowsSq]).toEqual([2, 8, 32]);
			expect(t.writeRowsMs).toBe(4 * t.writeMs);
			expect(t.writeMs + t.recountMs).toBeLessThanOrEqual(t.dbMs);
			if (!batchRecount) expect(t.recountMs).toBe(0);
			for (const turfId of [100, 200]) {
				const turf = await turfRow(turfId);
				expect(JSON.parse(turf.hull_json as string)).toHaveLength(4);
				expect(turf.roster_saved_list_id).toBe(1100);
				// No contacts yet: every door is uncontacted, so the count is the
				// roster's doors — which only a recount after the roster can give.
				expect(turf.uncontacted_doors).toBe(4);
			}
			const roster = await client.execute(
				'SELECT turf_id, count(*) AS n FROM van_turf_roster GROUP BY turf_id ORDER BY turf_id',
			);
			expect(roster.rows.map((r) => [r.turf_id, r.n])).toEqual([
				[100, 4],
				[200, 4],
			]);
			const queue = await client.execute(
				'SELECT status, attempts, export_job_id FROM van_geometry_queue ORDER BY turf_id',
			);
			expect(queue.rows.map((r) => [r.status, r.attempts, r.export_job_id])).toEqual([
				['done', 1, 900],
				['done', 1, 900],
			]);
		});
	}

	it('writes nothing of a turf whose batch fails part way', async () => {
		await seed(100);
		// The roster insert comes after the hull update in the batch.
		await client.execute(
			`CREATE TRIGGER no_roster BEFORE INSERT ON van_turf_roster
			BEGIN SELECT RAISE(ABORT, 'roster write failed'); END`,
		);

		const result = await run(true);

		expect(result.hullsStored).toBe(0);
		expect(result.rostersStored).toBe(0);
		const turf = await turfRow(100);
		expect(turf.hull_json).toBeNull();
		expect(turf.roster_saved_list_id).toBeNull();
		const queue = await client.execute(
			'SELECT status, attempts, export_job_id, last_error FROM van_geometry_queue',
		);
		const row = queue.rows[0]!;
		// Retried later, with the attempt counted.
		expect([row.status, row.attempts]).toEqual(['pending', 1]);
		expect(row.last_error).toMatch(/roster write failed/);
	});

	it('hands back the turfs whose end-of-run recount failed, without throwing', async () => {
		await seed(100);
		await seed(200);
		// Only the recount goes through db.run with batchRecount on; the
		// per-turf writes are query builders inside db.batch.
		const failingRun = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'run') return () => Promise.reject(new Error('connection reset'));
				return Reflect.get(target, prop, receiver);
			},
		});

		const result = await run(true, failingRun);

		expect(result.rostersStored).toBe(2);
		expect([...result.unrecounted].sort()).toEqual([100, 200]);
		expect(result.warnings.join('\n')).toMatch(/connection reset/);
		for (const turfId of [100, 200]) {
			const turf = await turfRow(turfId);
			expect(turf.roster_saved_list_id).toBe(1100);
			// Left for VAN's door count, not a stale one.
			expect(turf.uncontacted_doors).toBeNull();
		}
	});
});
