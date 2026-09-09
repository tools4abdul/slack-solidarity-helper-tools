import { describe, it, expect } from 'vitest';
import { formatRelative, relativeSince } from './format-relative.js';

describe('formatRelative', () => {
	it('returns "just now" for any delta under one minute', () => {
		expect(formatRelative(0)).toBe('just now');
		expect(formatRelative(1)).toBe('just now');
		expect(formatRelative(59_000)).toBe('just now');
		expect(formatRelative(59_999)).toBe('just now');
	});

	it('returns "1m ago" exactly at the minute boundary', () => {
		expect(formatRelative(60_000)).toBe('1m ago');
	});

	it('returns minutes for deltas inside the hour window', () => {
		expect(formatRelative(2 * 60_000)).toBe('2m ago');
		expect(formatRelative(15 * 60_000)).toBe('15m ago');
		expect(formatRelative(59 * 60_000)).toBe('59m ago');
		// Just below the hour boundary still reads as minutes.
		expect(formatRelative(59 * 60_000 + 59_999)).toBe('59m ago');
	});

	it('returns "1h ago" exactly at the hour boundary', () => {
		expect(formatRelative(60 * 60_000)).toBe('1h ago');
	});

	it('returns hours for deltas inside the day window', () => {
		expect(formatRelative(2 * 60 * 60_000)).toBe('2h ago');
		expect(formatRelative(23 * 60 * 60_000)).toBe('23h ago');
		// Just below the day boundary still reads as hours.
		expect(formatRelative(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h ago');
	});

	it('returns "1 day ago" (singular) at the day boundary', () => {
		expect(formatRelative(24 * 60 * 60_000)).toBe('1 day ago');
	});

	it('returns "N days ago" (plural) past 48 hours', () => {
		expect(formatRelative(2 * 24 * 60 * 60_000)).toBe('2 days ago');
		expect(formatRelative(7 * 24 * 60 * 60_000)).toBe('7 days ago');
	});

	it('clamps negative deltas (clock skew) to "just now" rather than rendering future tense', () => {
		expect(formatRelative(-1)).toBe('just now');
		expect(formatRelative(-60_000)).toBe('just now');
	});
});

describe('relativeSince', () => {
	const NOW = new Date('2026-09-09T12:00:00.000Z');

	it('measures against the supplied now, not the wall clock', () => {
		// The property the turf-page hydration mismatch came down to: the same
		// inputs must give the same output, whenever and wherever it is called.
		expect(relativeSince('2026-09-09T11:30:00.000Z', NOW)).toBe('30m ago');
		expect(relativeSince('2026-09-09T09:00:00.000Z', NOW)).toBe('3h ago');
		expect(relativeSince('2026-09-07T12:00:00.000Z', NOW)).toBe('2 days ago');
	});

	it('is deterministic across calls, so SSR and hydration agree', () => {
		const first = relativeSince('2026-09-09T11:00:00.000Z', NOW);
		const second = relativeSince('2026-09-09T11:00:00.000Z', NOW);
		expect(first).toBe(second);
		expect(first).toBe('1h ago');
	});

	it('returns an empty string for an unparseable timestamp rather than NaN', () => {
		expect(relativeSince('not a date', NOW)).toBe('');
		expect(relativeSince('', NOW)).toBe('');
	});

	it('clamps a future timestamp to "just now" via formatRelative', () => {
		expect(relativeSince('2026-09-09T12:30:00.000Z', NOW)).toBe('just now');
	});
});
