import { redirect } from '@sveltejs/kit';
import { parseDaysParam, type DashboardDaysPreset } from '$lib/components/dashboard/days.js';
import { type DaySignups, loadSolidaritySignups, loadSlackSignups } from './dashboard-signups.js';
import { db } from './db.js';
import { loadSettings } from './settings.js';
import { loginRedirectPath } from './post-login-redirect.js';

export type SourceResult = { ok: true; days: DaySignups[] } | { ok: false; error: string };

export interface DashboardPageData {
	days: DashboardDaysPreset;
	userName: string;
	isAdmin: boolean;
	solidarity: SourceResult;
	slack: SourceResult;
}

interface DashboardLoadEvent {
	url: URL;
	locals: App.Locals;
	depends: (...deps: string[]) => void;
}

const GENERIC_LOAD_ERROR = 'Failed to load signups. Please try again.';

function settledResult(label: string, settled: PromiseSettledResult<DaySignups[]>): SourceResult {
	if (settled.status === 'fulfilled') return { ok: true, days: settled.value };
	const err = settled.reason;
	console.error(`[dashboard] ${label} load failed:`, err instanceof Error ? err.message : err);
	return { ok: false, error: GENERIC_LOAD_ERROR };
}

// Shared load body for `/`, `/dashboard/solidarity`, and `/dashboard/slack`.
export async function loadDashboardPageData(event: DashboardLoadEvent): Promise<DashboardPageData> {
	// The +layout.server.ts guard runs concurrently with page loads (SvelteKit
	// does not order them), so it can't protect this pipeline — check the
	// session here before doing any DB or Slack work.
	const session = event.locals.session;
	if (!session) {
		redirect(302, loginRedirectPath(event.url));
	}

	event.depends('app:dashboard');

	const days = parseDaysParam(event.url.searchParams);

	// DB-backed exclusions (env fallback while the table is empty) so edits on
	// /settings apply to the charts the same as to the weekly growth report.
	const { reportExcludedChapterIds } = await loadSettings(db);

	// The doors-knocked series is not loaded while the door-knock cards are off
	// the dashboard; `loadDoorKnockSignups` stays in dashboard-signups.js for
	// when the VAN door stats are wired up.
	const [solidaritySettled, slackSettled] = await Promise.allSettled([
		loadSolidaritySignups(db, { days, excludedChapterIds: reportExcludedChapterIds }),
		loadSlackSignups(db, { days, excludedChapterIds: reportExcludedChapterIds }),
	]);

	return {
		days,
		userName: session.slackUserName,
		isAdmin: session.isAdmin,
		solidarity: settledResult('solidarity', solidaritySettled),
		slack: settledResult('slack', slackSettled),
	};
}
