/**
 * Text widget. Text is RICH TEXT (manifest "RICH TEXT"): a {runs, paras} value
 * of styled runs (bold/italic/underline/strike/size/font/color per run) over
 * paragraphs (align/lineSpacing/charSpacing/wordSpacing). The box is a REAL box
 * (manifest "Text boxes are REAL boxes"): resizable handles + word wrap within w.
 *
 * emit() stays PURE: it produces ONE rich text IR op carrying the runs + the box
 * width; each render backend runs the SHARED pure layout (core/richtext.js) with
 * its own metric seam — one layout, two backends (the parity lever). No layout
 * happens here (emit has no font metrics; it is DOM-free).
 *
 * Run-level content/style EDITING is SET-2 (the in-canvas cursor editor +
 * floating PPT toolbar); this file builds the MODEL + para/box Inspector rows.
 * Legacy plain-string `text` values migrate to runs LOUDLY at load
 * (core/richtext.withRichTextMigrated, wired in the app repair path).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults } from "../core/properties.js";
import { normalizeRichText, richTextIsEmpty } from "../core/richtext.js";
import { text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

export const textPlugin = {
  type: "text",
  title: "Text",
  // resizable:true → CanvasView shows the standard 8 resize handles (same
  // machinery as rect — capabilities.bbox && capabilities.resizable; NO special
  // case). w/h are real box dimensions; w constrains word wrap.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this text box currently a GHOST (manifest 13.6
   * CONDITIONAL GHOSTS: "same with text")? STATE-dependent, not
   * capabilities.ghost — a text box is only a ghost while its rich value has
   * no visible characters (core/richtext.richTextIsEmpty is the canonical
   * "no visible characters" predicate, shared with any other empty-text
   * consumer); core/derive.isGhostNode calls this hook to grant the
   * dashed-outline/findable-when-Show-Ghosts affordance exactly while the box
   * would otherwise render nothing.
   *
   * @example textPlugin.isGhost({ text: { runs: [{ text: "" }], paras: [{}] } })
   * true
   * @example textPlugin.isGhost({ text: { runs: [{ text: "Text" }], paras: [{}] } })
   * false
   */
  isGhost(state) {
    return richTextIsEmpty(state.text);
  },
  defaults: {
    type: "text", x: 120, y: 80, w: 260, h: 48, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `text` is the RICH-TEXT value {runs, paras} (core/richtext.js). The DEFAULT
    // is the canonical rich shape (one run "Text") — NOT a bare string — so it
    // shares the delta-leaf structure of every rich instance: both fold to the
    // two leaves `text.runs` and `text.paras` (arrays are leaf values to the
    // delta walker, so the run COUNT never matters), which means
    // document.missingDefaults NEVER mis-flags a rich instance as "missing text"
    // and clobbers it. A LEGACY plain-STRING `text` (old docs / hand-written /
    // make_demo) migrates to this shape LOUDLY at load via
    // core/richtext.withRichTextMigrated (wired in the app repair path); emit()
    // also tolerates an in-memory string on the fly (normalizeRichText).
    // outlineColor/outlineWidth/highlight (Round 13.4) default OFF: no glyph
    // outline (width 0), no highlight background ("" sentinel). Old docs without
    // these keys get the same off defaults via core/richtext.runFrom.
    text: { runs: [{ text: "Text", bold: false, italic: false, underline: false, strike: false, size: 36, font: DEFAULT_FONT, color: "#1a1a2e", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] },
    // Widget-level style the single migrated run inherits AND the per-paragraph
    // layout falls back to (font/size/color/bold are run-inherited; the para
    // keys below are the box's one-alignment-per-box defaults — SET-1 Inspector).
    size: 36, color: "#1a1a2e", bold: false, font: DEFAULT_FONT, opacity: 1,
    // Paragraph-level defaults for the whole box (each paragraph may override in
    // paras[i] via the SET-2 UX). align ∈ left|center|right|justify.
    align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0,
    // VERTICAL alignment of the whole line stack within the box height h
    // (Round 15.6). BOX-level (not per-paragraph, unlike `align`): top|middle|
    // bottom. Default "top" reproduces the historical top-anchored layout
    // exactly, so old docs render byte-identically (core/richtext.valignOffset
    // returns 0 for "top"). A plain-string leaf → repair's missingDefaults
    // fills it with "top" on old text items (no render change).
    valign: "top",
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // `category` groups rows into the Inspector's collapsible accordion regions.
  // NO `text` CONTENT row: rich content/run-style editing is the SET-2 in-canvas
  // editor + floating PPT toolbar (and the SET-2 dblclick stopgap); a plain text
  // input here can't represent runs and would clobber them. SET-1 exposes the
  // box/paragraph props only (the MODEL already supports per-run style).
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" },
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" },
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    // Default typography for the box (runs inherit these; SET-2 sets them per-run).
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text" },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text" },
    { key: "bold", label: "Bold", kind: "checkbox", category: "text" },
    // Paragraph props (box-level; the "one alignment per box" control — SET-2
    // adds per-paragraph). align is a select over the four alignments.
    { key: "align", label: "Align", kind: "select", options: ["left", "center", "right", "justify"], optionLabels: { left: "Left", center: "Center", right: "Right", justify: "Justify" }, category: "text" },
    // VERTICAL alignment is BOX-level (one value per box — the whole line stack
    // moves within h), so a single select row is the right control (unlike the
    // per-paragraph horizontal `align`, whose primary surface is the WYSIWYG
    // toolbar; this box-level valign has no toolbar equivalent). Round 15.6.
    { key: "valign", label: "V-Align", kind: "select", options: ["top", "middle", "bottom"], optionLabels: { top: "Top", middle: "Middle", bottom: "Bottom" }, category: "text" },
    { key: "lineSpacing", label: "Line spacing", kind: "number", min: 0, category: "text" },
    { key: "charSpacing", label: "Char spacing", kind: "number", category: "text" },
    { key: "wordSpacing", label: "Word spacing", kind: "number", category: "text" },
    { key: "color", label: "Color", kind: "color", category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → ONE rich text IR op (local space, top-left origin).
   * Carries the canonical rich value + the box width (wrap) + widget-level
   * paragraph defaults; the backend lays it out. `text`/`size`/`color`/`font`
   * also carry a plain-text fallback (richTextToPlain-ish via the first run) so
   * a backend that can't lay out still draws SOMETHING (never a silent blank).
   * Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE,
   * render_gpu/effects.js) wrap the op; all-off = pass-through. The shadow is
   * the glyphs' own blurred silhouette (per-letter, not the box) since the
   * effect texture holds exactly what the widget painted.
   */
  emit(s, _targetWorldIR, world) {
    // GHOST short-circuit (manifest 13.6 CONDITIONAL GHOSTS): an empty text box
    // (no visible characters) draws NOTHING — same as filmstrip's empty-frames
    // case. Without this the box is a ghost in the EDITOR (isGhost above) but
    // still emits a zero-ink text op into the PRESENTATION/export render, which
    // is the asymmetry the ghost model forbids: a ghost has no rendered volume
    // in ANY backend. Returning [] here makes editor-ghostness and render-
    // exclusion agree (the assertion SonnetE's ghost_test locks).
    if (richTextIsEmpty(s.text)) return [];
    const inherited = { font: s.font ?? DEFAULT_FONT, size: s.size ?? 36, color: s.color ?? "#000000", bold: s.bold ?? false };
    const rich = normalizeRichText(s.text, inherited);
    const first = rich.runs[0] ?? {};
    return applyEffects([text({
      // plain-text fallback (single-run degrade): the first run's text/style
      text: first.text ?? "",
      x: 0, y: 0,
      size: first.size ?? inherited.size,
      color: first.color ?? inherited.color,
      bold: first.bold ?? inherited.bold,
      font: first.font ?? inherited.font,
      opacity: s.opacity ?? 1,
      // the rich payload the backend actually lays out:
      rich,
      boxW: (s.w ?? 0) > 0 ? s.w : Infinity, // wrap to the box width; 0/absent ⇒ no wrap
      boxH: (s.h ?? 0) > 0 ? s.h : Infinity, // box height ⇒ VERTICAL align room (Round 15.6)
      // boxStyle carries the box-level paragraph defaults + the box-level valign
      // (top|middle|bottom) that layoutRichText offsets the line stack by.
      boxStyle: { align: s.align ?? "left", lineSpacing: s.lineSpacing ?? 1, charSpacing: s.charSpacing ?? 0, wordSpacing: s.wordSpacing ?? 0, valign: s.valign ?? "top" },
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-text", title: "Add Text", icon: "mdi:format-text", run: (app) => app.armCrosshairPlacement(textPlugin) },
  ],
};
