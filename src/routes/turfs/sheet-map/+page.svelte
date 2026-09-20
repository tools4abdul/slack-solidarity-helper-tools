<script lang="ts">
	// Where each region's turf checkouts will be logged.
	//
	// The three things worth knowing are, in order: which regions go nowhere
	// (their checkouts are piling up), which rules match nothing (almost always
	// a typo), and then the routing itself. So the two problems are at the top
	// and the reassuring part is below them — a page that opens on a tidy list
	// of correctly-routed regions invites nobody to scroll.

	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const totals = $derived({
		sheets: data.groups.length,
		regions: data.groups.reduce((n, g) => n + g.regions.length, 0) + data.unrouted.length,
		turfs: data.groups.reduce((n, g) => n + g.turfs, 0),
	});

	/** Regions are listed per sheet behind a disclosure — a dozen sheets of
	 *  twenty regions each is 240 rows nobody reads by default. */
	let open = $state<Record<string, boolean>>({});
</script>

<svelte:head><title>{data.pageTitle}</title></svelte:head>

<main>
	<header class="page-header">
		<h1>Checkout spreadsheets</h1>
		<p class="lede">
			Which of the campaign's spreadsheets each region's turf checkouts are appended to. Routing is
			decided from the region's name by the rules under
			<a href="{resolve('/settings')}#van-sheet-targets">Settings → Checkout spreadsheets</a>,
			longest prefix first.
		</p>
	</header>

	{#if !data.configured}
		<p class="notice">
			No rules are configured yet, so the checkout log is off. Every region the catalog has synced
			is listed below — write rules covering them under
			<a href="{resolve('/settings')}#van-sheet-targets">Settings → Checkout spreadsheets</a>.
		</p>
	{:else}
		<p class="totals">
			{totals.turfs} turf(s) across {totals.regions} region(s) → {totals.sheets} spreadsheet(s)
		</p>
	{/if}

	{#if data.unrouted.length > 0}
		<section class="problem">
			<h2>
				{data.unrouted.length}
				{data.configured ? 'region(s) route nowhere' : 'region(s) to write rules for'}
			</h2>
			<p>
				Checkouts in these regions are <strong>held, not dropped</strong> — they will be written as soon
				as a rule covers them. Add a rule whose prefix matches the start of the name.
			</p>
			<ul class="region-list">
				{#each data.unrouted as region (region.regionName)}
					<li>
						<code>{region.regionName}</code> <span class="muted">{region.turfs} turf(s)</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.unusedRules.length > 0}
		<section class="problem">
			<h2>{data.unusedRules.length} rule(s) match nothing</h2>
			<p>
				These rules cover no region the catalog has synced. Usually that is a typo in the prefix;
				occasionally it is turf VAN has not cut yet.
			</p>
			<ul class="region-list">
				{#each data.unusedRules as rule (rule.prefix)}
					<li><code>{rule.prefix}</code> <span class="muted">→ {rule.label}</span></li>
				{/each}
			</ul>
		</section>
	{/if}

	{#each data.groups as group (group.spreadsheetId)}
		<section class="sheet">
			<h2>{group.label}</h2>
			<p class="sheet-meta">
				{group.turfs} turf(s) in {group.regions.length} region(s) · matched by
				{#each group.prefixes as prefix, i (prefix)}<code>{prefix}</code
					>{#if i < group.prefixes.length - 1},
					{/if}{/each}
			</p>
			<button
				class="disclosure"
				type="button"
				aria-expanded={open[group.spreadsheetId] ?? false}
				onclick={() => (open[group.spreadsheetId] = !(open[group.spreadsheetId] ?? false))}
			>
				{open[group.spreadsheetId] ? 'Hide' : 'Show'} regions
			</button>
			{#if open[group.spreadsheetId]}
				<ul class="region-list">
					{#each group.regions as region (region.regionName)}
						<li>
							<code>{region.regionName}</code>
							<span class="muted">{region.turfs} turf(s)</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<p class="note">
		A region's name is the only geography VAN gives us, so this is what routing can see — never a
		boundary. A region renamed in VAN may stop matching its rule, which is what the "route nowhere"
		list above is for.
	</p>
</main>

<style>
	main {
		max-width: 860px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4);
	}

	.page-header {
		margin-bottom: var(--space-4);
	}

	.lede,
	.note,
	.totals {
		color: var(--color-text-muted);
	}

	.note {
		margin-top: var(--space-5);
		font-size: 0.9em;
	}

	.notice {
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
	}

	.problem {
		margin: var(--space-4) 0;
		padding: 12px 14px;
		border: 1px solid var(--color-border);
		border-left-width: 4px;
		border-radius: var(--radius-sm);
		background: var(--color-surface);
	}

	.problem h2,
	.sheet h2 {
		margin: 0 0 6px;
		font-size: 1.05em;
	}

	.sheet {
		margin: var(--space-4) 0;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.sheet-meta {
		margin: 0 0 8px;
		color: var(--color-text-muted);
		font-size: 0.9em;
	}

	.region-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.region-list code {
		font-size: 0.9em;
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--color-text-muted);
		font-size: 0.85em;
	}

	.disclosure {
		padding: 4px 10px;
		font-size: 0.9em;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
</style>
