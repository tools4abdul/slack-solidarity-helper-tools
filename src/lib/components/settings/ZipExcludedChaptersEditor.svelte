<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	/** Mirrors SolidarityChapterEntry from $lib/server/autocomplete-sources.ts. */
	interface ChapterOption {
		id: number;
		name: string;
	}

	interface Props {
		chapters: ChapterOption[];
		/** Currently excluded chapter ids from loadSettings. */
		excludedIds: number[];
	}

	let { chapters, excludedIds }: Props = $props();

	// Local mirror of the exclusion list, updated optimistically per op and
	// reverted if the save fails. A chip whose chapter has vanished from the
	// live list (deleted in Solidarity) falls back to its raw id inside
	// MultiSelectAutocomplete and stays removable — which matters more here than
	// for report exclusions, since the chapters worth excluding from zips are
	// exactly the ones on their way out.
	let excluded = $state<number[]>([...excludedIds]);

	const chapterItems = $derived<PickerItem<number>[]>(
		chapters.map((c) => ({ id: c.id, label: c.name })),
	);

	// --- Save flow — same optimistic/revert/retry shape as AllowedUsersEditor.

	interface Op {
		action: 'add' | 'remove';
		chapterId: number;
	}

	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let lastFailedOp: Op | null = $state(null);
	let inflight = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	function applyLocal(op: Op): boolean {
		if (op.action === 'add') {
			if (excluded.includes(op.chapterId)) return false;
			excluded = [...excluded, op.chapterId];
			return true;
		}
		if (!excluded.includes(op.chapterId)) return false;
		excluded = excluded.filter((id) => id !== op.chapterId);
		return true;
	}

	function revertLocal(op: Op): void {
		if (op.action === 'add') {
			excluded = excluded.filter((id) => id !== op.chapterId);
		} else if (!excluded.includes(op.chapterId)) {
			excluded = [...excluded, op.chapterId];
		}
	}

	async function runOp(op: Op): Promise<void> {
		const changed = applyLocal(op);
		status = 'saving';
		error = null;
		inflight++;
		try {
			const res = await fetch('/api/settings/zip-excluded-chapters', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(op),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			lastFailedOp = null;
			if (--inflight === 0 && status === 'saving') {
				status = 'saved';
				scheduleDismiss();
			}
		} catch (e) {
			inflight--;
			if (changed) revertLocal(op);
			status = 'error';
			error = errMessage(e);
			lastFailedOp = op;
		}
	}

	function retry(): void {
		if (!lastFailedOp) return;
		void runOp(lastFailedOp);
	}
</script>

<div class="zip-excluded-chapters-editor">
	<p class="zip-excluded-chapters-intro">
		Chapters listed here are never assigned a ZIP code. The ZIP → chapter map is derived from where
		members live, so a superseded chapter that still holds members can out-vote the chapters that
		replaced it — use this for a retired statewide or regional chapter. The ZIP goes to the
		<strong>next chapter with members there</strong> rather than being left unmapped, and a ZIP with no
		other chapter falls back to the channel a volunteer is posting in.
	</p>
	<p class="zip-excluded-chapters-intro">
		This is separate from <strong>Excluded chapters</strong> above, which is about reports. Changes take
		effect on the next membership sync, within a day.
	</p>
	<SettingsRow
		label="Never assigned ZIP codes"
		{status}
		{error}
		onRetry={lastFailedOp ? retry : undefined}
	>
		<MultiSelectAutocomplete
			items={chapterItems}
			values={excluded}
			onAdd={(id) => void runOp({ action: 'add', chapterId: id })}
			onRemove={(id) => void runOp({ action: 'remove', chapterId: id })}
			placeholder="Exclude a chapter from ZIP mapping…"
		/>
	</SettingsRow>
</div>

<style>
	.zip-excluded-chapters-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.zip-excluded-chapters-intro {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 0 0 4px;
	}
</style>
