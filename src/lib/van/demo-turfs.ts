// Fabricated turf data for the admin-only walkthrough at /turfs?demo.
//
// Lives in $lib rather than beside a route because there is no longer a
// separate demo page: /turfs renders this data instead of the database when an
// admin passes ?demo. One page means the walkthrough cannot drift away from
// the thing it is supposed to be previewing.
//
// Every number here is invented. No VAN key exists yet (see
// specs/010-van-turf-checkout/plan.md Story 0 — the campaign is still waiting
// on a Tier 3 security review), so this page exists to show organizers the
// volunteer flow while that runs.
//
// The shapes are NOT hand-drawn. Each turf gets a deterministic scatter of
// fake door coordinates which is then pushed through the real
// $lib/van/geometry pipeline — dropOutliers → convexHull → centroid — exactly
// as production will push real exported coordinates. So what the demo shows
// about hull quality (that a convex hull over-claims territory on an
// L-shaped turf) is honest rather than flattering.
//
// The neighbourhood is Cambridge, MA because VAN's own API documentation uses
// "City of Cambridge Turf 01" as its Map Route example. Nobody should mistake
// it for the campaign's real territory.

import { boundingBox, centroid, convexHull, dropOutliers, type LatLng } from './geometry.js';
import { visibleTurfState, type TurfStatus } from './turf-status.js';
import { canClaim, type ClaimSnapshot } from './checkout.js';
import type { TurfView } from './turf-view.js';

/** A county chapter, as it appears in Solidarity and in chapter_channel_map. */
export interface DemoChapter {
	chapterId: number;
	name: string;
}

/**
 * Exactly the shape the real page renders — `TurfView`, aliased rather than
 * redeclared.
 *
 * This is the guarantee that makes one page safe to use for both: if a field
 * is added to what volunteers see, this fixture stops compiling until it
 * supplies one too. A parallel interface would let the walkthrough quietly
 * fall behind the thing it exists to preview, which is exactly how the old
 * separate demo route drifted.
 */
export type DemoTurf = TurfView;

/** The viewer the fixture is built for. Only ever compared against itself, so
 *  the value is arbitrary — it just has to be stable. */
const DEMO_VIEWER_ID = 'U_DEMO_VIEWER';

/** A fixed clock. The fixture is asserted to be deterministic across calls, so
 *  it must not read the wall clock to decide whether a claim is still live. */
const DEMO_NOW = new Date('2026-01-01T00:00:00.000Z');
const DEMO_CLAIM_EXPIRY = '2099-01-01T00:00:00.000Z';

/** The ledger rows canClaim would find for this turf. Held turf gets one live
 *  claim; everything else gets none. */
function demoClaims(seed: TurfSeed): ClaimSnapshot[] {
	if (seed.status !== 'held-by-you' && seed.status !== 'held-by-other') return [];
	return [
		{
			mapRouteId: seed.mapRouteId,
			slackUserId: seed.status === 'held-by-you' ? DEMO_VIEWER_ID : 'U_SOMEONE_ELSE',
			slackUserName: seed.heldBy ?? 'A volunteer',
			claimedAt: DEMO_NOW.toISOString(),
			expiresAt: DEMO_CLAIM_EXPIRY,
			releasedAt: null,
			completedAt: null,
		},
	];
}

/** Deterministic PRNG (mulberry32) so the demo looks identical on every load.
 *  A demo that reshuffles between refreshes makes organizers think it's live. */
function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The stress-test chapter: 1,000 turfs spread across a county roughly 90 miles
 * wide, which is the shape of the campaign's biggest chapter.
 *
 * This is not decoration. It is the load case that decides whether hand-rolled
 * SVG rendering survives contact with a real chapter, or whether the map needs
 * canvas / a library / server-side viewport paging. Numbers worth watching
 * while it's open: the SSR payload size, first paint, and whether a drag stays
 * smooth.
 */
export const STRESS_CHAPTER_ID = 99;
const STRESS_TURF_COUNT = 1000;

/** County chapters, as they'd come from Solidarity via chapter_channel_map.
 *  Real chapter ids are Solidarity's; these are invented. */
export const DEMO_CHAPTERS: DemoChapter[] = [
	{ chapterId: 71, name: 'Middlesex County' },
	{ chapterId: 72, name: 'Suffolk County' },
	{ chapterId: 73, name: 'Norfolk County' },
	{ chapterId: STRESS_CHAPTER_ID, name: 'Stress test — 1,000 turfs' },
];

interface TurfSeed {
	mapRouteId: number;
	chapterId: number;
	name: string;
	regionName: string;
	printedListNumber: string;
	savedListId: number;
	centre: LatLng;
	/** Rough turf radius in degrees; ~0.0035 is a few blocks. */
	spread: number;
	/** >1 stretches the turf east-west, <1 north-south. Real turfs follow
	 *  streets, so none of them are circular. */
	aspect: number;
	doors: number;
	doorsRemaining: number;
	status: TurfStatus;
	heldBy: string | null;
	expiresInHours: number | null;
	refreshedMinutesAgo: number;
	/** VAN is re-cutting this turf's region right now. Set on one demo turf so
	 *  organizers previewing the flow see the state and can ask about it — it
	 *  is a chip on a still-claimable row, not a lock (Story 4.5.4). */
	updating?: true;
	seed: number;
}

const SEEDS: TurfSeed[] = [
	{
		mapRouteId: 4101,
		chapterId: 71,
		name: 'Ward 3 Turf 01',
		regionName: 'Ward 3 — Riverside',
		printedListNumber: '35536742-78261',
		savedListId: 500111,
		centre: { lat: 42.3688, lng: -71.1072 },
		spread: 0.0032,
		aspect: 1.6,
		doors: 91,
		doorsRemaining: 91,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1001,
	},
	{
		mapRouteId: 4102,
		chapterId: 71,
		name: 'Ward 3 Turf 02',
		regionName: 'Ward 3 — Riverside',
		printedListNumber: '35536745-88712',
		savedListId: 500112,
		centre: { lat: 42.3722, lng: -71.1121 },
		spread: 0.0026,
		aspect: 0.7,
		doors: 63,
		doorsRemaining: 47,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		// Freshly re-cut in VAN: its door count is about to move, and it is
		// still claimable while that happens.
		refreshedMinutesAgo: 3,
		updating: true,
		seed: 1002,
	},
	{
		mapRouteId: 4103,
		chapterId: 71,
		name: 'Ward 3 Turf 03',
		regionName: 'Ward 3 — Riverside',
		printedListNumber: '35536749-11904',
		savedListId: 500113,
		centre: { lat: 42.3671, lng: -71.1128 },
		spread: 0.0029,
		aspect: 1.1,
		doors: 74,
		doorsRemaining: 74,
		status: 'held-by-you',
		heldBy: null,
		expiresInHours: 39,
		refreshedMinutesAgo: 42,
		seed: 1003,
	},
	{
		// Walked out. Present so the demo actually shows the "no doors left"
		// state — a turf with nothing on it is a common sight a day into a
		// canvass, and it is the one state a volunteer must not walk to.
		mapRouteId: 4109,
		chapterId: 71,
		name: 'Ward 3 Turf 04',
		regionName: 'Ward 3 — Riverside',
		printedListNumber: '35536749-11204',
		savedListId: 500114,
		centre: { lat: 42.3652, lng: -71.1138 },
		spread: 0.0029,
		aspect: 1.25,
		doors: 62,
		doorsRemaining: 0,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1009,
	},
	{
		mapRouteId: 4204,
		chapterId: 71,
		name: 'Ward 4 Turf 01',
		regionName: 'Ward 4 — Cambridgeport',
		printedListNumber: '35536751-40233',
		savedListId: 500214,
		centre: { lat: 42.3634, lng: -71.1041 },
		spread: 0.0034,
		aspect: 1.35,
		doors: 88,
		doorsRemaining: 88,
		status: 'held-by-other',
		heldBy: 'Priya R.',
		expiresInHours: 11,
		refreshedMinutesAgo: 42,
		seed: 1004,
	},
	{
		mapRouteId: 4205,
		chapterId: 71,
		name: 'Ward 4 Turf 02',
		regionName: 'Ward 4 — Cambridgeport',
		printedListNumber: '35536753-62018',
		savedListId: 500215,
		centre: { lat: 42.3601, lng: -71.1098 },
		spread: 0.0022,
		aspect: 0.85,
		doors: 52,
		doorsRemaining: 18,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1005,
	},
	{
		mapRouteId: 4206,
		chapterId: 71,
		name: 'Ward 4 Turf 03',
		regionName: 'Ward 4 — Cambridgeport',
		printedListNumber: '35536755-77420',
		savedListId: 500216,
		centre: { lat: 42.3652, lng: -71.0982 },
		spread: 0.0027,
		aspect: 1.2,
		doors: 69,
		doorsRemaining: 69,
		status: 'assigned-in-van',
		heldBy: 'Marcus T.',
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1006,
	},
	{
		mapRouteId: 4307,
		chapterId: 71,
		name: 'Ward 5 Turf 01',
		regionName: 'Ward 5 — Mid-Cambridge',
		printedListNumber: '35536758-90551',
		savedListId: 500317,
		centre: { lat: 42.3751, lng: -71.1024 },
		spread: 0.003,
		aspect: 1.45,
		doors: 96,
		doorsRemaining: 82,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1007,
	},
	{
		mapRouteId: 4308,
		chapterId: 71,
		name: 'Ward 5 Turf 02',
		regionName: 'Ward 5 — Mid-Cambridge',
		printedListNumber: '35536760-13877',
		savedListId: 500318,
		centre: { lat: 42.3783, lng: -71.1089 },
		spread: 0.0038,
		aspect: 0.95,
		doors: 118,
		doorsRemaining: 118,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 42,
		seed: 1008,
	},

	// --- Suffolk County -----------------------------------------------------
	{
		mapRouteId: 5101,
		chapterId: 72,
		name: 'Ward 8 Turf 01',
		regionName: 'Ward 8 — South End',
		printedListNumber: '35540118-22047',
		savedListId: 501101,
		centre: { lat: 42.3411, lng: -71.0745 },
		spread: 0.0031,
		aspect: 1.25,
		doors: 84,
		doorsRemaining: 84,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 96,
		seed: 2001,
	},
	{
		mapRouteId: 5102,
		chapterId: 72,
		name: 'Ward 8 Turf 02',
		regionName: 'Ward 8 — South End',
		printedListNumber: '35540121-63390',
		savedListId: 501102,
		centre: { lat: 42.3448, lng: -71.0691 },
		spread: 0.0024,
		aspect: 0.8,
		doors: 57,
		doorsRemaining: 31,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 96,
		seed: 2002,
	},
	{
		mapRouteId: 5103,
		chapterId: 72,
		name: 'Ward 9 Turf 01',
		regionName: 'Ward 9 — Roxbury',
		printedListNumber: '35540124-51882',
		savedListId: 501103,
		centre: { lat: 42.3368, lng: -71.0821 },
		spread: 0.0035,
		aspect: 1.5,
		doors: 103,
		doorsRemaining: 103,
		status: 'held-by-other',
		heldBy: 'Dae-Ho L.',
		expiresInHours: 27,
		refreshedMinutesAgo: 96,
		seed: 2003,
	},
	{
		mapRouteId: 5104,
		chapterId: 72,
		name: 'Ward 9 Turf 02',
		regionName: 'Ward 9 — Roxbury',
		printedListNumber: '35540127-70115',
		savedListId: 501104,
		centre: { lat: 42.3325, lng: -71.0768 },
		spread: 0.0028,
		aspect: 1.05,
		doors: 71,
		doorsRemaining: 71,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 96,
		seed: 2004,
	},

	// --- Norfolk County -----------------------------------------------------
	{
		// A second one, in another chapter, so switching chapters in the demo
		// does not make the state look like a quirk of one county.
		mapRouteId: 5105,
		chapterId: 72,
		name: 'Ward 9 Turf 03',
		regionName: 'Ward 9 — Roxbury',
		printedListNumber: '35538814-60733',
		savedListId: 501105,
		centre: { lat: 42.3389, lng: -71.0702 },
		spread: 0.0026,
		aspect: 1.05,
		doors: 45,
		doorsRemaining: 0,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 26,
		seed: 2005,
	},
	{
		mapRouteId: 6101,
		chapterId: 73,
		name: 'Precinct 2 Turf 01',
		regionName: 'Quincy — Precinct 2',
		printedListNumber: '35541902-38664',
		savedListId: 502101,
		centre: { lat: 42.2551, lng: -71.0043 },
		spread: 0.0036,
		aspect: 1.3,
		doors: 95,
		doorsRemaining: 95,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 15,
		seed: 3001,
	},
	{
		mapRouteId: 6102,
		chapterId: 73,
		name: 'Precinct 2 Turf 02',
		regionName: 'Quincy — Precinct 2',
		printedListNumber: '35541905-90228',
		savedListId: 502102,
		centre: { lat: 42.2598, lng: -71.0112 },
		spread: 0.0027,
		aspect: 0.9,
		doors: 66,
		doorsRemaining: 9,
		status: 'available',
		heldBy: null,
		expiresInHours: null,
		refreshedMinutesAgo: 15,
		seed: 3002,
	},
	{
		mapRouteId: 6103,
		chapterId: 73,
		name: 'Precinct 5 Turf 01',
		regionName: 'Quincy — Precinct 5',
		printedListNumber: '35541908-44971',
		savedListId: 502103,
		centre: { lat: 42.2489, lng: -70.9968 },
		spread: 0.003,
		aspect: 1.15,
		doors: 78,
		doorsRemaining: 78,
		status: 'assigned-in-van',
		heldBy: 'Renata S.',
		expiresInHours: null,
		refreshedMinutesAgo: 15,
		seed: 3003,
	},
];

/** Scatter plausible door coordinates for one turf.
 *
 *  Doors cluster along streets rather than filling a disc, so points are laid
 *  on a few parallel rows with jitter. That is also what makes the convex hull
 *  visibly over-claim at the corners — which the demo should show, not hide. */
function scatterDoors(seed: TurfSeed): LatLng[] {
	const rand = seededRandom(seed.seed);
	const points: LatLng[] = [];
	const rows = 5;
	const perRow = Math.ceil(seed.doors / rows);

	for (let row = 0; row < rows; row++) {
		// -1 … +1 across the turf, north to south.
		const rowOffset = (row / (rows - 1)) * 2 - 1;
		for (let i = 0; i < perRow && points.length < seed.doors; i++) {
			const along = (i / Math.max(perRow - 1, 1)) * 2 - 1;
			// Taper the end rows so turfs read as blocks, not rectangles.
			const taper = 1 - Math.abs(rowOffset) * 0.25;
			points.push({
				lat: seed.centre.lat + rowOffset * seed.spread + (rand() - 0.5) * seed.spread * 0.18,
				lng:
					seed.centre.lng +
					along * seed.spread * seed.aspect * taper +
					(rand() - 0.5) * seed.spread * 0.22,
			});
		}
	}
	return points;
}

/** Coordinate precision on the wire.
 *
 *  Five decimal places is ~1.1 m, which is far finer than a convex hull over
 *  a turf will ever be meaningful to — and it is the precision
 *  `mobilize-migrator/lib/geocode.ts` already uses for its point cache, so the
 *  codebase has one answer to "how precise is a stored coordinate".
 *
 *  This is not cosmetic. Full float precision costs ~9 extra characters per
 *  number, and a hull has ~11 points; over a thousand turfs that alone is
 *  hundreds of kilobytes of payload a volunteer downloads on cell data. */
const COORD_DP = 5;
const round = (n: number) => Number(n.toFixed(COORD_DP));
const roundPoint = (p: LatLng): LatLng => ({ lat: round(p.lat), lng: round(p.lng) });

function buildTurf(seed: TurfSeed, viewer: { isAdmin: boolean }): DemoTurf {
	const doors = scatterDoors(seed);
	const cleaned = dropOutliers(doors);
	const hull = convexHull(cleaned);
	const centre = centroid(cleaned) ?? seed.centre;
	const bounds = boundingBox(cleaned.length > 0 ? cleaned : [seed.centre]) ?? {
		minLat: seed.centre.lat,
		maxLat: seed.centre.lat,
		minLng: seed.centre.lng,
		maxLng: seed.centre.lng,
	};

	// Redaction happens HERE, before the row is ever returned, so a non-admin
	// payload cannot contain a holder's name even by accident. Hiding it in the
	// template would still ship it in the SSR payload.
	const visible = visibleTurfState(
		{ status: seed.status, heldBy: seed.heldBy, expiresInHours: seed.expiresInHours },
		viewer,
	);

	// Claimability comes from the REAL rule, not an approximation of it.
	//
	// The demo has no ledger, so the inputs are synthesised — but the decision
	// and, more importantly, the refusal wording are canClaim's own. Every
	// previous attempt to restate the rules here has drifted from them: the
	// fixture handed out list numbers the real page withholds, and offered to
	// check out turf with no doors left. Calling the function removes the
	// opportunity.
	const decision = canClaim(
		{
			mapRouteId: seed.mapRouteId,
			printedListNumber: seed.printedListNumber,
			retiredAt: null,
			vanDistributedTo: seed.status === 'assigned-in-van' ? (seed.heldBy ?? 'A canvasser') : null,
			doorCount: seed.doorsRemaining,
		},
		demoClaims(seed),
		DEMO_VIEWER_ID,
		DEMO_NOW,
	);

	return {
		mapRouteId: seed.mapRouteId,
		chapterId: seed.chapterId,
		name: seed.name,
		regionName: seed.regionName,
		// Withheld unless you hold it, exactly as toTurfView does — the number
		// is the credential that pulls the doors down in MiniVAN. A fixture
		// that handed it out freely would be previewing a page we do not ship.
		printedListNumber: visible.status === 'held-by-you' ? seed.printedListNumber : null,
		// VAN reports routeSize (people) above doorCount (households).
		routeSize: Math.round(seed.doors * 1.7),
		doorsRemaining: seed.doorsRemaining,
		hull: hull.map(roundPoint),
		centre: roundPoint(centre),
		bounds: {
			minLat: round(bounds.minLat),
			maxLat: round(bounds.maxLat),
			minLng: round(bounds.minLng),
			maxLng: round(bounds.maxLng),
		},
		status: visible.status,
		heldBy: visible.heldBy,
		expiresInHours: visible.expiresInHours,
		refreshedMinutesAgo: seed.refreshedMinutesAgo,
		claimable: decision.ok,
		// Omitted, never null, and only when the turf looks available —
		// matching toTurfView exactly, so the demo's measured payload size
		// stays representative of the real one.
		...(decision.ok || visible.status !== 'available'
			? {}
			: { claimBlockedReason: decision.message }),
		...(seed.updating ? { updating: true as const } : {}),
	};
}

/**
 * Turfs for ONE chapter. There is deliberately no "all chapters" call.
 *
 * Turf data is scoped to the chapter the volunteer says they're canvassing in,
 * so no single page load hands anyone the campaign's whole field picture. Note
 * what this is and isn't: the chapter is the volunteer's own free choice (it
 * can't be derived from their Solidarity home chapter, because volunteers
 * regularly canvass outside it), so anyone patient can switch chapters and
 * page through everything. This is compartmentalisation — it raises effort and
 * leaves an audit trail — not access control. See the plan's §3 for the
 * controls that make it mean something.
 */
export function demoTurfs(chapterId: number, viewer: { isAdmin: boolean }): DemoTurf[] {
	const seeds =
		chapterId === STRESS_CHAPTER_ID
			? stressSeeds()
			: SEEDS.filter((seed) => seed.chapterId === chapterId);
	return seeds.map((seed) => buildTurf(seed, viewer));
}

/**
 * 1,000 turfs laid out across a county-sized area.
 *
 * Arranged as a grid of wards with a few streets each, rather than uniform
 * scatter, because real turf clusters in built-up areas with empty stretches
 * between — and clustering is what makes the zoomed-out view hard to render.
 * Doors per turf are kept low (the hull only needs enough points to have a
 * shape) so the fixture stays honest about geometry without generating 90,000
 * points to build one page.
 */
function stressSeeds(): TurfSeed[] {
	const rand = seededRandom(4242);
	const seeds: TurfSeed[] = [];

	// ~90 miles east-west, ~55 north-south, anchored west of Boston.
	const originLat = 42.05;
	const originLng = -72.3;
	const cols = 40;
	const rows = 25;

	for (let i = 0; i < STRESS_TURF_COUNT; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		if (row >= rows) break;

		// Jitter each turf inside its grid cell so the layout doesn't read as
		// graph paper, and skew density toward the middle of the county.
		const cellLng = 1.3 / cols;
		const cellLat = 0.8 / rows;
		const centreLat = originLat + row * cellLat + (rand() - 0.4) * cellLat * 0.7;
		const centreLng = originLng + col * cellLng + (rand() - 0.4) * cellLng * 0.7;

		const doors = 40 + Math.floor(rand() * 60);
		const walked = rand();

		// Status first, then the fields that only exist BECAUSE of it. Setting
		// heldBy unconditionally is how an "available" turf ends up rendering
		// "held by …" in the organizer view.
		const roll = rand();
		const status: TurfStatus =
			roll < 0.18 ? 'held-by-other' : roll < 0.24 ? 'assigned-in-van' : 'available';
		const held = status === 'held-by-other' || status === 'assigned-in-van';

		seeds.push({
			mapRouteId: 900_000 + i,
			chapterId: STRESS_CHAPTER_ID,
			name: `Ward ${row + 1} Turf ${String(col + 1).padStart(2, '0')}`,
			regionName: `Ward ${row + 1}`,
			printedListNumber: `9${String(100_000 + i)}-${String(10_000 + Math.floor(rand() * 89_999))}`,
			savedListId: 900_000 + i,
			centre: { lat: centreLat, lng: centreLng },
			spread: 0.004 + rand() * 0.004,
			aspect: 0.7 + rand() * 1.1,
			doors,
			// A realistic mix: most untouched, some part-walked, a few nearly
			// done, and roughly one in twenty walked out completely. That last
			// group is what puts the "no doors left" state on the stress map at
			// a density worth looking at.
			doorsRemaining:
				walked > 0.95 ? 0 : walked < 0.6 ? doors : Math.max(1, Math.floor(doors * rand())),
			status,
			heldBy: held ? 'A volunteer' : null,
			// Only app claims carry a TTL; turf assigned inside VAN has none.
			expiresInHours: status === 'held-by-other' ? 12 + Math.floor(rand() * 36) : null,
			refreshedMinutesAgo: 30,
			seed: 50_000 + i,
		});
	}
	return seeds;
}

/** Where the demo pretends the volunteer is standing while canvassing each
 *  chapter, for distance sorting when the Geolocation API is declined. Anchored
 *  inside the chapter rather than at a fixed home address — the whole point is
 *  that a volunteer travels to the turf they picked. */
export const DEMO_LOCATIONS: Record<number, LatLng> = {
	71: { lat: 42.3654, lng: -71.1037 }, // Central Square, Cambridge
	72: { lat: 42.3398, lng: -71.0762 }, // South End, Boston
	73: { lat: 42.2529, lng: -71.0041 }, // Quincy Center
	[STRESS_CHAPTER_ID]: { lat: 42.45, lng: -71.65 }, // middle of the stress county
};
