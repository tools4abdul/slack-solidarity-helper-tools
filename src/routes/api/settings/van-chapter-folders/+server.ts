import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { campaignFromRequest } from '$lib/server/van/campaigns.js';
import {
	saveVanChapterFolders,
	saveVanFolderChapters,
	deleteVanChapterFolders,
	isDeletedTurfCustomChapterError,
	type Editor,
} from '$lib/server/settings.js';

// Chapter → VAN folder mapping writes, for one campaign (`campaignId`,
// required). Folder ids are VAN's and only unique within a committee, and every
// write is scoped to the campaign, so another campaign's mapping for the same
// chapter or folder id is left alone.
//
// One chapter per request, folder list submitted whole. This mapping is an
// INPUT to the catalog sync rather than something it discovers: a chapter with
// no folders here has no turf, and the sync does nothing until an admin fills
// it in. That is why it can be edited before a VAN key exists — it needs to be
// ready the day the key lands.
//
// Chapter ids are Solidarity's, which are positive, or an admin's turf-only
// chapter (turf_custom_chapters), which are negative — so any non-zero integer,
// and a negative one must still exist: a page left open while another admin
// deleted the entry would otherwise write mapping rows back for a chapter no
// picker offers. The database refuses those rows (migration 0067) and the write
// answers 400. `remove` writes none, so stray rows can always be cleared.
//
// Folder ids are typed in by hand from VAN, so they are validated as positive
// integers but NOT checked against VAN — there is no key to check with yet, and
// a wrong id simply yields no turf rather than anything unsafe. Story 2 adds a
// "this folder returned nothing" warning once the sync can look.
//
// `action: "save-folder"` is the same mapping edited from the other side, by
// `/turfs/folder-map`: one FOLDER, its whole chapter list submitted at once.
// It exists because the question you can answer while looking at a map of a
// folder's turf is "who should see this", and answering it through the
// chapter-first shape would mean re-submitting every other folder that chapter
// has. The write is scoped to the one folder, so the two directions cannot
// clobber each other.
interface ChapterFoldersBody {
	campaignId?: unknown;
	action?: unknown;
	chapterId?: unknown;
	chapterName?: unknown;
	folderIds?: unknown;
	folderId?: unknown;
	chapters?: unknown;
}

const MAX_FOLDERS_PER_CHAPTER = 50;
const MAX_CHAPTERS_PER_FOLDER = 50;
const MAX_CHAPTER_NAME_LENGTH = 200;

/** Run a mapping write, answering 400 when it named a turf-only chapter that
 *  has been deleted. The check is the database's (migration 0067), so it holds
 *  however close the delete came to the write. */
async function write(save: () => Promise<void>) {
	try {
		await save();
	} catch (err) {
		if (!isDeletedTurfCustomChapterError(err)) throw err;
		return json(
			{ error: 'A custom chapter in this mapping has been deleted. Reload the page.' },
			{ status: 400 },
		);
	}
	return json({ ok: true });
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ChapterFoldersBody;
	try {
		body = (await request.json()) as ChapterFoldersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, chapterId, chapterName, folderIds, folderId, chapters } = body;
	if (action !== 'save' && action !== 'remove' && action !== 'save-folder') {
		return json({ error: 'action must be "save", "remove" or "save-folder"' }, { status: 400 });
	}
	const named = await campaignFromRequest(db, body.campaignId);
	if (!named.ok) return json({ error: named.error }, { status: named.status });
	const campaignId = named.campaign.id;

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'save-folder') {
		if (typeof folderId !== 'number' || !Number.isInteger(folderId) || folderId <= 0) {
			return json({ error: 'folderId must be a positive integer' }, { status: 400 });
		}
		if (!Array.isArray(chapters)) {
			return json({ error: 'chapters must be an array' }, { status: 400 });
		}
		if (chapters.length > MAX_CHAPTERS_PER_FOLDER) {
			return json(
				{ error: `A folder can map to at most ${MAX_CHAPTERS_PER_FOLDER} chapters.` },
				{ status: 400 },
			);
		}
		const entries: Array<{ chapterId: number; chapterName: string }> = [];
		for (const item of chapters) {
			const chapter = item as { chapterId?: unknown; chapterName?: unknown };
			if (
				typeof chapter?.chapterId !== 'number' ||
				!Number.isInteger(chapter.chapterId) ||
				chapter.chapterId === 0
			) {
				return json({ error: 'every chapterId must be a non-zero integer' }, { status: 400 });
			}
			// The name is stored denormalised, so it is bounded here rather than
			// trusted: it reaches /settings and the turf page as a label.
			if (
				typeof chapter.chapterName !== 'string' ||
				chapter.chapterName.trim() === '' ||
				chapter.chapterName.length > MAX_CHAPTER_NAME_LENGTH
			) {
				return json(
					{
						error: `every chapterName must be a non-empty string under ${MAX_CHAPTER_NAME_LENGTH} characters`,
					},
					{ status: 400 },
				);
			}
			entries.push({ chapterId: chapter.chapterId, chapterName: chapter.chapterName.trim() });
		}

		return write(() =>
			saveVanFolderChapters(db, { campaignId, folderId, chapters: entries }, editor),
		);
	}

	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId) || chapterId === 0) {
		return json({ error: 'chapterId must be a non-zero integer' }, { status: 400 });
	}

	if (action === 'remove') {
		await deleteVanChapterFolders(db, campaignId, chapterId, editor);
		return json({ ok: true });
	}

	if (typeof chapterName !== 'string' || chapterName.trim() === '') {
		return json({ error: 'chapterName must be a non-empty string' }, { status: 400 });
	}
	if (!Array.isArray(folderIds)) {
		return json({ error: 'folderIds must be an array' }, { status: 400 });
	}
	if (folderIds.length > MAX_FOLDERS_PER_CHAPTER) {
		return json(
			{ error: `A chapter can map to at most ${MAX_FOLDERS_PER_CHAPTER} folders.` },
			{ status: 400 },
		);
	}
	for (const id of folderIds) {
		if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
			return json({ error: 'every folderId must be a positive integer' }, { status: 400 });
		}
	}

	return write(() =>
		saveVanChapterFolders(
			db,
			{
				campaignId,
				chapterId,
				chapterName: chapterName.trim(),
				folderIds: folderIds as number[],
			},
			editor,
		),
	);
};
