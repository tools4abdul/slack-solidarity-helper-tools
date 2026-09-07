import { describe, it, expect } from 'vitest';
import { diffChannelChapter, unmatchedChapterMembers } from './channel-chapter-diff.js';
import type { UserEntry } from './autocomplete-sources.js';

function slackUser(over: Partial<UserEntry> & { id: string }): UserEntry {
	return { name: over.id, realName: '', email: `${over.id}@example.org`, ...over };
}

const chapterMember = (id: number, email: string) => ({ id, email });

describe('diffChannelChapter', () => {
	it('splits the two sides and counts the overlap', () => {
		const diff = diffChannelChapter(
			new Set(['U1', 'U2']),
			[
				slackUser({ id: 'U1', email: 'both@example.org' }),
				slackUser({ id: 'U2', email: 'slack@example.org' }),
				slackUser({ id: 'U3', email: 'notinchannel@example.org' }),
			],
			[chapterMember(1, 'both@example.org'), chapterMember(2, 'chapter@example.org')],
		);

		expect(diff.inSlackOnly).toEqual(['slack@example.org']);
		expect(diff.inChapterOnly).toEqual(['chapter@example.org']);
		expect(diff.inBothCount).toBe(1);
	});

	it('matches regardless of case and surrounding whitespace', () => {
		const diff = diffChannelChapter(
			new Set(['U1']),
			[slackUser({ id: 'U1', email: '  Person@Example.ORG ' })],
			[chapterMember(1, 'PERSON@example.org')],
		);

		expect(diff.inBothCount).toBe(1);
		expect(diff.inSlackOnly).toEqual([]);
		expect(diff.inChapterOnly).toEqual([]);
	});

	// conversations.members returns bots and apps alongside people; they are not
	// in the human-only Slack user list, so they must vanish entirely rather
	// than surface as members with no email.
	it('ignores channel member ids that are not humans in the Slack directory', () => {
		const diff = diffChannelChapter(
			new Set(['U1', 'BBOT', 'USLACKBOT']),
			[slackUser({ id: 'U1', email: 'person@example.org' })],
			[chapterMember(1, 'person@example.org')],
		);

		expect(diff.inBothCount).toBe(1);
		expect(diff.slackNoEmailCount).toBe(0);
		expect(diff.inSlackOnly).toEqual([]);
	});

	it('counts people with no email on either side instead of listing them', () => {
		const diff = diffChannelChapter(
			new Set(['U1', 'U2']),
			[slackUser({ id: 'U1', email: '' }), slackUser({ id: 'U2', email: '   ' })],
			[chapterMember(1, ''), chapterMember(2, 'has@example.org')],
		);

		expect(diff.slackNoEmailCount).toBe(2);
		expect(diff.chapterNoEmailCount).toBe(1);
		expect(diff.inSlackOnly).toEqual([]);
		expect(diff.inChapterOnly).toEqual(['has@example.org']);
		expect(diff.inBothCount).toBe(0);
	});

	it('lists an email once when duplicate Solidarity records share it', () => {
		const diff = diffChannelChapter(
			new Set(),
			[],
			[chapterMember(1, 'dupe@example.org'), chapterMember(2, 'dupe@example.org')],
		);

		expect(diff.inChapterOnly).toEqual(['dupe@example.org']);
	});

	it('reports two empty lists when the sides agree', () => {
		const diff = diffChannelChapter(
			new Set(['U1', 'U2']),
			[
				slackUser({ id: 'U1', email: 'a@example.org' }),
				slackUser({ id: 'U2', email: 'b@example.org' }),
			],
			[chapterMember(1, 'a@example.org'), chapterMember(2, 'b@example.org')],
		);

		expect(diff.inSlackOnly).toEqual([]);
		expect(diff.inChapterOnly).toEqual([]);
		expect(diff.inBothCount).toBe(2);
	});

	it('sorts both lists', () => {
		const diff = diffChannelChapter(
			new Set(['U1', 'U2', 'U3']),
			[
				slackUser({ id: 'U1', email: 'zeta@example.org' }),
				slackUser({ id: 'U2', email: 'alpha@example.org' }),
				slackUser({ id: 'U3', email: 'mid@example.org' }),
			],
			[chapterMember(1, 'yankee@example.org'), chapterMember(2, 'bravo@example.org')],
		);

		expect(diff.inSlackOnly).toEqual(['alpha@example.org', 'mid@example.org', 'zeta@example.org']);
		expect(diff.inChapterOnly).toEqual(['bravo@example.org', 'yankee@example.org']);
	});

	it('reports a null hidden count when no activity window is applied', () => {
		const diff = diffChannelChapter(new Set(), [], [chapterMember(1, 'a@example.org')]);
		expect(diff.inChapterOnlyHiddenCount).toBeNull();
	});

	describe('with an activity window', () => {
		it('holds inactive chapter members out of inChapterOnly and counts them', () => {
			const diff = diffChannelChapter(
				new Set(),
				[],
				[chapterMember(1, 'active@example.org'), chapterMember(2, 'quiet@example.org')],
				new Set([1]),
			);

			expect(diff.inChapterOnly).toEqual(['active@example.org']);
			expect(diff.inChapterOnlyHiddenCount).toBe(1);
		});

		// The filter narrows the Solidarity-side list only. A quiet chapter member
		// is still in the chapter, so they must not start reading as missing from it.
		it('does not push inactive chapter members into inSlackOnly', () => {
			const diff = diffChannelChapter(
				new Set(['U1']),
				[slackUser({ id: 'U1', email: 'quiet@example.org' })],
				[chapterMember(1, 'quiet@example.org')],
				new Set(),
			);

			expect(diff.inSlackOnly).toEqual([]);
			expect(diff.inBothCount).toBe(1);
			expect(diff.inChapterOnlyHiddenCount).toBe(0);
		});

		// Someone with two Solidarity records is one human; activity on either
		// record is activity.
		it('treats an email as active when any record sharing it is active', () => {
			const diff = diffChannelChapter(
				new Set(),
				[],
				[chapterMember(1, 'dupe@example.org'), chapterMember(2, 'dupe@example.org')],
				new Set([2]),
			);

			expect(diff.inChapterOnly).toEqual(['dupe@example.org']);
			expect(diff.inChapterOnlyHiddenCount).toBe(0);
		});

		it('never counts an emailless chapter member as hidden by the window', () => {
			const diff = diffChannelChapter(new Set(), [], [chapterMember(1, '')], new Set());

			expect(diff.chapterNoEmailCount).toBe(1);
			expect(diff.inChapterOnlyHiddenCount).toBe(0);
		});
	});

	describe('unmatchedChapterMembers', () => {
		// This set decides how much the activity filter costs, so it has to be
		// exactly the people who could appear in inChapterOnly — no more.
		it('is the chapter members with an email who are not in the channel', () => {
			const members = unmatchedChapterMembers(
				new Set(['U1']),
				[slackUser({ id: 'U1', email: 'inchannel@example.org' })],
				[
					chapterMember(1, 'inchannel@example.org'),
					chapterMember(2, 'missing@example.org'),
					chapterMember(3, ''),
				],
			);

			expect(members.map((m) => m.id)).toEqual([2]);
		});

		it('matches the unfiltered inChapterOnly list it is meant to predict', () => {
			const channel = new Set(['U1']);
			const slack = [slackUser({ id: 'U1', email: 'both@example.org' })];
			const chapter = [
				chapterMember(1, 'both@example.org'),
				chapterMember(2, 'a@example.org'),
				chapterMember(3, 'b@example.org'),
				chapterMember(4, 'b@example.org'),
			];

			const emails = new Set(unmatchedChapterMembers(channel, slack, chapter).map((m) => m.email));

			expect([...emails].sort()).toEqual(diffChannelChapter(channel, slack, chapter).inChapterOnly);
		});
	});
});
