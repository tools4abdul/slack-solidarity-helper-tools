// Which turfs go in a payload, and which get left out.
//
// The measurement that forced this (plan.md 6.2b): a 1,000-turf chapter
// serialises to ~800 KB even with coordinates rounded to 5 dp, and stripping
// hulls entirely only reaches ~390 KB. Hulls are about half the weight; the
// other half is per-row metadata and JSON key names. So paging *hulls* alone
// cannot fix it — whole rows have to be left out, and the client asks for more
// by viewport as the volunteer pans.
//
// Pure, so the cap and the ordering can be tested without a DB or a browser,
// and shared by the page load and /api/turfs so the two cannot disagree about
// what "the nearest N" means.

import { haversineMeters, type BoundingBox, type LatLng } from './geometry.js';

/**
 * Rows per payload.
 *
 * A budget, not a limit on how much turf exists: a chapter with more sends
 * `omitted` and the client pages by viewport as the volunteer drags the map.
 *
 * Raised from 150 once real turf existed to measure, against 2,191 synced
 * turfs and 400 real hulls rather than 6.2b's estimate:
 *
 *   - **The wire cost is small.** A row is ~611 bytes (a hull averages 10
 *     vertices, ~325 bytes), so 500 rows is ~300 KB of JSON — but this JSON
 *     compresses about 7x and production serves `content-encoding: zstd`, so
 *     ~40 KB actually crosses the network. 6.2b's ~800 KB was raw bytes.
 *   - **Holding more costs the map almost nothing.** TurfMap culls per frame
 *     with two projections a turf, draws anything under PIN_BELOW_PX as a pin,
 *     and only puts on-screen items in the DOM. Measured with 1,000 turfs
 *     loaded at a neighbourhood zoom: 20 on screen, 0.11 ms a frame on a
 *     laptop — call it 0.5 ms on a mid-range phone, against 16.7 ms at 60 fps.
 *
 * 500 covers every chapter this campaign has cut (the largest is ~300) without
 * paging, while staying well inside both budgets. The ceiling that matters is
 * the first parse, not the panning.
 */
export const TURFS_PER_PAYLOAD = 500;

/**
 * What every selector needs to place a turf.
 *
 * Two spellings of the same thing, because selection happens at two points: on
 * raw `van_turfs` rows for the real page — before the view is built, so a turf
 * cut from the payload is never serialised at all — and on already-built
 * `TurfView`s for the demo, which has no database behind it. Rather than two
 * near-identical functions that could sort differently, the accessor takes
 * whichever field is present.
 */
export interface Locatable {
	mapRouteId: number;
	name: string;
	/** As stored on a van_turfs row. */
	centroidLat?: number | null;
	centroidLng?: number | null;
	/** As carried on a TurfView. Takes precedence when both are present. */
	centre?: LatLng | null;
}

export interface Selection<T> {
	selected: T[];
	/** How many rows the chapter holds that this payload leaves out. Shown to
	 *  the volunteer, because a list that silently stops at 150 of 1,000 reads
	 *  as "there is no more turf" — the most misleading thing this page could
	 *  say.
	 *
	 *  With an `offset`, this counts only what follows the page — it is what the
	 *  Slack command's "show more" reads to decide whether there is a next page
	 *  at all. */
	omitted: number;
}

function pointOf(row: Locatable): LatLng | null {
	if (row.centre) return row.centre;
	if (typeof row.centroidLat !== 'number' || typeof row.centroidLng !== 'number') return null;
	return { lat: row.centroidLat, lng: row.centroidLng };
}

/**
 * The rows to serialise, nearest first when we know where the volunteer is.
 *
 * Without a location there is no meaningful "nearest", so it falls back to
 * name order — stable and predictable, which matters more than clever when the
 * volunteer is going to scan the list anyway.
 *
 * Turf with no centroid sorts last rather than being dropped. It cannot be
 * mapped and its distance is unknowable, but it is real, claimable turf, and
 * on a key without export-job access it is *all* the turf there is.
 *
 * `offset` walks further down that same ordering, for the Slack command's
 * paging. It lives here rather than in the caller because this function is the
 * one place that decides what "the nearest N" means: the map pages by viewport
 * and the command pages by offset, and if the two disagreed about the ordering
 * they would hand a volunteer the same turf twice, or skip one. The sort is
 * deterministic (distance, then name) precisely so paging is stable between
 * presses.
 */
export function selectNearest<T extends Locatable>(
	rows: readonly T[],
	options: { location?: LatLng | null; limit?: number; offset?: number } = {},
): Selection<T> {
	const { location = null, limit = TURFS_PER_PAYLOAD } = options;
	// Negative, fractional and NaN offsets all reach this from a Slack button
	// value, which round-trips through the client and is therefore untrusted.
	// Normalised here so every caller gets the same treatment. NaN is checked
	// explicitly: Math.max(0, NaN) is NaN, and slice(NaN, NaN) silently returns
	// nothing — an empty page that reads as "no turf here" rather than a bad
	// request.
	const rawOffset = options.offset ?? 0;
	const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

	const ordered = [...rows];
	if (location) {
		const distance = new Map<number, number>();
		for (const row of ordered) {
			const point = pointOf(row);
			distance.set(row.mapRouteId, point ? haversineMeters(location, point) : Infinity);
		}
		ordered.sort(
			(a, b) =>
				(distance.get(a.mapRouteId) ?? Infinity) - (distance.get(b.mapRouteId) ?? Infinity) ||
				a.name.localeCompare(b.name),
		);
	} else {
		ordered.sort((a, b) => a.name.localeCompare(b.name));
	}

	return {
		selected: ordered.slice(offset, offset + limit),
		omitted: Math.max(0, ordered.length - (offset + limit)),
	};
}

/** Rows whose centroid falls inside `box`. Turf without a centroid is excluded
 *  — it has no position to test, and the map is the only caller. */
export function withinBounds<T extends Locatable>(rows: readonly T[], box: BoundingBox): T[] {
	return rows.filter((row) => {
		const point = pointOf(row);
		if (!point) return false;
		return (
			point.lat >= box.minLat &&
			point.lat <= box.maxLat &&
			point.lng >= box.minLng &&
			point.lng <= box.maxLng
		);
	});
}

/** Parse a `minLat,minLng,maxLat,maxLng` query parameter. Null for anything
 *  malformed, out of range, or inverted — a bad box must 400, not silently
 *  match the whole world and hand back the chapter in one request. */
export function parseBounds(raw: string | null): BoundingBox | null {
	if (!raw) return null;
	const parts = raw.split(',').map((n) => Number(n.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
	const [minLat, minLng, maxLat, maxLng] = parts as [number, number, number, number];
	if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
	if (minLat > maxLat || minLng > maxLng) return null;
	return { minLat, minLng, maxLat, maxLng };
}
