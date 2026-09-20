// Draining the checkout ledger into the campaign's Google Sheets.
//
// The rules live in $lib/van/sheet-log.ts and $lib/van/sheet-routing.ts and are
// pure; this is the part that touches rows and Google. Called from
// /api/internal/van-sync, which already runs on a schedule and already holds a
// lock — a second cron would mean a second lock and a second way for two runs
// to append the same row twice.
//
// The ordering that matters, and it is the whole correctness argument:
//
//   1. Read the checkouts that still owe the sheet an event.
//   2. Append them, grouped by spreadsheet, one call per spreadsheet.
//   3. Stamp them ONLY after Google confirmed the append.
//
// A crash between 2 and 3 duplicates that batch on the next run. That is the
// one duplicate the spec allows, and it is identifiable by Checkout ID plus
// Event — which is why both are columns. The alternative, stamping first, loses
// rows silently on the same crash, and a canvassing log nobody can trust to be
// complete is not worth keeping.
//
// Never throws. A Google outage must not fail a sync whose catalog rows are
// already written and correct.

import { and, eq, inArray, isNull, or, isNotNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanSheetHealth, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { chunked } from './sql-chunk.js';
import { postAlert } from '../slack.js';
import type { SheetsClient } from '../google/sheets.js';
import {
	DEFAULT_SHEET_TAB_NAME,
	SHEET_COLUMNS,
	pendingEventsFor,
	type SheetCheckout,
	type SheetEvent,
} from '../../van/sheet-log.js';
import { matchSheetTarget, orderSheetTargets, type SheetTarget } from '../../van/sheet-routing.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[sheets]';

/** Rows read per run. Generous — a busy canvass weekend is hundreds of events,
 *  not thousands — and bounded so a first run after a long outage cannot try to
 *  hold the whole ledger in memory. Whatever is left waits for the next run. */
const MAX_EVENTS_PER_RUN = 2_000;

/** Google's own cap is 10,000 rows per append; this is far below it so one
 *  spreadsheet's batch always fits in a single call, and so a retry after a
 *  timeout re-sends something small. */
const MAX_ROWS_PER_APPEND = 500;

export interface SheetFlushResult {
	/** Rows Google confirmed and that are now stamped. */
	written: number;
	/** Events whose append failed. Left unstamped, so the next run retries. */
	failed: number;
	/** Events whose region matched no rule. Left unstamped so they flow in the
	 *  moment an admin adds one. */
	unrouted: number;
	/** Region names that matched no rule, deduplicated — what an admin needs to
	 *  write the missing rule. */
	unroutedRegions: string[];
	/** True when the run stopped early on its time budget. */
	budgetLapsed: boolean;
	/** Advisory notes for the sync's Slack summary. Failures that need an
	 *  operator are alerted separately, see `announceFailures`. */
	warnings: string[];
}

const EMPTY_RESULT: SheetFlushResult = {
	written: 0,
	failed: 0,
	unrouted: 0,
	unroutedRegions: [],
	budgetLapsed: false,
	warnings: [],
};

export interface SheetFlushOptions {
	now: Date;
	client: SheetsClient;
	targets: readonly SheetTarget[];
	tabName?: string;
	timeBudgetMs: number;
	/** Where an ongoing failure is announced. Empty means don't. */
	channelId: string;
}

/**
 * Checkouts that still owe the sheet an event.
 *
 * The SQL is deliberately wider than the real rule — it asks only "is either
 * stamp missing", and `pendingEvents` decides what that actually means for a
 * claim that has not ended yet. Expressing the whole condition here would split
 * the rule across SQL and TypeScript, and the two would eventually disagree
 * about a checkout that ended in the same run it started.
 *
 * Inner join to van_turfs for the turf and region names. Safe even for retired
 * turf: those rows are stamped `retired_at`, never deleted, precisely so a
 * checkout pointing at a vanished route still renders.
 */
async function loadCandidates(db: Db): Promise<SheetCheckout[]> {
	return (
		db
			.select({
				checkoutId: vanTurfCheckouts.id,
				claimedAt: vanTurfCheckouts.claimedAt,
				releasedAt: vanTurfCheckouts.releasedAt,
				completedAt: vanTurfCheckouts.completedAt,
				releaseReason: vanTurfCheckouts.releaseReason,
				slackUserName: vanTurfCheckouts.slackUserName,
				issuedListNumber: vanTurfCheckouts.issuedListNumber,
				sheetClaimSentAt: vanTurfCheckouts.sheetClaimSentAt,
				sheetEndSentAt: vanTurfCheckouts.sheetEndSentAt,
				turfName: vanTurfs.name,
				regionName: vanTurfs.regionName,
			})
			.from(vanTurfCheckouts)
			.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
			.where(
				or(
					isNull(vanTurfCheckouts.sheetClaimSentAt),
					and(
						isNull(vanTurfCheckouts.sheetEndSentAt),
						or(isNotNull(vanTurfCheckouts.releasedAt), isNotNull(vanTurfCheckouts.completedAt)),
					),
				),
			)
			// Oldest first, so a backlog drains in the order it happened and a run
			// cut short by its budget leaves the NEWEST events waiting rather than
			// stranding the oldest behind every canvass since.
			.orderBy(vanTurfCheckouts.claimedAt, vanTurfCheckouts.id)
			.limit(MAX_EVENTS_PER_RUN)
	);
}

/** Stamp the events Google accepted. Split by kind because they are different
 *  columns; chunked because a backlog can exceed SQLite's variable limit. */
async function markSent(db: Db, events: readonly SheetEvent[], at: string): Promise<void> {
	const claimIds = events.filter((e) => e.kind === 'claim').map((e) => e.checkoutId);
	const endIds = events.filter((e) => e.kind === 'end').map((e) => e.checkoutId);

	for (const batch of chunked(claimIds)) {
		await db
			.update(vanTurfCheckouts)
			.set({ sheetClaimSentAt: at })
			.where(inArray(vanTurfCheckouts.id, batch));
	}
	for (const batch of chunked(endIds)) {
		await db
			.update(vanTurfCheckouts)
			.set({ sheetEndSentAt: at })
			.where(inArray(vanTurfCheckouts.id, batch));
	}
}

/** Record that a spreadsheet is failing. Leaves `alerted_error` alone — that is
 *  `announceFailures`' to write, and only after Slack accepted the message. */
async function recordFailure(
	db: Db,
	spreadsheetId: string,
	error: string,
	at: string,
): Promise<void> {
	await db
		.insert(vanSheetHealth)
		.values({ spreadsheetId, lastError: error, lastFailedAt: at, alertedError: null })
		.onConflictDoUpdate({
			target: vanSheetHealth.spreadsheetId,
			set: { lastError: error, lastFailedAt: at },
		});
}

/** A spreadsheet wrote cleanly, so forget it was ever broken.
 *
 *  This is the half that is easy to leave out and the half that makes a
 *  recurrence audible: without it, a sheet that broke in March, was fixed, and
 *  breaks again in October keeps its old `alerted_error` and never announces
 *  the second failure. Same reasoning as staleDriftStamps in drift-alert.ts. */
async function recordSuccess(db: Db, spreadsheetId: string): Promise<void> {
	await db.delete(vanSheetHealth).where(eq(vanSheetHealth.spreadsheetId, spreadsheetId));
}

/**
 * Tell the operator about spreadsheets that are failing, once per problem.
 *
 * The unit of idempotency is the error text: a sheet that starts failing a
 * different way has something new to say, and a sheet failing the same way for
 * the fifth run running does not. Time-based re-announcement was the obvious
 * alternative and is wrong for the same reason drift-alert.ts gives — a channel
 * that repeats itself daily gets muted, which costs the campaign the first
 * alert about the next real problem.
 *
 * Stamped only after Slack accepted, so an outage retries next run rather than
 * burning the one message that says the campaign's sheet stopped updating.
 */
async function announceFailures(
	db: Db,
	channelId: string,
	labelFor: (spreadsheetId: string) => string,
	waiting: number,
): Promise<void> {
	if (!channelId) return;

	const rows = await db.select().from(vanSheetHealth);
	const due = rows.filter((row) => row.lastError !== row.alertedError);
	if (due.length === 0) return;

	for (const row of due) {
		const text =
			`${LOG} could not write the turf checkout log to *${labelFor(row.spreadsheetId)}*.\n` +
			`> ${row.lastError}\n` +
			`${waiting} event(s) are waiting. They are kept and will be written once this is fixed.`;
		if (!(await postAlert(channelId, text, LOG))) continue;
		await db
			.update(vanSheetHealth)
			.set({ alertedError: row.lastError })
			.where(eq(vanSheetHealth.spreadsheetId, row.spreadsheetId));
	}
}

/**
 * Append every pending checkout event to the spreadsheet that covers its turf.
 *
 * Grouped by spreadsheet and appended in one call each, rather than a call per
 * row: a busy weekend is a few hundred events across a dozen sheets, and
 * row-at-a-time would spend the run's whole budget — and Google's per-minute
 * write quota — on HTTP overhead.
 */
export async function flushSheetLog(db: Db, options: SheetFlushOptions): Promise<SheetFlushResult> {
	const { now, client, timeBudgetMs, channelId } = options;
	const tabName = options.tabName?.trim() || DEFAULT_SHEET_TAB_NAME;
	const deadline = Date.now() + timeBudgetMs;

	// No rules means the feature is not configured. Nothing happens and nothing
	// is said — an unconfigured integration that alerted would be noise on every
	// deployment that never intends to use it.
	if (options.targets.length === 0) return EMPTY_RESULT;
	const targets = orderSheetTargets(options.targets);
	const labelFor = (spreadsheetId: string): string =>
		targets.find((t) => t.spreadsheetId === spreadsheetId)?.label ?? spreadsheetId;

	let candidates: SheetCheckout[];
	try {
		candidates = await loadCandidates(db);
	} catch (err) {
		console.error(`${LOG} could not read pending checkout events:`, errText(err));
		return { ...EMPTY_RESULT, warnings: [`${LOG} could not read pending events: ${errText(err)}`] };
	}
	if (candidates.length === 0) return EMPTY_RESULT;

	// Route every event before sending any, so one spreadsheet's batch is built
	// once and the unmatched ones are known before the first HTTP call.
	const bySpreadsheet = new Map<string, SheetEvent[]>();
	const unroutedRegions = new Set<string>();
	let unrouted = 0;

	for (const event of pendingEventsFor(candidates)) {
		const target = matchSheetTarget(event.regionName, targets);
		if (!target) {
			unrouted += 1;
			unroutedRegions.add(event.regionName || '(no region name)');
			continue;
		}
		const batch = bySpreadsheet.get(target.spreadsheetId);
		if (batch) batch.push(event);
		else bySpreadsheet.set(target.spreadsheetId, [event]);
	}

	const result: SheetFlushResult = {
		...EMPTY_RESULT,
		unrouted,
		unroutedRegions: [...unroutedRegions].sort(),
		warnings: [],
	};

	for (const [spreadsheetId, events] of bySpreadsheet) {
		// Between spreadsheets, not between rows: a half-sent batch is the one
		// state this cannot recover from cleanly, so a spreadsheet is either
		// attempted with time to finish or left entirely for the next run.
		if (Date.now() >= deadline) {
			result.budgetLapsed = true;
			break;
		}

		for (const slice of sliced(events, MAX_ROWS_PER_APPEND)) {
			const res = await client.appendRows({
				spreadsheetId,
				tabName,
				header: SHEET_COLUMNS,
				rows: slice.map((e) => e.cells),
				deadline,
			});

			if (!res.ok) {
				result.failed += slice.length;
				await safely(
					() => recordFailure(db, spreadsheetId, res.error, now.toISOString()),
					'health',
				);
				// Stop on this spreadsheet — the next slice would fail the same
				// way, and the rows stay unstamped for the next run regardless.
				break;
			}

			try {
				await markSent(db, slice, now.toISOString());
			} catch (err) {
				// Google took the rows but the stamp did not land, so the next run
				// re-sends them. Logged loudly because a duplicated row in the
				// campaign's sheet is the visible symptom and this is its only
				// cause in normal operation.
				console.error(
					`${LOG} appended ${slice.length} row(s) to ${spreadsheetId} but could not stamp them:`,
					errText(err),
				);
				result.warnings.push(
					`${LOG} ${slice.length} row(s) were written to ${labelFor(spreadsheetId)} but not stamped — ` +
						'they may appear twice, tell them apart by Checkout ID',
				);
			}
			result.written += res.value.appended;
			if (res.value.createdTab) {
				result.warnings.push(`${LOG} created the "${tabName}" tab in ${labelFor(spreadsheetId)}`);
			}
			await safely(() => recordSuccess(db, spreadsheetId), 'health');
		}
	}

	if (unrouted > 0) {
		result.warnings.push(
			`${LOG} ${unrouted} event(s) match no spreadsheet rule and are waiting: ` +
				`${result.unroutedRegions.slice(0, 5).join(', ')}` +
				`${result.unroutedRegions.length > 5 ? `, +${result.unroutedRegions.length - 5} more` : ''}`,
		);
	}

	await safely(
		() => announceFailures(db, channelId, labelFor, result.failed + result.unrouted),
		'alert',
	);

	if (result.written > 0 || result.failed > 0 || unrouted > 0) {
		console.log(
			`${LOG} checkout log: written=${result.written} failed=${result.failed} ` +
				`unrouted=${unrouted} sheets=${bySpreadsheet.size}`,
		);
	}
	return result;
}

/** Split into slices of at most `size`. */
function* sliced<T>(items: readonly T[], size: number): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Run a bookkeeping write that must never take the drain down with it. The
 *  rows are already appended by the time these run; losing the health record
 *  costs an alert, losing the run costs the stamps. */
async function safely(fn: () => Promise<void>, what: string): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(`${LOG} ${what} bookkeeping failed:`, errText(err));
	}
}
