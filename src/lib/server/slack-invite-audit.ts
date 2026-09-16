// Hourly audit of every Slack invite link published through Solidarity.
//
// A stale invite is silent: the page still loads, the button still looks right,
// and the volunteer who clicks it lands on a signup form demanding an email
// address on the workspace's own domain, which they do not have. Nobody reports
// it because the people who hit it aren't in the Slack yet. So we check from
// the outside.
//
// Two halves, both with a wrinkle worth knowing about:
//
// 1. DISCOVERY. `/v1/pages` returns the body for most page types, but for
//    ActionPage::PageBuilder and ActionPage::BlogPost it returns a stub with
//    `description: null` and `form: null` — the visual-editor content simply is
//    not in the API. A link in a PageBuilder button is invisible to an
//    API-only scan (this is how /groupchat and /welcome were missed). Those
//    pages have to be fetched as rendered HTML. See `needsRenderedHtml`.
//
// 2. CLASSIFICATION. See `classifyInvite` — Slack gates the invite page on
//    browser version, which makes the User-Agent load-bearing.

import { fetchPaginated } from './solidarity-paginate.js';

/** Where in a page an invite link was found. Reported verbatim to Slack, so
 *  these read as prose rather than field paths. */
export type InviteLocation = 'page content' | 'redirect URL' | 'follow-up email' | 'follow-up text';

export type InviteStatus =
	/** Slack served the real invite page: anyone can join. */
	| 'valid'
	/** Redirected to the domain-restricted signup, or the token is unknown.
	 *  Stale and expired links are indistinguishable here — both bounce to
	 *  /signup#/domain-signup — and both are equally broken for a volunteer. */
	| 'broken'
	/** We could not tell. Never reported as broken: a false "your link is
	 *  dead" alert costs more trust than a missed hour of coverage. */
	| 'unknown';

export interface InviteRef {
	url: string;
	pageId: number;
	pageName: string;
	pageUrl: string;
	/** The Solidarity site the page belongs to (`website_id` from the API).
	 *  Carried on the ref because the dashboard edit link is scoped by site. */
	websiteId: number | null;
	location: InviteLocation;
}

export interface SolidarityPage {
	id: number;
	type: string;
	name: string;
	url_slug: string;
	full_url: string | null;
	is_published: boolean;
	website_id?: number | null;
	description?: string | null;
	form?: unknown;
	follow_up?: unknown;
	confirmations?: unknown;
}

// Matches the shared-invite links Solidarity pages actually carry. Deliberately
// stops at quote, angle bracket, whitespace, backslash and ampersand so a link
// embedded in HTML or in JSON-escaped email content comes back clean.
const INVITE_RE = /https?:\/\/join\.slack\.com\/t\/[^\s"'<>\\)&]+/gi;

// Slack serves an "your browser is not supported" wall to anything it reads as
// an old browser, and that wall is byte-identical for valid, stale and entirely
// fabricated tokens — so a stale UA here would classify every link the same and
// the audit would report nothing useful. Chrome 131 is walled; 140+ is served.
// Kept comfortably ahead of that floor. If Slack raises the floor past this
// value the audit does NOT start crying wolf: `classifyInvite` detects the wall
// explicitly and returns 'unknown', and `runSlackInviteAudit` surfaces it as a
// configuration problem to fix rather than as broken links.
/** Slack's own chain is one hop; anything past a handful is a loop. */
const MAX_INVITE_REDIRECTS = 5;

const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Pace for rendered-HTML fetches. The public site 429s readily — an unpaced
 *  sweep at concurrency 5 had two thirds of its requests rejected. */
const HTML_PACE_MS = 1000;

/** The page types whose body the API does not return at all. */
export function needsRenderedHtml(page: SolidarityPage): boolean {
	return page.type.endsWith('PageBuilder') || page.type.endsWith('BlogPost');
}

function matchInvites(haystack: unknown): string[] {
	if (haystack == null) return [];
	const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
	return [...new Set(text.match(INVITE_RE) ?? [])];
}

/**
 * Pull invite links out of the API record, tagged by where they live. Covers
 * the four places a link reaches a volunteer: the page body, the post-submit
 * redirect, and the two confirmation messages.
 */
export function collectInviteRefs(page: SolidarityPage): InviteRef[] {
	const confirmations = (page.confirmations ?? {}) as Record<string, unknown>;
	const buckets: [InviteLocation, unknown][] = [
		['page content', [page.description, page.form]],
		['redirect URL', page.follow_up],
		['follow-up email', confirmations.email],
		['follow-up text', confirmations.text],
	];

	const refs: InviteRef[] = [];
	for (const [location, source] of buckets) {
		for (const url of matchInvites(source)) {
			refs.push({
				url,
				pageId: page.id,
				pageName: page.name,
				pageUrl: page.full_url ?? '',
				websiteId: page.website_id ?? null,
				location,
			});
		}
	}
	return refs;
}

/** Invite links found in a PageBuilder/BlogPost body, which only exists as
 *  rendered HTML. Always reported as 'page content' — that is what an editor
 *  sees in the visual builder. */
export function collectInviteRefsFromHtml(page: SolidarityPage, html: string): InviteRef[] {
	return matchInvites(html).map((url) => ({
		url,
		pageId: page.id,
		pageName: page.name,
		pageUrl: page.full_url ?? '',
		websiteId: page.website_id ?? null,
		location: 'page content' as const,
	}));
}

/**
 * Ask Slack whether an invite still admits the public.
 *
 * The observable outcomes, all from the first response with redirects left
 * unfollowed:
 *   302 → /signup...          stale or expired; lands on the domain-restricted
 *                             form that demands a staff email address
 *   200 + "Create Account"    token means nothing to Slack
 *   200 + anything else       the real invite page
 *   403 + browser wall        our User-Agent aged out; not a verdict
 */
export async function classifyInvite(
	url: string,
	fetchImpl: typeof fetch = fetch,
	depth = 0,
): Promise<{ status: InviteStatus; detail: string }> {
	// `redirect: 'manual'` turns off the runtime's own redirect cap, so the
	// join.slack.com hop below is chased by this function and nothing else
	// bounds it. Two hosts pointing shared-invite URLs at each other would
	// recurse until the stack gives out, which fails the whole hourly audit and
	// leaves broken invite links unreported.
	if (depth > MAX_INVITE_REDIRECTS) {
		return { status: 'unknown', detail: `redirected more than ${MAX_INVITE_REDIRECTS} times` };
	}
	let res: Response;
	try {
		res = await fetchImpl(url, {
			redirect: 'manual',
			headers: { 'User-Agent': BROWSER_UA },
		});
	} catch (err) {
		return {
			status: 'unknown',
			detail: `fetch failed: ${err instanceof Error ? err.message : err}`,
		};
	}

	// join.slack.com rewrites blindly to <workspace>.slack.com without looking
	// at the token, so that first hop says nothing — follow it before judging.
	const location = res.headers.get('location') ?? '';
	if (res.status >= 300 && res.status < 400 && /\/join\/shared_invite\//.test(location)) {
		return classifyInvite(location, fetchImpl, depth + 1);
	}

	if (res.status >= 300 && res.status < 400) {
		if (/\/signup/.test(location)) {
			return { status: 'broken', detail: 'redirects to the domain-restricted signup form' };
		}
		return { status: 'unknown', detail: `unexpected redirect to ${location || '(none)'}` };
	}

	if (res.status === 200) {
		const html = await res.text();
		if (/Create Account/i.test(html)) {
			return { status: 'broken', detail: 'Slack does not recognise this invite token' };
		}
		return { status: 'valid', detail: 'invite page loads normally' };
	}

	if (res.status === 403 && /browser is not supported/i.test(await res.text())) {
		return {
			status: 'unknown',
			detail: 'Slack rejected our browser version — BROWSER_UA needs bumping',
		};
	}

	return { status: 'unknown', detail: `unexpected HTTP ${res.status}` };
}

export interface AuditResult {
	pagesScanned: number;
	pagesFetchedAsHtml: number;
	refs: InviteRef[];
	distinctUrls: number;
	statuses: Map<string, { status: InviteStatus; detail: string }>;
	broken: InviteRef[];
	unknown: InviteRef[];
}

/**
 * Scan every page, then classify each *distinct* URL once. The pages number in
 * the thousands but the links resolve to a handful, so classification is a few
 * requests rather than a few thousand.
 */
export async function runSlackInviteAudit(
	apiToken: string,
	fetchImpl: typeof fetch = fetch,
	pace = HTML_PACE_MS,
): Promise<AuditResult> {
	const pages = await fetchPaginated<SolidarityPage>(
		apiToken,
		'/v1/pages',
		'pages',
		'',
		'invite-audit',
		250,
	);

	const refs: InviteRef[] = [];
	for (const page of pages) refs.push(...collectInviteRefs(page));

	// The API-opaque page types, fetched as rendered HTML.
	const htmlPages = pages.filter((p) => p.is_published && p.full_url && needsRenderedHtml(p));
	let pagesFetchedAsHtml = 0;
	for (const page of htmlPages) {
		if (pagesFetchedAsHtml > 0 && pace > 0) {
			await new Promise((r) => setTimeout(r, pace));
		}
		try {
			const res = await fetchImpl(page.full_url as string, {
				headers: { 'User-Agent': BROWSER_UA },
			});
			pagesFetchedAsHtml++;
			if (!res.ok) {
				console.warn(`[invite-audit] page ${page.id} (${page.url_slug}) returned ${res.status}`);
				continue;
			}
			refs.push(...collectInviteRefsFromHtml(page, await res.text()));
		} catch (err) {
			console.warn(`[invite-audit] page ${page.id} fetch failed: ${err}`);
		}
	}

	const statuses = new Map<string, { status: InviteStatus; detail: string }>();
	for (const url of new Set(refs.map((r) => r.url))) {
		statuses.set(url, await classifyInvite(url, fetchImpl));
	}

	return {
		pagesScanned: pages.length,
		pagesFetchedAsHtml,
		refs,
		distinctUrls: statuses.size,
		statuses,
		broken: refs.filter((r) => statuses.get(r.url)?.status === 'broken'),
		unknown: refs.filter((r) => statuses.get(r.url)?.status === 'unknown'),
	};
}

const DASHBOARD_ORIGIN = 'https://dashboard.solidarity.tech';

/**
 * The dashboard editor URL for a page.
 *
 * Pages are scoped by site, so the `/sites/<website_id>/` segment is
 * load-bearing: `/pages/<id>` on its own does not open the page. Returns null
 * when the API gave us no `website_id` — the page name is then reported without
 * a link, which is better than sending an admin somewhere that doesn't resolve.
 */
export function dashboardPageUrl(ref: Pick<InviteRef, 'pageId' | 'websiteId'>): string | null {
	if (ref.websiteId == null) return null;
	return `${DASHBOARD_ORIGIN}/sites/${ref.websiteId}/pages/${ref.pageId}`;
}

/**
 * Whether this run has anything worth saying out loud.
 *
 * The check runs hourly and the overwhelmingly common outcome is that nothing
 * is wrong. An hourly ":white_check_mark: all clear" teaches the channel to
 * scroll past anything from the audit, which costs us the one message that
 * matters. So we stay silent unless there is a problem — broken links, or
 * links we could not check — or something changed since the last run: a fix is
 * worth announcing even though the result itself is all clear.
 *
 * `changeCount` is the length of `recordAudit`'s return; it is passed as a
 * number so this module stays independent of the ledger.
 */
export function auditIsWorthPosting(result: AuditResult, changeCount: number): boolean {
	return result.broken.length > 0 || result.unknown.length > 0 || changeCount > 0;
}

/** Slack mrkdwn for the run. Groups by page so one broken link used in an
 *  email and a text reads as one problem to fix, not two. */
export function formatAuditMessage(result: AuditResult): string {
	const lines: string[] = [];

	if (result.broken.length === 0 && result.unknown.length === 0) {
		lines.push(
			`:white_check_mark: *Slack invite audit* — all clear. ` +
				`${result.distinctUrls} invite link${result.distinctUrls === 1 ? '' : 's'} across ` +
				`${new Set(result.refs.map((r) => r.pageId)).size} page(s) working, ` +
				`${result.pagesScanned} pages scanned.`,
		);
		return lines.join('\n');
	}

	if (result.broken.length > 0) {
		const byPage = new Map<number, InviteRef[]>();
		for (const ref of result.broken) {
			byPage.set(ref.pageId, [...(byPage.get(ref.pageId) ?? []), ref]);
		}
		lines.push(
			// <!here> is Slack's @here: broken invite links are actively turning
			// volunteers away, so this one case is worth pinging the channel over.
			// Deliberately only on the broken branch — the all-clear and the
			// "couldn't check" notice stay quiet.
			`:rotating_light: <!here> *Slack invite audit* — ${byPage.size} page(s) have a broken invite link.`,
			`Anyone clicking these is asked for a staff email address and cannot join.`,
			'',
		);
		for (const pageRefs of byPage.values()) {
			const first = pageRefs[0];
			const editUrl = dashboardPageUrl(first);
			lines.push(
				`• *${first.pageName}*${editUrl ? ` (<${editUrl}|edit in Solidarity>)` : ''}`,
				`    broken in: ${pageRefs.map((r) => r.location).join(', ')}`,
				`    link: ${first.url}`,
				`    ${result.statuses.get(first.url)?.detail ?? ''}`,
			);
		}
	}

	if (result.unknown.length > 0) {
		const urls = new Set(result.unknown.map((r) => r.url));
		lines.push(
			'',
			`:warning: ${urls.size} link(s) could not be checked this run — *not* necessarily broken:`,
		);
		for (const url of urls) {
			lines.push(`• ${url} — ${result.statuses.get(url)?.detail ?? 'unknown'}`);
		}
	}

	return lines.join('\n');
}
