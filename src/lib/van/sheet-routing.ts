// Which of the campaign's spreadsheets a turf's checkout rows belong in.
//
// The campaign keeps about a dozen, named for the ground they cover —
// `R01A_Alger CR`, `R09A_Detroit CR`, `R10C_Downriver CR`. A turf has to be
// matched to one of them from its VAN region name, because that name is the
// only geography the catalog has: van_turfs carries no county column, and
// centroid_lat is null until an export job has run for that route.
//
// Neither half of a region name is enough on its own, which is why this is a
// rule list rather than a lookup on a parsed field:
//
//   R01A spans two counties, Alger and Houghton, and each has its own sheet —
//   so the region code alone routes both to the wrong place half the time.
//
//   R10C has two sheets, Downriver and Western Wayne, both inside Wayne county
//   and separated only by which cities they cover — so the county alone cannot
//   tell them apart either, and "Downriver" never appears in a VAN name.
//
// So an admin writes prefixes and the LONGEST match wins:
//
//   R01A_Alger           → R01A_Alger CR
//   R01A_Houghton        → R01A_Houghton CR
//   R10C_Wayne_Taylor    → R10C_Downriver CR
//   R10C_Wayne_Wyandotte → R10C_Downriver CR
//   R10C                 → R10C_WesternWayne CR      ← catch-all for the rest
//
// A name that matches nothing returns null. It is NOT guessed at: routing a
// checkout into the wrong campaign's spreadsheet looks exactly like routing it
// into the right one, so there is no failure to notice later. sheet-store.ts
// holds those events unsent and names them in the operator alert instead.
//
// Pure — no DB, no network, no clock. sheet-store.ts does the rows.

/** One admin-authored rule. Mirrors a `van_sheet_targets` row, minus the audit
 *  columns. */
export interface SheetTarget {
	/** The rule as typed, for display and for the settings editor. */
	prefix: string;
	/** `prefix` folded by `normaliseSheetKey`. Stored rather than recomputed so
	 *  the uniqueness constraint and the matcher agree by construction. */
	prefixKey: string;
	label: string;
	spreadsheetId: string;
}

/**
 * The one comparison form for a rule and a region name.
 *
 * Lowercase alphanumerics only, which is what makes the separators organizers
 * actually use interchangeable: `R08A.Macomb.WarrenCity` and
 * `R08A_Macomb_WarrenCity` fold to the same string, as do `R10C` and `r10c`.
 *
 * The same folding region-name.ts applies to county segments, deliberately —
 * but NOT shared with it. That function exists to match a segment against a
 * fixed census list; this one matches a whole name against an admin's rule.
 * They agree today by coincidence of being the obvious folding, and coupling
 * them would mean a change made for one silently re-routed the other.
 */
export function normaliseSheetKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Order rules so the longest key is tried first.
 *
 * Call once per run and reuse — `matchSheetTarget` does not sort, so that a
 * drain writing a few hundred events does not re-sort a dozen rules for each
 * one. Ties on length are broken by key for a stable order; they cannot be
 * ties on the key itself, which is a primary key.
 */
export function orderSheetTargets(targets: readonly SheetTarget[]): SheetTarget[] {
	return [...targets].sort(
		(a, b) => b.prefixKey.length - a.prefixKey.length || a.prefixKey.localeCompare(b.prefixKey),
	);
}

/**
 * The spreadsheet a region's turf belongs in, or null when no rule covers it.
 *
 * `targets` MUST come from `orderSheetTargets`. Passing an unordered list does
 * not throw — it quietly returns a shorter match over a longer one, which is
 * the bug this comment exists to make findable.
 */
export function matchSheetTarget(
	regionName: string | null | undefined,
	targets: readonly SheetTarget[],
): SheetTarget | null {
	if (!regionName) return null;
	const key = normaliseSheetKey(regionName);
	if (!key) return null;
	for (const target of targets) {
		// An empty rule key would match everything, including names it was never
		// meant to cover. The settings route refuses one, and this is the second
		// gate: a row that predates that check cannot become a silent catch-all.
		if (!target.prefixKey) continue;
		if (key.startsWith(target.prefixKey)) return target;
	}
	return null;
}
