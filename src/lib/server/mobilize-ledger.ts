// Turso-backed ledger for the Mobilize event sync.
//
// Deliberately free of $env and $lib imports — only drizzle and schema.js — so
// the CLI (mobilize-migrator/migrate.ts, which runs outside the Vite bundle via
// tsx) can share it with the SvelteKit endpoint. There is exactly one record of
// what has been created, which is the whole point: a second file-based ledger
// used to live alongside this one and drifted the moment the server ran.

import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type {
	Ledger,
	LedgerRecord,
	PushedCap,
	TimeslotPairing,
} from '../../../mobilize-migrator/lib/sync.js';
import {
	mobilizeGeocodedZips,
	mobilizeSyncedEvents,
	mobilizeSyncedImages,
	mobilizeSyncedTimeslots,
} from './schema.js';

export type LedgerDb = LibSQLDatabase<Record<string, unknown>>;

export class TursoLedger implements Ledger {
	constructor(private readonly db: LedgerDb) {}

	async all(): Promise<LedgerRecord[]> {
		return this.db
			.select({
				key: mobilizeSyncedEvents.key,
				mobilizeEventId: mobilizeSyncedEvents.mobilizeEventId,
				title: mobilizeSyncedEvents.title,
			})
			.from(mobilizeSyncedEvents);
	}

	async record(entry: LedgerRecord): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insert(mobilizeSyncedEvents)
			.values({ ...entry, createdAt: now, lastSyncedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedEvents.key,
				set: { mobilizeEventId: entry.mobilizeEventId, title: entry.title, lastSyncedAt: now },
			});
	}

	async imageFor(sourceUrl: string): Promise<string | null> {
		const rows = await this.db
			.select({ mobilizeUrl: mobilizeSyncedImages.mobilizeUrl })
			.from(mobilizeSyncedImages)
			.where(eq(mobilizeSyncedImages.sourceUrl, sourceUrl));
		return rows[0]?.mobilizeUrl ?? null;
	}

	/** Upserts rather than ignoring a conflict: a re-upload happens precisely
	 *  because the recorded URL was no longer usable, and keeping the old row
	 *  would re-upload the same image every night forever. */
	async recordImage(sourceUrl: string, mobilizeUrl: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insert(mobilizeSyncedImages)
			.values({ sourceUrl, mobilizeUrl, uploadedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedImages.sourceUrl,
				set: { mobilizeUrl, uploadedAt: now },
			});
	}

	/** Geocoded once per venue: Mobilize requires a postal code, and Solidarity
	 *  frequently has none. */
	async zipFor(point: string): Promise<string | null> {
		const rows = await this.db
			.select({ postalCode: mobilizeGeocodedZips.postalCode })
			.from(mobilizeGeocodedZips)
			.where(eq(mobilizeGeocodedZips.point, point));
		return rows[0]?.postalCode ?? null;
	}

	async recordZip(point: string, postalCode: string): Promise<void> {
		await this.db
			.insert(mobilizeGeocodedZips)
			.values({ point, postalCode, lookedUpAt: new Date().toISOString() })
			.onConflictDoNothing();
	}

	/**
	 * What we last sent as each shift's `max_attendees`.
	 *
	 * Rows written before capacity tracking carry NULL, which reads as "uncapped".
	 * That is the safe way round: a capped shift then looks like a change and gets
	 * its cap established on the next pass, where the opposite would leave a real
	 * cap unpushed forever.
	 */
	async pushedCaps(): Promise<Map<number, number | null>> {
		const rows = await this.db
			.select({
				id: mobilizeSyncedTimeslots.mobilizeTimeslotId,
				cap: mobilizeSyncedTimeslots.pushedMaxAttendees,
			})
			.from(mobilizeSyncedTimeslots);
		return new Map(rows.map((row) => [row.id, row.cap ?? null]));
	}

	/** Written only after the create or update that carried these actually landed. */
	async recordPushedCaps(entries: PushedCap[]): Promise<void> {
		if (entries.length === 0) return;
		for (const entry of entries) {
			await this.db
				.update(mobilizeSyncedTimeslots)
				.set({ pushedMaxAttendees: entry.maxAttendees })
				.where(eq(mobilizeSyncedTimeslots.mobilizeTimeslotId, entry.mobilizeTimeslotId));
		}
	}

	/** Consumed by the attendee sync to file a signup against the right session. */
	async recordTimeslots(pairings: TimeslotPairing[]): Promise<void> {
		if (pairings.length === 0) return;
		const now = new Date().toISOString();
		for (const pairing of pairings) {
			await this.db
				.insert(mobilizeSyncedTimeslots)
				.values({ ...pairing, updatedAt: now })
				.onConflictDoUpdate({
					target: mobilizeSyncedTimeslots.mobilizeTimeslotId,
					set: {
						solidarityEventId: pairing.solidarityEventId,
						solidaritySessionId: pairing.solidaritySessionId,
						updatedAt: now,
					},
				});
		}
	}
}
