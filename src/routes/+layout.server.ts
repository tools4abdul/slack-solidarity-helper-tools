import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { loginRedirectPath } from '$lib/server/post-login-redirect.js';
import { isPublicPath } from '$lib/server/public-paths.js';
import { parseThemeMode, THEME_COOKIE } from '$lib/theme-mode.js';
import { db } from '$lib/server/db.js';
import { getSiteName } from '$lib/server/site.js';

export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	// The policies are readable by anyone — see server/public-paths.ts for why.
	// A signed-out visitor gets the same shell with no user chrome, so the page
	// still carries the site's name and theme rather than looking like a
	// different site than the one that sent them there.
	if (!locals.session && !isPublicPath(url.pathname)) {
		// Carry the requested page through OAuth so login returns them to it.
		redirect(302, loginRedirectPath(url));
	}
	return {
		// Explicit rather than left to be inferred from `userName`: the layout
		// decides what chrome to render from this, and a display name is not an
		// auth fact. A member whose Slack name came back empty is still signed
		// in and still needs the log-out button.
		signedIn: locals.session !== null,
		userName: locals.session?.slackUserName ?? null,
		isAdmin: locals.session?.isAdmin ?? false,
		isModerator: locals.session?.isModerator ?? false,
		// Same cookie hooks.server.ts used to stamp <html>, so the toggle's first
		// render agrees with the markup already on screen.
		themeMode: parseThemeMode(cookies.get(THEME_COOKIE)),
		// Cached; see server/site.ts. Every page's <title> ends with this.
		siteName: await getSiteName(db),
	};
};
