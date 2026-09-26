import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	JOBS,
	createScheduler,
	latestSlot,
	localCaller,
	nextSlot,
	type Caller,
	type Job,
} from './scheduler.js';

// A real in-memory libsql, like sync-lock.test.ts: the claim that stops two
// machines running the same slot is the lock's atomic upsert. Only Date is
// faked, so the scheduler and the lock read the same clock while promises and
// timers stay real.
let db: LibSQLDatabase<Record<string, unknown>>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await client.execute(`
		CREATE TABLE sync_locks (
			name text PRIMARY KEY NOT NULL,
			token text NOT NULL,
			acquired_at text NOT NULL,
			expires_at text NOT NULL
		);
	`);
	db = drizzle(client);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const at = (iso: string) => new Date(`2026-09-25T${iso}:00Z`);
const MINUTE = 60_000;
const job = (name: string) => JOBS.find((j) => j.name === name)!;
const setNow = (d: Date) => vi.setSystemTime(d);

/** Every slot a job has in one UTC day, as HH:MM. */
function day(j: Job): string[] {
	const times: string[] = [];
	let t = new Date(at('00:00').getTime() - MINUTE);
	for (;;) {
		t = nextSlot(j.schedule, t);
		if (t.getUTCDate() !== 25) return times;
		times.push(t.toISOString().slice(11, 16));
	}
}

describe('the schedules', () => {
	it('runs the VAN sync every 30 minutes from 11:07 UTC and hourly overnight', () => {
		const times = day(job('van-sync'));
		expect(times).toHaveLength(37);
		expect(times.slice(0, 2)).toEqual(['00:07', '01:07']);
		expect(times.slice(10, 13)).toEqual(['10:07', '11:07', '11:37']);
		expect(times.at(-1)).toBe('23:37');
	});

	// The expiry warning needs a run inside every six hours; see the workflow.
	it('never leaves more than an hour between VAN syncs', () => {
		const j = job('van-sync');
		let t = at('00:00');
		for (let i = 0; i < 60; i++) {
			const next = nextSlot(j.schedule, t);
			expect(next.getTime() - t.getTime()).toBeLessThanOrEqual(60 * MINUTE);
			t = next;
		}
	});

	it('runs Mobilize every 30 minutes plus 07:40, and the invite audit hourly at :05', () => {
		const mobilize = day(job('mobilize-sync'));
		expect(mobilize).toHaveLength(49);
		expect(mobilize).toContain('07:40');
		expect(day(job('slack-invite-audit'))).toEqual(
			Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:05`),
		);
	});
});

describe('latestSlot', () => {
	const schedule = [{ hours: [11], minutes: [7] }];

	it('finds a slot that came due within the window', () => {
		expect(latestSlot(schedule, new Date(at('11:07').getTime() + 30_000), 10 * MINUTE)).toEqual(
			at('11:07'),
		);
		expect(latestSlot(schedule, at('11:16'), 10 * MINUTE)).toEqual(at('11:07'));
	});

	it('lets a slot go once it is older than the window', () => {
		expect(latestSlot(schedule, at('11:18'), 10 * MINUTE)).toBeNull();
		expect(latestSlot(schedule, at('11:06'), 10 * MINUTE)).toBeNull();
	});
});

/** A caller that records what it was asked, answering from `answer`. */
function recorder(answer: (path: string, n: number) => Record<string, unknown> = () => ({})) {
	const calls: Array<{ path: string; params: Record<string, string> }> = [];
	const call: Caller = async (path, params) => {
		calls.push({ path, params });
		return answer(path, calls.filter((c) => c.path === path).length);
	};
	return { calls, call };
}

describe('createScheduler', () => {
	it('runs a slot once, however many ticks see it', async () => {
		const { calls, call } = recorder();
		setNow(at('11:07'));
		const { tick } = createScheduler({ db, call, jobs: [job('van-sync')] });
		await tick();
		setNow(new Date(at('11:07').getTime() + 30_000));
		await tick();
		setNow(at('11:15'));
		await tick();
		expect(calls.map((c) => c.path)).toEqual(['/api/internal/van-sync']);

		setNow(at('11:37'));
		await tick();
		expect(calls).toHaveLength(2);
	});

	it('catches up a slot missed by a restart, not one long gone', async () => {
		const { calls, call } = recorder();
		setNow(at('11:12'));
		await createScheduler({ db, call, jobs: [job('van-sync')] }).tick();
		expect(calls).toHaveLength(1);

		// A different database: the first scheduler's claim is not in it.
		const other = createClient({ url: ':memory:' });
		await other.execute(
			'CREATE TABLE sync_locks (name text PRIMARY KEY NOT NULL, token text NOT NULL, acquired_at text NOT NULL, expires_at text NOT NULL)',
		);
		const late = recorder();
		setNow(at('11:30'));
		await createScheduler({ db: drizzle(other), call: late.call, jobs: [job('van-sync')] }).tick();
		other.close();
		expect(late.calls).toHaveLength(0);
	});

	it('runs each slot on one machine only', async () => {
		const a = recorder();
		const b = recorder();
		setNow(at('11:07'));
		await createScheduler({ db, call: a.call, jobs: [job('van-sync')] }).tick();
		await createScheduler({ db, call: b.call, jobs: [job('van-sync')] }).tick();
		expect(a.calls).toHaveLength(1);
		expect(b.calls).toHaveLength(0);

		// The claim lapses before the next slot, so either machine can take it.
		setNow(at('11:37'));
		await createScheduler({ db, call: b.call, jobs: [job('van-sync')] }).tick();
		expect(b.calls).toHaveLength(1);
	});

	it('queues a slot that comes due mid-run, keeping only the newest', async () => {
		const order: string[] = [];
		let release!: () => void;
		const slow: Job = {
			name: 'slow',
			schedule: [{ hours: [11], minutes: [0, 1, 2] }],
			run: async (slot) => {
				order.push(slot.toISOString().slice(11, 16));
				if (order.length === 1) await new Promise<void>((r) => (release = r));
			},
		};
		setNow(at('11:00'));
		const { tick } = createScheduler({ db, call: recorder().call, jobs: [slow] });
		const first = tick();
		await vi.waitFor(() => expect(order).toEqual(['11:00']));
		setNow(at('11:01'));
		void tick();
		setNow(at('11:02'));
		void tick();
		release();
		await first;
		expect(order).toEqual(['11:00', '11:02']);
	});

	it('keeps running other jobs when one fails', async () => {
		const { calls, call } = recorder();
		const failing: Job = {
			name: 'failing',
			schedule: [{ hours: [11], minutes: [5] }],
			run: async () => {
				throw new Error('boom');
			},
		};
		setNow(at('11:05'));
		await createScheduler({ db, call, jobs: [failing, job('slack-invite-audit')] }).tick();
		expect(calls.map((c) => c.path)).toEqual(['/api/internal/slack-invite-audit']);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failing 11:05'), 'boom');
	});
});

describe('the Mobilize job', () => {
	const run = (slot: string, call: Caller) => job('mobilize-sync').run(at(slot), call);

	it('runs events quietly and then signups inside the 4.5-hour window', async () => {
		const { calls, call } = recorder();
		await run('11:30', call);
		expect(calls).toEqual([
			{ path: '/api/internal/mobilize-sync', params: { quiet: '1' } },
			{ path: '/api/internal/attendee-sync', params: { window: '4.5' } },
		]);
	});

	it('reports edits and drops the window on the nightly pass', async () => {
		const { calls, call } = recorder();
		await run('07:40', call);
		expect(calls).toEqual([
			{ path: '/api/internal/mobilize-sync', params: {} },
			{ path: '/api/internal/attendee-sync', params: {} },
		]);
	});

	it('re-posts the event sync until it is complete', async () => {
		const { calls, call } = recorder((path, n) =>
			path.endsWith('mobilize-sync') ? { incomplete: n < 3 } : {},
		);
		await run('11:30', call);
		expect(calls.map((c) => c.path)).toEqual([
			'/api/internal/mobilize-sync',
			'/api/internal/mobilize-sync',
			'/api/internal/mobilize-sync',
			'/api/internal/attendee-sync',
		]);
	});

	it('stops re-posting when another sync holds the lock', async () => {
		const { calls, call } = recorder((path) =>
			path.endsWith('mobilize-sync') ? { skipped: true, incomplete: true } : {},
		);
		await run('11:30', call);
		expect(calls.map((c) => c.path)).toEqual([
			'/api/internal/mobilize-sync',
			'/api/internal/attendee-sync',
		]);
	});

	it('still syncs signups when the event half fails, then reports the failure', async () => {
		const calls: string[] = [];
		const call: Caller = async (path) => {
			calls.push(path);
			if (path.endsWith('mobilize-sync')) throw new Error('events down');
			return {};
		};
		await expect(run('11:30', call)).rejects.toThrow('events down');
		expect(calls).toEqual(['/api/internal/mobilize-sync', '/api/internal/attendee-sync']);
	});

	it('gives up on an event sync that never completes', async () => {
		const { calls, call } = recorder((path) =>
			path.endsWith('mobilize-sync') ? { incomplete: true } : {},
		);
		await expect(run('11:30', call)).rejects.toThrow('still incomplete after 12 requests');
		expect(calls.filter((c) => c.path.endsWith('mobilize-sync'))).toHaveLength(12);
		expect(calls.at(-1)!.path).toBe('/api/internal/attendee-sync');
	});
});

describe('localCaller', () => {
	let server: http.Server;
	let port: number;
	const seen: string[] = [];

	beforeEach(async () => {
		seen.length = 0;
		server = http.createServer((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			if (req.url?.startsWith('/slow')) return; // never answers
			const status = req.url?.startsWith('/broken') ? 500 : 200;
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(status === 200 ? { ok: true } : { error: 'bad' }));
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	});

	it('POSTs with the key and parameters, and returns the JSON', async () => {
		const call = localCaller(port, 's3cret');
		expect(await call('/api/x', { window: '4.5' }, MINUTE)).toEqual({ ok: true });
		expect(seen).toEqual(['POST /api/x?key=s3cret&window=4.5']);
	});

	it('rejects a non-2xx answer without the key in the message', async () => {
		const call = localCaller(port, 's3cret');
		const err = await call('/broken', {}, MINUTE).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('/broken answered 500');
		expect((err as Error).message).not.toContain('s3cret');
	});

	it('gives up after the timeout', async () => {
		await expect(localCaller(port, 'k')('/slow', {}, 50)).rejects.toThrow('/slow took longer');
	});
});
