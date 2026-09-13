// Block Kit view for the "Log member note" modal, plus the pure parsing of what
// comes back from it. One builder serves all three entry points (the
// /member-note slash command, the message shortcut, and a `views.update` after
// the Note/Warning radio changes) — only the prefill differs.
//
// Kept free of network and DB access so the block structure, the prefill
// behavior, and the state-preservation contract are all unit-testable in the
// node environment.

import { parseSlackMessageLink, type SlackMessageRef } from '../slack-message-link.js';

export const NOTE_MODAL_CALLBACK_ID = 'member_note_modal';
export const LOG_NOTE_SHORTCUT_CALLBACK_ID = 'log_member_note';
export const VIEW_RECORD_SHORTCUT_CALLBACK_ID = 'view_member_record';

/** Block ids, also used as the keys for `response_action: 'errors'`. */
export const BLOCK = {
	member: 'member',
	kind: 'kind',
	body: 'body',
	link: 'link',
	warningText: 'warning_text',
	dm: 'dm',
} as const;

const ACTION_ID = 'value';
/** Set on the kind block so changing the radio dispatches a `block_actions`
 *  payload — that's what lets the warning-text field appear and disappear. */
export const KIND_ACTION_ID = 'value';

export const MAX_BODY_LENGTH = 2000;
export const MAX_WARNING_LENGTH = 3000;

export type NoteKind = 'note' | 'warning';
export type NoteSource = 'slash' | 'shortcut';

/** Everything the modal can be pre-populated with. */
export interface NotePrefill {
	slackUserId?: string | null;
	messageLink?: string | null;
	kind?: NoteKind;
	body?: string | null;
	/** The per-warning message text. Prefilled with the configured template. */
	warningText?: string | null;
	sendDm?: boolean;
}

export interface NoteModalOptions {
	/** Carried through `private_metadata` so view_submission can post the
	 *  confirmation back where the command was invoked. */
	channelId?: string | null;
	/** Which entry point opened this modal. Also carried through
	 *  `private_metadata` — the view_submission payload has no other way to
	 *  tell a slash command apart from a message shortcut. */
	source?: NoteSource;
	/** Raw template used to seed the warning-text box the first time Warning is
	 *  selected. */
	warningTemplate: string;
}

// --- Block Kit types, narrowed to what we actually emit. -------------------

interface PlainText {
	type: 'plain_text';
	text: string;
	emoji?: boolean;
}
interface Option {
	text: PlainText;
	value: string;
}
type Element = Record<string, unknown>;
interface InputBlock {
	type: 'input';
	block_id: string;
	label: PlainText;
	element: Element;
	hint?: PlainText;
	optional?: boolean;
	dispatch_action?: boolean;
}
export interface NoteModalView {
	type: 'modal';
	callback_id: string;
	title: PlainText;
	submit: PlainText;
	close: PlainText;
	private_metadata: string;
	blocks: InputBlock[];
}

const text = (t: string): PlainText => ({ type: 'plain_text', text: t });

const KIND_OPTIONS: Record<NoteKind, Option> = {
	note: { text: text('Note'), value: 'note' },
	warning: { text: text('Warning'), value: 'warning' },
};

const DM_OPTION: Option = { text: text('Send DM to the member'), value: 'send' };

export interface NoteModalMetadata {
	channelId: string | null;
	messageRef: SlackMessageRef | null;
}

/**
 * Build the modal view.
 *
 * The warning-text input is rendered **only** when Warning is selected. That's
 * why the kind block sets `dispatch_action` — Slack sends a `block_actions`
 * payload on the radio change, and the handler re-renders the view. Because
 * `views.update` replaces the whole view, the caller must pass the current
 * field values back in via `prefill` or the admin loses whatever they'd already
 * typed; that round trip is the one genuinely fiddly part of this modal.
 */
export function buildNoteModal(prefill: NotePrefill, opts: NoteModalOptions): NoteModalView {
	const kind: NoteKind = prefill.kind ?? 'note';
	const blocks: InputBlock[] = [];

	blocks.push({
		type: 'input',
		block_id: BLOCK.member,
		label: text('Member'),
		element: {
			type: 'users_select',
			action_id: ACTION_ID,
			placeholder: text('Pick a person'),
			...(prefill.slackUserId ? { initial_user: prefill.slackUserId } : {}),
		},
	});

	blocks.push({
		type: 'input',
		block_id: BLOCK.kind,
		label: text('Type'),
		// Makes Slack notify us the moment the radio changes, so the warning
		// text box can be shown or hidden.
		dispatch_action: true,
		element: {
			type: 'radio_buttons',
			action_id: KIND_ACTION_ID,
			initial_option: KIND_OPTIONS[kind],
			options: [KIND_OPTIONS.note, KIND_OPTIONS.warning],
		},
	});

	blocks.push({
		type: 'input',
		block_id: BLOCK.body,
		label: text('Details'),
		element: {
			type: 'plain_text_input',
			action_id: ACTION_ID,
			multiline: true,
			max_length: MAX_BODY_LENGTH,
			...(prefill.body ? { initial_value: prefill.body } : {}),
		},
		hint: text(
			'Visible to admins and moderators on the member lookup page, and quoted in the warning DM.',
		),
	});

	blocks.push({
		type: 'input',
		block_id: BLOCK.link,
		label: text('Link to a Slack message'),
		optional: true,
		element: {
			type: 'plain_text_input',
			action_id: ACTION_ID,
			placeholder: text('Paste a Slack message link'),
			...(prefill.messageLink ? { initial_value: prefill.messageLink } : {}),
		},
		hint: text('Optional. Use “Copy link” on a message.'),
	});

	if (kind === 'warning') {
		blocks.push({
			type: 'input',
			block_id: BLOCK.warningText,
			label: text('Warning message'),
			// Optional because a blank box is a meaningful answer: send whatever
			// Settings is configured to send. Requiring it forced the admin to
			// re-approve a default they had already set.
			optional: true,
			element: {
				type: 'plain_text_input',
				action_id: ACTION_ID,
				multiline: true,
				max_length: MAX_WARNING_LENGTH,
				// Seeded from the configured template rather than pre-rendered
				// text: the warning number isn't known until the row is written,
				// and the note body may not be typed yet, so the tokens have to
				// survive until send time.
				initial_value: prefill.warningText ?? opts.warningTemplate,
			},
			hint: text(
				'Sent to the member. Leave blank to use the warning message from Settings. ' +
					'{{nth}} = which warning, {{note}} = the details above, {{message_link}} = the ' +
					'linked message. Edits apply to this warning only.',
			),
		});

		// Only rendered for warnings, because only warnings DM the member.
		// Showing it on a note and captioning it "only applies to warnings" made
		// the reader work out that a visible control does nothing.
		blocks.push({
			type: 'input',
			block_id: BLOCK.dm,
			label: text('Notify'),
			// Must be optional: an unchecked checkboxes element submits no value at
			// all, and a required input block would reject the whole submission.
			optional: true,
			element: {
				type: 'checkboxes',
				action_id: ACTION_ID,
				options: [DM_OPTION],
				...((prefill.sendDm ?? true) ? { initial_options: [DM_OPTION] } : {}),
			},
		});
	}

	return {
		type: 'modal',
		callback_id: NOTE_MODAL_CALLBACK_ID,
		title: text('Log member note'),
		submit: text('Save'),
		close: text('Cancel'),
		private_metadata: JSON.stringify({
			channelId: opts.channelId ?? null,
			source: opts.source ?? 'slash',
		}),
		blocks,
	};
}

// --- Reading the submitted view -------------------------------------------

interface ViewStateValues {
	[blockId: string]: { [actionId: string]: Record<string, unknown> } | undefined;
}

function stateOf(payload: unknown): ViewStateValues {
	const view = (payload as { view?: { state?: { values?: ViewStateValues } } } | null)?.view;
	return view?.state?.values ?? {};
}

function stringField(values: ViewStateValues, blockId: string): string {
	const raw = values[blockId]?.[ACTION_ID]?.['value'];
	return typeof raw === 'string' ? raw : '';
}

function selectedUser(values: ViewStateValues): string {
	const raw = values[BLOCK.member]?.[ACTION_ID]?.['selected_user'];
	return typeof raw === 'string' ? raw : '';
}

function selectedKind(values: ViewStateValues): NoteKind {
	const raw = values[BLOCK.kind]?.[ACTION_ID]?.['selected_option'];
	const value = (raw as { value?: unknown } | undefined)?.value;
	return value === 'warning' ? 'warning' : 'note';
}

/**
 * `true`/`false` when the checkbox was on screen, `undefined` when it wasn't.
 *
 * The distinction matters: the block only exists for warnings, so toggling
 * Note -> Warning reads a view that never had it. Reporting `false` there would
 * make the rebuilt modal come back unchecked and silently suppress the DM —
 * `undefined` lets buildNoteModal's default-checked apply instead.
 */
function dmChecked(values: ViewStateValues): boolean | undefined {
	const block = values[BLOCK.dm]?.[ACTION_ID];
	if (!block) return undefined;
	const raw = block['selected_options'];
	return Array.isArray(raw) && raw.length > 0;
}

/** Read the current field values back out of a view payload, so a
 *  `views.update` can re-seed every field it is about to replace. */
export function prefillFromView(payload: unknown): NotePrefill {
	const values = stateOf(payload);
	return {
		slackUserId: selectedUser(values) || null,
		kind: selectedKind(values),
		body: stringField(values, BLOCK.body) || null,
		messageLink: stringField(values, BLOCK.link) || null,
		warningText: stringField(values, BLOCK.warningText) || null,
		sendDm: dmChecked(values),
	};
}

export interface NoteSubmission {
	slackUserId: string;
	kind: NoteKind;
	body: string;
	messageRef: SlackMessageRef | null;
	/** Per-warning override of the DM text. `''` means the admin left it blank
	 *  and wants whatever Settings is configured to send — the caller must
	 *  substitute the stored template rather than letting renderWarningDm fall
	 *  through to its own built-in default. */
	warningText: string;
	sendDm: boolean;
}

export type SubmissionResult =
	{ ok: true; submission: NoteSubmission } | { ok: false; errors: Record<string, string> };

/**
 * Validate a `view_submission` payload. Returns per-block error messages on
 * failure, which the route hands straight back as
 * `{ response_action: 'errors', errors }` so the modal stays open with the
 * messages attached to the offending fields.
 */
export function extractNoteSubmission(payload: unknown): SubmissionResult {
	const values = stateOf(payload);
	const errors: Record<string, string> = {};

	const slackUserId = selectedUser(values);
	if (!slackUserId) errors[BLOCK.member] = 'Pick the member this note is about.';

	const body = stringField(values, BLOCK.body).trim();
	if (body === '') {
		errors[BLOCK.body] = 'Add some details.';
	} else if (body.length > MAX_BODY_LENGTH) {
		errors[BLOCK.body] = `Keep this under ${MAX_BODY_LENGTH} characters.`;
	}

	const kind = selectedKind(values);

	// Optional, but if something was typed it has to be a real permalink — the
	// field is explicitly "a link to a Slack message", the parsed channel/ts are
	// stored, and the URL goes out in a DM to a member.
	const rawLink = stringField(values, BLOCK.link).trim();
	let messageRef: SlackMessageRef | null = null;
	if (rawLink !== '') {
		messageRef = parseSlackMessageLink(rawLink);
		if (!messageRef) {
			errors[BLOCK.link] =
				'That doesn’t look like a Slack message link — use “Copy link” on the message.';
		}
	}

	// Deliberately unvalidated: empty means "use the configured Settings
	// template", which the caller resolves. See NoteSubmission.warningText.
	const warningText = stringField(values, BLOCK.warningText).trim();

	if (Object.keys(errors).length > 0) return { ok: false, errors };

	return {
		ok: true,
		submission: {
			slackUserId,
			kind,
			body,
			messageRef,
			warningText,
			sendDm: dmChecked(values) === true,
		},
	};
}

/** The invoking channel and entry point, recovered from `private_metadata`. */
export function readModalMetadata(payload: unknown): {
	channelId: string | null;
	source: NoteSource;
} {
	const raw = (payload as { view?: { private_metadata?: unknown } } | null)?.view?.private_metadata;
	if (typeof raw !== 'string' || raw === '') return { channelId: null, source: 'slash' };
	try {
		const parsed = JSON.parse(raw) as { channelId?: unknown; source?: unknown };
		return {
			channelId: typeof parsed.channelId === 'string' ? parsed.channelId : null,
			source: parsed.source === 'shortcut' ? 'shortcut' : 'slash',
		};
	} catch {
		return { channelId: null, source: 'slash' };
	}
}

/**
 * Pull a Slack user id out of a slash command's text, e.g. `<@U0123|alice>`.
 *
 * Requires "Escape channels, users, and links" to be enabled on the command;
 * without it Slack sends a bare `@alice` with no id to resolve, and we simply
 * open the modal unprefilled.
 */
export function parseCommandTarget(text: string): string | null {
	const match = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/i.exec(text ?? '');
	return match ? match[1]!.toUpperCase() : null;
}
