// Rendering timestamps in the campaign's own clock.
//
// Everything is stored as ISO-8601 UTC, which is right for storage and wrong
// for reading: a canvass that ran Saturday evening should say Saturday, not
// Sunday, and a knock at 9pm belongs to the day the volunteer was out.
//
// `America/Detroit` is the campaign's timezone, already the assumption in the
// canvassing board and the doors projection, which pin their day buckets to it.
// Those keep it private because they only bucket; this module exists because
// the activity history needs to *display* it.
//
// Formatting happens on the SERVER and ships as strings in the payload. Doing
// it in the browser would render each row in whatever zone the reader's laptop
// is set to — so two organizers comparing notes would see different times for
// the same event — and would risk an SSR/client hydration mismatch on every
// row. One clock, decided once.

export const CAMPAIGN_TIME_ZONE = 'America/Detroit';

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
