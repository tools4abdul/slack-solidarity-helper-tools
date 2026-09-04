import { redirect } from '@sveltejs/kit';
import { parseDaysParam, type DashboardDaysPreset } from '$lib/components/dashboard/days.js';
import {
	type DaySignups,
	loadSolidaritySignups,
	loadSlackSignups,
	loadDoorKnockSignups,
} from './dashboard-signups.js';
import { db } from './db.js';
import { loadSettings } from './settings.js';
import { loginRedirectPath } from './post-login-redirect.js';
import { loadCountyByChapterName } from './chapter-county.js';

export type SourceResult = { ok: true; days: DaySignups[] } | { ok: false; error: string };

export interface DashboardPageData {
	days: DashboardDaysPreset;
	userName: string;
	isAdmin: boolean;
	solidarity: SourceResult;
	slack: SourceResult;
	doorKnock: SourceResult;
	/** Chapter name (lowercased) -> Michigan county, as [name, county] pairs
	 *  (a Map doesn't survive SvelteKit's load-data serialization). */
	countyByChapterName: [string, string][];
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

	const [solidaritySettled, slackSettled, doorKnockSettled, countyByChapterNameSettled] =
		await Promise.allSettled([
			loadSolidaritySignups(db, { days, excludedChapterIds: reportExcludedChapterIds }),
			loadSlackSignups(db, { days, excludedChapterIds: reportExcludedChapterIds }),
			loadDoorKnockSignups(db, { days }),
			loadCountyByChapterName(db),
		]);

	// Best-effort: the county heatmap just falls back to its chapter-name
	// heuristic for every chapter if this fails, rather than breaking the load.
	if (countyByChapterNameSettled.status === 'rejected') {
		console.error(
			'[dashboard] county-by-chapter load failed:',
			countyByChapterNameSettled.reason instanceof Error
				? countyByChapterNameSettled.reason.message
				: countyByChapterNameSettled.reason,
		);
	}
	const countyByChapterName =
		countyByChapterNameSettled.status === 'fulfilled'
			? [...countyByChapterNameSettled.value]
			: [];

	return {
		days,
		userName: session.slackUserName,
		isAdmin: session.isAdmin,
		solidarity: settledResult('solidarity', solidaritySettled),
		slack: settledResult('slack', slackSettled),
		doorKnock: settledResult('door-knock', doorKnockSettled),
		countyByChapterName,
	};
}
