<script lang="ts">
	// One VAN campaign's settings: connection, folders, switches, status, and
	// switching it on or off (specs/012-multi-van-campaigns, Phase 5). Global
	// turf rules — claim length, the per-volunteer cap, the block list — stay
	// on /settings, because they apply to every campaign alike.

	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import '../../settings.css';
	import { errMessage } from '$lib/err-message.js';
	import ConfirmButton from '$lib/components/settings/ConfirmButton.svelte';
	import VanCampaignConnection from '$lib/components/settings/VanCampaignConnection.svelte';
	import VanCampaignSettings from '$lib/components/settings/VanCampaignSettings.svelte';
	import VanChapterFoldersEditor from '$lib/components/settings/VanChapterFoldersEditor.svelte';
	import { formatRelative } from '$lib/components/settings/format-relative.js';

	let { data } = $props();

	const campaign = $derived(data.campaign);
	const status = $derived(data.status);

	let enabling = $state(false);
	let enableError = $state<string | null>(null);

	async function setEnabled(enabled: boolean): Promise<void> {
		const res = await fetch(`/api/settings/van-campaigns/${campaign.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled }),
		});
		const parsed = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) throw new Error(parsed.error ?? `Save failed (HTTP ${res.status})`);
		await invalidateAll();
	}

	async function enable(): Promise<void> {
		enabling = true;
		enableError = null;
		try {
			await setEnabled(true);
		} catch (e) {
			enableError = errMessage(e);
		} finally {
			enabling = false;
		}
	}

	/** "4 hours ago", or the fallback when there is no timestamp. */
	function ago(iso: string | null, never = 'never'): string {
		return iso ? formatRelative(Date.now() - Date.parse(iso)) : never;
	}

	const disableDescription = $derived(
		`Syncing ${campaign.name} stops. ${status.unclaimedLiveTurfs} unclaimed turf will be hidden ` +
			`from the map and /turfs. ${status.liveClaims} live claim(s) keep running until they end` +
			`${campaign.sheetsEnabled ? ', and are still recorded in its Packet Tracker' : ''}. ` +
			'You can enable it again at any time.',
	);
</script>

<svelte:head><title>{data.pageTitle}</title></svelte:head>

<div class="settings-page">
	<main>
		<p class="back"><a href={resolve('/settings')}>← Settings</a></p>
		<header class="campaign-header">
			<h1>{campaign.name}</h1>
			<span class={['chip', campaign.chip]}>
				{campaign.chip === 'enabled'
					? 'Enabled'
					: campaign.chip === 'disabled'
						? 'Disabled'
						: 'New: not enabled'}
			</span>
		</header>

		<section id="state">
			<h2>{campaign.enabled ? 'Enabled' : 'Not enabled'}</h2>
			{#if campaign.enabled}
				<p>
					Synced every half hour. Its unclaimed turf is offered to volunteers in the chapters its
					folders are mapped to.
				</p>
				<ConfirmButton
					label="Disable"
					confirmLabel="Disable campaign"
					tone="neutral"
					description={disableDescription}
					onConfirm={() => setEnabled(false)}
				/>
			{:else}
				{#if campaign.chip === 'disabled' && campaign.disabledAt}
					<p>
						Disabled by {campaign.disabledByName ?? 'an admin'}
						{ago(campaign.disabledAt)}.
					</p>
				{:else}
					<p>
						Set up below, then enable it. It needs a working key and at least one folder mapped to a
						chapter.
					</p>
				{/if}
				<div class="enable">
					<button type="button" class="button primary" onclick={enable} disabled={enabling}>
						{enabling ? 'Checking…' : 'Enable'}
					</button>
					{#if enableError}
						<span class="problem" role="alert">{enableError}</span>
					{/if}
				</div>
			{/if}
		</section>

		<section id="connection">
			<h2>Connection</h2>
			<VanCampaignConnection
				campaignId={campaign.id}
				credentials={data.credentials}
				exportJobTypeId={campaign.exportJobTypeId}
				fallbackExportJobTypeId={campaign.fallbackExportJobTypeId}
			/>
		</section>

		<section id="folders">
			<h2>Chapter → VAN folders</h2>
			{#if data.chaptersError}
				<p class="error">Solidarity chapters: {data.chaptersError}</p>
			{/if}
			<VanChapterFoldersEditor
				campaignId={campaign.id}
				chapters={data.chapters}
				mappings={data.mappings}
			/>
			<p class="note">
				<a href="{resolve('/turfs/folder-map')}?campaign={campaign.id}"
					>See these folders on a map</a
				>
			</p>
		</section>

		<section id="settings">
			<h2>Campaign settings</h2>
			<VanCampaignSettings
				campaignId={campaign.id}
				credentialKey={campaign.credentialKey}
				label={campaign.label}
				badgeLabel={campaign.badgeLabel}
				refreshEnabled={campaign.refreshEnabled}
				sheetsEnabled={campaign.sheetsEnabled}
				sheetTabName={campaign.sheetTabName}
				dailyReportSpreadsheetId={campaign.dailyReportSpreadsheetId}
				targets={data.targets}
				serviceAccountEmail={data.sheetsServiceAccountEmail}
				onSaved={() => void invalidateAll()}
			/>
			{#if campaign.sheetsEnabled}
				<p class="note">
					<a href="{resolve('/turfs/sheet-map')}?campaign={campaign.id}"
						>Check which spreadsheet each region routes to</a
					>
				</p>
			{/if}
		</section>

		<section id="status">
			<h2>Status</h2>
			<dl class="status">
				<dt>Last sync</dt>
				<dd>{ago(status.lastSyncAt)}</dd>
				{#if status.lastError}
					<dt>Last error</dt>
					<dd class="problem">{status.lastError}</dd>
				{/if}
				<dt>Turf</dt>
				<dd>
					{status.liveTurfs} live · {status.retiredTurfs} retired · {status.liveClaims} claimed now
				</dd>
				<dt>Turf shapes</dt>
				<dd>
					{status.geometryPending} waiting{status.geometryFailed > 0
						? ` · ${status.geometryFailed} failed`
						: ''}
				</dd>
				<dt>MiniVAN exports</dt>
				<dd>
					{status.minivanExportsOk === null
						? 'not read yet'
						: status.minivanExportsOk
							? 'read and current'
							: 'not available — drift checks are off for this campaign'}
				</dd>
				<dt>Contact history</dt>
				<dd>
					{status.contactCursor
						? `read up to ${ago(status.contactCursor)}`
						: 'not read yet'}{status.contactLastError ? ` — ${status.contactLastError}` : ''}
				</dd>
			</dl>
		</section>
	</main>
</div>

<style>
	.back {
		margin: 0 0 var(--space-3);
	}

	.campaign-header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}

	.campaign-header h1 {
		margin: 0;
	}

	.chip {
		font-size: var(--font-size-sm);
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
	}

	.chip.enabled {
		border-color: var(--color-success);
	}

	.chip.new {
		font-style: italic;
	}

	.enable {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.button {
		font: inherit;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
		cursor: pointer;
	}

	.button.primary {
		border-color: var(--color-text);
		font-weight: 600;
	}

	.button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.problem {
		color: var(--color-error);
	}

	.note {
		font-size: var(--font-size-sm);
		margin-top: var(--space-3);
	}

	.status {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.status dt {
		color: var(--color-text-muted);
	}

	.status dd {
		margin: 0;
	}

	.error {
		margin: 8px 0 0;
		padding: 6px 10px;
		border-left: 3px solid var(--color-error);
		color: var(--color-error);
		font-size: 0.9em;
	}
</style>
