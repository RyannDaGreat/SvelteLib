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

  ── EACH BEAD IS THE COLOUR IT REPRESENTS, AND POINTS AT ITS STOP ───────────
  USER RULING (2026-08-02), verbatim: "there's no reason to make them purple
  because that's not the color they're representing. They should be the color
  they're representing. Second of all, they should have a tapered top so that
  they point to precisely where they are… instead of being a box with a flat
  top."

  So a bead is a PIN, not a chip: a pentagon whose apex sits at the top centre,
  which is exactly the x its `left` puts on the track above it — the shape now
  states the fraction it stores instead of leaving the reader to infer a centre
  from a 12px flat edge. It is filled with the stop's EVALUATED colour over the
  transparency checkerboard (the .colorfield-swatch recipe; a stop's colour
  carries alpha and a fading ramp must read as fading), with the shared white
  handle rim around it so a near-background colour is still a visible bead.

  THE PREVIOUS SKIN WAS THE CANVAS MODIFIER POINT'S — a flat gold square. That
  was defensible as "the same handle on another surface" and it was still wrong
  on the user's own test: on THIS surface the handle's whole job is to say which
  colour lives where, and a uniform accent fill says nothing. (Gold, not purple —
  the user's word for what they saw. The complaint lands the same either way: the
  fill was a token, not the datum.)

  SELECTION STAYS THE RIM, and now that is load-bearing rather than tidy: the
  fill IS the data, so recolouring it to mark selection would make the control
  lie about the stop. The selected bead's rim takes --a-selection and thickens;
  the fill is untouched.

  ── IT SITS ABOVE THE ROWS, AND THAT IS STRUCTURAL ──────────────────────────
  Same reason the preset library does (measured there: 13 list-height changes
  over 14 swatches, so the swatch under the cursor moved). The bar must not move
  mid-gesture, and from below the rows it would: a bead drag reorders the list, a
  row can reorder under it, and any row-height change would shove the bar out
  from under the pointer on the first pointermove.

  IT NO LONGER FOLDS THE ROWS, on the user's ruling (2026-08-02, verbatim): "the
  submenu for stops disappears as I drag it and reappears when I'm done. Please,
  you don't need to do that. That actually makes things more confusing for me,
  not less confusing." A bead drag stages a WHOLE-LIST preview, which used to be
  enough for ListField to fold its rows — that seam is told apart by SHAPE, and a
  bead drag has the same shape as a preset sweep. It is NOT the same gesture: a
  preset sweep rewrites the list's LENGTH (2 rows to 12 and back, measured) under
  a cursor resting on a swatch, while a bead drag keeps the count fixed and the
  pointer is captured on the bead — so nothing the rows do can steal the gesture.
  The bar therefore DECLARES its drag through `ondrag`, and ListField exempts the
  fold for its duration; the rows below render the PREVIEWED list live, which is
  what the user asked to see. A row swapping places with its neighbour mid-drag
  is correct and is the point: it is the reorder the drag is performing.

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
<script module>
  import { cssGradientFromStops, cssRampSwatch as rampSwatchOf } from "./GradientPresetPicker.svelte";
  import { sampleRampHex as sampleHex } from "../core/ramps.js";
  import { GRADIENT_SPREAD_MODES as SPREAD_MODES } from "../core/properties.js";

  /**
   * Samples across the continuation band when a spread mode is drawn — matches
   * cssRampSwatch's own resample density, so the band is exactly as smooth as the
   * ramp it continues.
   */
  const SPREAD_SAMPLES = 32;

  /** What each spread mode does past the ramp's end, for the band's tooltip —
   *  phrased as the CONSEQUENCE the strip is showing, not the API word. */
  export const SPREAD_TIPS = {
    mirror: "Past the ramp's end the colours reflect back the way they came.",
    loop: "Past the ramp's end the ramp starts over, so the first colour follows the last.",
    pad: "Past the ramp's end the last colour is held flat.",
  };

  /**
   * Pure function. The CSS gradient the CONTINUATION BAND paints — what the ramp
   * does JUST PAST its end under the active spread mode (user ruling, 2026-08-02:
   * with looping "I should see purple on the right of it"). Drawn as a bare single
   * ramp, the bar silently claimed every gradient pads.
   *
   * WHY A SEPARATE BAND RATHER THAN A TILED TRACK. The track's x IS the stop
   * offset: a bead sits at `left: offset%` of its width and a click maps the same
   * fraction back to a new stop's position. Squeezing tiles into that width would
   * desynchronize the beads from the colours under them and mis-place every click —
   * the bar would gain a preview and lose its accuracy as an editor. So the TRACK
   * keeps spanning exactly one ramp, and the continuation is shown BESIDE it, where
   * it costs the editing geometry nothing.
   *
   * The band reads left-to-right as the ramp's own continuation past offset 1:
   *   loop   — restarts at the FIRST stop, so the first colour reappears right after
   *            the last: the visible wrap the ruling asks for
   *   mirror — reflects, so it runs back from the last colour to the first
   *   pad     — holds the last colour flat
   *
   * Sampled through the SAME `sampleRampHex` the renderer's ramps go through, so a
   * looping/OKLab ramp shows the colours it will actually produce.
   *
   * Args:
   *   ramp ({stops, loop, space}): the ramp being continued
   *   spread (string): "mirror" | "loop" | "pad"
   *
   * Returns:
   *   string — a CSS `linear-gradient(...)` value
   *
   * @example spreadBandSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}], loop: false, space: "srgb"}, "loop").startsWith("linear-gradient(90deg, #ff0000 0%") // true (loop RESTARTS at red right after the blue end — the user's "purple on the right")
   * @example spreadBandSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}], loop: false, space: "srgb"}, "mirror").startsWith("linear-gradient(90deg, #0000ff 0%") // true (mirror REFLECTS: the seam matches, so it runs back from blue)
   * @example spreadBandSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}], loop: false, space: "srgb"}, "pad") // "linear-gradient(90deg, #0000ff 0%, #0000ff 100%)" (pad HOLDS the last colour flat)
   */
  export function spreadBandSwatch(ramp, spread) {
    if (!SPREAD_MODES.includes(spread)) throw new Error(`spreadBandSwatch: unknown spread ${JSON.stringify(spread)} (expected ${SPREAD_MODES.join(", ")})`);
    // PAD is one flat colour, so two stops say it exactly — no resampling needed.
    if (spread === "pad") {
      const last = sampleHex(ramp.stops, 1, ramp);
      return cssGradientFromStops([{ offset: 0, color: last }, { offset: 1, color: last }]);
    }
    const stops = Array.from({ length: SPREAD_SAMPLES + 1 }, (_, i) => {
      const u = i / SPREAD_SAMPLES;
      // The band is the NEXT tile: loop reads the ramp forward again from 0, mirror
      // reads it backwards from 1 (which is why its seam matches colour).
      return { offset: u, color: sampleHex(ramp.stops, spread === "mirror" ? 1 - u : u, ramp) };
    });
    return cssGradientFromStops(stops);
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { fieldOwnsKeydown } from "../../../lib/fieldKeys.js";
  import { fractionAt } from "./labelFrac.js";
  import { GRADIENT_DEFAULT_SPREAD } from "../core/properties.js";
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
  //
  // `ondrag(active)` DECLARES a bead gesture to the mount point. It exists because
  // a bead drag and a preset hover-sweep stage the identical SHAPE (a whole-list
  // array), and ListField's fold seam can only read shape — so the one gesture
  // that must NOT fold the rows has to say so. See the header: the user's ruling
  // is that the rows stay up and show the live preview.
  let { app, decl, path, label, disabled = false, onselect = null, ondrag = null } = $props();

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

  /** The EVALUATED colour of each stop, in stored order — WHAT EACH BEAD IS
   *  PAINTED. Read from the same evaluated list the positions are, so an
   *  equation-bound colour shows the colour it resolves to rather than its source
   *  text (the user's "they should be the color they represent" applies to a
   *  computed colour exactly as it does to a literal one). */
  let colors = $derived(evalList.map((el) => String(fieldOf(el, colorField.name))));

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

  /** The active SPREAD MODE, or null when this list has none (see spreadMode). */
  let spread = $derived(spreadMode());
  /** The CONTINUATION BAND's gradient — what the ramp does just past its end under
   *  the active spread. Null (no band rendered) for a list with no spread. */
  let bandCss = $derived(spread && ramp.stops.length > 0 ? spreadBandSwatch(ramp, spread) : null);

  /**
   * Query (reads the document). The SPREAD MODE this ramp renders with, or null
   * when the list has no spread to read (only a linear gradient paint has one —
   * a top-level `rampStops` list, a material's ramp knob and the radial paint do
   * not, and they must keep the plain single-ramp track they have always had).
   *
   * The stop list's path is […, "linear", "stops"], so the spread sits at
   * […, "linear", "spread"] — the same sibling-key read `rampAspects` does one
   * function up, for the same reason: the bar must show what the RENDER does.
   */
  function spreadMode() {
    if (path.at(-2) !== "linear") return null;
    return getPath(app.state(), [...path.slice(0, -1), "spread"]) ?? GRADIENT_DEFAULT_SPREAD;
  }

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
  // DECLARE the gesture upward, so the mount point can exempt its whole-list-
  // preview fold for its duration (see the header). Derived from the same `drag`
  // the writes read, so the two cannot disagree about whether a gesture is live —
  // there is no second flag to leave set when a pointercancel ends the drag.
  $effect(() => { ondrag?.(drag !== null); });
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

  /** Query. The continuation band's tooltip: which spread mode is drawn there and
   *  what it does, so the strip beside the ramp is self-explaining rather than a
   *  decorative smear. Names the row that changes it (Spread, in the paint panel). */
  function bandTip() {
    return `${SPREAD_TIPS[spread]} Set by the Spread row; this strip previews it, it is not clickable.`;
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

  <!-- THE CONTINUATION BAND — what the ramp does JUST PAST its end under the active
       SPREAD mode (user ruling, 2026-08-02: with looping "I should see purple on the
       right of it"). It is a SEPARATE, SHORTER strip under the track rather than
       tiling drawn inside it, because the track's x IS the stop offset: a bead's
       `left` and a click's fraction both read that width as 0..1, so tiling inside
       it would desynchronize every bead and mis-place every click. As its own strip
       the preview costs the editing geometry nothing.
       Only a LINEAR GRADIENT PAINT has a spread, so every other ramp list (the
       Mandelbrot rampStops, a material's ramp knob, a radial paint) renders no band
       at all and is byte-identical to before this feature.
       INERT: no pointer handlers and aria-hidden — it reports, it is not a second
       place to click, and the track's own tooltip already names the offer. -->
  {#if bandCss}
    <Tooltip text={bandTip()} anchor="element" placement="top">
      <div class="stopbar-band" style:--sb-band={bandCss} aria-hidden="true"></div>
    </Tooltip>
  {/if}

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
        <!-- ONE BEAD — A PIN, POINTING AT ITS OWN STOP. The button is the RIM: a
             pentagon with its apex at top-centre, which `translateX(-50%)` puts
             exactly on the stop's fraction, so the shape states the number it
             stores. Its child is the same pentagon inset by the rim stroke and
             filled with the stop's EVALUATED colour over the alpha checkerboard —
             the user's "they should be the color they represent". --sb-bead is
             DATA, passed exactly as --sb-ramp is one element up.
             SELECTION RECOLOURS THE RIM ONLY, and here that is a correctness
             rule, not a convention: the fill is the datum, so dyeing it to mark
             selection would make the bead misreport its stop. Hidden = hollow (no
             fill), which is this app's spelling for a handle that is present but
             not participating. role="slider" is AngleField's own mapping for a
             positional handle. -->
        <button
          type="button"
          class="stopbar-bead"
          class:selected={selectedIndex === index}
          class:stopbar-bead-hidden={!elementActive(evalActive, index)}
          class:stopbar-bead-bound={bound}
          class:dragging={drag?.at === index}
          style:left={`${Number.isFinite(positions[index]) ? positions[index] * PERCENT : 0}%`}
          style:--sb-bead={colors[index]}
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
          <span class="stopbar-bead-fill">
            {#if bound}
              <!-- The ƒ mark, and the identical glyph ColorField shows on an
                   equation-bound colour — one mark for one meaning. It rides
                   INSIDE the fill so it sits over the colour rather than over the
                   rim, and the fill keeps painting the stop's colour behind it:
                   an equation-bound POSITION says nothing about the colour, so
                   blanking the fill would drop a datum to mark an unrelated one. -->
              <iconify-icon icon="mdi:function-variant" width={EQ_ICON} height={EQ_ICON}></iconify-icon>
            {/if}
          </span>
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
