// Format a millisecond delta as a coarse human-readable "ago" label for the
// `/settings` page's "Last refreshed Nm ago" indicator (NAV-3, FR-008).
//
// The breakpoints are intentionally coarse — admins don't need second-level
// precision on cache age, they need to know whether to click "Refresh lists".
// See specs/007-settings-shell-primitives/research.md#R3 for the rationale.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelative(deltaMs: number): string {
	// Negative deltas (clock skew between server and client) are clamped to 0
	// rather than rendered as "in N minutes" — the indicator is past-only.
	const ms = Math.max(0, deltaMs);
	if (ms < MIN_MS) return 'just now';
	if (ms < HOUR_MS) return `${Math.floor(ms / MIN_MS)}m ago`;
	if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
	const days = Math.floor(ms / DAY_MS);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * `formatRelative` for an ISO timestamp, against an EXPLICIT `now`.
 *
 * `now` is a required parameter rather than a `Date.now()` inside this function,
 * and that is the whole point of it existing.
 *
 * The turf pages each had a local `ago()` helper that called `Date.now()` while
 * rendering. On the server that stamps the server's clock into the SSR markup;
 * on hydration the browser recomputes with its own, later clock, and the two
 * disagree — a hydration mismatch on every row carrying one. The turf activity
 * loader's own header already says timestamps are formatted server-side to avoid
 * exactly this, so the helpers were working against the rule the file next to
 * them states.
 *
 * Taking `now` from the caller means a loader passes the single `Date` it already
 * uses for the rest of its query, so every label on a page describes one instant
 * and SSR is reproducible. A component *can* still call this, but it has to
 * source a `now` deliberately rather than reach for the wall clock by accident.
 *
 * Returns '' for an unparseable timestamp rather than 'NaN days ago' — a missing
 * label reads as "no data", which is true, where NaN reads as a bug.
 *
 * One consequence worth naming: a server-rendered relative label is only as
 * fresh as the page load, so "5m ago" on a tab left open all morning is stale.
 * That is the same trade the absolute labels beside it already make, and the fix
 * for both is reloading the page, not drifting back to a render-time clock.
 */
export function relativeSince(iso: string, now: Date): string {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? '' : formatRelative(now.getTime() - ms);
}
