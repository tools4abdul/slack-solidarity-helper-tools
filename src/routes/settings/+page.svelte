<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import { resolve } from '$app/paths';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import './settings.css';
	import { formatRelative } from '$lib/components/settings/format-relative.js';
	import ChapterChannelEditor from '$lib/components/settings/ChapterChannelEditor.svelte';
	import CoalitionChannelEditor from '$lib/components/settings/CoalitionChannelEditor.svelte';
	import AllowedUsersEditor from '$lib/components/settings/AllowedUsersEditor.svelte';
	import InfoCommandsEditor from '$lib/components/settings/InfoCommandsEditor.svelte';
	import ExcludedChaptersEditor from '$lib/components/settings/ExcludedChaptersEditor.svelte';
	import ZipExcludedChaptersEditor from '$lib/components/settings/ZipExcludedChaptersEditor.svelte';
	import VanTurfCheckoutEditor from '$lib/components/settings/VanTurfCheckoutEditor.svelte';
	import VanChapterFoldersEditor from '$lib/components/settings/VanChapterFoldersEditor.svelte';
	import VanBlocklistEditor from '$lib/components/settings/VanBlocklistEditor.svelte';
	import ThemeEditor from '$lib/components/settings/ThemeEditor.svelte';
	import SettingsNav from '$lib/components/settings/SettingsNav.svelte';
	import { SECTION_IDS } from '$lib/components/settings/sections.js';
	import AppConfigEditor from '$lib/components/settings/AppConfigEditor.svelte';

	const { data } = $props();

	// "Last refreshed Nm ago" — derived from the oldest successful fetchedAt
	// across the three live-list sources. Em-dash when every list rejected,
	// because there's nothing to be old.
	const lastRefreshedLabel = $derived(
		data.oldestFetchedAt === null ? '—' : formatRelative(Date.now() - data.oldestFetchedAt),
	);

	// Strip ?refresh=lists after the server has honored it, so the back button
	// doesn't re-fire a forced refresh. Reads the reactive `page.url` (not
	// window.location) so it re-runs on every navigation — "Refresh lists" is a
	// repeated-use link and the router reuses this component across clicks, so a
	// one-shot mount effect would only clean up the first refresh. `refresh` is
	// the only query param /settings reads, so dropping back to the bare resolved
	// route fully strips it. Uses SvelteKit's replaceState to keep router state
	// in sync; $effect is client-only so no SSR guard is needed.
	$effect(() => {
		if (page.url.searchParams.get('refresh') === 'lists') {
			// The hash is preserved deliberately: `resolve('/settings')` is the bare
			// route, so replacing with it alone would silently drop a settings-nav
			// deep link (e.g. /settings?refresh=lists#cfg-warning-dm) on arrival.
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- a resolve()'d route plus a fragment; the rule only accepts a bare resolve() call for replaceState (its allowFragment option covers <a href> only), and typed linting isn't enabled here so the ResolvedPathname escape hatch is unavailable
			replaceState(`${resolve('/settings')}${page.url.hash}`, {});
		}
	});
</script>

<!-- Ids on the sections below are the settings-nav anchor targets; they are
     kept in sync with $lib/components/settings/sections.ts (SECTION_IDS). Each
     section body is bespoke markup, so the page can't render them from a loop
     over that tree. -->
<div class="settings-page">
	<SettingsNav />
	<main>
		<div class="settings-header">
			<Tooltip.Provider>
				<Tooltip.Root>
					<Tooltip.Trigger class="refresh-link-trigger">
						<a class="refresh-link" href="{resolve('/settings')}?refresh=lists">Refresh lists</a>
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Content class="refresh-tooltip" sideOffset={4}>
							Lists are cached for 5 minutes. Click to force a refresh.
						</Tooltip.Content>
					</Tooltip.Portal>
				</Tooltip.Root>
			</Tooltip.Provider>
			<span class="last-refreshed">Last refreshed {lastRefreshedLabel}</span>
		</div>

		<section
			id={SECTION_IDS.chapterChannelMap}
			data-settings-anchor={SECTION_IDS.chapterChannelMap}
			tabindex="-1"
		>
			<h2>Chapter ↔ Slack channel</h2>
			{#if data.errors.slackChannels}
				<p class="error">Slack channels: {data.errors.slackChannels}</p>
			{/if}
			{#if data.errors.solidarityChapters}
				<p class="error">Solidarity chapters: {data.errors.solidarityChapters}</p>
			{/if}
			{#if data.slackChannels && data.solidarityChapters}
				<ChapterChannelEditor
					chapters={data.solidarityChapters.items}
					channels={data.slackChannels.items}
					entries={data.settings.chapterChannelMap}
					welcomeDisabledChannelIds={[...data.settings.welcomeDisabledChannelIds]}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.coalitionChannelMap}
			data-settings-anchor={SECTION_IDS.coalitionChannelMap}
			tabindex="-1"
		>
			<h2>Coalition ↔ Slack channel</h2>
			{#if data.errors.slackChannels}
				<p class="error">Slack channels: {data.errors.slackChannels}</p>
			{/if}
			{#if data.errors.customProperties}
				<p class="error">Solidarity custom properties: {data.errors.customProperties}</p>
			{/if}
			{#if data.errors.userLists}
				<p class="error">Solidarity user lists: {data.errors.userLists}</p>
			{/if}
			{#if data.slackChannels && data.customProperties && data.userLists}
				<CoalitionChannelEditor
					channels={data.slackChannels.items}
					customProperties={data.customProperties.items}
					userLists={data.userLists.items}
					entries={data.settings.coalitionChannelMap}
				/>
			{/if}
		</section>

		<section id={SECTION_IDS.appConfig} data-settings-anchor={SECTION_IDS.appConfig} tabindex="-1">
			<h2>App config</h2>
			{#if data.errors.slackChannels}
				<p class="error">Slack channels: {data.errors.slackChannels}</p>
			{/if}
			{#if data.slackChannels}
				<AppConfigEditor
					channels={data.slackChannels.items}
					siteName={data.settings.siteName}
					trackingChannelId={data.settings.slackTrackingChannelId}
					growthReportChannelId={data.settings.slackGrowthReportChannelId}
					mobilizeSyncChannelId={data.settings.slackMobilizeSyncChannelId}
					turfChannelId={data.settings.slackTurfChannelId}
					mobilizeContactName={data.settings.mobilizeContactName}
					mobilizeContactEmail={data.settings.mobilizeContactEmail}
					mobilizeContactPhone={data.settings.mobilizeContactPhone}
					rankingAlpha={data.settings.slackGrowthReportRankingAlpha}
					countdownLabel={data.settings.countdownLabel}
					countdownEndAt={data.settings.countdownEndAt}
					memberNoteChannelId={data.settings.slackMemberNoteChannelId}
					welcomeDmMessage={data.settings.welcomeDmMessage}
					warningDmMessage={data.settings.warningDmMessage}
					tickerColumnsPerSecond={data.settings.doorTickerColumnsPerSecond}
					tickerEntries={data.tickerEntries}
					leaderboard={data.leaderboard}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.infoCommands}
			data-settings-anchor={SECTION_IDS.infoCommands}
			tabindex="-1"
		>
			<h2>Info commands</h2>
			<InfoCommandsEditor commands={data.settings.infoCommands} />
		</section>

		<section
			id={SECTION_IDS.allowedUsers}
			data-settings-anchor={SECTION_IDS.allowedUsers}
			tabindex="-1"
		>
			<h2>Allowed Slack users</h2>
			{#if data.errors.slackUsers}
				<p class="error">Slack users: {data.errors.slackUsers}</p>
			{/if}
			{#if data.slackUsers}
				<AllowedUsersEditor
					users={data.slackUsers.items}
					allowedIds={[...data.settings.allowedSlackUserIds]}
					selfId={data.selfSlackUserId}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.excludedChapters}
			data-settings-anchor={SECTION_IDS.excludedChapters}
			tabindex="-1"
		>
			<h2>Excluded chapters</h2>
			{#if data.errors.solidarityChapters}
				<p class="error">Solidarity chapters: {data.errors.solidarityChapters}</p>
			{/if}
			{#if data.solidarityChapters}
				<ExcludedChaptersEditor
					chapters={data.solidarityChapters.items}
					excludedIds={[...data.settings.reportExcludedChapterIds]}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.zipExcludedChapters}
			data-settings-anchor={SECTION_IDS.zipExcludedChapters}
			tabindex="-1"
		>
			<h2>Chapters without ZIP codes</h2>
			{#if data.errors.solidarityChapters}
				<p class="error">Solidarity chapters: {data.errors.solidarityChapters}</p>
			{/if}
			{#if data.solidarityChapters}
				<ZipExcludedChaptersEditor
					chapters={data.solidarityChapters.items}
					excludedIds={[...data.settings.zipExcludedChapterIds]}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.vanTurfCheckout}
			data-settings-anchor={SECTION_IDS.vanTurfCheckout}
			tabindex="-1"
		>
			<h2>Turf checkout</h2>
			<VanTurfCheckoutEditor
				ttlHours={data.settings.vanTurfClaimTtlHours}
				maxConcurrentClaims={data.settings.vanTurfMaxConcurrentClaims}
			/>
		</section>

		<section
			id={SECTION_IDS.vanChapterFolders}
			data-settings-anchor={SECTION_IDS.vanChapterFolders}
			tabindex="-1"
		>
			<h2>Chapter → VAN folders</h2>
			{#if data.errors.vanChapterFolders}
				<p class="error">{data.errors.vanChapterFolders}</p>
			{/if}
			{#if data.errors.solidarityChapters}
				<p class="error">Solidarity chapters: {data.errors.solidarityChapters}</p>
			{/if}
			{#if data.solidarityChapters}
				<VanChapterFoldersEditor
					chapters={data.solidarityChapters.items}
					mappings={data.vanChapterFolderMappings}
				/>
			{/if}
		</section>

		<section
			id={SECTION_IDS.vanBlocklist}
			data-settings-anchor={SECTION_IDS.vanBlocklist}
			tabindex="-1"
		>
			<h2>Blocked from turf checkout</h2>
			{#if data.errors.vanBlocklist}
				<p class="error">{data.errors.vanBlocklist}</p>
			{/if}
			{#if data.errors.slackUsers}
				<p class="error">Slack users: {data.errors.slackUsers}</p>
			{/if}
			{#if data.slackUsers}
				<VanBlocklistEditor
					users={data.slackUsers.items}
					blockedIds={data.vanBlockedUsers.map((u) => u.slackUserId)}
				/>
			{/if}
		</section>

		<section id={SECTION_IDS.theme} data-settings-anchor={SECTION_IDS.theme} tabindex="-1">
			<h2>Theme</h2>
			<ThemeEditor initialTokens={data.themeTokens} />
		</section>
	</main>
</div>

<style>
	.settings-header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 24px;
		padding: 12px 0;
		border-bottom: 1px solid var(--color-border);
	}

	:global(.refresh-link-trigger) {
		background: transparent;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}

	.refresh-link {
		color: var(--color-gold);
		text-decoration: none;
		border-bottom: 1px dashed currentColor;
	}

	.refresh-link:hover,
	.refresh-link:focus-visible {
		border-bottom-style: solid;
	}

	.last-refreshed {
		font-size: 0.9em;
		color: var(--color-text-muted);
	}

	.error {
		margin: 8px 0 0;
		padding: 6px 10px;
		background: color-mix(in srgb, var(--color-error) 8%, transparent);
		border-left: 3px solid var(--color-error);
		color: var(--color-error);
		font-size: 0.9em;
		border-radius: var(--radius-sm);
	}

	:global(.refresh-tooltip) {
		background: var(--color-bg-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 6px 10px;
		font-size: 0.85em;
		box-shadow: var(--shadow-popover);
		z-index: 50;
	}
</style>
