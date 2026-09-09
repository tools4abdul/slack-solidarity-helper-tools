<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		/** The shape the panel takes when it is switched to a fixed ratio, as a
		 *  CSS `aspect-ratio` value — '16 / 9' makes it a widescreen display at
		 *  whatever width the column gives it, the way the sign would read on a
		 *  TV. null means the panel has no other shape to offer and always
		 *  takes its content's height, which is what the settings speed preview
		 *  wants: a strip of scrolling ticker in a 16:9 box is mostly empty. */
		ratio?: string | null;
	}

	let { children, ratio = null }: Props = $props();

	// The sign loads as a strip no taller than what it is showing, and clicking
	// the panel stretches it to `ratio` — a display sized for a screen on the
	// wall rather than for a dashboard someone is scrolling past. That way the
	// page opens at the size the content justifies and the big version is
	// something you ask for. Plain component state: it is a way of looking at
	// the page, not a preference, and it costs one click to set again.
	let fitted = $state(true);
	const widescreen = $derived(ratio !== null && !fitted);
</script>

<!-- The dashboard's LED sign: dark panel, bezel, and a single diode grid laid
     over everything inside it. Whatever it wraps (countdown, ticker) reads as
     one physical board rather than as separate widgets that happen to share a
     colour scheme. -->
<div class="board-shell">
	<div class="board" class:board--fixed={widescreen} style:aspect-ratio={widescreen ? ratio : null}>
		<div class="board__grid" aria-hidden="true"></div>
		<div class="board__stage">{@render children()}</div>
		{#if ratio !== null}
			<!-- The whole panel is the control, which is why it is a transparent
			     button laid over the sign rather than a role on the panel itself:
			     role="button" gives its subtree presentational children, and that
			     would flatten away the countdown's timer and the ticker's
			     screen-reader list — the actual content — to name a toggle. As a
			     sibling it takes the clicks and the focus ring while leaving what
			     the sign says exposed. -->
			<button
				class="board__fit"
				type="button"
				aria-label="Fit the sign to its content"
				aria-pressed={fitted}
				onclick={() => (fitted = !fitted)}
			>
				<!-- Names what the click will do, not the current state, and only
				     on hover or focus: an always-lit chip would read as something
				     the sign is saying. -->
				<span class="board__fit-tag" aria-hidden="true">{fitted ? ratio : 'Fit'}</span>
			</button>
		{/if}
	</div>
</div>

<style>
	/* --led-pitch is registered rather than left as a plain custom property
	   because DoorTicker reads it back with getComputedStyle to count the LED
	   columns its strip spans. An unregistered custom property computes to its
	   token stream, so once the value became a clamp()/round() over cqw the
	   read would have come back as that literal text — parseFloat NaN, and the
	   ticker silently stepping against its 3px fallback instead of the pitch
	   actually on screen. Registered, it computes to a resolved px length, and
	   a value that ever fails to parse falls back to the initial below rather
	   than to nothing. */
	@property --led-pitch {
		syntax: '<length>';
		inherits: true;
		initial-value: 3px;
	}

	/* Every size on the board is a fraction of the board's own width, so the
	   board has to be a query container — and cq units inside a declaration on
	   the container itself resolve against its PARENT container, not itself.
	   Hence the shell: it is the container, .board is its only child and
	   exactly as wide, so 1cqw is 1% of the board. */
	.board-shell {
		container-type: inline-size;
	}

	.board {
		/* Silkscreen is drawn on a 10-unit grid per em (caps are 7 of those
		   units, verified from the font's head/OS2 tables), so one glyph pixel
		   is exactly font-size / 10 — which makes glyph pixels, not font-size,
		   the honest unit to size this board in. Whole-pixel values keep every
		   glyph edge on a device pixel; the bitmap letterforms go soft at
		   arbitrary sizes, and softness is the one thing that breaks the LED
		   illusion. That is why the fluid sizes below are round(down, …, 1px)
		   rather than raw cqw: type that scales with the sign, but only ever
		   through whole glyph pixels, so it steps up a size instead of
		   smearing between two.
		   The diode pitch and the ticker's glyph pixel are ONE value, and must
		   stay that way. The scrolling message advances exactly one pitch per
		   step, so when a glyph pixel is the same size as a diode, every lit
		   pixel lands on the next diode and the board reads as LEDs switching
		   on and off. At any other ratio each hole samples a different part of
		   a glyph pixel on every step, the on/off pattern beats against itself,
		   and the eye reads that moiré as the message sliding under a screen
		   door — that is what a 3px pitch against 2.5px glyph pixels looked
		   like, a five-step beat. Anything in the ticker that scrolls must
		   therefore be sized at exactly --glyph-px, never a fraction of it.
		   A whole number of CSS pixels matters here beyond ordinary crispness:
		   the message advances one pitch per step, so a fractional pitch puts
		   alternating steps on half device pixels and the board breathes
		   between sharp and soft. (Only exact at 100% and 200% display
		   scaling — at 125% nothing lands whole and there is no fixing it
		   from here.)
		   The static values here are what every board rendered before it
		   scaled, and they are still what a browser without round() gets; the
		   @supports block below is the fluid version. They are also the sizes
		   the fluid rule lands on at ~720px wide, so the settings preview
		   looks the same either way. */
		--led-pitch: 3px;
		--glyph-px: var(--led-pitch);
		/* The countdown is static, so it is free of the alignment rule above —
		   nothing beats when nothing moves. */
		--glyph-px-label: 3px;
		--glyph-px-note: 2px;
		--glyph-px-clock: 5px;

		/* Read by the ticker's marquee. It lives here because the pointer no
		   longer reaches the ticker once the toggle covers the panel, so
		   "hover to hold the board still and read it" has to be a property of
		   the board rather than of the strip. */
		--ticker-play: running;

		position: relative;
		/* Contains the children's stacking contexts so the grid overlay below
		   stays on top of all of them. */
		isolation: isolate;
		overflow: hidden;
		border-radius: var(--radius-lg);
		background: var(--led-panel);
		border: 1px solid var(--led-bezel);
		box-shadow:
			inset 0 2px 14px color-mix(in srgb, var(--led-panel) 90%, transparent),
			0 2px 6px color-mix(in srgb, var(--led-panel) 30%, transparent);
		padding: 18px 0 14px;
	}

	@supports (width: round(down, 1px, 1px)) {
		.board {
			/* Coefficients, in glyph pixels per 100px of board width. The clock
			   is the one that has to be checked rather than eyeballed, because
			   it is a single nowrap line and the widest thing on the board: in
			   Silkscreen a digit advances 0.75em, a space 0.5em, and the unit
			   letters ride at --glyph-px-note with 0.45em of margin, which puts
			   the worst-case clock ("365d 23h 59m 59s") at ~10.5x its font
			   size. At 0.8 glyph pixels per 100px that is ~80% of the board —
			   full-looking, with room for the rounding step and a long day
			   count. Anything much above 0.8 overflows before it clips.
			   The pitch scales more slowly than the type: it is the physical
			   grain of the sign, and a board twice as wide should read as more
			   diodes, not just bigger ones. */
			--led-pitch: clamp(2px, round(down, 0.45cqw, 1px), 8px);
			--glyph-px-clock: clamp(2px, round(down, 0.8cqw, 1px), 14px);
			/* Label and unit type hold their proportion to the clock (0.6 and
			   0.4, the ratios the fixed sizes used) instead of tracking the
			   width themselves, so the countdown block keeps one shape at every
			   size. The floors differ because the two lines fail differently:
			   the label is words and stops being readable below 2px, while the
			   units are four single letters that stay legible at 1px — and
			   holding them at 2px under a 2px clock is what pushed the clock
			   line past the panel edge on a phone, since d/h/m/s carry 0.45em
			   of margin each and stop being a rounding error once they are as
			   tall as the digits. */
			--glyph-px-label: max(2px, round(down, calc(var(--glyph-px-clock) * 0.6), 1px));
			--glyph-px-note: max(1px, round(down, calc(var(--glyph-px-clock) * 0.4), 1px));
		}
	}

	.board:hover {
		--ticker-play: paused;
	}

	/* Fixed-shape sign: the panel is a display of a set ratio, and the content
	   sits centred in it however much room that leaves. Padding scales with
	   the board for the same reason the type does. */
	.board--fixed {
		display: flex;
		padding: 3cqw;
	}

	/* Holds the sign's lines as one centred block, so a board with room to
	   spare puts the content in the middle of the panel rather than at the
	   top. The gap is the spacing between the sign's parts (countdown over
	   ticker) and scales with the board like everything else. */
	.board__stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: clamp(10px, 2.5cqw, 40px);
		width: 100%;
	}
	.board--fixed .board__stage {
		flex: 1;
	}

	/* The panel-wide toggle. Transparent and sitting above the diode grid so a
	   click anywhere on the sign lands on it — including on the ticker, which
	   is where the eye goes. */
	.board__fit {
		position: absolute;
		inset: 0;
		z-index: 6;
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		padding: clamp(8px, 1.2cqw, 20px);
		background: none;
		border: 0;
		cursor: pointer;
		font: inherit;
	}
	.board__fit:focus-visible {
		outline: 2px solid var(--led-amber);
		outline-offset: -4px;
	}

	/* Chrome, not content: it sits above the diode grid rather than under it,
	   so it reads as a label on the sign instead of a message the sign is
	   showing — but in the board's own face and amber, so it doesn't read as a
	   browser control dropped on top either. */
	.board__fit-tag {
		font-family: var(--font-led);
		font-size: clamp(11px, 1cqw, 18px);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--led-amber);
		text-shadow: 0 0 6px color-mix(in srgb, var(--led-amber) 60%, transparent);
		opacity: 0;
		transition: opacity 120ms ease;
	}
	.board__fit:hover .board__fit-tag,
	.board__fit:focus-visible .board__fit-tag {
		opacity: 1;
	}
	@media (prefers-reduced-motion: reduce) {
		.board__fit-tag {
			transition: none;
		}
	}

	/* The diodes: opaque panel colour everywhere EXCEPT a lattice of small
	   holes, sitting above the content. Lit glyphs and dark background get
	   chopped into the same uniform pitch — which is how a physical board
	   works, the LEDs are fixed and the message passes through them. Doing it
	   as one overlay rather than masking each glyph means nothing has to align
	   with the font's pixel grid, and the dots can't shimmer against moving
	   letters.
	   The hole radius is a fraction of the pitch rather than a fixed length, so
	   retuning --glyph-px keeps the same ~1/3 open area — close to the fill
	   factor of a real board. Smaller reads as a screen door over the text;
	   larger loses the dot structure. */
	.board__grid {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(
			circle at center,
			transparent 0 calc(var(--led-pitch) * 0.34),
			var(--led-panel) calc(var(--led-pitch) * 0.44) 100%
		);
		background-size: var(--led-pitch) var(--led-pitch);
		pointer-events: none;
		z-index: 5;
	}
</style>
