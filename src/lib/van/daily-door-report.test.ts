import { describe, it, expect } from 'vitest';
import { buildReportRows, reportSlackText, type DoorReport } from './daily-door-report.js';

const REPORT: DoorReport = {
	campaignName: 'Main',
	day: '2026-10-07',
	dayLabel: 'Wednesday, Oct 7, 2026',
	generatedAt: '2026-10-07 22:00',
	contactsReadThrough: '2026-10-07 21:55',
	turfs: [
		{
			turfId: 3,
			folderId: 20,
			turfName: 'Turf 10',
			regionName: 'R2',
			doors: 4,
			appDoors: 0,
			checkedOut: false,
		},
		{
			turfId: 2,
			folderId: 10,
			turfName: 'Turf 9',
			regionName: 'R1',
			doors: 5,
			appDoors: 0,
			checkedOut: true,
		},
		{
			turfId: 1,
			folderId: 20,
			turfName: 'Turf 2',
			regionName: 'R2',
			doors: 6,
			appDoors: 6,
			checkedOut: true,
		},
	],
	folderNames: new Map([
		[10, 'Washtenaw'],
		[20, 'Alger'],
	]),
	peopleOutsideTurfs: 3,
};

describe('buildReportRows', () => {
	it('groups turfs by folder, by name, splitting doors in and outside the app', () => {
		const rows = buildReportRows(REPORT).map((r) => r.cells);
		const body = rows.slice(4, rows.findIndex((r) => r[0] === 'Grand total') + 1);
		expect(body).toEqual([
			['Alger', 'Turf 2', 'R2', 'Yes', 6, 0, 6],
			['Alger', 'Turf 10', 'R2', '', 0, 4, 4],
			['Alger total', '2 turfs', '', '1 checked out', 6, 4, 10],
			[],
			// Checked out, but every door knocked outside the checkout.
			['Washtenaw', 'Turf 9', 'R1', 'Yes', 0, 5, 5],
			['Washtenaw total', '1 turf', '', '1 checked out', 0, 5, 5],
			[],
			['Grand total', '3 turfs in 2 folders', '', '2 checked out', 6, 9, 15],
		]);
		expect(rows).toContainEqual(['People contacted on no synced turf', '', '', '', '', '', 3]);
	});

	it('heads the columns', () => {
		expect(buildReportRows(REPORT)[3]).toEqual({
			cells: [
				'VAN folder',
				'Turf',
				'Region',
				'Checked out in app',
				'Doors in app',
				'Doors outside app',
				'Total doors',
			],
			bold: true,
		});
	});

	it('bolds the headings and totals only', () => {
		const bold = buildReportRows(REPORT)
			.filter((r) => r.bold)
			.map((r) => r.cells[0]);
		expect(bold).toEqual([
			'Doors contacted · Main · Wednesday, Oct 7, 2026',
			'VAN folder',
			'Alger total',
			'Washtenaw total',
			'Grand total',
		]);
	});

	it('still makes a tab on a day with no doors', () => {
		const rows = buildReportRows({ ...REPORT, turfs: [] }).map((r) => r.cells);
		expect(rows).toContainEqual(['No doors contacted on synced turf.']);
		expect(rows).toContainEqual([
			'Grand total',
			'0 turfs in 0 folders',
			'',
			'0 checked out',
			0,
			0,
			0,
		]);
	});
});

describe('reportSlackText', () => {
	it('gives the total split by the app, folders largest first, and the link', () => {
		expect(reportSlackText(REPORT, 'https://example.com/s?a=1&b=2')).toBe(
			[
				'*Doors contacted · Main · Wednesday, Oct 7, 2026*',
				'*15* doors on 3 turfs in 2 folders: *6* through the app, *9* outside it.',
				'• Alger: 10 (6 in app)',
				'• Washtenaw: 5 (0 in app)',
				'<https://example.com/s?a=1&amp;b=2|Full report by turf>',
			].join('\n'),
		);
	});

	it('escapes names from VAN', () => {
		const text = reportSlackText(
			{ ...REPORT, folderNames: new Map([[10, '<!channel>']]) },
			'https://example.com',
		);
		expect(text).toContain('• &lt;!channel&gt;: 5');
	});
});
