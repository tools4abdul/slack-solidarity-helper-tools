import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGeometryQueue, MAX_ATTEMPTS } from './geometry-worker.js';
import { VanError, type VanClient } from './client.js';
import { vanGeometryQueue, vanTurfs } from '../schema.js';
import type { VanExportJob } from './types.js';

const HEADER = 'VanID,FirstName,LastName,Address,VAddressLatitude,VAddressLongitude,DOB';
/** A square of doors plus an interior one — four hull vertices. */
const SQUARE_CSV = [
	HEADER,
	'1,Ron,Campbell,"4190 S Kirkman Rd , Orlando, FL",28.500,-81.400,1968-08-09',
	'2,Ada,Lovelace,"12 Main St , Orlando, FL",28.510,-81.400,1815-12-10',
	'3,Alan,Turing,"9 Elm St , Orlando, FL",28.510,-81.390,1912-06-23',
	'4,Grace,Hopper,"3 Oak St , Orlando, FL",28.500,-81.390,1906-12-09',
	'5,Katherine,Johnson,"7 Pine St , Orlando, FL",28.505,-81.395,1918-08-26',
	'',
].join('\r\n');

/**
 * A stateful stub of the drizzle chains the worker uses. Rows are keyed by
 * primary key so a read-modify-write across two tables behaves like the real
 * thing — the worker's whole retry design is read-modify-write, and a stub
 * that only recorded calls would let a broken state transition pass.
 */
function makeDb(queueRows: Record<string, unknown>[], turfRows: Record<string, unknown>[]) {
	const tables = new Map<unknown, Record<string, unknown>[]>([
		[vanGeometryQueue, queueRows],
		[vanTurfs, turfRows],
	]);
	const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

	function thenableFor(table: unknown) {
		const chain: Record<string, unknown> = {
			where: () => chain,
			orderBy: () => chain,
			limit: () => chain,
			// Copies, because drizzle hands back plain objects rather than live
			// rows. Returning the stored objects would let an update silently
			// mutate a row the caller is still holding — which real code would
			// never see, so a test must not either.
			then: (resolve: (v: unknown) => unknown) =>
				Promise.resolve((tables.get(table) ?? []).map((row) => ({ ...row }))).then(resolve),
		};
		return chain;
	}

	const db = {
		select: () => ({ from: (table: unknown) => thenableFor(table) }),
		update: (table: unknown) => ({
			set: (patch: Record<string, unknown>) => {
				updates.push({ table, patch });
				// The stub applies the patch, so a later read in the same run
				// sees it — that is what makes the resume path testable.
				for (const row of tables.get(table) ?? []) Object.assign(row, patch);
				return { where: () => Promise.resolve(undefined) };
			},
		}),
	};
	return { db: db as never, updates, queueRows, turfRows };
}

function patchesFor(
	updates: Array<{ table: unknown; patch: Record<string, unknown> }>,
	table: unknown,
) {
	return updates.filter((u) => u.table === table).map((u) => u.patch);
}

function job(over: Partial<VanExportJob> = {}): VanExportJob {
	return {
		exportJobId: 900,
		type: 5,
		savedListId: 585052,
		status: 'Completed',
		downloadUrl: 'https://ngpvan.blob.core.windows.net/canvass-files-votercircle/x.csv',
		dateExpired: null,
		errorCode: null,
		...over,
	};
}

function makeClient(over: Partial<VanClient> = {}): VanClient {
	return {
		folders: async () => [],
		mapRegions: async () => [],
		printedLists: async () => [],
		savedLists: async () => [],
		minivanExports: async () => [],
		refreshMapRegion: async () => undefined,
		exportJobTypes: async () => [],
		createExportJob: async () => job(),
		exportJob: async () => job(),
		get: async () => undefined as never,
		...over,
	};
}

function okCsv(body = SQUARE_CSV) {
	// Typed with fetch's own parameters so `mock.calls` carries them — the
	// "no credentials" assertion below reads the second argument.
	return async (...args: [RequestInfo | URL, RequestInit?]) => {
		void args;
		return new Response(body, { status: 200 });
	};
}

const OPTIONS = {
	exportJobTypeId: 5,
	// Per turf, as in production: the URL VAN stores carries a token scoped to
	// the turf rather than a shared secret. See webhook-token.ts.
	webhookUrlFor: (mapRouteId: number) =>
		`https://solidarity-slack-helper-tools.fly.dev/api/internal/van-export-callback?turf=${mapRouteId}&token=sig${mapRouteId}`,
	sleep: async () => undefined,
};

function pendingRow(over: Record<string, unknown> = {}) {
	return { mapRouteId: 100, savedListId: 585052, exportJobId: null, attempts: 0, ...over };
}

let calls = 0;
beforeEach(() => {
	calls = 0;
});

describe('runGeometryQueue', () => {
	it('turns a pending turf into a stored hull', async () => {
		const { db, updates, turfRows } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(db, makeClient(), { ...OPTIONS, fetchFn: okCsv() });

		expect(result.hullsStored).toBe(1);
		expect(result.attempted).toBe(1);

		const turfPatch = patchesFor(updates, vanTurfs)[0]!;
		expect(JSON.parse(turfPatch.hullJson as string)).toHaveLength(4);
		expect(turfPatch.centroidLat).toBe(28.505);
		expect(turfPatch.centroidLng).toBe(-81.395);
		// The hull is only valid against the route as it stands now, which is
		// exactly what the staleness check in catalog.ts compares against.
		expect(turfPatch.hullSourceRouteSize).toBe(76);
		expect(turfRows[0].hullJson).toBeTruthy();

		const queuePatches = patchesFor(updates, vanGeometryQueue);
		expect(queuePatches[0]!.status).toBe('running');
		expect(queuePatches.at(-1)!.status).toBe('done');
	});

	// The webhook URL is built per turf, and VAN keeps it forever — so what goes
	// into it is a privacy-relevant decision, not a formatting one. Asserting the
	// turf id reaches the builder is what stops it silently going back to one
	// shared URL carrying INTERNAL_CRON_SECRET.
	it('passes the configured type id and this turf own webhook url to VAN', async () => {
		const createExportJob = vi.fn(async () => job());
		const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		await runGeometryQueue(db, makeClient({ createExportJob }), { ...OPTIONS, fetchFn: okCsv() });

		expect(createExportJob).toHaveBeenCalledWith({
			savedListId: 585052,
			exportJobTypeId: 5,
			webhookUrl: OPTIONS.webhookUrlFor(100),
		});
		expect(OPTIONS.webhookUrlFor(100)).toContain('turf=100');
	});

	// Verified against the live API: a small list is already Completed on the
	// POST response, so the common case must not poll at all.
	it('does not poll when the POST already returned a downloadUrl', async () => {
		const exportJob = vi.fn(async () => job());
		const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		await runGeometryQueue(db, makeClient({ exportJob }), { ...OPTIONS, fetchFn: okCsv() });
		expect(exportJob).not.toHaveBeenCalled();
	});

	// The download goes to Azure, not api.securevan.com. Routing it through the
	// VAN client would attach our Basic credentials to a third-party host.
	it('downloads the CSV with a bare fetch and no credentials', async () => {
		const fetchFn = vi.fn(okCsv());
		const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		await runGeometryQueue(db, makeClient(), { ...OPTIONS, fetchFn });

		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(String(url)).toContain('blob.core.windows.net');
		// An abort signal is the only thing in `init`. Anything resembling a
		// credential here would be our VAN Basic header going to Azure.
		expect(Object.keys(init ?? {})).toEqual(['signal']);
		expect(init!.signal).toBeInstanceOf(AbortSignal);
	});

	// A blob that trickles rather than failing is otherwise outside every budget
	// in the file — the poll loop has already returned by then.
	it('bounds the download with the run deadline', async () => {
		const fetchFn = vi.fn(okCsv());
		const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		await runGeometryQueue(db, makeClient(), { ...OPTIONS, fetchFn, timeBudgetMs: 30_000 });

		const signal = fetchFn.mock.calls[0]![1]!.signal!;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
	});

	// The job id is already stored, so the next run resumes by polling. Starting
	// an extract we cannot finish would overrun the request the sync is allowed.
	it('leaves a turf resumable rather than downloading past the deadline', async () => {
		const fetchFn = vi.fn(okCsv());
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(
			db,
			// The budget is alive when the item starts and spent by the time the
			// POST comes back — which is exactly the window the outer pool check
			// cannot see, and where the download used to start regardless.
			makeClient({
				createExportJob: async () => {
					await new Promise((r) => setTimeout(r, 60));
					return job();
				},
			}),
			{ ...OPTIONS, fetchFn, timeBudgetMs: 30 },
		);

		expect(fetchFn).not.toHaveBeenCalled();
		expect(result.stillRunning).toBe(1);
		expect(result.budgetLapsed).toBe(true);
		const last = patchesFor(updates, vanGeometryQueue).at(-1)!;
		expect(last.status).toBe('running');
		// The attempt must not count against it, or a busy run would dead-letter
		// a turf it never actually tried.
		expect(last.attempts).toBe(0);
	});

	it('resumes a running job by polling instead of submitting a second one', async () => {
		const createExportJob = vi.fn(async () => job());
		const exportJob = vi.fn(async () => job({ exportJobId: 901 }));
		const { db } = makeDb(
			[pendingRow({ exportJobId: 901, attempts: 1 })],
			[{ mapRouteId: 100, routeSize: 76 }],
		);
		const result = await runGeometryQueue(db, makeClient({ createExportJob, exportJob }), {
			...OPTIONS,
			fetchFn: okCsv(),
		});

		expect(createExportJob).not.toHaveBeenCalled();
		expect(exportJob).toHaveBeenCalledWith(901);
		expect(result.hullsStored).toBe(1);
	});

	// A slow export must not dead-letter itself just by being looked at.
	it('leaves a job with no downloadUrl running without spending an attempt', async () => {
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const stillPending = job({ status: 'Pending', downloadUrl: null });
		const result = await runGeometryQueue(
			db,
			makeClient({
				createExportJob: async () => stillPending,
				exportJob: async () => stillPending,
			}),
			{ ...OPTIONS, fetchFn: okCsv() },
		);

		expect(result.stillRunning).toBe(1);
		expect(result.deadLettered).toBe(0);
		const last = patchesFor(updates, vanGeometryQueue).at(-1)!;
		expect(last.status).toBe('running');
		expect(last.attempts).toBe(0);
	});

	it('stores a centroid but no hull when the points are degenerate', async () => {
		const twoDoors = [HEADER, '1,A,B,"x",28.5,-81.4,', '2,C,D,"y",28.6,-81.3,', ''].join('\r\n');
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 2 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: okCsv(twoDoors),
		});

		expect(result.centroidsOnly).toBe(1);
		expect(result.hullsStored).toBe(0);
		const patch = patchesFor(updates, vanTurfs)[0]!;
		expect(patch.hullJson).toBeNull();
		expect(patch.centroidLat).toBe(28.55);
	});

	// A wrong export job type fails identically on every turf, so it must not
	// burn four attempts across hundreds of rows to establish that.
	it('dead-letters a bad export type immediately and alerts', async () => {
		const alert = vi.fn(async (...args: [string]) => {
			void args;
		});
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			alert,
			// The type-4 header: no coordinate columns.
			fetchFn: okCsv('CanvassFileRequestID,VanID\r\n255848,3328\r\n'),
		});

		expect(result.deadLettered).toBe(1);
		expect(patchesFor(updates, vanGeometryQueue).at(-1)!.status).toBe('failed');
		expect(alert).toHaveBeenCalledOnce();
		expect(alert.mock.calls[0]![0]).toMatch(/VAddressLatitude/);
		// Dead letters live apart from the advisory warnings, which the caller
		// posts itself. One message per turf, in exactly one channel.
		expect(result.deadLetters).toHaveLength(1);
		expect(result.warnings).toEqual([]);
	});

	// The job id is the only handle on the export VAN is now holding. Written
	// back onto the item at submission, so the failure below dead-letters the
	// row WITH it rather than with the null the row was selected with.
	it('keeps the job id it just created on a dead-lettered row', async () => {
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: okCsv('CanvassFileRequestID,VanID\r\n255848,3328\r\n'),
		});

		expect(result.deadLettered).toBe(1);
		expect(patchesFor(updates, vanGeometryQueue).at(-1)!.exportJobId).toBe(900);
	});

	// The alert says "N turf(s) have stopped retrying". A run where one turf
	// died and another merely looks odd must not list both under that sentence.
	it('alerts about dead letters only, leaving advisory warnings to the caller', async () => {
		const alert = vi.fn(async (...args: [string]) => {
			void args;
		});
		// Turf 100 has a bad export type; turf 101 succeeds with a hull spanning
		// most of Florida, which is advisory rather than fatal.
		//
		// Three points is BELOW MIN_POINTS_FOR_SPAN_VERDICT, so the span warning
		// must hedge rather than blame the saved list — see the dense case below
		// for the wording that does blame it.
		const wide = [
			HEADER,
			'1,A,B,"x",28.5,-81.4,',
			'2,C,D,"y",30.4,-84.3,',
			'3,E,F,"z",25.8,-80.2,',
			'',
		].join('\r\n');
		const { db } = makeDb(
			[pendingRow(), pendingRow({ mapRouteId: 101 })],
			[
				{ mapRouteId: 100, routeSize: 76 },
				{ mapRouteId: 101, routeSize: 3 },
			],
		);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			alert,
			fetchFn: async (...args: [RequestInfo | URL, RequestInit?]) => {
				void args;
				// Both turfs download through the same stub; the first row's turf
				// is decided by which queue item asked. Serve the bad header only
				// to the first caller.
				calls++;
				return calls === 1
					? new Response('CanvassFileRequestID,VanID\r\n255848,3328\r\n', { status: 200 })
					: new Response(wide, { status: 200 });
			},
		});
		expect(result.deadLettered).toBe(1);
		expect(result.hullsTooLarge).toBe(1);

		const text = alert.mock.calls[0]![0];
		expect(text).toMatch(/VAddressLatitude/);
		expect(text).not.toMatch(/span/);
		const warnings = result.warnings.join('\n');
		expect(warnings).toMatch(/too few to tell/);
		expect(warnings).toMatch(/3 coordinate\(s\)/);
		// The claim the old wording made on this very fixture, and could not
		// support: three scattered points say nothing about the saved list.
		expect(warnings).not.toMatch(/probably not a cut map region/);
		expect(warnings).not.toMatch(/gave up after/);
	});

	it('blames the saved list for a wide span only when there are enough points', async () => {
		// 30 points (≥ MIN_POINTS_FOR_SPAN_VERDICT) spread across Florida. Here the
		// span really is evidence: this many doors cannot be one walkable turf, so
		// the warning is allowed to name the likely cause.
		const rows = Array.from({ length: 30 }, (_, i) => {
			const lat = (28 + i * 0.1).toFixed(3);
			const lng = (-84 + i * 0.1).toFixed(3);
			return `${i + 1},A,B,"${i} Main St , Orlando, FL",${lat},${lng},1968-08-09`;
		});
		const dense = [HEADER, ...rows, ''].join('\r\n');
		const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 30 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: async () => new Response(dense, { status: 200 }),
		});

		expect(result.hullsTooLarge).toBe(1);
		expect(result.hullsStored).toBe(1);
		const warnings = result.warnings.join('\n');
		expect(warnings).toMatch(/far past a walkable turf/);
		expect(warnings).toMatch(/probably not a cut map region/);
		expect(warnings).not.toMatch(/too few to tell/);
	});

	it('dead-letters a 403 immediately rather than retrying a permission error', async () => {
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(
			db,
			makeClient({
				createExportJob: async () => {
					throw new VanError('/exportJobs', 403, ['FORBIDDEN'], 'restricted');
				},
			}),
			OPTIONS,
		);
		expect(result.deadLettered).toBe(1);
		expect(patchesFor(updates, vanGeometryQueue).at(-1)!.status).toBe('failed');
	});

	it('returns a transient failure to pending and clears the job id', async () => {
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: async () => new Response('nope', { status: 503 }),
		});

		expect(result.retried).toBe(1);
		expect(result.deadLettered).toBe(0);
		const last = patchesFor(updates, vanGeometryQueue).at(-1)!;
		expect(last.status).toBe('pending');
		// Cleared so the retry submits a fresh job rather than polling a dead one.
		expect(last.exportJobId).toBeNull();
		expect(last.lastError).toMatch(/503/);
	});

	it('dead-letters once the attempt cap is reached', async () => {
		const { db, updates } = makeDb(
			[pendingRow({ attempts: MAX_ATTEMPTS - 1 })],
			[{ mapRouteId: 100, routeSize: 76 }],
		);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: async () => new Response('nope', { status: 503 }),
		});

		expect(result.deadLettered).toBe(1);
		expect(patchesFor(updates, vanGeometryQueue).at(-1)!.status).toBe('failed');
	});

	it('keeps at most two turfs in flight', async () => {
		let active = 0;
		let peak = 0;
		const rows = Array.from({ length: 6 }, (_, i) => pendingRow({ mapRouteId: 100 + i }));
		const turfs = rows.map((r) => ({ mapRouteId: r.mapRouteId, routeSize: 76 }));
		const { db } = makeDb(rows, turfs);

		await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				return new Response(SQUARE_CSV, { status: 200 });
			},
		});
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('stops when the time budget lapses and reports it', async () => {
		const rows = Array.from({ length: 6 }, (_, i) => pendingRow({ mapRouteId: 100 + i }));
		const { db } = makeDb(
			rows,
			rows.map((r) => ({ mapRouteId: r.mapRouteId, routeSize: 76 })),
		);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			timeBudgetMs: -1,
			fetchFn: okCsv(),
		});

		expect(result.budgetLapsed).toBe(true);
		expect(result.attempted).toBe(0);
	});

	it('does nothing when the queue is empty', async () => {
		const { db, updates } = makeDb([], []);
		const result = await runGeometryQueue(db, makeClient(), { ...OPTIONS, fetchFn: okCsv() });
		expect(result.attempted).toBe(0);
		expect(updates).toEqual([]);
	});

	it('respects maxItems', async () => {
		const rows = Array.from({ length: 5 }, (_, i) => pendingRow({ mapRouteId: 100 + i }));
		const { db } = makeDb(
			rows,
			rows.map((r) => ({ mapRouteId: r.mapRouteId, routeSize: 76 })),
		);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			maxItems: 2,
			fetchFn: okCsv(),
		});
		expect(result.attempted).toBe(2);
	});

	// Geocoding is on by default now, so these pin both halves of "only when
	// needed": a turf VAN already placed must send nothing, and one it left
	// empty must be resolved.
	describe('address geocoding', () => {
		const UNGEOCODED = [
			HEADER,
			'1,Ron,Campbell,"4190 S Kirkman Rd , Orlando, FL",,,1968-08-09',
			'2,Ada,Lovelace,"12 Main St , Orlando, FL",,,1815-12-10',
			'3,Alan,Turing,"9 Elm St , Orlando, FL",,,1912-06-23',
			'',
		].join('\r\n');

		it('does not call the geocoder when VAN geocoded every row', async () => {
			const geocode = vi.fn(async () => new Map());
			const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 76 }]);
			const result = await runGeometryQueue(db, makeClient(), {
				...OPTIONS,
				geocode,
				fetchFn: okCsv(),
			});

			expect(geocode).not.toHaveBeenCalled();
			expect(result.geocodedFromAddress).toBe(0);
			expect(result.hullsStored).toBe(1);
		});

		it('geocodes the rows VAN left without coordinates', async () => {
			const geocode = vi.fn(async (rows: readonly { id: string }[]) => {
				const out = new Map<string, { lat: number; lng: number }>();
				const points = [
					{ lat: 28.5, lng: -81.4 },
					{ lat: 28.503, lng: -81.4 },
					{ lat: 28.503, lng: -81.397 },
				];
				rows.forEach((row, i) => out.set(row.id, points[i]!));
				return out;
			});
			const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 3 }]);
			const result = await runGeometryQueue(db, makeClient(), {
				...OPTIONS,
				geocode,
				fetchFn: okCsv(UNGEOCODED),
			});

			expect(geocode).toHaveBeenCalledOnce();
			expect(result.geocodedFromAddress).toBe(3);
			expect(result.hullsStored).toBe(1);
			expect(JSON.parse(patchesFor(updates, vanTurfs)[0]!.hullJson as string)).toHaveLength(3);
		});

		// An explicit null is the only way to turn it off, and it must stop the
		// extractor reading address columns at all rather than merely skipping
		// the call.
		it('reads no address when the geocoder is explicitly null', async () => {
			const { db } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 3 }]);
			const result = await runGeometryQueue(db, makeClient(), {
				...OPTIONS,
				geocode: null,
				fetchFn: okCsv(UNGEOCODED),
			});
			expect(result.geocodedFromAddress).toBe(0);
			expect(result.noGeometry).toBe(1);
		});
	});

	// A hull far too big to be a walking turf is stored anyway, with a warning.
	// Discarding it hid the problem: the operator saw a pin and no reason.
	it('stores an implausibly large hull and warns about it', async () => {
		const county = [
			HEADER,
			'1,A,B,"x",28.34956,-81.58047,',
			'2,C,D,"y",28.72072,-81.58047,',
			'3,E,F,"z",28.72072,-81.16984,',
			'4,G,H,"w",28.34956,-81.16984,',
			'',
		].join('\r\n');
		const { db, updates } = makeDb([pendingRow()], [{ mapRouteId: 100, routeSize: 4 }]);
		const result = await runGeometryQueue(db, makeClient(), {
			...OPTIONS,
			fetchFn: okCsv(county),
		});

		expect(result.hullsTooLarge).toBe(1);
		// Counted as stored as well — the shape really is on the row.
		expect(result.hullsStored).toBe(1);
		expect(JSON.parse(patchesFor(updates, vanTurfs)[0]!.hullJson as string)).toHaveLength(4);
		expect(result.warnings[0]).toMatch(/span ~\d+ km/);
	});
});
