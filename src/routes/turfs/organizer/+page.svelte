<script lang="ts">
	import './organizer.css';
	import { resolve } from '$app/paths';
	import { driftAdvice, driftLabel } from '$lib/van/turf-drift.js';

	const { data } = $props();

	// No `ago()` here, and no clock of any kind: the "ago" labels arrive from the
	// load function as `claimedAgoLabel` / `completedAgoLabel`. This file used to
	// compute them from `Date.now()` during render, which stamped the server's
	// clock into SSR and the browser's into hydration — a mismatch on every row.
	// Anything time-relative on this page belongs in +page.server.ts, measured
	// against the single `now` it already uses for the queries.

	function hoursLabel(hours: number): string {
		if (hours <= 0) return 'due now';
		return hours === 1 ? '1 hour left' : `${hours} hours left`;
	}

	const scope = $derived(data.chapter ? data.chapter.name : 'all chapters');
</script>

<main>
	<!-- One GET form, so the filter works with JavaScript off; the onchange is
	     enhancement, not the mechanism. Matches the activity page. -->
	<form class="filters" method="GET" action={resolve('/turfs/organizer')}>
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
		<button type="submit" class="filter-go">Show</button>
		<a class="cross-link" href={resolve('/turfs/activity')}>See what already happened →</a>
	</form>

	<!-- Counts first: on a canvass morning this row is the whole answer. -->
	<ul class="summary">
		<li class="summary-item">
			<span class="summary-count">{data.summary.turfsOut.toLocaleString('en-US')}</span>
			<span class="summary-label">turfs out</span>
		</li>
		<li class="summary-item">
			<span class="summary-count">{data.summary.holders.toLocaleString('en-US')}</span>
			<span class="summary-label">volunteers</span>
		</li>
		<li class="summary-item">
			<span class="summary-count">{data.summary.doorsOut.toLocaleString('en-US')}</span>
			<span class="summary-label">doors out</span>
		</li>
		{#if data.summary.expiring > 0}
			<li class="summary-item is-alert">
				<span class="summary-count">{data.summary.expiring.toLocaleString('en-US')}</span>
				<span class="summary-label">expiring soon</span>
			</li>
		{/if}
	</ul>

	{#if data.summary.expiringUnwarned > 0}
		<!-- The one line that means someone has to act personally: about to lapse
		     AND the automatic reminder has not reached them. -->
		<p class="callout">
			{data.summary.expiringUnwarned}
			{data.summary.expiringUnwarned === 1 ? 'turf is' : 'turfs are'} expiring and the volunteer hasn't
			been reminded yet — the reminder goes out six hours before expiry, so these may need a word directly.
		</p>
	{/if}

	<section class="board">
		<h2>Out right now</h2>
		{#if data.holdings.length === 0}
			<p class="empty">
				No turf is checked out in {scope} at the moment.
			</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>Volunteer</th>
							<th>Held for</th>
							<th>Expires</th>
							<th class="col-flag">Reminder</th>
						</tr>
					</thead>
					<tbody>
						{#each data.holdings as held (held.checkoutId)}
							<tr class="urgency-{held.urgency}">
								<td>
									<span class="turf-name">{held.turfName}</span>
									{#if held.regionName}
										<span class="turf-sub">{held.regionName}</span>
									{/if}
									<span class="turf-sub">
										{held.doorCount.toLocaleString('en-US')} doors · {held.chapterName}
									</span>
								</td>
								<td>{held.slackUserName}</td>
								<td class="col-num">
									{held.hoursHeld}h
									<span class="turf-sub">{held.claimedAgoLabel}</span>
								</td>
								<td class="col-num">
									<span class="expires-in">{hoursLabel(held.hoursLeft)}</span>
									<span class="turf-sub">{held.expiresLabel}</span>
								</td>
								<td class="col-flag">
									{#if held.urgency === 'expiring' && !held.warned}
										<span class="badge badge-unwarned">Not reminded</span>
									{:else if held.warned}
										<span class="badge badge-warned">Reminded</span>
									{:else}
										<span class="badge badge-none">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="board">
		<h2>Completed but nothing cleared</h2>
		{#if !data.deltaChecked}
			<!-- Not "all clear". Nothing has been measured, and saying otherwise
			     would report a check that has never run as a passing one. -->
			<p class="empty">
				Not checked yet. After a volunteer marks turf done, VAN is refreshed and the door count
				compared — a count that didn't move means MiniVAN was never synced and the results are still
				on their phone. That check needs VAN API access, which isn't configured yet, so nothing here
				has been verified either way.
				{#if data.completionsExamined > 0}
					<br />
					{data.completionsExamined.toLocaleString('en-US')} recent
					{data.completionsExamined === 1 ? 'completion is' : 'completions are'} waiting on it.
				{/if}
			</p>
		{:else if data.suspects.length === 0}
			<p class="empty">
				Every checked completion cleared doors. Nothing looks like a missed sync in {scope}.
			</p>
		{:else}
			<p class="section-note">
				These were marked done, but VAN's door count didn't move — almost always a MiniVAN that was
				never synced, so the canvass results are still on a phone.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Turf</th>
							<th>Volunteer</th>
							<th>Completed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.suspects as suspect (suspect.checkoutId)}
							<tr>
								<td>
									<span class="turf-name">{suspect.turfName}</span>
									{#if suspect.regionName}
										<span class="turf-sub">{suspect.regionName}</span>
									{/if}
									<span class="turf-sub">{suspect.chapterName}</span>
								</td>
								<td>{suspect.slackUserName}</td>
								<td class="col-num">
									{suspect.completedLabel}
									<span class="turf-sub">{suspect.completedAgoLabel}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="board">
		<h2>Out of step with VAN</h2>
		{#if data.drift.visibility === 'van-side-unavailable'}
			<!-- Not "no drift". The sync writes van_distributed_to = NULL both when
			     VAN reports nothing and when the tier that reads exports is not
			     granted, so an empty list here would be reassurance drawn from a
			     question nobody asked. -->
			<p class="empty">
				Can't check. Comparing our checkout list against MiniVAN needs VAN's
				<code>/minivanExports</code>, which the current API key can't read — so turf assigned by
				hand in VAN is invisible to the app and nothing here has been compared either way.
			</p>
		{:else if data.drift.items.length === 0}
			<p class="empty">
				Our checkout list and MiniVAN agree in {scope}. Nothing is claimed here without being
				exported, and nothing is out in MiniVAN that the app thinks is free.
			</p>
		{:else}
			<p class="section-note">
				The app and VAN disagree about {data.drift.items.length}
				{data.drift.items.length === 1 ? 'turf' : 'turfs'}. Turf out in MiniVAN but free here can be
				claimed by a second person; turf claimed here but never exported gives its holder a list
				number that loads nothing.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th class="col-flag">Problem</th>
							<th>Turf</th>
							<th>Who has it</th>
							<th>What to do</th>
						</tr>
					</thead>
					<tbody>
						{#each data.drift.items as item (item.kind + ':' + item.mapRouteId)}
							<tr class="drift-{item.kind}">
								<td class="col-flag">
									<span class="badge badge-{item.kind}">{driftLabel(item.kind)}</span>
								</td>
								<td>
									<span class="turf-name">{item.turfName}</span>
									{#if item.regionName}
										<span class="turf-sub">{item.regionName}</span>
									{/if}
									<span class="turf-sub">
										{item.doorCount.toLocaleString('en-US')} doors · {item.chapterName}
									</span>
								</td>
								<td>
									{item.heldBy ?? item.distributedTo ?? '—'}
									{#if !item.hasListNumber}
										<span class="turf-sub">no MiniVAN list number</span>
									{/if}
								</td>
								<td class="drift-advice">{driftAdvice(item.kind)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</main>
