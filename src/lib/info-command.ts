// Admin-defined slash commands that post a canned blurb as the person who ran
// them — "sign up to phone bank here: #phone-bank #text-bank" and the like.
//
// Pure: name normalization, validation, and rendering, with no DB or Slack
// access, so every rule below is unit-testable. The storage lives in the
// `info_commands` table and the posting in api/slack/commands.
//
// Messages are stored raw with friendly `#channel-name` tokens and resolved to
// real `<#C…>` links at post time, via the shared tokenizer in
// channel-tokens.ts — the same one the welcome and warning DMs use, so there is
// one channel-link convention across everything this app sends. There are no
// `{{tokens}}`: a blurb has no per-invocation context to substitute.

import { extractChannelNames, resolveChannelLinks } from './channel-tokens.js';

/** Slack renders a section block's text up to 3000 characters; keeping the
 *  stored message inside that means a saved blurb can never be rejected at
 *  post time. */
export const INFO_MESSAGE_MAX_LENGTH = 3000;

/** Slack's own limit on a slash command, including the leading slash. */
export const INFO_COMMAND_MAX_LENGTH = 32;

/**
 * Commands this app already handles for something else. An admin who created
 * `/member-note` here would shadow the moderation modal with a blurb, which is
 * both surprising and hard to diagnose from the Slack side.
 */
export const RESERVED_COMMANDS = new Set(['/member-note', '/turfs', '/list-commands']);

/** Slack truncates a message's text past 40,000 characters. A /list-commands
 *  message stops short of that and the list continues in the next one, so no
 *  blurb is ever cut in half. */
export const COMMAND_LIST_MAX_LENGTH = 39_000;

const COMMAND_RE = /^\/[a-z0-9][a-z0-9_-]*$/;

/**
 * Canonical form: trimmed, lowercased, with exactly one leading slash.
 *
 * Applied on both save and lookup so `/Info-Phone`, `info-phone`, and
 * ` /info-phone ` all land on the same row — and so the value Slack posts
 * (always lowercase, always slash-prefixed) matches the stored key directly.
 */
export function normalizeCommandName(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === '') return '';
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export type CommandNameCheck = { ok: true; command: string } | { ok: false; error: string };

/** Validate a command name typed by an admin, returning the normalized form. */
export function validateCommandName(raw: string): CommandNameCheck {
	const command = normalizeCommandName(raw);

	if (command === '' || command === '/') {
		return { ok: false, error: 'Enter a command name, for example /info-phone.' };
	}
	if (command.length > INFO_COMMAND_MAX_LENGTH) {
		return {
			ok: false,
			error: `Slash commands can be at most ${INFO_COMMAND_MAX_LENGTH} characters, including the slash.`,
		};
	}
	if (!COMMAND_RE.test(command)) {
		return {
			ok: false,
			error:
				'Use lowercase letters, numbers, dashes, and underscores only — for example /info-phone.',
		};
	}
	if (RESERVED_COMMANDS.has(command)) {
		return { ok: false, error: `${command} is already used by this app for something else.` };
	}
	return { ok: true, command };
}

export type MessageCheck =
	{ ok: true; message: string; channelNames: string[] } | { ok: false; error: string };

/**
 * Validate the blurb. Channel names are returned rather than checked here —
 * confirming a channel exists needs the live Slack list, which is the API
 * route's job (see api/settings/info-commands).
 */
export function validateInfoMessage(raw: unknown): MessageCheck {
	if (typeof raw !== 'string') {
		return { ok: false, error: 'The message must be text.' };
	}
	const message = raw.trim();
	if (message === '') {
		// Unlike the DM templates, '' has no meaning here: there is no built-in
		// default to fall back to, and posting an empty message is not a thing
		// Slack will do.
		return { ok: false, error: 'Enter the message this command should post.' };
	}
	if (message.length > INFO_MESSAGE_MAX_LENGTH) {
		return {
			ok: false,
			error: `Keep the message under ${INFO_MESSAGE_MAX_LENGTH} characters.`,
		};
	}
	return { ok: true, message, channelNames: extractChannelNames(message) };
}

/**
 * Turn a stored message into what actually gets posted.
 *
 * Unknown channel names stay literal `#name` rather than being stripped — a
 * renamed or archived channel degrades the message instead of blanking part of
 * it, and the reader still has something to search for.
 */
export function renderInfoMessage(message: string, nameToId: ReadonlyMap<string, string>): string {
	return resolveChannelLinks(message, nameToId);
}

/**
 * The /list-commands reply: every info command with the message it would post,
 * rendered exactly as it would be posted (channel links and all), each blurb
 * quoted so it reads as "this is what goes out" rather than as the reply.
 *
 * Returns one or more messages, each within COMMAND_LIST_MAX_LENGTH, that
 * together list every command — split only between entries. Nearly always
 * one. `entries` is taken in the order given; the caller sorts.
 *
 * Nothing here points at /settings: moderators run this too, and cannot open it.
 */
export function renderCommandList(
	entries: readonly { command: string; message: string }[],
	nameToId: ReadonlyMap<string, string>,
): string[] {
	if (entries.length === 0) return ['No info commands have been set up yet.'];

	const messages: string[] = [];
	let current = entries.length === 1 ? '1 info command:' : `${entries.length} info commands:`;
	for (const { command, message } of entries) {
		// Slack's `>` quotes a single line, so a multi-line blurb needs it on
		// every line to stay inside one quote.
		const quoted = renderInfoMessage(message, nameToId)
			.split('\n')
			.map((line) => `>${line}`)
			.join('\n');
		const entry = `*${command}*\n${quoted}`;
		// +2 for the blank line entries are separated by. A lone entry always
		// fits — a blurb is capped at INFO_MESSAGE_MAX_LENGTH, far below this.
		if (current.length + 2 + entry.length > COMMAND_LIST_MAX_LENGTH) {
			messages.push(current);
			current = entry;
		} else {
			current += `\n\n${entry}`;
		}
	}
	messages.push(current);
	return messages;
}
