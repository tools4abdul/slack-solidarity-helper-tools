// Admin and moderator checks for inbound Slack requests.
//
// The web app decides `isAdmin` / `isModerator` once at OAuth login and stores
// them on the session (see auth/slack/callback). Slack commands have no
// session, so they re-derive them from the same source of truth: the
// allowed_slack_users and slack_moderators tables via loadSettings, plus the
// SLACK_SUPERUSER_ID escape hatch.

import { db } from './db.js';
import { loadSettings } from './settings.js';
import { SLACK_SUPERUSER_ID } from './env.js';
import { errMessage } from '../err-message.js';

export type SlackRole = 'admin' | 'moderator' | null;

/**
 * Fails **closed**: if the settings read throws, a non-superuser gets no role
 * rather than one. The superuser id comes from the environment and needs no
 * DB, so a database outage can't lock the workspace owner out of their own
 * moderation tooling.
 */
export async function slackRole(slackUserId: string): Promise<SlackRole> {
	if (SLACK_SUPERUSER_ID !== '' && slackUserId === SLACK_SUPERUSER_ID) return 'admin';
	try {
		const { allowedSlackUserIds, moderatorSlackUserIds } = await loadSettings(db);
		if (allowedSlackUserIds.has(slackUserId)) return 'admin';
		if (moderatorSlackUserIds.has(slackUserId)) return 'moderator';
		return null;
	} catch (err) {
		console.error('[slack-admin] role check failed, denying:', errMessage(err));
		return null;
	}
}

/** Admins only. For the places a moderator must NOT reach — today, the admin
 *  view /turfs gives in Slack (holder names, no rate limit; see turf-slack.ts). */
export async function isSlackAdmin(slackUserId: string): Promise<boolean> {
	return (await slackRole(slackUserId)) === 'admin';
}

/** Admins and moderators: the note modal, the member-record shortcut, the
 *  info commands and /list-commands. */
export async function canUseSlackCommands(slackUserId: string): Promise<boolean> {
	return (await slackRole(slackUserId)) !== null;
}

export const NOT_AUTHORIZED_TEXT =
	"You're not authorized to use this — it's limited to Slack admins and moderators.";
