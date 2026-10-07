// Uncontacted doors per turf, from VAN's ContactHistory.
//
// Two inputs meet here, both reduced to keyed digests (person-hash.ts) before
// they touch the database:
//
//   - van_turf_roster: person → door for every turf, written by the geometry
//     worker from the same type-5 export that draws the hull.
//   - van_person_contacts: the latest in-person contact attempt per person,
//     pulled here from the ContactHistory changed-entity export.
//
// A door is contacted when ANY resident has an in-person attempt since the
// turf was cut — not home, refused and inaccessible all count, because the
// question is "does somebody still need to knock here", not "did it go well".
// Phone, text and mail do not count: they don't take a door off a walk list.
// Nor do the in-person types that happen away from the door (NOT_A_DOOR_CONTACT_TYPES).
//
// Every in-person contact is stored, not only those of people already on a
// roster. Rosters arrive turf by turf over hours during the first pass, and a
// contact filtered out because its turf's roster had not landed yet would never
// be pulled again. Contacts older than the oldest live turf's cut are pruned.
//
// The pull never reaches back more than MAX_BACKFILL_MS: a turf VAN has not
// re-cut in months would otherwise cost one export job per day of its age.
// Contacts older than that simply do not count against it.
//
// A retired route keeps its roster, and its count keeps being recomputed, for
// RETIRED_ROSTER_KEEP_MS. Marking turf walked asks VAN to re-cut the region,
// and a re-cut retires the route — often before the volunteer's MiniVAN sync
// has reached ContactHistory. The completion's % walked is derived from this
// route's count, so the count has to outlive the route by as long as that
// derivation runs (WALK_PERCENT_WINDOW_MS).
//
// Shaped like the geometry worker: injected client, fetch, clock and budget, no
// $env, so scripts/ can run it under tsx. Configuration is resolved in
// contact-live.ts.

import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { campaignWallClockToUtc } from '../../campaign-time.js';
import { vanContactSyncState, vanPersonContacts, vanTurfRoster, vanTurfs } from '../schema.js';
import type { VanClient } from './client.js';
import { csvRows, responseChunks, type RosterEntry } from './hull-extract.js';
import type { PersonHasher } from './person-hash.js';
import { chunked } from './sql-chunk.js';
import type { VanChangedEntityExportJob } from './types.js';

type Db = ReturnType<typeof drizzle>;
type FetchFn = typeof fetch;

/** One export job per window. A day of the whole committee's contact history
 *  is ~10k rows — small enough to finish in one run, and the unit the cursor
 *  advances by, so a two-week backfill is resumable a day at a time. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Below this there is nothing worth an export job; the next run picks it up. */
const MIN_WINDOW_MS = 60 * 1000;
/** How far back the pull ever starts. Older contacts are not read or kept. */
export const MAX_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;
/** Each window starts this far before the cursor. A contact VAN surfaces in
 *  the changed-entity data some time after its DateChanged would otherwise
 *  fall in a window already applied and never be read. Re-reading is free:
 *  upsertContacts keeps the later date. */
export const OVERLAP_MS = 2 * 60 * 60 * 1000;
/** Failed reads of one job's files before the job is dropped and its window
 *  submitted afresh. */
const MAX_JOB_FAILURES = 3;
/** A job not Complete after this long is abandoned and resubmitted. */
export const JOB_STALE_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIME_BUDGET_MS = 45 * 1000;
/** Turfs per recompute statement. Each turf is ~200 roster rows, so this keeps
 *  one statement to a few tens of thousands of index lookups. */
const RECOMPUTE_BATCH = 200;
/** Two blobs per row; well under SQLite's oldest 999-parameter limit. */
const CONTACT_BATCH = 400;
/** Three parameters per row. */
const ROSTER_BATCH = 300;
/** One parameter per person when finding the turfs a pull touched. */
const TOUCHED_BATCH = 500;

export const IN_PERSON_CHANNEL = 'in person';
/** In-person contact types that are not a knock on a door on the list: meeting
 *  someone at an event or a meeting, or a paid ID. Matched by name, since the
 *  ids are per committee. */
export const NOT_A_DOOR_CONTACT_TYPES: ReadonlySet<string> = new Set([
	'event',
	'meeting',
	'paid id',
]);

const LOG = '[van]';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `9/28/2026 3:07:00 PM` — ContactHistory's date format, verified live — as a
 * real UTC ISO string. Campaign-local wall-clock like every other VAN
 * timestamp (see vanTimestamp in catalog.ts). Also accepts the ISO shape, in
 * case VAN changes its mind. Null when unparseable.
 */
export function contactTimestamp(value: string): string | null {
	const text = value.trim();
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(
		text,
	);
	if (us) {
		const [, mo, d, y, h, mi, s, ampm] = us;
		let hour = Number(h);
		if (ampm) {
			const pm = ampm.toUpperCase() === 'PM';
			if (hour === 12) hour = pm ? 12 : 0;
			else if (pm) hour += 12;
		}
		const pad = (n: string | number) => String(n).padStart(2, '0');
		const wall = `${y}-${pad(mo!)}-${pad(d!)}T${pad(hour)}:${mi}:${s ?? '00'}`;
		return campaignWallClockToUtc(wall)?.toISOString() ?? null;
	}
	return campaignWallClockToUtc(text)?.toISOString() ?? null;
}

// ---------------------------------------------------------------------------
// Store

/** Replace one turf's roster and record which saved list it came from, in one
 *  atomic batch — a reader never sees half a roster. */
export async function replaceRoster(
	db: Db,
	turfId: number,
	savedListId: number,
	entries: readonly RosterEntry[],
): Promise<void> {
	const inserts = chunked(entries, ROSTER_BATCH).map((batch) =>
		db
			.insert(vanTurfRoster)
			.values(batch.map((e) => ({ turfId, personHash: e.personHash, doorHash: e.doorHash })))
			// A person listed twice in one saved list is still one person.
			.onConflictDoNothing(),
	);
	const statements = [
		db.delete(vanTurfRoster).where(eq(vanTurfRoster.turfId, turfId)),
		...inserts,
		db.update(vanTurfs).set({ rosterSavedListId: savedListId }).where(eq(vanTurfs.turfId, turfId)),
	];
	await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
}

/** Record contacts, keeping the later date where one is already stored. */
export async function upsertContacts(
	db: Db,
	campaignId: number,
	contacts: ReadonlyMap<string, { personHash: Buffer; at: string }>,
): Promise<void> {
	for (const batch of chunked([...contacts.values()], CONTACT_BATCH)) {
		await db
			.insert(vanPersonContacts)
			.values(batch.map((c) => ({ campaignId, personHash: c.personHash, lastInPersonAt: c.at })))
			.onConflictDoUpdate({
				target: [vanPersonContacts.campaignId, vanPersonContacts.personHash],
				set: {
					lastInPersonAt: sql`max(${vanPersonContacts.lastInPersonAt}, excluded.last_in_person_at)`,
				},
			});
	}
}

/** Turfs whose count is still kept up to date: live, or retired recently
 *  enough that a completion on them may still need its % walked. */
function countedTurfs(now: Date) {
	const since = new Date(now.getTime() - RETIRED_ROSTER_KEEP_MS).toISOString();
	return or(isNull(vanTurfs.retiredAt), gte(vanTurfs.retiredAt, since));
}

/**
 * Where the pull starts, and below which a stored contact can no longer matter:
 * the earliest cut among counted turfs, but never more than MAX_BACKFILL_MS
 * ago. Null when there is no turf to count for.
 */
export async function pullFloor(db: Db, campaignId: number, now: Date): Promise<string | null> {
	const [row] = await db
		.select({ at: sql<string | null>`min(coalesce(${vanTurfs.cutAt}, ${vanTurfs.firstSeenAt}))` })
		.from(vanTurfs)
		.where(and(eq(vanTurfs.campaignId, campaignId), countedTurfs(now)));
	if (!row?.at) return null;
	const limit = new Date(now.getTime() - MAX_BACKFILL_MS).toISOString();
	return row.at > limit ? row.at : limit;
}

/**
 * Forget every count. For when the feature is switched off: a count left in
 * place would go on overriding VAN's doorCount, and gating claims, frozen at
 * whatever it last was.
 */
export async function clearUncontacted(db: Db): Promise<void> {
	await db
		.update(vanTurfs)
		.set({ uncontactedDoors: null, uncontactedDoorsAt: null })
		.where(isNotNull(vanTurfs.uncontactedDoors));
	// Switched back on later, every turf needs its count again, not only the
	// ones the next pull happens to touch.
	await db
		.update(vanContactSyncState)
		.set({ fullRecomputeAt: null })
		.where(isNotNull(vanContactSyncState.fullRecomputeAt));
}

/**
 * What the readers of the count need from the pull's progress: how far
 * ContactHistory has been read (`cursor`, the count's "as of"), and the start
 * of the last scheduled run that caught up (`countedThrough`, before which a
 * completion's doors are in the count). Nulls when the pull has never run.
 */
export interface ContactMarks {
	cursor: string | null;
	countedThrough: string | null;
}

/** Every campaign's marks, by campaign id. Each campaign pulls its own
 *  ContactHistory, so a turf's count is as of ITS campaign's cursor. */
export async function loadContactMarks(db: Db): Promise<ReadonlyMap<number, ContactMarks>> {
	const rows = await db
		.select({
			campaignId: vanContactSyncState.campaignId,
			cursor: vanContactSyncState.cursor,
			countedThrough: vanContactSyncState.countedThrough,
		})
		.from(vanContactSyncState);
	return new Map(
		rows.map((r) => [r.campaignId, { cursor: r.cursor, countedThrough: r.countedThrough }]),
	);
}

/** One campaign's marks; nulls for a campaign whose pull has never run. */
export function marksFor(
	marks: ReadonlyMap<number, ContactMarks>,
	campaignId: number,
): ContactMarks {
	return marks.get(campaignId) ?? { cursor: null, countedThrough: null };
}

/** Turfs with a roster row for any of these people — the only counts a pull of
 *  their contacts can move. Retired rosters included; recomputing one is
 *  harmless and its completion may still need its % walked. */
async function turfsWithPeople(
	db: Db,
	campaignId: number,
	personHashes: readonly Buffer[],
): Promise<number[]> {
	const ids = new Set<number>();
	for (const batch of chunked(personHashes, TOUCHED_BATCH)) {
		// This campaign's turf only: the same person can be on another
		// campaign's roster, and that count is moved by that campaign's pull.
		const rows = await db
			.selectDistinct({ id: vanTurfRoster.turfId })
			.from(vanTurfRoster)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfRoster.turfId))
			.where(and(eq(vanTurfs.campaignId, campaignId), inArray(vanTurfRoster.personHash, batch)));
		for (const row of rows) ids.add(row.id);
	}
	return [...ids];
}

/**
 * Recompute `uncontactedDoors` for the given turfs, or every counted turf
 * (live, or retired within RETIRED_ROSTER_KEEP_MS).
 *
 * distinct doors − distinct doors with any resident contacted since the cut,
 * in one pass over the turf's roster rows rather than a per-door subquery.
 * A turf whose roster is missing or from an older saved list gets NULL: a
 * count from the wrong cut is worse than none, and the UI falls back to VAN's
 * own doorCount.
 */
export async function recomputeUncontacted(
	db: Db,
	options: { now: Date; campaignId: number; turfIds?: readonly number[] },
): Promise<number> {
	const ids =
		options.turfIds ??
		(
			await db
				.select({ id: vanTurfs.turfId })
				.from(vanTurfs)
				.where(and(eq(vanTurfs.campaignId, options.campaignId), countedTurfs(options.now)))
		).map((r) => r.id);
	const nowIso = options.now.toISOString();
	let updated = 0;
	for (const batch of chunked(ids, RECOMPUTE_BATCH)) {
		const current = sql`(van_turfs.roster_saved_list_id IS NOT NULL AND van_turfs.roster_saved_list_id = van_turfs.saved_list_id)`;
		const result = await db.run(sql`
			UPDATE van_turfs SET
				uncontacted_doors = CASE WHEN ${current} THEN (
					SELECT count(DISTINCT r.door_hash) - count(DISTINCT CASE
						WHEN c.last_in_person_at >= coalesce(van_turfs.cut_at, van_turfs.first_seen_at)
						THEN r.door_hash END)
					FROM van_turf_roster r
					LEFT JOIN van_person_contacts c
						ON c.campaign_id = van_turfs.campaign_id AND c.person_hash = r.person_hash
					WHERE r.turf_id = van_turfs.turf_id
				) ELSE NULL END,
				uncontacted_doors_at = CASE WHEN ${current} THEN ${nowIso} ELSE NULL END
			WHERE van_turfs.turf_id IN (${sql.join(
				batch.map((id) => sql`${id}`),
				sql`, `,
			)})
		`);
		updated += Number(result.rowsAffected ?? 0);
	}
	return updated;
}

/** How long after a completion its percentage keeps being re-derived. A
 *  volunteer who syncs MiniVAN an hour after marking walked still gets the
 *  doors they knocked; after a day the figure stops moving, so the ledger and
 *  the Packet Tracker are not rewritten by whoever walks the turf next. */
export const WALK_PERCENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a retired route's roster is kept. See the header. */
export const RETIRED_ROSTER_KEEP_MS = WALK_PERCENT_WINDOW_MS;

/**
 * Derive `reportedPercent` for recent completions from the uncontacted count:
 * the share of the turf's doors with an in-person contact since the cut.
 *
 * Replaces the % the volunteer used to type from MiniVAN. It describes the
 * turf, not only this volunteer's doors — which is what every reader of it
 * wants to know: whether anything is left (the claim gate, "About N% walked")
 * and whether the packet is Complete (the Packet Tracker). Turfs with no count
 * are left alone rather than zeroed, and so is one whose roster is gone or
 * from another saved list — a figure from the wrong cut, or a division by zero
 * doors, would overwrite a good one with nonsense or NULL.
 *
 * Only rows whose figure actually changes are written, so the count returned
 * is "percentages that moved", not "completions in the window".
 */
export async function stampWalkPercents(
	db: Db,
	options: { now: Date; campaignId: number; turfIds?: readonly number[] },
): Promise<number> {
	const since = new Date(options.now.getTime() - WALK_PERCENT_WINDOW_MS).toISOString();
	const scope =
		options.turfIds === undefined
			? sql``
			: options.turfIds.length === 0
				? sql`AND 0`
				: sql`AND van_turf_checkouts.turf_id IN (${sql.join(
						options.turfIds.map((id) => sql`${id}`),
						sql`, `,
					)})`;
	const derived = sql`(
		SELECT CAST(round(100.0 * (count(DISTINCT r.door_hash) - t.uncontacted_doors)
			/ count(DISTINCT r.door_hash)) AS INTEGER)
		FROM van_turf_roster r
		JOIN van_turfs t ON t.turf_id = r.turf_id
		WHERE r.turf_id = van_turf_checkouts.turf_id
	)`;
	const result = await db.run(sql`
		UPDATE van_turf_checkouts SET reported_percent = ${derived}
		WHERE completed_at IS NOT NULL AND completed_at >= ${since}
			AND EXISTS (
				SELECT 1 FROM van_turfs t
				WHERE t.turf_id = van_turf_checkouts.turf_id
					AND t.uncontacted_doors IS NOT NULL
					AND t.roster_saved_list_id = t.saved_list_id
					AND EXISTS (SELECT 1 FROM van_turf_roster r WHERE r.turf_id = t.turf_id)
			)
			AND reported_percent IS NOT ${derived}
			AND ${campaignScope(options.campaignId)}
			${scope}
	`);
	return Number(result.rowsAffected ?? 0);
}

/** Checkouts on this campaign's turf. A run stamps only its own campaign's
 *  completions: another campaign's are counted against that campaign's
 *  contacts, and only once that campaign's pull has caught up. */
function campaignScope(campaignId: number) {
	return sql`EXISTS (
		SELECT 1 FROM van_turfs ct
		WHERE ct.turf_id = van_turf_checkouts.turf_id AND ct.campaign_id = ${campaignId}
	)`;
}

/** Contacts this long before a claim still count as its volunteer's: they
 *  may start knocking a moment before the claim lands. */
const KNOCK_LEAD_MS = 30 * 60 * 1000;
/** And this long after marking walked: the last doors of the evening can be
 *  stamped a little after the volunteer taps the button. */
const KNOCK_TRAIL_MS = 60 * 60 * 1000;

/**
 * Derive `doorsKnocked` for recent completions: the turf's doors with an
 * in-person contact between the claim and the completion. What the dashboard's
 * doors figures count per volunteer.
 *
 * Lapsed claims are counted too, between the claim and its expiry, with no
 * trailing hour — the turf is someone else's by then. The dashboard reads
 * completions only; the count is for the Packet Tracker, which clears a lapsed
 * claim's entry when it comes to 0. So a lapsed claim is not counted until
 * KNOCK_TRAIL_MS after it ended: a volunteer still walking when it lapsed,
 * or whose MiniVAN had not synced, would otherwise read as 0 and lose their
 * entries before their doors reached VAN.
 *
 * Only ever raised, never lowered. Just each person's LATEST contact is stored,
 * so a door this volunteer knocked and someone else re-knocked later would
 * otherwise fall out of this claim's window and out of their count. Stops
 * moving after WALK_PERCENT_WINDOW_MS, like the % walked. Turfs without a
 * roster are left alone (null), and the dashboard falls back to VAN's delta.
 *
 * Only called by a scheduled run that read ContactHistory up to its own start
 * (`now`), and only for checkouts that ended before it. Stamped any earlier — by the
 * nudge seconds after the tap — it would read the volunteer's doors before
 * MiniVAN's sync reached VAN, and write a 0 that hides "not counted yet".
 */
export async function stampDoorsKnocked(
	db: Db,
	options: { now: Date; campaignId: number; turfIds?: readonly number[] },
): Promise<number> {
	const since = new Date(options.now.getTime() - WALK_PERCENT_WINDOW_MS).toISOString();
	const scope =
		options.turfIds === undefined
			? sql``
			: options.turfIds.length === 0
				? sql`AND 0`
				: sql`AND van_turf_checkouts.turf_id IN (${sql.join(
						options.turfIds.map((id) => sql`${id}`),
						sql`, `,
					)})`;
	// ISO strings compare correctly as text, and this strftime shape matches
	// toISOString's, milliseconds included.
	const shifted = (column: ReturnType<typeof sql>, ms: number) =>
		sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, ${`${ms / 1000} seconds`})`;
	const until = sql`CASE WHEN van_turf_checkouts.completed_at IS NOT NULL
		THEN ${shifted(sql`van_turf_checkouts.completed_at`, KNOCK_TRAIL_MS)}
		ELSE van_turf_checkouts.released_at END`;
	const knocked = sql`(
		SELECT count(DISTINCT r.door_hash)
		FROM van_turf_roster r
		JOIN van_person_contacts c
			ON c.campaign_id = ${options.campaignId} AND c.person_hash = r.person_hash
		WHERE r.turf_id = van_turf_checkouts.turf_id
			AND c.last_in_person_at >= ${shifted(sql`van_turf_checkouts.claimed_at`, -KNOCK_LEAD_MS)}
			AND c.last_in_person_at <= ${until}
	)`;
	const nowIso = options.now.toISOString();
	const lapsedBefore = new Date(options.now.getTime() - KNOCK_TRAIL_MS).toISOString();
	const result = await db.run(sql`
		UPDATE van_turf_checkouts SET doors_knocked = ${knocked}
		WHERE (
				(completed_at IS NOT NULL AND completed_at >= ${since} AND completed_at < ${nowIso})
				OR (completed_at IS NULL AND release_reason = 'expired'
					AND released_at >= ${since} AND released_at < ${lapsedBefore})
			)
			AND EXISTS (SELECT 1 FROM van_turf_roster r WHERE r.turf_id = van_turf_checkouts.turf_id)
			AND (doors_knocked IS NULL OR doors_knocked < ${knocked})
			AND ${campaignScope(options.campaignId)}
			${scope}
	`);
	return Number(result.rowsAffected ?? 0);
}

// ---------------------------------------------------------------------------
// Pull

export interface ContactSyncOptions {
	/** The campaign whose ContactHistory this run reads, with that campaign's
	 *  client. Its state row, contacts and turf are the only ones touched. */
	campaignId: number;
	hasher: PersonHasher;
	now?: Date;
	timeBudgetMs?: number;
	/** A completion nudge: recompute these turfs as well as the ones the pull
	 *  touched. Omitted means a scheduled run — the only kind that recomputes
	 *  every turf (the first time), stamps doors knocked, and moves
	 *  `countedThrough`. */
	recomputeTurfIds?: readonly number[];
	/** For the blob download — never the VAN client, which would send our
	 *  Basic credentials to a different host. */
	fetchFn?: FetchFn;
	sleep?: (ms: number) => Promise<void>;
}

export interface ContactSyncResult {
	/** Windows fully applied this run. */
	windowsApplied: number;
	/** In-person contact rows read (before de-duplication by person). */
	contactsRead: number;
	/** The cursor after this run: contacts up to here are applied. */
	cursor: string | null;
	/** A window's job is still running and will be polled next run. */
	pending: boolean;
	turfsRecomputed: number;
	/** Recent completions whose % walked was re-derived. */
	percentsStamped: number;
	/** Recent completions whose doors knocked went up. */
	doorsKnockedStamped: number;
	contactsPruned: number;
	error: string | null;
}

function isStatus(job: VanChangedEntityExportJob, wanted: string): boolean {
	return (job.jobStatus ?? '').trim().toLowerCase() === wanted;
}

/**
 * Stream one ContactHistory file into `into`, keeping the latest in-person
 * contact per person. Only five columns are ever read; the VanID is hashed at
 * the delimiter and nothing else about the row is kept.
 *
 * A row whose change type is a deletion is skipped: it is a contact someone
 * removed from VAN (entered on the wrong person, most often), not a knock.
 */
async function readContactFile(
	chunks: AsyncIterable<string>,
	kinds: { inPerson: ReadonlySet<string>; deletions: ReadonlySet<string> },
	hasher: PersonHasher,
	into: Map<string, { personHash: Buffer; at: string }>,
): Promise<number> {
	let header: string[] | null = null;
	let keep: Set<number> | null = null;
	let vanId = -1;
	let type = -1;
	let change = -1;
	let canvassed = -1;
	let created = -1;
	let read = 0;
	for await (const row of csvRows(chunks, (i) => (i === 0 ? null : keep))) {
		if (header === null) {
			header = row.map((cell) =>
				cell
					.replace(/^\uFEFF/, '')
					.trim()
					.toLowerCase(),
			);
			vanId = header.indexOf('vanid');
			type = header.indexOf('contacttypeid');
			change = header.indexOf('changetypeid');
			canvassed = header.indexOf('datecanvassed');
			created = header.indexOf('datecreated');
			if (vanId < 0 || type < 0 || (canvassed < 0 && created < 0)) {
				throw new Error('ContactHistory export is missing VanID, ContactTypeID or its dates');
			}
			keep = new Set([vanId, type, change, canvassed, created].filter((i) => i >= 0));
			continue;
		}
		if (!kinds.inPerson.has((row[type] ?? '').trim())) continue;
		if (change >= 0 && kinds.deletions.has((row[change] ?? '').trim())) continue;
		const id = (row[vanId] ?? '').trim();
		// When it was canvassed, not when it was keyed in: a paper list entered
		// three days late still happened on the day it was walked.
		const at =
			(canvassed >= 0 ? contactTimestamp(row[canvassed] ?? '') : null) ??
			(created >= 0 ? contactTimestamp(row[created] ?? '') : null);
		if (!id || !at) continue;
		read++;
		const personHash = hasher.person(id);
		const key = personHash.toString('hex');
		const prior = into.get(key);
		if (!prior || prior.at < at) into.set(key, { personHash, at });
	}
	return read;
}

/**
 * The ContactHistory change type ids that mean "deleted". Best-effort: if VAN
 * will not say, deletions count as contacts — the pre-existing behaviour, and
 * better than no count at all — and the log says so every run.
 */
async function deletionChangeTypes(client: VanClient): Promise<Set<string>> {
	try {
		const ids = (await client.changeTypes('ContactHistory'))
			.filter((t) => /delet/i.test(t.changeTypeName ?? ''))
			.map((t) => t.changeTypeId ?? t.changeTypeID)
			.filter((id): id is number => typeof id === 'number');
		return new Set(ids.map(String));
	} catch (err) {
		console.warn(
			`${LOG} ContactHistory change types unavailable; deleted contacts will count:`,
			errMessage(err),
		);
		return new Set();
	}
}

/** Signed blob URLs that will never work again: expired, revoked or gone. */
function isDeadDownload(status: number): boolean {
	return status === 403 || status === 404 || status === 410;
}

/**
 * Walk the ContactHistory cursor forward as far as the budget allows, then
 * recompute uncontacted doors.
 *
 * Which turfs are recomputed: every counted turf on the first scheduled run
 * (or the first after the feature is switched back on), and after that only
 * those with a person in the contacts this run pulled, plus the nudge's own.
 * Nothing else moves a count: a new roster is recomputed by the geometry
 * worker that wrote it, and the prune only drops contacts below every cut.
 *
 * Never throws for a VAN failure: the error is recorded on the state row and
 * returned, and the recompute still runs over whatever is stored — a stale
 * count beats no count. A thrown error means the database itself failed.
 *
 * No job can wedge the pull. One VAN reports as failed is dropped at once; one
 * whose files cannot be read is dropped after MAX_JOB_FAILURES tries, or at
 * once when its signed URL is dead; one that never completes is dropped after
 * JOB_STALE_MS. Each time the same window is simply submitted again.
 */
export async function runContactSync(
	db: Db,
	client: VanClient,
	options: ContactSyncOptions,
): Promise<ContactSyncResult> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const fetchFn = options.fetchFn ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const result: ContactSyncResult = {
		windowsApplied: 0,
		contactsRead: 0,
		cursor: null,
		pending: false,
		turfsRecomputed: 0,
		percentsStamped: 0,
		doorsKnockedStamped: 0,
		contactsPruned: 0,
		error: null,
	};

	const { campaignId } = options;
	await db.insert(vanContactSyncState).values({ campaignId }).onConflictDoNothing();
	const [state] = await db
		.select()
		.from(vanContactSyncState)
		.where(eq(vanContactSyncState.campaignId, campaignId));
	let cursor = state?.cursor ?? null;
	// A state row from before `coveredFrom` existed: all that is known is that
	// the pull reached the cursor, so treat that as where it began.
	let coveredFrom = state?.coveredFrom ?? cursor;
	let jobId = state?.exportJobId ?? null;
	let jobCreatedAt = state?.exportJobCreatedAt ?? null;
	let jobFailures = state?.exportJobFailures ?? 0;
	let windowTo = state?.windowTo ?? null;
	const scheduled = options.recomputeTurfIds === undefined;
	/** Everyone whose contact this run stored, keyed by hex digest. */
	const touched = new Map<string, Buffer>();

	const saveState = (patch: Partial<typeof vanContactSyncState.$inferInsert>) =>
		db
			.update(vanContactSyncState)
			.set({ lastRunAt: now.toISOString(), ...patch })
			.where(eq(vanContactSyncState.campaignId, campaignId));

	/** Abandon the current job; the next loop submits its window afresh. */
	const dropJob = async (message: string) => {
		jobId = null;
		jobCreatedAt = null;
		jobFailures = 0;
		result.error = message;
		await saveState({
			exportJobId: null,
			exportJobCreatedAt: null,
			exportJobFailures: 0,
			windowFrom: null,
			windowTo: null,
			lastError: message.slice(0, 500),
		});
	};

	try {
		const floor = await pullFloor(db, campaignId, now);
		// Only between jobs: a job in flight finishes its window first.
		if (floor !== null && jobId === null) {
			if (cursor === null || coveredFrom === null || floor < coveredFrom) {
				// The first run, or a turf cut before anything read so far — a
				// newly mapped folder, an un-retired route. Re-reading from there
				// is idempotent, and it is the only way that turf's earlier
				// contacts are ever seen.
				cursor = floor;
				coveredFrom = floor;
				await saveState({ cursor, coveredFrom });
			} else if (cursor < floor) {
				// Idle longer than MAX_BACKFILL_MS: nothing before the floor is
				// kept, so there is no point reading it.
				cursor = floor;
				await saveState({ cursor });
			}
		}

		if (cursor !== null && floor !== null) {
			// Resolved per run rather than hardcoded: contact type ids are per
			// committee, and the channel is what says "someone was at the door".
			const inPerson = new Set(
				(await client.contactTypes())
					.filter(
						(t) =>
							(t.channelTypeName ?? '').trim().toLowerCase() === IN_PERSON_CHANNEL &&
							!NOT_A_DOOR_CONTACT_TYPES.has((t.name ?? '').trim().toLowerCase()),
					)
					.map((t) => String(t.contactTypeId)),
			);
			if (inPerson.size === 0) {
				// Not fatal, but every row of every window below is skipped and the
				// cursor still moves past it — those contacts are never read again
				// without a manual rewind. Loud, so someone looks.
				console.error(
					`${LOG} no in-person contact types found in VAN; ContactHistory windows read ` +
						'now will store no contacts',
				);
			}
			const deletions = await deletionChangeTypes(client);

			while (Date.now() < deadline) {
				if (jobId === null) {
					const cursorMs = Date.parse(cursor!);
					const toMs = Math.min(cursorMs + WINDOW_MS, now.getTime());
					if (toMs - cursorMs < MIN_WINDOW_MS) break;
					const from = new Date(cursorMs - OVERLAP_MS).toISOString();
					const to = new Date(toMs).toISOString();
					windowTo = to;
					const created = await client.createChangedEntityExportJob({
						resourceType: 'ContactHistory',
						dateChangedFrom: from,
						dateChangedTo: to,
					});
					jobId = created.exportJobId;
					jobCreatedAt = now.toISOString();
					jobFailures = 0;
					// Stored before waiting, so a run cut short resumes this job
					// rather than submitting the same window twice.
					await saveState({
						exportJobId: jobId,
						exportJobCreatedAt: jobCreatedAt,
						exportJobFailures: 0,
						windowFrom: from,
						windowTo,
					});
				}

				let job = await client.changedEntityExportJob(jobId);
				while (!isStatus(job, 'complete') && !isStatus(job, 'error')) {
					if (deadline - Date.now() < POLL_INTERVAL_MS) break;
					await sleep(POLL_INTERVAL_MS);
					job = await client.changedEntityExportJob(jobId);
				}
				if (isStatus(job, 'error')) {
					await dropJob(`ContactHistory export ${jobId} failed: ${job.message ?? 'no message'}`);
					break;
				}
				if (!isStatus(job, 'complete')) {
					const age = jobCreatedAt ? now.getTime() - Date.parse(jobCreatedAt) : 0;
					if (age > JOB_STALE_MS) {
						await dropJob(
							`ContactHistory export ${jobId} still ${job.jobStatus ?? 'unfinished'} after ` +
								`${Math.round(age / 60000)} min; resubmitting`,
						);
						break;
					}
					result.pending = true;
					break;
				}

				const contacts = new Map<string, { personHash: Buffer; at: string }>();
				let read = 0;
				let dead = false;
				try {
					for (const file of job.files ?? []) {
						const res = await fetchFn(file.downloadUrl, {
							signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now())),
						});
						if (!res.ok) {
							await res.body?.cancel().catch(() => {});
							dead = isDeadDownload(res.status);
							throw new Error(`download returned HTTP ${res.status}`);
						}
						read += await readContactFile(
							responseChunks(res),
							{ inPerson, deletions },
							options.hasher,
							contacts,
						);
					}
				} catch (err) {
					const message = `ContactHistory export ${jobId}: ${errMessage(err)}`;
					jobFailures++;
					if (dead || jobFailures >= MAX_JOB_FAILURES) {
						await dropJob(message);
					} else {
						// Left in place: a transient failure re-reads the same
						// job's files next run rather than paying for a new export.
						result.error = message;
						await saveState({ exportJobFailures: jobFailures, lastError: message.slice(0, 500) });
					}
					break;
				}
				await upsertContacts(db, campaignId, contacts);
				for (const [key, c] of contacts) touched.set(key, c.personHash);
				result.contactsRead += read;
				cursor = windowTo!;
				jobId = null;
				jobCreatedAt = null;
				jobFailures = 0;
				await saveState({
					cursor,
					exportJobId: null,
					exportJobCreatedAt: null,
					exportJobFailures: 0,
					windowFrom: null,
					windowTo: null,
					lastError: null,
				});
				result.windowsApplied++;
			}
		}

		// Nothing below the floor can count against any turf.
		if (floor) {
			const pruned = await db
				.delete(vanPersonContacts)
				.where(
					and(
						eq(vanPersonContacts.campaignId, campaignId),
						lt(vanPersonContacts.lastInPersonAt, floor),
					),
				)
				.returning({ at: vanPersonContacts.lastInPersonAt });
			result.contactsPruned = pruned.length;
		}
	} catch (err) {
		result.error = errMessage(err);
		await saveState({ lastError: result.error.slice(0, 500) }).catch(() => {});
	}

	result.cursor = cursor;
	const full = scheduled && !state?.fullRecomputeAt;
	const recomputeIds = full
		? undefined
		: [
				...new Set([
					...(options.recomputeTurfIds ?? []),
					...(await turfsWithPeople(db, campaignId, [...touched.values()])),
				]),
			];
	result.turfsRecomputed = await recomputeUncontacted(db, {
		now,
		campaignId,
		turfIds: recomputeIds,
	});
	if (full) await saveState({ fullRecomputeAt: now.toISOString() });
	result.percentsStamped = await stampWalkPercents(db, {
		now,
		campaignId,
		turfIds: options.recomputeTurfIds,
	});

	// Caught up: nothing failed, no job left waiting, and the cursor reached
	// this run's start. Only then is a completion before `now` in the count.
	const caughtUp =
		result.error === null &&
		!result.pending &&
		cursor !== null &&
		now.getTime() - Date.parse(cursor) < MIN_WINDOW_MS;
	if (scheduled && caughtUp) {
		result.doorsKnockedStamped = await stampDoorsKnocked(db, { now, campaignId });
		await saveState({ countedThrough: now.toISOString() });
	}
	return result;
}

/** Live turfs, and how many have a roster for their current saved list. */
export async function rosterProgress(db: Db): Promise<{ live: number; rostered: number }> {
	const [row] = await db
		.select({
			live: sql<number>`count(*)`,
			rostered: sql<number>`sum(case when ${vanTurfs.rosterSavedListId} = ${vanTurfs.savedListId} then 1 else 0 end)`,
		})
		.from(vanTurfs)
		.where(isNull(vanTurfs.retiredAt));
	return { live: Number(row?.live ?? 0), rostered: Number(row?.rostered ?? 0) };
}
