// How far the turf-shape pipeline has got.
//
// A turf's shape is not something VAN hands over (plan.md §2 Constraint A): it
// is derived, one export job per turf, by the geometry worker. A statewide cut
// is thousands of turfs, so the first drain after a big sync takes a day of
// scheduled runs — during which the map is honestly a mix of shapes and pins,
// and the only question anyone asks is "is it still working?".
//
// Pure. The counts come from the caller (a DB query on the server, a script's
// own read); the wording lives here so the organizer page and the CLI say the
// same thing about the same numbers.

export interface GeometryProgress {
	/** Live turfs that could have a shape — a saved list to export. */
	eligible: number;
	/** Turfs with a hull polygon stored. */
	shaped: number;
	/** Turfs with a centroid but no usable hull: fewer than three points, or
	 *  collinear ones. A success — the map draws a pin — not a failure. */
	centroidOnly: number;
	/** Queue rows still to run, including the ones mid-flight. */
	pending: number;
	/** Queue rows that gave up after MAX_ATTEMPTS. */
	failed: number;
}

/** Turfs with neither a hull nor a centroid, and no queue row left to make one
 *  — the ones that will stay pins until something changes. */
export function unshapedForever(progress: GeometryProgress): number {
	const accounted = progress.shaped + progress.centroidOnly + progress.pending + progress.failed;
	return Math.max(0, progress.eligible - accounted);
}

/** Whole percent shaped, 0 when nothing is eligible. Floors, so it only reads
 *  100% when every eligible turf really has a shape. */
export function percentShaped(progress: GeometryProgress): number {
	if (progress.eligible <= 0) return 0;
	return Math.floor((progress.shaped / progress.eligible) * 100);
}

/**
 * One line an organizer can read without knowing what a hull is.
 *
 * Deliberately says "drawing" rather than "queued" while work remains: the
 * pending count is the reason the map looks half-finished, and naming it is
 * what stops it reading as a bug.
 */
export function geometryProgressLabel(progress: GeometryProgress): string {
	if (progress.eligible === 0) return 'No turf is waiting for a shape.';

	const n = (value: number) => value.toLocaleString('en-US');
	const parts = [`${n(progress.shaped)} of ${n(progress.eligible)} turfs mapped as shapes`];

	if (progress.pending > 0) parts.push(`${n(progress.pending)} still drawing`);
	if (progress.centroidOnly > 0) parts.push(`${n(progress.centroidOnly)} too small to outline`);
	if (progress.failed > 0) parts.push(`${n(progress.failed)} failed`);

	const rest = unshapedForever(progress);
	if (rest > 0) parts.push(`${n(rest)} not queued`);

	const summary = parts.join(' · ');
	return progress.pending > 0 ? `${summary}. The rest fill in as the sync runs.` : `${summary}.`;
}
