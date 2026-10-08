<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AlertDialog } from 'bits-ui';
	import { errMessage } from '$lib/err-message.js';

	interface Props {
		label: string;
		description: string;
		onConfirm: () => Promise<void> | void;
		disabled?: boolean;
		/** `danger` (the default) is for removing something; `neutral` is for a
		 *  consequential switch that undoes cleanly, like disabling a campaign. */
		tone?: 'danger' | 'neutral';
		/** The confirm button's text; the trigger's label by default. */
		confirmLabel?: string;
		/** Drawn in the trigger in place of `label`, which becomes its
		 *  accessible name. */
		icon?: Snippet;
	}

	let {
		label,
		description,
		onConfirm,
		disabled = false,
		tone = 'danger',
		confirmLabel,
		icon,
	}: Props = $props();

	let open = $state(false);
	let error: string | null = $state(null);
	let pending = $state(false);

	async function handleConfirm() {
		pending = true;
		error = null;
		try {
			await onConfirm();
			open = false;
		} catch (e) {
			error = errMessage(e);
			open = false;
		} finally {
			pending = false;
		}
	}
</script>

<div class="delete-confirm">
	<AlertDialog.Root bind:open>
		<AlertDialog.Trigger
			class={['delete-confirm-trigger', tone === 'neutral' && 'neutral', icon && 'icon']}
			{disabled}
			aria-label={icon ? label : undefined}
			title={icon ? label : undefined}
			onclick={() => {
				error = null;
			}}
		>
			{#if icon}{@render icon()}{:else}{label}{/if}
		</AlertDialog.Trigger>
		<AlertDialog.Portal>
			<AlertDialog.Overlay class="delete-confirm-overlay" />
			<AlertDialog.Content class="delete-confirm-content">
				<AlertDialog.Title class="delete-confirm-title">Confirm</AlertDialog.Title>
				<AlertDialog.Description class="delete-confirm-description">
					{description}
				</AlertDialog.Description>
				<div class="delete-confirm-actions">
					<AlertDialog.Cancel class="delete-confirm-cancel">Cancel</AlertDialog.Cancel>
					<AlertDialog.Action
						class={['delete-confirm-action', tone === 'neutral' && 'neutral']}
						onclick={handleConfirm}
						disabled={pending}
					>
						{pending ? 'Working…' : (confirmLabel ?? label)}
					</AlertDialog.Action>
				</div>
			</AlertDialog.Content>
		</AlertDialog.Portal>
	</AlertDialog.Root>
	{#if error}
		<span class="delete-confirm-error" role="alert">{error}</span>
	{/if}
</div>

<style>
	.delete-confirm {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	:global(.delete-confirm-trigger) {
		background: transparent;
		color: var(--color-error);
		border: 1px solid currentColor;
		border-radius: var(--radius-sm);
		padding: 4px 10px;
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}

	:global(.delete-confirm-trigger.icon) {
		display: inline-flex;
		align-items: center;
		border-color: transparent;
		padding: 4px;
	}

	:global(.delete-confirm-trigger:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--color-error) 8%, transparent);
	}

	:global(.delete-confirm-trigger:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}

	:global(.delete-confirm-overlay) {
		position: fixed;
		inset: 0;
		background: var(--color-scrim);
		z-index: 100;
	}

	:global(.delete-confirm-content) {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		background: var(--color-bg-surface);
		border-radius: var(--radius-md);
		padding: 20px 24px;
		min-width: 320px;
		max-width: 90vw;
		box-shadow: var(--shadow-modal);
		z-index: 101;
	}

	:global(.delete-confirm-title) {
		margin: 0 0 8px;
		font-size: 1.05em;
		font-weight: 600;
	}

	:global(.delete-confirm-description) {
		margin: 0 0 16px;
		color: var(--color-text);
	}

	.delete-confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	:global(.delete-confirm-cancel) {
		background: transparent;
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 4px 12px;
		font: inherit;
		cursor: pointer;
	}

	:global(.delete-confirm-action) {
		background: var(--color-error);
		color: white;
		border: 1px solid var(--color-error);
		border-radius: var(--radius-sm);
		padding: 4px 12px;
		font: inherit;
		cursor: pointer;
	}

	:global(.delete-confirm-trigger.neutral) {
		color: var(--color-text);
		border-color: var(--color-border);
	}

	:global(.delete-confirm-trigger.neutral:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--color-text) 6%, transparent);
	}

	:global(.delete-confirm-action.neutral) {
		background: var(--color-text);
		border-color: var(--color-text);
		color: var(--color-bg-surface);
	}

	:global(.delete-confirm-action:disabled) {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.delete-confirm-error {
		font-size: 0.85em;
		color: var(--color-error);
	}
</style>
