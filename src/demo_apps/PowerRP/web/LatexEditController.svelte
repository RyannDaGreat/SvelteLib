<!--
  LatexEditController — WYSIWYG in-place LaTeX equation editing via a MathLive
  `<math-field>` DOM overlay mounted at the widget's world pose.

  WHY THIS DIFFERS FROM TextEditController (the deliberate divergence):
    Text is CANVAS-AS-TRUTH — Skia keeps drawing the glyphs and the caret is
    self-drawn from the SAME CanvasKit Paragraph, so there is no double image and
    no exit jump. That is IMPOSSIBLE for math: the static render is MathJax
    (tex-svg), which exposes NO caret/cursor model to self-draw from. A math caret
    only exists inside a structural editor (MathLive/MathQuill), so the editor's
    OWN glyphs must be visible — which forces an OVERLAY-during-edit design where
    the canvas equation is SUPPRESSED (CanvasView paint filter) and this DOM field
    is the only visible equation. MathLive owns the caret, selection, and
    structural navigation entirely — we author none of it (a simplification).

  THE IRREDUCIBLE POP (honest): MathLive renders with the KaTeX webfonts; the
  canvas renders with MathJax's tex-svg glyphs. Both are Computer-Modern lineage
  → visually close, but not metric-identical. So a small enter/exit glyph "pop" is
  unavoidable with this two-engine overlay approach. It is minimized by matching
  size (font-size = the widget's em)/pose (world transform)/color (ink), and the
  `closing` CROSSFADE (app.commitLatexEdit un-suppresses the canvas render BENEATH
  this field, which then fades out) masks it as much as this design allows.

  LIFECYCLE (mirrors the text seams on app.svelte.js):
    beginLatexEdit → mount here → previewLatexValue (every input, stages the
    string; does NOT re-typeset the canvas — the field IS the visible math) →
    Escape / click-away → commitLatexEdit (one undo unit) → closing crossfade →
    finishLatexEdit (unmount). Invalid LaTeX is LOUD, not silent: MathLive shows
    its own inline error while editing, and on commit the canvas emit()'s
    latexErrorFor path draws the red error affordance — never a blank widget.

  Styling lives in app.css (.latex-edit-*; app convention: no <style>). The root
  keeps `.latex-edit-overlay-root` so App.svelte's click-away dismissal
  (`.closest(".latex-edit-overlay-root")`) treats clicks inside the field as
  in-editor, not click-away.
-->
<script>
  import * as T from "../core/transform.js";
  import { fitBox } from "../core/geometry.js";
  import { DEFAULT_FONT_SIZE } from "../plugins/latex.js";
  import { LATEX_DEFAULT_INK } from "../render_gpu/gpu/latex_raster.js";
  import "./latexEditor.js"; // registers <math-field> + offline fonts (also pre-warmed at boot by CanvasView)

  // app = the app store; node = the edited item's derived render node (preview-
  // blended); worldToScreen = the PanZoom camera map (render-area frame); zoom =
  // viewport.zoom. No `gpu`/`screenToWorld` (MathLive owns layout + pointer).
  let { app, node, worldToScreen, zoom } = $props();

  // Crossfade duration for enter (fade-in) and exit (the `closing` fade-out).
  // MUST equal --a-latex-edit-crossfade in app.css (JS drives the unmount timer;
  // CSS drives the opacity transition — they must agree or the field unmounts
  // mid-fade). Kept in the codebase's cross-file "MUST equal" convention.
  const CROSSFADE_MS = 140;

  let fieldEl = $state(null); // the <math-field> element
  let shown = $state(false);  // opacity gate: false→true fades in; true→false (on close) fades out
  let seeded = false;         // one-shot mount guard (non-reactive)
  let natW = $state(0);       // the field's NATURAL (layout, pre-scale) content size in LOCAL px —
  let natH = $state(0);       // measured live (fonts load async; equation grows as you type)

  // Root box: the item's world top-left in the render-area frame + the local→
  // screen scale (zoom·world.scale) + rotation. Identical to TextEditController's
  // `box` so the field lands exactly where the canvas equation drew.
  let box = $derived.by(() => {
    const p = T.apply(node.world, 0, 0);
    const sc = worldToScreen(p.x, p.y);
    return {
      x: sc.x, y: sc.y,
      w: node.state.w ?? 0, h: node.state.h ?? 0,
      scale: zoom * (node.world.scale ?? 1),
      deg: (node.world.rotation ?? 0) * 180 / Math.PI,
    };
  });

  // The em size (LOCAL px) and glyph color. font-size sets the field's PRE-scale
  // natural size close to the box so the fill scale stays near 1 (crisp subpixel).
  let fontSize = $derived(node.state.fontSize ?? DEFAULT_FONT_SIZE);
  let ink = $derived(node.state.ink ?? LATEX_DEFAULT_INK);

  // RENDER-MATCH scale — the field must map its tight ink onto the widget box the
  // SAME way the canvas maps the MathJax viewBox (plugins/latex.js + the backends'
  // drawLatexVector), or it appears a different size/shape (the dominant "pop").
  //   • preserveAspect (default): UNIFORM scale-to-FIT + center — the SAME fitBox
  //     helper the canvas uses, so both letterbox identically.
  //   • else: non-uniform box→box stretch (matches the legacy fill path).
  // natW/natH are the field's live tight ink size (measured below); the fill
  // converges in one step (measurement divides out the applied scale).
  let fill = $derived.by(() => {
    if (!(natW > 0) || !(natH > 0)) return { sx: 1, sy: 1, ox: 0, oy: 0 };
    if (node.state.preserveAspect !== false) {
      const f = fitBox(natW, natH, box.w, box.h);
      return { sx: f.scale, sy: f.scale, ox: f.offsetX, oy: f.offsetY };
    }
    return { sx: box.w / natW, sy: box.h / natH, ox: 0, oy: 0 };
  });

  /** Command. Stages the live field value into the preview (Inspector reflects,
   * commit keyframes it). The canvas equation is suppressed, so this never
   * re-typesets the canvas per keystroke — MathJax runs once, on commit. */
  function onInput() {
    if (fieldEl) app.previewLatexValue(fieldEl.value);
  }

  /** Command. Escape COMMITS (one undo unit) — the "done editing" gesture,
   * mirroring text. Enter is left to MathLive (it inserts rows in matrix/cases
   * environments); click-away commits via App.svelte's capture handler. */
  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      app.dismissLatexEdit();
    }
  }

  // Seed + focus ONCE on mount, then fade in. setValue is silenced so seeding
  // does not fire a spurious input/preview. The value is NEVER re-synced from
  // `node` afterward — during the edit MathLive is the source of truth (re-
  // writing it would fight the user's typing and reset the caret).
  $effect(() => {
    if (!fieldEl || seeded) return;
    seeded = true;
    fieldEl.mathVirtualKeyboardPolicy = "manual"; // desktop editor — never auto-pop the virtual keyboard
    fieldEl.setValue(node.state.latex ?? "", { silenceNotifications: true });
    fieldEl.focus();
    requestAnimationFrame(() => { shown = true; }); // fade IN one frame after mount
  });

  // Measure the field's TIGHT INK size (natW/natH, LOCAL px) — the union of the
  // rendered glyph leaves — NOT the content box, whose height includes KaTeX
  // line-box leading that MathJax's viewBox omits (measuring the box under-fills
  // ~30% vertically). MathJax maps a TIGHT viewBox → the widget box, so matching
  // it means filling the widget box with the editor's tight ink.
  //
  // Self-normalizing: each glyph leaf's getBoundingClientRect is in SCREEN px
  // (already scaled by the root's box.scale AND the field's current fill
  // transform); dividing the union by the total applied scale (read back as
  // contentRect / content.offset* — offset* is pre-transform layout) recovers the
  // ink size in LOCAL units regardless of the scale currently applied, so the
  // fill converges in one step with no feedback loop. Fires via ResizeObserver on
  // layout changes (typing, async font load); the fill transform never relayouts.
  $effect(() => {
    if (!fieldEl) return;
    const measure = () => {
      const content = fieldEl.shadowRoot?.querySelector('[part="content"]');
      if (!content || !content.offsetWidth || !content.offsetHeight) {
        natW = fieldEl.offsetWidth;
        natH = fieldEl.offsetHeight;
        return;
      }
      const cr = content.getBoundingClientRect();
      const appliedSx = cr.width / content.offsetWidth;   // = box.scale · fill.sx (total applied)
      const appliedSy = cr.height / content.offsetHeight; // = box.scale · fill.sy
      let top = Infinity, bot = -Infinity, left = Infinity, right = -Infinity;
      for (const el of content.querySelectorAll("*")) {
        if (el.firstElementChild) continue; // glyph LEAVES only (skip layout wrappers/struts)
        const r = el.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) continue; // skip zero-size struts/caret
        if (r.top < top) top = r.top;
        if (r.bottom > bot) bot = r.bottom;
        if (r.left < left) left = r.left;
        if (r.right > right) right = r.right;
      }
      if (bot > top && right > left && appliedSx > 0 && appliedSy > 0) {
        natW = (right - left) / appliedSx; // screen ink → LOCAL ink (divide out the applied scale)
        natH = (bot - top) / appliedSy;
      } else {
        natW = content.offsetWidth;
        natH = content.offsetHeight;
      }
    };
    const content = fieldEl.shadowRoot?.querySelector('[part="content"]');
    const ro = new ResizeObserver(measure);
    ro.observe(content ?? fieldEl); // content relayouts on typing/font-load
    measure();
    return () => ro.disconnect();
  });

  // CLOSING crossfade: commitLatexEdit sets latexEditing.closing, which un-
  // suppresses the canvas equation (paint stops skipping it) AND keeps this field
  // mounted. Fade this field out over the same duration, then unmount.
  $effect(() => {
    if (!app.latexEditing?.closing) return;
    shown = false;
    const t = setTimeout(() => app.finishLatexEdit(), CROSSFADE_MS);
    return () => clearTimeout(t);
  });

  // Dev/test seam (mirrors window.__powerrp_textEdit). Headless probes drive the
  // REAL field: read/replace the LaTeX and commit. Cleared on unmount.
  $effect(() => {
    window.__powerrp_latexEdit = {
      getValue: () => fieldEl?.value ?? "",
      setValue: (v) => { if (fieldEl) { fieldEl.setValue(v); app.previewLatexValue(fieldEl.value); } },
      commit: () => app.dismissLatexEdit(),
      box: () => ({ ...box }),
    };
    return () => { if (window.__powerrp_latexEdit) delete window.__powerrp_latexEdit; };
  });
</script>

<!-- Root at the item's world top-left (render-area frame), carrying the item's
     world rotation + scale so the field renders in the item's pose. Keeps the
     `.latex-edit-overlay-root` class for App.svelte's click-away guard. -->
<div
  class="latex-edit-overlay-root"
  style:left="{box.x}px"
  style:top="{box.y}px"
  style:transform="rotate({box.deg}deg) scale({box.scale})"
>
  <!-- Fade layer = the widget box (LOCAL units). The field is absolutely pinned
       to its top-left and scaled to FILL it (box-fill, matching the canvas's
       non-uniform box→box scale). Crossfades opacity on enter/exit. -->
  <div
    class="latex-edit-fade"
    class:latex-edit-shown={shown}
    style:width="{box.w}px"
    style:height="{box.h}px"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <math-field
      class="latex-edit-field"
      bind:this={fieldEl}
      style:font-size="{fontSize}px"
      style:color={ink}
      style:--caret-color={ink}
      style:--selection-color={ink}
      style:transform="translate({fill.ox}px, {fill.oy}px) scale({fill.sx}, {fill.sy})"
      oninput={onInput}
      onkeydown={onKeydown}
    ></math-field>
  </div>
</div>
