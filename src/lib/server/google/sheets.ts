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
// The rows read through here carry canvassers' names and MiniVAN printed list
// numbers, and the cells written carry a volunteer's display name. The list
// number is a CREDENTIAL — it is what pulls a turf's doors down in MiniVAN —
// which is why refresh-reconcile deliberately keeps it out of retained logs
// even while changing it. Nothing in this file may log cell contents, at any
// level. Counts, spreadsheet ids, tab names and HTTP status codes only.
//
// Sending a volunteer's name to the campaign's spreadsheet is a deliberate decision
// recorded in specs/011-turf-checkout-sheet/spec.md and PRIVACY.md: anyone with
// access to that spreadsheet can read them. It is not an implementation detail
// and PRIVACY.md must stay accurate about it.
// ─────────────────────────────────────────────────────────────────────────
//
// The app only ever writes cells on rows the campaign already has: it never
// adds, deletes or moves a row (see $lib/van/packet-tracker.ts). Writes are by
// row number, so the caller re-reads the row first and checks it is still the
// packet it means.
//
// Never throws. A Google outage must not fail a sync whose rows are already
// written — every call returns a result the caller can act on, and the ledger
// keeps what is unsent so a later run retries it.

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** The status a call reports when the run's deadline left no time to make
 *  it. Not an answer from Google: nothing was sent, and the caller should
 *  simply try again next run. */
export const OUT_OF_TIME = 408;

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

export interface SheetsClient {
	/**
	 * Every row of the tab, as displayed, in a single read.
	 *
	 * One request because Google caps this service account at 60 reads a
	 * minute — a hard limit — and the sync reads every one of the campaign's
	 * few dozen spreadsheets. A missing tab is a 404 rather than a created one:
	 * the tab is the campaign's.
	 */
	readTab(input: {
		spreadsheetId: string;
		tabName: string;
		deadline?: number;
	}): Promise<SheetsResult<string[][]>>;
	/** One row, as displayed — the check just before a write that the row is
	 *  still the packet the caller means. `rowIndex` is 0-based. */
	readRow(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		deadline?: number;
	}): Promise<SheetsResult<string[]>>;
	/** Write single cells on one row, USER_ENTERED, in one request. Cells not
	 *  named are left alone. `[columnIndex, value]`, both 0-based. */
	writeCells(input: {
		spreadsheetId: string;
		tabName: string;
		rowIndex: number;
		cells: ReadonlyArray<readonly [number, string]>;
		deadline?: number;
	}): Promise<SheetsResult<true>>;
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

/** A1 column letters for a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
	let n = index + 1;
	let letters = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		letters = String.fromCharCode(65 + rem) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}

/** Google answers a range naming a tab that is not there with a 400. */
function missingTab<T>(
	res: { ok: false; status: number; error: string },
	tabName: string,
): SheetsResult<T> {
	if (res.status === 400 && /unable to parse range/i.test(res.error)) {
		return { ok: false, status: 404, error: `the spreadsheet has no "${tabName}" tab` };
	}
	return res;
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
			return { ok: false, status: OUT_OF_TIME, error: 'no time left in the run to mint a token' };
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
				return {
					ok: false,
					status: OUT_OF_TIME,
					error: 'no time left in the run for this request',
				};
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
			const res = await request(
				`${base(spreadsheetId)}/values/${encodeURIComponent(tabRange(tabName))}` +
					`?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
				{ method: 'GET' },
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			const body = parseJson<{ values?: unknown[][] }>(res.value);
			return {
				ok: true,
				value: (body?.values ?? []).map((row) => row.map((cell) => String(cell ?? ''))),
			};
		},

		async readRow({ spreadsheetId, tabName, rowIndex, deadline }) {
			const row = rowIndex + 1;
			const res = await request(
				`${base(spreadsheetId)}/values/${encodeURIComponent(`${tabRange(tabName)}!${row}:${row}`)}` +
					`?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
				{ method: 'GET' },
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			const body = parseJson<{ values?: unknown[][] }>(res.value);
			return { ok: true, value: (body?.values?.[0] ?? []).map((cell) => String(cell ?? '')) };
		},

		async writeCells({ spreadsheetId, tabName, rowIndex, cells, deadline }) {
			if (cells.length === 0) return { ok: true, value: true };
			const res = await request(
				`${base(spreadsheetId)}/values:batchUpdate`,
				{
					method: 'POST',
					body: JSON.stringify({
						valueInputOption: 'USER_ENTERED',
						data: cells.map(([column, value]) => ({
							range: `${tabRange(tabName)}!${columnLetter(column)}${rowIndex + 1}`,
							values: [[value]],
						})),
					}),
				},
				deadline,
			);
			if (!res.ok) return missingTab(res, tabName);
			return { ok: true, value: true };
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
