import { describe, it, expect } from 'vitest';
import { focusZoom, isBoxVisible, type PixelBox } from './map-focus.js';

const WIDTH = 800;
const HEIGHT = 600;

const box = (over: Partial<PixelBox> = {}): PixelBox => ({
	minX: 100,
	minY: 100,
	maxX: 200,
	maxY: 200,
	...over,
});

describe('isBoxVisible', () => {
	it('is true for a box well inside the viewport', () => {
		expect(isBoxVisible(box(), WIDTH, HEIGHT)).toBe(true);
	});

	it.each([
		['off the left', { minX: -10, maxX: 50 }],
		['off the top', { minY: -10, maxY: 50 }],
		['off the right', { minX: 780, maxX: 900 }],
		['off the bottom', { minY: 560, maxY: 700 }],
	])('is false when the box runs %s', (_label, over) => {
		expect(isBoxVisible(box(over), WIDTH, HEIGHT)).toBe(false);
	});

	// The case the margin exists for: a hull with a couple of pixels showing is
	// one you cannot read, and calling it visible makes selecting it look like
	// it did nothing.
	it('treats a box touching the edge as not visible once a margin is set', () => {
		const touching = box({ minX: 4, maxX: 100 });
		expect(isBoxVisible(touching, WIDTH, HEIGHT)).toBe(true);
		expect(isBoxVisible(touching, WIDTH, HEIGHT, 24)).toBe(false);
	});

	// Not a special case in the code, but the answer the caller depends on: a
	// turf too big for the screen is reported invisible, which is what sends it
	// down the zoom-out path.
	it('is false for a box larger than the viewport', () => {
		expect(isBoxVisible(box({ minX: -50, minY: -50, maxX: 900, maxY: 700 }), WIDTH, HEIGHT)).toBe(
			false,
		);
	});

	it('is true for a box exactly filling the viewport with no margin', () => {
		expect(isBoxVisible(box({ minX: 0, minY: 0, maxX: WIDTH, maxY: HEIGHT }), WIDTH, HEIGHT)).toBe(
			true,
		);
	});
});

describe('focusZoom', () => {
	// The whole point: the volunteer picked their zoom, and "show me where this
	// is" must not become "zoom to the end of the street".
	it('keeps the current zoom when the turf already fits', () => {
		expect(focusZoom(12, 16)).toBe(12);
	});

	it('backs off only as far as framing the turf needs', () => {
		expect(focusZoom(16, 12)).toBe(12);
	});

	it('is a no-op when they are equal', () => {
		expect(focusZoom(14, 14)).toBe(14);
	});
});
