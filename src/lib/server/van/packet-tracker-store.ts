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
	isUnfilled,
	priorCells,
	normaliseListNumber,
	packetRows,
	sheetDoors,
	stillOurs,
	type ColumnLayout,
	type PacketCells,
	type PacketCheckout,
} from '../../van/packet-tracker.js';
import { matchSheetTarget, orderSheetTargets, type SheetTarget } from '../../van/sheet-routing.js';
import {
	COMPLETED_STATUS,
	DEFAULT_SHIFT_STARTS,
	WALK_IN_TAB_NAME,
	findOurWalkIn,
	findWalkInLayout,
	firstEmptyWalkInRow,
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
import { sheetBlocksClaim } from '../../van/turf-view.js';

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
	walkInsFilled: 0,
	walkInsCleared: 0,
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

/** The count columns are for `sheetBlocksClaim`: whether someone else's
 *  entry in the sheet is still an organizer's problem. */
type Candidate = PacketCheckout & {
	sheetState: string | null;
	walkInState: string | null;
	uncontactedDoors: number | null;
	savedListId: number | null;
	rosterSavedListId: number | null;
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
				uncontactedDoors: vanTurfs.uncontactedDoors,
				savedListId: vanTurfs.savedListId,
				rosterSavedListId: vanTurfs.rosterSavedListId,
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

/** How long a spreadsheet found without a Walk Ins tab is not asked again.
 *  Not every campaign sheet has one, and asking every run would spend a read
 *  of the minute's 60 for nothing; a tab added later is used within the hour. */
const NO_WALK_INS_MS = 60 * 60 * 1000;

const noWalkInsTab = new Map<string, number>();

/** How long a tab that refused a highlight is not asked again. A refusal that
 *  is not the quota or the clock — protected cells, most likely — will refuse
 *  the next one too, and each attempt spends a write of the minute's 60. */
const NO_HIGHLIGHT_MS = 60 * 60 * 1000;

const highlightRefused = new Map<string, number>();
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
			if (state.yellow && candidate.issuedListNumber) {
				return unhighlightFreed(
					client,
					tab,
					rowIndex,
					candidate.issuedListNumber,
					base,
					save,
					deadline,
				);
			}
			await save(base);
			return 'unchanged';
		}
		if (!isUnfilled(current, tab.layout)) {
			// Somebody has this packet. Theirs — but it is checked again every
			// run, and filled in if their entry is cleared while ours is live.
			// Said only where the sheet still blocks a claim. On turf with doors
			// known to be uncontacted it no longer does (sheetBlocksClaim), so a
			// name already there is expected, not an organizer's problem to chase.
			if (state.told !== 'taken' && sheetBlocksClaim(candidate)) {
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
	const samePacket =
		normaliseListNumber(fresh.value[tab.layout.columns['List Number']] ?? '') ===
		normaliseListNumber(candidate.issuedListNumber ?? '');
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
	listNumber: string,
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
	const samePacket =
		normaliseListNumber(fresh.value[tab.layout.columns['List Number']] ?? '') ===
		normaliseListNumber(listNumber);
	if (!samePacket) return 'moved';
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

/** How far down the tab the Shift Start Time drop-down is looked for. */
const DROPDOWN_SEARCH_ROWS = 20;

/**
 * The options of the tab's Shift Start Time drop-down, or the ones it had when
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
		columnIndex: layout.columns['Shift Start Time'],
		deadline,
	});
	if (!res.ok) {
		if (isDeferral(res)) return res;
		console.warn(
			`${LOG} could not read the Shift Start Time options in ${spreadsheetId}: ${res.status}`,
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

/**
 * Bring the spreadsheet's Walk Ins tab in line with its checkouts: add a row
 * for each new claim, mark it Completed when walked, clear it when given back
 * or lapsed.
 *
 * Reads the tab only when there is something to do. A spreadsheet without a
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
): Promise<WalkInsOutcome> {
	const outcome: WalkInsOutcome = { filled: 0, cleared: 0, deferred: 0 };
	const today = walkInDay(now.toISOString());
	// Yellow alone is not worth a read of the tab while it refuses highlights.
	const refusing = refusesHighlight(spreadsheetId, WALK_IN_TAB_NAME);
	const jobs = candidates.flatMap((candidate) => {
		const work = walkInWork(candidate, spreadsheetId, today);
		if (!work || (refusing && (work === 'paint' || work === 'unhighlight'))) return [];
		return [{ candidate, work }];
	});
	if (jobs.length === 0) return outcome;
	const missingSince = noWalkInsTab.get(spreadsheetId);
	if (missingSince !== undefined && Date.now() - missingSince < NO_WALK_INS_MS) return outcome;
	const fail = (failure: SheetFailure, waiting: number): WalkInsOutcome => ({
		...outcome,
		waiting,
		failure: walkInFailure(failure.error, failure.status),
	});

	const read = await client.readTab({ spreadsheetId, tabName: WALK_IN_TAB_NAME, deadline });
	if (!read.ok) {
		if (read.status === 404) {
			noWalkInsTab.set(spreadsheetId, Date.now());
			return outcome;
		}
		return fail(read, jobs.length);
	}
	const layout = findWalkInLayout(read.value);
	if (!layout) {
		return fail({ status: 0, error: 'it has no "Name" or "Shift Start Time" column' }, jobs.length);
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
				name: candidate.slackUserName,
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
					// Nothing of ours left to take back.
					await save(candidate.checkoutId, { spreadsheetId, rowIndex: null, name: null });
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
		if (ours.shift !== null) blanks.push(['Shift Start Time', '']);
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
	return outcome;
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
	let changed = 0;
	for (const turf of turfs) {
		const next = turf.printedListNumber
			? (assigned.get(normaliseListNumber(turf.printedListNumber)) ?? null)
			: null;
		if (next === turf.sheetAssignedTo) continue;
		await db
			.update(vanTurfs)
			.set({ sheetAssignedTo: next })
			.where(eq(vanTurfs.turfId, turf.turfId));
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
		turfId: number;
		regionName: string;
		printedListNumber: string | null;
		sheetAssignedTo: string | null;
	}>;
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
				);
			} catch (err) {
				// As above: Google accepted, the ledger did not. Repeated next run.
				console.error(`${LOG} walk-in bookkeeping for ${spreadsheetId} failed:`, errText(err));
				walkIns = { filled: 0, cleared: 0, deferred: 0 };
			}
			result.walkInsFilled += walkIns.filled;
			result.walkInsCleared += walkIns.cleared;
			result.deferred += walkIns.deferred;
			if (walkIns.failure) {
				const waiting = walkIns.waiting ?? 0;
				if (isDeferral(walkIns.failure)) {
					stopped = true;
					result.deferred += waiting;
				} else {
					failedHere = walkIns.failure.error;
					result.failed += waiting;
				}
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
			`${LOG} ${result.deferred} checkout(s) wait for the next run (quota, time, or a tab that changed mid-run)`,
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
				`walk-ins=+${result.walkInsFilled}/-${result.walkInsCleared}`,
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
