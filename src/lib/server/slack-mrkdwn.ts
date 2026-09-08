// Slack mrkdwn escaping, kept apart from slack.ts so the pure string work can be
// imported and tested without pulling in a WebClient or the env it reads.

/** Slack mrkdwn reserves three characters. Anything that reaches a message from
 *  VAN, Solidarity or Mobilize is typed by someone this app does not control. */
export function escapeMrkdwn(raw: string): string {
	return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A `<url|label>` link, or the bare label when there is no URL to point at.
 *
 * Both halves are escaped: an unescaped `&` in the URL is the classic broken
 * Slack link (query strings are full of them), and an unescaped `>` in a title
 * closes the link early and spills the markup into the message.
 */
export function mrkdwnLink(url: string | null | undefined, label: string): string {
	const text = escapeMrkdwn(label);
	return url ? `<${escapeMrkdwn(url)}|${text}>` : text;
}
