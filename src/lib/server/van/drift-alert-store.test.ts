import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockPostAlert = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/slack.js', () => ({ postAlert: mockPostAlert }));

const { sendDriftAlerts } = await import('./drift-alert-store.js');

// Real in-memory libsql rather than a chained fake, for the same reason
// expiry-warning-store.test.ts uses one: the guarantee under test is that a
// channel hears about one collision ONCE however many times the sync runs, and
// that guarantee lives in a column being stamped and read back by the next run.
// A fake db could assert the update was issued; only an engine shows the second
// run finding nothing to say.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-09T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CHANNEL = 'C_TURF';
const APP = 'https://app.example.org';

const run = (over: Partial<Parameters<typeof sendDriftAlerts>[1]> = {}) =>
	sendDriftAlerts(db, { now: NOW, channelId: CHANNEL, appUrl: APP, ...over });

/** The text of the last message we tried to post. */
const lastText = (): string => mockPostAlert.mock.calls.at(-1)![1] as string;

async function turf(
	mapRouteId: number,
	over: Record<string, string | number | null> = {},
): Promise<void> {
	const row: Record<string, string | number | null> = {
		map_route_id: mapRouteId,
		map_region_id: 1,
		folder_id: 1,
		chapter_id: 71,
		chapter_name: 'Washtenaw County',
		region_name: 'Ann Arbor',
		name: `Turf ${mapRouteId}`,
		printed_list_number: '35536745-88712',
		door_count: 250,
		van_distributed_to: null,
		drift_alerted_at: null,
		drift_alerted_kind: null,
		retired_at: null,
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

async function claim(mapRouteId: number, over: Record<string, string | null> = {}): Promise<void> {
	const row: Record<string, string | number | null> = {
		map_route_id: mapRouteId,
		slack_user_id: 'U_VOL',
		slack_user_name: 'Dana',
		claimed_at: iso(NOW.getTime() - 5 * HOUR),
		expires_at: iso(NOW.getTime() + 40 * HOUR),
		released_at: null,
		completed_at: null,
		...over,
	};
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO van_turf_checkouts (${cols}) VALUES (${vals})`);
}

async function stampsInDb(): Promise<
	Array<{ id: number; kind: string | null; at: string | null }>
> {
	const res = await client.execute(
		'SELECT map_route_id, drift_alerted_kind, drift_alerted_at FROM van_turfs ORDER BY map_route_id',
	);
	return res.rows.map((r) => ({
		id: Number(r.map_route_id),
		kind: (r.drift_alerted_kind as string | null) ?? null,
		at: (r.drift_alerted_at as string | null) ?? null,
	}));
}

/** Mark the last sync as having read /minivanExports, which is what makes VAN's
 *  half of the comparison legible. Without it every test would be a no-op. */
async function vanSideVisible(ok = true): Promise<void> {
	await client.execute(
		`INSERT INTO van_sync_state (id, last_sync_at, minivan_exports_ok)
		 VALUES (1, '${iso(NOW.getTime())}', ${ok ? 1 : 0})
		 ON CONFLICT(id) DO UPDATE SET minivan_exports_ok = ${ok ? 1 : 0}`,
	);
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockPostAlert.mockResolvedValue(true);

	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	// The REAL schema from drizzle/, not a hand-written CREATE TABLE: the
	// van_turf_checkouts partial unique index allows only one active claim per
	// route, and a fixture without it accepts states production forbids.
	await migrate(db, { migrationsFolder: 'drizzle' });
});

describe('sendDriftAlerts', () => {
	it('announces turf VAN has out but the ledger shows free', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });

		const result = await run();

		expect(result).toMatchObject({ announced: 1, cleared: 0, failed: false });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
		expect(mockPostAlert.mock.calls[0]![0]).toBe(CHANNEL);
		expect(lastText()).toContain('VAN says Sam Rivera');
	});

	it('announces turf claimed here that VAN never exported', async () => {
		await vanSideVisible();
		await turf(100);
		await claim(100);

		expect(await run()).toMatchObject({ announced: 1 });
		expect(lastText()).toContain('held by Dana');
	});

	it('says nothing when the two sides agree', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Dana' });
		await claim(100);
		await turf(200);

		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
		expect(mockPostAlert).not.toHaveBeenCalled();
	});

	it('announces once, not on every run', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });

		expect(await run()).toMatchObject({ announced: 1 });
		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
	});

	it('stamps the kind it announced, so a direction change gets through', async () => {
		await vanSideVisible();
		await turf(100);
		await claim(100);

		expect(await run()).toMatchObject({ announced: 1 });
		expect(await stampsInDb()).toEqual([
			{ id: 100, kind: 'claimed-not-in-minivan', at: iso(NOW.getTime()) },
		]);

		// The half-fixed case: the organizer exports it to MiniVAN, the volunteer's
		// claim lapses, and the route now drifts the dangerous way.
		await client.execute("UPDATE van_turfs SET van_distributed_to = 'Sam Rivera'");
		await client.execute(`UPDATE van_turf_checkouts SET released_at = '${iso(NOW.getTime())}'`);

		expect(await run()).toMatchObject({ announced: 1 });
		expect(lastText()).toContain('VAN says Sam Rivera');
		expect(await stampsInDb()).toEqual([
			{ id: 100, kind: 'in-minivan-not-claimed', at: iso(NOW.getTime()) },
		]);
	});

	it('clears the stamp when the drift is fixed, so a recurrence is audible', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });

		expect(await run()).toMatchObject({ announced: 1 });

		// Somebody claims it here, so the two sides now agree.
		await claim(100);
		expect(await run()).toMatchObject({ announced: 0, cleared: 1 });
		expect(await stampsInDb()).toEqual([{ id: 100, kind: null, at: null }]);

		// It drifts again months later. This must be heard, not swallowed.
		await client.execute(`UPDATE van_turf_checkouts SET released_at = '${iso(NOW.getTime())}'`);
		expect(await run()).toMatchObject({ announced: 1 });
		expect(mockPostAlert).toHaveBeenCalledTimes(2);
	});

	it('does not stamp when Slack rejects the post, so the alert retries', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });
		mockPostAlert.mockResolvedValue(false);

		expect(await run()).toMatchObject({ announced: 0, failed: true });
		expect(await stampsInDb()).toEqual([{ id: 100, kind: null, at: null }]);

		mockPostAlert.mockResolvedValue(true);
		expect(await run()).toMatchObject({ announced: 1, failed: false });
	});

	it("stays silent — and touches no stamp — when VAN's half is unreadable", async () => {
		// A key without /minivanExports writes NULL into van_distributed_to for
		// everything, which is indistinguishable from "nothing is distributed".
		// Clearing stamps here would re-announce the lot once the tier is granted.
		await vanSideVisible(false);
		await turf(100, { drift_alerted_kind: 'in-minivan-not-claimed', drift_alerted_at: iso(0) });

		expect(await run()).toMatchObject({
			announced: 0,
			cleared: 0,
			skipped: 'van-side-unavailable',
		});
		expect(mockPostAlert).not.toHaveBeenCalled();
		expect((await stampsInDb())[0]!.kind).toBe('in-minivan-not-claimed');
	});

	it('treats a never-synced database as unreadable rather than as agreement', async () => {
		// No van_sync_state row at all. An empty report at this point would be
		// reassurance drawn from an empty table.
		await turf(100, { van_distributed_to: 'Sam Rivera' });

		expect(await run()).toMatchObject({ skipped: 'van-side-unavailable' });
		expect(mockPostAlert).not.toHaveBeenCalled();
	});

	it('does nothing when no turf channel is configured', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });

		expect(await run({ channelId: '' })).toMatchObject({
			announced: 0,
			skipped: 'no-channel',
		});
		expect(mockPostAlert).not.toHaveBeenCalled();
		// Crucially unstamped: this drift must be announced once a channel is set.
		expect((await stampsInDb())[0]!.kind).toBeNull();
	});

	it('ignores retired turf and clears the stamp it used to carry', async () => {
		await vanSideVisible();
		await turf(100, {
			van_distributed_to: 'Sam Rivera',
			retired_at: iso(NOW.getTime() - HOUR),
			drift_alerted_kind: 'in-minivan-not-claimed',
			drift_alerted_at: iso(NOW.getTime() - 24 * HOUR),
		});

		expect(await run()).toMatchObject({ announced: 0, cleared: 1 });
		expect(mockPostAlert).not.toHaveBeenCalled();
	});

	it('batches every chapter into one message', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera' });
		await turf(200, { chapter_id: 82, chapter_name: 'Wayne County', region_name: 'Detroit' });
		await claim(200);

		expect(await run()).toMatchObject({ announced: 2 });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
		expect(lastText()).toContain('Ann Arbor');
		expect(lastText()).toContain('Detroit');
	});

	it('ignores an expired claim, which is drift rather than a holding', async () => {
		await vanSideVisible();
		await turf(100);
		await claim(100, { expires_at: iso(NOW.getTime() - HOUR) });

		// The claim lapsed, so nobody holds it and VAN never had it — the two sides
		// agree that it is free.
		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
	});

	it('survives an unrecognised stamp by re-announcing rather than going mute', async () => {
		await vanSideVisible();
		await turf(100, { van_distributed_to: 'Sam Rivera', drift_alerted_kind: 'something-else' });

		expect(await run()).toMatchObject({ announced: 1 });
		expect(await stampsInDb()).toEqual([
			{ id: 100, kind: 'in-minivan-not-claimed', at: iso(NOW.getTime()) },
		]);
	});

	it('sweeps an unrecognised stamp off turf that is not drifting', async () => {
		// The sweep reads every stamped row, not just the interpretable ones, so a
		// junk value does not sit on a healthy turf forever.
		await vanSideVisible();
		await turf(100, { drift_alerted_kind: 'something-else', drift_alerted_at: iso(0) });

		expect(await run()).toMatchObject({ announced: 0, cleared: 1 });
		expect(await stampsInDb()).toEqual([{ id: 100, kind: null, at: null }]);
	});
});
