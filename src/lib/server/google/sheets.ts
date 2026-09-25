// Reading and writing the campaign's Packet Tracker tab, as a service account.
//
// Written like van/client.ts and geocode-batch.ts: config and `fetch` are
// injected and nothing here imports `$env` or `$lib/server`, so it runs under
// `tsx` in scripts/ as well as inside the app. google-env.ts is the one place
// that turns environment into a config object.
//
// ─────────────────────────────────────────────────────────────────────────
// PRIVACY. Read this before changing the logging.
//
// The rows passed through here carry a volunteer's display name and the
// MiniVAN printed list number they were issued. The list number is a
// CREDENTIAL — it is what pulls a turf's doors down in MiniVAN — which is why
// refresh-reconcile deliberately keeps it out of retained logs even while
// changing it. Nothing in this file may log cell contents, at any level. Counts,
// spreadsheet ids, tab names and HTTP status codes only.
//
// Sending them to the campaign's spreadsheet at all is a deliberate decision
// recorded in specs/011-turf-checkout-sheet/spec.md and PRIVACY.md: anyone with
// access to that spreadsheet can read them. It is not an implementation detail
// and PRIVACY.md must stay accurate about it.
// ─────────────────────────────────────────────────────────────────────────
//
// Rows this app writes carry a developer-metadata tag (see
// $lib/van/packet-tracker.ts). Writes to an existing row go through that tag
// rather than a row number, so Google resolves which row is meant at the moment
// of the write and a sort or insert by someone else cannot redirect them. There
// is deliberately no delete: the API only deletes by position, and a position
// cannot be made safe (see the header of packet-tracker.ts).
//
// Never throws. A Google outage must not fail a sync whose rows are already
// written — every call returns a result the caller can act on, and the ledger
// keeps what is unsent so a later run retries it.

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Generous, and still bounded so a hung request cannot eat the sync's budget.
 *  A CEILING, not the budget: a caller passing a deadline gets whichever is
 *  smaller. */
const TIMEOUT_MS = 30_000;
/** Below this there is not enough time left to get an answer, so the call is
 *  not started and the events wait for the next run. */
const MIN_REQUEST_MS = 3_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;

/** Refresh this long before the token actually expires, so a token minted at
 *  the top of a run cannot lapse midway through it. */
const TOKEN_SKEW_MS = 60_000;

export type FetchFn = typeof fetch;

/** The fields this needs out of a service-account JSON key. */
export interface ServiceAccountConfig {
	clientEmail: string;
	/** PEM, as Google issues it. */
	privateKey: string;
}

export interface SheetsClientOptions {
	fetchFn?: FetchFn;
	/** Overridable for tests. */
	now?: () => number;
}

/** Every call returns one of these rather than throwing. `status` is 0 for a
 *  network-level failure, which reads differently from any HTTP answer. */
export type SheetsResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** One row this app tagged. `rowIndex` is 0-based and true only at the moment
 *  of the search — never write by it. */
export interface TaggedRow {
	value: string;
	sheetId: number;
	rowIndex: number;
}

export interface SheetsClient {
	/** The tab's numeric id and every row of it, as displayed. A missing tab is
	 *  a 404 rather than a created one: the tab is the campaign's. */
	readTab(input: {
		spreadsheetId: string;
		tabName: string;
		deadline?: number;
	}): Promise<SheetsResult<{ sheetId: number; values: string[][] }>>;
	/** Every row in the spreadsheet carrying `key`. */
	findTaggedRows(input: {
		spreadsheetId: string;
		key: string;
		deadline?: number;
	}): Promise<SheetsResult<TaggedRow[]>>;
	/** Insert an empty row at `rowIndex` and tag it, in one atomic batch — so
	 *  there is never an untagged row of ours, and never a tag on a row that is
	 *  not. Inserting only shifts other rows down; it overwrites nothing. */
	insertTaggedRow(input: {
		spreadsheetId: string;
		sheetId: number;
		rowIndex: number;
		key: string;
		value: string;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
	/** Write cells into the row tagged `key`=`value`, USER_ENTERED. `null`
	 *  cells are left as they are. `found: false` when no row has that tag. */
	writeTaggedRow(input: {
		spreadsheetId: string;
		key: string;
		value: string;
		row: readonly (string | null)[];
		deadline?: number;
	}): Promise<SheetsResult<{ found: boolean }>>;
	/** Whether the spreadsheet is reachable and whether it already has the tab.
	 *  Read-only — what `sheets:check` uses to tell "never shared with us" from
	 *  "shared, no tab" without writing anything. */
	describe(input: {
		spreadsheetId: string;
		tabName: string;
		deadline?: number;
	}): Promise<SheetsResult<{ title: string; hasTab: boolean; tabs: string[] }>>;
}

function base64url(input: string | Buffer): string {
	return Buffer.from(input)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	const parsed = parseInt(retryAfter ?? '', 10);
	if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
	return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Google's error envelope is `{error: {message, status}}`; a proxy's 502 is
 *  HTML. Both have to produce something an operator can read. */
function parseError(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
		const message = parsed.error?.message;
		if (message) return message;
	} catch {
		// fall through
	}
	return body.slice(0, 300);
}

/** A whole-tab range for the values API. The tab name is quoted because the
 *  campaign's have spaces in them, and a single quote inside it would otherwise
 *  end the quoting early. */
function tabRange(tabName: string): string {
	return `'${tabName.replace(/'/g, "''")}'`;
}

function parseJson<T>(body: string): T | null {
	try {
		return JSON.parse(body) as T;
	} catch {
		return null;
	}
}

export function createSheetsClient(
	config: ServiceAccountConfig,
	options: SheetsClientOptions = {},
): SheetsClient {
	const fetchFn = options.fetchFn ?? fetch;
	const now = options.now ?? Date.now;

	/** Cached across every spreadsheet in a run — one token serves them all. */
	let token: { value: string; expiresAt: number } | null = null;

	function budget(deadline: number | undefined): number {
		if (deadline === undefined) return TIMEOUT_MS;
		return Math.min(TIMEOUT_MS, deadline - now());
	}

	/** Mint a bearer token with the signed-JWT grant.
	 *
	 *  RS256 over the service account's private key. This is the only
	 *  asymmetric signing in the repo — everything else (oauth-state,
	 *  webhook-token) is HMAC — so it is written out rather than reached for
	 *  from a library: `googleapis` would be a large dependency for one POST. */
	async function accessToken(deadline?: number): Promise<SheetsResult<string>> {
		const cached = token;
		if (cached && cached.expiresAt - TOKEN_SKEW_MS > now()) {
			return { ok: true, value: cached.value };
		}
		// Reads go out in parallel, and without this each would mint its own
		// token on a cold client.
		if (minting) return minting;
		minting = mintToken(deadline).finally(() => {
			minting = null;
		});
		return minting;
	}

	let minting: Promise<SheetsResult<string>> | null = null;

	async function mintToken(deadline?: number): Promise<SheetsResult<string>> {
		const issuedAt = Math.floor(now() / 1000);
		const claims = {
			iss: config.clientEmail,
			scope: SCOPE,
			aud: TOKEN_URL,
			iat: issuedAt,
			exp: issuedAt + 3600,
		};
		const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
			JSON.stringify(claims),
		)}`;

		let assertion: string;
		try {
			const signer = createSign('RSA-SHA256');
			signer.update(signingInput);
			assertion = `${signingInput}.${signer.sign(config.privateKey, 'base64url')}`;
		} catch (err) {
			// A malformed private key fails here, every time, until someone fixes
			// the secret. Reported rather than retried.
			return {
				ok: false,
				status: 0,
				error: `could not sign the token request: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		const timeoutMs = budget(deadline);
		if (timeoutMs < MIN_REQUEST_MS) {
			return { ok: false, status: 0, error: 'no time left in the run to mint a token' };
		}

		let res: Response;
		try {
			res = await fetchFn(TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			return {
				ok: false,
				status: 0,
				error: `token request failed: ${err instanceof Error ? err.name : String(err)}`,
			};
		}

		const body = await res.text().catch(() => '');
		if (!res.ok) {
			console.warn(`[sheets] token request returned ${res.status}`);
			return { ok: false, status: res.status, error: parseError(body) };
		}

		let parsed: { access_token?: string; expires_in?: number };
		try {
			parsed = JSON.parse(body) as typeof parsed;
		} catch {
			return { ok: false, status: res.status, error: 'token response was not JSON' };
		}
		if (!parsed.access_token) {
			return { ok: false, status: res.status, error: 'token response carried no access_token' };
		}

		token = {
			value: parsed.access_token,
			expiresAt: now() + (parsed.expires_in ?? 3600) * 1000,
		};
		return { ok: true, value: token.value };
	}

	/** One authenticated request, retrying 429 and 5xx. Other 4xx answers come
	 *  straight back: a 403 means the spreadsheet was never shared with the
	 *  service account, and retrying it three more times just spends the run's
	 *  budget on an answer that will not change. */
	async function request(
		url: string,
		init: RequestInit,
		deadline?: number,
	): Promise<SheetsResult<string>> {
		const auth = await accessToken(deadline);
		if (!auth.ok) return auth;

		let lastError = 'request failed';
		let lastStatus = 0;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const isLast = attempt === MAX_ATTEMPTS - 1;
			const timeoutMs = budget(deadline);
			if (timeoutMs < MIN_REQUEST_MS) {
				return { ok: false, status: lastStatus, error: 'no time left in the run for this write' };
			}

			let res: Response;
			try {
				res = await fetchFn(url, {
					...init,
					headers: {
						...init.headers,
						Authorization: `Bearer ${auth.value}`,
						'Content-Type': 'application/json',
					},
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				lastError = `network failure: ${err instanceof Error ? err.name : String(err)}`;
				lastStatus = 0;
				if (!isLast) await new Promise((r) => setTimeout(r, backoffMs(attempt, null)));
				continue;
			}

			const body = await res.text().catch(() => '');
			if (res.ok) return { ok: true, value: body };

			lastStatus = res.status;
			lastError = parseError(body);
			if (res.status === 429 || res.status >= 500) {
				if (!isLast) {
					const wait = backoffMs(attempt, res.headers.get('Retry-After'));
					console.warn(`[sheets] ${res.status} — retrying in ${Math.round(wait / 1000)}s`);
					await new Promise((r) => setTimeout(r, wait));
				}
				continue;
			}
			return { ok: false, status: res.status, error: lastError };
		}
		return { ok: false, status: lastStatus, error: lastError };
	}

	const base = (spreadsheetId: string) => `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}`;

	return {
		async readTab({ spreadsheetId, tabName, deadline }) {
			const [meta, values] = await Promise.all([
				request(
					`${base(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
					{ method: 'GET' },
					deadline,
				),
				request(
					`${base(spreadsheetId)}/values/${encodeURIComponent(tabRange(tabName))}` +
						`?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
					{ method: 'GET' },
					deadline,
				),
			]);
			if (!meta.ok) return meta;
			const parsed = parseJson<{
				sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
			}>(meta.value);
			const tab = parsed?.sheets?.find((s) => s.properties?.title === tabName);
			if (!tab || typeof tab.properties?.sheetId !== 'number') {
				return { ok: false, status: 404, error: `the spreadsheet has no "${tabName}" tab` };
			}
			if (!values.ok) return values;
			const body = parseJson<{ values?: unknown[][] }>(values.value);
			return {
				ok: true,
				value: {
					sheetId: tab.properties.sheetId,
					values: (body?.values ?? []).map((row) => row.map((cell) => String(cell ?? ''))),
				},
			};
		},

		async findTaggedRows({ spreadsheetId, key, deadline }) {
			const res = await request(
				`${base(spreadsheetId)}/developerMetadata:search`,
				{
					method: 'POST',
					body: JSON.stringify({
						dataFilters: [{ developerMetadataLookup: { metadataKey: key } }],
					}),
				},
				deadline,
			);
			if (!res.ok) return res;
			const body = parseJson<{
				matchedDeveloperMetadata?: Array<{
					developerMetadata?: {
						metadataValue?: string;
						location?: { dimensionRange?: { sheetId?: number; startIndex?: number } };
					};
				}>;
			}>(res.value);
			const rows: TaggedRow[] = [];
			for (const match of body?.matchedDeveloperMetadata ?? []) {
				const meta = match.developerMetadata;
				const range = meta?.location?.dimensionRange;
				if (!meta?.metadataValue || typeof range?.sheetId !== 'number') continue;
				rows.push({
					value: meta.metadataValue,
					sheetId: range.sheetId,
					rowIndex: range.startIndex ?? 0,
				});
			}
			return { ok: true, value: rows };
		},

		async insertTaggedRow({ spreadsheetId, sheetId, rowIndex, key, value, deadline }) {
			const range = { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 };
			const res = await request(
				`${base(spreadsheetId)}:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						requests: [
							// Inherit from the row above: the campaign's dropdowns and
							// formats come with it.
							{ insertDimension: { range, inheritFromBefore: rowIndex > 0 } },
							{
								createDeveloperMetadata: {
									developerMetadata: {
										metadataKey: key,
										metadataValue: value,
										visibility: 'DOCUMENT',
										location: { dimensionRange: range },
									},
								},
							},
						],
					}),
				},
				deadline,
			);
			if (!res.ok) return res;
			return { ok: true, value: true };
		},

		async writeTaggedRow({ spreadsheetId, key, value, row, deadline }) {
			const res = await request(
				`${base(spreadsheetId)}/values:batchUpdateByDataFilter`,
				{
					method: 'POST',
					body: JSON.stringify({
						valueInputOption: 'USER_ENTERED',
						data: [
							{
								dataFilter: {
									developerMetadataLookup: { metadataKey: key, metadataValue: value },
								},
								majorDimension: 'ROWS',
								values: [row],
							},
						],
					}),
				},
				deadline,
			);
			if (!res.ok) return res;
			const body = parseJson<{ totalUpdatedRows?: number; responses?: unknown[] }>(res.value);
			// Google answers a filter that matched nothing with 200 and nothing
			// updated — which is also what an all-null row looks like, so that
			// case is decided by the caller never sending one.
			return { ok: true, value: { found: (body?.totalUpdatedRows ?? 0) > 0 } };
		},

		async describe({ spreadsheetId, tabName, deadline }) {
			const res = await request(
				`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
				{ method: 'GET' },
				deadline,
			);
			if (!res.ok) return res;
			try {
				const parsed = JSON.parse(res.value) as {
					properties?: { title?: string };
					sheets?: Array<{ properties?: { title?: string } }>;
				};
				const tabs = (parsed.sheets ?? [])
					.map((s) => s.properties?.title ?? '')
					.filter((t): t is string => Boolean(t));
				return {
					ok: true,
					value: {
						title: parsed.properties?.title ?? '',
						hasTab: tabs.includes(tabName),
						tabs,
					},
				};
			} catch {
				return { ok: false, status: 0, error: 'spreadsheet metadata was not JSON' };
			}
		},
	};
}
