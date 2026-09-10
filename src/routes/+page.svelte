<script lang="ts">
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import CountdownBanner from '$lib/components/dashboard/CountdownBanner.svelte';
	import LedBoard from '$lib/components/dashboard/LedBoard.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import {
		buildOverviewFrame,
		buildDetailFrame,
		type ChartBand,
		type ChartFrame,
	} from '$lib/components/dashboard/chart-data.js';
	import type { DaySignups } from '$lib/server/dashboard-signups.js';
	import type { PageData } from './$types';

	// Door-knock reporting is off the dashboard until the VAN door stats are
	// fully available: the doors chart, the doors leaderboard, the LED
	// ticker's scrolling day leaders, and the countdown's projected-doors line
	// are all unrendered here, but every piece they need is still in the tree
	// — DoorTicker.svelte, DoorsLeaderboard.svelte, CountdownBanner's
	// `projectedDoors` prop, and the door-knock server modules. Re-hooking is
	// a matter of pointing those at the VAN feed and putting the markup back.

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

	function buildState(
		source: { ok: true; days: DaySignups[] } | { ok: false; error: string },
		mode: ChartMode,
		label: string,
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
			// the stacked bands.
			showTotalOverlay: mode === 'detail',
			legendBands: detailFrame.bands,
		};
	}

	const solidarityState = $derived(buildState(data.solidarity, solidarityMode, 'Solidarity'));
	const slackState = $derived(buildState(data.slack, slackMode, 'Slack'));
</script>

<main>
	<!-- The LED sign, currently carrying the countdown alone; the scrolling
	     day-leader ticker rejoins it with the VAN door stats. -->
	{#if data.countdown}
		<div class="countdown-row">
			<LedBoard ratio={data.ticker.ratio} fit={data.ticker.fit}>
				<CountdownBanner label={data.countdown.label} endAt={data.countdown.endAt} />
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
