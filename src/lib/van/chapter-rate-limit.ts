// How often one person may switch which chapter's turf they are looking at.
//
// The chapter picker is open by design — volunteers regularly canvass outside
// the county they live in, so gating on their Solidarity home chapter would
// lock out exactly the people travelling to help. The cost of that openness is
// that anyone patient can page through every county and reconstruct the whole
// field picture.
//
// This does not stop them, and is not meant to. It makes enumeration slow and
// noisy instead of a loop: a handful of switches an hour is generous for
// someone actually canvassing and useless for someone scraping, and every
// refusal is a log line with a Slack user id on it. Compartmentalisation, not
// access control — see plan.md §3, which is explicit that this is the
// distinction.
//
// What is counted is new TURF, not new chapter ids. A VAN folder can be mapped
// to several chapters (chapter-visibility.ts), and then those chapters show the
// same turf: a volunteer typing ZIPs across three counties that share one
// regional list was spending three slots to see one list, and hit the limit
// having revealed almost nothing. A chapter whose folders are all ones the user
// has already seen this window is therefore free. A chapter with at least one
// folder they have not seen costs a slot, however much of it overlaps.
//
// Pure apart from the store it is handed, so the window arithmetic is testable
// without a clock or a database.

/**
 * Chapters showing new turf one user may open per window.
 *
 * Was eight, back when every chapter id cost a slot. Twelve now that a slot is
 * only spent on turf not already seen: still a handful of switches an hour for
 * a scraper, and room for a volunteer checking the counties around a canvass.
 */
export const MAX_CHAPTER_SWITCHES = 12;
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * Charged chapters in a window before a view is worth a log line.
 *
 * Counted the same way as the limit: a chapter showing only folders already
 * seen adds nothing to it, because it revealed nothing new.
 *
 * Logging every chapter view produced a line each time a volunteer opened
 * their own county — which is most of the traffic, carries no information, and
 * buries the handful of lines that matter. One or two chapters is what using
 * the feature looks like; four in an hour is not, and that is where the log
 * starts.
 *
 * What this trades away, stated plainly: someone who paces themselves under
 * the threshold and waits out each window can browse invisibly, at three
 * chapters an hour. The rate limit above still caps them at twelve, so this
 * buys quiet at the cost of catching only the impatient. That is the right
 * trade for a compartment that §3 already calls effort-raising rather than
 * access control — but it is a trade, not a free win.
 */
export const CHAPTER_LOG_THRESHOLD = 4;

export interface ChapterVisit {
	chapterId: number;
	at: number;
	/** The VAN folders this chapter showed. Null when the caller did not say,
	 *  which makes the visit its own turf: it covers nothing else. */
	folderIds: number[] | null;
	/** Whether this visit spent a slot. False when every folder it showed had
	 *  already been seen through another chapter in the window. */
	charged: boolean;
}

export type VisitLog = Map<string, ChapterVisit[]>;

export interface RateLimitDecision {
	allowed: boolean;
	/** Seconds until the oldest CHARGED visit falls out of the window — a free
	 *  one ageing out frees no slot. Only meaningful when `allowed` is false;
	 *  it is what the page tells the volunteer. */
	retryAfterSeconds: number;
	/** How many chapters this user has spent a slot on in the window, counting
	 *  this one. Chapters that only showed turf already seen are not included.
	 *  In the log line so a single entry carries what a run of them used to. */
	chargedChapters: number;
	/** True when this view is worth recording: a chapter that cost a slot,
	 *  and enough of them this window to be unusual. Computed
	 *  here rather than in the route so the threshold is testable and the two
	 *  callers cannot disagree about it. */
	shouldLog: boolean;
}

/**
 * Record a chapter view and say whether it was allowed.
 *
 * Re-opening a chapter you already looked at this window is free. That matters
 * more than it sounds: a volunteer refreshing their own county's page, or
 * bouncing between the map and a claim, is not enumerating anything, and a
 * limiter that counted page views would throttle the one person using the
 * feature properly while barely inconveniencing a script.
 */
export interface ChapterViewOptions {
	/** Never refuse this viewer. Admins are exempt, because the compartment
	 *  this enforces does not apply to them: `/turfs/organizer` and the drift
	 *  report already show every chapter at once, by design and without a
	 *  limiter. Capping the map at a dozen counties an hour therefore withheld
	 *  nothing an admin could not read on the next page over, while breaking
	 *  the one job — checking turf across a state on launch night — that needs
	 *  to move faster than a volunteer ever would.
	 *
	 *  Views are still RECORDED and still cross `CHAPTER_LOG_THRESHOLD`, so an
	 *  admin sweeping every county remains visible in the log. Removing the
	 *  throttle is not the same as removing the audit trail, and an insider is
	 *  exactly who that line is for. */
	exempt?: boolean;
	/** The VAN folders the chapter maps to. When every one of them has already
	 *  been seen this window, the view is free. Omitted, the chapter is treated
	 *  as showing turf nothing else does — the stricter reading, so a caller
	 *  that forgets to pass it throttles too much rather than too little.
	 *
	 *  An empty list is free: a chapter with no folders mapped shows no turf
	 *  (chapter-visibility.ts), so opening it reveals nothing. */
	folderIds?: number[];
}

export function recordChapterView(
	log: VisitLog,
	slackUserId: string,
	chapterId: number,
	now: number,
	options: ChapterViewOptions = {},
): RateLimitDecision {
	const cutoff = now - WINDOW_MS;
	const recent = (log.get(slackUserId) ?? []).filter((v) => v.at > cutoff);
	const charged = () => recent.filter((v) => v.charged).length;

	const seen = recent.find((v) => v.chapterId === chapterId);
	if (seen) {
		// Refresh the timestamp so an active session doesn't age out of its own
		// chapter and get charged for it again.
		seen.at = now;
		log.set(slackUserId, recent);
		// Never logged. Re-opening a chapter you are already working in is the
		// single most common request this page serves.
		return {
			allowed: true,
			retryAfterSeconds: 0,
			chargedChapters: charged(),
			shouldLog: false,
		};
	}

	// Free when it shows nothing new. Folders from free visits count as seen
	// too: the user did see them, whichever chapter they came through.
	const folderIds = options.folderIds ?? null;
	const seenFolders = new Set(recent.flatMap((v) => v.folderIds ?? []));
	if (folderIds && folderIds.every((id) => seenFolders.has(id))) {
		recent.push({ chapterId, at: now, folderIds, charged: false });
		log.set(slackUserId, recent);
		return {
			allowed: true,
			retryAfterSeconds: 0,
			chargedChapters: charged(),
			// Nothing new was revealed, so nothing new to say about breadth.
			shouldLog: false,
		};
	}

	// Exempt viewers fall through to the push below, so their visit is counted
	// and `chargedChapters` keeps climbing — which is what makes the
	// wide-browsing log line still fire for an admin.
	const chargedVisits = recent.filter((v) => v.charged);
	if (!options.exempt && chargedVisits.length >= MAX_CHAPTER_SWITCHES) {
		log.set(slackUserId, recent);
		// Only a charged visit ageing out frees a slot, so that is the wait.
		const oldest = Math.min(...chargedVisits.map((v) => v.at));
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
			chargedChapters: chargedVisits.length,
			// The refusal is logged by the caller regardless — a rate-limited
			// request is always worth a line.
			shouldLog: false,
		};
	}

	recent.push({ chapterId, at: now, folderIds, charged: true });
	log.set(slackUserId, recent);
	const count = chargedVisits.length + 1;
	return {
		allowed: true,
		retryAfterSeconds: 0,
		chargedChapters: count,
		shouldLog: count >= CHAPTER_LOG_THRESHOLD,
	};
}

/** Chapters this user has opened in the current window, oldest first. Used to
 *  make one log line as informative as the run of lines it replaces.
 *
 *  Every chapter opened, including ones that cost nothing, so this can be
 *  longer than `chargedChapters`: the log line should say which chapters were
 *  looked at, not only which ones counted. */
export function chaptersSeen(log: VisitLog, slackUserId: string, now: number): number[] {
	const cutoff = now - WINDOW_MS;
	return (log.get(slackUserId) ?? [])
		.filter((v) => v.at > cutoff)
		.sort((a, b) => a.at - b.at)
		.map((v) => v.chapterId);
}

/** Drop users whose visits have all aged out, so a long-running process does
 *  not accumulate one entry per person who ever used the page. */
export function pruneVisitLog(log: VisitLog, now: number): void {
	const cutoff = now - WINDOW_MS;
	for (const [user, visits] of log) {
		const recent = visits.filter((v) => v.at > cutoff);
		if (recent.length === 0) log.delete(user);
		else log.set(user, recent);
	}
}
