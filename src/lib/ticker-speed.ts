// Shared bounds for the doors ticker's scroll speed, in LED columns per
// second. Lives outside $lib/server so the settings editor and the ticker
// component can both import it without dragging drizzle into the client
// bundle — same arrangement as growth-ranking.ts and DEFAULT_RANKING_ALPHA.

/** Columns per second when nothing is configured. 30 divides both common
 *  refresh rates exactly (a step every 2 frames at 60 Hz, every 4 at 120 Hz),
 *  so every step is held the same length. */
export const DEFAULT_TICKER_COLUMNS_PER_SECOND = 30;

/** Below this the board is more distracting than readable. */
export const MIN_TICKER_COLUMNS_PER_SECOND = 5;

/** The hard ceiling: at 60 columns/sec a 60 Hz display advances exactly one
 *  column per frame. Faster than that the browser cannot render every step, so
 *  it skips columns — the message jumps several diodes at a time and the
 *  one-LED-at-a-time illusion the animation is built on breaks. */
export const MAX_TICKER_COLUMNS_PER_SECOND = 60;

/** The rates worth choosing: the divisors of 120 from 10 up. Every one of
 *  them is a whole number of frames at 120 Hz, and each is either a whole
 *  number at 60 Hz too (10, 12, 15, 20, 30, 60) or a short regular
 *  alternation there (24 → 2.5 frames, 40 → 1.5) rather than a long
 *  irregular pattern.
 *
 *  That distinction is what matters perceptually. 40 alternates 1,2,1,2 on a
 *  three-frame period — too quick to read as a beat — while something like 43
 *  only repeats every 43 frames and genuinely looks ragged. So 24 and 40 are
 *  good picks despite not dividing 60, and 40 is the only sensible option
 *  between 30 and 60.
 *
 *  Nothing enforces this list — the slider is continuous and any rate works.
 *  It's the shortlist the settings page shows. */
export const RECOMMENDED_TICKER_RATES = [10, 12, 15, 20, 24, 30, 40, 60] as const;

/** Clamp to the supported range; non-numbers fall back to the default. */
export function clampTickerColumnsPerSecond(value: number | null | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_TICKER_COLUMNS_PER_SECOND;
	}
	return Math.min(MAX_TICKER_COLUMNS_PER_SECOND, Math.max(MIN_TICKER_COLUMNS_PER_SECOND, value));
}
