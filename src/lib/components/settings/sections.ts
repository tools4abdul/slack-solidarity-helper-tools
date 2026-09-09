// Single source of truth for the /settings section navigation. Imported by BOTH
// `+page.svelte` (which stamps `id` on each <section>) and `AppConfigEditor`
// (which stamps `id` on each SettingsRow), so a nav entry can't point at a
// fragment that no longer exists in the DOM.
//
// The ids double as URL fragments, so they are hand-written stable slugs rather
// than being derived from label text. Two App-config rows interpolate live
// values into their visible labels (`α = 0.35`, `= 12 columns/sec`); a
// text-derived id would change as the user drags those sliders and break any
// deep link taken mid-session.

export interface SettingsNavItem {
	/** DOM id and URL fragment. Stable; never derived from label text. */
	readonly id: string;
	/** Nav label. Deliberately allowed to differ from the visible heading or row
	 *  label — see the two dynamic App-config rows below. */
	readonly label: string;
	readonly children?: readonly SettingsNavItem[];
}

/** Viewport width at or below which the sidebar becomes a sticky top drawer.
 *  Kept in sync by hand with the `@media (max-width: 960px)` blocks in
 *  settings.css and SettingsNav.svelte — a media query can't read a JS constant
 *  or a CSS custom property. 960 is already this codebase's shell breakpoint
 *  (src/routes/+page.svelte), and below it the content column would be narrower
 *  than AppConfigEditor's own 720px max-width, so the two-column push stops
 *  earning its keep. */
export const SETTINGS_NAV_BREAKPOINT_PX = 960;

export const APP_CONFIG_SECTION_ID = 'app-config';

/** Ids for the AppConfigEditor rows, so that file references symbols rather
 *  than repeating string literals. `sections.test.ts` asserts these stay in
 *  lockstep with the `app-config` children below. */
export const APP_CONFIG_ROW_IDS = {
	siteName: 'cfg-site-name',
	trackingChannel: 'cfg-tracking-channel',
	growthReportChannel: 'cfg-growth-report-channel',
	mobilizeSyncChannel: 'cfg-mobilize-sync-channel',
	turfChannel: 'cfg-turf-channel',
	mobilizeContact: 'cfg-mobilize-contact',
	countdown: 'cfg-countdown',
	welcomeDm: 'cfg-welcome-dm',
	memberNotesChannel: 'cfg-member-notes-channel',
	warningDm: 'cfg-warning-dm',
	rankingAlpha: 'cfg-ranking-alpha',
	tickerSpeed: 'cfg-ticker-speed',
} as const;

/** Ids for the top-level sections. `+page.svelte` stamps these onto its
 *  <section> elements; each section's body is bespoke markup, so the page can't
 *  render them from a loop over this tree. */
export const SECTION_IDS = {
	chapterChannelMap: 'chapter-channel-map',
	coalitionChannelMap: 'coalition-channel-map',
	appConfig: APP_CONFIG_SECTION_ID,
	infoCommands: 'info-commands',
	allowedUsers: 'allowed-users',
	excludedChapters: 'excluded-chapters',
	vanTurfCheckout: 'van-turf-checkout',
	vanChapterFolders: 'van-chapter-folders',
	vanBlocklist: 'van-blocklist',
	theme: 'theme',
} as const;

export const SETTINGS_SECTIONS: readonly SettingsNavItem[] = [
	{ id: SECTION_IDS.chapterChannelMap, label: 'Chapter ↔ Slack channel' },
	{ id: SECTION_IDS.coalitionChannelMap, label: 'Coalition ↔ Slack channel' },
	{
		id: SECTION_IDS.appConfig,
		label: 'App config',
		children: [
			{ id: APP_CONFIG_ROW_IDS.siteName, label: 'Site name' },
			{ id: APP_CONFIG_ROW_IDS.trackingChannel, label: 'Volunteer-help tracking channel' },
			{ id: APP_CONFIG_ROW_IDS.growthReportChannel, label: 'Weekly growth report channel' },
			{ id: APP_CONFIG_ROW_IDS.mobilizeSyncChannel, label: 'Mobilize sync channel' },
			{ id: APP_CONFIG_ROW_IDS.turfChannel, label: 'Turf sync channel' },
			{ id: APP_CONFIG_ROW_IDS.mobilizeContact, label: 'Mobilize event contact' },
			{ id: APP_CONFIG_ROW_IDS.countdown, label: 'Header countdown' },
			{ id: APP_CONFIG_ROW_IDS.welcomeDm, label: 'New-member welcome DM' },
			{ id: APP_CONFIG_ROW_IDS.memberNotesChannel, label: 'Member notes channel' },
			{ id: APP_CONFIG_ROW_IDS.warningDm, label: 'Warning DM' },
			// Static nav labels — these two rows keep their live-value labels on
			// the page itself (`α = 0.35`, `= 12 columns/sec`).
			{ id: APP_CONFIG_ROW_IDS.rankingAlpha, label: 'Growth report ranking α' },
			{ id: APP_CONFIG_ROW_IDS.tickerSpeed, label: 'Doors ticker speed' },
		],
	},
	{ id: SECTION_IDS.infoCommands, label: 'Info commands' },
	{ id: SECTION_IDS.allowedUsers, label: 'Allowed Slack users' },
	{ id: SECTION_IDS.excludedChapters, label: 'Excluded chapters' },
	{ id: SECTION_IDS.vanTurfCheckout, label: 'Turf checkout' },
	{ id: SECTION_IDS.vanChapterFolders, label: 'Chapter \u2192 VAN folders' },
	{ id: SECTION_IDS.vanBlocklist, label: 'Blocked from turf checkout' },
	{ id: SECTION_IDS.theme, label: 'Theme' },
];
