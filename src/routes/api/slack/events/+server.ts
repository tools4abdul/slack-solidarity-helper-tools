import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slackJoins } from '$lib/server/schema.js';
import { slack } from '$lib/server/slack.js';
import { getUserByEmail } from '$lib/server/solidarity.js';
import { loadSettings } from '$lib/server/settings.js';
import { verifySlackSignature } from '$lib/server/slack-signature.js';
import { channelNameToId } from '$lib/server/slack-channel-names.js';
import { renderWelcomeDm } from '$lib/welcome-dm.js';
// This route used to also watch the door-knocking channel's "Conversation
// Codes" canvas for Openfield, caching new codes as they appeared. Openfield is
// retired (plan.md Story 9) and nothing reads canvases any more, so file_change
// events are now ignored. The `file_change` bot event subscription can be
// removed from the Slack app.

// ---------------------------------------------------------------------------
// Slack signature verification
// ---------------------------------------------------------------------------

// Re-exported under the original name so this route's existing tests and any
// other callers keep working; the implementation now lives in
// $lib/server/slack-signature.js and is shared with the command routes.
export const _verifySlackSignature = verifySlackSignature;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const payload = JSON.parse(body) as SlackEventPayload;

	// Slack sends this once when you first configure the Events API URL
	if (payload.type === 'url_verification') {
		return json({ challenge: payload.challenge });
	}

	if (payload.type === 'event_callback' && payload.event?.type === 'team_join') {
		// Respond immediately — Slack requires a 200 within 3 seconds
		handleTeamJoin(payload.event.user).catch((err) => {
			console.error(
				'[slack-events] team_join handler failed:',
				err instanceof Error ? err.message : err,
			);
		});
	}

	return json({ ok: true });
};

// ---------------------------------------------------------------------------
// team_join handler
// ---------------------------------------------------------------------------

interface SlackUser {
	id: string;
}

interface SlackEventPayload {
	type: string;
	challenge?: string;
	event?: { type: string; user: SlackUser; file_id?: string };
}

// Slack only delivers team_join once (we ack with a 200 before this handler
// runs), so a transient DB blip must not permanently cost a joiner their
// channel invites. Retry with increasing waits before giving up; the handler
// runs detached from the HTTP response, so waiting here blocks nothing.
const LOAD_SETTINGS_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

async function loadSettingsWithRetry(): Promise<Awaited<ReturnType<typeof loadSettings>>> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await loadSettings(db);
		} catch (err) {
			if (attempt >= LOAD_SETTINGS_RETRY_DELAYS_MS.length) throw err;
			const delayMs = LOAD_SETTINGS_RETRY_DELAYS_MS[attempt]!;
			console.warn(
				`[slack-events] loadSettings failed (attempt ${attempt + 1}), retrying in ${delayMs}ms:`,
				err instanceof Error ? err.message : err,
			);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

async function handleTeamJoin(user: SlackUser): Promise<void> {
	// The team_join event payload does not include profile.email — fetch it via the API.
	const info = await slack.users.info({ user: user.id });
	const email = (info.user as { profile?: { email?: string } } | undefined)?.profile?.email;
	if (!email) {
		console.log(
			`[slack-events] team_join for ${user.id} — no email returned by users.info, skipping`,
		);
		return;
	}

	const solidarityUser = await getUserByEmail(email);
	if (!solidarityUser) {
		console.log(`[slack-events] no solidarity account found for ${email}`);
		return;
	}

	const chapterIds = resolveChapterIds(solidarityUser);
	await recordSlackJoin(user.id, email, chapterIds);

	// The mapping is admin-editable on /settings (DB-backed) and many-to-many:
	// every channel mapped to any of the joiner's chapters, deduped since
	// sibling chapters often share a channel.
	const { chapterChannelMap, welcomeDisabledChannelIds, welcomeDmMessage } =
		await loadSettingsWithRetry();
	const channelIds = [
		...new Set(
			chapterChannelMap.filter((e) => chapterIds.includes(e.chapterId)).map((e) => e.channelId),
		),
	];

	if (!channelIds.length) {
		console.log(
			`[slack-events] no channel mapping for chapters [${chapterIds.join(', ')}] (${email})`,
		);
		return;
	}

	const successfulChannelIds = await inviteToChannels(user.id, channelIds);
	if (!successfulChannelIds.length) {
		console.log(`[slack-events] all channel invites failed for ${user.id} (${email}), skipping DM`);
		return;
	}

	// Per-channel opt-out (the chip checkbox on /settings): invited either way,
	// but flagged channels get no "everybody welcome" post. The DM below still
	// mentions every channel they were invited to.
	const announceChannelIds = successfulChannelIds.filter(
		(id) => !welcomeDisabledChannelIds.has(id),
	);
	if (announceChannelIds.length > 0) {
		await announceInChannels(user.id, announceChannelIds);
	}

	const sent = await sendWelcomeDm(user.id, successfulChannelIds, welcomeDmMessage);
	if (sent) {
		const channelMentions = successfulChannelIds.map((id) => `<#${id}>`).join(', ');
		console.log(`[slack-events] invited ${user.id} (${email}) to ${channelMentions} and sent DM`);
	}
}

function resolveChapterIds(solidarityUser: {
	chapter_id?: number | null;
	chapter_ids?: number[];
}): number[] {
	if (solidarityUser.chapter_ids?.length) return solidarityUser.chapter_ids;
	if (solidarityUser.chapter_id != null) return [solidarityUser.chapter_id];
	return [];
}

async function recordSlackJoin(
	slackUserId: string,
	email: string,
	chapterIds: number[],
): Promise<void> {
	try {
		await db
			.insert(slackJoins)
			.values({
				slackUserId,
				email,
				joinedAt: new Date().toISOString(),
				chapterIds: JSON.stringify(chapterIds),
			})
			.onConflictDoNothing({ target: slackJoins.slackUserId });
	} catch (err) {
		console.error(
			`[slack-events] failed to record slack_join for ${slackUserId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

async function inviteToChannels(slackUserId: string, channelIds: string[]): Promise<string[]> {
	const results = await Promise.allSettled(
		channelIds.map((channelId) =>
			slack.conversations.invite({ channel: channelId, users: slackUserId }),
		),
	);

	const successful: string[] = [];
	for (let i = 0; i < channelIds.length; i++) {
		const result = results[i]!;
		if (result.status === 'fulfilled') {
			successful.push(channelIds[i]!);
		} else {
			console.error(
				`[slack-events] failed to invite ${slackUserId} to ${channelIds[i]}:`,
				result.reason instanceof Error ? result.reason.message : result.reason,
			);
		}
	}
	return successful;
}

// A rotating set of channel welcome messages so new joiners don't all get the
// same line. `%s` is replaced with the new member's <@mention>.
const CHANNEL_WELCOME_MESSAGES = [
	':tada: Everybody welcome %s to the channel — drop a hello!',
	":wave: Look who just walked in — %s is here. Don't be shy, say hi!",
	':sparkles: %s just joined us! Say hi and tell us a bit about yourself.',
	':rocket: %s has landed in the channel. Everybody say hi!',
	':seedling: A warm welcome to %s, our newest member — introduce yourself!',
	':raised_hands: Make some noise for %s, who just joined the channel! Say hi, folks!',
	':handshake: %s is in the room! Drop a wave and a hello.',
	":fist: %s — welcome aboard. Introduce yourself when you're ready!",
	':star2: A new face! Everybody say hi to %s.',
	':balloon: %s just joined the channel — welcome to the crew, say hi!',
	':sun_with_face: Good to have you here, %s. Introduce yourself!',
	':people_holding_hands: %s just joined us — everybody say hi!',
	':boom: %s has entered the channel. Welcome aboard — drop a hello!',
	':sparkler: Big welcome to %s, our latest addition — say hi, everyone!',
	':mega: Everybody give a warm welcome to %s — say hi!',
	":heart: %s just joined — so happy you're here! Introduce yourself when you can.",
	':deciduous_tree: Welcome %s! Make yourself at home and say hi.',
	':100: %s is here! Welcome to the channel — everybody say hi!',
];

function pickChannelWelcome(userMention: string): string {
	const template =
		CHANNEL_WELCOME_MESSAGES[Math.floor(Math.random() * CHANNEL_WELCOME_MESSAGES.length)]!;
	return template.replace('%s', userMention);
}

async function announceInChannels(slackUserId: string, channelIds: string[]): Promise<void> {
	const userMention = `<@${slackUserId}>`;
	const results = await Promise.allSettled(
		channelIds.map((channel) =>
			slack.chat.postMessage({ channel, text: pickChannelWelcome(userMention) }),
		),
	);
	for (let i = 0; i < channelIds.length; i++) {
		const result = results[i]!;
		if (result.status === 'rejected') {
			console.error(
				`[slack-events] failed to post welcome to ${channelIds[i]}:`,
				result.reason instanceof Error ? result.reason.message : result.reason,
			);
		}
	}
}

async function sendWelcomeDm(
	slackUserId: string,
	channelIds: string[],
	template: string,
): Promise<boolean> {
	const dm = await slack.conversations.open({ users: slackUserId });
	const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
	if (!dmChannelId) {
		console.error(`[slack-events] failed to open DM channel with ${slackUserId}`);
		return false;
	}

	const text = renderWelcomeDm(template, channelIds, await channelNameToId('slack-events'));

	await slack.chat.postMessage({
		channel: dmChannelId,
		text,
		blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
	});
	return true;
}
