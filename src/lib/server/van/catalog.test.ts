import { describe, it, expect } from 'vitest';
import { planCatalogSync, needsGeometry, type CatalogFolder } from './catalog.js';
import type { VanTurfRow } from '../schema.js';
import type { VanMapRegion, VanMinivanExport } from './types.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function route(over: Record<string, unknown> = {}) {
	return {
		mapRouteId: 100,
		name: 'City of Cambridge Turf 01',
		savedListId: 900,
		routeNumber: 1,
		routeSize: 400,
		doorCount: 250,
		phoneCount: 120,
		printedList: { number: '35536745-88712' },
		...over,
	};
}

function region(routes: unknown[], over: Record<string, unknown> = {}): VanMapRegion {
	return {
		mapRegionId: 10,
		name: 'Cambridge North',
		mapRoutes: routes,
		...over,
	} as VanMapRegion;
}

function folder(regions: VanMapRegion[], over: Partial<CatalogFolder> = {}): CatalogFolder {
	return {
		folderId: 1152,
		folderName: 'Middlesex Turf',
		chapterId: 71,
		chapterName: 'Middlesex County',
		regions,
		...over,
	};
}

function existingRow(over: Partial<VanTurfRow> = {}): VanTurfRow {
	return {
		mapRouteId: 100,
		mapRegionId: 10,
		folderId: 1152,
		chapterId: 71,
		chapterName: 'Middlesex County',
		regionName: 'Cambridge North',
		name: 'City of Cambridge Turf 01',
		savedListId: 900,
		printedListNumber: '35536745-88712',
		routeNumber: 1,
		routeSize: 400,
		doorCount: 250,
		phoneCount: 120,
		centroidLat: 42.37,
		centroidLng: -71.11,
		hullJson: '[{"lat":42.37,"lng":-71.11}]',
		hullSourceRouteSize: 400,
		vanDistributedTo: null,
		firstSeenAt: '2026-08-01T00:00:00.000Z',
		lastSeenAt: '2026-08-20T00:00:00.000Z',
		lastRefreshedAt: '2026-08-20T00:00:00.000Z',
		retiredAt: null,
		...over,
	} as VanTurfRow;
}

const base = { printedLists: [], existing: [], now: NOW };

describe('planCatalogSync', () => {
	it('maps a route to a turf row with its chapter and counts', () => {
		const plan = planCatalogSync({ ...base, folders: [folder([region([route()])])] });

		expect(plan.upserts).toHaveLength(1);
		expect(plan.upserts[0]).toMatchObject({
			mapRouteId: 100,
			mapRegionId: 10,
			folderId: 1152,
			chapterId: 71,
			chapterName: 'Middlesex County',
			regionName: 'Cambridge North',
			printedListNumber: '35536745-88712',
			routeSize: 400,
			doorCount: 250,
			retiredAt: null,
		});
		expect(plan.upserts[0]!.firstSeenAt).toBe(NOW.toISOString());
		expect(plan.upserts[0]!.lastSeenAt).toBe(NOW.toISOString());
	});

	it('preserves firstSeenAt and existing geometry across syncs', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route({ doorCount: 200 })])])],
			existing: [existingRow()],
		});

		const row = plan.upserts[0]!;
		expect(row.firstSeenAt).toBe('2026-08-01T00:00:00.000Z');
		expect(row.lastSeenAt).toBe(NOW.toISOString());
		expect(row.hullJson).toBe('[{"lat":42.37,"lng":-71.11}]');
		expect(row.doorCount).toBe(200);
		expect(plan.geometryQueue).toHaveLength(0);
	});

	describe('printed list numbers', () => {
		it('backfills from /printedLists when the route carries none', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ printedList: null })])])],
				printedLists: [
					{
						number: '11111111-22222',
						name: 'city of cambridge  turf 01',
						listSize: 400,
						folders: [{ folderId: 1152, name: 'Middlesex Turf' }],
						dateCreated: null,
						createdBy: null,
					},
				],
			});
			expect(plan.upserts[0]!.printedListNumber).toBe('11111111-22222');
		});

		it('records when the issued list was generated, from either source', () => {
			const list = (number: string, dateCreated: string) => ({
				number,
				name: 'City of Cambridge Turf 01',
				listSize: 400,
				folders: [{ folderId: 1152, name: 'Middlesex Turf' }],
				dateCreated,
				createdBy: null,
			});
			// Route-level date wins when the route carries one.
			const fromRoute = planCatalogSync({
				...base,
				folders: [
					folder([
						region([
							route({
								printedList: { number: '35536745-88712', dateCreated: '2026-08-01T10:00:00Z' },
							}),
						]),
					]),
				],
			});
			expect(fromRoute.upserts[0]!.printedListCreatedAt).toBe('2026-08-01T10:00:00Z');

			// Otherwise it comes from /printedLists, by the number being issued.
			const fromList = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				printedLists: [list('35536745-88712', '2026-08-02T10:00:00Z')],
			});
			expect(fromList.upserts[0]!.printedListCreatedAt).toBe('2026-08-02T10:00:00Z');

			// No number, no date — even when a list with another number has one.
			const none = planCatalogSync({
				...base,
				folders: [folder([region([route({ printedList: null })])])],
			});
			expect(none.upserts[0]!.printedListCreatedAt).toBeNull();
		});

		it('never touches the expiry-warning stamp, so a sync cannot re-arm a warning', () => {
			const plan = planCatalogSync({
				...base,
				existing: [existingRow({ listExpiryWarnedFor: '2026-08-01T10:00:00Z' })],
				folders: [folder([region([route()])])],
			});
			// Absent from the row, so the upsert's SET leaves the column alone.
			expect('listExpiryWarnedFor' in plan.upserts[0]!).toBe(false);
		});

		it('trusts the route and warns when the two disagree', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				printedLists: [
					{
						number: '99999999-00000',
						name: 'City of Cambridge Turf 01',
						listSize: 400,
						folders: [{ folderId: 1152, name: 'Middlesex Turf' }],
						dateCreated: null,
						createdBy: null,
					},
				],
			});
			expect(plan.upserts[0]!.printedListNumber).toBe('35536745-88712');
			const warning = plan.warnings.join(' ');
			expect(warning).toContain('City of Cambridge Turf 01');
			// The warning is posted to a Slack channel, so neither number may
			// appear in it — a MiniVAN list number is the credential.
			expect(warning).not.toContain('35536745-88712');
			expect(warning).not.toContain('99999999-00000');
		});

		it('does not borrow another folder’s identically named turf', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ printedList: null })])])],
				printedLists: [
					{
						number: '11111111-22222',
						name: 'City of Cambridge Turf 01',
						listSize: 400,
						folders: [{ folderId: 9999, name: 'Some Other County' }],
						dateCreated: null,
						createdBy: null,
					},
				],
			});
			expect(plan.upserts[0]!.printedListNumber).toBeNull();
		});

		it('collects unclaimable turf into a single warning, not one per route', () => {
			const routes = [1, 2, 3, 4, 5, 6, 7].map((n) =>
				route({ mapRouteId: 100 + n, name: `Turf 0${n}`, printedList: null }),
			);
			const plan = planCatalogSync({ ...base, folders: [folder([region(routes)])] });

			const missing = plan.warnings.filter((w) => w.includes('no MiniVAN list number'));
			expect(missing).toHaveLength(1);
			expect(missing[0]).toContain('7 turf(s)');
			expect(missing[0]).toContain('+2 more');
		});
	});

	describe('retirement', () => {
		it('retires a route that stopped appearing in a folder we synced', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				existing: [existingRow(), existingRow({ mapRouteId: 101, name: 'Turf 02' })],
			});
			expect(plan.retirements).toEqual([101]);
		});

		it('leaves turf in a folder that failed to sync completely alone', () => {
			// The classic disaster: one folder 403s, is dropped from `folders`,
			// and a naive diff retires every turf in it — releasing live claims
			// under volunteers already walking.
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				existing: [existingRow(), existingRow({ mapRouteId: 500, folderId: 9999 })],
			});
			expect(plan.retirements).toEqual([]);
		});

		it('does not re-retire an already retired route', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([])])],
				existing: [existingRow({ retiredAt: '2026-08-10T00:00:00.000Z' })],
			});
			expect(plan.retirements).toEqual([]);
		});

		it('reports a retired route that came back', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				existing: [existingRow({ retiredAt: '2026-08-10T00:00:00.000Z' })],
			});
			expect(plan.unretirements).toEqual([100]);
			expect(plan.upserts[0]!.retiredAt).toBeNull();
		});
	});

	describe('geometry', () => {
		it('queues a turf that has never had a hull', () => {
			const plan = planCatalogSync({ ...base, folders: [folder([region([route()])])] });
			expect(plan.geometryQueue).toEqual([{ mapRouteId: 100, savedListId: 900 }]);
		});

		it('does not queue a turf whose route merely shrank from canvassing', () => {
			// Doors leaving the list is the entire remaining-doors mechanism.
			// The addresses that remain sit inside the hull we already drew, so
			// re-exporting every turf after every refresh would be hundreds of
			// jobs a night to redraw shapes that were already right.
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ routeSize: 310, doorCount: 180 })])])],
				existing: [existingRow({ hullSourceRouteSize: 400 })],
			});
			expect(plan.geometryQueue).toHaveLength(0);
			expect(plan.upserts[0]!.hullJson).not.toBeNull();
		});

		it('re-queues and drops the hull when a route grows', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ routeSize: 460 })])])],
				existing: [existingRow({ hullSourceRouteSize: 400 })],
			});
			expect(plan.geometryQueue).toEqual([{ mapRouteId: 100, savedListId: 900 }]);
			expect(plan.upserts[0]!.hullJson).toBeNull();
			expect(plan.upserts[0]!.centroidLat).toBeNull();
			expect(plan.upserts[0]!.hullSourceRouteSize).toBeNull();
		});

		it('re-queues when a route collapses to less than half its hull size', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ routeSize: 150 })])])],
				existing: [existingRow({ hullSourceRouteSize: 400 })],
			});
			expect(plan.geometryQueue).toEqual([{ mapRouteId: 100, savedListId: 900 }]);
			expect(plan.upserts[0]!.hullJson).toBeNull();
		});

		it('tolerates VAN re-counting a route by one or two', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ routeSize: 402 })])])],
				existing: [existingRow({ hullSourceRouteSize: 400 })],
			});
			expect(plan.geometryQueue).toHaveLength(0);
		});

		it('skips a route with no saved list — there is nothing to export', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route({ savedListId: null })])])],
			});
			expect(plan.geometryQueue).toHaveLength(0);
		});
	});

	// These fixtures are the shape the LIVE API returns, captured 2026-09-22.
	// The previous ones were invented — an export named for the turf, with
	// `canvassers: [{name}]` — and both details were wrong, which is how
	// van_distributed_to came out null for every turf while these tests passed.
	// An export is named for its printed LIST, and a canvasser has firstName
	// and lastName and no `name` at all.
	const exportOf = (over: Partial<VanMinivanExport> = {}): VanMinivanExport => ({
		minivanExportId: 5,
		name: 'List 35536745-88712',
		dateCreated: '2026-09-22T14:10:33.83Z',
		createdBy: { id: 1, displayName: 'Richard Williamson' },
		canvassers: [{ canvassserId: 1, firstName: 'Dana', lastName: 'Ruiz' }],
		databaseMode: 0,
		...over,
	});

	it('flags turf an organizer distributed to MiniVAN by hand', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [
				exportOf({
					canvassers: [
						{ canvassserId: 1, firstName: 'Dana', lastName: 'Ruiz' },
						{ canvassserId: 2, firstName: 'Sam', lastName: 'Ito' },
					],
				}),
			],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBe('Dana Ruiz, Sam Ito');
	});

	// The join is the list number, because that is what the export names. The
	// route is called "City of Cambridge Turf 01" and matching on that found
	// nothing.
	it('matches the export to the turf by printed list number', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [exportOf({ name: 'List 35536745-88712' })],
		});
		expect(plan.upserts[0]!.printedListNumber).toBe('35536745-88712');
		expect(plan.upserts[0]!.vanDistributedTo).toBe('Dana Ruiz');
	});

	it('does not match an export for a different list', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [exportOf({ name: 'List 99999999-00000' })],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBeNull();
	});

	// Hand-named exports are left unmatched on purpose: the export window spans
	// a decade, turf names repeat across it, and matching one by name would
	// attribute a stranger from 2014 to turf cut last week.
	it('ignores a hand-named export rather than matching it by turf name', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [exportOf({ name: 'City of Cambridge Turf 01' })],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBeNull();
	});

	it('still reads a canvasser that does carry a name field', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [exportOf({ canvassers: [{ name: 'Dana Ruiz' }] })],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBe('Dana Ruiz');
	});

	it('ignores a MiniVAN export with no canvassers on it', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [exportOf({ canvassers: [] })],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBeNull();
	});

	// VAN returns some canvassers as an id with null names. They still hold the
	// list, so the turf must not read as free.
	it('shows a canvasser VAN names only by id as an unknown canvasser', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [
				exportOf({ canvassers: [{ canvassserId: 7, firstName: null, lastName: null }] }),
			],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBe('unknown canvasser');
	});

	it('names an unknown canvasser once, however many there are', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			minivanExports: [
				exportOf({
					canvassers: [
						{ canvassserId: 1, firstName: 'Dana', lastName: 'Ruiz' },
						{ canvassserId: 7 },
						{ canvassserId: 8 },
					],
				}),
			],
		});
		expect(plan.upserts[0]!.vanDistributedTo).toBe('Dana Ruiz, unknown canvasser');
	});

	describe('when a list has been exported more than once', () => {
		// The live case: Royal Oak 59430821-62783 went to a named canvasser on
		// 09-22 and was re-exported on 09-23 to one VAN names only by id.
		const first = exportOf({
			minivanExportId: 645875,
			dateCreated: '2026-09-22T11:52:28.15Z',
			canvassers: [{ canvassserId: 2833309, firstName: 'Tammy', lastName: 'Banjany' }],
		});
		const second = exportOf({
			minivanExportId: 646478,
			dateCreated: '2026-09-23T11:43:55.93Z',
			canvassers: [{ canvassserId: 132602398, firstName: null, lastName: null }],
		});

		it('takes the latest export, not every export merged', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				minivanExports: [first, second],
			});
			expect(plan.upserts[0]!.vanDistributedTo).toBe('unknown canvasser');
		});

		it('decides by date, whatever order the exports arrive in', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				minivanExports: [second, first],
			});
			expect(plan.upserts[0]!.vanDistributedTo).toBe('unknown canvasser');
		});

		it('breaks a same-second tie by export id', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				minivanExports: [
					exportOf({ minivanExportId: 9, canvassers: [{ firstName: 'Sam', lastName: 'Ito' }] }),
					exportOf({ minivanExportId: 8, canvassers: [{ firstName: 'Dana', lastName: 'Ruiz' }] }),
				],
			});
			expect(plan.upserts[0]!.vanDistributedTo).toBe('Sam Ito');
		});

		// An export naming nobody is no evidence the list changed hands.
		it('keeps the earlier canvasser when the later export has none', () => {
			const plan = planCatalogSync({
				...base,
				folders: [folder([region([route()])])],
				minivanExports: [
					first,
					exportOf({
						minivanExportId: 646999,
						dateCreated: '2026-09-23T12:00:00Z',
						canvassers: [],
					}),
				],
			});
			expect(plan.upserts[0]!.vanDistributedTo).toBe('Tammy Banjany');
		});
	});

	it('handles an empty catalog without throwing', () => {
		const plan = planCatalogSync({ ...base, folders: [] });
		expect(plan).toEqual({
			upserts: [],
			retirements: [],
			unretirements: [],
			geometryQueue: [],
			warnings: [],
		});
	});

	it('records VAN’s own refresh timestamp rather than our sync time', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()], { dateRefreshed: '2026-08-20T20:59:00Z' })])],
		});
		expect(plan.upserts[0]!.lastRefreshedAt).toBe('2026-08-20T20:59:00Z');
	});

	it('keeps the prior refresh time when VAN omits one', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route()])])],
			existing: [existingRow({ lastRefreshedAt: '2026-08-19T00:00:00.000Z' })],
		});
		expect(plan.upserts[0]!.lastRefreshedAt).toBe('2026-08-19T00:00:00.000Z');
	});

	it('names a route VAN left unnamed', () => {
		const plan = planCatalogSync({
			...base,
			folders: [folder([region([route({ name: null, routeNumber: 7 })])])],
		});
		expect(plan.upserts[0]!.name).toBe('Turf 7');
	});
});

describe('needsGeometry', () => {
	it('is true with no hull', () => {
		expect(needsGeometry({ hullJson: null, hullSourceRouteSize: null, routeSize: 100 })).toBe(true);
	});
	it('is true when the hull records no source size', () => {
		expect(needsGeometry({ hullJson: '[]', hullSourceRouteSize: null, routeSize: 100 })).toBe(true);
	});
	it('is false for a stable route', () => {
		expect(needsGeometry({ hullJson: '[]', hullSourceRouteSize: 100, routeSize: 100 })).toBe(false);
	});
	it('is false at exactly the collapse threshold', () => {
		expect(needsGeometry({ hullJson: '[]', hullSourceRouteSize: 100, routeSize: 50 })).toBe(false);
	});
	it('is true just past it', () => {
		expect(needsGeometry({ hullJson: '[]', hullSourceRouteSize: 100, routeSize: 49 })).toBe(true);
	});
});
