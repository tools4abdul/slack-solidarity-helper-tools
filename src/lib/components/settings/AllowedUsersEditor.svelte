<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	/** Mirrors UserEntry from $lib/server/autocomplete-sources.ts. */
	interface UserOption {
		id: string;
		name: string;
		realName: string;
	}

	interface Props {
		/** Which list this edits. Admins and moderators are the same shape — a
		 *  set of Slack users — kept in separate tables behind separate
		 *  endpoints. */
		kind?: 'admins' | 'moderators';
		users: UserOption[];
		/** Current ids for this list, from loadSettings. */
		allowedIds: string[];
		/** The signed-in admin's own Slack id — on the admin list their chip is
		 *  locked so they can't attempt to remove themselves (the endpoint
		 *  enforces it too). Irrelevant to the moderator list. */
		selfId: string;
	}

	let { kind = 'admins', users, allowedIds, selfId }: Props = $props();

	const config = $derived(
		kind === 'admins'
			? {
					label: 'Admins',
					endpoint: '/api/settings/allowed-users',
					placeholder: 'Add an admin…',
					locked: [selfId],
				}
			: {
					label: 'Moderators',
					endpoint: '/api/settings/moderators',
					placeholder: 'Add a moderator…',
					locked: [],
				},
	);

	// Local mirror of the allowlist, updated optimistically per op and reverted
	// if the save fails. Chip labels resolve against the live user list; an id
	// that has dropped out of it (deactivated user) falls back to the raw id
	// inside MultiSelectAutocomplete and stays removable.
	let allowed = $state<string[]>([...allowedIds]);

	const userItems = $derived<PickerItem<string>[]>(
		users.map((u) => ({
			id: u.id,
			label: u.name,
			sublabel: u.realName && u.realName !== u.name ? u.realName : undefined,
		})),
	);

	// --- Save flow — same optimistic/revert/retry shape as ChapterChannelEditor.

	interface Op {
		action: 'add' | 'remove';
		userId: string;
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

	/** Apply locally; returns whether anything changed so a failed save reverts
	 *  exactly this op's effect. */
	function applyLocal(op: Op): boolean {
		if (op.action === 'add') {
			if (allowed.includes(op.userId)) return false;
			allowed = [...allowed, op.userId];
			return true;
		}
		if (!allowed.includes(op.userId)) return false;
		allowed = allowed.filter((id) => id !== op.userId);
		return true;
	}

	function revertLocal(op: Op): void {
		if (op.action === 'add') {
			allowed = allowed.filter((id) => id !== op.userId);
		} else if (!allowed.includes(op.userId)) {
			allowed = [...allowed, op.userId];
		}
	}

	async function runOp(op: Op): Promise<void> {
		// Belt-and-braces alongside the locked chip: never even attempt a
		// self-removal (the endpoint would 400 it anyway).
		if (op.action === 'remove' && config.locked.includes(op.userId)) return;
		const changed = applyLocal(op);
		status = 'saving';
		error = null;
		inflight++;
		try {
			const res = await fetch(config.endpoint, {
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

<div class="allowed-users-editor">
	<SettingsRow label={config.label} {status} {error} onRetry={lastFailedOp ? retry : undefined}>
		<MultiSelectAutocomplete
			items={userItems}
			values={allowed}
			onAdd={(id) => void runOp({ action: 'add', userId: id })}
			onRemove={(id) => void runOp({ action: 'remove', userId: id })}
			placeholder={config.placeholder}
			showSublabel={true}
			minChars={3}
			lockedValues={config.locked}
			lockedReason="You can’t remove yourself"
		/>
		<p class="allowed-users-note">
			{#if kind === 'admins'}
				Admins can access /pending and /settings. Changes take effect at the person’s next sign-in.
				The <code>SLACK_SUPERUSER_ID</code> user always has access, and you can’t remove yourself.
			{:else}
				Moderators can use the Slack commands — <code>/member-note</code>, the info commands,
				<code>/list-commands</code>, and both message shortcuts — and read the member lookup page,
				but can’t link accounts or open any other admin page. In Slack, changes apply immediately;
				on the web, at the person’s next sign-in. Info commands post as the person running them, so
				each moderator must sign in to this site once before those work.
			{/if}
		</p>
	</SettingsRow>
</div>

<style>
	.allowed-users-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.allowed-users-note {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 8px 0 0;
	}

	.allowed-users-note code {
		font-size: 0.95em;
	}
</style>
