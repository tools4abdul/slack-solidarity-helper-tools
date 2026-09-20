import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import {
	saveVanChapterFolders,
	saveVanFolderChapters,
	deleteVanChapterFolders,
	type Editor,
} from '$lib/server/settings.js';

// Chapter → VAN folder mapping writes.
//
// One chapter per request, folder list submitted whole. This mapping is an
// INPUT to the catalog sync rather than something it discovers: a chapter with
// no folders here has no turf, and the sync does nothing until an admin fills
// it in. That is why it can be edited before a VAN key exists — it needs to be
// ready the day the key lands.
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
				chapter.chapterId <= 0
			) {
				return json({ error: 'every chapterId must be a positive integer' }, { status: 400 });
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

		await saveVanFolderChapters(db, { folderId, chapters: entries }, editor);
		return json({ ok: true });
	}

	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId) || chapterId <= 0) {
		return json({ error: 'chapterId must be a positive integer' }, { status: 400 });
	}

	if (action === 'remove') {
		await deleteVanChapterFolders(db, chapterId, editor);
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

	await saveVanChapterFolders(
		db,
		{ chapterId, chapterName: chapterName.trim(), folderIds: folderIds as number[] },
		editor,
	);
	return json({ ok: true });
};
