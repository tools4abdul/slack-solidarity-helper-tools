import { json, text as textResponse } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { APP_URL } from '$lib/server/env.js';
import { verifySlackSignature } from '$lib/server/slack-signature.js';
import { canUseSlackCommands, NOT_AUTHORIZED_TEXT } from '$lib/server/slack-admin.js';
import { channelNameToId } from '$lib/server/slack-channel-names.js';
import { insertNote, recordDmOutcome } from '$lib/server/member-notes.js';
import { renderWarningDm } from '$lib/warning-dm.js';
import { renderMemberNoteLog } from '$lib/member-note-log.js';
import { buildSlackPermalink } from '$lib/slack-message-link.js';
import {
	buildNoteModal,
	extractNoteSubmission,
	prefillFromView,
	readModalMetadata,
	BLOCK,
	KIND_ACTION_ID,
	NOTE_MODAL_CALLBACK_ID,
	LOG_NOTE_SHORTCUT_CALLBACK_ID,
	VIEW_RECORD_SHORTCUT_CALLBACK_ID,
	type NoteSubmission,
} from '$lib/server/slack-modal.js';
import { displayName } from '$lib/server/slack-display-name.js';
import { respondToSlack } from '$lib/server/slack-response-url.js';
import {
	decodeTurfAction,
	TURF_CLAIM_ACTION_ID,
	TURF_PAGE_ACTION_ID,
	TURF_RELEASE_ACTION_ID,
	TURF_RELEASE_MINE_ACTION_ID,
	TURF_COMPLETE_ACTION_ID,
} from '$lib/server/van/turf-command.js';
import {
	claimFromSlack,
	completeFromSlack,
	myTurfMessage,
	releaseFromSlack,
	releaseMineFromSlack,
	turfListMessage,
} from '$lib/server/van/turf-slack.js';
import { errMessage } from '$lib/err-message.js';

// Everything Slack sends back from an interactive surface:
//
//   message_action  — the two message shortcuts (log a note; open the record)
//   block_actions   — the Note/Warning radio changing, which shows or hides
//                     the editable warning text
//   view_submission — the modal being saved
//
// Same form-encoded, Origin-less shape as the slash command route, so the same
// signature-verification-instead-of-CSRF reasoning applies (see
// src/lib/server/csrf.ts).

const LOG = '[member-note]';
const TURF_LOG = '[van]';

interface SlackPayload {
	type?: string;
	callback_id?: string;
	trigger_id?: string;
	response_url?: string;
	user?: { id?: string };
	team?: { domain?: string };
	channel?: { id?: string };
	message?: { user?: string; bot_id?: string; ts?: string; thread_ts?: string };
	actions?: { action_id?: string; value?: string; selected_option?: { value?: string } }[];
	view?: { id?: string; hash?: string; callback_id?: string };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.text();

	if (!(await verifySlackSignature(request, body))) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let payload: SlackPayload;
	try {
		payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '') as SlackPayload;
	} catch {
		console.warn(`${LOG} could not parse interactivity payload`);
		return ok();
	}

	switch (payload.type) {
		case 'message_action':
			return handleMessageAction(payload);
		case 'block_actions':
			return handleBlockActions(payload);
		case 'view_submission':
			return handleViewSubmission(payload);
		default:
			// view_closed and anything else Slack adds later — acknowledge
			// quietly rather than surfacing an error to the user.
			return ok();
	}
};

const ok = () => textResponse('', { status: 200 });

// ---------------------------------------------------------------------------
// Message shortcuts
// ---------------------------------------------------------------------------

async function handleMessageAction(payload: SlackPayload): Promise<Response> {
	const actorId = payload.user?.id ?? '';
	if (!(await canUseSlackCommands(actorId))) {
		// A shortcut has no ephemeral channel of its own, so the refusal goes
		// back through response_url. Detached: the 200 must not wait on it.
		respondEphemeral(payload.response_url, NOT_AUTHORIZED_TEXT);
		return ok();
	}

	switch (payload.callback_id) {
		case LOG_NOTE_SHORTCUT_CALLBACK_ID:
			return openNoteModalFromMessage(payload);
		case VIEW_RECORD_SHORTCUT_CALLBACK_ID:
			return openMemberRecord(payload);
		default:
			console.warn(`${LOG} unrecognized shortcut "${payload.callback_id}"`);
			return ok();
	}
}

async function openNoteModalFromMessage(payload: SlackPayload): Promise<Response> {
	// The permalink is assembled locally from what the payload already carries.
	// chat.getPermalink would be a round trip in front of a trigger_id that
	// expires in ~3 seconds, and it would tell us nothing we don't have.
	const messageLink = buildSlackPermalink({
		teamDomain: payload.team?.domain,
		channelId: payload.channel?.id,
		ts: payload.message?.ts,
		threadTs: payload.message?.thread_ts ?? null,
	});

	try {
		const { warningDmMessage } = await loadSettings(db);
		await slack.views.open({
			trigger_id: payload.trigger_id ?? '',
			view: buildNoteModal(
				// message.user is absent on bot posts; the picker is then left
				// empty rather than prefilled with nothing useful.
				{ slackUserId: payload.message?.user ?? null, messageLink },
				{
					channelId: payload.channel?.id ?? null,
					source: 'shortcut',
					warningTemplate: warningDmMessage,
				},
			),
		});
	} catch (err) {
		console.error(`${LOG} views.open from shortcut failed:`, errMessage(err));
		respondEphemeral(payload.response_url, 'Could not open the note dialog. Please try again.');
	}
	return ok();
}

async function openMemberRecord(payload: SlackPayload): Promise<Response> {
	const targetId = payload.message?.user;
	if (!targetId) {
		// Bot and app messages carry bot_id but no user — there is no member
		// record to open, so say so rather than link somewhere useless.
		respondEphemeral(
			payload.response_url,
			"Couldn't identify who posted that message — it may have been sent by an app.",
		);
		return ok();
	}

	const url = `${APP_URL}/members?user=${encodeURIComponent(targetId)}`;
	respondEphemeral(payload.response_url, `Member record for <@${targetId}>`, [
		{
			type: 'section',
			text: { type: 'mrkdwn', text: `*Member record for <@${targetId}>*` },
			accessory: {
				type: 'button',
				text: { type: 'plain_text', text: 'Open member record' },
				url,
				action_id: 'open_member_record',
			},
		},
	]);
	return ok();
}

// ---------------------------------------------------------------------------
// Radio toggle — show/hide the editable warning text
// ---------------------------------------------------------------------------

async function handleBlockActions(payload: SlackPayload): Promise<Response> {
	// Turf buttons are checked FIRST and by action_id, because they come from a
	// message rather than a modal: `payload.view` is undefined for them, so the
	// note-modal guard below would swallow them silently.
	const turfAction = payload.actions?.find(
		(a) =>
			a.action_id === TURF_CLAIM_ACTION_ID ||
			a.action_id === TURF_RELEASE_ACTION_ID ||
			a.action_id === TURF_RELEASE_MINE_ACTION_ID ||
			a.action_id === TURF_COMPLETE_ACTION_ID ||
			a.action_id === TURF_PAGE_ACTION_ID,
	);
	if (turfAction) return handleTurfAction(payload, turfAction);

	const changedKind = payload.actions?.some((a) => a.action_id === KIND_ACTION_ID);
	if (!changedKind || payload.view?.callback_id !== NOTE_MODAL_CALLBACK_ID) return ok();

	try {
		const { warningDmMessage } = await loadSettings(db);
		await slack.views.update({
			view_id: payload.view.id ?? '',
			// Slack rejects the update if the view changed underneath us, which
			// is what keeps two rapid toggles from applying out of order.
			hash: payload.view.hash,
			view: buildNoteModal(
				// Every field is read back out and passed in again: views.update
				// replaces the whole view, so anything not re-supplied would be
				// silently wiped — including details the admin already typed.
				prefillFromView(payload),
				// Metadata is re-supplied for the same reason the field values
				// are: views.update replaces the view wholesale.
				{ ...readModalMetadata(payload), warningTemplate: warningDmMessage },
			),
		});
	} catch (err) {
		console.error(`${LOG} views.update failed:`, errMessage(err));
	}
	return ok();
}

// ---------------------------------------------------------------------------
// Turf checkout buttons
// ---------------------------------------------------------------------------

/**
 * Claim, give back, or page the turf list.
 *
 * Every gate the /turfs command applies is applied again inside
 * van/turf-slack.ts, against the same shared counters. That is not belt and
 * braces: these buttons are reachable without ever running the command — a
 * value can be replayed, and a message stays interactive for thirty minutes —
 * so inheriting the command's gates is not something they can do.
 *
 * Acknowledged immediately and answered through response_url, because a claim
 * is several database round trips and Slack's budget is three seconds.
 */
function handleTurfAction(
	payload: SlackPayload,
	action: { action_id?: string; value?: string; selected_option?: { value?: string } },
): Response {
	const slackUserId = payload.user?.id ?? '';
	const responseUrl = payload.response_url;
	// The value round-tripped through a client, so it is untrusted input.
	// decodeTurfAction validates it; turf-slack re-checks the chapter against
	// settings regardless.
	// A button carries `value`; the "Mark it done" dropdown carries the chosen
	// option's value instead, with the percentage packed into it.
	const decoded = decodeTurfAction(action.value ?? action.selected_option?.value);

	if (!slackUserId || !decoded) {
		respondToSlack(
			responseUrl,
			{ text: 'That button has expired. Run `/turfs` again.' },
			{ replaceOriginal: true, logTag: TURF_LOG },
		);
		return ok();
	}

	void (async () => {
		const ctx = {
			slackUserId,
			channelId: payload.channel?.id ?? null,
			chapterId: decoded.chapterId,
			offset: decoded.offset,
			location: decoded.location ?? null,
		};

		// Every branch needing a mapRouteId checks for one: the value came back
		// from a client, so "the button said complete but named no turf" is a
		// request that has to land somewhere sane rather than throw.
		const routeId = decoded.mapRouteId;
		const message =
			action.action_id === TURF_CLAIM_ACTION_ID && routeId !== undefined
				? await claimFromSlack(db, { ...ctx, mapRouteId: routeId })
				: action.action_id === TURF_RELEASE_ACTION_ID && routeId !== undefined
					? await releaseFromSlack(db, { ...ctx, mapRouteId: routeId })
					: action.action_id === TURF_RELEASE_MINE_ACTION_ID && routeId !== undefined
						? await releaseMineFromSlack(db, { ...ctx, mapRouteId: routeId })
						: action.action_id === TURF_COMPLETE_ACTION_ID && routeId !== undefined
							? await completeFromSlack(db, {
									...ctx,
									mapRouteId: routeId,
									percent: decoded.percent ?? null,
								})
							: // A mine-list button that lost its turf id redraws the mine
								// list, not the nearby one — landing somewhere unrelated to
								// where the tap happened is its own small betrayal.
								action.action_id === TURF_RELEASE_MINE_ACTION_ID ||
								  action.action_id === TURF_COMPLETE_ACTION_ID
								? await myTurfMessage(db, ctx)
								: await turfListMessage(db, ctx);

		respondToSlack(responseUrl, message, { replaceOriginal: true, logTag: TURF_LOG });
	})().catch((err) => {
		console.error(
			`${TURF_LOG} turf action ${action.action_id} failed for ${slackUserId}:`,
			errMessage(err),
		);
		respondToSlack(
			responseUrl,
			{ text: 'That did not go through. Run `/turfs` again.' },
			{ replaceOriginal: true, logTag: TURF_LOG },
		);
	});

	return ok();
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

async function handleViewSubmission(payload: SlackPayload): Promise<Response> {
	if (payload.view?.callback_id !== NOTE_MODAL_CALLBACK_ID) return ok();

	const actorId = payload.user?.id ?? '';
	// Re-checked because the modal may have been opened before an allowlist
	// change landed.
	if (!(await canUseSlackCommands(actorId))) {
		return json({
			response_action: 'errors',
			errors: { [BLOCK.member]: NOT_AUTHORIZED_TEXT },
		});
	}

	const parsed = extractNoteSubmission(payload);
	if (!parsed.ok) {
		// Keeps the modal open with messages attached to the offending fields.
		return json({ response_action: 'errors', errors: parsed.errors });
	}

	const { submission } = parsed;
	const { channelId, source } = readModalMetadata(payload);
	const authorName = await displayName(actorId);

	let inserted;
	try {
		inserted = await insertNote(db, {
			slackUserId: submission.slackUserId,
			kind: submission.kind,
			body: submission.body,
			messageLink: submission.messageRef?.url ?? null,
			messageChannelId: submission.messageRef?.channelId ?? null,
			messageTs: submission.messageRef?.ts ?? null,
			dmRequested: submission.sendDm,
			authorSlackUserId: actorId,
			authorSlackUserName: authorName,
			source,
		});
	} catch (err) {
		console.error(`${LOG} failed to save note:`, errMessage(err));
		return json({
			response_action: 'errors',
			errors: { [BLOCK.body]: 'Could not save the note. Please try again.' },
		});
	}

	console.log(
		`${LOG} ${submission.kind} logged for ${submission.slackUserId} by ${actorId}` +
			(inserted.warningNumber ? ` (warning #${inserted.warningNumber})` : ''),
	);

	// The row is committed. Everything below is best-effort and runs detached,
	// after the modal has already closed — the DM path is 2-3 Slack round trips
	// and would otherwise risk the 3-second view_submission deadline.
	void finishSubmission({
		noteId: inserted.id,
		warningNumber: inserted.warningNumber,
		submission,
		actorId,
		channelId,
	}).catch((err) => console.error(`${LOG} post-save handling failed:`, errMessage(err)));

	// Empty body closes the modal.
	return json({});
}

interface FinishArgs {
	noteId: number;
	warningNumber: number | null;
	submission: NoteSubmission;
	actorId: string;
	channelId: string | null;
}

async function finishSubmission(args: FinishArgs): Promise<void> {
	const { noteId, warningNumber, submission, actorId, channelId } = args;

	if (submission.kind !== 'warning') {
		await recordDmOutcome(db, noteId, { status: 'not-a-warning' });
		await announceToAdmins(submission, actorId, null);
		await notifyAuthor(actorId, channelId, `Note logged for <@${submission.slackUserId}>.`);
		return;
	}

	if (!submission.sendDm) {
		await recordDmOutcome(db, noteId, { status: 'suppressed' });
		await announceToAdmins(submission, actorId, null);
		await notifyAuthor(
			actorId,
			channelId,
			`Warning #${warningNumber} logged for <@${submission.slackUserId}> — no DM sent.`,
		);
		return;
	}

	// An empty box means "use what Settings says". Resolving it here rather than
	// leaning on renderWarningDm's own fallback matters: that one drops to the
	// hardcoded DEFAULT_WARNING_DM and would quietly ignore the admin's
	// configured template. renderWarningDm still backstops a blank setting.
	let template = submission.warningText;
	if (template === '') {
		try {
			template = (await loadSettings(db)).warningDmMessage;
		} catch (err) {
			console.error(`${LOG} could not load the warning template:`, errMessage(err));
			template = '';
		}
	}

	const dmBody = renderWarningDm(
		template,
		{
			warningNumber: warningNumber ?? 1,
			noteBody: submission.body,
			messageLink: submission.messageRef?.url ?? null,
		},
		await channelNameToId('member-note'),
	);

	try {
		const dm = await slack.conversations.open({ users: submission.slackUserId });
		const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
		if (!dmChannelId) throw new Error('Slack returned no DM channel');

		await slack.chat.postMessage({
			channel: dmChannelId,
			text: dmBody,
			blocks: [{ type: 'section', text: { type: 'mrkdwn', text: dmBody } }],
		});

		await recordDmOutcome(db, noteId, {
			sentAt: new Date().toISOString(),
			body: dmBody,
		});
		await announceToAdmins(submission, actorId, dmBody);
		await notifyAuthor(
			actorId,
			channelId,
			`Warning #${warningNumber} logged for <@${submission.slackUserId}> and DM'd to them.`,
		);
	} catch (err) {
		const message = errMessage(err);
		console.error(`${LOG} warning DM to ${submission.slackUserId} failed:`, message);
		// The note itself is already safe; record why the member wasn't told so
		// the page can show it and an admin can follow up in person.
		await recordDmOutcome(db, noteId, { status: message, body: dmBody });
		// null, not dmBody: the send failed, so "sent to them" would be a lie.
		await announceToAdmins(submission, actorId, null);
		await notifyAuthor(
			actorId,
			channelId,
			`Warning #${warningNumber} was logged for <@${submission.slackUserId}>, but the DM could not be sent: ${message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Announce the note in the admin tracking channel, if one is configured.
 *
 * Opt-in and entirely best-effort: an unset channel is the normal state, not an
 * error, and a posting failure must never surface to the admin or disturb the
 * note — which is already committed by the time this runs.
 */
async function announceToAdmins(
	submission: NoteSubmission,
	actorId: string,
	dmBody: string | null,
): Promise<void> {
	try {
		const { slackMemberNoteChannelId } = await loadSettings(db);
		if (!slackMemberNoteChannelId) return;

		const text = renderMemberNoteLog({
			kind: submission.kind,
			body: submission.body,
			targetSlackUserId: submission.slackUserId,
			authorSlackUserId: actorId,
			dmBody,
			messageLink: submission.messageRef?.url ?? null,
		});

		await slack.chat.postMessage({
			channel: slackMemberNoteChannelId,
			text,
			blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
		});
	} catch (err) {
		console.error(`${LOG} could not post to the admin channel:`, errMessage(err));
	}
}

/** Confirmation back to the admin who filed the note. Never throws — this is
 *  the least important thing in the flow and must not mask a real error. */
async function notifyAuthor(
	actorId: string,
	channelId: string | null,
	message: string,
): Promise<void> {
	try {
		if (channelId) {
			await slack.chat.postEphemeral({ channel: channelId, user: actorId, text: message });
			return;
		}
		const dm = await slack.conversations.open({ users: actorId });
		const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
		if (dmChannelId) await slack.chat.postMessage({ channel: dmChannelId, text: message });
	} catch (err) {
		console.warn(`${LOG} could not confirm to ${actorId}:`, errMessage(err));
	}
}

/** Post to a shortcut's response_url. Detached and swallowed by design. */
function respondEphemeral(responseUrl: string | undefined, text: string, blocks?: unknown[]): void {
	if (!responseUrl) return;
	void fetch(responseUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) }),
	}).catch((err) => console.warn(`${LOG} response_url post failed:`, errMessage(err)));
}
