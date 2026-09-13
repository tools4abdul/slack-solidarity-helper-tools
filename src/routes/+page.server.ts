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
import { tickerShape } from '$lib/components/dashboard/ticker-size.js';
import { projectDoorsAtDeadline } from '$lib/server/doors-projection.js';
import {
	computeDoorsLeaderboardPair,
	loadDoorsDayTotals,
	loadDoorsTicker,
	type DoorsTicker,
} from '$lib/server/van/doors-store.js';
import type { DoorsLeaderboardPair } from '$lib/van/doors-leaderboard.js';

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

	// The county canvassing board, rebuilt on the VAN checkout ledger (plan.md
	// Story 9). Same α and the same Monday-pinned windows as the Slack board
	// above; a failure degrades both of its tabs rather than the whole page.
	let doorsLeaderboard: DoorsLeaderboardPair;
	try {
		doorsLeaderboard = await computeDoorsLeaderboardPair(db, {
			rankingAlpha: settings.slackGrowthReportRankingAlpha,
		});
	} catch (err) {
		console.error(
			'[dashboard] doors leaderboard load failed:',
			err instanceof Error ? err.message : err,
		);
		const failed = { ok: false as const, error: 'Failed to load leaderboard. Please try again.' };
		doorsLeaderboard = { lastWeek: failed, thisWeek: failed };
	}

	// Dashboard countdown banner, from the same settings read as the
	// leaderboard opts. Absent end datetime = no banner. When there are
	// completions to extrapolate from, it also shows the doors projected to be
	// cleared by the deadline — best-effort, so a failure just hides that line.
	let countdown: { label: string; endAt: string; projectedDoors: number | null } | null = null;
	if (settings.countdownEndAt !== '') {
		let projectedDoors: number | null = null;
		try {
			projectedDoors = projectDoorsAtDeadline(
				await loadDoorsDayTotals(db),
				Date.parse(settings.countdownEndAt),
				Date.now(),
			);
		} catch (err) {
			console.error(
				'[dashboard] doors projection failed:',
				err instanceof Error ? err.message : err,
			);
		}
		countdown = { label: settings.countdownLabel, endAt: settings.countdownEndAt, projectedDoors };
	}

	// Daily personal standings for the LED ticker under the countdown. Empty
	// rather than fatal: a sign with no names is a quiet day, not an error.
	let doorsTicker: DoorsTicker = { date: null, entries: [] };
	try {
		doorsTicker = await loadDoorsTicker(db);
	} catch (err) {
		console.error(
			'[dashboard] doors ticker load failed:',
			err instanceof Error ? err.message : err,
		);
	}

	return {
		...base,
		leaderboard,
		doorsLeaderboard,
		doorsTicker,
		countdown,
		// ?ticker= picks the shape the LED sign opens at, so the dashboard can
		// be pointed at a wall screen as ?ticker=widescreen and come up 16:9
		// with nobody there to click it. Parsed server-side like ?days= so the
		// first paint is already the right shape.
		ticker: tickerShape(event.url.searchParams),
		// The LED sign's scroll rate, admin-tunable under Settings.
		tickerColumnsPerSecond: settings.doorTickerColumnsPerSecond,
		pageTitle: 'Dashboard',
	};
};
