<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import CountdownBanner from '$lib/components/dashboard/CountdownBanner.svelte';
	import LedBoard from '$lib/components/dashboard/LedBoard.svelte';
	import DoorTicker from '$lib/components/dashboard/DoorTicker.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import DoorsLeaderboard from '$lib/components/dashboard/DoorsLeaderboard.svelte';
	import {
		buildOverviewFrame,
		buildDetailFrame,
		buildCountySummary,
		type ChartBand,
		type ChartFrame,
	} from '$lib/components/dashboard/chart-data.js';
	import type { DaySignups } from '$lib/server/dashboard-signups.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const countyByChapterName = $derived(new Map(data.countyByChapterName));

	type ChartMode = 'overview' | 'detail' | 'county';
	type CardState =
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| {
				kind: 'ready';
				frame: ChartFrame;
				showTotalOverlay: boolean;
				legendBands: ChartBand[];
		  };

	let solidarityMode = $state<ChartMode>('overview');
	let slackMode = $state<ChartMode>('overview');
	let doorKnockMode = $state<ChartMode>('detail');

	function buildState(
		source: { ok: true; days: DaySignups[] } | { ok: false; error: string },
		mode: ChartMode,
		label: string,
		options: { totalOverlay?: boolean } = {},
	): CardState {
		if (!source.ok) return { kind: 'error', message: source.error };
		if (mode === 'county') {
			const countySummary = buildCountySummary(source.days, countyByChapterName);
			if (countySummary.length === 0) return { kind: 'empty' };
			return {
				kind: 'ready',
				frame: { dates: [], bands: [], countySummary },
				showTotalOverlay: false,
				legendBands: [],
			};
		}
		// Always build the detail frame: even in overview mode its band list
		// feeds the reserved-but-hidden legend, so toggling never resizes the card.
		const detailFrame = buildDetailFrame(source.days);
		const frame = mode === 'detail' ? detailFrame : buildOverviewFrame(source.days, label);
		if (frame.dates.length === 0) return { kind: 'empty' };
		return {
			kind: 'ready',
			frame,
			// The dark daily-total marker shows the deduped member count above
			// the stacked bands — meaningless for doors, where the total is just
			// the sum of the bands.
			showTotalOverlay: (options.totalOverlay ?? true) && mode === 'detail',
			legendBands: detailFrame.bands,
		};
	}

	const solidarityState = $derived(buildState(data.solidarity, solidarityMode, 'Solidarity'));
	const slackState = $derived(buildState(data.slack, slackMode, 'Slack'));
	const doorKnockState = $derived(
		buildState(data.doorKnock, doorKnockMode, 'Doors', { totalOverlay: false }),
	);

	// The door-knock card only appears once the nightly snapshot has ever
	// written data (or on a load error) — hidden entirely while the integration
	// is unconfigured, rather than showing a permanent empty card.
	const showDoorKnock = $derived(data.doorKnock.ok === false || doorKnockState.kind !== 'empty');

	// On-demand door-knock refresh. When the server says nobody has pulled
	// fresh numbers within the refresh window, this visit triggers one in the
	// background: the chart keeps showing the numbers it loaded with, the
	// header shows a spinner, and the page data is invalidated once the
	// snapshot lands. The server throttles, so a visit inside the window never
	// reaches the canvassing tool.
	let refreshingDoorKnock = $state(false);

	async function refreshDoorKnock() {
		refreshingDoorKnock = true;
		try {
			await fetch('/api/dashboard/door-knock-refresh', { method: 'POST' });
		} catch (err) {
			// A failed refresh is not worth interrupting the page for — the
			// already-rendered numbers stay valid, just older.
			console.error('[dashboard] door-knock refresh request failed:', err);
		} finally {
			refreshingDoorKnock = false;
		}
		// Reload regardless: on success this brings in the new numbers, and on
		// failure it costs one cheap page-data round trip.
		await invalidate('app:dashboard');
	}

	// Once per visit — onMount rather than $effect so a mid-refresh data change
	// (or a failed refresh) can't kick off a second round.
	onMount(() => {
		if (data.doorKnockRefreshDue) void refreshDoorKnock();
	});
</script>

<main>
	<!-- One LED sign carrying the countdown and the day's personal standings.
	     Either half can be absent — an unconfigured countdown no longer hides
	     the ticker, and vice versa. -->
	{#if data.countdown || data.doorKnockTicker.entries.length > 0}
		<div class="countdown-row">
			<LedBoard>
				{#if data.countdown}
					<CountdownBanner
						label={data.countdown.label}
						endAt={data.countdown.endAt}
						projectedDoors={data.countdown.projectedDoors}
					/>
				{/if}
				<DoorTicker
					entries={data.doorKnockTicker.entries}
					columnsPerSecond={data.tickerColumnsPerSecond}
				/>
			</LedBoard>
		</div>
	{/if}

	<div class="dashboard-toolbar">
		<RangePresetPicker current={data.days} />
	</div>

	{#if showDoorKnock}
		<div class="door-knock-row">
			<ChartCard
				title="Doors knocked"
				cardState={doorKnockState}
				bind:mode={doorKnockMode}
				showMultiChapterNote={false}
				refreshing={refreshingDoorKnock}
			/>
			<DoorsLeaderboard leaderboard={data.doorsLeaderboard} />
		</div>
	{/if}

	<ChartCard title="Solidarity signups" cardState={solidarityState} bind:mode={solidarityMode} />

	<div class="slack-row">
		<ChartCard title="Slack signups" cardState={slackState} bind:mode={slackMode} />
		<SlackLeaderboard leaderboard={data.leaderboard} />
	</div>
</main>

<style>
	main {
		font-family: var(--font-body);
		max-width: 1280px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		color: var(--color-text);
	}
	.countdown-row {
		margin-bottom: 1.5rem;
	}
	.dashboard-toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1.5rem;
	}
	.slack-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		align-items: start;
	}
	.door-knock-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		align-items: start;
		margin-bottom: 1.5rem;
	}
	@media (max-width: 960px) {
		.door-knock-row {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 960px) {
		.slack-row {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>
