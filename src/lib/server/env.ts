// Environment variable exports and startup validation.
// Uses $env/dynamic/private so Vite's .env/.env.local loading works in dev.
// Call validateEnv() from hooks.server.ts init() — never at module level.

import { env } from '$env/dynamic/private';
import { parseEncryptionKey } from './token-crypto.js';

const get = (key: string) => (env as Record<string, string | undefined>)[key] ?? '';

/**
 * Numeric env vars, falling back on anything that is not a finite number.
 *
 * `parseInt(get(KEY) || '25', 10)` — the shape these used to have — only
 * rescues the EMPTY string. A junk value (`MOBILIZE_SYNC_MAX_CREATES=unlimited`,
 * or a stray space) parses to NaN and propagates, and NaN is the worst possible
 * value for a guardrail: every `count > NaN` comparison is false, so a cap set
 * to NaN silently stops capping instead of failing loudly. Falling back to the
 * documented default keeps a mistyped value safe rather than unbounded.
 */
function intEnv(key: string, fallback: number): number {
	const parsed = parseInt(get(key), 10);
	if (!Number.isFinite(parsed)) {
		if (get(key) !== '') {
			console.warn(`[env] ${key} is not a number: "${get(key)}" — using ${fallback}`);
		}
		return fallback;
	}
	return parsed;
}

function floatEnv(key: string, fallback: number): number {
	const parsed = parseFloat(get(key));
	if (!Number.isFinite(parsed)) {
		if (get(key) !== '') {
			console.warn(`[env] ${key} is not a number: "${get(key)}" — using ${fallback}`);
		}
		return fallback;
	}
	return parsed;
}

export const SLACK_BOT_TOKEN = get('SLACK_BOT_TOKEN');
export const SLACK_CLIENT_ID = get('SLACK_CLIENT_ID');
export const SLACK_CLIENT_SECRET = get('SLACK_CLIENT_SECRET');
export const SLACK_SIGNING_SECRET = get('SLACK_SIGNING_SECRET');
export const SLACK_ALLOWED_USER_IDS = new Set(
	get('SLACK_ALLOWED_USER_IDS')
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean),
);
// Slack user id that is ALWAYS granted admin, regardless of the DB-backed
// allowed_slack_users list (or its SLACK_ALLOWED_USER_IDS fallback) — even
// when that list is empty or unreadable. Escape hatch so a mis-edited allowed
// list can never lock every admin out of /pending and /settings.
export const SLACK_SUPERUSER_ID = get('SLACK_SUPERUSER_ID');
export const SLACK_TRACKING_CHANNEL_ID = get('SLACK_TRACKING_CHANNEL_ID');
export const SLACK_GROWTH_REPORT_CHANNEL_ID = get('SLACK_GROWTH_REPORT_CHANNEL_ID');
// Comma-separated list of Solidarity chapter IDs to omit from reports — both
// the weekly growth leaderboard and the dashboard charts (e.g. test chapters,
// internal-only chapters).
export const REPORT_EXCLUDED_CHAPTER_IDS = new Set(
	get('REPORT_EXCLUDED_CHAPTER_IDS')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n)),
);
// Power-law exponent for the weekly growth ranking score:
//   score = newJoins / (existing + 1) ^ alpha
// Smaller value favors larger chapters; larger value (toward 1) is closer to
// pure rate. See weekly-growth-report.ts for the full rationale. Returns
// undefined if unset/unparseable so the function falls back to its default.
export const SLACK_GROWTH_REPORT_RANKING_ALPHA: number | undefined = (() => {
	const raw = get('SLACK_GROWTH_REPORT_RANKING_ALPHA');
	if (!raw) return undefined;
	const parsed = parseFloat(raw);
	if (!Number.isFinite(parsed)) {
		console.warn(
			`[env] SLACK_GROWTH_REPORT_RANKING_ALPHA is not a valid number: "${raw}" — using default`,
		);
		return undefined;
	}
	return parsed;
})();
// Base64-encoded 32-byte key for the per-user Slack tokens in
// `slack_user_tokens` (see token-crypto.ts). Generate with:
//   openssl rand -base64 32
// Rotating it does not break logins — it invalidates every stored token, and
// each admin re-authorizes the next time they run an info command.
export const TOKEN_ENCRYPTION_KEY = get('TOKEN_ENCRYPTION_KEY');

export const TURSO_DATABASE_URL = get('TURSO_DATABASE_URL');
export const TURSO_AUTH_TOKEN = get('TURSO_AUTH_TOKEN');
export const WEBHOOK_SECRET = get('WEBHOOK_SECRET');
export const APP_URL = get('APP_URL');
export const PORT = intEnv('PORT', 3000);
export const REDIRECT_URI = `${APP_URL}/auth/slack/callback`;

export const SOLIDARITY_API_TOKEN = get('SOLIDARITY_API_TOKEN');

// Mobilize v1 API credentials, shared by both syncs (events out, attendees back).
//
// The key must have write ("restricted") access granted by Mobilize — creating
// events and uploading images both need it. Unlike the browser session this
// replaced, it does not expire on its own; a 403 means it was revoked, mistyped,
// or never had that grant. Set it with `fly secrets set MOBILIZE_API_KEY=...`.
export const MOBILIZE_API_KEY = get('MOBILIZE_API_KEY');
// No default: syncing into the wrong organization publishes events under
// someone else's name, so an unset value has to stop the run rather than guess.
export const MOBILIZE_ORG_ID = parseInt(get('MOBILIZE_ORG_ID'), 10);

// Contact shown on synced events. Required by the API on every create and
// update, and Solidarity events carry no contact data of their own, so this is
// the fallback under the /settings value.
export const MOBILIZE_CONTACT_NAME = get('MOBILIZE_CONTACT_NAME');
export const MOBILIZE_CONTACT_EMAIL = get('MOBILIZE_CONTACT_EMAIL');
export const MOBILIZE_CONTACT_PHONE = get('MOBILIZE_CONTACT_PHONE');
// Blast-radius guard: if one night's plan wants more new events than this, the
// sync creates nothing and alerts instead. A flood means dedup or the source
// data broke, and these events are publicly visible once created.
export const MOBILIZE_SYNC_MAX_CREATES = intEnv('MOBILIZE_SYNC_MAX_CREATES', 25);

// Attendee sync (Mobilize signups -> Solidarity RSVPs).
// Last-resort chapter for a new profile when the person's zip isn't in the
// derived zip->chapter map and the event isn't chapter-scoped. Leave unset to
// have such people reported instead of filed under a guess.
export const SOLIDARITY_DEFAULT_CHAPTER_ID = intEnv('SOLIDARITY_DEFAULT_CHAPTER_ID', 0);
// Guardrail: a run creating more than this many NEW Solidarity profiles stops.
// A spike almost always means matching is failing, and the damage — duplicate
// person records in the CRM — is tedious to undo.
export const ATTENDEE_SYNC_MAX_NEW_PROFILES = intEnv('ATTENDEE_SYNC_MAX_NEW_PROFILES', 50);

// Match-health thresholds (see attendee-sync-health.ts). These alert; they never
// stop a run — ATTENDEE_SYNC_MAX_NEW_PROFILES above is the only thing that does.
//
// Defaults come from measured runs rather than intuition. Real passes matched
// 18% and 27% of signups, so the 10% floor sits below anything observed and
// warns only on a genuine collapse. Ambiguous lookups measured 0 of 111, which
// is why a quarter of them is already an alarm.
export const ATTENDEE_SYNC_MIN_MATCH_RATE = floatEnv('ATTENDEE_SYNC_MIN_MATCH_RATE', 0.1);
export const ATTENDEE_SYNC_MATCH_RATE_MIN_SAMPLE = intEnv(
	'ATTENDEE_SYNC_MATCH_RATE_MIN_SAMPLE',
	25,
);
export const ATTENDEE_SYNC_MAX_AMBIGUOUS_RATE = floatEnv('ATTENDEE_SYNC_MAX_AMBIGUOUS_RATE', 0.25);
export const ATTENDEE_SYNC_AMBIGUOUS_MIN_SAMPLE = intEnv('ATTENDEE_SYNC_AMBIGUOUS_MIN_SAMPLE', 8);

// Shared secret for internal cron-triggered endpoints (e.g. nightly snapshot).
// Callers pass it as ?key=<value>.
export const INTERNAL_CRON_SECRET = get('INTERNAL_CRON_SECRET');

// Which canvassing tool supplies the door-knock numbers (see
// door-knock-env.ts). Empty means "openfield", so existing deployments need no
// new variable.
export const DOOR_KNOCK_PROVIDER = get('DOOR_KNOCK_PROVIDER').trim().toLowerCase();

// Openfield door-knocking integration (all four required for the nightly
// door-knock snapshot; the endpoint 500s with a clear message when unset).
// OPENFIELD_BASE_URL e.g. https://your-org.openfield.ai (no trailing /).
// The username/password belong to a dedicated service account — the snapshot
// logs in like a volunteer to read per-conversation leaderboards.
// DOOR_KNOCK_CHANNEL_ID is the Slack channel whose "Conversation Codes"
// canvas tab lists the active codes (e.g. #door-knocking).
export const OPENFIELD_BASE_URL = get('OPENFIELD_BASE_URL').replace(/\/+$/, '');
export const OPENFIELD_USERNAME = get('OPENFIELD_USERNAME');
export const OPENFIELD_PASSWORD = get('OPENFIELD_PASSWORD');
export const DOOR_KNOCK_CHANNEL_ID = get('DOOR_KNOCK_CHANNEL_ID');

// NGP VAN / VoteBuilder turf checkout (see src/lib/server/van-env.ts and
// specs/010-van-turf-checkout/plan.md). All optional: the app must boot and
// run fine with VAN unconfigured, the way it does without Openfield.
//
// VAN_APP_NAME is the Application Name EveryAction issued alongside the key —
// it is the HTTP Basic *username*, not a display string, and a wrong value
// authenticates as nobody.
// VAN_DATABASE_MODE selects which database the key reads: 0 = My Voters,
// 1 = My Campaign. There is no safe default. Picking the wrong one does not
// error — it authenticates and returns a different, mostly empty database —
// so van-env.ts requires it explicitly rather than assuming 0.
export const VAN_APP_NAME = get('VAN_APP_NAME');
export const VAN_API_KEY = get('VAN_API_KEY');
export const VAN_DATABASE_MODE = get('VAN_DATABASE_MODE').trim();
// Export job type id for the coordinates-only export that feeds hull geometry.
// EveryAction issues these per developer, so the `101` in VAN's docs is an
// example — discover the real one with `npm run van:check`. Unset is fine:
// the catalog sync runs without it and only geometry is skipped.
export const VAN_EXPORT_JOB_TYPE_ID = intEnv('VAN_EXPORT_JOB_TYPE_ID', 0);

// Basemap tiles for the turf map. Defaults to CARTO's keyless Positron
// endpoint, which is what the demo has always used.
//
// Configurable because a keyless endpoint is courtesy, not an SLA, and a
// canvass launch is the worst possible moment to discover a rate limit. Moving
// to a keyed account (CARTO, Stadia, Protomaps, or self-hosted) should be a
// secret to set, not a deploy — so the URL and its attribution live here
// rather than as constants in the component. Attribution is a condition of use
// for every provider worth using; change both together.
export const MAP_TILE_URL_TEMPLATE = get('MAP_TILE_URL_TEMPLATE');
export const MAP_TILE_ATTRIBUTION = get('MAP_TILE_ATTRIBUTION');
// CARTO basemaps API key, appended to the tile URL as `?key=` (see
// van/tiles.ts). Set it to move off the keyless endpoint without touching the
// template — the keyed and keyless CARTO URLs are otherwise identical.
//
// Only ever sent to cartocdn.com, even if MAP_TILE_URL_TEMPLATE points
// somewhere else; and public by construction, because the browser is what
// fetches the tiles. Restrict it by domain in the CARTO dashboard.
export const MAP_TILE_API_KEY = get('MAP_TILE_API_KEY');

export interface ChapterEntry {
	chapterId: number;
	channelId: string;
	name: string;
}

// JSON array mapping solidarity chapter IDs to Slack channel IDs and display names.
// Fallback for the /settings chapter↔channel editor: used while the
// chapter_channel_map table is empty, and copied into it before its first
// interactive edit.
// Example: [{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]
export const SOLIDARITY_CHAPTER_CHANNEL_MAP: ChapterEntry[] = (() => {
	try {
		return JSON.parse(get('SOLIDARITY_CHAPTER_CHANNEL_MAP') || '[]') as ChapterEntry[];
	} catch {
		console.error('[env] SOLIDARITY_CHAPTER_CHANNEL_MAP is not valid JSON — defaulting to []');
		return [];
	}
})();

const REQUIRED_VARS = [
	'SLACK_BOT_TOKEN',
	'SLACK_CLIENT_ID',
	'SLACK_CLIENT_SECRET',
	'SLACK_SIGNING_SECRET',
	'SLACK_ALLOWED_USER_IDS',
	'SLACK_TRACKING_CHANNEL_ID',
	'TOKEN_ENCRYPTION_KEY',
	'TURSO_DATABASE_URL',
	'WEBHOOK_SECRET',
	'APP_URL',
] as const;

export function validateEnv(): void {
	for (const key of REQUIRED_VARS) {
		if (!(env as Record<string, string | undefined>)[key]) {
			console.error(`Missing required environment variable: ${key}`);
			process.exit(1);
		}
	}
	// Checked at startup rather than on first use: a truncated or mistyped key
	// otherwise surfaces as a Slack-looking failure the first time an admin runs
	// an info command, long after the deploy that broke it.
	try {
		parseEncryptionKey(TOKEN_ENCRYPTION_KEY);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
	if (!TURSO_DATABASE_URL.startsWith('file:') && !TURSO_AUTH_TOKEN) {
		console.error('Missing required environment variable: TURSO_AUTH_TOKEN');
		process.exit(1);
	}
	if (!SOLIDARITY_API_TOKEN) {
		console.warn(
			'[env] SOLIDARITY_API_TOKEN is not set — the team_join welcome flow will be disabled (every lookup returns null).',
		);
	}
}
