import { describe, it, expect } from 'vitest';
import {
	listExpiresAt,
	listExpiryAlerts,
	renderListExpiryAlert,
	LIST_EXPIRY_ALERT_MAX_ROWS,
	type ListExpiryTurf,
} from './list-expiry.js';

const NOW = new Date('2026-09-19T16:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const APP = 'https://app.example';

/** A creation date that makes the list expire `days` from NOW. */
function createdExpiringIn(days: number): string {
	return new Date(NOW.getTime() + days * DAY - 30 * DAY).toISOString();
}

function turf(over: Partial<ListExpiryTurf> = {}): ListExpiryTurf {
	return {
		mapRouteId: 1,
		name: 'Brighton Turf 01',
		regionName: 'R04C_Livingston_BrightonCity003',
		chapterName: 'Livingston County',
		printedListNumber: '35536745-88712',
		printedListCreatedAt: createdExpiringIn(4),
		listExpiryWarnedFor: null,
		retiredAt: null,
		...over,
	};
}

describe('listExpiresAt', () => {
	it('is thirty days after the list was generated', () => {
		expect(listExpiresAt('2026-09-01T12:00:00.000Z')?.toISOString()).toBe(
			'2026-10-01T12:00:00.000Z',
		);
	});

	it('is null for a date that will not parse, never "now"', () => {
		expect(listExpiresAt('not a date')).toBeNull();
	});
});

describe('listExpiryAlerts', () => {
	it('warns five days out and not before', () => {
		const alerts = listExpiryAlerts(
			[
				turf({ mapRouteId: 1, printedListCreatedAt: createdExpiringIn(5) }),
				turf({ mapRouteId: 2, printedListCreatedAt: createdExpiringIn(5.01) }),
			],
			new Set(),
			NOW,
		);
		expect(alerts.map((a) => a.mapRouteId)).toEqual([1]);
	});

	it('still warns about a list already past expiry that nobody was told about', () => {
		const [alert] = listExpiryAlerts(
			[turf({ printedListCreatedAt: createdExpiringIn(-2) })],
			new Set(),
			NOW,
		);
		expect(alert!.daysLeft).toBeLessThan(0);
	});

	it('warns once per list, and again for a regenerated one', () => {
		const created = createdExpiringIn(3);
		expect(
			listExpiryAlerts(
				[turf({ printedListCreatedAt: created, listExpiryWarnedFor: created })],
				new Set(),
				NOW,
			),
		).toEqual([]);
		// A new list has a new creation date — the old stamp does not cover it.
		const regenerated = turf({
			printedListCreatedAt: createdExpiringIn(2),
			listExpiryWarnedFor: created,
		});
		expect(listExpiryAlerts([regenerated], new Set(), NOW)).toHaveLength(1);
	});

	// Stamps written before the catalog converted VAN's local-time strings to
	// UTC. Same list, same instant, different string — it must not warn twice.
	it('treats a stamp in VAN’s old local-time form as the same list', () => {
		// 2026-08-24 10:00 Detroit: VAN wrote "10:00:00Z", we now store 14:00 UTC.
		const alert = listExpiryAlerts(
			[
				turf({
					printedListCreatedAt: '2026-08-24T14:00:00.000Z',
					listExpiryWarnedFor: '2026-08-24T10:00:00Z',
				}),
			],
			new Set(),
			NOW,
		);
		expect(alert).toEqual([]);
	});

	it('skips retired turf, turf with no list, and a date it cannot read', () => {
		expect(
			listExpiryAlerts(
				[
					turf({ retiredAt: '2026-09-18T00:00:00.000Z' }),
					turf({ printedListNumber: null }),
					turf({ printedListCreatedAt: null }),
					turf({ printedListCreatedAt: 'garbage' }),
				],
				new Set(),
				NOW,
			),
		).toEqual([]);
	});

	it('marks turf someone holds, and lists the soonest first', () => {
		const alerts = listExpiryAlerts(
			[
				turf({ mapRouteId: 1, printedListCreatedAt: createdExpiringIn(4) }),
				turf({ mapRouteId: 2, printedListCreatedAt: createdExpiringIn(1) }),
			],
			new Set([1]),
			NOW,
		);
		expect(alerts.map((a) => [a.mapRouteId, a.held])).toEqual([
			[2, false],
			[1, true],
		]);
	});
});

describe('renderListExpiryAlert', () => {
	it('is null with nothing to say', () => {
		expect(renderListExpiryAlert([], NOW, APP)).toBeNull();
	});

	it('names the turf and when, and never the list number', () => {
		const alerts = listExpiryAlerts([turf()], new Set([1]), NOW);
		const text = renderListExpiryAlert(alerts, NOW, APP)!;
		expect(text).toContain('*Brighton Turf 01*');
		expect(text).toContain('R04C_Livingston_BrightonCity003');
		expect(text).toContain('(4 days)');
		expect(text).toContain('someone holds it');
		expect(text).toContain('Turf Manager');
		// Loading the number in MiniVAN is what hands a list out; there is no
		// separate export step for an organizer to do.
		expect(text).not.toContain('bulk-export');
		expect(text).toContain(`${APP}/turfs/organizer`);
		// The number is the credential that loads the doors in MiniVAN.
		expect(text).not.toContain('35536745-88712');
	});

	it('says expired, and today, in words', () => {
		const expired = listExpiryAlerts(
			[turf({ printedListCreatedAt: createdExpiringIn(-1) })],
			new Set(),
			NOW,
		);
		expect(renderListExpiryAlert(expired, NOW, APP)).toContain('*expired*');
		const today = listExpiryAlerts(
			[turf({ printedListCreatedAt: createdExpiringIn(0.5) })],
			new Set(),
			NOW,
		);
		expect(renderListExpiryAlert(today, NOW, APP)).toContain('*today*');
	});

	it('caps the rows and counts the rest', () => {
		const many = Array.from({ length: LIST_EXPIRY_ALERT_MAX_ROWS + 3 }, (_, i) =>
			turf({ mapRouteId: i + 1, name: `Turf ${i + 1}` }),
		);
		const text = renderListExpiryAlert(listExpiryAlerts(many, new Set(), NOW), NOW, APP)!;
		expect(text).toContain('18 turfs');
		expect(text).toContain('+3 more');
	});
});
