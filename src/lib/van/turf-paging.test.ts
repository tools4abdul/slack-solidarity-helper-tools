import { describe, it, expect } from 'vitest';
import {
	parseBounds,
	selectNearest,
	withinBounds,
	TURFS_PER_PAYLOAD,
	type Locatable,
} from './turf-paging.js';

function turf(id: number, name: string, lat: number | null, lng: number | null): Locatable {
	return { mapRouteId: id, name, centroidLat: lat, centroidLng: lng };
}

// Ann Arbor, roughly.
const HERE = { lat: 42.28, lng: -83.74 };

describe('selectNearest', () => {
	it('orders by distance when the volunteer’s location is known', () => {
		const rows = [
			turf(1, 'Far', 42.6, -83.2),
			turf(2, 'Near', 42.281, -83.741),
			turf(3, 'Middle', 42.35, -83.8),
		];
		const { selected } = selectNearest(rows, { location: HERE });
		expect(selected.map((t) => t.name)).toEqual(['Near', 'Middle', 'Far']);
	});

	it('falls back to name order with no location', () => {
		const rows = [turf(1, 'Charlie', 1, 1), turf(2, 'Alpha', 2, 2), turf(3, 'Bravo', 3, 3)];
		const { selected } = selectNearest(rows, { location: null });
		expect(selected.map((t) => t.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	// Turf without a centroid is real, claimable turf — and on a key without
	// export-job access it is ALL the turf there is.
	it('keeps turf with no centroid, sorted last', () => {
		const rows = [turf(1, 'No geometry', null, null), turf(2, 'Near', 42.281, -83.741)];
		const { selected } = selectNearest(rows, { location: HERE });
		expect(selected.map((t) => t.name)).toEqual(['Near', 'No geometry']);
		expect(selected).toHaveLength(2);
	});

	it('caps the payload and reports what it left out', () => {
		const rows = Array.from({ length: 400 }, (_, i) =>
			turf(i, `Turf ${String(i).padStart(3, '0')}`, 42 + i / 1000, -83),
		);
		const { selected, omitted } = selectNearest(rows, { limit: 150 });
		expect(selected).toHaveLength(150);
		expect(omitted).toBe(250);
	});

	describe('alwaysInclude', () => {
		const many = (n: number) =>
			Array.from({ length: n }, (_, i) => turf(i, `Turf ${String(i).padStart(3, '0')}`, 42, -83));

		it('keeps a pinned row that the cap would have dropped', () => {
			const rows = [...many(200), turf(999, 'Zzz last by name', 42, -83)];
			const { selected } = selectNearest(rows, { limit: 150, alwaysInclude: [999] });
			expect(selected[0]!.mapRouteId).toBe(999);
			expect(selected).toHaveLength(150);
		});

		it('does not hand the same row back twice', () => {
			// The pinned row also sorts into the page on its own merits.
			const rows = many(5);
			const { selected } = selectNearest(rows, { limit: 5, alwaysInclude: [2] });
			expect(selected.filter((t) => t.mapRouteId === 2)).toHaveLength(1);
			expect(selected).toHaveLength(5);
		});

		it('does not count a shown row as omitted', () => {
			const rows = [...many(200), turf(999, 'Zzz last by name', 42, -83)];
			const { omitted } = selectNearest(rows, { limit: 150, alwaysInclude: [999] });
			// 200 unpinned rows, 149 of them served.
			expect(omitted).toBe(51);
		});

		// Repeating it under every "More" press would hand the volunteer the
		// same turf on page after page.
		it('pins only on the first page, so Slack paging does not repeat it', () => {
			const rows = many(300);
			const page2 = selectNearest(rows, { limit: 150, offset: 150, alwaysInclude: [0] });
			expect(page2.selected.some((t) => t.mapRouteId === 0)).toBe(false);
			expect(page2.selected).toHaveLength(150);
		});

		it('ignores ids that are not in the rows at all', () => {
			const rows = many(3);
			const { selected } = selectNearest(rows, { alwaysInclude: [12_345] });
			expect(selected).toHaveLength(3);
		});

		it('changes nothing when no ids are pinned', () => {
			const rows = many(200);
			const plain = selectNearest(rows, { limit: 150 });
			const empty = selectNearest(rows, { limit: 150, alwaysInclude: [] });
			expect(empty.selected.map((t) => t.mapRouteId)).toEqual(
				plain.selected.map((t) => t.mapRouteId),
			);
			expect(empty.omitted).toBe(plain.omitted);
		});
	});

	it('reports nothing omitted when the chapter fits', () => {
		const rows = [turf(1, 'Only', 42, -83)];
		expect(selectNearest(rows).omitted).toBe(0);
	});

	it('does not mutate the caller’s array', () => {
		const rows = [turf(1, 'Zulu', 1, 1), turf(2, 'Alpha', 2, 2)];
		selectNearest(rows);
		expect(rows.map((t) => t.name)).toEqual(['Zulu', 'Alpha']);
	});

	it('defaults to the documented budget', () => {
		const rows = Array.from({ length: TURFS_PER_PAYLOAD + 10 }, (_, i) =>
			turf(i, `Turf ${i}`, 42, -83),
		);
		expect(selectNearest(rows).selected).toHaveLength(TURFS_PER_PAYLOAD);
	});

	it('handles an empty chapter', () => {
		expect(selectNearest([])).toEqual({ selected: [], omitted: 0 });
	});
});

describe('withinBounds', () => {
	const box = { minLat: 42, maxLat: 43, minLng: -84, maxLng: -83 };

	it('keeps turf inside the box', () => {
		expect(withinBounds([turf(1, 'In', 42.5, -83.5)], box).map((t) => t.mapRouteId)).toEqual([1]);
	});

	it('drops turf outside it', () => {
		expect(withinBounds([turf(1, 'Out', 44, -83.5)], box)).toEqual([]);
		expect(withinBounds([turf(2, 'Out', 42.5, -90)], box)).toEqual([]);
	});

	it('includes turf exactly on the edge', () => {
		expect(withinBounds([turf(1, 'Edge', 42, -84)], box)).toHaveLength(1);
	});

	it('drops turf with no centroid — the map is the only caller', () => {
		expect(withinBounds([turf(1, 'No geometry', null, null)], box)).toEqual([]);
	});
});

describe('parseBounds', () => {
	it('parses a well-formed bbox', () => {
		expect(parseBounds('42,-84,43,-83')).toEqual({
			minLat: 42,
			minLng: -84,
			maxLat: 43,
			maxLng: -83,
		});
	});

	it('tolerates whitespace', () => {
		expect(parseBounds(' 42 , -84 , 43 , -83 ')).not.toBeNull();
	});

	// A bad box must not silently match the whole world — that would hand back
	// the entire chapter in one request and undo the paging.
	it.each([
		['null', null],
		['empty', ''],
		['too few parts', '42,-84,43'],
		['too many parts', '42,-84,43,-83,1'],
		['non-numeric', '42,-84,43,east'],
		['latitude out of range', '42,-84,91,-83'],
		['longitude out of range', '42,-181,43,-83'],
		['inverted latitude', '43,-84,42,-83'],
		['inverted longitude', '42,-83,43,-84'],
	])('rejects %s', (_label, raw) => {
		expect(parseBounds(raw)).toBeNull();
	});
});

// The Slack command's paging walks this offset. What has to hold is that the
// ordering never reshuffles between presses — otherwise a volunteer is handed
// the same turf twice, or one is skipped and never seen.
describe('selectNearest paging', () => {
	const rows = Array.from({ length: 12 }, (_, i) =>
		turf(i, `Turf ${String(i).padStart(2, '0')}`, 42 + i / 1000, -83),
	);

	it('returns the page after the offset', () => {
		const page1 = selectNearest(rows, { location: HERE, limit: 5 });
		const page2 = selectNearest(rows, { location: HERE, limit: 5, offset: 5 });
		const names1 = page1.selected.map((t) => t.name);
		const names2 = page2.selected.map((t) => t.name);
		expect(names1).toHaveLength(5);
		expect(names2).toHaveLength(5);
		expect(names1.some((n) => names2.includes(n))).toBe(false);
	});

	// The property that makes paging safe: two pages of five are exactly one
	// page of ten, so nothing is duplicated and nothing falls between them.
	it('is equivalent to one larger page', () => {
		const paged = [
			...selectNearest(rows, { location: HERE, limit: 5 }).selected,
			...selectNearest(rows, { location: HERE, limit: 5, offset: 5 }).selected,
		];
		const single = selectNearest(rows, { location: HERE, limit: 10 }).selected;
		expect(paged.map((t) => t.mapRouteId)).toEqual(single.map((t) => t.mapRouteId));
	});

	it('counts only what follows the page as omitted', () => {
		expect(selectNearest(rows, { limit: 5 }).omitted).toBe(7);
		expect(selectNearest(rows, { limit: 5, offset: 5 }).omitted).toBe(2);
		expect(selectNearest(rows, { limit: 5, offset: 10 }).omitted).toBe(0);
	});

	it('yields an empty page past the end rather than throwing', () => {
		const { selected, omitted } = selectNearest(rows, { limit: 5, offset: 500 });
		expect(selected).toEqual([]);
		expect(omitted).toBe(0);
	});

	// The offset arrives in a Slack button value, which round-trips through the
	// client. A negative, fractional or NaN one must not read backwards off the
	// array or silently return nothing.
	it.each([
		['negative', -5, 0],
		['fractional', 2.7, 2],
		['not a number', Number.NaN, 0],
	])('clamps a %s offset', (_label, offset, expectedIndex) => {
		const { selected } = selectNearest(rows, { location: HERE, limit: 5, offset });
		const all = selectNearest(rows, { location: HERE, limit: 12 }).selected;
		expect(selected[0]!.mapRouteId).toBe(all[expectedIndex]!.mapRouteId);
	});

	it('leaves the default behaviour untouched', () => {
		expect(selectNearest(rows, { limit: 5 })).toEqual(selectNearest(rows, { limit: 5, offset: 0 }));
	});
});
