// How old the door counts on a page are, and how to say it.
//
// Story 4.3 in one module: a volunteer reads one age and applies it to every
// number in front of them, so the age quoted has to be the WORST one on the
// page. Quoting the freshest would say "12 minutes ago" over a list where half
// the counts are two days old, and a volunteer who walks a turf on stale counts
// finds knocked doors and stops trusting the tool.
//
// Extracted because two surfaces answer the same question — the turf page and
// the `/turfs` Slack command — and they had already drifted: one took the first
// row's age and called it the freshest, the other took the oldest and rendered
// it with a different set of words. Same reason turf-query.ts exists.

/** Just enough of a TurfView to age it. */
export interface AgeableTurf {
	refreshedMinutesAgo: number | null;
}

/**
 * The most stale refresh across a page of turf, in minutes.
 *
 * Null when nothing on the page has ever been refreshed — a state to say out
 * loud rather than to render as zero, which would read as "just now".
 */
export function oldestRefreshMinutes(turfs: readonly AgeableTurf[]): number | null {
	let oldest: number | null = null;
	for (const turf of turfs) {
		if (turf.refreshedMinutesAgo === null) continue;
		if (oldest === null || turf.refreshedMinutesAgo > oldest) oldest = turf.refreshedMinutesAgo;
	}
	return oldest;
}

/**
 * An age in words.
 *
 * Rolls up to days past 48 hours. Without that, a count last refreshed on
 * Monday reads as "72 hours ago" on Thursday, which is technically true and
 * makes nobody reach for the right instinct — which is to distrust it.
 */
export function describeAge(minutes: number | null): string {
	// Phrased to sit inside "…as of ___", which is how both callers use it.
	if (minutes === null) return 'an unknown time';
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}
