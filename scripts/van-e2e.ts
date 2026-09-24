/**
 * End-to-end check of every VAN endpoint the tooling calls, against the key in
 * .env.local. Where van-check.ts answers "what can this key see", this answers
 * "does each call the app makes actually work", in the order the app makes
 * them: catalog sync → geometry export → blob download → hull extraction.
 *
 * What it touches:
 *   - Reads only, except ONE `POST /exportJobs` for the smallest turf with a
 *     saved list — the same call the geometry worker makes. It leaves a job in
 *     VAN's export history. Pass --no-export to skip it (and the download).
 *   - `POST .../mapRegions/refresh` is deliberately NOT exercised: it re-cuts a
 *     live region, which can move door counts under organizers.
 *   - The export's webhookUrl carries an invalid token, so the production
 *     callback answers 401 and drains nothing.
 *   - Hull extraction runs with geocoding OFF, so no address leaves this
 *     machine, and only counts are printed — never rows.
 *   - The catalog sync runs as a DRY RUN against every folder holding turf; it
 *     reads the database but writes nothing.
 *
 * /minivanExports is also called once RAW — no retries, full status line,
 * headers and body — because that is what a VAN support ticket needs.
 *
 * Usage (from project root):
 *   npm run van:e2e
 *   npm run van:e2e -- --no-export
 *
 * Required env vars:
 *   VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE, VAN_EXPORT_JOB_TYPE_ID,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import {
	createVanClient,
	VAN_BASE_URL,
	VanError,
	type VanDatabaseMode,
} from '../src/lib/server/van/client.js';
import { extractHull, responseChunks } from '../src/lib/server/van/hull-extract.js';
import { runCatalogSync } from '../src/lib/server/van/sync.js';
import type { VanExportJob, VanMapRegion } from '../src/lib/server/van/types.js';

const SKIP_EXPORT = process.argv.slice(2).includes('--no-export');

const appName = process.env.VAN_APP_NAME ?? '';
const apiKey = process.env.VAN_API_KEY ?? '';
const rawMode = (process.env.VAN_DATABASE_MODE ?? '').trim();
const exportJobTypeId = Number(process.env.VAN_EXPORT_JOB_TYPE_ID ?? '');
const appUrl = process.env.APP_URL ?? '';

if (!appName || !apiKey) {
	console.error('Missing required env vars: VAN_APP_NAME, VAN_API_KEY');
	process.exit(1);
}
if (rawMode !== '0' && rawMode !== '1') {
	console.error(`VAN_DATABASE_MODE must be 0 or 1, got "${rawMode}".`);
	process.exit(1);
}
const mode = Number(rawMode) as VanDatabaseMode;
const client = createVanClient({ appName, apiKey, databaseMode: mode });

// VAN requires an HTTPS webhook and POSTs the finished job to it. The token is
// invalid on purpose: the callback rejects it with a 401 before doing anything.
const webhookHost = appUrl.startsWith('https://')
	? appUrl.replace(/\/+$/, '')
	: 'https://slack-solidarity-helper-tools.fly.dev';
const WEBHOOK_URL = `${webhookHost}/api/internal/van-export-callback?turf=0&token=e2e-invalid`;

const EXPORT_POLL_MS = 3000;
const EXPORT_MAX_POLLS = 20;

type Outcome = 'ok' | 'FAIL' | 'skip';
const results: Array<{ step: string; outcome: Outcome; note: string }> = [];

function record(step: string, outcome: Outcome, note = ''): void {
	results.push({ step, outcome, note });
	const tag = outcome === 'ok' ? '  ok  ' : outcome === 'FAIL' ? ' FAIL ' : ' skip ';
	console.log(`[${tag}] ${step}${note ? ` — ${note}` : ''}`);
}

function describe(err: unknown): string {
	if (err instanceof VanError) return `HTTP ${err.status} ${err.message}`.slice(0, 300);
	return err instanceof Error ? err.message : String(err);
}

async function step<T>(name: string, run: () => Promise<T>, note?: (v: T) => string) {
	try {
		const value = await run();
		record(name, 'ok', note?.(value) ?? '');
		return value;
	} catch (err) {
		record(name, 'FAIL', describe(err));
		return null;
	}
}

function section(title: string): void {
	console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

/** One request, no retries, everything VAN sent back. The client's retry loop
 *  would print only the last of five attempts and none of the headers. */
async function rawMinivanExports(): Promise<void> {
	const url = `${VAN_BASE_URL}/minivanExports?$expand=canvassers&$top=50`;
	const auth = Buffer.from(`${appName}:${apiKey}|${mode}`).toString('base64');
	const sentAt = new Date().toISOString();
	const res = await fetch(url, {
		headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
	});
	const body = await res.text();
	console.log(`  Request:  GET ${url}`);
	console.log(`  App name: ${appName}   database mode: ${mode}`);
	console.log(`  Sent at:  ${sentAt}`);
	console.log(`\n  HTTP ${res.status} ${res.statusText}`);
	for (const [name, value] of res.headers) {
		console.log(`  ${name}: ${name === 'set-cookie' ? '(redacted)' : value}`);
	}
	console.log('');
	console.log(
		body.length > 2000
			? `${body.slice(0, 2000)}\n  … (${body.length} bytes)`
			: body
					.split('\n')
					.map((l) => `  ${l}`)
					.join('\n'),
	);
	if (res.ok) record('GET /minivanExports (raw, no retry)', 'ok', `HTTP ${res.status}`);
	else record('GET /minivanExports (raw, no retry)', 'FAIL', `HTTP ${res.status}`);
}

async function main(): Promise<void> {
	console.log(`\nVAN end-to-end — app "${appName}", mode ${mode}`);
	console.log(`Database (read only; sync is a dry run): ${dbConfig.url}`);

	section('Catalog reads');
	const folders = await step(
		'GET /folders',
		() => client.folders(),
		(f) => `${f.length} folder(s)`,
	);
	if (!folders || folders.length === 0) {
		console.log('\nNo folders — nothing else can be exercised.');
		return summarise();
	}

	// Every folder, not just the first with turf: the sync reads each mapped
	// folder, and a failure on one must not hide behind success on another.
	const regionsByFolder = new Map<number, VanMapRegion[]>();
	for (const folder of folders) {
		const regions = await step(
			`GET /folders/${folder.folderId}/mapRegions`,
			() => client.mapRegions(folder.folderId),
			(r) =>
				`${r.length} region(s), ${r.reduce((n, x) => n + (x.mapRoutes?.length ?? 0), 0)} route(s) · ${folder.name}`,
		);
		if (regions && regions.length > 0) regionsByFolder.set(folder.folderId, regions);
	}
	const turfFolderIds = [...regionsByFolder.keys()];
	const routes = [...regionsByFolder.values()].flat().flatMap((r) => r.mapRoutes ?? []);

	// The folder-scoped form the sync uses, and the cross-check it feeds.
	if (turfFolderIds.length > 0) {
		await step(
			`GET /printedLists?folderIds=${turfFolderIds.join(',')}`,
			() => client.printedLists(turfFolderIds),
			(lists) => {
				const withNumber = routes.filter((r) => r.printedList?.number).length;
				return `${lists.length} printed list(s); ${withNumber}/${routes.length} route(s) carry a list number`;
			},
		);
	} else {
		record('GET /printedLists?folderIds=…', 'skip', 'no folder holds turf');
	}
	await step(
		'GET /savedLists',
		() => client.savedLists(),
		(l) => `${l.length} saved list(s)`,
	);
	await step(
		'GET /exportJobTypes',
		() => client.exportJobTypes(),
		(types) => {
			const configured = types.find((t) => t.exportJobTypeId === exportJobTypeId);
			if (!configured) throw new Error(`VAN_EXPORT_JOB_TYPE_ID=${exportJobTypeId} is not offered`);
			return `VAN_EXPORT_JOB_TYPE_ID=${exportJobTypeId} is "${configured.name}"`;
		},
	);
	await step(
		'GET /minivanExports (client, with retries)',
		() =>
			client.minivanExportsSince(
				new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
				1,
			),
		(e) => `${e.items.length} export(s) on the first page of the last week`,
	);

	section('GET /minivanExports — raw response');
	await rawMinivanExports().catch((err) =>
		record('GET /minivanExports (raw, no retry)', 'FAIL', describe(err)),
	);

	section('Catalog sync (dry run)');
	if (turfFolderIds.length === 0) {
		record('runCatalogSync', 'skip', 'no folder holds turf');
	} else {
		const db = drizzle(createClient(dbConfig));
		const sync = await step(
			'runCatalogSync (dry run, all turf folders → one test chapter)',
			() =>
				runCatalogSync(
					db,
					client,
					[{ chapterId: -1, chapterName: 'e2e dry run', folderIds: turfFolderIds }],
					{ dryRun: true },
				),
			(r) =>
				`${r.foldersSynced} folder(s) synced, ${r.foldersSkipped} skipped, ` +
				`${r.turfsUpserted} turf(s) planned, ${r.geometryQueued} queued for geometry`,
		);
		for (const line of sync?.degraded ?? []) console.log(`         degraded: ${line}`);
		for (const line of sync?.warnings ?? []) console.log(`         warning:  ${line}`);
	}

	section('Geometry export');
	if (SKIP_EXPORT) {
		record('POST /exportJobs', 'skip', '--no-export');
		return summarise();
	}
	if (!Number.isFinite(exportJobTypeId) || exportJobTypeId <= 0) {
		record('POST /exportJobs', 'FAIL', 'VAN_EXPORT_JOB_TYPE_ID is not set');
		return summarise();
	}
	// Smallest route: the cheapest export VAN can run, and the likeliest to come
	// back Completed on the POST itself.
	const target = routes
		.filter((r) => r.savedListId)
		.sort((a, b) => (a.routeSize ?? Infinity) - (b.routeSize ?? Infinity))[0];
	if (!target) {
		record('POST /exportJobs', 'skip', 'no route has a savedListId');
		return summarise();
	}
	console.log(
		`  Turf: ${target.name} (route ${target.mapRouteId}, savedListId ${target.savedListId}, ` +
			`${target.routeSize ?? '?'} people)`,
	);
	console.log(`  Webhook (invalid token, rejected with 401): ${WEBHOOK_URL}`);

	let job = await step(
		'POST /exportJobs',
		() =>
			client.createExportJob({
				savedListId: target.savedListId!,
				exportJobTypeId,
				webhookUrl: WEBHOOK_URL,
			}),
		(j) =>
			`job ${j.exportJobId}, status ${j.status}${j.downloadUrl ? ', downloadUrl present' : ''}`,
	);
	if (!job) return summarise();

	// Always read it back once, even when the POST already finished: the worker
	// resumes interrupted jobs through this GET, so it has to work on its own.
	let polls = 0;
	do {
		if (polls > 0) await new Promise((r) => setTimeout(r, EXPORT_POLL_MS));
		const id: number = job.exportJobId;
		const next: VanExportJob | null = await step(
			`GET /exportJobs/${id}${polls > 0 ? ` (poll ${polls})` : ''}`,
			() => client.exportJob(id),
			(j) => `status ${j.status}${j.downloadUrl ? ', downloadUrl present' : ''}`,
		);
		if (!next) return summarise();
		job = next;
		polls++;
	} while (!job.downloadUrl && !/^error$/i.test(job.status ?? '') && polls <= EXPORT_MAX_POLLS);

	if (!job.downloadUrl) {
		record('Download export file', 'FAIL', `no downloadUrl (status ${job.status})`);
		return summarise();
	}

	// Plain fetch, never the VAN client: the blob host is not VAN's, and our
	// Basic credentials must not travel to it (geometry-worker.ts does the same).
	const res = await fetch(job.downloadUrl, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		record('Download export file', 'FAIL', `HTTP ${res.status}`);
		return summarise();
	}
	record('Download export file', 'ok', `HTTP ${res.status}`);

	await step(
		'Extract hull (geocoding off)',
		() => extractHull(responseChunks(res), { geocode: null }),
		(h) =>
			`${h.rowCount} row(s), ${h.pointCount} with coordinates, ` +
			`${h.rowsWithoutCoordinates} without, ${h.outliersDropped} outlier(s) dropped · ` +
			(h.hull.length >= 3
				? `hull of ${h.hull.length} vertices, ${Math.round(h.hullExtentMeters ?? 0)} m across` +
					(h.hullTooLarge ? ' (TOO LARGE)' : '')
				: h.centre
					? 'no hull, centroid only (renders as a pin)'
					: 'NO geometry'),
	);

	summarise();
}

function summarise(): void {
	const failed = results.filter((r) => r.outcome === 'FAIL');
	section('Summary');
	console.log(
		`  ${results.filter((r) => r.outcome === 'ok').length} ok, ${failed.length} failed, ` +
			`${results.filter((r) => r.outcome === 'skip').length} skipped`,
	);
	for (const r of failed) console.log(`  FAIL ${r.step}`);
	console.log('  Not exercised: POST /folders/{id}/mapRegions/refresh (re-cuts live turf)\n');
	process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
