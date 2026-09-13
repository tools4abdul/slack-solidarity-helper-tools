import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { getSlackUsers, getSolidarityMembers } from '$lib/server/autocomplete-sources.js';
import { errMessage } from '$lib/err-message.js';
import type { PickerItem } from '$lib/components/settings/picker-types.js';

// The Slack directory for the search box at the top of the page.
//
// It lives in the layout rather than the page load for one specific reason:
// SvelteKit tracks search-parameter access per key, so a load that never touches
// `url` is not re-run when `?user=` changes. Selecting member after member
// therefore re-serializes the (potentially large) directory exactly zero extra
// times.

export interface MembersLayoutData {
	slackUsers: PickerItem<string>[];
	slackUsersStale: boolean;
	slackUsersError?: string;
}

export const load: LayoutServerLoad = async ({ locals }) => {
	// Moderators too: this is where the Slack "View member record" shortcut
	// sends them. They read it; the account-linking controls stay admin-only
	// (see canLink in +page.server.ts, and api/members/*).
	if (!locals.session?.isAdmin && !locals.session?.isModerator) {
		redirect(302, '/');
	}

	// Warm the Solidarity roster in the background. A cold walk is many
	// sequential paginated requests; kicking it off when the page opens means
	// that by the time an admin hits an unmatched member and reaches for the
	// link picker, the in-flight de-duplication in autocomplete-sources lets
	// their search await an almost-finished walk instead of starting one.
	// Deliberately not awaited and deliberately swallowed — this is an
	// optimization, and the search endpoint reports its own failures.
	void getSolidarityMembers(SOLIDARITY_API_TOKEN).catch(() => {});

	try {
		const { items, stale } = await getSlackUsers(slack);
		return {
			slackUsers: items.map((u) => ({
				id: u.id,
				label: u.name,
				sublabel: u.realName || u.email,
			})),
			slackUsersStale: stale,
		} satisfies MembersLayoutData;
	} catch (err) {
		console.error('[member-page] Slack user list unavailable:', errMessage(err));
		return {
			slackUsers: [],
			slackUsersStale: false,
			slackUsersError: 'The Slack member list is unavailable right now. Try again in a moment.',
		} satisfies MembersLayoutData;
	}
};
