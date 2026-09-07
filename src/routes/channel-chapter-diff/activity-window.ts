// The activity-window control's state rules, kept out of the component so they
// can be tested — this project runs Vitest in a node environment with no
// component rendering, so page logic lives in a plain module beside the page
// (the same split as picker-logic.ts).
//
// The rule these enforce: the control must never claim a filter that isn't
// being applied. An empty days box can't express a window, and a ticked box
// over no window would show an unfiltered list under a heading promising a
// filtered one.

export const MIN_DAYS = 1;
export const MAX_DAYS = 365;
export const DEFAULT_DAYS = 30;

export interface ActivityWindow {
	/** Is the filter switched on? */
	on: boolean;
	/** Days in the box; null when it is empty — Svelte binds an empty number
	 *  input to null, which is exactly the case worth handling. */
	days: number | null;
}

/** State after the checkbox is toggled. */
export function afterToggle(state: ActivityWindow): ActivityWindow {
	// Switching on with an empty box would mean "filter by nothing", so the
	// default comes back with it.
	if (state.on && state.days === null) return { on: true, days: DEFAULT_DAYS };
	return state;
}

/** State after the days box is edited. */
export function afterDaysChange(state: ActivityWindow): ActivityWindow {
	// Clearing the box switches the filter off rather than leaving it ticked
	// over nothing: the comparison really will be unfiltered, and the control
	// should say so.
	if (state.days === null) return { on: false, days: null };
	// `min`/`max` on the input are only hints — a typed value can exceed them,
	// and the server rejects out-of-range days — so clamp instead of bouncing
	// the admin off a 400.
	const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(state.days)));
	return { on: state.on, days };
}

/** The window to send with the comparison, or null for an unfiltered one. */
export function appliedDays(state: ActivityWindow): number | null {
	return state.on && state.days !== null ? state.days : null;
}
