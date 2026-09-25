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
	'Doors Knocked',
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
	/** Runs once, after the run's read of a tab and before the re-check —
	 *  the window in which an organizer might sort the sheet. */
	let between: (() => void) | null = null;

	const api: SheetsClient = {
		async readTab({ spreadsheetId }) {
			calls.push(`read:${spreadsheetId}`);
			const fail = failing.get(spreadsheetId);
			if (fail) return { ok: false, ...fail };
			const sheet = sheets.get(spreadsheetId);
			if (!sheet) return { ok: false, status: 404, error: 'no tab' };
			return { ok: true, value: sheet.map((r) => [...r]) };
		},
		async readRow({ spreadsheetId, rowIndex }) {
			const fn = between;
			between = null;
			fn?.();
			calls.push(`readRow:${spreadsheetId}:${rowIndex}`);
			return { ok: true, value: [...(sheets.get(spreadsheetId)![rowIndex] ?? [])] };
		},
		async writeCells({ spreadsheetId, rowIndex, cells }) {
			calls.push(`write:${spreadsheetId}:${rowIndex}`);
			const fail = failing.get(`write:${spreadsheetId}`);
			if (fail) return { ok: false, ...fail };
			const row = sheets.get(spreadsheetId)![rowIndex]!;
			// Displayed without Sheets' text-forcing apostrophe.
			for (const [c, value] of cells) row[c] = value.replace(/^'/, '');
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
		/** The packet's row, by column name, as the campaign sees it. */
		entry(id: string, list = LIST): Record<string, string> {
			const row = sheets.get(id)!.find((r) => r[col('List Number')] === list)!;
			return Object.fromEntries(HEADER.map((h, i) => [h, row[i] ?? '']));
		},
		between(fn: () => void) {
			between = fn;
		},
	};
}

const writes = (calls: string[]) => calls.filter((c) => c.startsWith('write'));

async function turf(
	over: { mapRouteId?: number; regionName?: string; name?: string; list?: string | null } = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name,
		         name, printed_list_number, route_size, door_count, first_seen_at, last_seen_at)
		      VALUES (?, 1, 1, 71, 'Wayne County', ?, ?, ?, 120, 50, 'x', 'x')`,
		args: [
			over.mapRouteId ?? 100,
			over.regionName ?? 'R10C_Wayne_TaylorCity004_9.11',
			over.name ?? 'Turf 01',
			over.list === undefined ? LIST : over.list,
		],
	});
}

async function checkout(
	over: {
		id?: number;
		mapRouteId?: number;
		list?: string;
		releasedAt?: string | null;
		completedAt?: string | null;
		reportedPercent?: number | null;
		sheetState?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (id, map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, reported_percent, issued_list_number,
		         claim_door_count, sheet_state)
		      VALUES (?, ?, 'U1', 'Dana', '2026-09-19T14:07:00.000Z', '2026-09-21T14:00:00.000Z',
		              ?, ?, ?, ?, 64, ?)`,
		args: [
			over.id ?? 1,
			over.mapRouteId ?? 100,
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

async function assignedTo(mapRouteId = 100) {
	const res = await client.execute({
		sql: 'SELECT sheet_assigned_to FROM van_turfs WHERE map_route_id = ?',
		args: [mapRouteId],
	});
	return (res.rows[0]?.['sheet_assigned_to'] as string | null) ?? null;
}

function run(api: SheetsClient, over: Partial<Parameters<typeof syncPacketTracker>[1]> = {}) {
	return syncPacketTracker(db, {
		now: NOW,
		client: api,
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
			Canvasser: 'Dana',
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
			'Doors Knocked': '68',
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
		expect(fake.entry('sheet-downriver')).toMatchObject({ Canvasser: 'Dana', Status: 'Unwalked' });
		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);
		expect(fake.entry('sheet-downriver').Status).toBe('Out');

		// Loaded, so it would stay Incomplete; clear the load to test the hand-back.
		await update(1, "loaded_in_minivan_at = NULL, released_at = '2026-09-19T15:00:00.000Z'");
		await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(listed);
	});

	it('fills it in again if the hand-back turns out to have been walked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST)) });
		await run(fake.api);
		await update(1, "released_at = '2026-09-19T15:00:00.000Z'");
		await run(fake.api);

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);

		expect(fake.entry('sheet-downriver')).toMatchObject({
			Status: 'Incomplete',
			Canvasser: 'Dana',
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
	it('leaves a packet someone else has filled in, and says so once', async () => {
		await turf();
		await checkout();
		const theirs = packet(LIST, { Canvasser: 'Sam', Status: 'Incomplete', 'Walk Mode': 'Paper' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(theirs) });

		const first = await run(fake.api);
		const second = await run(fake.api);

		expect(fake.sheet('sheet-downriver')[2]).toEqual(theirs);
		expect(writes(fake.calls)).toEqual([]);
		expect(first.warnings.join(' ')).toContain('already has someone else');
		expect(second.warnings).toEqual([]);
	});

	it('fills in a packet once someone else’s entry is cleared, without telling twice', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({
			'sheet-downriver': tracker(packet(LIST, { Canvasser: 'Sam', Status: 'Incomplete' })),
		});
		const first = await run(fake.api);
		expect(first.warnings).toHaveLength(1);

		fake.sheet('sheet-downriver')[2] = packet(LIST, { Status: 'Unwalked' });
		const second = await run(fake.api);

		expect(second).toMatchObject({ filled: 1, warnings: [] });
		expect(fake.entry('sheet-downriver').Canvasser).toBe('Dana');
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
		expect(fake.entry('sheet-downriver').Canvasser).toBe('Dana');
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
				mapRouteId: 100,
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
			'write:sheet-downriver:2',
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
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 101, list: '2-2' });
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
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 2, mapRouteId: 101, list: '2-2' });

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
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 101, list: '2-2' });
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
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, name: 'Turf 02', list: '2-2' });
		await turf({ mapRouteId: 102, name: 'Turf 03', list: '3-3' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({
			id: 2,
			mapRouteId: 101,
			list: '2-2',
			completedAt: '2026-09-01T17:00:00.000Z',
			reportedPercent: 100,
		});
		await checkout({
			id: 3,
			mapRouteId: 102,
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
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 101, list: '2-2' });
		const fake = fakeSheets({ 'sheet-downriver': tracker(packet(LIST), packet('2-2')) });

		await run(fake.api, { onlyMapRouteId: 101 });

		expect(fake.entry('sheet-downriver').Canvasser).toBe('');
		expect(fake.entry('sheet-downriver', '2-2').Canvasser).toBe('Dana');
	});
});
