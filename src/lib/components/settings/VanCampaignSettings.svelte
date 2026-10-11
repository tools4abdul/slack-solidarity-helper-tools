<script lang="ts">
	// A VAN campaign's own switches: its name, whether the sync may re-cut its
	// regions, whether its checkouts go to a Packet Tracker
	// (specs/012-multi-van-campaigns), and where its nightly door report goes.
	// Each row autosaves on its own, like the App config rows, through PATCH
	// /api/settings/van-campaigns/<id>.

	import { untrack } from 'svelte';
	import SettingsRow from './SettingsRow.svelte';
	import VanSheetTargetsEditor from './VanSheetTargetsEditor.svelte';
	import { createFieldAutosave } from './use-field-autosave.svelte.js';
	import { DEFAULT_SHEET_TAB_NAME } from '$lib/van/packet-tracker.js';
	import { extractSpreadsheetId, isSpreadsheetId } from '$lib/google-sheet-id.js';

	interface TargetEntry {
		prefix: string;
		prefixKey: string;
		label: string;
		spreadsheetId: string;
	}

	interface Props {
		campaignId: number;
		credentialKey: string;
		label: string;
		badgeLabel: string;
		refreshEnabled: boolean;
		sheetsEnabled: boolean;
		sheetTabName: string;
		dailyReportSpreadsheetId: string;
		targets: TargetEntry[];
		serviceAccountEmail: string | null;
		/** After each successful save — so the page can re-read what it shows
		 *  from these fields (its heading, the disable dialog's wording). */
		onSaved?: () => void;
	}

	let {
		campaignId,
		credentialKey,
		label,
		badgeLabel,
		refreshEnabled,
		sheetsEnabled,
		sheetTabName,
		dailyReportSpreadsheetId,
		targets,
		serviceAccountEmail,
		onSaved,
	}: Props = $props();

	async function patch(body: Record<string, unknown>): Promise<void> {
		const res = await fetch(`/api/settings/van-campaigns/${campaignId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const parsed = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) throw new Error(parsed.error ?? `Save failed (HTTP ${res.status})`);
		onSaved?.();
	}

	// Seeded once from the server; from then on the field is the source of
	// truth while the page is open, as in every other settings editor.
	const labelSave = createFieldAutosave<string>({
		initial: untrack(() => label),
		save: (value) => patch({ label: value }),
	});
	const badgeSave = createFieldAutosave<string>({
		initial: untrack(() => badgeLabel),
		save: (value) => patch({ badgeLabel: value }),
	});
	const tabSave = createFieldAutosave<string>({
		initial: untrack(() => sheetTabName),
		save: (value) => patch({ sheetTabName: value }),
	});
	const reportSave = createFieldAutosave<string>({
		initial: untrack(() => dailyReportSpreadsheetId),
		save: (value) => patch({ dailyReportSpreadsheetId: value }),
	});
	/** The saved spreadsheet, as a link. The field keeps whatever was pasted —
	 *  usually the whole URL — while the server stores just the id, so the link
	 *  is what shows the two agree. */
	const reportUrl = $derived.by(() => {
		const id = extractSpreadsheetId(reportSave.value);
		return isSpreadsheetId(id) ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null;
	});
	const refreshSave = createFieldAutosave<boolean>({
		initial: untrack(() => refreshEnabled),
		parse: (raw) => raw === 'true',
		save: (value) => patch({ refreshEnabled: value }),
	});
	const sheetsSave = createFieldAutosave<boolean>({
		initial: untrack(() => sheetsEnabled),
		parse: (raw) => raw === 'true',
		save: (value) => patch({ sheetsEnabled: value }),
	});

	/** The autosave helper reads `event.target.value`, which on a checkbox is
	 *  the constant "on" — so hand it the checked state as the string it parses. */
	function toggle(save: typeof refreshSave) {
		return (e: Event): void => {
			const checked = (e.currentTarget as HTMLInputElement).checked;
			save.oninput({ target: { value: String(checked) } } as unknown as Event);
		};
	}

	$effect(() => () => {
		labelSave.destroy();
		badgeSave.destroy();
		tabSave.destroy();
		reportSave.destroy();
		refreshSave.destroy();
		sheetsSave.destroy();
	});
</script>

<SettingsRow
	label="Name"
	status={labelSave.status}
	error={labelSave.error}
	onRetry={labelSave.status === 'error' ? labelSave.retry : undefined}
>
	<input
		class="text-input"
		type="text"
		maxlength="80"
		placeholder={credentialKey}
		value={labelSave.value}
		oninput={labelSave.oninput}
		aria-label="Campaign name"
	/>
	<p class="app-config-note">
		What organizers see on these pages and what the turf channel's alerts call it — and the turf
		badge, unless that has its own text below. Left empty, it goes by its key,
		<code>{credentialKey}</code>.
	</p>
</SettingsRow>

<SettingsRow
	label="Turf badge"
	status={badgeSave.status}
	error={badgeSave.error}
	onRetry={badgeSave.status === 'error' ? badgeSave.retry : undefined}
>
	<input
		class="text-input"
		type="text"
		maxlength="24"
		placeholder={labelSave.value || credentialKey}
		value={badgeSave.value}
		oninput={badgeSave.oninput}
		aria-label="Turf badge"
	/>
	<p class="app-config-note">
		The short text beside this campaign's turf on the map, on a volunteer's turf card and in Slack —
		shown while more than one campaign is enabled, so volunteers know which campaign's VAN a list
		number is from, and on this campaign's turf still being walked after it is disabled. Left empty,
		it uses the name above.
	</p>
</SettingsRow>

<SettingsRow
	id="refresh"
	label="Re-cut regions in VAN"
	status={refreshSave.status}
	error={refreshSave.error}
	onRetry={refreshSave.status === 'error' ? refreshSave.retry : undefined}
>
	<label class="toggle">
		<input type="checkbox" checked={refreshSave.value} onchange={toggle(refreshSave)} />
		<span>Let the sync ask VAN to re-cut this campaign's map regions</span>
	</label>
	<p class="app-config-note">
		A re-cut is how knocked doors leave the counts: after someone finishes a turf, and overnight for
		every mapped folder. But <strong>a re-cut deletes the region's printed lists</strong>: VAN
		replaces every route, the old list numbers stop existing, and the new routes have none until
		someone prints lists for the region again in VAN — the app can't. Until then that turf can't be
		claimed, and any list number already handed out for it is gone. It also re-cuts turf other
		organizers cut, in any shared folder mapped here. Off by default, and only for a campaign that
		has agreed to it.
	</p>
</SettingsRow>

<SettingsRow
	id="sheets"
	label="Google Sheets Packet Tracker"
	status={sheetsSave.status}
	error={sheetsSave.error}
	onRetry={sheetsSave.status === 'error' ? sheetsSave.retry : undefined}
>
	<label class="toggle">
		<input type="checkbox" checked={sheetsSave.value} onchange={toggle(sheetsSave)} />
		<span>Record this campaign's checkouts in its Packet Tracker spreadsheets</span>
	</label>
	<p class="app-config-note">
		Off for a campaign that keeps no Packet Tracker: its turf then never waits on Google. Turning it
		off stops the writes and leaves the spreadsheets as they are.
	</p>
</SettingsRow>

{#if sheetsSave.value}
	<SettingsRow
		label="Packet Tracker tab"
		status={tabSave.status}
		error={tabSave.error}
		onRetry={tabSave.status === 'error' ? tabSave.retry : undefined}
	>
		<input
			class="text-input"
			type="text"
			maxlength="100"
			placeholder={DEFAULT_SHEET_TAB_NAME}
			value={tabSave.value}
			oninput={tabSave.oninput}
			aria-label="Packet Tracker tab name"
		/>
		<p class="app-config-note">
			The tab in every one of this campaign's spreadsheets. The app never creates it. Empty means “{DEFAULT_SHEET_TAB_NAME}”.
		</p>
	</SettingsRow>

	<VanSheetTargetsEditor {campaignId} {targets} {serviceAccountEmail} />
{/if}

<SettingsRow
	id="daily-report"
	label="Nightly door report"
	status={reportSave.status}
	error={reportSave.error}
	onRetry={reportSave.status === 'error' ? reportSave.retry : undefined}
>
	<input
		class="text-input"
		type="text"
		placeholder="Paste the spreadsheet's URL"
		value={reportSave.value}
		oninput={reportSave.oninput}
		aria-label="Nightly door report spreadsheet"
	/>
	<p class="app-config-note">
		At 10pm, a new tab in this spreadsheet lists every turf with doors contacted that day by VAN
		folder, marks the turf checked out through this app, and splits its doors into those knocked
		through the app and outside it, with totals. The turf channel gets the totals and a link. The
		tab is rewritten at 8am with anything MiniVAN synced overnight. Share the spreadsheet with
		{#if serviceAccountEmail}<code>{serviceAccountEmail}</code>{:else}the app's Google service
			account{/if} as an Editor, and keep it for this report alone: the app will not overwrite a tab it
		did not write, so a tab of someone else's named for a date stops that day's report. Empty means no
		report.
	</p>
	{#if reportUrl && reportSave.status !== 'error'}
		<p class="app-config-note">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external Google Sheets link -->
			<a href={reportUrl} target="_blank" rel="noopener noreferrer">Open the report spreadsheet</a>
		</p>
	{/if}
</SettingsRow>

<style>
	.toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.text-input {
		width: min(100%, 24rem);
		padding: var(--space-2) var(--space-3);
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.text-input:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}
</style>
