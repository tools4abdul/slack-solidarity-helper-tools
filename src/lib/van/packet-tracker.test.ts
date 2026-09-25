import { describe, it, expect } from 'vitest';
import {
	campaignAssignments,
	cellWrites,
	changedCells,
	clearedCells,
	desiredCells,
	findLayout,
	isUnfilled,
	packetRows,
	sheetDate,
	sheetDoors,
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
	doorCount: 50,
};

const checkout = (over: Partial<PacketCheckout> = {}): PacketCheckout => ({ ...BASE, ...over });

/** The campaign's real layout, verified 2026-09-24: an empty row 1, the
 *  header on row 2, formula columns among the ones we write. */
const HEADER = [
	'Packet Name',
	'Voters',
	'Doors',
	'List Number',
	'shift_key',
	'Canvasser',
	'Shift Time',
	'Date Sent Out',
	'Time Departed',
	'Walk Mode',
	'Phone Number',
	'Doors Knocked',
	'Status',
	'Today?',
	'Knocked %',
];
const col = (name: string) => HEADER.indexOf(name);

/** A packet the campaign listed, with whatever canvasser cells are given. */
function packet(list: string, over: Record<string, string> = {}, doors = '64'): string[] {
	const listed: Record<string, string> = {
		'Packet Name': 'Taylor 004',
		Voters: '120',
		Doors: doors,
		'List Number': list,
		shift_key: 'k',
	};
	return HEADER.map((h) => listed[h] ?? over[h] ?? '');
}

function layoutOf(values: string[][]): ColumnLayout {
	const found = findLayout(values);
	if (!found.ok) throw new Error(`missing ${found.missing.join(', ')}`);
	return found.layout;
}

const SHEET = [[], HEADER, packet('111-1'), packet('35536745-88712')];
const LAYOUT = layoutOf(SHEET);

describe('desiredCells', () => {
	it('fills in a fresh claim as Unwalked', () => {
		expect(desiredCells(checkout())).toEqual({
			Canvasser: 'Dana',
			'Shift Time': '10:07 AM',
			'Date Sent Out': '09/19/2026',
			'Time Departed': '',
			'Walk Mode': 'MiniVAN',
			'Doors Knocked': '',
			Status: 'Unwalked',
		});
	});

	// The protected columns, the formulas and the phone number are not ours.
	it('never names a column the campaign fills in or computes', () => {
		const cells = desiredCells(
			checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 50 }),
		)!;
		for (const theirs of [
			'Packet Name',
			'Voters',
			'Doors',
			'List Number',
			'Phone Number',
			'Knocked %',
		]) {
			expect(cells).not.toHaveProperty(theirs);
		}
	});

	it('goes Out, with a departure time, once the list is loaded in MiniVAN', () => {
		const cells = desiredCells(checkout({ loadedInMinivanAt: '2026-09-19T14:41:00.000Z' }));
		expect(cells).toMatchObject({ Status: 'Out', 'Time Departed': '10:41 AM' });
	});

	it('marks a fully walked turf Complete', () => {
		const cells = desiredCells(
			checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 100 }),
		);
		expect(cells).toMatchObject({ Status: 'Complete', 'Doors Knocked': '64' });
	});

	// The sheet's Knocked % divides by its own Doors cell, so Doors Knocked is
	// computed from that — the % it shows is then the one reported.
	it('computes doors knocked from the packet’s own door count', () => {
		const done = checkout({ completedAt: '2026-09-19T17:00:00.000Z', reportedPercent: 85 });
		expect(desiredCells(done, 80)).toMatchObject({ Status: 'Incomplete', 'Doors Knocked': '68' });
		// Falls back to the claim-time count, 0.85 × 64 = 54.4.
		expect(desiredCells(done)).toMatchObject({ 'Doors Knocked': '54' });
		expect(desiredCells({ ...done, claimDoorCount: null })).toMatchObject({
			'Doors Knocked': '43',
		});
	});

	it('wants nothing for a turf handed back before it was ever loaded', () => {
		expect(desiredCells(checkout({ releasedAt: '2026-09-19T15:00:00.000Z' }))).toBeNull();
	});

	it('keeps an Incomplete entry for a turf handed back after it was loaded', () => {
		const cells = desiredCells(
			checkout({
				releasedAt: '2026-09-19T15:00:00.000Z',
				loadedInMinivanAt: '2026-09-19T14:41:00.000Z',
			}),
		);
		expect(cells).toMatchObject({ Status: 'Incomplete', 'Doors Knocked': '' });
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
	it('finds the header on row 2, past the empty first row', () => {
		expect(LAYOUT.headerRowIndex).toBe(1);
		expect(LAYOUT.columns.Canvasser).toBe(col('Canvasser'));
		expect(LAYOUT.columns.Status).toBe(col('Status'));
	});

	it('does not mistake shift_key for Shift Time', () => {
		expect(LAYOUT.columns['Shift Time']).toBe(col('Shift Time'));
	});

	it('names the columns it could not find', () => {
		const found = findLayout([HEADER.filter((h) => h !== 'Status' && h !== 'Canvasser')]);
		expect(found).toEqual({ ok: false, missing: ['Canvasser', 'Status'] });
	});
});

describe('packetRows', () => {
	it('finds the packet by list number, forgiving stray spaces', () => {
		expect(packetRows(SHEET, LAYOUT, '35536745-88712')).toEqual([3]);
		expect(packetRows(SHEET, LAYOUT, ' 35536745 - 88712 ')).toEqual([3]);
	});

	it('returns every row listing it, and none for an unlisted one', () => {
		const doubled = [...SHEET, packet('111-1')];
		expect(packetRows(doubled, LAYOUT, '111-1')).toEqual([2, 4]);
		expect(packetRows(SHEET, LAYOUT, '999-9')).toEqual([]);
	});

	it('never matches the header or anything above it', () => {
		expect(packetRows(SHEET, LAYOUT, 'List Number')).toEqual([]);
	});
});

describe('sheetDoors', () => {
	it('reads the packet’s door count, and nothing that is not a number', () => {
		expect(sheetDoors(packet('1', {}, '1,204'), LAYOUT)).toBe(1204);
		expect(sheetDoors(packet('1', {}, ''), LAYOUT)).toBeNull();
		expect(sheetDoors(packet('1', {}, 'TBD'), LAYOUT)).toBeNull();
		expect(sheetDoors(undefined, LAYOUT)).toBeNull();
	});
});

describe('isUnfilled and stillOurs', () => {
	it('sees a listed packet with nothing filled in as free', () => {
		expect(isUnfilled(packet('1'), LAYOUT)).toBe(true);
	});

	it('sees any canvasser cell filled in as taken', () => {
		expect(isUnfilled(packet('1', { Status: 'Incomplete' }), LAYOUT)).toBe(false);
		expect(isUnfilled(packet('1', { 'Walk Mode': 'Paper' }), LAYOUT)).toBe(false);
	});

	// Phone Number is not ours, so a phone typed in alone does not make it taken.
	it('ignores the campaign’s own columns', () => {
		expect(isUnfilled(packet('1', { 'Phone Number': '555-0100' }), LAYOUT)).toBe(true);
	});

	it('knows our entry by the canvasser name', () => {
		const written = desiredCells(checkout())!;
		expect(stillOurs(packet('1', { Canvasser: 'Dana', Status: 'Out' }), LAYOUT, written)).toBe(
			true,
		);
		expect(stillOurs(packet('1', { Canvasser: 'Sam' }), LAYOUT, written)).toBe(false);
		expect(stillOurs(packet('1'), LAYOUT, written)).toBe(false);
	});
});

describe('changedCells and clearedCells', () => {
	it('returns only what moved', () => {
		const before = desiredCells(checkout())!;
		const after = desiredCells(checkout({ loadedInMinivanAt: '2026-09-19T14:41:00.000Z' }))!;
		expect(changedCells(before, after)).toEqual({ 'Time Departed': '10:41 AM', Status: 'Out' });
	});

	it('never rewrites the columns filled in at claim time', () => {
		const before = { ...desiredCells(checkout())!, Canvasser: 'Dana R.' };
		expect(changedCells(before, desiredCells(checkout())!)).toEqual({});
	});

	it('clears exactly what we filled in', () => {
		const written = desiredCells(checkout({ loadedInMinivanAt: '2026-09-19T14:41:00.000Z' }))!;
		expect(clearedCells(written)).toEqual({
			Canvasser: '',
			'Shift Time': '',
			'Date Sent Out': '',
			'Time Departed': '',
			'Walk Mode': '',
			Status: '',
		});
	});
});

describe('cellWrites', () => {
	it('places each cell by column', () => {
		expect(cellWrites({ Status: 'Out', 'Time Departed': '10:41 AM' }, LAYOUT)).toEqual([
			[col('Time Departed'), '10:41 AM'],
			[col('Status'), 'Out'],
		]);
	});

	// A Slack display name is user input and the write is USER_ENTERED.
	it('forces the canvasser name to text so it cannot be a formula', () => {
		expect(cellWrites({ Canvasser: '=IMPORTXML("x")' }, LAYOUT)).toEqual([
			[col('Canvasser'), '\'=IMPORTXML("x")'],
		]);
		expect(cellWrites({ Canvasser: '' }, LAYOUT)).toEqual([[col('Canvasser'), '']]);
	});
});

describe('campaignAssignments', () => {
	const sheet = (...rows: string[][]) => [[], HEADER, ...rows];

	it('counts Unwalked, Out and Complete, not Incomplete or blank', () => {
		const values = sheet(
			packet('1-1', { Canvasser: 'Sam', Status: 'Unwalked' }),
			packet('2-2', { Canvasser: 'Sam', Status: 'out' }),
			packet('3-3', { Canvasser: 'Sam', Status: ' Complete ' }),
			packet('4-4', { Canvasser: 'Sam', Status: 'Incomplete' }),
			packet('5-5'),
		);
		const assigned = campaignAssignments(values, LAYOUT, new Map());
		expect([...assigned.keys()].sort()).toEqual(['1-1', '2-2', '3-3']);
	});

	it('does not count our own entries', () => {
		const values = sheet(
			packet('1-1', { Canvasser: 'Dana', Status: 'Out' }),
			packet('2-2', { Canvasser: 'Sam', Status: 'Out' }),
		);
		const assigned = campaignAssignments(values, LAYOUT, new Map([['1-1', 'Dana']]));
		expect([...assigned.keys()]).toEqual(['2-2']);
	});

	// We filled it in, then an organizer handed it to someone else.
	it('counts a packet of ours that now names someone else', () => {
		const values = sheet(packet('1-1', { Canvasser: 'Sam', Status: 'Out' }));
		expect(campaignAssignments(values, LAYOUT, new Map([['1-1', 'Dana']])).get('1-1')).toBe('Sam');
	});

	it('names an unnamed holder as the tracker', () => {
		const values = sheet(packet('1-1', { Status: 'Out' }));
		expect(campaignAssignments(values, LAYOUT, new Map()).get('1-1')).toBe('Packet Tracker');
	});
});
