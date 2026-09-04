import { describe, it, expect } from 'vitest';
import type { DaySignups } from '$lib/server/dashboard-signups.js';
import {
	DASHBOARD_TOP_N,
	MAX_X_TICKS,
	OTHER_BAND_LABEL,
	NO_CHAPTER_BAND_LABEL,
	buildCountySummary,
	buildDetailFrame,
	buildOverviewFrame,
	formatDateTick,
	thinDateTicks,
} from './chart-data.js';

function day(
	date: string,
	total: number,
	byChapter: Array<{ chapterId: number | null; chapterName: string | null; count: number }>,
): DaySignups {
	return { date, total, byChapter };
}

describe('buildOverviewFrame', () => {
	it('returns empty bands for empty input', () => {
		const frame = buildOverviewFrame([], 'Solidarity');
		expect(frame.dates).toEqual([]);
		expect(frame.bands).toEqual([]);
	});

	it('zero-fills across a date gap', () => {
		const days: DaySignups[] = [day('2026-05-01', 3, []), day('2026-05-04', 5, [])];
		const frame = buildOverviewFrame(days, 'Slack');
		expect(frame.dates).toEqual(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']);
		expect(frame.bands).toHaveLength(1);
		expect(frame.bands[0]!.values).toEqual([3, 0, 0, 5]);
		expect(frame.bands[0]!.label).toBe('Slack signups');
	});
});

describe('buildDetailFrame', () => {
	it('returns empty bands for empty input', () => {
		const frame = buildDetailFrame([]);
		expect(frame.bands).toEqual([]);
		expect(frame.dailyTotals).toBeUndefined();
	});

	it('Solidarity: sum of bands per day equals the server total per day', () => {
		const days: DaySignups[] = [
			day('2026-05-01', 6, [
				{ chapterId: 1, chapterName: 'A', count: 4 },
				{ chapterId: 2, chapterName: 'B', count: 2 },
			]),
			day('2026-05-02', 5, [
				{ chapterId: 1, chapterName: 'A', count: 3 },
				{ chapterId: 2, chapterName: 'B', count: 2 },
			]),
		];
		const frame = buildDetailFrame(days);
		for (let i = 0; i < frame.dates.length; i++) {
			const sum = frame.bands.reduce((acc, b) => acc + b.values[i]!, 0);
			expect(sum).toBe(days[i]!.total);
		}
		expect(frame.dailyTotals).toEqual([6, 5]);
	});

	it('Solidarity: dailyTotals reflects the distinct user count even when sum-of-bands exceeds it', () => {
		// Mirrors the snapshot's distinct-total sentinel: server `total` is 3
		// distinct users, but the same user can be counted in multiple chapter
		// buckets so sum-of-bands = 5.
		const days: DaySignups[] = [
			day('2026-05-01', 3, [
				{ chapterId: 1, chapterName: 'A', count: 3 },
				{ chapterId: 2, chapterName: 'B', count: 2 },
			]),
		];
		const frame = buildDetailFrame(days);
		const sum = frame.bands.reduce((acc, b) => acc + b.values[0]!, 0);
		expect(sum).toBe(5);
		expect(frame.dailyTotals).toEqual([3]);
	});

	it('Slack: sum of bands per day ≥ server total per day', () => {
		// Distinct user joined two chapters; server total = 1 distinct user, sum = 2.
		const days: DaySignups[] = [
			day('2026-05-01', 1, [
				{ chapterId: 1, chapterName: 'A', count: 1 },
				{ chapterId: 2, chapterName: 'B', count: 1 },
			]),
		];
		const frame = buildDetailFrame(days);
		const sum = frame.bands.reduce((acc, b) => acc + b.values[0]!, 0);
		expect(sum).toBeGreaterThanOrEqual(days[0]!.total);
		expect(sum).toBe(2);
		expect(days[0]!.total).toBe(1);
		expect(frame.dailyTotals).toEqual([1]);
	});

	it('mergedChapters present iff chapter count > DASHBOARD_TOP_N', () => {
		const within: DaySignups[] = [
			day(
				'2026-05-01',
				DASHBOARD_TOP_N,
				Array.from({ length: DASHBOARD_TOP_N }, (_, i) => ({
					chapterId: i + 1,
					chapterName: `C${i + 1}`,
					count: 1,
				})),
			),
		];
		const frameWithin = buildDetailFrame(within);
		expect(frameWithin.bands.find((b) => b.key === 'other')).toBeUndefined();

		const over: DaySignups[] = [
			day(
				'2026-05-01',
				DASHBOARD_TOP_N + 2,
				Array.from({ length: DASHBOARD_TOP_N + 2 }, (_, i) => ({
					chapterId: i + 1,
					chapterName: `C${i + 1}`,
					count: 1,
				})),
			),
		];
		const frameOver = buildDetailFrame(over);
		const other = frameOver.bands.find((b) => b.key === 'other');
		expect(other).toBeDefined();
		expect(other!.label).toBe(OTHER_BAND_LABEL);
		expect(other!.mergedChapters).toBeDefined();
		expect(other!.mergedChapters!).toHaveLength(2);
	});

	it('zero-fills across a date gap', () => {
		const days: DaySignups[] = [
			day('2026-05-01', 2, [{ chapterId: 1, chapterName: 'A', count: 2 }]),
			day('2026-05-03', 1, [{ chapterId: 1, chapterName: 'A', count: 1 }]),
		];
		const frame = buildDetailFrame(days);
		expect(frame.dates).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
		const a = frame.bands.find((b) => b.label === 'A');
		expect(a!.values).toEqual([2, 0, 1]);
	});

	it('buildCountySummary keeps a running tally by county instead of by day', () => {
		const days: DaySignups[] = [
			day('2026-05-01', 3, [
				{ chapterId: 1, chapterName: 'Washtenaw County', count: 2 },
				{ chapterId: 2, chapterName: 'Oakland County', count: 1 },
			]),
			day('2026-05-02', 4, [
				{ chapterId: 1, chapterName: 'Washtenaw County', count: 3 },
				{ chapterId: 2, chapterName: 'Oakland County', count: 1 },
			]),
		];
		const counties = buildCountySummary(days);
		expect(counties).toEqual([
			{ county: 'Washtenaw', value: 5 },
			{ county: 'Oakland', value: 2 },
		]);
	});

	it('buildCountySummary prefers the real zip-derived county over the chapter-name heuristic', () => {
		const days: DaySignups[] = [
			day('2026-05-01', 3, [
				// Chapter name says "Oakland" but its members actually sit in Wayne.
				{ chapterId: 1, chapterName: 'Oakland County', count: 2 },
				// Chapter with no zip data falls back to the name heuristic.
				{ chapterId: 2, chapterName: 'Kent County', count: 1 },
			]),
		];
		const countyByChapterName = new Map([['oakland county', 'Wayne']]);
		const counties = buildCountySummary(days, countyByChapterName);
		expect(counties).toEqual([
			{ county: 'Wayne', value: 2 },
			{ county: 'Kent', value: 1 },
		]);
	});

	it('null-chapter rows land in the no-chapter band', () => {
		const days: DaySignups[] = [
			day('2026-05-01', 3, [
				{ chapterId: 1, chapterName: 'A', count: 2 },
				{ chapterId: null, chapterName: null, count: 1 },
			]),
		];
		const frame = buildDetailFrame(days);
		const noChapter = frame.bands.find((b) => b.key === 'no-chapter');
		expect(noChapter).toBeDefined();
		expect(noChapter!.label).toBe(NO_CHAPTER_BAND_LABEL);
		expect(noChapter!.values).toEqual([1]);
	});

	it('thinDateTicks keeps every label for short domains and caps long ones near MAX_X_TICKS', () => {
		const domain = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

		// 7-day preset: step 1 — nothing dropped.
		expect(thinDateTicks(domain(7))).toEqual(domain(7));

		// 30- and 90-day presets: capped, evenly stepped.
		for (const n of [30, 90]) {
			const ticks = thinDateTicks(domain(n));
			expect(ticks.length).toBeLessThanOrEqual(MAX_X_TICKS);
			const step = Math.ceil(n / MAX_X_TICKS);
			const indices = ticks.map((t) => Number(t.slice(1)));
			for (let i = 1; i < indices.length; i++) {
				expect(indices[i]! - indices[i - 1]!).toBe(step);
			}
		}

		expect(thinDateTicks([])).toEqual([]);
	});

	it('thinDateTicks anchors at the last date so the most recent day keeps its label', () => {
		const domain = Array.from({ length: 90 }, (_, i) => `d${i}`);
		const ticks = thinDateTicks(domain);
		expect(ticks[ticks.length - 1]).toBe('d89');
	});

	it('formatDateTick shortens ISO dates to MM/DD', () => {
		expect(formatDateTick('2026-07-06')).toBe('07/06');
		expect(formatDateTick('2026-12-31')).toBe('12/31');
	});

	it('mergedChapters are sorted descending by totalInWindow', () => {
		const chapters = Array.from({ length: DASHBOARD_TOP_N + 3 }, (_, i) => ({
			chapterId: i + 1,
			chapterName: `C${i + 1}`,
			// Make the top N have high counts (101..110), and the merged ones
			// have lower counts in non-sorted order so we can verify ordering.
			count:
				i < DASHBOARD_TOP_N
					? 100 + i
					: i === DASHBOARD_TOP_N
						? 3
						: i === DASHBOARD_TOP_N + 1
							? 7
							: 1,
		}));
		const days: DaySignups[] = [day('2026-05-01', 0, chapters)];
		const frame = buildDetailFrame(days);
		const other = frame.bands.find((b) => b.key === 'other')!;
		const totals = other.mergedChapters!.map((c) => c.totalInWindow);
		expect(totals).toEqual([...totals].sort((a, b) => b - a));
		expect(totals).toEqual([7, 3, 1]);
	});
});
