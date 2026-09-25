// Chapter reconciliation: compute who in the Slack workspace belongs in which
// chapter-mapped channel (per the chapter_channel_map settings) but isn't a
// member yet, so the /settings "move members" flow can preview and then invite
// them in bulk. Invite-only by design — nobody is ever removed from a channel.
//
// Same split as coalition-reconcile.ts: the pure bucketing
// (`bucketChapterMoves`) is separated from the orchestrator
// (`computeChapterMovePlan`) so the matching rules are unit-testable without
// Slack/Solidarity mocks.

import type { WebClient } from '@slack/web-api';
import { getSlackUsers, type UserEntry } from './autocomplete-sources.js';
import { fetchChannelMemberIds } from './coalition-reconcile.js';
import { fetchPaginated } from './solidarity-paginate.js';
import { chapterIdsOf } from './solidarity-chapter-ids.js';

/** The slice of a Solidarity /v1/users record the chapter diff needs. */
export interface SolidarityChapterUser {
	id: number;
	email: string | null;
	chapter_id: number | null;
	chapter_ids?: number[];
}

/** One person to invite into one channel, with the chapters that justify it. */
export interface ChapterMoveTarget {
	slackUserId: string;
	email: string;
	/** Slack display name. */
	name: string;
	/** Names of the person's chapters that map to this channel. */
	chapterNames: string[];
}

export interface ChannelMovePlan {
	channelId: string;
	/** Sorted by display name. */
	toInvite: ChapterMoveTarget[];
}

export interface ChapterMovePlan {
	/** Only channels with at least one person to invite, in mapping order. */
	channels: ChannelMovePlan[];
	/** Matched Slack members already in every channel their chapters map to. */
	alreadyInPlaceCount: number;
	/** Solidarity members of mapped chapters who can't be matched to a Slack
	 *  account (no email on the Solidarity record, or email not in the
	 *  workspace). Nothing we can do — report-only. */
	notInSlackCount: number;
	/** Solidarity members whose chapters exist but none are mapped to a channel. */
	unmappedChaptersCount: number;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Pure matching pass. `membersByChannel` comes from conversations.members and
 * may include bots/apps; that only ever makes someone count as "already in
 * place", never adds an invite, so non-humans need no special-casing.
 * Solidarity users with no chapters at all are ignored — they have nowhere to
 * be moved to and would drown the counts.
 */
export function bucketChapterMoves(
	slackUsers: readonly UserEntry[],
	solidarityUsers: readonly SolidarityChapterUser[],
	entries: readonly { chapterId: number; channelId: string; name: string }[],
	membersByChannel: ReadonlyMap<string, ReadonlySet<string>>,
): ChapterMovePlan {
	const channelsByChapter = new Map<number, { channelId: string; chapterName: string }[]>();
	for (const e of entries) {
		const list = channelsByChapter.get(e.chapterId) ?? [];
		list.push({ channelId: e.channelId, chapterName: e.name });
		channelsByChapter.set(e.chapterId, list);
	}

	const slackByEmail = new Map<string, UserEntry>();
	for (const u of slackUsers) {
		if (u.email) slackByEmail.set(normalizeEmail(u.email), u);
	}

	// channelId → slackUserId → target, so a person is listed once per channel
	// even when several of their chapters map to it.
	const invitesByChannel = new Map<string, Map<string, ChapterMoveTarget>>();
	let alreadyInPlaceCount = 0;
	let notInSlackCount = 0;
	let unmappedChaptersCount = 0;
	const seenEmails = new Set<string>();

	for (const person of solidarityUsers) {
		const chapterIds = chapterIdsOf(person);
		if (chapterIds.length === 0) continue;

		const mappings = chapterIds.flatMap((id) => channelsByChapter.get(id) ?? []);
		if (mappings.length === 0) {
			unmappedChaptersCount++;
			continue;
		}

		const email = person.email ? normalizeEmail(person.email) : '';
		if (email === '') {
			notInSlackCount++;
			continue;
		}
		// Duplicate Solidarity accounts sharing an email would double-count;
		// first record wins, matching findUserByEmailStrict's _limit=1.
		if (seenEmails.has(email)) continue;
		seenEmails.add(email);

		const slackUser = slackByEmail.get(email);
		if (!slackUser) {
			notInSlackCount++;
			continue;
		}

		let invitedSomewhere = false;
		for (const { channelId, chapterName } of mappings) {
			if (membersByChannel.get(channelId)?.has(slackUser.id)) continue;
			invitedSomewhere = true;
			let channelInvites = invitesByChannel.get(channelId);
			if (!channelInvites) {
				channelInvites = new Map();
				invitesByChannel.set(channelId, channelInvites);
			}
			const existing = channelInvites.get(slackUser.id);
			if (existing) {
				if (!existing.chapterNames.includes(chapterName)) {
					existing.chapterNames.push(chapterName);
				}
			} else {
				channelInvites.set(slackUser.id, {
					slackUserId: slackUser.id,
					email,
					name: slackUser.name,
					chapterNames: [chapterName],
				});
			}
		}
		if (!invitedSomewhere) alreadyInPlaceCount++;
	}

	const channels: ChannelMovePlan[] = [...invitesByChannel.entries()].map(
		([channelId, targets]) => ({
			channelId,
			toInvite: [...targets.values()].sort((a, b) => a.name.localeCompare(b.name)),
		}),
	);

	return { channels, alreadyInPlaceCount, notInSlackCount, unmappedChaptersCount };
}

/** Every Solidarity user, one paginated walk — the same full-table pass the
 *  nightly snapshot does, so scale is already proven acceptable. */
function fetchAllSolidarityUsers(token: string): Promise<SolidarityChapterUser[]> {
	return fetchPaginated<SolidarityChapterUser>(
		token,
		'/v1/users',
		'/v1/users',
		'',
		'chapter-reconcile',
	);
}

export async function computeChapterMovePlan(opts: {
	slack: WebClient;
	token: string;
	entries: readonly { chapterId: number; channelId: string; name: string }[];
}): Promise<ChapterMovePlan> {
	const channelIds = [...new Set(opts.entries.map((e) => e.channelId))];
	const [slackUsersResult, solidarityUsers, memberSets] = await Promise.all([
		getSlackUsers(opts.slack),
		fetchAllSolidarityUsers(opts.token),
		Promise.all(
			channelIds.map(async (id) => [id, await fetchChannelMemberIds(opts.slack, id)] as const),
		),
	]);

	return bucketChapterMoves(
		slackUsersResult.items,
		solidarityUsers,
		opts.entries,
		new Map(memberSets),
	);
}
