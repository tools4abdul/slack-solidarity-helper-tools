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
 */
export function chaptersFromChannelMap(
	entries: ReadonlyArray<{ chapterId: number; name: string }>,
): ChapterOption[] {
	const byChapterId = new Map<number, ChapterOption>();
	for (const entry of entries) {
		if (!byChapterId.has(entry.chapterId)) {
			byChapterId.set(entry.chapterId, { chapterId: entry.chapterId, name: entry.name });
		}
	}
	return [...byChapterId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
