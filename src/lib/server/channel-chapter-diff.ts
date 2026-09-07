// Ad-hoc channel ↔ chapter reconciliation: given any one Slack channel and any
// one Solidarity chapter, who is in one but not the other, matched by email.
//
// The two existing reconcilers only diff *configured* pairs — chapter-reconcile
// against the channels a chapter is mapped to, coalition-reconcile against a
// coalition's user list — so neither can answer the question for an arbitrary
// pair. Read-only: nothing here invites, marks, or writes anything.
//
// Same split as those two: the pure matching (`diffChannelChapter`) is
// separated from the orchestrator (`computeChannelChapterDiff`) so the rules
// are unit-testable without Slack/Solidarity mocks.

import type { WebClient } from '@slack/web-api';
import {
	getSlackUsers,
	getSolidarityChapterMembers,
	type UserEntry,
	type SolidarityChapterMemberEntry,
} from './autocomplete-sources.js';
import { fetchChannelMemberIds } from './coalition-reconcile.js';
import { resolveActiveIds } from './solidarity-activity.js';

export interface ChannelChapterDiff {
	/** Lowercased emails, sorted: in the Slack channel, not in the chapter. */
	inSlackOnly: string[];
	/** Lowercased emails, sorted: in the chapter, not in the Slack channel. */
	inChapterOnly: string[];
	/** In both. Count only — the page reports it as the agreement line. */
	inBothCount: number;
	/** Human channel members whose Slack profile carries no email. Unmatchable,
	 *  and reported so the counts visibly account for everyone rather than
	 *  quietly dropping people out of both lists. */
	slackNoEmailCount: number;
	/** Chapter members with no email on their Solidarity record. Same reason. */
	chapterNoEmailCount: number;
	/** People held back from `inChapterOnly` by the activity window, or null
	 *  when no window was applied. Reported so a shrinking list is visibly the
	 *  filter's doing rather than the chapter's. */
	inChapterOnlyHiddenCount: number | null;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * The channel's human members by email.
 *
 * `channelMemberIds` comes from conversations.members and includes bots and
 * apps; membership is intersected with the human-only `slackUsers` cache, so
 * non-humans (this bot included) are ignored entirely and can never inflate
 * the no-email count — a bot having no profile email is not a finding.
 */
function channelEmails(
	channelMemberIds: ReadonlySet<string>,
	slackUsers: readonly UserEntry[],
): { emails: Set<string>; noEmailCount: number } {
	const emails = new Set<string>();
	let noEmailCount = 0;
	for (const user of slackUsers) {
		if (!channelMemberIds.has(user.id)) continue;
		const email = normalizeEmail(user.email);
		if (email === '') {
			noEmailCount++;
			continue;
		}
		emails.add(email);
	}
	return { emails, noEmailCount };
}

/**
 * The chapter members who would land in `inChapterOnly` with no activity
 * window applied — the only people whose activity can change any answer.
 *
 * Knowing this set before doing any activity work is what lets the orchestrator
 * choose between looking these few people up directly and scanning the activity
 * collections wholesale.
 */
export function unmatchedChapterMembers(
	channelMemberIds: ReadonlySet<string>,
	slackUsers: readonly UserEntry[],
	chapterMembers: readonly SolidarityChapterMemberEntry[],
): SolidarityChapterMemberEntry[] {
	const { emails } = channelEmails(channelMemberIds, slackUsers);
	return chapterMembers.filter((m) => {
		const email = normalizeEmail(m.email);
		return email !== '' && !emails.has(email);
	});
}

/**
 * Pure matching pass. Bots and apps are filtered out by `channelEmails`.
 */
export function diffChannelChapter(
	channelMemberIds: ReadonlySet<string>,
	slackUsers: readonly UserEntry[],
	chapterMembers: readonly SolidarityChapterMemberEntry[],
	activeUserIds: ReadonlySet<number> | null = null,
): ChannelChapterDiff {
	const { emails: slackEmails, noEmailCount: slackNoEmailCount } = channelEmails(
		channelMemberIds,
		slackUsers,
	);

	// email -> is anyone holding that address active? Duplicate Solidarity
	// accounts sharing an email collapse into one person, so a list never shows
	// the same address twice — and that person counts as active if any of their
	// records is, since they are one human either way.
	const chapterEmails = new Map<string, boolean>();
	let chapterNoEmailCount = 0;
	for (const member of chapterMembers) {
		const email = normalizeEmail(member.email);
		if (email === '') {
			chapterNoEmailCount++;
			continue;
		}
		const active = activeUserIds === null || activeUserIds.has(member.id);
		chapterEmails.set(email, (chapterEmails.get(email) ?? false) || active);
	}

	const inSlackOnly: string[] = [];
	let inBothCount = 0;
	for (const email of slackEmails) {
		if (chapterEmails.has(email)) inBothCount++;
		else inSlackOnly.push(email);
	}

	// The activity window narrows this list only. Applying it to the comparison
	// as a whole would push quiet chapter members into `inSlackOnly`, which
	// would then no longer mean what its name says.
	const inChapterOnly: string[] = [];
	let inChapterOnlyHiddenCount = 0;
	for (const [email, active] of chapterEmails) {
		if (slackEmails.has(email)) continue;
		if (active) inChapterOnly.push(email);
		else inChapterOnlyHiddenCount++;
	}

	inSlackOnly.sort();
	inChapterOnly.sort();

	return {
		inSlackOnly,
		inChapterOnly,
		inBothCount,
		slackNoEmailCount,
		chapterNoEmailCount,
		inChapterOnlyHiddenCount: activeUserIds === null ? null : inChapterOnlyHiddenCount,
	};
}

export async function computeChannelChapterDiff(opts: {
	slack: WebClient;
	token: string;
	channelId: string;
	chapterId: number;
	/** Unix ms; only chapter members active since then reach `inChapterOnly`.
	 *  Null (the default) applies no activity window and costs no extra reads. */
	activeSinceMs?: number | null;
}): Promise<ChannelChapterDiff> {
	const [channelMemberIds, slackUsersResult] = await Promise.all([
		fetchChannelMemberIds(opts.slack, opts.channelId),
		getSlackUsers(opts.slack),
	]);

	// The Solidarity reads run one after the other, and after the Slack ones:
	// each is a paced multi-page walk already sitting near the 60-per-30s
	// ceiling, so overlapping them would only buy 429s.
	const chapterMembersResult = await getSolidarityChapterMembers(opts.token, opts.chapterId);

	const activeSinceMs = opts.activeSinceMs ?? null;
	const activeUserIds =
		activeSinceMs === null
			? null
			: await resolveActiveIds(
					opts.token,
					// Only these people's activity can change the answer, so only
					// these are worth paying to find out about.
					unmatchedChapterMembers(
						channelMemberIds,
						slackUsersResult.items,
						chapterMembersResult.items,
					).map((m) => m.id),
					activeSinceMs,
				);

	return diffChannelChapter(
		channelMemberIds,
		slackUsersResult.items,
		chapterMembersResult.items,
		activeUserIds,
	);
}
