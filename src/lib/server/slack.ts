import { WebClient } from '@slack/web-api';
import type { drizzle } from 'drizzle-orm/libsql';

import { SLACK_BOT_TOKEN, SLACK_GROWTH_REPORT_CHANNEL_ID } from './env.js';
import { loadSettings } from './settings.js';
import { errMessage } from '../err-message.js';

let _slack: WebClient | null = null;

export function getSlack(): WebClient {
	if (!_slack) {
		_slack = new WebClient(SLACK_BOT_TOKEN);
	}
	return _slack;
}

// Convenience proxy for direct use in route handlers.
export const slack = new Proxy({} as WebClient, {
	get(_target, prop) {
		return (getSlack() as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/**
 * Post an operational alert to the tracking channel, never throwing.
 *
 * Used by the cron-triggered internal endpoints: a Slack outage must not turn a
 * sync that otherwise succeeded into a failed run, and the alert is the only way
 * a rejected Mobilize API key reaches a human.
 */
/**
 * An alert bound to the Mobilize-sync channel: the /settings override when one
 * is set, otherwise the growth-report channel (DB override, then env), which is
 * where these alerts went before the override existed. Reading it per request
 * means changing the channel in /settings moves these alerts too, rather than
 * leaving them pointed at a stale id.
 *
 * A settings read failure falls back rather than throwing — a DB hiccup must not
 * silence the alert that says Mobilize rejected the API key.
 */
export async function alertForMobilizeSync(
	tag: string,
	db: ReturnType<typeof drizzle>,
): Promise<(text: string) => Promise<void>> {
	let channelId = SLACK_GROWTH_REPORT_CHANNEL_ID;
	try {
		channelId = (await loadSettings(db)).slackMobilizeSyncChannelId || channelId;
	} catch (err) {
		console.error(
			`[${tag}] could not read settings for the alert channel; using env default:`,
			err instanceof Error ? err.message : err,
		);
	}
	return alertFor(tag, channelId);
}

/**
 * Post to a channel and say whether it landed.
 *
 * The boolean is the whole point, and it is why this exists alongside
 * `alertFor`: an alert that carries its own idempotency stamp must not stamp
 * after a failed post. Same reasoning as `sendDm` in slack-dm.js — the drift
 * alert stamps `van_turfs.drift_alerted_kind` only on success, so a Slack outage
 * retries on the next sync instead of silently burning the one message that says
 * two volunteers are about to knock the same doors.
 *
 * Callers wanting fire-and-forget behaviour should keep using `alertFor`, which
 * is the right shape for a notice nobody records.
 */
export async function postAlert(channelId: string, text: string, logTag: string): Promise<boolean> {
	if (!channelId) return false;
	try {
		await slack.chat.postMessage({
			channel: channelId,
			text,
			// Section block renders the mrkdwn; `text` stays the notification
			// fallback. Same shape as sendDm, so an alert and a DM read alike.
			blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
		});
		return true;
	} catch (err) {
		console.error(`${logTag} Slack post to ${channelId} failed:`, errMessage(err));
		return false;
	}
}

export function alertFor(tag: string, channelId: string): (text: string) => Promise<void> {
	return async (text: string) => {
		if (!channelId) return;
		try {
			await slack.chat.postMessage({ channel: channelId, text });
		} catch (err) {
			console.error(`[${tag}] Slack alert failed:`, err instanceof Error ? err.message : err);
		}
	};
}
