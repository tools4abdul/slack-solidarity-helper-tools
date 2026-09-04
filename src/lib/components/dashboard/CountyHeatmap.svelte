<script module lang="ts">
	import type { FeatureCollection } from 'geojson';
	import michiganCountiesGeojsonRaw from '../../data/michigan-counties.geojson?raw';

	const michiganCountiesGeojson: FeatureCollection = JSON.parse(
		michiganCountiesGeojsonRaw,
	) as FeatureCollection;
</script>

<script lang="ts">
	import { geoMercator } from 'd3-geo';
	import { Chart, Layer } from 'layerchart';
	import { GeoPath } from 'layerchart/geo';
	import type { CountySummary } from './chart-data.js';

	type Props = {
		data: CountySummary[];
		accessibleName: string;
	};

	const WIDTH = 760;
	const HEIGHT = 600;

	let { data, accessibleName }: Props = $props();

	const maxValue = $derived(Math.max(...data.map((entry) => entry.value), 0));

	const sortedByValue = $derived([...data].sort((a, b) => b.value - a.value));
	const topCounties = $derived(new Set(sortedByValue.slice(0, 3).map((entry) => entry.county.toLowerCase())));
	const bottomCounties = $derived(
		new Set(sortedByValue.slice(-3).map((entry) => entry.county.toLowerCase())),
	);

	const dataByCounty = $derived(new Map(data.map((entry) => [entry.county.toLowerCase(), entry])));

	const counties = $derived(
		(michiganCountiesGeojson.features ?? []).map((feature) => {
			const sourceCounty = String(
				feature.properties?.county ?? feature.properties?.NAME ?? '',
			).replace(/\s*County\s*$/i, '').trim();
			const key = sourceCounty.toLowerCase();
			const entry = dataByCounty.get(key);
			const highlighted = topCounties.has(key) || bottomCounties.has(key);
			return {
				county: sourceCounty,
				value: entry?.value ?? 0,
				highlighted,
				geometry: feature.geometry,
			};
		}),
	);

	function colorForValue(value: number, highlighted: boolean): string {
		if (!highlighted || maxValue <= 0 || value <= 0) return 'var(--color-cream-light)';
		const mix = value / maxValue;
		return `color-mix(in oklch, var(--color-cream-light), var(--color-navy-mid) ${mix * 100}%)`;
	}
</script>

<div class="county-heatmap" role="img" aria-label={accessibleName}>
	<div class="county-heatmap__svg">
		<Chart
			geo={{ projection: geoMercator, fitGeojson: michiganCountiesGeojson }}
			width={WIDTH}
			height={HEIGHT}
		>
			<Layer type="svg" viewBox="0 0 {WIDTH} {HEIGHT}">
				{#each counties as county (county.county)}
					<GeoPath
						geojson={county.geometry}
						fill={colorForValue(county.value, county.highlighted)}
						stroke="var(--color-text)"
						stroke-width="0.7"
						stroke-opacity="0.35"
					/>
				{/each}
			</Layer>
		</Chart>
	</div>
	<div class="county-heatmap__legend" aria-hidden="true">
		<span>Low</span>
		<div class="county-heatmap__legend-bar"></div>
		<span>High</span>
	</div>
</div>

<style>
	.county-heatmap {
		display: grid;
		gap: 0.75rem;
		width: 100%;
	}
	.county-heatmap__svg {
		display: block;
		width: 100%;
		height: 360px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface);
	}
	.county-heatmap__legend {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}
	.county-heatmap__legend-bar {
		width: 120px;
		height: 10px;
		border-radius: 999px;
		background: linear-gradient(
			90deg,
			var(--color-cream-light) 0%,
			var(--color-navy-mid) 100%
		);
	}
</style>
