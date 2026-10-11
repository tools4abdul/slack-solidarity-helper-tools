import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadHiddenTurfs, setTurfHidden } from './turf-hide-store.js';
import { loadChapterTurfs } from './turf-query.js';
import { claimTurf } from './checkout-store.js';

// A real in-memory libsql, because what hiding does lives in SQL: the filter in
// loadChapterTurfs, and the row claimTurf reads. A fake would only answer what
// the test scripted.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-10T18:00:00.000Z');
const ADMIN = { id: 'U_ADMIN', name: 'Alex' };
const VOLUNTEER = { slackUserId: 'U_VOL', isAdmin: false };
const ADMIN_VIEWER = { slackUserId: 'U_ADMIN', isAdmin: true };

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });

	await client.execute({
		sql: `INSERT INTO van_chapter_folders
		        (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by,
		         last_edited_by_name, last_edited_at)
		      VALUES (1, 71, 1, 'Washtenaw County', 'U_ADMIN', 'Alex', ?)`,
		args: [NOW.toISOString()],
	});
	for (const id of [100, 101]) {
		await client.execute({
			sql: `INSERT INTO van_turfs
			        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
			         region_name, name, printed_list_number, door_count, first_seen_at, last_seen_at)
			      VALUES (?, ?, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', ?, ?, 250, ?, ?)`,
			args: [id, id, `Turf ${id}`, `L-${id}`, NOW.toISOString(), NOW.toISOString()],
		});
	}
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const ids = async (viewer: { slackUserId: string; isAdmin: boolean }, includeHeld = false) =>
	(
		await loadChapterTurfs(db, {
			chapterId: 71,
			viewer,
			includeHeldByViewer: includeHeld,
			now: NOW,
		})
	).turfs.map((t) => t.turfId);

describe('setTurfHidden', () => {
	it('takes the turf out of a volunteer’s list and puts it back', async () => {
		expect(await setTurfHidden(db, 100, true, ADMIN, NOW)).toBe(true);
		expect(await ids(VOLUNTEER)).toEqual([101]);

		await setTurfHidden(db, 100, false, ADMIN, NOW);
		expect((await ids(VOLUNTEER)).sort()).toEqual([100, 101]);
	});

	it('still shows it to admins, marked hidden', async () => {
		await setTurfHidden(db, 100, true, ADMIN, NOW);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: ADMIN_VIEWER, now: NOW });
		const byId = new Map(turfs.map((t) => [t.turfId, t]));
		expect(byId.get(100)).toMatchObject({
			hidden: true,
			claimable: false,
			// Told how to undo it, not the volunteer's "pick another turf".
			claimBlockedReason: expect.stringContaining('Untick'),
		});
		expect(byId.get(101)?.hidden).toBeUndefined();
	});

	it('still says so when hidden turf has no list number', async () => {
		await client.execute('UPDATE van_turfs SET printed_list_number = NULL WHERE turf_id = 100');
		await setTurfHidden(db, 100, true, ADMIN, NOW);
		const { turfs } = await loadChapterTurfs(db, { chapterId: 71, viewer: ADMIN_VIEWER, now: NOW });
		expect(turfs.find((t) => t.turfId === 100)).toMatchObject({ hidden: true, noListNumber: true });
	});

	it('refuses a claim, from anyone', async () => {
		await setTurfHidden(db, 100, true, ADMIN, NOW);
		for (const slackUserId of ['U_VOL', 'U_ADMIN']) {
			expect(
				await claimTurf(db, { turfId: 100, slackUserId, slackUserName: 'Dana', now: NOW }),
			).toMatchObject({ ok: false, status: 409, message: expect.stringContaining('handed out') });
		}
	});

	it('leaves a volunteer already holding it with their turf', async () => {
		expect(
			await claimTurf(db, { turfId: 100, slackUserId: 'U_VOL', slackUserName: 'Dana', now: NOW }),
		).toMatchObject({ ok: true });
		await setTurfHidden(db, 100, true, ADMIN, NOW);

		const { turfs } = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VOLUNTEER,
			includeHeldByViewer: true,
			now: NOW,
		});
		const mine = turfs.find((t) => t.turfId === 100);
		expect(mine).toMatchObject({ status: 'held-by-you', printedListNumber: 'L-100' });
		// Volunteers are never told a turf is hidden, their own included.
		expect(mine?.hidden).toBeUndefined();
	});

	it('reports a turf that does not exist', async () => {
		expect(await setTurfHidden(db, 999, true, ADMIN, NOW)).toBe(false);
	});
});

describe('loadHiddenTurfs', () => {
	it('lists hidden turf, most recently hidden first, with who hid it', async () => {
		await setTurfHidden(db, 100, true, ADMIN, NOW);
		await setTurfHidden(
			db,
			101,
			true,
			{ id: 'U_OTHER', name: 'Sam' },
			new Date(NOW.getTime() + 1000),
		);
		const rows = await loadHiddenTurfs(db, { chapterId: 71 });
		expect(rows.map((r) => [r.turfId, r.hiddenBy])).toEqual([
			[101, 'Sam'],
			[100, 'Alex'],
		]);
		expect(rows[1]).toMatchObject({ turfName: 'Turf 100', doorCount: 250 });
	});

	it('leaves out visible turf, retired turf and other chapters', async () => {
		await setTurfHidden(db, 100, true, ADMIN, NOW);
		await setTurfHidden(db, 101, true, ADMIN, NOW);
		await client.execute({
			sql: 'UPDATE van_turfs SET retired_at = ? WHERE turf_id = 101',
			args: [NOW.toISOString()],
		});
		expect((await loadHiddenTurfs(db, { chapterId: 71 })).map((r) => r.turfId)).toEqual([100]);
		expect(await loadHiddenTurfs(db, { chapterId: 72 })).toEqual([]);

		await setTurfHidden(db, 100, false, ADMIN, NOW);
		expect(await loadHiddenTurfs(db, { chapterId: null })).toEqual([]);
	});
});
