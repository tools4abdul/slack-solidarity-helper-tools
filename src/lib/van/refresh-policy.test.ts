import { describe, it, expect } from 'vitest';
import {
	planRefreshSweep,
	isNightlyWindow,
	MIN_REFRESH_INTERVAL_MS,
	type RegionRefreshState,
} from './refresh-policy.js';

const NOW = new Date('2026-09-12T18:00:00.000Z');

/** 02:00 in Detroit (EDT, UTC-4) — inside the nightly window. */
const NIGHT = new Date('2026-09-12T06:00:00.000Z');

function region(over: Partial<RegionRefreshState> = {}): RegionRefreshState {
	return {
		folderId: 1152,
		mapRegionId: 10,
		lastRequestAt: null,
		requestedAt: null,
		inFlightSince: null,
		activeClaims: 0,
		...over,
	};
}

function agoIso(ms: number, from: Date = NOW): string {
	return new Date(from.getTime() - ms).toISOString();
}

describe('isNightlyWindow', () => {
	it('is true overnight in the campaign timezone, not in UTC', () => {
		// 06:00Z is 02:00 in Detroit. The UTC hour is outside the window and the
		// campaign hour is inside it, which is the whole point of the check.
		expect(isNightlyWindow(NIGHT)).toBe(true);
		expect(NIGHT.getUTCHours()).toBe(6);
	});

	it('is false during a canvass afternoon', () => {
		expect(isNightlyWindow(NOW)).toBe(false);
	});
});

describe('planRefreshSweep — the on-demand path', () => {
	it('sends a region a volunteer just finished walking', () => {
		const plan = planRefreshSweep([region({ requestedAt: agoIso(60_000) })], { now: NOW });
		expect(plan.onDemandRegions).toEqual([{ folderId: 1152, mapRegionId: 10 }]);
		expect(plan.deferredRegions).toEqual([]);
	});

	it('sends nothing when nothing was requested', () => {
		const plan = planRefreshSweep([region()], { now: NOW });
		expect(plan.onDemandRegions).toEqual([]);
	});

	it('defers a region other volunteers are still out in', () => {
		const plan = planRefreshSweep([region({ requestedAt: agoIso(60_000), activeClaims: 2 })], {
			now: NOW,
		});
		expect(plan.onDemandRegions).toEqual([]);
		expect(plan.deferredRegions).toEqual([{ folderId: 1152, mapRegionId: 10, activeClaims: 2 }]);
	});

	it('holds off when the region was refreshed within the hour', () => {
		const plan = planRefreshSweep(
			[region({ requestedAt: agoIso(60_000), lastRequestAt: agoIso(10 * 60_000) })],
			{ now: NOW },
		);
		expect(plan.onDemandRegions).toEqual([]);
		// Not deferred either — deferral means "volunteers are out"; this is the
		// throttle, and conflating them would misreport why a count is stale.
		expect(plan.deferredRegions).toEqual([]);
	});

	it('sends again once the hour is up', () => {
		const plan = planRefreshSweep(
			[
				region({
					requestedAt: agoIso(90 * 60_000),
					lastRequestAt: agoIso(MIN_REFRESH_INTERVAL_MS + 60_000),
				}),
			],
			{ now: NOW },
		);
		expect(plan.onDemandRegions).toHaveLength(1);
	});

	it('treats an unparseable last-request stamp as long ago rather than freezing the region', () => {
		const plan = planRefreshSweep(
			[region({ requestedAt: agoIso(60_000), lastRequestAt: 'junk' })],
			{
				now: NOW,
			},
		);
		expect(plan.onDemandRegions).toHaveLength(1);
	});
});

describe('planRefreshSweep — the nightly sweep', () => {
	const stale = agoIso(30 * 60 * 60 * 1000, NIGHT);

	it('refreshes a whole folder with one call', () => {
		const plan = planRefreshSweep(
			[
				region({ mapRegionId: 10, lastRequestAt: stale }),
				region({ mapRegionId: 11, lastRequestAt: stale }),
			],
			{ now: NIGHT },
		);
		expect(plan.nightlyFolderIds).toEqual([1152]);
		// Every region in the folder is stamped, because VAN re-cut every region
		// in the folder. Stamping only the due one would let the throttle fire
		// twice for a single call.
		expect(plan.nightlyRegions).toEqual([
			{ folderId: 1152, mapRegionId: 10 },
			{ folderId: 1152, mapRegionId: 11 },
		]);
	});

	it('does not run outside the overnight window', () => {
		const plan = planRefreshSweep([region({ lastRequestAt: agoIso(30 * 60 * 60 * 1000) })], {
			now: NOW,
		});
		expect(plan.nightlyFolderIds).toEqual([]);
	});

	it('runs when the caller says so, without waiting for the clock', () => {
		const plan = planRefreshSweep([region({ lastRequestAt: agoIso(30 * 60 * 60 * 1000) })], {
			now: NOW,
			nightly: true,
		});
		expect(plan.nightlyFolderIds).toEqual([1152]);
	});

	it('refreshes a folder that has never been refreshed at all', () => {
		const plan = planRefreshSweep([region({ lastRequestAt: null })], { now: NIGHT });
		expect(plan.nightlyFolderIds).toEqual([1152]);
	});

	it('leaves a folder alone when nothing in it is due', () => {
		const plan = planRefreshSweep([region({ lastRequestAt: agoIso(3 * 60 * 60 * 1000, NIGHT) })], {
			now: NIGHT,
		});
		expect(plan.nightlyFolderIds).toEqual([]);
	});

	it('lets one recently refreshed region veto its folder', () => {
		const plan = planRefreshSweep(
			[
				region({ mapRegionId: 10, lastRequestAt: stale }),
				region({ mapRegionId: 11, lastRequestAt: agoIso(5 * 60_000, NIGHT) }),
			],
			{ now: NIGHT },
		);
		expect(plan.nightlyFolderIds).toEqual([]);
	});

	it('treats folders independently', () => {
		const plan = planRefreshSweep(
			[
				region({ folderId: 1, mapRegionId: 10, lastRequestAt: stale }),
				region({ folderId: 2, mapRegionId: 20, lastRequestAt: agoIso(5 * 60_000, NIGHT) }),
			],
			{ now: NIGHT },
		);
		expect(plan.nightlyFolderIds).toEqual([1]);
	});
});

describe('planRefreshSweep — budget and in-flight', () => {
	it('fills on-demand requests before the nightly sweep', () => {
		const regions: RegionRefreshState[] = [
			region({ folderId: 1, mapRegionId: 10, requestedAt: agoIso(60_000) }),
			region({ folderId: 2, mapRegionId: 20, requestedAt: agoIso(60_000) }),
			region({ folderId: 3, mapRegionId: 30, lastRequestAt: null }),
		];
		const plan = planRefreshSweep(regions, { now: NIGHT, maxRequests: 2 });
		expect(plan.onDemandRegions).toHaveLength(2);
		expect(plan.nightlyFolderIds).toEqual([]);
	});

	it('does not spend budget on a deferral', () => {
		const regions: RegionRefreshState[] = [
			// Deferred: wanted on demand, but someone is still out in it. Recent
			// enough that the nightly sweep has no interest in it either.
			region({
				folderId: 1,
				mapRegionId: 10,
				requestedAt: agoIso(60_000, NIGHT),
				lastRequestAt: agoIso(2 * 60 * 60 * 1000, NIGHT),
				activeClaims: 1,
			}),
			region({ folderId: 2, mapRegionId: 20, lastRequestAt: null }),
		];
		const plan = planRefreshSweep(regions, { now: NIGHT, maxRequests: 1 });
		expect(plan.deferredRegions).toHaveLength(1);
		expect(plan.nightlyFolderIds).toEqual([2]);
	});

	it('does not defer the nightly sweep for active claims — it is the fallback the deferral relies on', () => {
		// Story 4.5.2 defers the ON-DEMAND path so a completion does not re-cut a
		// region under the people still walking it. If the sweep deferred too, a
		// busy region would never be refreshed at all, and the deferral would be
		// an indefinite hold rather than a delay.
		const plan = planRefreshSweep(
			[region({ lastRequestAt: agoIso(30 * 60 * 60 * 1000, NIGHT), activeClaims: 3 })],
			{ now: NIGHT },
		);
		expect(plan.nightlyFolderIds).toEqual([1152]);
	});

	it('clears an in-flight flag that has waited too long', () => {
		const plan = planRefreshSweep(
			[
				region({ mapRegionId: 10, inFlightSince: agoIso(7 * 60 * 60 * 1000) }),
				region({ mapRegionId: 11, inFlightSince: agoIso(60 * 60 * 1000) }),
				region({ mapRegionId: 12, inFlightSince: 'junk' }),
			],
			{ now: NOW },
		);
		expect(plan.staleInFlight).toEqual([
			{ folderId: 1152, mapRegionId: 10 },
			{ folderId: 1152, mapRegionId: 12 },
		]);
	});
});
