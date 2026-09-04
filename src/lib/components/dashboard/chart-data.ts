import type { DaySignups } from '$lib/server/dashboard-signups.js';

export const DASHBOARD_TOP_N = 10;
export const OTHER_BAND_LABEL = 'Other';
export const NO_CHAPTER_BAND_LABEL = 'No chapter';

export interface ChartBand {
	key: string;
	label: string;
	values: number[];
	mergedChapters?: Array<{
		chapterId: number;
		chapterName: string;
		values: number[];
		totalInWindow: number;
	}>;
}

export interface CountySummary {
	county: string;
	value: number;
}

export interface ChartFrame {
	dates: string[];
	bands: ChartBand[];
	dailyTotals?: number[];
	countySummary?: CountySummary[];
}

/** Max x-axis tick labels on the signup charts. A band scale renders one
 *  label per bar by default, so the 30/90-day presets overlap without this. */
export const MAX_X_TICKS = 8;

/** Thin a band-scale domain to at most MAX_X_TICKS evenly stepped entries,
 *  anchored at the LAST date so the most recent day always keeps its label
 *  (the left edge loses one instead). Identity for short domains. */
export function thinDateTicks(domain: string[]): string[] {
	const step = Math.max(1, Math.ceil(domain.length / MAX_X_TICKS));
	return domain.filter((_, i) => (domain.length - 1 - i) % step === 0);
}

/** 'YYYY-MM-DD' → 'MM/DD' for compact x-axis tick labels. */
export function formatDateTick(date: string): string {
	return date.slice(5).replace('-', '/');
}

function addDays(date: string, n: number): string {
	const [y, m, d] = date.split('-').map(Number);
	const t = Date.UTC(y!, m! - 1, d! + n);
	return new Date(t).toISOString().slice(0, 10);
}

function contiguousDates(input: DaySignups[]): string[] {
	if (input.length === 0) return [];
	const first = input[0]!.date;
	const last = input[input.length - 1]!.date;
	const dates: string[] = [];
	let cursor = first;
	while (cursor <= last) {
		dates.push(cursor);
		cursor = addDays(cursor, 1);
	}
	return dates;
}

export function normalizeCountyName(name: string | null | undefined): string {
	if (!name) return 'Unassigned';
	const cleaned = name
		.trim()
		.replace(/\s*\bcounty\b\s*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned === '' ? 'Unassigned' : cleaned;
}

/**
 * @param countyByChapterName Chapter name (lowercased) -> real Michigan
 *   county, derived from member zip codes (see chapter-county.ts). Preferred
 *   over the chapter-name heuristic below when available; chapters missing
 *   from this map (no mapped zips yet, e.g. brand-new chapters) fall back to
 *   normalizeCountyName so they still land somewhere sane.
 */
export function buildCountySummary(
	days: DaySignups[],
	countyByChapterName?: ReadonlyMap<string, string>,
): CountySummary[] {
	const totals = new Map<string, number>();
	for (const day of days) {
		for (const chapter of day.byChapter) {
			const mapped = chapter.chapterName
				? countyByChapterName?.get(chapter.chapterName.toLowerCase())
				: undefined;
			const county = mapped ?? normalizeCountyName(chapter.chapterName);
			const next = (totals.get(county) ?? 0) + chapter.count;
			totals.set(county, next);
		}
	}
	return [...totals.entries()]
		.map(([county, value]) => ({ county, value }))
		.sort((a, b) => b.value - a.value || a.county.localeCompare(b.county));
}

export function buildOverviewFrame(days: DaySignups[], sourceLabel: string): ChartFrame {
	if (days.length === 0) {
		return { dates: [], bands: [] };
	}
	const dates = contiguousDates(days);
	const totalsByDate = new Map<string, number>();
	for (const d of days) totalsByDate.set(d.date, d.total);
	const values = dates.map((d) => totalsByDate.get(d) ?? 0);
	return {
		dates,
		bands: [
			{
				key: 'total',
				label: `${sourceLabel} signups`,
				values,
			},
		],
	};
}

export function buildDetailFrame(days: DaySignups[]): ChartFrame {
	if (days.length === 0) {
		return { dates: [], bands: [] };
	}

	const dates = contiguousDates(days);
	const dateIndex = new Map<string, number>();
	dates.forEach((d, i) => dateIndex.set(d, i));

	interface ChapterAccum {
		chapterId: number;
		chapterName: string;
		values: number[];
		totalInWindow: number;
	}

	const chapters = new Map<number, ChapterAccum>();
	const nullValues = new Array(dates.length).fill(0) as number[];
	let nullHasAny = false;

	for (const day of days) {
		const idx = dateIndex.get(day.date);
		if (idx === undefined) continue;
		for (const c of day.byChapter) {
			if (c.chapterId === null || c.chapterName === null) {
				nullValues[idx]! += c.count;
				if (c.count > 0) nullHasAny = true;
				continue;
			}
			let accum = chapters.get(c.chapterId);
			if (!accum) {
				accum = {
					chapterId: c.chapterId,
					chapterName: c.chapterName,
					values: new Array(dates.length).fill(0) as number[],
					totalInWindow: 0,
				};
				chapters.set(c.chapterId, accum);
			}
			accum.values[idx]! += c.count;
			accum.totalInWindow += c.count;
		}
	}

	const ranked = [...chapters.values()].sort((a, b) => b.totalInWindow - a.totalInWindow);
	const named = ranked.slice(0, DASHBOARD_TOP_N);
	const merged = ranked.slice(DASHBOARD_TOP_N);

	const bands: ChartBand[] = [];

	for (const c of named) {
		bands.push({
			key: String(c.chapterId),
			label: c.chapterName,
			values: c.values,
		});
	}

	if (nullHasAny) {
		bands.push({
			key: 'no-chapter',
			label: NO_CHAPTER_BAND_LABEL,
			values: nullValues,
		});
	}

	if (merged.length > 0) {
		const otherValues = new Array(dates.length).fill(0) as number[];
		for (const c of merged) {
			for (let i = 0; i < dates.length; i++) {
				otherValues[i]! += c.values[i]!;
			}
		}
		bands.push({
			key: 'other',
			label: OTHER_BAND_LABEL,
			values: otherValues,
			mergedChapters: merged.map((c) => ({
				chapterId: c.chapterId,
				chapterName: c.chapterName,
				values: c.values,
				totalInWindow: c.totalInWindow,
			})),
		});
	}

	// Always populate dailyTotals — for both Slack and Solidarity the per-band
	// sum can exceed the distinct daily total when a user belongs to multiple
	// chapters (Slack via slack_joins.chapter_ids; Solidarity via the snapshot's
	// distinct-total sentinel row). The overlay marker lets viewers see the
	// real total at a glance.
	const totalsByDate = new Map<string, number>();
	for (const d of days) totalsByDate.set(d.date, d.total);
	const dailyTotals = dates.map((d) => totalsByDate.get(d) ?? 0);

	return { dates, bands, dailyTotals };
}
