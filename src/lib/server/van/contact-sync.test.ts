import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { VanClient } from './client.js';
import {
	clearUncontacted,
	contactTimestamp,
	JOB_STALE_MS,
	MAX_BACKFILL_MS,
	OVERLAP_MS,
	recomputeUncontacted,
	replaceRoster,
	runContactSync,
	stampDoorsKnocked,
	stampWalkPercents,
	upsertContacts,
	WINDOW_MS,
} from './contact-sync.js';
import { createPersonHasher } from './person-hash.js';
import type { VanChangedEntityExportJob } from './types.js';

// A real in-memory libsql: the count is one SQL statement joining two blob-keyed
// tables, and a stub would let that statement say anything.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const hasher = createPersonHasher('test-secret');
const NOW = new Date('2026-09-28T18:00:00.000Z');
const CUT = '2026-09-14T13:00:00.000Z';

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
});

async function turf(
	turfId: number,
	over: { savedListId?: number; cutAt?: string | null; retiredAt?: string | null } = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, name, saved_list_id, door_count,
		         first_seen_at, last_seen_at, cut_at, retired_at)
		      VALUES (?1, ?1, 1, 1, 1, 'Turf', ?, 99, ?, ?, ?, ?)`,
		args: [
			turfId,
			over.savedListId ?? 900,
			'2026-09-15T00:00:00.000Z',
			'2026-09-28T00:00:00.000Z',
			over.cutAt === undefined ? CUT : over.cutAt,
			over.retiredAt ?? null,
		],
	});
}

/** Person id → address, as a roster. */
function roster(people: Record<string, string>) {
	return Object.entries(people).map(([id, address]) => ({
		personHash: hasher.person(id),
		doorHash: hasher.door(address, '48201'),
	}));
}

async function contact(vanId: string, at: string) {
	await upsertContacts(db, 1, new Map([[vanId, { personHash: hasher.person(vanId), at }]]));
}

async function counts(turfId: number) {
	const res = await client.execute({
		sql: 'SELECT uncontacted_doors, uncontacted_doors_at FROM van_turfs WHERE turf_id = ?',
		args: [turfId],
	});
	return res.rows[0]!;
}

describe('contactTimestamp', () => {
	// VAN's ContactHistory format, verified live. Detroit is UTC-4 in September.
	it('reads M/D/YYYY h:mm:ss AM/PM as campaign-local time', () => {
		expect(contactTimestamp('9/28/2026 3:07:00 PM')).toBe('2026-09-28T19:07:00.000Z');
		expect(contactTimestamp('9/28/2026 12:30:00 AM')).toBe('2026-09-28T04:30:00.000Z');
		expect(contactTimestamp('9/28/2026 12:30:00 PM')).toBe('2026-09-28T16:30:00.000Z');
	});

	it('is null for anything else', () => {
		expect(contactTimestamp('')).toBeNull();
		expect(contactTimestamp('yesterday')).toBeNull();
	});
});

describe('recomputeUncontacted', () => {
	beforeEach(async () => {
		await turf(1);
		// Two doors: 1 Main has two residents, 2 Main has one.
		await replaceRoster(db, 1, 900, roster({ a: '1 Main St', b: '1 Main St', c: '2 Main St' }));
	});

	it('counts every door when nobody has been contacted', async () => {
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect(await counts(1)).toMatchObject({
			uncontacted_doors: 2,
			uncontacted_doors_at: NOW.toISOString(),
		});
	});

	// Any resident answering (or not) is a knock on that door.
	it('takes a door off when any one resident was contacted since the cut', async () => {
		await contact('b', '2026-09-20T15:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect((await counts(1)).uncontacted_doors).toBe(1);
	});

	it('ignores contacts from before the cut', async () => {
		await contact('b', '2026-09-10T15:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect((await counts(1)).uncontacted_doors).toBe(2);
	});

	it('falls back to first-seen when VAN gave no cut date', async () => {
		await client.execute('UPDATE van_turfs SET cut_at = NULL');
		// After CUT but before first_seen_at (09-15): does not count.
		await contact('c', '2026-09-14T20:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect((await counts(1)).uncontacted_doors).toBe(2);
	});

	// A count from the previous cut is worse than none: the UI falls back to
	// VAN's doorCount.
	it('clears the count when the roster is from an older saved list', async () => {
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		await client.execute('UPDATE van_turfs SET saved_list_id = 901');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect(await counts(1)).toMatchObject({ uncontacted_doors: null, uncontacted_doors_at: null });
	});

	it('touches only the turfs asked for', async () => {
		await turf(2);
		await replaceRoster(db, 2, 900, roster({ d: '9 Elm St' }));
		await recomputeUncontacted(db, { campaignId: 1, now: NOW, turfIds: [2] });
		expect((await counts(1)).uncontacted_doors).toBeNull();
		expect((await counts(2)).uncontacted_doors).toBe(1);
	});

	it('replaces a roster wholesale', async () => {
		await replaceRoster(db, 1, 901, roster({ z: '5 Oak St' }));
		const res = await client.execute('SELECT count(*) AS n FROM van_turf_roster');
		expect(Number(res.rows[0]!.n)).toBe(1);
		const marker = await client.execute('SELECT roster_saved_list_id FROM van_turfs');
		expect(marker.rows[0]!.roster_saved_list_id).toBe(901);
	});
});

describe('upsertContacts', () => {
	it('keeps the later of two dates for one person', async () => {
		await contact('a', '2026-09-20T15:00:00.000Z');
		await contact('a', '2026-09-18T15:00:00.000Z');
		await contact('a', '2026-09-22T15:00:00.000Z');
		const res = await client.execute('SELECT last_in_person_at FROM van_person_contacts');
		expect(res.rows).toHaveLength(1);
		expect(res.rows[0]!.last_in_person_at).toBe('2026-09-22T15:00:00.000Z');
	});
});

// ---------------------------------------------------------------------------

const HEADER =
	'ContactsContactID,VanID,ResultID,CanvassedBy,CommitteeID,CreatedBy,DateCreated,' +
	'DateCanvassed,InputTypeID,ContactTypeID,ChangeTypeId,ErrorMessage';

function contactRow(
	vanId: string,
	contactTypeId: number,
	canvassed: string,
	changeTypeId = 1,
): string {
	return `1,${vanId},14,5,122299,5,9/28/2026 3:16:00 PM,${canvassed},14,${contactTypeId},${changeTypeId},`;
}

/** `iso` minus the pull's overlap: where a window after that cursor starts. */
const overlapped = (iso: string) => new Date(Date.parse(iso) - OVERLAP_MS).toISOString();

interface FakeVan {
	client: VanClient;
	created: Array<{ dateChangedFrom: string; dateChangedTo: string }>;
}

/** A VAN whose every window's export holds `rows` (or `rowsFor(window)`). */
function fakeVan(
	rowsFor: (window: { from: string; to: string }) => string[],
	jobs: {
		status?: (id: number, reads: number) => string;
		/** HTTP status of each download of a job's file. Default 200. */
		download?: (id: number, attempt: number) => number;
	} = {},
): { van: FakeVan; fetchFn: typeof fetch } {
	const created: FakeVan['created'] = [];
	const windows = new Map<number, { from: string; to: string }>();
	const reads = new Map<number, number>();
	let next = 1;
	const job = (id: number): VanChangedEntityExportJob => {
		const count = (reads.get(id) ?? 0) + 1;
		reads.set(id, count);
		const status = jobs.status?.(id, count) ?? 'Complete';
		return {
			exportJobId: id,
			jobStatus: status,
			files: status === 'Complete' ? [{ downloadUrl: `https://blob.example/${id}.csv` }] : null,
		};
	};
	const client = {
		contactTypes: async () => [
			{ contactTypeId: 2, name: 'Walk', channelTypeName: 'In Person' },
			{ contactTypeId: 1, name: 'Phone', channelTypeName: 'Phone' },
			{ contactTypeId: 13, name: 'Event', channelTypeName: 'In Person' },
			{ contactTypeId: 10, name: 'Meeting', channelTypeName: 'In Person' },
			{ contactTypeId: 5, name: 'Paid ID', channelTypeName: 'In Person' },
		],
		changeTypes: async () => [
			{ changeTypeId: 1, changeTypeName: 'CreatedOrUpdated' },
			{ changeTypeId: 2, changeTypeName: 'Deleted' },
		],
		createChangedEntityExportJob: async (input: {
			dateChangedFrom: string;
			dateChangedTo: string;
		}) => {
			created.push(input);
			const id = next++;
			windows.set(id, { from: input.dateChangedFrom, to: input.dateChangedTo });
			// The POST carries no status, as verified live.
			return { exportJobId: id };
		},
		changedEntityExportJob: async (id: number) => job(id),
	} as unknown as VanClient;
	const downloads = new Map<number, number>();
	const fetchFn = (async (url: string) => {
		const id = Number(/\/(\d+)\.csv$/.exec(url)![1]);
		const attempt = (downloads.get(id) ?? 0) + 1;
		downloads.set(id, attempt);
		const status = jobs.download?.(id, attempt) ?? 200;
		if (status !== 200) return new Response('nope', { status });
		const body = [HEADER, ...rowsFor(windows.get(id)!)].join('\r\n');
		return new Response(body);
	}) as typeof fetch;
	return { van: { client, created }, fetchFn };
}

async function state() {
	const res = await client.execute('SELECT * FROM van_contact_sync_state');
	return res.rows[0]!;
}

const noSleep = async () => {};

describe('runContactSync', () => {
	beforeEach(async () => {
		await turf(1, { cutAt: '2026-09-27T00:00:00.000Z' });
		await replaceRoster(db, 1, 900, roster({ '111': '1 Main St', '222': '2 Main St' }));
	});

	it('walks day windows from the earliest cut to now and counts in-person contacts', async () => {
		const { van, fetchFn } = fakeVan((w) =>
			w.from.startsWith('2026-09-27')
				? [
						contactRow('111', 2, '9/27/2026 1:00:00 PM'),
						contactRow('222', 1, '9/27/2026 2:00:00 PM'),
					]
				: [],
		);

		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		// 09-27T00:00 → 09-28T00:00 → 09-28T18:00, each window reaching back
		// OVERLAP_MS for contacts VAN surfaced late.
		expect(van.created.map((w) => w.dateChangedFrom)).toEqual([
			overlapped('2026-09-27T00:00:00.000Z'),
			overlapped('2026-09-28T00:00:00.000Z'),
		]);
		expect(van.created[0]!.dateChangedTo).toBe('2026-09-28T00:00:00.000Z');
		expect(van.created[1]!.dateChangedTo).toBe(NOW.toISOString());
		expect(result).toMatchObject({ windowsApplied: 2, contactsRead: 1, error: null });
		expect(result.cursor).toBe(NOW.toISOString());
		// 111 was walked; 222 was only phoned, which knocks no door.
		expect((await counts(1)).uncontacted_doors).toBe(1);
	});

	it('picks up from the cursor next time rather than re-reading', async () => {
		const { van, fetchFn } = fakeVan(() => []);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		van.created.length = 0;

		const later = new Date(NOW.getTime() + 30 * 60 * 1000);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: later,
			fetchFn,
			sleep: noSleep,
		});

		expect(van.created).toEqual([
			expect.objectContaining({
				dateChangedFrom: overlapped(NOW.toISOString()),
				dateChangedTo: later.toISOString(),
			}),
		]);
	});

	// In person, but not at a door on the list.
	it('ignores events, meetings and paid IDs', async () => {
		const { van, fetchFn } = fakeVan((w) =>
			w.from.startsWith('2026-09-27')
				? [
						contactRow('111', 13, '9/27/2026 1:00:00 PM'),
						contactRow('111', 10, '9/27/2026 1:00:00 PM'),
						contactRow('222', 5, '9/27/2026 2:00:00 PM'),
					]
				: [],
		);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(result.contactsRead).toBe(0);
		expect((await counts(1)).uncontacted_doors).toBe(2);
	});

	// Rosters land turf by turf; a contact must not be lost because its turf's
	// roster arrived after the window was read.
	it('keeps contacts for people on no roster yet', async () => {
		const { van, fetchFn } = fakeVan(() => [contactRow('999', 2, '9/27/2026 1:00:00 PM')]);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		await turf(2, { cutAt: '2026-09-27T00:00:00.000Z' });
		await replaceRoster(db, 2, 900, roster({ '999': '9 Elm St' }));
		await recomputeUncontacted(db, { campaignId: 1, now: NOW, turfIds: [2] });

		expect((await counts(2)).uncontacted_doors).toBe(0);
	});

	it('leaves a slow job to be polled next run, without advancing', async () => {
		const { van, fetchFn } = fakeVan(() => [], { status: () => 'Pending' });
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
			// Room to submit and poll once, but under the 3 s poll interval, so
			// the run stops at the first Pending. A budget of a few ms can lapse
			// before the loop starts, and then no job is submitted at all.
			timeBudgetMs: 2_000,
		});

		expect(result.pending).toBe(true);
		expect(result.windowsApplied).toBe(0);
		const saved = await state();
		expect(saved.export_job_id).toBe(1);
		expect(saved.window_from).toBe(overlapped('2026-09-27T00:00:00.000Z'));
		// Nothing applied yet: the cursor is still where the pull began.
		expect(saved.cursor).toBe('2026-09-27T00:00:00.000Z');
	});

	it('resumes the stored job instead of submitting the window again', async () => {
		let pending = true;
		const { van, fetchFn } = fakeVan(() => [contactRow('111', 2, '9/27/2026 1:00:00 PM')], {
			status: () => (pending ? 'Pending' : 'Complete'),
		});
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
			timeBudgetMs: 10,
		});
		pending = false;

		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		// Job 1 finished; only the second window was newly submitted.
		expect(van.created).toHaveLength(2);
		expect(result.windowsApplied).toBe(2);
		expect((await counts(1)).uncontacted_doors).toBe(1);
	});

	it('drops a failed job, records why, and still recomputes', async () => {
		const { van, fetchFn } = fakeVan(() => [], { status: () => 'Error' });
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		expect(result.error).toContain('failed');
		const saved = await state();
		expect(saved.export_job_id).toBeNull();
		expect(saved.cursor).toBe('2026-09-27T00:00:00.000Z');
		expect((await counts(1)).uncontacted_doors).toBe(2);
	});

	it('prunes contacts older than every live cut', async () => {
		await contact('old', '2026-09-01T00:00:00.000Z');
		const { van, fetchFn } = fakeVan(() => []);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(result.contactsPruned).toBe(1);
	});

	it('does nothing but recompute when there is no turf to count for', async () => {
		// Retired longer ago than a retired roster is kept.
		await client.execute(`UPDATE van_turfs SET retired_at = '2026-09-26T00:00:00.000Z'`);
		const { van, fetchFn } = fakeVan(() => []);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
		});
		expect(van.created).toHaveLength(0);
		expect(result.windowsApplied).toBe(0);
	});

	it('windows are one day', () => {
		expect(WINDOW_MS).toBe(86_400_000);
	});

	// A turf VAN has not re-cut in months would otherwise cost an export job
	// per day of its age.
	it('never starts more than 30 days back', async () => {
		await turf(2, { cutAt: '2026-06-01T00:00:00.000Z' });
		const { van, fetchFn } = fakeVan(() => []);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		const floor = new Date(NOW.getTime() - MAX_BACKFILL_MS).toISOString();
		expect(van.created[0]!.dateChangedFrom).toBe(overlapped(floor));
		expect((await state()).covered_from).toBe(floor);
	});

	// A newly mapped folder brings turf cut before anything read so far.
	it('rewinds for a turf cut before the pull began', async () => {
		const { van, fetchFn } = fakeVan(() => []);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		await turf(2, { cutAt: '2026-09-20T00:00:00.000Z' });
		van.created.length = 0;

		const later = new Date(NOW.getTime() + 30 * 60 * 1000);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: later,
			fetchFn,
			sleep: noSleep,
		});

		expect(van.created[0]!.dateChangedFrom).toBe(overlapped('2026-09-20T00:00:00.000Z'));
		expect((await state()).covered_from).toBe('2026-09-20T00:00:00.000Z');
	});

	it('skips contacts VAN reports as deleted', async () => {
		const { van, fetchFn } = fakeVan((w) =>
			w.to === '2026-09-28T00:00:00.000Z'
				? [
						contactRow('111', 2, '9/27/2026 1:00:00 PM', 2),
						contactRow('222', 2, '9/27/2026 2:00:00 PM', 1),
					]
				: [],
		);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(result.contactsRead).toBe(1);
		expect((await counts(1)).uncontacted_doors).toBe(1);
	});

	it('still counts when VAN will not say which change types are deletions', async () => {
		const { van, fetchFn } = fakeVan((w) =>
			w.to === '2026-09-28T00:00:00.000Z' ? [contactRow('111', 2, '9/27/2026 1:00:00 PM')] : [],
		);
		const client = {
			...van.client,
			changeTypes: async () => {
				throw new Error('403');
			},
		} as VanClient;
		const result = await runContactSync(db, client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(result.contactsRead).toBe(1);
	});

	// An expired signed URL never comes back; waiting on it would stop the
	// pull for good.
	it('drops a job whose download is dead and submits the window again', async () => {
		const { van, fetchFn } = fakeVan(() => [], { download: (id) => (id === 1 ? 403 : 200) });
		const first = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(first.error).toContain('HTTP 403');
		expect((await state()).export_job_id).toBeNull();

		const second = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(second.error).toBeNull();
		expect(second.cursor).toBe(NOW.toISOString());
		expect(van.created[1]!.dateChangedFrom).toBe(van.created[0]!.dateChangedFrom);
	});

	it('retries a transient download failure on the same job, then gives up on it', async () => {
		const { van, fetchFn } = fakeVan(() => [], { download: (id) => (id === 1 ? 500 : 200) });
		const run = () =>
			runContactSync(db, van.client, { campaignId: 1, hasher, now: NOW, fetchFn, sleep: noSleep });

		await run();
		expect(await state()).toMatchObject({ export_job_id: 1, export_job_failures: 1 });
		await run();
		expect(await state()).toMatchObject({ export_job_id: 1, export_job_failures: 2 });
		await run();
		expect(await state()).toMatchObject({ export_job_id: null, export_job_failures: 0 });
		expect(van.created).toHaveLength(1);

		const result = await run();
		expect(result.error).toBeNull();
		expect(van.created).toHaveLength(3);
	});

	it('abandons a job VAN never finishes', async () => {
		let stuck = true;
		const { van, fetchFn } = fakeVan(() => [], {
			status: (id) => (id === 1 && stuck ? 'Pending' : 'Complete'),
		});
		const opts = { hasher, fetchFn, sleep: noSleep, timeBudgetMs: 10 };
		await runContactSync(db, van.client, { campaignId: 1, ...opts, now: NOW });

		// Not yet stale: still waited on.
		const soon = await runContactSync(db, van.client, {
			campaignId: 1,
			...opts,
			now: new Date(NOW.getTime() + 60 * 60 * 1000),
		});
		expect(soon.pending).toBe(true);
		expect((await state()).export_job_id).toBe(1);

		const late = await runContactSync(db, van.client, {
			campaignId: 1,
			...opts,
			now: new Date(NOW.getTime() + JOB_STALE_MS + 60 * 1000),
		});
		expect(late.error).toContain('resubmitting');
		expect((await state()).export_job_id).toBeNull();
		stuck = false;
	});
});

describe('clearUncontacted', () => {
	it('forgets every count', async () => {
		await turf(1);
		await replaceRoster(db, 1, 900, roster({ a: '1 Main St' }));
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect((await counts(1)).uncontacted_doors).toBe(1);

		await clearUncontacted(db);
		expect(await counts(1)).toMatchObject({ uncontacted_doors: null, uncontacted_doors_at: null });
	});
});

describe('stampWalkPercents', () => {
	async function completion(
		id: number,
		completedAt: string,
		reportedPercent: number | null = null,
	) {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at,
			         completed_at, reported_percent)
			      VALUES (?, 1, 'U1', 'Dana', ?, ?, ?, ?)`,
			args: [id, completedAt, completedAt, completedAt, reportedPercent],
		});
	}
	async function percent(id: number) {
		const res = await client.execute({
			sql: 'SELECT reported_percent FROM van_turf_checkouts WHERE id = ?',
			args: [id],
		});
		return res.rows[0]!.reported_percent;
	}

	beforeEach(async () => {
		await turf(1);
		// Four doors.
		await replaceRoster(
			db,
			1,
			900,
			roster({ a: '1 Main St', b: '2 Main St', c: '3 Main St', d: '4 Main St' }),
		);
	});

	it('derives % walked for a recent completion from the uncontacted count', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z');
		await contact('a', '2026-09-28T11:00:00.000Z');
		await contact('b', '2026-09-28T11:30:00.000Z');
		await contact('c', '2026-09-28T11:45:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });

		expect(await stampWalkPercents(db, { campaignId: 1, now: NOW })).toBe(1);
		expect(await percent(1)).toBe(75);
	});

	it('leaves completions older than a day as they were', async () => {
		await completion(1, '2026-09-26T12:00:00.000Z', 40);
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		await stampWalkPercents(db, { campaignId: 1, now: NOW });
		expect(await percent(1)).toBe(40);
	});

	it('leaves a turf with no count alone rather than zeroing it', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z', 55);
		// No recompute: uncontacted_doors is still null.
		await stampWalkPercents(db, { campaignId: 1, now: NOW });
		expect(await percent(1)).toBe(55);
	});

	// Marking walked asks VAN for the re-cut that retires the route, often
	// before the volunteer's contacts have landed in ContactHistory.
	it('still derives % walked after the route retires', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z');
		await client.execute(`UPDATE van_turfs SET retired_at = '2026-09-28T13:00:00.000Z'`);
		await contact('a', '2026-09-28T11:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });

		await stampWalkPercents(db, { campaignId: 1, now: NOW });
		expect(await percent(1)).toBe(25);
	});

	it('never overwrites a % with NULL once the roster is gone', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z');
		await contact('a', '2026-09-28T11:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		await stampWalkPercents(db, { campaignId: 1, now: NOW });
		await client.execute('DELETE FROM van_turf_roster');

		await stampWalkPercents(db, { campaignId: 1, now: NOW });
		expect(await percent(1)).toBe(25);
	});

	it('writes only percentages that changed', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect(await stampWalkPercents(db, { campaignId: 1, now: NOW })).toBe(1);
		expect(await stampWalkPercents(db, { campaignId: 1, now: NOW })).toBe(0);
	});

	it('scopes to the turfs asked for', async () => {
		await completion(1, '2026-09-28T12:00:00.000Z');
		await recomputeUncontacted(db, { campaignId: 1, now: NOW });
		expect(await stampWalkPercents(db, { campaignId: 1, now: NOW, turfIds: [2] })).toBe(0);
		expect(await stampWalkPercents(db, { campaignId: 1, now: NOW, turfIds: [1] })).toBe(1);
		expect(await percent(1)).toBe(0);
	});
});

describe('stampDoorsKnocked', () => {
	const CLAIMED = '2026-09-28T12:00:00.000Z';
	const COMPLETED = '2026-09-28T15:00:00.000Z';

	async function completion(id: number, claimedAt = CLAIMED, completedAt = COMPLETED) {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, completed_at)
			      VALUES (?, 1, 'U1', 'Dana', ?, ?, ?)`,
			args: [id, claimedAt, completedAt, completedAt],
		});
	}
	async function knocked(id: number) {
		const res = await client.execute({
			sql: 'SELECT doors_knocked FROM van_turf_checkouts WHERE id = ?',
			args: [id],
		});
		return res.rows[0]!.doors_knocked;
	}

	beforeEach(async () => {
		await turf(1);
		// a and b share a door; c and d have their own.
		await replaceRoster(
			db,
			1,
			900,
			roster({ a: '1 Main St', b: '1 Main St', c: '2 Main St', d: '3 Main St' }),
		);
	});

	it('counts doors contacted during the claim, a shared door once', async () => {
		await completion(1);
		await contact('a', '2026-09-28T13:00:00.000Z');
		await contact('b', '2026-09-28T13:05:00.000Z');
		await contact('c', '2026-09-28T14:00:00.000Z');
		// Before the claim (by more than the lead): someone else's knock.
		await contact('d', '2026-09-28T10:00:00.000Z');

		expect(await stampDoorsKnocked(db, { campaignId: 1, now: NOW })).toBe(1);
		expect(await knocked(1)).toBe(2);
	});

	it('allows a little slack either side of the claim', async () => {
		await completion(1);
		await contact('a', '2026-09-28T11:45:00.000Z');
		await contact('c', '2026-09-28T15:40:00.000Z');
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBe(2);
	});

	// Only each person's latest contact is kept, so a later re-knock would
	// otherwise pull a door out of this claim's window.
	it('never lowers a count once stamped', async () => {
		await completion(1);
		await contact('c', '2026-09-28T14:00:00.000Z');
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBe(1);

		await contact('c', '2026-09-28T17:30:00.000Z');
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBe(1);
	});

	it('records zero, not null, for a rostered turf with no contacts', async () => {
		await completion(1);
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBe(0);
	});

	// For the Packet Tracker: a lapsed claim's entry is cleared at 0.
	it('counts a lapsed claim up to its expiry, without the trailing hour', async () => {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at,
			         released_at, release_reason)
			      VALUES (1, 1, 'U1', 'Dana', ?, ?, ?, 'expired')`,
			args: [CLAIMED, COMPLETED, COMPLETED],
		});
		await contact('a', '2026-09-28T13:00:00.000Z');
		// After expiry: the turf is someone else's.
		await contact('c', '2026-09-28T15:20:00.000Z');
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBe(1);
	});

	// Its volunteer may still be walking, or not yet synced: a 0 now would
	// clear their entries before their doors reach VAN.
	it('waits an hour after a claim lapses before counting it', async () => {
		const lapsed = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at,
			         released_at, release_reason)
			      VALUES (1, 1, 'U1', 'Dana', ?, ?, ?, 'expired')`,
			args: [CLAIMED, lapsed, lapsed],
		});
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBeNull();
	});

	it('leaves a claim given back alone', async () => {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at,
			         released_at, release_reason)
			      VALUES (1, 1, 'U1', 'Dana', ?, ?, ?, 'volunteer')`,
			args: [CLAIMED, COMPLETED, COMPLETED],
		});
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(1)).toBeNull();
	});

	it('leaves a turf with no roster, and old completions, alone', async () => {
		await turf(2);
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, completed_at)
			      VALUES (2, 2, 'U1', 'Dana', ?, ?, ?)`,
			args: [CLAIMED, COMPLETED, COMPLETED],
		});
		await completion(3, '2026-09-25T12:00:00.000Z', '2026-09-25T15:00:00.000Z');
		await stampDoorsKnocked(db, { campaignId: 1, now: NOW });
		expect(await knocked(2)).toBeNull();
		expect(await knocked(3)).toBeNull();
	});
});

describe('runContactSync: what a run recomputes and stamps', () => {
	const COMPLETED = '2026-09-28T15:00:00.000Z';

	beforeEach(async () => {
		await turf(1, { cutAt: '2026-09-27T00:00:00.000Z' });
		await replaceRoster(db, 1, 900, roster({ '111': '1 Main St', '222': '2 Main St' }));
		await turf(2, { cutAt: '2026-09-27T00:00:00.000Z' });
		await replaceRoster(db, 2, 900, roster({ '333': '9 Elm St' }));
	});

	async function completion() {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (id, turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, completed_at)
			      VALUES (1, 1, 'U1', 'Dana', '2026-09-28T12:00:00.000Z', ?, ?)`,
			args: [COMPLETED, COMPLETED],
		});
	}
	async function knocked() {
		const res = await client.execute('SELECT doors_knocked FROM van_turf_checkouts WHERE id = 1');
		return res.rows[0]!.doors_knocked;
	}

	it('recomputes every turf the first scheduled run, then only turfs it pulled people for', async () => {
		const quiet = fakeVan(() => []);
		await runContactSync(db, quiet.van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn: quiet.fetchFn,
			sleep: noSleep,
		});
		expect((await counts(1)).uncontacted_doors).toBe(2);
		expect((await counts(2)).uncontacted_doors).toBe(1);
		expect((await state()).full_recompute_at).toBe(NOW.toISOString());

		// Tamper with turf 2's stored count: a run that pulled nobody on it
		// must leave it be.
		await client.execute('UPDATE van_turfs SET uncontacted_doors = 42 WHERE turf_id = 2');
		const later = new Date(NOW.getTime() + 30 * 60 * 1000);
		const busy = fakeVan(() => [contactRow('111', 2, '9/28/2026 2:10:00 PM')]);
		const result = await runContactSync(db, busy.van.client, {
			campaignId: 1,
			hasher,
			now: later,
			fetchFn: busy.fetchFn,
			sleep: noSleep,
		});
		expect(result.turfsRecomputed).toBe(1);
		expect((await counts(1)).uncontacted_doors).toBe(1);
		expect((await counts(2)).uncontacted_doors).toBe(42);
	});

	it('does the full recompute again once the feature has been switched off and on', async () => {
		const { van, fetchFn } = fakeVan(() => []);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		await clearUncontacted(db);
		expect((await state()).full_recompute_at).toBeNull();
		const later = new Date(NOW.getTime() + 30 * 60 * 1000);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: later,
			fetchFn,
			sleep: noSleep,
		});
		expect((await counts(2)).uncontacted_doors).toBe(1);
	});

	it('recomputes the nudged turf and any it pulled people for, never the rest', async () => {
		const { van, fetchFn } = fakeVan(() => []);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		await client.execute('UPDATE van_turfs SET uncontacted_doors = 42');
		const later = new Date(NOW.getTime() + 30 * 60 * 1000);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: later,
			fetchFn,
			sleep: noSleep,
			recomputeTurfIds: [2],
		});
		expect(result.turfsRecomputed).toBe(1);
		expect((await counts(1)).uncontacted_doors).toBe(42);
		expect((await counts(2)).uncontacted_doors).toBe(1);
	});

	// A nudge fires seconds after the tap, before MiniVAN's sync reaches VAN.
	it('leaves doors knocked unset and countedThrough alone on a nudge', async () => {
		await completion();
		const { van, fetchFn } = fakeVan(() => []);
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
			recomputeTurfIds: [1],
		});
		expect(result.doorsKnockedStamped).toBe(0);
		expect(await knocked()).toBeNull();
		expect((await state()).counted_through).toBeNull();
	});

	it('stamps doors knocked and countedThrough on a scheduled run that caught up', async () => {
		await completion();
		const { van, fetchFn } = fakeVan((w) =>
			w.to === NOW.toISOString() ? [contactRow('111', 2, '9/28/2026 9:00:00 AM')] : [],
		);
		await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});
		expect(await knocked()).toBe(1);
		expect((await state()).counted_through).toBe(NOW.toISOString());
	});

	it('moves neither while a window is still pending', async () => {
		await completion();
		const { van, fetchFn } = fakeVan(() => [], { status: () => 'Pending' });
		const result = await runContactSync(db, van.client, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
			// Room to submit and poll once, but under the 3 s poll interval, so
			// the run stops at the first Pending. A budget of a few ms can lapse
			// before the loop starts, and then no job is submitted at all.
			timeBudgetMs: 2_000,
		});
		expect(result.pending).toBe(true);
		expect(await knocked()).toBeNull();
		expect((await state()).counted_through).toBeNull();
	});

	it('logs an error, and carries on, when VAN lists no in-person contact types', async () => {
		const { van, fetchFn } = fakeVan(() => [contactRow('111', 2, '9/28/2026 9:00:00 AM')]);
		const client2 = { ...van.client, contactTypes: async () => [] } as VanClient;
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await runContactSync(db, client2, {
				campaignId: 1,
				hasher,
				now: NOW,
				fetchFn,
				sleep: noSleep,
			});
			expect(spy).toHaveBeenCalledWith(expect.stringContaining('no in-person contact types'));
			expect(result.cursor).toBe(NOW.toISOString());
			expect(result.contactsRead).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
});
