// Keeping the campaign's Packet Tracker tab in step with the checkout ledger,
// and reading back which turf the campaign has handed out itself.
//
// The rules live in $lib/van/packet-tracker.ts and $lib/van/sheet-routing.ts
// and are pure; this is the part that touches rows and Google. Run from
// /api/internal/van-sync on its schedule, and nudged straight after a claim,
// completion or hand-back (packet-tracker-live.ts) so the row does not wait up
// to half an hour. Both take the same lock, so they cannot both append a row
// for one checkout.
//
// The correctness argument, per checkout:
//
//   1. Derive the row it should have from the ledger (`desiredRow`).
//   2. Compare with `sheet_state` — what Google last confirmed we wrote.
//   3. Write the difference, addressed by the row's hidden tag.
//   4. Record the new state ONLY after Google confirmed the write.
//
// A crash between 3 and 4 repeats the write next run. Every write is
// idempotent — the same cells into the same tagged row — except the insert,
// and an insert is never repeated because the tag search at the top of each
// run finds the row the first attempt made.
//
// Rows the campaign typed are read, never written. Nothing here deletes a row;
// see the header of packet-tracker.ts for why.
//
// Never throws. A Google outage must not fail a sync whose catalog rows are
// already written and correct.

import { and, eq, gte, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanSheetHealth, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { postAlert } from '../slack.js';
import type { SheetsClient } from '../google/sheets.js';
import {
	DEFAULT_SHEET_TAB_NAME,
	ROW_TAG_KEY,
	blankCells,
	campaignAssignments,
	changedCells,
	desiredRow,
	findLayout,
	normaliseListNumber,
	rowValues,
	stillOurs,
	type ColumnLayout,
	type PacketCells,
	type PacketCheckout,
} from '../../van/packet-tracker.js';
import { matchSheetTarget, orderSheetTargets, type SheetTarget } from '../../van/sheet-routing.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[sheets]';

/** How long after a checkout ends it is still re-derived. Long enough for the
 *  sync to notice a MiniVAN load that happened just before a hand-back — which
 *  turns "no row" into an Incomplete one — and short enough that the candidate
 *  read stays the handful of turf that is actually moving. */
const SETTLE_MS = 48 * 60 * 60 * 1000;

/** Checkouts read per run. A busy weekend is dozens of live claims, not
 *  thousands; bounded so a first run cannot hold the whole ledger. */
const MAX_CHECKOUTS_PER_RUN = 1_000;

/**
 * What `sheet_state` holds.
 *
 * `tagged`: we have inserted a tagged row for this checkout — it may since have
 * been cleared. `cells`: what that row holds as far as we know, or null when it
 * is blank. `gone`: our row was deleted or typed over by someone else, so we
 * leave this checkout alone for good rather than fight them for it.
 */
export interface SheetState {
	spreadsheetId: string | null;
	tagged: boolean;
	cells: PacketCells | null;
	gone?: true;
}

const EMPTY_STATE: SheetState = { spreadsheetId: null, tagged: false, cells: null };

export function parseSheetState(raw: string | null): SheetState | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<SheetState>;
		return {
			spreadsheetId: typeof parsed.spreadsheetId === 'string' ? parsed.spreadsheetId : null,
			tagged: parsed.tagged === true,
			cells: parsed.cells && typeof parsed.cells === 'object' ? parsed.cells : null,
			...(parsed.gone ? { gone: true as const } : {}),
		};
	} catch {
		// A corrupt state is treated as "never written". The tag search still
		// finds a row we did write, so this cannot produce a second one.
		return null;
	}
}

export interface TrackerResult {
	/** Rows appended. */
	appended: number;
	/** Rows updated in place, including cleared ones. */
	updated: number;
	/** Checkouts whose spreadsheet failed. Retried next run. */
	failed: number;
	/** Checkouts whose region matched no rule. */
	unrouted: number;
	unroutedRegions: string[];
	/** Turfs whose Packet Tracker assignment changed. */
	assignmentsChanged: number;
	budgetLapsed: boolean;
	/** Advisory notes for the sync's Slack summary. Failures that need an
	 *  operator are alerted separately, see `announceFailures`. */
	warnings: string[];
}

const EMPTY_RESULT: TrackerResult = {
	appended: 0,
	updated: 0,
	failed: 0,
	unrouted: 0,
	unroutedRegions: [],
	assignmentsChanged: 0,
	budgetLapsed: false,
	warnings: [],
};

export interface TrackerOptions {
	now: Date;
	client: SheetsClient;
	targets: readonly SheetTarget[];
	tabName?: string;
	timeBudgetMs: number;
	/** Where an ongoing failure is announced. Empty means don't. */
	channelId: string;
	/** Limit the run to the spreadsheet this turf routes to — the nudge after
	 *  one volunteer's action has no business reading a dozen spreadsheets. */
	onlyMapRouteId?: number;
}

type Candidate = PacketCheckout & { sheetState: string | null };

async function loadCandidates(db: Db, now: Date, mapRouteId?: number): Promise<Candidate[]> {
	const settledBefore = new Date(now.getTime() - SETTLE_MS).toISOString();
	const pending = or(
		isNull(vanTurfCheckouts.sheetState),
		and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt)),
		gte(vanTurfCheckouts.releasedAt, settledBefore),
		gte(vanTurfCheckouts.completedAt, settledBefore),
	);
	return (
		db
			.select({
				checkoutId: vanTurfCheckouts.id,
				slackUserName: vanTurfCheckouts.slackUserName,
				claimedAt: vanTurfCheckouts.claimedAt,
				releasedAt: vanTurfCheckouts.releasedAt,
				completedAt: vanTurfCheckouts.completedAt,
				reportedPercent: vanTurfCheckouts.reportedPercent,
				loadedInMinivanAt: vanTurfCheckouts.loadedInMinivanAt,
				issuedListNumber: vanTurfCheckouts.issuedListNumber,
				claimDoorCount: vanTurfCheckouts.claimDoorCount,
				sheetState: vanTurfCheckouts.sheetState,
				turfName: vanTurfs.name,
				regionName: vanTurfs.regionName,
				routeSize: vanTurfs.routeSize,
				doorCount: vanTurfs.doorCount,
			})
			.from(vanTurfCheckouts)
			// Inner join is safe for retired turf: those rows are stamped, never
			// deleted, precisely so a checkout on a vanished route still renders.
			.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
			.where(
				mapRouteId === undefined
					? pending
					: and(pending, eq(vanTurfCheckouts.mapRouteId, mapRouteId)),
			)
			// Oldest first, so rows land in the tracker in the order turf went out.
			.orderBy(vanTurfCheckouts.claimedAt, vanTurfCheckouts.id)
			.limit(MAX_CHECKOUTS_PER_RUN)
	);
}

async function saveState(db: Db, checkoutId: number, state: SheetState): Promise<void> {
	await db
		.update(vanTurfCheckouts)
		.set({ sheetState: JSON.stringify(state) })
		.where(eq(vanTurfCheckouts.id, checkoutId));
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

/** A spreadsheet worked, so forget it was ever broken — which is what makes a
 *  recurrence audible. Same reasoning as staleDriftStamps in drift-alert.ts. */
async function recordSuccess(db: Db, spreadsheetId: string): Promise<void> {
	await db.delete(vanSheetHealth).where(eq(vanSheetHealth.spreadsheetId, spreadsheetId));
}

/**
 * Tell the operator about spreadsheets that are failing, once per problem.
 *
 * The unit of idempotency is the error text: a sheet that starts failing a
 * different way has something new to say, and one failing the same way for the
 * fifth run running does not. Stamped only after Slack accepted, so an outage
 * retries rather than burning the one message that says the tracker stopped
 * updating.
 */
async function announceFailures(
	db: Db,
	channelId: string,
	labelFor: (spreadsheetId: string) => string,
	waiting: number,
): Promise<void> {
	if (!channelId) return;
	const rows = await db.select().from(vanSheetHealth);
	for (const row of rows.filter((r) => r.lastError !== r.alertedError)) {
		const text =
			`${LOG} could not update the Packet Tracker in *${labelFor(row.spreadsheetId)}*.\n` +
			`> ${row.lastError}\n` +
			`${waiting} checkout(s) are waiting. They are kept and will be written once this is fixed.`;
		if (!(await postAlert(channelId, text, LOG))) continue;
		await db
			.update(vanSheetHealth)
			.set({ alertedError: row.lastError })
			.where(eq(vanSheetHealth.spreadsheetId, row.spreadsheetId));
	}
}

/** One spreadsheet's tab, read once per run and shared by everything below. */
interface OpenTab {
	spreadsheetId: string;
	sheetId: number;
	values: string[][];
	layout: ColumnLayout;
	/** Checkout id → current row index, for rows carrying our tag in this tab. */
	tagged: Map<string, number>;
	/** Where the next inserted row goes: below the last row with anything in it. */
	nextRow: number;
}

async function openTab(
	client: SheetsClient,
	spreadsheetId: string,
	tabName: string,
	deadline: number,
): Promise<{ ok: true; tab: OpenTab } | { ok: false; error: string }> {
	const [read, tags] = await Promise.all([
		client.readTab({ spreadsheetId, tabName, deadline }),
		client.findTaggedRows({ spreadsheetId, key: ROW_TAG_KEY, deadline }),
	]);
	if (!read.ok) return { ok: false, error: read.error };
	if (!tags.ok) return { ok: false, error: tags.error };
	const found = findLayout(read.value.values);
	if (!found.ok) {
		return {
			ok: false,
			error: `the "${tabName}" tab has no ${found.missing.map((c) => `"${c}"`).join(', ')} column`,
		};
	}
	const tagged = new Map<string, number>();
	for (const row of tags.value) {
		if (row.sheetId === read.value.sheetId) tagged.set(row.value, row.rowIndex);
	}
	return {
		ok: true,
		tab: {
			spreadsheetId,
			sheetId: read.value.sheetId,
			values: read.value.values,
			layout: found.layout,
			tagged,
			nextRow: Math.max(read.value.values.length, found.layout.headerRowIndex + 1),
		},
	};
}

type Outcome = 'appended' | 'updated' | 'unchanged' | { error: string };

/**
 * Bring one checkout's row in line with the ledger.
 *
 * Returns an error only for a Google failure, which stops the spreadsheet. A
 * row somebody else removed or took over is not an error: it is recorded as
 * `gone` and reported once as a warning.
 */
async function syncCheckout(
	db: Db,
	client: SheetsClient,
	tab: OpenTab,
	candidate: Candidate,
	options: TrackerOptions,
	deadline: number,
	warnings: string[],
): Promise<Outcome> {
	const state = parseSheetState(candidate.sheetState) ?? EMPTY_STATE;
	if (state.gone) return 'unchanged';

	const tag = String(candidate.checkoutId);
	const rowIndex = tab.tagged.get(tag);
	const save = async (next: SheetState) => {
		if (JSON.stringify(next) !== candidate.sheetState)
			await saveState(db, candidate.checkoutId, next);
	};
	const write = (cells: PacketCells) =>
		client.writeTaggedRow({
			spreadsheetId: tab.spreadsheetId,
			key: ROW_TAG_KEY,
			value: tag,
			row: rowValues(cells, tab.layout),
			deadline,
		});
	const label = `${candidate.turfName} (${candidate.slackUserName})`;

	const desired = desiredRow(candidate);

	if (desired === null) {
		// No row wanted. Blank ours if it still has anything in it.
		if (rowIndex === undefined || state.cells === null) {
			await save({
				...state,
				spreadsheetId: state.spreadsheetId ?? tab.spreadsheetId,
				cells: null,
			});
			return 'unchanged';
		}
		if (!stillOurs(tab.values[rowIndex], tab.layout, state.cells)) {
			warnings.push(
				`${LOG} the Packet Tracker row for ${label} has been changed by hand, so it was left as it is`,
			);
			await save({ ...state, gone: true });
			return 'unchanged';
		}
		const res = await write(blankCells());
		if (!res.ok) return { error: res.error };
		await save({ ...state, cells: null });
		return 'updated';
	}

	if (rowIndex === undefined) {
		if (state.tagged) {
			// We made a row and it is not there now: someone deleted it. Theirs
			// to delete; putting it back would be arguing with the campaign.
			warnings.push(
				`${LOG} the Packet Tracker row for ${label} was deleted in the sheet, so it was not recreated`,
			);
			await save({ ...state, gone: true });
			return 'unchanged';
		}
		const inserted = await client.insertTaggedRow({
			spreadsheetId: tab.spreadsheetId,
			sheetId: tab.sheetId,
			rowIndex: tab.nextRow,
			key: ROW_TAG_KEY,
			value: tag,
			deadline,
		});
		if (!inserted.ok) return { error: inserted.error };
		tab.tagged.set(tag, tab.nextRow);
		tab.nextRow += 1;
		// Saved before the cells are written: if that write fails, the next run
		// must fill this row rather than insert a second one.
		await save({ spreadsheetId: tab.spreadsheetId, tagged: true, cells: null });
		candidate.sheetState = JSON.stringify({
			spreadsheetId: tab.spreadsheetId,
			tagged: true,
			cells: null,
		});
		const res = await write(desired);
		if (!res.ok) return { error: res.error };
		await save({ spreadsheetId: tab.spreadsheetId, tagged: true, cells: desired });
		return 'appended';
	}

	// Our row exists. A blank one (never filled, or cleared by a hand-back
	// that later turned out to have been walked) gets every cell; a filled one
	// only what changed.
	const changes = state.cells === null ? desired : changedCells(state.cells, desired);
	if (Object.keys(changes).length === 0) {
		await save({ ...state, spreadsheetId: tab.spreadsheetId, tagged: true });
		return 'unchanged';
	}
	const res = await write(changes);
	if (!res.ok) return { error: res.error };
	if (!res.value.found) {
		// Deleted between the tag search and the write.
		warnings.push(
			`${LOG} the Packet Tracker row for ${label} was deleted in the sheet, so it was not recreated`,
		);
		await save({ ...state, gone: true });
		return 'unchanged';
	}
	await save({
		spreadsheetId: tab.spreadsheetId,
		tagged: true,
		cells: { ...(state.cells ?? {}), ...changes },
	});
	return 'updated';
}

/**
 * Record which turf the campaign's own rows say is out, for the turfs that
 * route to this spreadsheet. Returns how many changed.
 */
async function refreshAssignments(
	db: Db,
	tab: OpenTab,
	turfs: ReadonlyArray<{
		mapRouteId: number;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>,
): Promise<number> {
	const taggedRows = new Set(tab.tagged.values());
	const assigned = campaignAssignments(tab.values, tab.layout, taggedRows);
	let changed = 0;
	for (const turf of turfs) {
		const next = turf.printedListNumber
			? (assigned.get(normaliseListNumber(turf.printedListNumber)) ?? null)
			: null;
		if (next === turf.sheetAssignedTo) continue;
		await db
			.update(vanTurfs)
			.set({ sheetAssignedTo: next })
			.where(eq(vanTurfs.mapRouteId, turf.mapRouteId));
		changed += 1;
	}
	return changed;
}

/**
 * Sync every pending checkout to its spreadsheet's Packet Tracker, and read
 * the campaign's own assignments back.
 */
export async function syncPacketTracker(db: Db, options: TrackerOptions): Promise<TrackerResult> {
	const { now, client, timeBudgetMs, channelId } = options;
	const tabName = options.tabName?.trim() || DEFAULT_SHEET_TAB_NAME;
	const deadline = Date.now() + timeBudgetMs;

	// No rules means the feature is not configured: nothing happens and
	// nothing is said.
	if (options.targets.length === 0) return EMPTY_RESULT;
	const targets = orderSheetTargets(options.targets);
	const labelFor = (spreadsheetId: string): string =>
		targets.find((t) => t.spreadsheetId === spreadsheetId)?.label ?? spreadsheetId;

	let candidates: Candidate[];
	let turfs: Array<{
		mapRouteId: number;
		regionName: string;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>;
	try {
		candidates = await loadCandidates(db, now, options.onlyMapRouteId);
		turfs = await db
			.select({
				mapRouteId: vanTurfs.mapRouteId,
				regionName: vanTurfs.regionName,
				printedListNumber: vanTurfs.printedListNumber,
				sheetAssignedTo: vanTurfs.sheetAssignedTo,
			})
			.from(vanTurfs)
			.where(
				options.onlyMapRouteId === undefined
					? isNull(vanTurfs.retiredAt)
					: and(isNull(vanTurfs.retiredAt), eq(vanTurfs.mapRouteId, options.onlyMapRouteId)),
			);
	} catch (err) {
		console.error(`${LOG} could not read the ledger:`, errText(err));
		return { ...EMPTY_RESULT, warnings: [`${LOG} could not read the ledger: ${errText(err)}`] };
	}

	// Route everything before sending anything. A checkout already written
	// stays with the spreadsheet its row is in, even if the rules have since
	// changed — that row is the one to update.
	const bySpreadsheet = new Map<string, { candidates: Candidate[]; turfs: typeof turfs }>();
	const bucket = (spreadsheetId: string) => {
		let entry = bySpreadsheet.get(spreadsheetId);
		if (!entry) bySpreadsheet.set(spreadsheetId, (entry = { candidates: [], turfs: [] }));
		return entry;
	};
	const unroutedRegions = new Set<string>();
	let unrouted = 0;
	for (const candidate of candidates) {
		const state = parseSheetState(candidate.sheetState);
		const spreadsheetId =
			state?.spreadsheetId ?? matchSheetTarget(candidate.regionName, targets)?.spreadsheetId;
		if (!spreadsheetId) {
			// Only a checkout that wants a row is waiting on a rule.
			if (desiredRow(candidate) !== null) {
				unrouted += 1;
				unroutedRegions.add(candidate.regionName || '(no region name)');
			}
			continue;
		}
		bucket(spreadsheetId).candidates.push(candidate);
	}
	for (const turf of turfs) {
		const target = matchSheetTarget(turf.regionName, targets);
		if (target) bucket(target.spreadsheetId).turfs.push(turf);
	}

	const result: TrackerResult = {
		...EMPTY_RESULT,
		unrouted,
		unroutedRegions: [...unroutedRegions].sort(),
		warnings: [],
	};

	for (const [spreadsheetId, work] of bySpreadsheet) {
		if (Date.now() >= deadline) {
			result.budgetLapsed = true;
			break;
		}
		const opened = await openTab(client, spreadsheetId, tabName, deadline);
		if (!opened.ok) {
			result.failed += work.candidates.length;
			await safely(
				() => recordFailure(db, spreadsheetId, opened.error, now.toISOString()),
				'health',
			);
			continue;
		}
		const tab = opened.tab;

		try {
			result.assignmentsChanged += await refreshAssignments(db, tab, work.turfs);
		} catch (err) {
			console.error(`${LOG} could not record assignments for ${spreadsheetId}:`, errText(err));
		}

		let failedHere: string | null = null;
		for (const [i, candidate] of work.candidates.entries()) {
			let outcome: Outcome;
			try {
				outcome = await syncCheckout(
					db,
					client,
					tab,
					candidate,
					options,
					deadline,
					result.warnings,
				);
			} catch (err) {
				// A ledger write failed after Google accepted. The next run
				// re-derives and repeats an idempotent write — or, for an insert,
				// finds the tagged row and fills it.
				console.error(
					`${LOG} bookkeeping for checkout ${candidate.checkoutId} failed:`,
					errText(err),
				);
				continue;
			}
			if (outcome === 'appended') result.appended += 1;
			else if (outcome === 'updated') result.updated += 1;
			else if (outcome !== 'unchanged') {
				// The next checkout would fail the same way; all of them wait.
				failedHere = outcome.error;
				result.failed += work.candidates.length - i;
				break;
			}
		}

		if (failedHere) {
			await safely(
				() => recordFailure(db, spreadsheetId, failedHere!, now.toISOString()),
				'health',
			);
		} else {
			await safely(() => recordSuccess(db, spreadsheetId), 'health');
		}
	}

	if (unrouted > 0) {
		result.warnings.push(
			`${LOG} ${unrouted} checkout(s) match no spreadsheet rule and are waiting: ` +
				`${result.unroutedRegions.slice(0, 5).join(', ')}` +
				`${result.unroutedRegions.length > 5 ? `, +${result.unroutedRegions.length - 5} more` : ''}`,
		);
	}

	await safely(
		() => announceFailures(db, channelId, labelFor, result.failed + result.unrouted),
		'alert',
	);

	if (result.appended + result.updated + result.failed + result.assignmentsChanged + unrouted > 0) {
		console.log(
			`${LOG} packet tracker: appended=${result.appended} updated=${result.updated} ` +
				`failed=${result.failed} unrouted=${unrouted} assignments=${result.assignmentsChanged}`,
		);
	}
	return result;
}

/**
 * Who the campaign's Packet Tracker says has this turf, read live.
 *
 * The claim path's double-check: the sync only reads the tracker every half
 * hour, and an organizer may have written a turf down since. Returns the
 * canvasser, null when the tracker does not have it out, or undefined when it
 * could not be read in time — the caller then relies on the last sync's
 * `sheetAssignedTo` rather than refusing everyone because Google is slow.
 */
export async function liveAssignment(
	db: Db,
	input: {
		client: SheetsClient;
		targets: readonly SheetTarget[];
		tabName?: string;
		turf: { mapRouteId: number; regionName: string; printedListNumber: string | null };
		timeBudgetMs: number;
	},
): Promise<string | null | undefined> {
	const { turf } = input;
	if (!turf.printedListNumber) return null;
	const target = matchSheetTarget(turf.regionName, orderSheetTargets(input.targets));
	if (!target) return null;
	const opened = await openTab(
		input.client,
		target.spreadsheetId,
		input.tabName?.trim() || DEFAULT_SHEET_TAB_NAME,
		Date.now() + input.timeBudgetMs,
	);
	if (!opened.ok) return undefined;
	const assigned =
		campaignAssignments(
			opened.tab.values,
			opened.tab.layout,
			new Set(opened.tab.tagged.values()),
		).get(normaliseListNumber(turf.printedListNumber)) ?? null;
	await safely(
		() =>
			db
				.update(vanTurfs)
				.set({ sheetAssignedTo: assigned })
				.where(eq(vanTurfs.mapRouteId, turf.mapRouteId))
				.then(() => undefined),
		'assignment',
	);
	return assigned;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Run a bookkeeping write that must never take the run down with it. */
async function safely(fn: () => Promise<void>, what: string): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(`${LOG} ${what} bookkeeping failed:`, errText(err));
	}
}
