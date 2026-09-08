// Turns Solidarity events into Mobilize event plans.
//
// Grouping rule (chosen deliberately): sessions are grouped by LOCATION only.
// Every future session at the same venue becomes one Mobilize event with one
// timeslot per session. A Solidarity event spanning five cities therefore
// produces five Mobilize events.

import { parseAddress } from './address.js';
import { normalizeTitle } from './dedupe.js';
import { parseCoordinates, type Coordinates } from './geocode.js';
import { htmlToMarkdown, plainTextToMarkdown } from './html-to-markdown.js';
import { EVENT_TYPE, type EventTypeName } from './payload.js';
import {
	hasTag,
	MOBILIZE_EXCLUDE_TAG,
	type SolidarityEvent,
	type SolidaritySession,
} from './solidarity.js';

export interface PlannedEvent {
	/** Stable key for the ledger: one Solidarity event + one location. */
	key: string;
	solidarityEventId: number;
	solidaritySessionIds: number[];
	title: string;
	description: string;
	eventType: EventTypeName;
	locationName: string;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	/** Street address is withheld from the payload when this is set. */
	locationIsPrivate: boolean;
	/** The venue's point, when Solidarity has one. Mobilize does not take
	 *  coordinates, but `postal_code` is required and often missing, and the sync
	 *  geocodes this to recover it — see lib/geocode.ts. */
	coordinates: Coordinates | null;
	/** Unix seconds, which is what the v1 API takes. */
	timeslots: { startDate: number; endDate: number; maxAttendees: number | null }[];
	/** Absolute instants in ms, kept for duplicate detection and timeslot matching. */
	startInstants: number[];
	endInstants: number[];
	sourceUrl: string | null;
	/** Solidarity-hosted image; must be re-uploaded before Mobilize will take it. */
	sourceImageUrl: string | null;
}

export interface SkippedEvent {
	solidarityEventId: number;
	title: string;
	reason: string;
}

/**
 * Solidarity has no structured "is this a canvass" flag, so classify off the
 * text. The campaign only wants COMMUNITY and COMMUNITY_CANVASS, and the dry
 * run prints the choice per event so it can be eyeballed before applying.
 */
const CANVASS_PATTERN = /\b(canvass|canvas|knock|door|lit\s*drop|turf)\b/i;

export function classifyEventType(title: string, description: string): EventTypeName {
	return CANVASS_PATTERN.test(`${title} ${description}`)
		? EVENT_TYPE.COMMUNITY_CANVASS
		: EVENT_TYPE.COMMUNITY;
}

/** One published location of an event, as far as naming it is concerned. */
export interface LocationTitleInput {
	/** Location key — stable across runs, so the last-resort numbering is too. */
	key: string;
	/** Every session title at this location; most are shift labels. */
	sessionTitles: string[];
	city: string;
	locationName: string;
	addressLine1: string;
}

function distinct(values: string[]): boolean {
	return new Set(values.map(normalizeTitle)).size === values.length;
}

/** Is this session title a full name in its own right — one that already says
 *  which event it belongs to? "Operation GOTV" -> "Operation GOTV: Flint". */
function carriesEventName(sessionTitle: string, eventTitle: string): boolean {
	const session = normalizeTitle(sessionTitle);
	const event = normalizeTitle(eventTitle);
	return Boolean(session && event && session.includes(event));
}

/**
 * Public titles for the Mobilize events one Solidarity event splits into — one
 * per group, in the order given.
 *
 * A single location keeps the campaign's title verbatim. Several locations each
 * need a title that both still names the event and differs from its siblings:
 * identical titles read as accidental duplicates in the Mobilize feed, and
 * findDuplicate treats them as duplicates outright.
 *
 * This used to simply take a session's title whenever an event spanned several
 * locations, assuming organizers put the city there ("Operation GOTV: Flint").
 * Plenty of them name the shift instead — "Session 2", "Thursday Shift" — and
 * that went out as the public event name with the campaign's own title nowhere
 * on the page. Volunteers browsing mobilize.us saw an event called "Session 2".
 */
export function titlesForLocations(eventTitle: string, groups: LocationTitleInput[]): string[] {
	const base = eventTitle.trim();
	if (groups.length <= 1) return groups.map(() => base);

	// Hand-written session titles that name the event stand on their own. Only
	// when every group has one: mixing hand-written names with derived ones makes
	// siblings look like unrelated events.
	const written = groups.map(
		(group) =>
			group.sessionTitles.map((t) => t.trim()).find((t) => carriesEventName(t, base)) ?? '',
	);
	if (written.every(Boolean) && distinct(written)) return written;

	// Otherwise keep the event's name and add whatever actually differs between
	// the copies, in the order a volunteer would find useful.
	for (const part of ['city', 'locationName', 'addressLine1'] as const) {
		const values = groups.map((group) => group[part].trim());
		if (values.every(Boolean) && distinct(values)) return values.map((v) => `${base} — ${v}`);
	}

	// Same name, same place: the shift label is all that is left to tell them
	// apart, and a number after that. Numbered by location key rather than by
	// input order, so a group keeps its number from one run to the next.
	const labels = groups.map(
		(group) => group.sessionTitles.map((t) => t.trim()).find(Boolean) ?? '',
	);
	if (labels.every(Boolean) && distinct(labels)) return labels.map((l) => `${base} — ${l}`);

	const rank = new Map(
		[...groups].sort((a, b) => a.key.localeCompare(b.key)).map((group, i) => [group.key, i + 1]),
	);
	return groups.map((group) => `${base} (${rank.get(group.key)})`);
}

/** The address as Solidarity holds it. Falls back to the venue name when there
 *  is no address at all, so two unaddressed venues don't merge. */
function locationKey(session: SolidaritySession): string {
	const address = session.location_data?.full_address ?? session.location_address ?? '';
	const name = session.location_name ?? '';
	return (address || name).trim().toLowerCase();
}

/**
 * Long and short forms of the words that vary between two spellings of the same
 * address, collapsed onto the short one. Only forms that are unambiguous in a US
 * street address are listed: "dr" is Drive here, never Doctor, because it is
 * being compared against another address for the same venue rather than parsed.
 */
const ADDRESS_SYNONYMS: Record<string, string> = {
	street: 'st',
	avenue: 'ave',
	boulevard: 'blvd',
	road: 'rd',
	drive: 'dr',
	lane: 'ln',
	court: 'ct',
	place: 'pl',
	parkway: 'pkwy',
	highway: 'hwy',
	square: 'sq',
	terrace: 'ter',
	circle: 'cir',
	trail: 'trl',
	suite: 'ste',
	apartment: 'apt',
	building: 'bldg',
	floor: 'fl',
	north: 'n',
	south: 's',
	east: 'e',
	west: 'w',
	northeast: 'ne',
	northwest: 'nw',
	southeast: 'se',
	southwest: 'sw',
	saint: 'st',
	mount: 'mt',
	fort: 'ft',
	usa: 'us',
};

/**
 * Two spellings of one address, reduced to the same string.
 *
 * Solidarity stores whatever was typed or whatever Google returned that day, so
 * the same field office arrives as both "1 South Saginaw Street, Pontiac, MI"
 * and "1 S Saginaw St, Pontiac, MI". Compared literally those are two venues,
 * which published the same office as three separate Mobilize events.
 *
 * A trailing country and postal code are dropped as well, since the same office
 * appears both with and without them ("…, Pontiac, MI 48342, USA" and "…,
 * Pontiac, MI, USA"). Only from the END: a five-digit token anywhere else is a
 * house number, and Warren's addresses are full of them.
 *
 * Only used to decide whether two sessions share a venue — never to build an
 * address for Mobilize, which always comes from the session's own fields.
 */
export function normalizeLocation(raw: string): string {
	const words = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.map((word) => ADDRESS_SYNONYMS[word] ?? word);
	if (words[words.length - 1] === 'us') words.pop();
	if (/^\d{5}$/.test(words[words.length - 1] ?? '')) words.pop();
	return words.join(' ');
}

interface ResolvedLocation {
	location: NonNullable<SolidaritySession['location_data']> | Record<string, never>;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	venueExtra: string;
	withAddress: SolidaritySession;
}

/**
 * Finds a usable street address for a group of sessions. Prefers Solidarity's
 * structured location_data, but most sessions leave those components blank and
 * only carry the Google-formatted `location_address` string, so fall back to
 * parsing that.
 *
 * City-only results (no street) are rejected: Mobilize would place a pin on the
 * city centroid, which is worse than a missing event a human can add correctly.
 */
function resolveLocation(sessions: SolidaritySession[]): ResolvedLocation | null {
	// Last-resort zip, used only where the session supplying the address has none
	// of its own: Solidarity often fills address_postal_code on a record whose
	// address_city is blank, and the all-or-nothing structured branch below would
	// otherwise discard a perfectly good zip, leaving the payload with the one
	// field Mobilize insists on empty. Borrowing across the group is sound because
	// they share a location key, but it stays the fallback rather than the answer.
	const harvestedZip =
		sessions.map((s) => (s.location_data?.address_postal_code ?? '').trim()).find(Boolean) ?? '';

	const structured = sessions.find(
		(s) => s.location_data?.address_line_1 && s.location_data.address_city,
	);
	if (structured) {
		const data = structured.location_data!;
		return {
			location: data,
			addressLine1: data.address_line_1!,
			city: data.address_city!,
			state: data.address_state || 'MI',
			zipcode: data.address_postal_code || harvestedZip,
			country: data.address_country || 'US',
			venueExtra: '',
			withAddress: structured,
		};
	}

	for (const session of sessions) {
		const parsed = parseAddress(session.location_address);
		if (parsed.quality !== 'full') continue;
		return {
			location: session.location_data ?? {},
			addressLine1: parsed.addressLine1,
			city: parsed.city,
			state: parsed.state || 'MI',
			zipcode: parsed.zipcode || harvestedZip,
			country: parsed.country,
			venueExtra: parsed.venueExtra,
			withAddress: session,
		};
	}
	return null;
}

/**
 * Mobilize requires a non-blank description, and a handful of Solidarity events
 * have none at all — no `description`, no ActionPage HTML, no session note. They
 * used to be rejected with 400 every night. The title plus the signup page is
 * the most useful thing that can honestly be said about them.
 */
export function fallbackDescription(title: string, pageUrl: string | null): string {
	const heading = `**${title.trim()}**`;
	return pageUrl ? `${heading}\n\nDetails and updates:\n${pageUrl}` : heading;
}

/** Solidarity uses 0 for "no cap"; Mobilize would read 0 as "nobody may sign up". */
function capacity(session: SolidaritySession): number | null {
	return session.max_capacity && session.max_capacity > 0 ? session.max_capacity : null;
}

export interface PlanResult {
	planned: PlannedEvent[];
	skipped: SkippedEvent[];
	/** Held back by the `mobilize-exclude` tag — a deliberate choice, not a
	 *  failure, so it is counted apart from `skipped`. */
	excludedByTag: SkippedEvent[];
	/** Sessions left out of a plan because another session at the same location
	 *  already covers that exact start and end. See `dedupeSessions`. */
	duplicateSessions: DuplicateSession[];
}

export interface DuplicateSession {
	solidarityEventId: number;
	/** The Mobilize event title this session would have been a shift on. */
	title: string;
	sessionId: number;
	/** The session that keeps the slot — signups mirror back to this one. */
	keptSessionId: number;
}

/**
 * Sessions in one location group, minus any that repeat a start and end already
 * taken by an earlier one.
 *
 * Mobilize rejects the whole payload — `400 Timeslot with start and end time
 * already exists` — if two timeslots share both times, so a Solidarity event
 * with a session entered twice at one venue could never be created at all. The
 * timeslot is a *time*, and the same time cannot be two shifts.
 *
 * Which one stays matters, because `solidaritySessionIds` is index-aligned with
 * the timeslots and decides where Mobilize signups are mirrored back to: the
 * earliest-sorted session keeps the slot, everyone who signs up lands on it, and
 * its own cap is the one that governs the shift. The dropped session stays
 * untouched in Solidarity — it simply receives no Mobilize signups.
 *
 * Comparison is on the unix seconds actually sent, not the raw strings, since
 * that is the granularity Mobilize compares at.
 */
export function dedupeSessions(sessions: SolidaritySession[]): {
	kept: SolidaritySession[];
	dropped: { session: SolidaritySession; keptSessionId: number }[];
} {
	const bySlot = new Map<string, SolidaritySession>();
	const kept: SolidaritySession[] = [];
	const dropped: { session: SolidaritySession; keptSessionId: number }[] = [];
	for (const session of sessions) {
		const slot = `${Math.floor(Date.parse(session.start_time) / 1000)}-${Math.floor(
			Date.parse(session.end_time) / 1000,
		)}`;
		const holder = bySlot.get(slot);
		if (holder) {
			dropped.push({ session, keptSessionId: holder.id });
			continue;
		}
		bySlot.set(slot, session);
		kept.push(session);
	}
	return { kept, dropped };
}

/**
 * Best available description, as Mobilize-flavored Markdown.
 *
 * Prefers the linked ActionPage's HTML (bold, links, lists intact) and falls
 * back to the events endpoint's flattened plain text, whose single newlines
 * would otherwise render as one run-on paragraph.
 */
export function buildDescription(
	event: SolidarityEvent,
	pageDescriptions?: Map<number, string>,
): string {
	const html = event.event_page_id ? pageDescriptions?.get(event.event_page_id) : undefined;
	if (html) {
		const markdown = htmlToMarkdown(html);
		if (markdown) return markdown;
	}
	return plainTextToMarkdown(event.description ?? '');
}

export function planMigration(
	events: SolidarityEvent[],
	now = Date.now(),
	pageDescriptions?: Map<number, string>,
): PlanResult {
	const planned: PlannedEvent[] = [];
	const skipped: SkippedEvent[] = [];
	const excludedByTag: SkippedEvent[] = [];
	const duplicateSessions: DuplicateSession[] = [];

	for (const event of events) {
		if (event.event_type !== 'in_person') {
			// Virtual events need a join URL that the list payload doesn't expose.
			continue;
		}
		if (event.is_co_hosted_mirror) {
			// A mirror is another org's copy of the same real event.
			continue;
		}
		// The organizer's opt-out, tagged in Solidarity. Reported rather than
		// silently dropped, since "why is my event not on Mobilize?" is otherwise
		// unanswerable from the sync's output.
		if (hasTag(event, MOBILIZE_EXCLUDE_TAG)) {
			excludedByTag.push({
				solidarityEventId: event.id,
				title: event.title,
				reason: `tagged ${MOBILIZE_EXCLUDE_TAG} in Solidarity`,
			});
			continue;
		}

		const future = event.event_sessions.filter((s) => Date.parse(s.start_time) > now);
		if (future.length === 0) continue;

		// Grouped on the normalized address, but keyed by a raw one: the ledger key
		// is built from this, and re-keying every event already in the ledger would
		// orphan it from the Mobilize event it created. An event whose sessions all
		// spell the address the same way — nearly all of them — therefore keeps the
		// exact key it has always had. Where spellings differ, the lowest sorting
		// one wins, so the key doesn't depend on the order Solidarity returns.
		const groups = new Map<string, { key: string; sessions: SolidaritySession[] }>();
		for (const session of future) {
			const raw = locationKey(session);
			const merged = normalizeLocation(raw);
			const existing = groups.get(merged);
			if (existing) {
				existing.sessions.push(session);
				if (raw < existing.key) existing.key = raw;
			} else {
				groups.set(merged, { key: raw, sessions: [session] });
			}
		}

		// Resolve every group before naming any of them. A title has to tell this
		// copy of the event apart from its siblings, so it can only be chosen once
		// the set of siblings that will actually be published is known — which is
		// after both skips below, not after grouping.
		const usable: {
			key: string;
			sessions: SolidaritySession[];
			resolved: ResolvedLocation;
			coordinates: Coordinates | null;
		}[] = [];

		for (const { key, sessions } of groups.values()) {
			const resolved = resolveLocation(sessions);
			if (!resolved) {
				skipped.push({
					solidarityEventId: event.id,
					title: `${event.title}${key ? ` @ ${key}` : ''}`,
					reason: `no usable address on ${sessions.length} session(s) — likely virtual, TBD, or city-only`,
				});
				continue;
			}

			// Read from the session the address itself came from, so a geocoded zip
			// describes the address being published. Grouping only guarantees a shared
			// location KEY — the same address string, or the same venue name where no
			// session has an address at all — which is not quite the same as a shared
			// point: two venues can share a name, and one session in a group can carry
			// coordinates while another does not. Any other session in the group is a
			// fallback for exactly that second case.
			const coordinates =
				parseCoordinates(resolved.withAddress.location_data?.coordinates) ??
				sessions.map((s) => parseCoordinates(s.location_data?.coordinates)).find(Boolean) ??
				null;

			// postal_code is the one required field in the v1 location object, and
			// for a private event it is all that places the pin — there is no street
			// line to fall back on. The sync geocodes a missing one from the venue's
			// coordinates, so only an event with neither is beyond rescue.
			if (event.hide_address_until_rsvp && !resolved.zipcode && !coordinates) {
				skipped.push({
					solidarityEventId: event.id,
					title: `${event.title}${key ? ` @ ${key}` : ''}`,
					reason: 'address is hidden until RSVP but the session has no postal code',
				});
				continue;
			}

			usable.push({ key, sessions, resolved, coordinates });
		}

		const titles = titlesForLocations(
			event.title,
			usable.map(({ key, sessions, resolved }) => ({
				key,
				sessionTitles: sessions.map((s) => s.title ?? ''),
				city: resolved.city,
				locationName: resolved.withAddress.location_name?.trim() || resolved.venueExtra,
				addressLine1: resolved.addressLine1,
			})),
		);

		for (const [index, { key, sessions, resolved, coordinates }] of usable.entries()) {
			const { addressLine1, city, venueExtra, withAddress } = resolved;
			const title = titles[index];

			const sourceDescription = buildDescription(event, pageDescriptions);
			const description =
				sourceDescription.trim() || fallbackDescription(title, event.event_page_url);
			const eventType = classifyEventType(`${title} ${event.title}`, description);
			const sorted = [...sessions].sort(
				(a, b) => Date.parse(a.start_time) - Date.parse(b.start_time),
			);
			const { kept: ordered, dropped } = dedupeSessions(sorted);
			for (const { session, keptSessionId } of dropped) {
				duplicateSessions.push({
					solidarityEventId: event.id,
					title: title.trim(),
					sessionId: session.id,
					keptSessionId,
				});
			}

			planned.push({
				key: `solidarity:${event.id}:${key}`,
				solidarityEventId: event.id,
				solidaritySessionIds: ordered.map((s) => s.id),
				title: title.trim(),
				description,
				eventType,
				locationName: withAddress.location_name?.trim() || venueExtra || city,
				addressLine1,
				city,
				state: resolved.state,
				zipcode: resolved.zipcode,
				country: resolved.country,
				locationIsPrivate: event.hide_address_until_rsvp,
				coordinates,
				timeslots: ordered.map((s) => ({
					startDate: Math.floor(Date.parse(s.start_time) / 1000),
					endDate: Math.floor(Date.parse(s.end_time) / 1000),
					maxAttendees: capacity(s),
				})),
				startInstants: ordered.map((s) => Date.parse(s.start_time)),
				endInstants: ordered.map((s) => Date.parse(s.end_time)),
				sourceUrl: event.event_page_url,
				sourceImageUrl: event.image_url ?? null,
			});
		}
	}

	return { planned, skipped, excludedByTag, duplicateSessions };
}
