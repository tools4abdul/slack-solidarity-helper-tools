import { describe, afterEach, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { replaceRoster, upsertContacts } from './contact-sync.js';
import { createPersonHasher } from './person-hash.js';
import {
	countDoorsByTurf,
	dailyReportCampaigns,
	runDailyDoorReport,
	type DailyReportDeps,
} from './daily-door-report.js';
import { vanCampaigns, type VanCampaignRow } from '../schema.js';
import type { SheetsClient } from '../google/sheets.js';
import { campaignDayBounds } from '../../campaign-time.js';

// A real in-memory libsql, as in contact-sync.test.ts: the count is one window
// query over blob-keyed tables, and a stub would let it say anything.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const hasher = createPersonHasher('test-secret');
const DAY = '2026-10-07';
const BOUNDS = campaignDayBounds(DAY)!;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

async function turf(
	turfId: number,
	over: {
		folderId?: number;
		name?: string;
		campaignId?: number;
		cutAt?: string;
		retiredAt?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, name,
		         region_name, saved_list_id, door_count, first_seen_at, last_seen_at, cut_at, retired_at)
		      VALUES (?1, ?, ?1, 1, ?, 1, ?, 'R01A_Alger', 900, 99, ?, ?, ?, ?)`,
		args: [
			turfId,
			over.campaignId ?? 1,
			over.folderId ?? 10,
			over.name ?? `Turf ${turfId}`,
			'2026-09-15T00:00:00.000Z',
			'2026-10-07T00:00:00.000Z',
			over.cutAt ?? '2026-09-20T00:00:00.000Z',
			over.retiredAt ?? null,
		],
	});
}

async function roster(turfId: number, people: Record<string, string>) {
	await replaceRoster(
		db,
		turfId,
		900,
		Object.entries(people).map(([id, address]) => ({
			personHash: hasher.person(id),
			doorHash: hasher.door(address, '48201'),
		})),
	);
}

async function contact(vanId: string, at: string, campaignId = 1) {
	await upsertContacts(
		db,
		campaignId,
		new Map([[vanId, { personHash: hasher.person(vanId), at }]]),
	);
}

const count = () => countDoorsByTurf(db, { campaignId: 1, ...BOUNDS });

describe('countDoorsByTurf', () => {
	it('counts a door once however many of its people were contacted', async () => {
		await turf(1);
		await roster(1, { a: '1 Main St', b: '1 Main St', c: '2 Main St', d: '3 Main St' });
		await contact('a', '2026-10-07T18:00:00.000Z');
		await contact('b', '2026-10-07T19:00:00.000Z');
		await contact('c', '2026-10-07T20:00:00.000Z');

		const { turfs } = await count();
		expect(turfs).toEqual([
			{ turfId: 1, folderId: 10, turfName: 'Turf 1', regionName: 'R01A_Alger', doors: 2 },
		]);
	});

	// Detroit midnight is 04:00 UTC in October; 23:59 local is 03:59 UTC next day.
	it('takes the campaign-local day, not the UTC one', async () => {
		await turf(1);
		await roster(1, { a: '1 Main St', b: '2 Main St', c: '3 Main St', d: '4 Main St' });
		await contact('a', '2026-10-07T03:59:00.000Z'); // 11:59pm the day before
		await contact('b', '2026-10-07T04:00:00.000Z'); // midnight
		await contact('c', '2026-10-08T03:59:00.000Z'); // 11:59pm
		await contact('d', '2026-10-08T04:00:00.000Z'); // midnight after

		expect((await count()).turfs[0]?.doors).toBe(2);
	});

	// VAN re-cut at 4pm; our sync noticed at 4:30. A knock at 4:10 looks live on
	// both, but the new route could not have been handed out yet.
	it('gives a knock in the gap before a re-cut is noticed to the older route', async () => {
		await turf(1, { retiredAt: '2026-10-07T20:30:00.000Z' });
		await turf(2, { cutAt: '2026-10-07T20:00:00.000Z' });
		await roster(1, { a: '1 Main St' });
		await roster(2, { a: '1 Main St' });
		await contact('a', '2026-10-07T20:10:00.000Z');

		expect((await count()).turfs.map((t) => [t.turfId, t.doors])).toEqual([[1, 1]]);
	});

	// A contact VAN dated before either route was cut (a canvass entered
	// late, against an older cut): neither was being walked, so the live one.
	it('falls back to the live route when neither was live at the knock', async () => {
		await turf(1, { cutAt: '2026-10-07T17:00:00.000Z', retiredAt: '2026-10-07T18:00:00.000Z' });
		await turf(2, { cutAt: '2026-10-07T18:00:00.000Z' });
		await roster(1, { a: '1 Main St' });
		await roster(2, { a: '1 Main St' });
		await contact('a', '2026-10-07T16:00:00.000Z');

		expect((await count()).turfs.map((t) => [t.turfId, t.doors])).toEqual([[2, 1]]);
	});

	// Walked at 3pm, marked walked, re-cut at 4pm: the doors are the walked
	// route's, though the replacement covers them too and is the live one.
	it('puts a door on the route that was live when it was knocked', async () => {
		await turf(1, { retiredAt: '2026-10-07T20:00:00.000Z' });
		await turf(2, { cutAt: '2026-10-07T20:00:00.000Z' });
		await roster(1, { a: '1 Main St', b: '2 Main St' });
		await roster(2, { a: '1 Main St', b: '2 Main St' });
		await contact('a', '2026-10-07T19:00:00.000Z');
		await contact('b', '2026-10-07T21:00:00.000Z'); // after the re-cut

		const byTurf = Object.fromEntries((await count()).turfs.map((t) => [t.turfId, t.doors]));
		expect(byTurf).toEqual({ 1: 1, 2: 1 });
	});

	it("counts people on no turf's list as people, and ignores other campaigns", async () => {
		await turf(1);
		await turf(2, { campaignId: 2 });
		await roster(1, { a: '1 Main St' });
		await roster(2, { z: '9 Main St' });
		await contact('a', '2026-10-07T18:00:00.000Z');
		await contact('x', '2026-10-07T18:00:00.000Z');
		await contact('y', '2026-10-07T18:00:00.000Z');
		await contact('z', '2026-10-07T18:00:00.000Z', 2);

		const result = await count();
		expect(result.turfs.map((t) => t.turfId)).toEqual([1]);
		expect(result.peopleOutsideTurfs).toBe(2);
	});
});

describe('dailyReportCampaigns', () => {
	it('is the enabled campaigns with a spreadsheet', async () => {
		expect(await dailyReportCampaigns(db)).toEqual([]);
		await db
			.update(vanCampaigns)
			.set({ dailyReportSpreadsheetId: 'sheet-abc' })
			.where(eq(vanCampaigns.id, 1));
		expect((await dailyReportCampaigns(db)).map((c) => c.id)).toEqual([1]);
		await db.update(vanCampaigns).set({ enabled: false }).where(eq(vanCampaigns.id, 1));
		expect(await dailyReportCampaigns(db)).toEqual([]);
	});
});

describe('runDailyDoorReport', () => {
	let replaceTab: Mock<SheetsClient['replaceTab']>;
	let post: Mock<DailyReportDeps['post']>;
	let campaign: VanCampaignRow;

	function deps(over: Partial<DailyReportDeps> = {}): DailyReportDeps {
		return {
			db,
			sheets: { ok: true, client: { replaceTab } as unknown as SheetsClient },
			folderNames: async () => new Map([[10, 'Alger County']]),
			post,
			serviceAccountEmail: 'report@example.iam.gserviceaccount.com',
			now: () => new Date('2026-10-08T02:00:00.000Z'),
			...over,
		};
	}

	beforeEach(async () => {
		replaceTab = vi
			.fn<SheetsClient['replaceTab']>()
			.mockResolvedValue({ ok: true, value: { sheetId: 42 } });
		post = vi.fn<DailyReportDeps['post']>().mockResolvedValue(true);
		await db
			.update(vanCampaigns)
			.set({ label: 'Main', dailyReportSpreadsheetId: 'sheet-abc' })
			.where(eq(vanCampaigns.id, 1));
		[campaign] = await db.select().from(vanCampaigns).where(eq(vanCampaigns.id, 1));
		await turf(1, { name: 'Turf 1' });
		await roster(1, { a: '1 Main St', b: '2 Main St' });
		await contact('a', '2026-10-07T18:00:00.000Z');
		await contact('b', '2026-10-07T18:30:00.000Z');
	});

	it("writes the day's tab and posts the totals with a link to it", async () => {
		const result = await runDailyDoorReport(deps(), campaign, { day: DAY, announce: true });

		expect(result).toMatchObject({ doors: 2, turfs: 1, folders: 1, written: true, posted: true });
		const [{ spreadsheetId, tabName, rows }] = replaceTab.mock.calls[0]!;
		expect({ spreadsheetId, tabName }).toEqual({ spreadsheetId: 'sheet-abc', tabName: DAY });
		expect(rows).toContainEqual({ cells: ['Alger County', 'Turf 1', 'R01A_Alger', 2] });
		const text = post.mock.calls[0]![0] as string;
		expect(text).toContain('*2* doors on 1 turf in 1 folder');
		expect(text).toContain('https://docs.google.com/spreadsheets/d/sheet-abc/edit#gid=42');
	});

	it('posts nothing on the morning rewrite', async () => {
		const result = await runDailyDoorReport(deps(), campaign, { day: DAY, announce: false });
		expect(result.written).toBe(true);
		expect(post).not.toHaveBeenCalled();
	});

	it('names a folder by id when VAN cannot be asked', async () => {
		await runDailyDoorReport(
			deps({ folderNames: () => Promise.reject(new Error('VAN down')) }),
			campaign,
			{ day: DAY, announce: false },
		);
		expect(replaceTab.mock.calls[0]![0].rows).toContainEqual({
			cells: ['Folder 10', 'Turf 1', 'R01A_Alger', 2],
		});
	});

	it('alerts the turf channel when the spreadsheet cannot be written', async () => {
		replaceTab.mockResolvedValue({ ok: false, status: 403, error: 'no permission' });
		const result = await runDailyDoorReport(deps(), campaign, { day: DAY, announce: true });

		expect(result).toMatchObject({ written: false, posted: false });
		expect(result.error).toContain('403');
		expect(post).toHaveBeenCalledTimes(1);
		expect(post.mock.calls[0]![0]).toContain('report@example.iam.gserviceaccount.com');
	});

	it('reads the newest contacts before counting, and counts anyway when that fails', async () => {
		const refreshContacts = vi.fn(async () => {
			await contact('c', '2026-10-07T21:00:00.000Z');
		});
		await roster(1, { a: '1 Main St', b: '2 Main St', c: '3 Main St' });
		const result = await runDailyDoorReport(deps({ refreshContacts }), campaign, {
			day: DAY,
			announce: false,
		});
		expect(refreshContacts).toHaveBeenCalledWith(campaign);
		expect(result.doors).toBe(3);

		const failing = await runDailyDoorReport(
			deps({ refreshContacts: () => Promise.reject(new Error('VAN down')) }),
			campaign,
			{ day: DAY, announce: false },
		);
		expect(failing).toMatchObject({ doors: 3, written: true });
	});

	it('refuses to overwrite a tab it does not own, and says so', async () => {
		replaceTab.mockResolvedValue({ ok: false, status: 409, error: 'not ours' });
		await runDailyDoorReport(deps(), campaign, { day: DAY, announce: true });
		expect(replaceTab.mock.calls[0]![0]).toMatchObject({
			ownedPrefix: 'Doors contacted · ',
			columnWidths: [220, 220, 200, 120],
		});
		expect(post.mock.calls[0]![0]).toContain('could not be written');
		// Not an access problem, so no advice about sharing.
		expect(post.mock.calls[0]![0]).not.toContain('shared with');
	});

	it('writes nothing on a dry run', async () => {
		const result = await runDailyDoorReport(deps(), campaign, {
			day: DAY,
			announce: true,
			dryRun: true,
		});
		expect(result.rows?.length).toBeGreaterThan(0);
		expect(replaceTab).not.toHaveBeenCalled();
		expect(post).not.toHaveBeenCalled();
	});
});
