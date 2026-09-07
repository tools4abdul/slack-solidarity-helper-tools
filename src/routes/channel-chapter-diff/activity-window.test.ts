import { describe, it, expect } from 'vitest';
import {
	afterToggle,
	afterDaysChange,
	appliedDays,
	DEFAULT_DAYS,
	MIN_DAYS,
	MAX_DAYS,
	type ActivityWindow,
} from './activity-window.js';

const state = (on: boolean, days: number | null): ActivityWindow => ({ on, days });

describe('activity window control', () => {
	describe('appliedDays', () => {
		it('sends the window when the filter is on', () => {
			expect(appliedDays(state(true, 30))).toBe(30);
		});

		it('sends nothing when the filter is off', () => {
			expect(appliedDays(state(false, 30))).toBeNull();
		});

		// The bug this whole module exists to prevent: a ticked checkbox over an
		// empty box used to send no window, so the page ran an unfiltered
		// comparison and showed every name with the filter visibly on.
		it('sends nothing when the box is empty, and the state says the filter is off', () => {
			const cleared = afterDaysChange(state(true, null));

			expect(cleared.on).toBe(false);
			expect(appliedDays(cleared)).toBeNull();
		});
	});

	describe('afterDaysChange', () => {
		it('switches the filter off when the box is cleared', () => {
			expect(afterDaysChange(state(true, null))).toEqual({ on: false, days: null });
		});

		it('leaves an off filter off', () => {
			expect(afterDaysChange(state(false, null))).toEqual({ on: false, days: null });
		});

		it.each([
			[0, MIN_DAYS],
			[-5, MIN_DAYS],
			[400, MAX_DAYS],
			[30.4, 30],
			[30.6, 31],
		])('clamps %s to %s rather than sending a value the server rejects', (typed, expected) => {
			expect(afterDaysChange(state(true, typed))).toEqual({ on: true, days: expected });
		});

		it('leaves an in-range whole number alone', () => {
			expect(afterDaysChange(state(true, 90))).toEqual({ on: true, days: 90 });
		});
	});

	describe('afterToggle', () => {
		it('restores the default when switched on over an empty box', () => {
			expect(afterToggle(state(true, null))).toEqual({ on: true, days: DEFAULT_DAYS });
		});

		it('keeps the existing window when switched on over a filled box', () => {
			expect(afterToggle(state(true, 7))).toEqual({ on: true, days: 7 });
		});

		it('leaves the window alone when switched off', () => {
			expect(afterToggle(state(false, 7))).toEqual({ on: false, days: 7 });
		});
	});

	// Whatever the sequence, a state that reports a window must be switched on.
	it('never applies a window while reporting the filter as off', () => {
		const inputs: ActivityWindow[] = [
			state(true, null),
			state(false, null),
			state(true, 0),
			state(true, 1000),
			state(false, 30),
			state(true, 30),
		];
		for (const start of inputs) {
			for (const next of [afterToggle(start), afterDaysChange(start)]) {
				if (appliedDays(next) !== null) expect(next.on).toBe(true);
			}
		}
	});
});
