import { describe, it, expect } from 'vitest';
import {
	PACKET_COLUMNS,
	blankCells,
	campaignAssignments,
	changedCells,
	desiredRow,
	findLayout,
	rowValues,
	sheetDate,
	stillOurs,
	type ColumnLayout,
	type PacketCheckout,
} from './packet-tracker.js';

// Campaign clock is America/Detroit (EDT, UTC-4, in September).
const BASE: PacketCheckout = {
	checkoutId: 41,
	claimedAt: '2026-09-19T14:07:00.000Z', // 10:07 AM
	releasedAt: null,
	completedAt: null,
	reportedPercent: null,
	loadedInMinivanAt: null,
	slackUserName: 'Dana',
	issuedListNumber: '35536745-88712',
	claimDoorCount: 64,
	turfName: 'Turf 01',
	regionName: 'R10C_Wayne_TaylorCity004_9.11',
	routeSize: 120,
	doorCount: 50,
};

const checkout = (over: Partial<PacketCheckout> = {}): PacketCheckout => ({ ...BASE, ...over });

const HEADER = [...PACKET_COLUMNS];

function layoutOf(values: string[][]): ColumnLayout {
	const found = findLayout(values);
	if (!found.ok) throw new Error(`missing ${found.missing.join(', ')}`);
	return found.layout;
}

describe('desiredRow', () => {
	it('writes a fresh claim as Unwalked, with what the volunteer was issued', () => {
		expect(desiredRow(checkout())).toEqual({
			'Packet Name': 'Turf 01',
			Voters: '120',
			// Claim-time door count, not VAN's current one.
			Doors: '64',
			'List Number': '35536745-88712',
			Canvasser: 'Dana',
			'Shift Time': '10:07 AM',
			'Date Sent Out': '09/19/2026',
			'Time Departed': '',
			'Walk Mode': 'MiniVAN',
			'Phone Number': '',
			'Doors Knocked': '',
			Status: 'Unwalked',
			'Knocked %': '',
		});
	});

	it('goes Out, with a departure time, once the list is loaded in MiniVAN', () => {
		const row = desiredRow(checkout({ loadedInMinivanAt: '2026-09-19T14:41:00.000Z' }));
		expect(row?.Status).toBe('Out');
		expect(row?.['Time Departed']).toBe('10:41 AM');
	});

	// Claimed from Slack or the site, it is the same moment.
	it('uses the claim time as the shift time', () => {
		expect(desiredRow(checkout())?.['Shift Time']).toBe('10:07 AM');
	});

	it('marks a fully walked turf Complete with doors knocked', () => {
		const row = desiredRow(
			checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 100 }),
		);
		expect(row).toMatchObject({ Status: 'Complete', 'Knocked %': '100%', 'Doors Knocked': '64' });
	});

	it('marks a partly walked turf Incomplete, rounding doors knocked', () => {
		const row = desiredRow(
			checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 85 }),
		);
		// 0.85 × 64 = 54.4
		expect(row).toMatchObject({ Status: 'Incomplete', 'Knocked %': '85%', 'Doors Knocked': '54' });
	});

	it('wants no row for a turf handed back before it was ever loaded', () => {
		expect(desiredRow(checkout({ releasedAt: '2026-09-19T15:00:00.000Z' }))).toBeNull();
	});

	it('keeps an Incomplete row for a turf handed back after it was loaded', () => {
		const row = desiredRow(
			checkout({
				releasedAt: '2026-09-19T15:00:00.000Z',
				loadedInMinivanAt: '2026-09-19T14:41:00.000Z',
			}),
		);
		expect(row?.Status).toBe('Incomplete');
		// Nobody said how far they got.
		expect(row?.['Knocked %']).toBe('');
	});

	it('falls back to the current door count on claims older than the column', () => {
		expect(desiredRow(checkout({ claimDoorCount: null }))?.Doors).toBe('50');
	});

	it('never sends a phone number', () => {
		expect(desiredRow(checkout())?.['Phone Number']).toBe('');
	});
});

describe('sheetDate', () => {
	// 11pm Saturday in Detroit is Sunday in UTC. The campaign's day is Saturday.
	it('uses the campaign clock, not UTC', () => {
		expect(sheetDate('2026-09-20T03:00:00.000Z')).toBe('09/19/2026');
	});

	it('is blank for garbage', () => {
		expect(sheetDate('nope')).toBe('');
	});
});

describe('findLayout', () => {
	it('finds columns by header name wherever they are', () => {
		const shuffled = [...HEADER].reverse();
		const layout = layoutOf([shuffled]);
		expect(layout.columns['Packet Name']).toBe(shuffled.length - 1);
		expect(layout.columns['Knocked %']).toBe(0);
		expect(layout.width).toBe(shuffled.length);
	});

	it('tolerates case, spacing and a title row above the header', () => {
		const messy = HEADER.map((h) => ` ${h.toUpperCase()} `);
		const layout = layoutOf([['Downriver packets — fall canvass'], messy]);
		expect(layout.headerRowIndex).toBe(1);
	});

	it('names the columns it could not find', () => {
		const found = findLayout([HEADER.filter((h) => h !== 'Status' && h !== 'Voters')]);
		expect(found).toEqual({ ok: false, missing: ['Voters', 'Status'] });
	});
});

describe('rowValues', () => {
	it('places cells by column and leaves the rest null', () => {
		const layout = layoutOf([['Notes', ...HEADER]]);
		const row = rowValues({ Status: 'Out' }, layout);
		expect(row).toHaveLength(HEADER.length + 1);
		expect(row[0]).toBeNull();
		expect(row[layout.columns.Status]).toBe("'Out");
		expect(row.filter((c) => c !== null)).toHaveLength(1);
	});

	// A Slack display name is user input and the write is USER_ENTERED.
	it('forces text cells to text so a name cannot be a formula', () => {
		const layout = layoutOf([HEADER]);
		const row = rowValues({ Canvasser: '=IMPORTXML("http://x")', Voters: '120' }, layout);
		expect(row[layout.columns.Canvasser]).toBe('\'=IMPORTXML("http://x")');
		expect(row[layout.columns.Voters]).toBe('120');
	});

	it('clears a text cell with a bare empty string', () => {
		const layout = layoutOf([HEADER]);
		expect(rowValues({ Canvasser: '' }, layout)[layout.columns.Canvasser]).toBe('');
	});
});

describe('changedCells', () => {
	it('returns only what moved', () => {
		const before = desiredRow(checkout())!;
		const after = desiredRow(checkout({ loadedInMinivanAt: '2026-09-19T14:41:00.000Z' }))!;
		expect(changedCells(before, after)).toEqual({ 'Time Departed': '10:41 AM', Status: 'Out' });
	});

	// A re-cut moves VAN's numbers; the campaign may have corrected a name.
	it('never rewrites the columns written at claim time', () => {
		const before = desiredRow(checkout())!;
		const after = desiredRow(checkout({ turfName: 'Turf 01 (recut)', routeSize: 90 }))!;
		expect(changedCells(before, after)).toEqual({});
	});

	it('includes cells that became blank', () => {
		const before = { ...desiredRow(checkout())!, 'Knocked %': '50%' };
		expect(changedCells(before, desiredRow(checkout())!)).toEqual({ 'Knocked %': '' });
	});

	it('clears every non-write-once cell to blank', () => {
		expect(blankCells().Status).toBe('');
	});
});

describe('stillOurs', () => {
	const layout = layoutOf([HEADER]);
	const written = desiredRow(checkout())!;
	const rowWith = (over: Record<string, string>) =>
		HEADER.map((h) => over[h] ?? (written as Record<string, string>)[h] ?? '');

	it('accepts our row as we left it', () => {
		expect(stillOurs(rowWith({}), layout, written)).toBe(true);
	});

	it('accepts a row we already blanked', () => {
		expect(
			stillOurs(
				HEADER.map(() => ''),
				layout,
				written,
			),
		).toBe(true);
		expect(stillOurs(undefined, layout, written)).toBe(true);
	});

	it('refuses a row someone typed a different turf or canvasser into', () => {
		expect(stillOurs(rowWith({ 'List Number': '999-1' }), layout, written)).toBe(false);
		expect(stillOurs(rowWith({ Canvasser: 'Sam' }), layout, written)).toBe(false);
	});

	it('does not care about other cells the campaign edited', () => {
		expect(stillOurs(rowWith({ 'Phone Number': '555-0100', Status: 'Out' }), layout, written)).toBe(
			true,
		);
	});
});

describe('campaignAssignments', () => {
	const row = (list: string, status: string, canvasser = 'Sam') =>
		HEADER.map((h) =>
			h === 'List Number' ? list : h === 'Status' ? status : h === 'Canvasser' ? canvasser : '',
		);

	it('counts Unwalked, Out and Complete, not Incomplete', () => {
		const values = [
			HEADER,
			row('1-1', 'Unwalked'),
			row('2-2', 'out'),
			row('3-3', ' Complete '),
			row('4-4', 'Incomplete'),
			row('5-5', ''),
		];
		const assigned = campaignAssignments(values, layoutOf(values), new Set());
		expect([...assigned.keys()].sort()).toEqual(['1-1', '2-2', '3-3']);
	});

	it('ignores our own tagged rows', () => {
		const values = [HEADER, row('1-1', 'Out'), row('2-2', 'Out')];
		const assigned = campaignAssignments(values, layoutOf(values), new Set([1]));
		expect([...assigned.keys()]).toEqual(['2-2']);
	});

	it('forgives stray spaces in a typed list number, and names an unnamed holder', () => {
		const values = [HEADER, row(' 35536745 - 88712 ', 'Out', '')];
		const assigned = campaignAssignments(values, layoutOf(values), new Set());
		expect(assigned.get('35536745-88712')).toBe('Packet Tracker');
	});

	it('reads nothing above the header', () => {
		const values = [row('1-1', 'Out'), HEADER, row('2-2', 'Out')];
		const layout = layoutOf(values);
		expect([...campaignAssignments(values, layout, new Set()).keys()]).toEqual(['2-2']);
	});
});
