import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { columnLetter, createSheetsClient, type ServiceAccountConfig } from './sheets.js';

// A real key pair, generated once: the JWT assertion has to actually sign, and
// a fixture key would either expire as a concept or need committing.
const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG: ServiceAccountConfig = {
	clientEmail: 'turf-log@example.iam.gserviceaccount.com',
	privateKey,
};

/** A claim's cells as the store sends them: [column index, value]. */
const CELLS: Array<[number, string]> = [
	[5, "'Dana"],
	[6, '10:07 AM'],
	[7, '09/19/2026'],
	[12, 'Unwalked'],
];
const write = (spreadsheetId = 'sheet-1') => ({
	spreadsheetId,
	tabName: 'Packet Tracker',
	rowIndex: 30,
	cells: CELLS,
});

function tokenResponse(): Response {
	return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
		status: 200,
	});
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

const WROTE = () => ok({ totalUpdatedCells: 4 });

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('authentication', () => {
	it('signs a JWT bearer assertion with the service account claims', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(WROTE());
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_700_000_000_000 });

		await client.writeCells(write());

		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://oauth2.googleapis.com/token');
		const body = init.body as URLSearchParams;
		expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

		const assertion = body.get('assertion') ?? '';
		const [rawHeader, rawClaims, signature] = assertion.split('.');
		expect(signature).toBeTruthy();
		expect(JSON.parse(Buffer.from(rawHeader!, 'base64url').toString())).toEqual({
			alg: 'RS256',
			typ: 'JWT',
		});
		expect(JSON.parse(Buffer.from(rawClaims!, 'base64url').toString())).toEqual({
			iss: CONFIG.clientEmail,
			scope: 'https://www.googleapis.com/auth/spreadsheets',
			aud: 'https://oauth2.googleapis.com/token',
			iat: 1_700_000_000,
			exp: 1_700_000_000 + 3600,
		});
	});

	it('reuses one token across spreadsheets in a run', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockImplementation(async () => WROTE());
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_700_000_000_000 });

		await client.writeCells(write('a'));
		await client.writeCells(write('b'));

		const tokenCalls = fetchFn.mock.calls.filter(
			([url]) => url === 'https://oauth2.googleapis.com/token',
		);
		expect(tokenCalls).toHaveLength(1);
	});

	// The sync reads several spreadsheets at once; a cold client must not
	// mint a token for each.
	it('mints one token for parallel requests on a cold client', async () => {
		const fetchFn = vi.fn(async (url: string) =>
			url === 'https://oauth2.googleapis.com/token' ? tokenResponse() : WROTE(),
		);
		const client = createSheetsClient(CONFIG, { fetchFn: fetchFn as typeof fetch });

		await Promise.all([client.writeCells(write('a')), client.writeCells(write('b'))]);

		const tokenCalls = fetchFn.mock.calls.filter(
			([url]) => url === 'https://oauth2.googleapis.com/token',
		);
		expect(tokenCalls).toHaveLength(1);
	});

	it('reports a malformed private key rather than throwing', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(
			{ clientEmail: 'x@y.iam.gserviceaccount.com', privateKey: 'not a pem' },
			{ fetchFn },
		);

		const res = await client.writeCells(write('a'));

		expect(res.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('readTab', () => {
	// Google caps reads at 60 a minute; the tracker makes one per spreadsheet.
	it('reads the whole tab, as displayed, in ONE request', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(ok({ values: [[], ['Packet Name', 'Voters'], ['Turf 01', 120]] }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.readTab({ spreadsheetId: 'sheet-1', tabName: 'Packet Tracker' });

		expect(fetchFn).toHaveBeenCalledTimes(2); // token + one read
		expect(res).toEqual({
			ok: true,
			value: [[], ['Packet Name', 'Voters'], ['Turf 01', '120']],
		});
		const [url] = fetchFn.mock.calls[1] as [string];
		expect(url).toContain(`/values/${encodeURIComponent("'Packet Tracker'")}?`);
		expect(url).toContain('valueRenderOption=FORMATTED_VALUE');
	});

	// The tab is the campaign's. The old log created its own; this must not.
	it('reports a missing tab as a 404 and creates nothing', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ error: { message: "Unable to parse range: 'Packet Tracker'" } }),
					{ status: 400 },
				),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.readTab({ spreadsheetId: 's', tabName: 'Packet Tracker' });

		expect(res).toMatchObject({ ok: false, status: 404 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('quotes a tab name containing an apostrophe rather than breaking the range', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.readTab({ spreadsheetId: 's', tabName: "Dana's Tracker" });

		const [url] = fetchFn.mock.calls[1] as [string];
		expect(url).toContain(encodeURIComponent("'Dana''s Tracker'"));
	});
});

describe('readRow', () => {
	it('reads one row by its 1-based A1 number', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(ok({ values: [['Turf 01', '120']] }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.readRow({
			spreadsheetId: 's',
			tabName: 'Packet Tracker',
			rowIndex: 30,
		});

		expect(res).toEqual({ ok: true, value: ['Turf 01', '120'] });
		const [url] = fetchFn.mock.calls[1] as [string];
		expect(url).toContain(encodeURIComponent("'Packet Tracker'!31:31"));
	});

	it('reads an empty row as empty', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.readRow({ spreadsheetId: 's', tabName: 'T', rowIndex: 0 });

		expect(res).toEqual({ ok: true, value: [] });
	});
});

describe('highlightCells', () => {
	const TABS = () =>
		ok({
			sheets: [
				{ properties: { sheetId: 0, title: 'Summary' } },
				{ properties: { sheetId: 1234, title: 'Packet Tracker' } },
			],
		});
	const highlight = (on: boolean) => ({
		spreadsheetId: 'sheet-1',
		tabName: 'Packet Tracker',
		rowIndex: 30,
		columns: [5, 12],
		on,
	});

	it('fills just the named cells yellow, by the tab’s id, in one request', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(TABS())
			.mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.highlightCells(highlight(true))).toEqual({ ok: true, value: true });
		const [url, init] = fetchFn.mock.calls[2] as [string, RequestInit];
		expect(url).toContain('/spreadsheets/sheet-1:batchUpdate');
		const { requests } = JSON.parse(init.body as string);
		expect(requests).toHaveLength(2);
		expect(requests[0].repeatCell).toEqual({
			range: {
				sheetId: 1234,
				startRowIndex: 30,
				endRowIndex: 31,
				startColumnIndex: 5,
				endColumnIndex: 6,
			},
			cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 } } },
			fields: 'userEnteredFormat.backgroundColor',
		});
	});

	it('removes the fill, and looks the tab up only once', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(TABS())
			.mockResolvedValue(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.highlightCells(highlight(true));
		await client.highlightCells(highlight(false));

		expect(fetchFn).toHaveBeenCalledTimes(4);
		const { requests } = JSON.parse(
			(fetchFn.mock.calls[3] as [string, RequestInit])[1].body as string,
		);
		expect(requests[0].repeatCell.cell).toEqual({ userEnteredFormat: {} });
		expect(requests[0].repeatCell.fields).toBe('userEnteredFormat.backgroundColor');
	});

	it('reports a missing tab as a 404', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(ok({ sheets: [{ properties: { sheetId: 0, title: 'Summary' } }] }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.highlightCells(highlight(true))).toMatchObject({ ok: false, status: 404 });
	});

	it('keeps the tab id through a rate limit, and drops it when Google says it is gone', async () => {
		const quota = () =>
			new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
		const bad = () =>
			new Response(
				JSON.stringify({
					error: { message: 'Invalid requests[0].repeatCell: No grid with id: 1234' },
				}),
				{ status: 400 },
			);
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(TABS())
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(quota())
			.mockResolvedValueOnce(bad())
			.mockResolvedValueOnce(TABS())
			.mockResolvedValueOnce(ok({}));
		vi.useFakeTimers();
		try {
			const client = createSheetsClient(CONFIG, { fetchFn });
			const first = client.highlightCells(highlight(true));
			await vi.runAllTimersAsync();
			expect(await first).toMatchObject({ ok: false, status: 429 });
			// Same id, no second lookup: straight to the batchUpdate.
			expect(await client.highlightCells(highlight(true))).toMatchObject({ status: 400 });
			expect(await client.highlightCells(highlight(true))).toEqual({ ok: true, value: true });
			const lookups = fetchFn.mock.calls.filter(([url]) =>
				String(url).includes('fields=sheets.properties'),
			);
			expect(lookups).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	// Protected cells answer with a 400 too; the id is fine, and a lookup on
	// every later call would spend the minute's reads for nothing.
	it('keeps the tab id through any other refusal', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(TABS())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ error: { message: 'You are trying to edit a protected cell' } }),
					{ status: 400 },
				),
			)
			.mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.highlightCells(highlight(true))).toMatchObject({ ok: false, status: 400 });
		expect(await client.highlightCells(highlight(true))).toEqual({ ok: true, value: true });
		expect(fetchFn).toHaveBeenCalledTimes(4);
	});

	it('sends nothing for no columns', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.highlightCells({ ...highlight(true), columns: [] })).toEqual({
			ok: true,
			value: true,
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('dropdownOptions', () => {
	const column = {
		spreadsheetId: 'sheet-1',
		tabName: 'Walk Ins',
		rowIndex: 1,
		rows: 20,
		columnIndex: 1,
	};
	const rules = (...conditions: unknown[]) =>
		ok({
			sheets: [
				{
					data: [
						{
							rowData: conditions.map((condition) => ({
								values: [condition ? { dataValidation: { condition } } : {}],
							})),
						},
					],
				},
			],
		});

	it('reads a typed-in list as text, looking down the column', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				// The first row's drop-down was pasted over; the second still has it.
				rules(null, {
					type: 'ONE_OF_LIST',
					values: [{ userEnteredValue: '10am' }, { userEnteredValue: '1pm' }],
				}),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.dropdownOptions(column)).toEqual({
			ok: true,
			value: [
				{ label: '10am', text: true },
				{ label: '1pm', text: true },
			],
		});
		const [url] = fetchFn.mock.calls[1] as [string];
		expect(decodeURIComponent(url)).toContain("ranges='Walk Ins'!B2:B21");
	});

	it('reads a list taken from a range, text or time per cell', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				rules({ type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!$A$2:$A$4' }] }),
			)
			.mockResolvedValueOnce(
				ok({
					sheets: [
						{
							data: [
								{
									rowData: [
										{
											values: [
												{ formattedValue: '10:00 AM', effectiveValue: { numberValue: 0.41 } },
											],
										},
										{ values: [{}] },
										{
											values: [{ formattedValue: 'Late', effectiveValue: { stringValue: 'Late' } }],
										},
									],
								},
							],
						},
					],
				}),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.dropdownOptions(column)).toEqual({
			ok: true,
			value: [
				{ label: '10:00 AM', text: false },
				{ label: 'Late', text: true },
			],
		});
		const [url] = fetchFn.mock.calls[2] as [string];
		expect(decodeURIComponent(url)).toContain('ranges=Lists!$A$2:$A$4');
	});

	it('reads a range on the same tab from that tab, not the first one', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				rules({ type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=$K$2:$K$5' }] }),
			)
			.mockResolvedValueOnce(ok({ sheets: [{ data: [{ rowData: [] }] }] }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.dropdownOptions(column);

		const [url] = fetchFn.mock.calls[2] as [string];
		expect(decodeURIComponent(url)).toContain("ranges='Walk Ins'!$K$2:$K$5");
	});

	it('says there is none when no row looked at has a drop-down', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(rules(null, null));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.dropdownOptions(column)).toEqual({ ok: true, value: null });
	});
});

describe('ensureRows', () => {
	const tab = (rowCount: number) =>
		ok({
			sheets: [{ properties: { sheetId: 1234, title: 'Walk Ins', gridProperties: { rowCount } } }],
		});
	const at = (rowIndex: number) => ({ spreadsheetId: 'sheet-1', tabName: 'Walk Ins', rowIndex });

	it('does nothing while the tab has the row', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(tab(100));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.ensureRows(at(99))).toEqual({ ok: true, value: true });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('adds just the rows missing, and remembers it has them', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(tab(100))
			.mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.ensureRows(at(101))).toEqual({ ok: true, value: true });
		const { requests } = JSON.parse(
			(fetchFn.mock.calls[2] as [string, RequestInit])[1].body as string,
		);
		expect(requests).toEqual([
			{ appendDimension: { sheetId: 1234, dimension: 'ROWS', length: 2 } },
		]);
		expect(await client.ensureRows(at(101))).toEqual({ ok: true, value: true });
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});
});

describe('replaceTab', () => {
	const ROWS = [{ cells: ['Doors contacted'], bold: true }, { cells: ['Folder', 'Turf 1', 12] }];
	const replace = () =>
		createSheetsClient(CONFIG, { fetchFn }).replaceTab({
			spreadsheetId: 'sheet-1',
			tabName: '2026-10-07',
			rows: ROWS,
		});
	let fetchFn: Mock<typeof fetch>;
	const body = (call: number) =>
		JSON.parse((fetchFn.mock.calls[call] as [string, RequestInit])[1].body as string);

	it('adds the tab first when it is not there, then writes it', async () => {
		fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(ok({ sheets: [{ properties: { sheetId: 1, title: 'Other' } }] }))
			.mockResolvedValueOnce(ok({ replies: [{ addSheet: { properties: { sheetId: 77 } } }] }))
			.mockResolvedValueOnce(ok({}));

		expect(await replace()).toEqual({ ok: true, value: { sheetId: 77 } });
		expect(body(2).requests[0].addSheet.properties).toMatchObject({
			title: '2026-10-07',
			index: 0,
			gridProperties: { rowCount: 2, columnCount: 3 },
		});
		const [clear, write] = body(3).requests;
		expect(clear).toEqual({
			updateCells: { range: { sheetId: 77 }, fields: 'userEnteredValue,userEnteredFormat' },
		});
		expect(write.updateCells.rows).toEqual([
			{
				values: [
					{
						userEnteredValue: { stringValue: 'Doors contacted' },
						userEnteredFormat: { textFormat: { bold: true } },
					},
				],
			},
			{
				values: [
					{ userEnteredValue: { stringValue: 'Folder' } },
					{ userEnteredValue: { stringValue: 'Turf 1' } },
					{ userEnteredValue: { numberValue: 12 } },
				],
			},
		]);
	});

	it('clears and rewrites a tab that is already there, growing it when short', async () => {
		fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				ok({
					sheets: [
						{ properties: { sheetId: 5, title: '2026-10-07', gridProperties: { rowCount: 1 } } },
					],
				}),
			)
			.mockResolvedValueOnce(ok({}));

		expect(await replace()).toEqual({ ok: true, value: { sheetId: 5 } });
		expect(fetchFn).toHaveBeenCalledTimes(3);
		const requests = body(2).requests;
		expect(requests[0]).toEqual({
			appendDimension: { sheetId: 5, dimension: 'ROWS', length: 1 },
		});
		expect(requests[1].updateCells.range).toEqual({ sheetId: 5 });
	});

	const existing = () =>
		ok({
			sheets: [
				{ properties: { sheetId: 5, title: '2026-10-07', gridProperties: { rowCount: 10 } } },
			],
		});
	const owned = (
		input: Partial<Parameters<ReturnType<typeof createSheetsClient>['replaceTab']>[0]>,
	) =>
		createSheetsClient(CONFIG, { fetchFn }).replaceTab({
			spreadsheetId: 'sheet-1',
			tabName: '2026-10-07',
			rows: ROWS,
			ownedPrefix: 'Doors contacted',
			...input,
		});

	it('refuses to clear a tab of the same name that it did not write', async () => {
		fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(existing())
			.mockResolvedValueOnce(ok({ values: [['Shift notes']] }));

		const res = await owned({});
		expect(res).toMatchObject({ ok: false, status: 409 });
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it('rewrites its own tab, or an empty one', async () => {
		for (const a1 of [{ values: [['Doors contacted · Main']] }, {}]) {
			fetchFn = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(tokenResponse())
				.mockResolvedValueOnce(existing())
				.mockResolvedValueOnce(ok(a1))
				.mockResolvedValueOnce(ok({}));
			expect(await owned({})).toEqual({ ok: true, value: { sheetId: 5 } });
		}
	});

	it('sets fixed column widths instead of fitting them, when given', async () => {
		fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(existing())
			.mockResolvedValueOnce(ok({}));

		await owned({ ownedPrefix: undefined, columnWidths: [200, 80] });
		const requests = body(2).requests as Array<Record<string, unknown>>;
		expect(requests.some((r) => 'autoResizeDimensions' in r)).toBe(false);
		expect(requests.filter((r) => 'updateDimensionProperties' in r)).toEqual([
			{
				updateDimensionProperties: {
					range: { sheetId: 5, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
					properties: { pixelSize: 200 },
					fields: 'pixelSize',
				},
			},
			{
				updateDimensionProperties: {
					range: { sheetId: 5, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
					properties: { pixelSize: 80 },
					fields: 'pixelSize',
				},
			},
		]);
	});

	it('reports a spreadsheet it may not open', async () => {
		fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ error: { message: 'The caller does not have permission' } }),
					{
						status: 403,
					},
				),
			);

		expect(await replace()).toEqual({
			ok: false,
			status: 403,
			error: 'The caller does not have permission',
		});
	});
});

describe('writeCells', () => {
	it('writes each cell by A1 address, USER_ENTERED, in one request', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(WROTE());
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.writeCells(write());

		expect(res).toEqual({ ok: true, value: true });
		const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect(url).toContain('/spreadsheets/sheet-1/values:batchUpdate');
		expect(JSON.parse(init.body as string)).toEqual({
			valueInputOption: 'USER_ENTERED',
			data: [
				{ range: "'Packet Tracker'!F31", values: [["'Dana"]] },
				{ range: "'Packet Tracker'!G31", values: [['10:07 AM']] },
				{ range: "'Packet Tracker'!H31", values: [['09/19/2026']] },
				{ range: "'Packet Tracker'!M31", values: [['Unwalked']] },
			],
		});
	});

	it('sends nothing for no cells', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn });

		expect(await client.writeCells({ ...write(), cells: [] })).toEqual({ ok: true, value: true });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	// What the campaign's protected ranges answer. Not retried: it will not change.
	it('does not retry a 400 or a 403', async () => {
		for (const status of [400, 403]) {
			const fetchFn = vi
				.fn()
				.mockResolvedValueOnce(tokenResponse())
				.mockResolvedValue(
					new Response(
						JSON.stringify({ error: { message: 'You are trying to edit a protected cell' } }),
						{ status },
					),
				);
			const client = createSheetsClient(CONFIG, { fetchFn });

			const res = await client.writeCells(write());

			expect(res).toMatchObject({ ok: false, status });
			expect(fetchFn).toHaveBeenCalledTimes(2);
		}
	});

	it('reports 408, having sent nothing, with no time left in the run', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_000 });

		const res = await client.writeCells({ ...write(), deadline: 1_500 });

		expect(res).toMatchObject({ ok: false, status: 408 });
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('columnLetter', () => {
	it.each([
		[0, 'A'],
		[12, 'M'],
		[25, 'Z'],
		[26, 'AA'],
		[51, 'AZ'],
		[52, 'BA'],
	])('%i is %s', (index, letters) => {
		expect(columnLetter(index)).toBe(letters);
	});
});

// The rule this file's header exists to state. The list number is the
// credential that pulls a turf's doors down in MiniVAN, and a volunteer's name
// beside it outlives the request by however long the log aggregator keeps it.
describe('privacy', () => {
	it('never logs a cell value, on any path', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 }),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.writeCells(write());

		const written = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
		expect(written).not.toContain('Dana');
		expect(written).not.toContain('09/19/2026');
	});
});

describe('describe', () => {
	it('reports the tabs a spreadsheet has, for the setup check', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						properties: { title: 'R10C_Downriver CR' },
						sheets: [{ properties: { title: 'Walk Sheet' } }, { properties: { title: 'Log' } }],
					}),
					{ status: 200 },
				),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.describe({ spreadsheetId: 'sheet-1', tabName: 'Log' });

		expect(res).toEqual({
			ok: true,
			value: { title: 'R10C_Downriver CR', hasTab: true, tabs: ['Walk Sheet', 'Log'] },
		});
	});

	it('says so when the tab is not there yet', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ properties: { title: 'X' }, sheets: [] }), { status: 200 }),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.describe({ spreadsheetId: 'sheet-1', tabName: 'Log' });

		expect(res.ok && res.value.hasTab).toBe(false);
	});
});
