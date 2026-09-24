// The /turfs slash command, minus the plumbing.
//
// Pure: no database, no network, no Slack client. It parses what the volunteer
// typed and builds what they see, so every rule below is unit-testable without
// a signature, a fixture database, or a workspace. Shaped after slack-modal.ts,
// which is the precedent for pure-but-Slack-flavoured modules under
// $lib/server/.
//
// Two things this module is responsible for, both of which are the reason it is
// one module rather than inlined into the two routes that call it:
//
//   1. The MiniVAN list number appears in exactly TWO builders —
//      buildClaimedBlocks and buildMineBlocks — and never in the browsable
//      list. It is the credential: it is what pulls the doors down in MiniVAN,
//      so putting it on a list of turf you do not hold would let anyone load
//      any turf regardless of who has it. toTurfView already nulls it on turf
//      you don't hold; this file must not reintroduce it by reading a raw row.
//
//      What makes those two safe is the same property in both: the reply is
//      ephemeral (slack-response-url.ts hardcodes response_type), so it has
//      exactly one recipient, and the rows behind it are scoped to that same
//      person — the claim they just made, or `loadHoldingsFor(theirUserId)`. A
//      third builder may only render it if BOTH still hold.
//   2. Button values round-trip through Slack, which makes them untrusted
//      input on the way back. decodeTurfAction validates rather than trusts,
//      and the caller re-checks the chapter against settings anyway.

import { formatDistance, haversineMeters, type LatLng } from '../../van/geometry.js';
import { escapeMrkdwn } from '../slack-mrkdwn.js';
import { statusLabel } from '../../van/turf-status.js';
import { describeAge, oldestRefreshMinutes } from '../../van/turf-freshness.js';
import type { TurfView } from '../../van/turf-view.js';
import { normalizeZip } from './zip-centroid.js';

/**
 * Turfs per Slack page.
 *
 * Five, not the web page's 150. A slash command reply is read on a phone in a
 * channel, and the useful question is "what's the closest thing I can take
 * right now", not "show me the county". Anyone who wants the county has the
 * map, which every reply links to.
 */
export const SLACK_TURF_LIMIT = 5;

/** Hard ceiling on how far the "Show next 5" button can walk. Matches the web
 *  payload budget, so a hand-crafted button value cannot page further through a
 *  chapter than the map itself would hand over. */
export const MAX_SLACK_OFFSET = 150;

/** Longest location argument we will pass to a geocoder. A street address is
 *  well under this; anything longer is a paste or an attack, and neither
 *  deserves a network call. */
export const MAX_LOCATION_LENGTH = 120;

export const TURF_CLAIM_ACTION_ID = 'van_turf_claim';
export const TURF_RELEASE_ACTION_ID = 'van_turf_release';
export const TURF_PAGE_ACTION_ID = 'van_turf_page';
// The two buttons on /turfs-mine. Release gets its OWN id rather than reusing
// TURF_RELEASE_ACTION_ID so the handler knows which list to redraw: giving turf
// back from the nearby list should show the nearby list again, and giving it
// back from "my turf" should show what you still hold. Same action, two places
// to return to.
export const TURF_RELEASE_MINE_ACTION_ID = 'van_turf_release_mine';
export const TURF_COMPLETE_ACTION_ID = 'van_turf_complete';

/** The choices "Mark it done" offers in Slack: 5% steps, 100 first because a
 *  finished turf is the common case. Slack caps a menu at 100 options; this
 *  is 20. The web page takes any whole number. */
export const COMPLETE_PERCENTS: readonly number[] = Array.from(
	{ length: 20 },
	(_, i) => 100 - i * 5,
);

export type TurfArgument =
	{ kind: 'none' } | { kind: 'zip'; zip: string } | { kind: 'address'; query: string };

/**
 * What the volunteer typed after the command.
 *
 * A bare five digits is a ZIP and takes the cached path. Anything else
 * non-empty is treated as an address — deliberately permissive, because the
 * geocoder is better at deciding what is an address than a regex is, and the
 * cost of being wrong is one "couldn't find that" message.
 */
export function parseTurfArgument(text: string | null | undefined): TurfArgument {
	const trimmed = (text ?? '').trim().slice(0, MAX_LOCATION_LENGTH).trim();
	if (trimmed === '') return { kind: 'none' };
	const zip = normalizeZip(trimmed);
	if (zip) return { kind: 'zip', zip };
	return { kind: 'address', query: trimmed };
}

export interface TurfActionValue {
	/** Absent on the paging button, which acts on no particular turf. */
	mapRouteId?: number;
	chapterId: number;
	offset: number;
	location?: LatLng | null;
	/** What MiniVAN shows as done, 0-100. Carried by the "Mark it done"
	 *  options, one value per percentage, so completing needs no modal. */
	percent?: number;
}

/** Pack a button's state. Coordinates are rounded to 3 dp (~100 m) — enough to
 *  re-sort the list, not enough to be a location trace sitting in a Slack
 *  message. */
export function encodeTurfAction(value: TurfActionValue): string {
	const payload: Record<string, number> = { c: value.chapterId, o: value.offset };
	if (value.mapRouteId !== undefined) payload.r = value.mapRouteId;
	if (value.percent !== undefined) payload.p = value.percent;
	if (value.location) {
		payload.lat = round3(value.location.lat);
		payload.lng = round3(value.location.lng);
	}
	return JSON.stringify(payload);
}

/**
 * Unpack a button's state, or null if it is not one of ours.
 *
 * Every field is checked rather than cast. The value came back from a client,
 * so a forged one is a plain request the handler will otherwise act on — and
 * `offset` in particular feeds a slice, where a negative or enormous number is
 * the difference between a page and a chapter.
 */
export function decodeTurfAction(raw: string | null | undefined): TurfActionValue | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const p = parsed as Record<string, unknown>;

	const chapterId = asInt(p.c);
	if (chapterId === null) return null;

	const value: TurfActionValue = {
		chapterId,
		offset: clampOffset(asInt(p.o) ?? 0),
	};
	const mapRouteId = asInt(p.r);
	if (mapRouteId !== null) value.mapRouteId = mapRouteId;
	// Out of range is dropped, not clamped: completing refuses a missing
	// percentage with a message, which beats recording a forged 400 as 100.
	const percent = asInt(p.p);
	if (percent !== null && percent >= 0 && percent <= 100) value.percent = percent;

	const lat = asFinite(p.lat);
	const lng = asFinite(p.lng);
	if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
		value.location = { lat, lng };
	}
	return value;
}

function clampOffset(offset: number): number {
	return Math.min(MAX_SLACK_OFFSET, Math.max(0, offset));
}

function asInt(v: unknown): number | null {
	return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function asFinite(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

// Narrow local types, as in slack-modal.ts: enough structure to be checked at
// compile time, without pulling @slack/web-api's whole block union into a
// module that has no client in it.
type Mrkdwn = { type: 'mrkdwn'; text: string };
type Button = {
	type: 'button';
	text: { type: 'plain_text'; text: string; emoji?: boolean };
	action_id: string;
	value?: string;
	url?: string;
	style?: 'primary' | 'danger';
};
type PlainText = { type: 'plain_text'; text: string };
type StaticSelect = {
	type: 'static_select';
	placeholder: PlainText;
	action_id: string;
	options: Array<{ text: PlainText; value: string }>;
};
export type Block =
	| { type: 'section'; text: Mrkdwn; accessory?: Button }
	| { type: 'context'; elements: Mrkdwn[] }
	| { type: 'actions'; elements: Array<Button | StaticSelect> }
	| { type: 'divider' };

export interface SlackMessage {
	/** Notification fallback. Slack shows this in the sidebar and on a phone's
	 *  lock screen, and screen readers read it, so it is never a placeholder. */
	text: string;
	blocks: Block[];
}

const mrkdwn = (text: string): Mrkdwn => ({ type: 'mrkdwn', text });
const context = (text: string): Block => ({ type: 'context', elements: [mrkdwn(text)] });

export interface ChapterRef {
	chapterId: number;
	name: string;
}

/**
 * Deep link to the same view on the web, so the map is always one tap away.
 *
 * Returns the URL raw, which is what a button's `url` field wants. Embedding it
 * in mrkdwn — `<url|label>` — needs the ampersands escaped first, so those call
 * sites wrap it in `escapeMrkdwn`. Getting that backwards is silent: an escaped
 * URL in a button field 404s, and a raw one in mrkdwn is at the mercy of
 * Slack's own unescaping pass.
 */
export function turfPageUrl(appUrl: string, chapterId?: number, zip?: string | null): string {
	const params = new URLSearchParams();
	if (chapterId !== undefined) params.set('chapter', String(chapterId));
	if (zip) params.set('zip', zip);
	const query = params.toString();
	return `${appUrl}/turfs${query ? `?${query}` : ''}`;
}

export interface TurfListInput {
	turfs: readonly TurfView[];
	chapter: ChapterRef;
	location?: LatLng | null;
	offset: number;
	omitted: number;
	total: number;
	appUrl: string;
	/** Echoed into the "open the map" link so the web page opens with the same
	 *  location the list was sorted by. */
	zip?: string | null;
}

/** The command's main reply: the nearest few turfs, each claimable in place. */
export function buildTurfListBlocks(input: TurfListInput): SlackMessage {
	const { turfs, chapter, location = null, offset, omitted, total, appUrl, zip = null } = input;
	const mapUrl = turfPageUrl(appUrl, chapter.chapterId, zip);
	const chapterName = escapeMrkdwn(chapter.name);

	if (total === 0) {
		// Not the same as "everything is taken", and it must not read as that.
		// With no VAN key yet this is the state a volunteer will actually hit.
		return {
			text: `No turf loaded for ${chapter.name} yet.`,
			blocks: [
				{ type: 'section', text: mrkdwn(`*${chapterName}* has no turf loaded yet.`) },
				context(
					'An organizer needs to cut turf in VAN and export it to MiniVAN before it shows up here.',
				),
			],
		};
	}

	if (turfs.length === 0) {
		// Only reachable by paging past the end.
		return {
			text: `No more turf in ${chapter.name}.`,
			blocks: [
				{ type: 'section', text: mrkdwn(`That's all ${total} turfs in *${chapterName}*.`) },
				startOverBlock(chapter.chapterId, location),
			],
		};
	}

	const blocks: Block[] = [
		{
			type: 'section',
			text: mrkdwn(
				`*Turf in ${chapterName}*\n` +
					`Showing ${offset + 1}–${offset + turfs.length} of ${total}` +
					(location ? ', nearest first' : ''),
			),
		},
	];

	for (const turf of turfs) {
		blocks.push(turfSection(turf, chapter.chapterId, offset, location));
		if (!turf.claimable && turf.claimBlockedReason) {
			blocks.push(context(escapeMrkdwn(turf.claimBlockedReason)));
		}
	}

	const staleness = oldestRefreshMinutes(turfs);
	if (staleness !== null) {
		// Story 4.3: never imply live data. A volunteer who walks a turf on stale
		// counts finds knocked doors and stops trusting the tool.
		blocks.push(context(`Door counts as of ${describeAge(staleness)}.`));
	}

	blocks.push(
		omitted > 0
			? nextPageBlock(chapter.chapterId, offset + turfs.length, location)
			: startOverBlock(chapter.chapterId, location),
	);
	blocks.push(
		context(
			`<${escapeMrkdwn(mapUrl)}|Open the map> to see these on a map, or browse the whole county.`,
		),
	);

	return {
		text: `${turfs.length} turfs in ${chapter.name} (${offset + 1}–${offset + turfs.length} of ${total})`,
		blocks,
	};
}

function turfSection(
	turf: TurfView,
	chapterId: number,
	offset: number,
	location: LatLng | null,
): Block {
	const facts = [`${turf.doorsRemaining} doors`];
	if (turf.walkReport) {
		facts.push(`about ${turf.walkReport.percent}% walked (${turf.walkReport.dayLabel})`);
	}
	const distance = distanceTo(turf, location);
	if (distance !== null) facts.push(`${formatDistance(distance)} away`);
	facts.push(statusLabel(turf.status));

	const section: Block = {
		type: 'section',
		text: mrkdwn(
			`*${escapeMrkdwn(turf.name)}*` +
				(turf.regionName ? ` · ${escapeMrkdwn(turf.regionName)}` : '') +
				`\n${facts.join(' · ')}`,
		),
	};

	if (turf.claimable) {
		section.accessory = {
			type: 'button',
			text: { type: 'plain_text', text: 'Claim' },
			style: 'primary',
			action_id: TURF_CLAIM_ACTION_ID,
			value: encodeTurfAction({ mapRouteId: turf.mapRouteId, chapterId, offset, location }),
		};
	} else if (turf.status === 'held-by-you') {
		section.accessory = {
			type: 'button',
			text: { type: 'plain_text', text: 'Give back' },
			action_id: TURF_RELEASE_ACTION_ID,
			value: encodeTurfAction({ mapRouteId: turf.mapRouteId, chapterId, offset, location }),
		};
	}
	return section;
}

function nextPageBlock(chapterId: number, offset: number, location: LatLng | null): Block {
	return {
		type: 'actions',
		elements: [
			{
				type: 'button',
				text: { type: 'plain_text', text: `Show next ${SLACK_TURF_LIMIT}` },
				action_id: TURF_PAGE_ACTION_ID,
				value: encodeTurfAction({ chapterId, offset, location }),
			},
		],
	};
}

/** Shown once the chapter runs out. A button that silently does nothing is
 *  worse than no button, and "there is no more turf" is real information. */
function startOverBlock(chapterId: number, location: LatLng | null): Block {
	return {
		type: 'actions',
		elements: [
			{
				type: 'button',
				text: { type: 'plain_text', text: 'Start over' },
				action_id: TURF_PAGE_ACTION_ID,
				value: encodeTurfAction({ chapterId, offset: 0, location }),
			},
		],
	};
}

function distanceTo(turf: TurfView, location: LatLng | null): number | null {
	if (!location || !turf.centre) return null;
	return haversineMeters(location, turf.centre);
}

export interface ClaimedInput {
	turf: { mapRouteId: number; name: string; regionName: string; doorsRemaining: number };
	chapter: ChapterRef;
	printedListNumber: string;
	expiresAt: string;
	now: Date;
	appUrl: string;
	location?: LatLng | null;
}

/**
 * One of the two places a MiniVAN list number is rendered; see the module
 * header for the rule both obey. The other is `buildMineBlocks`.
 *
 * Only ever posted as an ephemeral to the person who claimed the turf — an
 * ephemeral has exactly one recipient by construction, which is what makes
 * this safe to send into a channel at all. Never `in_channel`, never
 * chat.postMessage, never a DM.
 */
export function buildClaimedBlocks(input: ClaimedInput): SlackMessage {
	const { turf, chapter, printedListNumber, expiresAt, now, appUrl, location = null } = input;
	const hours = hoursUntil(expiresAt, now);

	return {
		// The number is deliberately NOT in the fallback text: that string shows
		// on a lock screen, which is the one place it could be read over a
		// shoulder without the phone being unlocked.
		text: `You've got ${turf.name}. Open Slack for the MiniVAN list number.`,
		blocks: [
			{
				type: 'section',
				text: mrkdwn(
					`*You've got ${escapeMrkdwn(turf.name)}*` +
						(turf.regionName ? ` · ${escapeMrkdwn(turf.regionName)}` : '') +
						`\n${turf.doorsRemaining} doors`,
				),
			},
			{
				type: 'section',
				text: mrkdwn(`Your MiniVAN list number:\n\`\`\`${escapeMrkdwn(printedListNumber)}\`\`\``),
			},
			{
				type: 'section',
				text: mrkdwn(
					// Step 3 names MiniVAN rather than saying a bare "hit Sync".
					// Read in Slack, an unqualified *Sync* invites the reader to look
					// for a button in this message — there isn't one, and there cannot
					// be: MiniVAN uploads canvass results to VAN itself, and the API
					// exposes no way for this app to send them (plan.md §2 Constraint
					// C). Someone who believes Slack synced for them has lost their
					// morning's doors and will not find out for a week, when the
					// unsynced nudge DM goes out. The web page's steps say the same
					// thing in the same order; these two must not drift.
					'*1.* Open MiniVAN on your phone\n' +
						'*2.* Enter the list number above\n' +
						'*3.* Knock the doors, then hit *Sync* in MiniVAN before you close the app\n\n' +
						'Your answers only reach VAN when MiniVAN syncs. Skip it and the turf looks ' +
						'unwalked, and someone else gets sent to the same doors.',
				),
			},
			context(
				`Yours for the next ${hours} hour${hours === 1 ? '' : 's'}. ` +
					'If you do not get to it, give it back so someone else can.\n' +
					// This message is gone as soon as it is scrolled past or replaced,
					// and it is the only place the list number has ever appeared. Say
					// how to get back to it.
					'Lost this message? `/turfs-mine` brings back your list numbers ' +
					'and lets you mark turf done.',
			),
			{
				type: 'actions',
				elements: [
					{
						type: 'button',
						text: { type: 'plain_text', text: 'Give it back' },
						action_id: TURF_RELEASE_ACTION_ID,
						value: encodeTurfAction({
							mapRouteId: turf.mapRouteId,
							chapterId: chapter.chapterId,
							offset: 0,
							location,
						}),
					},
					{
						type: 'button',
						text: { type: 'plain_text', text: 'Open the map' },
						action_id: 'van_turf_open_map',
						url: turfPageUrl(appUrl, chapter.chapterId),
					},
				],
			},
		],
	};
}

export interface MineTurf {
	mapRouteId: number;
	name: string;
	regionName: string;
	doorCount: number;
	expiresAt: string;
	chapterId: number;
	/** Null on a claim made before the column existed. Rendered as a pointer to
	 *  the turf page rather than as an empty code block. */
	issuedListNumber: string | null;
}

export interface MineInput {
	turfs: MineTurf[];
	now: Date;
	appUrl: string;
}

/**
 * What you are holding, with the two things you can do about it.
 *
 * This exists because the claim message is the only place those actions lived,
 * and a Slack message is gone the moment it is scrolled past or replaced. A
 * volunteer who closed it had no way back to their own list number, and no way
 * to mark turf done from Slack at all — that action was web-only.
 *
 * Renders the list number for the same reason buildClaimedBlocks does, under
 * the same two conditions: an ephemeral reply, and rows scoped to the caller's
 * own Slack id. See the module header.
 */
export function buildMineBlocks(input: MineInput): SlackMessage {
	const { turfs, now, appUrl } = input;

	if (turfs.length === 0) {
		return {
			text: 'You are not holding any turf right now.',
			blocks: [
				{
					type: 'section',
					text: mrkdwn(
						'*You are not holding any turf right now.*\n' + 'Run `/turfs` to find some near you.',
					),
				},
			],
		};
	}

	const blocks: Block[] = [
		{
			type: 'section',
			text: mrkdwn(`*Your turf* — ${turfs.length} checked out`),
		},
	];

	for (const turf of turfs) {
		const hours = hoursUntil(turf.expiresAt, now);
		blocks.push({ type: 'divider' });
		blocks.push({
			type: 'section',
			text: mrkdwn(
				`*${escapeMrkdwn(turf.name)}*` +
					(turf.regionName ? ` · ${escapeMrkdwn(turf.regionName)}` : '') +
					`\n${turf.doorCount} doors · ` +
					(hours === 0
						? 'expires shortly'
						: `yours for another ${hours} hour${hours === 1 ? '' : 's'}`),
			),
		});
		blocks.push({
			type: 'section',
			text: mrkdwn(
				turf.issuedListNumber
					? `MiniVAN list number:\n\`\`\`${escapeMrkdwn(turf.issuedListNumber)}\`\`\``
					: '_No list number was recorded for this claim — open the turf page for it._',
			),
		});
		blocks.push({
			type: 'actions',
			elements: [
				// A dropdown rather than a button: marking walked requires the
				// % MiniVAN shows, and picking it IS the action — one tap, no
				// modal. Each option carries the whole action value.
				{
					type: 'static_select',
					placeholder: { type: 'plain_text', text: 'Mark it done — MiniVAN %' },
					action_id: TURF_COMPLETE_ACTION_ID,
					options: COMPLETE_PERCENTS.map((percent) => ({
						text: { type: 'plain_text', text: `${percent}% done` },
						value: encodeTurfAction({
							mapRouteId: turf.mapRouteId,
							chapterId: turf.chapterId,
							offset: 0,
							percent,
						}),
					})),
				},
				{
					type: 'button',
					text: { type: 'plain_text', text: 'Give it back' },
					action_id: TURF_RELEASE_MINE_ACTION_ID,
					value: encodeTurfAction({
						mapRouteId: turf.mapRouteId,
						chapterId: turf.chapterId,
						offset: 0,
					}),
				},
				{
					type: 'button',
					text: { type: 'plain_text', text: 'Open the map' },
					action_id: TURF_PAGE_ACTION_ID,
					url: turfPageUrl(appUrl, turf.chapterId),
				},
			],
		});
	}

	// The warning that prompted this command existing. "Mark it done" records
	// that YOU walked it; it cannot move your answers off your phone, and a
	// volunteer who taps it instead of syncing loses the morning without being
	// told for a week (door-delta.ts sends the nudge). Last block, because it
	// is the thing to read before tapping anything above it.
	blocks.push(
		context(
			'*Sync MiniVAN first.* "Mark it done" records that you walked the turf — ' +
				'it does not send your answers to VAN. Only MiniVAN can do that.',
		),
	);

	return {
		text: `You are holding ${turfs.length} turf${turfs.length === 1 ? '' : 's'}.`,
		blocks,
	};
}

function hoursUntil(iso: string, now: Date): number {
	const ms = Date.parse(iso) - now.getTime();
	return Number.isNaN(ms) || ms <= 0 ? 0 : Math.ceil(ms / 3_600_000);
}

/**
 * Shown when we cannot tell which county the volunteer means.
 *
 * Lists every chapter with a Slack channel, NOT the chapters that have turf —
 * the latter is a cross-chapter aggregate revealing where the field operation
 * is running, which is exactly what chapter scoping exists to prevent. The same
 * reasoning is spelled out in routes/turfs/+page.server.ts.
 */
export function buildChapterPickerBlocks(
	chapters: readonly ChapterRef[],
	appUrl: string,
): SlackMessage {
	if (chapters.length === 0) {
		return {
			text: 'No chapters are set up for turf checkout yet.',
			blocks: [
				{
					type: 'section',
					text: mrkdwn('No chapters are set up for turf checkout yet. Ask an organizer.'),
				},
			],
		};
	}

	const links = chapters
		.map((c) => `• <${escapeMrkdwn(turfPageUrl(appUrl, c.chapterId))}|${escapeMrkdwn(c.name)}>`)
		.join('\n');

	return {
		text: 'Which county are you canvassing in?',
		blocks: [
			{
				type: 'section',
				text: mrkdwn(
					"*Which county are you canvassing in?*\nRun `/turfs` in your county's channel, or " +
						'add a ZIP or address — `/turfs 48104` or `/turfs 100 N Main St, Ann Arbor MI`.',
				),
			},
			{ type: 'section', text: mrkdwn(links) },
		],
	};
}

/** A plain sentence, for the paths that have nothing to render — blocked
 *  users, an unresolvable location. Kept here so the wording lives with the
 *  rest of the command's voice. */
export function plainMessage(text: string): SlackMessage {
	return { text, blocks: [{ type: 'section', text: mrkdwn(text) }] };
}
