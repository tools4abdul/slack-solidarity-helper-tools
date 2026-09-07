import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { errMessage } from '$lib/err-message.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { getSlackChannels, getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import type { PickerItem } from '$lib/components/settings/picker-types.js';

// The page only needs the two picker lists; the diff itself is fetched from
// /api/channel-chapter-diff once both are chosen, because a chapter walk can
// run long enough that doing it in the load would hold the whole page.
export interface ChannelChapterDiffPageData {
	pageTitle: 'Channel vs. chapter';
	channels: PickerItem<string>[];
	chapters: PickerItem<number>[];
	errors: {
		channels?: string;
		chapters?: string;
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	// Checked here, not just in +layout.server.ts — layout and page loads run
	// concurrently, so an unauthenticated request still reaches this function.
	if (!locals.session?.isAdmin) {
		redirect(302, '/');
	}

	// allSettled so a Slack outage still leaves the chapter picker usable, and
	// vice versa — each picker reports its own source's failure.
	const [channelsResult, chaptersResult] = await Promise.allSettled([
		getSlackChannels(slack),
		getSolidarityChapters(SOLIDARITY_API_TOKEN),
	]);

	const errors: ChannelChapterDiffPageData['errors'] = {};

	let channels: PickerItem<string>[] = [];
	if (channelsResult.status === 'fulfilled') {
		channels = channelsResult.value.items.map((c) => ({
			id: c.id,
			label: `#${c.name}`,
			sublabel: c.isPrivate ? 'private' : undefined,
		}));
	} else {
		errors.channels = errMessage(channelsResult.reason);
	}

	let chapters: PickerItem<number>[] = [];
	if (chaptersResult.status === 'fulfilled') {
		chapters = chaptersResult.value.items.map((c) => ({ id: c.id, label: c.name }));
	} else {
		errors.chapters = errMessage(chaptersResult.reason);
	}

	return {
		pageTitle: 'Channel vs. chapter',
		channels,
		chapters,
		errors,
	} satisfies ChannelChapterDiffPageData;
};
