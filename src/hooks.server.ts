import type { Handle } from '@sveltejs/kit';
import { text } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { db, sessionStore } from '$lib/server/db.js';
import { getTheme } from '$lib/server/theme.js';
import { parseThemeMode, themeAttribute, THEME_COOKIE } from '$lib/theme-mode.js';
import { errMessage } from '$lib/err-message.js';
import { validateEnv } from '$lib/server/env.js';
import { isCrossSiteFormPost } from '$lib/server/csrf.js';

export async function init() {
	validateEnv();
	// DEV_SLACK_USER_ID enables the no-auth admin backdoor at /auth/dev-login.
	// The endpoint itself also requires dev mode, but refuse to boot at all if
	// the var leaks into a production environment (e.g. a copied .env).
	if (!dev && (env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		console.error(
			'DEV_SLACK_USER_ID must not be set in production — it enables the dev-login auth bypass.',
		);
		process.exit(1);
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	// Stands in for SvelteKit's own CSRF check, which is disabled in
	// svelte.config.js so Slack's Origin-less form posts can reach
	// /api/slack/*. Matches Kit's dev exemption so local form testing behaves
	// the same as before. See src/lib/server/csrf.ts for the full rationale.
	if (!dev && isCrossSiteFormPost(event.request, event.url)) {
		return text(`Cross-site ${event.request.method} form submissions are forbidden`, {
			status: 403,
		});
	}

	const sid = event.cookies.get('session');

	if (sid) {
		const lookup = await sessionStore.get(sid);
		if (lookup.status === 'found') {
			event.locals.session = lookup.data;
			event.cookies.set('session', sid, {
				path: '/',
				httpOnly: true,
				secure: !dev,
				sameSite: 'lax',
				maxAge: 8 * 60 * 60,
			});
		} else {
			event.locals.session = null;
			// Only clear the cookie when the session is genuinely gone. On
			// 'unavailable' the database did not answer, and the session may be
			// perfectly valid — deleting the cookie there would turn a few
			// seconds of Turso trouble into a workspace-wide logout that
			// everyone has to fix by re-running Slack OAuth. Leaving it costs
			// nothing: this request is still treated as signed out, and the
			// next one retries the lookup.
			if (lookup.status === 'missing') {
				event.cookies.delete('session', { path: '/' });
			}
		}
	} else {
		event.locals.session = null;
	}

	// Inject the theme's custom properties into <head>. Done here rather than in
	// a layout because it has to reach <html>/<body> — a wrapper div can set
	// variables for its subtree but cannot colour the page background, and dark
	// mode needs somewhere above the app to hang.
	//
	// Never let a theming failure cost the user their page: on error the
	// placeholder is stripped and the app renders with app.css's own fallbacks.
	let themeStyle = '';
	try {
		const { css } = await getTheme(db);
		themeStyle = `<style id="theme-tokens">${css}</style>`;
	} catch (err) {
		console.error('[theme] injection failed, rendering without tokens:', errMessage(err));
	}

	// The viewer's own light/dark choice, stamped on <html> server-side.
	//
	// A cookie rather than localStorage precisely so it can be read HERE: an
	// inline script reading localStorage would run after first paint, which is
	// the flash-of-wrong-theme this whole design avoids. 'system' writes no
	// attribute at all, leaving prefers-color-scheme in charge.
	// Note the replaced token includes the space BEFORE it: themeAttribute
	// carries its own leading space, so 'system' collapses to `<html lang="en">`
	// rather than leaving a stray one.
	const themeAttr = themeAttribute(parseThemeMode(event.cookies.get(THEME_COOKIE)));

	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%theme.style%', themeStyle).replace(' %theme.attr%', themeAttr),
	});

	setSecurityHeaders(response.headers);
	return response;
};

/**
 * Response headers this app never sets per-route, applied in one place.
 *
 * Defence in depth rather than a hole being plugged: the session cookie is
 * SameSite=Lax, so it is not sent to a cross-site iframe and the clickjacking
 * route into /settings is already closed. These make that explicit and cover
 * the cases the cookie policy does not.
 *
 * Be honest about what this CSP does and does not buy. Both style-src and
 * script-src carry 'unsafe-inline', because SvelteKit emits an inline
 * bootstrap script on every page and this file injects the theme as an inline
 * <style> block by design (see above). So this is NOT an XSS backstop — an
 * injected inline script would still run. What it does enforce is origin:
 * nothing may be loaded from, or posted to, a host we did not name, and
 * object-src/base-uri close the two classic redirection tricks.
 *
 * Tightening it to a real script defence means giving Kit a nonce
 * (`kit.csp.directives` in svelte.config.js, which generates them per render)
 * rather than widening it here. That is worth doing; it is a bigger change
 * than this one, and a loose CSP beats none in the meantime.
 *
 * frame-ancestors is what modern browsers consult; X-Frame-Options is sent
 * alongside for anything old enough to need it.
 */
function setSecurityHeaders(headers: Headers): void {
	headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			// The map's basemap tiles come from a configurable CDN, and the
			// browser is what fetches them (see MAP_TILE_URL_TEMPLATE).
			"img-src 'self' data: blob: https:",
			"style-src 'self' 'unsafe-inline'",
			"script-src 'self' 'unsafe-inline'",
			"connect-src 'self' https:",
			"font-src 'self' data:",
			"object-src 'none'",
			"base-uri 'self'",
			// Nothing in this app is ever legitimately framed.
			"frame-ancestors 'none'",
			"form-action 'self'",
		].join('; '),
	);
	headers.set('X-Frame-Options', 'DENY');
	headers.set('X-Content-Type-Options', 'nosniff');
	// Same-origin referrers keep /turfs?chapter=… out of third-party logs, and
	// no referrer at all leaves the tile CDN.
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// fly.toml already forces HTTPS; this stops the first plaintext hop on a
	// return visit. Not preloaded — that is a one-way door for the domain.
	if (!dev) {
		headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
}
