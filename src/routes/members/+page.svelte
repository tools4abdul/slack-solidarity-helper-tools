<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import AutocompletePicker from '$lib/components/settings/AutocompletePicker.svelte';
	import SolidarityAccountLinker from '$lib/components/settings/SolidarityAccountLinker.svelte';
	import { formatRelative } from '$lib/components/settings/format-relative.js';
	import type { FeedResult, MemberDetail } from '$lib/server/member-lookup';
	import './members.css';

	let { data } = $props();

	function selectMember(id: string): void {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the base path IS resolved; the rule can't see through the template literal
		goto(`${resolve('/members')}?user=${encodeURIComponent(id)}`, {
			keepFocus: true,
			noScroll: true,
		});
	}

	// formatRelative already renders the "ago" suffix ("3m ago", "just now"),
	// so callers must not add one.
	function when(iso: string | null): string {
		if (!iso) return 'date unknown';
		const ms = Date.parse(iso);
		return Number.isNaN(ms) ? 'date unknown' : formatRelative(Date.now() - ms);
	}

	function noteWhen(iso: string): string {
		const ms = Date.parse(iso);
		return Number.isNaN(ms) ? iso : formatRelative(Date.now() - ms);
	}

	/** How the member was (or wasn't) notified. */
	function dmSummary(note: MemberDetail['notes'][number]): string | null {
		if (note.kind !== 'warning') return null;
		if (note.dmSentAt) return "DM'd to the member";
		if (note.dmStatus === 'suppressed') return 'No DM sent (suppressed by the admin)';
		if (note.dmStatus) return `DM failed: ${note.dmStatus}`;
		return 'DM not sent';
	}
</script>

<div class="members-page">
	<section class="member-search">
		<label class="member-search-label" for="member-picker">Find a member</label>
		<div id="member-picker">
			<AutocompletePicker
				items={data.slackUsers}
				value={data.selectedSlackUserId}
				onSelect={selectMember}
				placeholder="Search by Slack name…"
				showSublabel
			/>
		</div>
		{#if data.slackUsersError}
			<p class="member-notice">{data.slackUsersError}</p>
		{:else if data.slackUsersStale}
			<p class="member-notice">Showing a cached copy of the Slack member list.</p>
		{/if}
	</section>

	{#if !data.member}
		<p class="member-empty">Pick someone to see their recent volunteer activity and any notes.</p>
	{:else}
		{#await data.member}
			<p class="member-empty">Loading…</p>
		{:then member}
			{#if !member}
				<p class="member-empty">That Slack account isn't in the workspace directory.</p>
			{:else}
				<section class="member-card">
					<div class="member-head">
						<h2 class="member-name">{member.slack.name}</h2>
						{#if member.chapters.length > 0}
							<p class="member-chapters">{member.chapters.join(', ')}</p>
						{/if}
					</div>
					{#if member.slack.realName && member.slack.realName !== member.slack.name}
						<p class="member-realname">{member.slack.realName}</p>
					{/if}
					{#if member.link.reason === 'linked'}
						<p class="member-linkline">
							Linked to Solidarity by {member.link.linkedByName}
							{#if member.link.linkedAt}· {noteWhen(member.link.linkedAt)}{/if}
							{#if data.canLink}
								<button
									type="button"
									class="member-unlink"
									onclick={async () => {
										await fetch('/api/members/link', {
											method: 'POST',
											headers: { 'Content-Type': 'application/json' },
											body: JSON.stringify({ action: 'unlink', slackUserId: member.slack.id }),
										});
										location.reload();
									}}>Unlink</button
								>
							{/if}
						</p>
					{/if}
				</section>

				{#if member.link.reason === 'lookup-failed'}
					<!-- Deliberately distinct from "no account": inviting a manual link
					     because Solidarity was briefly down would create bad links. -->
					<p class="member-notice">
						Solidarity couldn't be reached, so this member's activity and account match are
						unavailable. Their notes below are unaffected.
					</p>
				{:else if data.canLink && (member.link.reason === 'no-slack-email' || member.link.reason === 'no-solidarity-match')}
					<SolidarityAccountLinker slackUserId={member.slack.id} slackEmail={member.slack.email} />
				{:else if member.link.reason === 'no-slack-email' || member.link.reason === 'no-solidarity-match'}
					<!-- A moderator's view: same fact, without the controls to fix it. -->
					<p class="member-notice">
						This member isn't matched to a Solidarity account, so there's no activity to show. Their
						notes below are unaffected.
					</p>
				{/if}

				{#if member.link.solidarityUserId !== null}
					<div class="member-feeds">
						{@render feed('Recent actions', member.actions, 'time')}
						{@render feed('Recent event RSVPs', member.rsvps, 'session')}
					</div>
				{/if}

				<section class="member-notes">
					<h3>Notes and warnings</h3>
					{#if member.notes.length === 0}
						<p class="member-empty">Nothing logged for this member.</p>
					{:else}
						<ul class="note-list">
							{#each member.notes as note (note.id)}
								<li class="note" class:note-warning={note.kind === 'warning'}>
									<div class="note-head">
										<span class="note-chip">
											{note.kind === 'warning'
												? `Warning${note.warningNumber ? ` #${note.warningNumber}` : ''}`
												: 'Note'}
										</span>
										<span class="note-meta">
											{note.authorSlackUserName} · {noteWhen(note.createdAt)}
										</span>
									</div>
									<p class="note-body">{note.body}</p>
									{#if note.messageLink}
										<p class="note-link">
											<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external Slack permalink, not an app route -->
											<a href={note.messageLink} target="_blank" rel="noopener noreferrer">
												View the message ↗
											</a>
										</p>
									{/if}
									{#if dmSummary(note)}
										<p class="note-dm">{dmSummary(note)}</p>
									{/if}
									{#if note.dmBody}
										<details class="note-dm-body">
											<summary>What the member was sent</summary>
											<pre>{note.dmBody}</pre>
										</details>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{:catch}
			<p class="member-notice">Something went wrong loading this member. Try again.</p>
		{/await}
	{/if}
</div>

{#snippet feed(title: string, result: FeedResult, occurrence: string)}
	<section class="member-feed">
		<h3>{title}</h3>
		{#if !result.ok}
			<p class="member-notice">{result.error}</p>
		{:else if result.items.length === 0}
			<p class="member-empty">Nothing recorded.</p>
		{:else}
			<ul class="activity-list">
				{#each result.items as item (item.key)}
					<li class="activity">
						{#if item.unknownShape}
							<!-- Solidarity's response schema is undocumented; showing the
							     raw fields beats silently rendering an empty row. -->
							<span class="activity-title activity-unknown">Unrecognized entry</span>
							<dl class="activity-extras">
								{#each item.extras as extra (extra.label)}
									<dt>{extra.label}</dt>
									<dd>{extra.value}</dd>
								{/each}
							</dl>
						{:else}
							<span class="activity-title">{item.title || 'Untitled'}</span>
							{#if item.count > 1}
								<span class="activity-count">{item.count} {occurrence}s</span>
							{/if}
							<span class="activity-when">
								{item.count > 1 ? 'latest ' : ''}{when(item.occurredAt)}{item.detail
									? ` · ${item.detail}`
									: ''}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			{#if result.truncated}
				<p class="activity-footnote">
					This member has more activity than one page; the most recent are shown.
				</p>
			{/if}
		{/if}
	</section>
{/snippet}
