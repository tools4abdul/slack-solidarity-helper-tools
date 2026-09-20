<script lang="ts">
	// Which of the campaign's spreadsheets each region's turf checkouts are
	// logged to.
	//
	// Rules are matched by LONGEST prefix, so the order they are entered in does
	// not matter and the list is shown longest-first — which is also the order
	// they are evaluated in, so what an admin reads top to bottom is what the
	// matcher does. `R10C_Wayne_Taylor` beats a bare `R10C` catch-all.
	//
	// The spreadsheet field takes a pasted URL as well as a bare id, because a
	// URL is what is actually on someone's clipboard. The server extracts the id.
	//
	// Nothing here is checked against Google: there may be no credential yet,
	// and this has to be fillable before one exists — the same reasoning as the
	// chapter → folder editor above it. A wrong id surfaces as a failed write
	// with an operator alert, not as anything unsafe.

	import { resolve } from '$app/paths';
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import DeleteConfirmButton from './DeleteConfirmButton.svelte';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface TargetEntry {
		prefix: string;
		prefixKey: string;
		label: string;
		spreadsheetId: string;
	}

	interface Props {
		/** From loadVanSheetTargets — already longest-prefix-first. */
		targets: TargetEntry[];
		/** The address every spreadsheet has to be shared with. Null when the
		 *  credential is not configured. */
		serviceAccountEmail: string | null;
	}

	let { targets, serviceAccountEmail }: Props = $props();

	let rows = $state<TargetEntry[]>(targets.map((t) => ({ ...t })));
	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	let draftPrefix = $state('');
	let draftSheet = $state('');

	const canAdd = $derived(draftPrefix.trim() !== '' && draftSheet.trim() !== '');

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	async function post(body: unknown): Promise<void> {
		status = 'saving';
		error = null;
		try {
			const res = await fetch('/api/settings/van-sheet-targets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const parsed = (await res.json().catch(() => null)) as {
				error?: string;
				targets?: TargetEntry[];
			} | null;
			if (!res.ok) throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			// The server returns the stored set, so the list reflects what is
			// actually saved — including a normalised prefix that collided with an
			// existing rule and replaced it rather than being added beside it.
			if (parsed?.targets) rows = parsed.targets;
			status = 'saved';
			scheduleDismiss();
		} catch (e) {
			status = 'error';
			error = errMessage(e);
		}
	}

	function addTarget(): void {
		if (!canAdd) return;
		const prefix = draftPrefix.trim();
		const spreadsheetId = draftSheet.trim();
		draftPrefix = '';
		draftSheet = '';
		// No name: the server reads the spreadsheet's own title from Google and
		// stores it, so the two can never disagree.
		void post({ action: 'save', prefix, spreadsheetId });
	}

	function removeTarget(prefixKey: string): void {
		rows = rows.filter((r) => r.prefixKey !== prefixKey);
		void post({ action: 'remove', prefixKey });
	}

	$effect(() => () => {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
	});
</script>

<div class="van-sheet-targets-editor">
	<SettingsRow label="Region → checkout spreadsheet" {status} {error}>
		{#if rows.length > 0}
			<!-- Visual only: this is a list, not a table, so a screen reader gets
			     nothing from column positions. The remove button names the rule it
			     would delete, which is what actually carries the context there. -->
			<div class="target-header" aria-hidden="true">
				<span>Region name prefix</span>
				<span>Spreadsheet</span>
				<span></span>
			</div>
			<ul class="target-list">
				{#each rows as row (row.prefixKey)}
					<li class="target-row">
						<code class="prefix">{row.prefix}</code>
						<!-- The id is the href and the tooltip rather than a column of its
						     own: it identifies the sheet to the app, but it tells a person
						     nothing, and a 44-character string is most of the row. -->
						<a
							class="sheet"
							class:unresolved={row.label === row.spreadsheetId}
							href="https://docs.google.com/spreadsheets/d/{row.spreadsheetId}"
							target="_blank"
							rel="noreferrer"
							title={row.label === row.spreadsheetId
								? `${row.spreadsheetId} — name not read from Google yet; save this rule again to retry`
								: row.spreadsheetId}
						>
							{row.label}
						</a>
						<DeleteConfirmButton
							label="Remove"
							description="Remove the rule for {row.prefix}? Checkouts it covers stop reaching {row.label} and wait for a new rule."
							onConfirm={() => removeTarget(row.prefixKey)}
						/>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="add-target">
			<input
				class="field"
				type="text"
				placeholder="Region name prefix"
				aria-label="Region name prefix"
				bind:value={draftPrefix}
			/>
			<input
				class="field"
				type="text"
				placeholder="Spreadsheet URL or id"
				aria-label="Spreadsheet URL or id"
				bind:value={draftSheet}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						addTarget();
					}
				}}
			/>
			<button class="add-button" type="button" disabled={!canAdd} onclick={addTarget}>Add</button>
		</div>

		<p class="note">
			The <strong>region name prefix</strong> is matched against the start of a turf's VAN region
			name, ignoring case and whether it is written with dots or underscores — so
			<code>R10C</code> covers <code>R10C_Wayne_TaylorCity004_9.18</code>, and a longer
			<code>R01A_Alger</code> covers only that county's share of R01A. Run
			<code>npm run van:regions</code> to list the names to write rules against. The spreadsheet's own
			name is read from Google when you save and shown above; until it can be reached, its id stands in.
		</p>

		<p class="note">
			The longest matching prefix wins, so a rule for one city beats a catch-all for its region
			code. Rules are listed in the order they are tried. A region matching no rule has its
			checkouts held — not dropped — and is named in the turf sync's Slack alert.
			<a href={resolve('/turfs/sheet-map')}>Check where every region routes →</a>
		</p>

		{#if serviceAccountEmail}
			<p class="note">
				Share every spreadsheet above with <code>{serviceAccountEmail}</code> as an Editor, or the app
				cannot write to it.
			</p>
		{:else}
			<p class="note note-warn">
				No Google credential is configured, so nothing is being written yet. Set
				<code>GOOGLE_SHEETS_SERVICE_ACCOUNT</code> to switch the log on — these rules can be filled in
				first.
			</p>
		{/if}
	</SettingsRow>
</div>

<style>
	.van-sheet-targets-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.target-list {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.target-header,
	.target-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
		align-items: center;
		gap: 10px;
	}

	.target-header {
		margin-bottom: 6px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-muted);
		font-size: 0.85em;
		font-weight: 600;
	}

	/* The header spans a column the remove button occupies, so reserve the same
	   width rather than letting the three labels drift out of line with the
	   values under them. */
	.target-header > span:last-child {
		min-width: 4.5rem;
	}

	.prefix {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sheet {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	/* Still showing an id means the name could not be read. Monospace and muted
	   so it reads as a fallback rather than as a sheet someone named that. */
	.sheet.unresolved {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85em;
		font-weight: 400;
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.add-target {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
		gap: 10px;
	}

	.field {
		width: 100%;
		padding: 6px 8px;
		font-size: var(--font-size-md);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.field:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}

	.add-button {
		padding: 6px 14px;
		font-size: var(--font-size-md);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.add-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.note {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 8px 0 0;
	}

	.note-warn {
		color: var(--color-text);
	}

	@media (max-width: 560px) {
		/* The row collapses to two columns with the id wrapped underneath, so the
		   header no longer describes what is beneath it. */
		.target-header {
			display: none;
		}

		.target-row,
		.add-target {
			grid-template-columns: 1fr auto;
		}

		/* Full width on its own line, so a long sheet name is not squeezed into
		   an auto column beside the prefix. Same shape the chapter → folder
		   editor uses for its folder-id input. */
		.sheet,
		.field {
			grid-column: 1 / -1;
		}
	}
</style>
