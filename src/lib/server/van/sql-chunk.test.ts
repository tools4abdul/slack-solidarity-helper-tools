import { describe, it, expect } from 'vitest';
import { chunked, idRows, SQL_BATCH_SIZE } from './sql-chunk.js';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

describe('chunked', () => {
	it('returns nothing for an empty list', () => {
		expect(chunked([])).toEqual([]);
	});

	it('leaves a short list in one batch', () => {
		expect(chunked([1, 2, 3])).toEqual([[1, 2, 3]]);
	});

	it('splits at the batch size', () => {
		const ids = Array.from({ length: SQL_BATCH_SIZE * 2 + 7 }, (_, i) => i);
		const batches = chunked(ids);
		expect(batches).toHaveLength(3);
		expect(batches[0]).toHaveLength(SQL_BATCH_SIZE);
		expect(batches[2]).toHaveLength(7);
	});

	it('loses nothing and reorders nothing', () => {
		const ids = Array.from({ length: 1234 }, (_, i) => i);
		expect(chunked(ids).flat()).toEqual(ids);
	});

	// The point of the module: one statement per batch has to stay under
	// SQLite's oldest bound-parameter cap, not merely the current one.
	it('stays under the 999-parameter limit of older SQLite builds', () => {
		expect(SQL_BATCH_SIZE).toBeLessThan(999);
	});

	it('honours an explicit size', () => {
		expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});
});

describe('idRows', () => {
	it('gives the ids back as rows, from one parameter', async () => {
		const client = createClient({ url: ':memory:' });
		const db = drizzle(client);
		const rows = await db.all<{ value: number }>(idRows([3, 1, 2]));
		expect(rows.map((r) => r.value)).toEqual([3, 1, 2]);
		client.close();
	});

	it('refuses anything but integers', () => {
		expect(() => idRows([1, 1.5])).toThrow('integer ids only');
	});
});
