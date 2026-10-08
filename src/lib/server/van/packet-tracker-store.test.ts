import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	_resetLiveReadsForTests,
	liveAssignment,
	parseSheetState,
	syncPacketTracker,
} from './packet-tracker-store.js';
import { DEFAULT_SHEET_TAB_NAME, FILL_COLUMNS } from '../../van/packet-tracker.js';
import { WALK_IN_TAB_NAME } from '../../van/walk-ins.js';
import { normaliseSheetKey, type SheetTarget } from '../../van/sheet-routing.js';
import type { SheetsClient } from '../google/sheets.js';

// A real in-memory libsql, because the candidate query and the state column
// ARE the behaviour under test; and a fake spreadsheet laid out like the
// campaign's real Packet Tracker — header on row 2, packets listed in advance,
// formula columns among ours.

vi.mock('../slack.js', () => ({ postAlert: vi.fn(async () => true) }));
import { postAlert } from '../slack.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-09-19T18:00:00.000Z');
const LIST = '35536745-88712';
const HEADER = [
	'Packet Name',
	'Voters',
	'Doors',
	'List Number',
	'shift_key',
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Time Departed',
	'Walk Mode',
	'Phone Number',
	'Knocked #',
	'Status',
	'Today?',
	'Knocked %',
];
const col = (name: string) => HEADER.indexOf(name);

function target(prefix: string, label: string, spreadsheetId: string): SheetTarget {
	return { prefix, prefixKey: normaliseSheetKey(prefix), label, spreadsheetId };
}
const DOWNRIVER = target('R10C', 'R10C_Downriver CR', 'sheet-downriver');
const WESTERN = target('R10D', 'R10D_Western CR', 'sheet-western');

/** A packet row as the campaign lists it, with any canvasser cells given. */
function packet(list: string, over: Record<string, string> = {}): string[] {
	const listed: Record<string, string> = {
		'Packet Name': `Packet ${list}`,
		Voters: '120',
		Doors: '80',
		'List Number': list,
		shift_key: 'k',
		'Today?': 'FALSE',
		'Knocked %': '0%',
	};
	return HEADER.map((h) => listed[h] ?? over[h] ?? '');
}

const tracker = (...rows: string[][]) => [[], HEADER, ...rows];

function fakeSheets(initial: Record<string, string[][]> = {}) {
	const sheets = new Map<string, string[][]>();
	for (const [id, values] of Object.entries(initial))
		sheets.set(
			id,
			values.map((r) => [...r]),
		);
	const failing = new Map<string, { status: number; error: string }>();
	const calls: string[] = [];
	/** The Walk Ins tab's Shift Start Time drop-down. */
	let dropdown: Array<{ label: string; text: boolean }> | null = ['10am', '1pm', '4pm', '6pm'].map(
		(label) => ({ label, text: true }),
	);
	/** Highlighted cells, as `spreadsheetId:row:column`. */
	const yellow = new Set<string>();
	/** Runs once, after the run's read of a tab and before the re-check —
	 *  the window in which an organizer might sort the sheet. */
	let between: (() => void) | null = null;

	// The Packet Tracker is keyed by spreadsheet id, the Walk Ins tab by
	// `id/Walk Ins` (absent unless a test adds it), and its calls carry a
	// `walkins-` prefix so the Packet Tracker's call lists read as before.
	const key = (id: string, tabName: string) =>
		tabName === WALK_IN_TAB_NAME ? `${id}/${tabName}` : id;
	const prefix = (tabName: string) => (tabName === WALK_IN_TAB_NAME ? 'walkins-' : '');

	const api: SheetsClient = {
		async readTab({ spreadsheetId, tabName }) {
			calls.push(`${prefix(tabName)}read:${spreadsheetId}`);
			const fail = failing.get(`${prefix(tabName)}${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			const sheet = sheets.get(key(spreadsheetId, tabName));
			if (!sheet) return { ok: false, status: 404, error: 'no tab' };
			return { ok: true, value: sheet.map((r) => [...r]) };
		},
		async readRow({ spreadsheetId, tabName, rowIndex }) {
			const fn = between;
			between = null;
			fn?.();
			calls.push(`${prefix(tabName)}readRow:${spreadsheetId}:${rowIndex}`);
			return { ok: true, value: [...(sheets.get(key(spreadsheetId, tabName))![rowIndex] ?? [])] };
		},
		async writeCells({ spreadsheetId, tabName, rowIndex, cells }) {
			calls.push(`${prefix(tabName)}write:${spreadsheetId}:${rowIndex}`);
			const fail = failing.get(`${prefix(tabName)}write:${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			const sheet = sheets.get(key(spreadsheetId, tabName))!;
			while (sheet.length <= rowIndex) sheet.push([]);
			const row = sheet[rowIndex]!;
			// Displayed without Sheets' text-forcing apostrophe.
			for (const [c, value] of cells) row[c] = value.replace(/^'/, '');
			return { ok: true, value: true };
		},
		async highlightCells({ spreadsheetId, tabName, rowIndex, columns, on }) {
			calls.push(`${prefix(tabName)}highlight:${spreadsheetId}:${rowIndex}:${on ? 'on' : 'off'}`);
			const fail = failing.get(`${prefix(tabName)}highlight:${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			for (const c of columns) {
				const key = `${spreadsheetId}/${tabName}:${rowIndex}:${c}`;
				if (on) yellow.add(key);
				else yellow.delete(key);
			}
			return { ok: true, value: true };
		},
		async dropdownOptions({ spreadsheetId }) {
			calls.push(`walkins-options:${spreadsheetId}`);
			const fail = failing.get(`walkins-options:${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			return { ok: true, value: dropdown };
		},
		async ensureRows({ spreadsheetId, tabName, rowIndex }) {
			calls.push(`${prefix(tabName)}grow:${spreadsheetId}:${rowIndex}`);
			const fail = failing.get(`${prefix(tabName)}grow:${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			return { ok: true, value: true };
		},
		async describe() {
			return { ok: true, value: { title: '', hasTab: true, tabs: [] } };
		},
	};

	return {
		api,
		calls,
		failing,
		sheet: (id: string) => sheets.get(id)!,
		setDropdown(next: typeof dropdown) {
			dropdown = next;
		},
		/** Give the spreadsheet a Walk Ins tab. */
		walkIns(id: string, values: string[][]) {
			sheets.set(
				`${id}/${WALK_IN_TAB_NAME}`,
				values.map((r) => [...r]),
			);
		},
		walkInSheet: (id: string) => sheets.get(`${id}/${WALK_IN_TAB_NAME}`)!,
		/** Whether a Walk Ins row is highlighted, judged by its Name cell. */
		walkInYellow: (id: string, row: number) => yellow.has(`${id}/${WALK_IN_TAB_NAME}:${row}:0`),
		/** The packet's row, by column name, as the campaign sees it. */
		entry(id: string, list = LIST): Record<string, string> {
			const row = sheets.get(id)!.find((r) => r[col('List Number')] === list)!;
			return Object.fromEntries(HEADER.map((h, i) => [h, row[i] ?? '']));
		},
		between(fn: () => void) {
			between = fn;
		},
		/** The columns highlighted on the packet's row, by name. */
		highlighted(id: string, list = LIST): string[] {
			const row = sheets.get(id)!.findIndex((r) => r[col('List Number')] === list);
			return HEADER.filter((_, i) => yellow.has(`${id}/${DEFAULT_SHEET_TAB_NAME}:${row}:${i}`));
		},
	};
}

const writes = (calls: string[]) => calls.filter((c) => c.startsWith('write'));

async function turf(
	over: {
		turfId?: number;
		campaignId?: number;
		regionName?: string;
		name?: string;
		list?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, printed_list_number, route_size, door_count,
		         first_seen_at, last_seen_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', ?3, ?4, ?5, 120, 50, 'x', 'x')`,
		args: [
			over.turfId ?? 100,
			over.campaignId ?? 1,
			over.regionName ?? 'R10C_Wayne_TaylorCity004_9.11',
			over.name ?? 'Turf 01',
			over.list === undefined ? LIST : over.list,
		],
	});
}

/** A second campaign, as the sync would have registered it. */
async function partnerCampaign() {
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'partner', 'test', 'test', 'x')`,
	);
}

async function checkout(
	over: {
		id?: number;
		turfId?: number;
		list?: string;
		releasedAt?: string | null;
		completedAt?: string | null;
		reportedPercent?: number | null;
		sheetState?: string | null;
		claimedAt?: string;
		slackUserName?: string;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, reported_percent, issued_list_number,
		         claim_door_count, sheet_state)
		      VALUES (?, ?, 'U1', ?, ?, '2026-09-21T14:00:00.000Z',
		              ?, ?, ?, ?, 64, ?)`,
		args: [
			over.id ?? 1,
			over.turfId ?? 100,
			over.slackUserName ?? 'Dana',
			over.claimedAt ?? '2026-09-19T14:07:00.000Z',
			over.releasedAt ?? null,
			over.completedAt ?? null,
			over.reportedPercent ?? null,
			over.list ?? LIST,
			over.sheetState ?? null,
		],
	});
}

async function update(id: number, set: string) {
	await client.execute({ sql: `UPDATE van_turf_checkouts SET ${set} WHERE id = ?`, args: [id] });
}

async function stateOf(id: number) {
	const res = await client.execute({
		sql: 'SELECT sheet_state FROM van_turf_checkouts WHERE id = ?',
		args: [id],
	});
	return parseSheetState((res.rows[0]?.['sheet_state'] as string | null) ?? null);
}

async function assignedTo(turfId = 100) {
	const res = await client.execute({
		sql: 'SELECT sheet_assigned_to FROM van_turfs WHERE turf_id = ?',
		args: [turfId],
	});
	return (res.rows[0]?.['sheet_assigned_to'] as string | null) ?? null;
}

function run(api: SheetsClient, over: Partial<Parameters<typeof syncPacketTracker>[1]> = {}) {
	return syncPacketTracker(db, {
		now: NOW,
		client: api,
		campaignId: 1,
		targets: [DOWNRIVER],
		timeBudgetMs: 30_000,
		channelId: 'C_TURF',
		...over,
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.mocked(postAlert).mockClear();
	vi.mocked(postAlert).mockResolvedValue(true);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	_resetLiveReadsForTests();
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('a checkout through its life', () => {
	it('fills in the packet’s existing row on claim, and nothing else', async () => {
		await turf();
		await checkout();
		const before = tracker(packet('111-1', { Canvasser: 'Olu', Status: 'Out' }), packet(LIST));
		const fake = fakeSheets({ 'sheet-downriver': before });

		const result = await run(fake.api);

		expect(result.filled).toBe(1);
		expect(fake.entry('sheet-downriver')).toMatchObject({
			Canvasser: '*Dana',
			'Shift Time': '10:07 AM',
			'Date Sent Out': '09/19/2026',
			'Walk Mode': 'MiniVAN',
			Status: 'Unwalked',
			// The campaign's own cells, untouched.
			'Packet Name': `Packet ${LIST}`,
			'Phone Number': '',
			'Knocked %': '0%',
			'Today?': 'FALSE',
		});
		// No row added, and the other packet exactly as it was.
		expect(fake.sheet('sheet-downriver')).toHaveLength(4);
		expect(fake.sheet('sheet-downriver')[2]).toEqual(before[2]);
	});

	it('updates the same entry as the turf goes out and is walked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);
		expect(fake.entry('sheet-downriver')).toMatchObject({
			Status: 'Out',
			'Time Departed': '10:41 AM',
		});

		await update(1, "completed_at = '2026-09-19T17:00:00.000Z', reported_percent = 85");
		await run(fake.api);
		// From the packet's own Doors (80), so its Knocked % formula reads 85%.
		expect(fake.entry('sheet-downriver')).toMatchObject({
			Status: 'Incomplete',
			'Knocked #': '68',
			'Knocked %': '0%',
		});
	});

	it('does nothing when nothing changed', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		fake.calls.length = 0;

		const result = await run(fake.api);

		expect(result.filled + result.updated).toBe(0);
		expect(fake.calls).toEqual(['read:sheet-downriver']);
	});

	it('clears what it filled in when the turf is handed back unwalked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);

		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(packet(LIST));
		expect((await stateOf(1))?.cells).toBeNull();
	});

	// Seen live 2026-09-25: the campaign marks a free packet Unwalked, and
	// the first version treated that as someone else's entry.
	it('fills in a packet showing the campaign’s Unwalked default, and restores it on hand-back', async () => {
		await turf();
		await checkout();
		const listed = packet(LIST, { Status: 'Unwalked' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(listed) });

		expect((await run(fake.api)).filled).toBe(1);
		expect(fake.entry('sheet-downriver')).toMatchObject({ Canvasser: '*Dana', Status: 'Unwalked' });
		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);
		expect(fake.entry('sheet-downriver').Status).toBe('Out');

		// Handed back after loading: the row goes back to the campaign's default.
		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(listed);
	});

	it('leaves a hand-back cleared when a MiniVAN load turns up after it', async () => {
		await turf();
		await checkout();
		const listed = packet(LIST);
		const fake = fakeSheets({ 'sheet-downriver': tracker(listed) });
		await run(fake.api);
		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		await run(fake.api);

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(listed);
	});

	it('highlights the cells it fills in, and only those', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		expect(fake.highlighted('sheet-downriver')).toEqual(expect.arrayContaining([...FILL_COLUMNS]));
		expect(fake.highlighted('sheet-downriver')).toHaveLength(FILL_COLUMNS.length);
	});

	it('takes the highlight off with the entry on a give-back', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		await run(fake.api);
		expect(fake.highlighted('sheet-downriver')).toEqual([]);
	});

	it('writes nothing when the highlight fails, and fills it in next run', async () => {
		await turf();
		await checkout();
		const listed = packet(LIST);
		const fake = fakeSheets({ 'sheet-downriver': tracker(listed) });
		fake.failing.set('highlight:sheet-downriver', { status: 429, error: 'quota' });
		await run(fake.api);
		expect(fake.sheet('sheet-downriver')[2]).toEqual(listed);

		fake.failing.delete('highlight:sheet-downriver');
		expect((await run(fake.api)).filled).toBe(1);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('*Dana');
	});

	it('clears a lapsed claim once its doors are counted at zero', async () => {
		await turf();
		await checkout();
		const listed = packet(LIST);
		const fake = fakeSheets({ 'sheet-downriver': tracker(listed) });
		await run(fake.api);
		await update(
			1,
			"loaded_in_minivan_at = '2026-09-19T14:41:00.000Z', " +
				"released_at = '2026-09-19T20:00:00.000Z', release_reason = 'expired'",
		);
		// Not counted yet: loaded, so it stays.
		await run(fake.api);
		expect(fake.entry('sheet-downriver').Status).toBe('Incomplete');

		await update(1, 'doors_knocked = 0');
		await run(fake.api);
		expect(fake.sheet('sheet-downriver')[2]).toEqual(listed);
	});

	it('keeps a lapsed claim that knocked doors, with what it knocked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		await update(
			1,
			"released_at = '2026-09-19T20:00:00.000Z', release_reason = 'expired', doors_knocked = 12",
		);
		await run(fake.api);
		expect(fake.entry('sheet-downriver')).toMatchObject({
			Canvasser: '*Dana',
			Status: 'Incomplete',
			'Knocked #': '12',
		});
	});

	it('never touches the sheet for a claim handed back before any run saw it', async () => {
		await turf();
		await checkout({ releasedAt: '2026-09-19T15:00:00.000Z' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });

		await run(fake.api);

		expect(writes(fake.calls)).toEqual([]);
	});
});

describe('the campaign’s entries are never overwritten', () => {
	/** Give turf 100 a current uncontacted count, so the sheet stops blocking. */
	async function withDoorsLeft(uncontacted: number) {
		await client.execute({
			sql: `UPDATE van_turfs SET saved_list_id = 900, roster_saved_list_id = 900,
			        uncontacted_doors = ? WHERE turf_id = 100`,
			args: [uncontacted],
		});
	}

	// Silent where doors are known to be left: the filled row no longer blocks
	// claiming that turf, so this is expected rather than something for an
	// organizer to chase.
	it('leaves a packet someone else has filled in, without a warning, on turf with doors left', async () => {
		await turf();
		await withDoorsLeft(12);
		await checkout();
		const theirs = packet(LIST, { Canvasser: 'Sam', Status: 'Incomplete', 'Walk Mode': 'Paper' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(theirs) });

		const first = await run(fake.api);
		const second = await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(theirs);
		expect(writes(fake.calls)).toEqual([]);
		expect(first.warnings).toEqual([]);
		expect(second.warnings).toEqual([]);
	});

	// With no count the sheet still blocks claims, so a claim that collided
	// with an entry is worth one warning — and only one.
	it('warns once about someone else’s entry where the sheet still blocks', async () => {
		await turf();
		await checkout();
		const theirs = packet(LIST, { Canvasser: 'Sam', Status: 'Incomplete', 'Walk Mode': 'Paper' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(theirs) });

		const first = await run(fake.api);
		const second = await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(theirs);
		expect(writes(fake.calls)).toEqual([]);
		expect(first.warnings).toEqual([expect.stringContaining("someone else's entry")]);
		expect(second.warnings).toEqual([]);
	});

	it('fills in a packet once someone else’s entry is cleared', async () => {
		await turf();
		await withDoorsLeft(12);
		await checkout();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Sam', Status: 'Incomplete' })),
		});
		const first = await run(fake.api);
		expect(first).toMatchObject({ filled: 0, warnings: [] });

		fake.sheet('sheet-downriver')[2] = packet(LIST, { Status: 'Unwalked' });
		const second = await run(fake.api);

		expect(second).toMatchObject({ filled: 1, warnings: [] });
		expect(fake.entry('sheet-downriver').Canvasser).toBe('*Dana');
	});

	// Entries written before the app marked its names keep their plain name:
	// still ours, and the Canvasser cell is never rewritten to add the mark.
	it('keeps managing an entry written before names were marked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		fake.sheet('sheet-downriver')[2]![col('Canvasser')] = 'Dana';
		await update(1, "sheet_state = REPLACE(sheet_state, '*Dana', 'Dana')");

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		const out = await run(fake.api);
		expect(out.warnings).toEqual([]);
		expect(fake.entry('sheet-downriver')).toMatchObject({ Canvasser: 'Dana', Status: 'Out' });

		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		const back = await run(fake.api);
		expect(back.warnings).toEqual([]);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		expect((await stateOf(1))?.gone).toBeUndefined();
	});

	it('stops managing an entry once someone types another canvasser over it', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		fake.sheet('sheet-downriver')[2]![col('Canvasser')] = 'Sam';

		await update(1, "released_at = '2026-09-19T15:00:00.000Z'");
		const result = await run(fake.api);

		expect(fake.entry('sheet-downriver').Canvasser).toBe('Sam');
		expect(fake.entry('sheet-downriver').Status).toBe('Unwalked');
		expect(result.warnings.join(' ')).toContain('changed by hand');
		expect((await stateOf(1))?.gone).toBe(true);
	});

	// Writes go by row number. If the tab was sorted after the run read it,
	// that row is another packet now, and the re-check catches it.
	it('does not write when the row has become another packet since the read', async () => {
		await turf();
		await checkout();
		const other = packet('222-2');
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), other) });
		fake.between(() => {
			const sheet = fake.sheet('sheet-downriver');
			[sheet[2], sheet[3]] = [sheet[3]!, sheet[2]!];
		});

		const result = await run(fake.api);

		expect(result).toMatchObject({ filled: 0, deferred: 1 });
		expect(writes(fake.calls)).toEqual([]);
		expect(fake.sheet('sheet-downriver')[2]).toEqual(other);
		// Picked up next run, at the packet's new row.
		await run(fake.api);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('*Dana');
		expect(fake.sheet('sheet-downriver')[2]).toEqual(other);
	});

	it('does not fill in a packet someone claimed since the read', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.between(() => {
			fake.sheet('sheet-downriver')[2]![col('Canvasser')] = 'Sam';
		});

		await run(fake.api);

		expect(writes(fake.calls)).toEqual([]);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('Sam');
	});
});

describe('packets the tracker does not list', () => {
	it('tells the turf channel once, and fills it in when an organizer adds it', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet('111-1')) });

		const first = await run(fake.api);
		const second = await run(fake.api);

		expect(first.warnings.join(' ')).toContain('does not list that packet');
		// The turf, never the list number: that is a credential.
		expect(first.warnings.join(' ')).not.toContain(LIST);
		expect(second.warnings).toEqual([]);

		fake.sheet('sheet-downriver').push(packet(LIST));
		const third = await run(fake.api);
		expect(third.filled).toBe(1);
	});

	it('writes to neither row when the packet is listed twice', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), packet(LIST)) });

		const result = await run(fake.api);

		expect(writes(fake.calls)).toEqual([]);
		expect(result.warnings.join(' ')).toContain('more than once');
	});
});

describe('the campaign’s own assignments', () => {
	it('records who the tracker says has a turf, by list number', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Organizer Olu', Status: 'Out' })),
		});

		const result = await run(fake.api);

		expect(result.assignmentsChanged).toBe(1);
		expect(await assignedTo()).toBe('Organizer Olu');
	});

	it('clears it when the entry goes Incomplete', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Olu', Status: 'Out' })),
		});
		await run(fake.api);
		fake.sheet('sheet-downriver')[2]![col('Status')] = 'Incomplete';

		await run(fake.api);

		expect(await assignedTo()).toBeNull();
	});

	it('does not count our own entries as the campaign’s', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });

		await run(fake.api);
		await run(fake.api);

		expect(await assignedTo()).toBeNull();
	});

	it('keeps the last known assignment when the spreadsheet cannot be read', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Olu', Status: 'Out' })),
		});
		await run(fake.api);
		fake.failing.set('sheet-downriver', { status: 403, error: 'no permission' });

		await run(fake.api);

		expect(await assignedTo()).toBe('Olu');
	});

	const liveFor = (api: SheetsClient) =>
		liveAssignment(db, {
			client: api,
			targets: [DOWNRIVER],
			turf: {
				turfId: 100,
				regionName: 'R10C_Wayne_TaylorCity004_9.11',
				printedListNumber: LIST,
			},
			timeBudgetMs: 6_000,
		});

	it('reads it live for a claim, and reuses a read from the last minute', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Olu', Status: 'Unwalked' })),
		});

		expect(await liveFor(fake.api)).toBe('Olu');
		expect(await liveFor(fake.api)).toBe('Olu');

		expect(fake.calls.filter((c) => c.startsWith('read'))).toHaveLength(1);
		expect(await assignedTo()).toBe('Olu');
	});

	it('says "could not tell" rather than "free" when the live read fails', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.failing.set('sheet-downriver', { status: 500, error: 'backend error' });

		expect(await liveFor(fake.api)).toBeUndefined();
	});
});

describe('Google’s 60-a-minute quota and the run’s time', () => {
	it('reads each spreadsheet once, plus the re-check before a write', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });

		await run(fake.api);

		expect(fake.calls).toEqual([
			'read:sheet-downriver',
			'readRow:sheet-downriver:2',
			// A write too, against the per-minute write quota, not the reads.
			'highlight:sheet-downriver:2:on',
			'write:sheet-downriver:2',
			// Looking for a Walk Ins tab: this sheet has none, which is
			// remembered for an hour rather than asked every run.
			'walkins-read:sheet-downriver',
		]);
	});

	it.each([
		[429, 'Quota exceeded'],
		[408, 'no time left in the run for this request'],
	])('waits out a %i quietly: no alert, retried next run', async (status, error) => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.failing.set('sheet-downriver', { status, error });

		const first = await run(fake.api);

		expect(first).toMatchObject({ deferred: 1, failed: 0 });
		expect(postAlert).not.toHaveBeenCalled();
		fake.failing.delete('sheet-downriver');
		expect((await run(fake.api)).filled).toBe(1);
	});

	it('stops calling Google once the quota is spent', async () => {
		await turf({ turfId: 100 });
		await turf({ turfId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, turfId: 100 });
		await checkout({ id: 2, turfId: 101, list: '2-2' });
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST)),
			'sheet-western': tracker(packet('2-2')),
		});
		fake.failing.set('write:sheet-downriver', { status: 429, error: 'Quota exceeded' });
		fake.failing.set('write:sheet-western', { status: 429, error: 'Quota exceeded' });

		const result = await run(fake.api, { targets: [DOWNRIVER, WESTERN] });

		expect(result.deferred).toBe(2);
		expect(writes(fake.calls)).toHaveLength(1);
	});

	// If the read-only sheet went first and hit the quota, the stop would come
	// before the write. The order is shuffled, so this is run several times.
	it('writes the spreadsheets with work before the ones only read for assignments', async () => {
		await turf({ turfId: 100 });
		await turf({ turfId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 2, turfId: 101, list: '2-2' });

		for (let i = 0; i < 8; i++) {
			await update(2, 'sheet_state = NULL');
			const fake = fakeSheets({
				'sheet-downriver': tracker(packet(LIST)),
				'sheet-western': tracker(packet('2-2')),
			});
			fake.failing.set('sheet-downriver', { status: 429, error: 'Quota exceeded' });

			const result = await run(fake.api, { targets: [DOWNRIVER, WESTERN] });

			expect(result.filled).toBe(1);
		}
	});
});

describe('alerts', () => {
	it('alerts once, with every spreadsheet failing the same way in one message', async () => {
		await turf({ turfId: 100 });
		await turf({ turfId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, turfId: 100 });
		await checkout({ id: 2, turfId: 101, list: '2-2' });
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST)),
			'sheet-western': tracker(packet('2-2')),
		});
		const protectedError = 'You are trying to edit a protected cell or object.';
		fake.failing.set('write:sheet-downriver', { status: 400, error: protectedError });
		fake.failing.set('write:sheet-western', { status: 400, error: protectedError });

		await run(fake.api, { targets: [DOWNRIVER, WESTERN] });
		await run(fake.api, { targets: [DOWNRIVER, WESTERN] });

		expect(postAlert).toHaveBeenCalledTimes(1);
		const text = vi.mocked(postAlert).mock.calls[0]![1];
		expect(text).toContain('R10C_Downriver CR');
		expect(text).toContain('R10D_Western CR');
		expect(await stateOf(1)).toBeNull();
	});

	it('refuses a tab missing a column rather than guessing where cells go', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({
			'sheet-downriver': [[], HEADER.filter((h) => h !== 'Status'), packet(LIST)],
		});

		const result = await run(fake.api);

		expect(result.failed).toBe(1);
		expect(writes(fake.calls)).toEqual([]);
		expect(vi.mocked(postAlert).mock.calls[0]?.[1]).toContain('"Status"');
	});
});

describe('backfill and scope', () => {
	it('fills in live and walked checkouts and skips released ones the migration stamped', async () => {
		await turf({ turfId: 100 });
		await turf({ turfId: 101, name: 'Turf 02', list: '2-2' });
		await turf({ turfId: 102, name: 'Turf 03', list: '3-3' });
		await checkout({ id: 1, turfId: 100 });
		await checkout({
			id: 2,
			turfId: 101,
			list: '2-2',
			completedAt: '2026-09-01T17:00:00.000Z',
			reportedPercent: 100,
		});
		await checkout({
			id: 3,
			turfId: 102,
			list: '3-3',
			releasedAt: '2026-09-01T15:00:00.000Z',
			sheetState: '{"spreadsheetId":null,"cells":null}',
		});
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST), packet('2-2'), packet('3-3')),
		});

		const result = await run(fake.api);

		expect(result.filled).toBe(2);
		expect(fake.entry('sheet-downriver', '2-2')).toMatchObject({ Status: 'Complete' });
		expect(fake.entry('sheet-downriver', '3-3').Canvasser).toBe('');
	});

	it('limits a nudge to the one turf', async () => {
		await turf({ turfId: 100 });
		await turf({ turfId: 101, name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, turfId: 100 });
		await checkout({ id: 2, turfId: 101, list: '2-2' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), packet('2-2')) });

		await run(fake.api, { onlyTurfId: 101 });

		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		expect(fake.entry('sheet-downriver', '2-2').Canvasser).toBe('*Dana');
	});
});

// Each campaign has its own spreadsheets and its own rules
// (specs/012-multi-van-campaigns). Region names are each campaign's own too,
// so two campaigns can both cut an "R10C_…" region.
describe('one campaign at a time', () => {
	const PARTNER = target('R10C', 'Partner R10C', 'sheet-partner');

	beforeEach(async () => {
		await partnerCampaign();
		await turf({ turfId: 100 });
		await turf({ turfId: 200, campaignId: 2, regionName: 'R10C_Wayne_Partner', list: '9-9' });
		await checkout({ id: 1, turfId: 100 });
		await checkout({ id: 2, turfId: 200, list: '9-9' });
	});

	it('never writes another campaign’s checkout, even where its rules would match', async () => {
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), packet('9-9')) });

		const result = await run(fake.api);

		expect(result.filled).toBe(1);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('*Dana');
		expect(fake.entry('sheet-downriver', '9-9').Canvasser).toBe('');
		expect(await stateOf(2)).toBeNull();
		expect(result.unrouted).toBe(0);
	});

	it('routes a campaign’s checkouts by its own rules only', async () => {
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST)),
			'sheet-partner': tracker(packet('9-9')),
		});

		await run(fake.api, { campaignId: 2, targets: [PARTNER] });

		expect(fake.entry('sheet-partner', '9-9').Canvasser).toBe('*Dana');
		expect(fake.calls.some((c) => c.includes('sheet-downriver'))).toBe(false);
		expect(await stateOf(1)).toBeNull();
	});

	it('counts only its own checkouts as unrouted', async () => {
		const fake = fakeSheets({ 'sheet-western': tracker() });

		const result = await run(fake.api, { campaignId: 2, targets: [WESTERN] });

		expect(result.unrouted).toBe(1);
		expect(result.unroutedRegions).toEqual(['R10C_Wayne_Partner']);
	});

	it('records assignments only on its own turf, even for a list number both use', async () => {
		await client.execute(
			`UPDATE van_turfs SET printed_list_number = '${LIST}' WHERE turf_id = 200`,
		);
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Organizer Olu', Status: 'Out' })),
		});

		await run(fake.api);

		expect(await assignedTo(100)).toBe('Organizer Olu');
		expect(await assignedTo(200)).toBeNull();
	});
});

describe('parseSheetState', () => {
	it('reads cells saved under the old Doors Knocked name as Knocked #', () => {
		const state = parseSheetState(
			JSON.stringify({
				spreadsheetId: 'sheet-downriver',
				cells: { Canvasser: 'Dana', Status: 'Complete', 'Doors Knocked': '64' },
				prior: { Status: 'Unwalked' },
			}),
		);
		expect(state?.cells).toEqual({ Canvasser: 'Dana', Status: 'Complete', 'Knocked #': '64' });
		expect(state?.prior).toEqual({ Status: 'Unwalked' });
	});
});

describe('the Walk Ins tab', () => {
	const WALK_IN_HEADER = [
		'Name',
		'Shift Start Time',
		'Phone',
		'Email',
		'Zip Code',
		'Notes',
		'Final Status',
		'In VAN?',
		'Reshifted?',
	];
	/** A walk-in the campaign wrote itself. */
	const theirs = (name: string) => [name, '9:00 AM', '313-555-0100'];
	const GIVEN_BACK = "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'";

	async function walkInState(id = 1) {
		const res = await client.execute({
			sql: 'SELECT walk_in_state FROM van_turf_checkouts WHERE id = ?',
			args: [id],
		});
		const raw = res.rows[0]?.['walk_in_state'] as string | null;
		return raw ? JSON.parse(raw) : null;
	}

	async function withWalkIns(...rows: string[][]) {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.walkIns('sheet-downriver', [WALK_IN_HEADER, ...rows]);
		return fake;
	}

	it('fills in the first empty row with Name and shift, highlighted', async () => {
		const fake = await withWalkIns(theirs('Ari'), [], theirs('Bo'));
		await checkout();

		const result = await run(fake.api);

		expect(result.walkInsFilled).toBe(1);
		// The gap between the campaign's rows, not the bottom.
		// 10:07 falls in the 10am shift, picked from the drop-down.
		expect(fake.walkInSheet('sheet-downriver')[2]).toEqual(['*Dana', '10am']);
		expect(fake.walkInYellow('sheet-downriver', 2)).toBe(true);
		expect(await walkInState()).toMatchObject({
			rowIndex: 2,
			name: '*Dana',
			shift: '10am',
			day: '2026-09-19',
		});
	});

	it('gives two claims in one run two rows', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713', slackUserName: 'Eli' });

		await run(fake.api);

		const names = fake.walkInSheet('sheet-downriver').map((r) => r[0]);
		expect(names).toEqual(['Name', 'Ari', '*Dana', '*Eli']);
	});

	it('clears its own row on a give-back, and only that row', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await run(fake.api);
		fake.walkInSheet('sheet-downriver').push(theirs('Bo'));

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(result.walkInsCleared).toBe(1);
		const sheet = fake.walkInSheet('sheet-downriver');
		expect(sheet[2]!.slice(0, 2)).toEqual(['', '']);
		expect(sheet[3]).toEqual(theirs('Bo'));
		expect(fake.walkInYellow('sheet-downriver', 2)).toBe(false);
	});

	// A row written before the app marked its names is still found by its
	// plain name, and cleared.
	it('clears a row written before names were marked', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await run(fake.api);
		fake.walkInSheet('sheet-downriver')[2]![0] = 'Dana';
		await update(1, "walk_in_state = REPLACE(walk_in_state, '*Dana', 'Dana')");

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(result.walkInsCleared).toBe(1);
		expect(result.warnings).toEqual([]);
		expect(fake.walkInSheet('sheet-downriver')[2]![0]).toBe('');
		expect(fake.walkInSheet('sheet-downriver')[1]).toEqual(theirs('Ari'));
	});

	it('clears on expiry only once no doors were knocked', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);

		await update(
			1,
			"released_at = '2026-09-19T17:00:00.000Z', release_reason = 'expired', doors_knocked = 4",
		);
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('*Dana');

		await update(1, 'doors_knocked = 0');
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('');
	});

	it('does not add a walk-in for a claim from an earlier day', async () => {
		const fake = await withWalkIns();
		await checkout({ claimedAt: '2026-09-18T20:00:00.000Z' });

		await run(fake.api);

		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);
	});

	it('does not add a walk-in once the claim has ended', async () => {
		const fake = await withWalkIns();
		await checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 100 });

		await run(fake.api);

		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);
	});

	// The campaign empties the tab daily, so yesterday's row number is today
	// somebody else's walk-in — even one with the same name.
	it('leaves a row from an earlier day alone', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');

		await update(1, GIVEN_BACK);
		await run(fake.api, { now: new Date('2026-09-20T15:00:00.000Z') });

		expect(sheet[1]![0]).toBe('*Dana');
	});

	it('leaves a row someone has written over, and says so once', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		fake.walkInSheet('sheet-downriver')[1]![0] = 'Frankie';

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);
		await run(fake.api);

		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('Frankie');
		expect(result.warnings.some((w) => w.includes('Walk Ins'))).toBe(true);
		expect(await walkInState()).toMatchObject({ gone: true });
	});

	it('waits for the next run when its row is taken between the read and the write', async () => {
		const fake = await withWalkIns();
		await checkout();
		// Someone writes in the row just before the Walk Ins re-check.
		const realReadRow = fake.api.readRow;
		fake.api.readRow = async (input) => {
			if (input.tabName === WALK_IN_TAB_NAME) {
				fake.walkInSheet('sheet-downriver').push(theirs('Gus'));
				fake.api.readRow = realReadRow;
			}
			return realReadRow(input);
		};

		const result = await run(fake.api);

		expect(result.walkInsFilled).toBe(0);
		expect(fake.walkInSheet('sheet-downriver')[1]).toEqual(theirs('Gus'));
		expect(await walkInState()).toBeNull();
	});

	it('writes nothing when the highlight fails, and fills it in next run', async () => {
		const fake = await withWalkIns();
		await checkout();
		fake.failing.set('walkins-highlight:sheet-downriver', { status: 429, error: 'quota' });

		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);

		fake.failing.delete('walkins-highlight:sheet-downriver');
		expect((await run(fake.api)).walkInsFilled).toBe(1);
	});

	it('falls back to the known shifts when the column has no drop-down', async () => {
		const fake = await withWalkIns();
		fake.setDropdown(null);
		await checkout({ claimedAt: '2026-09-19T17:30:00.000Z' }); // 1:30 PM
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]).toEqual(['*Dana', '1pm']);
	});

	it('writes a shift the drop-down holds as a real time as typed, not forced to text', async () => {
		const fake = await withWalkIns();
		fake.setDropdown([
			{ label: '10:00 AM', text: false },
			{ label: '1:00 PM', text: false },
		]);
		const raw: Array<[number, string]>[] = [];
		const write = fake.api.writeCells;
		fake.api.writeCells = async (input) => {
			if (input.tabName === WALK_IN_TAB_NAME) raw.push([...input.cells] as Array<[number, string]>);
			return write(input);
		};
		await checkout();
		await run(fake.api);
		expect(raw[0]).toEqual([
			[0, "'*Dana"],
			[1, '10:00 AM'],
		]);
	});

	it('marks its row Completed when the turf is walked', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);

		await update(1, "completed_at = '2026-09-19T17:00:00.000Z', reported_percent = 100");
		await run(fake.api);
		await run(fake.api);

		const row = fake.walkInSheet('sheet-downriver')[1]!;
		expect(row[0]).toBe('*Dana');
		expect(row[6]).toBe('Completed');
		expect(await walkInState()).toMatchObject({ status: 'Completed' });
	});

	it('clears only what it wrote, leaving a status the campaign picked', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		const row = fake.walkInSheet('sheet-downriver')[1]!;
		row[5] = 'changed her mind';
		row[6] = 'Declined';

		await update(1, GIVEN_BACK);
		await run(fake.api);

		expect(row.slice(0, 7)).toEqual([
			'',
			'',
			undefined,
			undefined,
			undefined,
			'changed her mind',
			'Declined',
		]);
	});

	// The campaign deleted a row above ours: ours moved up one.
	it('finds its row again after the rows above it change', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		sheet.splice(1, 1);
		sheet.push(theirs('Bo'));

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(result.walkInsCleared).toBe(1);
		expect(sheet[1]!.slice(0, 2)).toEqual(['', '']);
		expect(sheet[2]).toEqual(theirs('Bo'));
		expect(result.warnings).toEqual([]);
	});

	// The known limit: two rows reading "Dana / 10am" cannot be told apart.
	// The row at its recorded place is taken, which leaves one Dana row — the
	// right count, though not necessarily the row staff wrote.
	it('takes an identical row at its recorded place, rather than guessing elsewhere', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		// Ari's row deleted, and staff wrote Dana in again for the same shift.
		sheet.splice(1, 1);
		sheet.push(['*Dana', '10am']);
		sheet.push(['Cy']);

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(sheet.map((r) => r[0])).toEqual(['Name', '*Dana', '', 'Cy']);
		expect(result.warnings).toEqual([]);
	});

	it('refuses to guess when its row moved and two others could be it', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		// Our row moved down three, Cy is where it was, and staff wrote Dana
		// in for the same shift.
		sheet.splice(1, 0, ['Bo'], ['Cy'], ['*Dana', '10am']);

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(sheet.map((r) => r[0])).toEqual(['Name', 'Bo', 'Cy', '*Dana', 'Ari', '*Dana']);
		expect(result.warnings.some((w) => w.includes('Walk Ins'))).toBe(true);
		expect(await walkInState()).toMatchObject({ gone: true });
	});

	// Two turfs claimed back to back are two identical rows; the nudge after
	// giving one back loads only that turf.
	it('clears the right row from the nudge when the same volunteer has two', async () => {
		const fake = await withWalkIns();
		await checkout();
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713' });
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		expect(sheet.map((r) => r[0])).toEqual(['Name', '*Dana', '*Dana']);

		await update(1, GIVEN_BACK);
		const result = await run(fake.api, { onlyTurfId: 100 });

		expect(sheet.map((r) => r[0])).toEqual(['Name', '', '*Dana']);
		expect(result.warnings).toEqual([]);
		expect(await walkInState(2)).toMatchObject({ rowIndex: 2 });
	});

	// Ari's row deleted above both of Dana's: every recorded number is off by one.
	it('clears both identical rows, and nobody else’s, after rows above them go', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713' });
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		sheet.splice(1, 1);
		sheet.push(theirs('Bo'));

		await update(2, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		const first = await run(fake.api, { onlyTurfId: 101 });
		await update(1, GIVEN_BACK);
		const second = await run(fake.api, { onlyTurfId: 100 });

		expect(sheet.map((r) => r[0])).toEqual(['Name', '', '', 'Bo']);
		expect([...first.warnings, ...second.warnings]).toEqual([]);
	});

	it('leaves a Final Status the campaign already picked', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		const row = fake.walkInSheet('sheet-downriver')[1]!;
		row[6] = 'No Show';

		await update(1, "completed_at = '2026-09-19T17:00:00.000Z', reported_percent = 100");
		await run(fake.api);
		await run(fake.api);

		expect(row[6]).toBe('No Show');
		expect(await walkInState()).toMatchObject({ statusDone: true });
		expect(await walkInState()).not.toHaveProperty('status');
	});

	it('adds rows when the tab is full, before writing past its end', async () => {
		const fake = await withWalkIns(theirs('Ari'));
		await checkout();

		await run(fake.api);

		expect(fake.calls).toContain('walkins-grow:sheet-downriver:2');
		expect(fake.walkInSheet('sheet-downriver')[2]![0]).toBe('*Dana');
	});

	it('tries again to take the yellow off a cleared row', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		fake.failing.set('walkins-highlight:sheet-downriver', { status: 400, error: 'protected' });

		await update(1, GIVEN_BACK);
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('');
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(true);
		expect(await walkInState()).toMatchObject({ yellowRow: 1 });

		fake.failing.delete('walkins-highlight:sheet-downriver');
		// The refusal is remembered for an hour; an hour on, it is asked again.
		await run(fake.api);
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(true);
		_resetLiveReadsForTests();
		await run(fake.api);
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(false);
		expect(await walkInState()).not.toHaveProperty('yellowRow');
	});

	it('tries again to take the yellow off a cleared packet, while it is free', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		fake.failing.set('highlight:sheet-downriver', { status: 400, error: 'protected' });

		await update(1, GIVEN_BACK);
		await run(fake.api);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		expect(fake.highlighted('sheet-downriver')).not.toEqual([]);
		expect(await stateOf(1)).toMatchObject({ yellow: true });

		fake.failing.delete('highlight:sheet-downriver');
		_resetLiveReadsForTests(); // an hour on
		await run(fake.api);
		expect(fake.highlighted('sheet-downriver')).toEqual([]);
		expect(await stateOf(1)).not.toHaveProperty('yellow');
	});

	it('forgets its row quietly when the campaign has already emptied it', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		fake.walkInSheet('sheet-downriver').splice(1);

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(result.warnings).toEqual([]);
		expect(await walkInState()).toMatchObject({ rowIndex: null });
	});

	// 11pm claim, given back at 12:30am: still that night's walk-in.
	it('clears a row given back just after midnight', async () => {
		const fake = await withWalkIns();
		await checkout({ claimedAt: '2026-09-20T03:00:00.000Z' });
		await run(fake.api, { now: new Date('2026-09-20T03:05:00.000Z') });
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('*Dana');

		await update(1, "released_at = '2026-09-20T04:30:00.000Z', release_reason = 'volunteer'");
		await run(fake.api, { now: new Date('2026-09-20T04:35:00.000Z') });

		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('');
	});

	it('does not hold up the next walk-in when one row is taken mid-run', async () => {
		const fake = await withWalkIns();
		await checkout();
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713', slackUserName: 'Eli' });
		const realReadRow = fake.api.readRow;
		fake.api.readRow = async (input) => {
			if (input.tabName === WALK_IN_TAB_NAME) {
				fake.walkInSheet('sheet-downriver').push(theirs('Gus'));
				fake.api.readRow = realReadRow;
			}
			return realReadRow(input);
		};

		const result = await run(fake.api);

		expect(result.walkInsFilled).toBe(1);
		expect(fake.walkInSheet('sheet-downriver').map((r) => r[0])).toEqual(['Name', 'Gus', '*Eli']);
	});

	it('still writes when the highlight is refused for good', async () => {
		const fake = await withWalkIns();
		fake.failing.set('walkins-highlight:sheet-downriver', { status: 400, error: 'protected' });
		fake.failing.set('highlight:sheet-downriver', { status: 400, error: 'protected' });
		await checkout();

		const result = await run(fake.api);

		expect(result.filled).toBe(1);
		expect(result.walkInsFilled).toBe(1);
	});

	it('takes the yellow back off when the write fails after it', async () => {
		const fake = await withWalkIns();
		fake.failing.set('walkins-write:sheet-downriver', { status: 500, error: 'backend' });
		await checkout();

		await run(fake.api);

		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(false);
	});

	it('alerts a Walk Ins problem as one, counting what waits', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.walkIns('sheet-downriver', [['Who', 'When']]);
		await checkout();

		const result = await run(fake.api);

		expect(result.filled).toBe(1);
		expect(result.failed).toBe(1);
		const [, text] = vi.mocked(postAlert).mock.calls.at(-1)!;
		expect(text).toContain('Walk Ins tab: it has no "Name" or "Shift Start Time" column');
		expect(text).toContain('1 checkout(s) are waiting');
	});

	it('adds the row from the nudge after a claim, for that turf only', async () => {
		const fake = await withWalkIns();
		await checkout();
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713', slackUserName: 'Eli' });

		await run(fake.api, { onlyTurfId: 101 });

		expect(fake.walkInSheet('sheet-downriver').map((r) => r[0])).toEqual(['Name', '*Eli']);
	});

	it('adds no walk-in when the Packet Tracker cannot be read', async () => {
		const fake = await withWalkIns();
		fake.failing.set('sheet-downriver', { status: 500, error: 'backend' });
		await checkout();

		await run(fake.api);

		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);
	});

	it('does not ask a tab that refused a highlight again within the hour', async () => {
		const fake = await withWalkIns();
		fake.failing.set('highlight:sheet-downriver', { status: 400, error: 'protected' });
		await checkout();
		await run(fake.api);
		fake.calls.length = 0;

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		const result = await run(fake.api);

		expect(result.updated).toBe(1);
		expect(fake.calls.filter((c) => c.startsWith('highlight:'))).toEqual([]);
	});

	it('leaves the yellow alone when the packet’s row has moved', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), packet('35536745-88799')) });
		await run(fake.api);
		fake.failing.set('highlight:sheet-downriver', { status: 400, error: 'protected' });
		await update(1, GIVEN_BACK);
		await run(fake.api);
		fake.failing.delete('highlight:sheet-downriver');
		_resetLiveReadsForTests();
		fake.calls.length = 0;
		// Sorted between the run's read and the re-check: another packet is there now.
		fake.between(() => {
			const sheet = fake.sheet('sheet-downriver');
			[sheet[2], sheet[3]] = [sheet[3]!, sheet[2]!];
		});

		const result = await run(fake.api);

		expect(result.deferred).toBeGreaterThan(0);
		expect(fake.calls.filter((c) => c === 'highlight:sheet-downriver:2:off')).toEqual([]);
		expect(await stateOf(1)).toMatchObject({ yellow: true });
	});

	it('does not reuse a row another checkout holds, even emptied', async () => {
		const fake = await withWalkIns();
		await checkout();
		await run(fake.api);
		const sheet = fake.walkInSheet('sheet-downriver');
		sheet[1] = []; // staff emptied Dana's row
		await turf({ turfId: 101, name: 'Turf 02', list: '35536745-88713' });
		await checkout({ id: 2, turfId: 101, list: '35536745-88713', slackUserName: 'Eli' });
		await run(fake.api);
		expect(sheet.map((r) => r[0])).toEqual(['Name', undefined, '*Eli']);

		await update(1, GIVEN_BACK);
		const result = await run(fake.api);

		expect(result.warnings).toEqual([]);
		expect(await walkInState()).toMatchObject({ rowIndex: null });
	});

	// A 500 is Google failing to answer, not saying no: retried, not remembered.
	it('writes nothing when Google fails the highlight, and does it all next run', async () => {
		const fake = await withWalkIns();
		fake.failing.set('walkins-highlight:sheet-downriver', { status: 500, error: 'backend' });
		await checkout();

		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);

		fake.failing.delete('walkins-highlight:sheet-downriver');
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('*Dana');
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(true);
	});

	it('puts the yellow on later when the tab refused it at first', async () => {
		const fake = await withWalkIns();
		fake.failing.set('walkins-highlight:sheet-downriver', { status: 403, error: 'protected' });
		await checkout();
		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')[1]![0]).toBe('*Dana');
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(false);
		expect(await walkInState()).not.toHaveProperty('painted');

		// Within the hour nothing is asked; an hour on, the protection gone.
		fake.calls.length = 0;
		await run(fake.api);
		expect(fake.calls.filter((c) => c.startsWith('walkins-'))).toEqual([]);
		fake.failing.delete('walkins-highlight:sheet-downriver');
		_resetLiveReadsForTests();
		await run(fake.api);

		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(true);
		expect(await walkInState()).toMatchObject({ painted: true });
	});

	it('owes no yellow retry for a packet it never managed to highlight', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.failing.set('highlight:sheet-downriver', { status: 403, error: 'protected' });
		await run(fake.api);
		await update(1, GIVEN_BACK);
		await run(fake.api);

		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		expect(await stateOf(1)).not.toHaveProperty('yellow');
	});

	// Rows deleted at the bottom since the tab's size was looked up.
	it('does not take a row past the end for a refusal', async () => {
		const fake = await withWalkIns();
		fake.failing.set('walkins-highlight:sheet-downriver', {
			status: 400,
			error: 'Range (Walk Ins!A1000) exceeds grid limits',
		});
		await checkout();

		await run(fake.api);
		expect(fake.walkInSheet('sheet-downriver')).toHaveLength(1);

		fake.failing.delete('walkins-highlight:sheet-downriver');
		await run(fake.api);
		expect(fake.walkInYellow('sheet-downriver', 1)).toBe(true);
	});

	it('alerts and writes nothing when Google fails a Packet Tracker highlight', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		fake.failing.set('highlight:sheet-downriver', { status: 503, error: 'backend unavailable' });

		const result = await run(fake.api);

		expect(result.filled).toBe(0);
		expect(result.failed).toBe(1);
		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		const [, text] = vi.mocked(postAlert).mock.calls.at(-1)!;
		expect(text).toContain('backend unavailable');

		// Not remembered as a refusal: the next run highlights and fills.
		fake.failing.delete('highlight:sheet-downriver');
		expect((await run(fake.api)).filled).toBe(1);
		expect(fake.highlighted('sheet-downriver')).not.toEqual([]);
	});
});
