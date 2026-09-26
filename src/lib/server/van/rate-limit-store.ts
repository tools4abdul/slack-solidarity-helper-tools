// The process-wide rate-limit state for turf checkout.
//
// It lives in its own module for one reason: the page load and the API routes
// MUST share it. When the chapter limiter lived as a module-level Map inside
// `+page.server.ts`, hitting `/api/turfs?chapter=N` in a loop bypassed it
// completely — the page was gated and the endpoint serving the same data was
// not, which made the gate decorative. A shared store is what makes "twelve
// chapters an hour" a property of the user rather than of the URL they picked.
//
// In memory, per machine, reset by a deploy. That would disqualify it as
// access control; it is not one (plan.md §3 is explicit that chapter scoping
// raises effort and leaves a trail rather than preventing access). What it
// buys is that enumeration is slow and noisy from RAM, with no table, no
// migration, and no write on the hottest read in the app. Moving it to Turso
// is a contained change — these two Maps are the only state.

import { pruneVisitLog, type VisitLog } from '$lib/van/chapter-rate-limit.js';
import { pruneRequestLog, type RequestLog } from '$lib/van/request-budget.js';

/** Distinct chapters each user has opened in the current hour. */
export const chapterVisits: VisitLog = new Map();

/** Turf API requests each user has made in the current minute. */
export const turfRequests: RequestLog = new Map();

// Both logs are self-trimming on read for the user being looked at, so this is
// only about users who stopped visiting entirely — without it a long-lived
// machine accumulates one entry per person who ever opened the page. Cheap
// enough to run inline rather than on a timer, which keeps it out of the way
// of tests and of a machine that is asleep.
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let lastPrune = 0;

/** Call at the top of any turf request. Prunes at most once every ten minutes. */
export function pruneRateLimitStores(now: number): void {
	if (now - lastPrune < PRUNE_EVERY_MS) return;
	lastPrune = now;
	pruneVisitLog(chapterVisits, now);
	pruneRequestLog(turfRequests, now);
}
