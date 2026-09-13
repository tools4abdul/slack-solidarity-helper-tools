import { describe, it, expect } from 'vitest';
import { buildDoorsLeaderboard, type BuildLeaderboardInput } from './doors-leaderboard.js';
import type { ClearedRow } from './doors-cleared.js';
import { DEFAULT_RANKING_ALPHA, TOP_N } from '../growth-ranking.js';

const WINDOW_START = new Date('2026-09-07T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-14T00:00:00.000Z');
/** Well before the window before this one, so weeks are comparable. */
const OLD_CUTOVER = '2026-07-01T00:00:00.000Z';

function row(over: Partial<ClearedRow> = {}): ClearedRow {
	return {
		mapRouteId: 100,
		chapterId: 71,
		chapterName: 'Washtenaw County',
		slackUserId: 'U1',
		slackUserName: 'Dana',
		completedAt: '2026-09-09T18:00:00.000Z',
		doorsCleared: 100,
		...over,
	};
}

function build(over: Partial<BuildLeaderboardInput> = {}) {
	return buildDoorsLeaderboard({
		rows: [],
		prevRows: [],
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
		cutoverAt: OLD_CUTOVER,
		rankingAlpha: DEFAULT_RANKING_ALPHA,
		...over,
	});
}

describe('buildDoorsLeaderboard — the metric set', () => {
	it('reports doors cleared, turfs completed and canvassers out', () => {
		const board = build({
			rows: [
				row({ slackUserId: 'U1', doorsCleared: 100 }),
				row({ slackUserId: 'U2', doorsCleared: 60 }),
			],
		});
		expect(board).toMatchObject({
			totalDoorsCleared: 160,
			totalTurfsCompleted: 2,
			totalCanvassers: 2,
		});
		expect(board.topChapters[0]).toMatchObject({
			doorsCleared: 160,
			turfsCompleted: 2,
			canvassers: 2,
		});
	});

	it('counts a volunteer once across two chapters in the window total', () => {
		const board = build({
			rows: [
				row({ slackUserId: 'U1', chapterId: 71, chapterName: 'Washtenaw County' }),
				row({ slackUserId: 'U1', chapterId: 12, chapterName: 'Oakland County' }),
			],
		});
		expect(board.totalCanvassers).toBe(1);
		// Per chapter they are one canvasser in each, which is the honest answer
		// to a different question.
		expect(board.topChapters.map((c) => c.canvassers)).toEqual([1, 1]);
	});

	it('keeps a chapter whose doors are not counted yet on the board', () => {
		// Its canvass finished this evening; VAN recounts overnight. Dropping it
		// would make the busiest county vanish from its own canvass day.
		const board = build({ rows: [row({ doorsCleared: null })] });
		expect(board.topChapters).toHaveLength(1);
		expect(board.topChapters[0]).toMatchObject({ doorsCleared: 0, awaitingCount: 1 });
		expect(board.awaitingCount).toBe(1);
	});
});

describe('buildDoorsLeaderboard — ranking', () => {
	it('ranks a chapter with a prior-week comparison above one without', () => {
		const board = build({
			rows: [
				row({ chapterId: 12, chapterName: 'Oakland County', doorsCleared: 500 }),
				row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 120 }),
			],
			prevRows: [row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 60 })],
		});
		expect(board.topChapters.map((c) => c.chapterName)).toEqual([
			'Washtenaw County',
			'Oakland County',
		]);
	});

	it('computes week-over-week change against the previous window', () => {
		const board = build({
			rows: [row({ doorsCleared: 150 })],
			prevRows: [row({ doorsCleared: 100 })],
		});
		expect(board.topChapters[0]).toMatchObject({ prevDoors: 100, pct: 50, comparable: true });
	});

	it('caps the board at the shared TOP_N', () => {
		const rows = [...Array(TOP_N + 3)].map((_, i) =>
			row({ chapterId: i, chapterName: `Chapter ${i}`, doorsCleared: 10 * (i + 1) }),
		);
		expect(build({ rows }).topChapters).toHaveLength(TOP_N);
	});
});

describe('buildDoorsLeaderboard — the cutover (9.9)', () => {
	it('suppresses every week-over-week figure in the first VAN week', () => {
		// The previous window is Openfield's, which counted doors KNOCKED. A
		// percentage across that boundary divides one metric by another.
		const board = build({
			rows: [row({ doorsCleared: 150 })],
			prevRows: [row({ doorsCleared: 100 })],
			cutoverAt: '2026-09-05T00:00:00.000Z',
		});
		expect(board.firstVanWeek).toBe(true);
		expect(board.topChapters[0]).toMatchObject({ comparable: false, prevDoors: 0, pct: 0 });
	});

	it('treats a window whose predecessor is entirely VAN-era as comparable', () => {
		const board = build({
			rows: [row()],
			prevRows: [row({ doorsCleared: 50 })],
			cutoverAt: '2026-08-20T00:00:00.000Z',
		});
		expect(board.firstVanWeek).toBe(false);
		expect(board.topChapters[0].comparable).toBe(true);
	});

	it('treats no data at all as a first VAN week', () => {
		expect(build({ rows: [row()], cutoverAt: null }).firstVanWeek).toBe(true);
	});

	it('falls back to raw volume when nobody is comparable', () => {
		const board = build({
			rows: [
				row({ chapterId: 12, chapterName: 'Oakland County', doorsCleared: 500 }),
				row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 120 }),
			],
			prevRows: [row({ chapterId: 71, chapterName: 'Washtenaw County', doorsCleared: 60 })],
			cutoverAt: '2026-09-05T00:00:00.000Z',
		});
		// Exactly what 9.9 asks the first VAN week to be: volume, no denominator.
		expect(board.topChapters.map((c) => c.chapterName)).toEqual([
			'Oakland County',
			'Washtenaw County',
		]);
	});
});
