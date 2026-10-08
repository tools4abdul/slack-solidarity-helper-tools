<script lang="ts">
	// A "remove this" button that asks first. The confirm dialog itself is
	// ConfirmButton; this keeps the destructive styling its callers rely on.
	import type { Snippet } from 'svelte';
	import ConfirmButton from './ConfirmButton.svelte';

	interface Props {
		label: string;
		description: string;
		onConfirm: () => Promise<void> | void;
		disabled?: boolean;
		/** See ConfirmButton: an icon in place of the label. */
		icon?: Snippet;
	}

	let { label, description, onConfirm, disabled = false, icon }: Props = $props();
</script>

<ConfirmButton {label} {description} {onConfirm} {disabled} {icon} tone="danger" />
