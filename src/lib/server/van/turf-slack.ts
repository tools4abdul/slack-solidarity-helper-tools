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
// A note on chapter resolution: it is always a single lookup against a mapping
// table — channel to chapter, or ZIP to chapter — and NEVER "which chapter has
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
import { loadChapterTurfs } from './turf-query.js';
import { resolveLocation } from './zip-centroid.js';
import {
	buildChapterPickerBlocks,
	buildClaimedBlocks,
	buildTurfListBlocks,
	parseTurfArgument,
	plainMessage,
	SLACK_TURF_LIMIT,
	type ChapterRef,
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
	/** Where the command was typed. Resolves the chapter when nothing else does. */
	channelId?: string | null;
	/** Raw text after the command — a ZIP or an address. */
	argument?: string | null;
	/** From a button value; overrides the channel. */
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
	if (!chapter) return buildChapterPickerBlocks(gate.chapters, APP_URL);

	const offset = ctx.offset ?? 0;
	const { turfs, total, omitted } = await loadChapterTurfs(db, {
		chapterId: chapter.chapterId,
		viewer,
		location,
		limit: SLACK_TURF_LIMIT,
		offset,
		includeHeldByViewer: true,
		claimOptions: gate.claimOptions,
		now: new Date(now),
	});

	return buildTurfListBlocks({
		turfs,
		chapter,
		location,
		offset,
		omitted,
		total,
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
	if (!gate.chapter) return buildChapterPickerBlocks(gate.chapters, APP_URL);

	const result = await claimTurf(db, {
		mapRouteId: ctx.mapRouteId,
		slackUserId: ctx.slackUserId,
		slackUserName: await displayName(ctx.slackUserId),
		now: new Date(now),
		options: gate.claimOptions,
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

	const note = result.ok
		? 'Given back. Thanks for saying so — someone else can take it now.'
		: result.message;
	return withNote(note, await buildList(db, gate, ctx, now));
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

	// Location first: what the volunteer typed is a stronger statement about
	// where they are than which channel they happen to be reading.
	const argument = parseTurfArgument(ctx.argument);
	const resolved =
		argument.kind === 'none' ? null : await resolveLocation(db, locationQuery(argument));
	if (argument.kind !== 'none' && !resolved) {
		return {
			ok: false,
			message: plainMessage(
				"I couldn't find that place. Try a ZIP code, or a fuller address like `100 N Main St, Ann Arbor MI`.",
			),
		};
	}
	const location = resolved?.point ?? ctx.location ?? null;
	const zip = resolved?.zip ?? null;

	const chapter = await resolveChapter(db, {
		explicitChapterId: ctx.chapterId,
		zip,
		channelId: ctx.channelId ?? null,
		chapters,
		channelMap: settings.chapterChannelMap,
	});
	if (!chapter) {
		return { ok: true, viewer, chapters, chapter: null, location, zip, claimOptions };
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

function locationQuery(argument: ReturnType<typeof parseTurfArgument>): string {
	return argument.kind === 'zip' ? argument.zip : argument.kind === 'address' ? argument.query : '';
}

/**
 * Which county the volunteer means.
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
		zip: string | null;
		channelId: string | null;
		chapters: ChapterRef[];
		channelMap: { chapterId: number; channelId: string; name: string }[];
	},
): Promise<ChapterRef | null> {
	const known = (id: number | undefined | null) =>
		id === undefined || id === null
			? null
			: (input.chapters.find((c) => c.chapterId === id) ?? null);

	const explicit = known(input.explicitChapterId);
	if (explicit) return explicit;

	if (input.zip) {
		const fromZip = known(await chapterForZip(db, input.zip));
		if (fromZip) return fromZip;
	}

	if (input.channelId) {
		const entry = input.channelMap.find((c) => c.channelId === input.channelId);
		const fromChannel = known(entry?.chapterId);
		if (fromChannel) return fromChannel;
	}

	return null;
}

/**
 * The chapter a ZIP belongs to, from the map the attendee sync builds.
 *
 * Sparse by nature — it is derived from where members live, so a ZIP nobody
 * has signed up from has no row. That is a miss, not a failure: the caller
 * falls back to the channel, and then to the picker.
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
