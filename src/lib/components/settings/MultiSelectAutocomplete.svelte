<script lang="ts" generics="TId extends string | number">
	import { Combobox } from 'bits-ui';
	import type { PickerItem } from './picker-types.js';
	import { filterPickerItems } from './picker-logic.js';
	import { diffSelection } from './multi-picker-logic.js';

	interface Props {
		items: PickerItem<TId>[];
		/** Currently selected ids, in display order. Parent-owned state. */
		values: TId[];
		onAdd: (id: TId) => void;
		onRemove: (id: TId) => void;
		placeholder?: string;
		disabled?: boolean;
		showSublabel?: boolean;
		/**
		 * Minimum typed characters before the dropdown lists options. Use for
		 * large item lists (e.g. every workspace user) where rendering the whole
		 * list on open would be noise; 0 (default) lists everything immediately.
		 */
		minChars?: number;
		/**
		 * Selected ids that cannot be removed here (e.g. your own admin entry).
		 * Their chips render a disabled ×, Backspace skips them, and dropdown
		 * deselection is ignored — onRemove never fires for a locked id.
		 */
		lockedValues?: TId[];
		/** Tooltip shown on a locked chip's disabled × button. */
		lockedReason?: string;
		/**
		 * When set, each chip renders a checkbox for a per-value flag (e.g.
		 * "post the welcome message in this channel"). Purely presentational
		 * here — the parent owns the flag state and persistence.
		 */
		chipCheckbox?: {
			isChecked: (id: TId) => boolean;
			onToggle: (id: TId, checked: boolean) => void;
			/** Tooltip + accessible label, given the chip's display label. */
			label: (chipLabel: string) => string;
		};
	}

	let {
		items,
		values,
		onAdd,
		onRemove,
		placeholder = '',
		disabled = false,
		showSublabel = false,
		minChars = 0,
		lockedValues = [],
		lockedReason = 'This entry can’t be removed',
		chipCheckbox = undefined,
	}: Props = $props();

	// The ONLY source of what the text box shows. bits-ui keeps an inputValue of
	// its own and, in multiple mode, writes the picked item's label into it
	// *after* onValueChange returns — so clearing here used to be overwritten,
	// leaving stale text in the box while this read '' and Backspace deleted the
	// chip just added. The input below renders this value instead of bits-ui's.
	let inputText = $state('');

	const stringValues = $derived(values.map((v) => String(v)));

	// Chips render the item's label; a selected id that has dropped out of the
	// live list (e.g. an archived channel still mapped in the DB) falls back to
	// its raw id so it stays visible and removable.
	const selectedChips = $derived(
		values.map((v) => {
			const item = items.find((i) => i.id === v);
			return { id: v, label: item?.label ?? String(v), locked: lockedValues.includes(v) };
		}),
	);

	const query = $derived(inputText.trim());
	const belowMinChars = $derived(query.length < minChars);

	const filteredItems = $derived(
		belowMinChars ? [] : query === '' ? items : filterPickerItems(items, inputText),
	);

	function handleValueChange(rawIds: string[]): void {
		const { added, removed } = diffSelection(stringValues, rawIds);
		for (const raw of added) {
			const item = items.find((i) => String(i.id) === raw);
			if (item) onAdd(item.id);
		}
		for (const raw of removed) {
			const prev = values.find((v) => String(v) === raw);
			if (prev !== undefined && !lockedValues.includes(prev)) onRemove(prev);
		}
		// Reset the filter so the next dropdown open shows the full list again.
		inputText = '';
	}

	function handleKeydown(e: KeyboardEvent): void {
		// Backspace in an empty input removes the last removable chip — standard
		// multi-select affordance, skipping locked entries.
		if (e.key === 'Backspace' && inputText === '') {
			const last = [...values].reverse().find((v) => !lockedValues.includes(v));
			if (last !== undefined) onRemove(last);
		}
	}
</script>

<Combobox.Root type="multiple" value={stringValues} onValueChange={handleValueChange} {disabled}>
	<div class="mpicker-row" class:mpicker-disabled={disabled}>
		{#each selectedChips as chip (chip.id)}
			<span class="mpicker-chip" class:mpicker-chip-locked={chip.locked}>
				{#if chipCheckbox}
					<input
						type="checkbox"
						class="mpicker-chip-checkbox"
						checked={chipCheckbox.isChecked(chip.id)}
						{disabled}
						title={chipCheckbox.label(chip.label)}
						aria-label={chipCheckbox.label(chip.label)}
						onchange={(e) => chipCheckbox.onToggle(chip.id, e.currentTarget.checked)}
					/>
				{/if}
				<span class="mpicker-chip-label">{chip.label}</span>
				<button
					type="button"
					class="mpicker-chip-remove"
					aria-label="Remove {chip.label}"
					disabled={disabled || chip.locked}
					title={chip.locked ? lockedReason : undefined}
					onclick={() => {
						if (!chip.locked) onRemove(chip.id);
					}}
				>
					×
				</button>
			</span>
		{/each}
		<Combobox.Input
			oninput={(e) => {
				inputText = (e.currentTarget as HTMLInputElement).value;
			}}
			onkeydown={handleKeydown}
			onblur={() => {
				// No free-text commit on blur — the input is only ever a filter.
				inputText = '';
			}}
			placeholder={values.length === 0 ? placeholder : ''}
			class="mpicker-input"
		>
			{#snippet child({ props })}
				<!-- `value` after the spread, so it overrides bits-ui's (see inputText). -->
				<input {...props} value={inputText} />
			{/snippet}
		</Combobox.Input>
		<Combobox.Trigger class="mpicker-trigger" aria-label="Open dropdown">▾</Combobox.Trigger>
	</div>
	<Combobox.Portal>
		<Combobox.Content class="mpicker-content">
			{#if belowMinChars}
				<div class="mpicker-empty">
					Type at least {minChars} character{minChars === 1 ? '' : 's'} to search
				</div>
			{:else if filteredItems.length === 0}
				<div class="mpicker-empty">No matches</div>
			{:else}
				{#each filteredItems as item (item.id)}
					<Combobox.Item
						value={String(item.id)}
						label={item.label}
						data-selected={values.includes(item.id) ? 'true' : undefined}
						class="mpicker-item"
					>
						<span class="mpicker-item-check" aria-hidden="true">
							{values.includes(item.id) ? '✓' : ''}
						</span>
						<span class="mpicker-item-text">
							<span class="mpicker-item-label">{item.label}</span>
							{#if showSublabel && item.sublabel}
								<span class="mpicker-item-sublabel">{item.sublabel}</span>
							{/if}
						</span>
					</Combobox.Item>
				{/each}
			{/if}
		</Combobox.Content>
	</Combobox.Portal>
</Combobox.Root>

<style>
	.mpicker-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
	}

	.mpicker-disabled {
		opacity: 0.6;
	}

	.mpicker-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 4px 2px 8px;
		background: var(--color-bg-hover);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		font-size: 0.9em;
	}

	.mpicker-chip-checkbox {
		margin: 0;
		accent-color: var(--color-gold);
		cursor: pointer;
	}

	.mpicker-chip-checkbox:disabled {
		cursor: not-allowed;
	}

	.mpicker-chip-remove {
		border: none;
		background: transparent;
		padding: 0 4px;
		font: inherit;
		line-height: 1;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.mpicker-chip-remove:hover:not(:disabled),
	.mpicker-chip-remove:focus-visible {
		color: var(--color-error);
	}

	.mpicker-chip-locked .mpicker-chip-remove {
		opacity: 0.4;
		cursor: not-allowed;
	}

	:global(.mpicker-input) {
		flex: 1;
		min-width: 140px;
		border: none;
		background: transparent;
		padding: 4px 6px;
		font: inherit;
		color: inherit;
		outline: none;
	}

	:global(.mpicker-trigger) {
		border: none;
		background: transparent;
		padding: 0 8px;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	:global(.mpicker-content) {
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-popover);
		padding: 4px;
		max-height: 240px;
		overflow-y: auto;
		min-width: var(--bits-combobox-anchor-width, 220px);
		z-index: 50;
	}

	.mpicker-empty {
		padding: 8px 10px;
		color: var(--color-text-muted);
		font-style: italic;
	}

	:global(.mpicker-item) {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	:global(.mpicker-item[data-highlighted]) {
		background: var(--color-bg-hover);
	}

	:global(.mpicker-item[data-selected='true']) {
		font-weight: 600;
		color: var(--color-gold);
	}

	.mpicker-item-check {
		display: inline-block;
		width: 1em;
	}

	.mpicker-item-text {
		display: flex;
		flex-direction: column;
	}

	.mpicker-item-sublabel {
		font-size: 0.85em;
		color: var(--color-text-muted);
	}
</style>
