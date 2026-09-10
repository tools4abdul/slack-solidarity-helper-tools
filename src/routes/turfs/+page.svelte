<script lang="ts">
	// The volunteer turf-checkout page.
	//
	// The organizer walkthrough at /turfs?demo is the same layout over
	// fabricated data; both share turf-page.css and TurfMap so the demo stays a
	// faithful preview rather than drifting into a separate design.
	//
	// What the server decided, and this file must not second-guess: which
	// chapter's turf is in `data.turfs` (the payload is the compartment), the
	// visible status of each turf, and whether a list number was issued. This
	// component renders what it was given and posts actions back.

	import '$lib/components/turfs/turf-page.css';
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { formatDistance, haversineMeters, type LatLng } from '$lib/van/geometry.js';
	import { statusLabel } from '$lib/van/turf-status.js';
	import TurfMap from '$lib/components/turfs/TurfMap.svelte';
	import { mappableTurfs, type TurfView } from '$lib/van/turf-view.js';

	const { data } = $props();

	let selectedId = $state<number | null>(null);
	let copied = $state<Record<number, boolean>>({});
	let busy = $state<Record<number, boolean>>({});
	let error = $state<string | null>(null);
	/** List numbers handed back by a successful claim this session. The load
	 *  function only issues one for turf you already held when the page
	 *  rendered, so a fresh claim needs somewhere to put it until the
	 *  invalidate lands. */
	let issued = $state<Record<number, string>>({});

	/** Browser geolocation, requested once and never blocking. A volunteer who
	 *  declines still gets the map (framed on all the turf) and the full list —
	 *  see 6.4: the list must be usable with no map and no location at all. */
	let geoLocation = $state<LatLng | null>(null);
	let locationState = $state<'idle' | 'asking' | 'granted' | 'denied'>('idle');
	/** Live geolocation when we have it, otherwise whatever the server resolved
	 *  from a submitted ZIP. Both are just a point to measure distance from. */
	const location = $derived<LatLng | null>(geoLocation ?? data.location ?? null);

	function askForLocation() {
		if (!navigator.geolocation) {
			locationState = 'denied';
			return;
		}
		locationState = 'asking';
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				geoLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
				locationState = 'granted';
			},
			() => {
				locationState = 'denied';
			},
			{ timeout: 10_000, maximumAge: 300_000 },
		);
	}

	/** Turf fetched by panning the map, merged over what the load function
	 *  gave us. Keyed by mapRouteId so a turf that arrives from both sources
	 *  appears once, with the fresher copy winning. */
	let paged = $state<Record<number, TurfView>>({});
	let loadingMore = $state(false);
	/** The chapter's total, refreshed by whichever request answered last. It is
	 *  a total rather than a remainder precisely so panning cannot make it
	 *  disagree with the number of rows on screen. */
	let totalNow = $state<number | null>(null);
	/** The last viewport actually fetched.
	 *
	 *  This is a loop-breaker, not an optimisation. Before the volunteer pans,
	 *  the map has no camera of its own and frames itself from the turf it was
	 *  given — so merging fetched turf changes the frame, which re-fires
	 *  `onviewport`, which fetches, which changes the frame. Left alone that
	 *  spins at the debounce interval until the request budget cuts it off,
	 *  and the map is then stuck on 429s for a minute. Comparing the box
	 *  itself stops it at the source: the same view never fetches twice. */
	let lastBbox = '';

	/** The chapter currently on screen, as a plain value.
	 *
	 *  This exists so the effect below can depend on the chapter ID rather than
	 *  on `data`. Reading `data.chapter?.chapterId` directly inside an effect
	 *  does NOT narrow the dependency to that number — the effect subscribes to
	 *  the `data` prop itself and re-runs whenever SvelteKit hands over a new
	 *  object, which `invalidateAll()` does on every claim. A `$derived` gates
	 *  on value equality, so an unchanged chapter id notifies nobody. */
	const shownChapterId = $derived(data.chapter?.chapterId ?? null);

	// Cleared when the CHAPTER changes, and only then. Clearing on every `data`
	// change would empty the map after each claim — invalidateAll() refreshes
	// `data.turfs`, but nothing moves the viewport afterwards, so the turf the
	// volunteer had panned to would vanish until they dragged the map again.
	$effect(() => {
		void shownChapterId;
		paged = {};
		totalNow = null;
		lastBbox = '';
	});

	const turfs = $derived.by<TurfView[]>(() => {
		// A plain record rather than a Map: this is a transient dedupe inside a
		// derived, not reactive state, and `paged` is already keyed the same way.
		//
		// Order matters. The load function's rows are written LAST so they win:
		// they are re-fetched on every claim and release, while a paged row is
		// only as fresh as the last pan. Letting a stale paged copy override
		// them would show turf as available seconds after someone took it.
		const byId: Record<number, TurfView> = {};
		for (const turf of Object.values(paged)) byId[turf.mapRouteId] = turf;
		for (const turf of data.turfs ?? []) byId[turf.mapRouteId] = turf;
		const all = Object.values(byId);
		if (!data.demo) return all;
		// In demo mode the ledger is this component's own state, since there is
		// no server round trip to re-derive status from.
		return all.map((turf) =>
			demoStatus[turf.mapRouteId]
				? {
						...turf,
						status: demoStatus[turf.mapRouteId]!,
						claimable: demoStatus[turf.mapRouteId] === 'available',
						printedListNumber:
							demoStatus[turf.mapRouteId] === 'held-by-you' ? DEMO_LIST_NUMBER : null,
					}
				: turf,
		);
	});

	/** Demo turf carries no list number in its payload — the real page only
	 *  issues one on a successful claim, and the walkthrough has to show that
	 *  same behaviour or it stops previewing the real flow. */
	const DEMO_LIST_NUMBER = '35536745-88712';
	const drawable = $derived(mappableTurfs(turfs));
	const unmappable = $derived(turfs.length - drawable.length);
	const total = $derived(totalNow ?? data.total ?? 0);
	const shown = $derived(turfs.length);

	/** Fetch turf for the area the map settled on. Failures are silent by
	 *  design: the rows already on screen are still valid and still claimable,
	 *  and an error banner for a background top-up would be noise. */
	async function loadViewport(bounds: {
		minLat: number;
		maxLat: number;
		minLng: number;
		maxLng: number;
	}) {
		if (!data.chapter || loadingMore) return;
		const bbox = [bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng]
			.map((n) => n.toFixed(5))
			.join(',');
		if (bbox === lastBbox) return;
		lastBbox = bbox;

		loadingMore = true;
		try {
			// Demo mode pages against the same endpoint, so the walkthrough
			// exercises the real request/merge path rather than a stand-in.
			// Built as a string rather than URLSearchParams: this is a one-shot
			// value, not reactive state, and the lint rule that would otherwise
			// push it to SvelteURLSearchParams exists for the latter.
			const demoQuery = data.demo ? `&demo=${data.asAdmin ? '&view=admin' : ''}` : '';
			const res = await fetch(
				`/api/turfs?chapter=${data.chapter.chapterId}&bbox=${encodeURIComponent(bbox)}${demoQuery}`,
			);
			if (!res.ok) {
				// Let the same viewport be retried once the user moves back to it,
				// rather than remembering a box we never actually loaded.
				lastBbox = '';
				return;
			}
			const body = (await res.json()) as { turfs: TurfView[]; total: number };
			// Only reassign when something genuinely new arrived. A fresh object
			// every time would re-trigger every downstream derived — including
			// the map's own framing — for no change in content.
			const added = body.turfs.filter((t) => !(t.mapRouteId in paged));
			if (added.length > 0) {
				const next = { ...paged };
				for (const turf of added) next[turf.mapRouteId] = turf;
				paged = next;
			}
			totalNow = body.total;
		} catch {
			// Offline or a dropped request. Keep what we have — but forget the
			// box, for the same reason the !res.ok branch above does: otherwise
			// panning back to this exact viewport returns early on the
			// `bbox === lastBbox` check and never retries, leaving the area
			// permanently empty for the rest of the session.
			lastBbox = '';
		} finally {
			loadingMore = false;
		}
	}

	const distances = $derived.by(() => {
		const here = location;
		const out: Record<number, number> = {};
		if (!here) return out;
		for (const turf of turfs) {
			if (turf.centre) out[turf.mapRouteId] = haversineMeters(here, turf.centre);
		}
		return out;
	});

	// Yours first, then available, then everything else; within a band, nearest
	// first when we know where you are. A volunteer opening this wants the
	// closest thing they can actually take.
	const sortedTurfs = $derived(
		[...turfs].sort((a, b) => {
			const rank = (t: TurfView) =>
				t.status === 'held-by-you' ? 0 : t.status === 'available' ? 1 : 2;
			return (
				rank(a) - rank(b) ||
				(distances[a.mapRouteId] ?? Infinity) - (distances[b.mapRouteId] ?? Infinity) ||
				a.name.localeCompare(b.name)
			);
		}),
	);

	const myTurfs = $derived(turfs.filter((t) => t.status === 'held-by-you'));
	const availableCount = $derived(turfs.filter((t) => t.status === 'available').length);
	const freshest = $derived(
		turfs.map((t) => t.refreshedMinutesAgo).filter((m): m is number => m !== null)[0] ?? null,
	);

	function select(mapRouteId: number) {
		selectedId = mapRouteId;
	}
	function toggle(mapRouteId: number) {
		selectedId = selectedId === mapRouteId ? null : mapRouteId;
	}

	let listEl = $state<HTMLUListElement | null>(null);

	$effect(() => {
		if (selectedId === null || !listEl) return;
		listEl.querySelector('.turf-row.is-selected')?.scrollIntoView({
			block: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
		});
	});

	/** Demo claims mutate this and nothing else. Keyed by turf, and reset on
	 *  reload — the point is to rehearse the flow, not to persist anything. */
	let demoStatus = $state<Record<number, 'held-by-you' | 'available'>>({});

	async function act(turf: TurfView, action: 'claim' | 'release' | 'complete') {
		// Checked first and returning early, so a demo action can never reach
		// the network. The fabricated route ids would almost certainly 404
		// against van_turfs anyway, but "almost certainly" is not a guarantee
		// worth resting a write path on.
		if (data.demo) {
			demoStatus[turf.mapRouteId] = action === 'claim' ? 'held-by-you' : 'available';
			if (action === 'claim') selectedId = turf.mapRouteId;
			else delete copied[turf.mapRouteId];
			return;
		}

		busy[turf.mapRouteId] = true;
		error = null;
		try {
			const res = await fetch(`/api/turfs/${turf.mapRouteId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				// The server's refusals are written for volunteers (see canClaim
				// in checkout.ts), so they are shown verbatim rather than mapped
				// to a generic failure.
				error = body.error ?? 'Something went wrong. Try again.';
				return;
			}
			if (action === 'claim' && body.printedListNumber) {
				issued[turf.mapRouteId] = body.printedListNumber;
				selectedId = turf.mapRouteId;
			} else {
				delete issued[turf.mapRouteId];
				delete copied[turf.mapRouteId];
			}
			// Re-run the load function so every turf's status, claimability and
			// door count come back from the server rather than being patched
			// locally into something the server never said.
			await invalidateAll();
		} catch {
			error = "Couldn't reach the server. Check your signal and try again.";
		} finally {
			delete busy[turf.mapRouteId];
		}
	}

	function listNumberFor(turf: TurfView): string | null {
		return issued[turf.mapRouteId] ?? turf.printedListNumber;
	}

	async function copyCode(mapRouteId: number, code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copied[mapRouteId] = true;
			setTimeout(() => delete copied[mapRouteId], 2000);
		} catch {
			// Clipboard access is permission-gated and blocked outright in some
			// browsers. The number is selectable text either way.
			delete copied[mapRouteId];
		}
	}

	/** Five digits. Held in a constant because writing it inline would mean
	 *  escaping braces inside a Svelte attribute for no gain in clarity. */
	const ZIP_PATTERN = '[0-9]{5}';

	/** Whether the back-to-top button is showing.
	 *
	 *  Threshold rather than "any scroll at all": appearing the instant someone
	 *  nudges the page puts a control over the map for no reason. Roughly a
	 *  screen down is where the list has actually taken over the viewport and
	 *  scrolling back becomes a chore. */
	let scrolledDown = $state(false);

	function onScroll() {
		scrolledDown = window.scrollY > 600;
	}

	function backToTop() {
		window.scrollTo({
			top: 0,
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
		});
	}

	function staleness(minutes: number | null): string {
		if (minutes === null) return 'freshness unknown';
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.round(minutes / 60);
		return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
	}
</script>

<svelte:window onscroll={onScroll} />

<svelte:head><title>{data.pageTitle}</title></svelte:head>

<main>
	{#if data.demo}
		<div class="demo-banner" role="note">
			<strong>Demonstration.</strong> Every turf, door count and list number on this page is invented,
			and nothing here touches VAN or the database. Checking turf out changes what you see and nothing
			else. This is the same page volunteers use — only the data is fake.
		</div>
	{/if}

	{#if data.blocked}
		<!-- Deliberately plain: not an error, not a 404, and not an accusation.
		     And no turf data alongside it — the load function returned none. -->
		<section class="chapter-gate">
			<h2>Turf checkout</h2>
			<p class="gate-help">{data.blocked}</p>
		</section>
	{:else if data.rateLimited > 0}
		<!-- Not an accusation and not a dead end. Someone hitting this while
		     actually canvassing has done something unusual, so it says what
		     happened and when it clears. -->
		<section class="chapter-gate">
			<h2>Slow down a moment</h2>
			<p class="gate-help">
				You've opened a lot of different chapters in the last hour. Turf for a new chapter will load
				again in about {Math.ceil(data.rateLimited / 60)} minute{Math.ceil(
					data.rateLimited / 60,
				) === 1
					? ''
					: 's'}. Chapters you've already looked at still open normally.
			</p>
			<p class="gate-help"><a href={resolve('/turfs')}>Back to the chapter list</a></p>
		</section>
	{:else if !data.chapter}
		<!-- No chapter, no turf data. The server sends an empty list until one is
		     picked; this is a gate, not a pre-filter. -->
		<section class="chapter-gate">
			<h2>Where are you canvassing today?</h2>
			<p class="gate-help">
				Pick the chapter you're heading out with. You'll see the turfs for that chapter only — you
				don't have to be a member of it.
			</p>
			<ul class="chapter-list">
				{#each data.chapters as chapter (chapter.chapterId)}
					<li>
						<a
							class="chapter-choice"
							href="{resolve('/turfs')}?{data.demo ? 'demo&' : ''}chapter={chapter.chapterId}"
						>
							<span class="chapter-name">{chapter.name}</span>
							<span class="chapter-go" aria-hidden="true">→</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<div class="chapter-bar">
			<div>
				<span class="chapter-label">Canvassing in</span>
				<span class="chapter-current">{data.chapter.name}</span>
			</div>
			<div class="bar-actions">
				{#if data.demo}
					<!-- Not a display toggle: it feeds visibleTurfState in the load
					     function, so the PAYLOAD differs. Switching to Organizer is
					     what actually puts holder names on the wire — check devtools
					     if you don't believe it. -->
					<span class="view-switch" role="group" aria-label="Preview as">
						<a
							class="view-option"
							class:is-active={!data.asAdmin}
							href="{resolve('/turfs')}?demo&chapter={data.chapter.chapterId}">Volunteer</a
						>
						<a
							class="view-option"
							class:is-active={data.asAdmin}
							href="{resolve('/turfs')}?demo&chapter={data.chapter.chapterId}&view=admin"
							>Organizer</a
						>
					</span>
				{/if}
				<a class="change-chapter" href="{resolve('/turfs')}{data.demo ? '?demo' : ''}"
					>Change chapter</a
				>
			</div>
		</div>

		{#if error}
			<p class="sync-warning" role="alert">{error}</p>
		{/if}

		{#each myTurfs as turf (turf.mapRouteId)}
			<section class="my-turfs" aria-label="Your turf">
				<article class="code-card">
					<header>
						<h2>{turf.name}</h2>
						{#if turf.expiresInHours !== null}
							<span class="expiry">Yours for {turf.expiresInHours} more hours</span>
						{/if}
					</header>

					{#if turf.retired}
						<!-- The turf left VAN while this volunteer was holding it. The
						     list number below may no longer load in MiniVAN, and they
						     need to hear that from us rather than from a blank screen
						     on a doorstep. -->
						<p class="sync-warning">
							An organizer has re-cut this area in VAN, so this turf no longer exists there. Your
							list number may stop working — check with them before you head out.
						</p>
					{/if}

					{#if listNumberFor(turf)}
						<p class="code-lede">Open MiniVAN and enter this list number:</p>
						<div class="code-row">
							<output class="turf-code">{listNumberFor(turf)}</output>
							<button
								type="button"
								class="copy-btn"
								onclick={() => copyCode(turf.mapRouteId, listNumberFor(turf)!)}
							>
								{copied[turf.mapRouteId] ? 'Copied' : 'Copy'}
							</button>
						</div>
					{/if}

					<ol class="steps">
						<li>Open <strong>MiniVAN</strong> on your phone and sign in.</li>
						<li>Choose <strong>Enter List Number</strong> and type the number above.</li>
						<li>Knock the doors, then hit <strong>Sync</strong> before you close the app.</li>
					</ol>
					<p class="sync-warning">
						Your answers only reach VAN when you sync. If you skip it, the turf looks unwalked and
						someone else gets sent to the same doors.
					</p>

					<div class="card-actions">
						<button
							type="button"
							class="claim-btn"
							disabled={busy[turf.mapRouteId]}
							onclick={() => act(turf, 'complete')}
						>
							I've finished this turf
						</button>
						<button
							type="button"
							class="ghost-btn"
							disabled={busy[turf.mapRouteId]}
							onclick={() => act(turf, 'release')}
						>
							Give this turf back
						</button>
					</div>
				</article>
			</section>
		{/each}

		<div class="turf-layout">
			<div class="map-col">
				{#if drawable.length > 0}
					<TurfMap
						turfs={drawable}
						{selectedId}
						{location}
						onselect={select}
						tiles={data.tiles}
						onviewport={data.demo ? undefined : loadViewport}
					/>
					<ul class="legend">
						<!-- The ramp is only useful if it can be read off, so the bands
						     are shown rather than described. Order matches DOOR_BANDS. -->
						<li class="legend-ramp">
							<!-- Ends labelled where they are, so the scale reads left to
							     right without a colon or an arrow to parse. The item's own
							     label comes last, matching every other row in the legend. -->
							<span class="ramp-end">few</span>
							<span class="swatch swatch-available shade-low"></span>
							<span class="swatch swatch-available shade-medium"></span>
							<span class="swatch swatch-available shade-high"></span>
							<span class="swatch swatch-available shade-full"></span>
							<span class="ramp-end">many</span>
							Doors left
						</li>
						<li><span class="swatch swatch-cleared"></span> None left</li>
						<li><span class="swatch swatch-mine"></span> Yours</li>
						<li><span class="swatch swatch-other"></span> Checked out</li>
						{#if location}<li><span class="swatch swatch-me"></span> You</li>{/if}
					</ul>
					<!-- Constraint A, said out loud. A convex hull swallows territory
					     the turf does not contain, so it is a browsing aid and MiniVAN
					     is the authority on which doors are in the list. -->
					<p class="gate-help">
						Shapes are approximate — they're drawn around the addresses in each list, so they can
						cover ground the turf doesn't include. MiniVAN has the exact doors.
					</p>
				{:else}
					<p class="gate-help">
						No turf in this chapter has map data yet, so there's nothing to draw. The list is
						complete either way.
					</p>
				{/if}

				{#if locationState === 'idle'}
					<button type="button" class="ghost-btn" onclick={askForLocation}>
						Sort by what's nearest me
					</button>
				{/if}

				<!-- The ZIP fallback (6.4). A plain GET form, so it works with the
				     location permission denied, with the Geolocation API missing,
				     and with JavaScript off entirely — the server resolves the ZIP
				     and sorts before serialising. -->
				{#if locationState !== 'granted'}
					<form class="zip-form" method="GET" action={resolve('/turfs')}>
						<input type="hidden" name="chapter" value={data.chapter.chapterId} />
						<label for="zip">Or sort by ZIP code</label>
						<div class="zip-row">
							<input
								id="zip"
								name="zip"
								inputmode="numeric"
								pattern={ZIP_PATTERN}
								maxlength="5"
								placeholder="48104"
								value={data.zip ?? ''}
							/>
							<button type="submit" class="ghost-btn">Sort</button>
						</div>
						{#if data.zip}
							<p class="gate-help">Sorted by distance from {data.zip}.</p>
						{:else if locationState === 'denied'}
							<p class="gate-help">
								Location unavailable. Enter a ZIP to sort by distance — the list works either way.
							</p>
						{/if}
					</form>
				{/if}
			</div>

			<div class="list-col">
				<div class="list-head">
					<h2>{availableCount} turf{availableCount === 1 ? '' : 's'} available</h2>
					{#if turfs.length > 0}
						<span class="freshness">Door counts from VAN, {staleness(freshest)}</span>
					{/if}
				</div>

				{#if total > shown}
					<!-- A list that silently stops at 150 of 1,000 reads as "there is
					     no more turf", which is the most misleading thing this page
					     could say. Phrased as "N of T" rather than "M more": both
					     halves then come from the same set, so panning cannot make
					     them disagree. -->
					<p class="gate-help">
						Showing {shown} of {total} turfs in this chapter — pan or zoom the map to load turf in another
						area.
					</p>
				{/if}

				{#if unmappable > 0 && drawable.length > 0}
					<p class="gate-help">
						{unmappable} of these {turfs.length} don't have map data yet and appear only in this list.
					</p>
				{/if}

				<ul class="turf-list" bind:this={listEl}>
					{#each sortedTurfs as turf (turf.mapRouteId)}
						<li
							class="turf-row"
							class:is-selected={turf.mapRouteId === selectedId}
							class:is-mine={turf.status === 'held-by-you'}
							class:is-unavailable={turf.status === 'checked-out'}
						>
							<button
								type="button"
								class="turf-card"
								onclick={() => toggle(turf.mapRouteId)}
								aria-expanded={turf.mapRouteId === selectedId}
								aria-controls={turf.mapRouteId === selectedId
									? `turf-detail-${turf.mapRouteId}`
									: undefined}
							>
								<span class="card-top">
									<span class="turf-name">{turf.name}</span>
									<!-- Status reads as a badge rather than another line of meta
									     text: it is the field that decides whether the row is
									     worth opening, and colour makes that answerable without
									     reading. The class follows the status verbatim, so a new
									     status shows up as an unstyled chip rather than silently
									     borrowing the wrong colour. -->
									<span class="badge badge-{turf.status}">{statusLabel(turf.status)}</span>
								</span>
								<span class="card-meta">
									<span class="doors">{turf.doorsRemaining} doors left</span>
									{#if distances[turf.mapRouteId] !== undefined}
										<span class="dot" aria-hidden="true">·</span>
										<span>{formatDistance(distances[turf.mapRouteId])} away</span>
									{/if}
								</span>
								{#if turf.heldBy}
									<!-- Only ever populated for admins; the server nulls it for
									     everyone else (visibleTurfState), so this cannot leak by
									     template edit. The expiry distinguishes an app claim,
									     which lapses, from turf an organizer sent to someone in
									     VAN, which does not. -->
									<span class="card-note admin-only">
										Held by {turf.heldBy}{turf.expiresInHours
											? ` — frees up in ${turf.expiresInHours} h`
											: ' (assigned in VAN)'}
									</span>
								{/if}
							</button>

							{#if turf.mapRouteId === selectedId}
								<div class="row-detail" id="turf-detail-{turf.mapRouteId}">
									<dl class="detail-stats">
										<div>
											<dt>Region</dt>
											<dd>{turf.regionName || '—'}</dd>
										</div>
										<div>
											<dt>Doors left</dt>
											<dd>{turf.doorsRemaining}</dd>
										</div>
										<div>
											<dt>People in list</dt>
											<dd>{turf.routeSize}</dd>
										</div>
										{#if turf.heldBy}
											<div>
												<dt>Held by</dt>
												<dd>{turf.heldBy}</dd>
											</div>
										{/if}
									</dl>
									{#if turf.status === 'available'}
										<button
											type="button"
											class="claim-btn"
											disabled={!turf.claimable || busy[turf.mapRouteId]}
											onclick={() => act(turf, 'claim')}
										>
											{busy[turf.mapRouteId] ? 'Checking out…' : 'Check out this turf'}
										</button>
										<!-- `claimable` gates the promise, not the absence of a
										     reason. Written the other way round, a refusal that
										     arrived without a message would fall through and
										     promise a list number under a dead button. -->
										{#if turf.claimable}
											<!-- Said before the claim, not after: what you get and how
											     long you keep it are the two things someone wants to
											     know before committing to walk somewhere. -->
											<p class="claim-note">
												You'll get a MiniVAN list number and {data.claimTtlHours} hours to walk it. Nobody
												else can take it in the meantime.
											</p>
										{:else if turf.claimBlockedReason}
											<p class="claim-note">{turf.claimBlockedReason}</p>
										{/if}
									{:else if turf.status === 'held-by-you'}
										<p class="claim-note">Your list number is at the top of the page.</p>
									{:else}
										<!-- Why taken turf is shown at all. Hiding it would leave a
										     hole in the map that reads as a bug, and a volunteer
										     would keep looking for turf that is not missing. -->
										<p class="claim-note">
											Someone's already walking this one. It's shown rather than hidden so the map
											doesn't look like it has a hole in it — check back later, or pick another turf
											nearby.
										</p>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>

				{#if turfs.length === 0}
					<p class="gate-help">
						No turf is published for this chapter yet. An organizer needs to cut it in VAN and
						generate its printed lists.
					</p>
				{/if}
			</div>
		</div>
	{/if}

	{#if data.demo}
		<footer class="demo-footer">
			<p>
				<strong>What's real:</strong> everything except the data. This is the page volunteers use —
				the same load function, the same map, the same checkout rules. The turf shapes are computed
				by the production <code>$lib/van/geometry</code> code from fake door coordinates, so the hulls
				behave exactly as they will with live data.
			</p>
			<p>
				<strong>What's fake:</strong> the turfs, door counts and list numbers, and the checkout
				ledger — checking turf out here changes what you see and touches nothing else. See
				<code>specs/010-van-turf-checkout/plan.md</code>.
			</p>
		</footer>
	{/if}
</main>

<!-- Always rendered, shown by class. The CSS uses `visibility` rather than
     opacity alone, so while hidden it is out of the tab order too — a
     transparent-but-focusable button at the top of the page would be a
     keyboard trap for no reason. -->
<button
	type="button"
	class="to-top"
	class:is-visible={scrolledDown}
	onclick={backToTop}
	aria-label="Back to top"
	tabindex={scrolledDown ? undefined : -1}
>
	<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<path
			d="M12 19V5M12 5l-6 6M12 5l6 6"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
</button>
