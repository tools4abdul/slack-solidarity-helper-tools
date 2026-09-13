import { describe, it, expect } from 'vitest';
import {
	CAMPAIGN_TIME_ZONE,
	campaignDayKey,
	campaignDayLabel,
	campaignTimeLabel,
	campaignWeekStart,
} from './campaign-time.js';

describe('campaignDayKey', () => {
	it('returns an ISO-ordered key', () => {
		expect(campaignDayKey('2026-08-24T18:00:00.000Z')).toBe('2026-08-24');
	});

	// The whole reason this module exists: 9pm ET on Saturday is Sunday in UTC,
	// and those are exactly the hours a canvass runs. Bucketing on the raw ISO
	// date would file a Saturday evening's turf under Sunday.
	it('files a late-evening event under the campaign-local day', () => {
		// 2026-08-23T01:30Z is 21:30 on the 22nd in Detroit (EDT, UTC-4).
		expect(campaignDayKey('2026-08-23T01:30:00.000Z')).toBe('2026-08-22');
	});

	it('sorts lexicographically, which is what the grouping relies on', () => {
		const keys = ['2026-08-24T12:00:00Z', '2026-01-05T12:00:00Z', '2026-12-31T12:00:00Z'].map(
			campaignDayKey,
		);
		expect([...keys].sort()).toEqual(['2026-01-05', '2026-08-24', '2026-12-31']);
	});

	// EST is UTC-5, EDT is UTC-4 — a fixed offset would get one of these wrong.
	it('handles both sides of a daylight-saving change', () => {
		expect(campaignDayKey('2026-01-15T04:30:00.000Z')).toBe('2026-01-14');
		expect(campaignDayKey('2026-07-15T03:30:00.000Z')).toBe('2026-07-14');
	});

	it('returns an empty key for an unparseable timestamp rather than throwing', () => {
		expect(campaignDayKey('not a date')).toBe('');
	});
});

describe('campaignDayLabel', () => {
	it('reads as a day someone would say out loud', () => {
		expect(campaignDayLabel('2026-08-22T14:00:00.000Z')).toBe('Saturday, Aug 22');
	});

	it('agrees with the day key', () => {
		const iso = '2026-08-23T01:30:00.000Z';
		expect(campaignDayKey(iso)).toBe('2026-08-22');
		expect(campaignDayLabel(iso)).toContain('Aug 22');
	});

	it('degrades rather than throwing', () => {
		expect(campaignDayLabel('nonsense')).toBe('Unknown date');
	});
});

describe('campaignTimeLabel', () => {
	it('renders campaign-local time', () => {
		// 13:10Z is 9:10 AM in Detroit during EDT.
		expect(campaignTimeLabel('2026-08-24T13:10:00.000Z')).toBe('9:10 AM');
	});

	it('shifts with daylight saving', () => {
		// Same UTC clock time, opposite sides of the DST boundary.
		expect(campaignTimeLabel('2026-07-15T17:00:00.000Z')).toBe('1:00 PM');
		expect(campaignTimeLabel('2026-01-15T17:00:00.000Z')).toBe('12:00 PM');
	});

	it('degrades rather than throwing', () => {
		expect(campaignTimeLabel('nonsense')).toBe('');
	});
});

describe('campaignWeekStart', () => {
	it('returns the Monday of the campaign-local week', () => {
		// Thursday 2026-09-10 → Monday 2026-09-07.
		expect(campaignWeekStart(new Date('2026-09-10T18:00:00.000Z')).toISOString()).toBe(
			'2026-09-07T00:00:00.000Z',
		);
	});

	it('still says last Monday late on a Sunday evening, when UTC has rolled over', () => {
		// 01:30Z Monday is 21:30 Sunday in Detroit. The trap this function exists
		// for: a UTC week boundary would jump the board a week ahead into an
		// empty window while the Slack board still showed the real one.
		expect(campaignWeekStart(new Date('2026-09-14T01:30:00.000Z')).toISOString()).toBe(
			'2026-09-07T00:00:00.000Z',
		);
	});

	it('treats Monday itself as the start of its own week', () => {
		expect(campaignWeekStart(new Date('2026-09-07T14:00:00.000Z')).toISOString()).toBe(
			'2026-09-07T00:00:00.000Z',
		);
	});
});

describe('CAMPAIGN_TIME_ZONE', () => {
	// Pinned so a change is a deliberate edit rather than a drifting default —
	// van/doors-leaderboard.ts and doors-projection.ts assume the same one.
	it('is the campaign clock the canvassing modules already assume', () => {
		expect(CAMPAIGN_TIME_ZONE).toBe('America/Detroit');
	});
});
