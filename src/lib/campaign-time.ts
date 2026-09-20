// Rendering timestamps in the campaign's own clock.
//
// Everything is stored as ISO-8601 UTC, which is right for storage and wrong
// for reading: a canvass that ran Saturday evening should say Saturday, not
// Sunday, and a knock at 9pm belongs to the day the volunteer was out.
//
// The campaign's timezone is `CAMPAIGN_TIME_ZONE` — an IANA name, e.g.
// `America/Chicago`. Unset, it is the default below, which is where every
// deployment of this app started. It is one clock for the whole campaign, not a
// per-chapter one: the canvassing board, the doors projection and the activity
// history all bucket by it, and two chapters an hour apart comparing a day's
// numbers need those buckets to mean the same thing.
//
// Read from `process.env` rather than `$env/dynamic/private`, deliberately: the
// pure modules under $lib/van import this, scripts/ runs those under tsx, and
// the `$env` modules only exist inside the Vite bundle (see the note on
// ChapterFolders in server/van/sync.ts, which was written after that bit).
//
// Formatting happens on the SERVER and ships as strings in the payload. Doing
// it in the browser would render each row in whatever zone the reader's laptop
// is set to — so two organizers comparing notes would see different times for
// the same event — and would risk an SSR/client hydration mismatch on every
// row. One clock, decided once.

/** Where this app started, and the value every existing deployment had baked
 *  in before the variable existed. */
export const DEFAULT_CAMPAIGN_TIME_ZONE = 'America/Detroit';

/** True when the runtime knows this zone. A typo here would otherwise throw on
 *  the first `Intl.DateTimeFormat` call, i.e. while rendering a page, rather
 *  than at the point somebody could still fix it. */
function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

function resolveTimeZone(): string {
	// `process` is absent in a browser bundle; nothing here is meant to run
	// there, and the default keeps an accidental import rendering rather than
	// crashing.
	const raw =
		typeof process === 'undefined' ? '' : (process.env?.['CAMPAIGN_TIME_ZONE'] ?? '').trim();
	if (!raw) return DEFAULT_CAMPAIGN_TIME_ZONE;
	if (!isValidTimeZone(raw)) {
		// Warn rather than throw: a mistyped zone should not take the app down,
		// and a silent fallback would have every timestamp quietly wrong.
		console.warn(
			`[campaign-time] CAMPAIGN_TIME_ZONE is not a known IANA time zone: "${raw}" — using ${DEFAULT_CAMPAIGN_TIME_ZONE}`,
		);
		return DEFAULT_CAMPAIGN_TIME_ZONE;
	}
	return raw;
}

export const CAMPAIGN_TIME_ZONE = resolveTimeZone();

/** `en-CA` gives ISO-ordered `YYYY-MM-DD`, which sorts and compares as a
 *  string. */
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
	timeZone: CAMPAIGN_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
	timeZone: CAMPAIGN_TIME_ZONE,
	weekday: 'long',
	month: 'short',
	day: 'numeric',
});

const TIME_LABEL = new Intl.DateTimeFormat('en-US', {
	timeZone: CAMPAIGN_TIME_ZONE,
	hour: 'numeric',
	minute: '2-digit',
});

function parse(iso: string): Date | null {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Campaign-local calendar day, as `YYYY-MM-DD`.
 *
 * The grouping key for a day-by-day history. Derived here rather than from the
 * ISO string's own date, which would bucket anything after 8pm ET into
 * tomorrow — precisely the hours a canvass runs.
 */
export function campaignDayKey(iso: string): string {
	const date = parse(iso);
	return date ? DAY_KEY.format(date) : '';
}

/** Day heading, e.g. "Saturday, Aug 22". */
export function campaignDayLabel(iso: string): string {
	const date = parse(iso);
	return date ? DAY_LABEL.format(date) : 'Unknown date';
}

/** Time of day, e.g. "9:41 AM". */
export function campaignTimeLabel(iso: string): string {
	const date = parse(iso);
	return date ? TIME_LABEL.format(date) : '';
}

/** `en-CA` again for ISO order, with a 24-hour clock so the string sorts. */
const SHEET_STAMP = new Intl.DateTimeFormat('en-CA', {
	timeZone: CAMPAIGN_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/**
 * Campaign-local timestamp for a spreadsheet cell: `2026-09-19 14:07`.
 *
 * Its own formatter rather than `campaignDayKey` + `campaignTimeLabel` because
 * those compose to "2026-09-19 2:07 PM", which sorts wrongly in a column people
 * sort — 10 AM lands above 2 PM. The spec says readers sort by this column, so
 * the 24-hour form is the requirement rather than a preference.
 *
 * Returns '' for an unparseable timestamp, matching campaignDayKey: a blank
 * cell reads as "unknown" to anyone scanning the sheet, where a fabricated date
 * would not.
 */
export function campaignSheetStamp(iso: string): string {
	const date = parse(iso);
	if (!date) return '';
	// Intl renders this as "2026-09-19, 14:07"; the comma helps nobody in a
	// spreadsheet cell and stops Sheets reading it as a datetime.
	return SHEET_STAMP.format(date).replace(', ', ' ');
}

const HOUR = new Intl.DateTimeFormat('en-GB', {
	timeZone: CAMPAIGN_TIME_ZONE,
	hour: '2-digit',
	hourCycle: 'h23',
});

/**
 * Hour of the campaign day, 0-23.
 *
 * What the nightly refresh sweep schedules against (van/refresh-policy.ts). It
 * has to be the campaign's clock rather than UTC: "overnight" means the hours
 * nobody is knocking doors in Michigan, and those move by one relative to UTC
 * twice a year. A sweep pinned to a UTC hour would drift into the evening every
 * autumn, re-cutting regions while volunteers were still out in them.
 *
 * Returns null for an unparseable date, so a caller decides what to do with it
 * rather than being handed a plausible-looking zero.
 */
export function campaignHour(at: Date | string): number | null {
	const date = typeof at === 'string' ? parse(at) : at;
	if (!date || Number.isNaN(date.getTime())) return null;
	const hour = Number.parseInt(HOUR.format(date), 10);
	return Number.isNaN(hour) ? null : hour;
}

/**
 * Monday 00:00 of the campaign-local week `now` falls in, as a UTC Date.
 *
 * Pinned to the campaign's clock, NOT UTC, and the difference is not academic:
 * the Slack growth board's window uses UTC day boundaries, so every Sunday
 * between 8 pm ET (Monday 00:00 UTC) and midnight ET it already reports the
 * NEXT Monday. A doors board on UTC would jump a week ahead into an empty
 * window while the Slack board still showed the real one. Returns UTC midnight
 * of the Detroit Monday's calendar date, so `toISOString().slice(0, 10)` yields
 * the intended day string.
 *
 * Lifted verbatim (comment included) from the Openfield-era doors leaderboard
 * when that was retired — the reasoning is about the campaign's clock, not
 * about where the numbers came from.
 */
export function campaignWeekStart(now: Date): Date {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: CAMPAIGN_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'short',
	}).formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const daysBackToMonday: Record<string, number> = {
		Mon: 0,
		Tue: 1,
		Wed: 2,
		Thu: 3,
		Fri: 4,
		Sat: 5,
		Sun: 6,
	};
	const back = daysBackToMonday[get('weekday')] ?? 0;
	const midnight = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
	return new Date(midnight - back * 86_400_000);
}
