import { describe, it, expect } from 'vitest';
import { countyCandidates, parseRegionName, type CountyLookup } from './region-name.js';
import { countyIndexFor } from '../server/geo/counties.js';

// The MI names are real ones, from the 276 regions the live key returned on
// 2026-09-19 — the shapes organizers actually cut. The GA case is here to keep
// the parser honest: nothing in it may know which state a campaign is in, so
// the same code has to read a name from a different one.
const MI = countyIndexFor(['MI']);
const GA = countyIndexFor(['GA']);

/** A lookup with nothing in it — the "county table unavailable" path. */
const NONE: CountyLookup = { resolve: () => null };

describe('parseRegionName', () => {
	it('reads the usual code_county_place_date form', () => {
		expect(parseRegionName('R04C_Livingston_BrightonCity003_9.11', MI)).toMatchObject({
			regionCode: 'R04C',
			regionGroup: 'R04',
			county: 'Livingston',
			state: 'MI',
			place: 'BrightonCity003',
		});
	});

	it('places the county at its Census centroid', () => {
		const { centre } = parseRegionName('R02A_Kent_GrandRapidsCityWd01Pct017_9.11', MI);
		expect(centre?.lat).toBeCloseTo(43.03, 1);
		expect(centre?.lng).toBeCloseTo(-85.55, 1);
	});

	it('reads names separated by dots', () => {
		expect(parseRegionName('R08A.Macomb.WarrenCity.Wd3.046_9.11', MI)).toMatchObject({
			regionCode: 'R08A',
			county: 'Macomb',
			place: 'WarrenCity',
		});
	});

	it.each([
		['R01C_GrandTraverse_TraverseCity008_9.11', 'Grand Traverse'],
		['R03G_StJoseph_Mendon_Township_001.', 'St. Joseph'],
		['R03G_VanBuren_AntwerpTwp002_918', 'Van Buren'],
		['R08F.StClair.PortHuronCity.002_9.13', 'St. Clair'],
	])('resolves the multi-word county in %s', (name, county) => {
		expect(parseRegionName(name, MI).county).toBe(county);
	});

	it('splits a county and place written as one segment', () => {
		expect(parseRegionName('R07B_OaklandBerkleyCity002_814', MI)).toMatchObject({
			county: 'Oakland',
			place: 'BerkleyCity002',
		});
		expect(parseRegionName('R03A_KalamazooTwp003_911', MI)).toMatchObject({
			county: 'Kalamazoo',
			place: 'Twp003',
		});
	});

	it('reads another state’s names with that state’s lookup', () => {
		// Same parser, a different state. DeKalb and Chatham are GA counties;
		// against the MI lookup they resolve to nothing.
		expect(parseRegionName('R02B_DeKalb_DecaturCity004_9.11', GA)).toMatchObject({
			county: 'DeKalb',
			state: 'GA',
			place: 'DecaturCity004',
		});
		expect(parseRegionName('GA05_Chatham_SavannahPct012', GA).county).toBe('Chatham');
		expect(parseRegionName('R02B_DeKalb_DecaturCity004_9.11', MI).county).toBeNull();
	});

	it('finds the county wherever the convention puts it', () => {
		// No code at all, and the county in the first segment.
		expect(parseRegionName('Washtenaw_AnnArborCityWd05Pct048', MI)).toMatchObject({
			regionCode: null,
			county: 'Washtenaw',
		});
		// A code this parser does not recognise, county later in the name.
		expect(parseRegionName('turfcut-2026_Ingham_LansingCity001', MI).county).toBe('Ingham');
	});

	it('keeps the code when no segment names a county', () => {
		expect(parseRegionName('R05B_Somewhere_Else', MI)).toMatchObject({
			regionCode: 'R05B',
			county: null,
			state: null,
			centre: null,
		});
	});

	it('returns nulls rather than throwing on junk, or with no county table', () => {
		for (const name of ['', '   ', '___', null, undefined]) {
			expect(parseRegionName(name, MI)).toMatchObject({ county: null, centre: null });
		}
		expect(parseRegionName('R04C_Livingston_BrightonCity003', NONE).county).toBeNull();
	});
});

describe('countyCandidates', () => {
	it('offers every segment after the code, for state inference', () => {
		expect(countyCandidates('R04C_Livingston_BrightonCity003_9.11')).toEqual([
			'Livingston',
			'BrightonCity003',
			'9',
			'11',
		]);
	});

	it('offers every segment when there is no code', () => {
		expect(countyCandidates('Washtenaw_AnnArbor')).toEqual(['Washtenaw', 'AnnArbor']);
	});

	it('is empty for an empty name', () => {
		expect(countyCandidates(null)).toEqual([]);
	});
});
