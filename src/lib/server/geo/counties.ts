// US county centroids, and the lookup that turns a name in a VAN region into a
// point on a map.
//
// Nothing here knows which state the campaign is in. That is the whole point:
// the turf folder map needs to place a region named `R04C_County_Place003` without
// this repo being tied to one state's campaign. Two ways the state gets
// decided, in order:
//
//   1. `CAMPAIGN_STATES` — a comma-separated list of USPS codes, when a
//      deployment wants to be explicit (or spans several states).
//   2. Inference from the data. County names are unique WITHIN a state but not
//      across states — there are 31 Washington Counties — so with no setting we
//      resolve the unambiguous names first, see which state they land in, and
//      read the ambiguous ones in that state. A campaign whose turf is in one
//      state therefore needs no configuration at all, and one that spans two
//      still resolves every name either side can claim outright.
//
// Data: U.S. Census Bureau 2023 Gazetteer county file (INTPTLAT/INTPTLONG),
// public domain, all 3,222 counties and county equivalents. 130 KB, imported
// SERVER-SIDE ONLY — the browser gets the handful of points a page resolved,
// never the table.

import rows from './us-counties.json';
import type { LatLng } from '../../van/geometry.js';

export interface CountyEntry {
	/** USPS state code, two letters. */
	state: string;
	/** Census spelling, e.g. `St. Clair County`, `Orleans Parish`. */
	name: string;
	/** The name without its type suffix, as VAN region names spell it. */
	shortName: string;
	centre: LatLng;
}

/** Census county-equivalent suffixes. Stripped so `St. Clair County` and a
 *  region's `StClair` are the same thing — and kept off the ambiguity check,
 *  since a state never has both a Foo County and a Foo Parish. */
const SUFFIX =
	/\s+(county|parish|borough|census area|municipality|city and borough|city|district|island|islands|municipio)$/i;

/** Lowercase alphanumerics only: `St. Clair`, `StClair` and `ST_CLAIR` all
 *  normalise to `stclair`. */
export function normaliseCountyName(value: string): string {
	return value
		.replace(SUFFIX, '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

const ALL: CountyEntry[] = (rows as Array<[string, string, number, number]>).map(
	([state, name, lat, lng]) => ({
		state,
		name,
		shortName: name.replace(SUFFIX, ''),
		centre: { lat, lng },
	}),
);

/** What a name lookup can answer with. */
export interface CountyIndex {
	/** The counties this index covers — the bounds of the map, when a page has
	 *  no points of its own yet. */
	entries: CountyEntry[];
	/** States the index is scoped to, in the order they were resolved. */
	states: string[];
	/** Resolve a name segment, whole or as a prefix (`OaklandBerkleyCity` →
	 *  Oakland). Null when nothing matches, or when the name belongs to several
	 *  states in scope and nothing decides between them — a wrong county on a
	 *  map is worse than an unplaced region. */
	resolve(segment: string): CountyEntry | null;
}

function buildIndex(entries: CountyEntry[], states: string[]): CountyIndex {
	const byKey = new Map<string, CountyEntry[]>();
	for (const entry of entries) {
		const key = normaliseCountyName(entry.name);
		const list = byKey.get(key);
		if (list) list.push(entry);
		else byKey.set(key, [entry]);
	}
	// Longest first so `Grand Traverse` is tried before `Grand`, and a
	// run-together `OaklandBerkleyCity` resolves to the longest county that
	// starts it.
	const keysByLength = [...byKey.keys()].sort((a, b) => b.length - a.length);

	function lookup(key: string): CountyEntry | null {
		if (!key) return null;
		const exact = byKey.get(key);
		if (exact) return exact.length === 1 ? exact[0]! : null;
		for (const candidate of keysByLength) {
			if (key.startsWith(candidate)) {
				const matches = byKey.get(candidate)!;
				return matches.length === 1 ? matches[0]! : null;
			}
		}
		return null;
	}

	return {
		entries,
		states,
		resolve: (segment) => lookup(normaliseCountyName(segment)),
	};
}

/** An index over the given states, or over every state when `states` is empty. */
export function countyIndexFor(states: readonly string[]): CountyIndex {
	const wanted = new Set(states.map((s) => s.trim().toUpperCase()).filter(Boolean));
	if (wanted.size === 0) return buildIndex(ALL, [...new Set(ALL.map((e) => e.state))]);
	const entries = ALL.filter((e) => wanted.has(e.state));
	return buildIndex(entries, [...wanted]);
}

/**
 * Work out which states a set of names is talking about, then index those.
 *
 * `segments` are the raw candidate strings — the county-ish part of each region
 * name. Names that match exactly one state in the whole country are the votes;
 * anything a single state cannot claim outright is ignored for the vote and
 * then resolved inside the winning states.
 *
 * `maxStates` bounds how many states a campaign is assumed to span, so one
 * mistyped region cannot drag a whole second state's counties into scope.
 */
export function inferCountyIndex(segments: readonly string[], maxStates = 2): CountyIndex {
	const national = buildIndex(ALL, []);
	const votes = new Map<string, number>();
	for (const segment of segments) {
		const entry = national.resolve(segment);
		if (entry) votes.set(entry.state, (votes.get(entry.state) ?? 0) + 1);
	}
	if (votes.size === 0) return countyIndexFor([]);

	const ranked = [...votes].sort((a, b) => b[1] - a[1]);
	const top = ranked[0]![1];
	// A state only joins the scope if it is carrying real weight — a tenth of
	// the leader's regions — so a single odd name does not widen the search.
	const states = ranked
		.filter(([, count]) => count * 10 >= top)
		.slice(0, maxStates)
		.map(([state]) => state);
	return countyIndexFor(states);
}

/** The states named in `CAMPAIGN_STATES`, if any. Parsed here so the page and
 *  its tests agree on the format. */
export function parseCampaignStates(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim().toUpperCase())
		.filter((s) => /^[A-Z]{2}$/.test(s));
}
