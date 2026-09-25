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
import { PACKET_COLUMNS, ROW_TAG_KEY } from '../../van/packet-tracker.js';
import type { SheetsClient } from '../google/sheets.js';

// A real in-memory libsql, because the candidate query and the state column
// ARE the behaviour under test; and a fake spreadsheet that behaves like the
// real one where it matters — inserts shift rows, tags follow their row, and a
// null cell in a write is left alone.

vi.mock('../slack.js', () => ({ postAlert: vi.fn(async () => true) }));
import { postAlert } from '../slack.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-09-19T18:00:00.000Z');
const HEADER = [...PACKET_COLUMNS];
const col = (name: (typeof PACKET_COLUMNS)[number]) => HEADER.indexOf(name);

function target(prefix: string, label: string, spreadsheetId: string): SheetTarget {
	return { prefix, prefixKey: normaliseSheetKey(prefix), label, spreadsheetId };
}
const DOWNRIVER = target('R10C', 'R10C_Downriver CR', 'sheet-downriver');

/** A campaign row, typed by hand. */
function manualRow(list: string, status: string, canvasser = 'Organizer Olu'): string[] {
	return HEADER.map((h) =>
		h === 'List Number'
			? list
			: h === 'Status'
				? status
				: h === 'Canvasser'
					? canvasser
					: h === 'Packet Name'
						? 'Paper packet'
						: '',
	);
}

interface FakeSheet {
	values: string[][];
	/** Checkout id → row index. */
	tags: Map<string, number>;
}

function fakeSheets(initial: Record<string, string[][]> = {}) {
	const sheets = new Map<string, FakeSheet>();
	for (const [id, values] of Object.entries(initial)) {
		sheets.set(id, { values: values.map((r) => [...r]), tags: new Map() });
	}
	const failing = new Map<string, { status: number; error: string }>();
	const calls: string[] = [];

	const api: SheetsClient = {
		async readTracker({ spreadsheetId }) {
			calls.push(`read:${spreadsheetId}`);
			const fail = failing.get(spreadsheetId);
			if (fail) return { ok: false, status: fail.status, error: fail.error };
			const sheet = sheets.get(spreadsheetId);
			if (!sheet) return { ok: false, status: 404, error: 'no tab' };
			// Like the API: trailing blank rows are not returned.
			const values = sheet.values.map((r) => [...r]);
			while (values.length && values[values.length - 1]!.every((c) => c === '')) values.pop();
			return { ok: true, value: { sheetId: 7, values, tags: new Map(sheet.tags) } };
		},
		async insertTaggedRow({ spreadsheetId, rowIndex, value }) {
			calls.push(`insert:${spreadsheetId}:${rowIndex}`);
			const sheet = sheets.get(spreadsheetId)!;
			sheet.values.splice(
				rowIndex,
				0,
				HEADER.map(() => ''),
			);
			for (const [k, i] of sheet.tags) if (i >= rowIndex) sheet.tags.set(k, i + 1);
			sheet.tags.set(value, rowIndex);
			return { ok: true, value: true };
		},
		async writeTaggedRow({ spreadsheetId, value, row }) {
			calls.push(`write:${spreadsheetId}:${value}`);
			const sheet = sheets.get(spreadsheetId)!;
			const index = sheet.tags.get(value);
			if (index === undefined) return { ok: true, value: { found: false } };
			row.forEach((cell, i) => {
				// Displayed without Sheets' text-forcing apostrophe.
				if (cell !== null) sheet.values[index]![i] = cell.replace(/^'/, '');
			});
			return { ok: true, value: { found: true } };
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
		/** Our row for a checkout, as the campaign sees it. */
		rowFor(id: string, checkoutId: number): Record<string, string> | null {
			const sheet = sheets.get(id)!;
			const index = sheet.tags.get(String(checkoutId));
			if (index === undefined) return null;
			return Object.fromEntries(HEADER.map((h, i) => [h, sheet.values[index]![i] ?? '']));
		},
	};
}

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
			over.list === undefined ? '35536745-88712' : over.list,
		],
	});
}

async function checkout(
	over: {
		id?: number;
		mapRouteId?: number;
		releasedAt?: string | null;
		completedAt?: string | null;
		reportedPercent?: number | null;
		loadedAt?: string | null;
		sheetState?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (id, map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, reported_percent, loaded_in_minivan_at,
		         issued_list_number, claim_door_count, sheet_state)
		      VALUES (?, ?, 'U1', 'Dana', '2026-09-19T14:07:00.000Z', '2026-09-21T14:00:00.000Z',
		              ?, ?, ?, ?, '35536745-88712', 64, ?)`,
		args: [
			over.id ?? 1,
			over.mapRouteId ?? 100,
			over.releasedAt ?? null,
			over.completedAt ?? null,
			over.reportedPercent ?? null,
			over.loadedAt ?? null,
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
	it('appends one row on claim, below the campaign’s rows', async () => {
		await turf();
		await checkout();
		const manual = manualRow('111-1', 'Out');
		const fake = fakeSheets({ 'sheet-downriver': [HEADER, manual] });

		const result = await run(fake.api);

		expect(result.appended).toBe(1);
		expect(fake.sheet('sheet-downriver').tags.get('1')).toBe(2);
		expect(fake.rowFor('sheet-downriver', 1)).toMatchObject({
			'Packet Name': 'Turf 01',
			Voters: '120',
			Doors: '64',
			'List Number': '35536745-88712',
			Canvasser: 'Dana',
			'Date Sent Out': '09/19/2026',
			'Walk Mode': 'MiniVAN',
			Status: 'Unwalked',
		});
		// The campaign's row is exactly as it was.
		expect(fake.sheet('sheet-downriver').values[1]).toEqual(manual);
	});

	it('updates the same row as the turf goes out and is walked — never a second row', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		await run(fake.api);

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);
		expect(fake.rowFor('sheet-downriver', 1)).toMatchObject({
			Status: 'Out',
			'Time Departed': '10:41 AM',
		});

		await update(1, "completed_at = '2026-09-19T17:00:00.000Z', reported_percent = 85");
		await run(fake.api);
		expect(fake.rowFor('sheet-downriver', 1)).toMatchObject({
			Status: 'Incomplete',
			'Knocked %': '85%',
			'Doors Knocked': '54',
		});
		expect(fake.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
		expect(fake.sheet('sheet-downriver').values).toHaveLength(2);
	});

	it('does nothing when nothing changed', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		await run(fake.api);
		fake.calls.length = 0;

		const result = await run(fake.api);

		expect(result.appended + result.updated).toBe(0);
		expect(fake.calls.filter((c) => !c.startsWith('read'))).toEqual([]);
	});

	it('blanks the row of a turf handed back unwalked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER, manualRow('111-1', 'Out')] });
		await run(fake.api);

		await update(1, "released_at = '2026-09-19T15:00:00.000Z', release_reason = 'volunteer'");
		await run(fake.api);

		expect(Object.values(fake.rowFor('sheet-downriver', 1)!).every((c) => c === '')).toBe(true);
		expect(fake.sheet('sheet-downriver').values[1]).toEqual(manualRow('111-1', 'Out'));
		expect((await stateOf(1))?.cells).toBeNull();
	});

	it('refills the blanked row if the hand-back turns out to have been walked', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		await run(fake.api);
		await update(1, "released_at = '2026-09-19T15:00:00.000Z'");
		await run(fake.api);

		// The sync notices, late, that the list had been loaded.
		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		await run(fake.api);

		expect(fake.rowFor('sheet-downriver', 1)).toMatchObject({
			Status: 'Incomplete',
			Canvasser: 'Dana',
		});
		expect(fake.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
	});

	it('never touches the sheet for a claim handed back before any run saw it', async () => {
		await turf();
		await checkout({ releasedAt: '2026-09-19T15:00:00.000Z' });
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		await run(fake.api);

		expect(fake.calls.filter((c) => !c.startsWith('read'))).toEqual([]);
	});
});

describe('rows that are not ours', () => {
	it('leaves our row alone once someone types another turf over it', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		await run(fake.api);
		const index = fake.sheet('sheet-downriver').tags.get('1')!;
		fake.sheet('sheet-downriver').values[index]![col('List Number')] = '222-2';
		fake.sheet('sheet-downriver').values[index]![col('Canvasser')] = 'Sam';

		await update(1, "released_at = '2026-09-19T15:00:00.000Z'");
		const result = await run(fake.api);

		expect(fake.sheet('sheet-downriver').values[index]![col('Canvasser')]).toBe('Sam');
		expect(result.warnings.join(' ')).toContain('changed by hand');
		expect((await stateOf(1))?.gone).toBe(true);
	});

	it('does not recreate a row the campaign deleted', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		await run(fake.api);
		const sheet = fake.sheet('sheet-downriver');
		sheet.values.splice(sheet.tags.get('1')!, 1);
		sheet.tags.delete('1');

		await update(1, "loaded_in_minivan_at = '2026-09-19T14:41:00.000Z'");
		const result = await run(fake.api);

		expect(fake.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
		expect(result.warnings.join(' ')).toContain('deleted in the sheet');
		expect((await stateOf(1))?.gone).toBe(true);
	});
});

describe('the campaign’s own assignments', () => {
	it('records who the tracker says has a turf, by list number', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': [HEADER, manualRow('35536745-88712', 'Out')],
		});

		const result = await run(fake.api);

		expect(result.assignmentsChanged).toBe(1);
		expect(await assignedTo()).toBe('Organizer Olu');
	});

	it('clears it when the row goes Incomplete', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER, manualRow('35536745-88712', 'Out')] });
		await run(fake.api);
		fake.sheet('sheet-downriver').values[1]![col('Status')] = 'Incomplete';

		await run(fake.api);

		expect(await assignedTo()).toBeNull();
	});

	it('does not count our own rows as the campaign’s', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		await run(fake.api);
		await run(fake.api);

		expect(await assignedTo()).toBeNull();
	});

	it('keeps the last known assignment when the spreadsheet cannot be read', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER, manualRow('35536745-88712', 'Out')] });
		await run(fake.api);
		fake.failing.set('sheet-downriver', {
			status: 403,
			error: 'The caller does not have permission',
		});

		await run(fake.api);

		expect(await assignedTo()).toBe('Organizer Olu');
	});

	it('reads it live for a claim', async () => {
		await turf();
		const fake = fakeSheets({
			'sheet-downriver': [HEADER, manualRow('35536745-88712', 'Unwalked')],
		});

		const who = await liveAssignment(db, {
			client: fake.api,
			targets: [DOWNRIVER],
			turf: {
				mapRouteId: 100,
				regionName: 'R10C_Wayne_TaylorCity004_9.11',
				printedListNumber: '35536745-88712',
			},
			timeBudgetMs: 6_000,
		});

		expect(who).toBe('Organizer Olu');
		expect(await assignedTo()).toBe('Organizer Olu');
	});

	it('says "could not tell" rather than "free" when the live read fails', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		fake.failing.set('sheet-downriver', { status: 500, error: 'backend error' });

		const who = await liveAssignment(db, {
			client: fake.api,
			targets: [DOWNRIVER],
			turf: {
				mapRouteId: 100,
				regionName: 'R10C_Wayne_TaylorCity004_9.11',
				printedListNumber: '35536745-88712',
			},
			timeBudgetMs: 6_000,
		});

		expect(who).toBeUndefined();
	});
});

describe('Google’s 60-a-minute quota', () => {
	const WESTERN = target('R10D', 'R10D_Western CR', 'sheet-western');

	it('reads each spreadsheet once per run', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		await run(fake.api);

		expect(fake.calls.filter((c) => c.startsWith('read'))).toEqual(['read:sheet-downriver']);
	});

	it('waits out a 429 quietly: no alert, nothing marked failed, retried next run', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		fake.failing.set('sheet-downriver', { status: 429, error: 'Quota exceeded' });

		const first = await run(fake.api);

		expect(first).toMatchObject({ rateLimited: 1, failed: 0 });
		expect(postAlert).not.toHaveBeenCalled();

		fake.failing.delete('sheet-downriver');
		const second = await run(fake.api);
		expect(second.appended).toBe(1);
	});

	it('stops reading once the quota is spent', async () => {
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 101 });
		const fake = fakeSheets({ 'sheet-downriver': [HEADER], 'sheet-western': [HEADER] });
		fake.api.writeTaggedRow = async () => ({ ok: false, status: 429, error: 'Quota exceeded' });

		const result = await run(fake.api, { targets: [DOWNRIVER, WESTERN] });

		expect(result.rateLimited).toBe(2);
		expect(fake.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
	});

	// If the read-only sheet went first and hit the quota, the rate limit
	// would stop the run before the row was written. The order is shuffled, so
	// this is run several times.
	it('writes the spreadsheets with work before the ones only read for assignments', async () => {
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, regionName: 'R10D_Wayne_X', name: 'Turf 02', list: '2-2' });
		await checkout({ id: 2, mapRouteId: 101 });

		for (let i = 0; i < 8; i++) {
			await update(2, 'sheet_state = NULL');
			const fake = fakeSheets({ 'sheet-downriver': [HEADER], 'sheet-western': [HEADER] });
			fake.failing.set('sheet-downriver', { status: 429, error: 'Quota exceeded' });

			const result = await run(fake.api, { targets: [DOWNRIVER, WESTERN] });

			expect(result.appended).toBe(1);
		}
	});

	it('lets a claim reuse a read from the last minute', async () => {
		await turf();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER, manualRow('35536745-88712', 'Out')] });
		const ask = () =>
			liveAssignment(db, {
				client: fake.api,
				targets: [DOWNRIVER],
				turf: {
					mapRouteId: 100,
					regionName: 'R10C_Wayne_TaylorCity004_9.11',
					printedListNumber: '35536745-88712',
				},
				timeBudgetMs: 6_000,
			});

		expect(await ask()).toBe('Organizer Olu');
		expect(await ask()).toBe('Organizer Olu');

		expect(fake.calls.filter((c) => c.startsWith('read'))).toHaveLength(1);
	});
});

describe('backfill and bookkeeping', () => {
	it('writes live and walked checkouts and skips released ones the migration stamped', async () => {
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, name: 'Turf 02', list: '2-2' });
		await turf({ mapRouteId: 102, name: 'Turf 03', list: '3-3' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({
			id: 2,
			mapRouteId: 101,
			completedAt: '2026-09-01T17:00:00.000Z',
			reportedPercent: 100,
		});
		await checkout({
			id: 3,
			mapRouteId: 102,
			releasedAt: '2026-09-01T15:00:00.000Z',
			sheetState: '{"spreadsheetId":null,"tagged":false,"cells":null}',
		});
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		const result = await run(fake.api);

		expect(result.appended).toBe(2);
		expect(fake.rowFor('sheet-downriver', 2)).toMatchObject({ Status: 'Complete' });
		expect(fake.rowFor('sheet-downriver', 3)).toBeNull();
	});

	it('fills a row whose first write failed, instead of inserting another', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		const realWrite = fake.api.writeTaggedRow;
		fake.api.writeTaggedRow = async () => ({ ok: false, status: 500, error: 'backend error' });
		await run(fake.api);
		expect((await stateOf(1))?.tagged).toBe(true);

		fake.api.writeTaggedRow = realWrite;
		await run(fake.api);

		expect(fake.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
		expect(fake.rowFor('sheet-downriver', 1)).toMatchObject({
			Canvasser: 'Dana',
			Status: 'Unwalked',
		});
	});

	it('alerts once when a spreadsheet cannot be read, and keeps the checkout owed', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });
		fake.failing.set('sheet-downriver', {
			status: 403,
			error: 'The caller does not have permission',
		});

		const first = await run(fake.api);
		await run(fake.api);

		expect(first.failed).toBe(1);
		expect(postAlert).toHaveBeenCalledTimes(1);
		expect(await stateOf(1)).toBeNull();
	});

	it('refuses a tab missing a column rather than guessing where cells go', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER.filter((h) => h !== 'Status')] });

		const result = await run(fake.api);

		expect(result.failed).toBe(1);
		expect(fake.calls.filter((c) => c.startsWith('insert'))).toEqual([]);
		expect(vi.mocked(postAlert).mock.calls[0]?.[1]).toContain('"Status"');
	});

	it('writes the claim time as the shift time', async () => {
		await turf();
		await checkout();
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		await run(fake.api);

		// Claimed 14:07 UTC, 10:07 AM in Detroit.
		expect(fake.rowFor('sheet-downriver', 1)?.['Shift Time']).toBe('10:07 AM');
	});

	it('limits a nudge to the one turf', async () => {
		await turf({ mapRouteId: 100 });
		await turf({ mapRouteId: 101, name: 'Turf 02', list: '2-2' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 101 });
		const fake = fakeSheets({ 'sheet-downriver': [HEADER] });

		await run(fake.api, { onlyMapRouteId: 101 });

		expect(fake.rowFor('sheet-downriver', 1)).toBeNull();
		expect(fake.rowFor('sheet-downriver', 2)).not.toBeNull();
	});

	it('tags rows with the checkout id under the app’s key', () => {
		expect(ROW_TAG_KEY).toBe('solidarity-helper-checkout');
	});
});
