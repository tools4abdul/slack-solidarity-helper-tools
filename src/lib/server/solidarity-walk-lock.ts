// One Solidarity paginated walk at a time, process-wide.
//
// Every long walk in the app — the roster, the activity collections, the
// per-person activity lookups — is paced at ~1.67 requests/second to sit under
// Solidarity's 60-per-30s ceiling. That budget is only safe if exactly one walk
// is running: two at once put us at ~3.3/s, which earns 429s, drains
// `fetchWithRetry`'s shared retry budget, and aborts a walk that was minutes in.
//
// Concurrent walks are easy to trigger without meaning to — the comparison page
// fires a fresh request whenever an admin changes the window or the chapter,
// and the browser abandoning the old response does not stop the server working
// on it. So walks queue here instead of racing.
//
// Queued, not rejected: a caller that waits usually finds the cache warm by the
// time its turn comes and does no work at all. Callers are expected to
// re-check their cache after acquiring the lock for exactly that reason.

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` once every previously queued walk has settled.
 *
 * A predecessor's failure must not stop the queue, so the chain continues on
 * both outcomes; `fn`'s own rejection still propagates to its caller.
 */
export function withSolidarityWalkLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = tail.then(fn, fn);
	// The queue tracks completion only — never the value or the error, so a
	// rejection here can't surface as an unhandled one.
	tail = run.then(
		() => {},
		() => {},
	);
	return run;
}

export function _resetWalkLockForTests(): void {
	tail = Promise.resolve();
}
