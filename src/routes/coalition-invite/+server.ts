import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errMessage } from '$lib/err-message.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { WEBHOOK_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';

export const GET: RequestHandler = async ({ url }) => {
	if (!secretMatches(url.searchParams.get('secret'), WEBHOOK_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const email = url.searchParams.get('email')?.trim();
	const coalition = url.searchParams.get('coalition')?.trim().toLowerCase();

	if (!email) return json({ error: 'email is required' }, { status: 400 });
	if (!coalition) return json({ error: 'coalition is required' }, { status: 400 });
	if (!email.includes('@')) return json({ error: 'Invalid email address' }, { status: 400 });

	// Admin-editable on /settings (DB-backed). `group` is the coalition's
	// Solidarity custom-property internal_name — the same key Solidarity
	// automations pass as ?coalition=. Matched case-insensitively (the incoming
	// param is already lowercased above) so a property key with uppercase
	// characters still resolves.
	let coalitionChannelMap;
	try {
		({ coalitionChannelMap } = await loadSettings(db));
	} catch (err) {
		// Keep the JSON contract on a transient DB failure — a 503 tells the
		// Solidarity automation to retry rather than handing it an HTML 500.
		console.error('[coalition-invite] settings load failed:', errMessage(err));
		return json({ error: 'Settings are temporarily unavailable. Retry shortly.' }, { status: 503 });
	}
	const channelId = coalitionChannelMap.find((e) => e.group.toLowerCase() === coalition)?.channelId;
	if (!channelId) {
		return json({ error: `Unknown coalition: ${coalition}` }, { status: 400 });
	}

	// Look up the Slack user by email
	let slackUserId: string;
	try {
		const result = await slack.users.lookupByEmail({ email });
		const userId = (result.user as { id?: string } | undefined)?.id;
		if (!userId) {
			return json({ error: `No Slack user found for ${email}` }, { status: 404 });
		}
		slackUserId = userId;
	} catch (err) {
		const msg = errMessage(err);
		if (msg.includes('users_not_found')) {
			return json({ error: `No Slack user found for ${email}` }, { status: 404 });
		}
		console.error(`[coalition-invite] users.lookupByEmail failed for ${email}:`, msg);
		return json({ error: 'Failed to look up Slack user' }, { status: 502 });
	}

	// Invite the user to the coalition channel
	try {
		await slack.conversations.invite({ channel: channelId, users: slackUserId });
		console.log(
			`[coalition-invite] invited ${email} (${slackUserId}) to ${coalition} (${channelId})`,
		);
	} catch (err) {
		const msg = errMessage(err);
		if (msg.includes('already_in_channel')) {
			console.log(`[coalition-invite] ${email} already in ${coalition} (${channelId})`);
			return json({ success: true, already_in_channel: true });
		}
		console.error(`[coalition-invite] failed to invite ${email} to ${coalition}:`, msg);
		return json({ error: 'Failed to invite user to channel' }, { status: 502 });
	}

	return json({ success: true });
};
