import { describe, expect, it } from 'vitest';

import { normalizeAttendance } from './attendees.js';
import type { MobilizeAttendance } from './mobilize.js';

/** Shaped after the sample response in the Mobilize API docs. */
const row: MobilizeAttendance = {
	id: 52583461,
	status: 'REGISTERED',
	attended: null,
	created_date: 1785000000,
	modified_date: 1785000100,
	event: { id: 812345 },
	timeslot: { id: 6157028, start_date: 1785200000, end_date: 1785207200 },
	person: {
		id: 57,
		given_name: 'Kathryn',
		family_name: 'Agar',
		email_addresses: [{ primary: true, address: 'k@example.com' }],
		phone_numbers: [{ primary: true, number: '6169539282' }],
		postal_addresses: [{ primary: true, postal_code: '49504' }],
	},
};

describe('normalizeAttendance', () => {
	it('extracts the signup with its Mobilize ids', () => {
		expect(normalizeAttendance(row)).toEqual({
			id: 52583461,
			timeslotId: 6157028,
			status: 'REGISTERED',
			attended: null,
			firstName: 'Kathryn',
			lastName: 'Agar',
			email: 'k@example.com',
			phone: '6169539282',
			zipcode: '49504',
			modifiedDate: 1785000100,
			createdDate: 1785000000,
		});
	});

	it('defaults a missing created_date to 0 rather than dropping the field', () => {
		// The waitlist ordering sorts on this, so it has to be a number always.
		expect(normalizeAttendance({ ...row, created_date: undefined })?.createdDate).toBe(0);
	});

	it('carries the documented statuses through', () => {
		for (const status of ['REGISTERED', 'CANCELLED', 'CONFIRMED']) {
			expect(normalizeAttendance({ ...row, status })?.status).toBe(status);
		}
	});

	it('reports an unmapped status rather than assuming registered', () => {
		expect(normalizeAttendance({ ...row, status: 'SOMETHING_NEW' })?.status).toBe('UNKNOWN');
	});

	it('distinguishes "did not attend" from "not recorded"', () => {
		expect(normalizeAttendance({ ...row, attended: true })?.attended).toBe(true);
		// false is a real outcome now — the dashboard scrape could only ever infer
		// true-or-unknown from a check-in timestamp.
		expect(normalizeAttendance({ ...row, attended: false })?.attended).toBe(false);
		expect(normalizeAttendance({ ...row, attended: null })?.attended).toBeNull();
	});

	it('prefers the primary entry when a person has several', () => {
		const multi = normalizeAttendance({
			...row,
			person: {
				...row.person,
				email_addresses: [
					{ primary: false, address: 'old@example.com' },
					{ primary: true, address: 'current@example.com' },
				],
			},
		});
		expect(multi?.email).toBe('current@example.com');
	});

	it('falls back to the first entry when none is flagged primary', () => {
		const unflagged = normalizeAttendance({
			...row,
			person: { ...row.person, email_addresses: [{ address: 'only@example.com' }] },
		});
		expect(unflagged?.email).toBe('only@example.com');
	});

	it('tolerates a person with no contact arrays at all', () => {
		const bare = normalizeAttendance({ ...row, person: { given_name: 'Nobody' } });
		expect(bare).toMatchObject({ firstName: 'Nobody', email: null, phone: null, zipcode: null });
	});

	it('drops rows with no usable ids', () => {
		expect(normalizeAttendance({ ...row, timeslot: null })).toBeNull();
		expect(normalizeAttendance({ ...row, id: undefined as unknown as number })).toBeNull();
	});
});
