// Settings storage seam for the admin settings page (NAV-3 through NAV-9).
// One typed `loadSettings(db)` that reads the five settings tables, plus
// per-table setters that stamp the audit columns and log the action. The
// coalition channel map lives only in the DB (edited on /settings); the
// remaining fields fall back to env when their row(s) are absent.
//
// See specs/005-settings-storage-loader/contracts/settings-module.md for the
// full contract.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	zipExcludedChapters,
	channelWelcomeFlags,
	appConfig,
	infoCommands,
	vanChapterFolders,
	vanBlockedUsers,
} from './schema.js';
import {
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
	SLACK_ALLOWED_USER_IDS,
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_TRACKING_CHANNEL_ID,
	SLACK_GROWTH_REPORT_CHANNEL_ID,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
	MOBILIZE_CONTACT_NAME,
	MOBILIZE_CONTACT_EMAIL,
	MOBILIZE_CONTACT_PHONE,
} from './env.js';
import { clampTickerColumnsPerSecond } from '../ticker-speed.js';
import { resolveClaimOptions } from '../van/checkout.js';
import { invalidateThemeCache } from './theme.js';
import { invalidateSiteNameCache } from './site.js';

export {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	zipExcludedChapters,
	channelWelcomeFlags,
	appConfig,
	infoCommands,
	vanChapterFolders,
	vanBlockedUsers,
};

export type {
	ChapterChannelRow,
	NewChapterChannelRow,
	CoalitionChannelRow,
	NewCoalitionChannelRow,
	AllowedSlackUserRow,
	NewAllowedSlackUserRow,
	ExcludedChapterRow,
	NewExcludedChapterRow,
	AppConfigRow,
	NewAppConfigRow,
	InfoCommandRow,
	NewInfoCommandRow,
} from './schema.js';

type Database = ReturnType<typeof drizzle>;

export interface ChapterEntry {
	chapterId: number;
	channelId: string;
	name: string;
}

export interface CoalitionEntry {
	/** Solidarity custom-property internal_name; also the /coalition-invite webhook key. */
	group: string;
	channelId: string;
	/** Custom property display label ('' when unknown). */
	name: string;
	/** Solidarity user list mirroring the property; null when not configured. */
	userListId: number | null;
}

export interface InfoCommandEntry {
	/** Normalized: lowercase, leading slash (see normalizeCommandName). */
	command: string;
	/** Raw message with `#channel-name` tokens, resolved at post time. */
	message: string;
}

export interface Settings {
	chapterChannelMap: ChapterEntry[];
	coalitionChannelMap: CoalitionEntry[];
	allowedSlackUserIds: Set<string>;
	reportExcludedChapterIds: Set<number>;
	/** Chapters that may never win a zip in zip_chapter_map. Separate from
	 *  reportExcludedChapterIds on purpose — one decides what shows in the growth
	 *  report, the other decides where a zip resolves, and a superseded chapter
	 *  routinely needs the second without the first. DB-only, no env fallback. */
	zipExcludedChapterIds: Set<number>;
	/** Channels the bot should NOT post its channel welcome message in after
	 *  inviting a new member. Absent = welcome on (the default). DB-only. */
	welcomeDisabledChannelIds: Set<string>;
	slackTrackingChannelId: string;
	slackGrowthReportChannelId: string;
	/** Where the nightly Mobilize/attendee sync posts its alerts. Effective
	 *  value: the DB override when set, otherwise the resolved growth-report
	 *  channel — the channel these alerts used before the override existed.
	 *  DB-only override; it has no env var of its own. */
	slackMobilizeSyncChannelId: string;
	/** Where the VAN turf catalog sync and the geometry worker post their
	 *  alerts. Effective value: the DB override when set, otherwise the
	 *  resolved tracking channel — the channel these alerts used before the
	 *  override existed. DB-only override; it has no env var of its own. */
	slackTurfChannelId: string;
	/** Admin channel that gets a line whenever a member note or warning is
	 *  logged. DB-only with no env fallback; '' means "don't post", since
	 *  announcing moderation in the wrong channel is worse than not announcing
	 *  it at all. */
	slackMemberNoteChannelId: string;
	/** Contact published on events the sync creates in Mobilize. The v1 API
	 *  requires one on every create and update, and Solidarity events carry no
	 *  contact data, so this is the only source. DB override, falling back to
	 *  MOBILIZE_CONTACT_NAME / _EMAIL / _PHONE. */
	mobilizeContactName: string;
	mobilizeContactEmail: string;
	mobilizeContactPhone: string;
	slackGrowthReportRankingAlpha: number | undefined;
	/** Shown after each page's own name in the browser tab. DB-only with a code
	 *  default; '' means "use DEFAULT_SITE_NAME". */
	siteName: string;
	/** Header countdown. DB-only, no env fallback; '' means "not configured". */
	countdownLabel: string;
	/** ISO datetime the countdown ends at; '' means "no countdown". */
	countdownEndAt: string;
	/** New-member welcome DM template. DB-only; '' means "use the built-in
	 *  default" (renderWelcomeDm falls back). Stored raw with `{{channels}}`
	 *  and `#channel-name` tokens resolved at send time. */
	welcomeDmMessage: string;
	/** Template for the DM sent when an admin logs a warning. DB-only; ''
	 *  means "use the built-in default" (renderWarningDm falls back). Stored
	 *  raw with `{{nth}}`, `{{note}}`, `{{message_link}}` and `#channel-name`
	 *  tokens, all resolved at send time. */
	warningDmMessage: string;
	/** Admin-defined slash commands that post a canned blurb as the person who
	 *  ran them. DB-only; an empty list is the normal starting state. Sorted by
	 *  command name so /settings renders stably. */
	infoCommands: InfoCommandEntry[];
	/** Door-knock ticker scroll speed, in LED columns per second. DB-only;
	 *  always resolved to a usable number (see clampTickerColumnsPerSecond),
	 *  never undefined. */
	doorTickerColumnsPerSecond: number;
	/** Hours a turf claim lasts before it lapses. Resolved and clamped, so the
	 *  turf routes can use it without re-deciding what a NULL means. */
	vanTurfClaimTtlHours: number;
	/** Turfs one volunteer may hold at once. */
	vanTurfMaxConcurrentClaims: number;
}

export interface Editor {
	/** Slack user id (`U…`) or the SYSTEM_EDITOR sentinel `U0000000000`. */
	id: string;
	/** Display name captured at write time. */
	name: string;
}

export type AppConfigPatch = Partial<{
	slackTrackingChannelId: string;
	slackGrowthReportChannelId: string;
	slackMobilizeSyncChannelId: string;
	/** Where the VAN turf sync posts its alerts. Unset follows the tracking
	 *  channel. */
	slackTurfChannelId: string;
	/** Where member notes/warnings are announced. '' means "don't post". */
	slackMemberNoteChannelId: string;
	mobilizeContactName: string;
	mobilizeContactEmail: string;
	mobilizeContactPhone: string;
	slackGrowthReportRankingAlpha: number;
	siteName: string;
	countdownLabel: string;
	countdownEndAt: string;
	welcomeDmMessage: string;
	warningDmMessage: string;
	doorTickerColumnsPerSecond: number;
	vanTurfClaimTtlHours: number;
	vanTurfMaxConcurrentClaims: number;
	/** Theme overrides, serialised. One JSON column rather than ~60 colour
	 *  columns — see the comment on app_config.themeTokens in schema.ts.
	 *  Validated by themeTokensField before it ever reaches here. */
	themeTokens: string;
}>;

/** Sentinel editor for non-interactive writes (seed/backfill). Stays in the
 *  same Slack id shape (`^U[A-Z0-9]{10}$`) so generic id validators accept it
 *  without a carve-out. */
export const SYSTEM_EDITOR: Editor = { id: 'U0000000000', name: 'System' } as const;

export async function loadSettings(db: Database): Promise<Settings> {
	// Five parallel reads. The coalition map is DB-only — an empty table simply
	// means "nothing mapped" (a delete must stay deleted). The chapter map,
	// allowed-users, and excluded-chapters lists shadow the env list entirely
	// when non-empty (FR-012). The app_config singleton row falls back
	// per-field (FR-013): a NULL column means "use env for that field", while
	// a missing row means "use env for all three".
	const [
		chapterRows,
		coalitionRows,
		allowedRows,
		excludedRows,
		zipExcludedRows,
		welcomeRows,
		appConfigRows,
		infoCommandRows,
	] = await Promise.all([
		db.select().from(chapterChannelMap),
		db.select().from(coalitionChannelMap),
		db.select().from(allowedSlackUsers),
		db.select().from(reportExcludedChapters),
		db.select().from(zipExcludedChapters),
		db.select().from(channelWelcomeFlags),
		db.select().from(appConfig).limit(1),
		db.select().from(infoCommands),
	]);

	const chapterChannelMapField: ChapterEntry[] =
		chapterRows.length > 0
			? chapterRows.map((r) => ({ chapterId: r.chapterId, channelId: r.channelId, name: r.name }))
			: SOLIDARITY_CHAPTER_CHANNEL_MAP;

	const coalitionChannelMapField: CoalitionEntry[] = coalitionRows.map((r) => ({
		group: r.groupName,
		channelId: r.channelId,
		name: r.name,
		userListId: r.userListId,
	}));

	const allowedSlackUserIds: Set<string> =
		allowedRows.length > 0
			? new Set(allowedRows.map((r) => r.slackUserId))
			: SLACK_ALLOWED_USER_IDS;

	const reportExcludedChapterIds: Set<number> =
		excludedRows.length > 0
			? new Set(excludedRows.map((r) => r.chapterId))
			: REPORT_EXCLUDED_CHAPTER_IDS;

	// DB-only: an empty table means "exclude nothing", not "fall back to env".
	// There is no env list to inherit, and inventing one would give this the
	// report exclusions' seeding semantics — which are wrong here, since the two
	// answer different questions about the same chapter.
	const zipExcludedChapterIds: Set<number> = new Set(zipExcludedRows.map((r) => r.chapterId));

	// DB-only, like the coalition map: no env fallback. Only rows with the
	// flag off matter — a row toggled back on behaves like no row.
	const welcomeDisabledChannelIds: Set<string> = new Set(
		welcomeRows.filter((r) => !r.showWelcomeMessage).map((r) => r.channelId),
	);

	const cfg = appConfigRows[0];
	const slackTrackingChannelId = cfg?.slackTrackingChannelId ?? SLACK_TRACKING_CHANNEL_ID;
	const slackGrowthReportChannelId =
		cfg?.slackGrowthReportChannelId ?? SLACK_GROWTH_REPORT_CHANNEL_ID;
	// No env var of its own: an unset override keeps the sync alerts wherever
	// the growth report goes, which is exactly where they went before this
	// field existed. Resolving here means callers read one field and never have
	// to re-implement the chain.
	const slackMobilizeSyncChannelId = cfg?.slackMobilizeSyncChannelId ?? slackGrowthReportChannelId;
	// Same shape, different default: no env var, and an unset override leaves
	// the turf alerts in the tracking channel, where they posted before this
	// field existed.
	const slackTurfChannelId = cfg?.slackTurfChannelId ?? slackTrackingChannelId;
	// DB-only and no fallback: posting to the wrong channel is worse than not
	// posting, so this stays empty until an admin picks one.
	const slackMemberNoteChannelId = cfg?.slackMemberNoteChannelId ?? '';
	const mobilizeContactName = cfg?.mobilizeContactName ?? MOBILIZE_CONTACT_NAME;
	const mobilizeContactEmail = cfg?.mobilizeContactEmail ?? MOBILIZE_CONTACT_EMAIL;
	const mobilizeContactPhone = cfg?.mobilizeContactPhone ?? MOBILIZE_CONTACT_PHONE;
	const slackGrowthReportRankingAlpha =
		cfg?.slackGrowthReportRankingAlpha ?? SLACK_GROWTH_REPORT_RANKING_ALPHA;
	const siteName = cfg?.siteName ?? '';
	const countdownLabel = cfg?.countdownLabel ?? '';
	const countdownEndAt = cfg?.countdownEndAt ?? '';
	const welcomeDmMessage = cfg?.welcomeDmMessage ?? '';
	const warningDmMessage = cfg?.warningDmMessage ?? '';
	// DB-only with a code default rather than an env fallback — it's a display
	// preference, not deployment config. Clamped on read so a hand-edited row
	// can't hand the board an unusable rate.
	const doorTickerColumnsPerSecond = clampTickerColumnsPerSecond(cfg?.doorTickerColumnsPerSecond);
	// Clamped on read as well as on write: a row written before the bounds
	// existed, or edited by hand, must not hand a volunteer a one-minute claim.
	const claimOptions = resolveClaimOptions({
		ttlHours: cfg?.vanTurfClaimTtlHours,
		maxConcurrentClaims: cfg?.vanTurfMaxConcurrentClaims,
	});

	// Sorted here rather than in SQL so the order is part of the contract the
	// settings page and its tests can rely on.
	const infoCommandList: InfoCommandEntry[] = infoCommandRows
		.map((r) => ({ command: r.command, message: r.message }))
		.sort((a, b) => a.command.localeCompare(b.command));

	return {
		chapterChannelMap: chapterChannelMapField,
		coalitionChannelMap: coalitionChannelMapField,
		allowedSlackUserIds,
		reportExcludedChapterIds,
		zipExcludedChapterIds,
		welcomeDisabledChannelIds,
		slackTrackingChannelId,
		slackGrowthReportChannelId,
		slackMobilizeSyncChannelId,
		slackTurfChannelId,
		slackMemberNoteChannelId,
		mobilizeContactName,
		mobilizeContactEmail,
		mobilizeContactPhone,
		slackGrowthReportRankingAlpha,
		siteName,
		countdownLabel,
		countdownEndAt,
		welcomeDmMessage,
		warningDmMessage,
		infoCommands: infoCommandList,
		doorTickerColumnsPerSecond,
		vanTurfClaimTtlHours: claimOptions.ttlHours,
		vanTurfMaxConcurrentClaims: claimOptions.maxConcurrentClaims,
	};
}

/** Set whether the bot posts its channel welcome message in `channelId` after
 *  inviting a new member. Upserts a flag row either way — keeping the row on
 *  re-enable preserves the audit trail of who last touched the flag. */
export async function setChannelWelcomeFlag(
	db: Database,
	channelId: string,
	showWelcomeMessage: boolean,
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		channelId,
		showWelcomeMessage,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(channelWelcomeFlags)
		.values(row)
		.onConflictDoUpdate({
			target: channelWelcomeFlags.channelId,
			set: {
				showWelcomeMessage: row.showWelcomeMessage,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved channel_welcome_flags channel_id=${channelId} show=${showWelcomeMessage} by ${editor.id} (${editor.name})`,
	);
}

// Write path — multi-row tables. Each setter upserts in one round-trip via
// onConflictDoUpdate, stamps the three audit columns, and emits one [settings]
// log line (Constitution Principle V). Errors bubble — the calling HTTP endpoint
// (NAV-5+) owns failure logging because it has the request context.

/** Upsert one channel across many chapters in a single statement — the
 *  /settings multi-editor's "add a chip while N chapters are selected". */
export async function saveChapterChannelEntries(
	db: Database,
	chapters: { chapterId: number; name: string }[],
	channelId: string,
	editor: Editor,
): Promise<void> {
	if (chapters.length === 0) return;
	const lastEditedAt = new Date().toISOString();
	const rows = chapters.map((chapter) => ({
		chapterId: chapter.chapterId,
		channelId,
		name: chapter.name,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	}));
	await db
		.insert(chapterChannelMap)
		.values(rows)
		.onConflictDoUpdate({
			target: [chapterChannelMap.chapterId, chapterChannelMap.channelId],
			set: {
				// `excluded.*` so each conflicting row keeps its own name; the
				// audit columns are identical across the batch.
				name: sql`excluded.name`,
				lastEditedBy: editor.id,
				lastEditedByName: editor.name,
				lastEditedAt,
			},
		});
	console.log(
		`[settings] saved chapter_channel_map chapter_ids=[${chapters.map((c) => c.chapterId).join(', ')}] channel_id=${channelId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteChapterChannelEntries(
	db: Database,
	chapterIds: number[],
	channelId: string,
	editor: Editor,
): Promise<void> {
	if (chapterIds.length === 0) return;
	await db
		.delete(chapterChannelMap)
		.where(
			and(
				inArray(chapterChannelMap.chapterId, chapterIds),
				eq(chapterChannelMap.channelId, channelId),
			),
		);
	console.log(
		`[settings] deleted chapter_channel_map chapter_ids=[${chapterIds.join(', ')}] channel_id=${channelId} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into chapter_channel_map. The table
 * shadows SOLIDARITY_CHAPTER_CHANNEL_MAP *entirely* once it has any row
 * (FR-012), so the first interactive edit must not start from an empty table —
 * that would silently drop every env mapping except the one being edited.
 * Callers invoke this before the first write; no-op when the table already has
 * rows or the env map is empty. Seed rows are attributed to SYSTEM_EDITOR.
 * The check-then-insert is not atomic, so the insert uses onConflictDoNothing:
 * two concurrent first edits may both pass the emptiness check, but the loser
 * then no-ops per row instead of tripping the composite PK.
 */
export async function ensureChapterChannelMapSeeded(db: Database): Promise<void> {
	const existing = await db
		.select({ chapterId: chapterChannelMap.chapterId })
		.from(chapterChannelMap)
		.limit(1);
	if (existing.length > 0 || SOLIDARITY_CHAPTER_CHANNEL_MAP.length === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(chapterChannelMap)
		.values(
			SOLIDARITY_CHAPTER_CHANNEL_MAP.map((e) => ({
				chapterId: e.chapterId,
				channelId: e.channelId,
				name: e.name,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded chapter_channel_map with ${SOLIDARITY_CHAPTER_CHANNEL_MAP.length} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveCoalitionEntry(
	db: Database,
	entry: { group: string; channelId: string; name: string; userListId: number | null },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		groupName: entry.group,
		channelId: entry.channelId,
		name: entry.name,
		userListId: entry.userListId,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(coalitionChannelMap)
		.values(row)
		.onConflictDoUpdate({
			target: coalitionChannelMap.groupName,
			set: {
				channelId: row.channelId,
				name: row.name,
				userListId: row.userListId,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved coalition_channel_map group_name=${entry.group} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteCoalitionEntry(
	db: Database,
	group: string,
	editor: Editor,
): Promise<void> {
	await db.delete(coalitionChannelMap).where(eq(coalitionChannelMap.groupName, group));
	console.log(
		`[settings] deleted coalition_channel_map group_name=${group} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into allowed_slack_users — same rationale
 * and concurrency posture as ensureChapterChannelMapSeeded above: the table
 * shadows SLACK_ALLOWED_USER_IDS entirely once it has any row, so the first
 * interactive edit must inherit the env list instead of silently dropping
 * every admin except the one being edited. `displayNames` (from the cached
 * Slack user list, when available) makes seed rows human-readable; ids without
 * a known name fall back to the raw id.
 */
export async function ensureAllowedUsersSeeded(
	db: Database,
	displayNames?: ReadonlyMap<string, string>,
): Promise<void> {
	const existing = await db
		.select({ slackUserId: allowedSlackUsers.slackUserId })
		.from(allowedSlackUsers)
		.limit(1);
	if (existing.length > 0 || SLACK_ALLOWED_USER_IDS.size === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(allowedSlackUsers)
		.values(
			[...SLACK_ALLOWED_USER_IDS].map((id) => ({
				slackUserId: id,
				displayName: displayNames?.get(id) ?? id,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded allowed_slack_users with ${SLACK_ALLOWED_USER_IDS.size} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveAllowedUser(
	db: Database,
	entry: { slackUserId: string; displayName: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		slackUserId: entry.slackUserId,
		displayName: entry.displayName,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(allowedSlackUsers)
		.values(row)
		.onConflictDoUpdate({
			target: allowedSlackUsers.slackUserId,
			set: {
				displayName: row.displayName,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved allowed_slack_users slack_user_id=${entry.slackUserId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteAllowedUser(
	db: Database,
	slackUserId: string,
	editor: Editor,
): Promise<void> {
	await db.delete(allowedSlackUsers).where(eq(allowedSlackUsers.slackUserId, slackUserId));
	console.log(
		`[settings] deleted allowed_slack_users slack_user_id=${slackUserId} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into report_excluded_chapters — same
 * rationale and concurrency posture as the other ensure*Seeded helpers: the
 * table shadows REPORT_EXCLUDED_CHAPTER_IDS entirely once it has any row, so
 * the first interactive edit must inherit the env list. Env entries carry no
 * reason, so seed rows get reason NULL.
 */
export async function ensureExcludedChaptersSeeded(db: Database): Promise<void> {
	const existing = await db
		.select({ chapterId: reportExcludedChapters.chapterId })
		.from(reportExcludedChapters)
		.limit(1);
	if (existing.length > 0 || REPORT_EXCLUDED_CHAPTER_IDS.size === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(reportExcludedChapters)
		.values(
			[...REPORT_EXCLUDED_CHAPTER_IDS].map((chapterId) => ({
				chapterId,
				reason: null,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded report_excluded_chapters with ${REPORT_EXCLUDED_CHAPTER_IDS.size} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveExcludedChapter(
	db: Database,
	entry: { chapterId: number; reason?: string | null },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		chapterId: entry.chapterId,
		reason: entry.reason ?? null,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(reportExcludedChapters)
		.values(row)
		.onConflictDoUpdate({
			target: reportExcludedChapters.chapterId,
			set: {
				reason: row.reason,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved report_excluded_chapters chapter_id=${entry.chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteExcludedChapter(
	db: Database,
	chapterId: number,
	editor: Editor,
): Promise<void> {
	await db.delete(reportExcludedChapters).where(eq(reportExcludedChapters.chapterId, chapterId));
	console.log(
		`[settings] deleted report_excluded_chapters chapter_id=${chapterId} by ${editor.id} (${editor.name})`,
	);
}

/**
 * Exclude a chapter from ever winning a zip.
 *
 * No ensure*Seeded companion, unlike the report exclusions: that helper exists to
 * copy an env list into the table before the first interactive edit, and this
 * setting has no env list to inherit. An empty table means nothing is excluded.
 *
 * Takes effect on the next zip map rebuild rather than immediately — the map is
 * a derived table refreshed on staleness, so a chapter excluded now still holds
 * its zips until the attendee sync next walks the membership.
 */
export async function saveZipExcludedChapter(
	db: Database,
	entry: { chapterId: number; reason?: string | null },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		chapterId: entry.chapterId,
		reason: entry.reason ?? null,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(zipExcludedChapters)
		.values(row)
		.onConflictDoUpdate({
			target: zipExcludedChapters.chapterId,
			set: {
				reason: row.reason,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved zip_excluded_chapters chapter_id=${entry.chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteZipExcludedChapter(
	db: Database,
	chapterId: number,
	editor: Editor,
): Promise<void> {
	await db.delete(zipExcludedChapters).where(eq(zipExcludedChapters.chapterId, chapterId));
	console.log(
		`[settings] deleted zip_excluded_chapters chapter_id=${chapterId} by ${editor.id} (${editor.name})`,
	);
}

// Write path — app-config singleton. Set-only contract: an undefined or null
// patch value is treated as ABSENT (kept), not as a NULL write. Unspecified
// fields are preserved across the upsert because they don't appear in the `set`
// clause (FR-019). Unknown patch keys throw synchronously — last-line defense
// for the HTTP endpoint that's expected to validate first.

const APP_CONFIG_ALLOWED_KEYS = new Set<keyof AppConfigPatch>([
	'slackTrackingChannelId',
	'slackGrowthReportChannelId',
	'slackMobilizeSyncChannelId',
	'slackTurfChannelId',
	'slackMemberNoteChannelId',
	'mobilizeContactName',
	'mobilizeContactEmail',
	'mobilizeContactPhone',
	'slackGrowthReportRankingAlpha',
	'siteName',
	'countdownLabel',
	'countdownEndAt',
	'welcomeDmMessage',
	'warningDmMessage',
	'doorTickerColumnsPerSecond',
	'vanTurfClaimTtlHours',
	'vanTurfMaxConcurrentClaims',
	'themeTokens',
]);

export async function saveAppConfig(
	db: Database,
	patch: AppConfigPatch,
	editor: Editor,
): Promise<void> {
	for (const key of Object.keys(patch) as (keyof AppConfigPatch)[]) {
		if (!APP_CONFIG_ALLOWED_KEYS.has(key)) {
			throw new Error(`saveAppConfig: unknown patch key "${key}"`);
		}
	}

	// null and undefined both mean "leave as-is" — strip both before composing
	// the values payload and the on-conflict set clause.
	const definedFields: Record<string, string | number> = {};
	for (const key of APP_CONFIG_ALLOWED_KEYS) {
		const v = patch[key];
		if (v !== undefined && v !== null) {
			definedFields[key] = v;
		}
	}

	const lastEditedAt = new Date().toISOString();
	const values = {
		id: 1,
		...definedFields,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	const set: Record<string, string | number> = {
		...definedFields,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};

	await db.insert(appConfig).values(values).onConflictDoUpdate({ target: appConfig.id, set });

	// A theme write must take effect on the next render, not when the cache TTL
	// lapses — an admin who saves a colour and sees no change assumes it failed.
	if ('themeTokens' in definedFields) invalidateThemeCache();
	if ('siteName' in definedFields) invalidateSiteNameCache();

	const keysSummary = Object.keys(definedFields).join(',');
	console.log(`[settings] saved app_config patch=${keysSummary} by ${editor.id} (${editor.name})`);
}

/**
 * Create or update one admin-defined info command.
 *
 * `command` must already be normalized (see normalizeCommandName) — the API
 * route does that as part of validating it, and the primary key depends on it.
 * Upsert rather than insert so editing a blurb reuses the row and keeps the
 * audit columns pointing at whoever last touched it.
 */
export async function saveInfoCommand(
	db: Database,
	entry: { command: string; message: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		command: entry.command,
		message: entry.message,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(infoCommands)
		.values(row)
		.onConflictDoUpdate({
			target: infoCommands.command,
			set: {
				message: row.message,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved info_commands command=${entry.command} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteInfoCommand(
	db: Database,
	command: string,
	editor: Editor,
): Promise<void> {
	await db.delete(infoCommands).where(eq(infoCommands.command, command));
	console.log(
		`[settings] deleted info_commands command=${command} by ${editor.id} (${editor.name})`,
	);
}

/**
 * Look up one command by its normalized name.
 *
 * Separate from loadSettings because the Slack command route runs on a 3-second
 * budget and has no use for the other five settings tables.
 */
export async function findInfoCommand(
	db: Database,
	command: string,
): Promise<InfoCommandEntry | null> {
	const rows = await db
		.select({ command: infoCommands.command, message: infoCommands.message })
		.from(infoCommands)
		.where(eq(infoCommands.command, command))
		.limit(1);
	return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// VAN turf checkout settings (specs/010-van-turf-checkout/plan.md, Story 7.4)
//
// Kept out of loadSettings deliberately. The blocked set is read on EVERY turf
// page load and every claim/release call — the hottest read in the feature —
// while loadSettings pulls seven tables for an admin page nobody visits often.
// Two narrow loaders beat one wide one here.
// ---------------------------------------------------------------------------

export interface VanChapterFolderEntry {
	chapterId: number;
	chapterName: string;
	/** VAN folder ids whose Map Regions belong to this chapter. A county cut in
	 *  pieces has several. */
	folderIds: number[];
}

export interface VanBlockedUserEntry {
	slackUserId: string;
	displayName: string;
	reason: string;
	lastEditedByName: string;
	lastEditedAt: string;
}

/** Chapter → VAN folder mapping, grouped by chapter and sorted by name so
 *  /settings renders stably. This is an INPUT to the catalog sync: a chapter
 *  absent here has no turf, and the sync is a no-op until an admin fills it in. */
export async function loadVanChapterFolders(db: Database): Promise<VanChapterFolderEntry[]> {
	const rows = await db.select().from(vanChapterFolders);
	const byChapter = new Map<number, VanChapterFolderEntry>();
	for (const row of rows) {
		const existing = byChapter.get(row.chapterId);
		if (existing) {
			existing.folderIds.push(row.folderId);
			continue;
		}
		byChapter.set(row.chapterId, {
			chapterId: row.chapterId,
			chapterName: row.chapterName,
			folderIds: [row.folderId],
		});
	}
	const entries = [...byChapter.values()];
	for (const entry of entries) entry.folderIds.sort((a, b) => a - b);
	entries.sort((a, b) => a.chapterName.localeCompare(b.chapterName));
	return entries;
}

/** Just the ids, for the turf read path's access gate. */
export async function loadVanBlockedIds(db: Database): Promise<Set<string>> {
	const rows = await db.select({ slackUserId: vanBlockedUsers.slackUserId }).from(vanBlockedUsers);
	return new Set(rows.map((r) => r.slackUserId));
}

/** Full rows, for the /settings editor. */
export async function loadVanBlockedUsers(db: Database): Promise<VanBlockedUserEntry[]> {
	const rows = await db.select().from(vanBlockedUsers);
	return rows
		.map((row) => ({
			slackUserId: row.slackUserId,
			displayName: row.displayName,
			reason: row.reason ?? '',
			lastEditedByName: row.lastEditedByName,
			lastEditedAt: row.lastEditedAt,
		}))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Replace one chapter's folder list wholesale.
 *
 * Delete-then-insert rather than a diff: the editor always submits the full
 * set for a chapter, the rows are tiny, and a partial failure that leaves a
 * chapter pointing at half its folders would silently hide turf. An empty
 * `folderIds` removes the chapter's mapping entirely, which is how an admin
 * says "this chapter has no turf".
 */
export async function saveVanChapterFolders(
	db: Database,
	entry: { chapterId: number; chapterName: string; folderIds: readonly number[] },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	await db.delete(vanChapterFolders).where(eq(vanChapterFolders.chapterId, entry.chapterId));

	const unique = [...new Set(entry.folderIds)];
	if (unique.length > 0) {
		await db.insert(vanChapterFolders).values(
			unique.map((folderId) => ({
				chapterId: entry.chapterId,
				folderId,
				chapterName: entry.chapterName,
				lastEditedBy: editor.id,
				lastEditedByName: editor.name,
				lastEditedAt,
			})),
		);
	}
	console.log(
		`[van] saved van_chapter_folders chapter_id=${entry.chapterId} folders=${unique.join(',') || '(none)'} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteVanChapterFolders(
	db: Database,
	chapterId: number,
	editor: Editor,
): Promise<void> {
	await db.delete(vanChapterFolders).where(eq(vanChapterFolders.chapterId, chapterId));
	console.log(
		`[van] deleted van_chapter_folders chapter_id=${chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function saveVanBlockedUser(
	db: Database,
	entry: { slackUserId: string; displayName: string; reason: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		slackUserId: entry.slackUserId,
		displayName: entry.displayName,
		reason: entry.reason.trim() === '' ? null : entry.reason.trim(),
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(vanBlockedUsers)
		.values(row)
		.onConflictDoUpdate({
			target: vanBlockedUsers.slackUserId,
			set: {
				displayName: row.displayName,
				reason: row.reason,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(`[van] blocked slack_user_id=${entry.slackUserId} by ${editor.id} (${editor.name})`);
}

export async function deleteVanBlockedUser(
	db: Database,
	slackUserId: string,
	editor: Editor,
): Promise<void> {
	await db.delete(vanBlockedUsers).where(eq(vanBlockedUsers.slackUserId, slackUserId));
	console.log(`[van] unblocked slack_user_id=${slackUserId} by ${editor.id} (${editor.name})`);
}
