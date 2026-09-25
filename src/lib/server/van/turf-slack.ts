// Turf checkout over Slack: the gates, the lookups, and the reply.
//
// This is the Slack transport's equivalent of routes/turfs/+page.server.ts, and
// it exists as a module rather than as handlers in the two routes for one
// reason. The command produces a list; the buttons on that list produce another
// list, a claim, and a release. All four need the same gates, and plan.md
// records what happens when a second surface gets a weaker set of them: the
// map endpoint once had no rate limit, which made the page's chapter limiter
// decorative because a loop over `?chapter=` pulled the whole state unthrottled.
//
// So the gates live here, once:
//
//   1. Request budget      — the same shared counter the web API spends.
//   2. Blocklist           — van/access.ts, which gates READS as well as writes.
//   3. Chapter resolution  — always a point lookup, never a scan (see below).
//   4. Chapter rate limit  — the same shared counter the page spends.
//
// Slack supplies no session, so `isAdmin` is re-derived per request via
// isSlackAdmin(). It feeds visibleTurfState through toTurfView, so getting it
// wrong would ship holder names to volunteers; isSlackAdmin fails closed, which
// is the right default here.
//
// A note on chapter resolution: it is always a point lookup — the volunteer's
// own Solidarity chapter, or ZIP to chapter — and NEVER "which chapter has
// turf near this point". The latter would be the cross-chapter aggregate §3 of
// the plan forbids: one request revealing the shape of the whole field
// operation. Listing every chapter by name, as the picker does, is fine and is
// what the web page already does.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { zipChapterMap } from '../schema.js';
import { SLACK_SUPERUSER_ID, APP_URL } from '../env.js';
import { loadSettings, loadVanBlockedIds } from '../settings.js';
import { isSlackAdmin } from '../slack-admin.js';
import { displayName } from '../slack-display-name.js';
import { claimTurf, endClaim } from './checkout-store.js';
import { nudgePacketTracker, packetTrackerCheck } from './packet-tracker-live.js';
import { loadChapterTurfs } from './turf-query.js';
import { loadHoldingsFor } from './holdings-store.js';
import { isActive } from '../../van/checkout.js';
import { resolveLocation } from './zip-centroid.js';
import { profileRegionFor } from './turf-profile.js';
import {
	buildChapterPickerBlocks,
	buildClaimedBlocks,
	buildMineBlocks,
	buildTurfListBlocks,
	parseTurfArgument,
	plainMessage,
	SLACK_TURF_LIMIT,
	type ChapterRef,
	type LocationPrompt,
	type SlackMessage,
} from './turf-command.js';
import { turfAccess } from '../../van/access.js';
import { chaptersSeen, recordChapterView } from '../../van/chapter-rate-limit.js';
import { recordRequest } from '../../van/request-budget.js';
import { chapterVisits, pruneRateLimitStores, turfRequests } from './rate-limit-store.js';
import type { LatLng } from '../../van/geometry.js';
import { resolveClaimOptions, type ClaimOptions } from '../../van/checkout.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface TurfRequestContext {
	slackUserId: string;
	/** Raw text after the command — a ZIP or an address. When empty, and no
	 *  button supplied a chapter, the volunteer's Solidarity profile is asked. */
	argument?: string | null;
	/** From a button value; overrides everything else. */
	chapterId?: number;
	offset?: number;
	/** From a button value, so a paged list sorts the same way page one did. */
	location?: LatLng | null;
	now?: number;
}

/**
 * The turf list, or whatever should be shown instead of it.
 *
 * Every refusal comes back as a message rather than an exception: a volunteer
 * standing on a corner gets a sentence they can act on, and the caller has one
 * thing to post.
 */
export async function turfListMessage(db: Db, ctx: TurfRequestContext): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passGates(db, ctx, now);
	if (!gate.ok) return gate.message;
	return buildList(db, gate, ctx, now);
}

/**
 * The list, for a request that has already been through the gates.
 *
 * Separate from turfListMessage so claim and release can show the list again
 * after acting without re-running passGates — which would spend a second
 * request slot for a single button press, and re-geocode an address for no
 * reason.
 */
async function buildList(
	db: Db,
	gate: Extract<GateResult, { ok: true }>,
	ctx: TurfRequestContext,
	now: number,
): Promise<SlackMessage> {
	const { viewer, chapter, location, zip } = gate;
	if (!chapter) return buildChapterPickerBlocks(gate.chapters, APP_URL, gate.prompt);

	const offset = ctx.offset ?? 0;
	const { turfs, total, omitted, start, nextOffset, unavailable } = await loadChapterTurfs(db, {
		chapterId: chapter.chapterId,
		viewer,
		location,
		limit: SLACK_TURF_LIMIT,
		offset,
		includeHeldByViewer: true,
		// Five rows on a phone: spend them on turf the volunteer can act on.
		// Taken turf stays on the map, which every reply links to.
		claimableOnly: true,
		claimOptions: gate.claimOptions,
		now: new Date(now),
	});

	return buildTurfListBlocks({
		turfs,
		chapter,
		location,
		offset,
		start,
		nextOffset,
		omitted,
		total,
		unavailable,
		appUrl: APP_URL,
		zip,
	});
}

/** Claim a turf, then show the volunteer their list number. */
export async function claimFromSlack(
	db: Db,
	ctx: TurfRequestContext & { mapRouteId: number },
): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passGates(db, ctx, now);
	if (!gate.ok) return gate.message;
	if (!gate.chapter) return buildChapterPickerBlocks(gate.chapters, APP_URL, gate.prompt);

	const result = await claimTurf(db, {
		mapRouteId: ctx.mapRouteId,
		slackUserId: ctx.slackUserId,
		slackUserName: await displayName(ctx.slackUserId),
		now: new Date(now),
		options: gate.claimOptions,
		sheetCheck: packetTrackerCheck(db),
	});

	if (!result.ok) {
		// A refusal is a normal outcome, not an error — someone else got there
		// first, or the turf has no list number. Say why, then show the list
		// again so the volunteer can take a different one without retyping.
		return withNote(result.message, await buildList(db, gate, ctx, now));
	}

	// Read the turf back for its name and door count, SCOPED to the route just
	// claimed — without that filter this returns whichever turf sorts first in
	// the chapter, which is almost never the one in hand. Through
	// loadChapterTurfs rather than the raw row because that is the gate on what
	// a viewer may see, and now that the claim is in the ledger it reports this
	// turf as held-by-you.
	const { turfs } = await loadChapterTurfs(db, {
		chapterId: gate.chapter.chapterId,
		viewer: gate.viewer,
		mapRouteIds: [ctx.mapRouteId],
		limit: 1,
		includeHeldByViewer: true,
		claimOptions: gate.claimOptions,
		now: new Date(now),
	});
	const claimed = turfs.find((t) => t.mapRouteId === ctx.mapRouteId);

	console.log(`${LOG} slack claim: user=${ctx.slackUserId} route=${ctx.mapRouteId}`);
	nudgePacketTracker(db, ctx.mapRouteId);
	return buildClaimedBlocks({
		turf: {
			mapRouteId: ctx.mapRouteId,
			name: claimed?.name ?? `Turf ${ctx.mapRouteId}`,
			regionName: claimed?.regionName ?? '',
			doorsRemaining: claimed?.doorsRemaining ?? 0,
		},
		chapter: gate.chapter,
		printedListNumber: result.printedListNumber,
		expiresAt: result.expiresAt,
		now: new Date(now),
		appUrl: APP_URL,
		location: gate.location,
	});
}

/** Give turf back, then show the list again so the next one is a tap away. */
export async function releaseFromSlack(
	db: Db,
	ctx: TurfRequestContext & { mapRouteId: number },
): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passGates(db, ctx, now);
	if (!gate.ok) return gate.message;

	const result = await endClaim(db, {
		mapRouteId: ctx.mapRouteId,
		slackUserId: ctx.slackUserId,
		now: new Date(now),
		kind: 'release',
	});

	if (result.ok) nudgePacketTracker(db, ctx.mapRouteId);
	const note = result.ok
		? 'Given back. Thanks for saying so — someone else can take it now.'
		: result.message;
	return withNote(note, await buildList(db, gate, ctx, now));
}

/**
 * The turf this volunteer is holding, with its list numbers and its actions.
 *
 * Deliberately a LIGHTER gate than the nearby list — see passMineGate.
 */
export async function myTurfMessage(db: Db, ctx: TurfRequestContext): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passMineGate(db, ctx.slackUserId, now);
	if (gate) return gate;
	return renderMine(db, ctx.slackUserId, now);
}

/** The "my turf" list, for a request that has already been through the gate. */
async function renderMine(db: Db, slackUserId: string, now: number): Promise<SlackMessage> {
	return buildMineBlocks({
		turfs: await mineFor(db, slackUserId, now),
		now: new Date(now),
		appUrl: APP_URL,
	});
}

/**
 * Give turf back from the "my turf" list, then show that list again.
 *
 * Same write as `releaseFromSlack` and a different reply: you came from your
 * own holdings, so that is what you go back to. Redrawing the nearby list here
 * would answer a question nobody asked and lose your place.
 */
export async function releaseMineFromSlack(
	db: Db,
	ctx: TurfRequestContext & { mapRouteId: number },
): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passMineGate(db, ctx.slackUserId, now);
	if (gate) return gate;
	const result = await endClaim(db, {
		mapRouteId: ctx.mapRouteId,
		slackUserId: ctx.slackUserId,
		now: new Date(now),
		kind: 'release',
	});
	if (result.ok) nudgePacketTracker(db, ctx.mapRouteId);
	const note = result.ok
		? 'Given back. Thanks for saying so — someone else can take it now.'
		: result.message;
	return withNote(note, await renderMine(db, ctx.slackUserId, now));
}

/**
 * Mark turf walked from Slack.
 *
 * `endClaim` scopes the write to the caller's own active claim, so a forged
 * button value completes nothing that is not already theirs — the same
 * guarantee the release path leans on.
 *
 * The confirmation says what completing does NOT do. This action is the one a
 * volunteer is most likely to reach for INSTEAD of syncing, and the cost of
 * that mistake is a morning of doors that may never reach VAN — the unsynced
 * nudge (door-delta.ts) can only fire once VAN recounts the turf.
 */
export async function completeFromSlack(
	db: Db,
	ctx: TurfRequestContext & { mapRouteId: number; percent: number | null },
): Promise<SlackMessage> {
	const now = ctx.now ?? Date.now();
	const gate = await passMineGate(db, ctx.slackUserId, now);
	if (gate) return gate;
	const result = await endClaim(db, {
		mapRouteId: ctx.mapRouteId,
		slackUserId: ctx.slackUserId,
		now: new Date(now),
		kind: 'complete',
		// Required; endClaim refuses without it and says what to pick.
		reportedPercent: ctx.percent,
	});
	if (result.ok) nudgePacketTracker(db, ctx.mapRouteId);
	const note = result.ok
		? 'Marked walked. If MiniVAN has not synced yet, open it and hit *Sync* — ' +
			'your answers only reach VAN from there.'
		: result.message;
	return withNote(note, await renderMine(db, ctx.slackUserId, now));
}

/** The caller's live claims, newest expiry last.
 *
 *  `isActive` decides what counts as live rather than the query, because the
 *  expiry sweep runs on a cron: between ticks a lapsed claim is still unstamped
 *  in the table, and listing it would offer buttons for turf the volunteer no
 *  longer holds. */
async function mineFor(db: Db, slackUserId: string, now: number) {
	const rows = await loadHoldingsFor(db, slackUserId);
	const at = new Date(now);
	return rows
		.filter((row) =>
			isActive(
				{
					mapRouteId: row.mapRouteId,
					slackUserId,
					slackUserName: '',
					claimedAt: row.claimedAt,
					expiresAt: row.expiresAt,
					releasedAt: row.releasedAt,
					completedAt: row.completedAt,
				},
				at,
			),
		)
		.map((row) => ({
			mapRouteId: row.mapRouteId,
			name: row.turfName,
			regionName: row.regionName,
			doorCount: row.doorCount,
			expiresAt: row.expiresAt,
			chapterId: row.chapterId,
			issuedListNumber: row.issuedListNumber,
		}));
}

/** A sentence about what just happened, followed by the list again, so the next
 *  turf is one tap away rather than another `/turfs`. */
function withNote(note: string, list: SlackMessage): SlackMessage {
	return {
		text: note,
		blocks: [{ type: 'section', text: { type: 'mrkdwn', text: note } }, ...list.blocks],
	};
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

type GateResult =
	| { ok: false; message: SlackMessage }
	| {
			ok: true;
			viewer: { slackUserId: string; isAdmin: boolean };
			chapters: ChapterRef[];
			chapter: ChapterRef | null;
			location: LatLng | null;
			zip: string | null;
			/** Why a bare `/turfs` could not place the volunteer, when it could
			 *  not. Only ever set alongside `chapter: null`. */
			prompt?: LocationPrompt;
			/** How long a claim lasts and how many one volunteer may hold, as
			 *  configured on /settings. Carried on the gate because passGates is
			 *  the one place that reads settings: without it this file falls back
			 *  to the code defaults, and the same volunteer gets 48h/2 in Slack
			 *  while the web page gives them whatever the admin actually set. */
			claimOptions: ClaimOptions;
	  };

async function passGates(db: Db, ctx: TurfRequestContext, now: number): Promise<GateResult> {
	pruneRateLimitStores(now);

	// Admin status is resolved BEFORE the budget check, not after it as it used
	// to be. Admins are exempt from the budget, and a check that ran first could
	// only have refused them before knowing they were exempt. The cost is that a
	// request already over budget now does three lookups before being turned
	// away — cheap, and only on the path that is already being throttled.
	const [isAdmin, blockedIds, settings] = await Promise.all([
		isSlackAdmin(ctx.slackUserId),
		loadVanBlockedIds(db),
		loadSettings(db),
	]);
	const viewer = { slackUserId: ctx.slackUserId, isAdmin };
	const claimOptions = resolveClaimOptions({
		ttlHours: settings.vanTurfClaimTtlHours,
		maxConcurrentClaims: settings.vanTurfMaxConcurrentClaims,
	});

	// Counted against the same store the web API spends, so the budget follows
	// the user rather than the surface they came in through — and so does the
	// exemption, or an organizer would be throttled in Slack but not on the web.
	const budget = recordRequest(turfRequests, ctx.slackUserId, now, { exempt: isAdmin });
	if (!budget.allowed) {
		console.warn(`${LOG} turf request budget exhausted (slack): user=${ctx.slackUserId}`);
		return {
			ok: false,
			message: plainMessage('That is a lot of requests. Give it a minute and try again.'),
		};
	}

	const access = turfAccess(viewer, blockedIds, SLACK_SUPERUSER_ID);
	if (!access.allowed) return { ok: false, message: plainMessage(access.message) };

	const chapters: ChapterRef[] = settings.chapterChannelMap
		.map((entry) => ({ chapterId: entry.chapterId, name: entry.name }))
		.sort((a, b) => a.name.localeCompare(b.name));

	// What the volunteer typed wins. With nothing typed, and no chapter carried
	// in from a button, their own Solidarity profile says where they are.
	const argument = parseTurfArgument(ctx.argument);
	let resolved: Awaited<ReturnType<typeof resolveLocation>> = null;
	let profileZip: string | null = null;
	let profileChapterIds: number[] = [];
	let prompt: LocationPrompt | undefined;

	if (argument.kind !== 'none') {
		resolved = await resolveLocation(db, locationQuery(argument));
		if (!resolved) {
			return {
				ok: false,
				message: plainMessage(
					"I couldn't find that place. Try a ZIP code, or a fuller address like `100 N Main St, Ann Arbor MI`.",
				),
			};
		}
	} else if (ctx.chapterId === undefined) {
		const region = await profileRegionFor(db, ctx.slackUserId);
		if (!region) {
			prompt = 'no-profile';
		} else if (!region.zip && region.chapterIds.length === 0) {
			prompt = 'no-location';
		} else {
			prompt = 'unmatched';
			profileZip = region.zip;
			profileChapterIds = region.chapterIds;
			// Only for sorting nearest-first. A geocoder miss costs the sort, not
			// the list: the ZIP still resolves the chapter below.
			if (region.zip) resolved = await resolveLocation(db, region.zip);
		}
	}
	const location = resolved?.point ?? ctx.location ?? null;
	const zip = resolved?.zip ?? profileZip;

	const chapter = await resolveChapter(db, {
		explicitChapterId: ctx.chapterId,
		profileChapterIds,
		zip,
		chapters,
	});
	if (!chapter) {
		return { ok: true, viewer, chapters, chapter: null, location, zip, prompt, claimOptions };
	}

	// Same counter the page spends. Re-opening a chapter already seen this hour
	// is free, so paging and claiming within one county cost nothing.
	const limit = recordChapterView(chapterVisits, ctx.slackUserId, chapter.chapterId, now, {
		exempt: isAdmin,
	});
	if (!limit.allowed) {
		console.warn(
			`${LOG} chapter switch rate-limited (slack): user=${ctx.slackUserId} ` +
				`chapter=${chapter.chapterId} seen=${chaptersSeen(chapterVisits, ctx.slackUserId, now).join(',')}`,
		);
		return {
			ok: false,
			message: plainMessage('You have opened a lot of counties recently. Try again shortly.'),
		};
	}
	if (limit.shouldLog) {
		console.warn(
			`${LOG} wide chapter browsing (slack): user=${ctx.slackUserId} ` +
				`chapters=${limit.distinctChapters} seen=${chaptersSeen(chapterVisits, ctx.slackUserId, now).join(',')}`,
		);
	}

	return { ok: true, viewer, chapters, chapter, location, zip, claimOptions };
}

/**
 * The gate for everything on the "my turf" list: showing it, giving turf back
 * from it, and marking turf walked. Null when the request may go ahead,
 * otherwise the message to show instead. Runs BEFORE any write, so a blocked
 * or throttled volunteer changes nothing.
 *
 * Deliberately LIGHTER than passGates: no chapter to resolve, no location, no
 * chapter rate limit. Those exist to stop one request revealing the shape of
 * the field operation across chapters (see this file's header); this reads and
 * writes only rows that already belong to the caller, so there is nothing to
 * compartmentalise. Asking for a chapter would also be wrong in substance —
 * someone holding turf in two counties holds two turfs, and a command called
 * "mine" that showed one of them would be lying.
 *
 * The request budget and the blocklist still apply, the same as everywhere
 * else. A blocked volunteer has already had their turf released, so in
 * practice the block only shows them a sentence, but "blocked" gates reads as
 * well as writes (van/access.ts) and this surface should not be the exception
 * that discovers otherwise. One call spends one slot, like a web request —
 * the redraw after a write goes through renderMine, not back through here.
 */
async function passMineGate(
	db: Db,
	slackUserId: string,
	now: number,
): Promise<SlackMessage | null> {
	pruneRateLimitStores(now);
	const [isAdmin, blockedIds] = await Promise.all([
		isSlackAdmin(slackUserId),
		loadVanBlockedIds(db),
	]);

	const budget = recordRequest(turfRequests, slackUserId, now, { exempt: isAdmin });
	if (!budget.allowed) {
		console.warn(`${LOG} turf request budget exhausted (slack mine): user=${slackUserId}`);
		return plainMessage('That is a lot of requests. Give it a minute and try again.');
	}

	const access = turfAccess({ slackUserId, isAdmin }, blockedIds, SLACK_SUPERUSER_ID);
	return access.allowed ? null : plainMessage(access.message);
}

function locationQuery(argument: ReturnType<typeof parseTurfArgument>): string {
	return argument.kind === 'zip' ? argument.zip : argument.kind === 'address' ? argument.query : '';
}

/**
 * Which county the volunteer means.
 *
 * In order: a chapter from a button, the volunteer's own Solidarity chapters,
 * then the ZIP — typed, or from their profile. Membership beats the ZIP map
 * because the map is only a guess derived from where other members live.
 *
 * Every branch is a point lookup, and every answer is re-validated against the
 * chapter/channel map — including one that arrived in a button value, which
 * round-tripped through a client and is therefore untrusted. An id that is not
 * a real chapter resolves to nothing rather than probing the turf table.
 */
async function resolveChapter(
	db: Db,
	input: {
		explicitChapterId?: number;
		profileChapterIds: number[];
		zip: string | null;
		chapters: ChapterRef[];
	},
): Promise<ChapterRef | null> {
	const known = (id: number | undefined | null) =>
		id === undefined || id === null
			? null
			: (input.chapters.find((c) => c.chapterId === id) ?? null);

	const explicit = known(input.explicitChapterId);
	if (explicit) return explicit;

	for (const id of input.profileChapterIds) {
		const fromProfile = known(id);
		if (fromProfile) return fromProfile;
	}

	if (input.zip) {
		const fromZip = known(await chapterForZip(db, input.zip));
		if (fromZip) return fromZip;
	}

	return null;
}

/**
 * The chapter a ZIP belongs to, from the map the attendee sync builds.
 *
 * Sparse by nature — it is derived from where members live, so a ZIP nobody
 * has signed up from has no row. That is a miss, not a failure: the caller
 * asks the volunteer where they are instead.
 */
async function chapterForZip(db: Db, zip: string): Promise<number | null> {
	try {
		const [row] = await db
			.select({ chapterId: zipChapterMap.chapterId })
			.from(zipChapterMap)
			.where(eq(zipChapterMap.zipCode, zip));
		return row?.chapterId ?? null;
	} catch (err) {
		console.warn(`${LOG} zip→chapter lookup failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}
