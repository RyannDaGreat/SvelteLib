<!--
  SlideNav — the left-hand slide navigator. Shows display NUMBERS (which
  shift on insert) while slides keep permanent UUIDs underneath.

  Between each pair of slide rows sits a TRANSITION SLICE — a small, first-class
  SELECTABLE thing (manifest Round 12): clicking it selects the transition INTO
  the lower slide, whose properties then show in the Property Panel. The slice
  above slide 1 is the first real transition (slide 0 has no predecessor).

  THE SLICE IS THREE HIT TARGETS, NOT ONE (user, 2026-08-02). An insert-a-slide
  `+` at each END, the transition chip in the MIDDLE, and a role="group" band
  around them whose only job is to clear the hover state on leave. IDLE IT IS A
  FLAT LINE and that is the requirement, quoted: "unless I'm hovering over it, it
  should stay like a flat dash, a flat line like it is right now."

  THE RAIL ALSO OWNS THREE GESTURES BEYOND CLICK-TO-NAVIGATE:
    · DRAG-TO-REORDER — pointer capture on a row, a BOUNDARY (gap index) as the
      drop target, one undo unit per drop, through core withSlidesMovedToBoundary
      so the appearance law holds. Never a naive splice.
    · MULTI-SELECT — plain / shift-range / cmd-toggle, resolved by
      app.selectSlideAt. Rendered on TWO axes: `current` keeps the border (the one
      slide the canvas shows), `selected` takes a background tint (membership).
    · THE SLIDE CLIPBOARD — Copy/Paste/Duplicate/Delete Slide(s), registered
      commands, and the same Ctrl+C/V, Cmd+D and Backspace chords the canvas uses
      but scoped to RAIL FOCUS (core/shortcut_entries.js slideRailFocus), because
      there are two clipboards and one chord may not mean both.

  Thumbnails use the generic DirtyImage widget (src/lib): each renders THROUGH
  its slide's camera, at the size it's DISPLAYED (panel width × dpr) so it's
  crisp, and only when it's on screen AND dirty (scales to "5 million slides" —
  manifest: only the handful scrolled into view ever repaint).

  Editing is NON-BLOCKING and PER-SLIDE-dirty (thumbSchedule.js):
    · PER-SLIDE KEYS — each thumbnail's dirty key is the cumulative fold of
      deltas 0..i (+ enabled + meta + imageEpoch), not the whole document. Slide
      deltas fold FORWARD and are reference-stable under structural sharing, so
      editing slide N re-keys ONLY slides >= N (editing the last slide repaints
      one thumbnail; only editing slide 0 repaints all).
    · DEBOUNCED — a burst of commits coalesces into ONE render of the final
      state (published after THUMB_SETTLE_MS of quiet), never one per keystroke.
    · RATIONED — dirty renders drain at most THUMBS_PER_IDLE_TICK per idle/rAF
      tick, off the critical path, so a burst never freezes input; each tile
      keeps showing its last render until its turn.
    · GESTURE-HELD — while a gesture is in flight (thumbRenderPaused: a canvas
      drag, an Inspector scrub, a picker, a preset hover) NO thumbnail renders at
      all; the queue drains on release, so the tile is correct once the gesture
      settles. Two gates, because they cover different holes: the dirty-key
      freeze stops the gesture DIRTYING tiles, the queue hold stops an
      already-queued or scrolled-into-view render rastering mid-drag.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DirtyImage from "../../../lib/DirtyImage.svelte";
  import InlineRename from "../../../lib/InlineRename.svelte";
  import { resolveTransition, transitionType } from "../core/transitions.js";
  import { renderCameraFrame } from "./gpuService.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
  import { onTextAssetLoad } from "../render_gpu/gpu/text_asset_registry.js"; // CSV/JSON data assets a chart widget plots (core/plugin_assets.js assetText)
  import { makeSerialSource, thumbnailDirtyKeys, makeIdleThumbScheduler, browserTickDeps, thumbRenderPaused } from "./thumbSchedule.js";

  let { app } = $props();

  // Thumbnail scheduling knobs (named — no magic numbers).
  // How long edits must SETTLE before thumbnails re-render: a burst of commits
  // (numeric scrub, rapid keyframing) folds into ONE render of the final state
  // instead of one render per commit. Below the ~150ms "feels instant" bar, yet
  // long enough to swallow frame-rate (16ms) commit bursts.
  const THUMB_SETTLE_MS = 120;
  // Max thumbnails to render per idle/rAF tick. Each render is a synchronous
  // CanvasKit raster + readback; rationing to a small N per tick keeps the main
  // thread responsive during a burst (the rest wait, showing their last render).
  const THUMBS_PER_IDLE_TICK = 2;

  // Media (images) decode ASYNCHRONOUSLY, AFTER the commit that added the
  // widget — so a thumbnail rendered at commit time draws the image as nothing
  // (getSkiaImage returns null until decoded). onImageLoad bumps this epoch when
  // a decode lands; it's folded into the thumbnails' dirty key below so the
  // visible ones re-render and pick the image up — the SAME async-repaint nudge
  // CanvasView uses for the main canvas. Video frames are deliberately NOT folded
  // in (a playing clip must not re-render thumbnails every frame; a video's
  // poster refreshes on the next commit).
  let imageEpoch = $state(0);
  $effect(() => onImageLoad(() => (imageEpoch += 1)));
  // URL-sourced SVG text lands the same way (svg widget, url mode) — fold it
  // into the same epoch so thumbnails pick the vector art up when it arrives.
  $effect(() => onSvgSourceLoad(() => (imageEpoch += 1)));
  // A TEXT DATA asset (the CSV behind a chart) lands the same way — same epoch, so
  // a thumbnail rendered before the data arrived is redrawn with its bars.
  $effect(() => onTextAssetLoad(() => (imageEpoch += 1)));

  // Per-type icon for the between-rows slice (iconify only — manifest rule).
  // A third type adds one entry; unknown types fall back to a generic glyph.
  const TRANSITION_ICONS = { tween: "mdi:transition", fade: "mdi:transition-masked" };

  /** Camera rect of slide `i` at full alpha (the thumbnail's view + aspect).
      Evaluated state: the camera's own properties may be equations. */
  function slideRect(i) {
    return cameraRectAt(app.doc, i, 1, app.registry);
  }

  /** Thumbnail aspect (h/w) for slide `i`, or null when the camera is degenerate
      (no positive-area rect → no thumbnail). */
  function thumbAspect(i) {
    const rect = slideRect(i);
    return rect.w > 0 && rect.h > 0 ? rect.h / rect.w : null;
  }

  /**
   * render() for slide `i`'s thumbnail: paints the committed slide state through
   * its camera at the REQUESTED device-pixel size — displayed-size × dpr, so it
   * is exactly as crisp as the panel shows it (no fixed-256px upscale). Returns
   * a canvas; DirtyImage turns it into the <img>. Renders committed state only
   * (never the live drag preview), so a drag can't trigger thumbnail repaints.
   *
   * quality:"proxy" — thumbnails are ~100px, where the dither final pass and the
   * glass/material/magnify backdrop machinery (below-content re-render + full-
   * screen blur + SkSL) are invisible yet the dominant per-thumbnail cost. Proxy
   * skips all of it for a cheap-but-faithful preview; the editor/export/presenter
   * stay full quality (default).
   */
  function renderThumb(i) {
    // Async (GPU readback) — DirtyImage awaits the promise and drops stale
    // resolutions; wPx/hPx are already device px.
    return (wPx, hPx) =>
      renderCameraFrame(app.doc, { slideIndex: i, alpha: 1, registry: app.registry, width: wPx, height: hPx, quality: "proxy", project: app.projectName() });
  }

  /** The resolved transition INTO slide `i` (i > 0), for the slice label/icon. */
  function transitionInfo(i) {
    const t = resolveTransition(app.doc, i);
    return { type: t.type, seconds: t.seconds, title: transitionType(t.type).title };
  }

  // While a GESTURE is in flight we FREEZE the committed doc (a drag preview lives
  // in previewDelta, not app.doc — thumbnails show committed state only, never at
  // drag rate). thumbRenderPaused(app) is the ONE gesture predicate, shared with
  // the queue hold below: previewDelta alone missed the pointer-down→first-move
  // window and every preview-less gesture (band select, placement).
  // svelte-ignore state_referenced_locally — the initial value is immediately
  // reconciled by the effect below (no gesture is in flight at mount).
  let committedDoc = $state(app.doc);
  $effect(() => {
    if (!thumbRenderPaused(app)) committedDoc = app.doc;
  });

  // PER-SLIDE DIRTY KEYS. The old key was the WHOLE-document identity, so every
  // commit dirtied EVERY visible thumbnail. Instead, key each slide on the
  // cumulative fold of deltas 0..i (+ enabled flags + meta + imageEpoch): a
  // reference-stable serial per delta object means editing slide N re-keys ONLY
  // slides >= N (structural sharing — core/document.js keyframed). serialOf lives
  // for the component's life so identities stay comparable across commits.
  const serialOf = makeSerialSource();
  let liveKeys = $derived(thumbnailDirtyKeys(committedDoc, imageEpoch, serialOf));

  // DEBOUNCED PUBLICATION. Tiles see `publishedKeys`, not `liveKeys` — republished
  // only after edits SETTLE (THUMB_SETTLE_MS), so a burst of commits coalesces into
  // one render of the final state. Scroll-in renders stay prompt (they key off the
  // already-published value, not a fresh commit). Initialized to liveKeys so the
  // first paint is immediate.
  // svelte-ignore state_referenced_locally — seeded once; the effect below keeps it in sync.
  let publishedKeys = $state(liveKeys);
  let publishTimer = 0;
  $effect(() => {
    liveKeys; // subscribe to commits + image-decode epochs
    // Cleanup runs before each re-run (and on destroy), clearing the prior
    // timer — so successive commits keep pushing publication back until quiet.
    publishTimer = setTimeout(() => (publishedKeys = liveKeys), THUMB_SETTLE_MS);
    return () => clearTimeout(publishTimer);
  });

  // OFF-MAIN-THREAD RENDER RATIONING. A shared idle-batched scheduler drains at
  // most THUMBS_PER_IDLE_TICK thumbnail renders per idle/rAF tick, so publishing a
  // key (which dirties every visible tile at once) never fires N synchronous
  // CanvasKit rasters in one flush. Disposed on unmount.
  const thumbScheduler = makeIdleThumbScheduler({ ...browserTickDeps(), perTick: THUMBS_PER_IDLE_TICK });
  $effect(() => () => thumbScheduler.dispose());

  // GESTURE HOLD. The dirty-key freeze above stops a gesture from DIRTYING tiles,
  // but a run already queued when the gesture began — or a tile scrolled into view
  // mid-gesture, which is dirty on size alone — would still raster while the user
  // drags. So hold the queue itself for the whole gesture and drain on release:
  // zero thumbnail renders mid-drag, one render of the settled state after.
  $effect(() => thumbScheduler.setPaused(thumbRenderPaused(app)));

  // Dev/test seam (mirrors window.__powerrp_app). Idle-scheduled work is INVISIBLE
  // to an attached profiler — keeping the main thread busy is exactly what starves
  // requestIdleCallback — so expose the scheduler: with a profile recording, call
  // window.__powerrp_thumbs.flush() to run every pending thumbnail render
  // synchronously as ONE attributable task (it ignores the ration and the gesture
  // hold). pending() reports the queue depth. Cleared on unmount so it never
  // dangles. ZERO production effect — nothing in the app reads it.
  $effect(() => {
    window.__powerrp_thumbs = thumbScheduler;
    return () => { if (window.__powerrp_thumbs === thumbScheduler) delete window.__powerrp_thumbs; };
  });

  // ── SLIDE RENAME (Round 4 #54: "double click the title of the slide to
  // rename it") — now delegated WHOLESALE to InlineRename (SvelteLib), which
  // owns the editor state, the focus/select-all timing and the commit/cancel
  // keys. The bespoke copy that lived here was deleted rather than kept
  // alongside: two implementations of one gesture is exactly how the two halves
  // drift apart, and this one lacked BOTH rulings it now inherits — it selected
  // nothing on open (so typing appended to the old name) and it COMMITTED on
  // blur (so clicking away saved a half-typed name).
  //
  // All this file still owns is the write: renameSlide is ONE undo unit, and a
  // blank name restores the positional default. InlineRename never mutates.

  // ── THE TRANSITION SLICE'S THREE ZONES ──────────────────────────────────────
  // User, 2026-08-02: "maybe only the middle of it said tween point five seconds.
  // And if I move mouse to either side of it, maybe I'd see a plus symbol, which
  // means add new slide here … Now, unless I'm hovering over it, it should stay
  // like a flat dash, a flat line like it is right now."
  //
  // So the slice is THREE hit targets in one band, and which one the pointer is
  // over is tracked HERE rather than in CSS. It cannot be CSS: the three zones
  // must be separate <button>s (each does a different thing and each owes its own
  // tooltip and aria-label), but the CHIP they replace spans the whole band, so
  // "am I over an end" has to be readable by the middle zone's own markup. One
  // {slideId, zone} record, cleared on leave, answers it for every zone at once.
  //
  // KEYBOARD FOCUS COUNTS AS HOVER (`hoverZone` is set on focus too). Otherwise
  // the two `+` buttons would be reachable by Tab but invisible while focused —
  // a control you can activate and cannot see.
  let hoverZone = $state(null); // {slideId, zone: "before"|"middle"|"after"} | null

  /** Query. Is the pointer/focus inside slice `slideId`'s `zone`? */
  function inZone(slideId, zone) {
    return hoverZone?.slideId === slideId && hoverZone.zone === zone;
  }
  /** Query. Is the pointer/focus anywhere in slice `slideId`? Drives the whole
   *  band's lift out of the idle flat-line state. */
  function sliceHot(slideId) {
    return hoverZone?.slideId === slideId;
  }

  // ── DRAG TO REORDER ─────────────────────────────────────────────────────────
  // User: "I should also be able to drag slides … they would slide along that
  // vertical thing. And when in this mode, when I'm clicking and dragging it, the
  // horizontal line would be entirely there and would almost open when my mouse is
  // over it. And like maybe bold a little bit my mouse is under over one of those
  // boundaries between the slides."
  //
  // THE DROP TARGET IS A BOUNDARY, NOT A ROW — a gap index in 0..slides.length,
  // which is exactly what core withSlidesMovedToBoundary takes. A row index would
  // be ambiguous once the dragged rows are lifted out ("onto slide 3" means
  // something different depending on whether 3 is a mover); a gap does not move.
  //
  // POINTER EVENTS, NOT HTML5 DRAG-AND-DROP. The rail's rows are <button>s inside
  // Tooltip wrappers with a live thumbnail canvas inside them; the native drag
  // protocol would need a draggable attribute per row, a drag image, and a
  // dragover handler on every gap, and it fires no event at all until a platform
  // threshold is crossed. A pointer capture on the row gives the boundary math
  // directly from clientY, and it is the same gesture vocabulary the canvas uses.
  const DRAG_THRESHOLD_PX = 4; // below this a pointerdown is a CLICK, not a drag

  let dragState = $state(null); // {indices, startY, moved, boundary} | null
  let slidesEl = $state(null); // the scroll container — boundary math is relative to its rows

  /**
   * Query (reads the DOM). WHICH GAP the pointer is nearest, as a boundary index
   * in 0..n. Measures the rendered rows rather than assuming a row height: rows
   * differ in height (a slide whose camera is degenerate draws no thumbnail), so
   * a computed constant would drift from what is on screen.
   */
  function boundaryAt(clientY) {
    const rows = [...(slidesEl?.querySelectorAll("[data-slide-row]") ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  /** Command. Begins a potential row drag. The gesture is not a drag until the
   *  pointer has moved DRAG_THRESHOLD_PX — until then it is still a click, so a
   *  plain select never has to be undone by a stray pixel of movement. */
  function onRowPointerDown(e, i) {
    if (e.button !== 0) return;
    // The eye toggle and the rename editor live inside the row and own their own
    // pointers; a drag started on them would swallow their click.
    if (e.target.closest(".eye, .inline-rename-input")) return;
    const indices = app.isSlideSelected(i) ? app.selectedSlideIndices() : [i];
    dragState = { indices, startY: e.clientY, moved: false, boundary: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onRowPointerMove(e) {
    if (!dragState) return;
    if (!dragState.moved && Math.abs(e.clientY - dragState.startY) < DRAG_THRESHOLD_PX) return;
    dragState = { ...dragState, moved: true, boundary: boundaryAt(e.clientY) };
  }

  /** Command. Drops (one undo unit) or, if the pointer never really moved, lets
   *  the click through untouched. Pointer capture guarantees this fires even when
   *  the release lands outside the rail. */
  function onRowPointerUp(e) {
    const drag = dragState;
    dragState = null;
    if (!drag?.moved) return;
    e.preventDefault(); // a drop is not also a click
    app.moveSlidesToBoundary(drag.indices, drag.boundary ?? boundaryAt(e.clientY));
  }

  /** Query. Is boundary `b` the live drop target? Boundaries are drawn by the
   *  slice ABOVE slide b (and by a tail element for b === slides.length). */
  function isDropBoundary(b) {
    return dragState?.moved === true && dragState.boundary === b;
  }

  // THE MODIFIER KEY'S NAME ON THIS PLATFORM — "Cmd" on a Mac, "Ctrl" elsewhere.
  // The rail's toggle-click reads `metaKey || ctrlKey`, so BOTH really work; the
  // tip names the one the reader's own keyboard has rather than teaching a chord
  // they do not own. Same test (and the same `|| ""` guard for a
  // platform-less navigator) as CodeEditorModal's isMac, which is the app's
  // existing precedent for this read.
  const CMD_KEY_NAME = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "Cmd" : "Ctrl";

  /** Query. How many slides the rail commands will act on — 1 when nothing is
   *  multi-selected (an empty set means "the current slide"). Read by the bottom
   *  buttons' labels so a multi-slide Delete announces itself before it fires. */
  function selectionCount() {
    return app.selectedSlideIndices().length;
  }
</script>

<div class="slidenav" class:dragging={dragState?.moved}>
  <div class="slides" bind:this={slidesEl}>
    {#each app.doc.slides as slide, i (slide.id)}
      {#if i > 0}
        {@const info = transitionInfo(i)}
        <!-- THE SLICE IS THREE BUTTONS IN ONE BAND (see hoverZone above): an
             insert-before `+` at each end and the transition chip in the middle.
             Idle it is the flat line it always was — every affordance here is
             opacity 0 until the band is hot, which is the user's own condition
             ("unless I'm hovering over it, it should stay like a flat dash").
             It doubles as the DROP INDICATOR for boundary `i` during a drag. -->
        <!-- role="group": the band is a CONTAINER of three real buttons, not a
             control itself — its only handler clears the hover state on leave.
             Labelled so a screen reader announces what the three belong to. -->
        <div
          class="transition-slice"
          class:hot={sliceHot(slide.id)}
          class:drop={isDropBoundary(i)}
          role="group"
          aria-label={`Between slide ${i} and slide ${i + 1}`}
          onpointerleave={() => (hoverZone = null)}
        >
          <Tooltip text={`Insert a slide here. It starts as an empty difference, so it looks exactly like slide ${i} — and it takes its transition from the slide ABOVE.`}>
            <button
              class="tr-end"
              class:active={inZone(slide.id, "before")}
              aria-label={`Insert a slide above slide ${i + 1}`}
              onpointerenter={() => (hoverZone = { slideId: slide.id, zone: "before" })}
              onfocus={() => (hoverZone = { slideId: slide.id, zone: "before" })}
              onblur={() => (hoverZone = null)}
              onclick={() => app.insertSlideAtBoundary(i, "above")}
            >
              <iconify-icon icon="mdi:arrow-up" width="12" height="12"></iconify-icon>
              <iconify-icon icon="mdi:plus" width="12" height="12"></iconify-icon>
            </button>
          </Tooltip>
          <span class="tr-line"></span>
          <Tooltip text={`Transition into slide ${i + 1}: ${info.title} · ${info.seconds}s — click to edit`}>
            <button
              class="tr-chip"
              class:selected={app.selectedTransition === slide.id}
              aria-label={`Transition into slide ${i + 1}`}
              onpointerenter={() => (hoverZone = { slideId: slide.id, zone: "middle" })}
              onfocus={() => (hoverZone = { slideId: slide.id, zone: "middle" })}
              onblur={() => (hoverZone = null)}
              onclick={() => app.selectTransition(slide.id)}
            >
              <iconify-icon icon={TRANSITION_ICONS[info.type] ?? "mdi:transition"} width="13" height="13"></iconify-icon>
              <span class="tr-label">{info.title} · {info.seconds}s</span>
            </button>
          </Tooltip>
          <span class="tr-line"></span>
          <Tooltip text={`Insert a slide here. It starts as an empty difference, so it looks exactly like slide ${i} — and it takes its transition from the slide BELOW.`}>
            <button
              class="tr-end"
              class:active={inZone(slide.id, "after")}
              aria-label={`Insert a slide below slide ${i}`}
              onpointerenter={() => (hoverZone = { slideId: slide.id, zone: "after" })}
              onfocus={() => (hoverZone = { slideId: slide.id, zone: "after" })}
              onblur={() => (hoverZone = null)}
              onclick={() => app.insertSlideAtBoundary(i, "below")}
            >
              <iconify-icon icon="mdi:arrow-down" width="12" height="12"></iconify-icon>
              <iconify-icon icon="mdi:plus" width="12" height="12"></iconify-icon>
            </button>
          </Tooltip>
        </div>
      {:else}
        <!-- THE TOP BOUNDARY has no transition slice (slide 0 has no predecessor),
             so it gets a bare drop rail of its own — otherwise dragging a slide to
             the very top would show no indicator at the one gap that most needs
             one. Zero height when idle; it only exists during a drag. -->
        <div class="drop-rail" class:drop={isDropBoundary(0)}></div>
      {/if}
      <!-- THE ROW OWES EXPLANATION and gave none: it had no tooltip and no :hover
           rule at all, so the filmstrip's primary navigation surface read as inert.
           Three things were unreadable. (1) The NAME ellipsizes (app.css
           .slidenav .name), so a long slide name could not be read anywhere.
           (2) A DISABLED slide renders as bare opacity: 0.5 with nothing saying what
           "disabled" means — its delta is SKIPPED when the deltas are folded, so
           every later slide inherits as though it were not there. That is exactly
           the mystery-grey control the palette/Tools-pane `requires` rule exists to
           kill. (3) The incoming transition is already computed for the slice above;
           naming it here costs nothing.
           It owes NO canvas PREVIEW, deliberately: the thumbnail already IS the
           slide's preview, and swapping the main canvas on an incidental traverse of
           the rail would fight the thumbRenderPaused gesture discipline this file's
           header spends thirty lines on. -->
      <Tooltip>
        {#snippet tip()}
          <!-- The NAME alone, not "Slide {i+1}: {name}": the number is visible in
               the row two pixels away, and default names already read "Slide N", so
               the prefixed form rendered "Slide 1: Slide 1" — a doubled echo. A
               name-only line is the Open Project card's precedent (App.svelte), and
               it is information whenever the label is ellipsized. -->
          <div>{slide.name}</div>
          {#if i > 0}{@const info = transitionInfo(i)}<div>Transition in: {info.title} · {info.seconds}s</div>{/if}
          {#if slide.enabled === false}
            <div class="tool-tip-requires">Disabled — its delta is skipped, so later slides inherit as if it were not here</div>
          {/if}
          <!-- THE RENAME AFFORDANCE, hosted here because this tip already covers
               the name span (see that span's note: a nested Tooltip on it drew two
               boxes over each other). It replaces a native title= on the span —
               banned, and the reason the ban exists: it waited ~1s while the eye
               toggle beside it answered instantly.

               STILL DOUBLE-CLICK, unlike the toolbar's project title, which became
               single-click in the same pass: a slide card's SINGLE click SELECTS
               the slide, so rename must be the second gesture here or it would
               fight navigation. The toolbar title has no first gesture to lose. -->
          <div class="cmd-tip-note">Double-click the name to rename</div>
          <!-- THE TWO NEW GESTURES ON THIS ROW, taught here for the reason the
               rest of this tip exists: an affordance nobody is told about does not
               exist, and neither of these has any visual affordance of its own
               until it is already under way. Both are one line because the tip is
               already four deep on a hover target you cross incidentally. -->
          <div class="cmd-tip-note">Drag to reorder · Shift or {CMD_KEY_NAME}-click to select several</div>
        {/snippet}
        <!-- MULTI-SELECT + DRAG live on this one element. The click rule (plain /
             shift-range / cmd-toggle) is app.selectSlideAt, not spelled out here,
             so the rail and any future surfacing of it agree by construction.
             `.selected` and `.current` are two different things and both render:
             `current` is the ONE slide the canvas is showing (border color, as
             before), `selected` is membership in the multi-selection (a tint), so
             a block of five reads as a block with one of them live. -->
        <button
          class="slide"
          class:current={i === app.slideIndex}
          class:selected={app.isSlideSelected(i)}
          class:dragged={dragState?.moved && dragState.indices.includes(i)}
          class:disabled={slide.enabled === false}
          data-slide-row={i}
          onpointerdown={(e) => onRowPointerDown(e, i)}
          onpointermove={onRowPointerMove}
          onpointerup={onRowPointerUp}
          onpointercancel={() => (dragState = null)}
          onclick={(e) => app.selectSlideAt(i, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey })}
        >
          <span class="row-top">
            <span class="num">{i + 1}</span>
            <!-- NO TOOLTIP OF ITS OWN, and no native title= either (banned —
                 manifest; tests/native_tooltip_ban_test.js enforces it). This
                 span carried a native title for exactly the reason the ban
                 exists: it predated the convention, so it waited ~1s while the
                 eye toggle beside it answered instantly.

                 The rename hint moved UP into the CARD's tip (above) rather
                 than becoming a nested Tooltip here. A nested one was built
                 first and was visibly wrong: the card's tip covers this span
                 too, so hovering the name fired BOTH and painted two boxes over
                 each other — the card's "Slide 1" landing across the middle of
                 "Double-click to rename". One hover target owes one tip.

                 STILL DOUBLE-CLICK (InlineRename's default trigger): a slide
                 card's SINGLE click SELECTS the slide, so rename must be the
                 second gesture here or it would fight navigation. -->
            <InlineRename
              value={slide.name}
              onrename={(name) => app.renameSlide(i, name)}
              ariaLabel={`Rename slide ${i + 1}`}
            >
              {#snippet children()}
                <span class="name">{slide.name}</span>
              {/snippet}
            </InlineRename>
            <Tooltip text={slide.enabled === false ? "Enable slide (apply its delta)" : "Disable slide (skip its delta)"}>
              <span
                class="eye"
                role="button"
                tabindex="-1"
                onclick={(e) => { e.stopPropagation(); app.toggleSlide(i); }}
                onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); app.toggleSlide(i); } }}
              >
                <iconify-icon icon={slide.enabled === false ? "mdi:eye-off" : "mdi:eye"} width="14" height="14"></iconify-icon>
              </span>
            </Tooltip>
          </span>
          {#if thumbAspect(i)}
            <DirtyImage
              class="thumb"
              render={renderThumb(i)}
              dirtyKey={publishedKeys[i]}
              schedule={thumbScheduler.request}
              aspect={thumbAspect(i)}
              alt={`Slide ${i + 1} preview`}
            />
          {/if}
        </button>
      </Tooltip>
    {/each}
    <!-- THE TAIL BOUNDARY (drop at the very end). Same reason the head rail
         exists: without it the last gap is the one gap with no indicator. -->
    <div class="drop-rail" class:drop={isDropBoundary(app.doc.slides.length)}></div>
  </div>
  <div class="nav-actions">
    <Tooltip text="New slide after current">
      <button class="btn-icon" aria-label="New slide" onclick={() => app.runCommand("new-slide")}>
        <iconify-icon icon="mdi:plus" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="New blank slide — hides every visible item">
      <button class="btn-icon" aria-label="New blank slide" onclick={() => app.runCommand("new-blank-slide")}>
        <iconify-icon icon="mdi:plus-box" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Move slide up">
      <button class="btn-icon" aria-label="Move slide up" onclick={() => app.runCommand("move-slide-up")}>
        <iconify-icon icon="mdi:arrow-up" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Move slide down">
      <button class="btn-icon" aria-label="Move slide down" onclick={() => app.runCommand("move-slide-down")}>
        <iconify-icon icon="mdi:arrow-down" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <!-- DUPLICATE, beside the two News rather than hidden in the palette: it is
         the gesture the user asked for by name ("There should be some way to
         duplicate a slide") and the one that needs no clipboard step. It reads
         the multi-selection, like Delete beside it. -->
    <Tooltip text={selectionCount() > 1 ? `Duplicate the ${selectionCount()} selected slides` : "Duplicate slide"}>
      <button class="btn-icon" aria-label="Duplicate slide" onclick={() => app.runCommand("duplicate-slides")}>
        <iconify-icon icon="mdi:file-multiple-outline" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <!-- ONE BUTTON, TWO COMMANDS, and which one it runs is the rail selection —
         `delete-slides` is the multi form and covers the single case too (an
         empty slideSelection resolves to just the current slide), so this always
         runs the multi command and the label is the only thing that varies. -->
    <Tooltip text={selectionCount() > 1 ? `Delete the ${selectionCount()} selected slides` : "Delete slide"}>
      <button class="btn-icon" aria-label="Delete slide" onclick={() => app.runCommand("delete-slides")} disabled={app.doc.slides.length <= selectionCount()}>
        <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
  </div>
</div>
