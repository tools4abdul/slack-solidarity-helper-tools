// Reduce an export-job CSV to a hull, keeping nothing else.
//
// This is the file the security posture in specs/010-van-turf-checkout/plan.md
// §3 actually rests on, so the guarantee is enforced here in code rather than
// promised in a comment: the row parser is given the two coordinate column
// indices and DISCARDS every other field as it passes over it. A name or a
// street address exists only inside `field` for the few microseconds between
// two delimiters, is never pushed into the row, never returned, never logged.
//
// Plan Story 3.3 specifies a different check — "assert the header contains
// only the three requested columns and abort loudly if it contains anything
// else". That assertion cannot hold against the real API and would abort every
// run. Verified live: export job type 5 (VoterCircle) is the ONLY type whose
// output carries VAddressLatitude/VAddressLongitude, and it returns 43 columns
// including FirstName, LastName, Address, DOB, Party, CellPhone and Email.
// VAN's POST /exportJobs has no field-selection parameter for the base column
// set — the type defines it — so a narrow export is not orderable. (Type 4,
// SavedListExport, is narrow at CanvassFileRequestID,VanID but has no
// coordinates at all, so it cannot do this job.)
//
// The intent behind 3.3 survives, inverted: instead of asserting the file is
// narrow, we assert the columns we want are present and make it structurally
// impossible to read another. `FORBIDDEN_COLUMNS` below names what must never
// be admitted, and the tests assert it against the real 43-column header.
//
// Memory: coordinates accumulate, rows do not. `dropOutliers` is a two-pass
// statistic (it needs the centroid and sigma over every point before it can
// reject any), so a single-pass hull accumulator cannot also reject outliers,
// and a hull dragged across the county by one bad geocode is the failure this
// is here to prevent. Peak cost is 16 bytes per door — a 2,000-door export
// holds ~32 KB of numbers, against the couple of hundred KB the raw CSV would
// have cost. Nothing per-row is retained.

import {
	boundingBox,
	centroid,
	convexHull,
	dropOutliers,
	haversineMeters,
	type LatLng,
} from '../../van/geometry.js';
import type { AddressLookup } from './geocode-batch.js';

/** VAN's column names for address coordinates, exactly as they appear in the
 *  type-5 header. Matched case-insensitively — VAN's casing has drifted
 *  between endpoints before. */
export const LAT_COLUMN = 'VAddressLatitude';
export const LNG_COLUMN = 'VAddressLongitude';

/** Address components, read ONLY for rows VAN never geocoded and ONLY when a
 *  geocoder is supplied. `Address` is the full one-line form
 *  ("4190 S Kirkman Rd Apt 912 , Orlando, FL 32811"), so the street is
 *  everything before its first comma — StreetNo/StreetName are also present
 *  but lose the directional and the street type ("4190 Kirkman"), which costs
 *  matches.
 *
 *  This is the complete list of extra columns the mask ever admits. Adding to
 *  it widens what can be transmitted to a third party, so it is a privacy
 *  decision rather than a refactor — see the header of geocode-batch.ts. */
export const ADDRESS_COLUMNS = ['Address', 'City', 'State', 'ZipCode'] as const;

/** Identity columns that must NEVER be read, whatever else changes here.
 *  Asserted in the tests against the real 43-column header, so widening the
 *  mask to include one of these fails the build rather than quietly shipping. */
export const FORBIDDEN_COLUMNS = [
	'FirstName',
	'LastName',
	'DOB',
	'Email',
	'CellPhone',
	'HomePhone',
	'WorkPhone',
	'Phone',
	'Party',
	'Sex',
	'VanID',
	'VoterVANID',
	'StateFileID',
	'MyCampaignID',
] as const;

/** Stored hull coordinates are rounded to 5 decimal places — about a metre,
 *  far finer than a hull is accurate to, and worth ~280 KB across a
 *  1,000-turf chapter (plan.md Story 6.2b). */
const HULL_PRECISION = 5;

/**
 * Diagonal beyond which a hull is FLAGGED as implausible, in metres.
 *
 * A turf is something one person walks in an evening — hundreds of metres, a
 * couple of kilometres at the rural end. 10 km is far past any of that, so a
 * hull this wide is not a turf boundary that came out slightly wrong; it is a
 * saved list whose addresses are not geographically coherent.
 *
 * This is not hypothetical. Both demo saved lists span ~58 km once geocoded,
 * with one "Orlando" turf centred 150 km away near Gainesville. Measured, the
 * points are a uniform scatter rather than a cluster with outliers: Turf 01 has
 * 0% of its doors within 500 m of the centroid and 8% within 5 km, median
 * 10.5 km. `dropOutliers` cannot help — there is no outlier to find — and
 * neither would any clustering, because there is no core to keep.
 *
 * This flag therefore does NOT discard the hull. It cannot distinguish "the
 * shape is wrong" from "the turf really is enormous", and blanking the geometry
 * left an operator with a pin and no way to see why. The shape is stored, and
 * the flag rides along so the sync can say the turf looks implausible and any
 * future UI can caveat it. plan.md §2 Constraint A already establishes that a
 * hull is decoration for browsing and MiniVAN is authoritative for which doors
 * are in the list; this is the case where that caveat matters most.
 */
export const MAX_HULL_EXTENT_M = 10_000;

/**
 * Below this many surviving coordinates, a wide span is not evidence about the
 * saved list at all.
 *
 * The span check answers "is this really a cut map region?" by asking whether
 * the addresses could be walked. That inference needs enough points to be worth
 * anything, and it silently didn't have them. Measured against the VAN demo
 * database: a freshly cut 6-person map region geocoded to 6 points spread
 * evenly over ~10 km — no outlier to reject, `outliersDropped: 0` — and the
 * check reported the saved list was "probably not a cut map region". It was
 * exactly the cut map region; the region is simply sparsely populated, so the
 * hull of everyone in it is far wider than the boundary an organizer drew.
 *
 * A real precinct turf carries 200-400 doors packed along a few streets, where
 * a 10 km span genuinely does mean the list is mis-scoped. So the threshold
 * separates the two readings rather than trying to make one message cover both:
 * above it the verdict stands, below it we say we cannot tell. Deliberately
 * generous — the cost of hedging on a turf that really is mis-scoped is a
 * vaguer warning, while the cost of the old wording was sending someone to
 * re-cut turf that was already correct.
 */
export const MIN_POINTS_FOR_SPAN_VERDICT = 25;

function round5(value: number): number {
	return Number(value.toFixed(HULL_PRECISION));
}

export interface HullExtractResult {
	/** Hull vertices, rounded, or [] when the points were degenerate
	 *  (fewer than three, or all collinear). The caller stores a centroid and
	 *  the UI draws a pin. */
	hull: LatLng[];
	/** Mean of the surviving coordinates. Null only when nothing parsed. */
	centre: LatLng | null;
	/** Coordinates that survived the outlier filter. */
	pointCount: number;
	/** Data rows seen, outliers and unparseable rows included. */
	rowCount: number;
	/** Rows with a missing or unparseable coordinate pair. Expected to be
	 *  nonzero: VAN leaves the columns empty for addresses it never geocoded,
	 *  and the live demo list had several. */
	rowsWithoutCoordinates: number;
	/** Coordinates removed by the 3σ filter. */
	outliersDropped: number;
	/** Coordinates recovered by geocoding addresses VAN had not geocoded. Zero
	 *  when VAN had already geocoded every row, which is also the case where
	 *  nothing was sent to any third party. */
	geocodedFromAddress: number;
	/** Diagonal of the hull actually computed, in metres — reported even when
	 *  the hull was refused, so the caller can say how far past the bound it
	 *  was. Null when there was no hull to measure. */
	hullExtentMeters: number | null;
	/** True when the hull spans more than MAX_HULL_EXTENT_M — implausible for a
	 *  turf someone walks. Advisory: the hull is still returned and stored, and
	 *  the caller warns rather than discarding it. */
	hullTooLarge: boolean;
}

export class HullExtractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HullExtractError';
	}
}

/** Resolve addresses to coordinates. */
export type GeocodeFn = (rows: readonly AddressLookup[]) => Promise<Map<string, LatLng>>;

export interface ExtractOptions {
	/** When present, rows VAN never geocoded have their address components
	 *  collected and resolved through this. Omitting it leaves the extractor
	 *  reading nothing but the two coordinate columns — see the note on
	 *  `keepFor` in `extractHull`.
	 *
	 *  `geometry-worker.ts` supplies the Census batch geocoder by default, so
	 *  omitting it here is a testing affordance rather than the production
	 *  path. */
	geocode?: GeocodeFn | null;
}

/** Build the lookup for one ungeocoded row.
 *
 *  `street` is the portion of `Address` before its first comma: the column
 *  holds the full one-line address, and Census's batch format wants the street
 *  on its own with city/state/ZIP as separate fields.
 *
 *  `id` is the row's ordinal within this export, deliberately NOT the VanID —
 *  the file handed to Census must carry no identifier meaningful outside the
 *  request (rule 4 in geocode-batch.ts). */
function addressFrom(
	header: readonly string[],
	row: readonly string[],
	ordinal: number,
): AddressLookup | null {
	const at = (name: string): string => {
		const index = columnIndex(header, name);
		return index >= 0 ? (row[index] ?? '').trim() : '';
	};
	const street = (at('Address').split(',')[0] ?? '').trim();
	const zip = at('ZipCode');
	// Without a street there is nothing to match on, and a bare city would
	// geocode every door in the turf to the same downtown point.
	if (!street) return null;
	return { id: String(ordinal), street, city: at('City'), state: at('State'), zip };
}

/**
 * Parse CSV text arriving in arbitrary chunks, yielding one array per row.
 *
 * Exported for tests: the masking below is the security property this module
 * exists to provide, and it deserves a direct assertion rather than being
 * inferred from the hull that comes out the far end.
 *
 * `keep` is the whole point. When it is null every field is kept (the header
 * row, where we must read the names to find our columns). Once the header has
 * been read the caller passes the two coordinate indices, and from then on
 * every other field is dropped at the delimiter instead of being collected —
 * so PII never reaches the yielded array.
 *
 * Handles RFC 4180 quoting: commas, CRLF and doubled quotes inside a quoted
 * field. The live data needs it — addresses arrive as
 * `"4190 S Kirkman Rd Apt 912 , Orlando, FL 32811"`.
 */
export async function* csvRows(
	chunks: AsyncIterable<string>,
	keepFor: (rowIndex: number) => Set<number> | null,
): AsyncGenerator<string[]> {
	let row: string[] = [];
	let field = '';
	let index = 0;
	let rowIndex = 0;
	let inQuotes = false;
	let quoteJustClosed = false;
	let sawAnyChar = false;
	let keep = keepFor(0);

	const endField = (): void => {
		if (keep === null || keep.has(index)) row.push(field);
		else row.push('');
		field = '';
		index++;
	};

	for await (const chunk of chunks) {
		for (const char of chunk) {
			sawAnyChar = true;
			if (inQuotes) {
				if (quoteJustClosed) {
					quoteJustClosed = false;
					if (char === '"') {
						// Doubled quote inside a quoted field: a literal ".
						field += '"';
						continue;
					}
					inQuotes = false;
					// Fall through and reprocess this char unquoted.
				} else if (char === '"') {
					quoteJustClosed = true;
					continue;
				} else {
					field += char;
					continue;
				}
			}

			if (char === '"' && field === '') {
				inQuotes = true;
			} else if (char === ',') {
				endField();
			} else if (char === '\n' || char === '\r') {
				// \r\n ends the row on the \r; the \n then finds an empty row
				// and empty field, which the guard below ignores.
				if (row.length === 0 && field === '' && index === 0) continue;
				endField();
				yield row;
				row = [];
				index = 0;
				rowIndex++;
				keep = keepFor(rowIndex);
			} else {
				field += char;
			}
		}
	}

	// Final row when the file does not end in a newline.
	if (sawAnyChar && (field !== '' || row.length > 0)) {
		endField();
		yield row;
	}
}

/** Find a column by name, case-insensitively, trimming VAN's occasional
 *  leading BOM on the first header cell. */
function columnIndex(header: readonly string[], name: string): number {
	const wanted = name.trim().toLowerCase();
	// \uFEFF as an escape, not a literal BOM in the source — an invisible
	// character in a regex is exactly the kind of thing that survives review.
	return header.findIndex(
		(cell) =>
			cell
				.replace(/^\uFEFF/, '')
				.trim()
				.toLowerCase() === wanted,
	);
}

/**
 * Stream an export-job CSV and reduce it to a hull.
 *
 * Throws `HullExtractError` when the file has no header or lacks the
 * coordinate columns — that means the export job type is wrong (type 4 rather
 * than type 5, most likely), which is a configuration error a human needs to
 * see rather than a turf that quietly renders as a pin forever.
 */
export async function extractHull(
	chunks: AsyncIterable<string>,
	options: ExtractOptions = {},
): Promise<HullExtractResult> {
	let latIndex = -1;
	let lngIndex = -1;
	let addressIndexes: number[] = [];
	let header: string[] | null = null;
	const geocode = options.geocode ?? null;

	// Row 0 is read in full to locate the columns; every later row is masked to
	// the ones we found. Returning the set lazily per row is what lets the mask
	// change exactly once, between the header and the first data row: the
	// generator asks for row 1's mask only after the consumer below has read the
	// header out of row 0, so `dataRowKeep` is populated by then.
	//
	// The mask widens by exactly the four ADDRESS_COLUMNS, and only when a
	// geocoder was supplied. Callers normally supply one, so the narrowing that
	// matters is per-row rather than global: an address is collected ONLY for a
	// row whose coordinate columns were empty, and the geocoder is not called
	// at all when no row needed it. A turf VAN has already geocoded therefore
	// sends nothing anywhere, without depending on configuration.
	//
	// Built once and shared, not rebuilt per row — the contents change exactly
	// once, and a 30,000-row export does not need 30,000 identical Sets.
	let dataRowKeep: Set<number> | null = null;
	const keepFor = (rowIndex: number): Set<number> | null => (rowIndex === 0 ? null : dataRowKeep);

	const points: LatLng[] = [];
	// Addresses for rows VAN never geocoded, held only until the batch call
	// below resolves them. Never returned, never logged, never persisted.
	const pending: AddressLookup[] = [];
	let rowCount = 0;
	let rowsWithoutCoordinates = 0;

	for await (const row of csvRows(chunks, keepFor)) {
		if (header === null) {
			header = row;
			latIndex = columnIndex(header, LAT_COLUMN);
			lngIndex = columnIndex(header, LNG_COLUMN);
			if (latIndex < 0 || lngIndex < 0) {
				const missing = [latIndex < 0 ? LAT_COLUMN : null, lngIndex < 0 ? LNG_COLUMN : null].filter(
					Boolean,
				);
				throw new HullExtractError(
					`export CSV is missing ${missing.join(' and ')} — ` +
						`VAN_EXPORT_JOB_TYPE_ID is probably pointing at a type that does not ` +
						`carry address coordinates (type 5, VoterCircle, does)`,
				);
			}
			// Resolved only when geocoding is on, so the mask cannot widen by
			// accident. A missing address column is not fatal — those rows just
			// stay ungeocoded.
			addressIndexes = geocode
				? ADDRESS_COLUMNS.map((name) => columnIndex(header!, name)).filter((i) => i >= 0)
				: [];
			dataRowKeep = new Set([latIndex, lngIndex, ...addressIndexes]);
			continue;
		}

		rowCount++;
		const lat = Number(row[latIndex]);
		const lng = Number(row[lngIndex]);
		// VAN leaves both columns empty for an address it never geocoded, and
		// `Number('')` is 0 — which is a real coordinate in the Gulf of Guinea,
		// so an emptiness check has to come before the finiteness one.
		if (
			(row[latIndex] ?? '').trim() === '' ||
			(row[lngIndex] ?? '').trim() === '' ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lng) ||
			Math.abs(lat) > 90 ||
			Math.abs(lng) > 180
		) {
			rowsWithoutCoordinates++;
			if (geocode && addressIndexes.length > 0) {
				const lookup = addressFrom(header, row, rowCount);
				if (lookup) pending.push(lookup);
			}
			continue;
		}
		points.push({ lat, lng });
	}

	if (header === null) throw new HullExtractError('export CSV was empty — no header row');

	// One batch call for everything VAN left ungeocoded. Done after the walk
	// rather than per row so a 76-door turf is one request, not 76.
	let geocodedFromAddress = 0;
	if (geocode && pending.length > 0) {
		const found = await geocode(pending);
		for (const point of found.values()) {
			points.push(point);
			geocodedFromAddress++;
		}
		// The addresses have served their only purpose. Dropped explicitly so
		// the intent is visible, not merely implied by scope.
		pending.length = 0;
	}

	const kept = dropOutliers(points);
	const centre = centroid(kept);
	// `convexHull` returns the input points when there are fewer than three of
	// them — a faithful answer to "what is the hull of two points", but not a
	// polygon. Plan Story 3.4 is explicit that fewer than three surviving
	// points means no shape at all: store the centroid and let the UI draw a
	// pin, rather than a two-vertex sliver that reads as a real boundary.
	const raw = convexHull(kept);
	const hull = raw.length >= 3 ? raw : [];

	// Measured on the bounding-box diagonal rather than the true maximum
	// pairwise distance: within a few percent for any real shape, and O(n)
	// rather than O(n²) over a hull that can have many vertices.
	//
	// Reported, not enforced — see MAX_HULL_EXTENT_M. The hull is stored either
	// way; the caller decides what to say about it.
	const box = boundingBox(hull);
	const hullExtentMeters = box
		? haversineMeters({ lat: box.minLat, lng: box.minLng }, { lat: box.maxLat, lng: box.maxLng })
		: null;
	const hullTooLarge = hullExtentMeters !== null && hullExtentMeters > MAX_HULL_EXTENT_M;

	return {
		hull: hull.map((p) => ({ lat: round5(p.lat), lng: round5(p.lng) })),
		centre: centre ? { lat: round5(centre.lat), lng: round5(centre.lng) } : null,
		pointCount: kept.length,
		rowCount,
		rowsWithoutCoordinates,
		outliersDropped: points.length - kept.length,
		geocodedFromAddress,
		hullExtentMeters: hullExtentMeters === null ? null : Math.round(hullExtentMeters),
		hullTooLarge,
	};
}

/** Adapt a `fetch` response body to the chunk iterable `extractHull` wants.
 *  Separate so the extractor itself stays free of any network type. */
export async function* responseChunks(res: Response): AsyncGenerator<string> {
	const body = res.body;
	if (!body) {
		yield await res.text();
		return;
	}
	const decoder = new TextDecoder();
	// @ts-expect-error — Node's ReadableStream is async-iterable at runtime;
	// the DOM lib's type does not say so.
	for await (const value of body) {
		yield decoder.decode(value as Uint8Array, { stream: true });
	}
	const tail = decoder.decode();
	if (tail) yield tail;
}
