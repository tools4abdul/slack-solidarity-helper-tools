// Nightly Solidarity -> Mobilize event sync, server side.
//
// The algorithm lives in mobilize-migrator/lib/* so the same code backs both the
// CLI scripts and this endpoint. This module supplies the three things that
// differ on the server: credentials from $env, the event contact from
// /settings, and a Turso-backed ledger instead of a JSON file.
//
// Auth: MOBILIZE_API_KEY must have write ("restricted") access — creating
// events and uploading images both require it. A 403 means the key is rejected
// or lost that grant, and the sync reports authFailed and posts a Slack alert.

import type { drizzle } from 'drizzle-orm/libsql';

import { findDuplicate } from '../../../mobilize-migrator/lib/dedupe.js';
import { fetchPageDescriptions } from '../../../mobilize-migrator/lib/pages.js';
import { loadMobilizeApi } from './mobilize-api.js';
import { TursoLedger } from './mobilize-ledger.js';
import { fetchAllEvents } from '../../../mobilize-migrator/lib/solidarity.js';
import { listSessionRsvps } from '../../../mobilize-migrator/lib/rsvp.js';
import { countSolidaritySeats } from '../../../mobilize-migrator/lib/seats.js';
import { runSync, type SyncReport } from '../../../mobilize-migrator/lib/sync.js';
import { planMigration } from '../../../mobilize-migrator/lib/transform.js';
import { loadSettings } from './settings.js';
import { MOBILIZE_SYNC_MAX_CREATES, SOLIDARITY_API_TOKEN } from './env.js';

// The full drizzle type rather than LibSQLDatabase: loadSettings needs $client.
type Db = ReturnType<typeof drizzle>;

/**
 * How long one request may spend before it stops starting new writes.
 *
 * fly-proxy autostops a machine on its `soft_limit` concurrency math, which does
 * not count requests in flight — a six-minute sync looks like an idle machine
 * and is killed mid-write (SIGINT, 502). So a run is deliberately bounded and
 * the workflow calls back until the report says nothing is left; the ledger
 * makes each chunk resume rather than repeat.
 *
 * The budget covers the whole request, read phase included: the Solidarity and
 * Mobilize reads that precede any write take the better part of a minute on
 * their own, so measuring only the writes would understate it badly.
 */
const DEFAULT_BUDGET_MS = 120_000;

/** Solidarity allows 60 requests / 30s; one capped shift costs one read. */
const SEAT_COUNT_PAUSE_MS = 550;

/**
 * Seats each capped session has already spent on signups that did NOT come from
 * Mobilize, so the event sync can hand Mobilize only what is left and let it
 * enforce the cap itself.
 *
 * The Mobilize-origin exclusion is the whole trick — see lib/seats.ts. Counting
 * every RSVP would charge each Mobilize signup twice, once against Mobilize's
 * own tally and once by shrinking the cap we give it, and the shift would close
 * at half capacity.
 *
 * A session whose read fails is simply left out of the map, which the sync reads
 * as "no adjustment" rather than as a full or empty shift.
 */
async function countSeatsTaken(sessionIds: number[]): Promise<Map<number, number>> {
	const seats = new Map<number, number>();
	for (const [index, sessionId] of sessionIds.entries()) {
		if (index > 0) await new Promise((r) => setTimeout(r, SEAT_COUNT_PAUSE_MS));
		try {
			seats.set(
				sessionId,
				countSolidaritySeats(await listSessionRsvps(SOLIDARITY_API_TOKEN, sessionId)),
			);
		} catch (err) {
			console.warn(`[mobilize-sync] seat count failed for session ${sessionId}:`, err);
		}
	}
	return seats;
}

export interface MobilizeSyncOptions {
	/** When false, plan and report without writing anything. */
	apply?: boolean;
	/** Override the create guardrail for a deliberate bulk run. */
	maxCreates?: number;
	/** Override the per-request time budget. */
	budgetMs?: number;
}

export interface MobilizeSyncResult extends SyncReport {
	skippedNoAddress: number;
	/** Held back by the `mobilize-exclude` tag in Solidarity. */
	excludedByTag: number;
	/** Of those, the ones already published to Mobilize by an earlier run. The
	 *  tag stops further updates; it does not delete what is already live. */
	excludedStillLive: number;
	dryRun: boolean;
}

export async function runMobilizeSync(
	db: Db,
	options: MobilizeSyncOptions = {},
): Promise<MobilizeSyncResult> {
	const apply = options.apply ?? true;
	// Started before the reads, which are part of what has to fit in the budget.
	// A junk override falls back to the default rather than disabling the budget:
	// `Date.now() + NaN` is NaN, and every deadline comparison against it is
	// false, so a typo in ?budgetMs would silently restore the request that gets
	// killed at six minutes.
	const budgetMs =
		Number.isFinite(options.budgetMs) && (options.budgetMs as number) > 0
			? (options.budgetMs as number)
			: DEFAULT_BUDGET_MS;
	const writeDeadline = Date.now() + budgetMs;
	const api = loadMobilizeApi('the Mobilize sync');

	// Both reads are independent; the pages call is what recovers the formatted
	// descriptions the events endpoint flattens.
	const [events, pageDescriptions, settings] = await Promise.all([
		fetchAllEvents(SOLIDARITY_API_TOKEN),
		fetchPageDescriptions(SOLIDARITY_API_TOKEN),
		loadSettings(db),
	]);
	const { planned, skipped, excludedByTag } = planMigration(events, Date.now(), pageDescriptions);

	// The v1 API rejects a create or update with no contact, so stop here with a
	// message naming the fix rather than letting every event fail one by one.
	const contact = {
		name: settings.mobilizeContactName,
		emailAddress: settings.mobilizeContactEmail,
		phoneNumber: settings.mobilizeContactPhone,
	};
	if (!contact.emailAddress) {
		throw new Error(
			'No Mobilize event contact configured — set one on /settings, or MOBILIZE_CONTACT_EMAIL',
		);
	}

	const ledger = new TursoLedger(db);
	const report = await runSync(
		planned,
		{
			api,
			contact,
			maxCreatesPerRun: options.maxCreates ?? MOBILIZE_SYNC_MAX_CREATES,
			apply,
			writeDeadline,
			seatsTaken: countSeatsTaken,
			log: (message) => console.log(`[mobilize-sync] ${message}`),
		},
		ledger,
		findDuplicate,
	);

	// Tagging an event that was already published keeps the sync off it but does
	// not take it down — deleting a public event volunteers may have signed up for
	// is not something to do from a tag. Counted so the log says so out loud.
	const excludedIds = new Set(excludedByTag.map((entry) => entry.solidarityEventId));
	let excludedStillLive = 0;
	if (excludedIds.size > 0) {
		// Ledger keys are `solidarity:<eventId>:<location>`.
		for (const record of await ledger.all()) {
			if (excludedIds.has(Number(record.key.split(':')[1]))) excludedStillLive++;
		}
	}

	return {
		...report,
		skippedNoAddress: skipped.length,
		excludedByTag: excludedByTag.length,
		excludedStillLive,
		dryRun: !apply,
	};
}
