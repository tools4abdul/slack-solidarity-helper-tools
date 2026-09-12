import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { INTERNAL_CRON_SECRET, SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import {
	runSlackInviteAudit,
	formatAuditMessage,
	auditIsWorthPosting,
} from '$lib/server/slack-invite-audit.js';
import { recordAudit, formatChanges } from '$lib/server/slack-invite-log.js';

// Internal endpoint called hourly by a scheduler (GitHub Actions) to verify
// every Slack invite link published through Solidarity still admits the public.
// Auth via ?key=<INTERNAL_CRON_SECRET>. Optional ?dry_run=1 returns the report
// without posting it. A clean run posts nothing (see `auditIsWorthPosting`) but
// still returns its report here, so a manual call always gets the full picture.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[invite-audit] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry_run') === '1';

	try {
		const settings = await loadSettings(db);
		if (!settings.slackTrackingChannelId && !dryRun) {
			return json({ error: 'Tracking channel is not configured' }, { status: 500 });
		}

		const result = await runSlackInviteAudit(SOLIDARITY_API_TOKEN);

		// Record before posting: the ledger is the durable record, and a Slack
		// outage must not cost us the history of this run.
		const changes = dryRun ? [] : await recordAudit(db, result);

		const changeSummary = formatChanges(changes);
		const message = changeSummary
			? `${changeSummary}\n\n${formatAuditMessage(result)}`
			: formatAuditMessage(result);

		const posted = !dryRun && auditIsWorthPosting(result, changes.length);
		if (posted) {
			await slack.chat.postMessage({
				channel: settings.slackTrackingChannelId,
				text: message,
				unfurl_links: false,
			});
		}

		console.log(
			`[invite-audit] ${result.pagesScanned} pages (${result.pagesFetchedAsHtml} via HTML), ` +
				`${result.distinctUrls} distinct links, ${result.broken.length} broken ref(s), ` +
				`${result.unknown.length} unchecked` +
				(posted ? '' : ' — nothing to report, stayed quiet'),
		);

		return json({
			pagesScanned: result.pagesScanned,
			pagesFetchedAsHtml: result.pagesFetchedAsHtml,
			distinctUrls: result.distinctUrls,
			broken: result.broken,
			unknown: result.unknown,
			changes,
			posted,
			message,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[invite-audit] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};
