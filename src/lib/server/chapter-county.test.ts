import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { loadCountyByChapterName } from './chapter-county.js';

let client: Client;
let db: LibSQLDatabase<Record<string, unknown>>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await client.execute(`CREATE TABLE zip_chapter_map (
		zip_code text PRIMARY KEY,
		chapter_id integer NOT NULL,
		member_count integer DEFAULT 0 NOT NULL,
		updated_at text NOT NULL
	)`);
	await client.execute(`CREATE TABLE solidarity_daily_snapshots (
		date text NOT NULL,
		chapter_id integer NOT NULL,
		chapter_name text,
		count integer DEFAULT 0 NOT NULL
	)`);
});

afterEach(() => client.close());

async function seedZips(rows: Array<[zip: string, chapterId: number, memberCount: number]>) {
	for (const [zip, chapterId, memberCount] of rows) {
		await client.execute({
			sql: 'INSERT INTO zip_chapter_map VALUES (?, ?, ?, ?)',
			args: [zip, chapterId, memberCount, '2026-08-01T00:00:00.000Z'],
		});
	}
}

async function seedChapterNames(rows: Array<[chapterId: number, name: string]>) {
	for (const [chapterId, name] of rows) {
		await client.execute({
			sql: 'INSERT INTO solidarity_daily_snapshots VALUES (?, ?, ?, ?)',
			args: ['2026-08-01', chapterId, name, 0],
		});
	}
}

describe('loadCountyByChapterName', () => {
	it('returns an empty map when nothing has been recorded', async () => {
		expect(await loadCountyByChapterName(db)).toEqual(new Map());
	});

	it('maps a chapter to the county with the most member weight', async () => {
		// Detroit chapter's zips: mostly Wayne (48201, weight 10), a little Oakland (48009, weight 2).
		await seedZips([
			['48201', 1, 10],
			['48009', 1, 2],
		]);
		await seedChapterNames([[1, 'Detroit']]);

		const map = await loadCountyByChapterName(db);
		expect(map.get('detroit')).toBe('Wayne');
	});

	it('ignores zips with no known county and chapters with no zip data', async () => {
		await seedZips([['00000', 1, 5]]);
		await seedChapterNames([
			[1, 'Unmapped Zip Chapter'],
			[2, 'No Zip Data Chapter'],
		]);

		const map = await loadCountyByChapterName(db);
		expect(map.size).toBe(0);
	});

	it('keys the result by lowercased chapter name', async () => {
		await seedZips([['49503', 1, 3]]);
		await seedChapterNames([[1, 'Grand Rapids']]);

		const map = await loadCountyByChapterName(db);
		expect(map.get('grand rapids')).toBe('Kent');
		expect(map.has('Grand Rapids')).toBe(false);
	});
});
