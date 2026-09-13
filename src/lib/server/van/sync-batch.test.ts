import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { inArray } from 'drizzle-orm';
import { vanTurfs, vanTurfCheckouts } from '../schema.js';

// The retirement group in sync.ts is applied as one libsql batch, and
// sync.test.ts checks it against a stub — which can prove what the module asks
// for but not that the driver does it. This file is the other half: a real
// in-memory libsql, exercising the two assumptions the counting logic rests on.
//
// Worth its own file rather than a note in a comment, because a drizzle or
// libsql upgrade that changed either assumption would otherwise surface as
// claimsReleased silently reading zero, or as a retirement that half applied.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_turfs
		   (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name,
		    name, door_count, first_seen_at, last_seen_at)
		 VALUES (100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 01', 5, 'x', 'x')`,
	);
	await client.execute(
		`INSERT INTO van_turf_checkouts
		   (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at)
		 VALUES (100, 'U1', 'Dana', '2026-09-12T10:00:00.000Z', '2026-09-14T10:00:00.000Z')`,
	);
});

describe('the retirement batch, against a real libsql', () => {
	it('applies every statement and returns their rows in order', async () => {
		const statements = [
			db
				.update(vanTurfs)
				.set({ retiredAt: 'now' })
				.where(inArray(vanTurfs.mapRouteId, [100])),
			db
				.update(vanTurfCheckouts)
				.set({ releasedAt: 'now', releaseReason: 'retired' })
				.where(inArray(vanTurfCheckouts.mapRouteId, [100]))
				.returning({ id: vanTurfCheckouts.id }),
		];

		const results = (await db.batch(
			statements as unknown as Parameters<typeof db.batch>[0],
		)) as unknown as unknown[][];

		// Positional: sync.ts counts released claims by slicing this array, so a
		// driver that reordered or flattened results would miscount silently.
		expect(results[1]).toEqual([{ id: 1 }]);

		const turf = await client.execute('SELECT retired_at FROM van_turfs');
		const claim = await client.execute('SELECT release_reason FROM van_turf_checkouts');
		expect(turf.rows[0].retired_at).toBe('now');
		expect(claim.rows[0].release_reason).toBe('retired');
	});

	it('leaves nothing behind when one statement in the group fails', async () => {
		// The point of the batch: a reader never sees a turf retired with its
		// claim still live, or the reverse.
		const statements = [
			db
				.update(vanTurfs)
				.set({ retiredAt: 'now' })
				.where(inArray(vanTurfs.mapRouteId, [100])),
			db.run('UPDATE van_turf_checkouts SET nope = 1'),
		];

		await expect(
			db.batch(statements as unknown as Parameters<typeof db.batch>[0]),
		).rejects.toThrow();

		const turf = await client.execute('SELECT retired_at FROM van_turfs');
		expect(turf.rows[0].retired_at).toBeNull();
	});
});
