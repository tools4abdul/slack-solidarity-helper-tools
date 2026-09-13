// Projects the doors that will be cleared between now and the countdown
// deadline: the recent daily pace extrapolated over the knock-time remaining.
// This is the incremental figure the banner promises ("~N more doors between
// today and when the timer hits 0"), so it deliberately does NOT include the
// doors already cleared.
//
// Pace = mean of the last PROJECTION_WINDOW_DAYS days that had any completions.
// Days with no completions at all are absent rather than zero, so a week off
// does not drag the pace to nothing — which is the right behaviour for a
// campaign that canvasses at weekends, and the opposite of what the Openfield
// version did (it recorded a row per code every night, so quiet days counted).
// Worth knowing when reading the number: it is a pace per ACTIVE day.
//
// The day totals it reads now come from the checkout ledger (doors-store.ts);
// this file is only the arithmetic, and takes them as an argument.

/** One campaign day's doors cleared. */
export interface DoorsDayTotal {
	date: string;
	total: number;
}

export const PROJECTION_WINDOW_DAYS = 7;

/** The recent pace times the (fractional) canvassing days until `endAtMs` —
 *  i.e. the *additional* doors expected between `nowMs` and the deadline, NOT
 *  including the doors already cleared. The pace is per CANVASSING day (each
 *  total is a whole day's completions), so the remaining time counts only
 *  door-knocking hours (8 am – 9 pm America/Detroit) rather than assuming 24/7
 *  knocking. Null when there's no data to extrapolate from or the deadline is
 *  invalid/already passed. */
export function projectDoorsAtDeadline(
	dayTotals: DoorsDayTotal[],
	endAtMs: number,
	nowMs: number,
): number | null {
	if (dayTotals.length === 0) return null;
	if (!Number.isFinite(endAtMs) || endAtMs <= nowMs) return null;

	const window = dayTotals.slice(-PROJECTION_WINDOW_DAYS);
	const dailyPace = window.reduce((sum, d) => sum + d.total, 0) / window.length;

	const remainingCanvassDays = knockableMsBetween(nowMs, endAtMs) / KNOCK_DAY_MS;
	return Math.round(dailyPace * remainingCanvassDays);
}

// Door-knocking hours: 8 am – 9 pm campaign-local (America/Detroit).
export const KNOCK_START_HOUR = 8;
export const KNOCK_END_HOUR = 21;
export const KNOCK_DAY_MS = (KNOCK_END_HOUR - KNOCK_START_HOUR) * 3_600_000;

const DAY_MS = 86_400_000;

function detroitMsOfDay(ms: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Detroit',
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(ms));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	// hour12:false can render midnight as "24" in some ICU versions.
	return (get('hour') % 24) * 3_600_000 + get('minute') * 60_000 + get('second') * 1_000;
}

/** Milliseconds of door-knocking time (8 am – 9 pm America/Detroit) between
 *  two instants. Walks local days assuming a fixed 24 h length — the two DST
 *  transition days a year are off by ≤1 h, immaterial for a "~" estimate. */
export function knockableMsBetween(startMs: number, endMs: number): number {
	const windowStart = KNOCK_START_HOUR * 3_600_000;
	const windowEnd = KNOCK_END_HOUR * 3_600_000;
	let total = 0;
	let cursor = startMs;
	// Iteration cap well beyond any realistic countdown horizon.
	for (let i = 0; cursor < endMs && i < 3_000; i++) {
		const msOfDay = detroitMsOfDay(cursor);
		if (msOfDay < windowEnd) {
			const knockStart = cursor + Math.max(0, windowStart - msOfDay);
			const knockEnd = cursor + (windowEnd - msOfDay);
			total += Math.max(0, Math.min(knockEnd, endMs) - knockStart);
		}
		cursor += DAY_MS - msOfDay; // next local midnight
	}
	return total;
}
