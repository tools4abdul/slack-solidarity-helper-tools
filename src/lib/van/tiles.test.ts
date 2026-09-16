import { describe, it, expect } from 'vitest';
import {
	boundsCentre,
	createMapView,
	fitZoom,
	fromWorld,
	metresPerPixel,
	MAX_ZOOM,
	MIN_ZOOM,
	TILE_SIZE,
	TILE_URL_TEMPLATE,
	tileUrl,
	toWorld,
	withTileApiKey,
} from './tiles.js';
import type { BoundingBox } from './geometry.js';

const CAMBRIDGE: BoundingBox = {
	minLat: 42.36,
	maxLat: 42.38,
	minLng: -71.12,
	maxLng: -71.1,
};

describe('toWorld / fromWorld', () => {
	it('puts null island at the centre of the world square', () => {
		const { x, y } = toWorld({ lat: 0, lng: 0 });
		expect(x).toBeCloseTo(0.5, 10);
		expect(y).toBeCloseTo(0.5, 10);
	});

	it('puts the antimeridian at the edges', () => {
		expect(toWorld({ lat: 0, lng: -180 }).x).toBeCloseTo(0, 10);
		expect(toWorld({ lat: 0, lng: 180 }).x).toBeCloseTo(1, 10);
	});

	it('puts north above south', () => {
		expect(toWorld({ lat: 60, lng: 0 }).y).toBeLessThan(toWorld({ lat: -60, lng: 0 }).y);
	});

	it('round-trips', () => {
		for (const point of [
			{ lat: 42.3736, lng: -71.1097 },
			{ lat: -33.8688, lng: 151.2093 },
			{ lat: 0, lng: 0 },
		]) {
			const back = fromWorld(toWorld(point));
			expect(back.lat).toBeCloseTo(point.lat, 9);
			expect(back.lng).toBeCloseTo(point.lng, 9);
		}
	});

	it('clips beyond the Mercator limit into the unit square', () => {
		// Not infinity, and not a hair outside — a y of -6e-12 becomes tile
		// row -1 downstream, which is a guaranteed 404.
		for (const lat of [89.9, -89.9, 90, -90]) {
			const { y } = toWorld({ lat, lng: 0 });
			expect(Number.isFinite(y)).toBe(true);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
		}
	});
});

describe('fitZoom', () => {
	it('picks a street-level zoom for a neighbourhood in a large viewport', () => {
		const zoom = fitZoom(CAMBRIDGE, 720, 520, 28);
		expect(zoom).toBeGreaterThanOrEqual(13);
		expect(zoom).toBeLessThanOrEqual(16);
	});

	it('zooms out for a wider area', () => {
		const wide: BoundingBox = { minLat: 41, maxLat: 43, minLng: -72, maxLng: -70 };
		expect(fitZoom(wide, 720, 520)).toBeLessThan(fitZoom(CAMBRIDGE, 720, 520));
	});

	it('zooms out when the viewport shrinks', () => {
		expect(fitZoom(CAMBRIDGE, 300, 200)).toBeLessThanOrEqual(fitZoom(CAMBRIDGE, 720, 520));
	});

	it('stays within provider zoom limits', () => {
		const whole: BoundingBox = { minLat: -80, maxLat: 80, minLng: -179, maxLng: 179 };
		expect(fitZoom(whole, 100, 100)).toBeGreaterThanOrEqual(MIN_ZOOM);
		expect(fitZoom(CAMBRIDGE, 100_000, 100_000)).toBeLessThanOrEqual(MAX_ZOOM);
	});

	it('falls back to a close zoom for a zero-span box', () => {
		const point: BoundingBox = { minLat: 42.37, maxLat: 42.37, minLng: -71.11, maxLng: -71.11 };
		const zoom = fitZoom(point, 720, 520);
		expect(Number.isFinite(zoom)).toBe(true);
		expect(zoom).toBeGreaterThan(10);
	});

	// The fitted view must actually contain the bounds — this is the property
	// that makes "all turfs visible on load" true rather than approximately true.
	it('produces a view that contains the bounds it was fitted to', () => {
		const width = 720;
		const height = 520;
		const zoom = fitZoom(CAMBRIDGE, width, height, 28);
		const view = createMapView({
			centre: boundsCentre(CAMBRIDGE),
			zoom,
			width,
			height,
		});
		for (const corner of [
			{ lat: CAMBRIDGE.minLat, lng: CAMBRIDGE.minLng },
			{ lat: CAMBRIDGE.maxLat, lng: CAMBRIDGE.maxLng },
		]) {
			const { x, y } = view.project(corner);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(width);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(height);
		}
	});
});

describe('boundsCentre', () => {
	it('lands inside the bounds', () => {
		const centre = boundsCentre(CAMBRIDGE);
		expect(centre.lat).toBeGreaterThan(CAMBRIDGE.minLat);
		expect(centre.lat).toBeLessThan(CAMBRIDGE.maxLat);
		expect(centre.lng).toBeCloseTo(-71.11, 6);
	});
});

describe('createMapView', () => {
	const base = { centre: { lat: 42.37, lng: -71.11 }, width: 720, height: 520 };
	const view = createMapView({
		centre: { lat: 42.37, lng: -71.11 },
		zoom: 14,
		width: 720,
		height: 520,
	});

	it('projects its own centre to the middle of the viewport', () => {
		const { x, y } = view.project({ lat: 42.37, lng: -71.11 });
		expect(x).toBeCloseTo(360, 6);
		expect(y).toBeCloseTo(260, 6);
	});

	it('round-trips project and unproject', () => {
		const point = { lat: 42.3755, lng: -71.1042 };
		const back = view.unproject(view.project(point));
		expect(back.lat).toBeCloseTo(point.lat, 9);
		expect(back.lng).toBeCloseTo(point.lng, 9);
	});

	it('covers the whole viewport with tiles', () => {
		expect(view.tiles.length).toBeGreaterThan(0);
		// Every pixel of the viewport must be inside some tile's square.
		for (const probe of [
			{ x: 0, y: 0 },
			{ x: 719, y: 519 },
			{ x: 360, y: 260 },
		]) {
			const covering = view.tiles.some(
				(t) =>
					probe.x >= t.left &&
					probe.x < t.left + t.size &&
					probe.y >= t.top &&
					probe.y < t.top + t.size,
			);
			expect(covering).toBe(true);
		}
	});

	it('gives every tile a distinct key', () => {
		expect(new Set(view.tiles.map((t) => t.key)).size).toBe(view.tiles.length);
	});

	it('emits only in-range tile indices', () => {
		const count = Math.pow(2, view.zoom);
		for (const t of view.tiles) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.x).toBeLessThan(count);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(count);
		}
	});

	// --- Fractional zoom ----------------------------------------------------
	// Between levels the projection keeps moving while the tiles stay put at a
	// whole level and scale. These are the invariants that keeps honest.

	describe('between whole levels', () => {
		const frac = createMapView({
			centre: { lat: 42.37, lng: -71.11 },
			zoom: 14.4,
			width: 720,
			height: 520,
		});

		it('fetches the nearest whole level, not the floor', () => {
			expect(frac.tileZoom).toBe(14);
			expect(frac.tiles.every((t) => t.z === 14)).toBe(true);
			// 13.6 rounds the other way, to 14 as well; 14.6 rounds up to 15.
			expect(createMapView({ ...base, zoom: 14.6 }).tileZoom).toBe(15);
			expect(createMapView({ ...base, zoom: 13.6 }).tileZoom).toBe(14);
		});

		it('scales the tiles by the distance from that level', () => {
			const expected = TILE_SIZE * Math.pow(2, 0.4);
			expect(frac.tiles.every((t) => Math.abs(t.size - expected) < 1e-9)).toBe(true);
		});

		it('never resamples by more than 1.41x in either direction', () => {
			for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.1) {
				const view = createMapView({ ...base, zoom: z });
				const factor = view.tiles[0].size / TILE_SIZE;
				expect(factor).toBeGreaterThan(0.7);
				expect(factor).toBeLessThan(1.42);
			}
		});

		it('still covers the whole viewport', () => {
			for (const probe of [
				{ x: 0, y: 0 },
				{ x: 719, y: 519 },
				{ x: 360, y: 260 },
			]) {
				const covering = frac.tiles.some(
					(t) =>
						probe.x >= t.left &&
						probe.x < t.left + t.size &&
						probe.y >= t.top &&
						probe.y < t.top + t.size,
				);
				expect(covering).toBe(true);
			}
		});

		it('lays the grid out without seams or overlaps', () => {
			// Tiles in a row abut exactly: one tile's right edge is the next
			// one's left. A grid stepped by TILE_SIZE while scaled would drift.
			const row = frac.tiles
				.filter((t) => t.top === frac.tiles[0].top)
				.sort((a, b) => a.left - b.left);
			expect(row.length).toBeGreaterThan(1);
			for (let i = 1; i < row.length; i++) {
				expect(row[i].left).toBeCloseTo(row[i - 1].left + row[i - 1].size, 9);
			}
		});

		it('keeps projecting its own centre to the middle', () => {
			const { x, y } = frac.project({ lat: 42.37, lng: -71.11 });
			expect(x).toBeCloseTo(360, 6);
			expect(y).toBeCloseTo(260, 6);
		});

		it('round-trips project and unproject', () => {
			const point = { lat: 42.3755, lng: -71.1042 };
			const back = frac.unproject(frac.project(point));
			expect(back.lat).toBeCloseTo(point.lat, 9);
			expect(back.lng).toBeCloseTo(point.lng, 9);
		});

		it('reuses tile keys across a fractional change within one level', () => {
			// The whole point of keying on the tile's zoom: nudging the zoom
			// must rescale the images already loaded, never refetch them.
			const nudged = createMapView({ ...base, zoom: 14.45 });
			const before = new Set(createMapView({ ...base, zoom: 14.4 }).tiles.map((t) => t.key));
			expect(nudged.tiles.every((t) => before.has(t.key))).toBe(true);
		});

		it('clamps the tile level at the ends of the range', () => {
			expect(createMapView({ ...base, zoom: MAX_ZOOM }).tileZoom).toBe(MAX_ZOOM);
			expect(createMapView({ ...base, zoom: MIN_ZOOM }).tileZoom).toBe(MIN_ZOOM);
		});
	});

	it('omits tiles past the poles rather than requesting 404s', () => {
		const polar = createMapView({ centre: { lat: 84, lng: 0 }, zoom: 3, width: 800, height: 800 });
		const count = Math.pow(2, 3);
		expect(polar.tiles.every((t) => t.y >= 0 && t.y < count)).toBe(true);
	});

	it("draws whole levels at the tile's own resolution", () => {
		expect(view.tileZoom).toBe(14);
		expect(view.tiles.every((t) => t.size === TILE_SIZE)).toBe(true);
	});

	it('wraps tile x across the antimeridian', () => {
		const wrapped = createMapView({
			centre: { lat: 0, lng: 179.9 },
			zoom: 4,
			width: 800,
			height: 400,
		});
		const count = Math.pow(2, 4);
		expect(wrapped.tiles.every((t) => t.x >= 0 && t.x < count)).toBe(true);
		// Both the far-east and far-west columns should be present.
		expect(wrapped.tiles.some((t) => t.x === count - 1)).toBe(true);
		expect(wrapped.tiles.some((t) => t.x === 0)).toBe(true);
	});
});

describe('metresPerPixel', () => {
	it('halves with each zoom level', () => {
		const a = metresPerPixel(42, 14);
		const b = metresPerPixel(42, 15);
		expect(a / b).toBeCloseTo(2, 6);
	});

	it('shrinks away from the equator', () => {
		expect(metresPerPixel(60, 14)).toBeLessThan(metresPerPixel(0, 14));
	});

	it('is about 9.5 m/px at zoom 14 in Boston', () => {
		expect(metresPerPixel(42.37, 14)).toBeGreaterThan(6);
		expect(metresPerPixel(42.37, 14)).toBeLessThan(9);
	});
});

describe('tileUrl', () => {
	it('substitutes z, x and y', () => {
		const url = tileUrl({ z: 13, x: 2482, y: 3040, left: 0, top: 0, size: TILE_SIZE, key: 'k' });
		expect(url).toBe('https://basemaps.cartocdn.com/light_all/13/2482/3040@2x.png');
	});

	it('accepts an alternative template', () => {
		const url = tileUrl(
			{ z: 5, x: 1, y: 2, left: 0, top: 0, size: TILE_SIZE, key: 'k' },
			'https://example.test/{z}/{x}/{y}.png',
		);
		expect(url).toBe('https://example.test/5/1/2.png');
	});
});

describe('withTileApiKey', () => {
	it('appends the key to the CARTO template', () => {
		expect(withTileApiKey(TILE_URL_TEMPLATE, 'abc123')).toBe(
			'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png?key=abc123',
		);
	});

	it('joins with & when the template already has a query string', () => {
		expect(withTileApiKey('https://basemaps.cartocdn.com/t/{z}/{x}/{y}.png?r=2', 'abc')).toBe(
			'https://basemaps.cartocdn.com/t/{z}/{x}/{y}.png?r=2&key=abc',
		);
	});

	it('leaves the template alone when no key is set', () => {
		expect(withTileApiKey(TILE_URL_TEMPLATE, '')).toBe(TILE_URL_TEMPLATE);
		expect(withTileApiKey(TILE_URL_TEMPLATE, '   ')).toBe(TILE_URL_TEMPLATE);
	});

	it('never sends the key to a non-CARTO host', () => {
		const other = 'https://tiles.stadiamaps.test/{z}/{x}/{y}.png';
		expect(withTileApiKey(other, 'abc123')).toBe(other);
		// A lookalike host is not CARTO either.
		const lookalike = 'https://cartocdn.com.evil.test/{z}/{x}/{y}.png';
		expect(withTileApiKey(lookalike, 'abc123')).toBe(lookalike);
	});

	it('leaves an unparseable template alone', () => {
		expect(withTileApiKey('/local/{z}/{x}/{y}.png', 'abc123')).toBe('/local/{z}/{x}/{y}.png');
	});

	it('produces a fetchable url once z/x/y are substituted', () => {
		const template = withTileApiKey(TILE_URL_TEMPLATE, 'a b&c');
		expect(
			tileUrl({ z: 13, x: 2482, y: 3040, left: 0, top: 0, size: TILE_SIZE, key: 'k' }, template),
		).toBe('https://basemaps.cartocdn.com/light_all/13/2482/3040@2x.png?key=a%20b%26c');
	});
});
