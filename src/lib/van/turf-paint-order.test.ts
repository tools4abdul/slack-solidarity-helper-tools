import { describe, expect, it } from 'vitest';
import { paintOrder } from './turf-paint-order.js';

/** A square hull `side` degrees across, its south-west corner at (lat, lng). */
const square = (id: string, lat: number, lng: number, side: number) => ({
	id,
	hull: [
		{ lat, lng },
		{ lat, lng: lng + side },
		{ lat: lat + side, lng: lng + side },
		{ lat: lat + side, lng },
	],
});

const ids = (turfs: { id: string }[]) => turfs.map((t) => t.id);

describe('paintOrder', () => {
	it('paints a small turf after the large one that contains it, so it stays on top', () => {
		const outer = square('outer', 40, -75, 0.01);
		const inner = square('inner', 40.004, -74.996, 0.002);
		expect(ids(paintOrder([inner, outer]))).toEqual(['outer', 'inner']);
	});

	it('orders by area, not by input position', () => {
		const turfs = [
			square('mid', 40, -75, 0.005),
			square('small', 40, -75, 0.001),
			square('large', 40, -75, 0.01),
		];
		expect(ids(paintOrder(turfs))).toEqual(['large', 'mid', 'small']);
	});

	it('paints a degenerate hull, which draws as a pin, above every polygon', () => {
		const pin = { id: 'pin', hull: [{ lat: 40, lng: -75 }] };
		const tiny = square('tiny', 40, -75, 0.0001);
		const big = square('big', 40, -75, 0.01);
		expect(ids(paintOrder([pin, big, tiny]))).toEqual(['big', 'tiny', 'pin']);
	});

	it('keeps input order between equal areas', () => {
		const turfs = ['a', 'b', 'c'].map((id) => square(id, 40, -75, 0.003));
		expect(ids(paintOrder(turfs))).toEqual(['a', 'b', 'c']);
	});

	it('leaves its input untouched', () => {
		const turfs = [square('small', 40, -75, 0.001), square('large', 40, -75, 0.01)];
		paintOrder(turfs);
		expect(ids(turfs)).toEqual(['small', 'large']);
	});
});
