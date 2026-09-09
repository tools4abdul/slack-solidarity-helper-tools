<script lang="ts">
	import { countdownParts } from './countdown.js';

	interface Props {
		/** Admin-configured caption; '' hides the label line. */
		label: string;
		/** ISO datetime the countdown ends at. */
		endAt: string;
		/** Projected doors knocked by the deadline (recent pace extrapolated);
		 *  null hides the projection line. */
		projectedDoors?: number | null;
	}

	let { label, endAt, projectedDoors = null }: Props = $props();

	const endMs = $derived(Date.parse(endAt));

	let now = $state(Date.now());

	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	const parts = $derived(countdownParts(endMs, now));
	const pad = (n: number) => String(n).padStart(2, '0');
</script>

<!-- Renders inside <LedBoard>, which supplies the panel, the diode grid, and
     the --glyph-px-* sizes. This component draws lit text only. -->
{#if !Number.isNaN(endMs)}
	<div
		class="countdown"
		class:expired={parts.expired}
		role="timer"
		aria-live="off"
		aria-label="{label ||
			'Countdown'}: {parts.days} days {parts.hours} hours {parts.minutes} minutes {parts.seconds} seconds remaining"
	>
		{#if label}
			<span class="countdown__label">{label}</span>
		{/if}
		<span class="countdown__time" aria-hidden="true">
			{parts.days}<span class="countdown__unit">d</span>
			{pad(parts.hours)}<span class="countdown__unit">h</span>
			{pad(parts.minutes)}<span class="countdown__unit">m</span>
			{pad(parts.seconds)}<span class="countdown__unit">s</span>
		</span>
		{#if projectedDoors !== null && !parts.expired}
			<span class="countdown__projection">
				On pace for ~<span class="countdown__projection-value"
					>{projectedDoors.toLocaleString('en-US')}</span
				> more doors knocked between today and when the timer hits 0
			</span>
		{/if}
	</div>
{/if}

<style>
	.countdown {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* Scales with the board, like the type it separates. */
		gap: clamp(8px, 1.2cqw, 28px);
		padding: 0 1rem;
		line-height: 1;
		/* Every line on the board is the same bitmap face; the hierarchy comes
		   from size and colour, the way it does on a real sign. */
		font-family: var(--font-led);
	}

	/* Amber: the board's own voice, shared with the ticker's caption. */
	.countdown__label {
		font-size: calc(var(--glyph-px-label, 3px) * 10);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		text-align: center;
		color: var(--led-amber);
		text-shadow:
			0 0 6px color-mix(in srgb, var(--led-amber) 70%, transparent),
			0 0 18px rgba(255, 140, 20, 0.4);
	}

	/* Red for the clock — the urgent readout, and the most classic LED colour
	   there is. Distinct from the amber captions and the green counts. */
	.countdown__time {
		font-size: calc(var(--glyph-px-clock, 5px) * 10);
		letter-spacing: 0.02em;
		white-space: nowrap;
		color: var(--led-red);
		text-shadow:
			0 0 8px color-mix(in srgb, var(--led-red) 85%, transparent),
			0 0 24px rgba(255, 40, 30, 0.45);
	}
	/* Whole-pixel glyph size of its own rather than an em fraction of the
	   clock, which would land between pixels at every breakpoint. */
	.countdown__unit {
		font-size: calc(var(--glyph-px-note, 2px) * 10);
		margin-right: 0.4em;
		margin-left: 0.05em;
		opacity: 0.7;
	}

	.countdown__projection {
		font-size: calc(var(--glyph-px-note, 2px) * 10);
		line-height: 1.6;
		text-align: center;
		max-width: 60ch;
		color: var(--led-blue-grey);
		text-shadow: 0 0 6px rgba(130, 165, 210, 0.45);
	}
	/* The doors figure in the counts' green, tying the projection to the
	   numbers scrolling below it. */
	.countdown__projection-value {
		color: var(--led-green);
		text-shadow:
			0 0 6px color-mix(in srgb, var(--led-green) 85%, transparent),
			0 0 16px color-mix(in srgb, var(--led-green) 40%, transparent);
	}
</style>
