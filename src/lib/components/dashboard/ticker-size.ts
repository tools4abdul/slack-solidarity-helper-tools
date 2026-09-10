/** The shapes the dashboard's LED sign can be asked for by hand, as
 *  `?ticker=<name>`. The point of the parameter is a URL you can open on a
 *  screen on the wall and get the big version straight away, without a click
 *  the display has nobody to give it.
 *
 *  A value is the CSS `aspect-ratio` the panel holds; `fit` is null — no fixed
 *  shape, the panel is exactly as tall as what it is showing, which is how the
 *  dashboard reads for someone scrolling past it. */
export const TICKER_SIZES = {
	fit: null,
	widescreen: '16 / 9',
} as const;

export type TickerSize = keyof typeof TICKER_SIZES;

const DEFAULT_SIZE: TickerSize = 'fit';

/** The shape the sign offers when it is NOT fitted. Every non-`fit` size names
 *  its own ratio; `fit` still needs one, because the sign stays clickable and
 *  has to have something to expand TO. */
const DEFAULT_RATIO = TICKER_SIZES.widescreen;

export interface TickerShape {
	/** CSS `aspect-ratio` for the panel's fixed shape — what the click toggles
	 *  onto, and what the board renders at when `fit` is false. */
	ratio: string;
	/** Whether the sign starts fitted to its content rather than on `ratio`. */
	fit: boolean;
}

export function parseTickerSize(searchParams: URLSearchParams): TickerSize {
	const raw = searchParams.get('ticker');
	if (raw === null) return DEFAULT_SIZE;
	const name = raw.trim().toLowerCase();
	// hasOwn, not `in`: `?ticker=constructor` would otherwise be a hit on
	// Object.prototype and index out to undefined.
	return Object.hasOwn(TICKER_SIZES, name) ? (name as TickerSize) : DEFAULT_SIZE;
}

export function tickerShape(searchParams: URLSearchParams): TickerShape {
	const ratio = TICKER_SIZES[parseTickerSize(searchParams)];
	return ratio === null ? { ratio: DEFAULT_RATIO, fit: true } : { ratio, fit: false };
}
