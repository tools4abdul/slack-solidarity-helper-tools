import { describe, expect, it } from 'vitest';

import { escapeMrkdwn, mrkdwnLink } from './slack-mrkdwn.js';

describe('escapeMrkdwn', () => {
	it('escapes the three characters Slack mrkdwn reserves', () => {
		expect(escapeMrkdwn('A & B <script> C')).toBe('A &amp; B &lt;script&gt; C');
	});
});

describe('mrkdwnLink', () => {
	it('builds a link Slack will render', () => {
		expect(mrkdwnLink('https://x.test/e/1', 'Picnic')).toBe('<https://x.test/e/1|Picnic>');
	});

	it('escapes both halves', () => {
		// An unescaped & in the query string is the classic broken Slack link.
		expect(mrkdwnLink('https://x.test/e?a=1&b=2', 'Meet & Greet')).toBe(
			'<https://x.test/e?a=1&amp;b=2|Meet &amp; Greet>',
		);
	});

	it('falls back to the bare label when there is no URL', () => {
		expect(mrkdwnLink(null, 'Meet & Greet')).toBe('Meet &amp; Greet');
	});
});
