import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { count, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db.js';
import { vanTurfs } from '$lib/server/schema.js';
import { loadVanSheetTargets } from '$lib/server/settings.js';
import { matchSheetTarget, normaliseSheetKey } from '$lib/van/sheet-routing.js';

// Where every region's turf checkouts will be logged — the page for checking
// that the rules under Settings → Checkout spreadsheets actually cover the
// state.
//
// It exists because those rules are not readable by inspection. A dozen
// overlapping prefixes matched longest-first across a few hundred region names
// is not something anyone can verify from the settings table, and the failure
// is silent: a checkout routed into the wrong campaign's spreadsheet looks
// exactly like one routed correctly. This is the difference between
// "configured" and "configured correctly" — the same argument the folder-map
// page makes for folder → chapter.
//
// Reads van_turfs rather than VAN, deliberately, and that is the opposite of
// folder-map. The routing input is `region_name`, which the catalog has already
// synced, so VAN could add nothing here and a round trip per folder would be
// spent for nothing on a page an admin opens while editing rules.

export interface RegionRow {
	regionName: string;
	turfs: number;
}

export interface SheetGroup {
	label: string;
	spreadsheetId: string;
	/** Rules pointing at this spreadsheet. Several may — the campaign's two
	 *  Downriver rules do. */
	prefixes: string[];
	regions: RegionRow[];
	turfs: number;
}

export const load: PageServerLoad = async ({ locals }) => {
	// Same gate as the other organizer pages: a bare 302 for a missing session
	// and for a signed-in non-admin alike.
	if (!locals.session?.isAdmin) redirect(302, '/');

	const targets = await loadVanSheetTargets(db);

	// Retired turf is excluded: its region may not have been cut for months and
	// listing it would have an admin writing rules for ground nobody canvasses.
	// A live checkout on a retired route still routes correctly at drain time —
	// the rules are the same, this page is just not the place to show it.
	const rows = await db
		.select({ regionName: vanTurfs.regionName, turfs: count() })
		.from(vanTurfs)
		.where(isNull(vanTurfs.retiredAt))
		.groupBy(vanTurfs.regionName);

	const groups = new Map<string, SheetGroup>();
	const unrouted: RegionRow[] = [];

	for (const row of rows) {
		const region: RegionRow = { regionName: row.regionName, turfs: row.turfs };
		const target = matchSheetTarget(row.regionName, targets);
		if (!target) {
			unrouted.push(region);
			continue;
		}
		const group = groups.get(target.spreadsheetId);
		if (group) {
			group.regions.push(region);
			group.turfs += region.turfs;
		} else {
			groups.set(target.spreadsheetId, {
				label: target.label,
				spreadsheetId: target.spreadsheetId,
				prefixes: targets
					.filter((t) => t.spreadsheetId === target.spreadsheetId)
					.map((t) => t.prefix),
				regions: [region],
				turfs: region.turfs,
			});
		}
	}

	for (const group of groups.values()) {
		group.regions.sort((a, b) => a.regionName.localeCompare(b.regionName));
	}
	unrouted.sort((a, b) => a.regionName.localeCompare(b.regionName));

	return {
		pageTitle: 'Checkout spreadsheets' as const,
		// Most turf first: the spreadsheet a mistake would cost the most is at
		// the top.
		groups: [...groups.values()].sort((a, b) => b.turfs - a.turfs),
		unrouted,
		// Rules that match no region at all. Usually a typo, occasionally a
		// region VAN has not cut yet — either way worth seeing, because a rule
		// that matches nothing is indistinguishable from a working one in the
		// settings list.
		unusedRules: targets
			.filter((t) => !groups.has(t.spreadsheetId) || !matchesAny(t.prefix, rows))
			.map((t) => ({ prefix: t.prefix, label: t.label }))
			.filter((rule, i, all) => all.findIndex((r) => r.prefix === rule.prefix) === i),
		configured: targets.length > 0,
	};
};

/** Whether any synced region is actually covered by this exact rule. A rule can
 *  point at a spreadsheet that other rules fill while matching nothing itself,
 *  which is what makes a typo survivable long enough to matter. */
function matchesAny(prefix: string, rows: readonly { regionName: string }[]): boolean {
	const single = [{ prefix, prefixKey: normaliseSheetKey(prefix), label: '', spreadsheetId: '' }];
	return rows.some((row) => matchSheetTarget(row.regionName, single) !== null);
}
