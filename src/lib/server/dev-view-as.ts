// Seeing the app as somebody with fewer permissions than you have.
//
// Almost every page here branches on `isAdmin` or `isModerator`, and the only
// way to check what a volunteer actually sees has been to find a second Slack
// account or to edit your own row in the database and remember to put it back.
// Both are slow enough that the volunteer's view of a page routinely ships
// having never been looked at.
//
// So: `DEV_VIEW_AS=moderator` or `DEV_VIEW_AS=member` in `.env.local` demotes
// your own session for every request.
//
// ─────────────────────────────────────────────────────────────────────────
// It can only ever take permissions AWAY.
//
// There is deliberately no `DEV_VIEW_AS=admin`. A value this does not
// recognise leaves the session exactly as it was rather than guessing, so no
// spelling of this variable can grant anything to anyone — the worst a typo
// does is show you your real permissions. That is what makes it a development
// convenience rather than a privilege-escalation switch sitting in the request
// path.
//
// It is also refused at boot outside dev (see hooks.server.ts), on the same
// reasoning as DEV_SLACK_USER_ID: a copied `.env` must fail loudly rather than
// quietly locking the real admins out of their own settings page.
// ─────────────────────────────────────────────────────────────────────────

/** The roles you can borrow. Ordered most to least privileged; `admin` is
 *  absent on purpose — see the header. */
export type DevViewAs = 'moderator' | 'member';

export interface RoleFlags {
	isAdmin: boolean;
	isModerator?: boolean;
}

/** Parse the env value. Anything unrecognised — including '' and 'admin' — is
 *  null, meaning "leave the session alone". */
export function parseDevViewAs(raw: string | undefined | null): DevViewAs | null {
	const value = (raw ?? '').trim().toLowerCase();
	if (value === 'moderator') return 'moderator';
	if (value === 'member') return 'member';
	return null;
}

/**
 * Apply the demotion to one session's role flags.
 *
 * Returns a new object; the caller decides whether to use it. A null session
 * stays null — signed out is already the least-privileged view there is, and
 * inventing a session here would be exactly the escalation the header rules
 * out.
 */
export function applyDevViewAs<T extends RoleFlags>(
	session: T | null,
	as: DevViewAs | null,
): T | null {
	if (!session || as === null) return session;
	return {
		...session,
		isAdmin: false,
		// A moderator keeps the moderator flag; a member keeps nothing. Both
		// drop admin, because every role below admin does.
		isModerator: as === 'moderator',
	};
}
