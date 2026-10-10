import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { vanCampaigns, type NewVanCampaignRow } from '$lib/server/schema.js';
import {
	checkBoolean,
	checkSheetTabName,
	checkSpreadsheetId,
} from '$lib/server/app-config-fields.js';
import { vanClientFor } from '$lib/server/van-env.js';
import { loadCampaign } from '$lib/server/van/campaigns.js';
import { loadCampaignStatus } from '$lib/server/van/campaign-status-store.js';
import { errChainText, errMessage } from '$lib/err-message.js';

// One VAN campaign's settings (specs/012-multi-van-campaigns, Phase 5): the
// fields an admin edits on /settings/van/<id>. Credentials are not among them —
// they live in the campaign's `VAN_CAMPAIGN_<KEY>` secret and nothing here can
// read or change them.
//
// Each field is optional, so the page's autosaving rows can each send just the
// one they edit. `enabled: true` is checked rather than taken on trust: the key
// has to work and at least one folder has to be mapped, or the campaign would
// sync nothing and alert about it every half hour.

const LABEL_MAX_LENGTH = 80;
/** Short: it sits in a chip beside the turf name on a phone. */
const BADGE_MAX_LENGTH = 24;

interface CampaignBody {
	label?: unknown;
	badgeLabel?: unknown;
	exportJobTypeId?: unknown;
	refreshEnabled?: unknown;
	sheetsEnabled?: unknown;
	sheetTabName?: unknown;
	dailyReportSpreadsheetId?: unknown;
	enabled?: unknown;
}

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.session) return json({ error: 'unauthenticated' }, { status: 401 });
	if (!locals.session.isAdmin) return json({ error: 'unauthorized' }, { status: 403 });

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'campaign id must be a positive integer' }, { status: 400 });
	}
	const campaign = await loadCampaign(db, id);
	if (!campaign) return json({ error: `No campaign ${id}` }, { status: 404 });

	let body: CampaignBody;
	try {
		body = (await request.json()) as CampaignBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const patch: Partial<NewVanCampaignRow> = {};

	if ('label' in body) {
		if (typeof body.label !== 'string') {
			return json({ error: 'label must be a string' }, { status: 400 });
		}
		const label = body.label.trim();
		if (label.length > LABEL_MAX_LENGTH) {
			return json(
				{ error: `label must be ${LABEL_MAX_LENGTH} characters or fewer` },
				{ status: 400 },
			);
		}
		// Empty clears it: the campaign is then called by its key. Compared
		// ignoring case, as the unique index on lower(label) does — asked first
		// so the usual clash gets a readable answer rather than a failed write.
		if (label !== '') {
			const [clash] = await db
				.select({ label: vanCampaigns.label })
				.from(vanCampaigns)
				.where(and(sql`lower(${vanCampaigns.label}) = lower(${label})`, ne(vanCampaigns.id, id)));
			if (clash) return labelTaken(clash.label ?? label);
		}
		patch.label = label === '' ? null : label;
	}

	if ('badgeLabel' in body) {
		if (typeof body.badgeLabel !== 'string') {
			return json({ error: 'badgeLabel must be a string' }, { status: 400 });
		}
		const badge = body.badgeLabel.trim();
		if (badge.length > BADGE_MAX_LENGTH) {
			return json(
				{ error: `badge must be ${BADGE_MAX_LENGTH} characters or fewer` },
				{ status: 400 },
			);
		}
		// Empty falls back to the name, then the key (campaignBadge).
		patch.badgeLabel = badge === '' ? null : badge;
	}

	if ('exportJobTypeId' in body) {
		const value = body.exportJobTypeId;
		if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
			return json(
				{ error: 'exportJobTypeId must be a positive integer, or null for none' },
				{ status: 400 },
			);
		}
		patch.exportJobTypeId = value;
	}

	for (const key of ['refreshEnabled', 'sheetsEnabled'] as const) {
		if (!(key in body)) continue;
		const parsed = checkBoolean(key, body[key]);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
		patch[key] = parsed.value;
	}

	if ('sheetTabName' in body) {
		const parsed = checkSheetTabName('sheetTabName', body.sheetTabName);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
		patch.sheetTabName = parsed.value === '' ? null : parsed.value;
	}

	// Not checked against Google, like the Packet Tracker's: a sheet not yet
	// shared with the service account surfaces as an alert on the first report.
	if ('dailyReportSpreadsheetId' in body) {
		const parsed = checkSpreadsheetId('dailyReportSpreadsheetId', body.dailyReportSpreadsheetId, {
			allowEmpty: true,
		});
		if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
		patch.dailyReportSpreadsheetId = parsed.value === '' ? null : parsed.value;
	}

	const editorName = locals.session.slackUserName ?? locals.session.slackUserId;
	const now = new Date().toISOString();

	if ('enabled' in body) {
		const parsed = checkBoolean('enabled', body.enabled);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
		if (parsed.value && !campaign.enabled) {
			const refusal = await whyNotEnable(campaign);
			if (refusal) return json({ error: refusal }, { status: 409 });
		}
		if (parsed.value !== campaign.enabled) {
			patch.enabled = parsed.value;
			patch.disabledAt = parsed.value ? null : now;
			patch.disabledByName = parsed.value ? null : editorName;
		}
	}

	if (Object.keys(patch).length === 0) {
		return json({ error: 'nothing to change' }, { status: 400 });
	}

	try {
		await db
			.update(vanCampaigns)
			.set({
				...patch,
				lastEditedBy: locals.session.slackUserId,
				lastEditedByName: editorName,
				lastEditedAt: now,
			})
			.where(eq(vanCampaigns.id, id));
	} catch (err) {
		// Two admins naming two campaigns alike at once: the check above passed
		// for both, and the index refused the second.
		if (patch.label && /van_campaigns_label_unique|UNIQUE constraint/.test(errChainText(err))) {
			return labelTaken(patch.label);
		}
		throw err;
	}
	console.log(
		`[van] campaign ${id} (${campaign.credentialKey}) updated: ${Object.keys(patch).join(', ')} by ${locals.session.slackUserId} (${editorName})`,
	);
	const updated = await loadCampaign(db, id);
	return json({ ok: true, campaign: updated });
};

function labelTaken(label: string) {
	return json({ error: `Another campaign is already called "${label}"` }, { status: 409 });
}

/**
 * Why this campaign cannot be switched on yet, or null when it can. Asked of
 * VAN live rather than remembered from an earlier test, so a key that broke
 * since cannot be enabled on the strength of a stale green tick.
 */
async function whyNotEnable(campaign: NonNullable<Awaited<ReturnType<typeof loadCampaign>>>) {
	const configured = vanClientFor(campaign);
	if (!configured.ok) return `It has no working credentials: ${configured.error}`;
	const status = await loadCampaignStatus(db, campaign.id, new Date());
	if (status.mappedFolders === 0) {
		return 'Map at least one VAN folder to a chapter first — with none, it would sync no turf.';
	}
	try {
		await configured.client.folders();
	} catch (err) {
		return `VAN refused its key: ${errMessage(err)}`;
	}
	return null;
}
