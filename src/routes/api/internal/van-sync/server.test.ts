import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunCatalogSync = vi.hoisted(() => vi.fn());
const mockRunGeometryQueue = vi.hoisted(() => vi.fn());
const mockVanClient = vi.hoisted(() => vi.fn());
const mockExportJobTypeId = vi.hoisted(() => vi.fn());
const mockAlertFor = vi.hoisted(() => vi.fn(() => async () => undefined));
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockDrift = vi.hoisted(() => vi.fn());
const mockSettle = vi.hoisted(() => vi.fn());
const mockReconcile = vi.hoisted(() => vi.fn());
const mockRefreshSweep = vi.hoisted(() => vi.fn());
const mockDoorDeltas = vi.hoisted(() => vi.fn());
const mockDoorsHealth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'cron-secret' }));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/slack.js', () => ({
	slack: { chat: { postMessage: mockPostMessage } },
	alertFor: mockAlertFor,
}));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({
		slackTrackingChannelId: 'C_TRACK',
		slackTurfChannelId: 'C_TURF',
		vanTurfClaimTtlHours: 48,
	}),
	loadVanChapterFolders: async () => [
		{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] },
	],
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	acquireSyncLock: mockAcquire,
	releaseSyncLock: mockRelease,
}));
vi.mock('$lib/server/van-env.js', () => ({
	vanClient: mockVanClient,
	vanExportJobTypeId: mockExportJobTypeId,
}));
vi.mock('$lib/server/van/geometry-worker.js', () => ({
	runGeometryQueue: mockRunGeometryQueue,
}));
vi.mock('$lib/server/van/sync.js', () => ({ runCatalogSync: mockRunCatalogSync }));
vi.mock('$lib/server/van/checkout-store.js', () => ({ sweepExpiredClaims: mockSweep }));
vi.mock('$lib/server/van/expiry-warning-store.js', () => ({ sendExpiryWarnings: mockWarn }));
vi.mock('$lib/server/van/drift-alert-store.js', () => ({ sendDriftAlerts: mockDrift }));
vi.mock('$lib/server/van/refresh.js', () => ({
	settleRefreshes: mockSettle,
	runRefreshSweep: mockRefreshSweep,
}));
vi.mock('$lib/server/van/reconcile-store.js', () => ({ reconcileClaims: mockReconcile }));
vi.mock('$lib/server/van/door-delta-store.js', () => ({ stampDoorDeltas: mockDoorDeltas }));
vi.mock('$lib/server/van/doors-store.js', () => ({ doorsHealthWarning: mockDoorsHealth }));
vi.mock('$lib/server/env.js', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
	APP_URL: 'https://app.example',
}));

const result = {
	foldersSynced: 1,
	foldersSkipped: 0,
	turfsUpserted: 3,
	turfsRetired: 0,
	turfsUnretired: 0,
	geometryQueued: 3,
	claimsReleased: 0,
	regionsRead: [{ folderId: 2731, mapRegionId: 10, dateRefreshed: '2026-09-12T04:00:00.000Z' }],
	degraded: [],
	warnings: [],
};

const reconcileResult = {
	listNumbersChanged: 0,
	numbersAdopted: 0,
	walkedOut: 0,
	retiredReleased: 0,
	recutReplaced: 0,
	recutGone: 0,
	recutStale: 0,
	dmFailed: 0,
	missingListNumber: 0,
};

const doorDeltaResult = { measured: 0, unsynced: 0, doorsCleared: 0, dmFailed: 0 };

const refreshResult = {
	nightlyFolders: [],
	regionsRefreshed: 0,
	regionsDeferred: 0,
	failed: 0,
	staleCleared: 0,
	warnings: [],
};

const geometryResult = {
	attempted: 3,
	hullsStored: 3,
	centroidsOnly: 0,
	noGeometry: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	deadLetters: [],
	stillRunning: 0,
	budgetLapsed: false,
	warnings: [],
};

const driftResult = { announced: 0, cleared: 0, failed: false, skipped: 'nothing-new' };

const event = (key = 'cron-secret') =>
	({ url: new URL(`https://app.example/api/internal/van-sync?key=${key}`) }) as never;

describe('POST /api/internal/van-sync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockEnv.INTERNAL_CRON_SECRET = 'cron-secret';
		mockVanClient.mockReturnValue({ ok: true, client: {} });
		mockAcquire.mockResolvedValue('lock-token');
		mockRunCatalogSync.mockResolvedValue(result);
		mockSettle.mockResolvedValue(0);
		mockReconcile.mockResolvedValue(reconcileResult);
		mockRefreshSweep.mockResolvedValue(refreshResult);
		mockDoorDeltas.mockResolvedValue(doorDeltaResult);
		mockDoorsHealth.mockResolvedValue(null);
		mockExportJobTypeId.mockReturnValue(5);
		mockRunGeometryQueue.mockResolvedValue(geometryResult);
		mockSweep.mockResolvedValue(0);
		mockWarn.mockResolvedValue({ sent: 0, failed: 0 });
		mockDrift.mockResolvedValue(driftResult);
	});

	it('returns 401 for a wrong key', async () => {
		const res = await POST(event('nope'));
		expect(res.status).toBe(401);
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('returns 500 when INTERNAL_CRON_SECRET is unset rather than running unauthenticated', async () => {
		mockEnv.INTERNAL_CRON_SECRET = '';
		const res = await POST(event(''));
		expect(res.status).toBe(500);
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('returns 500 with the reason when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		mockSweep.mockResolvedValue(2);
		mockWarn.mockResolvedValue({ sent: 3, failed: 1 });
		const res = await POST(event());
		expect(res.status).toBe(500);
		// Same housekeeping fields as the success path, so a monitor parsing this
		// does not have to cope with keys that appear and disappear.
		expect(await res.json()).toEqual({
			error: 'VAN_API_KEY is not set',
			claimsExpired: 2,
			expiryWarningsSent: 3,
			expiryWarningsFailed: 1,
		});
	});

	// Ledger housekeeping does not need VAN, and a key rotated badly on a Friday
	// must not stop volunteers being warned about turf they are already holding.
	it('still sweeps and warns when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockSweep).toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalled();
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('releases the lock even when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});

	// Sweep first, then warn: nobody should be told that turf which lapsed
	// moments ago is about to lapse.
	it('sweeps before it warns, against the same clock', async () => {
		const order: string[] = [];
		mockSweep.mockImplementation(async () => {
			order.push('sweep');
			return 0;
		});
		mockWarn.mockImplementation(async () => {
			order.push('warn');
			return { sent: 0, failed: 0 };
		});
		await POST(event());
		expect(order).toEqual(['sweep', 'warn']);
		expect(mockWarn.mock.calls[0]![1]).toBe(mockSweep.mock.calls[0]![1]);
	});

	it('reports what the warning sweep did', async () => {
		mockWarn.mockResolvedValue({ sent: 4, failed: 1 });
		const body = await (await POST(event())).json();
		expect(body).toMatchObject({ expiryWarningsSent: 4, expiryWarningsFailed: 1 });
	});

	it('runs the sync with the configured chapter mapping', async () => {
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			...result,
			geometry: geometryResult,
			claimsExpired: 0,
			expiryWarningsSent: 0,
			expiryWarningsFailed: 0,
			drift: driftResult,
			refreshesSettled: 0,
			reconciled: reconcileResult,
			doorDeltas: doorDeltaResult,
			doorsWarning: null,
			refresh: refreshResult,
		});
		expect(mockRunCatalogSync).toHaveBeenCalledWith(
			{},
			{},
			[{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] }],
			// The catalog is capped below the workflow's `curl --max-time 300`
			// so geometry has room to run inside the same request.
			{ timeBudgetMs: 3 * 60 * 1000 },
		);
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});

	// The catalog writes `van_distributed_to`, which is VAN's half of the drift
	// comparison. Alerting first would announce drift computed against the
	// previous run's view of VAN — precisely the window an organizer's bulk export
	// lands in.
	it("alerts on drift only after the catalog has refreshed VAN's half", async () => {
		const order: string[] = [];
		mockRunCatalogSync.mockImplementation(async () => {
			order.push('catalog');
			return result;
		});
		mockDrift.mockImplementation(async () => {
			order.push('drift');
			return driftResult;
		});
		mockRunGeometryQueue.mockImplementation(async () => {
			order.push('geometry');
			return geometryResult;
		});
		await POST(event());
		// Before geometry too: geometry is the half the time budget cuts short, and
		// an unannounced collision costs more than a missing hull.
		expect(order).toEqual(['catalog', 'drift', 'geometry']);
	});

	it('confirms in-flight refreshes against the regions the catalog just read', async () => {
		// The catalog read is the only place VAN's dateRefreshed appears, so the
		// confirmation rides on it rather than costing a second call.
		await POST(event());
		expect(mockSettle).toHaveBeenCalledWith({}, result.regionsRead);
	});

	it('reconciles claims after the catalog and before the drift report', async () => {
		const order: string[] = [];
		mockRunCatalogSync.mockImplementation(async () => {
			order.push('catalog');
			return result;
		});
		mockSettle.mockImplementation(async () => {
			order.push('settle');
			return 0;
		});
		mockReconcile.mockImplementation(async () => {
			order.push('reconcile');
			return reconcileResult;
		});
		mockDoorDeltas.mockImplementation(async () => {
			order.push('deltas');
			return doorDeltaResult;
		});
		mockDrift.mockImplementation(async () => {
			order.push('drift');
			return driftResult;
		});
		mockRefreshSweep.mockImplementation(async () => {
			order.push('refresh');
			return refreshResult;
		});
		await POST(event());
		// Reconciliation repairs claims a re-cut just released, and the delta
		// check must not measure those as completions; drift reads the ledger, so
		// it has to see both. The sweep goes last because its effect lands on a
		// future tick.
		expect(order).toEqual(['catalog', 'settle', 'reconcile', 'deltas', 'drift', 'refresh']);
	});

	it('reports what the sync-back check found', async () => {
		mockDoorDeltas.mockResolvedValue({
			measured: 4,
			unsynced: 1,
			doorsCleared: 212,
			dmFailed: 0,
		});
		const body = await (await POST(event())).json();
		expect(body).toMatchObject({ doorDeltas: { measured: 4, unsynced: 1, doorsCleared: 212 } });
	});

	it('reconciles with the configured claim TTL, so a moved claim gets a normal window', async () => {
		await POST(event());
		expect(mockReconcile).toHaveBeenCalledWith(
			{},
			{ now: mockSweep.mock.calls[0]![1], appUrl: 'https://app.example', ttlHours: 48 },
		);
	});

	it('bounds the refresh sweep so it cannot eat the request', async () => {
		await POST(event());
		const { timeBudgetMs } = mockRefreshSweep.mock.calls[0]![2];
		expect(timeBudgetMs).toBeGreaterThan(0);
		expect(timeBudgetMs).toBeLessThanOrEqual(30 * 1000);
	});

	it('posts the turf-cutting health warning with the other notices', async () => {
		// Story 9.4: if regions are cut without a "not yet contacted" filter,
		// every doors number on the dashboard reads zero and looks like a bug in
		// this app. This is the only place that difference becomes visible.
		mockDoorsHealth.mockResolvedValue('5 completed turfs in a row cleared zero doors.');
		await POST(event());
		expect(mockPostMessage.mock.calls[0]![0].text as string).toContain('cleared zero doors');
	});

	it('survives a failed health check', async () => {
		mockDoorsHealth.mockRejectedValue(new Error('database is locked'));
		const res = await POST(event());
		expect(res.status).toBe(200);
	});

	it('posts refresh warnings to the turf channel with the rest', async () => {
		mockRefreshSweep.mockResolvedValue({
			...refreshResult,
			warnings: ['Nightly refresh of folder 2731 failed: FORBIDDEN'],
		});
		await POST(event());
		expect(mockPostMessage.mock.calls[0]![0].text as string).toContain(
			'Nightly refresh of folder 2731 failed',
		);
	});

	it('reports what the reconciliation and the sweep did', async () => {
		mockReconcile.mockResolvedValue({ ...reconcileResult, listNumbersChanged: 2, walkedOut: 1 });
		mockRefreshSweep.mockResolvedValue({ ...refreshResult, regionsRefreshed: 3 });
		const body = await (await POST(event())).json();
		expect(body).toMatchObject({
			reconciled: { listNumbersChanged: 2, walkedOut: 1 },
			refresh: { regionsRefreshed: 3 },
		});
	});

	it('posts drift to the turf channel, against the housekeeping clock', async () => {
		await POST(event());
		expect(mockDrift).toHaveBeenCalledWith(
			{},
			{
				now: mockSweep.mock.calls[0]![1],
				channelId: 'C_TURF',
				appUrl: 'https://app.example',
			},
		);
	});

	it('does not alert on drift when VAN is not configured', async () => {
		// Without a catalog run, `van_distributed_to` is whatever the last
		// successful sync left, and a stale comparison is worse than none.
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockDrift).not.toHaveBeenCalled();
	});

	it('reports what the drift alert did', async () => {
		mockDrift.mockResolvedValue({ announced: 3, cleared: 1, failed: false });
		const body = await (await POST(event())).json();
		expect(body).toMatchObject({ drift: { announced: 3, cleared: 1, failed: false } });
	});

	it('skips without error when another sync holds the lock', async () => {
		mockAcquire.mockResolvedValue(null);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect((await res.json()).skipped).toBeTruthy();
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('posts degraded-tier and warning notices to Slack', async () => {
		mockRunCatalogSync.mockResolvedValue({
			...result,
			degraded: ['/minivanExports unavailable'],
			warnings: ['2 turf(s) have no MiniVAN list number'],
		});
		await POST(event());
		const text = mockPostMessage.mock.calls[0]![0].text as string;
		expect(text).toContain('/minivanExports unavailable');
		expect(text).toContain('no MiniVAN list number');
	});

	it('still succeeds when Slack is down', async () => {
		mockRunCatalogSync.mockResolvedValue({ ...result, warnings: ['something'] });
		mockPostMessage.mockRejectedValue(new Error('slack is down'));
		const res = await POST(event());
		expect(res.status).toBe(200);
	});

	// Ledger housekeeping rides this schedule rather than needing its own cron.
	it('sweeps expired claims and reports the count', async () => {
		mockSweep.mockResolvedValue(3);
		const res = await POST(event());
		expect(mockSweep).toHaveBeenCalled();
		expect((await res.json()).claimsExpired).toBe(3);
	});

	it('sweeps before the catalog fetch, so a VAN outage does not skip it', async () => {
		mockRunCatalogSync.mockRejectedValue(new Error('VAN is down'));
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(mockSweep).toHaveBeenCalled();
	});

	it('releases the lock when the sync throws', async () => {
		mockRunCatalogSync.mockRejectedValue(new Error('VAN /folders returned 500'));
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'VAN /folders returned 500' });
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});

	describe('geometry', () => {
		it('drains the queue after the catalog and reports what it did', async () => {
			const res = await POST(event());
			const body = await res.json();

			expect(mockRunGeometryQueue).toHaveBeenCalledOnce();
			expect(body.geometry.hullsStored).toBe(3);
			// The catalog must be written before geometry runs — a turf cut
			// minutes ago should get its shape on this run, not the next.
			expect(mockRunCatalogSync.mock.invocationCallOrder[0]).toBeLessThan(
				mockRunGeometryQueue.mock.invocationCallOrder[0],
			);
		});

		// VAN stores this URL against the export job and echoes it back on every
		// later read, so what it carries is a disclosure decision. It must be a
		// per-turf HMAC and NEVER INTERNAL_CRON_SECRET, which also opens the
		// catalog sync, both snapshots, the mobilize sync, the invite audit and
		// the growth report.
		it('registers a per-turf webhook url on our own host, without the cron key', async () => {
			await POST(event());
			const options = mockRunGeometryQueue.mock.calls[0]![2];
			const url = new URL(options.webhookUrlFor(100));

			expect(url.origin).toBe('https://app.example');
			expect(url.pathname).toBe('/api/internal/van-export-callback');
			expect(url.searchParams.get('turf')).toBe('100');
			expect(url.searchParams.get('token')).toMatch(/^[0-9a-f]{32}$/);
			expect(url.searchParams.get('key')).toBeNull();
			expect(options.webhookUrlFor(100)).not.toContain('cron-secret');
			// A token that did not depend on the turf would be a shared secret
			// wearing a different name.
			expect(options.webhookUrlFor(101)).not.toBe(options.webhookUrlFor(100));
			expect(options.exportJobTypeId).toBe(5);
		});

		// The route deliberately says nothing about geocoding: the worker
		// defaults to the Census geocoder, and passing an explicit `null` here
		// would silently disable it for the scheduled sync only.
		it('leaves the geocoder to the worker default', async () => {
			await POST(event());
			expect(mockRunGeometryQueue.mock.calls[0]![2]).not.toHaveProperty('geocode');
		});

		it('skips geometry, but still syncs the catalog, with no export job type set', async () => {
			mockExportJobTypeId.mockReturnValue(null);
			const res = await POST(event());
			const body = await res.json();

			expect(mockRunGeometryQueue).not.toHaveBeenCalled();
			// Null rather than zeros, so "not configured" stays distinguishable
			// from "ran and found nothing to do".
			expect(body.geometry).toBeNull();
			expect(body.turfsUpserted).toBe(3);
			expect(res.status).toBe(200);
		});

		// Geometry is decoration; the catalog rows are already written and
		// correct by the time it runs.
		it('still returns the catalog result when the geometry queue throws', async () => {
			mockRunGeometryQueue.mockRejectedValue(new Error('VAN is down'));
			const res = await POST(event());
			const body = await res.json();

			expect(res.status).toBe(200);
			expect(body.turfsUpserted).toBe(3);
			expect(body.geometry).toBeNull();
		});

		// The worker posts dead letters itself, through the `alert` this route
		// hands it. Repeating them in the notices message put every one of them
		// in the channel twice.
		it('posts advisory geometry warnings but leaves dead letters to the worker alert', async () => {
			mockRunGeometryQueue.mockResolvedValue({
				...geometryResult,
				deadLettered: 1,
				deadLetters: ['Turf 100 geometry gave up after 4 attempt(s): boom'],
				warnings: ['Turf 101: addresses span ~58 km, far past a walkable turf.'],
			});
			await POST(event());

			expect(mockPostMessage).toHaveBeenCalledOnce();
			const text = mockPostMessage.mock.calls[0]![0].text;
			expect(text).toContain('far past a walkable turf');
			expect(text).not.toContain('gave up after');
		});

		// The workflow calls this with `curl --max-time 300`. Taking the deadline
		// after the ledger housekeeping would let the request run for that
		// housekeeping PLUS the whole budget.
		it('starts the request budget before the ledger housekeeping, not after', async () => {
			const SWEEP_MS = 40;
			mockSweep.mockImplementation(
				async () => new Promise((r) => setTimeout(() => r(0), SWEEP_MS)),
			);
			await POST(event());

			const { timeBudgetMs } = mockRunGeometryQueue.mock.calls[0]![2];
			// A budget stamped after the sweep would still be the full 4m30s.
			// Stamped before it, the sweep has already come out of it.
			expect(timeBudgetMs).toBeLessThanOrEqual(4 * 60 * 1000 + 30 * 1000 - SWEEP_MS / 2);
		});
	});
});
