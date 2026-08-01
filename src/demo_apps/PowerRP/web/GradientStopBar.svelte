<!--
  GradientStopBar — THE VISUAL STOP EDITOR: the ramp drawn as a horizontal track
  with a draggable BEAD per stop, the thing every other design tool has and this
  editor did not. Before it, moving a colour stop meant typing or scrubbing a
  number in a list row; now the ramp itself is the control — drag a bead to move
  a stop, click the track to add one there, and the selected bead's row lights up
  below so its colour is one glance away.

  MOUNTED FROM THE LIST DECLARATION, not by one field — web/ListField.svelte
  renders this above the stop rows whenever the declaration's element IS the
  shared RAMP_STOP_ELEMENT. That is deliberately the SAME mount rule the preset
  library follows (`decl.presets === COLOR_RAMP_LIBRARY`, one line above it), and
  for the reason ListField's own header records: the preset library "used to live
  PRIVATELY in web/PaintField.svelte, which is precisely why no property but a
  gradient paint could have a library". A bar mounted in PaintField would have
  reproduced that defect one week later — the Mandelbrot ramp (`PROPS.rampStops`)
  reaches ListField through the Inspector's own row, not through PaintField, so
  it would silently not have got one.

  ── IT SITS ABOVE THE ROWS, AND THAT IS STRUCTURAL ──────────────────────────
  Same reason the preset library does (measured there: 13 list-height changes
  over 14 swatches). Dragging a bead stages a WHOLE-LIST preview, which is the
  shape ListField folds its rows on — so the rows below collapse for the duration
  of the gesture. From ABOVE, the bar cannot move when they do; from below it
  would jump out from under the pointer on the first pointermove.

  ── THE WRITE IS ALWAYS THE WHOLE, CANONICALLY-ORDERED LIST ─────────────────
  Not the one dragged leaf, and this is the part that is easy to get wrong.
  Gradient stop ORDER is load-bearing all the way down: render_gpu/ir.js
  normalizeStops maps the array WITHOUT sorting, and Skia pins each stop position
  to >= the previous one — so a stop dragged before its predecessor does not
  swap, its span COLLAPSES (measured on this tree: stops [0.5 green, 0 red,
  1 blue] render flat green to 0.5, then red→blue; the SVG backend applies the
  identical clamp and the PDF backend emits a `Bounds` array the spec forbids).
  A leaf write would therefore paint a broken ramp on every pointermove. So each
  move rebuilds the pair through core/lists.withElementsOrderedBy and stages it,
  which keeps the document VALID at every instant of the gesture, and dragging a
  bead past a neighbour SWAPS the two — the behaviour core/lists.js declares for
  a "sorted" list ("drag stop 1 past stop 2 and they trade places").

  Preview mid-gesture, commit on release: ONE undo entry per drag, never one per
  pointermove (the house setPreview → commitPreview contract).

  ── AN EQUATION-BOUND POSITION IS NOT DRAGGABLE, AND SAYS SO ────────────────
  Any value may be an `=` equation, a stop's position included. Its bead is drawn
  at the EVALUATED position, carries the ƒ mark, and REFUSES the drag with the
  reason in its tooltip — the say-the-reason discipline ListField's blocked eye
  and floored purge already follow, and the same ruling web/ColorField.svelte
  made for the same hazard ("Never shown for an equation-bound value: picking
  would write a literal over the expression").

  Its NEIGHBOURS stay draggable. Every write here is built from the RAW list, so
  each stop keeps whatever it stores — literal or expression — and only the
  dragged stop's position becomes a literal. Ordering is decided by the EVALUATED
  positions (that is the order the renderer consumes) while the RAW elements are
  what get permuted; withElementsOrderedBy exists for exactly that combination.

  KNOWN BOUND, worth stating because it bites: a reorder RENUMBERS, so an
  equation elsewhere that names `…stops.2.offset` comes to mean a different stop.
  That is the same hazard insert and purge already carry (core/lists.js's identity
  invariant), not a new one, and the same follow-up fixes all three.

  ── A DRAGGED POSITION IS NOT QUANTIZED, DELIBERATELY ───────────────────────
  It stores the fraction the pointer was actually over. The app has two competing
  precedents and this follows the nearer one: a NUMERIC SCRUBBER snaps to a grid
  (NumericField hands DraggableNumber a `step` from the shared resolveScrub — for
  a 0..1 row that is 0.01, so scrubbing this same stop's `offset` in the row below
  DOES snap), while a DIRECT-MANIPULATION HANDLE does not. The bar is the second
  kind, and specifically it is the same gesture on the same state as the ON-CANVAS
  gradient beads (core/paint_handles.js paintModifierPoints), which write a raw
  fraction — those two must agree, or dragging a gradient would mean different
  things depending on which surface you did it from. Full precision is still
  reachable by TYPING into the row, exactly as it is for any scrubbed row.

  ── NO HOVER PREVIEW; A GHOST BEAD INSTEAD ──────────────────────────────────
  Hover-to-preview is the house trope for a PICKER, and ListField deliberately
  withholds it from insert/purge because previewing would move the affordance
  being pointed at. Here it would do something worse: an insert preview is a
  whole-list stage, which folds the rows below and resizes the panel on every
  pointermove across the track. So the track shows a GHOST bead at the pointer
  and states the outcome in its tooltip — the same "say what the click will do
  BEFORE it happens" contract ListField's insertTip has, with no document write
  at all.

  Props: app, decl (the list declaration — element/orderKey/activeKey/minLength),
  path (the list's full state path), label (accessible-label base), disabled.
  Styling lives in app.css (.stopbar*; app convention: no <style>). The ramp
  itself is DATA, not a design token, so it is passed as the --sb-ramp custom
  property exactly as GradientPresetPicker passes --gp-swatch and ColorField
  passes --cf-swatch.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { fieldOwnsKeydown } from "../../../lib/fieldKeys.js";
  import { fractionAt } from "./labelFrac.js";
  import { cssRampSwatch } from "./GradientPresetPicker.svelte";
  import { getPath } from "../core/deltas.js";
  import { DEFAULT_RAMP_SPACE, sampleRampHex } from "../core/ramps.js";
  import {
    activeListPath, copiedElement, elementActive, elementFieldValue, elementStorageKey,
    visibleElements, withElementFieldValue, withElementPurged, withElementsOrderedBy,
  } from "../core/lists.js";

  // `onselect(index|null)` reports which bead is selected, so the mount point can
  // light up the ROW that edits that stop — the bar's answer to "select one to
  // edit its colour" is to point at the one control that already does it, not to
  // grow a second colour editor beside the first.
  let { app, decl, path, label, disabled = false, onselect = null } = $props();

  /** Icon glyph size for the bar's own buttons — the .btn-icon size every other
   *  icon button in a panel row uses, so the bar is one height with the rows. */
  const ICON = 16;
  /** The ƒ mark inside an equation-bound bead. 13px is ColorField's own size for
   *  the identical mark (`mdi:function-variant`), so the two read as one glyph. */
  const EQ_ICON = 13;
  /** How many decimals a position is stated to in a tooltip. LINKED to
   *  web/ListField.svelte's SUMMARY_DECIMALS and for its reason: enough to read a
   *  normalized coordinate (0.125) without showing float dust. */
  const POSITION_DECIMALS = 3;
  /** Arrow-key nudge along the track, as a fraction of its span. Matches
   *  src/lib/ColorPicker.svelte's STEP_ALPHA — the app's only other 0..1 track
   *  with arrow-key control, so a bead and an alpha slider step alike. */
  const NUDGE_FRACTION = 0.02;
  /** Offsets are 0..1; a CSS `left` percentage is 0..100. */
  const PERCENT = 100;

  // ── What the declaration says this list holds ────────────────────────────
  // Derived, never restated: the POSITION field is the declaration's own
  // orderKey, and the COLOUR field is whichever element field declares kind
  // "color". A hardcoded "offset"/"color" pair here would be a second copy of
  // core/properties.js RAMP_STOP_ELEMENT, which exists precisely so there is one.
  let element = $derived(decl.element);
  let positionField = $derived(element.fields.find((f) => f.name === decl.orderKey));
  let colorField = $derived(element.fields.find((f) => f.kind === "color"));
  let bounds = $derived({ min: positionField.min, max: positionField.max });
  let activePath = $derived(activeListPath(decl, path));
  let floor = $derived(decl.minLength ?? 0);

  // ── The two reads: RAW is what gets written back, EVALUATED is what is drawn ──
  // Every write below is built from the RAW list so an "=" position or colour
  // survives it verbatim; every position, colour and ordering decision is made
  // from the EVALUATED one, because that is what the renderer paints.
  // A non-array is a fold/delta bug: ListField reports it LOUDLY from the same
  // path and renders nothing, so this reads its result rather than repeating the
  // report (one reader, one report).
  let rawList = $derived.by(() => {
    const list = getPath(app.rawState(), path);
    return Array.isArray(list) ? list : [];
  });
  let evalList = $derived.by(() => {
    const list = getPath(app.state(), path);
    return Array.isArray(list) ? list : [];
  });
  let rawActive = $derived(getPath(app.rawState(), activePath));
  let evalActive = $derived(getPath(app.state(), activePath));

  /** Query (reads the declaration + one element). One field of an element. */
  const fieldOf = (el, name) => elementFieldValue(element, el, name);

  /** The EVALUATED position of each stop, in stored order — the sort keys every
   *  write is ordered by, and the x each bead is drawn at. */
  let positions = $derived(evalList.map((el) => Number(fieldOf(el, decl.orderKey))));

  /** THE RAMP the track paints: the VISIBLE stops only, read through the same
   *  primitive the renderer reads them through (core/lists.visibleElements), so a
   *  hidden stop is as absent from the bar as it is from the picture. Painted by
   *  the SHARED cssRampSwatch, which RESAMPLES a looping/OKLab ramp through the
   *  real sampler rather than pretending its raw stops are CSS stops — the same
   *  reason a preset swatch does, one control over. */
  let ramp = $derived({
    stops: visibleElements(decl, { list: evalList, active: evalActive })
      .map((el) => ({ offset: Number(fieldOf(el, decl.orderKey)), color: String(fieldOf(el, colorField.name)) })),
    ...rampAspects(),
  });
  let rampCss = $derived(ramp.stops.length > 0 ? cssRampSwatch(ramp) : "none");

  /**
   * Query (reads the document). The ramp ASPECTS this list stores, from the
   * declaration's own `presetAspectKeys` map of aspect → SIBLING state key (the
   * shape a picked preset is written through — web/ListField.svelte
   * rampPreviewPairs). A declaration with no home for an aspect (the gradient
   * paint's `stops`, which stores no loop/space) falls to the sampler's own
   * defaults, which is exactly what its render does.
   */
  function rampAspects() {
    const stored = {};
    for (const [aspect, key] of Object.entries(decl.presetAspectKeys ?? {}))
      stored[aspect] = getPath(app.state(), [...path.slice(0, -1), key]);
    return { loop: stored.loop ?? false, space: stored.space ?? DEFAULT_RAMP_SPACE };
  }

  /**
   * Query (reads the raw list). Is stop `index`'s POSITION bound to an equation?
   * Then its bead is drawn where the expression EVALUATES but cannot be dragged:
   * a drag writes a literal, which would silently destroy the binding.
   *
   * The test is the TYPE, not the "=" marker, and that is deliberate: a position
   * is a NUMBER when it is a literal, so any string there is an expression —
   * INCLUDING the unmarked spelling, which is the one NumericField actually
   * writes into a numeric slot ("a leading '=' is tolerated and stripped"; core
   * accepts both). Testing for the marker would have missed every equation the
   * row's own field authors, which is all of them.
   */
  function positionBound(index) {
    const raw = rawList[index];
    return typeof (raw && fieldOf(raw, decl.orderKey)) === "string";
  }

  // ── SELECTION (view state — it changes nothing that renders) ────────────────
  // The inner-scope vocabulary the canvas already uses for handles one level up
  // (web/app.svelte.js handleSelection: "the vocabulary is deliberately the item
  // scope's, one level down"). Here it selects exactly one bead, and its only job
  // is to point at the row that edits that stop's colour — which ListField
  // highlights from this value.
  let selected = $state(null);
  let selectedIndex = $derived(selected !== null && selected < evalList.length ? selected : null);
  $effect(() => { onselect?.(selectedIndex); });

  // The in-flight bead drag, or null. `base` is the RAW pair SNAPSHOTTED at the
  // press and every move re-derives from it — never from the live document, which
  // is already carrying this gesture's own preview (AngleField's integrator keeps
  // its state out of the document for the same reason). `at` is where the dragged
  // bead currently sits after ordering, so the bar can keep marking the bead the
  // user has hold of as it changes address underneath them.
  let drag = $state(null);
  // The fraction the pointer is resting at over the track, or null — the GHOST
  // bead's position. Pure UI: nothing is staged and the document is untouched.
  let hover = $state(null);
  let trackEl = $state(null);

  /** Query (reads the track's box). The pointer's position as a fraction of the
   *  track, clamped to the position field's DECLARED bounds — through the app's
   *  own track arithmetic (web/labelFrac.js fractionAt), not a third copy of it.
   *  The rect is re-read per event so a drag stays correct if the panel
   *  resizes underneath it (that helper's own rule). */
  function fractionOf(clientX) {
    const r = trackEl.getBoundingClientRect();
    return fractionAt(clientX, r.left, r.width, bounds);
  }

  /**
   * Pure-ish per-call helper (reads the declaration). The [path, value] pairs one
   * list write stages: the elements, plus the visibility companion ONLY when
   * there is one — writing an all-true companion into a document that never hid
   * anything would mint state nobody asked for (web/ListField.svelte commitMoved's
   * rule, verbatim).
   */
  function pairsFor(next) {
    const pairs = [[path, next.list]];
    if (next.active) pairs.push([activePath, next.active]);
    return pairs;
  }

  /** Command. Stages a list value LIVE (the canvas re-renders; the document is
   * untouched and no undo entry is created). */
  function preview(next) {
    app.setPreview(pairsFor(next));
  }

  /** Command. Commits a list value as EXACTLY ONE undo unit. */
  function commit(next) {
    app.setPreview(pairsFor(next));
    app.commitPreview();
  }

  /**
   * Query (reads the drag snapshot). The list value for the dragged stop sitting
   * at position `t` — its RAW element with only the order key replaced, the pair
   * re-ordered by the EVALUATED positions. Built from the press-time snapshot, so
   * replaying it at a new `t` is idempotent however many moves have gone before.
   */
  function draggedTo(t) {
    const keys = drag.keys.slice();
    keys[drag.index] = t;
    const list = drag.base.list.slice();
    list[drag.index] = withElementFieldValue(element, list[drag.index], decl.orderKey, t);
    return withElementsOrderedBy({ list, active: drag.base.active }, keys);
  }

  /** Command. Begins a bead drag — or, for an equation-bound position, SELECTS the
   * bead and stops there (the tooltip carries the reason; a drag would write a
   * literal over the expression). */
  function onBeadDown(e, index) {
    selected = index;
    if (disabled || positionBound(index)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = { index, at: index, base: { list: rawList, active: rawActive }, keys: positions.slice() };
    onBeadMove(e);
    e.preventDefault();
  }

  /** Command. Previews the dragged stop at the pointer; the document stays
   * untouched. Re-marks which bead the gesture has hold of, because a drag past a
   * neighbour reorders the list under it. */
  function onBeadMove(e) {
    if (!drag) return;
    const next = draggedTo(fractionOf(e.clientX));
    drag = { ...drag, at: next.indices[drag.index] };
    preview(next);
  }

  /** Command. Settles the drag as ONE undo unit and leaves the moved stop
   * SELECTED — at its new address, which a reorder may have changed. */
  function onBeadUp(e) {
    if (!drag) return;
    const next = draggedTo(fractionOf(e.clientX));
    const landed = next.indices[drag.index];
    drag = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    commit(next);
    selected = landed;
  }

  /** Command. Arrow keys nudge a bead along the track (accessible fine control),
   * each press its own undo unit — AngleField's rule for its dial. An
   * equation-bound position is refused here for the same reason a drag is.
   *
   * It also claims the plain keyspace while the bead has focus, exactly as
   * lib/DraggableNumber and AngleField do and for their reason: a bead is a
   * button, so App.svelte's isTypingTarget() reports false and every canvas
   * shortcut would otherwise fire behind it — Backspace would delete the widget
   * whose gradient is being edited. Cmd/Ctrl/Alt combos and Tab/Escape/Enter keep
   * bubbling (src/lib/fieldKeys.js states that boundary once). */
  function onBeadKeydown(e, index) {
    if (disabled) return;
    if (fieldOwnsKeydown(e)) e.stopPropagation();
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? NUDGE_FRACTION
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -NUDGE_FRACTION
      : 0;
    if (step === 0 || positionBound(index)) return;
    e.preventDefault();
    const keys = positions.slice();
    keys[index] = Math.min(bounds.max, Math.max(bounds.min, positions[index] + step));
    const list = rawList.slice();
    list[index] = withElementFieldValue(element, list[index], decl.orderKey, keys[index]);
    const next = withElementsOrderedBy({ list, active: rawActive }, keys);
    commit(next);
    selected = next.indices[index];
  }

  /**
   * Query (reads the list). The element a click at `t` ADDS: a copy of the stop
   * before it (so any field this declaration grows travels with it), with the
   * position set to `t` and the colour SAMPLED from the ramp there — through the
   * real sampler, so adding a stop changes the picture by NOTHING. That is the
   * same "the shape does not jump" rule plugins/polygon.js's click-to-add-a-vertex
   * follows: insert on the curve that is already drawn.
   */
  function addedAt(t) {
    const before = positions.filter((p) => p <= t).length;
    const seed = copiedElement(element, rawList[Math.max(0, before - 1)]);
    const positioned = withElementFieldValue(element, seed, decl.orderKey, t);
    return withElementFieldValue(element, positioned, colorField.name, sampleRampHex(ramp.stops, t, ramp));
  }

  /** Command. Adds a stop where the track was clicked (one undo unit) and selects
   * it. A press that lands on a BEAD never reaches here — the beads are their own
   * row below the track, so there is no target test to get wrong. */
  function onTrackDown(e) {
    if (disabled || rawList.length === 0) return;
    const t = fractionOf(e.clientX);
    const el = addedAt(t);
    const next = withElementsOrderedBy(
      { list: [...rawList, el], active: rawActive ? [...rawList.map((_, i) => elementActive(rawActive, i)), true] : undefined },
      [...positions, t],
    );
    commit(next);
    selected = next.indices[rawList.length];
    e.preventDefault();
  }

  let purgeBlocked = $derived(selectedIndex === null || rawList.length <= floor);

  /** Command. Purges the SELECTED stop (one undo unit) — the destructive half,
   * the same core/lists.withElementPurged call and the same declared floor the
   * row's own purge button uses, so the two surfaces cannot disagree about what
   * removing a stop means. The guard is the second of two loud reports: the
   * button is already refusing with the reason in its tooltip. */
  function purgeSelected() {
    if (disabled || purgeBlocked) return;
    const next = withElementPurged(decl, { list: rawList, active: rawActive }, selectedIndex);
    commit(next);
    selected = null;
  }

  /**
   * Query (reads the list). The purge button's tooltip: what a click removes, or
   * WHY it is refusing. Both branches use the row purge's own vocabulary — the
   * word "Purge", the floor, and the RENUMBERING, which is what makes it different
   * from hiding rather than a stronger hide (web/ListField.svelte purgeTip). One
   * condition must have one voice.
   */
  function purgeTip() {
    if (selectedIndex === null) return "Purge — unavailable: select a stop on the bar first.";
    if (rawList.length <= floor) return `Purge — unavailable: this list needs at least ${floor} entr${floor === 1 ? "y" : "ies"}. Hide it instead.`;
    return `Purge stop ${selectedIndex + 1} — renumbers the later stops, shifting equations bound to them.`;
  }

  /** Query. A position as tooltip text, rounded past float dust. */
  const shown = (t) => String(+t.toFixed(POSITION_DECIMALS));

  /** Query (reads the list). ONE bead's tooltip: which stop it is, where it sits,
   *  and what can be done to it — or, for an equation-bound position, why it will
   *  not move. */
  function beadTip(index) {
    const where = `Stop ${index + 1} at ${shown(positions[index])}`;
    if (positionBound(index)) return `${where} — its position is an equation (${fieldOf(rawList[index], decl.orderKey)}), so it cannot be dragged. Edit the expression in the row below.`;
    if (!elementActive(evalActive, index)) return `${where}, hidden — the ramp runs straight past it. Drag to move it; the row's eye brings it back.`;
    return `${where}. Drag to move it, or use the arrow keys.`;
  }

  /** Query (reads the list). The track's tooltip: what a click here would ADD,
   *  stated BEFORE the click and computed by the same pure function the click
   *  commits, so the two can never disagree (ListField insertTip's contract). */
  function trackTip() {
    if (hover === null || rawList.length === 0) return `${label} bar — click to add a stop where you click.`;
    return `Add a stop at ${shown(hover)}, coloured ${sampleRampHex(ramp.stops, hover, ramp)} — the ramp's own colour there, so the picture does not change.`;
  }
</script>

<div class="stopbar" class:stopbar-disabled={disabled}>
  <!-- THE TRACK: the ramp itself, over the transparency checkerboard (a stop's
       colour carries alpha, so a ramp that fades out must read as fading out —
       ColorField's swatch recipe). Clicking it adds a stop at the clicked
       position; a GHOST bead follows the pointer to say where, with no document
       write (see the header on why this is not a hover PREVIEW). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- ANCHORED TO THE ELEMENT, ABOVE IT: a cursor-anchored tip would sit ON the
       bar and hide the ghost, the beads and the ramp the user is aiming at —
       which is the case Tooltip's own `anchor="element"` exists for ("the tip is
       wholly outside it and never covers the target"). Measured: it did. -->
  <Tooltip text={trackTip()} anchor="element" placement="top">
    <div
      class="stopbar-track"
      bind:this={trackEl}
      style:--sb-ramp={rampCss}
      onpointerdown={onTrackDown}
      onpointermove={(e) => (hover = trackEl ? fractionOf(e.clientX) : null)}
      onpointerleave={() => (hover = null)}
    ></div>
  </Tooltip>

  <!-- THE BEAD LANE — its own row under the track, sharing the track's column so
       a bead's x IS its position on the ramp above it. Beads are a separate row
       rather than children of the track so a press on one can never also be a
       press on the track: there is no hit test to get wrong. -->
  <div class="stopbar-lane">
    <!-- THE GHOST: a hollow bead where a click on the track would put a real one.
         It lives in the LANE, not on the track, for a measured reason — it was a
         dashed rule ON the ramp first, and at one device pixel over a saturated
         gradient it was effectively invisible. A hollow bead is both easier to see
         (the lane behind it is flat panel background) and a truer statement: it is
         the shape of the thing the click will create, and hollow is already this
         app's spelling for a handle that is not participating. -->
    {#if hover !== null && !drag && !disabled}
      <span class="stopbar-ghost" style:left={`${hover * PERCENT}%`}></span>
    {/if}
    {#each evalList as _, index (index)}
      {@const bound = positionBound(index)}
      <Tooltip text={beadTip(index)} anchor="element" placement="top">
        <!-- The bead wears the canvas MODIFIER POINT's skin, because that is what
             it is one surface over: the same gold fill, the same white rim, the
             same selection recolour of the rim alone, and hollow when the stop is
             hidden (app.css .overlay .modifier — "no new colour is minted, so
             every theme's selection override applies for free"). role="slider" is
             AngleField's own mapping for a positional handle. -->
        <button
          type="button"
          class="stopbar-bead"
          class:selected={selectedIndex === index}
          class:stopbar-bead-hidden={!elementActive(evalActive, index)}
          class:stopbar-bead-bound={bound}
          class:dragging={drag?.at === index}
          style:left={`${Number.isFinite(positions[index]) ? positions[index] * PERCENT : 0}%`}
          role="slider"
          tabindex={disabled ? -1 : 0}
          aria-label={`${label} ${index + 1} position`}
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={positions[index]}
          aria-disabled={disabled || bound}
          onpointerdown={(e) => onBeadDown(e, index)}
          onpointermove={onBeadMove}
          onpointerup={onBeadUp}
          onpointercancel={onBeadUp}
          onkeydown={(e) => onBeadKeydown(e, index)}
        >
          {#if bound}
            <!-- The ƒ mark, and the identical glyph ColorField shows on an
                 equation-bound colour — one mark for one meaning. -->
            <iconify-icon icon="mdi:function-variant" width={EQ_ICON} height={EQ_ICON}></iconify-icon>
          {/if}
        </button>
      </Tooltip>
    {/each}
  </div>

  <!-- PURGE the selected stop. It is the HandleToolbar's offer one surface down
       (select handles → the toolbar offers Hide and Purge), with that toolbar's
       icon and the row purge's own sentence. `aria-disabled` rather than the
       native attribute: while it refuses, its tip is the only place the reason is
       written, and a natively-disabled button is not focusable, so the keyboard
       could never reach it. -->
  <Tooltip text={purgeTip()} anchor="element" placement="top">
    <button
      type="button"
      class="btn-icon stopbar-purge"
      aria-disabled={disabled || purgeBlocked}
      aria-label={`Purge the selected ${label}`}
      onclick={purgeSelected}
    >
      <iconify-icon icon="mdi:delete-forever-outline" width={ICON} height={ICON}></iconify-icon>
    </button>
  </Tooltip>
</div>
