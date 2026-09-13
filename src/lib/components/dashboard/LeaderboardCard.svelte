<script module lang="ts">
	export type LeaderboardTab = 'lastWeek' | 'thisWeek';
</script>

<script
	lang="ts"
	generics="TLeaderboard extends { windowStart: string; windowEnd: string }, TEntry"
>
	// Shared shell for the weekly leaderboards (Slack signups, doors knocked):
	// the tab toggle, window line, total line, and ranked top-5 list with the
	// 🏆 winner treatment. The data-specific parts — total sentence, empty
	// message, row title and metrics — come in as snippets from the wrapper.
	import type { Snippet } from 'svelte';

	type Result = { ok: true; leaderboard: TLeaderboard } | { ok: false; error: string };

	type Props = {
		title: string;
		thisWeek: Result;
		lastWeek: Result;
		entriesOf: (lb: TLeaderboard) => readonly TEntry[];
		rowKey: (entry: TEntry) => string | number;
		rowName: (entry: TEntry) => string;
		total: Snippet<[TLeaderboard, LeaderboardTab]>;
		empty: Snippet<[LeaderboardTab]>;
		metrics: Snippet<[TEntry]>;
	};

	let { title, thisWeek, lastWeek, entriesOf, rowKey, rowName, total, empty, metrics }: Props =
		$props();

	let tab = $state<LeaderboardTab>('thisWeek');
	const active = $derived(tab === 'lastWeek' ? lastWeek : thisWeek);

	const headingId = $derived('leaderboard-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

	function fmtDate(iso: string): string {
		return iso.slice(0, 10);
	}
</script>

<aside class="leaderboard" aria-labelledby={headingId}>
	<h2 id={headingId} class="leaderboard__title">{title}</h2>
	<div class="leaderboard__tabs" role="group" aria-label="Leaderboard window">
		<button
			type="button"
			class="leaderboard__tab"
			class:active={tab === 'thisWeek'}
			aria-pressed={tab === 'thisWeek'}
			onclick={() => (tab = 'thisWeek')}
		>
			This week so far
		</button>
		<button
			type="button"
			class="leaderboard__tab"
			class:active={tab === 'lastWeek'}
			aria-pressed={tab === 'lastWeek'}
			onclick={() => (tab = 'lastWeek')}
		>
			Last week
		</button>
	</div>
	{#if active.ok}
		{@const lb = active.leaderboard}
		{@const entries = entriesOf(lb)}
		<p class="leaderboard__window">
			{fmtDate(lb.windowStart)} → {fmtDate(lb.windowEnd)}
		</p>
		<p class="leaderboard__total">
			{@render total(lb, tab)}
		</p>
		{#if entries.length === 0}
			<p class="leaderboard__empty">
				{@render empty(tab)}
			</p>
		{:else}
			<ol class="leaderboard__list">
				{#each entries as entry, i (rowKey(entry))}
					<li class="leaderboard__row" class:winner={i === 0}>
						<div class="leaderboard__rank">
							{i === 0 ? '🏆' : `#${i + 1}`}
						</div>
						<div class="leaderboard__details">
							<div class="leaderboard__chapter">{rowName(entry)}</div>
							<div class="leaderboard__metrics">
								{@render metrics(entry)}
							</div>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	{:else}
		<p class="leaderboard__error">{active.error}</p>
	{/if}
</aside>

<style>
	.leaderboard {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.5rem;
		box-shadow: var(--shadow-card);
		margin-top: 1rem;
	}
	.leaderboard__title {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--color-text);
	}
	.leaderboard__tabs {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface);
		margin: 0 0 0.75rem;
	}
	.leaderboard__tab {
		appearance: none;
		background: transparent;
		border: 0;
		padding: 0.35rem 0.75rem;
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		cursor: pointer;
		border-right: 1px solid var(--color-border);
	}
	.leaderboard__tab:last-child {
		border-right: 0;
	}
	.leaderboard__tab:hover:not(.active) {
		background: var(--color-border-subtle);
	}
	.leaderboard__tab.active {
		background: var(--color-action);
		color: var(--color-action-text);
	}
	.leaderboard__tab:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 2px;
		position: relative;
		z-index: 1;
	}
	.leaderboard__window {
		margin: 0 0 0.75rem;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
	.leaderboard__total {
		margin: 0 0 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
		font-size: var(--font-size-md);
		color: var(--color-text-muted);
	}
	.leaderboard__total :global(strong) {
		color: var(--color-text);
	}
	/* Same treatment as a note in the per-row metrics: a caveat on the number
	   above it rather than another number. Used by the doors board for the
	   turfs whose doors VAN has not counted yet. */
	.leaderboard__total :global(.leaderboard__note) {
		font-style: italic;
		color: var(--color-text-faint);
	}
	.leaderboard__empty,
	.leaderboard__error {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		margin: 0;
	}
	.leaderboard__error {
		color: var(--color-error);
	}
	.leaderboard__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.leaderboard__row {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.leaderboard__row.winner .leaderboard__chapter {
		font-weight: 600;
		color: var(--color-text);
	}
	.leaderboard__rank {
		flex-shrink: 0;
		width: 1.75rem;
		font-weight: 600;
		font-size: var(--font-size-base);
		color: var(--color-text-muted);
		padding-top: 1px;
	}
	.leaderboard__row.winner .leaderboard__rank {
		font-size: 1.1rem;
		padding-top: 0;
	}
	.leaderboard__details {
		flex: 1;
		min-width: 0;
	}
	.leaderboard__chapter {
		font-size: var(--font-size-lg);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}
	.leaderboard__metrics {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: baseline;
	}
	.leaderboard__metrics :global(strong) {
		color: var(--color-text);
	}
	.leaderboard__metrics :global(.leaderboard__sep) {
		color: var(--color-text-faint);
	}
	.leaderboard__metrics :global(.leaderboard__note) {
		font-style: italic;
	}
</style>
