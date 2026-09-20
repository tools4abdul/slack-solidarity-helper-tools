<script lang="ts">
	// Which VAN folder covers which counties — the page for deciding what each
	// folder should be mapped to under Settings → Chapter → VAN folders.
	//
	// Names, not geometry: see the note in +page.server.ts. The caption and the
	// note below say so on the page too, because a dot on a street map invites
	// exactly the wrong reading ("that is where the turf is").

	import FolderCountyMap from '$lib/components/turfs/FolderCountyMap.svelte';
	import FolderChapterPicker from '$lib/components/turfs/FolderChapterPicker.svelte';
	import type { MapDot } from '$lib/components/turfs/FolderCountyMap.svelte';
	import { chartBands } from '$lib/styles/chart-bands.svelte.js';
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const bands = chartBands();
	let highlight = $state<number | null>(null);

	/** One colour per folder, cycling the theme's categorical bands. */
	const colourFor = $derived((index: number) => bands.current[index % bands.current.length]!);

	const dots = $derived(
		data.folders.flatMap((folder, i) =>
			folder.counties.map((county): MapDot => ({
				key: `${folder.folderId}:${county.county}`,
				centre: county.centre,
				routes: county.routes,
				colour: colourFor(i),
				folderId: folder.folderId,
				label: `${folder.name} — ${county.county} County: ${county.routes} turf(s) in ${county.regions} region(s)`,
			})),
		),
	);

	const totals = $derived({
		folders: data.folders.length,
		routes: data.folders.reduce((n, f) => n + f.routes, 0),
		unplaced: data.folders.reduce((n, f) => n + f.unplaced.length, 0),
	});

	/** The chapters already mapped to a folder, by folder id. */
	const mappedChapters = $derived(new Map(data.mapping.map((m) => [m.folderId, m.chapters])));

	/** "Wayne (23), Oakland (1)" — the counties a folder actually covers. */
	function countyList(folder: PageData['folders'][number]): string {
		return folder.counties.map((c) => `${c.county} (${c.routes})`).join(', ');
	}
</script>

<svelte:head><title>VAN folders by county</title></svelte:head>

<main>
	<header>
		<h1>VAN folders by county</h1>
		<p class="note">
			Where each VAN folder's turf is, worked out from the county in each region's name. Every dot
			sits at a
			<strong>county centroid</strong>, sized by how much turf the folder has there — it is not the
			turf's real shape or position. Pick the chapters that should see each folder in the last
			column.
		</p>
		{#if data.states.length > 0}
			<p class="note">
				Counties read in {data.states.join(', ')}{data.statesInferred
					? ' — worked out from the region names. Set CAMPAIGN_STATES to pin it.'
					: ' (from CAMPAIGN_STATES).'}
			</p>
		{/if}
		{#if data.fetchedAt}
			<p class="note">
				Read live from VAN, cached for 10 minutes.
				<a href="{resolve('/turfs/folder-map')}?refresh=1" data-sveltekit-reload>Refresh now</a>
			</p>
		{/if}
	</header>

	{#if data.error}
		<p class="error">Could not read folders from VAN: {data.error}</p>
	{:else if data.folders.length === 0}
		<p class="note">No folder this key can see holds any turf.</p>
	{:else}
		<p class="totals">
			{totals.folders} folder{totals.folders === 1 ? '' : 's'} with turf · {totals.routes.toLocaleString(
				'en-US',
			)} turfs
			{#if totals.unplaced > 0}· {totals.unplaced} region(s) whose name names no county{/if}
		</p>

		<FolderCountyMap
			{dots}
			tiles={data.tiles}
			fallbackBounds={data.fallbackBounds}
			highlightFolderId={highlight}
		/>

		<ul class="legend">
			{#each data.folders as folder, i (folder.folderId)}
				<li>
					<button
						type="button"
						class:active={highlight === folder.folderId}
						onclick={() => (highlight = highlight === folder.folderId ? null : folder.folderId)}
						onmouseenter={() => (highlight = folder.folderId)}
						onmouseleave={() => (highlight = null)}
					>
						<span class="swatch" style:background={colourFor(i)}></span>
						<span class="name">{folder.name}</span>
						<span class="count">{folder.routes.toLocaleString('en-US')}</span>
					</button>
				</li>
			{/each}
		</ul>

		{#if data.chaptersError}
			<p class="note">Chapter list unavailable: {data.chaptersError}</p>
		{/if}
		{#if data.mappingError}
			<p class="note">Existing mapping could not be read: {data.mappingError}</p>
		{/if}

		<table>
			<caption>
				Pick the chapters that should see each folder — saved as you pick, to the same mapping
				/settings edits chapter-first.
			</caption>
			<thead>
				<tr>
					<th scope="col">Folder</th>
					<th scope="col">Id</th>
					<th scope="col">Regions</th>
					<th scope="col">Turfs</th>
					<th scope="col">Counties (turfs)</th>
					<th scope="col">Chapters that see this folder</th>
				</tr>
			</thead>
			<tbody>
				{#each data.folders as folder (folder.folderId)}
					<tr class:highlighted={highlight === folder.folderId}>
						<th scope="row">{folder.name}</th>
						<td><code>{folder.folderId}</code></td>
						<td class="num">{folder.regions}</td>
						<td class="num">{folder.routes.toLocaleString('en-US')}</td>
						<td>
							{countyList(folder)}
							{#if folder.unplaced.length > 0}
								<span class="unplaced"
									>· {folder.unplaced.length} region(s) with no county in the name: {folder.unplaced
										.slice(0, 3)
										.join(', ')}{folder.unplaced.length > 3 ? '…' : ''}</span
								>
							{/if}
						</td>
						<td class="chapters-cell">
							<FolderChapterPicker
								folderId={folder.folderId}
								folderName={folder.name}
								chapters={data.chapters}
								selected={mappedChapters.get(folder.folderId) ?? []}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if data.errors.length > 0}
		<section class="folder-errors">
			<h2>Folders VAN would not show</h2>
			<ul>
				{#each data.errors as line (line)}<li>{line}</li>{/each}
			</ul>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.note,
	.totals {
		margin: var(--space-2) 0 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.error {
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-error);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.legend button {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}

	.legend button.active {
		border-color: var(--color-border-focus);
	}

	.swatch {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 50%;
	}

	.legend .count {
		color: var(--color-text-muted);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-sm);
	}

	caption {
		margin-bottom: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-align: left;
	}

	th,
	td {
		padding: var(--space-2);
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--color-border);
	}

	tr.highlighted {
		background: var(--color-bg-hover);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.chapters-cell {
		min-width: 18rem;
	}

	.unplaced {
		color: var(--color-text-muted);
	}

	.folder-errors {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	@media (max-width: 40rem) {
		table {
			font-size: var(--font-size-xs);
		}
	}
</style>
