import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
