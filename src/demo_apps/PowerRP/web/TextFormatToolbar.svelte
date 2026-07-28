<!--
  TextFormatToolbar — the floating PowerPoint-style format toolbar that hovers
  ABOVE the text box being edited (Round 13.4; manifest "WHILE EDITING, a toolbar
  LIKE THAT floats SOMEWHERE ABOVE the text being edited"). It applies character
  style to the CURRENT SELECTION of the TextEditOverlay via the `onstyle` callback
  (core/richtext.applyRunStyle under the hood) — one preview per action, committed
  as ONE undo unit when editing exits.

  Controls (the PPT target subset built now): Bold · Italic · Underline ·
  Strikethrough · font-size stepper · font family · font Color · text HIGHLIGHT ·
  glyph OUTLINE (color + width) · paragraph ALIGN left/center/right (Round 15.6).
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
  import FontPicker from "./FontPicker.svelte";
  import ColorPicker from "../../../lib/ColorPicker.svelte";
  import { commonStyle, paragraphRanges, paraStyleFor } from "../core/richtext.js";
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
  let { app, boxScale, onstyle, onstylepreview, onstylepreviewend, selRange, runsAt, onparastyle, parasAt, boxAlign } = $props();

  // Which inline color popover is open (font | highlight | outline | null).
  let openPicker = $state(null);

  const SIZE_STEP = 2; // px per +/- (matches the overlay's Cmd+/- step)

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
  function stepSize(delta) { previewing = false; onstyle(sizeDelta(common.size, delta, DEFAULT_SIZE)); }
  function previewStepSize(delta) { previewing = true; onstylepreview(sizeDelta(common.size, delta, DEFAULT_SIZE)); }

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
  <!-- The readout's "—" is the INDETERMINATE state (the selection spans more than
       one size), which nothing on screen said. The stepper still works on it: it
       steps from DEFAULT_SIZE, which is what the tip promises. -->
  <Tooltip text={common.size != null ? `${common.size}px` : `Mixed sizes in the selection — the steppers work from ${DEFAULT_SIZE}px`}>
    <span class="text-format-size">{common.size ?? "—"}</span>
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
        <input type="range" min="0" max="6" step="0.5" value={common.outlineWidth ?? 0} onmousedown={(e) => e.preventDefault()} oninput={(e) => onstyle({ outlineWidth: +e.currentTarget.value })} />
      </label>
    </div>
  {/if}
</div>

<script module>
  // Default outline width when enabling outline via the color popover with no
  // width yet set (a sensible visible stroke; the user tunes it with the slider).
  const DEFAULT_OUTLINE_W = 1.5;

  // The size a stepper counts from when the selection has NO common size (mixed
  // runs, or a run that never set one). Matches the text plugin's own default so
  // stepping an unset selection lands where the unstepped text already renders.
  const DEFAULT_SIZE = 36;

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
   * Pure function. The run-style delta a size stepper would write: the common
   * size nudged by `delta`, floored at 1px so repeated shrinking can never reach
   * 0. `fallback` stands in when the selection has no common size.
   *
   * @param {number|undefined} size - the selection's common size, or undefined when mixed
   * @param {number} delta - px to add (negative to shrink)
   * @param {number} fallback - size to step from when `size` is undefined
   * @returns {{size:number}}
   *
   * @example sizeDelta(36, 2, 36)  // => { size: 38 }
   * @example sizeDelta(36, -2, 36) // => { size: 34 }
   * @example
   * // Mixed sizes step from the fallback, so the control still does something:
   * sizeDelta(undefined, 2, 36) // => { size: 38 }
   * @example sizeDelta(2, -2, 36) // => { size: 1 }  (floored, never 0)
   */
  export function sizeDelta(size, delta, fallback) {
    return { size: Math.max(1, (size ?? fallback) + delta) };
  }
</script>
