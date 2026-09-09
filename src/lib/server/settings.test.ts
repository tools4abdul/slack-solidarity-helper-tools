import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// env.ts is mocked per-test. Modeled on the chained-db pattern in
// dashboard-signups.test.ts:35–67 — a `makeDb()` factory whose `select` chain
// pulls rows from a queue and whose `insert`/`delete` chains record what they
// were called with into capturable arrays.
vi.mock('./env.js', () => ({
	SOLIDARITY_CHAPTER_CHANNEL_MAP: [{ chapterId: 1, channelId: 'C_ENV_CHAP', name: 'Env Chapter' }],
	SLACK_ALLOWED_USER_IDS: new Set(['U_ENV_ALICE']),
	REPORT_EXCLUDED_CHAPTER_IDS: new Set([99]),
	SLACK_TRACKING_CHANNEL_ID: 'C_ENV_TRACK',
	SLACK_GROWTH_REPORT_CHANNEL_ID: 'C_ENV_GROWTH',
	SLACK_GROWTH_REPORT_RANKING_ALPHA: 0.5,
	MOBILIZE_CONTACT_NAME: 'Env Field Team',
	MOBILIZE_CONTACT_EMAIL: 'env-events@example.org',
	MOBILIZE_CONTACT_PHONE: '',
}));

import { DEFAULT_TICKER_COLUMNS_PER_SECOND } from '../ticker-speed.js';
import {
	loadSettings,
	saveChapterChannelEntries,
	deleteChapterChannelEntries,
	ensureChapterChannelMapSeeded,
	ensureAllowedUsersSeeded,
	ensureExcludedChaptersSeeded,
	setChannelWelcomeFlag,
	channelWelcomeFlags,
	SYSTEM_EDITOR,
	saveCoalitionEntry,
	deleteCoalitionEntry,
	saveAllowedUser,
	deleteAllowedUser,
	saveExcludedChapter,
	deleteExcludedChapter,
	saveAppConfig,
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	appConfig,
} from './settings.js';

interface CapturedInsert {
	table: unknown;
	values: unknown;
	onConflict: unknown;
}

interface CapturedDelete {
	table: unknown;
	where: unknown;
}

interface MockDb {
	select: ReturnType<typeof vi.fn>;
	insert: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	_pushSelect: (rows: unknown[]) => void;
	_capturedInserts: () => CapturedInsert[];
	_capturedDeletes: () => CapturedDelete[];
}

function makeDb(): MockDb {
	const selectQueue: unknown[][] = [];
	const inserts: CapturedInsert[] = [];
	const deletes: CapturedDelete[] = [];

	const select = vi.fn(() => {
		const rows = selectQueue.shift() ?? [];
		const limit = vi.fn().mockResolvedValue(rows);
		const from = vi.fn(() => ({
			limit,
			then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
		}));
		return { from };
	});

	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: async (onConflict: unknown) => {
				inserts.push({ table, values, onConflict });
			},
			// Race-tolerant seed insert — used by ensureChapterChannelMapSeeded.
			onConflictDoNothing: async () => {
				inserts.push({ table, values, onConflict: 'do-nothing' });
			},
		}),
	}));

	const del = vi.fn((table: unknown) => ({
		where: async (where: unknown) => {
			deletes.push({ table, where });
		},
	}));

	return {
		select,
		insert,
		delete: del,
		_pushSelect: (rows) => selectQueue.push(rows),
		_capturedInserts: () => inserts,
		_capturedDeletes: () => deletes,
	};
}

// `loadSettings` always issues six reads, in this exact order: chapter,
// coalition, allowed users, excluded chapters, welcome flags, app_config.
function pushAllEmpty(db: MockDb) {
	for (let i = 0; i < 7; i++) db._pushSelect([]);
}

describe('loadSettings — Story 1 (env fallback when tables are empty)', () => {
	it('returns env values for env-backed fields and an empty coalition map when all five tables are empty', async () => {
		const db = makeDb();
		pushAllEmpty(db);

		const result = await loadSettings(db as never);

		expect(result.chapterChannelMap).toEqual([
			{ chapterId: 1, channelId: 'C_ENV_CHAP', name: 'Env Chapter' },
		]);
		// The coalition map is DB-only — no env fallback, so an empty table
		// means "nothing mapped" (a delete must stay deleted).
		expect(result.coalitionChannelMap).toEqual([]);
		expect(result.allowedSlackUserIds).toEqual(new Set(['U_ENV_ALICE']));
		expect(result.reportExcludedChapterIds).toEqual(new Set([99]));
		expect(result.slackTrackingChannelId).toBe('C_ENV_TRACK');
		expect(result.slackGrowthReportChannelId).toBe('C_ENV_GROWTH');
		expect(result.slackGrowthReportRankingAlpha).toBe(0.5);
	});

	it('returns defensive defaults when env vars are unset and tables are empty', async () => {
		// Re-mock env.js with the empty-state shapes for just this test.
		vi.doMock('./env.js', () => ({
			SOLIDARITY_CHAPTER_CHANNEL_MAP: [],
			SLACK_ALLOWED_USER_IDS: new Set<string>(),
			REPORT_EXCLUDED_CHAPTER_IDS: new Set<number>(),
			SLACK_TRACKING_CHANNEL_ID: '',
			SLACK_GROWTH_REPORT_CHANNEL_ID: '',
			SLACK_GROWTH_REPORT_RANKING_ALPHA: undefined,
			MOBILIZE_CONTACT_NAME: '',
			MOBILIZE_CONTACT_EMAIL: '',
			MOBILIZE_CONTACT_PHONE: '',
		}));
		vi.resetModules();
		const { loadSettings: loadFresh } = await import('./settings.js');

		const db = makeDb();
		pushAllEmpty(db);

		const result = await loadFresh(db as never);

		expect(result).toEqual({
			chapterChannelMap: [],
			coalitionChannelMap: [],
			allowedSlackUserIds: new Set(),
			reportExcludedChapterIds: new Set(),
			welcomeDisabledChannelIds: new Set(),
			slackTrackingChannelId: '',
			slackGrowthReportChannelId: '',
			// Falls back to the growth-report channel, which is itself empty here.
			slackMobilizeSyncChannelId: '',
			// Falls back to the tracking channel, which is itself empty here.
			slackTurfChannelId: '',
			slackMemberNoteChannelId: '',
			mobilizeContactName: '',
			mobilizeContactEmail: '',
			mobilizeContactPhone: '',
			slackGrowthReportRankingAlpha: undefined,
			siteName: '',
			countdownLabel: '',
			countdownEndAt: '',
			welcomeDmMessage: '',
			warningDmMessage: '',
			// DB-only with no env fallback: an empty table means no commands
			// have been defined yet, which is the normal starting state.
			infoCommands: [],
			// DB-only with a code default, so it resolves even with no env and
			// no row — unlike the env-backed fields above.
			doorTickerColumnsPerSecond: DEFAULT_TICKER_COLUMNS_PER_SECOND,
			// Built-in defaults from $lib/van/checkout.ts when app_config is empty.
			vanTurfClaimTtlHours: 48,
			vanTurfMaxConcurrentClaims: 2,
		});

		// Restore the module-level mock for subsequent tests.
		vi.doUnmock('./env.js');
		vi.resetModules();
	});

	it('does not re-parse env on each call — imports the already-parsed constants', async () => {
		// The env module exposes constants, not functions. Calling loadSettings
		// twice must not produce two different env-parse passes; both calls see the
		// same imported reference for the env-fallback fields.
		const db1 = makeDb();
		pushAllEmpty(db1);
		const result1 = await loadSettings(db1 as never);

		const db2 = makeDb();
		pushAllEmpty(db2);
		const result2 = await loadSettings(db2 as never);

		expect(result1.chapterChannelMap).toBe(result2.chapterChannelMap);
		expect(result1.allowedSlackUserIds).toBe(result2.allowedSlackUserIds);
		expect(result1.reportExcludedChapterIds).toBe(result2.reportExcludedChapterIds);
	});
});

describe('loadSettings — Story 2 (typed contract under DB-override)', () => {
	it('DB rows override env for chapterChannelMap', async () => {
		const db = makeDb();
		db._pushSelect([
			{
				chapterId: 7,
				channelId: 'C_DB_CHAP',
				name: 'DB Chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);

		expect(result.chapterChannelMap).toEqual([
			{ chapterId: 7, channelId: 'C_DB_CHAP', name: 'DB Chapter' },
		]);
		// The coalition map is independent — its empty table stays empty.
		expect(result.coalitionChannelMap).toEqual([]);
	});

	it('DB rows populate coalitionChannelMap', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([
			{
				groupName: 'housing',
				channelId: 'C_DB_HOUS',
				name: 'Housing Justice',
				userListId: 88,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.coalitionChannelMap).toEqual([
			{ group: 'housing', channelId: 'C_DB_HOUS', name: 'Housing Justice', userListId: 88 },
		]);
	});

	it('DB rows override env for allowedSlackUserIds', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				slackUserId: 'U_DB_BOB',
				displayName: 'Bob',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.allowedSlackUserIds).toEqual(new Set(['U_DB_BOB']));
	});

	it('DB rows override env for reportExcludedChapterIds', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				chapterId: 42,
				reason: 'test chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.reportExcludedChapterIds).toEqual(new Set([42]));
	});

	it('app_config row with one populated field uses DB for that field and env for the other two NULLs', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: 'C_DB_TRACK',
				slackGrowthReportChannelId: null,
				slackGrowthReportRankingAlpha: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);

		const result = await loadSettings(db as never);
		expect(result.slackTrackingChannelId).toBe('C_DB_TRACK');
		expect(result.slackGrowthReportChannelId).toBe('C_ENV_GROWTH');
		expect(result.slackGrowthReportRankingAlpha).toBe(0.5);
	});

	it('slackMobilizeSyncChannelId falls back to the resolved growth-report channel', async () => {
		// NULL column, NULL growth column: both fall through to the env growth id
		// — where the sync alerts posted before the override existed.
		const db = makeDb();
		pushAllEmpty(db);
		expect((await loadSettings(db as never)).slackMobilizeSyncChannelId).toBe('C_ENV_GROWTH');

		// NULL column, growth overridden in the DB: follows the growth override,
		// not the env var it shadows.
		const db2 = makeDb();
		for (let i = 0; i < 5; i++) db2._pushSelect([]);
		db2._pushSelect([
			{
				id: 1,
				slackGrowthReportChannelId: 'C_DB_GROWTH',
				slackMobilizeSyncChannelId: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-27T00:00:00.000Z',
			},
		]);
		expect((await loadSettings(db2 as never)).slackMobilizeSyncChannelId).toBe('C_DB_GROWTH');

		// Own override set: wins over the growth channel, which stays put.
		const db3 = makeDb();
		for (let i = 0; i < 5; i++) db3._pushSelect([]);
		db3._pushSelect([
			{
				id: 1,
				slackGrowthReportChannelId: 'C_DB_GROWTH',
				slackMobilizeSyncChannelId: 'C_DB_MOBILIZE',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-27T00:00:00.000Z',
			},
		]);
		const result3 = await loadSettings(db3 as never);
		expect(result3.slackMobilizeSyncChannelId).toBe('C_DB_MOBILIZE');
		expect(result3.slackGrowthReportChannelId).toBe('C_DB_GROWTH');
	});

	it('slackTurfChannelId falls back to the resolved tracking channel', async () => {
		// NULL column, NULL tracking column: both fall through to the env tracking
		// id — where the turf sync alerts posted before the override existed.
		const db = makeDb();
		pushAllEmpty(db);
		expect((await loadSettings(db as never)).slackTurfChannelId).toBe('C_ENV_TRACK');

		// NULL column, tracking overridden in the DB: follows the tracking
		// override, not the env var it shadows.
		const db2 = makeDb();
		for (let i = 0; i < 5; i++) db2._pushSelect([]);
		db2._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: 'C_DB_TRACK',
				slackTurfChannelId: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-09-08T00:00:00.000Z',
			},
		]);
		expect((await loadSettings(db2 as never)).slackTurfChannelId).toBe('C_DB_TRACK');

		// Own override set: wins over the tracking channel, which stays put.
		const db3 = makeDb();
		for (let i = 0; i < 5; i++) db3._pushSelect([]);
		db3._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: 'C_DB_TRACK',
				slackTurfChannelId: 'C_DB_TURF',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-09-08T00:00:00.000Z',
			},
		]);
		const result3 = await loadSettings(db3 as never);
		expect(result3.slackTurfChannelId).toBe('C_DB_TURF');
		expect(result3.slackTrackingChannelId).toBe('C_DB_TRACK');
	});

	it('the Mobilize contact falls back per field, not all-or-nothing', async () => {
		// The event sync cannot write without a contact email, so a half-filled
		// row must still resolve the other fields from env rather than blanking
		// them.
		const db = makeDb();
		pushAllEmpty(db);
		const fromEnv = await loadSettings(db as never);
		expect(fromEnv.mobilizeContactName).toBe('Env Field Team');
		expect(fromEnv.mobilizeContactEmail).toBe('env-events@example.org');
		expect(fromEnv.mobilizeContactPhone).toBe('');

		const db2 = makeDb();
		for (let i = 0; i < 5; i++) db2._pushSelect([]);
		db2._pushSelect([
			{
				id: 1,
				mobilizeContactEmail: 'db-events@example.org',
				mobilizeContactName: null,
				mobilizeContactPhone: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-27T00:00:00.000Z',
			},
		]);
		const mixed = await loadSettings(db2 as never);
		expect(mixed.mobilizeContactEmail).toBe('db-events@example.org');
		expect(mixed.mobilizeContactName).toBe('Env Field Team');
	});

	it("an empty-string contact override means 'unset', not 'fall back to env'", async () => {
		// Clearing the field on /settings writes '' (the set-only contract
		// reserves NULL for "keep"), and that has to stick — otherwise the env
		// value silently comes back and the admin can never remove it.
		const db = makeDb();
		for (let i = 0; i < 5; i++) db._pushSelect([]);
		db._pushSelect([
			{
				id: 1,
				mobilizeContactName: '',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-27T00:00:00.000Z',
			},
		]);
		expect((await loadSettings(db as never)).mobilizeContactName).toBe('');
	});

	it('bundle has exactly the documented keys', async () => {
		const db = makeDb();
		pushAllEmpty(db);
		const result = await loadSettings(db as never);
		expect(Object.keys(result).sort()).toEqual(
			[
				'allowedSlackUserIds',
				'chapterChannelMap',
				'coalitionChannelMap',
				'reportExcludedChapterIds',
				'welcomeDisabledChannelIds',
				'slackGrowthReportChannelId',
				'slackGrowthReportRankingAlpha',
				'slackMobilizeSyncChannelId',
				'slackTurfChannelId',
				'slackMemberNoteChannelId',
				'slackTrackingChannelId',
				'mobilizeContactName',
				'mobilizeContactEmail',
				'mobilizeContactPhone',
				'siteName',
				'countdownLabel',
				'countdownEndAt',
				'welcomeDmMessage',
				'warningDmMessage',
				'infoCommands',
				'doorTickerColumnsPerSecond',
				'vanTurfClaimTtlHours',
				'vanTurfMaxConcurrentClaims',
			].sort(),
		);
	});

	it('countdown fields come from the app_config row and default to empty strings for NULL columns', async () => {
		const db = makeDb();
		for (let i = 0; i < 5; i++) db._pushSelect([]);
		db._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: null,
				slackGrowthReportChannelId: null,
				slackGrowthReportRankingAlpha: null,
				countdownLabel: 'Petition deadline',
				countdownEndAt: '2026-08-15T12:00:00.000Z',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-06T00:00:00.000Z',
			},
		]);

		const result = await loadSettings(db as never);
		expect(result.countdownLabel).toBe('Petition deadline');
		expect(result.countdownEndAt).toBe('2026-08-15T12:00:00.000Z');

		// NULL columns (or a missing row) mean "not configured" — no env fallback.
		const db2 = makeDb();
		for (let i = 0; i < 5; i++) db2._pushSelect([]);
		db2._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: null,
				slackGrowthReportChannelId: null,
				slackGrowthReportRankingAlpha: null,
				countdownLabel: null,
				countdownEndAt: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-06T00:00:00.000Z',
			},
		]);
		const result2 = await loadSettings(db2 as never);
		expect(result2.countdownLabel).toBe('');
		expect(result2.countdownEndAt).toBe('');
	});

	it('no module-level cache — two calls each hit the DB (7 reads × 2 = 14)', async () => {
		const db = makeDb();
		pushAllEmpty(db);
		pushAllEmpty(db);

		await loadSettings(db as never);
		await loadSettings(db as never);

		expect(db.select).toHaveBeenCalledTimes(14);
	});

	it('welcomeDisabledChannelIds contains only channels with the flag off', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				channelId: 'C_QUIET',
				showWelcomeMessage: false,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-06T00:00:00.000Z',
			},
			{
				channelId: 'C_LOUD',
				showWelcomeMessage: true,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-07-06T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.welcomeDisabledChannelIds).toEqual(new Set(['C_QUIET']));
	});

	it('chapter row shape matches ChapterEntry — keys chapterId/channelId/name', async () => {
		const db = makeDb();
		db._pushSelect([
			{
				chapterId: 5,
				channelId: 'C_DB_CHAP',
				name: 'Some Chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		const [entry] = result.chapterChannelMap;
		expect(Object.keys(entry!).sort()).toEqual(['channelId', 'chapterId', 'name']);
		expect(typeof entry!.chapterId).toBe('number');
		expect(typeof entry!.channelId).toBe('string');
		expect(typeof entry!.name).toBe('string');
	});
});

describe('settings setters — Story 3', () => {
	const editor = { id: 'U_ALICE', name: 'Alice' };
	const FROZEN = new Date('2026-05-17T12:00:00.000Z');

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FROZEN);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('saveChapterChannelEntries writes one multi-row upsert + audit columns and emits [settings] log', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveChapterChannelEntries(
			db as never,
			[
				{ chapterId: 7, name: 'Seven' },
				{ chapterId: 8, name: 'Eight' },
			],
			'C_X',
			editor,
		);

		// One statement for the whole batch — never one round-trip per chapter.
		const captured = db._capturedInserts();
		expect(captured).toHaveLength(1);
		expect(captured[0]!.table).toBe(chapterChannelMap);
		const rows = captured[0]!.values as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			chapterId: 7,
			channelId: 'C_X',
			name: 'Seven',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		expect(rows[1]).toMatchObject({ chapterId: 8, channelId: 'C_X', name: 'Eight' });
		const onConflict = captured[0]!.onConflict as { target: unknown; set: Record<string, unknown> };
		// Composite conflict target — a chapter can map to many channels, so the
		// upsert key is the (chapterId, channelId) pair and channelId is never in
		// the set clause. `name` is per-row via excluded.name, so it's SQL, not a
		// literal.
		expect(onConflict.target).toEqual([chapterChannelMap.chapterId, chapterChannelMap.channelId]);
		expect(onConflict.set).not.toHaveProperty('channelId');
		expect(onConflict.set.name).toBeDefined();
		expect(onConflict.set).toMatchObject({
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings\] saved chapter_channel_map .*U_ALICE.*Alice/),
		);
	});

	it('saveChapterChannelEntries is a no-op for an empty batch', async () => {
		const db = makeDb();
		await saveChapterChannelEntries(db as never, [], 'C_X', editor);
		expect(db._capturedInserts()).toHaveLength(0);
	});

	it('saveCoalitionEntry writes payload + audit columns', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveCoalitionEntry(
			db as never,
			{ group: 'labor', channelId: 'C_L', name: 'Labor Unions', userListId: 42 },
			editor,
		);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(coalitionChannelMap);
		expect(captured!.values).toMatchObject({
			groupName: 'labor',
			channelId: 'C_L',
			name: 'Labor Unions',
			userListId: 42,
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(coalitionChannelMap.groupName);
		expect(onConflict.set).toMatchObject({ name: 'Labor Unions', userListId: 42 });
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings\] saved coalition_channel_map .*U_ALICE/),
		);
	});

	it('saveAllowedUser writes payload + audit columns', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAllowedUser(db as never, { slackUserId: 'U_BOB', displayName: 'Bob' }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(allowedSlackUsers);
		expect(captured!.values).toMatchObject({
			slackUserId: 'U_BOB',
			displayName: 'Bob',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown };
		expect(onConflict.target).toBe(allowedSlackUsers.slackUserId);
	});

	it('saveExcludedChapter writes payload (with explicit null reason when omitted)', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveExcludedChapter(db as never, { chapterId: 99 }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(reportExcludedChapters);
		expect(captured!.values).toMatchObject({
			chapterId: 99,
			reason: null,
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown };
		expect(onConflict.target).toBe(reportExcludedChapters.chapterId);
	});

	it('saveExcludedChapter forwards a provided reason verbatim', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveExcludedChapter(db as never, { chapterId: 99, reason: 'internal-only' }, editor);

		const [captured] = db._capturedInserts();
		expect((captured!.values as { reason: string }).reason).toBe('internal-only');
	});

	it('delete setters call db.delete(table).where(eq(<pk>, key)) and log success', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await deleteChapterChannelEntries(db as never, [7], 'C_X', editor);
		await deleteCoalitionEntry(db as never, 'labor', editor);
		await deleteAllowedUser(db as never, 'U_BOB', editor);
		await deleteExcludedChapter(db as never, 99, editor);

		const captured = db._capturedDeletes();
		expect(captured).toHaveLength(4);
		expect(captured[0]!.table).toBe(chapterChannelMap);
		expect(captured[1]!.table).toBe(coalitionChannelMap);
		expect(captured[2]!.table).toBe(allowedSlackUsers);
		expect(captured[3]!.table).toBe(reportExcludedChapters);

		// Spot-check that the `where` arg references the PK column and key value.
		// Drizzle's `eq` returns an SQL object whose serialization carries the column
		// and value — we stringify with a WeakSet-based replacer (circular refs).
		function safeStringify(obj: unknown): string {
			const seen = new WeakSet();
			return JSON.stringify(obj, (_key, value: unknown) => {
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value as object)) return '[Circular]';
					seen.add(value as object);
				}
				return value;
			});
		}
		expect(safeStringify(captured[0]!.where)).toContain('chapter_id');
		expect(safeStringify(captured[0]!.where)).toContain('7');
		expect(safeStringify(captured[0]!.where)).toContain('channel_id');
		expect(safeStringify(captured[0]!.where)).toContain('C_X');
		expect(safeStringify(captured[1]!.where)).toContain('group_name');
		expect(safeStringify(captured[1]!.where)).toContain('labor');

		// All four delete log lines fired.
		const lines = log.mock.calls.map((c) => String(c[0]));
		expect(lines).toHaveLength(4);
		for (const line of lines) {
			expect(line).toMatch(/^\[settings\] deleted .*U_ALICE.*Alice/);
		}
	});

	it('setChannelWelcomeFlag upserts the flag row with audit columns and logs', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await setChannelWelcomeFlag(db as never, 'C_QUIET', false, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(channelWelcomeFlags);
		expect(captured!.values).toMatchObject({
			channelId: 'C_QUIET',
			showWelcomeMessage: false,
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(channelWelcomeFlags.channelId);
		expect(onConflict.set).toMatchObject({ showWelcomeMessage: false });
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings\] saved channel_welcome_flags .*show=false.*U_ALICE/),
		);
	});

	it('saveAppConfig rejects unknown patch keys synchronously (before any DB call)', async () => {
		const db = makeDb();
		await expect(
			saveAppConfig(db as never, { someUnknownKey: 'x' } as never, editor),
		).rejects.toThrow(/unknown patch key "someUnknownKey"/);
		expect(db.insert).not.toHaveBeenCalled();
	});

	it('saveAppConfig partial patch builds a set clause containing only the present keys + audit', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(db as never, { slackTrackingChannelId: 'C_X' }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(appConfig);
		expect(captured!.values).toMatchObject({
			id: 1,
			slackTrackingChannelId: 'C_X',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(appConfig.id);
		expect(Object.keys(onConflict.set).sort()).toEqual([
			'lastEditedAt',
			'lastEditedBy',
			'lastEditedByName',
			'slackTrackingChannelId',
		]);
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportChannelId');
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportRankingAlpha');
	});

	it('saveAppConfig accepts the countdown keys, including empty-string clears', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(db as never, { countdownLabel: 'Deadline', countdownEndAt: '' }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.values).toMatchObject({
			id: 1,
			countdownLabel: 'Deadline',
			countdownEndAt: '',
		});
		const onConflict = captured!.onConflict as { set: Record<string, unknown> };
		expect(onConflict.set).toMatchObject({ countdownLabel: 'Deadline', countdownEndAt: '' });
		expect(onConflict.set).not.toHaveProperty('slackTrackingChannelId');
	});

	it('saveAppConfig treats null and undefined patch values as ABSENT (set-only contract)', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(
			db as never,
			{
				slackTrackingChannelId: 'C_X',
				slackGrowthReportChannelId: null as never,
				slackGrowthReportRankingAlpha: undefined,
			},
			editor,
		);

		const [captured] = db._capturedInserts();
		expect(captured!.values).not.toHaveProperty('slackGrowthReportChannelId');
		expect(captured!.values).not.toHaveProperty('slackGrowthReportRankingAlpha');
		const onConflict = captured!.onConflict as { set: Record<string, unknown> };
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportChannelId');
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportRankingAlpha');
	});

	it('saveAppConfig emits the [settings] log line with comma-separated patch keys', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(
			db as never,
			{ slackTrackingChannelId: 'C_X', slackGrowthReportChannelId: 'C_Y' },
			editor,
		);

		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\[settings\] saved app_config patch=.*slackTrackingChannelId.*slackGrowthReportChannelId.*by U_ALICE \(Alice\)/,
			),
		);
	});

	it('round-trip: after a save, the next loadSettings returns the new value', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveChapterChannelEntries(db as never, [{ chapterId: 11, name: 'New' }], 'C_NEW', editor);

		// Pre-queue the rows the next loadSettings will read — chapter row reflects
		// the save, the other four tables are empty.
		db._pushSelect([
			{
				chapterId: 11,
				channelId: 'C_NEW',
				name: 'New',
				lastEditedBy: 'U_ALICE',
				lastEditedByName: 'Alice',
				lastEditedAt: FROZEN.toISOString(),
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.chapterChannelMap).toEqual([{ chapterId: 11, channelId: 'C_NEW', name: 'New' }]);
	});
});

describe('ensureChapterChannelMapSeeded', () => {
	it('copies every env entry into the table when it is empty, attributed to SYSTEM_EDITOR, race-tolerantly', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		db._pushSelect([]);

		await ensureChapterChannelMapSeeded(db as never);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(chapterChannelMap);
		// onConflictDoNothing, not a bare insert — a concurrent first edit may
		// seed between our emptiness check and this insert.
		expect(captured!.onConflict).toBe('do-nothing');
		const rows = captured!.values as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			chapterId: 1,
			channelId: 'C_ENV_CHAP',
			name: 'Env Chapter',
			lastEditedBy: SYSTEM_EDITOR.id,
			lastEditedByName: SYSTEM_EDITOR.name,
		});
	});

	it('is a no-op when the table already has rows', async () => {
		const db = makeDb();
		db._pushSelect([{ chapterId: 7 }]);

		await ensureChapterChannelMapSeeded(db as never);

		expect(db._capturedInserts()).toHaveLength(0);
	});
});

describe('ensureAllowedUsersSeeded', () => {
	it('copies every env id into the table when it is empty, resolving display names from the provided map', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		db._pushSelect([]);

		await ensureAllowedUsersSeeded(db as never, new Map([['U_ENV_ALICE', 'Alice']]));

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(allowedSlackUsers);
		expect(captured!.onConflict).toBe('do-nothing');
		const rows = captured!.values as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			slackUserId: 'U_ENV_ALICE',
			displayName: 'Alice',
			lastEditedBy: SYSTEM_EDITOR.id,
			lastEditedByName: SYSTEM_EDITOR.name,
		});
	});

	it('falls back to the raw id as displayName when no name is known', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		db._pushSelect([]);

		await ensureAllowedUsersSeeded(db as never);

		const [captured] = db._capturedInserts();
		const rows = captured!.values as Record<string, unknown>[];
		expect(rows[0]).toMatchObject({ slackUserId: 'U_ENV_ALICE', displayName: 'U_ENV_ALICE' });
	});

	it('is a no-op when the table already has rows', async () => {
		const db = makeDb();
		db._pushSelect([{ slackUserId: 'U_DB' }]);

		await ensureAllowedUsersSeeded(db as never);

		expect(db._capturedInserts()).toHaveLength(0);
	});
});

describe('ensureExcludedChaptersSeeded', () => {
	it('copies every env id into the table when it is empty, with a NULL reason', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		db._pushSelect([]);

		await ensureExcludedChaptersSeeded(db as never);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(reportExcludedChapters);
		expect(captured!.onConflict).toBe('do-nothing');
		const rows = captured!.values as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			chapterId: 99,
			reason: null,
			lastEditedBy: SYSTEM_EDITOR.id,
			lastEditedByName: SYSTEM_EDITOR.name,
		});
	});

	it('is a no-op when the table already has rows', async () => {
		const db = makeDb();
		db._pushSelect([{ chapterId: 42 }]);

		await ensureExcludedChaptersSeeded(db as never);

		expect(db._capturedInserts()).toHaveLength(0);
	});
});

describe('app_config singleton CHECK constraint — Story 3 (FR-022)', () => {
	it('rejects a second insert against an in-memory libSQL with the real migration', async () => {
		const { createClient } = await import('@libsql/client');
		const fs = await import('node:fs');
		const path = await import('node:path');

		// Discover the migration filename — the auto-slug picked by drizzle-kit
		// generate is non-deterministic, so anyone regenerating gets a new slug.
		const drizzleDir = path.resolve('drizzle');
		const file = fs
			.readdirSync(drizzleDir)
			.find((f) => f.startsWith('0005_') && f.endsWith('.sql'));
		expect(file).toBeDefined();
		const sqlText = fs.readFileSync(path.join(drizzleDir, file!), 'utf-8');

		const client = createClient({ url: ':memory:' });
		try {
			await client.executeMultiple(sqlText);

			await client.execute({
				sql: 'INSERT INTO app_config (id, last_edited_by, last_edited_by_name, last_edited_at) VALUES (?, ?, ?, ?)',
				args: [1, 'U_X', 'X', '2026-05-17T00:00:00.000Z'],
			});

			await expect(
				client.execute({
					sql: 'INSERT INTO app_config (id, last_edited_by, last_edited_by_name, last_edited_at) VALUES (?, ?, ?, ?)',
					args: [2, 'U_Y', 'Y', '2026-05-17T00:00:01.000Z'],
				}),
			).rejects.toThrow();
		} finally {
			client.close();
		}
	});
});
