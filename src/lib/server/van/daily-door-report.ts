// The nightly door report: doors contacted per turf on one campaign day,
// written as a new tab of the campaign's report spreadsheet and announced in the
// turf channel. The layout is in $lib/van/daily-door-report.ts.
//
// The counts come from the same two tables as the uncontacted-door count
// (contact-sync.ts): van_person_contacts, every in-person contact VAN has for
// the campaign whoever handed out the turf, and van_turf_roster, which puts each
// person at a door on a turf. A door is contacted on the day when any resident's
// latest in-person contact falls inside it.
//
// LATEST contact, because that is all van_person_contacts keeps. A door knocked
// today and again tomorrow has moved to tomorrow by the time tomorrow is read, so
// a day's figure is right only until the next day's canvassing syncs — which is
// why the report is made the same night and refreshed the next morning, and
// never backfilled.
//
// A door can sit on two rosters at once: a re-cut retires a route, and its
// roster is kept a day (RETIRED_ROSTER_KEEP_MS) beside the new route's. It is
// counted once, on the route that was live when it was knocked — the one the
// volunteer was walking — and only failing that on the live route, then the
// most recently cut. When both look live at the knock, the older cut wins:
// `retired_at` is when our sync noticed the re-cut, up to half an hour after
// VAN made it, and in that gap nobody can have been handed the new route —
// the same sync is what offers it. Preferring the live route outright would hand a turf
// walked at 3pm and re-cut at 4pm to its replacement, and the overnight
// re-cut sweep would move the whole day's doors between 10pm and 8am.
//
// Injected sheets client, folder lookup and Slack post, so tests drive it
// without Google, VAN or Slack. The endpoint wires the real ones.

import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { vanCampaigns, vanContactSyncState, type VanCampaignRow } from '../schema.js';
import type { SheetsClient } from '../google/sheets.js';
import { errMessage } from '../../err-message.js';
import { escapeMrkdwn } from '../../slack-mrkdwn.js';
import { campaignDayBounds, campaignDayLabel, campaignSheetStamp } from '../../campaign-time.js';
import {
	buildReportRows,
	groupByFolder,
	REPORT_COLUMN_WIDTHS,
	REPORT_TITLE_PREFIX,
	reportSlackText,
	type DoorReport,
	type ReportRow,
	type TurfDoors,
} from '../../van/daily-door-report.js';
import { campaignName } from './campaigns.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

const LOG = '[door-report]';

/** Long enough for the three Sheets requests a tab takes, with retries. */
const SHEETS_BUDGET_MS = 2 * 60 * 1000;

/** Enabled campaigns with a report spreadsheet. A disabled campaign is not
 *  synced, so it has no fresh contacts to report. */
export async function dailyReportCampaigns(db: Db): Promise<VanCampaignRow[]> {
	return db
		.select()
		.from(vanCampaigns)
		.where(
			and(
				eq(vanCampaigns.enabled, true),
				isNotNull(vanCampaigns.dailyReportSpreadsheetId),
				ne(vanCampaigns.dailyReportSpreadsheetId, ''),
			),
		)
		.orderBy(vanCampaigns.id);
}

/**
 * Doors contacted per turf in `[start, end)`, and the people contacted then
 * who are on no turf's roster. Turfs with none are not returned.
 */
export async function countDoorsByTurf(
	db: Db,
	options: { campaignId: number; start: Date; end: Date },
): Promise<{ turfs: TurfDoors[]; peopleOutsideTurfs: number }> {
	const from = options.start.toISOString();
	const to = options.end.toISOString();
	const liveAtContact = sql`coalesce(t.cut_at, t.first_seen_at) <= c.last_in_person_at
		AND (t.retired_at IS NULL OR t.retired_at > c.last_in_person_at)`;
	const turfs = (await db.all(sql`
		WITH hits AS (
			SELECT r.turf_id AS turf_id,
				row_number() OVER (
					PARTITION BY r.door_hash
					ORDER BY (${liveAtContact}) DESC,
						CASE WHEN ${liveAtContact} THEN coalesce(t.cut_at, t.first_seen_at) END ASC,
						t.retired_at IS NULL DESC,
						coalesce(t.cut_at, t.first_seen_at) DESC,
						t.turf_id DESC
				) AS pick
			FROM van_person_contacts c
			JOIN van_turf_roster r ON r.person_hash = c.person_hash
			JOIN van_turfs t ON t.turf_id = r.turf_id AND t.campaign_id = c.campaign_id
			WHERE c.campaign_id = ${options.campaignId}
				AND c.last_in_person_at >= ${from}
				AND c.last_in_person_at < ${to}
		)
		SELECT t.turf_id AS turfId, t.folder_id AS folderId, t.name AS turfName,
			t.region_name AS regionName, count(*) AS doors
		FROM hits h
		JOIN van_turfs t ON t.turf_id = h.turf_id
		WHERE h.pick = 1
		GROUP BY t.turf_id
	`)) as TurfDoors[];

	const [outside] = (await db.all(sql`
		SELECT count(*) AS n
		FROM van_person_contacts c
		WHERE c.campaign_id = ${options.campaignId}
			AND c.last_in_person_at >= ${from}
			AND c.last_in_person_at < ${to}
			AND NOT EXISTS (
				SELECT 1 FROM van_turf_roster r
				JOIN van_turfs t ON t.turf_id = r.turf_id
				WHERE r.person_hash = c.person_hash AND t.campaign_id = c.campaign_id
			)
	`)) as Array<{ n: number }>;

	return {
		turfs: turfs.map((t) => ({ ...t, doors: Number(t.doors) })),
		peopleOutsideTurfs: Number(outside?.n ?? 0),
	};
}

export interface DailyReportDeps {
	db: Db;
	/** The Sheets client, or why there is none. */
	sheets: { ok: true; client: SheetsClient } | { ok: false; error: string };
	/** VAN folder names by id. May throw: the report goes out with folder ids. */
	folderNames: (campaign: VanCampaignRow) => Promise<Map<number, string>>;
	/** Read VAN's newest contacts before counting. Given minutes rather than
	 *  the half-hourly sync's 45 seconds, because ContactHistory is an export
	 *  job VAN takes a few minutes to finish, and a short pass only submits it.
	 *  May throw: the report then counts what is already read. */
	refreshContacts?: (campaign: VanCampaignRow) => Promise<void>;
	/** Post mrkdwn to the turf channel; false when it did not go. */
	post: (text: string) => Promise<boolean>;
	/** Who the spreadsheet has to be shared with, for the failure alert. */
	serviceAccountEmail: string | null;
	now?: () => Date;
}

export interface DailyReportResult {
	campaignId: number;
	day: string;
	doors: number;
	turfs: number;
	folders: number;
	peopleOutsideTurfs: number;
	written: boolean;
	posted: boolean;
	error?: string;
	/** The tab's rows, on a dry run. */
	rows?: ReportRow[];
}

/**
 * Make one campaign's report for `day` (`YYYY-MM-DD`, campaign-local): write
 * its tab, and with `announce` post the totals. Rerunning a day rewrites the
 * same tab. Never throws; a failure to write is posted to the turf channel and
 * returned.
 */
export async function runDailyDoorReport(
	deps: DailyReportDeps,
	campaign: VanCampaignRow,
	options: { day: string; announce: boolean; dryRun?: boolean },
): Promise<DailyReportResult> {
	const now = deps.now ?? (() => new Date());
	const name = campaignName(campaign);
	const result: DailyReportResult = {
		campaignId: campaign.id,
		day: options.day,
		doors: 0,
		turfs: 0,
		folders: 0,
		peopleOutsideTurfs: 0,
		written: false,
		posted: false,
	};

	const bounds = campaignDayBounds(options.day);
	if (!bounds) return { ...result, error: `not a day: ${options.day}` };
	const spreadsheetId = campaign.dailyReportSpreadsheetId?.trim();
	if (!spreadsheetId) return { ...result, error: 'no report spreadsheet is set' };

	try {
		if (deps.refreshContacts && !options.dryRun) {
			try {
				await deps.refreshContacts(campaign);
			} catch (err) {
				console.warn(`${LOG} campaign ${campaign.id}: contact refresh failed:`, errMessage(err));
			}
		}
		const counts = await countDoorsByTurf(deps.db, {
			campaignId: campaign.id,
			start: bounds.start,
			end: bounds.end,
		});
		const [state] = await deps.db
			.select({ cursor: vanContactSyncState.cursor })
			.from(vanContactSyncState)
			.where(eq(vanContactSyncState.campaignId, campaign.id));

		let folderNames = new Map<number, string>();
		if (counts.turfs.length > 0) {
			try {
				folderNames = await deps.folderNames(campaign);
			} catch (err) {
				console.warn(`${LOG} campaign ${campaign.id}: folder names unavailable:`, errMessage(err));
			}
		}

		const report: DoorReport = {
			campaignName: name,
			day: options.day,
			dayLabel: `${campaignDayLabel(bounds.start.toISOString())}, ${options.day.slice(0, 4)}`,
			generatedAt: campaignSheetStamp(now().toISOString()),
			contactsReadThrough: state?.cursor ? campaignSheetStamp(state.cursor) : '',
			turfs: counts.turfs,
			folderNames,
			peopleOutsideTurfs: counts.peopleOutsideTurfs,
		};
		const folders = groupByFolder(report);
		result.doors = folders.reduce((sum, f) => sum + f.doors, 0);
		result.turfs = folders.reduce((sum, f) => sum + f.turfs.length, 0);
		result.folders = folders.length;
		result.peopleOutsideTurfs = counts.peopleOutsideTurfs;
		const rows = buildReportRows(report);
		if (options.dryRun) return { ...result, rows };

		/** `shareHint` only where access is the likely cause: a refusal to
		 *  overwrite somebody else's tab (409) is not about sharing. */
		const failed = async (error: string, shareHint = true): Promise<DailyReportResult> => {
			const shareWith =
				shareHint && deps.serviceAccountEmail
					? ` Check the spreadsheet is shared with ${escapeMrkdwn(deps.serviceAccountEmail)} as an Editor.`
					: '';
			await deps.post(
				`:warning: The ${escapeMrkdwn(options.day)} door report for ${escapeMrkdwn(name)} ` +
					`could not be written: ${escapeMrkdwn(error)}.${shareWith}`,
			);
			return { ...result, error };
		};

		if (!deps.sheets.ok) return failed(`no Google credential (${deps.sheets.error})`);
		const written = await deps.sheets.client.replaceTab({
			spreadsheetId,
			tabName: options.day,
			rows,
			ownedPrefix: REPORT_TITLE_PREFIX,
			columnWidths: REPORT_COLUMN_WIDTHS,
			deadline: Date.now() + SHEETS_BUDGET_MS,
		});
		if (!written.ok) {
			return failed(`Google answered ${written.status}: ${written.error}`, written.status !== 409);
		}
		result.written = true;

		if (options.announce) {
			const link =
				`https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}` +
				`/edit#gid=${written.value.sheetId}`;
			result.posted = await deps.post(reportSlackText(report, link));
		}
		return result;
	} catch (err) {
		return { ...result, error: errMessage(err) };
	}
}
