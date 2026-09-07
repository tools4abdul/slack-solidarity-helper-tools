// Mirrors Mobilize signups back into Solidarity as event RSVPs, server side.
//
// Companion to mobilize-sync.ts, which pushes events the other way. The
// algorithm lives in mobilize-migrator/lib/attendee-sync.ts; this supplies
// credentials from $env and a Turso-backed ledger.
//
// Two modes, both driven by the same code and differing only in scope:
//   - imminent: sessions inside a look-ahead window, run every 30 minutes so
//               organizers have accurate lists before doors open
//   - nightly:  no window, so events further out still get a rolling picture
//
// Both look back as well as forward: check-ins are recorded during and after an
// event, so a forward-only scope would never sync who actually showed up. The
// zip -> chapter map rebuilds on staleness rather than on a mode, which is why
// neither cron entry is special-cased.

import { desc, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import {
	runAttendeeSync,
	type AttendeeLedger,
	type AttendeeSyncReport,
	type RsvpRecord,
	type TimeslotLink,
} from '../../../mobilize-migrator/lib/attendee-sync.js';
import { buildZipChapterMap } from '../../../mobilize-migrator/lib/people.js';
import { fetchAllEvents } from '../../../mobilize-migrator/lib/solidarity.js';
import { loadMobilizeApi } from './mobilize-api.js';
import {
	ATTENDEE_SYNC_MAX_NEW_PROFILES,
	SOLIDARITY_DEFAULT_CHAPTER_ID,
	SOLIDARITY_API_TOKEN,
} from './env.js';
import { mobilizeSyncedRsvps, mobilizeSyncedTimeslots, zipChapterMap } from './schema.js';
import { fetchPaginated } from './solidarity-paginate.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

class TursoAttendeeLedger implements AttendeeLedger {
	constructor(private readonly db: Db) {}

	async rsvpsByAttendanceId(): Promise<Map<number, RsvpRecord>> {
		const rows = await this.db.select().from(mobilizeSyncedRsvps);
		return new Map(
			rows.map((row) => [
				row.mobilizeAttendanceId,
				{
					mobilizeAttendanceId: row.mobilizeAttendanceId,
					solidarityRsvpId: row.solidarityRsvpId,
					solidarityUserId: row.solidarityUserId,
					solidaritySessionId: row.solidaritySessionId,
					status: row.status,
					attended: row.attended,
					modifiedDate: row.mobilizeModifiedDate,
				},
			]),
		);
	}

	async recordRsvp(record: RsvpRecord): Promise<void> {
		const now = new Date().toISOString();
		const { modifiedDate, ...rest } = record;
		await this.db
			.insert(mobilizeSyncedRsvps)
			.values({ ...rest, mobilizeModifiedDate: modifiedDate, syncedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedRsvps.mobilizeAttendanceId,
				set: {
					solidarityRsvpId: record.solidarityRsvpId,
					solidarityUserId: record.solidarityUserId,
					solidaritySessionId: record.solidaritySessionId,
					status: record.status,
					attended: record.attended,
					mobilizeModifiedDate: modifiedDate,
					syncedAt: now,
				},
			});
	}

	/**
	 * Forget the shift pairings for a Mobilize event that has been deleted there.
	 *
	 * Only the pairings go. The event ledger row stays, because the event sync
	 * treats an event deleted in Mobilize as deliberate and does not resurrect it;
	 * so do the mirrored RSVP rows, which record what was written into Solidarity
	 * and is still true.
	 */
	async forgetEvent(mobilizeEventId: number): Promise<void> {
		await this.db
			.delete(mobilizeSyncedTimeslots)
			.where(eq(mobilizeSyncedTimeslots.mobilizeEventId, mobilizeEventId));
	}
}

export interface AttendeeSyncOptions {
	apply?: boolean;
	/**
	 * Only sync sessions starting within this many hours. OMIT it for every
	 * upcoming session — 0 is a real window of zero hours, not "no limit", and
	 * would match nothing.
	 *
	 * This bounds the run, though far less sharply than it used to: signups are
	 * fetched one request per Mobilize EVENT rather than one per shift, and an
	 * event usually carries several shifts. A windowless pass is tens of requests
	 * against a 15/s budget, so the window is now about keeping the Solidarity
	 * write side small rather than about surviving the Mobilize read side.
	 */
	windowHours?: number;
	/**
	 * Also include sessions that started this recently. Check-ins are recorded
	 * during and after an event, so without a lookback the `attended` outcome
	 * would never reach Solidarity.
	 */
	lookbackHours?: number;
	maxNewProfiles?: number;
}

export interface AttendeeSyncResult extends AttendeeSyncReport {
	dryRun: boolean;
	windowHours: number | null;
	lookbackHours: number;
	zipsMapped: number;
}

const ZIP_MAP_MAX_AGE_MS = 24 * 3600_000;

/** True when the derived zip map is missing or older than a day. */
async function zipMapIsStale(db: Db): Promise<boolean> {
	const rows = await db
		.select({ updatedAt: zipChapterMap.updatedAt })
		.from(zipChapterMap)
		.orderBy(desc(zipChapterMap.updatedAt))
		.limit(1);
	const newest = rows[0]?.updatedAt;
	if (!newest) return true;
	return Date.now() - Date.parse(newest) > ZIP_MAP_MAX_AGE_MS;
}

/**
 * Rebuild zip -> chapter from where members actually sit. Solidarity chapters
 * have no geographic fields, so this is derived rather than fetched. Nightly is
 * often enough; the imminent pass reads the cached table.
 */
export async function refreshZipChapterMap(db: Db): Promise<number> {
	const users = await fetchPaginated<{
		address?: { zip_code?: string | null } | null;
		chapter_ids?: number[] | null;
	}>(SOLIDARITY_API_TOKEN, '/v1/users', 'zip chapter map', '', 'attendee-sync');

	const map = buildZipChapterMap(users);
	const now = new Date().toISOString();
	const rows = [...map].map(([zipCode, { chapterId, memberCount }]) => ({
		zipCode,
		chapterId,
		memberCount,
		updatedAt: now,
	}));

	// Chunked to stay under libsql's statement/variable limits.
	for (let i = 0; i < rows.length; i += 200) {
		await db
			.insert(zipChapterMap)
			.values(rows.slice(i, i + 200))
			.onConflictDoUpdate({
				target: zipChapterMap.zipCode,
				set: {
					chapterId: sqlExcluded('chapter_id'),
					memberCount: sqlExcluded('member_count'),
					updatedAt: now,
				},
			});
	}
	return rows.length;
}

// drizzle has no typed `excluded` helper for sqlite upserts; this keeps the
// raw reference in one place.
function sqlExcluded(column: string) {
	return sql.raw(`excluded.${column}`);
}

export async function runSolidarityAttendeeSync(
	db: Db,
	options: AttendeeSyncOptions = {},
): Promise<AttendeeSyncResult> {
	const apply = options.apply ?? true;
	const api = loadMobilizeApi('the attendee sync');
	const windowHours = options.windowHours ?? null;
	const lookbackHours = options.lookbackHours ?? 48;

	// Rebuilt on staleness rather than on a separate nightly schedule, so this
	// whole sync needs only one cron entry. Walking every Solidarity user is
	// expensive, hence once a day rather than every run.
	let zipsMapped = 0;
	if (apply && (await zipMapIsStale(db))) {
		zipsMapped = await refreshZipChapterMap(db);
	}

	const now = Date.now();
	const upperBound = windowHours === null ? null : now + windowHours * 3600_000;
	const lowerBound = now - lookbackHours * 3600_000;

	// Which Mobilize timeslots to read, from pairings the event sync recorded.
	const pairings = await db.select().from(mobilizeSyncedTimeslots);

	// Session start times come from Solidarity, which is also where the owning
	// chapter lives (the fallback when a zip can't be mapped).
	const events = await fetchAllEvents(SOLIDARITY_API_TOKEN);
	const sessionMeta = new Map<
		number,
		{ startsAt: number; chapterId: number | null; capacity: number | null }
	>();
	for (const event of events) {
		const chapterId = event.scope_type === 'Chapter' ? event.scope_id : null;
		for (const session of event.event_sessions) {
			sessionMeta.set(session.id, {
				startsAt: Date.parse(session.start_time),
				chapterId,
				// Solidarity uses 0 for "no cap", the same convention transform.ts
				// handles on the way out. Anything at or below zero is uncapped.
				capacity: (session.max_capacity ?? 0) > 0 ? session.max_capacity : null,
			});
		}
	}

	const links: TimeslotLink[] = [];
	for (const pairing of pairings) {
		const meta = sessionMeta.get(pairing.solidaritySessionId);
		if (!meta || !Number.isFinite(meta.startsAt)) continue;
		if (meta.startsAt < lowerBound) continue;
		if (upperBound !== null && meta.startsAt > upperBound) continue;
		links.push({
			mobilizeTimeslotId: pairing.mobilizeTimeslotId,
			mobilizeEventId: pairing.mobilizeEventId,
			solidarityEventId: pairing.solidarityEventId,
			solidaritySessionId: pairing.solidaritySessionId,
			eventChapterId: meta.chapterId,
			startsAt: meta.startsAt,
			sessionCapacity: meta.capacity,
		});
	}

	const zipRows = await db.select().from(zipChapterMap);
	const zipChapters = new Map(zipRows.map((row) => [row.zipCode, { chapterId: row.chapterId }]));

	const report = await runAttendeeSync(
		links,
		{
			api,
			solidarityToken: SOLIDARITY_API_TOKEN,
			apply,
			maxNewProfiles: options.maxNewProfiles ?? ATTENDEE_SYNC_MAX_NEW_PROFILES,
			log: (message) => console.log(`[attendee-sync] ${message}`),
		},
		new TursoAttendeeLedger(db),
		zipChapters,
		SOLIDARITY_DEFAULT_CHAPTER_ID || null,
	);

	return { ...report, dryRun: !apply, windowHours, lookbackHours, zipsMapped };
}

export type { AttendeeSyncReport };
