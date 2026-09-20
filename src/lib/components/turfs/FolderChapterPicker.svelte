<script lang="ts">
	// Which chapters see one VAN folder, edited next to the map of where that
	// folder's turf is.
	//
	// The same van_chapter_folders mapping /settings edits chapter-first. Here
	// it is folder-first, because that is the question the map answers: you can
	// see that R07 is entirely Oakland County, so you can say who gets it
	// without holding a chapter's other folders in your head. The write is
	// scoped to this folder (`action: "save-folder"`), so the two editors cannot
	// overwrite each other's rows.
	//
	// Saved on every pick rather than behind a Save button: a row is one field,
	// the request is small, and an admin who maps six folders and navigates away
	// should not lose five of them.

	import MultiSelectAutocomplete from '$lib/components/settings/MultiSelectAutocomplete.svelte';
	import type { PickerItem } from '$lib/components/settings/picker-types.js';
	import type { AutosaveStatus } from '$lib/components/settings/use-field-autosave.svelte.js';
	import { errMessage } from '$lib/err-message.js';

	export interface ChapterRef {
		chapterId: number;
		chapterName: string;
	}

	interface Props {
		folderId: number;
		folderName: string;
		/** Every chapter that can be picked. Empty when the chapter list failed
		 *  to load — the row then says so rather than offering nothing. */
		chapters: Array<{ id: number; name: string }>;
		/** Chapters already mapped to this folder. */
		selected: ChapterRef[];
		disabled?: boolean;
	}

	let { folderId, folderName, chapters, selected, disabled = false }: Props = $props();

	let picked = $state<ChapterRef[]>([...selected]);
	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;
	/** A save is in flight; the newest selection waits for it rather than racing
	 *  it, so two quick picks cannot land out of order. */
	let inFlight = false;
	let queued = false;

	const values = $derived(picked.map((c) => c.chapterId));
	const items = $derived<PickerItem<number>[]>(chapters.map((c) => ({ id: c.id, label: c.name })));

	$effect(() => () => {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
	});

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	async function save(): Promise<void> {
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		status = 'saving';
		error = null;
		try {
			const res = await fetch('/api/settings/van-chapter-folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'save-folder', folderId, chapters: picked }),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			status = 'saved';
			scheduleDismiss();
		} catch (e) {
			status = 'error';
			error = errMessage(e);
		} finally {
			inFlight = false;
			if (queued) {
				queued = false;
				void save();
			}
		}
	}

	function add(chapterId: number): void {
		const chapter = chapters.find((c) => c.id === chapterId);
		if (!chapter || picked.some((c) => c.chapterId === chapterId)) return;
		picked = [...picked, { chapterId, chapterName: chapter.name }];
		void save();
	}

	function remove(chapterId: number): void {
		picked = picked.filter((c) => c.chapterId !== chapterId);
		void save();
	}
</script>

<div class="folder-chapters">
	{#if chapters.length === 0}
		<p class="unavailable">Chapter list unavailable</p>
	{:else}
		<MultiSelectAutocomplete
			{items}
			{values}
			onAdd={add}
			onRemove={remove}
			{disabled}
			placeholder="Add a chapter…"
		/>
	{/if}
	<p class="status" aria-live="polite">
		{#if status === 'saving'}
			Saving…
		{:else if status === 'saved'}
			Saved
		{:else if status === 'error'}
			<span class="failed">{error}</span>
			<button type="button" onclick={() => void save()}>Retry</button>
		{:else if picked.length === 0}
			<span class="muted">No chapter sees {folderName} yet</span>
		{/if}
	</p>
</div>

<style>
	.folder-chapters {
		min-width: 16rem;
	}

	.status {
		margin: var(--space-1) 0 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.failed {
		color: var(--color-error);
	}

	.muted {
		color: var(--color-text-muted);
	}

	.status button {
		font: inherit;
		color: var(--color-text);
		background: none;
		border: none;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
	}
</style>
