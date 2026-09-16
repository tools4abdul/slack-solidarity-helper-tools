// Which gestures over the map belong to the map, and which belong to the page.
//
// The map is not always the same kind of thing on the page. Beside the turf
// list on a desktop it is a panel with page either side of it, and it can own
// every gesture aimed at it. At the mobile breakpoint it is full-bleed and most
// of the screen, so the gestures a reader uses to get PAST it — a one-finger
// swipe, a plain wheel — have to keep working, or the map becomes a trap at the
// top of the page with the turf list stranded below it.
//
// What is left over is unambiguous, and it is what the map answers to there:
// two fingers, a pinch, and an explicit Ctrl/⌘ + wheel. Nothing in here is
// about capability — a phone can pinch and a trackpad can pinch. It is about
// which gesture the reader has already spent on scrolling.
//
// Pure, so the rule is one table rather than a condition spread across four
// event handlers. TurfMap.svelte is the only caller.

export interface WheelIntent {
	/** True at the breakpoint where the map goes full-bleed. */
	narrow: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

/**
 * Whether a wheel event zooms the map instead of scrolling the page.
 *
 * Ctrl/⌘ is the explicit ask, and it is also what a trackpad pinch arrives as,
 * so honouring the modifier is what makes "pinch to zoom" true on a laptop as
 * well as a phone.
 */
export function wheelZoomsMap(intent: WheelIntent): boolean {
	if (!intent.narrow) return true;
	return intent.ctrlKey || intent.metaKey;
}

export interface SwipeIntent {
	narrow: boolean;
	/** `PointerEvent.pointerType`. */
	pointerType: string;
}

/**
 * Whether one pointer dragging across the map pans it.
 *
 * A mouse drag is never a page scroll, so a mouse keeps panning at every width
 * — narrowing a desktop window must not cost the drag. Touch and pen are the
 * direct-manipulation cases where the same movement is how the page is read.
 */
export function swipePansMap(intent: SwipeIntent): boolean {
	if (!intent.narrow) return true;
	return intent.pointerType === 'mouse';
}

export interface WheelDelta {
	deltaY: number;
	/** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
	deltaMode: number;
	/** Viewport height, the unit of a page-mode delta. */
	height: number;
}

/** A mouse wheel notch, in pixels — and one whole zoom level. */
const WHEEL_NOTCH = 120;
/** A line, in pixels. Firefox reports a notch as three of them. */
const WHEEL_LINE = 40;
/** Levels one event may move. A notch is exactly one; the cap is there for
 *  pointing devices whose acceleration reports far more in a single event. */
const MAX_LEVELS_PER_EVENT = 2;

/**
 * Zoom levels for one wheel event: positive zooms in.
 *
 * Fractional on purpose. A trackpad sends a stream of a few pixels at a time,
 * and rounding each one to a whole level is what makes the map jump between
 * levels instead of tracking the fingers. A mouse wheel's notch still comes
 * out as exactly one level.
 */
export function wheelZoomDelta(wheel: WheelDelta): number {
	const pixels =
		wheel.deltaMode === 1
			? wheel.deltaY * WHEEL_LINE
			: wheel.deltaMode === 2
				? wheel.deltaY * wheel.height
				: wheel.deltaY;
	if (!Number.isFinite(pixels)) return 0;
	const levels = -pixels / WHEEL_NOTCH;
	return Math.max(-MAX_LEVELS_PER_EVENT, Math.min(MAX_LEVELS_PER_EVENT, levels));
}
