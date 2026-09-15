// Ranks each chapter's most active members by how many distinct events they
// RSVP'd to in a trailing window, for the CSV produced by
// scripts/top-rsvpers.ts.
//
// Intentionally has no `$env/*` or `$lib/*` imports so the standalone script
// (which runs outside the Vite bundle via tsx) can import it by relative path —
// the same constraint solidarity-snapshot.ts works under.
//
// How the counting is done, and why:
//
//   * Sessions, not events, are what the API lets us filter by date, and
//     `/v1/event_rsvps?session_id=` is the only RSVP filter verified against the
//     live API (attendee-sync depends on it). Solidarity silently ignores query
//     parameters it doesn't recognize and answers with the *unfiltered* list, so
//     inventing a `_since` on event_rsvps would look like it worked while
//     quietly counting all of history. We enumerate the sessions in the window
//     from /v1/events and ask per session.
//   * A member is counted once per EVENT, not per session. Someone who
//     committed to eight weeks of the same weekly canvass did one thing, and
//     counting it eight times would let a single recurring commitment outrank
//     everyone who showed up to eight different things.
//   * A member in more than one chapter lands in the single chapter where most
//     of their RSVPs went, so each person appears on exactly one chapter's list.

import { fetchPaginated } from './solidarity-paginate.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Members with no chapter at all, kept visible rather than dropped. */
export const NO_CHAPTER_ID = -1;
export const NO_CHAPTER_NAME = '(no chapter)';

/** One member's RSVP to one event, already de-duplicated across sessions. */
export interface EventRsvp {
	userId: number;
	eventId: number;
	/** The chapter that owns the event; null when it isn't chapter-scoped. */
	eventChapterId: number | null;
	/** Contact details carried on the RSVP row itself. A fallback for members the
	 *  roster walk didn't return — see rankTopRsvpers. */
	contact?: Contact;
}

export interface Contact {
	fullName: string;
	email: string;
	phoneNumber: string;
}

/** The roster fields the CSV needs. */
export interface RosterMember {
	id: number;
	fullName: string;
	email: string;
	phoneNumber: string;
	chapterIds: number[];
}

export interface TopRsvperRow {
	chapterId: number;
	chapterName: string;
	rsvpCount: number;
	fullName: string;
	email: string;
	phoneNumber: string;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * The trailing window, ending now. `months` is calendar months back from today,
 * so a run on March 31st looks back to January 31st rather than to a fixed 60
 * days — that's what "the past two months" means to the person reading the CSV.
 *
 * Clamps to the end of the target month (May 31 - 2mo = March 31, not March 3,
 * which is what naive `setMonth` arithmetic produces).
 */
export function trailingWindow(
	months: number,
	now = new Date(),
): { startMs: number; endMs: number } {
	const endMs = now.getTime();
	const start = new Date(now.getTime());
	const day = start.getUTCDate();
	start.setUTCDate(1);
	start.setUTCMonth(start.getUTCMonth() - months);
	const lastDayOfTarget = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
	).getUTCDate();
	start.setUTCDate(Math.min(day, lastDayOfTarget));
	return { startMs: start.getTime(), endMs };
}

// ---------------------------------------------------------------------------
// Ranking (pure)
// ---------------------------------------------------------------------------

interface UserTally {
	/** eventId -> the chapter that owns it. Distinct events only. */
	events: Map<number, number | null>;
	/** From the RSVP rows; only consulted when the roster has no record. */
	contact: Contact | null;
}

function tallyByUser(rsvps: EventRsvp[]): Map<number, UserTally> {
	const byUser = new Map<number, UserTally>();
	for (const rsvp of rsvps) {
		let tally = byUser.get(rsvp.userId);
		if (!tally) {
			tally = { events: new Map(), contact: null };
			byUser.set(rsvp.userId, tally);
		}
		tally.events.set(rsvp.eventId, rsvp.eventChapterId);
		if (!tally.contact && rsvp.contact) tally.contact = rsvp.contact;
	}
	return byUser;
}

/** One human, after any duplicate Solidarity profiles have been folded together. */
interface MergedMember {
	/** Every profile folded into this person, lowest id first. */
	userIds: number[];
	events: Map<number, number | null>;
	chapterIds: number[];
	contact: Contact | null;
	/** Whether `contact` came from the roster rather than an RSVP contact card. */
	contactFromRoster: boolean;
}

/**
 * Fold multiple Solidarity profiles for the same person into one.
 *
 * Solidarity really does hold duplicate people — its API offers
 * `POST /v1/users/merge` precisely because of it, and the first run of this
 * report put one member in a chapter's top ten TWICE, with her RSVPs split
 * across the two records so both counts understated her. The ask is for ten
 * people per chapter, so a duplicate taking two slots is wrong twice over.
 *
 * The key is email AND name, not email alone. Email alone looks right — it is
 * what Solidarity itself matches on (see findUserByEmailStrict) — but this
 * organisation's data has PLACEHOLDER addresses: 29 different people share
 * `noemail@gmail.com`, entered when someone signs up without an email. Keying on
 * that alone pooled 29 strangers into one person who then topped their chapter
 * with their combined RSVPs. Requiring the name to match as well costs us the
 * occasional real duplicate filed under "Bob" and "Robert", which is a far
 * cheaper mistake than inventing a member out of two dozen other people.
 *
 * Phone is not part of the key at all, for the same reason in a stronger form:
 * households share a number far more often than they share an inbox.
 *
 * Iterating ids in ascending order keeps the surviving contact details, and so
 * the CSV, identical from run to run.
 */
function identityKey(userId: number, contact: Contact | null): string {
	const email = (contact?.email ?? '').trim().toLowerCase();
	if (!email) return `id:${userId}`;
	// Collapsed whitespace so "Ada  Lovelace" and "Ada Lovelace" are one person.
	const name = (contact?.fullName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
	// NUL separator: it cannot occur in either half, so no name/email pair can
	// collide with a different one by straddling the boundary.
	return `${email}\u0000${name}`;
}

function mergeDuplicateProfiles(
	byUser: Map<number, UserTally>,
	roster: Map<number, RosterMember>,
): { people: MergedMember[]; unmatchedUserIds: number[] } {
	const groups = new Map<string, MergedMember>();
	const unmatchedUserIds: number[] = [];

	for (const userId of [...byUser.keys()].sort((a, b) => a - b)) {
		const tally = byUser.get(userId)!;
		const member = roster.get(userId);
		if (!member) unmatchedUserIds.push(userId);

		const contact: Contact | null = member
			? { fullName: member.fullName, email: member.email, phoneNumber: member.phoneNumber }
			: tally.contact;
		const key = identityKey(userId, contact);

		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				userIds: [userId],
				events: new Map(tally.events),
				chapterIds: [...(member?.chapterIds ?? [])],
				contact,
				contactFromRoster: Boolean(member),
			});
			continue;
		}

		existing.userIds.push(userId);
		// Union, so a person's count is what they actually did across both records
		// rather than whichever half landed on the profile that ranked.
		for (const [eventId, chapterId] of tally.events) existing.events.set(eventId, chapterId);
		existing.chapterIds.push(...(member?.chapterIds ?? []));
		// A roster record beats an RSVP contact card whichever order they arrive in.
		if (contact && (!existing.contact || (!existing.contactFromRoster && member))) {
			existing.contact = contact;
			existing.contactFromRoster = Boolean(member);
		}
	}

	return { people: [...groups.values()], unmatchedUserIds };
}

/**
 * Pick the one chapter a member is reported under.
 *
 * A member in a single chapter goes there regardless of whose events they
 * attended — the question the CSV answers is "who are this chapter's most
 * engaged members". Only a genuinely multi-chapter member needs a decision, and
 * that's settled by where most of their RSVPs actually went. Ties (including
 * the common case where none of their events were chapter-scoped) fall back to
 * the lowest chapter id, so repeated runs produce the same CSV.
 */
export function assignChapter(chapterIds: number[], events: Map<number, number | null>): number {
	const ids = [...new Set(chapterIds)].sort((a, b) => a - b);
	if (ids.length === 0) return NO_CHAPTER_ID;
	if (ids.length === 1) return ids[0];

	const perChapter = new Map<number, number>(ids.map((id) => [id, 0]));
	for (const eventChapterId of events.values()) {
		if (eventChapterId === null) continue;
		const current = perChapter.get(eventChapterId);
		if (current !== undefined) perChapter.set(eventChapterId, current + 1);
	}

	let best = ids[0];
	let bestCount = perChapter.get(best) ?? 0;
	for (const id of ids) {
		const count = perChapter.get(id) ?? 0;
		if (count > bestCount) {
			best = id;
			bestCount = count;
		}
	}
	return best;
}

/**
 * The top `topN` members of every chapter, ranked by distinct events RSVP'd to.
 *
 * The reported count is the member's total across all events in the window, not
 * just their assigned chapter's — someone who turns out for a neighbouring
 * chapter's canvasses is still that engaged, and the assignment above is about
 * which list they appear on, not about discounting what they did.
 *
 * A member with RSVPs but no roster record still gets a row, from the contact
 * card on their RSVP rows — they are real people who turned up, and dropping
 * them would silently shorten a chapter's list. What's missing is their chapter,
 * so they land under "(no chapter)" rather than under a guess, and their ids are
 * returned so a run can report how many were in that position. Only someone with
 * neither a roster record nor a contact card is skipped outright.
 *
 * Duplicate Solidarity profiles for one person are folded together first — see
 * mergeDuplicateProfiles — so `topN` counts people, not records.
 */
export function rankTopRsvpers(
	rsvps: EventRsvp[],
	roster: Map<number, RosterMember>,
	chapterNames: Map<number, string>,
	topN = 10,
): { rows: TopRsvperRow[]; unmatchedUserIds: number[]; duplicateProfilesMerged: number } {
	const { people, unmatchedUserIds } = mergeDuplicateProfiles(tallyByUser(rsvps), roster);
	const byChapter = new Map<number, TopRsvperRow[]>();
	let duplicateProfilesMerged = 0;

	for (const person of people) {
		if (person.userIds.length > 1) duplicateProfilesMerged += person.userIds.length - 1;
		if (!person.contact) continue;

		const chapterId = assignChapter(person.chapterIds, person.events);
		const row: TopRsvperRow = {
			chapterId,
			chapterName:
				chapterId === NO_CHAPTER_ID
					? NO_CHAPTER_NAME
					: (chapterNames.get(chapterId) ?? `Chapter ${chapterId}`),
			rsvpCount: person.events.size,
			...person.contact,
		};
		const bucket = byChapter.get(chapterId);
		if (bucket) bucket.push(row);
		else byChapter.set(chapterId, [row]);
	}

	const rows: TopRsvperRow[] = [];
	// Chapters alphabetically, with the chapter-less bucket last so it reads as
	// a footnote rather than as a chapter called "(".
	const chapters = [...byChapter.keys()].sort((a, b) => {
		if (a === NO_CHAPTER_ID) return 1;
		if (b === NO_CHAPTER_ID) return -1;
		const nameA = chapterNames.get(a) ?? `Chapter ${a}`;
		const nameB = chapterNames.get(b) ?? `Chapter ${b}`;
		return nameA.localeCompare(nameB) || a - b;
	});

	for (const chapterId of chapters) {
		const bucket = byChapter.get(chapterId)!;
		// Name breaks count ties so the CSV is stable across runs; two members with
		// the same count and name are ordered by whichever the roster yielded first.
		bucket.sort((a, b) => b.rsvpCount - a.rsvpCount || a.fullName.localeCompare(b.fullName));
		rows.push(...bucket.slice(0, topN));
	}

	return { rows, unmatchedUserIds, duplicateProfilesMerged };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_HEADER = [
	'Chapter Name',
	'RSVP count (over the past two months)',
	'Full Name',
	'Email',
	'Phone Number',
];

function csvCell(value: string | number): string {
	const text = String(value);
	// Quote whenever the value could otherwise break the row apart. Leading `=`
	// and `+` are deliberately NOT neutralized: phone numbers are E.164 and start
	// with `+`, so the usual formula-injection guard would corrupt a whole column.
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: TopRsvperRow[]): string {
	const lines = [CSV_HEADER.join(',')];
	for (const row of rows) {
		lines.push(
			[row.chapterName, row.rsvpCount, row.fullName, row.email, row.phoneNumber]
				.map(csvCell)
				.join(','),
		);
	}
	// Trailing newline: POSIX-conventional, and Excel doesn't mind.
	return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Solidarity fetch
// ---------------------------------------------------------------------------

interface RawSession {
	id: number;
	start_time: string;
	/** Solidarity reports this on the session itself, which lets the walk skip
	 *  empty sessions outright — worth a few hundred fewer requests on a
	 *  two-month window. */
	rsvp_count?: number | null;
}

interface RawEvent {
	id: number;
	title?: string | null;
	scope_id?: number | null;
	scope_type?: string | null;
	event_sessions?: RawSession[] | null;
}

interface RawRsvp {
	user_id?: number | null;
	/** 'yes' | 'no' | 'maybe' | 'waitlisted' on list responses; the member page
	 *  has also seen a boolean, so both are handled. */
	is_attending?: string | boolean | null;
	/** Present even with `full_user_payload=false` — a trimmed contact card. Used
	 *  only to fill in someone the roster walk didn't return; the roster stays
	 *  authoritative because this carries no chapter. */
	user_details?: {
		first_name?: string | null;
		last_name?: string | null;
		email?: string | null;
		phone?: string | null;
	} | null;
}

interface RawChapter {
	id: number;
	name: string;
}

interface RawUser {
	id: number;
	first_name?: string | null;
	last_name?: string | null;
	alternate_name?: string | null;
	email?: string | null;
	phone_number?: string | null;
	chapter_id?: number | null;
	chapter_ids?: number[] | null;
}

/** ~1.67 requests/second, under Solidarity's 60-per-30s ceiling. The per-session
 *  RSVP walk is one request per session and can run to hundreds; without pacing
 *  it burns the shared retry budget on 429s and aborts partway through. */
const PACE_MS = 600;

/** A cancelled RSVP is not a turnout. Everything else — yes, maybe, waitlisted —
 *  is someone putting their name down, which is what's being counted. */
export function countsAsRsvp(raw: RawRsvp): boolean {
	const value = raw.is_attending;
	if (value === false) return false;
	return !(typeof value === 'string' && value.trim().toLowerCase() === 'no');
}

export interface SessionInWindow {
	sessionId: number;
	eventId: number;
	eventChapterId: number | null;
	/** null when the API didn't report one — which means "ask", not "empty". */
	rsvpCount: number | null;
}

/** Every session starting inside the window, with the chapter owning its event. */
export function sessionsInWindow(
	events: RawEvent[],
	startMs: number,
	endMs: number,
): SessionInWindow[] {
	const out: SessionInWindow[] = [];
	for (const event of events) {
		const eventChapterId =
			event.scope_type === 'Chapter' && typeof event.scope_id === 'number' ? event.scope_id : null;
		for (const session of event.event_sessions ?? []) {
			const startedAt = Date.parse(session.start_time ?? '');
			if (!Number.isFinite(startedAt)) continue;
			if (startedAt < startMs || startedAt > endMs) continue;
			out.push({
				sessionId: session.id,
				eventId: event.id,
				eventChapterId,
				rsvpCount: typeof session.rsvp_count === 'number' ? session.rsvp_count : null,
			});
		}
	}
	return out;
}

function fullNameOf(raw: RawUser): string {
	const full = [raw.first_name, raw.last_name]
		.map((part) => (part ?? '').trim())
		.filter(Boolean)
		.join(' ');
	// Falls back the same way the roster picker does — a nameless record is still
	// a real person an organizer may recognize by email.
	return (
		full ||
		(raw.alternate_name ?? '').trim() ||
		(raw.email ?? '').trim() ||
		`Solidarity user ${raw.id}`
	);
}

/** The contact card on an RSVP row, or undefined when it carries nothing usable. */
export function contactOf(raw: RawRsvp): Contact | undefined {
	const details = raw.user_details;
	if (!details) return undefined;
	const fullName = [details.first_name, details.last_name]
		.map((part) => (part ?? '').trim())
		.filter(Boolean)
		.join(' ');
	const email = (details.email ?? '').trim();
	const phoneNumber = (details.phone ?? '').trim();
	if (!fullName && !email && !phoneNumber) return undefined;
	return { fullName: fullName || email || `Solidarity user ${raw.user_id}`, email, phoneNumber };
}

function chapterIdsOf(raw: RawUser): number[] {
	const ids = new Set<number>();
	for (const id of raw.chapter_ids ?? []) {
		if (typeof id === 'number') ids.add(id);
	}
	// Folded in because a member with exactly one chapter has been observed
	// carrying only the singular field (see getUserChapterNames).
	if (typeof raw.chapter_id === 'number') ids.add(raw.chapter_id);
	return [...ids];
}

/** The full roster, keyed by id. One walk, because every RSVP'ing member needs
 *  their chapter before anyone can be ranked — far cheaper than a lookup each. */
export async function fetchRoster(token: string): Promise<Map<number, RosterMember>> {
	const raw = await fetchPaginated<RawUser>(
		token,
		'/v1/users',
		'/v1/users roster',
		'',
		'top-rsvpers',
		PACE_MS,
	);
	const roster = new Map<number, RosterMember>();
	for (const user of raw) {
		if (typeof user.id !== 'number') continue;
		roster.set(user.id, {
			id: user.id,
			fullName: fullNameOf(user),
			email: (user.email ?? '').trim(),
			phoneNumber: (user.phone_number ?? '').trim(),
			chapterIds: chapterIdsOf(user),
		});
	}
	return roster;
}

async function fetchChapterNames(token: string): Promise<Map<number, string>> {
	const chapters = await fetchPaginated<RawChapter>(
		token,
		'/v1/chapters',
		'/v1/chapters',
		'',
		'top-rsvpers',
	);
	return new Map(chapters.map((c) => [c.id, c.name]));
}

async function fetchEvents(token: string): Promise<RawEvent[]> {
	return fetchPaginated<RawEvent>(token, '/v1/events', '/v1/events', '', 'top-rsvpers', PACE_MS);
}

/** RSVPs on one session. `session_id` is the only event_rsvps filter verified
 *  against the live API — see the note at the top of this file.
 *
 *  Unpaced: the caller sleeps PACE_MS between sessions, and one session's RSVPs
 *  are rarely more than a page or two. */
async function fetchSessionRsvps(token: string, sessionId: number): Promise<RawRsvp[]> {
	return fetchPaginated<RawRsvp>(
		token,
		'/v1/event_rsvps',
		`rsvp list for session ${sessionId}`,
		`&session_id=${sessionId}&full_user_payload=false`,
		'top-rsvpers',
	);
}

export interface TopRsvpersResult {
	rows: TopRsvperRow[];
	startMs: number;
	endMs: number;
	eventsScanned: number;
	sessionsInWindow: number;
	/** Sessions actually queried — the rest were reported empty by the API. */
	sessionsQueried: number;
	rsvpsCounted: number;
	membersRanked: number;
	unmatchedUserIds: number[];
	/** Extra profiles folded into an existing person by matching email. */
	duplicateProfilesMerged: number;
}

export interface TopRsvpersOptions {
	months?: number;
	topN?: number;
	now?: Date;
	/** Progress line per N sessions; the RSVP walk is the slow part of a run. */
	log?: (message: string) => void;
}

export async function runTopRsvpers(
	token: string,
	options: TopRsvpersOptions = {},
): Promise<TopRsvpersResult> {
	const { months = 2, topN = 10, now = new Date(), log = () => {} } = options;
	const { startMs, endMs } = trailingWindow(months, now);

	log(`window: ${new Date(startMs).toISOString()} .. ${new Date(endMs).toISOString()}`);

	const [chapterNames, events] = await Promise.all([fetchChapterNames(token), fetchEvents(token)]);
	const sessions = sessionsInWindow(events, startMs, endMs);
	// A session Solidarity already told us has no RSVPs needs no request of its
	// own. `null` means it didn't say, which is not the same as zero — those are
	// still asked about.
	const toQuery = sessions.filter((s) => s.rsvpCount !== 0);
	log(
		`${events.length} events scanned, ${sessions.length} sessions in window, ` +
			`${toQuery.length} with RSVPs to fetch`,
	);

	const rsvps: EventRsvp[] = [];
	for (const [index, session] of toQuery.entries()) {
		if (index > 0) await new Promise((r) => setTimeout(r, PACE_MS));
		for (const raw of await fetchSessionRsvps(token, session.sessionId)) {
			if (typeof raw.user_id !== 'number' || !countsAsRsvp(raw)) continue;
			rsvps.push({
				userId: raw.user_id,
				eventId: session.eventId,
				eventChapterId: session.eventChapterId,
				contact: contactOf(raw),
			});
		}
		if ((index + 1) % 25 === 0 || index === toQuery.length - 1) {
			log(`  sessions ${index + 1}/${toQuery.length}, ${rsvps.length} RSVPs so far`);
		}
	}

	// After the RSVP walk: the roster is the expensive fetch, and there is no
	// point paying for it if the walk above is going to fail.
	const roster = await fetchRoster(token);
	log(`roster: ${roster.size} members`);

	const { rows, unmatchedUserIds, duplicateProfilesMerged } = rankTopRsvpers(
		rsvps,
		roster,
		chapterNames,
		topN,
	);

	return {
		rows,
		startMs,
		endMs,
		eventsScanned: events.length,
		sessionsInWindow: sessions.length,
		sessionsQueried: toQuery.length,
		rsvpsCounted: rsvps.length,
		membersRanked: new Set(rsvps.map((r) => r.userId)).size,
		unmatchedUserIds,
		duplicateProfilesMerged,
	};
}
