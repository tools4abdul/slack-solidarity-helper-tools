import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import { errMessage } from '$lib/err-message.js';
import {
	deleteTurfCustomChapter,
	saveTurfCustomChapter,
	type Editor,
} from '$lib/server/settings.js';

// The admin's turf-only chapters: one add or remove per request, shaped like
// /api/settings/turf-hidden-chapters.
//
// `add` takes a name and answers with the new entry, whose negative id the
// editor needs to remove it again. `remove` takes that id and also deletes every
// VAN folder mapped to it, in every campaign — see deleteTurfCustomChapter.
interface TurfCustomChaptersBody {
	action?: unknown;
	name?: unknown;
	chapterId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: TurfCustomChaptersBody;
	try {
		body = (await request.json()) as TurfCustomChaptersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, name, chapterId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'add') {
		if (typeof name !== 'string') {
			return json({ error: 'name must be a string' }, { status: 400 });
		}
		// Solidarity's chapters, which the folder-mapping pickers list beside
		// this one, so a name can't shadow one with no Slack channel. Best
		// effort: Solidarity being down must not stop an admin adding a name,
		// and the channel map still covers every chapter /turfs offers.
		const solidarityNames = await getSolidarityChapters(SOLIDARITY_API_TOKEN).then(
			(result) => result.items.map((c) => c.name),
			(err: unknown) => {
				console.warn(
					'[settings] custom chapter: Solidarity chapters unavailable:',
					errMessage(err),
				);
				return [];
			},
		);
		const result = await saveTurfCustomChapter(db, name, editor, solidarityNames);
		if (!result.ok) return json({ error: result.error }, { status: 400 });
		return json({ ok: true, chapter: result.chapter });
	}

	// Negative only: a positive id is a Solidarity chapter, and this must never
	// be the way its folder mappings get wiped.
	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId) || chapterId >= 0) {
		return json({ error: 'chapterId must be a negative integer' }, { status: 400 });
	}
	await deleteTurfCustomChapter(db, chapterId, editor);
	return json({ ok: true });
};
