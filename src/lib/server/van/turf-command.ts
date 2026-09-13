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
//   1. The MiniVAN list number appears in exactly ONE builder —
//      buildClaimedBlocks — and never in the list. It is the credential: it is
//      what pulls the doors down in MiniVAN, so putting it on a browsable list
//      would let anyone load any turf regardless of who holds it. toTurfView
//      already nulls it on turf you don't hold; this file must not reintroduce
//      it by reading a raw row.
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
}

/** Pack a button's state. Coordinates are rounded to 3 dp (~100 m) — enough to
 *  re-sort the list, not enough to be a location trace sitting in a Slack
 *  message. */
export function encodeTurfAction(value: TurfActionValue): string {
	const payload: Record<string, number> = { c: value.chapterId, o: value.offset };
	if (value.mapRouteId !== undefined) payload.r = value.mapRouteId;
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
export type Block =
	| { type: 'section'; text: Mrkdwn; accessory?: Button }
	| { type: 'context'; elements: Mrkdwn[] }
	| { type: 'actions'; elements: Button[] }
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
 * The one place a MiniVAN list number is rendered.
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
					'*1.* Open MiniVAN on your phone\n' +
						'*2.* Enter the list number above\n' +
						'*3.* Knock, then hit *Sync* when you finish — that is what sends your results back',
				),
			},
			context(
				`Yours for the next ${hours} hour${hours === 1 ? '' : 's'}. ` +
					'If you do not get to it, give it back so someone else can.',
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
