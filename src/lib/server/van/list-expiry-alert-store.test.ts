import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockPostAlert = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/slack.js', () => ({ postAlert: mockPostAlert }));

const { sendListExpiryAlerts } = await import('./list-expiry-alert-store.js');

// Real in-memory libsql, as drift-alert-store.test.ts uses: the guarantee is
// that each list is announced ONCE however many times the sync runs, and that
// lives in a column stamped by one run and read back by the next.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-19T16:00:00.000Z');
const DAY = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CHANNEL = 'C_TURF';
const APP = 'https://app.example.org';

/** A creation date that makes the list expire `days` from NOW. */
const createdExpiringIn = (days: number) => iso(NOW.getTime() + days * DAY - 30 * DAY);

const run = (over: Partial<Parameters<typeof sendListExpiryAlerts>[1]> = {}) =>
	sendListExpiryAlerts(db, { now: NOW, channelId: CHANNEL, appUrl: APP, ...over });

async function turf(mapRouteId: number, over: Record<string, string | null> = {}): Promise<void> {
	const row: Record<string, string | number | null> = {
		map_route_id: mapRouteId,
		map_region_id: 1,
		folder_id: 1,
		chapter_id: 71,
		chapter_name: 'Livingston County',
		region_name: 'Brighton',
		name: `Turf ${mapRouteId}`,
		printed_list_number: '35536745-88712',
		printed_list_created_at: createdExpiringIn(3),
		first_seen_at: iso(NOW.getTime()),
		last_seen_at: iso(NOW.getTime()),
		...over,
	};
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO van_turfs (${cols}) VALUES (${vals})`);
}

async function stamps(): Promise<Array<string | null>> {
	const res = await client.execute(
		'SELECT list_expiry_warned_for FROM van_turfs ORDER BY map_route_id',
	);
	return res.rows.map((r) => (r.list_expiry_warned_for as string | null) ?? null);
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockPostAlert.mockResolvedValue(true);
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

describe('sendListExpiryAlerts', () => {
	it('announces a list inside the window once, however often the sync runs', async () => {
		await turf(100);
		await turf(101, { printed_list_created_at: createdExpiringIn(12) });

		expect(await run()).toEqual({ announced: 1, failed: false });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
		expect(mockPostAlert.mock.calls[0]![0]).toBe(CHANNEL);
		expect(await stamps()).toEqual([createdExpiringIn(3), null]);

		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
	});

	it('announces again once the list is regenerated and nears its own expiry', async () => {
		await turf(100);
		await run();
		// The catalog writes the new list's creation date; the stamp still holds
		// the old one, so this list has not been announced.
		await client.execute(
			`UPDATE van_turfs SET printed_list_created_at = '${createdExpiringIn(1)}'`,
		);
		expect(await run()).toMatchObject({ announced: 1 });
	});

	it('retries next run when Slack rejects the post', async () => {
		await turf(100);
		mockPostAlert.mockResolvedValueOnce(false);
		expect(await run()).toEqual({ announced: 0, failed: true });
		expect(await stamps()).toEqual([null]);
		expect(await run()).toMatchObject({ announced: 1 });
	});

	it('stamps nothing with no channel, so setting one later still announces', async () => {
		await turf(100);
		expect(await run({ channelId: '' })).toMatchObject({ skipped: 'no-channel' });
		expect(mockPostAlert).not.toHaveBeenCalled();
		expect(await stamps()).toEqual([null]);
	});

	it('skips retired turf', async () => {
		await turf(100, { retired_at: iso(NOW.getTime() - DAY) });
		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
	});

	it('notes turf someone is holding', async () => {
		await turf(100);
		await client.execute(
			`INSERT INTO van_turf_checkouts (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at)
			 VALUES (100, 'U_VOL', 'Dana', '${iso(NOW.getTime() - DAY)}', '${iso(NOW.getTime() + DAY)}')`,
		);
		await run();
		expect(mockPostAlert.mock.calls[0]![1]).toContain('someone holds it');
	});
});
