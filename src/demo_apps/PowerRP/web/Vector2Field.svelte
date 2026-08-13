<!--
  Vector2Field — THE `vec2` ROW CONTROL (core/vector_values.js VEC2_ROW_KIND):
  two numeric boxes plus the drag pad, over ONE slot holding an `[x, y]` tuple.

  ── WHY THIS EXISTS BESIDE Vector2Pad AND DOES NOT REPLACE IT ────────────────
  Vector2Pad is the pad for a COMPOUND row: two SEPARATE leaf paths (`x` and
  `y`), which is what the R7-36 Position/Size rows group. This field is the
  control for a row whose value is the TUPLE ITSELF at one path — a global
  variable being the case with no leaves at all (core/var_kinds.js's recorded
  omission named exactly that gap).

  So the two differ in STORAGE, not in appearance, and the user sees the same
  `[X] [Y] [pad]` grammar either way. Composing rather than forking is what keeps
  it that way: the pad's pointer capture, its preview/commit contract, its
  one-gesture-one-undo law and its arrow-key nudges are Vector2Pad's, unchanged,
  and this file adds only the tuple ⟷ axes mapping and the two boxes.

  ── THE MAPPING IS THE WHOLE FILE ───────────────────────────────────────────
  Vector2Pad writes through `app.setPreview([[path, value], …])` — one pair per
  axis. A tuple slot has ONE path, so a naive reuse would stage two writes to the
  same path and the second would win, giving a pad that moves only in Y. This
  field therefore hands the pad SYNTHETIC axis paths and intercepts the writes,
  recomposing them into one tuple write. `app.setPreview` is called with a single
  pair, so the undo unit and the preview semantics are identical to every other
  field's.

  AN EQUATION-BOUND SLOT IS NOT DRAGGABLE, and it says so rather than silently
  overwriting the expression — ColorField's standing discipline, which
  Vector2Pad already enforces per axis and which this file enforces for the
  whole slot (a tuple is bound or it is not; there is no half-bound tuple).

  Styling lives in app.css (app convention: no <style> blocks here).
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Vector2Pad from "./Vector2Pad.svelte";
  import { getPath } from "../core/deltas.js";
  import { isVec2Value, VECTOR_KINDS } from "../core/vector_values.js";

  let {
    /** @type {object} The PowerRPApp controller. */
    app,
    /** @type {string[]} The state path of the slot holding the `[x, y]` tuple. */
    path,
    /** @type {string[][]|null} MULTI-SELECTION write paths — the joint seam fans
     *  one computed tuple to N slots (core/multiselect.js classifies `vec2` as
     *  jointly editable, and states why). Absent = single selection. */
    paths = null,
    /** @type {string} What this row edits, for aria-labels and tooltips. */
    label,
    /** @type {boolean} A not-yet-created item's grayed row. */
    disabled = false,
    /** @type {object} The row def, for the axes' scrub coefficients. */
    row = {},
  } = $props();

  /** The component names, from the DECLARATION table rather than literals — a
   *  kind whose axes are renamed follows with no edit here (R7-38c). */
  const AXES = VECTOR_KINDS.pos.axes;

  /** The synthetic parent key the pad's axis paths hang off. It never reaches a
   *  document — `padApp` intercepts every write — so it only has to be a name the
   *  two synthetic paths agree on. */
  const AXIS_HOST = "__vec2";

  let writePaths = $derived(paths ?? [path]);

  /** Query. The slot's RAW value — raw, so an equation string is seen as a
   *  string rather than coerced into a misleading pair of zeros. */
  let stored = $derived(getPath(app.rawState(), path));
  let isBound = $derived(typeof stored === "string");
  let pair = $derived(isVec2Value(stored) ? stored : null);

  /** Command. Writes the whole tuple to every target slot, as a PREVIEW. */
  function previewTuple(next) {
    app.setPreview(writePaths.map((p) => [p, next]));
  }

  /**
   * THE INTERCEPTING APP FACADE handed to Vector2Pad. The pad believes it is
   * driving two independent leaf paths; this recomposes its per-axis writes into
   * ONE tuple write before they reach the real controller.
   *
   * WHY A FACADE RATHER THAN A PROP ON THE PAD. The pad's contract is "N paths,
   * one gesture, one undo unit", and it is already correct — teaching it about a
   * second storage shape would put a branch in a control that has none, to serve
   * a caller it should not know about. Intercepting keeps the pad ignorant and
   * keeps this file's oddity local to the file that has it.
   */
  const padApp = {
    rawState: () => {
      // The pad reads each axis off the state by its synthetic path, so present
      // the tuple's components where it expects to find them. Absent when the
      // slot is unreadable, which is what makes the pad decline to drag.
      const p = pair;
      return p ? { [AXIS_HOST]: { [AXES[0]]: p[0], [AXES[1]]: p[1] } } : { [AXIS_HOST]: {} };
    },
    setPreview: (pairs) => {
      // Fold the pad's per-axis pairs back into ONE tuple, seeded from the
      // current value so a gesture that moves only X keeps Y exactly.
      const next = pair ? [...pair] : [0, 0];
      for (const [p, v] of pairs) {
        const axis = p[p.length - 1];
        const i = AXES.indexOf(axis);
        if (i >= 0) next[i] = v;
      }
      previewTuple(next);
    },
    commitPreview: () => app.commitPreview(),
    cancelPreview: () => app.cancelPreview?.(),
  };

  let padAxes = $derived(AXES.map((axis) => ({
    row: { label: axis.toUpperCase(), ...row },
    path: [AXIS_HOST, axis],
  })));

  /** Command. One box's typed value, committed as one undo unit. A non-number is
   *  ignored rather than written as NaN — the box keeps showing the real value. */
  function commitAxis(i, text) {
    const v = Number(text);
    if (!Number.isFinite(v) || !pair) return;
    const next = [...pair];
    next[i] = v;
    previewTuple(next);
    app.commitPreview();
  }
</script>

<span class="vec2-field" class:vec2-field-disabled={disabled}>
  {#if isBound}
    <!-- AN EQUATION OWNS THE SLOT. Showing the expression rather than a pair of
         boxes is the honest display: there is no stored pair to edit, and boxes
         over an equation would invite a keystroke that destroys it. -->
    <Tooltip text={`${label} is bound to an equation — edit it in the row's = field`}>
      <span class="vec2-bound">{stored}</span>
    </Tooltip>
  {:else}
    {#each AXES as axis, i (axis)}
      <input
        type="number"
        class="vec2-box"
        aria-label={`${label} ${axis.toUpperCase()}`}
        value={pair ? pair[i] : ""}
        placeholder={axis.toUpperCase()}
        {disabled}
        onchange={(e) => commitAxis(i, e.target.value)}
        onkeydown={(e) => e.stopPropagation()}
      />
    {/each}
    {#if !disabled}
      <Vector2Pad app={padApp} axes={padAxes} {label} />
    {/if}
  {/if}
</span>
