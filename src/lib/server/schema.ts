import {
	sqliteTable,
	text,
	integer,
	real,
	blob,
	index,
	uniqueIndex,
	primaryKey,
	check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const requests = sqliteTable('requests', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').unique(),
	name: text('name'),
	phone: text('phone'),
	comment: text('comment'),
	requestedAt: text('requested_at').notNull(),
	lastEditedById: text('last_edited_by_id'),
	lastEditedByName: text('last_edited_by_name'),
	status: text('status').notNull().default('uncontacted'),
});

export const sessions = sqliteTable('sessions', {
	sid: text('sid').primaryKey(),
	data: text('data').notNull(),
	expiresAt: text('expires_at').notNull(),
});

export const slackJoins = sqliteTable(
	'slack_joins',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slackUserId: text('slack_user_id').notNull(),
		email: text('email'),
		joinedAt: text('joined_at'),
		chapterIds: text('chapter_ids').notNull().default('[]'),
	},
	(table) => [uniqueIndex('slack_joins_slack_user_id_unique').on(table.slackUserId)],
);

export const solidarityDailySnapshots = sqliteTable(
	'solidarity_daily_snapshots',
	{
		date: text('date').notNull(),
		chapterId: integer('chapter_id').notNull().default(-1),
		chapterName: text('chapter_name'),
		count: integer('count').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.chapterId] })],
);

// Per-window leaderboard snapshot written by the Monday cron. Preserves the
// num_members count from conversations.info at compute time so the dashboard
// keeps showing a stable Mon-to-Mon leaderboard instead of drifting against a
// growing live num_members.
export const weeklyGrowthWindows = sqliteTable('weekly_growth_windows', {
	windowEnd: text('window_end').primaryKey(),
	windowStart: text('window_start').notNull(),
	totalNewJoins: integer('total_new_joins').notNull(),
	computedAt: text('computed_at').notNull(),
});

export const weeklyChapterGrowth = sqliteTable(
	'weekly_chapter_growth',
	{
		windowEnd: text('window_end').notNull(),
		chapterId: integer('chapter_id').notNull(),
		chapterName: text('chapter_name').notNull(),
		slackChannelId: text('slack_channel_id'),
		newJoins: integer('new_joins').notNull(),
		existing: integer('existing').notNull(),
		// Raw num_members reported by Slack at compute time, before subtracting
		// newJoins to derive `existing`. Kept for auditing.
		numMembers: integer('num_members'),
	},
	(table) => [primaryKey({ columns: [table.windowEnd, table.chapterId] })],
);

// Settings tables (NAV-1). Each table carries audit columns enforced .notNull()
// so writes can never lose attribution. The `app_config` singleton is enforced
// via the natural PK collision plus a redundant CHECK (id = 1) for defense in
// depth and to document intent in the generated migration SQL.

// Composite (chapter_id, channel_id) key: a chapter may map to any number of
// Slack channels, and new joiners are invited to every mapped channel.
export const chapterChannelMap = sqliteTable(
	'chapter_channel_map',
	{
		chapterId: integer('chapter_id').notNull(),
		channelId: text('channel_id').notNull(),
		name: text('name').notNull(),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.chapterId, table.channelId] })],
);

// A coalition row ties together the three identities one coalition has:
// `group_name` is the Solidarity custom-property internal_name (also the key
// the /coalition-invite webhook receives), `name` is the property's display
// label, `user_list_id` is the Solidarity user list that mirrors the property
// (the fast membership read path for reconciliation; nullable because
// pre-existing rows don't have one).
export const coalitionChannelMap = sqliteTable('coalition_channel_map', {
	groupName: text('group_name').primaryKey(),
	channelId: text('channel_id').notNull(),
	name: text('name').notNull().default(''),
	userListId: integer('user_list_id'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

export const allowedSlackUsers = sqliteTable('allowed_slack_users', {
	slackUserId: text('slack_user_id').primaryKey(),
	displayName: text('display_name').notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// Moderators: people who may use the app's Slack commands and shortcuts
// (/member-note, the info commands, the member-record shortcut) and read the
// /members page it links to — and nothing else. Deliberately a separate table
// rather than a role column on allowed_slack_users: every `isAdmin` check in
// the app keeps meaning exactly what it did, and a moderator can only ever gain
// what the handful of places that read this table grant.
//
// DB-only, unlike the admin list: there is no env fallback and no seeding.
export const slackModerators = sqliteTable('slack_moderators', {
	slackUserId: text('slack_user_id').primaryKey(),
	displayName: text('display_name').notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

export const reportExcludedChapters = sqliteTable('report_excluded_chapters', {
	chapterId: integer('chapter_id').primaryKey(),
	reason: text('reason'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// Chapters that may never win a zip in zip_chapter_map.
//
// Deliberately NOT report_excluded_chapters reused: that table decides who
// appears in the growth report, this one decides where a zip resolves, and a
// chapter can legitimately need one without the other. The case that created
// this table is a superseded statewide chapter — still real, still holding
// members, so it belongs in reports — whose leftover membership was out-voting
// the county chapters carved out of it in every zip where those counties are
// thin.
//
// Applied when the tally is built rather than after a winner is picked, so an
// excluded chapter's members do not suppress the zip entirely: the runner-up
// wins it instead. See buildZipChapterMap.
export const zipExcludedChapters = sqliteTable('zip_excluded_chapters', {
	chapterId: integer('chapter_id').primaryKey(),
	reason: text('reason'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// Chapters left out of the /turfs chapter pickers — the web page and the Slack
// command. The pickers otherwise list every chapter in chapter_channel_map, and
// that map is also the auto-invite mapping, the dashboard and the growth report:
// hiding a chapter from turf there would cost it its Slack channels. Row present
// means hidden, so the default — an empty table — shows every chapter, and a
// chapter added to the map later is shown without a second setting. The
// organizer and activity pages, being admin-only, still list it.
export const turfHiddenChapters = sqliteTable('turf_hidden_chapters', {
	chapterId: integer('chapter_id').primaryKey(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// Per-channel team_join behavior: whether the bot posts its "everybody
// welcome @X" message in the channel after inviting a new member. Row absent
// means the default (show the welcome message), so only channels an admin has
// toggled carry a row. Toggled from the chapter ↔ channel chips on /settings.
export const channelWelcomeFlags = sqliteTable('channel_welcome_flags', {
	channelId: text('channel_id').primaryKey(),
	showWelcomeMessage: integer('show_welcome_message', { mode: 'boolean' }).notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// ---------------------------------------------------------------------------
// Openfield-era door-knock tables: DORMANT, and deliberately still declared.
//
// Openfield was retired with plan.md Story 9 — the canvassing board now reads
// the VAN turf checkout ledger (van/doors-store.ts), and nothing writes or
// reads the five tables below any more. They stay in the schema because the
// tables still exist in the database and hold the campaign's door-knock
// history; deleting the declarations would have drizzle-kit generate a DROP
// TABLE and take that history with it.
//
// Their numbers are NOT comparable with the new board's. These count doors
// KNOCKED (attempts, including not-homes) as reported by Openfield, stamped in
// Openfield's own Pacific rollover zone. The VAN board counts doors CLEARED, in
// campaign-local days. Anything that reads both is measuring two different
// things — see plan.md 9.9 for why the series starts fresh instead.
// ---------------------------------------------------------------------------

// One row per (date, turf code): the turf's total door-knock attempts/contacts
// for that day, captured by the nightly snapshot. `code` was an Openfield
// conversation code and `chapter_name` the chapter its "Conversation Codes"
// Slack canvas attributed it to at snapshot time.
export const doorKnockDaily = sqliteTable(
	'door_knock_daily',
	{
		date: text('date').notNull(),
		code: text('code').notNull(),
		chapterName: text('chapter_name').notNull(),
		attempts: integer('attempts').notNull().default(0),
		contacts: integer('contacts').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.code] })],
);

// One row per (date, code, canvasser): an individual's door-knock attempts on
// that turf for that day. Providers already break their totals down per
// canvasser — door_knock_daily throws that detail away, so this table keeps it
// for the dashboard's daily personal ticker.
//
// Keyed by code as well as canvasser (rather than pre-summing per person)
// because the snapshot writes code by code and upserts; a mid-day re-run then
// overwrites exactly the rows it rewrote, the same contract door_knock_daily
// has. Summing across codes is the reader's job — one person can canvass under
// several codes in a day.
export const doorKnockCanvasserDaily = sqliteTable(
	'door_knock_canvasser_daily',
	{
		date: text('date').notNull(),
		code: text('code').notNull(),
		/** The provider's display name for the canvasser, trimmed. */
		canvasser: text('canvasser').notNull(),
		/** Chapter the code belonged to that day, denormalised from the canvas
		 *  the same way door_knock_daily stores it — so the ticker can name a
		 *  canvasser's region without joining back on (date, code). Defaulted
		 *  because it was added after the table; every row the snapshot writes
		 *  sets it. */
		chapterName: text('chapter_name').notNull().default(''),
		attempts: integer('attempts').notNull().default(0),
		contacts: integer('contacts').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.code, table.canvasser] })],
);

// Openfield provider only. Cache of conversation code → Openfield numeric
// conversation id. Resolving a code costs a POST to /codes/, so each code is
// resolved once and reused.
export const doorKnockCodeIds = sqliteTable('door_knock_code_ids', {
	code: text('code').primaryKey(),
	conversationId: integer('conversation_id').notNull(),
	resolvedAt: text('resolved_at').notNull(),
});

// Openfield provider only. Nightly archive of the "Conversation Codes" canvas
// HTML (~30 KB/night) — Slack has no canvas version-history API, so this is
// our own record of what the canvas said on each date. One row per date; a
// re-run the same evening overwrites with the fresher copy.
export const doorKnockCanvasArchive = sqliteTable('door_knock_canvas_archive', {
	date: text('date').primaryKey(),
	html: text('html').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});

// Singleton row recording the last door-knock snapshot ATTEMPT, so dashboard
// visits can re-run the snapshot at most once every DOOR_KNOCK_REFRESH_MS
// (see door-knock-refresh.ts). Stamped at claim time — before the snapshot
// runs — so a failing provider/Slack call throttles the retry the same as a
// success instead of letting every page view start a new attempt.
export const doorKnockRefresh = sqliteTable(
	'door_knock_refresh',
	{
		id: integer('id').primaryKey(),
		/** ISO timestamp the attempt was claimed. */
		startedAt: text('started_at').notNull(),
		/** ISO timestamp the attempt settled; NULL while one is in flight. */
		finishedAt: text('finished_at'),
		ok: integer('ok', { mode: 'boolean' }),
		/** Error message of the last failed attempt, for debugging. */
		error: text('error'),
	},
	(table) => [check('door_knock_refresh_singleton', sql`${table.id} = 1`)],
);

export const appConfig = sqliteTable(
	'app_config',
	{
		id: integer('id').primaryKey(),
		slackTrackingChannelId: text('slack_tracking_channel_id'),
		slackGrowthReportChannelId: text('slack_growth_report_channel_id'),
		slackGrowthReportRankingAlpha: real('slack_growth_report_ranking_alpha'),
		// Where the nightly Mobilize/attendee sync posts its alerts. NULL means
		// "wherever the growth report goes" — the fallback these alerts had
		// before this column existed. No env var of its own.
		slackMobilizeSyncChannelId: text('slack_mobilize_sync_channel_id'),
		// Where the VAN turf catalog sync and the geometry worker post their
		// alerts. NULL means "wherever the volunteer-help tracking channel
		// points" — the fallback these alerts had before this column existed. No
		// env var of its own.
		slackTurfChannelId: text('slack_turf_channel_id'),
		// Admin channel that gets a line every time a member note or warning is
		// logged, so moderation stays visible to the whole admin group rather
		// than only to whoever filed it. NULL means "don't post" — the feature
		// is opt-in, and an unconfigured channel must not be an error path.
		slackMemberNoteChannelId: text('slack_member_note_channel_id'),
		// Contact published on events the sync creates in Mobilize. The v1 API
		// requires a contact on every create and update, and Solidarity events
		// carry none, so it is configured here. NULL falls back to
		// MOBILIZE_CONTACT_NAME / _EMAIL / _PHONE.
		mobilizeContactName: text('mobilize_contact_name'),
		mobilizeContactEmail: text('mobilize_contact_email'),
		mobilizeContactPhone: text('mobilize_contact_phone'),
		// Partner-org import: events in the partner's Mobilize org carrying this
		// tag are copied into Solidarity. NULL / '' means the import is off. No
		// env fallback — it is the switch an organizer flips, not deploy config.
		mobilizeImportTag: text('mobilize_import_tag'),
		// Header countdown (label + ISO end datetime). DB-only, no env fallback;
		// '' means "not configured" (the set-only save contract reserves NULL for
		// "use the fallback", so clearing writes '' rather than NULL).
		// Shown in the browser tab after each page's own name, and as the header
		// title fallback. DB-only with a code default (DEFAULT_SITE_NAME) rather
		// than an env fallback — it is a display preference, not deployment
		// config, same reasoning as the ticker speed.
		siteName: text('site_name'),
		countdownLabel: text('countdown_label'),
		countdownEndAt: text('countdown_end_at'),
		// New-member welcome DM template. NULL / '' means "use the built-in
		// default" (see DEFAULT_WELCOME_DM). Stored raw with `{{channels}}` and
		// friendly `#channel-name` tokens; resolution happens at send time.
		welcomeDmMessage: text('welcome_dm_message'),
		// Template for the DM a member receives when an admin logs a warning
		// against them. NULL / '' means "use the built-in default" (see
		// DEFAULT_WARNING_DM). Stored raw with `{{nth}}`, `{{note}}`,
		// `{{message_link}}` and friendly `#channel-name` tokens; all resolved at
		// send time. An admin can also override the text per-warning in the Slack
		// modal without changing this template.
		warningDmMessage: text('warning_dm_message'),
		// Door-knock ticker scroll speed in LED columns per second. DB-only,
		// no env fallback; NULL means DEFAULT_TICKER_COLUMNS_PER_SECOND.
		doorTickerColumnsPerSecond: real('door_ticker_columns_per_second'),
		// Turf checkout tunables (Story 7.4). DB-only, no env fallback; NULL means
		// the built-in default in $lib/van/checkout.ts. Bounds are enforced on
		// write by app-config-fields.ts and clamped again on read by
		// resolveClaimOptions, because a row written before the bounds existed
		// must degrade to something sane rather than hand a volunteer a claim
		// that lapses in a minute.
		vanTurfClaimTtlHours: integer('van_turf_claim_ttl_hours'),
		vanTurfMaxConcurrentClaims: integer('van_turf_max_concurrent_claims'),
		// Hours a turf handed out in VAN stays out of the pool (vanAssignmentBlocks
		// in turf-view.ts). Same NULL-means-default and clamp-on-read as the two
		// above.
		vanAssignmentTtlHours: integer('van_assignment_ttl_hours'),
		// Theme overrides as JSON: {"color-bg":{"light":"#fbf0e4"}}. One column
		// rather than ~60, because adding a field to this table is a nine-step
		// checklist across six files and a palette would be unmaintainable that
		// way. NULL or '{}' means "all brand defaults". Validated on write and
		// again on read (src/lib/styles/theme-css.ts) — a corrupt blob degrades
		// to defaults rather than taking the site's styling down.
		themeTokens: text('theme_tokens'),
		// Where the signed-out /turfs page's "Join our chat" button goes — the
		// Solidarity sign-up page that gets someone into the Slack. DB-only, no
		// env fallback; NULL or '' hides the button rather than showing a dead
		// link.
		publicJoinUrl: text('public_join_url'),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [check('app_config_singleton', sql`${table.id} = 1`)],
);

export type Request = typeof requests.$inferSelect;
export type NewRequest = typeof requests.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type SlackJoin = typeof slackJoins.$inferSelect;
export type NewSlackJoin = typeof slackJoins.$inferInsert;

export type SolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferSelect;
export type NewSolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferInsert;

export type WeeklyGrowthWindow = typeof weeklyGrowthWindows.$inferSelect;
export type NewWeeklyGrowthWindow = typeof weeklyGrowthWindows.$inferInsert;

export type WeeklyChapterGrowthRow = typeof weeklyChapterGrowth.$inferSelect;
export type NewWeeklyChapterGrowthRow = typeof weeklyChapterGrowth.$inferInsert;

export type ChapterChannelRow = typeof chapterChannelMap.$inferSelect;
export type NewChapterChannelRow = typeof chapterChannelMap.$inferInsert;

export type CoalitionChannelRow = typeof coalitionChannelMap.$inferSelect;
export type NewCoalitionChannelRow = typeof coalitionChannelMap.$inferInsert;

export type AllowedSlackUserRow = typeof allowedSlackUsers.$inferSelect;
export type NewAllowedSlackUserRow = typeof allowedSlackUsers.$inferInsert;

export type ExcludedChapterRow = typeof reportExcludedChapters.$inferSelect;
export type NewExcludedChapterRow = typeof reportExcludedChapters.$inferInsert;
export type ZipExcludedChapterRow = typeof zipExcludedChapters.$inferSelect;
export type TurfHiddenChapterRow = typeof turfHiddenChapters.$inferSelect;
export type NewZipExcludedChapterRow = typeof zipExcludedChapters.$inferInsert;

export type ChannelWelcomeFlagRow = typeof channelWelcomeFlags.$inferSelect;
export type NewChannelWelcomeFlagRow = typeof channelWelcomeFlags.$inferInsert;

export type AppConfigRow = typeof appConfig.$inferSelect;
export type NewAppConfigRow = typeof appConfig.$inferInsert;

export type DoorKnockDailyRow = typeof doorKnockDaily.$inferSelect;
export type NewDoorKnockDailyRow = typeof doorKnockDaily.$inferInsert;

export type DoorKnockCanvasserDailyRow = typeof doorKnockCanvasserDaily.$inferSelect;
export type NewDoorKnockCanvasserDailyRow = typeof doorKnockCanvasserDaily.$inferInsert;

export type DoorKnockCodeIdRow = typeof doorKnockCodeIds.$inferSelect;
export type NewDoorKnockCodeIdRow = typeof doorKnockCodeIds.$inferInsert;

export type DoorKnockCanvasArchiveRow = typeof doorKnockCanvasArchive.$inferSelect;
export type NewDoorKnockCanvasArchiveRow = typeof doorKnockCanvasArchive.$inferInsert;

export type DoorKnockRefreshRow = typeof doorKnockRefresh.$inferSelect;
export type NewDoorKnockRefreshRow = typeof doorKnockRefresh.$inferInsert;

// Ledger for the nightly Solidarity -> Mobilize event sync. Mobilize has no
// public write API and no way to tag an event with its Solidarity origin, so
// this mapping is the only reliable record of what we created — without it a
// re-run would publish duplicate events volunteers could sign up for.
export const mobilizeSyncedEvents = sqliteTable('mobilize_synced_events', {
	// `solidarity:<eventId>:<location>` — one Solidarity event can span several
	// locations and therefore several Mobilize events.
	key: text('key').primaryKey(),
	mobilizeEventId: integer('mobilize_event_id').notNull(),
	title: text('title').notNull(),
	createdAt: text('created_at').notNull(),
	lastSyncedAt: text('last_synced_at'),
});

// Solidarity image URL -> the copy re-hosted in Mobilize's bucket. Keyed by
// source so an image shared across events uploads once.
export const mobilizeSyncedImages = sqliteTable('mobilize_synced_images', {
	sourceUrl: text('source_url').primaryKey(),
	mobilizeUrl: text('mobilize_url').notNull(),
	uploadedAt: text('uploaded_at').notNull(),
});

// Venue coordinates -> postal code. `postal_code` is the one location field
// Mobilize requires and a third of Solidarity's sessions have no zip anywhere in
// them, so it is geocoded from the coordinates they do carry. Cached because a
// venue's zip never changes and the campaign runs the same offices all season.
export const mobilizeGeocodedZips = sqliteTable('mobilize_geocoded_zips', {
	// "42.98372,-83.67487" — see pointKey() in mobilize-migrator/lib/geocode.ts.
	point: text('point').primaryKey(),
	postalCode: text('postal_code').notNull(),
	lookedUpAt: text('looked_up_at').notNull(),
});

export type MobilizeGeocodedZipRow = typeof mobilizeGeocodedZips.$inferSelect;
export type NewMobilizeGeocodedZipRow = typeof mobilizeGeocodedZips.$inferInsert;

export type MobilizeSyncedEventRow = typeof mobilizeSyncedEvents.$inferSelect;
export type NewMobilizeSyncedEventRow = typeof mobilizeSyncedEvents.$inferInsert;

export type MobilizeSyncedImageRow = typeof mobilizeSyncedImages.$inferSelect;
export type NewMobilizeSyncedImageRow = typeof mobilizeSyncedImages.$inferInsert;

// --- Mobilize -> Solidarity attendee sync -------------------------------------

// Maps a Mobilize timeslot to the Solidarity event session it came from.
// Written during the event sync (reconcileTimeslots already pairs them), so the
// attendee sync can resolve a signup to a session without re-planning.
export const mobilizeSyncedTimeslots = sqliteTable('mobilize_synced_timeslots', {
	mobilizeTimeslotId: integer('mobilize_timeslot_id').primaryKey(),
	mobilizeEventId: integer('mobilize_event_id').notNull(),
	// NOTE: Solidarity's own event id. Its API confusingly calls this
	// `mobilize_event_id` — "mobilize_event" is Solidarity's internal name for
	// its event entity and has nothing to do with mobilize.us.
	solidarityEventId: integer('solidarity_event_id').notNull(),
	solidaritySessionId: integer('solidarity_session_id').notNull(),
	// The `max_attendees` last pushed to Mobilize for this shift: the Solidarity
	// cap minus the seats Solidarity-side signups have already spent. Stored
	// because Mobilize will not give it back — its event read returns `is_full`
	// and no cap — so this is the only way to tell an unchanged cap from one that
	// has moved. NULL means uncapped, which is not the same as 0 (full).
	pushedMaxAttendees: integer('pushed_max_attendees'),
	updatedAt: text('updated_at').notNull(),
});

// One row per Mobilize signup we've mirrored. `mobilizeModifiedDate` lets a run
// skip rows that haven't changed; `status` records what we last wrote so a
// cancellation is only pushed once.
export const mobilizeSyncedRsvps = sqliteTable('mobilize_synced_rsvps', {
	mobilizeAttendanceId: integer('mobilize_attendance_id').primaryKey(),
	solidarityRsvpId: integer('solidarity_rsvp_id'),
	solidarityUserId: integer('solidarity_user_id').notNull(),
	solidaritySessionId: integer('solidarity_session_id').notNull(),
	status: text('status').notNull(),
	attended: integer('attended', { mode: 'boolean' }).notNull().default(false),
	mobilizeModifiedDate: integer('mobilize_modified_date').notNull().default(0),
	syncedAt: text('synced_at').notNull(),
});

// zip -> chapter, derived from where existing members actually belong.
// Solidarity chapters carry no geographic data, so this is rebuilt nightly from
// the membership base rather than fetched.
export const zipChapterMap = sqliteTable('zip_chapter_map', {
	zipCode: text('zip_code').primaryKey(),
	chapterId: integer('chapter_id').notNull(),
	// How many members in this zip belong to that chapter — a low count means a
	// weak guess, useful when auditing where the sync put people.
	memberCount: integer('member_count').notNull().default(0),
	updatedAt: text('updated_at').notNull(),
});

// One row per long-running sync that must not overlap itself. Cancelling a
// GitHub Actions run does not stop the request it fired — nothing propagates the
// cancellation to Fly — so a re-run can start while the previous sync is still
// writing. Two runs then snapshot the ledger before either has written to it and
// both attempt the same Solidarity creates.
//
// `expiresAt` makes the lock self-healing: a process that dies without releasing
// would otherwise wedge the sync forever. Stored as an ISO-8601 UTC string,
// which is fixed-width, so lexicographic comparison is chronological.
//
// `token` identifies the holder, so a run that overran its TTL and lost the lock
// cannot release the lock a newer run now holds.
export const syncLocks = sqliteTable('sync_locks', {
	name: text('name').primaryKey(),
	token: text('token').notNull(),
	acquiredAt: text('acquired_at').notNull(),
	expiresAt: text('expires_at').notNull(),
});

export type MobilizeSyncedTimeslotRow = typeof mobilizeSyncedTimeslots.$inferSelect;
export type NewMobilizeSyncedTimeslotRow = typeof mobilizeSyncedTimeslots.$inferInsert;

export type MobilizeSyncedRsvpRow = typeof mobilizeSyncedRsvps.$inferSelect;
export type NewMobilizeSyncedRsvpRow = typeof mobilizeSyncedRsvps.$inferInsert;

export type ZipChapterRow = typeof zipChapterMap.$inferSelect;
export type NewZipChapterRow = typeof zipChapterMap.$inferInsert;

// --- Partner Mobilize org -> Solidarity event import ---------------------------

// One row per partner Mobilize event the import has acted on. Written the
// moment the Solidarity event exists — before its sessions and page — so a
// crashed run resumes it rather than creating it twice. Mobilize event ids are
// global across organizations, so the id alone is the key.
export const mobilizeImportedEvents = sqliteTable('mobilize_imported_events', {
	mobilizeEventId: integer('mobilize_event_id').primaryKey(),
	sourceOrgId: integer('source_org_id').notNull(),
	// NULL unless the Solidarity event exists ('created' / 'complete').
	solidarityEventId: integer('solidarity_event_id'),
	// See ImportStatus in mobilize-migrator/lib/import.ts.
	status: text('status').notNull(),
	title: text('title').notNull(),
	solidarityPageUrl: text('solidarity_page_url'),
	// Permanent refusals (4xx) since the last state change. At
	// MAX_PERMANENT_FAILURES the row becomes 'rejected' and stops retrying.
	failedAttempts: integer('failed_attempts').notNull().default(0),
	// When a 'created' row whose event left the plan was announced, so a
	// stalled import is reported once rather than every hour.
	stalledReportedAt: text('stalled_reported_at'),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
});

// Partner timeslot -> the Solidarity session made for it. The session id is
// NULL for the first timeslot when the event-create response didn't name the
// session it made; the row still stops that timeslot being created twice.
export const mobilizeImportedTimeslots = sqliteTable('mobilize_imported_timeslots', {
	mobilizeTimeslotId: integer('mobilize_timeslot_id').primaryKey(),
	mobilizeEventId: integer('mobilize_event_id').notNull(),
	solidaritySessionId: integer('solidarity_session_id'),
	createdAt: text('created_at').notNull(),
});

export type MobilizeImportedEventRow = typeof mobilizeImportedEvents.$inferSelect;
export type MobilizeImportedTimeslotRow = typeof mobilizeImportedTimeslots.$inferSelect;

// ---------------------------------------------------------------------------
// Member lookup + moderation notes
// ---------------------------------------------------------------------------

// Admin-made Slack -> Solidarity account links, for the members whose Slack
// email doesn't match any Solidarity record. Consulted by the member lookup
// page *before* it falls back to matching on email: an explicit human decision
// has to outrank the heuristic, or someone who later corrects their Solidarity
// email would silently re-point to a different record than the one an admin
// deliberately picked.
export const memberAccountLinks = sqliteTable(
	'member_account_links',
	{
		// One Slack account maps to at most one Solidarity account, so the Slack
		// id is the key — the page read is a point lookup and re-linking is a
		// plain onConflictDoUpdate.
		slackUserId: text('slack_user_id').primaryKey(),
		solidarityUserId: integer('solidarity_user_id').notNull(),
		// The Solidarity email as it read when the link was made. Audit trail
		// only — never a lookup key, since the whole reason a link exists is that
		// the emails don't line up.
		solidarityEmail: text('solidarity_email'),
		linkedBy: text('linked_by').notNull(),
		linkedByName: text('linked_by_name').notNull(),
		linkedAt: text('linked_at').notNull(),
	},
	// Deliberately NOT uniqueIndex: duplicate Solidarity records exist, and a
	// mis-link has to be correctable rather than blowing up mid-request. The
	// index is here for reverse lookups.
	(table) => [index('member_account_links_solidarity_user_id').on(table.solidarityUserId)],
);

// Append-only moderation log: notes and warnings admins record about a Slack
// member, written from the Slack modal and read by the member lookup page.
//
// Keyed by Slack user id, not Solidarity id: both entry points (the users_select
// in the modal, the author of a shortcut's message) produce a Slack id, and
// plenty of members have no Solidarity account at all. memberAccountLinks is
// the join when Solidarity data is needed.
export const memberNotes = sqliteTable(
	'member_notes',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slackUserId: text('slack_user_id').notNull(),
		// drizzle's `enum` is compile-time only, so the check constraint below is
		// what actually keeps junk out of the column.
		kind: text('kind', { enum: ['note', 'warning'] }).notNull(),
		body: text('body').notNull(),
		// Permalink to the Slack message the note is about, when there is one.
		// The raw URL is what we render — always clickable, and immune to
		// permalink format changes.
		messageLink: text('message_link'),
		// Parsed from messageLink at write time. Kept alongside the raw URL so a
		// fresh permalink can be re-resolved via chat.getPermalink after a channel
		// rename without re-parsing.
		messageChannelId: text('message_channel_id'),
		messageTs: text('message_ts'),
		// All-time warning rank at insert time, 1-based; NULL for kind='note'.
		// Persisted rather than derived so the DM and the page agree forever —
		// recomputing after a future delete would silently renumber history.
		warningNumber: integer('warning_number'),
		// What the admin chose in the modal, kept separately from the outcome so
		// "chose not to notify" stays distinguishable from "tried and failed".
		dmRequested: integer('dm_requested', { mode: 'boolean' }).notNull().default(false),
		dmSentAt: text('dm_sent_at'),
		// 'suppressed' | 'not-a-warning' | an error message. NULL once sent.
		dmStatus: text('dm_status'),
		// The fully rendered message actually delivered. Needed because admins can
		// edit the warning text per-warning in the modal, so the template alone
		// can't tell you what this member was told.
		dmBody: text('dm_body'),
		// Snapshot of the author's name at write time, matching the settings
		// tables — names change, and the log should render what it said then.
		authorSlackUserId: text('author_slack_user_id').notNull(),
		authorSlackUserName: text('author_slack_user_name').notNull(),
		createdAt: text('created_at').notNull(),
		source: text('source', { enum: ['slash', 'shortcut'] })
			.notNull()
			.default('slash'),
	},
	(table) => [
		index('member_notes_slack_user_created').on(table.slackUserId, table.createdAt),
		// Makes the insert-then-rank warning count (see member-notes.ts) an
		// index-only scan.
		index('member_notes_warning_rank').on(table.slackUserId, table.kind, table.id),
		check('member_notes_kind_check', sql`${table.kind} in ('note', 'warning')`),
		check('member_notes_source_check', sql`${table.source} in ('slash', 'shortcut')`),
	],
);

export type MemberAccountLinkRow = typeof memberAccountLinks.$inferSelect;
export type NewMemberAccountLinkRow = typeof memberAccountLinks.$inferInsert;

export type MemberNoteRow = typeof memberNotes.$inferSelect;
export type NewMemberNoteRow = typeof memberNotes.$inferInsert;

/**
 * Every place a Slack invite link is currently published in Solidarity, one row
 * per (page, location, link), refreshed by the hourly invite audit.
 *
 * A ledger rather than a scan cache: Solidarity exposes no `updated_at` on
 * pages and its public pages send no ETag, so this table is the only record of
 * *when* a link appeared on a page or *when* it went bad. `firstSeenAt` answers
 * "how long have volunteers been hitting a dead link here", and
 * `statusChangedAt` plus `previousStatus` make the transition visible even
 * though the audit re-checks everything from scratch each run.
 *
 * Rows are kept after a link disappears from a page (`lastSeenAt` stops
 * advancing) — deleting them would erase the history of a fix.
 */
export const slackInviteSightings = sqliteTable(
	'slack_invite_sightings',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		pageId: integer('page_id').notNull(),
		// Snapshotted so the log still reads correctly after a page is renamed.
		pageName: text('page_name').notNull(),
		pageUrl: text('page_url').notNull().default(''),
		// 'page content' | 'redirect URL' | 'follow-up email' | 'follow-up text'
		location: text('location').notNull(),
		url: text('url').notNull(),
		// 'valid' | 'broken' | 'unknown'
		status: text('status').notNull(),
		detail: text('detail').notNull().default(''),
		previousStatus: text('previous_status'),
		firstSeenAt: text('first_seen_at').notNull(),
		lastSeenAt: text('last_seen_at').notNull(),
		statusChangedAt: text('status_changed_at'),
	},
	(table) => [
		// The natural key of a sighting: the same link in the email and in the
		// text of one page are two independent things to fix.
		uniqueIndex('slack_invite_sightings_page_location_url').on(
			table.pageId,
			table.location,
			table.url,
		),
		index('slack_invite_sightings_status').on(table.status, table.lastSeenAt),
		check(
			'slack_invite_sightings_status_check',
			sql`${table.status} in ('valid', 'broken', 'unknown')`,
		),
	],
);

export type SlackInviteSightingRow = typeof slackInviteSightings.$inferSelect;
export type NewSlackInviteSightingRow = typeof slackInviteSightings.$inferInsert;

/**
 * Admin-defined slash commands that post a canned blurb — "here's how to sign
 * up to phone bank" and friends — as the person who typed the command rather
 * than as the bot.
 *
 * Rows are created on /settings. Registering the command with Slack is a
 * separate, manual step in the Slack app config: Slack only routes commands it
 * knows about, so a row here with no matching Slack registration is inert (and
 * the editor says so).
 *
 * `command` is the primary key, stored normalized — lowercase, leading slash —
 * so the lookup in api/slack/commands is a direct hit on what Slack sends.
 * `message` is stored raw with friendly `#channel-name` tokens, resolved to
 * `<#C…>` at post time, the same convention the DM templates use.
 */
export const infoCommands = sqliteTable('info_commands', {
	command: text('command').primaryKey(),
	message: text('message').notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

export type InfoCommandRow = typeof infoCommands.$inferSelect;
export type NewInfoCommandRow = typeof infoCommands.$inferInsert;

/**
 * Per-user Slack OAuth tokens (`xoxp-`), captured at login and used by the
 * info commands above to post as the person who typed the command rather than
 * as the bot.
 *
 * The token column holds ciphertext, never the raw token — see token-crypto.ts
 * for the format and why this one table gets that treatment. `scopes` is the
 * grant Slack actually returned, stored so the app can tell "you authorized
 * before chat:write was requested" apart from "you never authorized".
 */
export const slackUserTokens = sqliteTable('slack_user_tokens', {
	slackUserId: text('slack_user_id').primaryKey(),
	encryptedToken: text('encrypted_token').notNull(),
	// Comma-separated, exactly as Slack returns it in `authed_user.scope`.
	scopes: text('scopes').notNull().default(''),
	updatedAt: text('updated_at').notNull(),
});

export type SlackUserTokenRow = typeof slackUserTokens.$inferSelect;
export type NewSlackUserTokenRow = typeof slackUserTokens.$inferInsert;

// ---------------------------------------------------------------------------
// VAN turf checkout (specs/010-van-turf-checkout/plan.md)
//
// Nothing here holds voter data. Turf geometry arrives as a convex hull over
// exported address coordinates, computed server-side with the rows discarded
// (plan §3), so the most granular thing stored is a polygon and a count.
// ---------------------------------------------------------------------------

// One row per VAN campaign — a committee the app reads turf from with its own
// API key (specs/012-multi-van-campaigns/spec.md).
//
// NO credentials here. A campaign's app name, API key and database mode live
// in its `VAN_CAMPAIGN_<KEY>` Fly secret (van/campaign-credentials.ts), and
// `credential_key` is the lowercased <KEY> that links this row to it. That key
// is the campaign's permanent identity: renaming the secret is creating a new
// campaign, and this row is left reporting its credentials missing.
//
// Row 1 is seeded by the migration as the campaign the app has always served,
// with key 'primary' — which the legacy VAN_APP_NAME/VAN_API_KEY vars stand in
// for — so an existing install keeps working with no secret changes. It has no
// label until an admin gives it one. Rows for
// new secrets are created disabled (`ensureCampaignRows` in van-env.ts), so
// setting a secret on its own never starts a sync.
/** The campaign the app has always served: van_campaigns row 1, seeded by the
 *  migration that created the table. The default where a page or script names
 *  no campaign. */
export const PRIMARY_CAMPAIGN_ID = 1;

export const vanCampaigns = sqliteTable(
	'van_campaigns',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		credentialKey: text('credential_key').notNull().unique(),
		/** Shown to signed-in volunteers on turf and in alerts. Blank until an admin
		 *  names the campaign in /settings — the migration and discovery never pick
		 *  one, so no organisation's name is baked into the schema. Unique among
		 *  campaigns that have one, ignoring case (SQLite lets any number of rows be
		 *  NULL): two campaigns told apart only by capitals would read as one on a
		 *  turf badge. */
		label: text('label'),
		/** The short text on this campaign's turf badge, shown to volunteers on
		 *  the map, their turf card and in Slack while more than one campaign is
		 *  enabled, and always on a disabled campaign's turf still being walked
		 *  (badgeShown in van/campaigns.ts). Null or '' falls back to the label, then the credential key
		 *  (campaignBadge in van/campaigns.ts). Not unique: it is a hint beside
		 *  the turf name, not an identifier. */
		badgeLabel: text('badge_label'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
		/** The coordinates export that feeds hull geometry. Per campaign because
		 *  EveryAction issues export job types per key. Null means no geometry —
		 *  turf draws as pins — except for 'primary', which falls back to
		 *  VAN_EXPORT_JOB_TYPE_ID (vanExportJobTypeIdFor in van-env.ts). */
		exportJobTypeId: integer('export_job_type_id'),
		/** Whether the sync may ask VAN to re-cut this campaign's map regions. Off
		 *  by default, and it should stay off unless the campaign has agreed. A
		 *  re-cut retires every route in the region and returns new ones with new
		 *  ids and new saved lists — and it DELETES the region's printed lists.
		 *  Verified live 2026-09-24 on R06F_Washtenaw_SalineCity02 (folder 68298):
		 *  all 18 routes came back with no printed list, and the old numbers 404 on
		 *  /printedLists/{number}. They came back only when an organizer printed the
		 *  lists again in VAN, which this app cannot do. So a refresh turns
		 *  claimable turf into unclaimable turf until someone prints, kills any list
		 *  number already handed out, and a nightly sweep would do that to every
		 *  mapped folder every night, including shared folders other organizers cut.
		 *  Moved here from app_config, where it was one switch for everyone. */
		refreshEnabled: integer('refresh_enabled', { mode: 'boolean' }).notNull().default(false),
		/** Whether this campaign's checkouts are written to its Packet Tracker
		 *  spreadsheets (van_sheet_targets rows for this campaign). Off by default:
		 *  most campaigns keep no such sheet. A disabled campaign with this on is
		 *  still written to, so its live claims' endings are recorded. */
		sheetsEnabled: integer('sheets_enabled', { mode: 'boolean' }).notNull().default(false),
		/** The Packet Tracker tab in every one of this campaign's spreadsheets. One
		 *  name for all of them — a campaign uses the same tab everywhere, and a
		 *  per-sheet name would be a dozen more chances to typo. The app never
		 *  creates it. Null or '' means DEFAULT_SHEET_TAB_NAME in
		 *  $lib/van/packet-tracker.ts. Moved here from app_config. */
		sheetTabName: text('sheet_tab_name'),
		disabledAt: text('disabled_at'),
		disabledByName: text('disabled_by_name'),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [uniqueIndex('van_campaigns_label_unique').on(sql`lower(${table.label})`)],
);

// Which VAN folders belong to which Solidarity chapter. Mirrors
// chapter_channel_map deliberately: same composite-key shape, same audit
// triplet, same settings-editor ergonomics.
//
// This is an INPUT, not something the sync discovers — a chapter with no row
// here has no turf, so the first catalog sync is a no-op until an admin fills
// it in. A chapter can span several folders (counties get cut in pieces).
export const vanChapterFolders = sqliteTable(
	'van_chapter_folders',
	{
		/** Which van_campaigns row the folder belongs to. Folder ids are VAN's
		 *  and only unique within one committee, so the campaign is part of the
		 *  key. */
		campaignId: integer('campaign_id').notNull().default(1),
		chapterId: integer('chapter_id').notNull(),
		folderId: integer('folder_id').notNull(),
		// Denormalised so /settings and the turf page can name a chapter without
		// a Solidarity round-trip, exactly as chapter_channel_map does.
		chapterName: text('chapter_name').notNull(),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.campaignId, table.chapterId, table.folderId] })],
);

// Which of the campaign's spreadsheets a turf's checkout rows belong in.
//
// The campaign keeps about a dozen, named for the region and place they cover —
// `R01A_Alger CR`, `R09A_Detroit CR`, `R10C_WesternWayne CR`. Routing has to be
// decided from a turf's VAN region name, because that name is the only
// geography the catalog has (van_turfs has no county column, and centroid_lat
// is null until an export job has run). Neither half of the name is enough on
// its own: R01A spans Alger and Houghton, which have a spreadsheet each, and
// R10C has two spreadsheets inside Wayne separated only by which cities they
// cover.
//
// So this is a rule list, matched by longest normalised prefix — `R10C_Wayne_Taylor`
// beats a bare `R10C` catch-all. `prefix_key` is the normalisation (lowercase
// alphanumerics, see van/region-name.ts) and, with the campaign, the primary
// key, so two of one campaign's rules cannot disagree about the same ground:
// the settings route refuses the second.
//
// Per campaign (specs/012-multi-van-campaigns): each campaign that keeps a
// Packet Tracker has its own rules, matched only against its own turf.
//
// An INPUT, like van_chapter_folders above. No rows means the sheet log is off
// for that campaign, which is what the spec asks for — an unconfigured feature
// does nothing and raises no alerts.
export const vanSheetTargets = sqliteTable(
	'van_sheet_targets',
	{
		/** The campaign whose turf this rule routes. Each campaign has its own
		 *  rules; another campaign's region names never match them. */
		campaignId: integer('campaign_id').notNull().default(1),
		prefixKey: text('prefix_key').notNull(),
		/** The rule as the admin typed it, for display. `prefix_key` is what
		 *  matches. */
		prefix: text('prefix').notNull(),
		/** What the spreadsheet is called, so an alert can name it without a Google
		 *  round-trip. */
		label: text('label').notNull(),
		/** From the spreadsheet's URL. Several rules may point at one spreadsheet —
		 *  the two R10C rules do. */
		spreadsheetId: text('spreadsheet_id').notNull(),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.campaignId, table.prefixKey] })],
);

// Whether each spreadsheet is currently writable, and what the operator has
// already been told about it.
//
// Keyed by spreadsheet rather than by rule because that is the unit that breaks:
// someone unshares one sheet, or renames the app's tab in it, and both R10C
// rules pointing at it fail together.
//
// `alerted_error` is the idempotency key, in the shape van/drift-alert.ts uses
// and for the reason spelled out there: an alert that repeats every half hour
// gets the channel muted, which costs the campaign the FIRST alert about the
// next real problem. A successful write DELETES the row, which is what makes a
// recurrence audible — without that, a sheet that broke in March, was fixed, and
// breaks again in October stays silent forever.
export const vanSheetHealth = sqliteTable('van_sheet_health', {
	spreadsheetId: text('spreadsheet_id').primaryKey(),
	/** The most recent failure, as the operator would need to read it. */
	lastError: text('last_error').notNull(),
	lastFailedAt: text('last_failed_at').notNull(),
	/** The error text that was last posted to Slack. Null when a problem is
	 *  known but has not been announced yet — stamped only after Slack accepts
	 *  the message. */
	alertedError: text('alerted_error'),
});

// One row per VAN Map Route.
//
// `turfId` is this app's id for the turf: what checkouts, rosters, the geometry
// queue, Slack buttons and webhook URLs point at. VAN's own id for the route is
// `vanMapRouteId`, unique only within its campaign — two campaigns' committees
// can hand out the same route id. A new turf takes its VAN id as its `turfId`
// whenever no other turf already has that id, so the two normally match; only a
// genuine collision gets a different one (see planCatalogSync). Anything read
// from VAN is matched on (campaignId, vanMapRouteId); everything inside the app
// on turfId.
//
// VAN's `mapRouteId` is NOT stable across a refresh —
// this comment used to claim it was, and the plan's Story 4.6 was written to
// settle the question. Verified against the live API on 2026-09-08: refreshing
// region 508413 retired routes 56456/56457 and returned 56502/56503 in their
// place, each with a new savedListId; a second re-cut produced 56507/56508/56509.
// So a route id identifies a CUT of a piece of ground, not the ground. A
// refresh therefore reads as "every route in this region vanished and new ones
// appeared", the catalog sync retires the old rows, and van/refresh-reconcile.ts
// is what pairs a volunteer's dead claim to its replacement — by region and
// name, because there is no id in common to pair on.
export const vanTurfs = sqliteTable(
	'van_turfs',
	{
		turfId: integer('turf_id').primaryKey(),
		/** The van_campaigns row whose key this turf was read with. */
		campaignId: integer('campaign_id').notNull().default(1),
		/** VAN's `mapRouteId`. Unique per campaign, not globally. */
		vanMapRouteId: integer('van_map_route_id').notNull(),
		mapRegionId: integer('map_region_id').notNull(),
		folderId: integer('folder_id').notNull(),
		// Resolved through van_chapter_folders at sync time so reads don't join.
		chapterId: integer('chapter_id').notNull(),
		chapterName: text('chapter_name').notNull().default(''),
		regionName: text('region_name').notNull().default(''),
		name: text('name').notNull(),
		savedListId: integer('saved_list_id'),
		/** The MiniVAN list number a volunteer types in. Nullable: a route can
		 *  exist before anyone generates its printed list, and a turf without
		 *  one must not be claimable. */
		printedListNumber: text('printed_list_number'),
		/** VAN's `dateCreated` for that printed list. Printed lists expire 30
		 *  days after they are generated, after which the number loads nothing
		 *  in MiniVAN — this is what the expiry warning counts from. Null when
		 *  VAN didn't say, which the warning treats as "can't tell", not "fine". */
		printedListCreatedAt: text('printed_list_created_at'),
		/** The `printedListCreatedAt` the turf channel was last warned about.
		 *  The creation date rather than the number, because the number is the
		 *  credential and stays out of anything posted; a regenerated list has a
		 *  new creation date, so it is warned about afresh when its turn comes. */
		listExpiryWarnedFor: text('list_expiry_warned_for'),
		routeNumber: integer('route_number'),
		/** People in the list (VAN's routeSize). */
		routeSize: integer('route_size').notNull().default(0),
		/** Unique doors (VAN's doorCount). */
		doorCount: integer('door_count').notNull().default(0),
		phoneCount: integer('phone_count').notNull().default(0),
		centroidLat: real('centroid_lat'),
		centroidLng: real('centroid_lng'),
		/** JSON array of {lat,lng}, rounded to 5dp. Null while geometry is
		 *  pending or when the hull was degenerate — the UI draws a pin. */
		hullJson: text('hull_json'),
		/** routeSize when the hull was computed. A materially different
		 *  routeSize means the turf was re-cut and the hull is stale. */
		hullSourceRouteSize: integer('hull_source_route_size'),
		/** Canvassers VAN reports for this turf via /minivanExports, when it was
		 *  handed out outside this app. Null = not distributed. Carried forward
		 *  once `vanAssignedAt` is set — see there. */
		vanDistributedTo: text('van_distributed_to'),
		/** When this route was last seen loaded in MiniVAN OUTSIDE one of our
		 *  own claims — an organizer handing the list out directly, or a
		 *  volunteer given the number by someone else. The latest such export,
		 *  so a re-export restarts the clock.
		 *
		 *  The catalog sync carries it and `vanDistributedTo` forward after the
		 *  export ages out, but the turf only stays out of this app's pool for
		 *  app_config.vanAssignmentTtlHours after it, once there is an uncontacted count
		 *  (vanAssignmentBlocks in turf-view.ts). Exports made DURING one of our
		 *  claims are our own volunteer loading the list and are recorded on the
		 *  claim instead (`van_turf_checkouts.loaded_in_minivan_at`). See
		 *  catalog.ts. */
		vanAssignedAt: text('van_assigned_at'),
		/** Who the campaign's Packet Tracker says has this turf, from a row it
		 *  entered itself — matched on list number, Status Unwalked, Out or
		 *  Complete. Null = the tracker does not have it out.
		 *
		 *  NOT carried forward, unlike `vanAssignedAt`: re-read from the tracker every sync
		 *  and cleared when the row goes, because the campaign's rows change and
		 *  this is their word, not VAN's. Blocks a claim the same way
		 *  `vanDistributedTo` does. See van/packet-tracker-store.ts. */
		sheetAssignedTo: text('sheet_assigned_to'),
		/** When the turf channel was last told this turf was drifting, and which
		 *  direction it was drifting in.
		 *
		 *  The idempotency key for the drift alert, and a pair rather than a lone
		 *  flag for the reason in drift-alert.ts: a route can stop drifting one way
		 *  and start drifting the other, and the second direction is the dangerous
		 *  one. Cleared when the turf stops drifting, so a recurrence is audible.
		 *  Stamped only after Slack accepted the message. */
		driftAlertedAt: text('drift_alerted_at'),
		/** 'claimed-not-in-minivan'. Older rows may hold 'in-minivan-not-claimed',
		 *  a kind since dropped; the drift alert's stale sweep clears those. */
		driftAlertedKind: text('drift_alerted_kind'),
		firstSeenAt: text('first_seen_at').notNull(),
		lastSeenAt: text('last_seen_at').notNull(),
		lastRefreshedAt: text('last_refreshed_at'),
		/** When VAN cut this route: the region's `dateRefreshed`, else its
		 *  `dateCreated`, as real UTC. Contact attempts before this are about a
		 *  different cut and do not take a door off this one. Null when VAN said
		 *  neither; readers fall back to `firstSeenAt`. */
		cutAt: text('cut_at'),
		/** Doors with no in-person contact attempt since `cutAt` — not home,
		 *  refused and inaccessible all count as contacted. Computed from
		 *  van_turf_roster × van_person_contacts by van/contact-sync.ts. Null
		 *  until this turf has a roster for its current saved list. NOT part of
		 *  the catalog upsert, which would otherwise clobber it every sync. */
		uncontactedDoors: integer('uncontacted_doors'),
		uncontactedDoorsAt: text('uncontacted_doors_at'),
		/** The savedListId van_turf_roster was built from. Differs from
		 *  `savedListId` (or is null) when the roster is missing or describes an
		 *  older cut, which is what queues a fresh export. Written only by the
		 *  geometry worker. */
		rosterSavedListId: integer('roster_saved_list_id'),
		/** Stamped, never deleted, so a live checkout pointing at a vanished
		 *  route still renders. */
		retiredAt: text('retired_at'),
	},
	(table) => [
		index('van_turfs_chapter').on(table.chapterId),
		index('van_turfs_region').on(table.mapRegionId),
		uniqueIndex('van_turfs_campaign_route').on(table.campaignId, table.vanMapRouteId),
		index('van_turfs_campaign_folder').on(table.campaignId, table.folderId),
	],
);

// Append-only checkout ledger. Rows are never updated in place except to stamp
// a terminal timestamp, so the history of who held what survives.
//
// The partial unique index is the anti-collision guarantee: at most one row per
// turf may be simultaneously unreleased and uncompleted. Two racing claims
// cannot both win, because the constraint is enforced by the storage engine
// rather than by a read-then-write in application code.
export const vanTurfCheckouts = sqliteTable(
	'van_turf_checkouts',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		turfId: integer('turf_id').notNull(),
		slackUserId: text('slack_user_id').notNull(),
		slackUserName: text('slack_user_name').notNull(),
		claimedAt: text('claimed_at').notNull(),
		/** When the claim lapses if untouched. Evaluated on read as well as by
		 *  the sweep, so an expired claim never shows as held. */
		expiresAt: text('expires_at').notNull(),
		releasedAt: text('released_at'),
		completedAt: text('completed_at'),
		/** 'volunteer' | 'expired' | 'admin' | 'retired' | 'blocked' | 'walked-out'
		 *
		 *  'walked-out' is the reconciliation's: VAN refreshed the region and the
		 *  turf came back with no doors left in it, so there is nothing for the
		 *  holder to knock. See van/refresh-reconcile.ts. */
		releaseReason: text('release_reason'),
		/** VAN's door count for this turf at the moment it was claimed.
		 *
		 *  The baseline half of `confirmedDoorDelta`. Recorded per claim rather
		 *  than read from van_turfs later because van_turfs holds one number that
		 *  moves — by the time a completion is checked, the count the volunteer
		 *  started against is gone.
		 *
		 *  Claim-time rather than completion-time on purpose: a nightly refresh
		 *  can land mid-walk, and measuring from completion would credit that
		 *  volunteer with nothing for everything they synced before it. NULL on
		 *  rows claimed before this column existed, which reads as "cannot be
		 *  measured" rather than as zero. */
		claimDoorCount: integer('claim_door_count'),
		/** What MiniVAN showed as done, 0-100, when the volunteer marked the turf
		 *  walked. Required on completion; null on releases and on rows from
		 *  before it was asked.
		 *
		 *  VAN's API has no progress figure and its door counts only move on a
		 *  re-cut, which deletes the printed lists — so the volunteer, who has
		 *  MiniVAN open at that moment, is the only source. Trusted until the
		 *  turf is next cut: it belongs to this route id, and a re-cut issues new
		 *  ones. */
		reportedPercent: integer('reported_percent'),
		/** When the sync first saw this claim's list loaded in MiniVAN: an export
		 *  of the turf's list inside the claim's window. Loading a list number is
		 *  what creates the export, so null on a live claim means the volunteer
		 *  has not opened it yet — the drift report's one direction. */
		loadedInMinivanAt: text('loaded_in_minivan_at'),
		/** Doors that left the turf between claim and the post-completion
		 *  refresh. Zero means the volunteer probably never synced MiniVAN. */
		confirmedDoorDelta: integer('confirmed_door_delta'),
		/** Doors on the turf with an in-person contact in VAN's ContactHistory
		 *  between this claim and its completion — the doors this volunteer
		 *  knocked, not-homes included. Derived by van/contact-sync.ts for a day
		 *  after completion (MiniVAN syncs late), then left alone. Also derived
		 *  for an expired claim, up to its expiry, for the Packet Tracker. Null when the
		 *  turf had no roster to count against; the dashboard then falls back
		 *  to `confirmedDoorDelta`. */
		doorsKnocked: integer('doors_knocked'),
		/** The MiniVAN list number this volunteer was actually given.
		 *
		 *  Not a duplicate of van_turfs.printed_list_number: that column is what
		 *  VAN says TODAY, this one is what the holder was told, and the
		 *  reconciliation in Story 4.5 is precisely the comparison of the two. A
		 *  refresh can regenerate a printed list under a claim that is hours old,
		 *  and without a record of what we issued there is no way to notice —
		 *  the volunteer would walk up to a MiniVAN list that no longer loads.
		 *
		 *  NULL on rows claimed before this column existed, and on any claim
		 *  whose DM has not landed yet. A null is read as "we have not told them
		 *  anything to correct" and is adopted silently rather than announced:
		 *  the alternative is one DM per outstanding claim on the deploy that
		 *  adds the column, all of them saying the number did not change. */
		issuedListNumber: text('issued_list_number'),
		/** When the holder was told their turf had been re-cut out from under
		 *  them, and what happened to their claim.
		 *
		 *  The idempotency key for that DM, in the shape of expiryWarnedAt above
		 *  and for the same reason: the reconciliation runs on every sync tick,
		 *  and a released claim stays released forever, so without a stamp the
		 *  volunteer is told about the same re-cut 37 times a day. Stamped only
		 *  after Slack accepted the message. */
		recutNotifiedAt: text('recut_notified_at'),
		/** When the T-6h expiry warning DM was successfully sent.
		 *
		 *  The idempotency key for that DM, and the reason it is a column rather
		 *  than a log line: the warning sweep runs every half hour for the whole
		 *  six-hour window, so without a stamp a volunteer would be reminded
		 *  twelve times about one turf. Stamped only on a successful send, so a
		 *  Slack outage retries on the next tick instead of silently swallowing
		 *  the one message that stops turf being lost. */
		expiryWarnedAt: text('expiry_warned_at'),
		/** What this checkout's Packet Tracker row last said, as Google confirmed
		 *  it — JSON, see van/packet-tracker-store.ts for the shape.
		 *
		 *  The whole of the tracker's bookkeeping. The row the checkout SHOULD
		 *  have is derived from this table on every run and compared with this;
		 *  a difference is a write owed. Derived rather than enqueued by the code
		 *  paths that end a claim — there are six of those (endClaim, the
		 *  lapsed-claim clear inside claimTurf, sweepExpiredClaims, blocklist.ts,
		 *  the retirement batch in sync.ts, refresh-reconcile) and hooking each
		 *  one is how the seventh gets missed.
		 *
		 *  NULL means nothing has been written yet. Released checkouts from before
		 *  the Packet Tracker existed were stamped by the migration as "no row",
		 *  so switching it on backfills only live and walked turf. */
		sheetState: text('sheet_state'),
		/** JSON: the row this checkout filled in on the same spreadsheet's Walk
		 *  Ins tab — see van/packet-tracker-store.ts `WalkInState`. Rows there
		 *  are filled top-down into the first empty one, so the row number is
		 *  recorded to clear the right one later. NULL means nothing written. */
		walkInState: text('walk_in_state'),
	},
	(table) => [
		uniqueIndex('van_turf_checkouts_one_active')
			.on(table.turfId)
			.where(sql`${table.releasedAt} IS NULL AND ${table.completedAt} IS NULL`),
		index('van_turf_checkouts_holder').on(table.slackUserId),
	],
);

// Deny-list for turf checkout. Mirrors allowed_slack_users, inverted.
// Blocking gates reads as well as writes — see src/lib/van/access.ts.
export const vanBlockedUsers = sqliteTable('van_blocked_users', {
	slackUserId: text('slack_user_id').primaryKey(),
	displayName: text('display_name').notNull(),
	/** Free text, shown only to admins. Nullable — a block doesn't require a
	 *  stated reason, though one is strongly encouraged. */
	reason: text('reason'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// RETIRED — replaced by `outside_volunteers` below, which migration 0063
// copied its rows into. Nothing in the app reads or writes it any more.
//
// It is still declared so the next `db:generate` does not drop it. Dropping it
// in the same release as 0063 would pull it out from under the previous
// version while Fly's release command runs and the old machines still serve:
// their Google sign-ins would fail to record, and a failed deploy would leave
// them running against a missing table. Remove this declaration in a later
// release, and have that migration first copy across any rows the old
// machines wrote during the switchover — an INSERT OR IGNORE … SELECT shaped
// like 0063's copy, with the IGNORE so rows 0063 already moved are skipped —
// before the DROP.
export const googleVolunteers = sqliteTable('google_volunteers', {
	userId: text('user_id').primaryKey(),
	email: text('email').notNull(),
	displayName: text('display_name').notNull(),
	firstSignedInAt: text('first_signed_in_at').notNull(),
	lastSignedInAt: text('last_signed_in_at').notNull(),
});

// Everyone who has signed in outside Slack — with Google
// (specs/013-google-sso-login, FR-020) or Apple (specs/014-apple-sso-login,
// FR-019). Replaces `google_volunteers`, whose rows it took over.
//
// The only place an outside volunteer's email is kept, and kept for one
// reason: so an organizer can tell who is holding turf and block them if need
// be. Read by admin views and the block-list editor, and by nothing else.
//
// Keyed by the holder id the rest of the app uses (`google:<sub>` or
// `apple:<sub>`, see server/identity.ts), so it joins straight onto checkouts
// and blocks. Upserted on every sign-in, so a changed email catches up.
// Cleared wholesale by an admin at the end of a campaign; blocks and past
// claims survive that, since they carry their own display name.
//
// `display_name` is null while the volunteer has no usable name — Apple sends
// one only on the first authorization, and a Google profile may have none.
// /turfs asks for it then, and a typed name is set once and never changed
// (FR-011b). A Google profile name, when there is one, still refreshes it on
// every sign-in, as before.
export const outsideVolunteers = sqliteTable('outside_volunteers', {
	userId: text('user_id').primaryKey(),
	/** 'google' | 'apple' — also readable from the id's prefix; stored so a
	 *  count by provider is a plain GROUP BY. */
	provider: text('provider').notNull(),
	email: text('email').notNull(),
	/** An Apple Hide My Email relay address: unique to this app, but mail from
	 *  an organizer's own account will not reach it. Always false for Google. */
	isPrivateEmail: integer('is_private_email', { mode: 'boolean' }).notNull().default(false),
	displayName: text('display_name'),
	firstSignedInAt: text('first_signed_in_at').notNull(),
	lastSignedInAt: text('last_signed_in_at').notNull(),
});

// What a turf holder would have been DMed, kept for one who has no Slack.
//
// The expiry warning, the "did MiniVAN sync?" nudge and the re-cut messages
// are Slack DMs. A Google or Apple volunteer (specs/013-google-sso-login, User
// Story 5) cannot get those, so van/holder-notices.ts writes the same text here and
// /turfs shows it until they dismiss it. Dismissing deletes the row, and rows
// past NOTICE_MAX_AGE are dropped unread — a week-old warning about a claim
// that has long since lapsed is noise, and some of these name a MiniVAN list
// number, which is not worth keeping longer than it is useful.
export const turfNotices = sqliteTable(
	'turf_notices',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** The holder id — always `google:<sub>` or `apple:<sub>`. */
		userId: text('user_id').notNull(),
		/** Which message: 'expiry' | 'unsynced' | 'list-number' | 'walked-out' | 'recut'. */
		kind: text('kind').notNull(),
		/** The message exactly as the DM would have said it, in Slack mrkdwn. */
		text: text('text').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [index('turf_notices_user').on(table.userId, table.createdAt)],
);

// Work queue for the per-turf export jobs that produce hull geometry. Export
// Jobs are scoped to one savedListId, so a 200-turf region is 200 jobs; this
// exists to throttle them and to survive a dropped webhook.
export const vanGeometryQueue = sqliteTable(
	'van_geometry_queue',
	{
		turfId: integer('turf_id').primaryKey(),
		savedListId: integer('saved_list_id').notNull(),
		exportJobId: integer('export_job_id'),
		/** 'pending' | 'running' | 'done' | 'failed' */
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		requestedAt: text('requested_at'),
		completedAt: text('completed_at'),
		lastError: text('last_error'),
	},
	(table) => [index('van_geometry_queue_status').on(table.status)],
);

// Who lives behind which door on each turf, with neither written down.
//
// Both columns are HMAC-SHA256 digests truncated to 16 bytes, keyed by
// VAN_ID_HASH_SECRET (van/person-hash.ts). A VanID is a small integer and an
// unkeyed hash of one is reversed by enumeration in seconds, so the key is what
// makes this table useless without the server. The raw VanID and address exist
// only inside the CSV parser (hull-extract.ts) and are never stored or logged.
//
// Blobs rather than hex: at ~200 people × a few thousand turfs this is the
// largest table in the database, and hex would double it.
export const vanTurfRoster = sqliteTable(
	'van_turf_roster',
	{
		turfId: integer('turf_id').notNull(),
		personHash: blob('person_hash', { mode: 'buffer' }).notNull(),
		doorHash: blob('door_hash', { mode: 'buffer' }).notNull(),
	},
	// The person index is for the other direction: after a ContactHistory pull,
	// which turfs have one of the people just read (contact-sync.ts), so only
	// those are recomputed. Without it that lookup scans the whole table.
	(table) => [
		primaryKey({ columns: [table.turfId, table.personHash] }),
		index('van_turf_roster_person').on(table.personHash),
	],
);

// The latest in-person contact attempt per person, from VAN's ContactHistory
// changed-entity export. Every in-person contact in the committee is kept, not
// only people already on a roster: rosters arrive turf by turf over hours, and
// filtering on them would silently drop contacts made before a turf's roster
// landed. Pruned below the oldest live turf's cut date. Same hashing as above.
export const vanPersonContacts = sqliteTable(
	'van_person_contacts',
	{
		/** Contacts are per campaign: one committee's key cannot see another's
		 *  ContactHistory, and a turf counts only its own campaign's doors. */
		campaignId: integer('campaign_id').notNull().default(1),
		personHash: blob('person_hash', { mode: 'buffer' }).notNull(),
		lastInPersonAt: text('last_in_person_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.campaignId, table.personHash] })],
);

// Progress record for each campaign's ContactHistory pull. The pull walks forward
// one window at a time; `cursor` is the end of the last window fully applied,
// and a window's export job id is stored before it is waited on so a slow job
// is resumed by polling on the next run rather than submitted twice.
export const vanContactSyncState = sqliteTable('van_contact_sync_state', {
	/** One row per campaign: each pulls its own ContactHistory. */
	campaignId: integer('campaign_id').primaryKey(),
	cursor: text('cursor'),
	/** Where the pull began: [coveredFrom, cursor] has been read. A live turf
	 *  cut before this (a newly mapped folder) rewinds the cursor to it. */
	coveredFrom: text('covered_from'),
	exportJobId: integer('export_job_id'),
	/** When the current job was submitted, so one VAN never finishes is
	 *  eventually abandoned rather than polled forever. */
	exportJobCreatedAt: text('export_job_created_at'),
	/** Failed attempts to read the current job's files. At the cap the job
	 *  is dropped and its window submitted afresh. */
	exportJobFailures: integer('export_job_failures').notNull().default(0),
	windowFrom: text('window_from'),
	windowTo: text('window_to'),
	lastRunAt: text('last_run_at'),
	lastError: text('last_error'),
	/** Start of the last scheduled run that read ContactHistory all the way
	 *  up to its own start. A completion at or after this has not been
	 *  counted yet: its turf stays unclaimable and its doors knocked unset
	 *  until a scheduled run gets past it. Nudges never set it. */
	countedThrough: text('counted_through'),
	/** When every counted turf was last recomputed. Null means the next
	 *  scheduled run does all of them; after that, only turfs with a person
	 *  in the contacts just pulled. Cleared when the feature is switched off. */
	fullRecomputeAt: text('full_recompute_at'),
});

// One row per Map Region we have ever asked VAN to re-cut.
//
// VAN owns the answer to "which doors are left" — a refresh re-runs the region
// against current data and contacted doors fall out of its routes (plan.md §2
// Constraint C). This table is the bookkeeping around that call, and it exists
// because the call is asynchronous, rate-worthy, and occasionally deferred:
// nothing in VAN's response says a refresh finished, so the evidence has to be
// stored and compared against on a later read.
//
// Keyed by folder AND region because that is what the endpoint takes: VAN
// exposes POST /folders/{id}/mapRegions/refresh (the whole folder) and
// POST /folders/{id}/mapRegions/{id}/refresh (one region). A region id alone is
// not addressable.
export const vanRegionRefreshes = sqliteTable(
	'van_region_refreshes',
	{
		campaignId: integer('campaign_id').notNull().default(1),
		folderId: integer('folder_id').notNull(),
		mapRegionId: integer('map_region_id').notNull(),
		/** An on-demand refresh is wanted and has not been sent yet. Set when a
		 *  volunteer completes turf in this region; cleared when the POST goes
		 *  out. Non-null with a stale timestamp is the deferral (Story 4.5.2) —
		 *  a region with other live claims waits rather than being re-cut under
		 *  the people walking it. */
		requestedAt: text('requested_at'),
		/** When we last POSTed a refresh for this region, by either path. The
		 *  once-an-hour throttle reads this and nothing else. */
		lastRequestAt: text('last_request_at'),
		/** 'nightly' | 'completion' — which path sent that last request. */
		lastRequestKind: text('last_request_kind'),
		/** Set when a POST is accepted, cleared when VAN's own dateRefreshed
		 *  moves past it (or when it times out). While this is set the turf page
		 *  marks the region's turf as updating — a soft per-turf state that stays
		 *  claimable, rather than the page-wide block Story 4.5 rejects. */
		inFlightSince: text('in_flight_since'),
		/** Last failed POST. The sweep also reports failures as sync warnings,
		 *  which reach the turf channel, but those scroll away — this is what an
		 *  operator can still read a week later when asking why one region's
		 *  counts stopped moving. */
		lastError: text('last_error'),
		lastErrorAt: text('last_error_at'),
	},
	(table) => [primaryKey({ columns: [table.campaignId, table.folderId, table.mapRegionId] })],
);

// MiniVAN exports, as read from VAN and kept so that each sync only asks for
// what is new (minivan-export-store.ts).
//
// Stored rather than re-read because there is no way to re-read "the recent
// ones" cheaply. The unfiltered endpoint holds 645,000+ records in no date
// order at all — verified live on 2026-09-23, the table's tail ran 2014 to
// 2023 — so the old "walk back 1,000 from the end" read an effectively random
// slice, and a turf's `van_distributed_to` flickered between syncs as the
// slice moved. `generatedAfter` does filter, and returns oldest-first, so a
// cursor over this table turns each sync into a page or two.
//
// Every export is kept, not only the ones matching a turf today: a list number
// VAN issues tomorrow may have been exported already, and the cursor is read
// back off `date_created`.
export const vanMinivanExports = sqliteTable(
	'van_minivan_exports',
	{
		/** Each campaign's key reads its own committee's exports. */
		campaignId: integer('campaign_id').notNull().default(1),
		minivanExportId: integer('minivan_export_id').notNull(),
		/** VAN's export name, normally `"List 58817996-30305"`. */
		name: text('name'),
		/** The printed list number parsed from `name`, which is what a turf is
		 *  joined on. Null for hand-named exports, which are deliberately not
		 *  matched (see listNumberFromExportName in catalog.ts). */
		listNumber: text('list_number'),
		/** VAN's `dateCreated`, verbatim. It carries a `Z` but reads as campaign
		 *  local time, so it is compared by DATE only — see the cursor. */
		dateCreated: text('date_created'),
		/** The `canvassers` array as VAN sent it, JSON. Kept whole rather than
		 *  reduced to names so a change in how names are read needs no refetch. */
		canvassersJson: text('canvassers_json').notNull().default('[]'),
		fetchedAt: text('fetched_at').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.campaignId, table.minivanExportId] }),
		index('van_minivan_exports_list_number').on(table.campaignId, table.listNumber),
		index('van_minivan_exports_date_created').on(table.campaignId, table.dateCreated),
	],
);

// What the last catalog sync could actually see, so a read can tell "VAN says
// nothing is distributed" apart from "we could not ask VAN".
//
// `/minivanExports` is Tier 3 and 403s on a demo key, and on a fresh database
// the first few syncs are still backfilling it. Either way
// `van_turfs.van_distributed_to` is null (or incomplete) for reasons that have
// nothing to do with what VAN says, which leaves the column meaning two
// opposite things. The drift report (Story 8.2) is the one reader that cannot
// live with that ambiguity, so the sync records the answer here.
//
// One row per campaign: each reads its own MiniVAN exports with its own key.
export const vanSyncState = sqliteTable('van_sync_state', {
	/** One row per campaign. */
	campaignId: integer('campaign_id').primaryKey(),
	/** ISO timestamp of the last non-dry-run catalog sync. */
	/** Null for a campaign whose catalog sync has never completed — a row can
	 *  exist before then to record why it is failing (`lastError`). */
	lastSyncAt: text('last_sync_at'),
	/** Whether the stored exports were complete and current on that run:
	 *  /minivanExports answered AND the store has caught up to today. NULL
	 *  only before the first sync has ever completed. */
	minivanExportsOk: integer('minivan_exports_ok', { mode: 'boolean' }),
	/** The last catalog sync failure for this campaign — missing
	 *  credentials, a rejected key — or null after a success. */
	lastError: text('last_error'),
	/** The `lastError` already posted to Slack, so a campaign that stays
	 *  broken is announced once rather than every half hour. Cleared by a
	 *  success, so a recurrence is announced again. */
	alertedError: text('alerted_error'),
});

// zip -> lat/lng cache for the "no geolocation" fallback. Deliberately shaped
// like mobilize_geocoded_zips, including the never-throw contract of the
// geocoder that fills it: a lookup failure yields no row, never an exception.
export const vanZipCentroids = sqliteTable('van_zip_centroids', {
	zip: text('zip').primaryKey(),
	lat: real('lat').notNull(),
	lng: real('lng').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});

export type VanCampaignRow = typeof vanCampaigns.$inferSelect;
export type NewVanCampaignRow = typeof vanCampaigns.$inferInsert;

export type VanChapterFolderRow = typeof vanChapterFolders.$inferSelect;
export type NewVanChapterFolderRow = typeof vanChapterFolders.$inferInsert;

export type VanTurfRow = typeof vanTurfs.$inferSelect;
export type NewVanTurfRow = typeof vanTurfs.$inferInsert;

export type VanTurfCheckoutRow = typeof vanTurfCheckouts.$inferSelect;
export type NewVanTurfCheckoutRow = typeof vanTurfCheckouts.$inferInsert;

export type VanRegionRefreshRow = typeof vanRegionRefreshes.$inferSelect;

export type VanBlockedUserRow = typeof vanBlockedUsers.$inferSelect;
export type NewVanBlockedUserRow = typeof vanBlockedUsers.$inferInsert;

export type VanSyncStateRow = typeof vanSyncState.$inferSelect;

export type VanMinivanExportRow = typeof vanMinivanExports.$inferSelect;
export type NewVanMinivanExportRow = typeof vanMinivanExports.$inferInsert;

export type VanGeometryQueueRow = typeof vanGeometryQueue.$inferSelect;
export type NewVanGeometryQueueRow = typeof vanGeometryQueue.$inferInsert;

export type VanTurfRosterRow = typeof vanTurfRoster.$inferSelect;
export type VanPersonContactRow = typeof vanPersonContacts.$inferSelect;
export type VanContactSyncStateRow = typeof vanContactSyncState.$inferSelect;

export type VanZipCentroidRow = typeof vanZipCentroids.$inferSelect;
export type NewVanZipCentroidRow = typeof vanZipCentroids.$inferInsert;
