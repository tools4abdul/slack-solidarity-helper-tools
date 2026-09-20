import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadGeometryFailures, loadGeometryProgress } from './geometry-progress-store.js';

let db: ReturnType<typeof drizzle>;
let client: Client;
const AT = '2026-09-20T00:00:00.000Z';

async function turf(
	mapRouteId: number,
	over: Record<string, string | number | null> = {},
): Promise<void> {
	const row: Record<string, string | number | null> = {
		map_route_id: mapRouteId,
		map_region_id: 1,
		folder_id: 1,
		chapter_id: 71,
		chapter_name: 'Chapter',
		region_name: 'Region',
		name: `Turf ${mapRouteId}`,
		saved_list_id: 900 + mapRouteId,
		door_count: 100,
		hull_json: null,
		centroid_lat: null,
		retired_at: null,
		first_seen_at: AT,
		last_seen_at: AT,
		...over,
	};
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO van_turfs (${cols}) VALUES (${vals})`);
}

async function queued(
	mapRouteId: number,
	status: string,
	over: Record<string, string | number | null> = {},
): Promise<void> {
	const row: Record<string, string | number | null> = {
		map_route_id: mapRouteId,
		saved_list_id: 900 + mapRouteId,
		status,
		attempts: status === 'failed' ? 4 : 1,
		last_error: null,
		...over,
	};
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO van_geometry_queue (${cols}) VALUES (${vals})`);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

describe('loadGeometryProgress', () => {
	it('counts shapes, pins, outstanding work and dead letters', async () => {
		await turf(100, { hull_json: '[{"lat":42,"lng":-83}]', centroid_lat: 42 });
		await turf(200, { centroid_lat: 42 }); // centroid only — drawn as a pin
		await turf(300); // queued
		await queued(300, 'pending');
		await turf(400); // mid-flight
		await queued(400, 'running');
		await turf(500); // gave up
		await queued(500, 'failed');

		expect(await loadGeometryProgress(db)).toEqual({
			eligible: 5,
			shaped: 1,
			centroidOnly: 1,
			// `running` is not a state an organizer needs told apart from queued.
			pending: 2,
			failed: 1,
		});
	});

	it('ignores retired turf, which is off the map anyway', async () => {
		await turf(100, { hull_json: '[{"lat":42,"lng":-83}]' });
		await turf(200, { retired_at: AT });
		await queued(200, 'pending');

		expect(await loadGeometryProgress(db)).toMatchObject({
			eligible: 1,
			shaped: 1,
			pending: 0,
		});
	});

	it('leaves turf with no saved list out of the denominator', async () => {
		// Nothing can be exported for it, so counting it would hold the total
		// below 100% forever.
		await turf(100, { hull_json: '[{"lat":42,"lng":-83}]' });
		await turf(200, { saved_list_id: null });

		expect(await loadGeometryProgress(db)).toMatchObject({ eligible: 1, shaped: 1 });
	});

	it('reports zeroes on an empty database rather than throwing', async () => {
		expect(await loadGeometryProgress(db)).toEqual({
			eligible: 0,
			shaped: 0,
			centroidOnly: 0,
			pending: 0,
			failed: 0,
		});
	});
});

describe('loadGeometryFailures', () => {
	it('names the turf and the error that stopped it', async () => {
		await turf(500, { name: 'Brighton Turf 03' });
		await queued(500, 'failed', { last_error: 'downloadUrl returned HTTP 403' });
		await turf(600);
		await queued(600, 'pending');

		const failures = await loadGeometryFailures(db);
		expect(failures).toEqual([
			{
				mapRouteId: 500,
				name: 'Brighton Turf 03',
				attempts: 4,
				lastError: 'downloadUrl returned HTTP 403',
			},
		]);
	});

	it('honours the limit', async () => {
		for (const id of [100, 200, 300]) {
			await turf(id);
			await queued(id, 'failed');
		}
		expect(await loadGeometryFailures(db, 2)).toHaveLength(2);
	});
});
