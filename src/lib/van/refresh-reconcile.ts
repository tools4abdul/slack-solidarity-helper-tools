// What a refresh did to the people already holding turf.
//
// Story 4.5 rejects blocking the volunteer page while VAN re-cuts a region, and
// the reason is worth restating because this module is the alternative: a page
// block would only protect volunteers who would have claimed *during* the
// refresh window, while the actual exposure spans the whole claim. Someone who
// claimed ten minutes before a refresh has exactly the same stale list number
// as someone who claims during it. So instead of freezing a page, we reconcile
// every live claim after every catalog read, for the whole life of the claim.
//
// Three things can have happened to a claim since it was issued:
//
//   1. **The list number changed.** VAN regenerated the printed list, so the
//      number the volunteer was given no longer loads in MiniVAN. DM the new one.
//   2. **The doors ran out.** The region was re-cut and the turf came back empty
//      — somebody walked it, or it merged into another cut. Release it and say so.
//   3. **The turf was re-cut out from under them.** Story 4.6, verified live: a
//      refresh does not renumber a route's contents, it RETIRES the route and
//      returns new ones with new ids and new saved lists. The catalog sync
//      releases the claim (it has to — the list number is dead), and this module
//      is what makes that survivable: pair the dead route to its replacement by
//      region and name, hand the volunteer the replacement, and tell them.
//
// Pure: no DB, no Slack, no clock of its own. The decisions and the wording are
// here and unit-tested; reconcile-store.ts does the rows and the sending.

/**
 * Doors remaining at which a claim is released as walked out.
 *
 * Zero, deliberately, and not a ratio. "Near zero" is tempting — release at 95%
 * cleared and free the turf sooner — but 95% cleared describes a volunteer who
 * is most of the way down the street and about to finish, and taking their turf
 * at that moment is precisely wrong. Zero doors is the one state where there is
 * provably nothing left for them to knock.
 */
export const WALKED_OUT_DOOR_COUNT = 0;

/**
 * How far back the re-cut notice looks.
 *
 * `recutNotifiedAt` is null on every row that predates the column, so without a
 * horizon the first sync after this ships would DM every volunteer whose turf
 * was ever retired — months of history, all of it stale. Anything older than
 * this is stamped silently instead. A day is comfortably longer than the sync's
 * half-hour cadence and shorter than anyone's memory of turf they held.
 */
export const RECUT_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The turf state a live claim is judged against. */
export interface ReconcileTurf {
	mapRouteId: number;
	mapRegionId: number;
	chapterId: number;
	name: string;
	regionName: string;
	printedListNumber: string | null;
	doorCount: number;
	retiredAt: string | null;
}

/** A live claim, with what we told its holder when we issued it. */
export interface ReconcileClaim {
	checkoutId: number;
	mapRouteId: number;
	slackUserId: string;
	slackUserName: string;
	issuedListNumber: string | null;
	turf: ReconcileTurf;
}

/** A claim the catalog sync released because VAN stopped returning its route. */
export interface RecutClaim {
	checkoutId: number;
	mapRouteId: number;
	slackUserId: string;
	slackUserName: string;
	releasedAt: string;
	turf: { mapRegionId: number; chapterId: number; name: string; regionName: string };
}

/** A route that could be the replacement for a re-cut one. */
export interface ReplacementTurf {
	mapRouteId: number;
	mapRegionId: number;
	name: string;
	printedListNumber: string | null;
	doorCount: number;
	retiredAt: string | null;
	/** True when somebody already holds it. A replacement someone else has
	 *  taken is not a replacement. */
	claimed: boolean;
}

export type ReconcileAction =
	/** Record the number we already gave them. No DM: see `issuedListNumber` in
	 *  schema.ts — a null means we have nothing to correct, not that something
	 *  changed. */
	| { kind: 'adopt-list-number'; checkoutId: number; listNumber: string }
	| {
			kind: 'list-number-changed';
			checkoutId: number;
			slackUserId: string;
			listNumber: string;
			text: string;
	  }
	| { kind: 'walked-out'; checkoutId: number; slackUserId: string; text: string }
	/** The claim is live on a route VAN has retired. Released without a DM here:
	 *  the release is what turns it into a `RecutClaim`, and the next pass says
	 *  the one thing worth saying, once. */
	| { kind: 'release-retired'; checkoutId: number }
	| {
			kind: 'recut-replaced';
			checkoutId: number;
			slackUserId: string;
			slackUserName: string;
			replacement: ReplacementTurf;
			text: string;
	  }
	| { kind: 'recut-gone'; checkoutId: number; slackUserId: string; text: string }
	/** Older than the notice horizon. Stamped so it is never looked at again. */
	| { kind: 'recut-stale'; checkoutId: number };

export interface ReconcileInput {
	/** Every claim that is currently live, with its turf. */
	claims: readonly ReconcileClaim[];
	/** Claims released with reason 'retired' that nobody has been told about. */
	recut: readonly RecutClaim[];
	/** Unretired routes, for pairing a re-cut claim to its replacement. Scoped
	 *  by the caller to the regions in `recut`; passing the whole catalog would
	 *  work and would read the whole table on every tick. */
	replacements: readonly ReplacementTurf[];
	now: Date;
	appUrl: string;
	recutMaxAgeMs?: number;
}

/** Loose name match, in the shape catalog.ts uses for the same job: casing and
 *  inner whitespace drift as organizers rename turf, and a pairing that missed
 *  because of a double space would cost a volunteer their block. */
function nameKey(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function turfLine(name: string, regionName: string, doors: number): string {
	const where = regionName ? ` — ${regionName}` : '';
	return `*${name}*${where} · ${doors.toLocaleString('en-US')} doors`;
}

function turfLink(appUrl: string, chapterId: number): string {
	return `<${appUrl}/turfs?chapter=${chapterId}|Open turf checkout>`;
}

/**
 * The DM when a printed list number changes under a live claim.
 *
 * Leads with the number, because that is the entire actionable content and a
 * volunteer reading this on a doorstep should not have to parse a paragraph to
 * find it. Says what to do with it in MiniVAN, and does not apologise: VAN
 * regenerating a list is normal campaign housekeeping, not a fault.
 */
export function renderListNumberChanged(input: {
	turf: ReconcileTurf;
	listNumber: string;
	appUrl: string;
}): string {
	const { turf, listNumber, appUrl } = input;
	return [
		':arrows_counterclockwise: *Your turf has a new MiniVAN list number.*',
		'',
		turfLine(turf.name, turf.regionName, turf.doorCount),
		`New list number: *${listNumber}*`,
		'',
		'VAN regenerated the printed list for this turf, so the number you were given no longer ' +
			'loads. Enter the new one in MiniVAN — the turf is still yours.',
		turfLink(appUrl, turf.chapterId),
	].join('\n');
}

/** The DM when a refresh leaves a claimed turf with no doors in it. */
export function renderWalkedOut(input: { turf: ReconcileTurf; appUrl: string }): string {
	const { turf, appUrl } = input;
	const where = turf.regionName ? ` — ${turf.regionName}` : '';
	return [
		':white_check_mark: *That turf is done — no doors left in it.*',
		'',
		`*${turf.name}*${where}`,
		'',
		"VAN re-cut the area and this turf came back empty, so it's been checked back in for you. " +
			"If you walked it, thank you — nothing else to do. If you didn't, someone else got there " +
			'first.',
		turfLink(appUrl, turf.chapterId),
	].join('\n');
}

/**
 * The DM when a re-cut replaced the turf and we moved the claim across.
 *
 * The replacement is held for them rather than dropped back in the pool. A
 * volunteer standing on a street they were assigned an hour ago should not lose
 * it to whoever refreshes the page first, and the checkout ledger exists to stop
 * exactly that collision — so the reconciliation keeps the claim and swaps what
 * it points at.
 */
export function renderRecutReplaced(input: {
	oldName: string;
	replacement: ReplacementTurf;
	regionName: string;
	chapterId: number;
	appUrl: string;
}): string {
	const { oldName, replacement, regionName, chapterId, appUrl } = input;
	const number = replacement.printedListNumber;
	return [
		':arrows_counterclockwise: *VAN re-cut your turf.*',
		'',
		turfLine(replacement.name, regionName, replacement.doorCount),
		number ? `New list number: *${number}*` : 'It has no MiniVAN list number yet.',
		'',
		`${oldName} was re-cut against current data, which in VAN means the old turf was replaced ` +
			'rather than updated. The new cut is checked out to you and the doors you already ' +
			'knocked are no longer in it.',
		number
			? 'Enter the new list number in MiniVAN before you carry on.'
			: 'Ask an organizer to generate its printed list before you carry on.',
		turfLink(appUrl, chapterId),
	].join('\n');
}

/** The DM when a re-cut left nothing we can hand back. */
export function renderRecutGone(input: {
	turf: { name: string; regionName: string; chapterId: number };
	appUrl: string;
}): string {
	const { turf, appUrl } = input;
	const where = turf.regionName ? ` in ${turf.regionName}` : '';
	return [
		':warning: *The turf you were holding no longer exists in VAN.*',
		'',
		`*${turf.name}*${where}`,
		'',
		'It was re-cut or archived, which releases your checkout — the list number you had will ' +
			'not load any more. Nothing you knocked is lost; MiniVAN already synced it. Take a ' +
			'fresh turf when you are ready.',
		turfLink(appUrl, turf.chapterId),
	].join('\n');
}

/**
 * Pair a re-cut claim to the route that replaced it.
 *
 * By region and name, because Story 4.6 established there is no id in common:
 * the refresh retires `mapRouteId` 56456 and returns 56502. Name is only a
 * convention — VAN's re-cut happens to reuse "City of Cambridge Turf 01" — so
 * this is deliberately strict rather than clever:
 *
 *   - the candidate must be in the same map region,
 *   - its name must match once normalised,
 *   - it must not be retired,
 *   - nobody else may hold it,
 *   - and the match must be UNIQUE. Two candidates means we cannot tell which
 *     piece of ground the volunteer was on, and handing them the wrong one puts
 *     two people on the same block — the failure this whole feature exists to
 *     prevent. Ambiguity falls back to "your turf is gone", which is honest.
 */
export function findReplacement(
	claim: RecutClaim,
	replacements: readonly ReplacementTurf[],
): ReplacementTurf | null {
	const key = nameKey(claim.turf.name);
	const matches = replacements.filter(
		(r) =>
			r.mapRegionId === claim.turf.mapRegionId &&
			r.retiredAt === null &&
			!r.claimed &&
			r.mapRouteId !== claim.mapRouteId &&
			nameKey(r.name) === key,
	);
	return matches.length === 1 ? matches[0] : null;
}

/**
 * Everything the reconciliation should do this tick.
 *
 * Ordered by precedence per claim, and the order is the interesting part:
 *
 *   1. **Retired beats everything.** A live claim on a route VAN no longer has
 *      is released here, and the re-cut notice picks it up on the next pass. A
 *      new list number on a dead route is not worth a DM.
 *   2. **Walked out beats a number change.** If there are no doors left, the
 *      number is moot; one message that says "this is finished" is better than
 *      two that disagree about whether the volunteer still has work to do.
 *   3. **Adopt beats notify.** A claim with no record of what it was issued has
 *      nothing to correct — see `issuedListNumber` in schema.ts.
 */
export function planReconciliation(input: ReconcileInput): ReconcileAction[] {
	const { claims, recut, replacements, now, appUrl } = input;
	const recutMaxAgeMs = input.recutMaxAgeMs ?? RECUT_NOTICE_MAX_AGE_MS;
	const actions: ReconcileAction[] = [];

	for (const claim of claims) {
		const turf = claim.turf;

		if (turf.retiredAt !== null) {
			actions.push({ kind: 'release-retired', checkoutId: claim.checkoutId });
			continue;
		}

		if (turf.doorCount <= WALKED_OUT_DOOR_COUNT) {
			actions.push({
				kind: 'walked-out',
				checkoutId: claim.checkoutId,
				slackUserId: claim.slackUserId,
				text: renderWalkedOut({ turf, appUrl }),
			});
			continue;
		}

		// A turf whose printed list has gone missing is deliberately NOT a
		// notification. The volunteer already has the number and MiniVAN already
		// has their doors, so nothing about their walk has changed; meanwhile
		// there is no stamp that could make such a DM idempotent, so it would
		// repeat on every tick until VAN regenerated the list. It shows up in the
		// sync's counts instead.
		if (turf.printedListNumber === null) continue;

		if (claim.issuedListNumber === null) {
			actions.push({
				kind: 'adopt-list-number',
				checkoutId: claim.checkoutId,
				listNumber: turf.printedListNumber,
			});
			continue;
		}

		if (claim.issuedListNumber !== turf.printedListNumber) {
			actions.push({
				kind: 'list-number-changed',
				checkoutId: claim.checkoutId,
				slackUserId: claim.slackUserId,
				listNumber: turf.printedListNumber,
				text: renderListNumberChanged({ turf, listNumber: turf.printedListNumber, appUrl }),
			});
		}
	}

	for (const claim of recut) {
		const releasedMs = Date.parse(claim.releasedAt);
		const tooOld = Number.isNaN(releasedMs) || now.getTime() - releasedMs > recutMaxAgeMs;
		if (tooOld) {
			actions.push({ kind: 'recut-stale', checkoutId: claim.checkoutId });
			continue;
		}

		const replacement = findReplacement(claim, replacements);
		if (replacement) {
			actions.push({
				kind: 'recut-replaced',
				checkoutId: claim.checkoutId,
				slackUserId: claim.slackUserId,
				slackUserName: claim.slackUserName,
				replacement,
				text: renderRecutReplaced({
					oldName: claim.turf.name,
					replacement,
					regionName: claim.turf.regionName,
					chapterId: claim.turf.chapterId,
					appUrl,
				}),
			});
			continue;
		}

		actions.push({
			kind: 'recut-gone',
			checkoutId: claim.checkoutId,
			slackUserId: claim.slackUserId,
			text: renderRecutGone({ turf: claim.turf, appUrl }),
		});
	}

	return actions;
}
