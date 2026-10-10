import { describe, it, expect } from 'vitest';
import {
	toTurfView,
	parseHull,
	mappableTurfs,
	doorsLeft,
	doorDensity,
	vanAssignmentBlocks,
	regionRefreshKey,
	type TurfRowInput,
} from './turf-view.js';
import type { ClaimSnapshot } from './checkout.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const VOLUNTEER = { slackUserId: 'U_VOL', isAdmin: false };
const ADMIN = { slackUserId: 'U_ADMIN', isAdmin: true };

const HULL = JSON.stringify([
	{ lat: 42.36, lng: -71.12 },
	{ lat: 42.38, lng: -71.12 },
	{ lat: 42.38, lng: -71.1 },
	{ lat: 42.36, lng: -71.1 },
]);

function row(over: Partial<TurfRowInput> = {}): TurfRowInput {
	return {
		turfId: 100,
		campaignId: 1,
		mapRegionId: 10,
		chapterId: 71,
		name: 'Turf 01',
		regionName: 'Cambridge North',
		printedListNumber: '35536745-88712',
		routeSize: 400,
		doorCount: 250,
		centroidLat: null,
		centroidLng: null,
		hullJson: HULL,
		vanDistributedTo: null,
		retiredAt: null,
		lastRefreshedAt: '2026-08-22T06:00:00.000Z',
		...over,
	};
}

function claim(over: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
	return {
		turfId: 100,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana Ruiz',
		claimedAt: '2026-08-22T09:00:00.000Z',
		expiresAt: '2026-08-24T09:00:00.000Z',
		releasedAt: null,
		completedAt: null,
		...over,
	};
}

describe('toTurfView — the MiniVAN list number', () => {
	// The number is the credential: it is what pulls the doors down in
	// MiniVAN. Shipping it for unclaimed turf would make the checkout ledger
	// advisory, which defeats the entire feature.
	it('is withheld on turf nobody holds', () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW);
		expect(view.status).toBe('available');
		expect(view.printedListNumber).toBeNull();
	});

	it('is issued on turf you hold', () => {
		const view = toTurfView(row(), [claim()], VOLUNTEER, NOW);
		expect(view.status).toBe('held-by-you');
		expect(view.printedListNumber).toBe('35536745-88712');
	});

	it('is withheld on turf someone else holds', () => {
		const view = toTurfView(row(), [claim({ slackUserId: 'U_OTHER' })], VOLUNTEER, NOW);
		expect(view.status).toBe('checked-out');
		expect(view.printedListNumber).toBeNull();
	});

	it('is withheld from an admin who does not hold it', () => {
		// Admins see holder names, but the number is still a credential and an
		// admin has no more need to type it into MiniVAN than anyone else.
		const view = toTurfView(row(), [claim({ slackUserId: 'U_OTHER' })], ADMIN, NOW);
		expect(view.printedListNumber).toBeNull();
	});

	it('is withdrawn once the claim lapses', () => {
		const lapsed = claim({ expiresAt: '2026-08-22T11:00:00.000Z' });
		const view = toTurfView(row(), [lapsed], VOLUNTEER, NOW);
		expect(view.status).toBe('available');
		expect(view.printedListNumber).toBeNull();
	});

	it('is withdrawn once the claim is released', () => {
		const released = claim({ releasedAt: '2026-08-22T10:00:00.000Z' });
		const view = toTurfView(row(), [released], VOLUNTEER, NOW);
		expect(view.printedListNumber).toBeNull();
	});
});

describe('toTurfView — what reaches the browser', () => {
	const ADDRESS_LIKE =
		/address|street|addr|city|zip|postal|firstname|lastname|phone|email|vanid|voter|dob|party/i;

	it('emits no address-like or person-like field', () => {
		const view = toTurfView(row(), [claim()], ADMIN, NOW);
		for (const key of Object.keys(view)) {
			expect(key, `field "${key}" reaching the browser`).not.toMatch(ADDRESS_LIKE);
		}
	});

	it('emits no unexpected fields at all', () => {
		// A whitelist, not a blacklist. A new column added to van_turfs and
		// carelessly spread into the view would fail here rather than shipping.
		const view = toTurfView(row(), [], VOLUNTEER, NOW);
		expect(Object.keys(view).sort()).toEqual(
			[
				'bounds',
				'centre',
				'chapterId',
				'claimable',
				'doorsRemaining',
				'expiresInHours',
				'heldBy',
				'heldByAccount',
				'hull',
				'turfId',
				'name',
				'printedListNumber',
				'refreshedMinutesAgo',
				'regionName',
				'routeSize',
				'status',
			].sort(),
		);
	});

	// The Slack/Google/Apple mark and an outside holder's email ride on `heldBy`, so
	// they reach exactly the viewers `heldBy` does: admins.
	it('marks the holder’s account for an admin, and for nobody else', () => {
		const held = [claim({ slackUserId: 'google:7', slackUserName: 'Ana Ruiz' })];
		const holderAccounts = new Map([
			[
				'google:7',
				{ provider: 'google' as const, email: 'ana@example.com', isPrivateEmail: false },
			],
		]);

		expect(toTurfView(row(), held, ADMIN, NOW, { holderAccounts }).heldByAccount).toEqual({
			provider: 'google',
			email: 'ana@example.com',
			isPrivateEmail: false,
		});
		expect(toTurfView(row(), held, VOLUNTEER, NOW, { holderAccounts }).heldByAccount).toBeNull();
		// No claim — nothing held, or held in VAN — means no account to mark.
		expect(toTurfView(row(), [], ADMIN, NOW, { holderAccounts }).heldByAccount).toBeNull();
	});

	it('hides the holder’s name from a volunteer but shows it to an admin', () => {
		const held = [claim({ slackUserId: 'U_OTHER', slackUserName: 'Sam Ito' })];
		expect(toTurfView(row(), held, VOLUNTEER, NOW).heldBy).toBeNull();
		expect(toTurfView(row(), held, ADMIN, NOW).heldBy).toBe('Sam Ito');
	});

	it('reports a VAN-side assignment as plain "checked-out" to a volunteer', () => {
		const view = toTurfView(row({ vanDistributedTo: 'Sam Ito' }), [], VOLUNTEER, NOW);
		expect(view.status).toBe('checked-out');
		expect(view.heldBy).toBeNull();
	});
});

describe('toTurfView — geometry', () => {
	it('derives centre and bounds from the hull', () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW);
		expect(view.hull).toHaveLength(4);
		expect(view.centre!.lat).toBeCloseTo(42.37, 6);
		expect(view.centre!.lng).toBeCloseTo(-71.11, 6);
		expect(view.bounds).toEqual({ minLat: 42.36, maxLat: 42.38, minLng: -71.12, maxLng: -71.1 });
	});

	it('falls back to a stored centroid, so the turf still gets a pin', () => {
		const view = toTurfView(
			row({ hullJson: null, centroidLat: 42.37, centroidLng: -71.11 }),
			[],
			VOLUNTEER,
			NOW,
		);
		expect(view.hull).toEqual([]);
		expect(view.centre).toEqual({ lat: 42.37, lng: -71.11 });
	});

	// The state of the demo key today: no export-job access, so no hulls and no
	// centroids anywhere. Such turf must still be listed.
	it('yields a listable but unmappable turf when there is no geometry at all', () => {
		const view = toTurfView(row({ hullJson: null }), [], VOLUNTEER, NOW);
		expect(view.centre).toBeNull();
		expect(view.bounds).toBeNull();
		expect(view.name).toBe('Turf 01');
		expect(view.doorsRemaining).toBe(250);
	});

	it('mappableTurfs keeps only what can be drawn', () => {
		const withHull = toTurfView(row(), [], VOLUNTEER, NOW);
		const without = toTurfView(row({ turfId: 101, hullJson: null }), [], VOLUNTEER, NOW);
		const mappable = mappableTurfs([withHull, without]);
		expect(mappable.map((t) => t.turfId)).toEqual([100]);
	});
});

describe('toTurfView — freshness and claimability', () => {
	it('reports staleness in minutes from VAN’s refresh time', () => {
		expect(toTurfView(row(), [], VOLUNTEER, NOW).refreshedMinutesAgo).toBe(360);
	});

	// Recomputes run even while the pull is failing, so their timestamp would
	// call old data fresh; how far ContactHistory was read is the honest age.
	it('ages a turf showing its count by the contact cursor, not the recompute', () => {
		const counted = row({
			savedListId: 900,
			rosterSavedListId: 900,
			uncontactedDoors: 5,
			uncontactedDoorsAt: NOW.toISOString(),
		});
		const through = new Date(NOW.getTime() - 90 * 60 * 1000).toISOString();
		expect(
			toTurfView(counted, [], VOLUNTEER, NOW, { contactsThrough: through }).refreshedMinutesAgo,
		).toBe(90);
		// No count: still VAN's own refresh time.
		expect(
			toTurfView(row(), [], VOLUNTEER, NOW, { contactsThrough: through }).refreshedMinutesAgo,
		).toBe(360);
	});

	it('reports null staleness when VAN never gave a refresh time', () => {
		expect(
			toTurfView(row({ lastRefreshedAt: null }), [], VOLUNTEER, NOW).refreshedMinutesAgo,
		).toBeNull();
	});

	it('never reports negative staleness on clock skew', () => {
		const future = row({ lastRefreshedAt: '2026-08-22T18:00:00.000Z' });
		expect(toTurfView(future, [], VOLUNTEER, NOW).refreshedMinutesAgo).toBe(0);
	});

	it('marks turf whose region VAN is re-cutting, without making it unclaimable', () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW, {
			refreshingRegions: new Set([regionRefreshKey(1, 10)]),
		});
		expect(view.updating).toBe(true);
		// Story 4.5: an "updating" turf is still turf you can take. Blocking
		// during a refresh would take the page down on the mornings it is
		// busiest, and would protect only the people who happened to be
		// claiming inside the window.
		expect(view.claimable).toBe(true);
	});

	it('omits the updating flag entirely for every other region', () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW, {
			refreshingRegions: new Set([regionRefreshKey(1, 999)]),
		});
		expect('updating' in view).toBe(false);
	});

	// Region ids are VAN's, unique only within one committee: another
	// campaign's region 10 being re-cut says nothing about this one.
	it("does not mark turf updating for another campaign's region with the same id", () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW, {
			refreshingRegions: new Set([regionRefreshKey(2, 10)]),
		});
		expect('updating' in view).toBe(false);
	});

	it('flags available turf that has no list number, and says who to ask', () => {
		const view = toTurfView(row({ printedListNumber: null }), [], VOLUNTEER, NOW);
		expect(view.noListNumber).toBe(true);
		expect(view.claimable).toBe(false);
		expect(view.claimBlockedReason).toMatch(/organizer/);
	});

	it('omits the no-list-number flag on turf that has one, or that is taken', () => {
		expect('noListNumber' in toTurfView(row(), [], VOLUNTEER, NOW)).toBe(false);
		const taken = row({ printedListNumber: null, vanDistributedTo: 'Sam Ito' });
		expect('noListNumber' in toTurfView(taken, [], VOLUNTEER, NOW)).toBe(false);
	});

	it('is claimable when available with a list number and doors left', () => {
		const view = toTurfView(row(), [], VOLUNTEER, NOW);
		expect(view.claimable).toBe(true);
		expect(view.claimBlockedReason).toBeUndefined();
	});

	it('explains why turf without a list number cannot be claimed', () => {
		const view = toTurfView(row({ printedListNumber: null }), [], VOLUNTEER, NOW);
		expect(view.claimable).toBe(false);
		expect(view.claimBlockedReason).toMatch(/list number/i);
	});

	it('omits the refusal entirely on turf that is visibly checked out', () => {
		// Not null — absent, so JSON.stringify drops the key. The status
		// already explains itself, and the key name is real weight at scale.
		const view = toTurfView(row(), [claim({ slackUserId: 'U_OTHER' })], VOLUNTEER, NOW);
		expect(view.claimable).toBe(false);
		expect('claimBlockedReason' in view).toBe(false);
		expect(JSON.stringify(view)).not.toContain('claimBlockedReason');
	});

	// The button is disabled off `claimable`, so this is what actually greys it
	// out — and canClaim is the same function the API calls, so a hand-rolled
	// POST is refused by the same rule rather than by the template.
	it('refuses turf with no doors left, and says why', () => {
		const view = toTurfView(row({ doorCount: 0 }), [], VOLUNTEER, NOW);
		expect(view.status).toBe('available');
		expect(view.claimable).toBe(false);
		expect(view.claimBlockedReason).toMatch(/already been knocked/i);
	});

	it('still offers a turf with a single door left', () => {
		// The 1-vs-0 boundary the shading exists to make visible; the button
		// has to agree with it.
		const view = toTurfView(row({ doorCount: 1 }), [], VOLUNTEER, NOW);
		expect(view.claimable).toBe(true);
	});

	it('explains a retired turf', () => {
		const view = toTurfView(row({ retiredAt: '2026-08-21T00:00:00.000Z' }), [], VOLUNTEER, NOW);
		expect(view.claimable).toBe(false);
		expect(view.claimBlockedReason).toMatch(/isn't in VAN any more/i);
	});
});

describe('parseHull', () => {
	it('parses a well-formed hull', () => {
		expect(parseHull('[{"lat":1,"lng":2}]')).toEqual([{ lat: 1, lng: 2 }]);
	});
	it.each([
		['null input', null],
		['not JSON', '{oops'],
		['not an array', '{"lat":1}'],
		['a non-numeric point', '[{"lat":"1","lng":2}]'],
		['a NaN point', '[{"lat":null,"lng":2}]'],
	])('degrades to no shape for %s', (_label, input) => {
		expect(parseHull(input)).toEqual([]);
	});
});

describe('doorsLeft', () => {
	const base = { doorCount: 40, uncontactedDoors: 12, savedListId: 900 };

	it('uses the count when its roster is from the current saved list', () => {
		expect(doorsLeft({ ...base, rosterSavedListId: 900 })).toBe(12);
	});

	// Between a re-cut and the next recompute, or after the feature is
	// switched off, the stored count is not this turf's.
	it("falls back to VAN's doorCount when the count is from another cut", () => {
		expect(doorsLeft({ ...base, rosterSavedListId: 899 })).toBe(40);
		expect(doorsLeft({ ...base, rosterSavedListId: null })).toBe(40);
		expect(doorsLeft({ ...base, savedListId: null, rosterSavedListId: null })).toBe(40);
	});

	it("falls back to VAN's doorCount when there is no count", () => {
		expect(doorsLeft({ ...base, uncontactedDoors: null, rosterSavedListId: 900 })).toBe(40);
	});
});

describe('vanAssignmentBlocks', () => {
	const HOUR = 3_600_000;
	const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
	const counted = { savedListId: 900, rosterSavedListId: 900, uncontactedDoors: 12 };

	it('blocks for 48 hours after the hand-out', () => {
		const handedOut = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(47) });
		expect(vanAssignmentBlocks(handedOut, NOW)).toBe(true);
	});

	it('lets go once 48 hours have passed and the count shows what is left', () => {
		const handedOut = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(48) });
		expect(vanAssignmentBlocks(handedOut, NOW)).toBe(false);
	});

	// Without a count the turf would come back at VAN's full doorCount.
	it('keeps holding a lapsed hand-out when there is no current count', () => {
		const lapsed = { vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(72) };
		expect(vanAssignmentBlocks(row(lapsed), NOW)).toBe(true);
		expect(vanAssignmentBlocks(row({ ...lapsed, ...counted, rosterSavedListId: 899 }), NOW)).toBe(
			true,
		);
	});

	it('uses the configured hold instead of 48 hours', () => {
		const handedOut = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(60) });
		expect(vanAssignmentBlocks(handedOut, NOW, 72)).toBe(true);
		expect(vanAssignmentBlocks(handedOut, NOW, 24)).toBe(false);
		expect(toTurfView(handedOut, [], VOLUNTEER, NOW, { vanAssignmentTtlHours: 72 }).status).toBe(
			'checked-out',
		);
		expect(toTurfView(handedOut, [], VOLUNTEER, NOW, { vanAssignmentTtlHours: 24 }).status).toBe(
			'available',
		);
	});

	it('never lets go when the hold is set to 0', () => {
		const old = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(10_000) });
		expect(vanAssignmentBlocks(old, NOW, 0)).toBe(true);
		expect(toTurfView(old, [], VOLUNTEER, NOW, { vanAssignmentTtlHours: 0 }).status).toBe(
			'checked-out',
		);
		// 0 is "never", not "no hold": turf nobody was handed is unaffected.
		expect(vanAssignmentBlocks(row(counted), NOW, 0)).toBe(false);
	});

	it('keeps holding a hand-out with no date', () => {
		expect(
			vanAssignmentBlocks(
				row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: null }),
				NOW,
			),
		).toBe(true);
	});

	it('never blocks turf nobody was handed', () => {
		expect(vanAssignmentBlocks(row({ ...counted, vanAssignedAt: ago(1) }), NOW)).toBe(false);
	});

	it('shows a lapsed hand-out as available and claimable, with no holder', () => {
		const lapsed = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(72) });
		const view = toTurfView(lapsed, [], ADMIN, NOW);
		expect(view.status).toBe('available');
		expect(view.heldBy).toBeNull();
		expect(view.claimable).toBe(true);
	});

	it('still shows a live hand-out as checked out', () => {
		const live = row({ ...counted, vanDistributedTo: 'Sam Ito', vanAssignedAt: ago(2) });
		const view = toTurfView(live, [], VOLUNTEER, NOW);
		expect(view.status).toBe('checked-out');
		expect(view.claimable).toBe(false);
	});

	// A lapsed VAN hand-out must not unmask a Packet Tracker row that still
	// blocks on its own terms.
	it('falls through to the Packet Tracker when the VAN hold has lapsed', () => {
		const lapsed = row({
			...counted,
			uncontactedDoors: 0,
			vanDistributedTo: 'Sam Ito',
			vanAssignedAt: ago(72),
			sheetAssignedTo: 'Jo Park',
		});
		expect(toTurfView(lapsed, [], ADMIN, NOW).heldBy).toBe('Jo Park');
	});
});

describe('doorDensity', () => {
	const square = [
		{ lat: 42, lng: -71 },
		{ lat: 42, lng: -70.99 },
		{ lat: 42.01, lng: -70.99 },
		{ lat: 42.01, lng: -71 },
	];

	it('is doors remaining per square kilometre of hull', () => {
		// The square is ~0.92 km².
		expect(doorDensity({ hull: square, doorsRemaining: 92 })).toBeCloseTo(100, 0);
	});

	it('is null without a hull to measure', () => {
		expect(doorDensity({ hull: [], doorsRemaining: 50 })).toBeNull();
	});

	// A single apartment building: hundreds of doors on a hull a few metres
	// across, which would out-rank every street in the county.
	it('is null for a hull smaller than a block', () => {
		const building = [
			{ lat: 42, lng: -71 },
			{ lat: 42, lng: -70.9995 },
			{ lat: 42.0005, lng: -70.9995 },
			{ lat: 42.0005, lng: -71 },
		];
		// ~41 m × 56 m, about 2,300 m².
		expect(doorDensity({ hull: building, doorsRemaining: 150 })).toBeNull();
	});

	it('ranks a hull just over a block', () => {
		const block = [
			{ lat: 42, lng: -71 },
			{ lat: 42, lng: -70.9988 },
			{ lat: 42.001, lng: -70.9988 },
			{ lat: 42.001, lng: -71 },
		];
		// ~99 m × 111 m, about 11,000 m².
		expect(doorDensity({ hull: block, doorsRemaining: 11 })).toBeCloseTo(1000, -2);
	});
});
