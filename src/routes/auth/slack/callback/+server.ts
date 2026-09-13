import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { db, sessionStore } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { saveUserToken, deleteUserToken } from '$lib/server/user-tokens.js';
import { slack } from '$lib/server/slack.js';
import {
	OAUTH_REDIRECT_COOKIE,
	resolvePostLoginRedirect,
	sanitizeRedirectTarget,
} from '$lib/server/post-login-redirect.js';
import { verifyState } from '$lib/server/oauth-state.js';
import {
	SLACK_CLIENT_ID,
	SLACK_CLIENT_SECRET,
	SLACK_SUPERUSER_ID,
	REDIRECT_URI,
} from '$lib/server/env.js';

interface SlackOAuthResponse {
	ok: boolean;
	authed_user?: { id?: string; access_token: string; scope?: string };
	error?: string;
}

const SESSION_MAX_AGE = 8 * 60 * 60;

export const GET: RequestHandler = async ({ url, cookies }) => {
	const errorParam = url.searchParams.get('error');
	if (errorParam) {
		console.error('[auth] Slack OAuth error:', errorParam);
		error(403, 'Access denied.');
	}

	const code = url.searchParams.get('code');
	const rawState = url.searchParams.get('state');
	const storedNonce = cookies.get('oauth_state');

	if (!code || !rawState) {
		error(400, 'Invalid OAuth state.');
	}

	const verdict = verifyState(rawState);
	if (!verdict.ok) {
		// A signature that does not check out is the only failure here that means
		// somebody tampered with the round trip. Everything else is a browser
		// being a browser, and earns another go.
		if (verdict.reason === 'bad-signature') {
			console.warn('[auth] OAuth state failed signature verification');
			error(400, 'Invalid OAuth state.');
		}
		// `malformed` also covers the states minted by the previous bare-UUID
		// code, so the few in flight across a deploy restart cleanly rather than
		// 400ing. Neither reason can loop: the state we mint next is well-formed
		// and freshly dated by construction.
		console.warn(`[auth] restarting login: OAuth state ${verdict.reason}`);
		restartLogin(null);
	}
	const state = verdict.state;

	if (storedNonce === undefined) {
		// The URL came back but the cookie did not, which is the signature of a
		// login that changed browsers mid-flight: Slack's in-app webview hands the
		// current URL to Safari on "Open in browser", and Safari has its own
		// cookie jar. Nobody is attacking — so start the login over in whichever
		// browser we are in now, and still send them where they were going, since
		// the signed state carried the destination across even though the cookie
		// could not.
		if (!state.isRetry) {
			console.warn('[auth] restarting login: no state cookie (browser handoff?)');
			restartLogin(state.destination);
		}
		// One retry already happened and the cookie still is not sticking, so
		// going round again would only spin. Say what is actually wrong instead.
		console.error('[auth] login abandoned: state cookie missing after a retry');
		error(
			400,
			'Your browser did not send back the login cookie. This usually means the link was opened ' +
				'inside an app’s built-in browser. Open the site directly in your browser and sign in again.',
		);
	}

	if (storedNonce !== state.nonce) {
		// A cookie that is present but *different* is the case this check exists
		// for: someone else's authorization being fed into this browser.
		console.warn('[auth] OAuth state did not match the cookie');
		error(400, 'Invalid OAuth state.');
	}

	// The page they were trying to reach when they got bounced to login. The
	// cookie wins where it survived; the signed state is the fallback for the
	// jars that drop one cookie but not the other. Read before the session
	// exists — whether they may actually see it is decided below, once we know
	// if they're an admin.
	const requestedPath = cookies.get(OAUTH_REDIRECT_COOKIE) ?? state.destination;

	cookies.delete('oauth_state', { path: '/' });
	cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });

	// Exchange code for token
	const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: SLACK_CLIENT_ID,
			client_secret: SLACK_CLIENT_SECRET,
			code,
			redirect_uri: REDIRECT_URI,
		}),
	});

	const tokenData = (await tokenRes.json()) as SlackOAuthResponse;
	if (!tokenData.ok || !tokenData.authed_user?.access_token || !tokenData.authed_user.id) {
		console.error('[auth] token exchange failed:', tokenData.error);
		error(502, 'Authentication failed.');
	}

	// Straight off the token response — no users.identity round trip. That call
	// needed the identity.basic scope, which Slack refuses to grant alongside
	// chat:write (see the scope comment in ../+server.ts), and it told us
	// nothing `authed_user.id` doesn't.
	const userId = tokenData.authed_user.id;
	// Admin gate reads the DB-backed allowed list via loadSettings (which falls
	// back to env SLACK_ALLOWED_USER_IDS while the table is empty). The
	// superuser is admitted without consulting the list — even when reading it
	// fails — so a mis-edited or emptied allowed_slack_users table can never
	// lock every admin out of /pending and /settings.
	//
	// Moderators come from the same read. An admin is never also flagged a
	// moderator: isModerator only ever widens access for someone who is not an
	// admin, so it is kept meaningful as "moderator and nothing more".
	const isSuperuser = SLACK_SUPERUSER_ID !== '' && userId === SLACK_SUPERUSER_ID;
	let isAdmin = isSuperuser;
	let isModerator = false;
	if (!isAdmin) {
		try {
			const { allowedSlackUserIds, moderatorSlackUserIds } = await loadSettings(db);
			isAdmin = allowedSlackUserIds.has(userId);
			isModerator = !isAdmin && moderatorSlackUserIds.has(userId);
		} catch (err) {
			console.error(
				'[auth] loadSettings failed — denying admin and moderator to non-superuser:',
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Keep the user token only for admins and moderators, and only for as long
	// as they stay one — the info commands are theirs alone, so storing anyone
	// else's would be holding a credential the app has no use for. Anyone
	// else's row is dropped rather than left behind, which also cleans up after
	// someone is removed from both lists and logs in again.
	if (isAdmin || isModerator) {
		try {
			await saveUserToken(db, {
				slackUserId: userId,
				accessToken: tokenData.authed_user.access_token,
				scopes: tokenData.authed_user.scope ?? '',
			});
		} catch (err) {
			// Never blocks the login: the session is the point of this route, and
			// the info commands degrade to "authorize again" on their own.
			console.error(
				'[auth] could not store the user token:',
				err instanceof Error ? err.message : err,
			);
		}
	} else {
		try {
			await deleteUserToken(db, userId);
		} catch (err) {
			console.error(
				'[auth] could not clear a stored user token:',
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Read once and reused for the session and the log line below.
	const userName = await displayName(userId);

	// Create session
	const sid = crypto.randomUUID();
	await sessionStore.set(
		sid,
		{ slackUserId: userId, slackUserName: userName, isAdmin, isModerator },
		SESSION_MAX_AGE,
	);

	cookies.set('session', sid, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE,
	});

	console.log(
		`[auth] login: ${userName} (${userId}) admin=${isAdmin}` +
			`${isModerator ? ' moderator=true' : ''}${isSuperuser ? ' (superuser)' : ''}`,
	);
	// Back to the page they asked for — or the dashboard, when they asked for
	// nothing or for something this session may not see.
	redirect(302, resolvePostLoginRedirect(requestedPath, { isAdmin, isModerator }));
};

/**
 * Send someone back through login rather than dead-ending them on a 400.
 *
 * Safe by construction: the `code` Slack just handed us is dropped on the floor
 * and a brand-new authorization begins, so nothing from an unverified response
 * ever reaches a session. `retry=1` is what keeps this to at most one automatic
 * attempt — ../+server.ts folds it into the state it mints, and the branch above
 * refuses to restart a login that already carries it.
 */
function restartLogin(destination: string | null): never {
	const params = new URLSearchParams();
	// Re-sanitised rather than trusted: it is signed, but the rule that only
	// same-origin paths reach a Location header should hold at every hop.
	const target = sanitizeRedirectTarget(destination);
	if (target !== null) params.set('redirectTo', target);
	params.set('retry', '1');
	redirect(302, `/auth/slack?${params}`);
}

/**
 * Display name for the session, read with the **bot** token — it already holds
 * `users:read`, and the user token deliberately carries only `chat:write`.
 *
 * Never throws: the name is cosmetic (it labels the session and stamps audit
 * rows), and a Slack hiccup must not cost someone their login. Falls back to
 * the raw id, which every caller already tolerates.
 */
async function displayName(slackUserId: string): Promise<string> {
	try {
		const info = await slack.users.info({ user: slackUserId });
		const user = info.user as
			{ name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
		return (
			user?.profile?.display_name?.trim() ||
			user?.profile?.real_name?.trim() ||
			user?.name?.trim() ||
			slackUserId
		);
	} catch (err) {
		console.warn('[auth] could not read a display name:', err instanceof Error ? err.message : err);
		return slackUserId;
	}
}
