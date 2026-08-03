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
  reason in its ACCESSIBLE LABEL (the beads lost their tooltips on the user's
  2026-08-02 ruling; a refusal is the one thing role="slider" cannot state, so it
  survives where a screen reader can still reach it, and the ƒ mark says it on
  screen) — the say-the-reason discipline ListField's blocked eye
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
  pointermove across the track. So the track shows a GHOST bead at the pointer,
  which says what the click will do BEFORE it happens with no document write at
  all. It used to ALSO narrate that in a tooltip; the user removed it
  (2026-08-02, verbatim: "This tooltip is noise"), and the ghost is the part
  that was doing the work.

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
   * Samples across the effective ramp when a spread mode makes it differ from the
   * authored stops — matches cssRampSwatch's own resample density, so the one bar
   * is exactly as smooth as the swatches beside it.
   */
  const SPREAD_SAMPLES = 32;

  /**
   * Pure function. THE ONE BAR's CSS gradient: the ramp AS THE FILL READS IT over
   * the [0,1] window, under the active spread mode.
   *
   * ── WHY THERE IS ONLY ONE BAR NOW (user ruling, 2026-08-02, verbatim) ───────
   * "What I also don't understand is why there's two bars. There should only be
   * one. Now, the way that we display the one on the top could depend on whether
   * we do loop vs mirror vs pad. If it's mirror or pad, it would look the same
   * between those two. Loop would only be the only one that's different. You see,
   * in order for a loop to work, the very left of it and the very right of it have
   * to take into consideration what would happen if it loops. You don't need two
   * bars. That's weird looking."
   *
   * The second bar was a CONTINUATION BAND — a shorter strip under the track
   * showing the NEXT tile past offset 1, so the bar would stop silently claiming
   * every gradient pads. It answered the right question with the wrong picture: a
   * second ramp beside the first reads as a second ramp, and the information it
   * carried belongs IN the ramp, at the two ends where the mode actually changes
   * what you see.
   *
   * ── THE RULE, AND WHY EACH MODE LANDS WHERE IT DOES ─────────────────────────
   * The tile mode is a property of what happens OUTSIDE the ramp's span. Inside
   * [0,1]:
   *   PAD    — beyond the last stop the last colour is held. That is what CLAMP
   *            already does inside the window, so the bar IS the authored ramp.
   *   MIRROR — the reflection is the tile at [1,2] (and [-1,0]); nothing about the
   *            window itself changes. Identical to pad, as the ruling states.
   *   LOOP   — the fill's period is exactly one ramp, so the stretch between the
   *            LAST stop and offset 1 is not held flat: it runs across the seam
   *            toward the FIRST stop's colour, because that is the colour that
   *            arrives immediately after it. Symmetrically, 0..first-stop arrives
   *            from the last stop's colour. That is precisely core/ramps.js's
   *            `loop` reading — the SYNTHESISED WRAP SEGMENT, running from
   *            offset_last to offset_0 + 1 (its module header spells the boundary
   *            semantics out, including why offset 1 IS offset 0 on that circle).
   *
   * So loop is not respelled here: the bar sets `loop: true` on the ramp aspects
   * and hands the whole thing to the SAME `sampleRampHex` the renderer, the preset
   * swatches and the click-to-add colour all read, which is what makes it
   * structurally impossible for the bar to disagree with the picture.
   *
   * A ramp that ALREADY declares `loop: true` (a cyclic palette) is unchanged by
   * loop spread — it was already being read on the circle.
   *
   * MEASURED, AND WORTH KNOWING BEFORE YOU CALL THIS BROKEN: a ramp whose stops
   * span the FULL window (one at 0 and one at 1 — the common two-stop default)
   * looks IDENTICAL in all three modes. Its wrap segment has zero length, which
   * core/ramps.js calls the deliberately-authored HARD SEAM, so there is no
   * stretch outside the stops for loop to fill differently. The difference appears
   * exactly when there is room for it: drag a stop inward and loop's tail stops
   * holding flat and starts running back toward the other end. Verified on
   * teal #00c497 → green #22c55e at offsets 0.2/0.8: clamp reads #22c55e at 0.9,
   * loop reads #1ac56c.
   *
   * Args:
   *   ramp ({stops, loop, space}): the ramp being drawn
   *   spread (string|null): "mirror" | "loop" | "pad", or null for a list with no
   *     spread to read (every non-linear-paint ramp) — then the authored ramp
   *
   * Returns:
   *   string — a CSS `linear-gradient(...)` value
   *
   * @example effectiveRampSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#0000ff"}], loop: false, space: "srgb"}, "pad") // "linear-gradient(90deg, #ff0000 0%, #0000ff 50%)" (pad/clamp: the authored stops, verbatim)
   * @example effectiveRampSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#0000ff"}], loop: false, space: "srgb"}, "mirror") // "linear-gradient(90deg, #ff0000 0%, #0000ff 50%)" (mirror is identical inside the window — the reflection is the NEXT tile)
   * @example effectiveRampSwatch({stops: [{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#0000ff"}], loop: false, space: "srgb"}, "loop").endsWith("#ff0000 100%)") // true (loop's tail crosses the seam back to the FIRST stop's red, instead of holding blue flat)
   */
  export function effectiveRampSwatch(ramp, spread) {
    if (spread !== null && !SPREAD_MODES.includes(spread))
      throw new Error(`effectiveRampSwatch: unknown spread ${JSON.stringify(spread)} (expected ${SPREAD_MODES.join(", ")}, or null)`);
    // PAD and MIRROR leave the [0,1] window exactly as authored, so the bar is the
    // ordinary ramp swatch and a plain sRGB clamped ramp stays its literal stops.
    if (spread !== "loop" || ramp.loop) return rampSwatchOf(ramp);
    const looped = { ...ramp, loop: true };
    const stops = Array.from({ length: SPREAD_SAMPLES + 1 }, (_, i) => ({
      offset: i / SPREAD_SAMPLES,
      color: sampleHex(ramp.stops, i / SPREAD_SAMPLES, looped),
    }));
    return cssGradientFromStops(stops);
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { fieldOwnsKeydown } from "../../../lib/fieldKeys.js";
  import { fractionAt } from "./labelFrac.js";
  import { GRADIENT_DEFAULT_SPREAD } from "../core/properties.js";
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
  /** How many decimals a position is stated to in an accessible label. LINKED to
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
   *  hidden stop is as absent from the bar as it is from the picture. */
  let ramp = $derived({
    stops: visibleElements(decl, { list: evalList, active: evalActive })
      .map((el) => ({ offset: Number(fieldOf(el, decl.orderKey)), color: String(fieldOf(el, colorField.name)) })),
    ...rampAspects(),
  });

  /** The active SPREAD MODE, or null when this list has none (see spreadMode). */
  let spread = $derived(spreadMode());

  /** THE ONE BAR's gradient — the ramp AS THE FILL READS IT under the active
   *  spread (module header). Identical to the authored ramp under pad and mirror;
   *  under loop the two ends cross the seam. Sampled through the SAME sampler the
   *  renderer uses, so this cannot disagree with the picture. */
  let rampCss = $derived(ramp.stops.length > 0 ? effectiveRampSwatch(ramp, spread) : "none");

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
   * bead and stops there (its aria-label and its ƒ mark carry the reason; a drag
   * would write a literal over the expression). */
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

  /** Query. A position as accessible-label text, rounded past float dust. */
  const shown = (t) => String(+t.toFixed(POSITION_DECIMALS));

  /**
   * Query (reads the list). ONE bead's ACCESSIBLE NAME — which stop it is and
   * where it sits. NOT a tooltip: the bar carried one and the user removed it
   * (2026-08-02, verbatim: "That tooltip does not need to exist… redundant and
   * they're noisy"). What was redundant on screen is not redundant to a screen
   * reader, which cannot see the bead's x or the number in the row below, so the
   * SENTENCE survives as the aria-label and only its visual advertisement is gone.
   *
   * The bead's ROLE carries the rest: role="slider" with aria-valuenow already
   * states the position numerically and announces the arrow keys as its own
   * affordance, so the old tip's "Drag to move it, or use the arrow keys" was
   * telling a screen reader what its widget role had already told it — twice.
   * The one thing a role cannot say is the REFUSAL, so an equation-bound bead
   * keeps its reason here (aria-disabled is a state, not an explanation).
   */
  function beadLabel(index) {
    const where = `${label} ${index + 1} at ${shown(positions[index])}`;
    if (positionBound(index)) return `${where} — position is an equation (${fieldOf(rawList[index], decl.orderKey)}); edit it in the row below`;
    if (!elementActive(evalActive, index)) return `${where}, hidden`;
    return where;
  }
</script>

<div class="stopbar" class:stopbar-disabled={disabled}>
  <!-- THE ONE TRACK — the ramp itself as the FILL reads it under the active spread
       (see the module header for the loop-seam rule), over the transparency
       checkerboard (a stop's colour carries alpha, so a ramp that fades out must
       read as fading out — ColorField's swatch recipe). Clicking it adds a stop at
       the clicked position; a GHOST bead follows the pointer to say where, with no
       document write (see the header on why this is not a hover PREVIEW).
       NO TOOLTIP, on the user's ruling (2026-08-02, verbatim: "This tooltip is
       noise… redundant and they're noisy"). The ghost bead already shows where a
       click lands, the `cursor: copy` already states that a click ADDS, and the
       stop's colour and number appear in the row below the instant it exists — so
       the sentence was narrating three things the surface was already saying. The
       BEHAVIOUR is untouched: click still adds a stop, at the ramp's own colour.
       It carries NO role and NO aria-label, deliberately. It is a POINTER-ONLY
       affordance with no keyboard equivalent, so naming it in the accessibility
       tree would promise a control that cannot be operated from there; the
       ACCESSIBLE way to add a stop is the row list's own insert button, and the
       beads (role="slider", labelled and focusable) are this bar's keyboard
       surface. Labelling a div is not the same as making it usable. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="stopbar-track"
    bind:this={trackEl}
    style:--sb-ramp={rampCss}
    onpointerdown={onTrackDown}
    onpointermove={(e) => (hover = trackEl ? fractionOf(e.clientX) : null)}
    onpointerleave={() => (hover = null)}
  ></div>

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
      <!-- NO TOOLTIP ON A BEAD, on the user's ruling (2026-08-02, verbatim: "That
           tooltip does not need to exist… redundant and they're noisy"). It said
           "Stop N at F. Drag to move it, or use the arrow keys." — a sentence
           restating the bead's own x, the number already in the row below it, and
           two affordances the pointer discovers by trying them. Every BEHAVIOUR it
           advertised is intact (drag, arrow-key nudge, the refusal on an
           equation-bound position); only the advertisement is gone, and the
           sentence survives where it is not redundant, as the aria-label. -->
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
        aria-label={beadLabel(index)}
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
