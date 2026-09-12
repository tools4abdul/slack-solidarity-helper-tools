import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import {
	saveZipExcludedChapter,
	deleteZipExcludedChapter,
	type Editor,
} from '$lib/server/settings.js';
import { validateSolidarityChapter } from '$lib/server/settings-validation.js';

// Zip-exclusion writes for the settings page: one add/remove of one Solidarity
// chapter per request. An excluded chapter is dropped from the tally that builds
// zip_chapter_map, so it can never win a zip — and the runner-up chapter wins
// instead of the zip being blanked.
//
// Shaped exactly like /api/settings/excluded-chapters, including the asymmetry:
// `add` membership-checks the id against the cached live chapter list (503 on a
// transient list outage, 400 for an unknown id), while `remove` only
// shape-validates, so an exclusion on a chapter since deleted in Solidarity can
// always be lifted.
//
// No ensure*Seeded call, unlike the report exclusions — that helper copies an
// env list in before the first edit, and this setting has no env list.
interface ZipExcludedChaptersBody {
	action?: unknown;
	chapterId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ZipExcludedChaptersBody;
	try {
		body = (await request.json()) as ZipExcludedChaptersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, chapterId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}
	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId)) {
		return json({ error: 'chapterId must be an integer' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'add') {
		const result = await validateSolidarityChapter(SOLIDARITY_API_TOKEN, chapterId);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
		await saveZipExcludedChapter(db, { chapterId }, editor);
		return json({ ok: true });
	}

	await deleteZipExcludedChapter(db, chapterId, editor);
	return json({ ok: true });
};
