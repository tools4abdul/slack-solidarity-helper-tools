// Turf geometry: hulls, centroids, distances, and framing.
//
// Viewport-free and projection-free on purpose — everything here is spherical
// or plain lat/lng. Putting pixels on a screen is tiles.ts's job, because that
// has to be Web Mercator to line up with basemap tiles.
//
// This exists because VAN has no turf boundaries. Map Regions and Map Routes
// are pure metadata — I grepped the whole v4 reference for geojson/polygon/
// geometry and there is nothing. The only coordinates VAN will give up are
// per-address VAddressLatitude/VAddressLongitude columns on an Export Job, so
// a turf's shape has to be derived from the doors inside it.
//
// Deliberately NOT under $lib/server: there is nothing secret about a convex
// hull, and the browser needs `haversineMeters` to re-sort turfs as the
// volunteer moves. The PII boundary is upstream of here — export rows are
// reduced to a hull server-side and dropped (see specs/010-van-turf-checkout).
// What reaches this module's callers on the client is already aggregate.
//
// No dependencies. Monotone chain is ~30 lines and a hull library would be a
// Principle IV violation for arithmetic we can read in full.

export interface LatLng {
	lat: number;
	lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. Used for "turfs near me" ordering, which
 *  needs to be right to a block, not to a metre — haversine is plenty and
 *  avoids Vincenty's iteration. */
export function haversineMeters(a: LatLng, b: LatLng): number {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Mean of the input points. This is the centroid of the *doors*, not of the
 *  hull polygon — which is what we want, because it lands where the people
 *  are rather than in the middle of an empty bulge. */
export function centroid(points: readonly LatLng[]): LatLng | null {
	if (points.length === 0) return null;
	let lat = 0;
	let lng = 0;
	for (const p of points) {
		lat += p.lat;
		lng += p.lng;
	}
	return { lat: lat / points.length, lng: lng / points.length };
}

export interface BoundingBox {
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
}

export function boundingBox(points: readonly LatLng[]): BoundingBox | null {
	if (points.length === 0) return null;
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLng = Infinity;
	let maxLng = -Infinity;
	for (const p of points) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lng < minLng) minLng = p.lng;
		if (p.lng > maxLng) maxLng = p.lng;
	}
	return { minLat, maxLat, minLng, maxLng };
}

/** Cross product of OA×OB. >0 means counter-clockwise turn at O. */
function cross(o: LatLng, a: LatLng, b: LatLng): number {
	return (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
}

/**
 * Convex hull by Andrew's monotone chain, in counter-clockwise order, with no
 * repeated closing point.
 *
 * Returns fewer than 3 points when the input is degenerate (empty, a single
 * door, two doors, or a street of perfectly collinear doors). Callers must
 * handle that: a turf with no drawable hull renders as a centroid pin, never
 * as a broken polygon.
 *
 * Operates on raw lng/lat as if they were planar. Over a canvassing turf —
 * hundreds of metres — the error from ignoring the earth's curvature is far
 * below the error already baked into calling a turf convex at all.
 */
export function convexHull(points: readonly LatLng[]): LatLng[] {
	// De-duplicate first: apartment buildings put dozens of doors on one exact
	// coordinate, and duplicates make the collinearity test below ambiguous.
	const seen = new Set<string>();
	const unique: LatLng[] = [];
	for (const p of points) {
		const key = `${p.lat},${p.lng}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(p);
	}

	if (unique.length < 3) return unique;

	const sorted = [...unique].sort((a, b) => a.lng - b.lng || a.lat - b.lat);

	const lower: LatLng[] = [];
	for (const p of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
			lower.pop();
		}
		lower.push(p);
	}

	const upper: LatLng[] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
			upper.pop();
		}
		upper.push(p);
	}

	// Drop each chain's last point — it is the other chain's first.
	lower.pop();
	upper.pop();
	const hull = lower.concat(upper);

	// All input collinear: the two chains collapse to the same segment.
	return hull.length < 3 ? [] : hull;
}

/**
 * Drop points more than `maxSigma` standard deviations from the centroid.
 *
 * One bad geocode — a door that landed on the state centroid because its
 * address didn't parse — drags a hull across the county and makes the map
 * useless. This runs before `convexHull`, which is exactly the operation an
 * outlier has outsized influence over.
 *
 * Returns the input unchanged when there are too few points for a meaningful
 * spread, so a 4-door turf isn't whittled to nothing.
 */
export function dropOutliers(points: readonly LatLng[], maxSigma = 3): LatLng[] {
	if (points.length < 8) return [...points];
	const c = centroid(points);
	if (!c) return [];

	const distances = points.map((p) => haversineMeters(c, p));
	const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
	const variance = distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length;
	const sigma = Math.sqrt(variance);

	// A perfectly uniform ring has sigma 0; keep everything rather than
	// dividing by zero into a filter that drops the whole turf.
	if (sigma === 0) return [...points];

	const limit = mean + maxSigma * sigma;
	return points.filter((_, i) => distances[i] <= limit);
}

/** Union of several bounding boxes, e.g. to frame every turf at once. */
export function unionBounds(boxes: readonly BoundingBox[]): BoundingBox | null {
	if (boxes.length === 0) return null;
	return boxes.reduce((acc, b) => ({
		minLat: Math.min(acc.minLat, b.minLat),
		maxLat: Math.max(acc.maxLat, b.maxLat),
		minLng: Math.min(acc.minLng, b.minLng),
		maxLng: Math.max(acc.maxLng, b.maxLng),
	}));
}

/** Grow a box by a fraction of its own span, so a fitted map isn't flush
 *  against its frame. Also rescues a zero-span box (one point). */
export function padBounds(bounds: BoundingBox, fraction = 0.08): BoundingBox {
	const latSpan = bounds.maxLat - bounds.minLat || 0.002;
	const lngSpan = bounds.maxLng - bounds.minLng || 0.002;
	return {
		minLat: bounds.minLat - latSpan * fraction,
		maxLat: bounds.maxLat + latSpan * fraction,
		minLng: bounds.minLng - lngSpan * fraction,
		maxLng: bounds.maxLng + lngSpan * fraction,
	};
}

/**
 * A frame around the `count` items nearest `origin`, plus `origin` itself.
 *
 * Chapters are counties, and the widest is ~150 miles across; turfs are a
 * couple of miles. Fitting the whole chapter would put every turf at a few
 * pixels and answer a question nobody asked. The volunteer's question is
 * "what's near me", so the default frame is their neighbourhood — with a
 * "show everything" control for the times they want the wider picture.
 *
 * Falls back to framing everything when there are fewer items than `count`,
 * and to `origin` alone when there are none.
 */
export function boundsForNearest<T extends { centre: LatLng; bounds: BoundingBox }>(
	origin: LatLng,
	items: readonly T[],
	count = 5,
): BoundingBox {
	const soloBox: BoundingBox = {
		minLat: origin.lat,
		maxLat: origin.lat,
		minLng: origin.lng,
		maxLng: origin.lng,
	};
	if (items.length === 0) return soloBox;

	const nearest = [...items]
		.sort((a, b) => haversineMeters(origin, a.centre) - haversineMeters(origin, b.centre))
		.slice(0, Math.max(1, count));

	return unionBounds([soloBox, ...nearest.map((i) => i.bounds)]) ?? soloBox;
}

const FEET_PER_METRE = 3.280839895;
const METRES_PER_MILE = 1609.344;

/**
 * Metres → a short human string for turf cards ("450 ft", "1.2 mi").
 *
 * Imperial, because every reader of this is a canvasser in Michigan deciding
 * whether a turf is walkable from where they are standing. Distances are
 * computed in metres throughout — `haversineMeters` and the hull maths stay
 * metric — and converted only here, at the one point a number becomes words.
 *
 * The switch is at 1000 ft rather than at a round number of miles: below it,
 * "down the street" is the useful answer and feet say it; above it, tenths of
 * a mile are what anyone judges a drive or a walk by. Short distances round to
 * 50 ft because the underlying position is a turf centroid and a phone's
 * geolocation, neither of which is accurate to the foot — a precise-looking
 * "437 ft" would be false precision.
 */
export function formatDistance(meters: number): string {
	const feet = meters * FEET_PER_METRE;
	if (feet < 1000) return `${Math.round(feet / 50) * 50} ft`;
	return `${(meters / METRES_PER_MILE).toFixed(1)} mi`;
}
