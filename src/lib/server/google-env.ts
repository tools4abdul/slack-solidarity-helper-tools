// Env → the Google Sheets client, and the only file in the app that knows a
// service-account credential exists. Everything under src/lib/server/google/
// takes injected config, so this is the single seam where configuration meets
// the network.
//
// Shaped exactly like van-env.ts: a discriminated result rather than a throw,
// because the app must run normally with the Packet Tracker unconfigured. Most
// deployments of this tool have no campaign spreadsheet at all, and a turf page
// that 500s over a missing Google key would be a far worse outcome than a
// Packet Tracker that simply is not being updated.
//
// Note there is no GOOGLE_SHEET_ID. Which spreadsheet a row goes to is decided
// per turf from the van_sheet_targets rules in /settings — the campaign keeps
// about a dozen, so a single env var naming one would be a second and
// conflicting source of truth.

import { GOOGLE_SHEETS_SERVICE_ACCOUNT } from './env.js';
import {
	createSheetsClient,
	type SheetsClient,
	type ServiceAccountConfig,
} from './google/sheets.js';

export type SheetsClientResult = { ok: true; client: SheetsClient } | { ok: false; error: string };

/**
 * Pull the two fields we need out of a service-account JSON key.
 *
 * Defensive in the same way env.ts's SOLIDARITY_CHAPTER_CHANNEL_MAP parse is:
 * the value is a large blob pasted into a secret by hand, and every way of
 * getting it wrong should name itself rather than surface later as a signing
 * error nobody can place.
 *
 * `private_key` carries literal `\n` escapes when the JSON has been through a
 * shell, which is the single most common way this is mis-set. Unescaping them
 * here rather than asking the operator to get it right is the difference
 * between a secret that works first time and one that needs a debugging
 * session.
 */
function parseServiceAccount(raw: string):
	| { ok: true; config: ServiceAccountConfig }
	| {
			ok: false;
			error: string;
	  } {
	let parsed: { client_email?: unknown; private_key?: unknown; type?: unknown };
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		return { ok: false, error: 'GOOGLE_SHEETS_SERVICE_ACCOUNT is not valid JSON' };
	}
	const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
	const privateKeyRaw = typeof parsed.private_key === 'string' ? parsed.private_key : '';
	if (!clientEmail) {
		return { ok: false, error: 'GOOGLE_SHEETS_SERVICE_ACCOUNT has no client_email' };
	}
	if (!privateKeyRaw) {
		return { ok: false, error: 'GOOGLE_SHEETS_SERVICE_ACCOUNT has no private_key' };
	}
	const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
	if (!privateKey.includes('BEGIN PRIVATE KEY')) {
		return {
			ok: false,
			error: 'GOOGLE_SHEETS_SERVICE_ACCOUNT private_key is not a PEM block',
		};
	}
	return { ok: true, config: { clientEmail, privateKey } };
}

let shared: SheetsClient | null = null;

/** The configured Sheets client, or why there isn't one.
 *
 *  One client per process, because the client caches its access token: the
 *  claim path's live check would otherwise mint a fresh token — an extra round
 *  trip to Google — on every claim. */
export function sheetsClient(): SheetsClientResult {
	if (shared) return { ok: true, client: shared };
	if (!GOOGLE_SHEETS_SERVICE_ACCOUNT) {
		return { ok: false, error: 'GOOGLE_SHEETS_SERVICE_ACCOUNT is not set' };
	}
	const parsed = parseServiceAccount(GOOGLE_SHEETS_SERVICE_ACCOUNT);
	if (!parsed.ok) return parsed;
	shared = createSheetsClient(parsed.config);
	return { ok: true, client: shared };
}

/** The service account's address, for the settings page and the README's
 *  "share each spreadsheet with this" step. Null when unconfigured — an
 *  operator staring at a blank field is better served by "not set" than by an
 *  empty string that looks like a bug. */
export function sheetsServiceAccountEmail(): string | null {
	if (!GOOGLE_SHEETS_SERVICE_ACCOUNT) return null;
	const parsed = parseServiceAccount(GOOGLE_SHEETS_SERVICE_ACCOUNT);
	return parsed.ok ? parsed.config.clientEmail : null;
}
