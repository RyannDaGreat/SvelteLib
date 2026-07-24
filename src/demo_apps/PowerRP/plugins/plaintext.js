/**
 * PLAINTEXT widget — a lightweight SINGLE-STRING text box, deliberately DISTINCT
 * from the rich-text widget (plugins/text.js). Where the rich widget stores a
 * {runs, paras} structure and edits per-run style through a floating format bar,
 * this widget stores ONE plain `text` STRING and exposes its styling as ORDINARY
 * Inspector property rows (font / size / bold / colour / align / valign) — no
 * floating bar, no runs. It is the "just some text" primitive: a caption, a
 * label, or an equation-bound readout.
 *
 * ── EQUATION-BINDABLE STRING (no engine change) ───────────────────────────────
 * `text` is a normal item-state leaf, so it rides the UNIVERSAL `=` marker
 * (core/expressions.js): typing `=` in its Inspector field turns it into an
 * equation evaluated up-front by the derive/evaluate path, exactly like every
 * other property. emit() therefore receives the ALREADY-resolved value in `s`
 * and never touches the evaluator. A non-string equation result (e.g. binding
 * the text to a computed number) is coerced with String() so a bound readout
 * displays its value rather than crashing the text() builder (which demands a
 * string) — a sensible coercion, NOT a silent swallow.
 *
 * ── STYLING = SHARED REGISTRY, one text() op ──────────────────────────────────
 * It composes the SHARED PROPERTY REGISTRY like rect.js: the positioning bundle,
 * opacity, and the effects bundle (shadow/bloom/blend). The ink colour reuses the
 * registry's PAINT-capable `fill` prop (relabelled "Color"), so a solid colour
 * OR a linear/radial gradient paints the glyphs for free — the text() IR op runs
 * `color` through parsePaint. emit() builds exactly ONE existing ir.js text() op
 * (a LEGACY single-run op — no `rich` payload) from the single string + style
 * props, carrying `boxStyle` {align, valign} + boxW/boxH so the renderer's shared
 * layout aligns/wraps it (the Skia backend wraps a legacy op via singleRunRich).
 * No new IR op; no plugin imports another.
 *
 * ── GHOST-ON-EMPTY ────────────────────────────────────────────────────────────
 * A blank/whitespace-only string is an EXPECTED "nothing typed yet" state (the
 * mermaid/qr convention), not a failure: emit() returns [] and isGhost() grants
 * the dashed-outline/findable affordance, so an empty plaintext draws nothing and
 * never crashes.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// The app's default text size, in canvas units — matches plugins/text.js's 36u
// default so a plaintext box and a rich-text box read at the same size out of the
// box (one shared convention, not a fresh per-widget number).
const DEFAULT_TEXT_SIZE = 36;

// The four horizontal + three vertical alignment options (with human labels),
// mirroring plugins/text.js's box/paragraph alignment controls. valign moves the
// whole line stack within the box height h (core/richtext.valignOffset).
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };

/**
 * Pure function. Is a plaintext value EMPTY — blank, whitespace-only, or
 * absent, so there is nothing to draw yet? The ONE canonical predicate driving
 * BOTH the ghost hook and emit()'s short-circuit (the mermaid/qr ghost
 * convention). An empty string is an EXPECTED state (a freshly-added box, or one
 * the user cleared), NOT a failure. A non-string value (an equation result) is
 * coerced with String() first so a bound numeric readout is never mis-flagged
 * as empty.
 *
 * @param {*} value - the text leaf (string, or an equation-resolved value)
 * @returns {boolean}
 *
 * @example plaintextIsEmpty("")        // true
 * @example plaintextIsEmpty("   ")     // true (whitespace-only — nothing to draw)
 * @example plaintextIsEmpty(null)      // true
 * @example plaintextIsEmpty("Hello")   // false
 * @example plaintextIsEmpty(0)         // false (a bound number renders as "0")
 */
export function plaintextIsEmpty(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

export const plaintextPlugin = {
  type: "plaintext",
  title: "Plain Text",
  // resizable:true → the standard 8 resize handles (same machinery as rect/text);
  // w constrains word-wrap, h gives the vertical-align stack its room.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // ── INLINE WYSIWYG EDITING (opt-in; REUSES the rich text widget's editor) ─────
  // Double-clicking a plaintext box on the canvas enters the SAME Skia-owned
  // in-place editor the rich text widget uses (web/TextEditController), but in
  // PLAIN-STRING mode: it edits this widget's single `text` string directly (no
  // {runs, paras}, NO floating format toolbar), committing the typed string as a
  // keyframed change on the current slide — the box updates live per keystroke.
  // CanvasView.onDblClick reads THIS descriptor to route the gesture (declarative
  // opt-in, so any future single-string widget gets the editor by declaring it);
  // the controller reads `plain` to flatten its rich editing model to a plain
  // string at the stored-value boundary. An `=` equation-bound `text` is NOT
  // opened this way (in-place editing would overwrite the equation with its
  // computed value) — beginTextEdit no-ops it and routes the user to the
  // Inspector's equation field (the mermaid/codeblock "equations live in the
  // Inspector" precedent). `property` names WHICH string leaf the editor binds.
  inlineTextEdit: { property: "text", plain: true },
  /**
   * Pure function. Is this box currently a GHOST? STATE-dependent — a plaintext
   * box is a ghost only while its string is empty/blank (plaintextIsEmpty, shared
   * with emit()'s short-circuit); core/derive.isGhostNode calls this to grant the
   * dashed-outline/findable-when-Show-Ghosts affordance exactly while the box
   * would otherwise render nothing — the same opt-in the empty text/mermaid/qr
   * widgets make.
   *
   * @param {object} state - the folded item state
   * @returns {boolean}
   *
   * @example plaintextPlugin.isGhost({ text: "" })      // true
   * @example plaintextPlugin.isGhost({ text: "Hello" }) // false
   */
  isGhost(state) {
    return plaintextIsEmpty(state.text);
  },
  // defaults COMPOSE from the SHARED REGISTRY: positioning coords + opacity +
  // effects-off, exactly like rect.js. `text` is a plain STRING (NOT a {runs,
  // paras} rich value — the whole point of this widget). `fill` is the glyph ink
  // (paint-capable via the registry `fill` prop); the registry declares no
  // default for it, so it is supplied here (matching text.js's #1a1a2e ink).
  defaults: {
    type: "plaintext", x: 120, y: 80, w: 260, h: 60, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    text: "Text",
    font: DEFAULT_FONT, size: DEFAULT_TEXT_SIZE, bold: false,
    fill: "#1a1a2e", align: "left", valign: "top",
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  // Rows grouped into the Inspector accordion via each row's `category`. The
  // string CONTENT + typography live in "text"; the ink + opacity in
  // "formatting"; position in "positioning"; the shared effects bundle last.
  inspector: [
    ...bundle("positioning"),
    // The single string. kind "text" is an ordinary field (the qr/codeblock
    // precedent) that also accepts an `=` equation — this is the widget's whole
    // "single equation-bindable string" surface, with NO floating format bar.
    { key: "text", label: "Text", kind: "text", category: "text", help: "The text this box displays. Type freely, or start with '=' to bind it to an equation (e.g. a computed value shown as text)." },
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the text is drawn in." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Font size in canvas units. Larger is bigger on the slide." },
    { key: "bold", label: "Bold", kind: "checkbox", category: "text", help: "Draw the text in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment of the text within the box width: left, center, right, or justified." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the line stack within the box height: top, middle, or bottom." },
    // Ink color reuses the PAINT-capable registry `fill` prop (solid OR
    // linear/radial gradient), relabelled for a text widget; text() runs it
    // through parsePaint so a gradient fills the glyphs.
    ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the glyphs are painted with. Pick a solid color or a linear/radial gradient." } }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → ONE existing ir.js text() op (local space, top-left
   * origin) built from the single string + style props — no new IR op, no rich
   * payload (a LEGACY single-run op; the Skia backend wraps it via singleRunRich
   * and applies boxStyle's align/valign + boxW wrap). Effects (the shared EFFECTS
   * BUNDLE, render_gpu/effects.js) wrap the op; all-off = pass-through.
   *
   * GHOST short-circuit (the mermaid/qr convention): a blank/whitespace-only
   * string draws NOTHING (returns []), so a fresh or cleared box emits no ink in
   * ANY backend and isGhost keeps it selectable. An equation-resolved non-string
   * value is String()-coerced (a bound readout), never a silent blank.
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    if (plaintextIsEmpty(s.text)) return []; // GHOST — draws nothing
    const w = s.w ?? 0, h = s.h ?? 0;
    return applyEffects([text({
      text: String(s.text),
      x: 0, y: 0,
      size: s.size ?? DEFAULT_TEXT_SIZE,
      color: s.fill ?? "#000000",
      bold: s.bold ?? false,
      font: s.font ?? DEFAULT_FONT,
      opacity: s.opacity ?? 1,
      boxW: w > 0 ? w : Infinity, // wrap to the box width; 0/absent ⇒ no wrap
      boxH: h > 0 ? h : Infinity, // box height ⇒ vertical-align room
      boxStyle: { align: s.align ?? "left", valign: s.valign ?? "top" },
    })], s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — same choice
  // plugins/text.js makes; a text box's selectable frame IS its bounding box.
  anchors: standardBBoxAnchors,
  commands: [
    // Arms crosshair placement (the SAME gesture every Add button uses —
    // CanvasView drives click-drag-places off the plugin's type + .defaults).
    { id: "add-plaintext", title: "Add Plain Text", icon: "mdi:format-text-variant", run: (app) => app.armCrosshairPlacement(plaintextPlugin) },
  ],
};
