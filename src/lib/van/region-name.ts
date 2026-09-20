// Reading geography out of a VAN map region's name.
//
// VAN exposes no boundary for a region (plan.md §2 Constraint A) and no county
// field, so the name is the only geography the catalog gets without running an
// export job per turf. Names are cut by organizers to a convention:
//
//   R04C_County_PlaceCity003_9.11        group code, county, place, date
//   R09A_County_PlaceCityWd06Pct151_8_7  … with a dotless date
//   R08A.County.PlaceCity.Wd3.046_9.11   … dots instead of underscores
//   R07B_CountyPlaceCity002_814          … county and place run together
//   R03A_CountyTwp003_911                … county doubles as the place
//
// It is a convention, not a contract: nobody validates these on the VAN side,
// and a renamed region changes what this can read. So everything degrades to
// null rather than guessing, and "unplaced" for a handful of regions is the
// intended failure — not a wrong county on a map.
//
// **No geography lives here.** The caller passes a lookup
// ($lib/server/geo/counties.ts), which is what keeps this repo free of any one
// campaign's state: the same parser reads a name from any state, and the
// 130 KB county table stays on the server.

/** What `parseRegionName` needs of a county lookup — structurally satisfied by
 *  `CountyIndex`, and trivially faked in a test. */
export interface CountyLookup {
	resolve(segment: string): { state: string; shortName: string; centre: LatLng } | null;
}

import type { LatLng } from './geometry.js';

export interface ParsedRegionName {
	/** The code a region is cut under, e.g. `R04C`. Null when the first segment
	 *  is not one. */
	regionCode: string | null;
	/** `R04C` → `R04`, the grouping the folders are named for. */
	regionGroup: string | null;
	/** County, spelled as the Census spells it (no type suffix). */
	county: string | null;
	/** USPS state code of that county. */
	state: string | null;
	/** Centroid of the county. Null exactly when `county` is. */
	centre: LatLng | null;
	/** The place segment as VAN wrote it, e.g. `PlaceCity003`. Kept raw: it
	 *  is for a human reading a table, not for matching. */
	place: string | null;
}

const EMPTY: ParsedRegionName = {
	regionCode: null,
	regionGroup: null,
	county: null,
	state: null,
	centre: null,
	place: null,
};

/** A leading grouping code: a letter or two, digits, an optional sub-letter —
 *  `R04C`, `R1`, `HD12A`. Loose on purpose; conventions differ per campaign,
 *  and a first segment this does not recognise is simply treated as content. */
const REGION_CODE = /^[A-Z]{1,3}\d{1,3}[A-Z]?$/i;

/** Split on both separators, because organizers use both — sometimes in one
 *  name. */
function segmentsOf(name: string): string[] {
	return name
		.split(/[._]+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Parse one region name against a county lookup. Never throws, and each field
 * is independently nullable: a name whose code is unrecognised can still name
 * its county, and vice versa.
 */
export function parseRegionName(
	name: string | null | undefined,
	counties: CountyLookup,
): ParsedRegionName {
	if (!name) return EMPTY;
	const parts = segmentsOf(name);
	if (parts.length === 0) return EMPTY;

	const code = REGION_CODE.test(parts[0]!) ? parts[0]!.toUpperCase() : null;
	const group = code ? (code.match(/^[A-Z]{1,3}\d{1,3}/i)?.[0].toUpperCase() ?? null) : null;

	// The county is normally the segment after the code, but conventions vary,
	// so every segment is tried in order and the first that names a county wins.
	// A date segment or a precinct number resolves to nothing, which is what
	// makes scanning safe.
	const start = code ? 1 : 0;
	for (let i = start; i < parts.length; i++) {
		const segment = parts[i]!;
		const match = counties.resolve(segment);
		if (!match) continue;
		// When county and place are written as one segment, the remainder after
		// the county is the place; otherwise the next segment is.
		const remainder = segment.slice(match.shortName.replace(/[^A-Za-z0-9]/g, '').length);
		return {
			regionCode: code,
			regionGroup: group,
			county: match.shortName,
			state: match.state,
			centre: match.centre,
			place: remainder || parts[i + 1] || null,
		};
	}

	return {
		...EMPTY,
		regionCode: code,
		regionGroup: group,
		place: parts[start + 1] ?? parts[start] ?? null,
	};
}

/** The segments a name offers as candidate county names, for the state
 *  inference in `inferCountyIndex` — the same scan `parseRegionName` does,
 *  without needing a lookup to do it. */
export function countyCandidates(name: string | null | undefined): string[] {
	if (!name) return [];
	const parts = segmentsOf(name);
	if (parts.length === 0) return [];
	return REGION_CODE.test(parts[0]!) ? parts.slice(1) : parts;
}
