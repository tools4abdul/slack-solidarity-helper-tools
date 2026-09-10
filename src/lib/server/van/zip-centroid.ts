// ZIP → centroid, for volunteers who decline or cannot use geolocation.
//
// Shaped deliberately like mobilize-migrator/lib/geocode.ts, including the
// contract that matters most: **this never throws.** A geocoder outage, a
// typo, a point in open water — all of them return null, and the caller shows
// an unsorted list instead of an error page. Distance sorting is a
// convenience; losing it must never cost someone the turf list.
//
// The Census Bureau is used for the same reasons the migrator uses it: free,
// keyless, no account, and no terms that forbid this. Answers are cached in
// van_zip_centroids because a ZIP's location does not change and a canvass
// launch will hit the same dozen ZIPs all morning.
//
// Two Census services, because one cannot do both jobs. A full street address —
// what the /turfs Slack command offers ("/turfs 123 Main St, Cambridge MA") —
// goes to the geocoder at ENDPOINT. A bare ZIP goes to the ZCTA layer at
// ZCTA_ENDPOINT, because the geocoder has no ZIP-centroid mode and returns no
// matches for one; see the note there.
//
// The street address is the most sensitive string this feature handles, so two
// rules apply to it and are enforced below rather than left to callers:
//
//   1. It is NEVER persisted. Only the ZIP the geocoder reports back is written
//      to van_zip_centroids — a ZIP centroid is not personal data, and caching
//      it means an address lookup warms the same cache a ZIP lookup reads.
//   2. It is NEVER logged. The ZIP path logs the ZIP it failed on, which is fine;
//      the address path logs a redacted marker instead, because a warn line
//      carrying someone's home address outlives the request by however long the
//      log aggregator keeps it.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanZipCentroids } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/**
 * ZCTA polygons, which is where a bare ZIP is answered.
 *
 * A separate service from ENDPOINT, and it has to be. The geocoder above
 * resolves *street addresses* and has no ZIP-centroid mode at all: asked for
 * `48104` it returns `addressMatches: []`, and its structured form rejects a
 * ZIP-only query outright with "Specify House number and Street name". This
 * module used to send bare ZIPs there, so `/turfs 48104` could only ever work
 * for a ZIP some earlier volunteer had already warmed the cache with by typing a
 * full street address inside it.
 *
 * TIGERweb serves the ZIP Code Tabulation Areas themselves, so a ZIP is a
 * lookup rather than a geocode. Same agency, no key, no account — the properties
 * that made the Census geocoder the right choice in the first place.
 *
 * Layer 2 is "2020 Census ZIP Code Tabulation Areas" in tigerWMS_Current. The id
 * is positional and Census could renumber it in a future vintage; that failure
 * is a lookup returning nothing, which the never-throw contract already turns
 * into an unsorted list rather than an error.
 */
const ZCTA_ENDPOINT =
	'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query';

// The geocoder is occasionally slow. A volunteer standing on a street corner
// will not wait, and neither should the request.
const TIMEOUT_MS = 4000;

export interface LatLng {
	lat: number;
	lng: number;
}

/** Five digits, or null. Rejects ZIP+4, letters, and the empty string rather
 *  than passing them to the geocoder to be rejected more slowly. */
export function normalizeZip(raw: string | null | undefined): string | null {
	const trimmed = (raw ?? '').trim();
	const match = /^(\d{5})(?:-\d{4})?$/.exec(trimmed);
	return match ? match[1]! : null;
}

/**
 * Ask the Census where a ZIP is. Never throws.
 *
 * Answers from the ZCTA layer rather than the address geocoder — see
 * ZCTA_ENDPOINT for why the geocoder cannot do this.
 *
 * The point returned is INTPTLAT/INTPTLON, the ZCTA's *internal* point, not
 * CENTLAT/CENTLON. Census guarantees the internal point falls inside the area;
 * a centroid is the average of the shape and lands outside it for a ZIP that
 * wraps a bay or a mountain. Since this point is what the turf list sorts by,
 * "somewhere in that ZIP" beats "the mean of its outline" every time.
 */
export async function geocodeZip(
	rawZip: string,
	fetchFn: typeof fetch = fetch,
): Promise<LatLng | null> {
	// Re-normalized rather than trusted, even though every caller in this module
	// already did it: the ZIP is interpolated into a `where` clause below, and a
	// function that guarantees five digits at its own boundary cannot be made to
	// carry a quote into one by a future caller.
	const zip = normalizeZip(rawZip);
	if (!zip) return null;

	const url = new URL(ZCTA_ENDPOINT);
	url.searchParams.set('where', `ZCTA5='${zip}'`);
	url.searchParams.set('outFields', 'INTPTLAT,INTPTLON');
	url.searchParams.set('returnGeometry', 'false');
	url.searchParams.set('f', 'json');

	try {
		const res = await fetchFn(url.toString(), {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn(`[van] zip lookup for ${zip} returned ${res.status}`);
			return null;
		}
		const body = (await res.json()) as {
			error?: { message?: unknown };
			features?: Array<{ attributes?: { INTPTLAT?: unknown; INTPTLON?: unknown } }>;
		};
		// ArcGIS reports its own errors with HTTP 200 and an `error` envelope, so a
		// status check alone would read a rejected query as "no such ZIP" and cache
		// nothing while looking like a clean miss.
		if (body?.error) {
			console.warn(`[van] zip lookup for ${zip} was rejected by TIGERweb`);
			return null;
		}
		const attrs = body?.features?.[0]?.attributes;
		// Signed and zero-padded in the source ("+42.2620394", "-083.7166908").
		// Number() handles both, which is why these are not parsed by hand.
		const lat = Number(attrs?.INTPTLAT);
		const lng = Number(attrs?.INTPTLON);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		// Null island means the answer carried no usable point.
		if (lat === 0 && lng === 0) return null;
		return { lat, lng };
	} catch (err) {
		// Includes the timeout. Deliberately swallowed: see the header.
		console.warn(`[van] zip lookup for ${zip} failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

/**
 * Where a ZIP is, from cache when we have it and from the geocoder otherwise.
 *
 * A cache write failure is swallowed too — having the answer and failing to
 * store it is strictly better than failing the lookup, and the next request
 * simply asks again.
 */
export async function lookupZipCentroid(
	db: Db,
	rawZip: string | null | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<LatLng | null> {
	const zip = normalizeZip(rawZip);
	if (!zip) return null;

	try {
		const [cached] = await db.select().from(vanZipCentroids).where(eq(vanZipCentroids.zip, zip));
		if (cached) return { lat: cached.lat, lng: cached.lng };
	} catch (err) {
		// A cache read failure must not stop the lookup either.
		console.warn('[van] zip cache read failed:', err instanceof Error ? err.message : err);
	}

	const point = await geocodeZip(zip, fetchFn);
	if (!point) return null;

	await cacheCentroid(db, zip, point);
	return point;
}

/** Write a ZIP's centroid to the cache. Shared by the ZIP and address paths so
 *  there is one place that decides what gets stored — which is what keeps a
 *  street address from ever reaching a column. Never throws: having the answer
 *  and failing to store it is strictly better than failing the lookup. */
async function cacheCentroid(db: Db, zip: string, point: LatLng): Promise<void> {
	const fetchedAt = new Date().toISOString();
	try {
		await db
			.insert(vanZipCentroids)
			.values({ zip, lat: point.lat, lng: point.lng, fetchedAt })
			.onConflictDoUpdate({
				target: vanZipCentroids.zip,
				set: { lat: point.lat, lng: point.lng, fetchedAt },
			});
	} catch (err) {
		console.warn('[van] zip cache write failed:', err instanceof Error ? err.message : err);
	}
}

/**
 * Where a free-text address is, plus the ZIP the geocoder matched it to.
 *
 * The ZIP is the interesting half for everything except distance sorting: it is
 * what gets cached, and it is what resolves the volunteer's chapter. It can
 * legitimately come back null — the geocoder matches some addresses without a
 * usable ZIP component — and the caller has to cope rather than treat it as a
 * failure, because the coordinates are still good.
 *
 * Never throws, per the module header.
 */
export async function geocodeAddress(
	query: string,
	fetchFn: typeof fetch = fetch,
): Promise<{ point: LatLng; zip: string | null } | null> {
	const address = query.trim();
	if (address === '') return null;

	const url = new URL(ENDPOINT);
	url.searchParams.set('address', address);
	url.searchParams.set('benchmark', 'Public_AR_Current');
	url.searchParams.set('format', 'json');

	try {
		const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			// No address in the message — see rule 2 in the header.
			console.warn(`[van] address geocode returned ${res.status}`);
			return null;
		}
		const body = (await res.json()) as {
			result?: {
				addressMatches?: Array<{
					coordinates?: { x?: unknown; y?: unknown };
					addressComponents?: { zip?: unknown };
				}>;
			};
		};
		const match = body?.result?.addressMatches?.[0];
		const lng = Number(match?.coordinates?.x);
		const lat = Number(match?.coordinates?.y);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		// Null island means the geocoder answered with nothing useful.
		if (lat === 0 && lng === 0) return null;
		return { point: { lat, lng }, zip: normalizeZip(String(match?.addressComponents?.zip ?? '')) };
	} catch (err) {
		// The timeout lands here. Swallowed, and the error is not logged with it:
		// an AbortError carries no address, but a URL-bearing fetch error would.
		console.warn('[van] address geocode failed:', err instanceof Error ? err.name : 'unknown');
		return null;
	}
}

/**
 * Where the volunteer says they are, from either a ZIP or a street address.
 *
 * One entry point rather than two, so the caller never has to decide which kind
 * of input it holds — and so the caching rule (ZIP only, never the address) is
 * applied in exactly one place.
 *
 * Never throws.
 */
export async function resolveLocation(
	db: Db,
	raw: string | null | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<{ point: LatLng; zip: string | null } | null> {
	const trimmed = (raw ?? '').trim();
	if (trimmed === '') return null;

	// A bare ZIP takes the cached path, which is the common case on a canvass
	// morning and costs no network call at all after the first volunteer.
	const zip = normalizeZip(trimmed);
	if (zip) {
		const point = await lookupZipCentroid(db, zip, fetchFn);
		return point ? { point, zip } : null;
	}

	const match = await geocodeAddress(trimmed, fetchFn);
	if (!match) return null;

	// Cache under the matched ZIP, so the street address leaves no trace but the
	// next person who types that ZIP gets a free answer.
	if (match.zip) await cacheCentroid(db, match.zip, match.point);
	return match;
}
