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

/** A Packet Tracker row as the store sends it: nulls are cells left alone. */
const ROW = ["'Turf 01", '120', '64', "'35536745-88712", "'Dana", null, '09/19/2026'];

function tokenResponse(): Response {
	return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
		status: 200,
	});
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

/** A write that matched one tagged row. */
const WROTE = () => ok({ totalUpdatedRows: 1 });

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

		await client.writeTaggedRow({ spreadsheetId: 'sheet-1', key: 'k', value: '41', row: ROW });

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

		await client.writeTaggedRow({ spreadsheetId: 'a', key: 'k', value: '1', row: ROW });
		await client.writeTaggedRow({ spreadsheetId: 'b', key: 'k', value: '2', row: ROW });

		const tokenCalls = fetchFn.mock.calls.filter(
			([url]) => url === 'https://oauth2.googleapis.com/token',
		);
		expect(tokenCalls).toHaveLength(1);
	});

	// readTab sends its two reads in parallel; a cold client must not mint a
	// token for each.
	it('mints one token for parallel requests on a cold client', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
			if (url.includes('/values/')) return ok({ values: [] });
			return ok({ sheets: [{ properties: { sheetId: 7, title: 'Packet Tracker' } }] });
		});
		const client = createSheetsClient(CONFIG, { fetchFn: fetchFn as typeof fetch });

		await client.readTab({ spreadsheetId: 'a', tabName: 'Packet Tracker' });

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

		const res = await client.writeTaggedRow({ spreadsheetId: 'a', key: 'k', value: '1', row: ROW });

		expect(res.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('readTab', () => {
	it('returns the tab id and its rows as displayed', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
			if (url.includes('/values/'))
				return ok({
					values: [
						['Packet Name', 'Voters'],
						['Turf 01', 120],
					],
				});
			return ok({
				sheets: [
					{ properties: { sheetId: 1, title: 'Walk Sheet' } },
					{ properties: { sheetId: 7, title: 'Packet Tracker' } },
				],
			});
		});
		const client = createSheetsClient(CONFIG, { fetchFn: fetchFn as typeof fetch });

		const res = await client.readTab({ spreadsheetId: 'sheet-1', tabName: 'Packet Tracker' });

		expect(res).toEqual({
			ok: true,
			value: {
				sheetId: 7,
				values: [
					['Packet Name', 'Voters'],
					['Turf 01', '120'],
				],
			},
		});
		const valuesUrl = fetchFn.mock.calls.map(([u]) => u).find((u) => u.includes('/values/'))!;
		expect(valuesUrl).toContain(encodeURIComponent("'Packet Tracker'"));
		expect(valuesUrl).toContain('valueRenderOption=FORMATTED_VALUE');
	});

	// The tab is the campaign's. The old log created its own; this must not.
	it('reports a missing tab as a 404 and creates nothing', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
			if (url.includes('/values/')) {
				return new Response(JSON.stringify({ error: { message: 'Unable to parse range' } }), {
					status: 400,
				});
			}
			return ok({ sheets: [{ properties: { sheetId: 1, title: 'Walk Sheet' } }] });
		});
		const client = createSheetsClient(CONFIG, { fetchFn: fetchFn as typeof fetch });

		const res = await client.readTab({ spreadsheetId: 'sheet-1', tabName: 'Packet Tracker' });

		expect(res).toMatchObject({ ok: false, status: 404 });
		expect(fetchFn.mock.calls.some(([url]) => url.includes(':batchUpdate'))).toBe(false);
	});

	it('quotes a tab name containing an apostrophe rather than breaking the range', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
			if (url.includes('/values/')) return ok({ values: [] });
			return ok({ sheets: [{ properties: { sheetId: 7, title: "Dana's Tracker" } }] });
		});
		const client = createSheetsClient(CONFIG, { fetchFn: fetchFn as typeof fetch });

		await client.readTab({ spreadsheetId: 'sheet-1', tabName: "Dana's Tracker" });

		const valuesUrl = fetchFn.mock.calls.map(([u]) => u).find((u) => u.includes('/values/'))!;
		expect(valuesUrl).toContain(encodeURIComponent("'Dana''s Tracker'"));
	});
});

describe('findTaggedRows', () => {
	it('searches by key and returns each row with its current position', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				ok({
					matchedDeveloperMetadata: [
						{
							developerMetadata: {
								metadataValue: '41',
								location: { dimensionRange: { sheetId: 7, startIndex: 12 } },
							},
						},
						// A tag somebody's copy-paste put on a column is not a row.
						{ developerMetadata: { metadataValue: '42', location: {} } },
					],
				}),
			);
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.findTaggedRows({ spreadsheetId: 'sheet-1', key: 'k' });

		expect(res).toEqual({ ok: true, value: [{ value: '41', sheetId: 7, rowIndex: 12 }] });
		const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect(url).toContain('/developerMetadata:search');
		expect(JSON.parse(init.body as string)).toEqual({
			dataFilters: [{ developerMetadataLookup: { metadataKey: 'k' } }],
		});
	});
});

describe('insertTaggedRow', () => {
	it('inserts and tags the row in one atomic batch', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(ok({}));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.insertTaggedRow({
			spreadsheetId: 'sheet-1',
			sheetId: 7,
			rowIndex: 30,
			key: 'k',
			value: '41',
		});

		expect(res).toEqual({ ok: true, value: true });
		const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect(url).toContain('/spreadsheets/sheet-1:batchUpdate');
		const range = { sheetId: 7, dimension: 'ROWS', startIndex: 30, endIndex: 31 };
		expect(JSON.parse(init.body as string)).toEqual({
			requests: [
				{ insertDimension: { range, inheritFromBefore: true } },
				{
					createDeveloperMetadata: {
						developerMetadata: {
							metadataKey: 'k',
							metadataValue: '41',
							visibility: 'DOCUMENT',
							location: { dimensionRange: range },
						},
					},
				},
			],
		});
	});
});

describe('writeTaggedRow', () => {
	it('writes by tag, USER_ENTERED, with nulls left in place', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(WROTE());
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.writeTaggedRow({
			spreadsheetId: 'sheet-1',
			key: 'k',
			value: '41',
			row: ROW,
		});

		expect(res).toEqual({ ok: true, value: { found: true } });
		const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
		expect(url).toContain('/values:batchUpdateByDataFilter');
		expect(JSON.parse(init.body as string)).toEqual({
			valueInputOption: 'USER_ENTERED',
			data: [
				{
					dataFilter: { developerMetadataLookup: { metadataKey: 'k', metadataValue: '41' } },
					majorDimension: 'ROWS',
					values: [ROW],
				},
			],
		});
	});

	it('says when no row carries the tag', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(ok({ totalUpdatedRows: 0 }));
		const client = createSheetsClient(CONFIG, { fetchFn });

		const res = await client.writeTaggedRow({
			spreadsheetId: 'sheet-1',
			key: 'k',
			value: '41',
			row: ROW,
		});

		expect(res).toEqual({ ok: true, value: { found: false } });
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

		const res = await client.writeTaggedRow({
			spreadsheetId: 'sheet-1',
			key: 'k',
			value: '41',
			row: ROW,
		});

		expect(res).toMatchObject({ ok: false, status: 403 });
		expect(res.ok === false && res.error).toContain('does not have permission');
		// Token + one write. No second attempt.
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('does not start a request with no time left in the run', async () => {
		const fetchFn = vi.fn();
		const client = createSheetsClient(CONFIG, { fetchFn, now: () => 1_000 });

		const res = await client.writeTaggedRow({
			spreadsheetId: 'sheet-1',
			key: 'k',
			value: '41',
			row: ROW,
			deadline: 1_500,
		});

		expect(res.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
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

		await client.writeTaggedRow({ spreadsheetId: 'sheet-1', key: 'k', value: '41', row: ROW });

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
