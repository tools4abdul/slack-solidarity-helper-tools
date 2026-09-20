import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createSheetsClient, type ServiceAccountConfig } from './sheets.js';

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

const HEADER = ['When', 'Event', 'Turf', 'Region', 'List #', 'Volunteer', 'Checkout ID'] as const;
const ROW = [
	'2026-09-19 10:07',
	'Checked out',
	'Turf 01',
	'R10C_Wayne_Taylor',
	'35536745-88712',
	'Dana',
	'41',
];

function tokenResponse(): Response {
	return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
		status: 200,
	});
}

/** Sheets' answer when the range names a tab that is not there. */
function missingTabResponse(): Response {
	return new Response(
		JSON.stringify({ error: { message: "Unable to parse range: 'Turf Checkouts'!A:G" } }),
		{ status: 400 },
	);
}

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
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_700_000_000_000 });

		await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Log',
			header: HEADER,
			rows: [ROW],
		});

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
			.mockResolvedValue(new Response('{}', { status: 200 }));
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_700_000_000_000 });

		await client.appendRows({ spreadsheetId: 'a', tabName: 'Log', header: HEADER, rows: [ROW] });
		await client.appendRows({ spreadsheetId: 'b', tabName: 'Log', header: HEADER, rows: [ROW] });

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

		const res = await client.appendRows({
			spreadsheetId: 'a',
			tabName: 'Log',
			header: HEADER,
			rows: [ROW],
		});

		expect(res.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('appendRows', () => {
	it('appends to the tab with RAW values and INSERT_ROWS', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Turf Checkouts',
			header: HEADER,
			rows: [ROW],
		});

		expect(res).toEqual({ ok: true, value: { appended: 1, createdTab: false } });
		const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect(url).toContain('/spreadsheets/sheet-1/values/');
		expect(url).toContain(encodeURIComponent("'Turf Checkouts'!A:G"));
		expect(url).toContain('valueInputOption=RAW');
		expect(url).toContain('insertDataOption=INSERT_ROWS');
		expect(JSON.parse(init.body as string)).toEqual({ values: [ROW] });
	});

	it('creates the tab with its header row, then retries the append', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(missingTabResponse())
			.mockResolvedValueOnce(new Response('{}', { status: 200 })) // addSheet
			.mockResolvedValueOnce(new Response('{}', { status: 200 })) // header row
			.mockResolvedValueOnce(new Response('{}', { status: 200 })); // retry
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Turf Checkouts',
			header: HEADER,
			rows: [ROW],
		});

		expect(res).toEqual({ ok: true, value: { appended: 1, createdTab: true } });

		const [addUrl, addInit] = fetchFn.mock.calls[2] as [string, RequestInit];
		expect(addUrl).toContain(':batchUpdate');
		expect(JSON.parse(addInit.body as string)).toEqual({
			requests: [{ addSheet: { properties: { title: 'Turf Checkouts' } } }],
		});

		const [headerUrl, headerInit] = fetchFn.mock.calls[3] as [string, RequestInit];
		expect(headerUrl).toContain(encodeURIComponent("'Turf Checkouts'!A1:G1"));
		expect(headerInit.method).toBe('PUT');
		expect(JSON.parse(headerInit.body as string)).toEqual({ values: [HEADER] });
	});

	it('does not retry a 403 — an unshared sheet stays unshared', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValue(
				new Response(
					JSON.stringify({ error: { message: 'The caller does not have permission' } }),
					{
						status: 403,
					},
				),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Log',
			header: HEADER,
			rows: [ROW],
		});

		expect(res).toMatchObject({ ok: false, status: 403 });
		expect(res.ok === false && res.error).toContain('does not have permission');
		// Token + one append. No second attempt.
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('sends nothing at all for an empty batch', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Log',
			header: HEADER,
			rows: [],
		});

		expect(res).toEqual({ ok: true, value: { appended: 0, createdTab: false } });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('does not start a request with no time left in the run', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_000 });

		const res = await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Log',
			header: HEADER,
			rows: [ROW],
			deadline: 1_500,
		});

		expect(res.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('quotes a tab name containing an apostrophe rather than breaking the range', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(new Response('{}', { status: 200 }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: "Dana's Log",
			header: HEADER,
			rows: [ROW],
		});

		const [url] = fetchFn.mock.calls[1] as [string];
		expect(url).toContain(encodeURIComponent("'Dana''s Log'!A:G"));
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
			.mockResolvedValueOnce(missingTabResponse())
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 }),
			)
			.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 }),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		await client.appendRows({
			spreadsheetId: 'sheet-1',
			tabName: 'Turf Checkouts',
			header: HEADER,
			rows: [ROW],
		});

		const written = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
		expect(written).not.toContain('35536745-88712');
		expect(written).not.toContain('Dana');
		expect(written).not.toContain('Turf 01');
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
