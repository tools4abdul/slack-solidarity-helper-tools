import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { runWeeklyGrowthReport, firstChannelByChapter } from '$lib/server/weekly-growth-report.js';
import { loadSettings } from '$lib/server/settings.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { withSyncLock } from '$lib/server/sync-lock.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// Internal endpoint called by a scheduler (GitHub Actions) to compute and post
// the weekly per-chapter Slack-growth leaderboard. Auth via ?key=<INTERNAL_CRON_SECRET>.
// Optional ?dry_run=1 returns the result without posting to Slack, and
// ?force=1 recomputes a window that already has a snapshot.
//
// Serialised on a lock because the workflow calls this with a timeout: an
// aborted request leaves the run going server-side, and the retry would
// otherwise reach persistSnapshot's DELETE while the first run's inserts are
// still landing — wiping them, then colliding on the (window_end, chapter_id)
// primary key for the rest.
const SYNC_LOCK_NAME = 'weekly-growth-report';
// Comfortably over a slow run: the conversations.info fan-out is one call per
// chapter with growth, and the TTL only has to outlive that.
const SYNC_LOCK_TTL_MS = 10 * 60 * 1000;

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[growth] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const dryRun = url.searchParams.get('dry_run') === '1';
	const force = url.searchParams.get('force') === '1';

	try {
		// Admin-editable settings (DB-backed, env fallback for the app_config
		// fields) — must agree with the dashboard and team_join invites.
		const settings = await loadSettings(db);
		if (!settings.slackGrowthReportChannelId) {
			return json({ error: 'Growth report channel is not configured' }, { status: 500 });
		}
		const chapterChannelIds = firstChannelByChapter(settings.chapterChannelMap);
		const run = await withSyncLock(db, SYNC_LOCK_NAME, SYNC_LOCK_TTL_MS, () =>
			runWeeklyGrowthReport(db, slack, settings.slackGrowthReportChannelId, {
				dryRun,
				force,
				excludedChapterIds: settings.reportExcludedChapterIds,
				chapterChannelIds,
				rankingAlpha: settings.slackGrowthReportRankingAlpha,
			}),
		);

		// 200 rather than 409, matching the other internal syncs: the caller uses
		// `curl --fail-with-body`, and an ordinary skip should not turn the
		// workflow run red.
		if (run.skipped) {
			console.log('[growth] skipped — another growth report run is already in flight');
			return json({ skipped: true, reason: 'another growth report run is already in flight' });
		}
		const result = run.result;

		console.log(
			`[growth] ${result.windowStart} → ${result.windowEnd}: ${result.chaptersWithGrowth} chapters, ` +
				`${result.totalNewJoins} new joins, posted=${result.posted}, persisted=${result.persisted}`,
		);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[growth] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};
