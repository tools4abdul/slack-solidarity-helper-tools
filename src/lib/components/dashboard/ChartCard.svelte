<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { ChartBand, ChartFrame } from './chart-data.js';
	import CountyHeatmap from './CountyHeatmap.svelte';
	import SignupChart from './SignupChart.svelte';

	type CardState =
		| { kind: 'loading' }
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| {
				kind: 'ready';
				frame: ChartFrame;
				showTotalOverlay?: boolean;
				/** Per-chapter bands for the legend, reserved in both modes. */
				legendBands: ChartBand[];
		  };

	type ChartMode = 'overview' | 'detail' | 'county';

	type Props = {
		title: string;
		cardState: CardState;
		/** Bound by the parent so it can rebuild `cardState` for the chosen view. */
		mode?: ChartMode;
		/** The multi-chapter-members disclaimer only applies to sources where a
		 *  person can appear in several bands (signups); doors-knocked counts
		 *  are per-conversation and don't need it. */
		showMultiChapterNote?: boolean;
		/** Shows a "Fetching new data…" spinner beside the title while newer
		 *  numbers are being pulled in the background. The chart keeps showing
		 *  the data it already has until they land. */
		refreshing?: boolean;
	};

	let {
		title,
		cardState,
		mode = $bindable('overview'),
		showMultiChapterNote = true,
		refreshing = false,
	}: Props = $props();

	let isRetrying = $state(false);

	const headingId = $derived('chart-card-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

	const displayState = $derived<CardState>(isRetrying ? { kind: 'loading' } : cardState);

	async function handleRetry() {
		isRetrying = true;
		try {
			await invalidate('app:dashboard');
		} finally {
			isRetrying = false;
		}
	}
</script>

<section class="chart-card" aria-labelledby={headingId}>
	<header class="chart-card__header">
		<div class="chart-card__heading">
			<h2 class="chart-card__title" id={headingId}>{title}</h2>
			{#if refreshing}
				<p class="chart-card__refreshing" role="status">
					<span class="chart-card__spinner" aria-hidden="true"></span>
					Fetching new data…
				</p>
			{/if}
		</div>
		<div class="chart-card__toggle" role="group" aria-label="{title} breakdown">
			<button
				type="button"
				class="chart-card__toggle-btn"
				class:active={mode === 'overview'}
				aria-pressed={mode === 'overview'}
				onclick={() => (mode = 'overview')}
			>
				Overall
			</button>
			<button
				type="button"
				class="chart-card__toggle-btn"
				class:active={mode === 'detail'}
				aria-pressed={mode === 'detail'}
				onclick={() => (mode = 'detail')}
			>
				By chapter
			</button>
			<button
				type="button"
				class="chart-card__toggle-btn"
				class:active={mode === 'county'}
				aria-pressed={mode === 'county'}
				onclick={() => (mode = 'county')}
			>
				By county
			</button>
		</div>
	</header>
	<div class="chart-card__body">
		{#if displayState.kind === 'loading'}
			<div class="chart-card__loading" role="status" aria-label="Loading">
				<span class="chart-card__loading-bar" aria-hidden="true"></span>
			</div>
		{:else if displayState.kind === 'empty'}
			<p class="chart-card__empty">No signups recorded yet</p>
		{:else if displayState.kind === 'error'}
			<p class="chart-card__error">{displayState.message}</p>
			<button type="button" class="chart-card__retry" onclick={handleRetry}>Retry</button>
		{:else if mode === 'county'}
			{#if displayState.frame.countySummary?.length}
				<CountyHeatmap data={displayState.frame.countySummary} accessibleName={title} />
				<div class="chart-card__county-summary" aria-label="{title} county totals">
					{#each displayState.frame.countySummary as county (county.county)}
						<div class="chart-card__county-row">
							<span>{county.county}</span>
							<strong>{county.value}</strong>
						</div>
					{/each}
				</div>
			{:else}
				<p class="chart-card__empty">No county totals recorded yet</p>
			{/if}
		{:else}
			<SignupChart
				variant={mode}
				frame={displayState.frame}
				legendBands={displayState.legendBands}
				accessibleName={title}
				showTotalOverlay={displayState.showTotalOverlay ?? false}
			/>
			<table class="chart-card__sr-table">
				<caption>{title}</caption>
				<thead>
					<tr>
						<th scope="col">Date</th>
						{#each displayState.frame.bands as band (band.key)}
							<th scope="col">{band.label}</th>
						{/each}
						{#if displayState.frame.dailyTotals}
							<th scope="col">Daily distinct total</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each displayState.frame.dates as date, i (date)}
						<tr>
							<th scope="row">{date}</th>
							{#each displayState.frame.bands as band (band.key)}
								<td>{band.values[i] ?? 0}</td>
							{/each}
							{#if displayState.frame.dailyTotals}
								<td>{displayState.frame.dailyTotals[i] ?? 0}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
	{#if displayState.kind === 'ready' && showMultiChapterNote}
		<!-- Always rendered so toggling overview/detail doesn't shift the page;
		     only visible in detail mode. -->
		<p
			class="chart-card__legend-note"
			class:chart-card__legend-note--hidden={mode !== 'detail'}
			aria-hidden={mode !== 'detail'}
		>
			Members in multiple chapters are counted in each band but only once in the daily total (shown
			as the dark marker on each bar).
		</p>
	{/if}
</section>

<style>
	.chart-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.5rem;
		margin: 1rem 0;
		box-shadow: var(--shadow-card);
	}
	.chart-card__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.chart-card__heading {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-wrap: wrap;
		min-width: 0;
	}
	.chart-card__title {
		margin: 0;
		font-size: 1.125rem;
		color: var(--color-text);
	}
	.chart-card__refreshing {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
	.chart-card__spinner {
		display: block;
		width: 0.85em;
		height: 0.85em;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-blue);
		border-radius: 50%;
		animation: chart-card-spin 0.7s linear infinite;
	}
	@keyframes chart-card-spin {
		to {
			transform: rotate(360deg);
		}
	}
	/* Respect reduced-motion: the label alone carries the meaning. */
	@media (prefers-reduced-motion: reduce) {
		.chart-card__spinner {
			animation-duration: 3s;
		}
	}
	.chart-card__toggle {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface);
	}
	.chart-card__toggle-btn {
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
	.chart-card__toggle-btn:last-child {
		border-right: 0;
	}
	.chart-card__county-summary {
		display: grid;
		gap: 0.5rem;
		padding-top: 1rem;
	}
	.chart-card__county-row {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: rgba(18, 28, 80, 0.02);
	}
	.chart-card__toggle-btn:hover:not(.active) {
		background: var(--color-border-subtle);
	}
	.chart-card__toggle-btn.active {
		background: var(--color-action);
		color: var(--color-action-text);
	}
	.chart-card__toggle-btn:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 2px;
		position: relative;
		z-index: 1;
	}
	.chart-card__body {
		position: relative;
		min-height: 200px;
	}
	.chart-card__loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3rem 0;
	}
	.chart-card__loading-bar {
		display: block;
		width: 60%;
		height: 3px;
		background: linear-gradient(90deg, transparent, var(--color-blue), transparent);
		background-size: 200% 100%;
		animation: chart-card-shimmer 1.4s linear infinite;
	}
	@keyframes chart-card-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	.chart-card__empty,
	.chart-card__error {
		color: var(--color-text-muted);
		padding: 3rem 0;
		text-align: center;
		margin: 0;
	}
	.chart-card__error {
		color: var(--color-error);
	}
	.chart-card__retry {
		display: block;
		margin: 0 auto;
		appearance: none;
		background: var(--color-action);
		color: var(--color-action-text);
		border: 0;
		padding: 0.5rem 1.25rem;
		border-radius: var(--radius-lg);
		cursor: pointer;
		font: inherit;
	}
	.chart-card__retry:hover {
		background: var(--color-action-hover);
	}
	.chart-card__retry:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 2px;
	}
	.chart-card__legend-note {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		margin: 0.75rem 0 0;
	}
	/* Keeps the note's reserved space while hiding it in overview mode. */
	.chart-card__legend-note--hidden {
		visibility: hidden;
	}
	.chart-card__sr-table {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
