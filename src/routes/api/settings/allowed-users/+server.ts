import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { saveAllowedUser, deleteAllowedUser, type Editor } from '$lib/server/settings.js';
import { validateSlackUser } from '$lib/server/settings-validation.js';

// Admin-allowlist writes for the settings page: one add/remove of one Slack
// user per request. `add` membership-checks the id against the cached live
// user list (503 on a transient list outage, 400 for an unknown id) and stores
// the validated display name; `remove` only shape-validates so a stale entry
// (deactivated user) can always be deleted.
//
// Two guardrails on removal. You cannot remove your own id — one accidental
// chip-click shouldn't cost the clicker their access; the superuser is exempt
// (they stay admin via SLACK_SUPERUSER_ID no matter what the list says). And
// the last admin cannot be removed at all, enforced in deleteAllowedUser: this
// table is the only source of admin access, so emptying it would leave nobody
// able to reach /settings and refill it.
interface AllowedUsersBody {
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

	let body: AllowedUsersBody;
	try {
		body = (await request.json()) as AllowedUsersBody;
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
		await saveAllowedUser(db, { slackUserId: userId, displayName: result.displayName }, editor);
		return json({ ok: true });
	}

	if (userId === locals.session.slackUserId && userId !== SLACK_SUPERUSER_ID) {
		return json(
			{ error: 'You cannot remove your own admin access. Ask another admin to remove you.' },
			{ status: 400 },
		);
	}

	const removal = await deleteAllowedUser(db, userId, editor);
	if (removal === 'last-admin') {
		return json(
			{
				error:
					'You cannot remove the only admin. Add another admin first, ' +
					'or nobody will be able to reach this page.',
			},
			{ status: 409 },
		);
	}
	// 'not-found' is reported as success: the row is gone, which is what the
	// caller asked for, and a stale chip should not raise an error.
	return json({ ok: true });
};
