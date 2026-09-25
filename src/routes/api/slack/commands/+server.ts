import { json, text } from '@sveltejs/kit';
import { WebClient } from '@slack/web-api';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { APP_URL } from '$lib/server/env.js';
import { loadSettings, findInfoCommand, listInfoCommands } from '$lib/server/settings.js';
import { verifySlackSignature } from '$lib/server/slack-signature.js';
import { canUseSlackCommands, NOT_AUTHORIZED_TEXT } from '$lib/server/slack-admin.js';
import { buildNoteModal, parseCommandTarget } from '$lib/server/slack-modal.js';
import { channelNameToId } from '$lib/server/slack-channel-names.js';
import { loadUserToken, type TokenLookupFailure } from '$lib/server/user-tokens.js';
import { normalizeCommandName, renderCommandList, renderInfoMessage } from '$lib/info-command.js';
import { postToResponseUrl, respondToSlack } from '$lib/server/slack-response-url.js';
import { myTurfMessage, turfListMessage } from '$lib/server/van/turf-slack.js';
import { errMessage } from '$lib/err-message.js';

// Slash commands. Five kinds:
//
//   /member-note          — opens the note/warning modal (see slack-modal.ts)
//   /turfs                — nearest claimable turf, claimable in place
//   /turfs-mine           — what you are holding, with its list numbers
//                           (see van/turf-slack.ts)
//   /list-commands        — every info command and its message, shown only to
//                           the person who ran it
//   anything else         — looked up in `info_commands`, the admin-defined
//                           blurbs, and posted **as the person who typed it**
//
// Everything but /turfs and /turfs-mine is for admins and moderators (see
// slack-admin.ts); moderators exist precisely to use these commands without
// the web admin.
//
// /turfs and /turfs-mine are the ONLY commands here open to everyone, and
// deliberately so: they serve the same data the /turfs web page serves, and
// that page is open to any signed-in workspace member minus the turf
// blocklist. A Slack workspace member is the same bar as a Slack-OAuth
// session, so this grants nothing new. Their gates are van/turf-slack.ts's,
// not this file's.
//
// Two things differ from the events route: Slack sends slash commands as
// `application/x-www-form-urlencoded` (so the body is parsed with
// URLSearchParams, not JSON.parse), and those requests carry no Origin header —
// which is why /api/slack/* is exempt from the CSRF check in
// src/lib/server/csrf.ts. The signature verification below is what replaces it.

const LOG = '[info-command]';
const TURF_LOG = '[van]';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const form = new URLSearchParams(body);
	const command = form.get('command') ?? '';
	const slackUserId = form.get('user_id') ?? '';
	const triggerId = form.get('trigger_id') ?? '';
	const channelId = form.get('channel_id');
	const commandText = form.get('text') ?? '';
	const responseUrl = form.get('response_url');

	if (command === '/member-note') {
		return handleMemberNote({ slackUserId, triggerId, channelId, commandText });
	}

	if (command === '/turfs') {
		return handleTurfs({ slackUserId, commandText, responseUrl });
	}

	if (command === '/turfs-mine') {
		return handleTurfsMine({ slackUserId, responseUrl });
	}

	if (command === '/list-commands') {
		return handleListCommands(slackUserId, responseUrl);
	}

	return handleInfoCommand({ command, slackUserId, channelId });
};

// ---------------------------------------------------------------------------
// /turfs-mine
// ---------------------------------------------------------------------------

/**
 * What you are holding right now.
 *
 * Deferred like /turfs rather than answered inline: it is two reads plus an
 * admin lookup, which is usually well inside Slack's three seconds and is not
 * worth betting a timeout on when fly.toml still allows a cold boot.
 *
 * No argument is read. /turfs takes a ZIP or an address because it has to
 * decide what is NEAR you; this command answers from rows that are already
 * yours, so there is nothing for a location to change.
 */
function handleTurfsMine(args: { slackUserId: string; responseUrl: string | null }): Response {
	const { slackUserId, responseUrl } = args;

	void (async () => {
		const message = await myTurfMessage(db, { slackUserId });
		respondToSlack(responseUrl, message, { replaceOriginal: true, logTag: TURF_LOG });
	})().catch((err) => {
		console.error(`${TURF_LOG} /turfs-mine failed for ${slackUserId}:`, errMessage(err));
		respondToSlack(
			responseUrl,
			{ text: 'Could not look up your turf just now. Please try again.' },
			{ replaceOriginal: true, logTag: TURF_LOG },
		);
	});

	return ephemeral('Looking up your turf…');
}

// ---------------------------------------------------------------------------
// /turfs
// ---------------------------------------------------------------------------

/**
 * Acknowledge now, answer in a moment.
 *
 * Unlike /member-note this cannot be done inside Slack's three seconds. A cold
 * geocode is up to four on its own (zip-centroid.ts), and fly.toml still has
 * min_machines_running = 0, so a boot can land on top of it.
 *
 * The follow-up asks to replace the ack rather than sit below it. Slack's
 * support for `replace_original` on a slash command's first ephemeral is not
 * something to bet on, so the failure mode is deliberately benign: if it does
 * not take, the answer simply appears under "Finding turf near you…" instead
 * of over it.
 */
function handleTurfs(args: {
	slackUserId: string;
	commandText: string;
	responseUrl: string | null;
}): Response {
	const { slackUserId, commandText, responseUrl } = args;

	void (async () => {
		const message = await turfListMessage(db, {
			slackUserId,
			argument: commandText,
		});
		respondToSlack(responseUrl, message, { replaceOriginal: true, logTag: TURF_LOG });
	})().catch((err) => {
		console.error(`${TURF_LOG} /turfs failed for ${slackUserId}:`, errMessage(err));
		respondToSlack(
			responseUrl,
			{ text: 'Could not look up turf just now. Please try again.' },
			{ replaceOriginal: true, logTag: TURF_LOG },
		);
	});

	return ephemeral(commandText.trim() ? 'Finding turf near you…' : 'Finding turf…');
}

// ---------------------------------------------------------------------------
// /member-note
// ---------------------------------------------------------------------------

async function handleMemberNote(args: {
	slackUserId: string;
	triggerId: string;
	channelId: string | null;
	commandText: string;
}): Promise<Response> {
	const { slackUserId, triggerId, channelId, commandText } = args;

	if (!(await canUseSlackCommands(slackUserId))) {
		// 200 with an ephemeral body — only the person who typed it sees this.
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	if (!triggerId) {
		return ephemeral('Slack did not send a trigger id, so the dialog cannot be opened.');
	}

	// Awaited rather than fire-and-forget: this is a single ~200ms call, well
	// inside Slack's 3-second budget, and if it fails the admin needs to be told
	// rather than left staring at nothing. The trigger_id also expires in about
	// three seconds, so there is nothing to gain by deferring it.
	try {
		const { warningDmMessage } = await loadSettings(db);
		await slack.views.open({
			trigger_id: triggerId,
			view: buildNoteModal(
				// `<@U123|name>` only arrives if "Escape channels, users, and
				// links" is enabled on the command; without it we simply open
				// the modal with no member preselected.
				{ slackUserId: parseCommandTarget(commandText) },
				{ channelId, source: 'slash', warningTemplate: warningDmMessage },
			),
		});
	} catch (err) {
		console.error('[member-note] views.open failed:', errMessage(err));
		return ephemeral('Could not open the note dialog. Please try again.');
	}

	// Empty 200 — the modal is the response; echoing text would just clutter
	// the channel.
	return text('', { status: 200 });
}

// ---------------------------------------------------------------------------
// /list-commands
// ---------------------------------------------------------------------------

/**
 * Admins and moderators only, like the commands it lists: anyone else could
 * not run any of them, so the list would only be a menu of things that refuse
 * them.
 *
 * The reply is ephemeral — the response body, or response_url — never
 * postMessage, so it needs neither a stored authorization nor the bot's
 * membership in the channel, and nobody else in the channel sees it.
 */
async function handleListCommands(
	slackUserId: string,
	responseUrl: string | null,
): Promise<Response> {
	if (!(await canUseSlackCommands(slackUserId))) {
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	let entries;
	try {
		entries = await listInfoCommands(db);
	} catch (err) {
		console.error(`${LOG} /list-commands lookup failed:`, errMessage(err));
		return ephemeral('Could not load the command list. Please try again.');
	}

	// Skip the channel list when there is nothing to resolve links in.
	const nameToId = entries.length > 0 ? await channelNameToId('list-commands') : new Map();
	const messages = renderCommandList(entries, nameToId);

	// The usual case: the whole list fits in one message, sent as the body.
	// (No response_url is a request Slack never actually sends; the first
	// message is still better than nothing.)
	if (messages.length === 1 || !responseUrl) return ephemeral(messages[0]!);

	// Too long for one message, so it goes out as several — all of them through
	// response_url, awaited one after another. Putting the first in the body
	// instead would race the follow-ups, and the list could arrive out of order.
	//
	// Slack accepts five posts per response_url. At 39k characters a message and
	// 3k at most per blurb, that is well over sixty maximum-length commands; if a
	// list ever outgrows it, the post Slack refuses is logged and the rest stop.
	void (async () => {
		for (const [i, message] of messages.entries()) {
			const ok = await postToResponseUrl(responseUrl, { text: message }, { logTag: LOG });
			if (!ok) {
				console.error(`${LOG} /list-commands stopped at message ${i + 1} of ${messages.length}`);
				return;
			}
		}
	})();

	// Empty 200 — the messages above are the reply.
	return text('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Admin-defined info commands
// ---------------------------------------------------------------------------

async function handleInfoCommand(args: {
	command: string;
	slackUserId: string;
	channelId: string | null;
}): Promise<Response> {
	const { slackUserId, channelId } = args;
	// Slack always sends the command lowercase and slash-prefixed, but the rows
	// are keyed on the normalized form, so normalize both sides rather than
	// trusting that to stay true.
	const command = normalizeCommandName(args.command);

	let entry;
	try {
		entry = await findInfoCommand(db, command);
	} catch (err) {
		console.error(`${LOG} lookup failed for ${command}:`, errMessage(err));
		return ephemeral('Could not look that command up. Please try again.');
	}

	if (!entry) {
		console.warn(`${LOG} unrecognized command "${command}"`);
		return ephemeral('Unrecognized command.');
	}

	// Same gate as /member-note. It is also the only gate that can work: a
	// token is stored only for admins and moderators (see auth/slack/callback),
	// so anyone else has nothing to post with.
	if (!(await canUseSlackCommands(slackUserId))) {
		return ephemeral(NOT_AUTHORIZED_TEXT);
	}

	if (!channelId) {
		return ephemeral('Slack did not say which channel to post in.');
	}

	const lookup = await loadUserToken(db, slackUserId);
	if (!lookup.ok) {
		return ephemeral(reauthorizeMessage(lookup.reason));
	}

	// Channel links are resolved with the *bot* client: it is the one with
	// channels:read, and the cached list is shared with the DM templates.
	// Failing to resolve is non-fatal — names stay literal (see
	// channelNameToId), which is better than not posting at all.
	const message = renderInfoMessage(entry.message, await channelNameToId('info-command'));

	try {
		// A per-request client, not the shared bot `slack` proxy: this call must
		// carry the user's own token, which is the entire point — the message
		// lands as theirs, editable and deletable by them, with no APP badge.
		await new WebClient(lookup.token).chat.postMessage({
			channel: channelId,
			text: message,
			// No `blocks`: a section block would render the same text but strip
			// the message of its plain-text fallback in notifications, and
			// there is no structure here worth the tradeoff.
			unfurl_links: false,
		});
	} catch (err) {
		const detail = errMessage(err);
		console.error(`${LOG} ${command} post as ${slackUserId} failed:`, detail);
		return ephemeral(postFailureMessage(detail));
	}

	console.log(`${LOG} ${command} posted as ${slackUserId} in ${channelId}`);
	// Empty 200 — the posted message is the response.
	return text('', { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ephemeral(message: string): Response {
	return json({ response_type: 'ephemeral', text: message });
}

/** All four lookup failures are fixed by logging in again, so they share a
 *  call to action and differ only in why. */
function reauthorizeMessage(reason: TokenLookupFailure): string {
	const authorize = `${APP_URL}/auth/slack`;
	switch (reason) {
		case 'stale-scope':
			return (
				'This command posts as you, and your Slack authorization predates that. ' +
				`Sign in again at ${authorize} to grant it, then retry.`
			);
		case 'unreadable':
		case 'error':
			return (
				'Your stored Slack authorization could not be read. ' +
				`Sign in again at ${authorize} to refresh it, then retry.`
			);
		case 'missing':
		default:
			return (
				'This command posts as you, so it needs your authorization first. ' +
				`Sign in at ${authorize}, then retry.`
			);
	}
}

/** Turn the two Slack errors an admin can actually act on into instructions,
 *  and pass anything else through so the failure isn't silent. */
function postFailureMessage(detail: string): string {
	if (detail.includes('not_in_channel')) {
		return 'You need to be a member of this channel to post here.';
	}
	if (detail.includes('token_revoked') || detail.includes('invalid_auth')) {
		return (
			'Slack rejected your stored authorization — it may have been revoked. ' +
			`Sign in again at ${APP_URL}/auth/slack, then retry.`
		);
	}
	return `Could not post the message: ${detail}`;
}
