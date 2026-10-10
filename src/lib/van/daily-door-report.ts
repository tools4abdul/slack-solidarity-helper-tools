// The nightly door report's layout: one campaign day's doors contacted, per
// turf, grouped by VAN folder, as the rows of a spreadsheet tab and as a Slack
// message. Pure — the counting is in server/van/daily-door-report.ts.
//
// Every in-person contact VAN has counts, whether the turf was claimed here,
// handed out by an organizer, or walked off a list printed in VAN: the counts
// come from ContactHistory, not from this app's checkouts.

import { escapeMrkdwn, mrkdwnLink } from '../slack-mrkdwn.js';

/** Doors contacted on one turf on the day. */
export interface TurfDoors {
	turfId: number;
	folderId: number;
	turfName: string;
	regionName: string;
	doors: number;
}

export interface DoorReport {
	campaignName: string;
	/** `YYYY-MM-DD`, campaign-local. */
	day: string;
	/** e.g. "Wednesday, Oct 7, 2026". */
	dayLabel: string;
	/** `campaignSheetStamp` of when the report was made. */
	generatedAt: string;
	/** `campaignSheetStamp` of how far VAN's contact history has been read, or
	 *  '' when it has not been read yet. */
	contactsReadThrough: string;
	turfs: readonly TurfDoors[];
	/** VAN folder names by id; a folder missing here shows as `Folder <id>`. */
	folderNames: ReadonlyMap<number, string>;
	/** People with a contact on the day who are on no synced turf's list, and
	 *  so cannot be put on one. People, not doors: without a turf there is no
	 *  door to count them by. */
	peopleOutsideTurfs: number;
}

export interface FolderDoors {
	folderId: number;
	name: string;
	doors: number;
	turfs: TurfDoors[];
}

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function folderName(folderNames: ReadonlyMap<number, string>, folderId: number): string {
	return folderNames.get(folderId)?.trim() || `Folder ${folderId}`;
}

/** Folders by name, each with its turfs by name and its total. Turfs with no
 *  doors are left out. */
export function groupByFolder(report: Pick<DoorReport, 'turfs' | 'folderNames'>): FolderDoors[] {
	const folders = new Map<number, FolderDoors>();
	for (const turf of report.turfs) {
		if (turf.doors <= 0) continue;
		let folder = folders.get(turf.folderId);
		if (!folder) {
			folder = {
				folderId: turf.folderId,
				name: folderName(report.folderNames, turf.folderId),
				doors: 0,
				turfs: [],
			};
			folders.set(turf.folderId, folder);
		}
		folder.doors += turf.doors;
		folder.turfs.push(turf);
	}
	const sorted = [...folders.values()].sort(
		(a, b) => byName.compare(a.name, b.name) || a.folderId - b.folderId,
	);
	for (const folder of sorted) {
		folder.turfs.sort((a, b) => byName.compare(a.turfName, b.turfName) || a.turfId - b.turfId);
	}
	return sorted;
}

export interface ReportRow {
	cells: Array<string | number>;
	bold?: boolean;
}

export const REPORT_COLUMNS = ['VAN folder', 'Turf', 'Region', 'Doors contacted'] as const;
/** Pixel widths for REPORT_COLUMNS. Fixed rather than fitted: the title and the
 *  notes run long in column A and would stretch it across the screen. */
export const REPORT_COLUMN_WIDTHS = [220, 220, 200, 120] as const;
/** What A1 of every report tab starts with — how the app tells its own tab
 *  from one somebody else made with the same date for a name. */
export const REPORT_TITLE_PREFIX = 'Doors contacted · ';

/**
 * The tab, top to bottom: a title and how fresh the numbers are, the column
 * headings, each folder's turfs followed by its total, the grand total, and
 * what the numbers do not include.
 *
 * The folder is repeated on every turf row rather than written once above its
 * turfs, so the tab still reads right after someone filters or sorts it.
 */
export function buildReportRows(report: DoorReport): ReportRow[] {
	const folders = groupByFolder(report);
	const total = folders.reduce((sum, f) => sum + f.doors, 0);
	const turfCount = folders.reduce((sum, f) => sum + f.turfs.length, 0);

	const rows: ReportRow[] = [
		{ cells: [`${REPORT_TITLE_PREFIX}${report.campaignName} · ${report.dayLabel}`], bold: true },
		{
			cells: [
				`Made ${report.generatedAt}. VAN contact history read up to ${
					report.contactsReadThrough || 'nothing yet'
				}.`,
			],
		},
		{ cells: [] },
		{ cells: [...REPORT_COLUMNS], bold: true },
	];

	if (folders.length === 0) {
		rows.push({ cells: ['No doors contacted on synced turf.'] });
	}
	for (const folder of folders) {
		for (const turf of folder.turfs) {
			rows.push({ cells: [folder.name, turf.turfName, turf.regionName, turf.doors] });
		}
		rows.push({
			cells: [
				`${folder.name} total`,
				`${folder.turfs.length} ${folder.turfs.length === 1 ? 'turf' : 'turfs'}`,
				'',
				folder.doors,
			],
			bold: true,
		});
		rows.push({ cells: [] });
	}
	if (folders.length === 0) rows.push({ cells: [] });

	rows.push({
		cells: [
			'Grand total',
			`${turfCount} ${turfCount === 1 ? 'turf' : 'turfs'} in ${folders.length} ${
				folders.length === 1 ? 'folder' : 'folders'
			}`,
			'',
			total,
		],
		bold: true,
	});
	rows.push({ cells: [] });
	rows.push({
		cells: ['People contacted on no synced turf', '', '', report.peopleOutsideTurfs],
	});
	rows.push({ cells: [] });
	for (const note of REPORT_NOTES) rows.push({ cells: [note] });
	return rows;
}

export const REPORT_NOTES = [
	'Counts every in-person door contact in VAN that day, including not home and refused, whether or not the turf was checked out through this app.',
	'A door counts once, however many people there were contacted.',
	"Only turf in VAN folders mapped to a chapter in this app's settings is listed. People contacted elsewhere are counted as people on the line above, not as doors.",
	'This tab is written at 10pm and rewritten at 8am the next day, to take in canvassers who synced MiniVAN late.',
];

/** The turf channel's message: the totals, the biggest folders, and a link to
 *  the tab. mrkdwn. */
export function reportSlackText(report: DoorReport, link: string): string {
	const folders = groupByFolder(report);
	const total = folders.reduce((sum, f) => sum + f.doors, 0);
	const turfCount = folders.reduce((sum, f) => sum + f.turfs.length, 0);
	const heading = `*Doors contacted · ${escapeMrkdwn(report.campaignName)} · ${escapeMrkdwn(report.dayLabel)}*`;
	if (total === 0) {
		return `${heading}\nNo doors contacted on synced turf. ${mrkdwnLink(link, 'Report')}`;
	}
	const top = [...folders]
		.sort((a, b) => b.doors - a.doors)
		.slice(0, 5)
		.map((f) => `• ${escapeMrkdwn(f.name)}: ${f.doors.toLocaleString('en-US')}`);
	return [
		heading,
		`*${total.toLocaleString('en-US')}* doors on ${turfCount} ${
			turfCount === 1 ? 'turf' : 'turfs'
		} in ${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}.`,
		...top,
		...(folders.length > top.length ? [`…and ${folders.length - top.length} more`] : []),
		mrkdwnLink(link, 'Full report by turf'),
	].join('\n');
}
