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

import { and, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanSheetHealth, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { postAlert } from '../slack.js';
import { chunked } from './sql-chunk.js';
import { escapeMrkdwn } from '../../slack-mrkdwn.js';
import { OUT_OF_TIME, STALE_TAB, type SheetsClient } from '../google/sheets.js';
import {
	DEFAULT_SHEET_TAB_NAME,
	FILL_COLUMNS,
	campaignAssignments,
	cellWrites,
	changedCells,
	clearedCells,
	desiredCells,
	findLayout,
	isPacketRow,
	isUnfilled,
	markedName,
	priorCells,
	normaliseListNumber,
	packetRows,
	sheetDoors,
	stillOurs,
	type ColumnLayout,
	type PacketCells,
	type PacketCheckout,
	type PacketKey,
} from '../../van/packet-tracker.js';
import { matchSheetTarget, orderSheetTargets, type SheetTarget } from '../../van/sheet-routing.js';
import {
	COMPLETED_STATUS,
	DEFAULT_SHIFT_STARTS,
	WALK_IN_TAB_NAME,
	findOurWalkIn,
	filledWalkInColumns,
	findWalkInLayout,
	firstEmptyWalkInRow,
	highlightSweepDay,
	isEmptyWalkIn,
	isOurWalkIn,
	shiftFor,
	walkInCells,
	walkInColumnIndexes,
	walkInDay,
	walkInStatus,
	walkInWrites,
	type ShiftOption,
	type WalkInColumn,
	type WalkInLayout,
	type WalkInMark,
} from '../../van/walk-ins.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[sheets]';

/** How long after a checkout ends it is still re-derived. Long enough for the
 *  doors a lapsed claim knocked to be counted (WALK_PERCENT_WINDOW_MS) — which
 *  decides whether its entry is cleared — and short enough that the candidate read stays the
 *  handful of turf that is actually moving. */
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
 * when nothing. `prior`: what the packet had in those columns before we filled
 * it in — the campaign's Unwalked default, usually — so taking our entry back
 * restores it. `told`: the one-time notice already sent about this checkout, so
 * it is not repeated every run; the packet is still re-checked each run.
 * `gone`: our entry was taken over or removed by someone else, so we leave this
 * checkout alone for good rather than fight them for it. `yellow`: we cleared
 * our entry but Google would not take the highlight off, so it is tried again
 * while the packet is still free — only when it ever went on (`painted`).
 */
export interface SheetState {
	spreadsheetId: string | null;
	cells: PacketCells | null;
	prior?: PacketCells;
	told?: Notice;
	gone?: true;
	painted?: true;
	yellow?: true;
}

type Notice = 'not-listed' | 'duplicate' | 'taken';
const NOTICES: ReadonlySet<string> = new Set<Notice>(['not-listed', 'duplicate', 'taken']);

const EMPTY_STATE: SheetState = { spreadsheetId: null, cells: null };

/** States saved before the campaign renamed Doors Knocked to Knocked #
 *  (2026-10-05) hold the old name; read it as the new one. */
function renamedCells(cells: unknown): PacketCells | null {
	if (!cells || typeof cells !== 'object') return null;
	const { 'Doors Knocked': legacy, ...rest } = cells as PacketCells & {
		'Doors Knocked'?: string;
	};
	return legacy === undefined || 'Knocked #' in rest ? rest : { ...rest, 'Knocked #': legacy };
}

export function parseSheetState(raw: string | null): SheetState | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<SheetState>;
		const prior = renamedCells(parsed.prior);
		return {
			spreadsheetId: typeof parsed.spreadsheetId === 'string' ? parsed.spreadsheetId : null,
			cells: renamedCells(parsed.cells),
			...(prior ? { prior } : {}),
			...(parsed.told && NOTICES.has(parsed.told) ? { told: parsed.told } : {}),
			...(parsed.gone ? { gone: true as const } : {}),
			...(parsed.painted ? { painted: true as const } : {}),
			...(parsed.yellow ? { yellow: true as const } : {}),
		};
	} catch {
		// A corrupt state reads as "never written". The first fill only ever
		// goes into an empty packet, so this cannot overwrite anything.
		return null;
	}
}

/**
 * What `walk_in_state` holds: the Walk Ins row this checkout filled in and
 * what it wrote there — the name, which tells our row from the campaign's,
 * and the shift and status, so a row that has moved can be found again and
 * only our own cells are cleared. `rowIndex` null once cleared. `day` is the
 * canvass day it was written: the campaign empties the tab every day, so a
 * row from an earlier day is not ours any more, whatever is in it now.
 * `gone`: someone wrote over our row, so it is theirs and left alone.
 */
export interface WalkInState {
	spreadsheetId: string;
	rowIndex: number | null;
	name: string | null;
	shift?: string | null;
	/** The Final Status we wrote. Absent when we have not, or (`statusDone`)
	 *  when the campaign had already picked one, which is theirs. */
	status?: string;
	statusDone?: true;
	day?: string;
	/** Our row has its yellow. Absent when the tab refused it, so it is put on
	 *  later, once the tab takes it. */
	painted?: true;
	/** A row whose highlight we could not take off when we cleared it, to try
	 *  again while it is still that day and still empty. */
	yellowRow?: number;
	/** The night's sweep (highlightSweepDay) that took this row's yellow off
	 *  while it was still held, so the yellow on it is the repaint and that
	 *  sweep is not run on its spreadsheet again. */
	sweptOn?: string;
	gone?: true;
}

export function parseWalkInState(raw: string | null): WalkInState | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<WalkInState>;
		if (typeof parsed.spreadsheetId !== 'string') return null;
		return {
			spreadsheetId: parsed.spreadsheetId,
			rowIndex: typeof parsed.rowIndex === 'number' ? parsed.rowIndex : null,
			name: typeof parsed.name === 'string' ? parsed.name : null,
			...(typeof parsed.shift === 'string' ? { shift: parsed.shift } : {}),
			...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
			...(parsed.statusDone ? { statusDone: true as const } : {}),
			...(parsed.painted ? { painted: true as const } : {}),
			...(typeof parsed.yellowRow === 'number' ? { yellowRow: parsed.yellowRow } : {}),
			...(typeof parsed.day === 'string' ? { day: parsed.day } : {}),
			...(typeof parsed.sweptOn === 'string' ? { sweptOn: parsed.sweptOn } : {}),
			...(parsed.gone ? { gone: true as const } : {}),
		};
	} catch {
		// Read as "never written": the next fill only takes an empty row.
		return null;
	}
}

async function saveWalkInState(db: Db, checkoutId: number, state: WalkInState): Promise<void> {
	await db
		.update(vanTurfCheckouts)
		.set({ walkInState: JSON.stringify(state) })
		.where(eq(vanTurfCheckouts.id, checkoutId));
}

export interface TrackerResult {
	/** Packets filled in for the first time. */
	filled: number;
	/** Packets updated or cleared. */
	updated: number;
	/** Checkouts whose spreadsheet failed. Retried next run. */
	failed: number;
	/** Rows added to, and cleared from, the Walk Ins tab. */
	walkInsFilled: number;
	walkInsCleared: number;
	/** Checkouts left for the next run because Google's per-minute quota or
	 *  the run's own time ran out, or a row changed under the run. Not a
	 *  failure: nothing is alerted. */
	deferred: number;
	/** `deferred`, by why. */
	deferredFor: Partial<Record<DeferReason, number>>;
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

/** Why a checkout waits for the next run. */
export type DeferReason = 'quota' | 'out of time' | 'packet row moved' | 'walk-in row in use';

const EMPTY_RESULT: TrackerResult = {
	filled: 0,
	updated: 0,
	failed: 0,
	walkInsFilled: 0,
	walkInsCleared: 0,
	deferred: 0,
	deferredFor: {},
	unrouted: 0,
	unroutedRegions: [],
	assignmentsChanged: 0,
	budgetLapsed: false,
	warnings: [],
};

export interface TrackerOptions {
	now: Date;
	client: SheetsClient;
	/** The campaign this run writes for. Only its checkouts and turf are read,
	 *  and only `targets` — its own rules — route them. */
	campaignId: number;
	targets: readonly SheetTarget[];
	tabName?: string;
	timeBudgetMs: number;
	/** Where an ongoing failure is announced. Empty means don't. */
	channelId: string;
	/** Limit the run to the spreadsheet this turf routes to — the nudge after
	 *  one volunteer's action has no business reading a dozen spreadsheets. */
	onlyTurfId?: number;
}

type Candidate = PacketCheckout & {
	sheetState: string | null;
	walkInState: string | null;
};

async function loadCandidates(
	db: Db,
	now: Date,
	campaignId: number,
	turfId?: number,
): Promise<Candidate[]> {
	const settledBefore = new Date(now.getTime() - SETTLE_MS).toISOString();
	const pending = and(
		eq(vanTurfs.campaignId, campaignId),
		or(
			isNull(vanTurfCheckouts.sheetState),
			and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt)),
			gte(vanTurfCheckouts.releasedAt, settledBefore),
			gte(vanTurfCheckouts.completedAt, settledBefore),
		),
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
				releaseReason: vanTurfCheckouts.releaseReason,
				doorsKnocked: vanTurfCheckouts.doorsKnocked,
				issuedListNumber: vanTurfCheckouts.issuedListNumber,
				claimDoorCount: vanTurfCheckouts.claimDoorCount,
				sheetState: vanTurfCheckouts.sheetState,
				walkInState: vanTurfCheckouts.walkInState,
				turfName: vanTurfs.name,
				regionName: vanTurfs.regionName,
				doorCount: vanTurfs.doorCount,
			})
			.from(vanTurfCheckouts)
			// Inner join is safe for retired turf: those rows are stamped, never
			// deleted, precisely so a checkout on a vanished route still renders.
			.innerJoin(vanTurfs, eq(vanTurfCheckouts.turfId, vanTurfs.turfId))
			.where(turfId === undefined ? pending : and(pending, eq(vanTurfCheckouts.turfId, turfId)))
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
	spreadsheetIds: ReadonlySet<string>,
): Promise<void> {
	if (!channelId) return;
	// Only the spreadsheets this campaign's rules cover. Another campaign's run
	// announces its own, by name — this one would only know the bare id.
	const rows = (await db.select().from(vanSheetHealth)).filter((r) =>
		spreadsheetIds.has(r.spreadsheetId),
	);
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
	/** The Walk Ins tab, read in the same request when the run has walk-in
	 *  work for this spreadsheet. */
	walkIns?: string[][];
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

/** Count `count` checkouts as waiting for the next run, and why. */
function defer(result: TrackerResult, reason: DeferReason, count: number): void {
	if (count <= 0) return;
	result.deferred += count;
	result.deferredFor[reason] = (result.deferredFor[reason] ?? 0) + count;
}

/** Why a deferral (isDeferral) stops the run. */
const deferredBy = (failure: SheetFailure): DeferReason =>
	failure.status === RATE_LIMITED ? 'quota' : 'out of time';

/** "10 out of time, 1 walk-in row in use", most first. */
export function describeDeferrals(counts: TrackerResult['deferredFor']): string {
	return Object.entries(counts)
		.sort(([, a], [, b]) => b - a)
		.map(([reason, n]) => `${n} ${reason}`)
		.join(', ');
}

/**
 * Read the spreadsheet's Packet Tracker tab, and its Walk Ins tab with it when
 * `walkIns` says the run has work there: one request either way, of the
 * minute's 60. A spreadsheet with no Walk Ins tab fails the pair, so its
 * Packet Tracker tab is read on its own and the missing tab remembered.
 */
async function openTab(
	client: SheetsClient,
	spreadsheetId: string,
	tabName: string,
	deadline: number,
	ours: ReadonlyMap<string, string>,
	options: { walkIns?: boolean; urgent?: boolean; signal?: AbortSignal } = {},
): Promise<{ ok: true; tab: OpenTab } | ({ ok: false } & SheetFailure)> {
	const { urgent, signal } = options;
	let values: string[][];
	let walkIns: string[][] | undefined;
	const pair =
		options.walkIns && !walkInsTabMissing(spreadsheetId)
			? await client.readTabs({
					spreadsheetId,
					tabNames: [tabName, WALK_IN_TAB_NAME],
					deadline,
					urgent,
					signal,
				})
			: null;
	if (pair?.ok) {
		[values, walkIns] = pair.value as [string[][], string[][]];
	} else {
		if (pair && pair.status !== 404) return { ok: false, error: pair.error, status: pair.status };
		const read = await client.readTab({ spreadsheetId, tabName, deadline, urgent, signal });
		if (!read.ok) return { ok: false, error: read.error, status: read.status };
		// The pair failed for a missing tab, and it was not this one.
		if (pair) noWalkInsTab.set(spreadsheetId, Date.now());
		values = read.value;
	}
	const found = findLayout(values);
	if (!found.ok) {
		return {
			ok: false,
			status: 0,
			error: `the "${tabName}" tab has no ${found.missing.map((c) => `"${c}"`).join(', ')} column`,
		};
	}
	const tab: OpenTab = {
		spreadsheetId,
		tabName,
		values,
		layout: found.layout,
		...(walkIns ? { walkIns } : {}),
	};
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

/** How long a spreadsheet found without a Walk Ins tab is not asked again.
 *  Not every campaign sheet has one, and asking every run would spend a read
 *  of the minute's 60 for nothing; a tab added later is used within the hour. */
const NO_WALK_INS_MS = 60 * 60 * 1000;

const noWalkInsTab = new Map<string, number>();

/**
 * Spreadsheets the scheduled run read in full and brought up to date: when the
 * read went out, and the run's work for it as loaded then (`workFingerprint`).
 * A spreadsheet Drive says has not changed since, whose work is the same, has
 * nothing for the next run to do, and is not read: the run reads about 70
 * spreadsheets against 45 reads a minute, and most have not changed.
 *
 * In memory: a restart, or the other machine's first run, reads everything
 * once. A run that changed something — a write, a ledger save — is read again
 * next run, since Drive and the work both show it, and settles on the run
 * after.
 */
const fullReads = new Map<string, { at: number; fingerprint: string }>();
/** Drive's times are Google's clock and ours is ours, and an edit saved just
 *  as the read went out may not be in it: a spreadsheet is skipped only when
 *  it last changed this long before the read. */
const MODIFIED_MARGIN_MS = 2 * 60 * 1000;
/** Read anyway once the last full read is this old. Values that come from
 *  formulas — IMPORTRANGE, a lookup — change without Drive saying so, and
 *  what the run remembers for an hour (a tab that refused a highlight) ends
 *  without the work changing. */
const FULL_READ_MAX_AGE_MS = 60 * 60 * 1000;
/** When the run last said it could not ask Drive, so it says so hourly, not
 *  every run. */
let driveRefusedSaidAt = 0;

function walkInsTabMissing(spreadsheetId: string): boolean {
	const since = noWalkInsTab.get(spreadsheetId);
	return since !== undefined && Date.now() - since < NO_WALK_INS_MS;
}

/** How long a tab that refused a highlight is not asked again. A refusal that
 *  is not the quota or the clock — protected cells, most likely — will refuse
 *  the next one too, and each attempt spends a write of the minute's 60. */
const NO_HIGHLIGHT_MS = 60 * 60 * 1000;

const highlightRefused = new Map<string, number>();

/** The canvass day each spreadsheet's Walk Ins highlights were last taken off
 *  for, so the rest of the night's runs on this machine skip the ledger read.
 *  Whether a sweep is owed is the ledger's to say (loadPaintRecords), so a
 *  restart or the other machine does not repeat one. */
const highlightsSwept = new Map<string, string>();
/** What a refusal is: Google saying no, not Google failing to answer. */
const REFUSALS: ReadonlySet<number> = new Set([400, 403, 404]);
const highlightKey = (spreadsheetId: string, tabName: string) => `${spreadsheetId}\u0000${tabName}`;

function refusesHighlight(spreadsheetId: string, tabName: string): boolean {
	const since = highlightRefused.get(highlightKey(spreadsheetId, tabName));
	return since !== undefined && Date.now() - since < NO_HIGHLIGHT_MS;
}

/** Test-only: forget every remembered read. */
export function _resetLiveReadsForTests(): void {
	recentAssignments.clear();
	noWalkInsTab.clear();
	highlightRefused.clear();
	highlightsSwept.clear();
	fullReads.clear();
	driveRefusedSaidAt = 0;
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
	// Escaped for the same channel: a Google or Apple volunteer picks their own name.
	const label = escapeMrkdwn(`${candidate.turfName} (${candidate.slackUserName})`);
	const base: SheetState = { ...state, spreadsheetId: tab.spreadsheetId };

	const key = { listNumber: candidate.issuedListNumber, turfName: candidate.turfName };
	const rows = candidate.issuedListNumber ? packetRows(tab.values, tab.layout, key) : [];
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
			if (state.yellow && candidate.issuedListNumber) {
				return unhighlightFreed(client, tab, rowIndex, key, base, save, deadline);
			}
			await save(base);
			return 'unchanged';
		}
		if (!isUnfilled(current, tab.layout)) {
			// Somebody has this packet. Theirs — but it is checked again every
			// run, and filled in if their entry is cleared while ours is live.
			// The sheet's entry should have blocked the claim, so one here means
			// two people have the turf — an organizer's problem to sort out.
			if (state.told !== 'taken') {
				warnings.push(
					`${LOG} ${label} was claimed, but its packet already has someone else's entry in the Packet Tracker, so that entry was left as it is`,
				);
			}
			await save({ ...base, told: 'taken' });
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
			writes = clearedCells(state.cells, state.prior);
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
	const samePacket = isPacketRow(fresh.value, tab.layout, key);
	const stillFree =
		state.cells === null
			? isUnfilled(fresh.value, tab.layout)
			: stillOurs(fresh.value, tab.layout, state.cells);
	if (!samePacket || !stillFree) return 'moved';

	// Our entry is highlighted while it is ours, so the campaign can tell it
	// from theirs at a glance; taking it back takes the yellow with it. Before
	// the values: out of quota or time, nothing is written and the whole step
	// is retried next run. Every write re-applies it, which also catches
	// entries filled in before there was a highlight.
	const styled = await highlight(
		client,
		tab.spreadsheetId,
		rowIndex,
		FILL_COLUMNS.map((column) => tab.layout.columns[column]),
		next !== null,
		deadline,
		tab.tabName,
	);
	if (typeof styled === 'object') return styled;

	const res = await client.writeCells({
		spreadsheetId: tab.spreadsheetId,
		tabName: tab.tabName,
		rowIndex,
		cells: cellWrites(writes, tab.layout),
		deadline,
	});
	if (!res.ok) return { error: res.error, status: res.status };
	// A first fill records what it covered, from the row as just re-read.
	const prior = state.cells === null ? priorCells(fresh.value, tab.layout) : state.prior;
	await save({
		spreadsheetId: tab.spreadsheetId,
		cells: next,
		...(next && prior && Object.keys(prior).length > 0 ? { prior } : {}),
		...(next !== null && (styled === 'done' || state.painted) ? { painted: true as const } : {}),
		// Cleared, but the yellow we put on could not come off: try again.
		...(next === null && styled !== 'done' && state.painted ? { yellow: true as const } : {}),
	});
	return state.cells === null ? 'filled' : 'updated';
}

/**
 * Try again to take the highlight off a packet we cleared, while nobody has
 * it: once someone's entry is there, the row is theirs, colour and all. The
 * row is re-read first, as before any write: it goes by number, and the tab
 * may have been sorted since the run read it.
 */
async function unhighlightFreed(
	client: SheetsClient,
	tab: OpenTab,
	rowIndex: number,
	key: PacketKey,
	base: SheetState,
	save: (next: SheetState) => Promise<void>,
	deadline: number,
): Promise<Outcome> {
	if (refusesHighlight(tab.spreadsheetId, tab.tabName)) return 'unchanged';
	const rest: SheetState = { ...base };
	delete rest.yellow;
	const fresh = await client.readRow({
		spreadsheetId: tab.spreadsheetId,
		tabName: tab.tabName,
		rowIndex,
		deadline,
	});
	if (!fresh.ok) return { error: fresh.error, status: fresh.status };
	if (!isPacketRow(fresh.value, tab.layout, key)) return 'moved';
	if (isUnfilled(fresh.value, tab.layout)) {
		const off = await highlight(
			client,
			tab.spreadsheetId,
			rowIndex,
			FILL_COLUMNS.map((column) => tab.layout.columns[column]),
			false,
			deadline,
			tab.tabName,
		);
		if (typeof off === 'object') return off;
		if (off === 'skipped') return 'unchanged';
	}
	await save(rest);
	return 'unchanged';
}

type WalkInWork = 'fill' | 'complete' | 'paint' | 'clear' | 'unhighlight';

/** What a checkout needs on the Walk Ins tab this run, if anything. */
function walkInWork(candidate: Candidate, spreadsheetId: string, today: string): WalkInWork | null {
	const state = parseWalkInState(candidate.walkInState);
	if (state?.gone) return null;
	// Rows stay with the spreadsheet they were written to, and a row from an
	// earlier day was emptied by the campaign — whoever is in it now is
	// somebody else.
	const ours = state !== null && state.spreadsheetId === spreadsheetId && state.day === today;
	// Same rule as the packet's entry: there while it would be.
	const wanted = desiredCells(candidate) !== null;
	if (state?.rowIndex != null) {
		if (!ours) return null;
		if (!wanted) return 'clear';
		const owed = state.status === undefined && !state.statusDone;
		if (candidate.completedAt !== null && owed) return 'complete';
		// Added while the tab refused highlights: its yellow is still owed.
		return state.painted ? null : 'paint';
	}
	// Today's claims only, while held: the tab is the day's walk-ins, and
	// nothing earlier is backfilled.
	const live = candidate.releasedAt === null && candidate.completedAt === null;
	if (wanted && live && walkInDay(candidate.claimedAt) === today) return 'fill';
	return ours && state.yellowRow !== undefined ? 'unhighlight' : null;
}

interface WalkInsOutcome {
	filled: number;
	cleared: number;
	/** Rows that changed under us since the read; the next run tries again. */
	deferred: number;
	/** A Google error, and how many rows it left waiting for the next run. */
	failure?: SheetFailure;
	waiting?: number;
}

/** Said in the alert, so a Walk Ins problem is not taken for the Packet
 *  Tracker's. */
const walkInFailure = (error: string, status: number): SheetFailure => ({
	error: `${WALK_IN_TAB_NAME} tab: ${error}`,
	status,
});

/** How far down the tab the Shift Start drop-down is looked for. */
const DROPDOWN_SEARCH_ROWS = 20;

/**
 * The options of the tab's Shift Start drop-down, or the ones it had when
 * this was written if it has none or cannot be read. Only a lapsed budget or
 * the minute's quota stops the run.
 */
async function shiftOptions(
	client: SheetsClient,
	spreadsheetId: string,
	layout: WalkInLayout,
	deadline: number,
): Promise<readonly ShiftOption[] | SheetFailure> {
	const res = await client.dropdownOptions({
		spreadsheetId,
		tabName: WALK_IN_TAB_NAME,
		rowIndex: layout.headerRowIndex + 1,
		rows: DROPDOWN_SEARCH_ROWS,
		columnIndex: layout.columns['Shift Start'],
		deadline,
	});
	if (!res.ok) {
		if (isDeferral(res)) return res;
		console.warn(
			`${LOG} could not read the Shift Start options in ${spreadsheetId}: ${res.status}`,
		);
	} else if (res.value && res.value.length > 0) {
		return res.value;
	}
	return DEFAULT_SHIFT_STARTS;
}

/** Another checkout's row today, as recorded: where, and what marks it. */
interface HeldRow {
	checkoutId: number;
	rowIndex: number;
	mark: WalkInMark;
}

/**
 * Every row a checkout holds on this spreadsheet's Walk Ins tab today — from
 * the ledger, not this run's candidates: the nudge after one volunteer's
 * action loads only their turf, and the rows of their other turfs still have
 * to be told apart from theirs.
 */
async function loadHeldRows(
	db: Db,
	spreadsheetId: string,
	today: string,
	now: Date,
): Promise<HeldRow[]> {
	// Today's rows were written for claims made today, and a canvass day runs
	// past midnight: two days back covers it without reading the season.
	const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({ id: vanTurfCheckouts.id, walkInState: vanTurfCheckouts.walkInState })
		.from(vanTurfCheckouts)
		.where(and(isNotNull(vanTurfCheckouts.walkInState), gte(vanTurfCheckouts.claimedAt, since)));
	return rows.flatMap((row) => {
		const state = parseWalkInState(row.walkInState);
		if (
			!state ||
			state.gone ||
			state.rowIndex === null ||
			state.name === null ||
			state.spreadsheetId !== spreadsheetId ||
			state.day !== today
		) {
			return [];
		}
		return [
			{
				checkoutId: row.id,
				rowIndex: state.rowIndex,
				mark: { name: state.name, shift: state.shift ?? null },
			},
		];
	});
}

/** The checkouts with something to do on this spreadsheet's Walk Ins tab
 *  this run. */
function walkInJobs(
	candidates: readonly Candidate[],
	spreadsheetId: string,
	now: Date,
): Array<{ candidate: Candidate; work: WalkInWork }> {
	const today = walkInDay(now.toISOString());
	// Yellow alone is not worth a read of the tab while it refuses highlights.
	const refusing = refusesHighlight(spreadsheetId, WALK_IN_TAB_NAME);
	return candidates.flatMap((candidate) => {
		const work = walkInWork(candidate, spreadsheetId, today);
		if (!work || (refusing && (work === 'paint' || work === 'unhighlight'))) return [];
		return [{ candidate, work }];
	});
}

/**
 * Bring the spreadsheet's Walk Ins tab in line with its checkouts: add a row
 * for each new claim, mark it Completed when walked, clear it when given back
 * or lapsed.
 *
 * Reads the tab only when there is something to do, and not at all when the
 * run read it with the Packet Tracker tab (`preRead`). A spreadsheet without a
 * Walk Ins tab is skipped quietly — not every campaign sheet has one.
 */
async function syncWalkIns(
	db: Db,
	client: SheetsClient,
	spreadsheetId: string,
	candidates: readonly Candidate[],
	now: Date,
	deadline: number,
	warnings: string[],
	preRead?: string[][],
): Promise<WalkInsOutcome> {
	const outcome: WalkInsOutcome = { filled: 0, cleared: 0, deferred: 0 };
	const today = walkInDay(now.toISOString());
	const jobs = walkInJobs(candidates, spreadsheetId, now);
	if (jobs.length === 0) return outcome;
	if (walkInsTabMissing(spreadsheetId)) return outcome;
	const fail = (failure: SheetFailure, waiting: number): WalkInsOutcome => ({
		...outcome,
		waiting,
		failure: walkInFailure(failure.error, failure.status),
	});

	const read = preRead
		? { ok: true as const, value: preRead }
		: await client.readTab({ spreadsheetId, tabName: WALK_IN_TAB_NAME, deadline });
	if (!read.ok) {
		if (read.status === 404) {
			noWalkInsTab.set(spreadsheetId, Date.now());
			return outcome;
		}
		return fail(read, jobs.length);
	}
	const layout = findWalkInLayout(read.value);
	if (!layout) {
		return fail({ status: 0, error: 'it has no "Name" or "Shift Start" column' }, jobs.length);
	}
	let shifts: readonly ShiftOption[] = DEFAULT_SHIFT_STARTS;
	if (jobs.some((j) => j.work === 'fill')) {
		const found = await shiftOptions(client, spreadsheetId, layout, deadline);
		if ('error' in found) return fail(found, jobs.length);
		shifts = found;
	}
	const highlighted = walkInColumnIndexes(layout);
	const held = await loadHeldRows(db, spreadsheetId, today, now);
	// Rows filled in or found in use this run, which the tab as read does not
	// show.
	const taken = new Set<number>();
	const readRow = (rowIndex: number) =>
		client.readRow({ spreadsheetId, tabName: WALK_IN_TAB_NAME, rowIndex, deadline });
	const save = (checkoutId: number, state: WalkInState) => saveWalkInState(db, checkoutId, state);

	for (const [i, { candidate, work }] of jobs.entries()) {
		const state = parseWalkInState(candidate.walkInState);
		const waiting = jobs.length - i;

		if (work === 'fill') {
			// Not a row another checkout holds today, even one staff emptied:
			// that checkout would later find a stranger in it.
			const rowIndex = firstEmptyWalkInRow(
				read.value,
				layout,
				new Set([...taken, ...held.map((h) => h.rowIndex)]),
			);
			taken.add(rowIndex);
			// A tab filled to its last row gets more, rather than refusing the
			// read and write past its end every run.
			if (rowIndex >= read.value.length) {
				const grown = await client.ensureRows({
					spreadsheetId,
					tabName: WALK_IN_TAB_NAME,
					rowIndex,
					deadline,
				});
				if (!grown.ok) return fail(grown, waiting);
			}
			// The check just before the write, as on the Packet Tracker: rows go
			// by number, and someone may have written in this one since the read.
			const fresh = await readRow(rowIndex);
			if (!fresh.ok) return fail(fresh, waiting);
			if (!isEmptyWalkIn(fresh.value, layout)) {
				// Which columns, never what is in them. Someone writing in the
				// row between the two reads gives this, and so would two reads
				// that disagree about the same row; the row number against the
				// read's length, and how often it happens, tell them apart.
				if (outcome.deferred === 0) {
					const where =
						rowIndex < read.value.length
							? `blank in the tab read (${read.value.length} rows`
							: `past the end of the tab read (${read.value.length} rows`;
					console.warn(
						`${LOG} ${spreadsheetId} ${WALK_IN_TAB_NAME} row ${rowIndex + 1}: ${where}, ` +
							`header row ${layout.headerRowIndex + 1}), filled on re-read in ` +
							`${filledWalkInColumns(fresh.value, layout).join(', ')}; ` +
							`re-read has ${fresh.value.length} cells`,
					);
				}
				outcome.deferred += 1;
				continue;
			}
			const shift = shiftFor(candidate.claimedAt, shifts);
			const styled = await highlight(client, spreadsheetId, rowIndex, highlighted, true, deadline);
			if (typeof styled === 'object') return fail(styled, waiting);
			const written = await client.writeCells({
				spreadsheetId,
				tabName: WALK_IN_TAB_NAME,
				rowIndex,
				cells: walkInWrites(walkInCells(candidate, shift?.label ?? null), layout, {
					shiftAsTyped: shift !== null && !shift.text,
				}),
				deadline,
			});
			if (!written.ok) {
				// Not left as an empty yellow row: the claim may end before the
				// next run fills it in.
				const off =
					styled === 'done'
						? await highlight(client, spreadsheetId, rowIndex, highlighted, false, deadline)
						: 'done';
				if (off !== 'done') {
					await save(candidate.checkoutId, {
						spreadsheetId,
						rowIndex: null,
						name: null,
						day: today,
						yellowRow: rowIndex,
					});
				}
				return fail(written, waiting);
			}
			await save(candidate.checkoutId, {
				spreadsheetId,
				rowIndex,
				name: markedName(candidate.slackUserName),
				shift: shift?.label ?? null,
				day: today,
				...(styled === 'done' ? { painted: true as const } : {}),
			});
			outcome.filled += 1;
			continue;
		}

		if (work === 'unhighlight') {
			// A cleared row still yellow. Ours to fix only while it is empty: if
			// someone has written in it since, it is theirs, colour and all.
			const rowIndex = state!.yellowRow!;
			const fresh = await readRow(rowIndex);
			if (!fresh.ok) return fail(fresh, waiting);
			const rest: WalkInState = { ...state! };
			delete rest.yellowRow;
			if (isEmptyWalkIn(fresh.value, layout)) {
				const off = await highlight(client, spreadsheetId, rowIndex, highlighted, false, deadline);
				if (typeof off === 'object') return fail(off, waiting);
				if (off === 'skipped') continue;
			}
			await save(candidate.checkoutId, rest);
			continue;
		}

		// Clearing, completing or painting: find our row.
		const ours: WalkInMark = { name: state!.name ?? '', shift: state!.shift ?? null };
		const recorded = state!.rowIndex!;
		let rowIndex = recorded;
		let fresh = await readRow(recorded);
		if (!fresh.ok) return fail(fresh, waiting);
		if (!isOurWalkIn(fresh.value, layout, ours)) {
			// Not where we left it: the campaign may have deleted, inserted or
			// sorted rows. Only ever the one row marked as ours that no other
			// checkout can be shown to hold — a second could be a walk-in staff
			// wrote for the same person, and clearing theirs instead of ours is
			// worse than clearing neither. Another checkout's row counts as
			// held only while its recorded row still reads as its own: after a
			// move, recorded numbers point at the wrong rows.
			const others = new Set(taken);
			for (const h of held) {
				if (h.checkoutId === candidate.checkoutId) continue;
				if (isOurWalkIn(read.value[h.rowIndex], layout, h.mark)) others.add(h.rowIndex);
			}
			const found = findOurWalkIn(read.value, layout, ours, others);
			if (found !== null) {
				const moved = await readRow(found);
				if (!moved.ok) return fail(moved, waiting);
				if (isOurWalkIn(moved.value, layout, ours)) {
					rowIndex = found;
					fresh = moved;
				}
			}
			if (rowIndex === recorded) {
				if (isEmptyWalkIn(fresh.value, layout)) {
					// Emptied already — the campaign clearing the tab early.
					// Its clear leaves the yellow, which is still ours to take
					// off ('unhighlight', or the night's sweep).
					await save(candidate.checkoutId, {
						spreadsheetId,
						rowIndex: null,
						name: null,
						day: today,
						...(state!.painted ? { yellowRow: recorded } : {}),
					});
				} else {
					// Escaped: a Google or Apple volunteer picks their own name.
					warnings.push(
						`${LOG} the Walk Ins row for ${escapeMrkdwn(`${candidate.turfName} (${candidate.slackUserName})`)} ` +
							`has been changed by hand, so it was left as it is`,
					);
					await save(candidate.checkoutId, { ...state!, gone: true });
				}
				continue;
			}
		}

		if (work === 'paint') {
			const on = await highlight(client, spreadsheetId, rowIndex, highlighted, true, deadline);
			if (typeof on === 'object') return fail(on, waiting);
			if (on === 'done') {
				await save(candidate.checkoutId, { ...state!, rowIndex, painted: true });
			}
			continue;
		}

		if (work === 'complete') {
			// A Final Status the campaign already picked is theirs, as on the
			// Packet Tracker: never overwritten.
			if (
				layout.columns['Final Status'] === undefined ||
				walkInStatus(fresh.value, layout) !== ''
			) {
				await save(candidate.checkoutId, { ...state!, rowIndex, statusDone: true });
				continue;
			}
			const written = await client.writeCells({
				spreadsheetId,
				tabName: WALK_IN_TAB_NAME,
				rowIndex,
				cells: walkInWrites([['Final Status', COMPLETED_STATUS]], layout),
				deadline,
			});
			if (!written.ok) return fail(written, waiting);
			await save(candidate.checkoutId, { ...state!, rowIndex, status: COMPLETED_STATUS });
			continue;
		}

		const styled = await highlight(client, spreadsheetId, rowIndex, highlighted, false, deadline);
		if (typeof styled === 'object') return fail(styled, waiting);
		// Only what we wrote and is still as we wrote it: a Final Status the
		// campaign has picked since stays. Name and shift were just checked.
		const blanks: Array<[WalkInColumn, string]> = [['Name', '']];
		if (ours.shift !== null) blanks.push(['Shift Start', '']);
		if (state!.status !== undefined && walkInStatus(fresh.value, layout) === state!.status) {
			blanks.push(['Final Status', '']);
		}
		const written = await client.writeCells({
			spreadsheetId,
			tabName: WALK_IN_TAB_NAME,
			rowIndex,
			cells: walkInWrites(blanks, layout),
			deadline,
		});
		if (!written.ok) return fail(written, waiting);
		await save(candidate.checkoutId, {
			spreadsheetId,
			rowIndex: null,
			name: null,
			day: today,
			// Cleared, but the yellow we put on could not come off: try again.
			...(styled !== 'done' && state!.painted ? { yellowRow: rowIndex } : {}),
		});
		outcome.cleared += 1;
	}
	if (outcome.deferred > 1) {
		const fills = jobs.filter((j) => j.work === 'fill').length;
		console.warn(
			`${LOG} ${spreadsheetId} ${WALK_IN_TAB_NAME}: ${outcome.deferred} of ${fills} new ` +
				'row(s) found filled on re-read',
		);
	}
	return outcome;
}

/**
 * Take every highlight off the Walk Ins tab of each spreadsheet where a row
 * this app painted may still be yellow, once a night (highlightSweepDay). The
 * campaign empties the tab's values each night and the yellow stays behind on
 * rows nobody is in any more.
 *
 * Only those spreadsheets: the sweep is for our yellow, and the ledger records
 * each row we painted. Asking Google of every spreadsheet costs a read and a
 * write each — seventy-odd, paced, which fills the run before any packet is
 * written. Within one, every row below the header loses its yellow, whoever
 * coloured it. A row a checkout still holds for the closing day loses its
 * yellow too, and is marked to have it put back: run before the ledger is
 * read, so this same run repaints it.
 *
 * Best effort: a failure is logged, and the next run before the rollover
 * tries again. Only the minute's quota or the run's time stops the rest.
 */
async function sweepWalkInHighlights(
	db: Db,
	client: SheetsClient,
	spreadsheetIds: readonly string[],
	now: Date,
	deadline: number,
): Promise<void> {
	const day = highlightSweepDay(now);
	if (day === null) return;
	const unswept = spreadsheetIds.filter((id) => highlightsSwept.get(id) !== day);
	if (unswept.length === 0) return;
	const records = await loadPaintRecords(db, day, now);
	for (const spreadsheetId of unswept) {
		const ours = records.filter((r) => r.state.spreadsheetId === spreadsheetId);
		if (ours.length === 0) {
			highlightsSwept.set(spreadsheetId, day);
			continue;
		}
		if (refusesHighlight(spreadsheetId, WALK_IN_TAB_NAME)) continue;
		if (walkInsTabMissing(spreadsheetId)) continue;

		const read = await client.readTab({ spreadsheetId, tabName: WALK_IN_TAB_NAME, deadline });
		if (!read.ok) {
			if (read.status === 404) {
				noWalkInsTab.set(spreadsheetId, Date.now());
				highlightsSwept.set(spreadsheetId, day);
				continue;
			}
			if (isDeferral(read)) return;
			console.warn(`${LOG} could not read the Walk Ins tab in ${spreadsheetId}: ${read.status}`);
			continue;
		}
		// No header to keep: the walk-in sync says so in its own alert.
		const layout = findWalkInLayout(read.value);
		if (!layout) {
			highlightsSwept.set(spreadsheetId, day);
			continue;
		}
		const res = await client.clearHighlights({
			spreadsheetId,
			tabName: WALK_IN_TAB_NAME,
			fromRowIndex: layout.headerRowIndex + 1,
			deadline,
		});
		if (!res.ok) {
			if (isDeferral(res)) return;
			console.warn(
				`${LOG} could not take the highlights off the Walk Ins tab in ${spreadsheetId}: ${res.status}`,
			);
			continue;
		}
		highlightsSwept.set(spreadsheetId, day);
		const repaint = await unpaintHeldRows(db, ours, day);
		console.log(
			`${LOG} took the highlights off the Walk Ins tab in ${spreadsheetId}; ${repaint} row(s) to repaint`,
		);
	}
}

interface PaintRecord {
	id: number;
	/** The stored `walk_in_state`, as read. */
	raw: string;
	state: WalkInState;
}

/**
 * Checkouts whose Walk Ins row this app painted and may still be yellow, from
 * the day being swept or one before it whose sweep was missed. Not a row
 * repainted after this night's sweep: the ledger is shared, so a sweep one
 * machine has done is not repeated by the other.
 */
async function loadPaintRecords(db: Db, day: string, now: Date): Promise<PaintRecord[]> {
	// As loadHeldRows: two days back covers a canvass day past midnight.
	const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({ id: vanTurfCheckouts.id, walkInState: vanTurfCheckouts.walkInState })
		.from(vanTurfCheckouts)
		.where(and(isNotNull(vanTurfCheckouts.walkInState), gte(vanTurfCheckouts.claimedAt, since)));
	const records: PaintRecord[] = [];
	for (const row of rows) {
		const state = parseWalkInState(row.walkInState);
		if (!state?.day || state.day > day || state.sweptOn === day) continue;
		if (state.painted || state.yellowRow !== undefined) {
			records.push({ id: row.id, raw: row.walkInState!, state });
		}
	}
	return records;
}

/**
 * After the sweep of one spreadsheet: forget that its rows have their yellow,
 * so a row still held is repainted ('paint') and a cleared one is not chased
 * for a highlight that is already gone ('unhighlight'). Returns how many rows
 * are still held and so owed their yellow back.
 */
async function unpaintHeldRows(db: Db, records: readonly PaintRecord[], day: string) {
	let held = 0;
	for (const { id, raw, state } of records) {
		const rest: WalkInState = { ...state };
		delete rest.painted;
		delete rest.yellowRow;
		const holds = rest.day === day && rest.rowIndex !== null && !rest.gone;
		if (holds) rest.sweptOn = day;
		// Only over the state as read, which was before the sweep's paced calls
		// to Google. A nudge that took the lock from a run past its lifetime may
		// have saved a newer one since, and that one stands.
		const saved = await db
			.update(vanTurfCheckouts)
			.set({ walkInState: JSON.stringify(rest) })
			.where(and(eq(vanTurfCheckouts.id, id), eq(vanTurfCheckouts.walkInState, raw)));
		if (holds && saved.rowsAffected > 0) held += 1;
	}
	return held;
}

/**
 * Highlight a row's cells, or take the highlight off. A failure is returned
 * for the minute's quota, the run's time or Google failing to answer, which
 * stop the step; a refusal is logged and comes back as `skipped`, and the
 * write goes ahead
 * without it — the highlight helps the campaign read the sheet, it is no
 * reason to leave the sheet stale. A tab that refused is not asked again for
 * an hour. A highlight left on a row we cleared is the caller's to try again.
 */
async function highlight(
	client: SheetsClient,
	spreadsheetId: string,
	rowIndex: number,
	columns: readonly number[],
	on: boolean,
	deadline: number,
	tabName: string = WALK_IN_TAB_NAME,
): Promise<'done' | 'skipped' | SheetFailure> {
	if (refusesHighlight(spreadsheetId, tabName)) return 'skipped';
	const res = await client.highlightCells({
		spreadsheetId,
		tabName,
		rowIndex,
		columns,
		on,
		deadline,
	});
	if (res.ok) return 'done';
	// Only an answer that will not change is a refusal. A 5xx or a network
	// failure is Google having a bad moment: stop and try the step again next
	// run, like the quota — remembered as a refusal, it would leave an hour of
	// walk-ins without their yellow.
	// Nor is a row or tab the cached layout says is there and is not: the
	// write fails the same way, the client looks the tab up again, and the
	// next run has it right.
	const refused = REFUSALS.has(res.status) && !STALE_TAB.test(res.error);
	if (isDeferral(res) || !refused) return { error: res.error, status: res.status };
	highlightRefused.set(highlightKey(spreadsheetId, tabName), Date.now());
	console.warn(
		`${LOG} could not ${on ? 'highlight' : 'un-highlight'} a row in ${spreadsheetId}: ${res.status}`,
	);
	return 'skipped';
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
		turfId: number;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>,
): Promise<number> {
	const assigned = campaignAssignments(tab.values, tab.layout, ours);
	// One statement per name rather than per turf: a campaign that writes a
	// fresh cut into its trackers changes thousands at once, and a write each
	// took the run's whole budget on the first few spreadsheets.
	const byName = new Map<string | null, number[]>();
	for (const turf of turfs) {
		const next = turf.printedListNumber
			? (assigned.get(normaliseListNumber(turf.printedListNumber)) ?? null)
			: null;
		if (next === turf.sheetAssignedTo) continue;
		let ids = byName.get(next);
		if (!ids) byName.set(next, (ids = []));
		ids.push(turf.turfId);
	}
	const writes = [...byName].flatMap(([name, ids]) =>
		chunked(ids).map((chunk) =>
			db.update(vanTurfs).set({ sheetAssignedTo: name }).where(inArray(vanTurfs.turfId, chunk)),
		),
	);
	if (writes.length === 0) return 0;
	await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
	return [...byName.values()].reduce((n, ids) => n + ids.length, 0);
}

/** Everything the run does to a spreadsheet follows from: its checkouts and
 *  turfs as the ledger has them, our entries in it, the tab, and the canvass
 *  day. */
function workFingerprint(
	work: { candidates: Candidate[]; turfs: unknown[] },
	ours: ReadonlyMap<string, string>,
	tabName: string,
	day: string,
): string {
	return JSON.stringify([tabName, day, work.candidates, work.turfs, [...ours]]);
}

/**
 * The spreadsheets the run can leave unread: read in full within the hour,
 * the same work since, and no change Drive knows of since that read. None
 * when Drive cannot be asked — every spreadsheet is read, as it would be
 * without this.
 */
async function unchangedSpreadsheets(
	client: SheetsClient,
	fingerprints: ReadonlyMap<string, string>,
	deadline: number,
): Promise<Set<string>> {
	const unchanged = new Set<string>();
	const recent = [...fingerprints].flatMap(([spreadsheetId, fingerprint]) => {
		const read = fullReads.get(spreadsheetId);
		const fresh = read && Date.now() - read.at < FULL_READ_MAX_AGE_MS;
		return fresh && read.fingerprint === fingerprint ? [{ spreadsheetId, at: read.at }] : [];
	});
	if (recent.length === 0) return unchanged;
	const since = Math.min(...recent.map((r) => r.at)) - MODIFIED_MARGIN_MS;
	const changed = await client.modifiedSince({ since: new Date(since).toISOString(), deadline });
	if (!changed.ok) {
		if (Date.now() - driveRefusedSaidAt >= FULL_READ_MAX_AGE_MS) {
			driveRefusedSaidAt = Date.now();
			console.warn(
				`${LOG} could not ask Drive which spreadsheets changed, so every one is read: ` +
					`${changed.status} ${changed.error}`,
			);
		}
		return unchanged;
	}
	for (const { spreadsheetId, at } of recent) {
		const modified = changed.value.get(spreadsheetId);
		if (modified === undefined || Date.parse(modified) < at - MODIFIED_MARGIN_MS) {
			unchanged.add(spreadsheetId);
		}
	}
	return unchanged;
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
		turfId: number;
		regionName: string;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>;
	// The scheduled run only, not a nudge for one turf. Before the ledger is
	// read, so the rows it marks for repainting are repainted by this run.
	if (options.onlyTurfId === undefined) {
		const spreadsheetIds = [...new Set(targets.map((t) => t.spreadsheetId))];
		await safely(
			() => sweepWalkInHighlights(db, client, spreadsheetIds, now, deadline),
			'walk-in highlight sweep',
		);
	}
	try {
		candidates = await loadCandidates(db, now, options.campaignId, options.onlyTurfId);
		ourEntries = await loadOurEntries(db);
		turfs = await db
			.select({
				turfId: vanTurfs.turfId,
				regionName: vanTurfs.regionName,
				printedListNumber: vanTurfs.printedListNumber,
				sheetAssignedTo: vanTurfs.sheetAssignedTo,
			})
			.from(vanTurfs)
			.where(
				and(
					eq(vanTurfs.campaignId, options.campaignId),
					isNull(vanTurfs.retiredAt),
					options.onlyTurfId === undefined ? undefined : eq(vanTurfs.turfId, options.onlyTurfId),
				),
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
		deferredFor: {},
		warnings: [],
	};

	// The scheduled run only: a nudge reads its one spreadsheet regardless.
	const scheduled = options.onlyTurfId === undefined;
	const today = walkInDay(now.toISOString());
	const fingerprints = new Map(
		[...bySpreadsheet].map(([spreadsheetId, work]) => [
			spreadsheetId,
			workFingerprint(work, oursIn(spreadsheetId), tabName, today),
		]),
	);
	const unchanged = scheduled
		? await unchangedSpreadsheets(client, fingerprints, deadline)
		: new Set<string>();

	// Spreadsheets with an entry to write go first; the rest are only being
	// read for the campaign's assignments, and go in a different order each run
	// so that a run cut short does not skip the same ones every time.
	const order = shuffled([...bySpreadsheet.keys()].filter((id) => !unchanged.has(id))).sort(
		(a, b) =>
			Number(bySpreadsheet.get(b)!.candidates.length > 0) -
			Number(bySpreadsheet.get(a)!.candidates.length > 0),
	);

	// A few reads started ahead, so the next spreadsheet's tab is in hand when
	// this one is done. The Sheets client paces them through the minute's
	// quota, so one started ahead may wait its turn there: the run withdraws
	// any still outstanding when it returns, before they spend a read nobody
	// will use, after the lock is released.
	const opening = new Map<string, ReturnType<typeof openTab>>();
	/** When each read went out, for `fullReads`. */
	const openedAt = new Map<string, number>();
	const ahead = new AbortController();
	const open = (spreadsheetId: string) => {
		let pending = opening.get(spreadsheetId);
		if (!pending) {
			openedAt.set(spreadsheetId, Date.now());
			const work = bySpreadsheet.get(spreadsheetId)!;
			pending = openTab(client, spreadsheetId, tabName, deadline, oursIn(spreadsheetId), {
				walkIns: walkInJobs(work.candidates, spreadsheetId, now).length > 0,
				signal: ahead.signal,
			});
			opening.set(spreadsheetId, pending);
		}
		return pending;
	};

	// Set once Google says the minute's quota is spent or the run's time is
	// up: everything after would be refused the same way.
	let stopped = false;
	/** What stopped it, for the checkouts left after. */
	let stoppedFor: DeferReason = 'out of time';
	/** Spreadsheets whose tab this run read, of `order.length`. Logged, so a
	 *  run the quota cuts short says how far it got. */
	let reached = 0;
	for (const [index, spreadsheetId] of order.entries()) {
		const work = bySpreadsheet.get(spreadsheetId)!;
		if (!stopped && Date.now() >= deadline) {
			stopped = true;
			result.budgetLapsed = true;
		}
		if (stopped) {
			defer(result, stoppedFor, work.candidates.length);
			continue;
		}
		for (const ahead of order.slice(index, index + READ_CONCURRENCY)) void open(ahead);
		const opened = await open(spreadsheetId);
		if (!opened.ok) {
			if (isDeferral(opened)) {
				stopped = true;
				stoppedFor = deferredBy(opened);
				defer(result, stoppedFor, work.candidates.length);
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
		reached += 1;

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
			else if (outcome === 'moved') defer(result, 'packet row moved', 1);
			else if (outcome !== 'unchanged') {
				// The next checkout would fail the same way; all of them wait.
				const waiting = work.candidates.length - i;
				if (isDeferral(outcome)) {
					stopped = true;
					stoppedFor = deferredBy(outcome);
					defer(result, stoppedFor, waiting);
				} else {
					failedHere = outcome.error;
					result.failed += waiting;
				}
				break;
			}
		}

		if (!failedHere && !stopped) {
			let walkIns: WalkInsOutcome;
			try {
				walkIns = await syncWalkIns(
					db,
					client,
					spreadsheetId,
					work.candidates,
					now,
					deadline,
					result.warnings,
					tab.walkIns,
				);
			} catch (err) {
				// As above: Google accepted, the ledger did not. Repeated next run.
				console.error(`${LOG} walk-in bookkeeping for ${spreadsheetId} failed:`, errText(err));
				walkIns = { filled: 0, cleared: 0, deferred: 0 };
			}
			result.walkInsFilled += walkIns.filled;
			result.walkInsCleared += walkIns.cleared;
			defer(result, 'walk-in row in use', walkIns.deferred);
			if (walkIns.failure) {
				const waiting = walkIns.waiting ?? 0;
				if (isDeferral(walkIns.failure)) {
					stopped = true;
					stoppedFor = deferredBy(walkIns.failure);
					defer(result, stoppedFor, waiting);
				} else {
					failedHere = walkIns.failure.error;
					result.failed += waiting;
				}
			}
		}

		if (failedHere) {
			fullReads.delete(spreadsheetId);
			await safely(
				() => recordFailure(db, spreadsheetId, failedHere!, now.toISOString()),
				'health',
			);
		} else if (!stopped) {
			if (scheduled) {
				fullReads.set(spreadsheetId, {
					at: openedAt.get(spreadsheetId)!,
					fingerprint: fingerprints.get(spreadsheetId)!,
				});
			}
			await safely(() => recordSuccess(db, spreadsheetId), 'health');
		} else {
			fullReads.delete(spreadsheetId);
		}
	}
	// Reads started ahead that the loop never reached: withdrawn, so one still
	// waiting for a slot in the quota is never sent. Each still resolves, as
	// OUT_OF_TIME, and nothing waits on it.
	ahead.abort();
	for (const pending of opening.values()) void pending.catch(() => undefined);

	if (unrouted > 0) {
		result.warnings.push(
			`${LOG} ${unrouted} checkout(s) match no spreadsheet rule and are waiting: ` +
				`${result.unroutedRegions.slice(0, 5).join(', ')}` +
				`${result.unroutedRegions.length > 5 ? `, +${result.unroutedRegions.length - 5} more` : ''}`,
		);
	}

	await safely(
		() =>
			announceFailures(
				db,
				channelId,
				labelFor,
				result.failed + result.unrouted,
				new Set(targets.map((t) => t.spreadsheetId)),
			),
		'alert',
	);

	if (result.deferred > 0) {
		console.warn(
			`${LOG} ${result.deferred} checkout(s) wait for the next run: ${describeDeferrals(result.deferredFor)}`,
		);
	}
	const walkIns = result.walkInsFilled + result.walkInsCleared;
	if (
		result.filled +
			result.updated +
			result.failed +
			result.assignmentsChanged +
			unrouted +
			walkIns >
		0
	) {
		console.log(
			`${LOG} packet tracker: filled=${result.filled} updated=${result.updated} ` +
				`failed=${result.failed} unrouted=${unrouted} assignments=${result.assignmentsChanged} ` +
				`walk-ins=+${result.walkInsFilled}/-${result.walkInsCleared} ` +
				`spreadsheets=${reached}/${order.length} unchanged=${unchanged.size}`,
		);
	}
	return result;
}

/**
 * Who the campaign's Packet Tracker says has this turf, read live.
 *
 * The claim path's double-check: the sync only reads the tracker every 15
 * minutes, and an organizer may have written a turf down since. Returns the
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
		turf: { turfId: number; regionName: string; printedListNumber: string | null };
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
			{ urgent: true },
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
				.where(eq(vanTurfs.turfId, turf.turfId))
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
