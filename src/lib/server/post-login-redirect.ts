// Post-login destination handling: remember the page a signed-out visitor
// asked for, and send them back there once Slack OAuth completes.
//
// Two rules keep this from becoming a hole:
//   * only same-origin *paths* survive sanitisation — an attacker who can get
//     someone to click `/auth/slack?redirectTo=https://evil.example` must not
//     be able to turn our login flow into an open redirect;
//   * the destination is re-checked against the session that was just created,
//     so a non-admin who asked for an admin page lands on `/` instead of
//     bouncing off that page's own guard.

/** Page routes that require `isAdmin` (or, for MODERATOR_PREFIXES below,
 *  `isModerator`). Kept in sync with the `locals.session` guards in the
 *  corresponding `+page.server.ts` / `+layout.server.ts` loads — this list only decides where login *sends* people; the routes
 *  still enforce their own access. */
const ADMIN_ONLY_PREFIXES = ['/pending', '/members', '/channel-chapter-diff', '/settings'];

/** The subset of ADMIN_ONLY_PREFIXES a moderator may also see — the page the
 *  Slack "View member record" shortcut links to. Same caveat: the routes
 *  enforce this themselves. */
const MODERATOR_PREFIXES = ['/members'];

/** Generous cap: real destinations are short, and a cookie has to hold this. */
const MAX_TARGET_LENGTH = 512;

/** Holds the requested page across the Slack OAuth round trip. */
export const OAUTH_REDIRECT_COOKIE = 'oauth_redirect';

/**
 * Reduce an untrusted `redirectTo` value to a safe same-origin path, or null
 * when it cannot be trusted.
 */
export function sanitizeRedirectTarget(raw: string | null | undefined): string | null {
	if (!raw || raw.length > MAX_TARGET_LENGTH) return null;
	// Must be a rooted path. `//host` and `/\host` are protocol-relative URLs
	// that browsers happily follow off-site.
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
	// Control characters (including a stray newline) have no business in a
	// Location header.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

	let parsed: URL;
	try {
		parsed = new URL(raw, 'http://redirect.invalid');
	} catch {
		return null;
	}
	if (parsed.origin !== 'http://redirect.invalid') return null;

	// The auth endpoints themselves are never a useful destination — sending a
	// freshly signed-in user back to /auth/slack just loops them through OAuth.
	if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) return null;

	// Hashes never reach the server, so pathname + search is the whole story.
	return parsed.pathname + parsed.search;
}

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
	);
}

/** True when `path` belongs to a page only admins (and, for some, moderators)
 *  may see. */
export function isAdminOnlyPath(path: string): boolean {
	return matchesPrefix(path, ADMIN_ONLY_PREFIXES);
}

/**
 * Where to send someone immediately after their session is created: the page
 * they originally asked for when they may see it, `/` otherwise.
 */
export function resolvePostLoginRedirect(
	raw: string | null | undefined,
	session: { isAdmin: boolean; isModerator?: boolean },
): string {
	const target = sanitizeRedirectTarget(raw);
	if (target === null) return '/';
	if (session.isAdmin || !isAdminOnlyPath(target)) return target;
	if (session.isModerator && matchesPrefix(target, MODERATOR_PREFIXES)) return target;
	return '/';
}

/**
 * The login URL to bounce an unauthenticated request to, carrying the page it
 * was trying to reach. Pass the request's `url`.
 */
export function loginRedirectPath(url: URL): string {
	const target = sanitizeRedirectTarget(url.pathname + url.search);
	// `/` is the default destination anyway — no need to decorate the URL.
	if (target === null || target === '/') return '/auth/slack';
	return `/auth/slack?redirectTo=${encodeURIComponent(target)}`;
}
