// The distinct chapters behind a channel map.
//
// Pure and dependency-free, in `$lib/` rather than `$lib/server/`, for the same
// reason the rest of the pure layer is: the page loads that need it already mock
// `$lib/server/settings.js`, so a helper living there would be `undefined` under
// test and every suite would have to restub it. Here it is imported directly by
// loaders and tests alike, and exercised for real rather than through a mock.

export interface ChapterOption {
	chapterId: number;
	name: string;
}

/**
 * An admin's turf-only chapters, labelled so none reads the same as a real
 * chapter beside it in a picker: one whose name matches any of `realNames`,
 * ignoring case, becomes "<name> (custom)".
 *
 * Adding a name checks it against the real chapters, but that check is only as
 * good as the day it ran — a Solidarity chapter renamed later, or a chapter
 * newly given a Slack channel, can still arrive under the same name. Labelling
 * where the lists meet covers that whenever it happens, and stops as soon as
 * the names differ again, with nothing stored to clean up.
 */
export function labelCustomChapters(
	custom: ReadonlyArray<ChapterOption>,
	realNames: readonly string[],
): ChapterOption[] {
	const real = new Set(realNames.map((n) => n.trim().toLocaleLowerCase()));
	return custom.map((c) =>
		real.has(c.name.trim().toLocaleLowerCase()) ? { ...c, name: `${c.name} (custom)` } : c,
	);
}

/**
 * Deduplicate a channel map down to its chapters, sorted by name.
 *
 * `chapter_channel_map` is keyed by CHANNEL, so a chapter with two channels
 * appears twice — and in production every one of the 32 chapters does, giving 64
 * rows. Mapping those rows straight to picker options lists every chapter twice,
 * and that is the benign version of the failure.
 *
 * The sharp version: a keyed `{#each chapters as c (c.chapterId)}` throws
 * `each_key_duplicate`, and that is an UNCAUGHT error during hydration. It does
 * not just break the picker, it kills the client-side app for the whole page.
 * Observed on /turfs/organizer and /turfs/activity: the top bar rendered from SSR
 * and was then torn back out — no theme toggle, no menu, no username, no log-out
 * button — and client-side navigation stopped working, so clicking the menu item
 * appeared to do nothing until a manual reload. Neither symptom points anywhere
 * near a chapter list, which is what made it expensive to find. The server
 * response was correct and fast throughout; only the browser was broken.
 *
 * Extracted rather than left inline because /turfs/+page.server.ts had already
 * hit this once and fixed it in place, and the two pages written afterwards
 * repeated the raw `.map()`. A shared function is the only version of the fix
 * that stops the third occurrence.
 *
 * First row wins on the name. The two agree in practice, and picking arbitrarily
 * between two spellings of one chapter would make the order jitter per request.
 *
 * `custom` is the admin's turf-only chapters (turf_custom_chapters), which have
 * negative ids and no channel, merged in and sorted with the rest — labelled by
 * labelCustomChapters where a name collides.
 */
export function chaptersFromChannelMap(
	entries: ReadonlyArray<{ chapterId: number; name: string }>,
	custom: ReadonlyArray<ChapterOption> = [],
): ChapterOption[] {
	const byChapterId = new Map<number, ChapterOption>();
	const labelled = labelCustomChapters(
		custom,
		entries.map((e) => e.name),
	);
	for (const entry of [...entries, ...labelled]) {
		if (!byChapterId.has(entry.chapterId)) {
			byChapterId.set(entry.chapterId, { chapterId: entry.chapterId, name: entry.name });
		}
	}
	return [...byChapterId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The chapters a volunteer can pick on /turfs and in the Slack `/turfs`
 * command: every chapter in the channel map, less the ones an admin has hidden
 * from turf (turf_hidden_chapters), plus the admin's turf-only chapters
 * (turf_custom_chapters). Hiding is turf-only — the same chapter
 * keeps its Slack channels and its place in the reports, which read the map
 * directly.
 *
 * The one rule for every volunteer-facing chapter list and every check of a
 * chapter id a volunteer sent, so a hidden chapter is neither offered nor
 * reachable by URL. The admin organizer and activity pages use
 * chaptersFromChannelMap and still list it.
 */
export function turfChapters(
	entries: ReadonlyArray<{ chapterId: number; name: string }>,
	hiddenChapterIds: ReadonlySet<number>,
	custom: ReadonlyArray<ChapterOption> = [],
): ChapterOption[] {
	return chaptersFromChannelMap(entries, custom).filter((c) => !hiddenChapterIds.has(c.chapterId));
}
