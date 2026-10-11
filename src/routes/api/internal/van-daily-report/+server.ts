import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { postAlert } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { withSyncLock } from '$lib/server/sync-lock.js';
import { sheetsClient, sheetsServiceAccountEmail } from '$lib/server/google-env.js';
import { vanClientFor } from '$lib/server/van-env.js';
import { loadCampaign } from '$lib/server/van/campaigns.js';
import { runContactStage } from '$lib/server/van/contact-live.js';
import {
	dailyReportCampaigns,
	runDailyDoorReport,
	type DailyReportDeps,
	type DailyReportResult,
} from '$lib/server/van/daily-door-report.js';
import type { VanCampaignRow } from '$lib/server/schema.js';
import { campaignDayBounds, campaignDayKey } from '$lib/campaign-time.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// The nightly door report (van/daily-door-report.ts). Called by the scheduler
// at 10pm campaign time with `slack=1`, and at 8am for the day before without,
// to take in MiniVAN syncs that landed overnight. Auth via
// ?key=<INTERNAL_CRON_SECRET>.
//
//   ?day=YYYY-MM-DD  the campaign day; today's when absent
//   ?campaign=<id>   one campaign; every enabled one with a report spreadsheet
//                    when absent
//   ?slack=1         post the totals to the turf channel
//   ?dry_run=1       return the tab's rows without writing or posting
//
// Each run but a dry one first reads VAN's newest contacts, waiting minutes for
// the export rather than the half-hourly sync's 45 seconds. A run rewrites the
// day's tab, so a rerun is harmless. Locked per campaign so
// the scheduler and a hand-run cannot write the same tab at once.

/** Time the report gives VAN to finish a ContactHistory export before it
 *  counts. Most finish in two or three minutes. */
const CONTACT_REFRESH_BUDGET_MS = 3 * 60 * 1000;
/** Past the contact refresh plus the Sheets budget. */
const LOCK_TTL_MS = 8 * 60 * 1000;
const LOG = '[door-report]';

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error(`${LOG} INTERNAL_CRON_SECRET is not set`);
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const day = url.searchParams.get('day') ?? campaignDayKey(new Date().toISOString());
	const announce = url.searchParams.get('slack') === '1';
	const dryRun = url.searchParams.get('dry_run') === '1';
	if (!campaignDayBounds(day)) {
		return json({ error: 'day must be a date, YYYY-MM-DD' }, { status: 400 });
	}

	let campaigns: VanCampaignRow[];
	const campaignParam = url.searchParams.get('campaign');
	if (campaignParam !== null) {
		const id = Number(campaignParam);
		const campaign = Number.isInteger(id) && id > 0 ? await loadCampaign(db, id) : null;
		if (!campaign) return json({ error: `No campaign ${campaignParam}` }, { status: 404 });
		if (!campaign.dailyReportSpreadsheetId?.trim()) {
			return json(
				{ error: `Campaign ${campaign.id} has no report spreadsheet set` },
				{ status: 400 },
			);
		}
		campaigns = [campaign];
	} else {
		campaigns = await dailyReportCampaigns(db);
	}

	const settings = await loadSettings(db);
	const deps: DailyReportDeps = {
		db,
		sheets: sheetsClient(),
		folderNames: async (campaign) => {
			const configured = vanClientFor(campaign);
			if (!configured.ok) throw new Error(configured.error);
			const folders = await configured.client.folders();
			return new Map(folders.map((f) => [f.folderId, f.name]));
		},
		refreshContacts: async (campaign) => {
			const result = await runContactStage(db, campaign, {
				timeBudgetMs: CONTACT_REFRESH_BUDGET_MS,
			});
			if (result?.error) console.warn(`${LOG} campaign ${campaign.id} contacts:`, result.error);
		},
		post: (text) => postAlert(settings.slackTurfChannelId, text, LOG),
		serviceAccountEmail: sheetsServiceAccountEmail(),
	};

	const results: Array<DailyReportResult | { campaignId: number; skipped: true }> = [];
	for (const campaign of campaigns) {
		const run = await withSyncLock(db, `van-daily-report:${campaign.id}`, LOCK_TTL_MS, () =>
			runDailyDoorReport(deps, campaign, { day, announce, dryRun }),
		);
		if (run.skipped) {
			results.push({ campaignId: campaign.id, skipped: true });
			continue;
		}
		const r = run.result;
		console.log(
			`${LOG} campaign ${campaign.id} ${day}: ${r.doors} doors (${r.appDoors} in app) on ${r.turfs} turfs in ${r.folders} folders, ` +
				`${r.peopleOutsideTurfs} people off turf, written=${r.written}, posted=${r.posted}` +
				(r.error ? `, error: ${r.error}` : ''),
		);
		results.push(r);
	}

	const failed = results.some((r) => 'error' in r && r.error);
	return json({ day, results }, { status: failed ? 500 : 200 });
};
