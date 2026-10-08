import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// The admin's turf-only chapters, on a real in-memory database: adding one
// checks names against the chapter → channel map, and removing one deletes its
// van_chapter_folders rows.

const { holder, mockChapters } = vi.hoisted(() => ({
	holder: { db: null as unknown },
	mockChapters: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));

vi.mock('$lib/server/autocomplete-sources.js', () => ({ getSolidarityChapters: mockChapters }));

import { POST } from './+server.js';
import { loadSettings } from '$lib/server/settings.js';

let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

function post(body: unknown, session: unknown = ADMIN) {
	return POST({
		locals: { session },
		request: { json: async () => body },
	} as never);
}

const custom = async () =>
	(await loadSettings(holder.db as ReturnType<typeof drizzle>)).turfCustomChapters;

async function folderRows(): Promise<Array<{ campaign_id: number; chapter_id: number }>> {
	const result = await client.execute(
		'SELECT campaign_id, chapter_id FROM van_chapter_folders ORDER BY campaign_id, chapter_id',
	);
	return result.rows.map((r) => ({
		campaign_id: Number(r.campaign_id),
		chapter_id: Number(r.chapter_id),
	}));
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO chapter_channel_map (chapter_id, channel_id, name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (71, 'C1', 'Washtenaw County', 'U', 'u', 'x')`,
	);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	mockChapters.mockReset();
	mockChapters.mockResolvedValue({ items: [{ id: 99, name: 'Kent County' }] });
});

describe('auth', () => {
	it('401s without a session, 403s for a non-admin', async () => {
		expect((await post({ action: 'add', name: 'Outreach' }, null)).status).toBe(401);
		expect(
			(await post({ action: 'add', name: 'Outreach' }, { ...ADMIN, isAdmin: false })).status,
		).toBe(403);
		expect(await custom()).toEqual([]);
	});
});

describe('adding', () => {
	it('adds a trimmed name with a negative id, and returns it', async () => {
		const res = await post({ action: 'add', name: '  Outreach team  ' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			chapter: { chapterId: -1, name: 'Outreach team' },
		});
		expect(await custom()).toEqual([{ chapterId: -1, name: 'Outreach team' }]);
	});

	it('sorts the entries by name', async () => {
		await post({ action: 'add', name: 'Zeta' });
		await post({ action: 'add', name: 'Alpha' });
		expect(await custom()).toEqual([
			{ chapterId: -2, name: 'Alpha' },
			{ chapterId: -1, name: 'Zeta' },
		]);
	});

	// Both lists land in the same pickers, where two identical names cannot be
	// told apart.
	it('refuses a name already taken by an entry or a mapped chapter, ignoring case', async () => {
		await post({ action: 'add', name: 'Outreach' });
		for (const name of ['outreach', 'WASHTENAW COUNTY']) {
			const res = await post({ action: 'add', name });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toMatch(/already a chapter/);
		}
		expect(await custom()).toHaveLength(1);
	});

	// The folder-mapping pickers list Solidarity's chapters, which can include
	// ones with no Slack channel and so no row in the channel map.
	it('refuses a name a Solidarity chapter already has', async () => {
		const res = await post({ action: 'add', name: 'kent county' });
		expect(res.status).toBe(400);
		expect(await custom()).toEqual([]);
	});

	it('still adds when Solidarity cannot be read', async () => {
		mockChapters.mockRejectedValue(new Error('Solidarity is down'));
		expect((await post({ action: 'add', name: 'Kent County' })).status).toBe(200);
		expect(await custom()).toEqual([{ chapterId: -1, name: 'Kent County' }]);
	});

	// Two identical adds racing past the name check: the unique index refuses
	// the second, and that is a duplicate (400), not a server error. The race
	// is forced by a db whose insert fails the way libsql does under drizzle.
	it('answers a duplicate the unique index caught as a duplicate', async () => {
		const real = holder.db as ReturnType<typeof drizzle>;
		const racing = Object.create(real) as typeof real;
		racing.insert = (() => ({
			values: () => ({
				returning: async () => {
					throw new Error('Failed query', {
						cause: new Error('UNIQUE constraint failed: turf_custom_chapters.name'),
					});
				},
			}),
		})) as never;
		holder.db = racing;

		const res = await post({ action: 'add', name: 'Outreach' });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/already a chapter/);
	});

	it('still throws a write failure that is not a duplicate', async () => {
		const real = holder.db as ReturnType<typeof drizzle>;
		const failing = Object.create(real) as typeof real;
		failing.insert = (() => ({
			values: () => ({
				returning: async () => {
					throw new Error('disk I/O error');
				},
			}),
		})) as never;
		holder.db = failing;

		await expect(post({ action: 'add', name: 'Outreach' })).rejects.toThrow('disk I/O error');
	});

	it('refuses an empty, over-long or missing name', async () => {
		for (const name of ['', '   ', 'x'.repeat(201), 42, undefined]) {
			expect((await post({ action: 'add', name })).status).toBe(400);
		}
		expect(await custom()).toEqual([]);
	});
});

describe('removing', () => {
	it('removes the entry and every folder mapped to it, in every campaign', async () => {
		await post({ action: 'add', name: 'Outreach' });
		await client.execute(
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'second', 1, 'U', 'u', 'x')`,
		);
		await client.execute(
			`INSERT INTO van_chapter_folders (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (1, -1, 10, 'Outreach', 'U', 'u', 'x'), (2, -1, 11, 'Outreach', 'U', 'u', 'x'),
			        (1, 71, 10, 'Washtenaw County', 'U', 'u', 'x')`,
		);

		expect((await post({ action: 'remove', chapterId: -1 })).status).toBe(200);
		expect(await custom()).toEqual([]);
		// The real chapter sharing folder 10 keeps it.
		expect(await folderRows()).toEqual([{ campaign_id: 1, chapter_id: 71 }]);
	});

	// A positive id is a Solidarity chapter: this route must never be the way
	// its folder mappings get wiped.
	it('refuses anything but a negative integer id', async () => {
		for (const chapterId of [71, 0, -1.5, '-1', undefined]) {
			expect((await post({ action: 'remove', chapterId })).status).toBe(400);
		}
	});

	it('rejects a bad action and malformed JSON', async () => {
		expect((await post({ action: 'rename', chapterId: -1 })).status).toBe(400);
		const bad = await POST({
			locals: { session: ADMIN },
			request: {
				json: async () => {
					throw new SyntaxError('bad');
				},
			},
		} as never);
		expect(bad.status).toBe(400);
	});
});
