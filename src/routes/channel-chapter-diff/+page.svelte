<script lang="ts">
	import AutocompletePicker from '$lib/components/settings/AutocompletePicker.svelte';
	import type { ChannelChapterDiff } from '$lib/server/channel-chapter-diff';
	import {
		afterToggle,
		afterDaysChange,
		appliedDays as windowDays,
		DEFAULT_DAYS,
		MIN_DAYS,
		MAX_DAYS,
	} from './activity-window.js';
	import './channel-chapter-diff.css';

	let { data } = $props();

	type Phase =
		| { kind: 'idle' }
		| { kind: 'loading' }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; diff: ChannelChapterDiff };

	let channelId = $state<string | null>(null);
	let chapterId = $state<number | null>(null);
	let phase = $state<Phase>({ kind: 'idle' });

	// The activity window is off until asked for, because switching it on is
	// what makes the comparison read the actions and RSVP collections at all.
	// `activeDays` is null when the box is empty — Svelte binds an empty number
	// input to null, and activity-window.ts owns what that should mean.
	let activityFilterOn = $state(false);
	let activeDays = $state<number | null>(DEFAULT_DAYS);

	const appliedDays = $derived(windowDays({ on: activityFilterOn, days: activeDays }));

	interface WalkStep {
		label: string;
		fetched: number;
		total: number | null;
	}
	let steps = $state<WalkStep[]>([]);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// A chapter that isn't cached yet takes a paginated walk to fetch, which can
	// outlast the admin's patience for the dropdown they just changed. Every
	// request carries a sequence number and only the newest one is allowed to
	// write `phase`, so a slow answer for an earlier pair can never land on top
	// of a newer pair's answer.
	let seq = 0;

	const channelLabel = $derived(data.channels.find((c) => c.id === channelId)?.label ?? '');
	const chapterLabel = $derived(data.chapters.find((c) => c.id === chapterId)?.label ?? '');

	// Progress is polled rather than streamed: the walks report into shared
	// server state anyway, so a 1.5s poll costs one tiny request and needs no
	// long-lived connection held open across a multi-minute read.
	function startPolling(): void {
		stopPolling();
		void pollProgress();
		pollTimer = setInterval(() => void pollProgress(), 1500);
	}

	function stopPolling(): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
		steps = [];
	}

	async function pollProgress(): Promise<void> {
		try {
			const res = await fetch('/api/channel-chapter-diff/progress');
			if (!res.ok) return;
			const body = (await res.json()) as { steps?: WalkStep[] };
			// Only paint progress while we are still the request being waited on.
			if (phase.kind === 'loading') steps = body.steps ?? [];
		} catch {
			// A dropped poll is not worth reporting — the next one is 1.5s away,
			// and the comparison itself is still running regardless.
		}
	}

	$effect(() => () => stopPolling());

	async function runDiff(): Promise<void> {
		if (channelId === null || chapterId === null) return;

		const mine = ++seq;
		phase = { kind: 'loading' };
		startPolling();
		try {
			const params = new URLSearchParams({
				channel: channelId,
				chapter: String(chapterId),
				...(appliedDays === null ? {} : { activeDays: String(appliedDays) }),
			});
			const res = await fetch(`/api/channel-chapter-diff?${params}`);
			const body = (await res.json().catch(() => null)) as
				(ChannelChapterDiff & { error?: string }) | null;
			if (mine !== seq) return;
			stopPolling();
			if (!res.ok) {
				// The server's refusals are written to be read, so they're shown verbatim.
				phase = { kind: 'error', message: body?.error ?? `Comparison failed (HTTP ${res.status})` };
				return;
			}
			phase = { kind: 'ready', diff: body as ChannelChapterDiff };
		} catch {
			if (mine !== seq) return;
			stopPolling();
			phase = { kind: 'error', message: 'Comparison failed. Check your connection and try again.' };
		}
	}

	/** Re-run only once there is something to re-run — before both pickers are
	 *  set, the phase is still idle and there is no comparison to update. */
	function rerun(): void {
		if (phase.kind !== 'idle') void runDiff();
	}

	function apply(next: { on: boolean; days: number | null }): void {
		activityFilterOn = next.on;
		activeDays = next.days;
		rerun();
	}

	function toggleActivityFilter(): void {
		apply(afterToggle({ on: activityFilterOn, days: activeDays }));
	}

	function changeActiveDays(): void {
		apply(afterDaysChange({ on: activityFilterOn, days: activeDays }));
	}

	function selectChannel(id: string): void {
		channelId = id;
		void runDiff();
	}

	function selectChapter(id: number): void {
		chapterId = id;
		void runDiff();
	}

	let copied = $state<'slack' | 'chapter' | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => () => {
		if (copyTimer) clearTimeout(copyTimer);
	});

	async function copy(which: 'slack' | 'chapter', emails: string[]): Promise<void> {
		try {
			await navigator.clipboard.writeText(emails.join(', '));
			copied = which;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = null), 2000);
		} catch {
			// Clipboard blocked (permissions, insecure context). The textarea below
			// holds the same text and is selectable, so there's nothing to recover
			// from — just don't claim a copy that didn't happen.
			copied = null;
		}
	}
</script>

<div class="ccd-page">
	<p class="ccd-intro">
		Compare who's in a Slack channel with who's in a Solidarity chapter. People are matched by email
		address; nothing is changed on either side.
	</p>

	<section class="ccd-pickers">
		<div class="ccd-picker">
			<label class="ccd-label" for="ccd-channel">Slack channel</label>
			<div id="ccd-channel">
				<AutocompletePicker
					items={data.channels}
					value={channelId}
					onSelect={selectChannel}
					placeholder="Search channels…"
					disabled={data.channels.length === 0}
					showSublabel
				/>
			</div>
			{#if data.errors.channels}
				<p class="ccd-notice">Slack channel list unavailable: {data.errors.channels}</p>
			{/if}
		</div>

		<div class="ccd-picker">
			<label class="ccd-label" for="ccd-chapter">Solidarity chapter</label>
			<div id="ccd-chapter">
				<AutocompletePicker
					items={data.chapters}
					value={chapterId}
					onSelect={selectChapter}
					placeholder="Search chapters…"
					disabled={data.chapters.length === 0}
				/>
			</div>
			{#if data.errors.chapters}
				<p class="ccd-notice">Solidarity chapter list unavailable: {data.errors.chapters}</p>
			{/if}
		</div>
	</section>

	<section class="ccd-activity">
		<label class="ccd-check">
			<input type="checkbox" bind:checked={activityFilterOn} onchange={toggleActivityFilter} />
			Only list Solidarity people active in the last
		</label>
		<input
			class="ccd-days"
			type="number"
			min={MIN_DAYS}
			max={MAX_DAYS}
			step="1"
			aria-label="Number of days"
			bind:value={activeDays}
			disabled={!activityFilterOn}
			onchange={changeActiveDays}
		/>
		<span class="ccd-days-unit">days</span>
		<p class="ccd-hint">
			Active means they submitted a page or RSVP'd to an event. This narrows the “in {chapterLabel ||
				'the chapter'} but not in Slack” list only — it never changes who counts as being in the chapter.
		</p>
	</section>

	{#if phase.kind === 'idle'}
		<p class="ccd-empty">Pick a channel and a chapter to compare them.</p>
	{:else if phase.kind === 'loading'}
		<p class="ccd-empty">Comparing {channelLabel} with {chapterLabel}…</p>
		{#if steps.length === 0}
			<p class="ccd-hint">Reading Slack and checking what's already cached.</p>
		{:else}
			<!-- A denominator only when Solidarity actually reported one; the rest
			     of the time an indeterminate bar and an honest row count. -->
			<ul class="ccd-steps">
				{#each steps as step (step.label)}
					<li>
						<div class="ccd-step-head">
							<span>{step.label}</span>
							<span class="ccd-step-count">
								{#if step.total !== null}
									{step.fetched.toLocaleString()} of {step.total.toLocaleString()}
								{:else}
									{step.fetched.toLocaleString()} so far
								{/if}
							</span>
						</div>
						{#if step.total !== null}
							<progress class="ccd-bar" value={step.fetched} max={step.total}></progress>
						{:else}
							<progress class="ccd-bar"></progress>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if phase.kind === 'error'}
		<p class="ccd-error">{phase.message}</p>
	{:else}
		{@const diff = phase.diff}
		<p class="ccd-summary">
			{diff.inBothCount}
			{diff.inBothCount === 1 ? 'person is' : 'people are'} in both {channelLabel} and {chapterLabel}.
		</p>

		{#each [{ key: 'slack' as const, emails: diff.inSlackOnly, heading: `In ${channelLabel} but not in ${chapterLabel}`, empty: `Everyone in ${channelLabel} is also in ${chapterLabel}.` }, { key: 'chapter' as const, emails: diff.inChapterOnly, heading: `In ${chapterLabel} but not in ${channelLabel}`, empty: `Everyone in ${chapterLabel} is also in ${channelLabel}.` }] as list (list.key)}
			<section class="ccd-list">
				<div class="ccd-list-head">
					<h2>{list.heading}</h2>
					<span class="ccd-count">{list.emails.length}</span>
					{#if list.emails.length > 0}
						<button type="button" class="ccd-copy" onclick={() => copy(list.key, list.emails)}>
							{copied === list.key ? 'Copied' : 'Copy'}
						</button>
					{/if}
				</div>
				{#if list.emails.length === 0}
					<p class="ccd-empty">{list.empty}</p>
				{:else}
					<textarea class="ccd-emails" readonly rows="6" value={list.emails.join(', ')}></textarea>
				{/if}
			</section>
		{/each}

		<!-- Without these lines the two lists plus the "in both" count silently
		     fail to add up, and an admin has no way to tell whether someone is
		     genuinely absent or just unmatchable. -->
		{#if diff.slackNoEmailCount > 0 || diff.chapterNoEmailCount > 0 || (diff.inChapterOnlyHiddenCount ?? 0) > 0}
			<ul class="ccd-caveats">
				{#if (diff.inChapterOnlyHiddenCount ?? 0) > 0}
					<li>
						{diff.inChapterOnlyHiddenCount}
						more {diff.inChapterOnlyHiddenCount === 1 ? 'person is' : 'people are'} in {chapterLabel}
						but not in {channelLabel}, hidden because they have no Solidarity action or RSVP in the
						last {appliedDays} days.
					</li>
				{/if}
				{#if diff.slackNoEmailCount > 0}
					<li>
						{diff.slackNoEmailCount}
						{diff.slackNoEmailCount === 1 ? 'channel member has' : 'channel members have'} no email on
						their Slack profile, so they couldn't be matched either way.
					</li>
				{/if}
				{#if diff.chapterNoEmailCount > 0}
					<li>
						{diff.chapterNoEmailCount}
						{diff.chapterNoEmailCount === 1 ? 'chapter member has' : 'chapter members have'} no email
						on their Solidarity record, so they couldn't be matched either way.
					</li>
				{/if}
			</ul>
		{/if}
	{/if}
</div>
