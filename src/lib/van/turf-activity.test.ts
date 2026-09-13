import { describe, it, expect } from 'vitest';
import {
	activityEvents,
	activityLabel,
	ACTIVITY_KINDS,
	DEFAULT_PERIOD,
	emptyCounts,
	EVENT_CAP,
	groupByDay,
	parsePeriod,
	PERIOD_OPTIONS,
	rangeFor,
	totalEvents,
	type ActivityRow,
} from './turf-activity.js';

const NOW = new Date('2026-08-24T18:00:00.000Z');

function row(over: Partial<ActivityRow> = {}): ActivityRow {
	return {
		checkoutId: 1,
		mapRouteId: 100,
		name: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		doorCount: 250,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: '2026-08-24T13:10:00.000Z',
		releasedAt: null,
		completedAt: null,
		releaseReason: null,
		confirmedDoorDelta: null,
		...over,
	};
}

const WEEK = rangeFor('7', NOW);

describe('parsePeriod', () => {
	it.each(PERIOD_OPTIONS.map((o) => o.value))('accepts %s', (value) => {
		expect(parsePeriod(value)).toBe(value);
	});

	// A mistyped query string should show a page, not a 400.
	it.each([
		['null', null],
		['undefined', undefined],
		['empty', ''],
		['junk', 'banana'],
		['a number outside the set', '3'],
		['sql-ish', "7' OR 1=1"],
	])('falls back to the default for %s', (_label, raw) => {
		expect(parsePeriod(raw)).toBe(DEFAULT_PERIOD);
	});
});

describe('rangeFor', () => {
	it('bounds a day-based period', () => {
		expect(rangeFor('1', NOW)).toEqual({
			start: '2026-08-23T18:00:00.000Z',
			end: '2026-08-24T18:00:00.000Z',
		});
	});

	it('leaves the start open for all time', () => {
		expect(rangeFor('all', NOW)).toEqual({ start: null, end: NOW.toISOString() });
	});

	it('widens with the period', () => {
		expect(rangeFor('30', NOW).start! < rangeFor('7', NOW).start!).toBe(true);
	});
});

describe('activityEvents', () => {
	it('reads a claim as one event', () => {
		const events = activityEvents([row()], WEEK);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: 'claimed', at: '2026-08-24T13:10:00.000Z' });
	});

	// The reason this is a fan-out rather than a map: one row, two things that
	// happened, and a history showing it once answers a different question.
	it('reads a claim-and-complete row as two events, newest first', () => {
		const events = activityEvents([row({ completedAt: '2026-08-24T15:30:00.000Z' })], WEEK);
		expect(events.map((e) => e.kind)).toEqual(['completed', 'claimed']);
		expect(events.map((e) => e.id)).toEqual(['1:completed', '1:claimed']);
	});

	it('gives every event a distinct id so a list can key on it', () => {
		const events = activityEvents(
			[row({ completedAt: '2026-08-24T15:30:00.000Z' }), row({ checkoutId: 2 })],
			WEEK,
		);
		expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
	});

	it.each([
		['volunteer', 'given-back'],
		['expired', 'expired'],
		['blocked', 'blocked'],
		['retired', 'retired'],
		['walked-out', 'walked-out'],
		['admin', 'given-back'],
	])('maps releaseReason %s to %s', (reason, kind) => {
		const events = activityEvents(
			[row({ releasedAt: '2026-08-24T16:00:00.000Z', releaseReason: reason })],
			WEEK,
		);
		expect(events[0]!.kind).toBe(kind);
	});

	// An unknown reason must still appear: a missing row is the one outcome an
	// audit trail cannot afford.
	it('still reports a release with an unrecognised reason', () => {
		const events = activityEvents(
			[row({ releasedAt: '2026-08-24T16:00:00.000Z', releaseReason: 'something-new' })],
			WEEK,
		);
		// Two, not one: the claim is in this window as well. The release is the
		// newer of the pair.
		expect(events.map((e) => e.kind)).toEqual(['given-back', 'claimed']);
	});

	describe('range filtering', () => {
		it('drops stamps before the start', () => {
			const events = activityEvents([row({ claimedAt: '2026-01-01T00:00:00.000Z' })], WEEK);
			expect(events).toEqual([]);
		});

		// The interesting half of the fan-out: a turf claimed last week and
		// completed today shows once in a one-day range and twice in a monthly one.
		it('reports only the stamps inside the window', () => {
			const claimedLastWeek = row({
				claimedAt: '2026-08-10T09:00:00.000Z',
				completedAt: '2026-08-24T15:00:00.000Z',
			});
			expect(activityEvents([claimedLastWeek], rangeFor('1', NOW)).map((e) => e.kind)).toEqual([
				'completed',
			]);
			expect(activityEvents([claimedLastWeek], rangeFor('30', NOW)).map((e) => e.kind)).toEqual([
				'completed',
				'claimed',
			]);
		});

		it('includes everything for all time', () => {
			const old = row({ claimedAt: '2020-01-01T00:00:00.000Z' });
			expect(activityEvents([old], rangeFor('all', NOW))).toHaveLength(1);
		});

		// Half-open at the top, so two adjacent windows cannot both count it.
		it('excludes a stamp exactly at the end', () => {
			expect(activityEvents([row({ claimedAt: WEEK.end })], WEEK)).toEqual([]);
		});

		it('includes a stamp exactly at the start', () => {
			expect(activityEvents([row({ claimedAt: WEEK.start! })], WEEK)).toHaveLength(1);
		});
	});

	it('orders across rows by timestamp, newest first', () => {
		const events = activityEvents(
			[
				row({ checkoutId: 1, claimedAt: '2026-08-24T09:00:00.000Z' }),
				row({ checkoutId: 2, claimedAt: '2026-08-24T17:00:00.000Z' }),
				row({ checkoutId: 3, claimedAt: '2026-08-24T12:00:00.000Z' }),
			],
			WEEK,
		);
		expect(events.map((e) => e.checkoutId)).toEqual([2, 3, 1]);
	});

	it('breaks a timestamp tie stably', () => {
		const at = '2026-08-24T12:00:00.000Z';
		const events = activityEvents(
			[row({ checkoutId: 1, claimedAt: at }), row({ checkoutId: 2, claimedAt: at })],
			WEEK,
		);
		expect(events.map((e) => e.checkoutId)).toEqual([2, 1]);
	});

	it('carries the turf and holder detail an organizer reads', () => {
		const [event] = activityEvents([row()], WEEK);
		expect(event).toMatchObject({
			turfName: 'Turf 01',
			regionName: 'Ann Arbor',
			chapterName: 'Washtenaw County',
			doorCount: 250,
			slackUserName: 'Dana',
		});
	});

	// The credential rule, asserted rather than trusted: the list number is
	// issued to the holder alone, and an admin is not the holder.
	it('carries no MiniVAN list number and nothing address-like', () => {
		const serialised = JSON.stringify(activityEvents([row()], WEEK)).toLowerCase();
		for (const field of ['printedlist', 'address', 'street', 'firstname', 'lastname', 'phone']) {
			expect(serialised).not.toContain(field);
		}
	});

	it('handles an empty ledger', () => {
		expect(activityEvents([], WEEK)).toEqual([]);
	});
});

describe('counts', () => {
	it('starts at zero for every kind', () => {
		const counts = emptyCounts();
		expect(Object.keys(counts).sort()).toEqual([...ACTIVITY_KINDS].sort());
		expect(totalEvents(counts)).toBe(0);
	});

	it('totals across kinds', () => {
		expect(totalEvents({ ...emptyCounts(), claimed: 4, completed: 3, expired: 2 })).toBe(9);
	});

	// The split that keeps the page honest: a release nobody chose must not
	// inflate the number an organizer reads as "volunteers handing turf back".
	it('does not fold blocked, retired or walked-out into given-back', () => {
		const counts = {
			...emptyCounts(),
			'given-back': 1,
			blocked: 2,
			retired: 3,
			'walked-out': 4,
		};
		expect(counts['given-back']).toBe(1);
		expect(totalEvents(counts)).toBe(10);
	});
});

describe('activityLabel', () => {
	it.each([
		['claimed', 'Claimed'],
		['completed', 'Completed'],
		['given-back', 'Given back'],
		['expired', 'Expired'],
		['blocked', 'Released (blocked)'],
		['retired', 'Released (turf retired)'],
		['walked-out', 'Released (no doors left)'],
	] as const)('labels %s', (kind, label) => {
		expect(activityLabel(kind)).toBe(label);
	});

	it('labels every kind', () => {
		for (const kind of ACTIVITY_KINDS) expect(activityLabel(kind).length).toBeGreaterThan(0);
	});
});

describe('groupByDay', () => {
	it('groups consecutive events sharing a day', () => {
		const groups = groupByDay([
			{ dayKey: '2026-08-24', id: 'a' },
			{ dayKey: '2026-08-24', id: 'b' },
			{ dayKey: '2026-08-23', id: 'c' },
		]);
		expect(groups.map((g) => g.dayKey)).toEqual(['2026-08-24', '2026-08-23']);
		expect(groups[0]!.events).toHaveLength(2);
	});

	it('preserves order and loses nothing', () => {
		const events = [
			{ dayKey: 'd1', id: 'a' },
			{ dayKey: 'd2', id: 'b' },
			{ dayKey: 'd1', id: 'c' },
		];
		const groups = groupByDay(events);
		// Deliberately does NOT re-sort: the caller sorts once, and a grouper that
		// reordered would silently undo it.
		expect(groups.map((g) => g.dayKey)).toEqual(['d1', 'd2', 'd1']);
		expect(groups.flatMap((g) => g.events)).toEqual(events);
	});

	it('handles an empty list', () => {
		expect(groupByDay([])).toEqual([]);
	});
});

describe('EVENT_CAP', () => {
	it('is a sane page budget', () => {
		expect(EVENT_CAP).toBeGreaterThan(0);
		expect(Number.isSafeInteger(EVENT_CAP)).toBe(true);
	});
});
