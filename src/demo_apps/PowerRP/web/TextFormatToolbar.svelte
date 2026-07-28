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

  function toggle(key) { onstyle({ [key]: common[key] === true ? false : true }); }
  function stepSize(delta) {
    const base = common.size ?? 36;
    onstyle({ size: Math.max(1, base + delta) });
  }
  // Keep focus in the editor: swallow mousedown on the toolbar chrome.
  function keepFocus(e) { e.preventDefault(); }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="text-format-toolbar"
  style:transform="scale({1 / boxScale})"
  onmousedown={keepFocus}
>
  <Tooltip text="Bold (Cmd+B)">
    <button class="btn-icon" class:active={common.bold === true} aria-pressed={common.bold === true} aria-label="Bold" onclick={() => toggle("bold")}>
      <iconify-icon icon="mdi:format-bold" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Italic (Cmd+I)">
    <button class="btn-icon" class:active={common.italic === true} aria-pressed={common.italic === true} aria-label="Italic" onclick={() => toggle("italic")}>
      <iconify-icon icon="mdi:format-italic" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Underline (Cmd+U)">
    <button class="btn-icon" class:active={common.underline === true} aria-pressed={common.underline === true} aria-label="Underline" onclick={() => toggle("underline")}>
      <iconify-icon icon="mdi:format-underline" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip text="Strikethrough">
    <button class="btn-icon" class:active={common.strike === true} aria-pressed={common.strike === true} aria-label="Strikethrough" onclick={() => toggle("strike")}>
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
    <button class="btn-icon" aria-label="Decrease size" onclick={() => stepSize(-SIZE_STEP)}>
      <iconify-icon icon="mdi:format-font-size-decrease" width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <span class="text-format-size">{common.size ?? "—"}</span>
  <Tooltip text="Increase size (Cmd+Plus)">
    <button class="btn-icon" aria-label="Increase size" onclick={() => stepSize(SIZE_STEP)}>
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
      onpreview={(v) => onstylepreview({ font: v })}
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
</script>
