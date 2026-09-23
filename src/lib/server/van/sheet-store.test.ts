import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { flushSheetLog } from './sheet-store.js';
import { normaliseSheetKey, type SheetTarget } from '../../van/sheet-routing.js';
import type { SheetsClient } from '../google/sheets.js';

// A real in-memory libsql. The candidate query — "either stamp missing, and an
// ending only counts once the checkout has actually ended" — IS the behaviour
// under test, and a chained fake would let that SQL drift from the pure rules
// in sheet-log.ts without anything failing.

vi.mock('../slack.js', () => ({ postAlert: vi.fn(async () => true) }));
import { postAlert } from '../slack.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-09-19T18:00:00.000Z');

function target(prefix: string, label: string, spreadsheetId: string): SheetTarget {
	return { prefix, prefixKey: normaliseSheetKey(prefix), label, spreadsheetId };
}

const DOWNRIVER = target('R10C_Wayne_Taylor', 'R10C_Downriver CR', 'sheet-downriver');
const WESTERN = target('R10C', 'R10C_WesternWayne CR', 'sheet-western');

/** A client that records what it was asked to append. */
function fakeClient(
	behaviour: (spreadsheetId: string) => Awaited<ReturnType<SheetsClient['appendRows']>> = () => ({
		ok: true,
		value: { appended: 0, createdTab: false },
	}),
): SheetsClient & {
	calls: Array<{ spreadsheetId: string; rows: readonly (readonly string[])[] }>;
} {
	const calls: Array<{ spreadsheetId: string; rows: readonly (readonly string[])[] }> = [];
	return {
		calls,
		async appendRows({ spreadsheetId, rows }) {
			calls.push({ spreadsheetId, rows });
			const result = behaviour(spreadsheetId);
			// Report the real row count on success so `written` is meaningful.
			if (result.ok) return { ok: true, value: { ...result.value, appended: rows.length } };
			return result;
		},
		async describe() {
			return { ok: true, value: { title: '', hasTab: true, tabs: [] } };
		},
	};
}

async function turf(over: { mapRouteId?: number; regionName?: string; name?: string } = {}) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name,
		         name, door_count, first_seen_at, last_seen_at)
		      VALUES (?, 1, 1, 71, 'Wayne County', ?, ?, 100, 'x', 'x')`,
		args: [
			over.mapRouteId ?? 100,
			over.regionName ?? 'R10C_Wayne_TaylorCity004_9.11',
			over.name ?? 'Turf 01',
		],
	});
}

async function checkout(
	over: {
		id?: number;
		mapRouteId?: number;
		releasedAt?: string | null;
		completedAt?: string | null;
		releaseReason?: string | null;
		sheetClaimSentAt?: string | null;
		sheetEndSentAt?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (id, map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, release_reason, issued_list_number,
		         sheet_claim_sent_at, sheet_end_sent_at)
		      VALUES (?, ?, 'U1', 'Dana', '2026-09-19T14:00:00.000Z', '2026-09-21T14:00:00.000Z',
		              ?, ?, ?, '35536745-88712', ?, ?)`,
		args: [
			over.id ?? 1,
			over.mapRouteId ?? 100,
			over.releasedAt ?? null,
			over.completedAt ?? null,
			over.releaseReason ?? null,
			over.sheetClaimSentAt ?? null,
			over.sheetEndSentAt ?? null,
		],
	});
}

async function stamps(id: number): Promise<{ claim: string | null; end: string | null }> {
	const res = await client.execute({
		sql: 'SELECT sheet_claim_sent_at, sheet_end_sent_at FROM van_turf_checkouts WHERE id = ?',
		args: [id],
	});
	const row = res.rows[0];
	return {
		claim: (row?.['sheet_claim_sent_at'] as string | null) ?? null,
		end: (row?.['sheet_end_sent_at'] as string | null) ?? null,
	};
}

function flush(over: Partial<Parameters<typeof flushSheetLog>[1]> = {}) {
	return flushSheetLog(db, {
		now: NOW,
		client: fakeClient(),
		targets: [DOWNRIVER, WESTERN],
		timeBudgetMs: 30_000,
		channelId: 'C_TURF',
		...over,
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.mocked(postAlert).mockClear();
	vi.mocked(postAlert).mockResolvedValue(true);
});

afterEach(() => {
	// Closing the per-test client keeps one per test from leaking for the life
	// of the worker — which never shows up while this file is run on its own.
	client.close();
	vi.restoreAllMocks();
});

describe('flushSheetLog: what it sends', () => {
	it('appends a Checked out row and stamps only the claim half', async () => {
		await turf();
		await checkout();
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.written).toBe(1);
		expect(sheets.calls).toHaveLength(1);
		expect(sheets.calls[0]?.spreadsheetId).toBe('sheet-downriver');
		const after = await stamps(1);
		expect(after.claim).toBe(NOW.toISOString());
		// The claim has not ended, so it owes no ending row yet.
		expect(after.end).toBeNull();
	});

	it('sends nothing, and says nothing, when no rules are configured', async () => {
		await turf();
		await checkout();
		const sheets = fakeClient();

		const result = await flush({ client: sheets, targets: [] });

		expect(sheets.calls).toHaveLength(0);
		expect(result).toMatchObject({ written: 0, failed: 0, unrouted: 0, warnings: [] });
		expect(postAlert).not.toHaveBeenCalled();
	});

	it('writes both rows for a checkout that started and ended between runs', async () => {
		await turf();
		await checkout({ releasedAt: '2026-09-19T16:00:00.000Z', releaseReason: 'volunteer' });
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.written).toBe(2);
		const rows = sheets.calls[0]?.rows ?? [];
		expect(rows.map((r) => r[1])).toEqual(['Checked out', 'Released']);
		const after = await stamps(1);
		expect(after.claim).toBe(NOW.toISOString());
		expect(after.end).toBe(NOW.toISOString());
	});

	it('leaves an already-sent checkout alone', async () => {
		await turf();
		await checkout({ sheetClaimSentAt: '2026-09-19T14:05:00.000Z' });
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.written).toBe(0);
		expect(sheets.calls).toHaveLength(0);
	});

	it('groups a run into one append per spreadsheet', async () => {
		await turf({ mapRouteId: 100, regionName: 'R10C_Wayne_TaylorCity004_9.11' });
		await turf({ mapRouteId: 200, regionName: 'R10C_Wayne_TaylorCity007_9.11' });
		await turf({ mapRouteId: 300, regionName: 'R10C_Wayne_LivoniaCity001_9.11' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 200 });
		await checkout({ id: 3, mapRouteId: 300 });
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.written).toBe(3);
		expect(sheets.calls).toHaveLength(2);
		const downriver = sheets.calls.find((c) => c.spreadsheetId === 'sheet-downriver');
		const western = sheets.calls.find((c) => c.spreadsheetId === 'sheet-western');
		expect(downriver?.rows).toHaveLength(2);
		expect(western?.rows).toHaveLength(1);
	});
});

describe('flushSheetLog: when Google is unhappy', () => {
	it('leaves rows unstamped so the next run retries them', async () => {
		await turf();
		await checkout();
		const sheets = fakeClient(() => ({ ok: false, status: 403, error: 'caller has no access' }));

		const result = await flush({ client: sheets });

		expect(result).toMatchObject({ written: 0, failed: 1 });
		const after = await stamps(1);
		expect(after.claim).toBeNull();
	});

	it('records the failure and alerts the operator once', async () => {
		await turf();
		await checkout();
		const sheets = fakeClient(() => ({ ok: false, status: 403, error: 'caller has no access' }));

		await flush({ client: sheets });

		expect(postAlert).toHaveBeenCalledTimes(1);
		expect(vi.mocked(postAlert).mock.calls[0]?.[1]).toContain('R10C_Downriver CR');
		expect(vi.mocked(postAlert).mock.calls[0]?.[1]).toContain('caller has no access');

		// A second run failing the same way says nothing new.
		vi.mocked(postAlert).mockClear();
		await flush({ client: sheets });
		expect(postAlert).not.toHaveBeenCalled();
	});

	it('announces again when the failure changes', async () => {
		await turf();
		await checkout();
		await flush({ client: fakeClient(() => ({ ok: false, status: 403, error: 'no access' })) });
		vi.mocked(postAlert).mockClear();

		await flush({ client: fakeClient(() => ({ ok: false, status: 400, error: 'bad range' })) });

		expect(postAlert).toHaveBeenCalledTimes(1);
	});

	// The half that is easy to leave out: without it a sheet that broke, was
	// fixed, and breaks again the same way stays silent forever.
	it('a success clears the record, so a recurrence is audible again', async () => {
		await turf();
		await checkout();
		await flush({ client: fakeClient(() => ({ ok: false, status: 403, error: 'no access' })) });
		vi.mocked(postAlert).mockClear();

		// Fixed.
		await flush({ client: fakeClient() });
		// Broken again, the same way, with a new checkout to carry it. A second
		// turf, because the partial unique index allows only one live claim per
		// route — which is exactly the guarantee it exists to give.
		await turf({ mapRouteId: 200, regionName: 'R10C_Wayne_TaylorCity007_9.11' });
		await checkout({ id: 2, mapRouteId: 200 });
		await flush({ client: fakeClient(() => ({ ok: false, status: 403, error: 'no access' })) });

		expect(postAlert).toHaveBeenCalledTimes(1);
	});

	it('does not stamp when Slack refuses the alert, so the next run retries it', async () => {
		await turf();
		await checkout();
		vi.mocked(postAlert).mockResolvedValue(false);
		const sheets = fakeClient(() => ({ ok: false, status: 403, error: 'no access' }));

		await flush({ client: sheets });
		expect(postAlert).toHaveBeenCalledTimes(1);

		vi.mocked(postAlert).mockResolvedValue(true);
		await flush({ client: sheets });
		expect(postAlert).toHaveBeenCalledTimes(2);
	});
});

describe('flushSheetLog: turf no rule covers', () => {
	it('holds the event unsent so a later rule picks it up', async () => {
		await turf({ regionName: 'R04C_Livingston_BrightonCity003_9.11' });
		await checkout();
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.unrouted).toBe(1);
		expect(result.unroutedRegions).toEqual(['R04C_Livingston_BrightonCity003_9.11']);
		expect(sheets.calls).toHaveLength(0);
		expect((await stamps(1)).claim).toBeNull();
	});

	it('names the unmatched region in the sync notices', async () => {
		await turf({ regionName: 'R04C_Livingston_BrightonCity003_9.11' });
		await checkout();

		const result = await flush();

		expect(result.warnings.join('\n')).toContain('R04C_Livingston_BrightonCity003_9.11');
	});

	it('sends the routable events even when a sibling is unrouted', async () => {
		await turf({ mapRouteId: 100, regionName: 'R10C_Wayne_TaylorCity004_9.11' });
		await turf({ mapRouteId: 200, regionName: 'R04C_Livingston_BrightonCity003_9.11' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 200 });

		const result = await flush();

		expect(result.written).toBe(1);
		expect(result.unrouted).toBe(1);
		expect((await stamps(1)).claim).toBe(NOW.toISOString());
		expect((await stamps(2)).claim).toBeNull();
	});
});

describe('flushSheetLog: the time budget', () => {
	it('stops starting appends when the budget is gone and leaves the rest', async () => {
		await turf({ mapRouteId: 100, regionName: 'R10C_Wayne_TaylorCity004_9.11' });
		await turf({ mapRouteId: 200, regionName: 'R10C_Wayne_LivoniaCity001_9.11' });
		await checkout({ id: 1, mapRouteId: 100 });
		await checkout({ id: 2, mapRouteId: 200 });
		const sheets = fakeClient();

		const result = await flush({ client: sheets, timeBudgetMs: -1 });

		expect(result.budgetLapsed).toBe(true);
		expect(sheets.calls).toHaveLength(0);
		expect((await stamps(1)).claim).toBeNull();
		expect((await stamps(2)).claim).toBeNull();
	});
});

describe('flushSheetLog: retired turf', () => {
	// van_turfs rows are stamped retired_at, never deleted, precisely so a
	// checkout pointing at a vanished route still renders. The inner join has to
	// keep finding them.
	it('still logs a checkout whose turf VAN has retired', async () => {
		await turf();
		await client.execute("UPDATE van_turfs SET retired_at = '2026-09-19T15:00:00.000Z'");
		await checkout({ releasedAt: '2026-09-19T15:00:00.000Z', releaseReason: 'retired' });
		const sheets = fakeClient();

		const result = await flush({ client: sheets });

		expect(result.written).toBe(2);
		expect(sheets.calls[0]?.rows.map((r) => r[1])).toEqual([
			'Checked out',
			'Released (turf re-cut)',
		]);
	});
});
