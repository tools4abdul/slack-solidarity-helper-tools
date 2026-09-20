/**
 * How far the turf-shape pipeline has got, and what is stuck.
 *
 * Read-only, and it makes no VAN call: everything here is in our own database,
 * written by the geometry worker as it drains `van_geometry_queue`. Run it
 * while a big first sync fills in — a statewide cut is thousands of turfs and
 * one export job each, so the map is a mix of shapes and pins for a day and the
 * only question worth answering is whether it is still moving.
 *
 * Usage (from project root):
 *   npm run van:geometry
 *   npm run van:geometry -- --failures 40
 *
 * Required env vars:
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, sql } from 'drizzle-orm';
import { dbConfig } from '../bin/db-config.js';
import { syncLocks, vanGeometryQueue } from '../src/lib/server/schema.js';
import {
	loadGeometryFailures,
	loadGeometryProgress,
} from '../src/lib/server/van/geometry-progress-store.js';
import {
	geometryProgressLabel,
	percentShaped,
	unshapedForever,
} from '../src/lib/van/geometry-progress.js';

const args = process.argv.slice(2);
const failureIdx = args.indexOf('--failures');
const FAILURE_LIMIT = failureIdx >= 0 ? Math.max(1, Number(args[failureIdx + 1]) || 10) : 10;

const db = drizzle(createClient(dbConfig));

/** A 30-cell bar. Progress on a long drain is easier to read as a shape than as
 *  two numbers that barely move between runs. */
function bar(percent: number, width = 30): string {
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
	return `[${'#'.repeat(filled)}${'·'.repeat(width - filled)}]`;
}

async function main(): Promise<void> {
	console.log(`\nTurf geometry — ${dbConfig.url}\n`);

	const progress = await loadGeometryProgress(db);
	const percent = percentShaped(progress);

	console.log(`  ${bar(percent)} ${percent}%`);
	console.log(`  ${geometryProgressLabel(progress)}\n`);

	const n = (value: number) => String(value).padStart(6);
	console.log(`  eligible turfs      ${n(progress.eligible)}`);
	console.log(`  with a hull         ${n(progress.shaped)}`);
	console.log(`  centroid only       ${n(progress.centroidOnly)}   (drawn as a pin, by design)`);
	console.log(`  queued or running   ${n(progress.pending)}`);
	console.log(`  dead-lettered       ${n(progress.failed)}`);
	const stranded = unshapedForever(progress);
	if (stranded > 0) {
		console.log(`  no queue row        ${n(stranded)}   (no saved list, or never queued)`);
	}

	// The queue's own view, which separates the two states an organizer does not
	// need but an operator debugging a stall does.
	const rows = await db
		.select({ status: vanGeometryQueue.status, n: sql<number>`count(*)` })
		.from(vanGeometryQueue)
		.groupBy(vanGeometryQueue.status);
	if (rows.length > 0) {
		console.log('\n  queue rows by status (including retired turf)');
		for (const row of rows.sort((a, b) => a.status.localeCompare(b.status))) {
			console.log(`    ${row.status.padEnd(8)} ${String(row.n).padStart(6)}`);
		}
	}

	// Who holds the sync lock, if anyone. A drain that was killed, or a Fly
	// machine stopped mid-run, leaves the lock behind until its TTL lapses — and
	// until then every scheduled run is a no-op, which looks exactly like a
	// stalled queue.
	const locks = await db.select().from(syncLocks);
	if (locks.length > 0) {
		console.log('\n  sync locks');
		for (const lock of locks) {
			const expiresMs = Date.parse(lock.expiresAt);
			const mins = Number.isNaN(expiresMs) ? null : Math.round((expiresMs - Date.now()) / 60000);
			const state =
				mins === null ? 'unreadable expiry' : mins > 0 ? `HELD, ${mins} min left` : 'expired';
			console.log(`    ${lock.name.padEnd(18)} ${state}  (acquired ${lock.acquiredAt})`);
		}
	}

	// Rows left mid-flight. One or two is a run that ran out of budget and will
	// resume; a pile of them with old timestamps is work nobody is picking up.
	const running = await db
		.select({
			mapRouteId: vanGeometryQueue.mapRouteId,
			exportJobId: vanGeometryQueue.exportJobId,
			attempts: vanGeometryQueue.attempts,
			requestedAt: vanGeometryQueue.requestedAt,
			lastError: vanGeometryQueue.lastError,
		})
		.from(vanGeometryQueue)
		.where(eq(vanGeometryQueue.status, 'running'))
		.limit(5);
	if (running.length > 0) {
		console.log('\n  in flight (oldest first)');
		for (const row of running) {
			console.log(
				`    [${row.mapRouteId}] job ${row.exportJobId ?? '—'} · ${row.attempts} attempt(s) · requested ${row.requestedAt ?? '—'}` +
					(row.lastError ? `\n        ${row.lastError.slice(0, 120)}` : ''),
			);
		}
	}

	if (progress.failed > 0) {
		const failures = await loadGeometryFailures(db, FAILURE_LIMIT);
		console.log(`\n  Dead-lettered turfs (showing ${failures.length} of ${progress.failed})`);
		for (const failure of failures) {
			console.log(`    [${failure.mapRouteId}] ${failure.name} — ${failure.attempts} attempt(s)`);
			if (failure.lastError) console.log(`        ${failure.lastError.slice(0, 160)}`);
		}
		console.log(
			'\n  These have stopped retrying. The usual causes are a wrong\n' +
				'  VAN_EXPORT_JOB_TYPE_ID (5 = VoterCircle carries coordinates; 4 does not)\n' +
				'  and a key without export access — neither of which retrying fixes.',
		);
	}

	if (progress.pending > 0) {
		console.log(
			'\n  Work remains. It drains on the scheduled sync\n' +
				'  (POST /api/internal/van-sync), a few minutes of export jobs per run.',
		);
	}
	console.log('');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
