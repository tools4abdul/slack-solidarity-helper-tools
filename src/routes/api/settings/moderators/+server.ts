import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { saveModerator, deleteModerator, type Editor } from '$lib/server/settings.js';
import { validateSlackUser } from '$lib/server/settings-validation.js';

// Moderator-list writes for the settings page: one add/remove of one Slack user
// per request, same contract as ../allowed-users. Admin-only — a moderator
// cannot reach /settings, and must not be able to grow their own list here.
//
// Two things allowed-users has that this does not need: no env seeding (the
// moderator list is DB-only), and no self-removal guard (an admin removing
// themselves from this list loses nothing — they remain an admin).
interface ModeratorsBody {
	action?: unknown;
	userId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ModeratorsBody;
	try {
		body = (await request.json()) as ModeratorsBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, userId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}
	if (typeof userId !== 'string' || userId.trim() === '') {
		return json({ error: 'userId must be a non-empty string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'add') {
		const result = await validateSlackUser(slack, userId);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
		await saveModerator(db, { slackUserId: userId, displayName: result.displayName }, editor);
		return json({ ok: true });
	}

	// Shape-validated only, so a deactivated user can always be removed.
	await deleteModerator(db, userId, editor);
	return json({ ok: true });
};
