<script lang="ts">
	import type {
		DoorsLeaderboardPair,
		DoorsLeaderboard,
		DoorsChapterEntry,
	} from '$lib/van/doors-leaderboard';
	import LeaderboardCard, { type LeaderboardTab } from './LeaderboardCard.svelte';

	// The metric set changed with the source (plan.md 9.1). VAN can say how many
	// doors left a turf, how many turfs were walked and by how many people; it
	// cannot say how many doors were KNOCKED, because a not-home door stays on
	// the list. So attempts and the contact rate are gone rather than filled
	// with a number that means something else — doors-cleared in both columns
	// would render a permanent 100% contact rate.
	type Props = { leaderboard: DoorsLeaderboardPair };
	let { leaderboard }: Props = $props();

	function fmtPct(p: number): string {
		const rounded = Math.round(Math.abs(p) * 10) / 10;
		return `${p >= 0 ? '↑' : '↓'}${rounded}%`;
	}

	function plural(n: number, one: string, many: string): string {
		return n === 1 ? one : many;
	}
</script>

{#snippet total(lb: DoorsLeaderboard, tab: LeaderboardTab)}
	<strong>{lb.totalDoorsCleared.toLocaleString('en-US')}</strong>
	{plural(lb.totalDoorsCleared, 'door', 'doors')} cleared
	{tab === 'lastWeek' ? 'that week' : 'so far this week'}
	· <strong>{lb.totalTurfsCompleted.toLocaleString('en-US')}</strong>
	{plural(lb.totalTurfsCompleted, 'turf', 'turfs')}
	· <strong>{lb.totalCanvassers.toLocaleString('en-US')}</strong>
	{plural(lb.totalCanvassers, 'canvasser', 'canvassers')}
	{#if lb.awaitingCount > 0}
		<!-- Two clocks (9.6): turfs are known the moment they are marked walked,
		     their doors only after VAN recounts the region. Saying so is the
		     difference between a number that looks low and one that is unfinished. -->
		<span class="leaderboard__note"
			>· {lb.awaitingCount}
			{plural(lb.awaitingCount, 'turf', 'turfs')} awaiting VAN's recount</span
		>
	{/if}
{/snippet}

{#snippet empty(tab: LeaderboardTab)}
	{tab === 'lastWeek' ? 'No turf completed that week.' : 'No turf completed yet this week.'}
{/snippet}

{#snippet metrics(entry: DoorsChapterEntry)}
	<span>
		<strong>+{entry.doorsCleared.toLocaleString('en-US')}</strong> doors
	</span>
	<span class="leaderboard__sep">·</span>
	<span>
		{entry.turfsCompleted}
		{plural(entry.turfsCompleted, 'turf', 'turfs')} · {entry.canvassers}
		{plural(entry.canvassers, 'canvasser', 'canvassers')}
	</span>
	{#if entry.comparable}
		<span class="leaderboard__sep">·</span>
		<span>
			<strong>{fmtPct(entry.pct)}</strong> vs last week
		</span>
		<span class="leaderboard__sep">·</span>
		<span>{entry.prevDoors.toLocaleString('en-US')} last week</span>
	{:else if entry.awaitingCount > 0 && entry.doorsCleared === 0}
		<span class="leaderboard__sep">·</span>
		<span class="leaderboard__note">doors not counted yet</span>
	{:else}
		<span class="leaderboard__sep">·</span>
		<span class="leaderboard__note">first week on this measure</span>
	{/if}
{/snippet}

<LeaderboardCard
	title="Canvassing leaderboard"
	thisWeek={leaderboard.thisWeek}
	lastWeek={leaderboard.lastWeek}
	entriesOf={(lb) => lb.topChapters}
	rowKey={(entry) => entry.chapterName}
	rowName={(entry) => entry.chapterName}
	{total}
	{empty}
	{metrics}
/>
