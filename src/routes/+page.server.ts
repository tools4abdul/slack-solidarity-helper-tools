import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import {
	computeWeeklyLeaderboard,
	computeLiveLeaderboardSinceSnapshot,
	firstChannelByChapter,
	type WeeklyLeaderboard,
	type LeaderboardResult,
	type LeaderboardPair,
} from '$lib/server/weekly-growth-report.js';
import { loadSettings } from '$lib/server/settings.js';

async function safeLoad(
	label: string,
	compute: () => Promise<WeeklyLeaderboard>,
): Promise<LeaderboardResult> {
	try {
		return { ok: true, leaderboard: await compute() };
	} catch (err) {
		console.error(
			`[dashboard] ${label} leaderboard load failed:`,
			err instanceof Error ? err.message : err,
		);
		return { ok: false, error: 'Failed to load leaderboard. Please try again.' };
	}
}

export const load: PageServerLoad = async (event) => {
	const base = await loadDashboardPageData(event);

	// Same admin-editable settings the team_join invites use — the leaderboard's
	// channel links and exclusions must agree with what /settings shows.
	const settings = await loadSettings(db);
	const chapterChannelIds = firstChannelByChapter(settings.chapterChannelMap);

	const opts = {
		excludedChapterIds: settings.reportExcludedChapterIds,
		chapterChannelIds,
		rankingAlpha: settings.slackGrowthReportRankingAlpha,
	};

	const [saved, live] = await Promise.all([
		// Saved tab stays the frozen snapshot; only the live tab fetches the
		// current Slack channel sizes.
		safeLoad('saved', () => computeWeeklyLeaderboard(db, opts)),
		safeLoad('live', () => computeLiveLeaderboardSinceSnapshot(db, { ...opts, slack })),
	]);

	const leaderboard: LeaderboardPair = { saved, live };

	// Dashboard countdown banner, from the same settings read as the
	// leaderboard opts. Absent end datetime = no banner.
	//
	// The banner's projected-doors line is off with the rest of the door-knock
	// reporting until the VAN door stats land: `projectDoorsAtDeadline` and the
	// `projectedDoors` prop are both still there to feed it from the new
	// source.
	let countdown: { label: string; endAt: string } | null = null;
	if (settings.countdownEndAt !== '') {
		countdown = { label: settings.countdownLabel, endAt: settings.countdownEndAt };
	}

	return {
		...base,
		leaderboard,
		countdown,
		pageTitle: 'Dashboard',
	};
};
