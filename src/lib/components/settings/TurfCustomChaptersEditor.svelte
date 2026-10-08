<script lang="ts">
	// Turf-only chapters: names an admin adds by hand, which /turfs offers and
	// VAN folders can be mapped to like any Solidarity chapter. Adding waits for
	// the server, which assigns the (negative) id; removing asks first, because
	// it also unmaps every folder the entry had, and applies optimistically.
	import { untrack } from 'svelte';
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import DeleteConfirmButton from './DeleteConfirmButton.svelte';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface CustomChapter {
		chapterId: number;
		name: string;
	}

	interface Props {
		/** The current entries, from loadSettings. */
		chapters: CustomChapter[];
	}

	let { chapters }: Props = $props();

	const ENDPOINT = '/api/settings/turf-custom-chapters';

	let entries = $state<CustomChapter[]>(untrack(() => [...chapters]));
	let draft = $state('');
	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function sorted(list: CustomChapter[]): CustomChapter[] {
		return [...list].sort((a, b) => a.name.localeCompare(b.name));
	}

	function saved(): void {
		status = 'saved';
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	async function post(body: unknown): Promise<{ chapter?: CustomChapter }> {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const parsed = (await res.json().catch(() => null)) as {
			error?: string;
			chapter?: CustomChapter;
		} | null;
		if (!res.ok) throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
		return parsed ?? {};
	}

	async function add(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const name = draft.trim();
		if (name === '' || status === 'saving') return;
		status = 'saving';
		error = null;
		try {
			const { chapter } = await post({ action: 'add', name });
			if (chapter) entries = sorted([...entries, chapter]);
			draft = '';
			saved();
		} catch (e) {
			status = 'error';
			error = errMessage(e);
		}
	}

	async function remove(chapter: CustomChapter): Promise<void> {
		entries = entries.filter((c) => c.chapterId !== chapter.chapterId);
		status = 'saving';
		error = null;
		try {
			await post({ action: 'remove', chapterId: chapter.chapterId });
			saved();
		} catch (e) {
			entries = sorted([...entries, chapter]);
			status = 'error';
			error = errMessage(e);
		}
	}
</script>

<div class="turf-custom-chapters-editor">
	<p class="turf-custom-chapters-intro">
		Extra chapters for turf only — a team or an area with no Solidarity chapter of its own. Each one
		is offered on <strong>/turfs</strong> and the Slack <code>/turfs</code> command, and can be given
		VAN folders on a campaign's settings page or on the folder map, like any other chapter. It has no
		Slack channel. On the doors board, a folder's doors go to a real chapter mapped to it when there is
		one, and to a custom chapter only when nothing else is mapped there.
	</p>
	<SettingsRow label="Custom chapters" {status} {error}>
		{#if entries.length > 0}
			<ul class="turf-custom-chapters-list">
				{#each entries as chapter (chapter.chapterId)}
					<li>
						<span class="turf-custom-chapters-name">{chapter.name}</span>
						<DeleteConfirmButton
							label="Remove {chapter.name}"
							description="Remove “{chapter.name}”? It disappears from /turfs, and every VAN folder mapped to it is unmapped from it, in every campaign. Turf in a folder mapped only to it stops being offered to anyone and stops syncing, and keeps this name on the doors board until the folder is mapped again."
							onConfirm={() => remove(chapter)}
						>
							{#snippet icon()}
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M3 6h18" />
									<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
									<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
									<path d="M10 11v6" />
									<path d="M14 11v6" />
								</svg>
							{/snippet}
						</DeleteConfirmButton>
					</li>
				{/each}
			</ul>
		{/if}
		<form class="turf-custom-chapters-add" onsubmit={add}>
			<input
				type="text"
				bind:value={draft}
				maxlength="200"
				placeholder="New chapter name…"
				aria-label="New custom chapter name"
			/>
			<button type="submit" disabled={draft.trim() === '' || status === 'saving'}>Add</button>
		</form>
	</SettingsRow>
</div>

<style>
	.turf-custom-chapters-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.turf-custom-chapters-intro {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 0 0 4px;
	}

	.turf-custom-chapters-list {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
	}

	.turf-custom-chapters-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 0;
		border-bottom: 1px solid var(--color-border);
	}

	.turf-custom-chapters-name {
		overflow-wrap: anywhere;
	}

	.turf-custom-chapters-add {
		display: flex;
		gap: 8px;
	}

	.turf-custom-chapters-add input {
		flex: 1;
		min-width: 0;
		font: inherit;
		padding: 6px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		color: var(--color-text);
	}

	.turf-custom-chapters-add button {
		font: inherit;
		font-size: 0.9em;
		padding: 4px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
		cursor: pointer;
	}

	.turf-custom-chapters-add button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
