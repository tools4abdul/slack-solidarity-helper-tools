import { describe, it, expect } from 'vitest';
import {
	boundingBox,
	boundsForNearest,
	centroid,
	convexHull,
	dropOutliers,
	formatDistance,
	haversineMeters,
	padBounds,
	unionBounds,
	type LatLng,
} from './geometry.js';

const at = (lat: number, lng: number): LatLng => ({ lat, lng });

describe('haversineMeters', () => {
	it('is zero for a point against itself', () => {
		expect(haversineMeters(at(42.37, -71.11), at(42.37, -71.11))).toBe(0);
	});

	it('measures a degree of latitude as ~111 km', () => {
		const d = haversineMeters(at(42, -71), at(43, -71));
		expect(d).toBeGreaterThan(111_000);
		expect(d).toBeLessThan(111_400);
	});

	it('shrinks a degree of longitude with latitude', () => {
		const atEquator = haversineMeters(at(0, 0), at(0, 1));
		const atBoston = haversineMeters(at(42, -71), at(42, -70));
		expect(atBoston).toBeLessThan(atEquator * 0.8);
	});

	it('is symmetric', () => {
		const a = at(42.3736, -71.1097);
		const b = at(42.3801, -71.1201);
		expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
	});
});

describe('convexHull', () => {
	it('returns a square for a filled square of points', () => {
		const points = [
			at(0, 0),
			at(0, 1),
			at(1, 0),
			at(1, 1),
			at(0.5, 0.5), // interior — must be dropped
			at(0.2, 0.7), // interior — must be dropped
		];
		const hull = convexHull(points);
		expect(hull).toHaveLength(4);
		expect(hull).toEqual(expect.arrayContaining([at(0, 0), at(0, 1), at(1, 0), at(1, 1)]));
	});

	it('drops points strictly inside the hull', () => {
		const hull = convexHull([at(0, 0), at(0, 10), at(10, 10), at(10, 0), at(5, 5)]);
		expect(hull).not.toContainEqual(at(5, 5));
	});

	// The degenerate cases are the ones that matter: a hull of 2 points draws a
	// zero-area sliver, and the UI must fall back to a pin instead.
	it('returns the input for fewer than three unique points', () => {
		expect(convexHull([])).toEqual([]);
		expect(convexHull([at(1, 1)])).toEqual([at(1, 1)]);
		expect(convexHull([at(1, 1), at(2, 2)])).toHaveLength(2);
	});

	it('collapses duplicate coordinates before hulling', () => {
		// An apartment block: many doors, one coordinate.
		const hull = convexHull([at(1, 1), at(1, 1), at(1, 1)]);
		expect(hull).toEqual([at(1, 1)]);
	});

	it('returns empty for perfectly collinear points', () => {
		// A single straight street. There is no polygon to draw.
		const hull = convexHull([at(0, 0), at(1, 1), at(2, 2), at(3, 3)]);
		expect(hull).toEqual([]);
	});

	it('does not repeat the closing point', () => {
		const hull = convexHull([at(0, 0), at(0, 1), at(1, 1), at(1, 0)]);
		expect(hull[0]).not.toEqual(hull[hull.length - 1]);
	});

	it('is stable regardless of input order', () => {
		const points = [at(0, 0), at(2, 1), at(1, 3), at(3, 2), at(1.5, 1.5)];
		const a = convexHull(points);
		const b = convexHull([...points].reverse());
		expect(new Set(a.map((p) => `${p.lat},${p.lng}`))).toEqual(
			new Set(b.map((p) => `${p.lat},${p.lng}`)),
		);
	});
});

describe('dropOutliers', () => {
	it('leaves small inputs untouched', () => {
		const points = [at(42, -71), at(42.001, -71), at(0, 0)];
		expect(dropOutliers(points)).toHaveLength(3);
	});

	it('removes a far-flung bad geocode from a real cluster', () => {
		const cluster: LatLng[] = [];
		for (let i = 0; i < 40; i++) {
			cluster.push(at(42.37 + (i % 8) * 0.0004, -71.11 + Math.floor(i / 8) * 0.0004));
		}
		const withBadPoint = [...cluster, at(38.9, -77.03)]; // geocoder fell back to DC
		const cleaned = dropOutliers(withBadPoint);
		expect(cleaned).not.toContainEqual(at(38.9, -77.03));
		expect(cleaned.length).toBeGreaterThanOrEqual(cluster.length - 2);
	});

	it('keeps everything when all points sit on one ring (sigma 0)', () => {
		const ring: LatLng[] = [];
		for (let i = 0; i < 12; i++) {
			const angle = (i / 12) * Math.PI * 2;
			ring.push(at(42 + Math.sin(angle) * 0.001, -71 + Math.cos(angle) * 0.001));
		}
		expect(dropOutliers(ring)).toHaveLength(12);
	});
});

describe('centroid / boundingBox', () => {
	it('averages the points', () => {
		expect(centroid([at(0, 0), at(2, 4)])).toEqual(at(1, 2));
	});

	it('returns null for no points', () => {
		expect(centroid([])).toBeNull();
		expect(boundingBox([])).toBeNull();
	});

	it('bounds every point', () => {
		const box = boundingBox([at(1, 5), at(-2, 9), at(4, -3)]);
		expect(box).toEqual({ minLat: -2, maxLat: 4, minLng: -3, maxLng: 9 });
	});
});

describe('unionBounds / padBounds', () => {
	it('unions to cover both boxes', () => {
		const a = { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 };
		const b = { minLat: 2, maxLat: 3, minLng: -1, maxLng: 0 };
		expect(unionBounds([a, b])).toEqual({ minLat: 0, maxLat: 3, minLng: -1, maxLng: 1 });
	});

	it('returns null for no boxes', () => {
		expect(unionBounds([])).toBeNull();
	});

	it('grows a box outward', () => {
		const padded = padBounds({ minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 }, 0.1);
		expect(padded.minLat).toBeCloseTo(-1);
		expect(padded.maxLat).toBeCloseTo(11);
	});

	it('gives a single-point box a usable span', () => {
		const padded = padBounds({ minLat: 42, maxLat: 42, minLng: -71, maxLng: -71 });
		expect(padded.maxLat).toBeGreaterThan(padded.minLat);
		expect(padded.maxLng).toBeGreaterThan(padded.minLng);
	});
});

describe('boundsForNearest', () => {
	const turf = (lat: number, lng: number) => ({
		centre: at(lat, lng),
		bounds: { minLat: lat - 0.002, maxLat: lat + 0.002, minLng: lng - 0.002, maxLng: lng + 0.002 },
	});

	// The 150-mile-wide-chapter case: framing everything would render each
	// two-mile turf at a few pixels.
	it('ignores far turfs when nearer ones exist', () => {
		const here = at(42.365, -71.104);
		const items = [
			turf(42.366, -71.105),
			turf(42.368, -71.108),
			turf(42.37, -71.11),
			turf(41.2, -73.9), // 150 miles away
		];
		const box = boundsForNearest(here, items, 3);
		expect(box.minLat).toBeGreaterThan(42);
		expect(box.minLng).toBeGreaterThan(-72);
	});

	it('always contains the origin', () => {
		const here = at(42.5, -71.5);
		const box = boundsForNearest(here, [turf(42.36, -71.1)], 1);
		expect(here.lat).toBeGreaterThanOrEqual(box.minLat);
		expect(here.lat).toBeLessThanOrEqual(box.maxLat);
		expect(here.lng).toBeGreaterThanOrEqual(box.minLng);
		expect(here.lng).toBeLessThanOrEqual(box.maxLng);
	});

	it('frames everything when there are fewer items than requested', () => {
		const here = at(42.365, -71.104);
		const items = [turf(42.366, -71.105), turf(42.4, -71.2)];
		const box = boundsForNearest(here, items, 10);
		expect(box.maxLat).toBeGreaterThanOrEqual(42.4);
	});

	it('degenerates to the origin when there are no turfs', () => {
		const here = at(42.365, -71.104);
		expect(boundsForNearest(here, [])).toEqual({
			minLat: 42.365,
			maxLat: 42.365,
			minLng: -71.104,
			maxLng: -71.104,
		});
	});

	it('does not mutate the input array order', () => {
		const items = [turf(43, -71), turf(42, -71)];
		const copy = [...items];
		boundsForNearest(at(42, -71), items, 1);
		expect(items).toEqual(copy);
	});
});

describe('formatDistance', () => {
	it('rounds short distances to 50 ft', () => {
		// 120 m ≈ 394 ft, 139 m ≈ 456 ft.
		expect(formatDistance(120)).toBe('400 ft');
		expect(formatDistance(139)).toBe('450 ft');
	});

	it('switches to miles at 1000 ft', () => {
		// 304 m ≈ 997 ft, still feet; 305 m ≈ 1001 ft, now miles.
		expect(formatDistance(304)).toBe('1000 ft');
		expect(formatDistance(305)).toBe('0.2 mi');
	});

	it('reports longer distances in miles', () => {
		expect(formatDistance(1609.344)).toBe('1.0 mi');
		expect(formatDistance(15_000)).toBe('9.3 mi');
	});

	it('handles zero without inventing a distance', () => {
		expect(formatDistance(0)).toBe('0 ft');
	});
});
