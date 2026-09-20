import { describe, it, expect } from 'vitest';
import {
	SHEET_COLUMNS,
	endEventLabel,
	pendingEvents,
	pendingEventsFor,
	type SheetCheckout,
} from './sheet-log.js';

const BASE: SheetCheckout = {
	checkoutId: 41,
	claimedAt: '2026-09-19T14:07:00.000Z',
	releasedAt: null,
	completedAt: null,
	releaseReason: null,
	slackUserName: 'Dana',
	issuedListNumber: '35536745-88712',
	turfName: 'Turf 01',
	regionName: 'R10C_Wayne_TaylorCity004_9.11',
	sheetClaimSentAt: null,
	sheetEndSentAt: null,
};

function checkout(overrides: Partial<SheetCheckout> = {}): SheetCheckout {
	return { ...BASE, ...overrides };
}

/** Column index by header, so assertions name the column rather than a number. */
const col = (name: (typeof SHEET_COLUMNS)[number]): number => SHEET_COLUMNS.indexOf(name);

describe('endEventLabel', () => {
	it.each([
		['volunteer', 'Released'],
		['expired', 'Expired'],
		['blocked', 'Released (blocked)'],
		['retired', 'Released (turf re-cut)'],
		['walked-out', 'Released (no doors left)'],
		['admin', 'Released (admin)'],
	])('labels %s as %s', (reason, label) => {
		expect(endEventLabel(reason)).toBe(label);
	});

	// A missing row is the one outcome an audit log cannot afford, so an
	// unrecognised reason still produces one. This is what keeps a reason added
	// by a later migration from vanishing silently.
	it('still produces a row for a reason nothing writes yet', () => {
		expect(endEventLabel('some-future-reason')).toBe('Released');
		expect(endEventLabel(null)).toBe('Released');
	});
});

describe('pendingEvents', () => {
	it('builds a Checked out row with the claim-time list number', () => {
		const [event, ...rest] = pendingEvents(checkout());
		expect(rest).toHaveLength(0);
		expect(event?.kind).toBe('claim');
		expect(event?.cells[col('Event')]).toBe('Checked out');
		expect(event?.cells[col('Turf')]).toBe('Turf 01');
		expect(event?.cells[col('Region')]).toBe('R10C_Wayne_TaylorCity004_9.11');
		expect(event?.cells[col('List #')]).toBe('35536745-88712');
		expect(event?.cells[col('Volunteer')]).toBe('Dana');
		expect(event?.cells[col('Checkout ID')]).toBe('41');
	});

	it('writes the When column in campaign-local time, not UTC', () => {
		// 14:07 UTC is 10:07 in America/Detroit, and the sheet is read by people
		// in Michigan sorting by this column.
		const [event] = pendingEvents(checkout());
		expect(event?.cells[col('When')]).toBe('2026-09-19 10:07');
	});

	it('leaves the list number blank rather than printing null', () => {
		const [event] = pendingEvents(checkout({ issuedListNumber: null }));
		expect(event?.cells[col('List #')]).toBe('');
	});

	it('owes nothing once both halves are stamped', () => {
		expect(
			pendingEvents(
				checkout({
					completedAt: '2026-09-19T20:00:00.000Z',
					sheetClaimSentAt: '2026-09-19T14:10:00.000Z',
					sheetEndSentAt: '2026-09-19T20:10:00.000Z',
				}),
			),
		).toEqual([]);
	});

	it('owes only the ending once the claim row has been sent', () => {
		const events = pendingEvents(
			checkout({
				completedAt: '2026-09-19T20:00:00.000Z',
				sheetClaimSentAt: '2026-09-19T14:10:00.000Z',
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('end');
		expect(events[0]?.cells[col('Event')]).toBe('Completed');
	});

	// The spec's edge case. A "Released" row above its own "Checked out" row is
	// the kind of thing that makes a reader distrust the whole log, so the order
	// is a property of this function rather than of the query that fed it.
	it('orders the claim before the ending when a checkout starts and ends in one run', () => {
		const events = pendingEvents(
			checkout({ releasedAt: '2026-09-19T16:00:00.000Z', releaseReason: 'volunteer' }),
		);
		expect(events.map((e) => e.kind)).toEqual(['claim', 'end']);
		expect(events.map((e) => e.cells[col('Event')])).toEqual(['Checked out', 'Released']);
		// Both rows carry the same Checkout ID — that pairing is what makes the
		// log readable, and what identifies a duplicate after a crash.
		expect(new Set(events.map((e) => e.cells[col('Checkout ID')]))).toEqual(new Set(['41']));
	});

	it('uses the completion time for a completed turf, not the claim time', () => {
		const events = pendingEvents(
			checkout({ completedAt: '2026-09-19T20:00:00.000Z', sheetClaimSentAt: 'sent' }),
		);
		expect(events[0]?.cells[col('When')]).toBe('2026-09-19 16:00');
	});

	// completedAt and releasedAt are separate columns and a row should only ever
	// have one. If a hand edit leaves both, completion is the truthful label —
	// the doors were actually knocked.
	it('prefers Completed when both terminal stamps are somehow set', () => {
		const events = pendingEvents(
			checkout({
				completedAt: '2026-09-19T20:00:00.000Z',
				releasedAt: '2026-09-19T21:00:00.000Z',
				releaseReason: 'expired',
				sheetClaimSentAt: 'sent',
			}),
		);
		expect(events[0]?.cells[col('Event')]).toBe('Completed');
	});
});

describe('pendingEventsFor', () => {
	it('flattens a batch, keeping each checkout claim-before-end', () => {
		const events = pendingEventsFor([
			checkout({ checkoutId: 1, releasedAt: '2026-09-19T16:00:00.000Z', releaseReason: 'expired' }),
			checkout({ checkoutId: 2 }),
		]);
		expect(events.map((e) => [e.checkoutId, e.kind])).toEqual([
			[1, 'claim'],
			[1, 'end'],
			[2, 'claim'],
		]);
	});

	it('carries the region name so the router does not re-read the checkout', () => {
		const events = pendingEventsFor([checkout()]);
		expect(events[0]?.regionName).toBe('R10C_Wayne_TaylorCity004_9.11');
	});
});
