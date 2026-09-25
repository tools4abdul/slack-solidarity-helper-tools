// Keeping the campaign's Packet Tracker tab in step with the checkout ledger,
// and reading back which turf the campaign has handed out itself.
//
// The rules live in $lib/van/packet-tracker.ts and $lib/van/sheet-routing.ts
// and are pure; this is the part that touches rows and Google. Run from
// /api/internal/van-sync on its schedule, and nudged straight after a claim,
// completion or hand-back (packet-tracker-live.ts) so the packet does not wait
// up to half an hour. Both take the same lock.
//
// The correctness argument, per checkout:
//
//   1. Derive what it should have filled in on its packet (`desiredCells`).
//   2. Compare with `sheet_state` — what Google last confirmed we wrote.
//   3. Re-read the packet's row, check it is still that packet and still ours
//      (or still empty), and write the difference.
//   4. Record the new state ONLY after Google confirmed the write.
//
// A crash between 3 and 4 repeats the write next run; writing the same cells
// twice is harmless. Step 3's re-read is there because writes go by row
// number: the campaign's rows are protected, so they cannot carry a tag that
// Google would resolve for us, and a row number read half a minute earlier at
// the top of the run may since have been sorted onto another packet.
//
// The campaign's entries are read, never written: a packet somebody else has
// filled in is left as it is.
//
// Never throws. A Google outage must not fail a sync whose catalog rows are
// already written and correct.

import { and, eq, gte, isNotNull, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanSheetHealth, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { postAlert } from '../slack.js';
import { OUT_OF_TIME, type SheetsClient } from '../google/sheets.js';
import {
	DEFAULT_SHEET_TAB_NAME,
	campaignAssignments,
	cellWrites,
	changedCells,
	clearedCells,
	desiredCells,
	findLayout,
	isUnfilled,
	normaliseListNumber,
	packetRows,
	sheetDoors,
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
 *  turns "nothing" into an Incomplete entry — and short enough that the
 *  candidate read stays the handful of turf that is actually moving. */
const SETTLE_MS = 48 * 60 * 60 * 1000;

/** Checkouts read per run. A busy weekend is dozens of live claims, not
 *  thousands; bounded so a first run cannot hold the whole ledger. */
const MAX_CHECKOUTS_PER_RUN = 1_000;

/** Spreadsheets read at once. Enough that a few dozen fit the run's budget. */
const READ_CONCURRENCY = 4;

/** Google's answer when this service account has used its 60 reads (or
 *  writes) for the minute. A hard cap that cannot be raised. */
const RATE_LIMITED = 429;

/**
 * What `sheet_state` holds.
 *
 * `cells`: what we have filled in on the packet, as far as we know, or null
 * when nothing. `told`: the one-time notice already sent about this checkout,
 * so it is not repeated every run. `gone`: the packet was taken over or cleared
 * by someone else, so we leave this checkout alone for good rather than fight
 * them for it.
 */
export interface SheetState {
	spreadsheetId: string | null;
	cells: PacketCells | null;
	told?: 'not-listed' | 'duplicate';
	gone?: true;
}

const EMPTY_STATE: SheetState = { spreadsheetId: null, cells: null };

export function parseSheetState(raw: string | null): SheetState | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<SheetState>;
		return {
			spreadsheetId: typeof parsed.spreadsheetId === 'string' ? parsed.spreadsheetId : null,
			cells: parsed.cells && typeof parsed.cells === 'object' ? parsed.cells : null,
			...(parsed.told === 'not-listed' || parsed.told === 'duplicate' ? { told: parsed.told } : {}),
			...(parsed.gone ? { gone: true as const } : {}),
		};
	} catch {
		// A corrupt state reads as "never written". The first fill only ever
		// goes into an empty packet, so this cannot overwrite anything.
		return null;
	}
}

export interface TrackerResult {
	/** Packets filled in for the first time. */
	filled: number;
	/** Packets updated or cleared. */
	updated: number;
	/** Checkouts whose spreadsheet failed. Retried next run. */
	failed: number;
	/** Checkouts left for the next run because Google's per-minute quota or
	 *  the run's own time ran out. Not a failure: nothing is alerted. */
	deferred: number;
	/** Checkouts whose region matched no rule. */
	unrouted: number;
	unroutedRegions: string[];
	/** Turfs whose Packet Tracker assignment changed. */
	assignmentsChanged: number;
	budgetLapsed: boolean;
	/** Notes for the turf channel. Failures that need an operator are alerted
	 *  separately, see `announceFailures`. */
	warnings: string[];
}

const EMPTY_RESULT: TrackerResult = {
	filled: 0,
	updated: 0,
	failed: 0,
	deferred: 0,
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
			// Oldest first, so packets are filled in the order turf went out.
			.orderBy(vanTurfCheckouts.claimedAt, vanTurfCheckouts.id)
			.limit(MAX_CHECKOUTS_PER_RUN)
	);
}

/**
 * The entries we have filled in, per spreadsheet: list number → canvasser.
 *
 * What tells our own entries apart from the campaign's when reading the
 * tracker back. From every checkout that has cells recorded, not just this
 * run's candidates — a packet walked last week is still ours in the sheet.
 */
async function loadOurEntries(db: Db): Promise<Map<string, Map<string, string>>> {
	const rows = await db
		.select({
			issuedListNumber: vanTurfCheckouts.issuedListNumber,
			sheetState: vanTurfCheckouts.sheetState,
		})
		.from(vanTurfCheckouts)
		.where(isNotNull(vanTurfCheckouts.sheetState));
	const ours = new Map<string, Map<string, string>>();
	for (const row of rows) {
		const state = parseSheetState(row.sheetState);
		if (!state?.spreadsheetId || !state.cells?.Canvasser || !row.issuedListNumber) continue;
		let entries = ours.get(state.spreadsheetId);
		if (!entries) ours.set(state.spreadsheetId, (entries = new Map()));
		entries.set(normaliseListNumber(row.issuedListNumber), state.cells.Canvasser);
	}
	return ours;
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
 * One message per distinct error, naming every spreadsheet failing that way:
 * a problem the campaign set up on all its sheets at once is one thing to fix,
 * and three dozen messages saying so bury it. The unit of idempotency is still
 * each spreadsheet's error text — a sheet failing the same way for the fifth
 * run running has nothing new to say. Stamped only after Slack accepted.
 */
async function announceFailures(
	db: Db,
	channelId: string,
	labelFor: (spreadsheetId: string) => string,
	waiting: number,
): Promise<void> {
	if (!channelId) return;
	const rows = await db.select().from(vanSheetHealth);
	const byError = new Map<string, string[]>();
	for (const row of rows.filter((r) => r.lastError !== r.alertedError)) {
		const ids = byError.get(row.lastError);
		if (ids) ids.push(row.spreadsheetId);
		else byError.set(row.lastError, [row.spreadsheetId]);
	}
	for (const [error, ids] of byError) {
		const names = ids.map(labelFor).sort();
		const shown = names
			.slice(0, 10)
			.map((n) => `*${n}*`)
			.join(', ');
		const more = names.length > 10 ? `, and ${names.length - 10} more` : '';
		const text =
			`${LOG} could not update the Packet Tracker in ${shown}${more}.\n` +
			`> ${error}\n` +
			`${waiting} checkout(s) are waiting. They are kept and will be written once this is fixed.`;
		if (!(await postAlert(channelId, text, LOG))) continue;
		for (const spreadsheetId of ids) {
			await db
				.update(vanSheetHealth)
				.set({ alertedError: error })
				.where(eq(vanSheetHealth.spreadsheetId, spreadsheetId));
		}
	}
}

/** One spreadsheet's tab, read once per run and shared by everything below. */
interface OpenTab {
	spreadsheetId: string;
	tabName: string;
	values: string[][];
	layout: ColumnLayout;
}

/** A failed Google call, with its status so a rate limit or a lapsed budget
 *  can be told apart from a sheet that is actually broken. */
interface SheetFailure {
	error: string;
	status: number;
}

/** Whether a failure is only "not now": the minute's quota, or the run's own
 *  time. Neither says anything is wrong with the spreadsheet. */
function isDeferral(failure: SheetFailure): boolean {
	return failure.status === RATE_LIMITED || failure.status === OUT_OF_TIME;
}

async function openTab(
	client: SheetsClient,
	spreadsheetId: string,
	tabName: string,
	deadline: number,
	ours: ReadonlyMap<string, string>,
): Promise<{ ok: true; tab: OpenTab } | ({ ok: false } & SheetFailure)> {
	const read = await client.readTab({ spreadsheetId, tabName, deadline });
	if (!read.ok) return { ok: false, error: read.error, status: read.status };
	const found = findLayout(read.value);
	if (!found.ok) {
		return {
			ok: false,
			status: 0,
			error: `the "${tabName}" tab has no ${found.missing.map((c) => `"${c}"`).join(', ')} column`,
		};
	}
	const tab: OpenTab = { spreadsheetId, tabName, values: read.value, layout: found.layout };
	recentAssignments.set(`${spreadsheetId}\u0000${tabName}`, {
		at: Date.now(),
		assigned: campaignAssignments(tab.values, tab.layout, ours),
	});
	return { ok: true, tab };
}

/** How long the claim's live check may reuse a read of the same spreadsheet.
 *  Every read spends one of the minute's 60, and a canvass launch is a room of
 *  people claiming turf out of the same few spreadsheets within a minute. */
const LIVE_REUSE_MS = 60_000;

const recentAssignments = new Map<string, { at: number; assigned: Map<string, string> }>();

/** Test-only: forget every remembered read. */
export function _resetLiveReadsForTests(): void {
	recentAssignments.clear();
}

type Outcome = 'filled' | 'updated' | 'unchanged' | 'moved' | SheetFailure;

/**
 * Bring one checkout's entry in line with the ledger.
 *
 * Returns a failure only for a Google error, which stops the spreadsheet. A
 * packet somebody else holds or has cleared is not an error: it is recorded
 * and reported once as a warning. `moved` means the tab changed under us since
 * it was read, and the checkout waits for the next run.
 */
async function syncCheckout(
	db: Db,
	client: SheetsClient,
	tab: OpenTab,
	candidate: Candidate,
	deadline: number,
	warnings: string[],
): Promise<Outcome> {
	const state = parseSheetState(candidate.sheetState) ?? EMPTY_STATE;
	if (state.gone) return 'unchanged';

	const save = async (next: SheetState) => {
		if (JSON.stringify(next) !== candidate.sheetState) {
			await saveState(db, candidate.checkoutId, next);
		}
	};
	// The turf, never the list number: that is the credential that loads the
	// doors in MiniVAN, and this goes to a Slack channel.
	const label = `${candidate.turfName} (${candidate.slackUserName})`;
	const base: SheetState = { ...state, spreadsheetId: tab.spreadsheetId };

	const rows = candidate.issuedListNumber
		? packetRows(tab.values, tab.layout, candidate.issuedListNumber)
		: [];
	const wanted = desiredCells(candidate, sheetDoors(tab.values[rows[0] ?? -1], tab.layout));

	if (rows.length !== 1) {
		if (state.cells) {
			// We filled it in, and now it is not there (or is there twice).
			warnings.push(
				`${LOG} the Packet Tracker row for ${label} is gone or now listed twice, so it is no longer updated`,
			);
			await save({ ...base, gone: true });
			return 'unchanged';
		}
		if (wanted === null) {
			await save(base);
			return 'unchanged';
		}
		const told = rows.length === 0 ? 'not-listed' : 'duplicate';
		if (state.told !== told) {
			warnings.push(
				told === 'not-listed'
					? `${LOG} ${label} was claimed, but the Packet Tracker does not list that packet — an organizer needs to add it`
					: `${LOG} ${label} was claimed, but the Packet Tracker lists that packet more than once — it was not filled in`,
			);
		}
		// Kept pending: once an organizer adds the packet, the next run fills it.
		await save({ ...base, told });
		return 'unchanged';
	}

	const rowIndex = rows[0]!;
	const current = tab.values[rowIndex];
	let writes: PacketCells;
	let next: PacketCells | null;

	if (state.cells === null) {
		if (wanted === null) {
			await save(base);
			return 'unchanged';
		}
		if (!isUnfilled(current, tab.layout)) {
			// Somebody has an entry on this packet already. Theirs.
			warnings.push(
				`${LOG} ${label} was claimed, but its packet already has someone else's entry in the Packet Tracker, so that entry was left as it is`,
			);
			await save({ ...base, gone: true });
			return 'unchanged';
		}
		writes = wanted;
		next = wanted;
	} else {
		if (!stillOurs(current, tab.layout, state.cells)) {
			warnings.push(
				`${LOG} the Packet Tracker entry for ${label} has been changed by hand, so it was left as it is`,
			);
			await save({ ...base, gone: true });
			return 'unchanged';
		}
		if (wanted === null) {
			writes = clearedCells(state.cells);
			next = null;
		} else {
			writes = changedCells(state.cells, wanted);
			next = { ...state.cells, ...writes };
		}
	}

	if (Object.keys(writes).length === 0) {
		await save({ ...base, cells: next });
		return 'unchanged';
	}

	// The check just before the write. Rows are addressed by number, and the
	// tab was read at the top of the run; if it has been sorted or had rows
	// added since, this row may be another packet now.
	const fresh = await client.readRow({
		spreadsheetId: tab.spreadsheetId,
		tabName: tab.tabName,
		rowIndex,
		deadline,
	});
	if (!fresh.ok) return { error: fresh.error, status: fresh.status };
	const samePacket =
		normaliseListNumber(fresh.value[tab.layout.columns['List Number']] ?? '') ===
		normaliseListNumber(candidate.issuedListNumber ?? '');
	const stillFree =
		state.cells === null
			? isUnfilled(fresh.value, tab.layout)
			: stillOurs(fresh.value, tab.layout, state.cells);
	if (!samePacket || !stillFree) return 'moved';

	const res = await client.writeCells({
		spreadsheetId: tab.spreadsheetId,
		tabName: tab.tabName,
		rowIndex,
		cells: cellWrites(writes, tab.layout),
		deadline,
	});
	if (!res.ok) return { error: res.error, status: res.status };
	await save({ spreadsheetId: tab.spreadsheetId, cells: next });
	return state.cells === null ? 'filled' : 'updated';
}

/**
 * Record which turf the campaign's own entries say is out, for the turfs that
 * route to this spreadsheet. Returns how many changed.
 */
async function refreshAssignments(
	db: Db,
	tab: OpenTab,
	ours: ReadonlyMap<string, string>,
	turfs: ReadonlyArray<{
		mapRouteId: number;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>,
): Promise<number> {
	const assigned = campaignAssignments(tab.values, tab.layout, ours);
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
	let ourEntries: Map<string, Map<string, string>>;
	let turfs: Array<{
		mapRouteId: number;
		regionName: string;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>;
	try {
		candidates = await loadCandidates(db, now, options.onlyMapRouteId);
		ourEntries = await loadOurEntries(db);
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
	const oursIn = (spreadsheetId: string) => ourEntries.get(spreadsheetId) ?? new Map();

	// Route everything before sending anything. A checkout already written
	// stays with the spreadsheet its entry is in, even if the rules have since
	// changed — that entry is the one to update.
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
			// Only a checkout that wants an entry is waiting on a rule.
			if (desiredCells(candidate) !== null) {
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

	// Spreadsheets with an entry to write go first; the rest are only being
	// read for the campaign's assignments, and go in a different order each run
	// so that a run cut short does not skip the same ones every time.
	const order = shuffled([...bySpreadsheet.keys()]).sort(
		(a, b) =>
			Number(bySpreadsheet.get(b)!.candidates.length > 0) -
			Number(bySpreadsheet.get(a)!.candidates.length > 0),
	);

	// A few reads in flight at once: one at a time, a few dozen spreadsheets do
	// not fit the budget. The per-minute quota caps the count, not the pace.
	const opening = new Map<string, ReturnType<typeof openTab>>();
	const open = (spreadsheetId: string) => {
		let pending = opening.get(spreadsheetId);
		if (!pending) {
			pending = openTab(client, spreadsheetId, tabName, deadline, oursIn(spreadsheetId));
			opening.set(spreadsheetId, pending);
		}
		return pending;
	};

	// Set once Google says the minute's quota is spent or the run's time is
	// up: everything after would be refused the same way.
	let stopped = false;
	for (const [index, spreadsheetId] of order.entries()) {
		const work = bySpreadsheet.get(spreadsheetId)!;
		if (!stopped && Date.now() >= deadline) {
			stopped = true;
			result.budgetLapsed = true;
		}
		if (stopped) {
			result.deferred += work.candidates.length;
			continue;
		}
		for (const ahead of order.slice(index, index + READ_CONCURRENCY)) void open(ahead);
		const opened = await open(spreadsheetId);
		if (!opened.ok) {
			if (isDeferral(opened)) {
				stopped = true;
				result.deferred += work.candidates.length;
				continue;
			}
			result.failed += work.candidates.length;
			await safely(
				() => recordFailure(db, spreadsheetId, opened.error, now.toISOString()),
				'health',
			);
			continue;
		}
		const tab = opened.tab;

		try {
			result.assignmentsChanged += await refreshAssignments(
				db,
				tab,
				oursIn(spreadsheetId),
				work.turfs,
			);
		} catch (err) {
			console.error(`${LOG} could not record assignments for ${spreadsheetId}:`, errText(err));
		}

		let failedHere: string | null = null;
		for (const [i, candidate] of work.candidates.entries()) {
			let outcome: Outcome;
			try {
				outcome = await syncCheckout(db, client, tab, candidate, deadline, result.warnings);
			} catch (err) {
				// A ledger write failed after Google accepted. The next run
				// re-derives and repeats the write, which is harmless.
				console.error(
					`${LOG} bookkeeping for checkout ${candidate.checkoutId} failed:`,
					errText(err),
				);
				continue;
			}
			if (outcome === 'filled') result.filled += 1;
			else if (outcome === 'updated') result.updated += 1;
			else if (outcome === 'moved') result.deferred += 1;
			else if (outcome !== 'unchanged') {
				// The next checkout would fail the same way; all of them wait.
				const waiting = work.candidates.length - i;
				if (isDeferral(outcome)) {
					stopped = true;
					result.deferred += waiting;
				} else {
					failedHere = outcome.error;
					result.failed += waiting;
				}
				break;
			}
		}

		if (failedHere) {
			await safely(
				() => recordFailure(db, spreadsheetId, failedHere!, now.toISOString()),
				'health',
			);
		} else if (!stopped) {
			await safely(() => recordSuccess(db, spreadsheetId), 'health');
		}
	}
	// Reads started ahead that the loop never reached still resolve; nothing
	// waits on them, and their only side effect is the live-check memory.
	for (const pending of opening.values()) void pending.catch(() => undefined);

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

	if (result.deferred > 0) {
		console.warn(
			`${LOG} ${result.deferred} checkout(s) wait for the next run (quota, time, or a tab that changed mid-run)`,
		);
	}
	if (result.filled + result.updated + result.failed + result.assignmentsChanged + unrouted > 0) {
		console.log(
			`${LOG} packet tracker: filled=${result.filled} updated=${result.updated} ` +
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
	const tabName = input.tabName?.trim() || DEFAULT_SHEET_TAB_NAME;
	const key = `${target.spreadsheetId}\u0000${tabName}`;
	let recent = recentAssignments.get(key);
	if (!recent || Date.now() - recent.at > LIVE_REUSE_MS) {
		const ours = (await loadOurEntries(db)).get(target.spreadsheetId) ?? new Map();
		const opened = await openTab(
			input.client,
			target.spreadsheetId,
			tabName,
			Date.now() + input.timeBudgetMs,
			ours,
		);
		if (!opened.ok) return undefined;
		recent = recentAssignments.get(key);
		if (!recent) return undefined;
	}
	const assigned = recent.assigned.get(normaliseListNumber(turf.printedListNumber)) ?? null;
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

/** Fisher–Yates, in place. */
function shuffled<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j]!, items[i]!];
	}
	return items;
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
