// MiniVAN exports, kept locally and topped up from VAN a page or two at a time.
//
// VAN's half of the drift report (Story 8.2) is "which printed lists has an
// organizer exported to a named canvasser". The only way to read that cheaply is
// forward from a date (`generatedAfter`, see client.ts), so the catalog sync asks
// for everything since the newest export it already holds and stores it here.
// The distribution index is then built from this table rather than from
// whatever one VAN read happened to return — which is what made a turf's
// `van_distributed_to` flicker between syncs before.
//
// Two numbers bound it:
//
//   - LOOKBACK: an empty table backfills 30 days. Printed lists expire 30 days
//     after they are generated and an export can only follow its list, so an
//     older export describes a list number that no longer loads in MiniVAN.
//
//   - RETENTION: rows older than 45 days are pruned. Longer than the lookback so
//     that a list generated on day 29 keeps the export that went out on day 1
//     of its life; short enough to keep a statewide campaign's ~1,000 exports
//     a day to tens of thousands of rows.

import { eq, gte, inArray, lt, max } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanMinivanExports, vanTurfCheckouts, type NewVanMinivanExportRow } from '../schema.js';
import { listNumberFromExportName, type CatalogClaim } from './catalog.js';
import type { VanClient } from './client.js';
import { chunked } from './sql-chunk.js';
import type { VanMinivanExport } from './types.js';

type Db = ReturnType<typeof drizzle>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPORT_LOOKBACK_DAYS = 30;
export const EXPORT_RETENTION_DAYS = 45;
/** Pages of 50 per sync. VAN answers a filtered page in ~150-400ms, so this is
 *  under a minute of a sync's four — and a 30-day backfill of a busy campaign
 *  (~25,000 exports) finishes over its first few syncs rather than one. */
export const MAX_EXPORT_PAGES_PER_SYNC = 150;
const WRITE_BATCH_SIZE = 100;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/;

function dateOnly(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `generatedAfter` date to read from.
 *
 * The date of the newest stored export, NOT the day after it. That day is read
 * again, deliberately: a date is all VAN's filter compares reliably (client.ts),
 * so re-reading it is the only way to pick up exports that landed later on the
 * same day. The overlap is harmless because rows upsert on their export id.
 *
 * Never earlier than the lookback, so a table left idle for weeks resumes at
 * the window that matters rather than replaying everything it missed.
 */
export function exportCursor(newestDateCreated: string | null, now: Date): string {
	const floor = dateOnly(now.getTime() - EXPORT_LOOKBACK_DAYS * DAY_MS);
	const newest =
		newestDateCreated && DATE_ONLY.test(newestDateCreated) ? newestDateCreated.slice(0, 10) : null;
	return newest !== null && newest > floor ? newest : floor;
}

export interface ExportPullResult {
	/** The date this run read from. */
	from: string;
	/** Exports VAN returned this run, overlap included. */
	fetched: number;
	/** False when the page cap stopped the walk: the store is still behind, and
	 *  the next sync resumes from the newest date this one reached. */
	complete: boolean;
}

/**
 * Read exports newer than what is stored, write them, and prune old ones.
 *
 * Throws if VAN does — a 403 on a key without Tier 3, or a walk that could not
 * finish. Nothing from a failed run is written, and the store keeps what it had.
 *
 * A single day with more than MAX_EXPORT_PAGES_PER_SYNC pages (7,500 exports)
 * would pin the cursor to that day. The busiest day seen so far had ~1,000.
 */
export async function pullMinivanExports(
	db: Db,
	client: VanClient,
	options: { now: Date; maxPages?: number },
): Promise<ExportPullResult> {
	const { now } = options;
	const [row] = await db
		.select({ newest: max(vanMinivanExports.dateCreated) })
		.from(vanMinivanExports);
	const from = exportCursor(row?.newest ?? null, now);

	const { items, complete } = await client.minivanExportsSince(
		from,
		options.maxPages ?? MAX_EXPORT_PAGES_PER_SYNC,
	);

	const fetchedAt = now.toISOString();
	const rows: NewVanMinivanExportRow[] = items
		.filter((item) => typeof item.minivanExportId === 'number')
		.map((item) => ({
			minivanExportId: item.minivanExportId,
			name: item.name ?? null,
			listNumber: listNumberFromExportName(item.name),
			dateCreated: item.dateCreated ?? null,
			canvassersJson: JSON.stringify(item.canvassers ?? []),
			fetchedAt,
		}));

	// Upserted rather than inserted-or-ignored: an export re-read on the
	// overlap day is the same record, but VAN is the authority on it and a
	// canvasser list edited after the fact should land.
	for (const batch of chunked(rows, WRITE_BATCH_SIZE)) {
		const statements = batch.map((r) =>
			db
				.insert(vanMinivanExports)
				.values(r)
				.onConflictDoUpdate({ target: vanMinivanExports.minivanExportId, set: r }),
		);
		await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
	}

	await db
		.delete(vanMinivanExports)
		.where(
			lt(vanMinivanExports.dateCreated, dateOnly(now.getTime() - EXPORT_RETENTION_DAYS * DAY_MS)),
		);

	return { from, fetched: items.length, complete };
}

/**
 * Stored exports for the given printed list numbers, in the shape VAN returns,
 * for the catalog planner's distribution index.
 *
 * Scoped to list numbers the catalog could issue this run, rather than the
 * whole table: that table is tens of thousands of rows and nearly all of them
 * name lists from other campaigns' folders.
 *
 * Ordered by date for readability in a debugger; the index picks each list's
 * latest export itself and does not depend on this order.
 */
export async function loadMinivanExports(
	db: Db,
	listNumbers: readonly string[],
): Promise<VanMinivanExport[]> {
	const unique = [...new Set(listNumbers.map((n) => n.trim()).filter(Boolean))];
	const rows = [];
	for (const batch of chunked(unique)) {
		rows.push(
			...(await db
				.select()
				.from(vanMinivanExports)
				.where(inArray(vanMinivanExports.listNumber, batch))),
		);
	}
	rows.sort(
		(a, b) =>
			(a.dateCreated ?? '').localeCompare(b.dateCreated ?? '') ||
			a.minivanExportId - b.minivanExportId,
	);
	return rows.map((row) => ({
		minivanExportId: row.minivanExportId,
		name: row.name,
		dateCreated: row.dateCreated,
		createdBy: null,
		canvassers: parseCanvassers(row.canvassersJson),
		databaseMode: null,
	}));
}

/** A corrupt row reads as "nobody assigned", which the index already skips —
 *  never as an exception that takes the whole catalog sync down with it. */
function parseCanvassers(json: string): VanMinivanExport['canvassers'] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as VanMinivanExport['canvassers']) : [];
	} catch {
		return [];
	}
}

/**
 * Our own claims that the stored exports could fall inside — the input that
 * tells the catalog "this export was our volunteer loading the list".
 *
 * Every claim claimed within the retention window, whatever its state: a
 * completed or released claim still explains an export made while it ran.
 * Older claims cannot overlap any export the store still holds.
 */
export async function loadClaimsForExports(db: Db, now: Date): Promise<CatalogClaim[]> {
	const rows = await db
		.select({
			id: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			loadedInMinivanAt: vanTurfCheckouts.loadedInMinivanAt,
		})
		.from(vanTurfCheckouts)
		.where(
			gte(
				vanTurfCheckouts.claimedAt,
				new Date(now.getTime() - EXPORT_RETENTION_DAYS * DAY_MS).toISOString(),
			),
		);
	return rows.map((r) => ({
		checkoutId: r.id,
		mapRouteId: r.mapRouteId,
		claimedAt: r.claimedAt,
		endedAt: r.completedAt ?? r.releasedAt ?? r.expiresAt,
		loadedInMinivanAt: r.loadedInMinivanAt,
	}));
}

/** Record that a claim's list was seen loaded in MiniVAN. */
export async function stampClaimsLoaded(
	db: Db,
	stamps: ReadonlyArray<{ checkoutId: number; loadedAt: string }>,
): Promise<void> {
	for (const batch of chunked([...stamps], WRITE_BATCH_SIZE)) {
		const statements = batch.map((s) =>
			db
				.update(vanTurfCheckouts)
				.set({ loadedInMinivanAt: s.loadedAt })
				.where(eq(vanTurfCheckouts.id, s.checkoutId)),
		);
		await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
	}
}
