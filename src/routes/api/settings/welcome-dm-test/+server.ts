import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, type ChapterEntry } from '$lib/server/settings.js';
import { findSolidarityUserForSlack } from '$lib/server/slack-solidarity-user.js';
import { chapterIdsOf } from '$lib/server/solidarity-chapter-ids.js';
import { errMessage } from '$lib/err-message.js';
import { getSlackChannels } from '$lib/server/autocomplete-sources.js';
import { DEFAULT_WELCOME_DM, renderWelcomeDm } from '$lib/welcome-dm.js';
import { resolveChannelLinks } from '$lib/channel-tokens.js';

// "Send this DM to me" — renders the welcome template and DMs it to the signed-
// in admin so they can proof-read the real thing (links, emoji, formatting)
// before a new member ever sees it. The message can be the unsaved textarea
// value (body.welcomeDmMessage) so testing doesn't require saving first; when
// absent it falls back to the saved setting.
//
// `{{channels}}` is filled with the ADMIN's own chapter channels when their
// Slack account maps to a Solidarity member (Slack id → admin-made link or
// email → Solidarity chapters → channel map). Many admins aren't mapped
// members — their Slack email may not match their Solidarity email and nobody
// has linked them, or they have no account — so when the personal lookup comes
// up empty we fall back to a small SAMPLE of real mapped channels so the
// preview still shows genuine clickable links. The test DM's header states
// which mode was used so the sample is never mistaken for the recipient's
// actual channels. Only with no channel map at all do we show a placeholder.
interface TestBody {
	welcomeDmMessage?: unknown;
}

const NO_CHANNELS_PLACEHOLDER = '#your-chapter-channel(s)';
const SAMPLE_CHANNEL_COUNT = 2;

type PreviewMode = 'personalized' | 'sample' | 'placeholder';

const MODE_NOTE: Record<PreviewMode, string> = {
	personalized: ':test_tube: Welcome DM preview — showing *your* chapter channels',
	sample:
		":test_tube: Welcome DM preview — your Slack email isn't linked to a Solidarity chapter, so {{channels}} shows *example* channels",
	placeholder:
		':test_tube: Welcome DM preview — no chapter channels are configured, so {{channels}} shows a placeholder',
};

/** The admin's own chapter channels (deduped), or [] when their Slack account
 *  can't be mapped to a Solidarity member with mapped chapters. Never throws —
 *  a lookup failure just yields the placeholder preview. */
async function resolveOwnChannelIds(
	slackUserId: string,
	chapterChannelMap: ChapterEntry[],
): Promise<string[]> {
	try {
		const solidarityUser = await findSolidarityUserForSlack(db, slackUserId);
		if (!solidarityUser) return [];
		const chapterIds = chapterIdsOf(solidarityUser);
		if (chapterIds.length === 0) return [];
		return [
			...new Set(
				chapterChannelMap.filter((e) => chapterIds.includes(e.chapterId)).map((e) => e.channelId),
			),
		];
	} catch (err) {
		// The lenient getUserByEmail this replaced logged its failures; the shared
		// lookup throws instead, so the log lives here now.
		console.error(
			`[settings] welcome-dm test: account lookup failed for ${slackUserId}:`,
			errMessage(err),
		);
		return [];
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: TestBody;
	try {
		body = (await request.json()) as TestBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	if (body.welcomeDmMessage !== undefined && typeof body.welcomeDmMessage !== 'string') {
		return json({ error: 'welcomeDmMessage must be a string' }, { status: 400 });
	}

	const settings = await loadSettings(db);
	const template = body.welcomeDmMessage ?? settings.welcomeDmMessage;

	const ownChannelIds = await resolveOwnChannelIds(
		locals.session.slackUserId,
		settings.chapterChannelMap,
	);
	// Sample of real mapped channels for the fallback — first couple of distinct
	// channel ids in the chapter map, so the preview shows genuine links.
	const sampleChannelIds = [...new Set(settings.chapterChannelMap.map((e) => e.channelId))].slice(
		0,
		SAMPLE_CHANNEL_COUNT,
	);

	let previewChannelIds: string[];
	let mode: PreviewMode;
	if (ownChannelIds.length > 0) {
		previewChannelIds = ownChannelIds;
		mode = 'personalized';
	} else if (sampleChannelIds.length > 0) {
		previewChannelIds = sampleChannelIds;
		mode = 'sample';
	} else {
		previewChannelIds = [];
		mode = 'placeholder';
	}

	let nameToId = new Map<string, string>();
	try {
		const { items } = await getSlackChannels(slack);
		nameToId = new Map(items.map((c) => [c.name.toLowerCase(), c.id]));
	} catch {
		// Non-fatal: `#name` tokens stay literal in the test message.
	}

	// Personalized/sample render exactly as the join flow would (real <#…>
	// links). The placeholder path fills {{channels}} with a labeled stand-in,
	// still resolving #name links and the blank-template default.
	const text =
		mode === 'placeholder'
			? resolveChannelLinks(
					(template.trim() || DEFAULT_WELCOME_DM).replaceAll(
						'{{channels}}',
						NO_CHANNELS_PLACEHOLDER,
					),
					nameToId,
				)
			: renderWelcomeDm(template, previewChannelIds, nameToId);

	try {
		const dm = await slack.conversations.open({ users: locals.session.slackUserId });
		const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
		if (!dmChannelId) {
			return json({ error: 'Could not open a DM channel with you.' }, { status: 502 });
		}
		await slack.chat.postMessage({
			channel: dmChannelId,
			text: `${MODE_NOTE[mode]}\n${text}`,
			blocks: [
				{ type: 'context', elements: [{ type: 'mrkdwn', text: MODE_NOTE[mode] }] },
				{ type: 'section', text: { type: 'mrkdwn', text } },
			],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[settings] welcome-dm test send failed:', msg);
		return json({ error: `Slack rejected the test send: ${msg}` }, { status: 502 });
	}

	console.log(
		`[settings] sent welcome-DM test to ${locals.session.slackUserId} (${locals.session.slackUserName ?? '?'})`,
	);
	return json({ ok: true });
};
