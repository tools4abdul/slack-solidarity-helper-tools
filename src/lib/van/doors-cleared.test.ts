import { describe, it, expect } from 'vitest';
import {
	canvasserTotals,
	chapterTotals,
	dailyDoorsCleared,
	latestActiveDay,
	rowsOnDay,
	unmovedDoorsWarning,
	type ClearedRow,
} from './doors-cleared.js';

function row(over: Partial<ClearedRow> = {}): ClearedRow {
	return {
		mapRouteId: 100,
		chapterId: 71,
		chapterName: 'Washtenaw County',
		slackUserId: 'U1',
		slackUserName: 'Dana',
		completedAt: '2026-09-12T18:00:00.000Z',
		doorsCleared: 60,
		...over,
	};
}

describe('dailyDoorsCleared', () => {
	it('buckets by campaign day, not by UTC day', () => {
		// 01:30Z on the 13th is 21:30 on the 12th in Detroit — the evening the
		// volunteer was actually out. Bucketing on the UTC date would file a
		// Saturday night canvass under Sunday.
		const days = dailyDoorsCleared([row({ completedAt: '2026-09-13T01:30:00.000Z' })]);
		expect(days.map((d) => d.date)).toEqual(['2026-09-12']);
	});

	it('totals doors and turfs per day, oldest first', () => {
		const days = dailyDoorsCleared([
			row({ completedAt: '2026-09-12T18:00:00.000Z', doorsCleared: 60 }),
			row({ completedAt: '2026-09-12T20:00:00.000Z', doorsCleared: 40 }),
			row({ completedAt: '2026-09-11T18:00:00.000Z', doorsCleared: 10 }),
		]);
		expect(days.map((d) => [d.date, d.doorsCleared, d.turfsCompleted])).toEqual([
			['2026-09-11', 10, 1],
			['2026-09-12', 100, 2],
		]);
	});

	it('counts an uncounted completion as a turf with no doors', () => {
		// The two clocks: a completion is known instantly, its doors are not
		// known until VAN re-cuts. A null must not read as zero doors cleared.
		const [day] = dailyDoorsCleared([row({ doorsCleared: null })]);
		expect(day).toMatchObject({ doorsCleared: 0, turfsCompleted: 1, awaitingCount: 1 });
	});

	it('breaks a day down by chapter', () => {
		const [day] = dailyDoorsCleared([
			row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 60 }),
			row({ chapterId: 12, chapterName: 'Oakland County', doorsCleared: 25 }),
			row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 15 }),
		]);
		expect(day.byChapter).toEqual([
			{
				chapterId: 12,
				chapterName: 'Oakland County',
				doorsCleared: 25,
				turfsCompleted: 1,
			},
			{
				chapterId: 71,
				chapterName: 'Washtenaw County',
				doorsCleared: 75,
				turfsCompleted: 2,
			},
		]);
	});

	it('leaves quiet days out rather than zero-filling them', () => {
		const days = dailyDoorsCleared([
			row({ completedAt: '2026-09-08T18:00:00.000Z' }),
			row({ completedAt: '2026-09-12T18:00:00.000Z' }),
		]);
		expect(days).toHaveLength(2);
	});
});

describe('chapterTotals', () => {
	it('counts distinct volunteers, not completions', () => {
		const [total] = chapterTotals([
			row({ slackUserId: 'U1' }),
			row({ slackUserId: 'U1' }),
			row({ slackUserId: 'U2' }),
		]);
		expect(total).toMatchObject({ turfsCompleted: 3, canvassers: 2, doorsCleared: 180 });
	});

	it('carries the count of completions still waiting on VAN', () => {
		const [total] = chapterTotals([row(), row({ doorsCleared: null })]);
		expect(total).toMatchObject({ doorsCleared: 60, turfsCompleted: 2, awaitingCount: 1 });
	});
});

describe('canvasserTotals', () => {
	it('ranks by doors, then by turfs, then by name', () => {
		const totals = canvasserTotals([
			row({ slackUserId: 'U1', slackUserName: 'Dana', doorsCleared: 40 }),
			row({ slackUserId: 'U2', slackUserName: 'Sam', doorsCleared: 90 }),
			row({ slackUserId: 'U3', slackUserName: 'Alex', doorsCleared: 40 }),
			row({ slackUserId: 'U3', slackUserName: 'Alex', doorsCleared: null }),
		]);
		expect(totals.map((t) => t.slackUserName)).toEqual(['Sam', 'Alex', 'Dana']);
	});

	it('keeps someone whose doors are not counted yet on the board', () => {
		// They finished three turfs an hour ago. Ordering on doors alone would
		// leave them off a board they are currently topping.
		const totals = canvasserTotals([
			row({ slackUserId: 'U1', slackUserName: 'Dana', doorsCleared: null }),
			row({ slackUserId: 'U1', slackUserName: 'Dana', doorsCleared: null }),
			row({ slackUserId: 'U2', slackUserName: 'Sam', doorsCleared: null }),
		]);
		expect(totals.map((t) => [t.slackUserName, t.doorsCleared, t.turfsCompleted])).toEqual([
			['Dana', 0, 2],
			['Sam', 0, 1],
		]);
	});

	it('files someone who worked two chapters under the busier one', () => {
		const [total] = canvasserTotals([
			row({ chapterName: 'Oakland County', doorsCleared: 10 }),
			row({ chapterName: 'Washtenaw County', doorsCleared: 90 }),
		]);
		expect(total.chapterName).toBe('Washtenaw County');
	});

	it('still names a chapter for someone with no doors counted yet', () => {
		const [total] = canvasserTotals([
			row({ chapterName: 'Oakland County', doorsCleared: null }),
			row({ chapterName: 'Oakland County', doorsCleared: null }),
		]);
		expect(total.chapterName).toBe('Oakland County');
	});
});

describe('latestActiveDay and rowsOnDay', () => {
	it('finds the most recent campaign day with any completion', () => {
		expect(
			latestActiveDay([
				row({ completedAt: '2026-09-08T18:00:00.000Z' }),
				row({ completedAt: '2026-09-12T18:00:00.000Z' }),
			]),
		).toBe('2026-09-12');
	});

	it('is null with nothing to show', () => {
		expect(latestActiveDay([])).toBeNull();
	});

	it('selects one campaign day, including its late evening', () => {
		const rows = [
			row({ completedAt: '2026-09-12T18:00:00.000Z' }),
			row({ completedAt: '2026-09-13T01:30:00.000Z' }),
			row({ completedAt: '2026-09-13T18:00:00.000Z' }),
		];
		expect(rowsOnDay(rows, '2026-09-12')).toHaveLength(2);
	});
});

describe('unmovedDoorsWarning', () => {
	it('says nothing on a sample too small to mean anything', () => {
		expect(unmovedDoorsWarning([row({ doorsCleared: 0 }), row({ doorsCleared: 0 })])).toBeNull();
	});

	it('says nothing while any turf is clearing doors', () => {
		const rows = [...Array(5)].map(() => row({ doorsCleared: 0 }));
		expect(unmovedDoorsWarning([...rows, row({ doorsCleared: 12 })])).toBeNull();
	});

	it('names both causes when a run of completions clears nothing', () => {
		// The two are indistinguishable from here, and one of them (turf cut
		// without a "not yet contacted" filter) makes every number on the board
		// zero however many doors are knocked.
		const rows = [...Array(5)].map(() => row({ doorsCleared: 0 }));
		const warning = unmovedDoorsWarning(rows);
		expect(warning).toContain('MiniVAN is not being synced');
		expect(warning).toContain('not yet contacted');
	});

	it('ignores completions VAN has not counted yet when sizing the sample', () => {
		// Six completions, only two measured — not enough to accuse anyone.
		const rows = [
			...[...Array(2)].map(() => row({ doorsCleared: 0 })),
			...[...Array(4)].map(() => row({ doorsCleared: null })),
		];
		expect(unmovedDoorsWarning(rows)).toBeNull();
	});
});
