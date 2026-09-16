import { describe, expect, it } from 'vitest';
import { swipePansMap, wheelZoomDelta, wheelZoomsMap } from './turf-gestures.js';

describe('wheelZoomsMap', () => {
	it('zooms on a plain wheel when the map is a panel beside the list', () => {
		expect(wheelZoomsMap({ narrow: false, ctrlKey: false, metaKey: false })).toBe(true);
	});

	it('leaves a plain wheel to the page at the full-bleed breakpoint', () => {
		expect(wheelZoomsMap({ narrow: true, ctrlKey: false, metaKey: false })).toBe(false);
	});

	it.each([
		['ctrl', { ctrlKey: true, metaKey: false }],
		['cmd', { ctrlKey: false, metaKey: true }],
	])('zooms on %s + wheel even when narrow — a trackpad pinch arrives this way', (_, mods) => {
		expect(wheelZoomsMap({ narrow: true, ...mods })).toBe(true);
	});
});

describe('swipePansMap', () => {
	it.each(['touch', 'pen'])('leaves a %s swipe to the page when narrow', (pointerType) => {
		expect(swipePansMap({ narrow: true, pointerType })).toBe(false);
	});

	it('keeps panning with a mouse when narrow: a mouse drag is never a scroll', () => {
		expect(swipePansMap({ narrow: true, pointerType: 'mouse' })).toBe(true);
	});

	it.each(['touch', 'pen', 'mouse'])('pans on a %s drag above the breakpoint', (pointerType) => {
		expect(swipePansMap({ narrow: false, pointerType })).toBe(true);
	});
});

describe('wheelZoomDelta', () => {
	const px = (deltaY: number) => ({ deltaY, deltaMode: 0, height: 520 });

	it('turns one mouse notch into exactly one level, zooming in on a negative delta', () => {
		expect(wheelZoomDelta(px(-120))).toBe(1);
		expect(wheelZoomDelta(px(120))).toBe(-1);
	});

	it("keeps a trackpad's small deltas fractional — the reason zoom tracks the fingers", () => {
		expect(wheelZoomDelta(px(-6))).toBeCloseTo(0.05, 10);
		expect(wheelZoomDelta(px(-1))).toBeCloseTo(1 / 120, 10);
	});

	it('reads a line-mode delta as lines: three of them are one notch', () => {
		expect(wheelZoomDelta({ deltaY: -3, deltaMode: 1, height: 520 })).toBe(1);
	});

	it('reads a page-mode delta against the viewport height', () => {
		expect(wheelZoomDelta({ deltaY: -1, deltaMode: 2, height: 240 })).toBe(2);
	});

	it('caps a single event at two levels, whatever the device reports', () => {
		expect(wheelZoomDelta(px(-100000))).toBe(2);
		expect(wheelZoomDelta(px(100000))).toBe(-2);
	});

	it('treats a non-finite delta as no movement rather than NaN zoom', () => {
		expect(wheelZoomDelta(px(Number.NaN))).toBe(0);
	});
});
