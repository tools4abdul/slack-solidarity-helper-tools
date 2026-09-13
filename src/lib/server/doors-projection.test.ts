import { describe, it, expect } from 'vitest';
import {
	projectDoorsAtDeadline,
	knockableMsBetween,
	PROJECTION_WINDOW_DAYS,
	KNOCK_DAY_MS,
	type DoorsDayTotal,
} from './doors-projection.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// 2026-07-09T12:00Z = 8:00 AM EDT — the start of a canvassing day, so
// whole-DAY offsets from NOW are whole 13-hour canvassing days.
const NOW = Date.UTC(2026, 6, 9, 12);

function days(totals: number[]): DoorsDayTotal[] {
	return totals.map((total, i) => ({
		date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
		total,
	}));
}

describe('knockableMsBetween', () => {
	it('counts a full 8am–9pm canvassing day as 13 hours', () => {
		// 8:00 AM EDT → 9:00 PM EDT the same day.
		expect(knockableMsBetween(NOW, NOW + 13 * HOUR)).toBe(13 * HOUR);
		expect(KNOCK_DAY_MS).toBe(13 * HOUR);
	});

	it('starts counting mid-window from the current instant', () => {
		// Noon EDT → 9 PM EDT = 9 knockable hours.
		expect(knockableMsBetween(NOW + 4 * HOUR, NOW + 13 * HOUR)).toBe(9 * HOUR);
	});

	it('skips night hours entirely', () => {
		// 10 PM EDT → 9 AM EDT next day: only 8–9 AM counts.
		expect(knockableMsBetween(NOW + 14 * HOUR, NOW + 25 * HOUR)).toBe(1 * HOUR);
		// 9:30 PM → 7:30 AM: nothing.
		expect(knockableMsBetween(NOW + 13.5 * HOUR, NOW + 23.5 * HOUR)).toBe(0);
	});

	it('sums windows across multiple days', () => {
		// 8 AM day 1 → 9 PM day 3 = 3 full canvassing days.
		expect(knockableMsBetween(NOW, NOW + 2 * DAY + 13 * HOUR)).toBe(39 * HOUR);
	});
});

describe('projectDoorsAtDeadline', () => {
	it('extrapolates the pace over remaining canvassing days, not wall-clock days', () => {
		// 100/day pace over 7 days. Deadline 9 PM tomorrow = 2 canvassing days
		// away (13h today + 13h tomorrow) even though it's 37 wall-clock hours.
		// The projection is the ADDITIONAL doors only (2 days × 100), not the
		// running total.
		const week = days([100, 100, 100, 100, 100, 100, 100]);
		expect(projectDoorsAtDeadline(week, NOW + DAY + 13 * HOUR, NOW)).toBe(200);
		// Overnight hours add nothing: 9 PM today vs 8 AM tomorrow.
		expect(projectDoorsAtDeadline(week, NOW + 13 * HOUR, NOW)).toBe(100);
		expect(projectDoorsAtDeadline(week, NOW + DAY, NOW)).toBe(100);
	});

	it('counts a partial canvassing day fractionally', () => {
		// Deadline 2:30 PM today: 6.5 of 13 knockable hours → half a day's pace.
		const week = days([100, 100, 100, 100, 100, 100, 100]);
		expect(projectDoorsAtDeadline(week, NOW + 6.5 * HOUR, NOW)).toBe(50);
	});

	it('uses only the last PROJECTION_WINDOW_DAYS dates for the pace', () => {
		// 10 days: first three at 1000/day (old surge), last seven at 100/day.
		// The surge days fall outside the pace window, so pace is 100/day; the
		// projection is 100 × 1 remaining day. Doors already knocked (including
		// the surge) are NOT part of the projection.
		const totals = [1000, 1000, 1000, 100, 100, 100, 100, 100, 100, 100];
		const result = projectDoorsAtDeadline(days(totals), NOW + 1 * DAY, NOW);
		expect(result).toBe(100);
		expect(totals.length).toBeGreaterThan(PROJECTION_WINDOW_DAYS);
	});

	it('averages over however many days exist when fewer than the window', () => {
		// Two days at 80 and 120 → pace 100/day, 3 days left.
		expect(projectDoorsAtDeadline(days([80, 120]), NOW + 3 * DAY, NOW)).toBe(300);
	});

	it('counts zero-door days against the pace', () => {
		// [100, 0] → pace 50/day; 2 canvassing days left → 100 additional doors.
		expect(projectDoorsAtDeadline(days([100, 0]), NOW + 2 * DAY, NOW)).toBe(100);
	});

	it('returns null with no data, a passed deadline, or an invalid deadline', () => {
		expect(projectDoorsAtDeadline([], NOW + DAY, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NOW, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NOW - DAY, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NaN, NOW)).toBeNull();
	});
});
