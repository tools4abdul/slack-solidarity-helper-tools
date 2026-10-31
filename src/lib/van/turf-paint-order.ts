// The order the map paints turfs in, which is also the order taps resolve in.
//
// SVG has no z-index: later siblings paint over earlier ones, and a tap lands
// on the topmost shape under it. Turfs overlap — a re-cut sits inside the turf
// it came from, neighbours share streets — so painting in arrival order lets a
// large hull bury a small one and leave it untappable. Painting largest first
// keeps every smaller turf above anything that covers it. The cost is the
// mirror case: a large turf is reachable on the map only where no smaller one
// covers it, and the turf list beside the map reaches it everywhere.
//
// Area is ground area, not on-screen area. The map's projection scales every
// hull by the same factor, so the order is the same at every zoom, and a fixed
// order means a pan or zoom never moves a turf's node in the DOM (a moved node
// drops keyboard focus). Turfs that draw as pins are the ones too small to
// draw, so they sort to the end and sit above the polygons; degenerate hulls
// have zero area and do the same.
//
// Pure, so the rule is tested here rather than in a component. TurfMap.svelte
// is the only caller.

import { hullAreaSquareMeters, type LatLng } from './geometry.js';

/**
 * A copy of `turfs` in paint order: largest hull first. Ties keep their input
 * order.
 */
export function paintOrder<T extends { hull: readonly LatLng[] }>(turfs: readonly T[]): T[] {
	return turfs
		.map((turf) => ({ turf, area: hullAreaSquareMeters(turf.hull) }))
		.sort((a, b) => b.area - a.area)
		.map(({ turf }) => turf);
}
