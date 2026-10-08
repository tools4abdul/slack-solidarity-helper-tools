import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// The folder map, one campaign at a time (specs/012-multi-van-campaigns): each
// campaign's folders are read with its own key, and its folder ids mean
// nothing to another campaign's key.

const { holder, mockClientFor } = vi.hoisted(() => ({
	holder: { db: null as unknown },
	mockClientFor: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClientFor: mockClientFor }));
vi.mock('$lib/server/autocomplete-sources.js', () => ({
	getSolidarityChapters: vi.fn(async () => ({ items: [{ id: 71, name: 'Wayne County' }] })),
}));

import { load } from './+page.server.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';

let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

type Data = {
	campaign: { id: number; name: string };
	campaigns: Array<{ id: number; name: string }>;
	pickedState: string | null;
	folders: Array<{
		folderId: number;
		name: string;
		counties: Array<{ county: string; centre: { lat: number; lng: number } }>;
		unplaced: string[];
	}>;
	emptyFolders: Array<{ folderId: number; name: string }>;
	mapping: Array<{ folderId: number; chapters: Array<{ chapterId: number }> }>;
	chapters: Array<{ id: number; name: string }>;
	chaptersError: string | null;
	error: string | null;
	states: string[];
	statesSource: string;
};

/** The load, with its streamed half awaited and flattened in. */
async function run(query = '') {
	const { folderData, ...rest } = (await load({
		locals: { session: ADMIN },
		url: new URL(`http://localhost/turfs/folder-map${query}`),
	} as never)) as Record<string, unknown> & { folderData: Promise<object> };
	return { ...rest, ...(await folderData) } as Data;
}

/** A VAN client for one campaign: one folder, named for it, with one region. */
function clientFor(campaign: { id: number }) {
	return {
		ok: true,
		client: {
			folders: async () => [{ folderId: 10, name: `Folder of ${campaign.id}` }],
			mapRegions: async () => [
				{ mapRegionId: 1, name: 'R10C_Wayne_Detroit001', mapRoutes: [{ mapRouteId: 1 }] },
			],
		},
	};
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'abdul', 'Partner', 0, 'sync', 'sync', 'x')`,
	);
	// Folder 10 is mapped in campaign 2 only.
	await client.execute(
		`INSERT INTO van_chapter_folders
		   (campaign_id, chapter_id, folder_id, chapter_name,
		    last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 71, 10, 'Wayne County', 'test', 'test', 'x')`,
	);
	vi.clearAllMocks();
	mockClientFor.mockImplementation(clientFor);
});

describe('which campaign', () => {
	it('shows the primary campaign by default, with every campaign to switch to', async () => {
		const data = await run('?refresh=1');
		expect(data.campaign.id).toBe(1);
		expect(data.campaigns.map((c) => c.id)).toEqual([1, 2]);
		expect(mockClientFor).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
		expect(data.folders.map((f) => f.name)).toEqual(['Folder of 1']);
		expect(data.mapping).toEqual([{ folderId: 10, chapters: [] }]);
	});

	it('reads another campaign’s folders with its key, and shows its mapping', async () => {
		const data = await run('?campaign=2&refresh=1');
		expect(data.campaign).toEqual({ id: 2, name: 'Partner' });
		expect(mockClientFor).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
		expect(data.folders.map((f) => f.name)).toEqual(['Folder of 2']);
		expect(data.mapping).toEqual([
			{ folderId: 10, chapters: [{ chapterId: 71, chapterName: 'Wayne County' }] },
		]);
	});

	// The cache is per campaign: one campaign's folders must never be served
	// on another's page.
	it('caches each campaign’s folders separately', async () => {
		await run('?campaign=1&refresh=1');
		await run('?campaign=2&refresh=1');
		mockClientFor.mockClear();

		expect((await run('?campaign=1')).folders[0]!.name).toBe('Folder of 1');
		expect((await run('?campaign=2')).folders[0]!.name).toBe('Folder of 2');
		expect(mockClientFor).not.toHaveBeenCalled();
	});

	it('says why when the campaign has no credentials, rather than failing the page', async () => {
		mockClientFor.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_ABDUL is not set' });
		const data = await run('?campaign=2&refresh=1');
		expect(data.error).toBe('VAN_CAMPAIGN_ABDUL is not set');
	});

	// A campaign whose folders are shared but not cut yet: nothing to map, but
	// the folders are listed so they can be given chapters ahead of the cut.
	it('lists folders with no map regions yet, and the mapping for them', async () => {
		mockClientFor.mockImplementation(() => ({
			ok: true,
			client: {
				folders: async () => [
					{ folderId: 10, name: 'Chapter - Wayne' },
					{ folderId: 11, name: 'Chapter - Bay' },
				],
				mapRegions: async (folderId: number) =>
					folderId === 10
						? []
						: [{ mapRegionId: 1, name: 'R10C_Wayne_Detroit001', mapRoutes: [{ mapRouteId: 1 }] }],
			},
		}));
		const data = await run('?campaign=2&refresh=1');
		expect(data.folders.map((f) => f.folderId)).toEqual([11]);
		expect(data.emptyFolders).toEqual([{ folderId: 10, name: 'Chapter - Wayne' }]);
		// Folder 10 is mapped in campaign 2, so its picker opens on that.
		expect(data.mapping).toContainEqual({
			folderId: 10,
			chapters: [{ chapterId: 71, chapterName: 'Wayne County' }],
		});
	});

	it('404s for a campaign that does not exist', async () => {
		await expect(run('?campaign=99')).rejects.toMatchObject({ status: 404 });
	});
});

// The picker offers the admin's turf-only chapters beside Solidarity's, by
// their negative id — and still offers them when Solidarity is down.
describe('the chapter picker', () => {
	beforeEach(async () => {
		await client.execute(
			`INSERT INTO turf_custom_chapters (name, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES ('Ann Arbor outreach', 'U', 'u', 'x')`,
		);
	});

	it('lists turf-only chapters sorted in with Solidarity’s', async () => {
		const data = await run('?refresh=1');
		expect(data.chapters).toEqual([
			{ id: -1, name: 'Ann Arbor outreach' },
			{ id: 71, name: 'Wayne County' },
		]);
		expect(data.chaptersError).toBeNull();
	});

	it('still lists them when Solidarity is down, and says why the rest are missing', async () => {
		vi.mocked(getSolidarityChapters).mockRejectedValueOnce(new Error('Solidarity is down'));
		const data = await run('?refresh=1');
		expect(data.chapters).toEqual([{ id: -1, name: 'Ann Arbor outreach' }]);
		expect(data.chaptersError).toBe('Solidarity is down');
	});

	it('labels a turf-only chapter that shares a Solidarity chapter’s name', async () => {
		await client.execute(
			`INSERT INTO turf_custom_chapters (name, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES ('wayne county', 'U', 'u', 'x')`,
		);
		const data = await run('?refresh=1');
		expect(data.chapters).toContainEqual({ id: 71, name: 'Wayne County' });
		expect(data.chapters).toContainEqual({ id: -2, name: 'wayne county (custom)' });
	});

	it('says so when the turf-only chapters cannot be read', async () => {
		await client.execute('DROP TABLE turf_custom_chapters');
		const data = await run('?refresh=1');
		expect(data.chapters).toEqual([{ id: 71, name: 'Wayne County' }]);
		expect(data.chaptersError).toMatch(/^custom chapters: /);
	});
});

// Wayne County exists in several states, so with nothing to decide between them
// the name places nowhere; a state picked on the page decides it.
describe('confining the lookup to a state', () => {
	it('places an ambiguous county in the picked state', async () => {
		const mi = await run('?refresh=1&state=mi');
		expect(mi.pickedState).toBe('MI');
		expect(mi.states).toEqual(['MI']);
		expect(mi.statesSource).toBe('picked');
		expect(mi.folders[0]!.counties[0]!.county).toBe('Wayne');
		expect(mi.folders[0]!.counties[0]!.centre.lat).toBeGreaterThan(41);

		// Same cached VAN read, placed again in another state.
		mockClientFor.mockClear();
		const nc = await run('?state=NC');
		expect(mockClientFor).not.toHaveBeenCalled();
		expect(nc.folders[0]!.counties[0]!.centre.lat).toBeLessThan(37);
	});

	it('leaves a county unplaced when the picked state has no such county', async () => {
		const data = await run('?refresh=1&state=AK');
		expect(data.folders[0]!.counties).toEqual([]);
		expect(data.folders[0]!.unplaced).toEqual(['R10C_Wayne_Detroit001']);
	});

	it('ignores a state that is not one', async () => {
		const data = await run('?refresh=1&state=ZZ');
		expect(data.pickedState).toBeNull();
		expect(data.statesSource).not.toBe('picked');
	});
});
