import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	exportCursor,
	loadClaimsForExports,
	loadMinivanExports,
	pullMinivanExports,
	stampClaimsLoaded,
} from './minivan-export-store.js';
import type { VanClient } from './client.js';
import type { VanMinivanExport } from './types.js';

// Real in-memory libsql on the real migrations, as the sibling stores do. What
// matters here is the cursor: each sync must ask VAN only for what is new, and
// must never skip a day it has not finished reading.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-23T19:00:00.000Z');

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
});

const exp = (
	id: number,
	dateCreated: string,
	name = `List ${id}-00000`,
	canvassers: VanMinivanExport['canvassers'] = [{ firstName: 'Tammy', lastName: 'B' }],
): VanMinivanExport => ({
	minivanExportId: id,
	name,
	dateCreated,
	createdBy: null,
	canvassers,
	databaseMode: 0,
});

function vanReturning(items: VanMinivanExport[], complete = true) {
	const minivanExportsSince = vi.fn(async () => ({ items, complete }));
	return { client: { minivanExportsSince } as unknown as VanClient, minivanExportsSince };
}

describe('exportCursor', () => {
	it('backfills 30 days on an empty store', () => {
		expect(exportCursor(null, NOW)).toBe('2026-08-24');
	});

	// Re-reading the newest day is how exports that landed later that day get
	// picked up; the day after would skip them.
	it('resumes from the DATE of the newest stored export, not the day after', () => {
		expect(exportCursor('2026-09-22T11:52:28.15Z', NOW)).toBe('2026-09-22');
	});

	it('never reaches back past the lookback, however stale the store', () => {
		expect(exportCursor('2026-06-01T00:00:00Z', NOW)).toBe('2026-08-24');
	});

	it('ignores a date it cannot read', () => {
		expect(exportCursor('not a date', NOW)).toBe('2026-08-24');
	});
});

describe('pullMinivanExports', () => {
	it('stores what VAN returns and resumes from it next time', async () => {
		const first = vanReturning([
			exp(1, '2026-09-13T17:19:02.657Z'),
			exp(2, '2026-09-22T11:52:28.15Z'),
		]);
		const result = await pullMinivanExports(db, first.client, { now: NOW });
		expect(result).toEqual({ from: '2026-08-24', fetched: 2, complete: true });

		const second = vanReturning([]);
		await pullMinivanExports(db, second.client, { now: NOW });
		expect(second.minivanExportsSince).toHaveBeenCalledWith('2026-09-22', 150);
	});

	it('parses the list number the catalog joins on', async () => {
		const { client: van } = vanReturning([
			exp(1, '2026-09-22T11:52:28.15Z', 'List 59430821-62783'),
			exp(2, '2026-09-22T11:52:28.15Z', 'downtown LO Turf 01'),
		]);
		await pullMinivanExports(db, van, { now: NOW });
		const rows = await client.execute(
			'SELECT minivan_export_id, list_number FROM van_minivan_exports ORDER BY minivan_export_id',
		);
		expect(rows.rows.map((r) => r.list_number)).toEqual(['59430821-62783', null]);
	});

	// The overlap day comes back on every sync. It must update, not duplicate
	// or fail on the primary key.
	it('upserts an export read twice, keeping VAN’s latest canvassers', async () => {
		await pullMinivanExports(db, vanReturning([exp(1, '2026-09-22T11:52:28.15Z')]).client, {
			now: NOW,
		});
		await pullMinivanExports(
			db,
			vanReturning([exp(1, '2026-09-22T11:52:28.15Z', 'List 1-00000', [{ firstName: 'Sam' }])])
				.client,
			{ now: NOW },
		);
		const rows = await client.execute('SELECT canvassers_json FROM van_minivan_exports');
		expect(rows.rows).toHaveLength(1);
		expect(JSON.parse(String(rows.rows[0]!.canvassers_json))).toEqual([{ firstName: 'Sam' }]);
	});

	it('passes through an incomplete walk so the sync keeps drift unavailable', async () => {
		const result = await pullMinivanExports(
			db,
			vanReturning([exp(1, '2026-08-30T10:00:00Z')], false).client,
			{ now: NOW },
		);
		expect(result.complete).toBe(false);

		// …and the next run picks up where that one stopped.
		const next = vanReturning([]);
		await pullMinivanExports(db, next.client, { now: NOW });
		expect(next.minivanExportsSince).toHaveBeenCalledWith('2026-08-30', 150);
	});

	it('prunes exports older than the retention window', async () => {
		await pullMinivanExports(
			db,
			vanReturning([exp(1, '2026-07-01T10:00:00Z'), exp(2, '2026-09-20T10:00:00Z')]).client,
			{ now: NOW },
		);
		const rows = await client.execute('SELECT minivan_export_id FROM van_minivan_exports');
		expect(rows.rows.map((r) => r.minivan_export_id)).toEqual([2]);
	});

	// A failed read writes nothing and keeps what the last good one stored —
	// which is what stops a bad sync from blanking van_distributed_to.
	it('throws when VAN does, leaving the store as it was', async () => {
		await pullMinivanExports(db, vanReturning([exp(1, '2026-09-22T11:52:28.15Z')]).client, {
			now: NOW,
		});
		const failing = {
			minivanExportsSince: async () => {
				throw new Error('VAN /minivanExports returned 503');
			},
		} as unknown as VanClient;
		await expect(pullMinivanExports(db, failing, { now: NOW })).rejects.toThrow(/503/);
		const rows = await client.execute('SELECT count(*) AS n FROM van_minivan_exports');
		expect(rows.rows[0]!.n).toBe(1);
	});
});

describe('loadMinivanExports', () => {
	beforeEach(async () => {
		await pullMinivanExports(
			db,
			vanReturning([
				exp(3, '2026-09-22T11:52:28.15Z', 'List 59430821-62783', [
					{ firstName: 'Tammy', lastName: 'B' },
				]),
				exp(1, '2026-09-13T17:19:02.657Z', 'List 59430821-62783', [
					{ firstName: 'Sam', lastName: 'I' },
				]),
				exp(2, '2026-09-13T17:19:02.657Z', 'List 11111111-22222'),
			]).client,
			{ now: NOW },
		);
	});

	it('returns only exports for the requested list numbers, oldest first', async () => {
		const exports = await loadMinivanExports(db, ['59430821-62783', '99999999-00000']);
		expect(exports.map((e) => e.minivanExportId)).toEqual([1, 3]);
		expect(exports[1]).toMatchObject({
			name: 'List 59430821-62783',
			canvassers: [{ firstName: 'Tammy', lastName: 'B' }],
		});
	});

	it('returns nothing for no list numbers', async () => {
		expect(await loadMinivanExports(db, [])).toEqual([]);
	});

	it('reads a corrupt canvasser column as nobody, not as an exception', async () => {
		await client.execute(
			"UPDATE van_minivan_exports SET canvassers_json = '{oops' WHERE minivan_export_id = 2",
		);
		const [only] = await loadMinivanExports(db, ['11111111-22222']);
		expect(only!.canvassers).toEqual([]);
	});
});

describe('our claims, for export attribution', () => {
	async function checkout(id: number, claimedAt: string, over: Record<string, string> = {}) {
		const row: Record<string, string | number> = {
			id,
			// One route each: the real schema allows one open claim per route.
			map_route_id: 100 + id,
			slack_user_id: 'U_VOL',
			slack_user_name: 'Dana',
			claimed_at: claimedAt,
			expires_at: '2026-09-30T00:00:00.000Z',
			...over,
		};
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts (${Object.keys(row).join(', ')})
			      VALUES (${Object.keys(row)
							.map(() => '?')
							.join(', ')})`,
			args: Object.values(row),
		});
	}

	it('loads every recent claim, ended ones included, with when it stopped', async () => {
		await checkout(1, '2026-09-20T10:00:00.000Z', { completed_at: '2026-09-20T14:00:00.000Z' });
		await checkout(2, '2026-09-22T10:00:00.000Z', { released_at: '2026-09-22T11:00:00.000Z' });
		await checkout(3, '2026-09-23T10:00:00.000Z');
		// Older than anything the export store still holds.
		await checkout(4, '2026-07-01T10:00:00.000Z');

		const claims = await loadClaimsForExports(db, NOW);
		expect(claims.map((c) => [c.checkoutId, c.endedAt])).toEqual([
			[1, '2026-09-20T14:00:00.000Z'],
			[2, '2026-09-22T11:00:00.000Z'],
			[3, '2026-09-30T00:00:00.000Z'],
		]);
	});

	it('stamps the claims whose list was seen loaded', async () => {
		await checkout(1, '2026-09-23T10:00:00.000Z');
		await checkout(2, '2026-09-23T11:00:00.000Z');
		await stampClaimsLoaded(db, [{ checkoutId: 2, loadedAt: '2026-09-23T11:05:00.000Z' }]);
		const rows = await client.execute(
			'SELECT id, loaded_in_minivan_at FROM van_turf_checkouts ORDER BY id',
		);
		expect(rows.rows.map((r) => r.loaded_in_minivan_at)).toEqual([
			null,
			'2026-09-23T11:05:00.000Z',
		]);
	});
});
