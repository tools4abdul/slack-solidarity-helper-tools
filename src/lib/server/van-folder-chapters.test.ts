import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// settings.ts pulls in env.ts, which only exists inside the Vite bundle.
vi.mock('./env.js', () => ({
	SOLIDARITY_CHAPTER_CHANNEL_MAP: [],
	REPORT_EXCLUDED_CHAPTER_IDS: new Set<number>(),
	SLACK_TRACKING_CHANNEL_ID: '',
	SLACK_GROWTH_REPORT_CHANNEL_ID: '',
	SLACK_GROWTH_REPORT_RANKING_ALPHA: 0.5,
	MOBILIZE_CONTACT_NAME: '',
	MOBILIZE_CONTACT_EMAIL: '',
	MOBILIZE_CONTACT_PHONE: '',
}));

const {
	saveVanChapterFolders,
	saveVanFolderChapters,
	deleteVanChapterFolders,
	loadVanChapterFolders,
	isDeletedTurfCustomChapterError,
} = await import('./settings.js');

// A real engine rather than a chained fake: the guarantee here is that two
// editors of ONE table — /settings writing a chapter's folders, and
// /turfs/folder-map writing a folder's chapters — do not erase each other's
// rows. Only a database with the real (chapter_id, folder_id) primary key can
// show that.

let db: ReturnType<typeof drizzle>;
let client: Client;
const EDITOR = { id: 'U_ADMIN', name: 'Alice' };

/** chapterId → folderIds, which is the shape /settings and the sync read. */
async function mapping(): Promise<Record<number, number[]>> {
	const rows = await loadVanChapterFolders(db, 1);
	return Object.fromEntries(rows.map((r) => [r.chapterId, [...r.folderIds].sort((a, b) => a - b)]));
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

// Each test opens its own in-memory client and replaces console. Both leak for
// the life of the worker otherwise — `clearAllMocks` resets a spy's recorded
// calls but leaves it installed. Neither is visible while this file is run on
// its own, which is the shape of a test that fails once in a full suite and
// passes every time you go looking for it.
afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('saveVanFolderChapters', () => {
	it('maps one folder to several chapters', async () => {
		await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68300,
				chapters: [
					{ chapterId: 71, chapterName: 'Macomb County' },
					{ chapterId: 72, chapterName: 'Oakland County' },
				],
			},
			EDITOR,
		);
		expect(await mapping()).toEqual({ 71: [68300], 72: [68300] });
	});

	it('leaves a chapter’s other folders alone', async () => {
		// Washtenaw already has two folders, set chapter-first on /settings.
		await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: 71, chapterName: 'Washtenaw County', folderIds: [68298, 68295] },
			EDITOR,
		);
		// Now the folder-map page gives folder 68298 to a different chapter.
		await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68298,
				chapters: [{ chapterId: 72, chapterName: 'Oakland County' }],
			},
			EDITOR,
		);
		// 68298 moved; Washtenaw keeps 68295, which this edit never mentioned.
		expect(await mapping()).toEqual({ 71: [68295], 72: [68298] });
	});

	it('an empty list unmaps the folder and nothing else', async () => {
		await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: 71, chapterName: 'Washtenaw County', folderIds: [68298, 68295] },
			EDITOR,
		);
		await saveVanFolderChapters(db, { campaignId: 1, folderId: 68298, chapters: [] }, EDITOR);
		expect(await mapping()).toEqual({ 71: [68295] });
	});

	it('replaces the folder’s list wholesale, rather than adding to it', async () => {
		const save = (chapters: Array<{ chapterId: number; chapterName: string }>) =>
			saveVanFolderChapters(db, { campaignId: 1, folderId: 68299, chapters }, EDITOR);
		await save([
			{ chapterId: 71, chapterName: 'Macomb County' },
			{ chapterId: 72, chapterName: 'Oakland County' },
		]);
		await save([{ chapterId: 72, chapterName: 'Oakland County' }]);
		expect(await mapping()).toEqual({ 72: [68299] });
	});

	it('survives the same chapter picked twice', async () => {
		// The primary key is (chapter_id, folder_id), so an unfiltered insert
		// would fail the whole save rather than storing the obvious intent.
		await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68299,
				chapters: [
					{ chapterId: 72, chapterName: 'Oakland County' },
					{ chapterId: 72, chapterName: 'Oakland County' },
				],
			},
			EDITOR,
		);
		expect(await mapping()).toEqual({ 72: [68299] });
	});

	it('records who edited it', async () => {
		await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68299,
				chapters: [{ chapterId: 72, chapterName: 'Oakland County' }],
			},
			EDITOR,
		);
		const res = await client.execute(
			'SELECT last_edited_by, last_edited_by_name, chapter_name FROM van_chapter_folders',
		);
		expect(res.rows[0]).toMatchObject({
			last_edited_by: 'U_ADMIN',
			last_edited_by_name: 'Alice',
			chapter_name: 'Oakland County',
		});
	});
});

// A chapter can have folders in several campaigns, and the editors only ever
// save one campaign's. Before campaigns existed the saves deleted by chapter or
// by folder alone, which would now wipe another campaign's mapping.
describe('campaigns', () => {
	beforeEach(async () => {
		await client.execute(
			"INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at) VALUES (2, 'other', 1, 's', 's', 'x')",
		);
		await saveVanChapterFolders(
			db,
			{ campaignId: 2, chapterId: 71, chapterName: 'Washtenaw County', folderIds: [68299] },
			EDITOR,
		);
	});

	it("saving one campaign's chapter leaves another campaign's folders for it alone", async () => {
		await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: 71, chapterName: 'Washtenaw County', folderIds: [1] },
			EDITOR,
		);
		await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: 71, chapterName: 'Washtenaw County', folderIds: [] },
			EDITOR,
		);
		const other = await loadVanChapterFolders(db, 2);
		expect(other.map((r) => [r.chapterId, r.folderIds])).toEqual([[71, [68299]]]);
	});

	it("saving a folder in one campaign leaves another campaign's folder with the same id", async () => {
		await saveVanFolderChapters(db, { campaignId: 1, folderId: 68299, chapters: [] }, EDITOR);
		expect((await loadVanChapterFolders(db, 2)).map((r) => r.folderIds)).toEqual([[68299]]);
	});

	it('removing a chapter in one campaign leaves its mapping in another', async () => {
		await deleteVanChapterFolders(db, 1, 71, EDITOR);
		expect((await loadVanChapterFolders(db, 2)).map((r) => r.chapterId)).toEqual([71]);
	});

	it('loads only the campaign asked for', async () => {
		expect(await mapping()).toEqual({});
	});
});

// Turf-only chapters (negative ids) are guarded in the database: a mapping row
// must name a turf_custom_chapters row that exists (migration 0067). That is
// what closes the gap between the route's check and the write — and the saves
// run as one batch, so a refused insert takes its delete back with it.
describe('a deleted turf-only chapter', () => {
	beforeEach(async () => {
		await client.execute(
			`INSERT INTO turf_custom_chapters (id, name, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (1, 'Ann Arbor outreach', 'U', 'u', 'x')`,
		);
		await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68300,
				chapters: [
					{ chapterId: 71, chapterName: 'Washtenaw County' },
					{ chapterId: -1, chapterName: 'Ann Arbor outreach' },
				],
			},
			EDITOR,
		);
	});

	it('maps a turf-only chapter that exists', async () => {
		expect(await mapping()).toEqual({ [-1]: [68300], 71: [68300] });
	});

	it('refuses a folder list naming one, and keeps the folder as it was', async () => {
		const err = await saveVanFolderChapters(
			db,
			{
				campaignId: 1,
				folderId: 68300,
				chapters: [
					{ chapterId: 71, chapterName: 'Washtenaw County' },
					{ chapterId: -2, chapterName: 'Gone team' },
				],
			},
			EDITOR,
		).catch((e: unknown) => e);
		expect(isDeletedTurfCustomChapterError(err)).toBe(true);
		// The delete ran in the same batch and was rolled back with the insert.
		expect(await mapping()).toEqual({ [-1]: [68300], 71: [68300] });
	});

	it('refuses a chapter-first save for one, and keeps its old folders', async () => {
		await client.execute('DELETE FROM turf_custom_chapters WHERE id = 1');
		const err = await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: -1, chapterName: 'Ann Arbor outreach', folderIds: [68301] },
			EDITOR,
		).catch((e: unknown) => e);
		expect(isDeletedTurfCustomChapterError(err)).toBe(true);
		expect(await mapping()).toEqual({ [-1]: [68300], 71: [68300] });
	});

	it('refuses an update that points a row at one', async () => {
		await expect(
			client.execute('UPDATE van_chapter_folders SET chapter_id = -2 WHERE chapter_id = 71'),
		).rejects.toThrow('turf_custom_chapter_deleted');
	});

	it('still lets a real chapter be saved, and its rows removed', async () => {
		await saveVanChapterFolders(
			db,
			{ campaignId: 1, chapterId: 72, chapterName: 'Wayne County', folderIds: [68302] },
			EDITOR,
		);
		await deleteVanChapterFolders(db, 1, -1, EDITOR);
		expect(await mapping()).toEqual({ 71: [68300], 72: [68302] });
	});
});
