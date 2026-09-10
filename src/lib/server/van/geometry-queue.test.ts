import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runCatalogSync } from './sync.js';
import type { VanClient } from './client.js';
import type { VanMapRegion } from './types.js';

// Real in-memory libsql, for the same reason sync-lock.test.ts uses one: the
// guarantee under test is the semantics of a single INSERT .. ON CONFLICT DO
// UPDATE .. WHERE, and a chained fake could only assert the query was SHAPED a
// certain way — which would keep passing if the WHERE stopped matching.
//
// What this protects is Story 2.5's re-cut path end to end. A re-cut turf keeps
// its mapRouteId and gets a new savedListId, so a queue keyed by mapRouteId has
// to notice the saved list changed or the turf never gets fresh geometry.

// Inferred rather than annotated as LibSQLDatabase<...>: runCatalogSync takes
// the wider `ReturnType<typeof drizzle>`, which also carries `$client`.
let db: ReturnType<typeof drizzle>;
let client: Client;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	for (const ddl of [
		`CREATE TABLE van_turfs (
			map_route_id integer PRIMARY KEY NOT NULL, map_region_id integer, folder_id integer,
			chapter_id integer, chapter_name text DEFAULT '' NOT NULL, region_name text DEFAULT '' NOT NULL,
			name text NOT NULL, saved_list_id integer, printed_list_number text, route_number integer,
			route_size integer DEFAULT 0 NOT NULL, door_count integer DEFAULT 0 NOT NULL,
			phone_count integer DEFAULT 0 NOT NULL, centroid_lat real, centroid_lng real, hull_json text,
			hull_source_route_size integer, van_distributed_to text, drift_alerted_at text,
			drift_alerted_kind text, first_seen_at text NOT NULL,
			last_seen_at text NOT NULL, last_refreshed_at text, retired_at text)`,
		`CREATE TABLE van_geometry_queue (
			map_route_id integer PRIMARY KEY NOT NULL, saved_list_id integer NOT NULL,
			export_job_id integer, status text DEFAULT 'pending' NOT NULL,
			attempts integer DEFAULT 0 NOT NULL, requested_at text, completed_at text, last_error text)`,
		`CREATE TABLE van_turf_checkouts (
			id integer PRIMARY KEY AUTOINCREMENT NOT NULL, map_route_id integer NOT NULL,
			slack_user_id text NOT NULL, slack_user_name text NOT NULL, claimed_at text NOT NULL,
			expires_at text NOT NULL, released_at text, release_reason text)`,
		`CREATE TABLE van_sync_state (
			id integer PRIMARY KEY NOT NULL, last_sync_at text NOT NULL, minivan_exports_ok integer)`,
	]) {
		await client.execute(ddl);
	}
	db = drizzle(client);
});

/** One folder, one region, one route — with the saved list id under test. */
function vanClientWith(savedListId: number, routeSize = 76): VanClient {
	const regions: VanMapRegion[] = [
		{
			mapRegionId: 508413,
			name: 'Orlando',
			dateRefreshed: null,
			mapRoutes: [
				{
					mapRouteId: 56456,
					name: 'Orlando Turf 01',
					savedListId,
					routeNumber: 1,
					routeSize,
					doorCount: 68,
					phoneCount: 0,
					printedList: { number: '1234' },
				},
			],
		},
	];
	return {
		folders: async () => [{ folderId: 2731, name: 'Test Folder' }],
		mapRegions: async () => regions,
		printedLists: async () => [],
		savedLists: async () => [],
		minivanExports: async () => [],
		refreshMapRegion: async () => undefined,
		exportJobTypes: async () => [],
		createExportJob: async () => ({}) as never,
		exportJob: async () => ({}) as never,
		get: async () => undefined as never,
	};
}

const MAPPINGS = [{ chapterId: 71, chapterName: 'Orange County', folderIds: [2731] }];

async function queueRow() {
	const res = await client.execute('SELECT * FROM van_geometry_queue WHERE map_route_id = 56456');
	return res.rows[0] ?? null;
}

/** Mark the row the way a successful worker run would. */
async function markDone(savedListId: number) {
	await client.execute({
		sql: `UPDATE van_geometry_queue SET status='done', attempts=1, export_job_id=?, completed_at='2026-09-01T00:00:00Z' WHERE map_route_id=56456`,
		args: [savedListId],
	});
}

describe('geometry queue re-arming', () => {
	it('queues a turf that has no hull', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		const row = await queueRow();
		expect(row!.saved_list_id).toBe(585052);
		expect(row!.status).toBe('pending');
	});

	// The bug this replaced `onConflictDoNothing` for. Observed live: the demo
	// region was re-cut and "Orlando Turf 01" moved from saved list 585052 to
	// 585484, after which POST /exportJobs answered `'savedListId' must be a
	// valid saved list ID in this context` for as long as the stale row stood.
	it('re-arms a settled row when the turf is re-cut onto a new saved list', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await markDone(585052);

		await runCatalogSync(db, vanClientWith(585484), MAPPINGS);

		const row = await queueRow();
		expect(row!.saved_list_id).toBe(585484);
		expect(row!.status).toBe('pending');
		expect(row!.attempts).toBe(0);
		// Everything describing the previous saved list's job is cleared —
		// leaving the old id behind would make the worker resume by polling a
		// job belonging to a list that no longer exists.
		expect(row!.export_job_id).toBeNull();
		expect(row!.completed_at).toBeNull();
	});

	// The other half of the rule, and the one that keeps this endpoint's 37
	// runs a day from becoming 37 export jobs a day per turf. A turf with no
	// hull is re-queued by `needsGeometry` on every single sync.
	it('leaves a settled row alone when the saved list is unchanged', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await markDone(585052);

		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);

		const row = await queueRow();
		expect(row!.status).toBe('done');
		expect(row!.attempts).toBe(1);
		expect(row!.export_job_id).toBe(585052);
	});

	it('does not resurrect a dead-lettered row on an unchanged saved list', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await client.execute(
			`UPDATE van_geometry_queue SET status='failed', attempts=4, last_error='boom' WHERE map_route_id=56456`,
		);

		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);

		const row = await queueRow();
		expect(row!.status).toBe('failed');
		expect(row!.last_error).toBe('boom');
	});

	// A re-cut is exactly when a dead letter deserves another go: the saved
	// list that failed is gone, so the reason it failed may be gone too.
	it('does resurrect a dead-lettered row when the saved list changes', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await client.execute(
			`UPDATE van_geometry_queue SET status='failed', attempts=4, last_error='boom' WHERE map_route_id=56456`,
		);

		await runCatalogSync(db, vanClientWith(585484), MAPPINGS);

		const row = await queueRow();
		expect(row!.status).toBe('pending');
		expect(row!.attempts).toBe(0);
		expect(row!.last_error).toBeNull();
	});

	// The original reason for onConflictDoNothing, which must still hold: a row
	// the worker is mid-flight on is not reset under its feet.
	it('does not disturb a running row on an unchanged saved list', async () => {
		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);
		await client.execute(
			`UPDATE van_geometry_queue SET status='running', attempts=1, export_job_id=900 WHERE map_route_id=56456`,
		);

		await runCatalogSync(db, vanClientWith(585052), MAPPINGS);

		const row = await queueRow();
		expect(row!.status).toBe('running');
		expect(row!.export_job_id).toBe(900);
	});
});
