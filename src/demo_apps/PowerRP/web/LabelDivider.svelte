<!--
  LabelDivider — THE draggable label⟷value boundary for a rows block (the
  Property Panel's and the Variables Panel's shared row grid).

  WHAT THE USER ASKED FOR, verbatim: "I'd like a divider line that controls the
  [label/value proportion]. It wouldn't be one continuous line, it would be
  multiple lines, but in synchronized x position... I can click and drag that
  from left to right to control the proportion of text to property bar. And it
  should be a constant proportion based on the width of that panel. And the bar
  doesn't need to be visible unless I'm hovering over it."

  SO THE SHAPE IS: one instance per rows BLOCK (a category's rows, the Variables
  Panel's list, ...), each spanning only its own block — that is the "multiple
  lines" — but every one of them positioned from the SAME app-level fraction
  (app.labelFrac, published as --a-label-frac on the app root), which is the
  "synchronized x position". Dragging ANY of them moves ALL of them, because they
  are readouts of one number rather than N independent handles. A single
  full-height line was considered and rejected on the user's own wording: the
  panel is a stack of sections with headers and gaps between them, and a line
  ruled straight through those headers reads as a table border, not a handle.

  WHY IT LIVES IN THE DOM AT ALL rather than being a ::before on the rows block:
  a pseudo-element cannot capture a pointer, and a drag that survives the pointer
  leaving a 7px strip needs setPointerCapture. The geometry mirrors the app
  shell's SplitPane handle and the Render Center's divider: a thin visible line
  centred inside a much larger invisible hit area, col-resize to announce itself
  before you press. It reads the SAME --a-split-handle-* tokens those do, so the
  three cannot drift apart across the theme set.

  DOUBLE-CLICK RESETS to the default split. There was no existing double-click
  convention on a divider in this app to mirror (FontPicker's and Render Center's
  offer no reset), so this establishes one; it is the near-universal convention
  in editors with draggable splits, and it is the only way back to the default
  for a preference with no toggle.

  HOW FAR DOWN IT RUNS is decided by WHERE IT IS MOUNTED, and by nothing else:
  this component always spans its offsetParent. That is deliberate — it keeps the
  component free of any notion of which rows deserve a boundary, which is a
  question about ROW DEFINITIONS and belongs to whoever renders them.

  So a caller must mount one per RUN OF BOUNDARY ROWS, not one per category. A
  category is usually all boundary rows and gets exactly one; but a category
  holding a RESTACKED editor (a gradient paint stack, a list's full-width second
  line) is split by it, because a mode strip, a preset library and a stops list
  have no label⟷value column — and a col-resize strip over those was the user's
  "that line is still extending too far down… visually going past the stroke
  material area". That is the same defect that moved the divider from .rows to
  .cat-rows in the first place, one level deeper, and it has the same fix: mount
  on the smallest block that is all boundary rows. web/Inspector.svelte splits a
  category into runs (rowRuns) and PaintField mounts one around its own geometry
  sub-rows and its material knobs. Every segment reads the one app.labelFrac, so
  they stay in x-sync — the user's "multiple lines, in synchronized x position",
  now at two nesting depths.

  A DOM-MEASURING VERSION WAS BUILT AND REVERTED. It published the offsetTop of
  the first full-width child as a CSS variable and ended the strip there. It kept
  losing the measurement: `.cat-rows` is inside the category's `{#if !collapsed}`,
  so expanding a category builds a FRESH block with no inline style, and the
  effect ran before the paint stack mounted — leaving a stale full-block span with
  no mutation to trigger a remeasure. Two observers were added to chase it and it
  was still racy. The row defs already know which rows are full-width, so
  measuring the DOM to rediscover it was the wrong layer.

  Props: app (the PowerRPApp — owns labelFrac and its persistence).
  Styling lives in app.css (.label-divider; app convention: no <style>).
-->
<script module>
  /**
   * Pure function. The label fraction a pointer at client-x `clientX` names, for
   * a rows block whose content box spans [left, left + width], clamped to
   * `bounds`.
   *
   * The pointer's x is read against the ROWS BLOCK, not the panel: the block is
   * the row grid's containing box, so `calc(fraction * 100%)` resolves against
   * exactly this width. Measuring the panel instead would be off by its padding,
   * and the divider would settle a few pixels away from where it was dropped.
   *
   * In `<script module>` so the drag arithmetic is importable by a bare-node
   * test without a DOM — the component around it is the only part that needs one.
   *
   * @param {number} clientX Pointer x in client coordinates
   * @param {number} left Rows-block content-box left edge, client coordinates
   * @param {number} width Rows-block content-box width in px
   * @param {{min: number, max: number}} bounds Clamp bounds for the fraction
   * @returns {number} The clamped fraction
   *
   * @example fractionAt(140, 20, 400, {min: 0.15, max: 0.55})
   * 0.3
   * @example fractionAt(0, 20, 400, {min: 0.15, max: 0.55})
   * 0.15
   * @example fractionAt(1000, 20, 400, {min: 0.15, max: 0.55})
   * 0.55
   */
  export function fractionAt(clientX, left, width, bounds) {
    if (!(width > 0)) return bounds.min; // a zero-width block names no fraction
    return Math.min(bounds.max, Math.max(bounds.min, (clientX - left) / width));
  }
</script>

<script>
  import { LABEL_FRAC_BOUNDS } from "./app.svelte.js";

  let { app } = $props();

  /** The element, for measuring the rows block this divider belongs to. */
  let el = $state(null);
  /** True while a drag is in flight — keeps the line revealed off-hover. */
  let dragging = $state(false);

  /** Query. The rows block this divider is positioned inside — its offset parent,
   *  which app.css makes the .cat-rows / .rows container (position: relative). */
  function rowsBlock() {
    return el?.offsetParent ?? null;
  }

  /** Command. Writes the fraction this pointer position names (clamped +
   *  persisted through app.setLabelFrac). Reads the rows block's live geometry
   *  every move rather than caching it at press, so a drag stays correct if the
   *  panel resizes underneath it (an equation row growing the block, say). */
  function applyPointer(clientX) {
    const block = rowsBlock();
    if (!block) return;
    const r = block.getBoundingClientRect();
    app.setLabelFrac(fractionAt(clientX, r.left, r.width, LABEL_FRAC_BOUNDS));
  }

  /** Command. Begins a divider drag: captures the pointer on this element so the
   *  gesture survives leaving the 7px strip (and outruns the rows re-laying out
   *  underneath it, which a window-listener drag would race). */
  function onPointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    applyPointer(e.clientX);
  }

  /** Command. Tracks the drag. No-op unless a drag is in flight, so merely
   *  moving across the strip does nothing. */
  function onPointerMove(e) {
    if (dragging) applyPointer(e.clientX);
  }

  /** Command. Ends the drag and releases the capture. */
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    el.releasePointerCapture(e.pointerId);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="label-divider"
  class:dragging
  bind:this={el}
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize the property label column"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={() => app.resetLabelFrac()}
></div>
