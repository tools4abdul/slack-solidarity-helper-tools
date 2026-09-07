// Progress reporting for the long paginated Solidarity walks.
//
// The channel-vs-chapter page's first comparison of the day spends minutes
// reading the roster, and before this the admin had nothing to look at but a
// sentence asking them to wait. A walk registers itself here, updates as pages
// land, and /api/channel-chapter-diff/progress reads it back.
//
// State is module-global rather than per-request on purpose: the caches these
// walks fill are global too, so a second admin waiting on the same cold roster
// is genuinely waiting on this same walk and should see its progress.
//
// No DB, no HTTP, no imports — a walker can report from anywhere.

export interface WalkStep {
	/** Human sentence for the UI, e.g. "Reading the Solidarity roster". */
	label: string;
	/** Rows read so far. */
	fetched: number;
	/** Rows upstream says exist, or null when it won't say — the UI then shows
	 *  an indeterminate bar rather than inventing a denominator. */
	total: number | null;
	/** Unix ms this walk started. */
	startedAt: number;
}

const steps = new Map<string, WalkStep>();

/**
 * Register a walk and get back the reporter to call as pages land.
 *
 * `key` identifies the walk, so a second caller joining an in-flight walk
 * (the autocomplete caches de-duplicate concurrent fetches) overwrites rather
 * than stacking up a duplicate bar.
 */
export function startWalk(
	key: string,
	label: string,
): (fetched: number, total: number | null) => void {
	steps.set(key, { label, fetched: 0, total: null, startedAt: Date.now() });
	return (fetched, total) => {
		const step = steps.get(key);
		// Gone means finishWalk already ran — a late page report is not a reason
		// to resurrect a finished bar.
		if (!step) return;
		step.fetched = fetched;
		step.total = total;
	};
}

export function finishWalk(key: string): void {
	steps.delete(key);
}

/** Every walk running right now, oldest first, so the UI shows the one the
 *  admin has been waiting on longest at the top. */
export function listWalks(): WalkStep[] {
	return [...steps.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function _resetWalkProgressForTests(): void {
	steps.clear();
}
