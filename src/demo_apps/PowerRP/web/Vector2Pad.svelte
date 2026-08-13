<!--
  Vector2Pad — THE 2D DRAG PAD for a COMPOUND row's two numeric leaves
  (workstream COMPOUND_, backburner CY). The user's own request names it and
  names its reference: XY "can be controlled similar to rot in that if not
  dropped down we might have a drag pad where we click and drag that pad to move
  the x and y values which are like > [X] [Y] [dragpad] unless dropped down then
  it would be like  v [DragPad] \n [X] [Y]".

  SO IT IS THE ROTATION DIAL'S SIBLING, and it is written as one: same pointer
  capture, same preview-during-drag / commit-on-release contract, same "one
  gesture is ONE undo unit" law, same `role="slider"` + arrow-key nudges so the
  control is not pointer-only. web/AngleField.svelte is the precedent for every
  one of those and this file deliberately restates none of the reasoning.

  IT IS RELATIVE, NOT ABSOLUTE, and that is the one place it must differ from the
  dial. A heading has a natural absolute mapping onto a circle — the pointer's
  angle IS the value — but X and Y are UNBOUNDED canvas coordinates, so there is
  no position inside a 40px square that "is" x = 1730. Mapping the pad's box onto
  a fixed coordinate window would either clamp the widget to that window or make
  the pad's sensitivity depend on a range nobody declared. So the pad integrates
  DELTAS: press seeds from the current pair, every move adds the pointer's
  movement scaled by the leaves' own scrub coefficients, and release commits the
  accumulated pair. That also makes it behave exactly like dragging the two
  NumericField scrubbers at once, which is what an author already knows.

  BOTH LEAVES MOVE IN ONE WRITE (one `setPreview` pair list, one
  `commitPreview`), so a diagonal drag is a single undo step rather than an x
  step and a y step the author has to undo twice — and so the two can never land
  on different slides' keyframes.

  AN EQUATION-BOUND LEAF IS NOT DRAGGABLE, and the pad says so rather than
  silently overwriting the expression. This is ColorField's standing discipline
  ("every one of them would overwrite the equation") applied to a joint control:
  the pad is disabled, its tooltip names which axis is bound, and the leaf's own
  row is still there for editing the expression. Dragging a pad that quietly
  replaced `= centre.x` with a literal is exactly the quiet wrongness this
  codebase forbids.

  Styling lives in app.css (.vec2pad; app convention: no <style> blocks here).
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { getPath } from "../core/deltas.js";
  import { resolveScrub } from "../../../lib/numberStep.js";

  let {
    /** @type {object} The PowerRPApp controller. */
    app,
    /** @type {{path: string[], row: object}[]} The two leaves, in [horizontal,
     *  vertical] order: the full state path to write and the row def whose
     *  scrub/bounds this axis uses. */
    axes,
    /** @type {boolean} The EXPANDED presentation — a larger pad, shown above the
     *  leaves' own rows when the compound is dropped down. */
    large = false,
    /** @type {string} What the pad edits, for its aria-label and tooltip. */
    label,
  } = $props();

  /** Query. This axis's RAW stored value — raw, so an equation string is seen as
   *  a string rather than coerced into a misleading number. */
  function storedAt(axis) {
    return getPath(app.rawState(), axis.path);
  }

  /** Query. The axes' current numeric pair, or null on an axis that is not a
   *  plain number (an equation, or an absent slot). */
  let pair = $derived(axes.map((a) => storedAt(a)));
  let boundAxis = $derived.by(() => {
    for (let i = 0; i < axes.length; i++) {
      if (typeof pair[i] === "string") return axes[i];
    }
    return null;
  });
  let draggable = $derived(!boundAxis && pair.every((v) => typeof v === "number"));

  /** Query. Canvas units per dragged pixel for one axis — the SAME coefficient
   *  that axis's own NumericField scrubber uses, so dragging the pad and dragging
   *  the X box move the widget at identical speed. Deriving it here from the row
   *  rather than picking a pad-local constant is what keeps the two in step when
   *  a row's bounds change. */
  function coefficientFor(row) {
    return resolveScrub({
      scrub: row.scrub ?? null,
      min: row.scrubMin ?? row.min ?? null,
      max: row.scrubMax ?? row.max ?? null,
    });
  }

  /** The in-flight gesture: the accumulated values and the last pointer seen.
   *  Null when no drag is running. */
  let drag = $state(null);
  let padEl = $state(null);

  /** Command. Writes both axes at once as a PREVIEW (viewport re-renders live;
   *  the document is untouched until commit). */
  function preview(values) {
    app.setPreview(axes.map((a, i) => [a.path, values[i]]));
  }

  /** Command. Starts the gesture: captures the pointer and seeds from the values
   *  currently stored, so the first move is relative to what is on screen. */
  function onPointerDown(e) {
    if (!draggable) return;
    padEl.setPointerCapture(e.pointerId);
    drag = { values: [...pair], x: e.clientX, y: e.clientY };
    e.preventDefault();
  }

  /** Command. Integrates one step: each axis advances by the pointer's movement
   *  along that axis times its own coefficient. Screen y is down and canvas y is
   *  down, so the vertical axis needs no flip. */
  function onPointerMove(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * coefficientFor(axes[0].row);
    const dy = (e.clientY - drag.y) * coefficientFor(axes[1].row);
    const values = [drag.values[0] + dx, drag.values[1] + dy];
    drag = { values, x: e.clientX, y: e.clientY };
    preview(values);
  }

  /** Command. Settles the gesture as ONE undo unit at the ACCUMULATED pair —
   *  never at a re-read of the pointer, which would drop the last step. A drag
   *  that never moved commits nothing, so a stray click does not create a
   *  keyframe (the dial's own rule). */
  function onPointerUp(e) {
    if (!drag) return;
    const settled = drag.values;
    const moved = settled.some((v, i) => v !== pair[i]);
    drag = null;
    padEl.releasePointerCapture?.(e.pointerId);
    if (!moved) return;
    preview(settled);
    app.commitPreview();
  }

  /** Command. Arrow keys nudge the pair (the control is not pointer-only —
   *  the save-dot rule). Shift is the coarse step, matching DraggableNumber's
   *  own modifier. Each nudge is its own undo unit. */
  const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const COARSE_NUDGE_MULTIPLIER = 10;

  function onKeyDown(e) {
    const step = NUDGE_KEYS[e.key];
    if (!step || !draggable) return;
    e.preventDefault();
    e.stopPropagation(); // a focused pad must not also drive canvas shortcuts
    const scale = e.shiftKey ? COARSE_NUDGE_MULTIPLIER : 1;
    const values = axes.map((a, i) => pair[i] + step[i] * scale * coefficientFor(a.row));
    preview(values);
    app.commitPreview();
  }

  let tip = $derived(
    boundAxis
      ? `${label}: ${boundAxis.row.label} is bound to an equation — edit it on its own row`
      : draggable
        ? `Drag to change ${label} (both axes at once, one undo step)`
        : `${label} has no value to drag yet`
  );
</script>

<Tooltip text={tip}>
  <!-- role="slider" mirrors the rotary dial's own markup (web/AngleField.svelte):
       a focusable, keyboard-operable control that reports a value.
       A 2-VECTOR HAS NO SINGLE `aria-valuenow`, and the two attributes divide
       that honestly rather than one of them lying: `aria-valuetext` carries the
       PAIR, which is what a screen reader actually announces, and `aria-valuenow`
       carries the HORIZONTAL axis because the role requires a number and a
       reader falling back to it should get one of the real values rather than a
       0 that means nothing. Both are the dial's own attributes; only the pairing
       is new. -->
  <div
    bind:this={padEl}
    class="vec2pad"
    class:vec2pad-large={large}
    class:vec2pad-disabled={!draggable}
    class:vec2pad-dragging={!!drag}
    role="slider"
    tabindex={draggable ? 0 : -1}
    aria-label={label}
    aria-disabled={!draggable}
    aria-valuenow={typeof pair[0] === "number" ? pair[0] : undefined}
    aria-valuetext={axes.map((a, i) => `${a.row.label} ${typeof pair[i] === "number" ? pair[i].toFixed(1) : String(pair[i] ?? "—")}`).join(", ")}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
  >
    <!-- The crosshair: a purely decorative reticle that says "this square is a
         2D control" without claiming a coordinate window it does not have (see
         the header on why the pad is relative). -->
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <line x1="50" y1="8" x2="50" y2="92" />
      <line x1="8" y1="50" x2="92" y2="50" />
      <circle cx="50" cy="50" r="9" />
    </svg>
  </div>
</Tooltip>
