import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';

const mockValidateSlackChannel = vi.hoisted(() => vi.fn());
const mockGetSlackChannels = vi.hoisted(() => vi.fn());

vi.mock('./settings-validation.js', () => ({ validateSlackChannel: mockValidateSlackChannel }));
vi.mock('./autocomplete-sources.js', () => ({ getSlackChannels: mockGetSlackChannels }));

import { APP_CONFIG_FIELDS, APP_CONFIG_FIELD_KEYS } from './app-config-fields.js';
import { MAX_TICKER_COLUMNS_PER_SECOND, MIN_TICKER_COLUMNS_PER_SECOND } from '../ticker-speed.js';

const ctx = { slack: {} as WebClient };
const run = (key: keyof typeof APP_CONFIG_FIELDS, value: unknown) =>
	APP_CONFIG_FIELDS[key](value, ctx);

beforeEach(() => {
	vi.clearAllMocks();
	mockValidateSlackChannel.mockResolvedValue({ ok: true, name: 'general' });
	mockGetSlackChannels.mockResolvedValue({
		items: [
			{ id: 'C1', name: 'general', isPrivate: false },
			{ id: 'C2', name: 'rules', isPrivate: false },
		],
	});
});

describe('the table', () => {
	it('covers every writable app-config field', () => {
		// The type system enforces this; asserted here too so the failure reads as
		// "you added a field without a validator" rather than a type error.
		expect(APP_CONFIG_FIELD_KEYS).toEqual(
			expect.arrayContaining([
				'slackTrackingChannelId',
				'slackGrowthReportChannelId',
				'slackMobilizeSyncChannelId',
				'slackTurfChannelId',
				'slackMemberNoteChannelId',
				'mobilizeContactName',
				'mobilizeContactEmail',
				'mobilizeContactPhone',
				'slackGrowthReportRankingAlpha',
				'vanTurfClaimTtlHours',
				'vanTurfMaxConcurrentClaims',
				'doorTickerColumnsPerSecond',
				'siteName',
				'countdownLabel',
				'countdownEndAt',
				'welcomeDmMessage',
				'warningDmMessage',
				'themeTokens',
			]),
		);
		expect(APP_CONFIG_FIELD_KEYS).toHaveLength(18);
	});
});

describe('slack channel fields', () => {
	it.each([
		'slackTrackingChannelId',
		'slackGrowthReportChannelId',
		'slackMobilizeSyncChannelId',
		'slackTurfChannelId',
		'slackMemberNoteChannelId',
	] as const)('%s accepts a validated channel id', async (key) => {
		expect(await run(key, 'C123')).toEqual({ ok: true, value: 'C123' });
	});

	it.each([undefined, 42, '', '   ', null])('rejects %p as a channel id', async (value) => {
		const result = await run('slackTrackingChannelId', value);
		expect(result).toMatchObject({ ok: false, status: 400 });
	});

	it('maps a transient lookup failure to 503 so the admin can retry', async () => {
		mockValidateSlackChannel.mockResolvedValue({
			ok: false,
			error: 'Slack channel list is temporarily unavailable.',
			transient: true,
		});
		expect(await run('slackTrackingChannelId', 'C123')).toMatchObject({ ok: false, status: 503 });
	});

	it('maps an unknown channel to 400', async () => {
		mockValidateSlackChannel.mockResolvedValue({
			ok: false,
			error: 'Not valid.',
			transient: false,
		});
		expect(await run('slackTrackingChannelId', 'C123')).toMatchObject({ ok: false, status: 400 });
	});
});

describe('contact fields', () => {
	it('trims and stores text', async () => {
		expect(await run('mobilizeContactName', '  Jordan  ')).toEqual({ ok: true, value: 'Jordan' });
	});

	// '' is meaningful: saveAppConfig reserves NULL for "leave as-is", so an
	// empty string is how the UI clears a field back to its env fallback.
	it('accepts an empty string as an explicit clear', async () => {
		expect(await run('mobilizeContactName', '')).toEqual({ ok: true, value: '' });
	});

	it('rejects over-length text', async () => {
		expect(await run('mobilizeContactName', 'x'.repeat(201))).toMatchObject({ ok: false });
	});

	it('rejects a non-string', async () => {
		expect(await run('mobilizeContactPhone', 5551234)).toMatchObject({ ok: false });
	});

	it.each(['organizer@example.org', 'a.b+tag@sub.example.co.uk'])(
		'accepts %s as a contact email',
		async (value) => {
			expect(await run('mobilizeContactEmail', value)).toEqual({ ok: true, value });
		},
	);

	it.each(['not-an-email', 'missing@domain', 'spaces in@example.org'])(
		'rejects %s as a contact email',
		async (value) => {
			expect(await run('mobilizeContactEmail', value)).toMatchObject({ ok: false, status: 400 });
		},
	);

	it('allows clearing the email', async () => {
		expect(await run('mobilizeContactEmail', '')).toEqual({ ok: true, value: '' });
	});
});

describe('numeric fields', () => {
	it.each([0, 0.7, 1])('accepts alpha %p', async (value) => {
		expect(await run('slackGrowthReportRankingAlpha', value)).toEqual({ ok: true, value });
	});

	it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null])(
		'rejects alpha %p',
		async (value) => {
			expect(await run('slackGrowthReportRankingAlpha', value)).toMatchObject({ ok: false });
		},
	);

	it('accepts a ticker rate inside the bounds', async () => {
		expect(await run('doorTickerColumnsPerSecond', MIN_TICKER_COLUMNS_PER_SECOND)).toMatchObject({
			ok: true,
		});
		expect(await run('doorTickerColumnsPerSecond', MAX_TICKER_COLUMNS_PER_SECOND)).toMatchObject({
			ok: true,
		});
	});

	it('rejects a ticker rate outside the bounds', async () => {
		expect(
			await run('doorTickerColumnsPerSecond', MAX_TICKER_COLUMNS_PER_SECOND + 1),
		).toMatchObject({ ok: false });
		expect(
			await run('doorTickerColumnsPerSecond', MIN_TICKER_COLUMNS_PER_SECOND - 1),
		).toMatchObject({ ok: false });
	});

	it('names the bounds in the error so the admin knows the range', async () => {
		const result = await run('doorTickerColumnsPerSecond', 9999);
		expect(result.ok === false && result.error).toContain(String(MAX_TICKER_COLUMNS_PER_SECOND));
	});
});

describe('countdown fields', () => {
	it('trims the label', async () => {
		expect(await run('countdownLabel', '  Election day  ')).toEqual({
			ok: true,
			value: 'Election day',
		});
	});

	it('rejects an over-length label', async () => {
		expect(await run('countdownLabel', 'x'.repeat(81))).toMatchObject({ ok: false });
	});

	it('re-serializes the end datetime to canonical ISO', async () => {
		expect(await run('countdownEndAt', '2026-11-03T12:00:00-05:00')).toEqual({
			ok: true,
			value: '2026-11-03T17:00:00.000Z',
		});
	});

	it('accepts an empty string to clear the countdown', async () => {
		expect(await run('countdownEndAt', '')).toEqual({ ok: true, value: '' });
	});

	it.each(['not a date', '2026-13-45', 42])('rejects %p as an end datetime', async (value) => {
		expect(await run('countdownEndAt', value)).toMatchObject({ ok: false, status: 400 });
	});
});

// Both DM templates share one builder; these cover the shared guard once and
// then the per-template difference.
describe('DM template fields', () => {
	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s stores the template trimmed',
		async (key) => {
			const message = key === 'warningDmMessage' ? '  Your {{nth}} warning.  ' : '  Welcome!  ';
			const result = await run(key, message);
			expect(result).toMatchObject({ ok: true, value: message.trim() });
		},
	);

	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s rejects an over-length template',
		async (key) => {
			expect(await run(key, 'x'.repeat(3001))).toMatchObject({ ok: false, status: 400 });
		},
	);

	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s accepts a #channel that exists',
		async (key) => {
			const message = key === 'warningDmMessage' ? '{{nth}} warning, see #rules' : 'see #rules';
			expect(await run(key, message)).toMatchObject({ ok: true });
		},
	);

	// A typo'd channel is invisible until the DM has already been sent.
	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s rejects an unknown #channel',
		async (key) => {
			const message = key === 'warningDmMessage' ? '{{nth}} warning, see #nope' : 'see #nope';
			const result = await run(key, message);
			expect(result).toMatchObject({ ok: false, status: 400 });
			expect(result.ok === false && result.error).toContain('#nope');
		},
	);

	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s returns 503 when the channel list is unavailable',
		async (key) => {
			mockGetSlackChannels.mockRejectedValue(new Error('slack down'));
			const message = key === 'warningDmMessage' ? '{{nth}} warning, see #rules' : 'see #rules';
			expect(await run(key, message)).toMatchObject({ ok: false, status: 503 });
		},
	);

	it.each(['welcomeDmMessage', 'warningDmMessage'] as const)(
		'%s skips the channel lookup entirely when no #channel is referenced',
		async (key) => {
			await run(key, key === 'warningDmMessage' ? 'Your {{nth}} warning.' : 'Welcome!');
			expect(mockGetSlackChannels).not.toHaveBeenCalled();
		},
	);

	it('lets the welcome template be cleared to the built-in default', async () => {
		expect(await run('welcomeDmMessage', '')).toEqual({ ok: true, value: '' });
	});

	// The one place the two templates differ.
	it('rejects a warning template missing {{nth}}', async () => {
		const result = await run('warningDmMessage', 'You have been warned.');
		expect(result).toMatchObject({ ok: false, status: 400 });
		expect(result.ok === false && result.error).toContain('{{nth}}');
	});

	it('rejects an unknown token in a warning template', async () => {
		expect(await run('warningDmMessage', '{{nth}} warning {{bogus}}')).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it('does not apply the {{nth}} rule to the welcome template', async () => {
		expect(await run('welcomeDmMessage', 'Welcome, no tokens here')).toMatchObject({ ok: true });
	});
});

describe('themeTokensField', () => {
	const run = (v: unknown) => APP_CONFIG_FIELDS.themeTokens(v, {} as never);

	it('accepts an object of valid overrides and canonicalises it', async () => {
		// Canonical form is the layered {brand, tokens} shape, and a legacy flat
		// blob is read into the tokens layer rather than rejected.
		const r = await run({ 'color-bg': { light: '#ABCDEF' } });
		expect(r).toEqual({
			ok: true,
			value: '{"brand":{},"tokens":{"color-bg":{"light":"#abcdef"}}}',
		});
	});

	it('accepts and canonicalises a brand-palette override', async () => {
		const r = await run({ brand: { primary: '#001122' }, tokens: {} });
		expect(r).toEqual({ ok: true, value: '{"brand":{"primary":"#001122"},"tokens":{}}' });
	});

	it('rejects an unknown brand colour by name', async () => {
		const r = await run({ brand: { chartreuse: '#7fff00' } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('brand.chartreuse');
	});

	it('accepts a JSON string', async () => {
		const r = await run('{"color-bg":{"dark":"#123456"}}');
		expect(r.ok).toBe(true);
	});

	it('treats an empty string as "no overrides"', async () => {
		expect(await run('')).toEqual({ ok: true, value: '{}' });
	});

	// The injection guard: nothing free-text can reach the emitted <style>.
	it('rejects a non-colour token and names it', async () => {
		const r = await run({ 'shadow-card': { light: '0 0 0 red' } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('shadow-card');
	});

	it('rejects a malformed colour and names it', async () => {
		const r = await run({ 'color-bg': { light: '#fff;}</style>' } });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('color-bg.light');
	});

	it('rejects unparseable JSON and non-objects', async () => {
		expect((await run('{not json')).ok).toBe(false);
		expect((await run(['#fff'])).ok).toBe(false);
		expect((await run(42)).ok).toBe(false);
	});
});
