// The app's own clock for its scheduled syncs.
//
// These used to be GitHub Actions crons alone, and GitHub treats a schedule as
// a suggestion: from 2026-09-20 to 09-25 the VAN catalog sync, asked for 37
// times a day, ran 5 to 7 times, with gaps of up to 6h23m. That gap broke the
// six-hour expiry warning, which only reaches a volunteer if a run lands inside
// the six hours before their claim lapses. The machine Fly keeps running
// (`min_machines_running = 1`) keeps better time than that.
//
// Each job calls its existing /api/internal endpoint on this machine, exactly
// as the workflows do over the internet, so the endpoint stays the one place
// that decides what a run does, and the workflows stay as a backup. A run the
// workflow also triggers is harmless: every endpoint takes its own lock and is
// idempotent.
//
// A slot fires once. Missed by up to CATCH_UP_MS (a deploy restarting the
// process) it still fires; missed by more, it is left for the next one. With
// more than one machine up, the first to claim the job's `sync_locks` row runs
// it and the others skip; the claim lasts until just before the next slot.

import http from 'node:http';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { acquireSyncLock } from './sync-lock.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

const LOG = '[scheduler]';

const MINUTE = 60_000;
const TICK_MS = 30_000;
/** How late a slot may still fire. Covers a restart; much more and the run
 *  would land close enough to the next slot to be pointless. */
const CATCH_UP_MS = 10 * MINUTE;

/** Cron-style times, in UTC: every listed minute of every listed hour. */
export interface Slots {
	hours: readonly number[];
	minutes: readonly number[];
}

const EVERY_HOUR = Array.from({ length: 24 }, (_, h) => h);
const hoursFrom = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

function matches(schedule: readonly Slots[], at: Date): boolean {
	return schedule.some(
		(s) => s.hours.includes(at.getUTCHours()) && s.minutes.includes(at.getUTCMinutes()),
	);
}

/** The latest slot at or before `now`, if there is one within `withinMs`. */
export function latestSlot(schedule: readonly Slots[], now: Date, withinMs: number): Date | null {
	const minute = Math.floor(now.getTime() / MINUTE) * MINUTE;
	for (let t = minute; t >= now.getTime() - withinMs; t -= MINUTE) {
		if (matches(schedule, new Date(t))) return new Date(t);
	}
	return null;
}

/** The first slot strictly after `after`. */
export function nextSlot(schedule: readonly Slots[], after: Date): Date {
	const start = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
	for (let t = start; t < start + 2 * 24 * 60 * MINUTE; t += MINUTE) {
		if (matches(schedule, new Date(t))) return new Date(t);
	}
	throw new Error('schedule has no slot in the next two days');
}

/**
 * POST to one of this app's internal endpoints. Resolves with the parsed JSON
 * body; rejects on a non-2xx answer or the timeout.
 */
export type Caller = (
	path: string,
	params: Record<string, string>,
	timeoutMs: number,
) => Promise<Record<string, unknown>>;

export interface Job {
	name: string;
	schedule: readonly Slots[];
	run: (slot: Date, call: Caller) => Promise<void>;
}

/** Mirrors van-catalog-sync.yml: every 30 minutes by day, hourly overnight. No
 *  two runs more than an hour apart — see that file for why that matters. */
const vanSync: Job = {
	name: 'van-sync',
	schedule: [
		{ hours: hoursFrom(11, 23), minutes: [7, 37] },
		{ hours: hoursFrom(0, 10), minutes: [7] },
	],
	run: async (_slot, call) => {
		await call('/api/internal/van-sync', {}, 5 * MINUTE);
	},
};

/** The 07:40 UTC pass: no signup window, and routine event edits reported. */
const MOBILIZE_NIGHTLY = { hour: 7, minute: 40 };
/** Requests the event half may take before it is treated as stuck. */
const MOBILIZE_MAX_CHUNKS = 12;

/** Mirrors mobilize-sync.yml, whose comments explain the window and `quiet`. */
const mobilizeSync: Job = {
	name: 'mobilize-sync',
	schedule: [
		{ hours: EVERY_HOUR, minutes: [0, 30] },
		{ hours: [MOBILIZE_NIGHTLY.hour], minutes: [MOBILIZE_NIGHTLY.minute] },
	],
	run: async (slot, call) => {
		const nightly =
			slot.getUTCHours() === MOBILIZE_NIGHTLY.hour &&
			slot.getUTCMinutes() === MOBILIZE_NIGHTLY.minute;

		// Events first: they record the timeslot pairings the signups read.
		// A failure here still lets the signup half run, as in the workflow.
		let eventsError: unknown = null;
		try {
			for (let chunk = 1; ; chunk++) {
				const res = await call(
					'/api/internal/mobilize-sync',
					nightly ? {} : { quiet: '1' },
					5 * MINUTE,
				);
				if (res.skipped || res.incomplete !== true) break;
				if (chunk === MOBILIZE_MAX_CHUNKS) {
					throw new Error(`still incomplete after ${MOBILIZE_MAX_CHUNKS} requests`);
				}
			}
		} catch (err) {
			eventsError = err;
		}

		await call(
			'/api/internal/attendee-sync',
			nightly ? {} : { window: '4.5' },
			(nightly ? 50 : 15) * MINUTE,
		);
		if (eventsError) throw eventsError;
	},
};

/** Mirrors slack-invite-audit.yml. */
const slackInviteAudit: Job = {
	name: 'slack-invite-audit',
	schedule: [{ hours: EVERY_HOUR, minutes: [5] }],
	run: async (_slot, call) => {
		await call('/api/internal/slack-invite-audit', {}, 10 * MINUTE);
	},
};

export const JOBS: readonly Job[] = [vanSync, mobilizeSync, slackInviteAudit];

/**
 * Calls this machine's own server. `node:http` rather than fetch: fetch gives
 * up waiting for response headers after five minutes, and the nightly
 * attendee sync answers only when it is done.
 */
export function localCaller(port: number, secret: string): Caller {
	return (path, params, timeoutMs) =>
		new Promise((resolve, reject) => {
			const query = new URLSearchParams({ key: secret, ...params });
			const req = http.request(
				{ host: '127.0.0.1', port, method: 'POST', path: `${path}?${query}` },
				(res) => {
					let body = '';
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => (body += chunk));
					res.on('end', () => {
						// Never the URL in an error: it carries the secret.
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							reject(new Error(`${path} answered ${status}: ${body.slice(0, 300)}`));
							return;
						}
						try {
							resolve(JSON.parse(body) as Record<string, unknown>);
						} catch {
							resolve({});
						}
					});
					res.on('error', reject);
				},
			);
			req.setTimeout(timeoutMs, () =>
				req.destroy(new Error(`${path} took longer than ${timeoutMs / MINUTE} minutes`)),
			);
			req.on('error', reject);
			req.end();
		});
}

export interface SchedulerOptions {
	db: Db;
	call: Caller;
	jobs?: readonly Job[];
}

/**
 * The scheduler's state and its tick, without the timer, so tests can drive
 * it. `tick` returns once every run it started has finished.
 */
export function createScheduler(options: SchedulerOptions) {
	const { db, call } = options;
	const jobs = options.jobs ?? JOBS;

	/** The latest slot each job has taken on, run or queued. */
	const taken = new Map<string, number>();
	const running = new Map<string, Promise<void>>();
	/** A slot that came due while the job was still running. Only the newest
	 *  is kept: two runs back to back would do nothing the second can't. */
	const queued = new Map<string, Date>();

	async function fire(job: Job, slot: Date): Promise<void> {
		const label = `${job.name} ${slot.toISOString().slice(11, 16)}`;
		const until = nextSlot(job.schedule, slot).getTime() - MINUTE;
		let claimed: string | null;
		try {
			claimed = await acquireSyncLock(
				db,
				`schedule:${job.name}`,
				Math.max(until - Date.now(), MINUTE),
			);
		} catch (err) {
			console.error(`${LOG} ${label}: could not claim the run:`, err);
			return;
		}
		if (claimed === null) {
			console.log(`${LOG} ${label}: another machine has this one`);
			return;
		}
		const started = Date.now();
		try {
			await job.run(slot, call);
			console.log(`${LOG} ${label}: done in ${Math.round((Date.now() - started) / 1000)}s`);
		} catch (err) {
			console.error(`${LOG} ${label}: failed:`, err instanceof Error ? err.message : err);
		}
	}

	function start(job: Job, slot: Date): Promise<void> {
		const run = (async () => {
			let next: Date | undefined = slot;
			while (next) {
				await fire(job, next);
				next = queued.get(job.name);
				queued.delete(job.name);
			}
			running.delete(job.name);
		})();
		running.set(job.name, run);
		return run;
	}

	async function tick(): Promise<void> {
		const at = new Date();
		const started: Promise<void>[] = [];
		for (const job of jobs) {
			const slot = latestSlot(job.schedule, at, CATCH_UP_MS);
			if (!slot || (taken.get(job.name) ?? -Infinity) >= slot.getTime()) continue;
			taken.set(job.name, slot.getTime());
			const busy = running.get(job.name);
			if (busy) {
				queued.set(job.name, slot);
				started.push(busy);
			} else {
				started.push(start(job, slot));
			}
		}
		await Promise.all(started);
	}

	return { tick };
}

/** Start ticking. Returns a function that stops it. */
export function startScheduler(options: SchedulerOptions): () => void {
	const { tick } = createScheduler(options);
	console.log(`${LOG} running ${(options.jobs ?? JOBS).map((j) => j.name).join(', ')}`);
	// The first tick waits a full interval, so the server is listening by then.
	const timer = setInterval(() => void tick(), TICK_MS);
	timer.unref();
	return () => clearInterval(timer);
}
