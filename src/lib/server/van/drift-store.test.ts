import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadDriftClaims, loadDriftTurfs, loadDriftVisibility } from './drift-store.js';
import { driftReport } from '../../van/turf-drift.js';

// Real in-memory libsql on the real migrations, as the sibling stores do. The
// point here is the visibility flag: it decides whether an empty report means
// "they agree" or "we could not look", and that lives in a row this test writes
// and reads back.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-05T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });

	for (const [id, folder, chapter, chapterName] of [
		[100, 1, 71, 'Washtenaw County'],
		[200, 1, 71, 'Washtenaw County'],
		[300, 2, 72, 'Wayne County'],
	] as const) {
		await client.execute(
			`INSERT INTO van_turfs (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, printed_list_number, first_seen_at, last_seen_at)
			 VALUES (${id}, 1, ${folder}, ${chapter}, '${chapterName}', 'Ann Arbor', 'Turf ${id}', 100, '35536745-${id}', '${iso(NOW.getTime())}', '${iso(NOW.getTime())}')`,
		);
	}

	// Chapter 71 sees folder 1, chapter 72 sees folder 2 — visibility comes from
	// this mapping now, not from van_turfs.chapter_id (chapter-visibility.ts).
	await client.execute(
		`INSERT INTO van_chapter_folders (chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (71, 1, 'Washtenaw County', 'U_ADMIN', 'Alice', '2026-01-01T00:00:00.000Z'),
		        (72, 2, 'Wayne County', 'U_ADMIN', 'Alice', '2026-01-01T00:00:00.000Z')`,
	);
});

const claimOn = (route: number, name = 'Dana') =>
	client.execute(
		`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at)
		 VALUES (${route}, 'U_VOL', '${name}', '${iso(NOW.getTime() - HOUR)}', '${iso(NOW.getTime() + 40 * HOUR)}')`,
	);

const distribute = (route: number, who: string) =>
	client.execute(
		`UPDATE van_turfs SET van_distributed_to = '${who}' WHERE map_route_id = ${route}`,
	);

const syncState = (ok: boolean | null) =>
	client.execute(
		`INSERT INTO van_sync_state (id, last_sync_at, minivan_exports_ok) VALUES (1, '${iso(NOW.getTime())}', ${ok === null ? 'NULL' : ok ? 1 : 0})`,
	);

const all = { chapterId: null };

// Each test opens its own in-memory client. Closing it keeps one per test from
// leaking for the life of the worker — which never shows up while this file is
// run on its own.
afterEach(() => {
	client.close();
});

describe('loadDriftTurfs', () => {
	// Half the drift is turf VAN says is out and our ledger says is free — that
	// row has no checkout to find it by, so an unclaimed turf must come back.
	it('returns turf whether or not anyone claimed it', async () => {
		await claimOn(100);
		const rows = await loadDriftTurfs(db, all);
		expect(rows.map((r) => r.mapRouteId).sort()).toEqual([100, 200, 300]);
	});

	it('filters to one chapter', async () => {
		const rows = await loadDriftTurfs(db, { chapterId: 72 });
		expect(rows.map((r) => r.mapRouteId)).toEqual([300]);
	});

	it('carries the columns the comparison needs', async () => {
		await distribute(100, 'Sam Rivera');
		const [row] = await loadDriftTurfs(db, { chapterId: 71 });
		expect(row).toMatchObject({
			vanDistributedTo: 'Sam Rivera',
			printedListNumber: '35536745-100',
		});
	});
});

describe('loadDriftClaims', () => {
	it('returns only claims the ledger has not closed', async () => {
		await claimOn(100);
		await client.execute(
			`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, release_reason)
			 VALUES (200, 'U2', 'Sam', '${iso(NOW.getTime() - 5 * HOUR)}', '${iso(NOW.getTime() + HOUR)}', '${iso(NOW.getTime() - HOUR)}', 'volunteer')`,
		);
		const claims = await loadDriftClaims(db, all);
		expect(claims.map((c) => c.mapRouteId)).toEqual([100]);
	});

	it('scopes by chapter through the join', async () => {
		await claimOn(100);
		await claimOn(300);
		expect(await loadDriftClaims(db, { chapterId: 72 })).toHaveLength(1);
	});
});

describe('loadDriftVisibility', () => {
	// The distinction the pane hangs on.
	it('is visible once a sync read /minivanExports', async () => {
		await syncState(true);
		expect(await loadDriftVisibility(db)).toBe('visible');
	});

	it('is unavailable when the last sync could not read them', async () => {
		await syncState(false);
		expect(await loadDriftVisibility(db)).toBe('van-side-unavailable');
	});

	// Before any sync there is genuinely nothing to compare, and an empty
	// report then would be reassurance drawn from an empty table.
	it('is unavailable when no sync has ever completed', async () => {
		expect(await loadDriftVisibility(db)).toBe('van-side-unavailable');
	});

	it('is unavailable when the flag was never set', async () => {
		await syncState(null);
		expect(await loadDriftVisibility(db)).toBe('van-side-unavailable');
	});
});

describe('the three reads together', () => {
	it('finds both directions of drift', async () => {
		await claimOn(100); // claimed here, not in MiniVAN
		await distribute(200, 'Sam Rivera'); // in MiniVAN, not claimed here
		await distribute(300, 'Alex Kim');
		await claimOn(300); // both sides agree — not drift
		await syncState(true);

		const report = driftReport(
			await loadDriftTurfs(db, all),
			await loadDriftClaims(db, all),
			NOW,
			await loadDriftVisibility(db),
		);
		expect(report.claimedNotInMinivan).toBe(1);
		expect(report.inMinivanNotClaimed).toBe(1);
		expect(report.items.map((i) => i.mapRouteId)).toEqual([200, 100]);
	});

	// Same rows, unreadable VAN side: the report must go quiet rather than
	// report the nulls as agreement.
	it('reports nothing when the sync could not read exports', async () => {
		await claimOn(100);
		await syncState(false);
		const report = driftReport(
			await loadDriftTurfs(db, all),
			await loadDriftClaims(db, all),
			NOW,
			await loadDriftVisibility(db),
		);
		expect(report.visibility).toBe('van-side-unavailable');
		expect(report.items).toEqual([]);
	});
});
