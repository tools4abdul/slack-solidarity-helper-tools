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

const { saveVanChapterFolders, saveVanFolderChapters, loadVanChapterFolders } =
	await import('./settings.js');

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
	const rows = await loadVanChapterFolders(db);
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
			{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [68298, 68295] },
			EDITOR,
		);
		// Now the folder-map page gives folder 68298 to a different chapter.
		await saveVanFolderChapters(
			db,
			{ folderId: 68298, chapters: [{ chapterId: 72, chapterName: 'Oakland County' }] },
			EDITOR,
		);
		// 68298 moved; Washtenaw keeps 68295, which this edit never mentioned.
		expect(await mapping()).toEqual({ 71: [68295], 72: [68298] });
	});

	it('an empty list unmaps the folder and nothing else', async () => {
		await saveVanChapterFolders(
			db,
			{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [68298, 68295] },
			EDITOR,
		);
		await saveVanFolderChapters(db, { folderId: 68298, chapters: [] }, EDITOR);
		expect(await mapping()).toEqual({ 71: [68295] });
	});

	it('replaces the folder’s list wholesale, rather than adding to it', async () => {
		const save = (chapters: Array<{ chapterId: number; chapterName: string }>) =>
			saveVanFolderChapters(db, { folderId: 68299, chapters }, EDITOR);
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
			{ folderId: 68299, chapters: [{ chapterId: 72, chapterName: 'Oakland County' }] },
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
