// Which chapters a Solidarity user belongs to.
//
// One rule, used everywhere a user record is turned into chapters: `chapter_ids`
// when it has anything in it, otherwise the legacy single `chapter_id`. It has
// to be one rule. The team_join handler and chapter reconciliation use it to
// decide which channels someone is invited to, the ZIP map uses it to decide
// which chapter a ZIP resolves to, and /turfs uses it to decide which county to
// show. When two of those disagreed, a member carrying `chapter_id` but an empty
// `chapter_ids` counted everywhere except the tally that places their
// neighbours.
//
// Deliberately free of imports, so the standalone scripts and the migrator can
// share it by relative path (see tsconfig.migrator.json).

export function chapterIdsOf(user: {
	chapter_id?: number | null;
	chapter_ids?: number[] | null;
}): number[] {
	if (user.chapter_ids?.length) return user.chapter_ids;
	if (user.chapter_id != null) return [user.chapter_id];
	return [];
}
