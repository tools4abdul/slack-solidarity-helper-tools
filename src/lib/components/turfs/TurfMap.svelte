<script lang="ts">
	// Turf hulls over a real street basemap, with no mapping library.
	//
	// The projection and tile grid are ours ($lib/van/tiles, unit-tested); this
	// file is the pointer, keyboard and rendering layer on top. Leaflet (~42 KB
	// + stylesheet + an SSR guard for its window access) would supply all of it,
	// and the honest accounting of what we gave up is:
	//
	//   - tile retention during a zoom. Leaflet keeps the old layer underneath
	//     while the new one loads; we swap and briefly show the graticule.
	//   - tile prefetch beyond the viewport, so ours pop in at the edges.
	//   - inertial panning, and a marker/popup API this page doesn't use.
	//
	// What we kept: no dependency, no SSR dance, one coordinate system shared
	// with geometry.ts, and pure functions we can unit-test. If the steppy zoom
	// starts drawing complaints from volunteers, swapping in Leaflet replaces
	// THIS FILE and nothing else — that boundary is the point.
	//
	// Tiles are CARTO Positron: keyless, light enough that coloured polygons
	// stay legible, and not under a usage policy that forbids this. Attribution
	// is a condition of use and is rendered, not hidden.

	import {
		boundingBox,
		boundsForNearest,
		padBounds,
		unionBounds,
		type BoundingBox,
		type LatLng,
	} from '$lib/van/geometry.js';
	import {
		boundsCentre,
		createMapView,
		fitZoom,
		metresPerPixel,
		scaleBarStep,
		MAX_ZOOM,
		MIN_ZOOM,
		TILE_ATTRIBUTION,
		TILE_URL_TEMPLATE,
		tileUrl,
	} from '$lib/van/tiles.js';
	import { statusLabel, type VolunteerStatus } from '$lib/van/turf-status.js';
	import { shadeLabel, turfShade } from '$lib/van/turf-shade.js';
	import { swipePansMap, wheelZoomDelta, wheelZoomsMap } from '$lib/van/turf-gestures.js';
	import { focusZoom, isBoxVisible } from '$lib/van/map-focus.js';
	import { untrack } from 'svelte';
	import type { MappableTurf } from '$lib/van/turf-view.js';

	interface Props {
		/** Only turf with geometry — filter with `mappableTurfs()`. Turf without
		 *  a hull or centroid is real and claimable, it just cannot be drawn, so
		 *  the list view carries it instead of this component inventing a
		 *  location for it. */
		turfs: MappableTurf[];
		selectedId: number | null;
		/** Where the volunteer is. Null when geolocation was declined or is
		 *  unavailable — the map still works, it just frames all the turf
		 *  instead of the nearest few, and draws no "you" marker. Declining
		 *  location must not cost you the map. */
		location: LatLng | null;
		onselect: (mapRouteId: number) => void;
		/** Basemap source. Passed in rather than imported so moving to a keyed
		 *  account is a secret to set, not a deploy (plan.md 6.3). */
		tiles?: { urlTemplate: string; attribution: string };
		/** Fired when the visible area settles after a pan or zoom, so the page
		 *  can fetch turf outside the rows it was given. Debounced by the
		 *  caller — a drag emits one of these, not sixty. */
		onviewport?: (bounds: BoundingBox) => void;
	}

	let {
		turfs,
		selectedId,
		location,
		onselect,
		tiles = { urlTemplate: TILE_URL_TEMPLATE, attribution: TILE_ATTRIBUTION },
		onviewport,
	}: Props = $props();

	/** Fallback viewport, used for SSR and for the first frame before the
	 *  element has been measured. Matches the desktop aspect ratio the
	 *  stylesheet asks for, so hydration doesn't visibly reframe. */
	const BASE_WIDTH = 720;
	const BASE_HEIGHT = 520;
	const PADDING = 32;

	// The map is measured rather than fixed: on a phone it runs edge to edge
	// and is taller than it is wide, on a desktop it sits in a 720x520 column.
	// One viewBox unit is one CSS pixel at every size, which keeps tiles at
	// their native resolution instead of scaling a fixed viewBox to fit.
	let frameWidth = $state(0);
	let frameHeight = $state(0);
	const mapWidth = $derived(frameWidth || BASE_WIDTH);
	const mapHeight = $derived(frameHeight || BASE_HEIGHT);

	/** How many nearby turfs the opening view frames. Chapters run to ~150
	 *  miles across while a turf is a couple of miles, so fitting the whole
	 *  chapter would render every turf at a few pixels and answer a question
	 *  nobody asked. Open on the volunteer's neighbourhood; "Show all" is one
	 *  click away. */
	const NEARBY_COUNT = 5;

	/** Below this projected size a hull is a smudge, so it draws as a pin
	 *  instead. This is what keeps turfs findable when someone zooms out to
	 *  survey a whole county. */
	const PIN_BELOW_PX = 16;

	/** Above this projected size there's room for a turf number. Higher than
	 *  PIN_BELOW_PX because a 20px polygon can be drawn but not labelled. */
	const LABEL_ABOVE_PX = 34;

	// With a location, open on the volunteer plus the nearest few turfs: a
	// chapter can run 150 miles across and framing the whole thing shows a
	// scatter of dots nobody can act on. Without one, all the turf is the only
	// honest frame.
	const nearbyBounds = $derived.by((): BoundingBox => {
		if (location) return padBounds(boundsForNearest(location, turfs, NEARBY_COUNT), 0.15);
		// Every turf here is mappable by the prop's contract, so unionBounds
		// only returns null for an empty list — which the parent does not
		// render this component for. The fallback keeps the type honest without
		// a cast.
		const all = unionBounds(turfs.map((t) => t.bounds));
		return all ? padBounds(all, 0.1) : { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
	});

	const allBounds = $derived.by(() => {
		const boxes = turfs.map((t) => t.bounds);
		if (location) boxes.push(boundingBox([location])!);
		return padBounds(unionBounds(boxes) ?? nearbyBounds, 0.1);
	});

	// Camera. Seeded from the fit, then owned by the user once they pan or
	// zoom — `moved` is what stops a re-render from yanking the view back.
	let moved = $state(false);
	let centre = $state<LatLng | null>(null);
	let zoom = $state<number | null>(null);

	const view = $derived(
		createMapView({
			centre: centre ?? boundsCentre(nearbyBounds),
			zoom: zoom ?? fitZoom(nearbyBounds, mapWidth, mapHeight, PADDING),
			width: mapWidth,
			height: mapHeight,
		}),
	);

	function frameTo(bounds: BoundingBox) {
		centre = boundsCentre(bounds);
		zoom = fitZoom(bounds, mapWidth, mapHeight, PADDING);
		moved = true;
	}

	/** Enough edge that a turf counted as "on screen" is one you can actually
	 *  read, rather than two pixels of hull against the frame. */
	const FOCUS_MARGIN_PX = 24;

	// Selecting a turf brings it into view — but only if it is not already
	// there.
	//
	// The list and the map are two views of one selection, so reading down the
	// list must not drag the camera along behind it; that would make the map
	// useless for comparing a turf against its neighbours, which is most of
	// what it is for. It also means clicking a turf ON the map never moves
	// anything, since a turf you just clicked is by definition visible — the
	// visibility test gets that for free rather than needing to know where the
	// selection came from.
	//
	// Only `selectedId` is tracked. Everything the decision reads — the camera,
	// the turf list, the element size — is untracked, because reading the view
	// reactively would make this effect a feedback loop: it moves the camera,
	// the camera invalidates the view, the effect runs again.
	$effect(() => {
		const id = selectedId;
		if (id === null) return;
		untrack(() => {
			if (mapWidth === 0 || mapHeight === 0) return;
			const turf = turfs.find((t) => t.mapRouteId === id);
			if (!turf) return;

			const nw = view.project({ lat: turf.bounds.maxLat, lng: turf.bounds.minLng });
			const se = view.project({ lat: turf.bounds.minLat, lng: turf.bounds.maxLng });
			const box = { minX: nw.x, minY: nw.y, maxX: se.x, maxY: se.y };
			if (isBoxVisible(box, mapWidth, mapHeight, FOCUS_MARGIN_PX)) return;

			// Padded so a turf that only just fits does not land flush against
			// the frame, which reads as "still cut off".
			const framed = fitZoom(padBounds(turf.bounds, 0.25), mapWidth, mapHeight, PADDING);
			centre = boundsCentre(turf.bounds);
			zoom = focusZoom(zoom ?? fitZoom(nearbyBounds, mapWidth, mapHeight, PADDING), framed);
			moved = true;
		});
	});

	const me = $derived(location ? view.project(location) : null);

	// Report the visible area after it settles, so the page can fetch turf
	// outside the rows it was handed. The debounce lives here rather than in
	// the caller because the natural trigger is every camera change — a single
	// drag produces one settled viewport, not one per pointer move — and
	// $effect's cleanup makes the trailing-edge timer a two-line affair.
	$effect(() => {
		if (!onviewport) return;
		const nw = view.unproject({ x: 0, y: 0 });
		const se = view.unproject({ x: mapWidth, y: mapHeight });
		const bounds: BoundingBox = {
			minLat: se.lat,
			maxLat: nw.lat,
			minLng: nw.lng,
			maxLng: se.lng,
		};
		const timer = setTimeout(() => onviewport(bounds), 250);
		return () => clearTimeout(timer);
	});

	/** Tiles that failed to load — a dead provider must not leave a white void
	 *  with no explanation, so the graticule and this flag stay behind them. */
	let failedTiles = $state<Record<string, boolean>>({});
	const tilesBroken = $derived(
		view.tiles.length > 0 && view.tiles.every((t) => failedTiles[t.key]),
	);

	/** "Ward 3 Turf 01" → "01". The card carries the full name; the map only
	 *  needs to tell neighbours apart. */
	function shortLabel(name: string): string {
		return name.match(/(\d+)\s*$/)?.[1] ?? name;
	}

	interface RenderedTurf {
		turf: MappableTurf;
		/** Pin/label position — the projected door centroid. */
		x: number;
		y: number;
		/** Polygon points, or null when the turf draws as a pin. */
		points: string | null;
		/** Null when there is no room to read a number. */
		label: string | null;
	}

	/**
	 * Everything the map draws, computed once per view change.
	 *
	 * Two things happen here that matter at scale, and a chapter can hold a
	 * thousand turfs:
	 *
	 * 1. **Culling.** Turfs outside the viewport are dropped before any hull is
	 *    projected. Zoomed into a neighbourhood this is the difference between
	 *    projecting twenty thousand points per drag frame and projecting a few
	 *    hundred.
	 * 2. **One pass.** Projection, pin-vs-polygon and labelling are decided
	 *    together instead of in three functions each re-projecting the same
	 *    bounds from the template.
	 */
	const rendered = $derived.by((): RenderedTurf[] => {
		// A margin keeps turfs that straddle the edge from popping in and out.
		const margin = 64;
		const out: RenderedTurf[] = [];

		for (const turf of turfs) {
			const nw = view.project({ lat: turf.bounds.maxLat, lng: turf.bounds.minLng });
			const se = view.project({ lat: turf.bounds.minLat, lng: turf.bounds.maxLng });

			if (se.x < -margin || nw.x > mapWidth + margin) continue;
			if (se.y < -margin || nw.y > mapHeight + margin) continue;

			const size = Math.max(Math.abs(se.x - nw.x), Math.abs(se.y - nw.y));
			const centrePoint = view.project(turf.centre);
			const asPin = turf.hull.length < 3 || size < PIN_BELOW_PX;

			out.push({
				turf,
				x: centrePoint.x,
				y: centrePoint.y,
				points: asPin
					? null
					: turf.hull
							.map((p) => view.project(p))
							.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
							.join(' '),
				label: size >= LABEL_ABOVE_PX ? shortLabel(turf.name) : null,
			});
		}
		return out;
	});

	// --- Panning and pinching -----------------------------------------------
	// Pointer events rather than mouse+touch: one code path covers mouse, pen
	// and finger, and setPointerCapture keeps a gesture alive when the cursor
	// leaves the svg mid-drag.
	//
	// Above the phone breakpoint the map sits beside the list with page either
	// side of it, so it can own every gesture over it: `touch-action: none`
	// suppresses the browser's own pan and pinch, one finger pans, two fingers
	// pinch, and the wheel zooms.
	//
	// At phone width it is full-bleed and most of the screen, so the swipe and
	// the plain wheel are how the page is read and the map must leave them
	// alone — a map that swallows them strands the reader on it. What is left
	// belongs to the map: two fingers pan, a pinch zooms, and Ctrl/⌘ + wheel
	// zooms. Volunteers use this standing on a pavement, so a gesture the map
	// declines says so on screen rather than looking broken.

	/** Matches the .map-frame breakpoint in this file's stylesheet: the rule
	 *  that makes the map full-bleed is the reason the gestures change. */
	const NARROW_QUERY = '(max-width: 640px)';
	let narrow = $state(false);

	$effect(() => {
		const query = window.matchMedia(NARROW_QUERY);
		const sync = () => (narrow = query.matches);
		sync();
		query.addEventListener('change', sync);
		return () => query.removeEventListener('change', sync);
	});

	function pageOwnsSwipe(event: PointerEvent): boolean {
		return !swipePansMap({ narrow, pointerType: event.pointerType });
	}

	/** A one-line nudge over the map, shown when a gesture was left to the
	 *  page. Nothing about the map moves in that case, and silence reads as a
	 *  broken map rather than as a deliberate handover. */
	let gestureHint = $state<string | null>(null);
	let hintTimer: ReturnType<typeof setTimeout> | undefined;

	function flashGestureHint(message: string) {
		gestureHint = message;
		clearTimeout(hintTimer);
		hintTimer = setTimeout(() => (gestureHint = null), 2400);
	}

	$effect(() => () => clearTimeout(hintTimer));

	/** The svg itself, for the one listener that cannot be an attribute. */
	let svg = $state<SVGSVGElement | undefined>();

	let dragging = $state(false);
	let dragMoved = false;
	let dragOrigin = { x: 0, y: 0 };

	interface ActivePointer {
		id: number;
		x: number;
		y: number;
	}

	/** Live pointers. Two of them means a pinch is in progress.
	 *
	 *  A plain array, not $state and not a SvelteMap: nothing renders from it,
	 *  it only feeds the gesture arithmetic below, and making it reactive would
	 *  schedule an update on every pointermove for no visible change. */
	let activePointers: ActivePointer[] = [];

	/** Gesture baseline, captured when the second finger lands. */
	let pinch: { distance: number; zoom: number } | null = null;
	/** Where the two fingers were centred at the last move, in client pixels.
	 *  Two fingers pan by the drift of this point. */
	let pinchMidpoint = { x: 0, y: 0 };

	function midpointOf(pair: [ActivePointer, ActivePointer]) {
		return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
	}

	function trackPointer(event: PointerEvent) {
		const existing = activePointers.find((p) => p.id === event.pointerId);
		if (existing) {
			existing.x = event.clientX;
			existing.y = event.clientY;
		} else {
			activePointers.push({ id: event.pointerId, x: event.clientX, y: event.clientY });
		}
	}

	function pointerPair(): [ActivePointer, ActivePointer] | null {
		return activePointers.length === 2 ? [activePointers[0], activePointers[1]] : null;
	}

	function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	/** The turf this gesture started on, or null for empty map.
	 *
	 *  Tapping a turf is resolved from the pointer events rather than from an
	 *  onclick on the shape, because the svg takes a pointer capture below and a
	 *  capture retargets the compatibility click event to the capturing element
	 *  — so a click handler on the turf never fires. Giving up the capture is
	 *  not an option: it is what keeps a drag alive when the pointer leaves the
	 *  svg mid-pan. */
	let pressedTurfId: number | null = null;

	function turfIdAt(target: EventTarget | null): number | null {
		const el = (target as Element | null)?.closest?.('[data-turf-id]');
		return el ? Number(el.getAttribute('data-turf-id')) : null;
	}

	function onPointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		trackPointer(event);
		(event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);

		const pair = pointerPair();
		if (pair) {
			// Second finger down: stop panning, start pinching.
			dragging = false;
			pressedTurfId = null;
			pinch = { distance: distanceBetween(pair[0], pair[1]), zoom: view.zoom };
			pinchMidpoint = midpointOf(pair);
			return;
		}

		dragMoved = false;
		// The origin is recorded either way: a swipe the page owns still has to
		// be measured, to tell it apart from a tap that selects a turf.
		dragOrigin = { x: event.clientX, y: event.clientY };
		// Read before any movement: the capture retargets later events to the
		// svg, so this is the last point at which the shape under the finger is
		// still the event target.
		pressedTurfId = turfIdAt(event.target);
		if (pageOwnsSwipe(event)) return;

		dragging = true;
	}

	/** Two fingers are the map's gesture at phone width, so take the sequence
	 *  back from the scroller the moment the second one lands. `touch-action`
	 *  has no way to say this — it can allow the one-finger pan or forbid it,
	 *  and the count is the whole distinction here. A second finger arriving
	 *  mid-scroll is uncancellable, and the page keeps that one. */
	function onTouchStart(event: TouchEvent) {
		if (narrow && event.touches.length >= 2 && event.cancelable) event.preventDefault();
	}

	// Attached by hand rather than as an `ontouchstart` attribute. Svelte
	// delegates touchstart to the app root and registers it passive, and a
	// passive listener's preventDefault does nothing — which is the entire
	// mechanism above.
	$effect(() => {
		const el = svg;
		if (!el) return;
		el.addEventListener('touchstart', onTouchStart, { passive: false });
		return () => el.removeEventListener('touchstart', onTouchStart);
	});

	function onPointerMove(event: PointerEvent) {
		if (!activePointers.some((p) => p.id === event.pointerId)) return;
		trackPointer(event);

		const element = event.currentTarget as SVGSVGElement;
		const pair = pointerPair();

		if (pair && pinch) {
			const midpoint = midpointOf(pair);
			// Two fingers pan as well as scale. At phone width this is the only
			// way to move the map, and at any width a pinch that drifts should
			// carry the map with it instead of pivoting in place.
			panBy(midpoint.x - pinchMidpoint.x, midpoint.y - pinchMidpoint.y, element);
			pinchMidpoint = midpoint;
			dragMoved = true;

			const distance = distanceBetween(pair[0], pair[1]);
			if (distance < 20 || pinch.distance < 20) return; // fingers too close to be stable

			// Straight off the gesture: the fingers' separation IS the scale, and
			// log2 of it is the zoom. Nothing is rounded, so the map tracks the
			// pinch continuously rather than jumping a level at a time.
			const target = pinch.zoom + Math.log2(distance / pinch.distance);
			changeZoom(
				target - view.zoom,
				toViewBox({ clientX: midpoint.x, clientY: midpoint.y }, element),
			);
			return;
		}

		const dx = event.clientX - dragOrigin.x;
		const dy = event.clientY - dragOrigin.y;
		const travelled = Math.abs(dx) + Math.abs(dy);
		if (travelled < 3) return;
		// Recorded before the pan, and whether or not there is one: a swipe the
		// page took is still a swipe, and lifting out of it must not land as a
		// tap on whatever turf it started over.
		dragMoved = true;

		if (!dragging) {
			// A swipe the page is scrolling. Say what does move the map, once
			// the travel is past anything a fingertip does on a tap. `dragOrigin`
			// stands still while the page owns the gesture, so this measures the
			// whole swipe rather than one move's delta.
			if (travelled > 16 && pageOwnsSwipe(event)) {
				flashGestureHint('Use two fingers to move the map');
			}
			return;
		}

		panBy(dx, dy, element);
		dragOrigin = { x: event.clientX, y: event.clientY };
	}

	/** Shift the centre by a client-pixel delta. The svg is scaled to its
	 *  container, so a client-pixel delta is not a viewBox-unit delta —
	 *  converting through the rendered width is what keeps the map pinned to
	 *  the finger. */
	function panBy(dx: number, dy: number, element: SVGSVGElement) {
		if (dx === 0 && dy === 0) return;
		const unitsPerPixel = mapWidth / element.getBoundingClientRect().width;
		// Dragging right moves the map right, i.e. the centre moves left.
		centre = view.unproject({
			x: mapWidth / 2 - dx * unitsPerPixel,
			y: mapHeight / 2 - dy * unitsPerPixel,
		});
		zoom = view.zoom;
		moved = true;
	}

	function onPointerUp(event: PointerEvent) {
		// A tap: the last finger lifting, having started on a turf and never
		// crossed the drag threshold. A gesture that panned or pinched is not a
		// selection, which is what dragMoved records.
		if (!dragMoved && pressedTurfId !== null && activePointers.length === 1) {
			onselect(pressedTurfId);
		}
		pressedTurfId = null;

		activePointers = activePointers.filter((p) => p.id !== event.pointerId);
		(event.currentTarget as SVGSVGElement).releasePointerCapture?.(event.pointerId);

		if (activePointers.length < 2) pinch = null;

		// Lifting one finger of a pinch leaves the other still down. Resume
		// panning from where it actually is, or the map jumps by the distance
		// between the two fingers.
		const [remaining] = activePointers;
		if (remaining && !pageOwnsSwipe(event)) {
			dragging = true;
			dragOrigin = { x: remaining.x, y: remaining.y };
		} else {
			dragging = false;
		}
	}

	/** The browser took the gesture away (a system scroll, a call coming in).
	 *  Not a tap, whatever the pointer did before it was cancelled. */
	function onPointerCancel(event: PointerEvent) {
		pressedTurfId = null;
		onPointerUp(event);
	}

	// --- Keyboard -----------------------------------------------------------
	// Without this the map is mouse-and-touch only, which fails anyone using a
	// keyboard and anyone whose pointing device is imprecise. Arrows pan by a
	// quarter-viewport, +/− zoom, Home refits.

	function onKeyDown(event: KeyboardEvent) {
		const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
			event.key
		];

		if (step) {
			event.preventDefault(); // otherwise the page scrolls instead
			centre = view.unproject({
				x: mapWidth / 2 + step[0] * (mapWidth / 4),
				y: mapHeight / 2 + step[1] * (mapHeight / 4),
			});
			zoom = view.zoom;
			moved = true;
			return;
		}

		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			stepZoom(1);
		} else if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			stepZoom(-1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			resetView();
		}
	}

	/** Zoom by `delta`, holding `anchor` (viewport pixels) still.
	 *
	 *  Anchoring matters far more here than on a typical map: going from a
	 *  county overview to a single turf is six or seven zoom levels, and
	 *  centre-only zoom loses whatever you were aiming at within two of them.
	 *  Defaults to the middle, which is what the +/− buttons want. */
	/** One whole level, for the keyboard and the +/− buttons.
	 *
	 *  A discrete control has to land somewhere predictable, and from a zoom
	 *  part-way between levels that means the next whole one — not a whole step
	 *  from wherever a pinch happened to stop. The epsilon keeps a zoom already
	 *  sitting on a level (to within floating-point noise) from counting as
	 *  part-way past it and stepping only a fraction. */
	function stepZoom(direction: 1 | -1) {
		const EPSILON = 1e-6;
		const target =
			direction > 0 ? Math.floor(view.zoom + EPSILON) + 1 : Math.ceil(view.zoom - EPSILON) - 1;
		changeZoom(target - view.zoom);
	}

	function changeZoom(delta: number, anchor = { x: mapWidth / 2, y: mapHeight / 2 }) {
		const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + delta));
		if (nextZoom === view.zoom) return;

		const held = view.unproject(anchor);
		const currentCentre = view.unproject({ x: mapWidth / 2, y: mapHeight / 2 });

		// Re-project the held point at the new zoom, then shift the centre by
		// however far it drifted.
		const probe = createMapView({
			centre: currentCentre,
			zoom: nextZoom,
			width: mapWidth,
			height: mapHeight,
		});
		const after = probe.project(held);
		centre = probe.unproject({
			x: mapWidth / 2 + (after.x - anchor.x),
			y: mapHeight / 2 + (after.y - anchor.y),
		});
		zoom = nextZoom;
		moved = true;
	}

	/** Client coordinates → viewBox units. The svg is scaled to its container,
	 *  so these are not the same thing. */
	function toViewBox(event: { clientX: number; clientY: number }, el: SVGSVGElement) {
		const rect = el.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * mapWidth,
			y: ((event.clientY - rect.top) / rect.height) * mapHeight,
		};
	}

	function onWheel(event: WheelEvent) {
		if (!wheelZoomsMap({ narrow, ctrlKey: event.ctrlKey, metaKey: event.metaKey })) {
			flashGestureHint('Pinch, or hold Ctrl or ⌘ and scroll, to zoom');
			return;
		}
		event.preventDefault();
		// Applied as it arrives, fractional and all. A trackpad's stream of
		// small deltas becomes a smooth ramp; a mouse notch is still one level.
		const delta = wheelZoomDelta({
			deltaY: event.deltaY,
			deltaMode: event.deltaMode,
			height: mapHeight,
		});
		if (delta !== 0) changeZoom(delta, toViewBox(event, event.currentTarget as SVGSVGElement));
	}

	function resetView() {
		centre = null;
		zoom = null;
		moved = false;
	}

	// --- Scale bar ----------------------------------------------------------

	const scale = $derived.by(() =>
		scaleBarStep(
			metresPerPixel(view.unproject({ x: mapWidth / 2, y: mapHeight / 2 }).lat, view.zoom),
			mapWidth / 4,
		),
	);

	/** True when at least one turf is off-screen — the only time offering
	 *  "Show all" is meaningful. Falls out of the cull for free. */
	const hasOffscreenTurfs = $derived(rendered.length < turfs.length);

	function statusClass(turf: MappableTurf): string {
		// Two classes, doing two jobs: the status sets the hue, the shade sets
		// how strongly it is filled. Keeping them separate is what lets the
		// door ramp apply to available turf without touching the colours that
		// mean "yours" and "taken".
		const shade = turfShade(turf.status, turf.doorsRemaining);
		const selected = turf.mapRouteId === selectedId ? ' is-selected' : '';
		return `turf turf-${turf.status} shade-${shade}${selected}`;
	}

	function ariaLabelFor(turf: MappableTurf): string {
		// The ramp is invisible to a screen reader, so the band is spoken. The
		// raw count goes with it — "nearly finished" is the gist, "3 doors
		// remaining" is the fact someone decides on.
		const status = turf.status as VolunteerStatus;
		const doors =
			status === 'available'
				? `, ${turf.doorsRemaining} doors remaining, ${shadeLabel(turfShade(status, turf.doorsRemaining))}`
				: '';
		return `${turf.name}, ${statusLabel(status)}${doors}`;
	}
</script>

<figure class="map-figure">
	<div class="map-frame" bind:clientWidth={frameWidth} bind:clientHeight={frameHeight}>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<!-- Svelte's a11y heuristics don't model a map widget: it treats <svg> as
		     non-interactive regardless of role, so a focusable, keyboard-driven
		     map trips both rules. `role="application"` with a tabindex and key
		     handlers is the correct ARIA pattern here — it tells a screen reader
		     to pass arrow keys through to us rather than using them to navigate
		     — and every mapping library does the same thing. Suppressed
		     deliberately, not because the rules are noisy. -->
		<svg
			viewBox="0 0 {mapWidth} {mapHeight}"
			class="turf-map"
			class:is-dragging={dragging}
			role="application"
			tabindex="0"
			aria-label="Map of canvassing turfs near you. Arrow keys pan, plus and minus zoom, Home resets."
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerCancel}
			onwheel={onWheel}
			onkeydown={onKeyDown}
			bind:this={svg}
		>
			<defs>
				<!-- Behind the tiles, so a provider outage degrades to a grid with a
				     message rather than a blank white rectangle. -->
				<pattern id="graticule" width="40" height="40" patternUnits="userSpaceOnUse">
					<path
						d="M40 0 L0 0 0 40"
						fill="none"
						stroke="var(--color-border-subtle)"
						stroke-width="1"
					/>
				</pattern>
				<clipPath id="map-clip">
					<rect width={mapWidth} height={mapHeight} />
				</clipPath>
			</defs>

			<rect width={mapWidth} height={mapHeight} fill="url(#graticule)" />

			<g clip-path="url(#map-clip)">
				<g class="basemap">
					{#each view.tiles as tile (tile.key)}
						<image
							href={tileUrl(tile, tiles.urlTemplate)}
							x={tile.left}
							y={tile.top}
							width={tile.size}
							height={tile.size}
							onerror={() => (failedTiles[tile.key] = true)}
						/>
					{/each}
				</g>

				{#each rendered as item (item.turf.mapRouteId)}
					<g
						class={statusClass(item.turf)}
						data-turf-id={item.turf.mapRouteId}
						role="button"
						aria-label={ariaLabelFor(item.turf)}
						aria-pressed={item.turf.mapRouteId === selectedId}
						tabindex={item.points ? 0 : -1}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onselect(item.turf.mapRouteId);
							}
						}}
					>
						{#if item.points}
							<polygon points={item.points} />
						{:else}
							<!-- Too small to read as a shape, or a degenerate hull
							     (collinear doors, or too few). Either way: a pin, never a
							     zero-area sliver. Not a tab stop — zoomed out over a county
							     that would be hundreds of them between the map and the next
							     control, and the turf list beside the map is the keyboard
							     path anyway. -->
							<circle cx={item.x} cy={item.y} r="7" />
						{/if}
						{#if item.label}
							<text x={item.x} y={item.y} text-anchor="middle" dominant-baseline="central">
								{item.label}
							</text>
						{/if}
					</g>
				{/each}

				<g class="me" aria-hidden="true">
					{#if me}
						<circle class="me-halo" cx={me.x} cy={me.y} r="16" />
						<circle class="me-dot" cx={me.x} cy={me.y} r="6" />
					{/if}
				</g>
			</g>

			<g class="scale-bar" aria-hidden="true">
				<line x1={PADDING} y1={mapHeight - 20} x2={PADDING + scale.px} y2={mapHeight - 20} />
				<line x1={PADDING} y1={mapHeight - 25} x2={PADDING} y2={mapHeight - 15} />
				<line
					x1={PADDING + scale.px}
					y1={mapHeight - 25}
					x2={PADDING + scale.px}
					y2={mapHeight - 15}
				/>
				<text x={PADDING + scale.px / 2} y={mapHeight - 29} text-anchor="middle">{scale.label}</text
				>
			</g>
		</svg>

		<div class="map-controls">
			<button type="button" onclick={() => stepZoom(1)} aria-label="Zoom in">+</button>
			<button type="button" onclick={() => stepZoom(-1)} aria-label="Zoom out">−</button>
			{#if moved}
				<button type="button" class="wide" onclick={resetView}>Near me</button>
			{/if}
			{#if hasOffscreenTurfs}
				<button type="button" class="wide" onclick={() => frameTo(allBounds)}>Show all</button>
			{/if}
		</div>

		{#if gestureHint}
			<!-- aria-hidden: this is a visual answer to a gesture that just did
			     nothing, and the figcaption already carries the same instruction
			     in a form a screen reader can reach at any time. Announcing it
			     would interrupt with news of something that did not happen. -->
			<p class="gesture-hint" aria-hidden="true">{gestureHint}</p>
		{/if}

		<p class="attribution">{tiles.attribution}</p>

		{#if tilesBroken}
			<p class="tile-error" role="status">
				Street map unavailable — turf shapes and positions are still accurate.
			</p>
		{/if}
	</div>

	<!-- How to work the map, and nothing else. What the shapes mean is said
	     once, under the legend beside it, and a volunteer who swipes and gets
	     a page scroll is answered on the map itself. The keyboard line is for
	     the phone-less: on a touch screen it is instructions for hardware that
	     is not there. -->
	<figcaption>
		{#if narrow}
			Two fingers move the map. Pinch to zoom.
		{:else}
			Drag to move the map, scroll to zoom. With it focused, arrow keys pan and
			<kbd>+</kbd>/<kbd>−</kbd> zoom.
		{/if}
	</figcaption>
</figure>

<style>
	.map-figure {
		margin: 0;
	}

	.map-frame {
		position: relative;
		/* The svg fills this box and takes its viewBox from the measured size,
		   so the frame is what decides the map's shape. On a desktop that is a
		   fixed ratio; the mobile rule below hands it a height instead. */
		aspect-ratio: 720 / 520;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface);
	}

	.turf-map {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
	}

	/* Phone layout: the map runs the full width of the screen, as the band under
	   the chapter bar. `50% - 50vw` is measured against the page column, so the
	   frame escapes whatever padding <main> has without knowing its value.

	   dvh, not vh: on mobile Safari and Chrome vh is the *largest* viewport, so
	   a vh-sized map hides its own bottom edge behind the address bar. */
	@media (max-width: 640px) {
		.map-frame {
			aspect-ratio: auto;
			height: 58dvh;
			min-height: 260px;
			margin-inline: calc(50% - 50vw);
			border-width: 0 0 1px;
			border-radius: 0;
		}

		.turf-map {
			/* A map this size is the page here, so the browser keeps the
			   one-finger vertical scroll through it, and the map declines its
			   own single-pointer pan in pageOwnsSwipe. Two fingers are the
			   map's, taken back in onTouchStart. pan-y alone rather than
			   `pan-x pan-y`: this layout has nothing to scroll sideways to. */
			touch-action: pan-y;
		}
	}

	/* Out of the way, bottom right: it answers a gesture that did nothing, and
	   the map is what the volunteer is trying to look at. Above the attribution
	   rather than over it, clear of the +/− controls in the top corner and of
	   the scale bar at bottom left. Pointer-transparent — it appears
	   mid-gesture and must not become the thing the next finger lands on. */
	.gesture-hint {
		position: absolute;
		right: 8px;
		bottom: 24px;
		max-width: calc(100% - 16px);
		margin: 0;
		padding: 7px 14px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-near-black) 85%, transparent);
		color: var(--color-header-text);
		font-size: var(--font-size-sm);
		line-height: 1.3;
		text-align: center;
		text-wrap: balance;
		pointer-events: none;
		animation: hint-in 120ms ease-out;
	}

	@keyframes hint-in {
		from {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.gesture-hint {
			animation: none;
		}
	}

	.turf-map.is-dragging {
		cursor: grabbing;
	}

	/* The map is keyboard-operable, so it must show where focus is. */
	.turf-map:focus-visible {
		outline: 3px solid var(--color-border-focus);
		outline-offset: -3px;
	}

	figcaption kbd {
		font-family: var(--font-mono);
		font-size: 0.95em;
		padding: 0 3px;
		border: 1px solid var(--color-border);
		border-radius: 3px;
		background: var(--color-cream-light);
	}

	.basemap image {
		/* Kills the hairline seams between adjacent tiles on fractional offsets. */
		shape-rendering: crispEdges;
		/* Tiles are scenery. Without this the browser's native image drag wins
		   the gesture and the map stops panning halfway through a swipe. */
		pointer-events: none;
		-webkit-user-drag: none;
	}

	.turf-map {
		/* Same reason: a drag that starts on a label must pan, not select text. */
		user-select: none;
		-webkit-user-select: none;
	}

	figcaption {
		margin-top: 8px;
		font-size: var(--font-size-md);
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.map-controls {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.map-controls button {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
	}

	.map-controls button:hover {
		background: var(--color-cream-light);
		border-color: var(--color-action);
	}

	.map-controls .wide {
		width: auto;
		padding: 0 8px;
		font-size: var(--font-size-xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.attribution {
		position: absolute;
		right: 0;
		bottom: 0;
		margin: 0;
		padding: 2px 6px;
		background: color-mix(in srgb, var(--color-surface) 75%, transparent);
		border-top-left-radius: var(--radius-sm);
		font-size: 10px;
		color: var(--color-warm-dark);
	}

	.tile-error {
		position: absolute;
		left: 50%;
		top: 12px;
		transform: translateX(-50%);
		margin: 0;
		padding: 6px 12px;
		background: var(--color-surface);
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		font-size: var(--font-size-xs);
		color: var(--color-text);
	}

	.turf {
		cursor: pointer;
	}

	.turf polygon,
	.turf circle {
		stroke-width: 2;
		transition: fill-opacity 120ms ease;
	}

	/* Label treatment is fixed rather than themed, because the thing it sits on
	   is fixed: the basemap is Positron in both modes, and the polygon under a
	   label runs from a 0.28 tint to a 0.7 fill. Paper glyphs on an opaque ink
	   halo are the only pairing that clears all of that in one rule.
	   It used to be --color-surface over --color-scrim, which is white on a 45%
	   black in light mode -- a halo that thin over a pale basemap barely
	   separates the glyphs -- and in dark mode --color-surface IS Medium Blue,
	   so the label became dark navy behind a dark scrim on light tiles. Neither
	   token can be used here: both change meaning with the theme, and the map
	   underneath does not. */
	.turf text {
		font-size: 13px;
		font-weight: 700;
		fill: var(--color-header-text);
		paint-order: stroke;
		stroke: var(--color-near-black);
		stroke-width: 3.5px;
		/* Round joins, or the halo grows spikes off the corners of a K or an M. */
		stroke-linejoin: round;
		pointer-events: none;
		user-select: none;
	}

	/* Hover and selection bump the turf's OWN fill rather than jumping to a
	   fixed value. A flat 0.8 on hover would erase the door ramp exactly when
	   the volunteer is pointing at the turf they are deciding about. */
	.turf:hover polygon,
	.turf:hover circle {
		fill-opacity: calc(var(--turf-fill) + 0.16);
	}

	.turf:focus-visible {
		outline: none;
	}

	.turf:focus-visible polygon,
	.turf:focus-visible circle {
		stroke: var(--color-border-focus);
		stroke-width: 4;
	}

	.turf.is-selected polygon,
	.turf.is-selected circle {
		stroke: var(--color-near-black);
		stroke-width: 4;
		fill-opacity: calc(var(--turf-fill) + 0.2);
	}

	/* Hue answers "can I take this?"; fill answers "how much is left in it?".
	   Available turf is the only thing a volunteer can act on, so it is the only
	   colour that ramps; taken turf recedes into the map at a flat weight.
	   Opacities run higher than they would on a blank background — there are
	   streets underneath now, and a 0.3 fill over a basemap reads as noise. */
	.turf {
		/* Overridden by the shade classes below. The default is the middle of
		   the ramp, so a turf whose shade class somehow went missing looks
		   ordinary rather than invisible. */
		--turf-fill: 0.46;
	}

	.turf polygon,
	.turf circle {
		fill-opacity: var(--turf-fill);
	}

	.turf-available polygon,
	.turf-available circle {
		fill: var(--color-blue);
		stroke: var(--color-navy-mid);
	}

	.turf-held-by-you polygon,
	.turf-held-by-you circle {
		fill: var(--color-success);
		stroke: var(--color-success);
	}

	.turf-checked-out polygon,
	.turf-checked-out circle {
		fill: var(--color-warm-dark);
		stroke: var(--color-warm-dark);
	}

	/* The door ramp. Four steps, far enough apart to be told apart over a
	   street basemap — closer spacing looked like one colour with noise. */
	.shade-full {
		--turf-fill: 0.7;
	}
	.shade-high {
		--turf-fill: 0.56;
	}
	.shade-medium {
		--turf-fill: 0.42;
	}
	.shade-low {
		--turf-fill: 0.28;
	}

	/* Flat, deliberately: door count is not actionable on turf someone else is
	   walking, and ramping it would compete with the hue that says so. */
	.shade-yours {
		--turf-fill: 0.65;
	}
	.shade-taken {
		--turf-fill: 0.42;
	}

	/* Nothing left to knock. Not a paler blue — a different kind of mark, so it
	   cannot be mistaken for the one-door end of the ramp, which is the
	   distinction that decides whether a walk over there is worth making. The
	   dash carries it without relying on colour vision. */
	.turf.shade-cleared {
		--turf-fill: 0.1;
	}

	.shade-cleared polygon,
	.shade-cleared circle {
		fill: var(--color-warm-dark);
		stroke: var(--color-warm-dark);
		stroke-dasharray: 5 4;
	}

	.me-dot {
		fill: var(--color-coral);
		stroke: var(--color-surface);
		stroke-width: 2.5;
	}

	.me-halo {
		fill: var(--color-coral);
		fill-opacity: 0.2;
	}

	.scale-bar line {
		stroke: var(--color-near-black);
		stroke-width: 1.5;
	}

	.scale-bar text {
		font-size: 11px;
		font-weight: 600;
		fill: var(--color-near-black);
		paint-order: stroke;
		stroke: color-mix(in srgb, var(--color-surface) 85%, transparent);
		stroke-width: 3px;
	}

	@media (prefers-reduced-motion: reduce) {
		.turf polygon,
		.turf circle {
			transition: none;
		}
	}
</style>
