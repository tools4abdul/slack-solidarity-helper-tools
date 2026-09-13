<script lang="ts">
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import CountdownBanner from '$lib/components/dashboard/CountdownBanner.svelte';
	import LedBoard from '$lib/components/dashboard/LedBoard.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import DoorTicker from '$lib/components/dashboard/DoorTicker.svelte';
	import DoorsLeaderboard from '$lib/components/dashboard/DoorsLeaderboard.svelte';
	import {
		buildOverviewFrame,
		buildDetailFrame,
		type ChartBand,
		type ChartFrame,
	} from '$lib/components/dashboard/chart-data.js';
	import type { DaySignups } from '$lib/server/dashboard-signups.js';
	import type { PageData } from './$types';

	// The four door-knock surfaces — the chart, the county leaderboard, the LED
	// ticker and the countdown's projection — are all back, reading the VAN
	// turf checkout ledger rather than Openfield's nightly snapshot (plan.md
	// Story 9). The metric changed with the source: these are doors CLEARED
	// (doors that left a turf after it was walked), not doors knocked.

	let { data }: { data: PageData } = $props();

	type ChartMode = 'overview' | 'detail';
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
	let doorsMode = $state<ChartMode>('detail');

	function buildState(
		source: { ok: true; days: DaySignups[] } | { ok: false; error: string },
		mode: ChartMode,
		label: string,
		options: { totalOverlay?: boolean } = {},
	): CardState {
		if (!source.ok) return { kind: 'error', message: source.error };
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
	const doorsState = $derived(buildState(data.doors, doorsMode, 'Doors', { totalOverlay: false }));

	// The doors card appears once anything has been walked (or on a load
	// error), rather than sitting empty through the weeks before the first
	// canvass — same rule the Openfield card used.
	const showDoors = $derived(data.doors.ok === false || doorsState.kind !== 'empty');
</script>

<main>
	<!-- One LED sign carrying the countdown and the day's personal standings.
	     Either half can be absent — an unconfigured countdown no longer hides
	     the ticker, and vice versa. -->
	{#if data.countdown || data.doorsTicker.entries.length > 0}
		<div class="countdown-row">
			<LedBoard ratio={data.ticker.ratio} fit={data.ticker.fit}>
				{#if data.countdown}
					<CountdownBanner
						label={data.countdown.label}
						endAt={data.countdown.endAt}
						projectedDoors={data.countdown.projectedDoors}
					/>
				{/if}
				<DoorTicker
					entries={data.doorsTicker.entries}
					columnsPerSecond={data.tickerColumnsPerSecond}
				/>
			</LedBoard>
		</div>
	{/if}

	<div class="dashboard-toolbar">
		<RangePresetPicker current={data.days} />
	</div>

	<ChartCard title="Solidarity signups" cardState={solidarityState} bind:mode={solidarityMode} />

	<div class="slack-row">
		<ChartCard title="Slack signups" cardState={slackState} bind:mode={slackMode} />
		<SlackLeaderboard leaderboard={data.leaderboard} />
	</div>

	{#if showDoors}
		<div class="doors-row">
			<ChartCard
				title="Doors cleared"
				cardState={doorsState}
				bind:mode={doorsMode}
				showMultiChapterNote={false}
			/>
			<DoorsLeaderboard leaderboard={data.doorsLeaderboard} />
		</div>
	{/if}
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
	.slack-row,
	.doors-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		align-items: start;
	}
	.doors-row {
		margin-top: 1.5rem;
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
