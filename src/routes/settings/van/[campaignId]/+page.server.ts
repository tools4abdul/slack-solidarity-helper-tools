import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { sheetsServiceAccountEmail } from '$lib/server/google-env.js';
import {
	loadTurfCustomChapters,
	loadVanChapterFolders,
	loadVanSheetTargets,
} from '$lib/server/settings.js';
import { credentialStatus, vanExportJobTypeIdFor } from '$lib/server/van-env.js';
import { campaignName, loadCampaign } from '$lib/server/van/campaigns.js';
import { loadCampaignStatus } from '$lib/server/van/campaign-status-store.js';
import { getSolidarityChapters } from '$lib/server/autocomplete-sources.js';
import { labelCustomChapters } from '$lib/chapter-list.js';
import { errMessage } from '$lib/err-message.js';
import { campaignChip } from '$lib/van/campaign-list.js';

// One VAN campaign's settings page (specs/012-multi-van-campaigns, Phase 5).
//
// Admin-only, with the same bare 302 as /settings. Everything about the
// campaign that is not a credential is edited here; its credentials are only
// described, through credentialStatus, which never carries the key — so no
// field of this page's data can leak it.

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session?.isAdmin) redirect(302, '/');

	const id = Number(params.campaignId);
	const campaign = Number.isInteger(id) && id > 0 ? await loadCampaign(db, id) : null;
	if (!campaign) error(404, 'No such campaign');

	const [status, mappings, targets, customChapters, chapters] = await Promise.all([
		loadCampaignStatus(db, campaign.id, new Date()),
		loadVanChapterFolders(db, campaign.id),
		loadVanSheetTargets(db, campaign.id),
		loadTurfCustomChapters(db),
		// The folder editor's chapter picker. Not page-fatal: without it the
		// rest of the page still answers what it is for.
		getSolidarityChapters(SOLIDARITY_API_TOKEN).then(
			(result) => ({ ok: true as const, items: result.items }),
			(err: unknown) => ({ ok: false as const, error: errMessage(err) }),
		),
	]);

	const name = campaignName(campaign);
	const solidarityChapters = chapters.ok ? chapters.items : [];
	return {
		pageTitle: `${name} · VAN campaign`,
		campaign: {
			id: campaign.id,
			name,
			label: campaign.label ?? '',
			badgeLabel: campaign.badgeLabel ?? '',
			credentialKey: campaign.credentialKey,
			enabled: campaign.enabled,
			chip: campaignChip(campaign),
			disabledAt: campaign.disabledAt,
			disabledByName: campaign.disabledByName,
			exportJobTypeId: campaign.exportJobTypeId,
			// What geometry uses while none is picked here: for primary, the
			// legacy VAN_EXPORT_JOB_TYPE_ID. Shown so "None" on this page cannot
			// read as "no geometry" when the env var is supplying one.
			fallbackExportJobTypeId:
				campaign.exportJobTypeId === null ? vanExportJobTypeIdFor(campaign) : null,
			refreshEnabled: campaign.refreshEnabled,
			sheetsEnabled: campaign.sheetsEnabled,
			sheetTabName: campaign.sheetTabName ?? '',
			dailyReportSpreadsheetId: campaign.dailyReportSpreadsheetId ?? '',
		},
		credentials: credentialStatus(campaign),
		status,
		mappings,
		targets,
		// The admin's turf-only chapters list even when Solidarity is down.
		chapters: [
			...solidarityChapters,
			...labelCustomChapters(
				customChapters,
				solidarityChapters.map((c) => c.name),
			).map((c) => ({ id: c.chapterId, name: c.name })),
		].sort((a, b) => a.name.localeCompare(b.name)),
		chaptersError: chapters.ok ? null : chapters.error,
		sheetsServiceAccountEmail: sheetsServiceAccountEmail(),
	};
};
