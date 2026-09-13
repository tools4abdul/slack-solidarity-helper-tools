import { describe, it, expect } from 'vitest';
import {
	normalizeCommandName,
	validateCommandName,
	validateInfoMessage,
	renderInfoMessage,
	renderCommandList,
	INFO_MESSAGE_MAX_LENGTH,
	INFO_COMMAND_MAX_LENGTH,
	COMMAND_LIST_MAX_LENGTH,
} from './info-command.js';

describe('normalizeCommandName', () => {
	it('adds the leading slash', () => {
		expect(normalizeCommandName('info-phone')).toBe('/info-phone');
	});

	it('lowercases and trims', () => {
		expect(normalizeCommandName('  /Info-Phone  ')).toBe('/info-phone');
	});

	it('leaves an already-normal name alone', () => {
		expect(normalizeCommandName('/info-phone')).toBe('/info-phone');
	});

	it('returns empty for blank input rather than a bare slash', () => {
		expect(normalizeCommandName('   ')).toBe('');
	});
});

describe('validateCommandName', () => {
	it('accepts a normal command and returns the normalized form', () => {
		expect(validateCommandName('Info-Phone')).toEqual({ ok: true, command: '/info-phone' });
	});

	it('accepts digits and underscores', () => {
		expect(validateCommandName('/info_phone2')).toEqual({ ok: true, command: '/info_phone2' });
	});

	it('rejects an empty name', () => {
		expect(validateCommandName('  ')).toMatchObject({ ok: false });
	});

	it('rejects a bare slash', () => {
		expect(validateCommandName('/')).toMatchObject({ ok: false });
	});

	it('rejects spaces inside the name', () => {
		expect(validateCommandName('/info phone')).toMatchObject({ ok: false });
	});

	it('rejects a name that does not start with a letter or digit', () => {
		expect(validateCommandName('/-info')).toMatchObject({ ok: false });
	});

	it('rejects a name longer than Slack allows', () => {
		const tooLong = '/' + 'a'.repeat(INFO_COMMAND_MAX_LENGTH);
		expect(validateCommandName(tooLong)).toMatchObject({ ok: false });
	});

	it('accepts a name exactly at the limit', () => {
		const atLimit = '/' + 'a'.repeat(INFO_COMMAND_MAX_LENGTH - 1);
		expect(validateCommandName(atLimit)).toEqual({ ok: true, command: atLimit });
	});

	it('refuses to shadow a command the app already handles', () => {
		// Creating /member-note here would replace the moderation modal with a
		// blurb, which is near-impossible to diagnose from the Slack side.
		const result = validateCommandName('/member-note');
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.error).toContain('already used');
	});

	it('catches a reserved name written in mixed case', () => {
		expect(validateCommandName('/Member-Note')).toMatchObject({ ok: false });
	});

	it('refuses /list-commands, which the app answers itself', () => {
		expect(validateCommandName('/list-commands')).toMatchObject({ ok: false });
	});
});

describe('validateInfoMessage', () => {
	it('accepts a message and reports its channel references', () => {
		const result = validateInfoMessage('Sign up here: #phone-bank #text-bank');
		expect(result).toMatchObject({ ok: true });
		if (result.ok) expect(result.channelNames).toEqual(['phone-bank', 'text-bank']);
	});

	it('trims the stored message', () => {
		const result = validateInfoMessage('  hello  ');
		if (!result.ok) throw new Error('expected ok');
		expect(result.message).toBe('hello');
	});

	it('rejects a blank message', () => {
		// There is no built-in default to fall back to, unlike the DM templates.
		expect(validateInfoMessage('   ')).toMatchObject({ ok: false });
	});

	it('rejects a non-string', () => {
		expect(validateInfoMessage(42)).toMatchObject({ ok: false });
	});

	it('rejects a message over the Slack section-block limit', () => {
		expect(validateInfoMessage('a'.repeat(INFO_MESSAGE_MAX_LENGTH + 1))).toMatchObject({
			ok: false,
		});
	});

	it('reports no channel names when there are none', () => {
		const result = validateInfoMessage('Just some text.');
		if (!result.ok) throw new Error('expected ok');
		expect(result.channelNames).toEqual([]);
	});
});

describe('renderInfoMessage', () => {
	const channels = new Map([
		['phone-bank', 'C_PHONE'],
		['text-bank', 'C_TEXT'],
	]);

	it('resolves known channel names to links', () => {
		expect(renderInfoMessage('Sign up: #phone-bank and #text-bank', channels)).toBe(
			'Sign up: <#C_PHONE> and <#C_TEXT>',
		);
	});

	it('leaves unknown channel names literal', () => {
		// A renamed or archived channel should degrade the message, not blank it.
		expect(renderInfoMessage('Try #no-such-channel', channels)).toBe('Try #no-such-channel');
	});

	it('leaves an already-resolved link alone', () => {
		expect(renderInfoMessage('Go to <#C_PHONE>', channels)).toBe('Go to <#C_PHONE>');
	});

	it('is case-insensitive on channel names', () => {
		expect(renderInfoMessage('#Phone-Bank', channels)).toBe('<#C_PHONE>');
	});

	it('passes text through untouched when there is nothing to resolve', () => {
		expect(renderInfoMessage('No channels here.', channels)).toBe('No channels here.');
	});
});

describe('renderCommandList', () => {
	const channels = new Map([['phone-bank', 'C_PHONE']]);

	it('lists each command with its message quoted beneath it', () => {
		const messages = renderCommandList(
			[
				{ command: '/info-canvass', message: 'Canvass info' },
				{ command: '/info-phone', message: 'Phone info' },
			],
			channels,
		);
		expect(messages).toEqual([
			'2 info commands:\n\n*/info-canvass*\n>Canvass info\n\n*/info-phone*\n>Phone info',
		]);
	});

	it('uses the singular for one command', () => {
		const [text] = renderCommandList([{ command: '/a', message: 'x' }], channels);
		expect(text!.startsWith('1 info command:')).toBe(true);
	});

	it('shows messages as they would be posted, with channel links resolved', () => {
		const [text] = renderCommandList(
			[{ command: '/info-phone', message: 'Sign up: #phone-bank' }],
			channels,
		);
		expect(text).toContain('>Sign up: <#C_PHONE>');
	});

	it('quotes every line of a multi-line message', () => {
		// `>` only quotes one line; an unprefixed second line would fall out of
		// the quote and read as part of the reply.
		const [text] = renderCommandList(
			[{ command: '/info-phone', message: 'Line one\nLine two' }],
			channels,
		);
		expect(text).toContain('>Line one\n>Line two');
	});

	// Moderators run this too, and cannot open /settings.
	it('says so when there are no commands, without pointing at settings', () => {
		const messages = renderCommandList([], channels);
		expect(messages).toEqual(['No info commands have been set up yet.']);
	});

	describe('a list too long for one Slack message', () => {
		const entries = Array.from({ length: 30 }, (_, i) => ({
			command: `/cmd-${String(i).padStart(2, '0')}`,
			message: `${i}`.padEnd(INFO_MESSAGE_MAX_LENGTH, 'x'),
		}));
		const messages = renderCommandList(entries, channels);

		it('splits into several messages, each within the limit', () => {
			expect(messages.length).toBeGreaterThan(1);
			for (const m of messages) expect(m.length).toBeLessThanOrEqual(COMMAND_LIST_MAX_LENGTH);
		});

		it('lists every command exactly once, in order, across the messages', () => {
			const listed = messages.join('\n\n').match(/^\*\/cmd-\d+\*$/gm);
			expect(listed).toEqual(entries.map((e) => `*${e.command}*`));
		});

		it('splits only between entries, never through a blurb', () => {
			for (const m of messages.slice(1)) expect(m.startsWith('*/cmd-')).toBe(true);
			for (const e of entries) {
				expect(messages.some((m) => m.includes(`*${e.command}*\n>${e.message}`))).toBe(true);
			}
		});

		it('puts the count only at the top of the first message', () => {
			expect(messages[0]!.startsWith('30 info commands:')).toBe(true);
			expect(messages.slice(1).some((m) => m.includes('info commands:'))).toBe(false);
		});
	});
});
