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
	let draftLabel = $state('');
	let draftSheet = $state('');

	const canAdd = $derived(
		draftPrefix.trim() !== '' && draftLabel.trim() !== '' && draftSheet.trim() !== '',
	);

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
		const label = draftLabel.trim();
		const spreadsheetId = draftSheet.trim();
		draftPrefix = '';
		draftLabel = '';
		draftSheet = '';
		void post({ action: 'save', prefix, label, spreadsheetId });
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
			<ul class="target-list">
				{#each rows as row (row.prefixKey)}
					<li class="target-row">
						<code class="prefix">{row.prefix}</code>
						<span class="label">{row.label}</span>
						<code class="sheet-id" title={row.spreadsheetId}>{row.spreadsheetId}</code>
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
				placeholder="R10C_Wayne_Taylor"
				aria-label="Region name prefix"
				bind:value={draftPrefix}
			/>
			<input
				class="field"
				type="text"
				placeholder="R10C_Downriver CR"
				aria-label="Spreadsheet name"
				bind:value={draftLabel}
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

	.target-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
	}

	.prefix,
	.sheet-id {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sheet-id {
		color: var(--color-text-muted);
	}

	.label {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.add-target {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
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
		.target-row,
		.add-target {
			grid-template-columns: 1fr auto;
		}

		.sheet-id,
		.field {
			grid-column: 1 / -1;
		}
	}
</style>
