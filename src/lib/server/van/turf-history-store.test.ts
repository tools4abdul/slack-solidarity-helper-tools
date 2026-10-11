import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { explainLiveCut, loadTurfHistory } from './turf-history-store.js';

let client: Client;
let db: ReturnType<typeof drizzle>;

const NAME = 'R02F_037_Kent_Plainfield_003 Turf 05';
const OLD_CUT = '2026-10-03T14:32:00.000Z';
const NEW_CUT = '2026-10-10T18:32:00.000Z';

async function turf(turfId: number, listId: number, cutAt: string, retiredAt: string | null) {
	await client.execute({
		sql: `INSERT INTO van_turfs (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id,
			region_name, name, saved_list_id, roster_saved_list_id, door_count, route_size,
			cut_at, first_seen_at, last_seen_at, retired_at, uncontacted_doors)
			VALUES (?, ?, 1, 1, 71, 'R02F_037_Kent_Plainfield_003', ?, ?, ?, 3, 4, ?, ?, ?, ?, ?)`,
		args: [turfId, turfId, NAME, listId, listId, cutAt, cutAt, cutAt, retiredAt, 3],
	});
}

/** One door per letter; a person per door, hashed as their letter. */
async function roster(turfId: number, doors: string[]) {
	for (const d of doors) {
		await client.execute({
			sql: 'INSERT INTO van_turf_roster (turf_id, person_hash, door_hash) VALUES (?, ?, ?)',
			args: [turfId, Buffer.from(`p-${d}`), Buffer.from(`d-${d}`)],
		});
	}
}

async function contact(door: string, at: string) {
	await client.execute({
		sql: 'INSERT INTO van_person_contacts (campaign_id, person_hash, last_in_person_at) VALUES (1, ?, ?)',
		args: [Buffer.from(`p-${door}`), at],
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => client.close());

describe('loadTurfHistory', () => {
	it('shows a re-cut that kept doors knocked under the old cut', async () => {
		await turf(100, 1100, OLD_CUT, NEW_CUT);
		await turf(200, 2200, NEW_CUT, null);
		await roster(100, ['a', 'b', 'c']);
		await roster(200, ['a', 'b', 'c']);
		// Two knocked between the cuts, one never.
		await contact('a', '2026-10-06T01:43:00.000Z');
		await contact('b', '2026-10-09T23:34:00.000Z');

		const [history] = await loadTurfHistory(db, 'Plainfield_003 Turf 05');

		expect(history!.cuts.map((c) => c.turfId)).toEqual([100, 200]);
		const [old, live] = history!.cuts;
		expect([old!.knockedSinceCut, old!.knockedBeforeCut]).toEqual([2, 0]);
		expect([live!.knockedSinceCut, live!.knockedBeforeCut]).toEqual([0, 2]);
		expect(live!.lastKnockedBeforeCut).toBe('2026-10-09T23:34:00.000Z');
		// By campaign-local day: 01:43Z on the 6th is the evening of the 5th in
		// Detroit, which is when the door was knocked.
		expect(live!.knockedByDay).toEqual([
			{ day: '2026-10-05', doors: 1 },
			{ day: '2026-10-09', doors: 1 },
		]);
		expect(explainLiveCut(history!)).toMatch(
			/re-cut .* 2 of its 3 doors were knocked before the cut/,
		);
	});

	it('finds every cut under the name from one turf id', async () => {
		await turf(100, 1100, OLD_CUT, NEW_CUT);
		await turf(200, 2200, NEW_CUT, null);

		const histories = await loadTurfHistory(db, '200');

		expect(histories).toHaveLength(1);
		expect(histories[0]!.cuts.map((c) => c.turfId)).toEqual([100, 200]);
	});

	it('says when nothing reached VAN at all', async () => {
		await turf(100, 1100, OLD_CUT, NEW_CUT);
		await turf(200, 2200, NEW_CUT, null);
		await roster(200, ['a', 'b']);

		const [history] = await loadTurfHistory(db, NAME);

		expect(explainLiveCut(history!)).toMatch(/no in-person contact/);
	});

	it('says when the live cut has no roster yet', async () => {
		await turf(200, 2200, NEW_CUT, null);
		await client.execute('UPDATE van_turfs SET roster_saved_list_id = NULL');

		const [history] = await loadTurfHistory(db, NAME);

		expect(history!.cuts[0]!.rosterCurrent).toBe(false);
		expect(explainLiveCut(history!)).toMatch(/No roster for the current list/);
	});
});
