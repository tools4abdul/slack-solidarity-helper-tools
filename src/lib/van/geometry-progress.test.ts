import { describe, it, expect } from 'vitest';
import {
	geometryProgressLabel,
	percentShaped,
	unshapedForever,
	type GeometryProgress,
} from './geometry-progress.js';

const progress = (over: Partial<GeometryProgress> = {}): GeometryProgress => ({
	eligible: 100,
	shaped: 40,
	centroidOnly: 0,
	pending: 60,
	failed: 0,
	...over,
});

describe('percentShaped', () => {
	it('floors, so it only reads 100% when every turf really has a shape', () => {
		expect(percentShaped(progress({ shaped: 99, pending: 1 }))).toBe(99);
		expect(percentShaped(progress({ shaped: 999, eligible: 1000, pending: 1 }))).toBe(99);
		expect(percentShaped(progress({ shaped: 100, pending: 0 }))).toBe(100);
	});

	it('is zero rather than NaN when nothing is eligible', () => {
		expect(percentShaped(progress({ eligible: 0, shaped: 0, pending: 0 }))).toBe(0);
	});
});

describe('unshapedForever', () => {
	it('counts turf that nothing is going to draw', () => {
		// 100 eligible, 40 shaped, 10 pins, 20 queued, 5 failed → 25 unaccounted.
		expect(
			unshapedForever(progress({ shaped: 40, centroidOnly: 10, pending: 20, failed: 5 })),
		).toBe(25);
	});

	it('never goes negative when the counts overlap', () => {
		expect(unshapedForever(progress({ eligible: 1, shaped: 1, centroidOnly: 1, pending: 1 }))).toBe(
			0,
		);
	});
});

describe('geometryProgressLabel', () => {
	it('leads with how many turfs have a shape', () => {
		expect(
			geometryProgressLabel(progress({ eligible: 2188, shaped: 1842, pending: 346 })),
		).toContain('1,842 of 2,188 turfs mapped as shapes');
	});

	it('says the rest are coming while work is queued', () => {
		expect(geometryProgressLabel(progress())).toContain('60 still drawing');
		expect(geometryProgressLabel(progress())).toContain('fill in as the sync runs');
	});

	it('stops promising more once the queue is empty', () => {
		const done = geometryProgressLabel(progress({ shaped: 100, pending: 0 }));
		expect(done).toBe('100 of 100 turfs mapped as shapes.');
		expect(done).not.toContain('fill in');
	});

	it('names pins and failures only when there are some', () => {
		const clean = geometryProgressLabel(progress({ shaped: 100, pending: 0 }));
		expect(clean).not.toContain('too small');
		expect(clean).not.toContain('failed');

		const messy = geometryProgressLabel(
			progress({ eligible: 100, shaped: 80, centroidOnly: 12, pending: 0, failed: 8 }),
		);
		expect(messy).toContain('12 too small to outline');
		expect(messy).toContain('8 failed');
	});

	it('has something to say when there is no turf at all', () => {
		expect(geometryProgressLabel(progress({ eligible: 0, shaped: 0, pending: 0 }))).toBe(
			'No turf is waiting for a shape.',
		);
	});
});
