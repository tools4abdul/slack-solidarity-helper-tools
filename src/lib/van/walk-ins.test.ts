import { describe, it, expect } from 'vitest';
import {
	findWalkInLayout,
	firstEmptyWalkInRow,
	isOurWalkIn,
	walkInColumnIndexes,
	walkInWrites,
	walkInCells,
	findOurWalkIn,
	shiftFor,
	shiftMinutes,
	walkInDay,
} from './walk-ins.js';

const HEADER = [
	'Name',
	'Shift Start Time',
	'Phone',
	'Email',
	'Zip Code',
	'Notes',
	'Final Status',
	'In VAN?',
	'Reshifted?',
];

describe('findWalkInLayout', () => {
	it('finds the header below a title row, by name, whatever the spacing', () => {
		const layout = findWalkInLayout([
			['Walk-ins for today'],
			['name', ' Shift start time ', 'Phone'],
		]);
		expect(layout).toEqual({
			headerRowIndex: 1,
			columns: { Name: 0, 'Shift Start Time': 1, Phone: 2 },
		});
	});

	it('needs Name and Shift Start Time', () => {
		expect(findWalkInLayout([['Name', 'Phone']])).toBeNull();
		expect(findWalkInLayout([])).toBeNull();
	});
});

describe('firstEmptyWalkInRow', () => {
	const layout = findWalkInLayout([HEADER])!;

	it('takes the first gap, not the bottom', () => {
		expect(
			firstEmptyWalkInRow([HEADER, ['Ari'], ['', '', '', '', '', '', '', '', ''], ['Bo']], layout),
		).toBe(2);
	});

	it('counts a row with only the campaign’s notes as used', () => {
		expect(firstEmptyWalkInRow([HEADER, ['', '', '', '', '', 'came back later']], layout)).toBe(2);
	});

	it('goes past the last row read, and past rows this run already took', () => {
		const values = [HEADER, ['Ari']];
		expect(firstEmptyWalkInRow(values, layout)).toBe(2);
		expect(firstEmptyWalkInRow(values, layout, new Set([2, 3]))).toBe(4);
		expect(firstEmptyWalkInRow([HEADER, [], ['Bo']], layout, new Set([1]))).toBe(3);
	});
});

describe('cells', () => {
	const layout = findWalkInLayout([HEADER])!;

	it('writes the name and a text shift as text, so the drop-down still matches', () => {
		const cells = walkInCells({ slackUserName: '=IMPORTXML(1)' }, '10am');
		expect(walkInWrites(cells, layout)).toEqual([
			[0, "'=IMPORTXML(1)"],
			[1, "'10am"],
		]);
		expect(walkInWrites([['Final Status', 'Completed']], layout)).toEqual([[6, "'Completed"]]);
	});

	it('writes a shift held as a real time as typed, and blanks as blanks', () => {
		const cells = walkInCells({ slackUserName: 'Dana' }, '10:00 AM');
		expect(walkInWrites(cells, layout, { shiftAsTyped: true })).toEqual([
			[0, "'Dana"],
			[1, '10:00 AM'],
		]);
		expect(walkInWrites([['Name', '']], layout)).toEqual([[0, '']]);
	});

	it('leaves the shift out when there is none', () => {
		expect(walkInCells({ slackUserName: 'Dana' }, null)).toEqual([['Name', 'Dana']]);
	});

	it('highlights every column the tab has', () => {
		expect(walkInColumnIndexes(layout)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('knows its row by the name, and the shift when it wrote one', () => {
		expect(isOurWalkIn(['Dana ', '10AM'], layout, { name: 'Dana', shift: '10am' })).toBe(true);
		expect(isOurWalkIn(['Dana', '1pm'], layout, { name: 'Dana', shift: '10am' })).toBe(false);
		expect(isOurWalkIn(['Dana', '1pm'], layout, { name: 'Dana', shift: null })).toBe(true);
		expect(isOurWalkIn(['Frankie'], layout, { name: 'Dana', shift: null })).toBe(false);
	});
});

describe('shifts', () => {
	const OPTIONS = ['10am', '1pm', '4pm', '6pm'].map((label) => ({ label, text: true }));
	const pick = (claimedAt: string, options = OPTIONS) =>
		shiftFor(claimedAt, options)?.label ?? null;
	const opts = (...labels: string[]) => labels.map((label) => ({ label, text: true }));

	it('reads times as people write them', () => {
		expect(shiftMinutes('10am')).toBe(600);
		expect(shiftMinutes('1 PM')).toBe(780);
		expect(shiftMinutes('12pm')).toBe(720);
		expect(shiftMinutes('12am')).toBe(0);
		expect(shiftMinutes('10:30 a.m.')).toBe(630);
		expect(shiftMinutes('10:00:00 AM')).toBe(600);
		expect(shiftMinutes('16:00')).toBe(960);
		expect(shiftMinutes('13pm')).toBeNull();
		expect(shiftMinutes('morning')).toBeNull();
		expect(shiftMinutes('10am-2pm')).toBeNull();
	});

	// Campaign clock is America/Detroit: UTC-4 in September.
	it('picks the latest shift starting at or before the claim', () => {
		expect(pick('2026-09-19T14:07:00.000Z')).toBe('10am'); // 10:07
		expect(pick('2026-09-19T17:00:00.000Z')).toBe('1pm'); // 1:00
		expect(pick('2026-09-19T19:59:00.000Z')).toBe('1pm'); // 3:59
		expect(pick('2026-09-20T01:30:00.000Z')).toBe('6pm'); // 9:30pm
	});

	it('gives a claim before the first shift the first one', () => {
		expect(pick('2026-09-19T12:30:00.000Z')).toBe('10am'); // 8:30
	});

	it('ignores options that are not times, and has none when none are', () => {
		expect(pick('2026-09-19T17:30:00.000Z', opts('TBD', '1pm'))).toBe('1pm');
		expect(pick('2026-09-19T17:30:00.000Z', opts('Morning', 'Evening'))).toBeNull();
	});

	it('keeps whether the option is text', () => {
		expect(shiftFor('2026-09-19T14:07:00.000Z', [{ label: '10:00 AM', text: false }])).toEqual({
			label: '10:00 AM',
			text: false,
		});
	});
});

describe('walkInDay', () => {
	it('runs a canvass day on until 4am', () => {
		expect(walkInDay('2026-09-20T03:00:00.000Z')).toBe('2026-09-19'); // 11pm
		expect(walkInDay('2026-09-20T07:30:00.000Z')).toBe('2026-09-19'); // 3:30am
		expect(walkInDay('2026-09-20T08:30:00.000Z')).toBe('2026-09-20'); // 4:30am
	});
});

describe('findOurWalkIn', () => {
	const layout = findWalkInLayout([HEADER])!;
	const ours = { name: 'Dana', shift: '10am' };

	it('finds the one row with our name and shift', () => {
		const values = [HEADER, ['Ari'], ['Dana', '1pm'], ['Dana', '10am']];
		expect(findOurWalkIn(values, layout, ours, new Set())).toBe(3);
	});

	it('skips rows other checkouts hold', () => {
		const values = [HEADER, ['Dana', '10am'], ['Dana', '10am']];
		expect(findOurWalkIn(values, layout, ours, new Set([1]))).toBe(2);
	});

	it('will not guess between two', () => {
		const values = [HEADER, ['Dana', '10am'], ['Dana', '10am']];
		expect(findOurWalkIn(values, layout, ours, new Set())).toBeNull();
		expect(findOurWalkIn([HEADER, ['Ari']], layout, ours, new Set())).toBeNull();
	});
});
