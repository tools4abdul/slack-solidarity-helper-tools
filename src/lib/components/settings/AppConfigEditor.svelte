<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import { reRank, DEFAULT_RANKING_ALPHA } from '$lib/growth-ranking.js';
	import type { LeaderboardPair, LeaderboardResult } from '$lib/server/weekly-growth-report';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import LedBoard from '$lib/components/dashboard/LedBoard.svelte';
	import DoorTicker from '$lib/components/dashboard/DoorTicker.svelte';
	import type { TickerEntry } from '$lib/server/door-knock-ticker';
	import SettingsRow from './SettingsRow.svelte';
	import { APP_CONFIG_ROW_IDS } from './sections.js';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import type { PickerItem } from './picker-types.js';
	import { createFieldAutosave, type AutosaveStatus } from './use-field-autosave.svelte.js';
	import { isoToLocalInput, localInputToIso } from '$lib/components/dashboard/countdown.js';
	import { extractChannelNames } from '$lib/channel-tokens.js';
	import { DEFAULT_WELCOME_DM } from '$lib/welcome-dm.js';
	import { DEFAULT_WARNING_DM, validateWarningTemplate } from '$lib/warning-dm.js';
	import { DEFAULT_SITE_NAME, SITE_NAME_MAX_LENGTH } from '$lib/site-name.js';
	import {
		DEFAULT_TICKER_COLUMNS_PER_SECOND,
		RECOMMENDED_TICKER_RATES,
		MAX_TICKER_COLUMNS_PER_SECOND,
		MIN_TICKER_COLUMNS_PER_SECOND,
	} from '$lib/ticker-speed.js';

	interface ChannelOption {
		id: string;
		name: string;
		isPrivate: boolean;
	}

	interface Props {
		channels: ChannelOption[];
		/** Effective values from loadSettings ('' / undefined when unset). */
		trackingChannelId: string;
		growthReportChannelId: string;
		/** Effective Mobilize-sync alert channel — the growth-report channel
		 *  when no override is set. */
		mobilizeSyncChannelId: string;
		/** Effective VAN turf alert channel — the tracking channel when no
		 *  override is set. */
		turfChannelId: string;
		/** Admin channel for member note/warning announcements ('' = off). */
		memberNoteChannelId: string;
		/** Contact published on events the sync creates in Mobilize ('' when
		 *  neither /settings nor the MOBILIZE_CONTACT_* env vars set it). */
		siteName: string;
		mobilizeContactName: string;
		mobilizeContactEmail: string;
		mobilizeContactPhone: string;
		rankingAlpha: number | undefined;
		/** Header countdown config ('' when unset). */
		countdownLabel: string;
		countdownEndAt: string;
		/** New-member welcome DM template ('' means "use the built-in default"). */
		welcomeDmMessage: string;
		/** Warning DM template ('' means "use the built-in default"). */
		warningDmMessage: string;
		/** Door-knock ticker scroll speed, in LED columns per second. */
		tickerColumnsPerSecond: number;
		/** Today's real standings for the speed preview; [] before the first
		 *  canvasser snapshot, in which case the preview uses sample names. */
		tickerEntries: TickerEntry[];
		/** Saved/live leaderboards with UNTRIMMED topChapters — the slider
		 *  preview re-ranks them client-side. */
		leaderboard: LeaderboardPair;
	}

	let {
		channels,
		trackingChannelId,
		growthReportChannelId,
		mobilizeSyncChannelId,
		turfChannelId,
		memberNoteChannelId,
		siteName,
		mobilizeContactName,
		mobilizeContactEmail,
		mobilizeContactPhone,
		rankingAlpha,
		countdownLabel,
		countdownEndAt,
		welcomeDmMessage,
		warningDmMessage,
		tickerColumnsPerSecond,
		tickerEntries,
		leaderboard,
	}: Props = $props();

	const channelItems = $derived<PickerItem<string>[]>(
		channels.map((c) => ({
			id: c.id,
			label: `#${c.name}`,
			sublabel: c.isPrivate ? '🔒 private' : undefined,
		})),
	);

	async function postAppConfig(patch: Record<string, unknown>): Promise<void> {
		const res = await fetch('/api/settings/app-config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) {
			const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
		}
	}

	// --- Channel rows — pessimistic save: the picker's value only moves once
	// the server accepted the pick, so a failed save visibly snaps back.

	interface ChannelField {
		value: string;
		status: AutosaveStatus;
		error: string | null;
		lastFailedId: string | null;
	}

	let tracking = $state<ChannelField>({
		value: trackingChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});
	let growthReport = $state<ChannelField>({
		value: growthReportChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});
	let mobilizeSync = $state<ChannelField>({
		value: mobilizeSyncChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});
	let turf = $state<ChannelField>({
		value: turfChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});
	let memberNote = $state<ChannelField>({
		value: memberNoteChannelId,
		status: 'idle',
		error: null,
		lastFailedId: null,
	});

	async function saveChannel(field: ChannelField, key: string, channelId: string): Promise<void> {
		field.status = 'saving';
		field.error = null;
		try {
			await postAppConfig({ [key]: channelId });
			field.value = channelId;
			field.lastFailedId = null;
			field.status = 'saved';
			setTimeout(() => {
				if (field.status === 'saved') field.status = 'idle';
			}, 2000);
		} catch (e) {
			field.status = 'error';
			field.error = errMessage(e);
			field.lastFailedId = channelId;
		}
	}

	// --- Ranking alpha — debounced autosave; the preview below re-ranks
	// instantly from the local value while the save waits for the slider to
	// settle.

	const alphaSave = createFieldAutosave<number>({
		initial: rankingAlpha ?? DEFAULT_RANKING_ALPHA,
		parse: (raw) => parseFloat(raw),
		save: (value) => postAppConfig({ slackGrowthReportRankingAlpha: value }),
	});

	// --- Mobilize event contact — debounced autosave. The v1 API requires a
	// contact on every event create and update, and Solidarity events carry no
	// contact data of their own, so without one here the sync cannot write at all.

	// Shown after every page's own name in the browser tab, and as the header
	// title on pages that don't set one of their own.
	const siteNameSave = createFieldAutosave<string>({
		initial: siteName,
		save: (value) => postAppConfig({ siteName: value }),
	});

	const contactNameSave = createFieldAutosave<string>({
		initial: mobilizeContactName,
		save: (value) => postAppConfig({ mobilizeContactName: value }),
	});
	const contactEmailSave = createFieldAutosave<string>({
		initial: mobilizeContactEmail,
		save: (value) => postAppConfig({ mobilizeContactEmail: value }),
	});
	const contactPhoneSave = createFieldAutosave<string>({
		initial: mobilizeContactPhone,
		save: (value) => postAppConfig({ mobilizeContactPhone: value }),
	});

	const contactSaves = $derived([contactNameSave, contactEmailSave, contactPhoneSave]);
	const contactStatus = $derived(contactSaves.find((f) => f.status !== 'idle')?.status ?? 'idle');
	const contactError = $derived(contactSaves.find((f) => f.error)?.error ?? null);
	const contactRetry = $derived(contactSaves.find((f) => f.status === 'error')?.retry);

	// --- Header countdown — debounced autosave like the alpha slider. The
	// datetime-local input speaks local time; the API stores canonical ISO, so
	// the value converts on the way in and out. An empty date clears the
	// countdown (the header hides it).

	const countdownLabelSave = createFieldAutosave<string>({
		initial: countdownLabel,
		save: (value) => postAppConfig({ countdownLabel: value }),
	});

	const countdownEndSave = createFieldAutosave<string>({
		initial: isoToLocalInput(countdownEndAt),
		save: (value) => postAppConfig({ countdownEndAt: localInputToIso(value) }),
	});

	// --- Welcome DM template — debounced autosave. `{{channels}}` and friendly
	// `#channel-name` tokens are resolved server-side when the DM is sent; the
	// preview and warning below are computed locally from the channel list.

	const welcomeDmSave = createFieldAutosave<string>({
		initial: welcomeDmMessage,
		save: (value) => postAppConfig({ welcomeDmMessage: value }),
	});

	// --- Warning DM template — same autosave shape as the welcome DM. An admin
	// can also override the text per-warning in the Slack modal; this is the
	// default that box is seeded with.

	const warningDmSave = createFieldAutosave<string>({
		initial: warningDmMessage,
		save: (value) => postAppConfig({ warningDmMessage: value }),
	});

	// --- Door-knock ticker speed — debounced autosave like the alpha slider.
	// Measured in LED columns per second because that is what the board
	// actually does: it advances one column per animation step.

	const tickerSpeedSave = createFieldAutosave<number>({
		initial: tickerColumnsPerSecond,
		parse: (raw) => parseInt(raw, 10),
		save: (value) => postAppConfig({ doorTickerColumnsPerSecond: value }),
	});

	// How long each step is held, in frames. A whole number means every step is
	// identical; otherwise the browser alternates between the floor and the
	// ceiling, and the shorter the step the more that one-frame swing shows.
	// Both common refresh rates are reported because they disagree: 40/sec is
	// a 3:2 alternation at 60 Hz but exactly 3 frames at 120 Hz, which makes it
	// the one good choice in the 30–60 gap. Nothing in the UI hard-codes that —
	// the numbers just show it.
	function cadence(rate: number, refresh: number) {
		const frames = refresh / rate;
		return {
			frames,
			even: Number.isInteger(frames),
			label: Number.isInteger(frames) ? `${frames}` : frames.toFixed(2),
		};
	}
	const at60 = $derived(cadence(tickerSpeedSave.value, 60));
	const at120 = $derived(cadence(tickerSpeedSave.value, 120));

	// Stand-ins so the slider still previews before the first canvasser
	// snapshot lands. Same shape the dashboard renders.
	const SAMPLE_TICKER: TickerEntry[] = [
		{ canvasser: 'Maria Torres', doors: 412, chapter: 'Wayne', rank: 1 },
		{ canvasser: 'James Rowe', doors: 388, chapter: 'Washtenaw', rank: 2 },
		{ canvasser: 'Aisha Bell', doors: 351, chapter: 'Wayne', rank: 3 },
		{ canvasser: 'Kai Nguyen', doors: 231, chapter: 'Ingham', rank: 4 },
		{ canvasser: 'Ruth Feld', doors: 198, chapter: 'Oakland', rank: 5 },
	];
	const previewTicker = $derived(tickerEntries.length > 0 ? tickerEntries : SAMPLE_TICKER);

	$effect(() => () => {
		siteNameSave.destroy();
		alphaSave.destroy();
		tickerSpeedSave.destroy();
		countdownLabelSave.destroy();
		countdownEndSave.destroy();
		welcomeDmSave.destroy();
		warningDmSave.destroy();
	});

	const knownChannelNames = $derived(new Set(channels.map((c) => c.name.toLowerCase())));

	// `#name` tokens in the current draft that don't match any known channel —
	// the save endpoint rejects these, so warn before the admin hits that.
	const unknownChannels = $derived(
		extractChannelNames(welcomeDmSave.value).filter((n) => !knownChannelNames.has(n)),
	);

	// Human-readable preview: the effective message (default when blank) with
	// `{{channels}}` shown as a sample chapter channel. `#name` tokens stay as-is
	// since that's exactly how they read in Slack.
	const previewText = $derived(
		(welcomeDmSave.value.trim() || DEFAULT_WELCOME_DM).replaceAll(
			'{{channels}}',
			'#your-chapter-channel',
		),
	);

	const unknownWarningChannels = $derived(
		extractChannelNames(warningDmSave.value).filter((n) => !knownChannelNames.has(n)),
	);

	// Mirrors the server-side check so a missing or misspelled token surfaces
	// while typing rather than as a save failure.
	const warningTemplateError = $derived.by(() => {
		const result = validateWarningTemplate(warningDmSave.value);
		return result.ok ? null : result.error;
	});

	// Sample values matching the "send to me" preview: number 2 so the ordinal
	// is actually exercised.
	const warningPreviewText = $derived(
		(warningDmSave.value.trim() || DEFAULT_WARNING_DM)
			.replaceAll('{{nth}}', 'second')
			.replaceAll('{{note}}', '> Example: posting off-topic links after being asked to stop.')
			.replaceAll(
				'{{message_link}}',
				'This is regarding: https://slack.com/archives/C0EXAMPLE/p1712345678123456',
			)
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
	);

	// --- "Send this DM to me" test button.

	let testStatus = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
	let testError = $state<string | null>(null);

	let warningTestStatus = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
	let warningTestError = $state<string | null>(null);

	async function postTestDm(url: string, body: Record<string, string>): Promise<void> {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(parsed?.error ?? `Send failed (HTTP ${res.status})`);
		}
	}

	async function sendTestDm(): Promise<void> {
		testStatus = 'sending';
		testError = null;
		try {
			await postTestDm('/api/settings/welcome-dm-test', {
				welcomeDmMessage: welcomeDmSave.value,
			});
			testStatus = 'sent';
			setTimeout(() => {
				if (testStatus === 'sent') testStatus = 'idle';
			}, 3000);
		} catch (e) {
			testStatus = 'error';
			testError = errMessage(e);
		}
	}

	async function sendTestWarningDm(): Promise<void> {
		warningTestStatus = 'sending';
		warningTestError = null;
		try {
			await postTestDm('/api/settings/warning-dm-test', {
				warningDmMessage: warningDmSave.value,
			});
			warningTestStatus = 'sent';
			setTimeout(() => {
				if (warningTestStatus === 'sent') warningTestStatus = 'idle';
			}, 3000);
		} catch (e) {
			warningTestStatus = 'error';
			warningTestError = errMessage(e);
		}
	}

	const previewPair = $derived.by<LeaderboardPair>(() => {
		const alpha = alphaSave.value;
		const rerank = (r: LeaderboardResult): LeaderboardResult =>
			r.ok
				? {
						ok: true,
						leaderboard: {
							...r.leaderboard,
							topChapters: reRank(r.leaderboard.topChapters, alpha),
						},
					}
				: r;
		return { saved: rerank(leaderboard.saved), live: rerank(leaderboard.live) };
	});
</script>

<div class="app-config-editor">
	<SettingsRow
		id={APP_CONFIG_ROW_IDS.siteName}
		label="Site name"
		status={siteNameSave.status}
		error={siteNameSave.error}
		onRetry={siteNameSave.status === 'error' ? siteNameSave.retry : undefined}
	>
		<input
			class="site-name-input"
			type="text"
			maxlength={SITE_NAME_MAX_LENGTH}
			placeholder={DEFAULT_SITE_NAME}
			value={siteNameSave.value}
			oninput={siteNameSave.oninput}
		/>
		<p class="site-name-note">
			Shown after each page's name in the browser tab — "Dashboard — {siteNameSave.value.trim() ||
				DEFAULT_SITE_NAME}". Leave blank to use "{DEFAULT_SITE_NAME}".
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.trackingChannel}
		label="Volunteer-help tracking channel"
		status={tracking.status}
		error={tracking.error}
		onRetry={tracking.lastFailedId
			? () => void saveChannel(tracking, 'slackTrackingChannelId', tracking.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={tracking.value || null}
			onSelect={(id) => void saveChannel(tracking, 'slackTrackingChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">
			Where “volunteer needs help joining Slack” webhook notifications are posted.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.growthReportChannel}
		label="Weekly growth report channel"
		status={growthReport.status}
		error={growthReport.error}
		onRetry={growthReport.lastFailedId
			? () =>
					void saveChannel(growthReport, 'slackGrowthReportChannelId', growthReport.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={growthReport.value || null}
			onSelect={(id) => void saveChannel(growthReport, 'slackGrowthReportChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">Where the Monday chapter-growth leaderboard is posted.</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.mobilizeSyncChannel}
		label="Mobilize sync channel"
		status={mobilizeSync.status}
		error={mobilizeSync.error}
		onRetry={mobilizeSync.lastFailedId
			? () =>
					void saveChannel(mobilizeSync, 'slackMobilizeSyncChannelId', mobilizeSync.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={mobilizeSync.value || null}
			onSelect={(id) => void saveChannel(mobilizeSync, 'slackMobilizeSyncChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">
			Where the nightly Solidarity → Mobilize event sync and attendee sync post their alerts —
			including the one that says Mobilize rejected the API key. Defaults to the weekly growth
			report channel until you pick one here.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.turfChannel}
		label="Turf sync channel"
		status={turf.status}
		error={turf.error}
		onRetry={turf.lastFailedId
			? () => void saveChannel(turf, 'slackTurfChannelId', turf.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={turf.value || null}
			onSelect={(id) => void saveChannel(turf, 'slackTurfChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">
			Where the VAN turf catalog sync and the map-geometry worker post their alerts — sync notices
			and turfs that could not be drawn. Defaults to the volunteer-help tracking channel until you
			pick one here.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.mobilizeContact}
		label="Mobilize event contact"
		status={contactStatus}
		error={contactError}
		onRetry={contactRetry}
	>
		<div class="countdown-fields">
			<label class="countdown-field">
				<span class="countdown-field-label">Name</span>
				<input
					type="text"
					maxlength="200"
					placeholder="e.g. Field Team"
					value={contactNameSave.value}
					oninput={contactNameSave.oninput}
				/>
			</label>
			<label class="countdown-field">
				<span class="countdown-field-label">Email</span>
				<input
					type="email"
					maxlength="200"
					placeholder="e.g. events@example.org"
					value={contactEmailSave.value}
					oninput={contactEmailSave.oninput}
				/>
			</label>
			<label class="countdown-field">
				<span class="countdown-field-label">Phone</span>
				<input
					type="tel"
					maxlength="200"
					placeholder="optional"
					value={contactPhoneSave.value}
					oninput={contactPhoneSave.oninput}
				/>
			</label>
		</div>
		<p class="app-config-note">
			The contact listed on events the sync creates in Mobilize. Mobilize requires one on every
			event, and Solidarity events don't carry contact details, so <strong
				>the event sync cannot run without an email here</strong
			>
			(or in <code>MOBILIZE_CONTACT_EMAIL</code>). Clearing a field falls back to its
			<code>MOBILIZE_CONTACT_*</code> environment variable.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.countdown}
		label="Header countdown"
		status={countdownEndSave.status === 'idle'
			? countdownLabelSave.status
			: countdownEndSave.status}
		error={countdownEndSave.error ?? countdownLabelSave.error}
		onRetry={countdownEndSave.status === 'error'
			? countdownEndSave.retry
			: countdownLabelSave.status === 'error'
				? countdownLabelSave.retry
				: undefined}
	>
		<div class="countdown-fields">
			<label class="countdown-field">
				<span class="countdown-field-label">Label</span>
				<input
					type="text"
					maxlength="80"
					placeholder="e.g. Petition deadline"
					value={countdownLabelSave.value}
					oninput={countdownLabelSave.oninput}
				/>
			</label>
			<label class="countdown-field">
				<span class="countdown-field-label">Ends at</span>
				<input
					type="datetime-local"
					value={countdownEndSave.value}
					oninput={countdownEndSave.oninput}
				/>
			</label>
		</div>
		<p class="app-config-note">
			Shown as a large days/hours/minutes/seconds countdown at the top of the dashboard, above the
			Solidarity signups chart. Clear the date to hide it.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.welcomeDm}
		label="New-member welcome DM"
		status={welcomeDmSave.status}
		error={welcomeDmSave.error}
		onRetry={welcomeDmSave.status === 'error' ? welcomeDmSave.retry : undefined}
	>
		<textarea
			class="welcome-dm-input"
			rows="4"
			maxlength="3000"
			placeholder={DEFAULT_WELCOME_DM}
			value={welcomeDmSave.value}
			oninput={welcomeDmSave.oninput}></textarea>
		<p class="app-config-note">
			The DM sent to each new member after they're added to their chapter channel(s). Use
			<code>{'{{channels}}'}</code> where the list of channels they were added to should appear, and
			write a channel name like <code>#general</code> to link any other channel. Leave blank to use the
			default message.
		</p>
		{#if unknownChannels.length > 0}
			<p class="welcome-dm-warning">
				⚠️ Unknown channel{unknownChannels.length > 1 ? 's' : ''}: {unknownChannels
					.map((n) => `#${n}`)
					.join(', ')} — saving will fail until these match a real channel.
			</p>
		{/if}
		<div class="welcome-dm-preview">
			<span class="welcome-dm-preview-label">Preview</span>
			<p class="welcome-dm-preview-body">{previewText}</p>
		</div>
		<div class="welcome-dm-test">
			<button
				type="button"
				class="welcome-dm-test-btn"
				onclick={sendTestDm}
				disabled={testStatus === 'sending'}
			>
				{testStatus === 'sending' ? 'Sending…' : 'Send this DM to me'}
			</button>
			{#if testStatus === 'sent'}
				<span class="welcome-dm-test-ok">Sent — check your Slack DMs.</span>
			{:else if testStatus === 'error'}
				<span class="welcome-dm-test-err">{testError}</span>
			{/if}
		</div>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.memberNotesChannel}
		label="Member notes channel"
		status={memberNote.status}
		error={memberNote.error}
		onRetry={memberNote.lastFailedId
			? () => void saveChannel(memberNote, 'slackMemberNoteChannelId', memberNote.lastFailedId!)
			: undefined}
	>
		<AutocompletePicker
			items={channelItems}
			value={memberNote.value || null}
			onSelect={(id) => void saveChannel(memberNote, 'slackMemberNoteChannelId', id)}
			placeholder="Pick a channel…"
			showSublabel={true}
		/>
		<p class="app-config-note">
			Where a line is posted each time an admin logs a member note or warning, so moderation is
			visible to every admin rather than only whoever filed it. Make this a private admin channel —
			the note text and the warning sent to the member both appear in it. Leave unset to post
			nothing.
		</p>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.warningDm}
		label="Warning DM"
		status={warningDmSave.status}
		error={warningDmSave.error}
		onRetry={warningDmSave.status === 'error' ? warningDmSave.retry : undefined}
	>
		<textarea
			class="welcome-dm-input"
			rows="5"
			maxlength="3000"
			placeholder={DEFAULT_WARNING_DM}
			value={warningDmSave.value}
			oninput={warningDmSave.oninput}></textarea>
		<p class="app-config-note">
			The DM a member receives when an admin logs a warning against them with
			<code>/member-note</code>. Use <code>{'{{nth}}'}</code> for which warning this is (“first”,
			“second”…), <code>{'{{note}}'}</code> for the details the admin typed, and
			<code>{'{{message_link}}'}</code> for the linked Slack message. Write a channel name like
			<code>#general</code> to link it. Admins can edit the text for an individual warning before sending;
			this is the default they start from. Leave blank to use the default message.
		</p>
		{#if warningTemplateError}
			<p class="welcome-dm-warning">⚠️ {warningTemplateError}</p>
		{/if}
		{#if unknownWarningChannels.length > 0}
			<p class="welcome-dm-warning">
				⚠️ Unknown channel{unknownWarningChannels.length > 1 ? 's' : ''}: {unknownWarningChannels
					.map((n) => `#${n}`)
					.join(', ')} — saving will fail until these match a real channel.
			</p>
		{/if}
		<div class="welcome-dm-preview">
			<span class="welcome-dm-preview-label">Preview (as a second warning)</span>
			<p class="welcome-dm-preview-body">{warningPreviewText}</p>
		</div>
		<div class="welcome-dm-test">
			<button
				type="button"
				class="welcome-dm-test-btn"
				onclick={sendTestWarningDm}
				disabled={warningTestStatus === 'sending'}
			>
				{warningTestStatus === 'sending' ? 'Sending…' : 'Send this DM to me'}
			</button>
			{#if warningTestStatus === 'sent'}
				<span class="welcome-dm-test-ok">Sent — check your Slack DMs.</span>
			{:else if warningTestStatus === 'error'}
				<span class="welcome-dm-test-err">{warningTestError}</span>
			{/if}
		</div>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.rankingAlpha}
		label="Growth report ranking α = {alphaSave.value.toFixed(2)}"
		status={alphaSave.status}
		error={alphaSave.error}
		onRetry={alphaSave.status === 'error' ? alphaSave.retry : undefined}
	>
		<div class="alpha-control">
			<span class="alpha-end">Biggest gain</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={alphaSave.value}
				oninput={alphaSave.oninput}
				aria-label="Growth report ranking alpha"
			/>
			<span class="alpha-end">Fastest growth</span>
		</div>
		<p class="app-config-note">
			Chapters are ranked by <code>new joins ÷ (existing + 1)^α</code>. At α&nbsp;=&nbsp;0 the
			report ranks by absolute new joins (large chapters tend to win); at α&nbsp;=&nbsp;1 by pure
			relative growth (small chapters tend to win). Default {DEFAULT_RANKING_ALPHA}. The preview
			below re-ranks the current data as you drag.
		</p>
		<div class="alpha-preview">
			<SlackLeaderboard leaderboard={previewPair} />
		</div>
	</SettingsRow>

	<SettingsRow
		id={APP_CONFIG_ROW_IDS.tickerSpeed}
		label="Doors ticker speed = {tickerSpeedSave.value} columns/sec"
		status={tickerSpeedSave.status}
		error={tickerSpeedSave.error}
		onRetry={tickerSpeedSave.status === 'error' ? tickerSpeedSave.retry : undefined}
	>
		<div class="alpha-control">
			<span class="alpha-end">Slower</span>
			<input
				type="range"
				min={MIN_TICKER_COLUMNS_PER_SECOND}
				max={MAX_TICKER_COLUMNS_PER_SECOND}
				step="1"
				value={tickerSpeedSave.value}
				oninput={tickerSpeedSave.oninput}
				aria-label="Doors ticker speed in LED columns per second"
			/>
			<span class="alpha-end">Faster</span>
		</div>
		<p class="app-config-note">
			How fast the dashboard's doors-knocked ticker scrolls. The board moves one LED column per
			step, so this is its speed in columns per second. Default {DEFAULT_TICKER_COLUMNS_PER_SECOND};
			the {MAX_TICKER_COLUMNS_PER_SECOND} ceiling is one column per frame on a 60&nbsp;Hz screen, the
			fastest a browser can actually draw without skipping columns.
		</p>
		<p class="app-config-note" class:ticker-speed-warn={!at60.even && !at120.even}>
			Each step is held {at60.label} frame{at60.frames === 1 ? '' : 's'} at 60&nbsp;Hz and {at120.label}
			at 120&nbsp;Hz.
			{#if at60.even && at120.even}
				Every step the same length on both.
			{:else if at60.even}
				Even at 60&nbsp;Hz; at 120&nbsp;Hz steps alternate between {Math.floor(at120.frames)} and {Math.ceil(
					at120.frames,
				)}.
			{:else if at120.even}
				Even at 120&nbsp;Hz; at 60&nbsp;Hz steps alternate between {Math.floor(at60.frames)} and {Math.ceil(
					at60.frames,
				)} — a regular alternation, not a drift.
			{:else}
				Steps alternate on both. Any rate works, but the shorter the step the more that one-frame
				swing shows. Smoothest: {RECOMMENDED_TICKER_RATES.join(', ')}.
			{/if}
		</p>
		<div class="ticker-preview">
			<LedBoard>
				<DoorTicker entries={previewTicker} columnsPerSecond={tickerSpeedSave.value} />
			</LedBoard>
			{#if tickerEntries.length === 0}
				<p class="app-config-note">No doors recorded yet today — previewing with sample names.</p>
			{/if}
		</div>
	</SettingsRow>
</div>

<style>
	.app-config-editor {
		margin-top: 12px;
		max-width: 720px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.app-config-note {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 6px 0 0;
	}

	.app-config-note code {
		font-size: 0.95em;
	}

	/* Advisory, not an error — an uneven rate still works. */
	.ticker-speed-warn {
		color: var(--color-warning);
	}

	.ticker-preview {
		margin-top: 10px;
	}

	.countdown-fields {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.countdown-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.countdown-field-label {
		font-size: 0.8em;
		color: var(--color-text-muted);
	}

	.countdown-field input {
		padding: 6px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
	}

	.countdown-field input[type='text'] {
		min-width: 220px;
	}

	.alpha-control {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 480px;
	}

	.alpha-control input[type='range'] {
		flex: 1;
		accent-color: var(--color-gold);
	}

	.alpha-end {
		font-size: 0.8em;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.alpha-preview {
		margin-top: 8px;
	}

	.welcome-dm-input {
		width: 100%;
		max-width: 560px;
		padding: 8px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font: inherit;
		line-height: 1.5;
		color: var(--color-text);
		background: var(--color-surface);
		resize: vertical;
	}

	.welcome-dm-warning {
		color: var(--color-error);
		font-size: 0.9em;
		margin: 6px 0 0;
	}

	.welcome-dm-preview {
		margin-top: 8px;
		max-width: 560px;
		padding: 8px 12px;
		border-left: 3px solid var(--color-gold);
		background: var(--color-surface-alt);
		border-radius: var(--radius-md);
	}

	.welcome-dm-preview-label {
		display: block;
		font-size: 0.75em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
		margin-bottom: 4px;
	}

	.welcome-dm-preview-body {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.5;
	}

	.welcome-dm-test {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 10px;
	}

	.welcome-dm-test-btn {
		padding: 6px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		cursor: pointer;
	}

	.welcome-dm-test-btn:hover:not(:disabled) {
		border-color: var(--color-gold);
	}

	.welcome-dm-test-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.welcome-dm-test-ok {
		color: var(--color-success);
		font-size: 0.9em;
	}

	.welcome-dm-test-err {
		color: var(--color-error);
		font-size: 0.9em;
	}

	.site-name-input {
		width: 100%;
		max-width: 340px;
		padding: 6px 8px;
		font-family: inherit;
		font-size: var(--font-size-md);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.site-name-note {
		margin: 8px 0 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		line-height: 1.5;
	}
</style>
