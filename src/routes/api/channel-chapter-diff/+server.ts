import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { errMessage } from '$lib/err-message.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import {
	validateSlackChannel,
	validateSolidarityChapter,
} from '$lib/server/settings-validation.js';
import { computeChannelChapterDiff } from '$lib/server/channel-chapter-diff.js';

const MAX_ACTIVE_DAYS = 365;

// GET ?channel=<C…>&chapter=<n>[&activeDays=<n>] → the email diff between one
// Slack channel's members and one Solidarity chapter's members.
//
// `activeDays` narrows the Solidarity-side list to people with a recorded
// action or event RSVP in that many days. Omitting it skips those reads
// entirely, so the unfiltered comparison stays as cheap as it was.
//
// Both ids are re-validated against the live lists rather than trusted from the
// query string: this endpoint is reachable independently of the page, so it
// re-applies every gate the page load applies. Same validation contract as the
// settings endpoints — a list outage is 503 (retry), a genuinely unknown id is
// 400 (your pick was wrong).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const channelId = url.searchParams.get('channel')?.trim();
	if (!channelId) {
		return json({ error: 'channel is required' }, { status: 400 });
	}

	const rawChapter = url.searchParams.get('chapter')?.trim();
	const chapterId = Number(rawChapter);
	if (!rawChapter || !Number.isInteger(chapterId)) {
		return json({ error: 'chapter must be an integer chapter id' }, { status: 400 });
	}

	// Bounded because the window decides how far back two multi-page walks
	// read; a year is already several minutes of reading.
	const rawDays = url.searchParams.get('activeDays')?.trim();
	let activeSinceMs: number | null = null;
	if (rawDays) {
		const days = Number(rawDays);
		if (!Number.isInteger(days) || days < 1 || days > MAX_ACTIVE_DAYS) {
			return json(
				{ error: `activeDays must be a whole number of days between 1 and ${MAX_ACTIVE_DAYS}` },
				{ status: 400 },
			);
		}
		activeSinceMs = Date.now() - days * 86_400_000;
	}

	const [channel, chapter] = await Promise.all([
		validateSlackChannel(slack, channelId),
		validateSolidarityChapter(SOLIDARITY_API_TOKEN, chapterId),
	]);
	for (const result of [channel, chapter]) {
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
	}

	try {
		const diff = await computeChannelChapterDiff({
			slack,
			token: SOLIDARITY_API_TOKEN,
			channelId,
			chapterId,
			activeSinceMs,
		});
		return json(diff);
	} catch (err) {
		console.error(
			`[channel-chapter-diff] diff failed for ${channelId} × chapter ${chapterId}:`,
			errMessage(err),
		);
		return json(
			{ error: `Couldn't compare those two right now: ${errMessage(err)}` },
			{ status: 502 },
		);
	}
};
