<script module lang="ts">
	// The dot contract, in a module script so the page can import the type.
	import type { LatLng as DotLatLng } from '$lib/van/geometry.js';

	export interface MapDot {
		key: string;
		centre: DotLatLng;
		/** Drives the dot's area, so a county with ten times the turf reads as
		 *  bigger without swamping its neighbours. */
		routes: number;
		colour: string;
		label: string;
		folderId: number;
	}
</script>

<script lang="ts">
	// VAN folders as coloured dots on a basemap, one dot per county a folder
	// has turf in.
	//
	// Deliberately not TurfMap.svelte: that draws claimable turf, with hulls,
	// claim status and a volunteer's location, and none of those exist here. It
	// shares the projection and tile grid ($lib/van/tiles) and nothing else, so
	// this stays a read-only overview and TurfMap stays about checkout.
	//
	// No pan or zoom. The question is "which part of the state is this folder",
	// which one fitted frame answers; anything more is a second map to maintain.

	import { boundingBox, padBounds, type BoundingBox } from '$lib/van/geometry.js';
	import {
		boundsCentre,
		createMapView,
		fitZoom,
		TILE_ATTRIBUTION,
		TILE_URL_TEMPLATE,
		tileUrl,
	} from '$lib/van/tiles.js';

	interface Props {
		dots: MapDot[];
		/** Basemap source, keyed by the server the same way TurfMap's is — passed
		 *  in rather than imported, or the page renders the keyless endpoint and
		 *  CARTO stamps "API Key required" across every tile. */
		tiles?: { urlTemplate: string; attribution: string };
		/** Frame to use when nothing resolved to a point — the states in scope,
		 *  passed in rather than hardcoded so this component knows no geography.
		 *  Null falls back to the lower 48, which is only ever a last resort. */
		fallbackBounds?: BoundingBox | null;
		/** Dots outside this folder fade back. Null shows every folder equally. */
		highlightFolderId?: number | null;
		width?: number;
		height?: number;
	}

	let {
		dots,
		tiles = { urlTemplate: TILE_URL_TEMPLATE, attribution: TILE_ATTRIBUTION },
		fallbackBounds = null,
		highlightFolderId = null,
		width = 720,
		height = 560,
	}: Props = $props();

	const view = $derived.by(() => {
		const points = dots.map((d) => d.centre);
		const box = boundingBox(points);
		// An empty map of the right place beats an empty map of the Atlantic, so
		// with no dots we frame whatever scope the caller gave us.
		const bounds = box
			? padBounds(box, 0.12)
			: (fallbackBounds ?? { minLat: 24.5, maxLat: 49.4, minLng: -125, maxLng: -66.9 });
		return createMapView({
			centre: boundsCentre(bounds),
			zoom: fitZoom(bounds, width, height),
			width,
			height,
		});
	});

	/** Area ∝ routes, with a floor so a one-route county is still clickable. */
	function radius(routes: number): number {
		return Math.max(5, Math.min(26, Math.sqrt(Math.max(routes, 1)) * 1.6));
	}

	const placed = $derived(
		dots
			.map((dot) => ({ ...dot, pixel: view.project(dot.centre), r: radius(dot.routes) }))
			// Big dots first so small ones land on top and stay hoverable.
			.sort((a, b) => b.r - a.r),
	);
</script>

<figure class="folder-map">
	<svg viewBox="0 0 {width} {height}" role="img" aria-label="VAN folders by county">
		<defs>
			<clipPath id="folder-map-clip">
				<rect x="0" y="0" {width} {height} />
			</clipPath>
		</defs>
		<rect {width} {height} fill="var(--color-bg-surface)" />
		<g clip-path="url(#folder-map-clip)">
			{#each view.tiles as tile (tile.key)}
				<image
					href={tileUrl(tile, tiles.urlTemplate)}
					x={tile.left}
					y={tile.top}
					width={tile.size}
					height={tile.size}
				/>
			{/each}
			{#each placed as dot (dot.key)}
				<g
					class="dot"
					class:faded={highlightFolderId !== null && dot.folderId !== highlightFolderId}
				>
					<circle cx={dot.pixel.x} cy={dot.pixel.y} r={dot.r} fill={dot.colour} />
					<circle
						cx={dot.pixel.x}
						cy={dot.pixel.y}
						r={dot.r}
						fill="none"
						stroke="var(--color-bg)"
						stroke-width="1.5"
					/>
					<title>{dot.label}</title>
				</g>
			{/each}
		</g>
	</svg>
	<figcaption>
		Each dot is a county, placed at its centroid — not the turf's real shape. {tiles.attribution}
	</figcaption>
</figure>

<style>
	.folder-map svg {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface);
	}

	.folder-map figcaption {
		margin-top: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.dot circle {
		fill-opacity: 0.75;
		transition: fill-opacity 120ms ease;
	}

	.dot.faded circle {
		fill-opacity: 0.12;
	}

	@media (prefers-reduced-motion: reduce) {
		.dot circle {
			transition: none;
		}
	}
</style>
