// Posting back to a Slack `response_url`.
//
// Slack gives a slash command three seconds to answer and then hands over a
// URL good for thirty minutes. Anything slower than a couple of database reads
// — a geocode, or a cold start on a Fly machine with min_machines_running = 0 —
// has to acknowledge first and answer here.
//
// Detached and swallowed by design, like the copy this was generalised from in
// the interactivity route: the 200 must not wait on it, and a failed follow-up
// must not turn into an unhandled rejection that takes the process with it.

import { errMessage } from '../err-message.js';

export interface ResponseUrlMessage {
	text: string;
	blocks?: unknown[];
}

export interface ResponseUrlOptions {
	/**
	 * Replace the message this came from rather than adding another.
	 *
	 * The default for anything that continues an interaction — a turf list
	 * being paged, a claim replacing the list it was made from. Without it a
	 * volunteer pressing "Show next 5" three times ends up scrolling a column
	 * of stale lists, any of which they might claim from.
	 */
	replaceOriginal?: boolean;
	/** Log prefix, so a failure is attributable. */
	logTag?: string;
}

/** Post an ephemeral message to a response_url. Never throws, never awaited. */
export function respondToSlack(
	responseUrl: string | undefined | null,
	message: ResponseUrlMessage,
	options: ResponseUrlOptions = {},
): void {
	void postToResponseUrl(responseUrl, message, options);
}

/**
 * The awaitable form, for callers that need their posts to land in order —
 * separate fetches that are not awaited can arrive at Slack in any order.
 * Never throws; resolves to whether Slack accepted the post.
 */
export async function postToResponseUrl(
	responseUrl: string | undefined | null,
	message: ResponseUrlMessage,
	options: ResponseUrlOptions = {},
): Promise<boolean> {
	if (!responseUrl) return false;
	const { replaceOriginal = false, logTag = '[slack]' } = options;
	try {
		const res = await fetch(responseUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				response_type: 'ephemeral',
				text: message.text,
				...(message.blocks ? { blocks: message.blocks } : {}),
				...(replaceOriginal ? { replace_original: true } : {}),
			}),
		});
		if (!res.ok) {
			console.warn(`${logTag} response_url post rejected: HTTP ${res.status}`);
			return false;
		}
		return true;
	} catch (err) {
		console.warn(`${logTag} response_url post failed:`, errMessage(err));
		return false;
	}
}
