// Deciding whether selecting a turf should move the map, and how far.
//
// Clicking a row in the turf list selects that turf. If it is already on
// screen, the map must NOT move: the list and the map are two views of one
// selection, and a camera that jumps every time you read down the list makes
// the map useless for comparing one turf against its neighbours. So the rule
// is "recentre only when you cannot see it", and this is the half of it that
// can be decided without a camera.
//
// Pure — the projection lives in tiles.ts and the camera in TurfMap.svelte.
// Everything here is in viewport pixels, which is the one space where "can I
// see it" is a straight comparison.

/** A box in viewport pixels: 0,0 is the top-left of the map element. */
export interface PixelBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Whether a projected box sits fully inside the viewport.
 *
 * `margin` keeps a turf touching the very edge from counting as visible — a
 * hull with two pixels showing is one you cannot actually read, and treating it
 * as "already on screen" is how a selection appears to do nothing.
 *
 * A box LARGER than the viewport is never visible by this test, which is the
 * intended answer: it is also the case where the caller should zoom out.
 */
export function isBoxVisible(box: PixelBox, width: number, height: number, margin = 0): boolean {
	return (
		box.minX >= margin &&
		box.minY >= margin &&
		box.maxX <= width - margin &&
		box.maxY <= height - margin
	);
}

/**
 * The zoom to adopt when recentring on a turf.
 *
 * Never zooms IN. Selecting a small turf should not slam the camera to street
 * level — the volunteer chose their zoom, and the request is "show me where
 * this is", not "show me this as large as possible". So the current zoom is
 * kept unless the turf will not fit at it, and then it backs off only as far as
 * framing the turf requires.
 */
export function focusZoom(current: number, fit: number): number {
	return Math.min(current, fit);
}
