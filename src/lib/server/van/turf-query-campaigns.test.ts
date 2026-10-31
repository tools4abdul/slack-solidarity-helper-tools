import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadChapterTurfs } from './turf-query.js';

// A disabled campaign's turf leaves the map and /turfs
// (specs/012-multi-van-campaigns), except turf the viewer is still walking.
// On a real in-memory database, because the filter is SQL: the scripted db in
// turf-query.test.ts would answer the same whatever the WHERE said.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const VIEWER = { slackUserId: 'U_VOL', isAdmin: false };
const NOW = new Date('2026-10-01T18:00:00.000Z');

async function campaign(id: number, enabled: boolean) {
	await client.execute({
		sql: `INSERT INTO van_campaigns
		        (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, 'test', 'test', 'x')
		      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`,
		args: [id, `campaign${id}`, enabled ? 1 : 0],
	});
	// Chapter 71 sees folder 1 in every campaign.
	await client.execute({
		sql: `INSERT INTO van_chapter_folders
		        (campaign_id, chapter_id, folder_id, chapter_name,
		         last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, 71, 1, 'Wayne County', 'test', 'test', 'x')`,
		args: [id],
	});
}

async function turf(turfId: number, campaignId: number) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, printed_list_number, route_size, door_count,
		         first_seen_at, last_seen_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', 'R10C_Wayne', ?3, '1-1', 120, 50,
		              'x', 'x')`,
		args: [turfId, campaignId, `Turf ${turfId}`],
	});
}

async function claim(turfId: number) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
		      VALUES (?, 'U_VOL', 'Dana', '2026-10-01T12:00:00.000Z', '2026-10-03T12:00:00.000Z')`,
		args: [turfId],
	});
}

const idsOf = (r: { turfs: Array<{ turfId: number }> }) => r.turfs.map((t) => t.turfId).sort();

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await campaign(1, true);
	await campaign(2, false);
	await turf(100, 1);
	await turf(200, 2);
	await turf(201, 2);
});

describe('a disabled campaign’s turf', () => {
	it('is not offered', async () => {
		const result = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW });
		expect(idsOf(result)).toEqual([100]);
	});

	// Disabling stops new claims, not the ones in progress: a volunteer halfway
	// down a street still needs the turf on their map.
	it('stays visible to the volunteer holding it', async () => {
		await claim(201);
		const result = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			now: NOW,
			includeHeldByViewer: true,
		});
		expect(idsOf(result)).toEqual([100, 201]);
	});

	it('comes back when the campaign is enabled again', async () => {
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		const result = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW });
		expect(idsOf(result)).toEqual([100, 200, 201]);
	});
});

// Which campaign each turf is from (specs/012-multi-van-campaigns, Phase 6):
// shown while more than one campaign is enabled, and always on turf from a
// disabled one. The text travels once per payload, not on every row.
describe('campaign badges', () => {
	const load = (over: { includeHeldByViewer?: boolean } = {}) =>
		loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW, ...over });

	it('shows none while only one campaign is enabled', async () => {
		const result = await load();
		expect(result.turfs.map((t) => t.campaignId)).toEqual([undefined]);
		expect(result.campaignBadges).toBeNull();
	});

	it('badges every turf once a second campaign is enabled', async () => {
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		const result = await load();
		expect(Object.fromEntries(result.turfs.map((t) => [t.turfId, t.campaignId]))).toEqual({
			100: 1,
			200: 2,
			201: 2,
		});
		expect(result.campaignBadges).toEqual({ 1: 'primary', 2: 'campaign2' });
	});

	// The campaign filter's "Showing N of T": T is the picked campaign's share
	// of the chapter, not the whole chapter's, even past the payload cut.
	it('splits the chapter total by campaign, beside the badges', async () => {
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		const result = await load();
		expect(result.total).toBe(3);
		expect(result.campaignTotals).toEqual({ 1: 1, 2: 2 });

		const cut = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW, limit: 2 });
		expect(cut.turfs).toHaveLength(2);
		expect(cut.campaignTotals).toEqual({ 1: 1, 2: 2 });
	});

	it('sends no split while only one campaign is enabled', async () => {
		expect((await load()).campaignTotals).toBeNull();
	});

	it('uses the badge text, then the name, then the key', async () => {
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		await client.execute(
			`UPDATE van_campaigns SET label = 'One Team Michigan', badge_label = 'OTM' WHERE id = 1`,
		);
		await client.execute(
			`UPDATE van_campaigns SET label = 'El-Sayed', badge_label = '  ' WHERE id = 2`,
		);
		expect((await load()).campaignBadges).toEqual({ 1: 'OTM', 2: 'El-Sayed' });
	});

	it('names only the campaigns on the page', async () => {
		await campaign(3, true);
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		expect(Object.keys((await load()).campaignBadges ?? {})).toEqual(['1', '2']);
	});

	// With the partner disabled only one campaign is left enabled, so badges are
	// off — but the volunteer still holding partner turf needs to see whose it is.
	it('badges turf from a disabled campaign for its holder, and says it was disabled', async () => {
		await claim(201);
		const result = await load({ includeHeldByViewer: true });
		const held = result.turfs.find((t) => t.turfId === 201)!;
		expect(held).toMatchObject({ campaignId: 2, campaignDisabled: true });
		expect(result.turfs.find((t) => t.turfId === 100)!.campaignId).toBeUndefined();
		expect(result.campaignBadges).toEqual({ 2: 'campaign2' });
	});
});

// Which rows the turf read picks: the chapter's live turf by its folders and
// its placements, and the viewer's own wherever the chapter can see it.
describe('the turf a chapter sees', () => {
	const load = (over: { includeHeldByViewer?: boolean; isAdmin?: boolean } = {}) =>
		loadChapterTurfs(db, {
			chapterId: 71,
			viewer: { ...VIEWER, isAdmin: over.isAdmin ?? false },
			now: NOW,
			includeHeldByViewer: over.includeHeldByViewer,
		});

	async function placed(turfId: number, chapterId: number) {
		// Folder 9 is mapped to no chapter: its turf is seen only where placed.
		await client.execute({
			sql: `INSERT INTO van_turfs
			        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
			         chapter_name, region_name, name, printed_list_number, route_size, door_count,
			         first_seen_at, last_seen_at)
			      VALUES (?1, 1, ?1, 1, 9, 0, '', 'R1', ?2, '1-1', 120, 50, 'x', 'x')`,
			args: [turfId, `Turf ${turfId}`],
		});
		await client.execute({
			sql: `INSERT INTO van_turf_placements (turf_id, chapter_id, chapter_name, source, placed_at)
			      VALUES (?, ?, 'Wayne County', 'zip', 'x')`,
			args: [turfId, chapterId],
		});
	}

	it('includes turf placed in the chapter, and not turf placed in another', async () => {
		await placed(300, 71);
		await placed(301, 72);
		expect(idsOf(await load())).toEqual([100, 300]);
	});

	it('leaves out retired turf, unless the viewer holds it', async () => {
		await turf(101, 1);
		await turf(102, 1);
		await client.execute(`UPDATE van_turfs SET retired_at = 'x' WHERE turf_id IN (101, 102)`);
		await claim(101);
		expect(idsOf(await load())).toEqual([100]);
		expect(idsOf(await load({ includeHeldByViewer: true }))).toEqual([100, 101]);
	});

	it('shows hidden turf to admins and to its holder alone', async () => {
		await turf(101, 1);
		await turf(102, 1);
		await client.execute(`UPDATE van_turfs SET hidden_at = 'x' WHERE turf_id IN (101, 102)`);
		await claim(101);
		expect(idsOf(await load())).toEqual([100]);
		expect(idsOf(await load({ includeHeldByViewer: true }))).toEqual([100, 101]);
		expect(idsOf(await load({ isAdmin: true }))).toEqual([100, 101, 102]);
	});

	// Held turf is the viewer's wherever it is, but this chapter's page shows
	// only what this chapter can see.
	it('does not bring in turf the viewer holds in another chapter', async () => {
		await placed(301, 72);
		await claim(301);
		expect(idsOf(await load({ includeHeldByViewer: true }))).toEqual([100]);
	});

	// Folder ids are VAN's, unique only within one campaign.
	it('matches a folder by campaign as well as number', async () => {
		await client.execute(`UPDATE van_campaigns SET enabled = 1 WHERE id = 2`);
		await client.execute(`DELETE FROM van_chapter_folders WHERE campaign_id = 2`);
		expect(idsOf(await load())).toEqual([100]);
	});
});
