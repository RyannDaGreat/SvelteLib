<!--
  TextFormatToolbar — the floating PowerPoint-style format toolbar that hovers
  ABOVE the text box being edited (Round 13.4; manifest "WHILE EDITING, a toolbar
  LIKE THAT floats SOMEWHERE ABOVE the text being edited"). It applies character
  style to the CURRENT SELECTION of the TextEditOverlay via the `onstyle` callback
  (core/richtext.applyRunStyle under the hood) — one preview per action, committed
  as ONE undo unit when editing exits.

  Controls (the PPT target subset built now): Bold · Italic · Underline ·
  Strikethrough · font-size stepper AND a scrubbable size readout between its two
  buttons (R6-13.2) · font family · font Color · text HIGHLIGHT · glyph OUTLINE
  (color + width) · paragraph ALIGN left/center/right (Round 15.6).
  THE SIZE CONTROL HAS THREE VERBS, one per gesture (user ruling, 2026-08-02 —
  quoted in full at "THE THREE SIZE VERBS" below): TYPING a number NORMALIZES every
  selected run to it, DRAGGING scales them all PROPORTIONALLY (ratios kept), and
  the +/- buttons ADD to each (ratios deliberately not kept). The gesture arrives
  from DraggableNumber's provenance argument; the verbs are
  core/richtext.applyRunStyle / scaleRunSize / adjustRunSize respectively. This
  file used to say "EVERY SIZE CONTROL HERE IS RELATIVE" and send px-to-ADD for
  BOTH of the readout's gestures, which is why typing 18 over a 48+18 selection
  shifted it by -30 instead of normalizing it.
  Character toggles reflect the selection's COMMON value (indeterminate when
  mixed) via `onstyle`; the align buttons are PARAGRAPH-level and go through
  `onparastyle` (they set every paragraph the selection touches), reflecting the
  common paragraph align. Buttons follow the app's .btn-icon standard; hover help
  uses SvelteLib's Tooltip (native title= is banned — manifest).

  It floats in the overlay's ROOT frame (already world-transformed), so it counter-
  scales by 1/boxScale to stay a fixed on-screen size (a toolbar should not rotate/
  zoom with the text). Styling lives in app.css (.text-format-toolbar*).

  MOUSEDOWN on the toolbar must NOT blur the contenteditable (which would exit
  edit mode) — every interactive control preventDefaults mousedown so focus stays
  in the editor while a button is clicked.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import FontPicker from "./FontPicker.svelte";
  import ColorPicker from "../../../lib/ColorPicker.svelte";
  import { commonStyle, runStyleAt, paragraphRanges, paraStyleFor, DEFAULT_PARA_SIZE, MIN_RUN_SIZE, SIZE_STEP } from "../core/richtext.js";
  // The app's ONE way of writing "these values differ" — reused, not re-invented.
  import { MIXED_MARK } from "../core/multiselect.js";
  import { fontOptions } from "../render_gpu/fonts.js";

  // app, boxScale (world→screen scale to counter), onstyle(delta), selRange,
  // runsAt() → current runs (read fresh so the toggle reflects the live DOM),
  // onparastyle(delta) applies a PARAGRAPH-style delta (align) to the touched
  // paragraphs, parasAt() → current paras + boxAlign (the box-level align default
  // underlying paragraphs with no own override — so an unset paragraph reflects
  // the box, not a bare undefined).
  //
  // onstylepreview(delta)/onstylepreviewend() are the same run-style delta staged
  // LIVE and reverted — the hover-to-preview seam. They mirror onstyle exactly so
  // the previewed thing and the committed thing can never disagree. This toolbar
  // stays app-agnostic about them (the GradientPresetPicker/AngleField callback
  // convention): only the controller knows the text model and the selection
  // RANGE a run-style delta applies over, so only it can stage one.
  //
  // onsizestep(delta)/onsizesteppreview(delta) are the SIZE stepper's own seam,
  // separate from onstyle because a size step is ADDITIVE (px to ADD to every
  // covered run) while every other control writes an ABSOLUTE value. This toolbar
  // used to build a {size: n} delta itself from the selection's COMMON size, which
  // is undefined on a MIXED selection — so it fell back to a constant and
  // flattened 48+18 into one run at 38, while the keyboard path's differently
  // computed fallback produced one run at 50. Both now call the controller's ONE
  // stepSize; this file no longer knows how a size is derived, only by how much.
  //
  // onsizeset(px) / onsizescale(factor) / onsizescalepreview(factor) are the OTHER
  // TWO size verbs — see "THE THREE SIZE VERBS" below and in
  // core/richtext.js. They are separate props rather than one callback taking a
  // verb tag because they take DIFFERENT ARGUMENTS: a size in px, a multiplier,
  // and a px delta are three different quantities, and a single `(verb, n)` seam
  // would put the reader one indirection away from knowing which of the three `n`
  // is.
  let { app, boxScale, onstyle, onstylepreview, onstylepreviewend, onsizestep, onsizesteppreview, onsizeset, onsizescale, onsizescalepreview, selRange, runsAt, onparastyle, parasAt, boxAlign } = $props();

  // Which inline color popover is open (font | highlight | outline | null).
  let openPicker = $state(null);

  // The selection's COMMON value for each style key (undefined = mixed). Reading
  // runsAt() makes these reactive to selRange + preview edits.
  let runs = $derived(runsAt());
  let common = $derived.by(() => {
    const r = runs, { start, end } = selRange;
    return {
      bold: commonStyle(r, start, end, "bold"),
      italic: commonStyle(r, start, end, "italic"),
      underline: commonStyle(r, start, end, "underline"),
      strike: commonStyle(r, start, end, "strike"),
      size: commonStyle(r, start, end, "size"),
      font: commonStyle(r, start, end, "font"),
      color: commonStyle(r, start, end, "color"),
      highlight: commonStyle(r, start, end, "highlight"),
      outlineColor: commonStyle(r, start, end, "outlineColor"),
      outlineWidth: commonStyle(r, start, end, "outlineWidth"),
    };
  });

  // The number the size scrubber SHOWS and measures its drag from: the selection's
  // common size, or — when the sizes differ — the size at the selection START.
  // Stable for the whole gesture, because `runs` is the PRE-PREVIEW base while a
  // preview is staged, which is what lets the scrub send a CUMULATIVE delta.
  let sizeSeed = $derived(common.size ?? runStyleAt(runs, selRange.start).size ?? DEFAULT_PARA_SIZE);

  const fonts = fontOptions().map((o) => ({ value: o.value, label: o.label }));

  // The common paragraph ALIGN across every paragraph the selection touches
  // (undefined ⇒ mixed → no button lit; the PPT indeterminate convention). Each
  // paragraph's EFFECTIVE align layers the box-level default under its own paras
  // override (paraStyleFor), so a paragraph that never set align reflects the box
  // — the button reads what the user actually SEES.
  let commonAlign = $derived.by(() => {
    const runs = runsAt(), paras = parasAt();
    const ranges = paragraphRanges(runs);
    const { start, end } = selRange;
    const lo = Math.min(start, end), hi = Math.max(start, end);
    let value, seen = false;
    ranges.forEach((r, i) => {
      const touched = lo === hi ? (lo >= r.start && lo <= r.end) : (lo <= r.end && hi > r.start);
      if (!touched) return;
      const a = paraStyleFor(paras, i, { align: boxAlign }).align;
      if (!seen) { value = a; seen = true; }
      else if (a !== value) value = undefined; // mixed
    });
    return value;
  });

  function setAlign(align) { onparastyle({ align }); }

  // HOVER PREVIEWS WHAT THE CLICK WOULD DO. Every control below routes its
  // WRITE through the pure *Delta helpers in <script module>, and its HOVER
  // through the same helper into onstylepreview — so the previewed thing and the
  // committed thing are the same delta by construction, not by two people
  // remembering to keep two expressions in step.
  //
  // The seam was already passed in (onstylepreview/onstylepreviewend, props
  // above) and reached only the FontPicker; every other control ignored it. The
  // controller's previewStyleOnSelection re-applies from a captured base, so
  // hovering Bold then Italic previews Italic alone rather than compounding, and
  // stages the value as app.transientPreview so a click-away mid-hover commits
  // the real value rather than the one merely pointed at.
  // WHOSE PREVIEW IS STAGED — a PLAIN (non-$state) bridge variable, written and
  // read imperatively and never driving a re-render: the CanvasToolbar/
  // CommandPalette `previewing`/`previewedId` convention.
  //
  // IT IS LOAD-BEARING, and measured. There is exactly ONE preview slot, and this
  // toolbar has TWO things that stage into it: these buttons, and the FontPicker
  // NESTED INSIDE IT, which owns its own preview lifecycle (its own leave, close
  // and unmount all revert). A bare `onpointerleave={onstylepreviewend}` on the
  // toolbar root therefore became a second, coarser owner of the same slot and
  // reverted the FONT preview out from under the picker: with it wired that way,
  // fontpicker_probe's "HOVER REPAINTS THE CANVAS" fell from mad=53.272 to
  // mad=0.000 while the arrow-key path — which never crosses the toolbar edge —
  // kept working. So the leave reverts ONLY a preview these buttons staged, and
  // the FontPicker's own preview claims the slot away from them (below).
  let previewing = false;

  function toggle(key) { previewing = false; onstyle(toggleDelta(common, key)); }
  function previewToggle(key) { previewing = true; onstylepreview(toggleDelta(common, key)); }
  function stepSize(delta) { previewing = false; onsizestep(delta); }
  function previewStepSize(delta) { previewing = true; onsizesteppreview(delta); }

  // ── THE THREE SIZE VERBS (user ruling, 2026-08-02, verbatim) ────────────────
  // "when I type in a number for a font size, if I have multiple words that have
  //  different sizes, they should all be normalized to that number. But if I drag
  //  it up and down, it should make them all bigger or smaller, maintaining the
  //  myriad of different sizes I may have selected. And by the way, it should do
  //  so proportionally when I'm using the slider, as opposed to the pluses and
  //  minuses. The reason why is because I want to keep the relative proportions of
  //  the different font sizes the same when I use the slider, and increment or
  //  decrement when I use the increment or decrement buttons."
  //
  // So ONE control has THREE meanings, decided by the GESTURE and by nothing else:
  //   TYPED  → NORMALIZE    onsizeset(n)          every run becomes n
  //   DRAG   → PROPORTIONAL onsizescale(f)        every run × f, ratios kept
  //   +/-    → ADDITIVE     onsizestep(±SIZE_STEP) every run ± the step, ratios NOT
  // The +/- buttons are unchanged; they were already the additive verb. What is
  // new is that the READOUT no longer answers with the additive verb for both of
  // its own two gestures.
  //
  // HOW THE GESTURE REACHES HERE: DraggableNumber reports it, as the second
  // argument to oninput/onchange — {source: "drag"|"typed"|"step", startValue}.
  // That argument is why this workstream needed a lib change at all ("You may need
  // the number slider to be able to emit an event upon entering a number through
  // text … everything else out there right now doesn't, but this one little thing
  // can"). Nothing else in the app reads it.
  //
  // THE FACTOR IS ALWAYS RATIO-FROM-START, NEVER FROM THE LAST FRAME, and that is
  // load-bearing rather than stylistic. `sizeSeed` is the value the readout showed
  // when the drag began — it is stable for the whole gesture, because the toolbar
  // reads the PRE-PREVIEW base while a preview is staged — and the controller
  // re-applies each preview from its own captured base. So every frame computes
  // "start sizes × (current / start)". A frame-to-frame factor would instead
  // multiply the PREVIOUS frame's already-rounded sizes, and since scaledSize
  // rounds to whole px, a long drag would accumulate that rounding differently per
  // run and visibly drift the proportions apart — the classic compounding bug, and
  // the one thing the user explicitly asked this control to preserve.
  //
  // WHY NOT USE g.startValue (which DraggableNumber also supplies)? It is the same
  // number by construction, but sizeSeed is the one the CONTROLLER's re-apply base
  // corresponds to; reading the seed keeps the numerator and denominator sourced
  // from the same place, so they cannot disagree if a future edit changes what the
  // readout displays mid-gesture.

  /** Command. The scrubbable readout's live frames. Routes on the gesture: a DRAG
   *  previews the PROPORTIONAL verb (ratio from the drag's start), a TYPED value
   *  previews nothing here — it has no intermediate frames, it arrives once,
   *  already committed, through onchange.
   *
   *  A "step" source cannot reach this control: it comes from DraggableNumber's
   *  own Arrow-key nudge, which IS an increment, so it takes the additive verb —
   *  the same one the +/- buttons use, keeping the keyboard and the buttons on one
   *  answer as they have been since the 38-vs-50 divergence. */
  function scrubSize(next, g) {
    previewing = true;
    if (g?.source === "step") { onsizesteppreview(next - sizeSeed); return; }
    onsizescalepreview(sizeFactor(next));
  }

  /** Command. The scrubbable readout settling — the durable write, routed to
   *  whichever of the three verbs the gesture means. TYPED normalizes, DRAG
   *  scales, an Arrow-key nudge steps. Each is ONE undo unit: the controller's
   *  durable entry points all push exactly one in-session snapshot, and the whole
   *  edit session commits as one document-level entry. */
  function commitScrubSize(next, g) {
    previewing = false;
    if (g?.source === "typed") { onsizeset(next); return; }
    if (g?.source === "step") { onsizestep(next - sizeSeed); return; }
    onsizescale(sizeFactor(next));
  }

  /** Pure-ish (reads the gesture's stable seed). The drag's whole-gesture ratio —
   *  see the RATIO-FROM-START note above for why the denominator is the seed and
   *  never the previous frame. */
  function sizeFactor(next) { return dragFactor(next, sizeSeed); }

  /** Command. Stages a FONT preview and takes OWNERSHIP of the slot from the
   *  buttons, so a later toolbar-leave cannot revert the picker's preview. Last
   *  writer owns — one rule, no two-owner ambiguity. */
  function previewFont(id) { previewing = false; onstylepreview({ font: id }); }

  /** Command. Reverts a preview THESE BUTTONS staged; a no-op when the slot is
   *  owned by the nested FontPicker or by nothing at all. Safe to call from any
   *  leave/teardown path unconditionally. */
  function endOwnPreview() {
    if (!previewing) return;
    previewing = false;
    onstylepreviewend();
  }

  // ONE leave handler, on the toolbar ROOT rather than per button: moving between
  // neighbouring buttons fires the next one's pointerenter, which overwrites the
  // stage without a revert flickering in between. The GradientPresetPicker rule
  // ("pointerleave on the GRID, not each swatch"), applied to a button row.
  //
  // AND an unmount revert: this toolbar disappears the moment text edit exits or
  // the selection changes, which fires no pointerleave at all — the same reason
  // FontPicker and GradientPresetPicker both revert on teardown.
  $effect(() => () => endOwnPreview());

  // Keep focus in the editor: swallow mousedown on the toolbar chrome.
  function keepFocus(e) { e.preventDefault(); }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="text-format-toolbar"
  style:transform="scale({1 / boxScale})"
  onmousedown={keepFocus}
  onpointerleave={endOwnPreview}
>
  <Tooltip text="Bold (Cmd+B)">
    <button class="btn-icon" class:active={common.bold === true} aria-pressed={common.bold === true} aria-label="Bold" onpointerenter={() => previewToggle("bold")} onclick={() => toggle("bold")}>
      <iconify-icon icon="mdi:format-bold" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Italic (Cmd+I)">
    <button class="btn-icon" class:active={common.italic === true} aria-pressed={common.italic === true} aria-label="Italic" onpointerenter={() => previewToggle("italic")} onclick={() => toggle("italic")}>
      <iconify-icon icon="mdi:format-italic" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Underline (Cmd+U)">
    <button class="btn-icon" class:active={common.underline === true} aria-pressed={common.underline === true} aria-label="Underline" onpointerenter={() => previewToggle("underline")} onclick={() => toggle("underline")}>
      <iconify-icon icon="mdi:format-underline" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Strikethrough">
    <button class="btn-icon" class:active={common.strike === true} aria-pressed={common.strike === true} aria-label="Strikethrough" onpointerenter={() => previewToggle("strike")} onclick={() => toggle("strike")}>
      <iconify-icon icon="mdi:format-strikethrough" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>

  <span class="text-format-sep"></span>

  <!-- Paragraph ALIGN (Round 15.6): left/center/right applied to every paragraph
       the selection touches (onparastyle → applyParaStyle). The lit button
       reflects the common effective align (indeterminate → none lit). -->
  <Tooltip text="Align left">
    <button class="btn-icon" class:active={commonAlign === "left"} aria-pressed={commonAlign === "left"} aria-label="Align left" onclick={() => setAlign("left")}>
      <iconify-icon icon="mdi:format-align-left" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Align center">
    <button class="btn-icon" class:active={commonAlign === "center"} aria-pressed={commonAlign === "center"} aria-label="Align center" onclick={() => setAlign("center")}>
      <iconify-icon icon="mdi:format-align-center" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Align right">
    <button class="btn-icon" class:active={commonAlign === "right"} aria-pressed={commonAlign === "right"} aria-label="Align right" onclick={() => setAlign("right")}>
      <iconify-icon icon="mdi:format-align-right" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>

  <span class="text-format-sep"></span>

  <Tooltip text="Decrease size (Cmd+Minus)">
    <button class="btn-icon" aria-label="Decrease size" onpointerenter={() => previewStepSize(-SIZE_STEP)} onclick={() => stepSize(-SIZE_STEP)}>
      <iconify-icon icon="mdi:format-font-size-decrease" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <!-- THE SIZE READOUT IS A SCRUBBER (manifest R6-13.2: "a SCRUBBABLE number
       widget, draggable like any numeric value").
       WHY A BARE DraggableNumber AND NOT NumericField: NumericField's ƒ toggle
       would be a lie — a RUN size is not an equation slot (core/expressions.js
       never generates a text.runs.N.size path), and offering an escape hatch on a
       value that cannot hold one is the "control that looks like it does
       something" defect this round is REMOVING, not adding. The precedent for a
       bare scrubber outside the panels is app.css's material-knob rule and
       RenderCenterModal's form fields. No `step`: defaultValue supplies it
       (numberStep.defaultStep(36) = 1, i.e. whole px), and `min` is the same floor
       every size write already lands on.
       IT STAYS LIVE ON A MIXED SELECTION, which is the ONLY place the three verbs
       differ at all: on a uniform selection normalize, scale and step can all
       reach the same number, and the distinction is invisible.

       WHAT IT SHOWS WHEN SIZES DIFFER — a NUMBER (the SEED, i.e. the size at the
       selection start) with MIXED_MARK beside it, NOT the bare mark alone. The
       Inspector's mixed rows show "…" and nothing else, and that is right THERE
       because those rows have only two verbs (leave it, or unify to one typed
       value) so a number would only invite a misread. This control has THREE, and
       two of them are CONTINUOUS: a drag needs a number to be a ratio away from,
       and the user must be able to see what they are dragging from. A bare "…"
       would make the drag start from nothing visible and the readout jump on the
       first pixel. So: the mark says "these differ" (the app's ONE way of saying
       it, imported from core/multiselect rather than re-invented) and the number
       says "and this is the one you are moving relative to". The seed is the size
       at the selection START — core/multiselect.rowMixedState's own "defined
       starting point a gesture on a mixed row needs", and the exact value the
       keyboard path has always stepped from.

       THE NUMBER IS NOT A PROMISE THAT EVERY RUN IS IT: on a mixed selection only
       the TYPED verb sets the shown number onto everything, and typing is exactly
       the gesture where the user names a size. The other two move every run
       relative to its OWN size, and the tooltip says so. -->
  <Tooltip text={common.size != null
    ? `Font size ${common.size}px — drag to scrub, click to type, +/− to step`
    : `Sizes differ in the selection (${sizeSeed}px at the start). Type a number to make them ALL that size; drag to scale them all proportionally, keeping the differences; use +/− to add or subtract the same amount from each`}>
    <span class="text-format-size">
      <DraggableNumber
        label="Font size"
        value={sizeSeed}
        min={MIN_RUN_SIZE}
        defaultValue={DEFAULT_PARA_SIZE}
        suffix={common.size != null ? "" : MIXED_MARK}
        oninput={scrubSize}
        onchange={commitScrubSize}
      />
    </span>
  </Tooltip>
  <Tooltip text="Increase size (Cmd+Plus)">
    <button class="btn-icon" aria-label="Increase size" onpointerenter={() => previewStepSize(SIZE_STEP)} onclick={() => stepSize(SIZE_STEP)}>
      <iconify-icon icon="mdi:format-font-size-increase" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>

  <span class="text-format-sep"></span>

  <!-- Font family: self-rendering FontPicker — each option in its OWN typeface,
       a larger preview on hover (manifest #26). Includes uploaded font assets.
       The focused option also previews on the REAL CANVAS (onpreview), reverting
       when the picker closes; clicking commits through the same onstyle path as
       every other control, so a preview never becomes an edit by itself. -->
  <div class="text-format-font">
    <FontPicker
      options={fonts}
      value={common.font ?? "system"}
      onchange={(v) => onstyle({ font: v })}
      onpreview={previewFont}
      onpreviewend={onstylepreviewend}
    />
  </div>

  <span class="text-format-sep"></span>

  <!-- Color / Highlight / Outline: a swatch button opens an inline ColorPicker
       (the ColorField idiom). Each previews live via onstyle and commits when the
       overlay exits — the whole edit is one undo unit. -->
  <Tooltip text="Font color">
    <button class="btn-icon" aria-label="Font color" onclick={() => openPicker = openPicker === "color" ? null : "color"}>
      <span class="text-format-swatch" style:background={common.color ?? "#000"}></span>
      <iconify-icon icon="mdi:format-color-text" width="14" height="14"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Highlight color">
    <button class="btn-icon" aria-label="Highlight" onclick={() => openPicker = openPicker === "highlight" ? null : "highlight"}>
      <span class="text-format-swatch" style:background={common.highlight || "transparent"}></span>
      <iconify-icon icon="mdi:marker" width="14" height="14"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Outline (glyph stroke)">
    <button class="btn-icon" class:active={(common.outlineWidth ?? 0) > 0} aria-label="Outline" onclick={() => openPicker = openPicker === "outline" ? null : "outline"}>
      <iconify-icon icon="mdi:format-color-highlight" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>

  {#if openPicker === "color"}
    <div class="text-format-popover">
      <ColorPicker value={common.color ?? "#000000"} label="Font color" oninput={(v) => onstyle({ color: v })} onchange={(v) => onstyle({ color: v })} />
    </div>
  {:else if openPicker === "highlight"}
    <div class="text-format-popover">
      <ColorPicker value={common.highlight || "#ffff00"} label="Highlight" oninput={(v) => onstyle({ highlight: v })} onchange={(v) => onstyle({ highlight: v })} />
      <button class="btn" onmousedown={(e) => e.preventDefault()} onclick={() => onstyle({ highlight: "" })}>Clear highlight</button>
    </div>
  {:else if openPicker === "outline"}
    <div class="text-format-popover">
      <ColorPicker value={common.outlineColor ?? "#000000"} label="Outline color" oninput={(v) => onstyle({ outlineColor: v, outlineWidth: (common.outlineWidth ?? 0) > 0 ? common.outlineWidth : DEFAULT_OUTLINE_W })} onchange={(v) => onstyle({ outlineColor: v, outlineWidth: (common.outlineWidth ?? 0) > 0 ? common.outlineWidth : DEFAULT_OUTLINE_W })} />
      <label class="text-format-range">
        Width
        <input type="range" min={OUTLINE_W_MIN} max={OUTLINE_W_MAX} step={OUTLINE_W_STEP} value={common.outlineWidth ?? 0} onmousedown={(e) => e.preventDefault()} oninput={(e) => onstyle({ outlineWidth: +e.currentTarget.value })} />
      </label>
    </div>
  {/if}
</div>

<script module>
  // Default outline width when enabling outline via the color popover with no
  // width yet set (a sensible visible stroke; the user tunes it with the slider).
  const DEFAULT_OUTLINE_W = 1.5;

  // The outline-width slider's range, named because three bare literals in the
  // markup answered none of "why 6?" or "why halves?". OUTLINE_W_MIN is 0 because
  // 0 IS the off sentinel (core/richtext.runFrom), so the slider can turn the
  // outline off without a second control. OUTLINE_W_MAX is DEFAULT_OUTLINE_W ×
  // FOUR — the slider's job is to tune around the default, not to reach every
  // representable width, and a run may still carry any value (the per-run state
  // is unbounded; only this control's convenient range is). OUTLINE_W_STEP is a
  // HALF-px grid, so the span is twelve notches, which a native range thumb can
  // actually land on individually. Both are the values this slider shipped with
  // and are FLAGGED PENDING RATIFICATION, the same disposition core/richtext.js
  // gives its decoration-geometry fractions: named and justified here rather than
  // left as bare literals in the markup, but not derived from a precedent.
  const OUTLINE_W_MIN = 0;
  const OUTLINE_W_MAX = DEFAULT_OUTLINE_W * 4;
  const OUTLINE_W_STEP = 0.5;

  /**
   * Pure function. The run-style delta a boolean control would WRITE — the single
   * source of that answer, so a control's hover preview and its click commit
   * cannot disagree about what the control does. Two hand-written copies of
   * "invert this key" is exactly how a preview starts showing something the click
   * does not do.
   *
   * @param {Object} common - the selection's common style values (undefined = mixed)
   * @param {string} key - a boolean run-style key ("bold", "italic", …)
   * @returns {Object} a one-key run-style delta
   *
   * @example
   * // The selection is entirely bold, so the control turns bold OFF:
   * toggleDelta({ bold: true }, "bold") // => { bold: false }
   * @example
   * // Not bold, or MIXED (undefined) — either way the control turns it ON, the
   * // PowerPoint convention for an indeterminate toggle.
   * toggleDelta({ bold: false }, "bold")     // => { bold: true }
   * @example toggleDelta({ bold: undefined }, "bold") // => { bold: true }
   */
  export function toggleDelta(common, key) {
    return { [key]: common[key] === true ? false : true };
  }

  /**
   * Pure function. The PROPORTIONAL verb's multiplier for a drag that started at
   * `seed` and has reached `next` — the whole-gesture ratio, which is the ONE
   * expression of "ratio from start, never from the last frame".
   *
   * WHY IT IS ITS OWN NAMED FUNCTION rather than a `next / sizeSeed` inline: it is
   * where the DEGENERATE SEED is answered, and that answer needs stating. A seed
   * of 0 (or negative, or non-finite) would make the ratio ±∞ or NaN, which
   * scaleRunSize refuses LOUDLY — correctly, since dividing by it is meaningless.
   * But a seed of 0 is not a bug to throw on HERE: it is what the readout shows
   * before a real size is known, and the honest multiplier from "no size" is 1
   * (leave the runs alone) rather than a crash on a gesture the user made in good
   * faith. So the guard returns the identity, and the LOUD refusal stays in the
   * primitive, where a genuinely bad factor computed some other way still hits it.
   *
   * @param {number} next - the value the readout shows now
   * @param {number} seed - the value it showed when the drag began
   * @returns {number} the multiplier to apply to every covered run's size
   *
   * @example
   * // A drag from 12 up to 18 scales everything by 1.5 — so a selection holding
   * // 12 and 24 becomes 18 and 36, and the 1:2 ratio is exactly preserved.
   * dragFactor(18, 12) // 1.5
   * @example dragFactor(24, 48) // 0.5  (dragging down halves every run)
   * @example dragFactor(36, 36) // 1  (no movement — identity)
   * @example dragFactor(20, 0) // 1  (degenerate seed → identity, never Infinity)
   */
  export function dragFactor(next, seed) {
    if (!Number.isFinite(seed) || seed <= 0) return 1;
    return next / seed;
  }

  // THERE IS NO sizeDelta HERE ANY MORE, on purpose. It returned ONE ABSOLUTE
  // {size: n} built from the selection's common size, which applyRunStyle then
  // spread over every covered run — so a mixed 48+18 selection collapsed to a
  // single run at the fallback ±2, destroying the boundary, and it disagreed with
  // the keyboard path that computed its fallback differently (38 vs 50, measured).
  // The relative primitive core/richtext.adjustRunSize replaced it, reached
  // through the controller's ONE stepSize via onsizestep/onsizesteppreview.
</script>
