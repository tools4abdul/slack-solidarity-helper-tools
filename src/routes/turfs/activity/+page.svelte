<script lang="ts">
	import './activity.css';
	import { resolve } from '$app/paths';
	import {
		ACTIVITY_KINDS,
		activityLabel,
		groupByDay,
		PERIOD_OPTIONS,
	} from '$lib/van/turf-activity.js';

	const { data } = $props();

	const days = $derived(groupByDay(data.events));

	// Zero-count kinds are dropped rather than rendered as "0 expired" — a row of
	// zeroes reads as a problem, and the counts are a summary, not a schema.
	const summary = $derived(
		ACTIVITY_KINDS.filter((kind) => data.counts[kind] > 0).map((kind) => ({
			kind,
			label: activityLabel(kind),
			count: data.counts[kind],
		})),
	);

	const periodLabel = $derived(
		PERIOD_OPTIONS.find((o) => o.value === data.period)?.label ?? 'this period',
	);

	// No `ago()` here, and no clock of any kind: each event arrives with its own
	// `agoLabel` from the load function. This file used to compute it from
	// `Date.now()` during render, which stamped the server's clock into SSR and
	// the browser's into hydration — a mismatch on every row, and the very thing
	// the note at the top of +page.server.ts says this page avoids.
</script>

<main>
	<!-- One GET form for both facets, so changing either keeps the other. Two
	     separate forms, or a link per chapter, would silently drop whichever
	     filter was not being changed. It submits without JavaScript; the
	     onchange below is enhancement, not the mechanism. -->
	<form class="filters" method="GET" action={resolve('/turfs/activity')}>
		<div class="filter">
			<label for="chapter">Chapter</label>
			<select id="chapter" name="chapter" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
				<option value="" selected={data.chapter === null}>All chapters</option>
				{#each data.chapters as chapter (chapter.chapterId)}
					<option
						value={chapter.chapterId}
						selected={data.chapter?.chapterId === chapter.chapterId}
					>
						{chapter.name}
					</option>
				{/each}
			</select>
		</div>

		<div class="filter">
			<label for="days">Period</label>
			<select id="days" name="days" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
				{#each PERIOD_OPTIONS as option (option.value)}
					<option value={option.value} selected={data.period === option.value}
						>{option.label}</option
					>
				{/each}
			</select>
		</div>

		<button type="submit" class="filter-go">Show</button>
	</form>

	{#if summary.length > 0}
		<ul class="summary">
			{#each summary as item (item.kind)}
				<li class="summary-item">
					<span class="summary-count">{item.count.toLocaleString('en-US')}</span>
					<span class="summary-label">{item.label}</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.events.length === 0}
		<!-- Two different nothings. With no VAN key the catalog is empty, which is
		     the state anyone actually hits today, and reading it as "a quiet week"
		     would send an organizer looking for volunteers instead of a key. -->
		{#if !data.anyTurf}
			<p class="empty">
				No turf has been loaded yet, so there is no activity to show. An organizer needs to cut turf
				in VAN and the catalog sync needs to pull it in.
			</p>
		{:else}
			<p class="empty">
				No turf activity in {periodLabel.toLowerCase()}{data.chapter
					? ` for ${data.chapter.name}`
					: ''}. Try a longer period.
			</p>
		{/if}
	{:else}
		{#each days as day (day.dayKey)}
			<section class="day">
				<h2 class="day-heading">{data.dayLabels[day.dayKey] ?? day.dayKey}</h2>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th class="col-time">Time</th>
								<th class="col-what">What</th>
								<th>Turf</th>
								<th>Chapter</th>
								<th>Volunteer</th>
							</tr>
						</thead>
						<tbody>
							{#each day.events as event (event.id)}
								<tr>
									<td class="col-time">
										<span class="time">{event.timeLabel}</span>
										<span class="time-ago">{event.agoLabel}</span>
									</td>
									<td class="col-what">
										<span class="badge badge-{event.kind}">{activityLabel(event.kind)}</span>
									</td>
									<td>
										<span class="turf-name">{event.turfName}</span>
										{#if event.regionName}
											<span class="turf-region">{event.regionName}</span>
										{/if}
										<span class="turf-doors">
											{event.doorCount.toLocaleString('en-US')} doors
											{#if event.kind === 'completed' && event.confirmedDoorDelta !== null}
												· {event.confirmedDoorDelta.toLocaleString('en-US')} cleared
											{/if}
										</span>
									</td>
									<td>{event.chapterName}</td>
									<td>{event.slackUserName}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/each}

		{#if data.total > data.shown}
			<!-- "N of M", never "M more": both halves then come from the same set,
			     so narrowing the period cannot make them disagree. -->
			<p class="cap-note">
				Showing the most recent {data.shown.toLocaleString('en-US')} of
				{data.total.toLocaleString('en-US')} events — narrow the period or pick a chapter to see the rest.
			</p>
		{/if}
	{/if}
</main>
