/**
 * LABELED CIRCLE widget — a filled disc with a rim and one short label centred in
 * it: the numbered callout a figure uses to point at step 3 of a pipeline. A
 * reproduction of the user's own Figures library entry
 * (refs/Figures/labeled_circle/labeled_circle.py — `labeled_circle`).
 *
 * ── THE REFERENCE, PARAMETER BY PARAMETER ─────────────────────────────────────
 *   text, color, rim_color, rim_width  → `text`, `fill`, `stroke`, `strokeWidth`
 *   rim_width < 0 = an INWARD rim      → `strokeOffset` (see below)
 *   diameter                           → the widget's own box (w = h = the disc)
 *   font, font_size, text_style, text_color
 *                                      → `font`, `size`, `bold`, `labelColor`
 *   font_size default = diameter·0.65  → the `size` DEFAULT, evaluated once (see
 *                                        DEFAULT_LABEL_SIZE for why not an equation)
 *   padding, with_checkerboard, scale → dropped, deliberately. `padding` only grew
 *     the reference's output raster around the disc; here the disc IS the widget's
 *     box and a caller who wants room around it moves the box. The checkerboard is a
 *     transparency PREVIEW (this app has a canvas behind the widget already). `scale`
 *     multiplied diameter/padding/rim_width/font_size together, which is what
 *     resizing the box does to the disc — but NOT to `strokeWidth` or `size`, which
 *     are stored lengths here; a caller who wants the reference's coupling types
 *     `= abs(self.h) * 20/257` and `= abs(self.h) * 0.65` into those two rows.
 *   crop_zeros                         → NOT expressible, and it is the one place
 *     this widget can visibly differ from the reference. See the note below.
 *
 * ── HOW THE LABEL IS CENTRED, AND WHERE THAT DIVERGES (measured) ──────────────
 * The reference crops the text raster's transparent margin (`crop_zeros`, default
 * ON) and only then stamps it centre-on-centre, so what it centres is the GLYPH INK.
 * PowerRP centres the laid-out LINE BOX (core/richtext.js valignOffset), whose height
 * is the font's ascent + descent and is therefore the same whatever the label says.
 * The two agree exactly for a string whose ink is cap-height — which is what a
 * numbered callout is — and diverge by the descender for anything lower.
 *
 * MEASURED, rendering this widget at its shipped defaults through cli/render.js and
 * taking the ink bounding box out of the PNG (offset of ink centre below disc centre,
 * positive = low; the disc is 257 px and the label 167.05 px):
 *
 *     "42"  ->  -0.5 px   (-0.2% of the diameter)   the shipped default: FAITHFUL
 *     "Ag"  ->  22.5 px   ( 8.8%)
 *     "gy"  ->  41.5 px   (16.1%)                   a descender-only label: OFF
 *
 * So the widget is faithful for what it is FOR, and a lowercase word label sits low.
 * It is recorded rather than worked around because the fix does not belong here: emit()
 * is DOM-free and cannot measure a glyph, so ink-centring has to be a text-layout
 * capability (a `valign` that resolves against the ink box), which would serve
 * plaintext, number and both clocks at the same time. A per-widget nudge would be one
 * more spelling of a feature five widgets already want.
 *
 * ── THE INWARD RIM IS `strokeOffset`, NOT A SIGNED WIDTH ──────────────────────
 * The reference stores the rim as a SIGNED width (negative = drawn inward). PowerRP
 * already has that concept and spells it differently: a non-negative `strokeWidth`
 * plus `strokeOffset`, where -1 puts the whole outline INSIDE the shape, 0 straddles
 * the edge and +1 puts it outside (core/properties.js PROPS.strokeOffset, stamped
 * universally at render_gpu/ports.js — no plugin implements it). Inventing a second,
 * signed spelling of the same quantity would be a dialect, so the widget defaults
 * `strokeOffset` to -1 and gets the reference's look through the existing knob.
 *
 * ── THE LABEL ─────────────────────────────────────────────────────────────────
 * ONE ir.js `text()` op at the widget's local origin with `boxW`/`boxH` = the box
 * and `boxStyle` centred, which is the plaintext/clock_digital idiom: the box IS the
 * disc, so centring in the box centres on the disc for free and no glyph measuring
 * happens in emit() (it cannot — emit is DOM-free).
 *
 * KNOWN BOUND, stated because it is not this widget's to fix: a LEGACY single-run
 * text op's `boxStyle` is honoured by the Skia painter (which wraps it into a
 * one-run rich layout internally) and IGNORED by the SVG and PDF exporters, which
 * fall through to a plain top-left `<text>`. So an SVG/PDF export of this widget
 * top-left-anchors its label. That is a pre-existing gap shared with plaintext,
 * number and both clocks — ledger C-17's class, an IR field one backend honours and
 * two silently drop — and it is reported rather than worked around here, because a
 * per-widget workaround is exactly how five spellings of one feature get born.
 *
 * ── THE THREE KINDS OF STATE ──────────────────────────────────────────────────
 * Property state only: no clock, no randomness, no history.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import {
  bundle, bundleNestedDefaults, defaults, props,
  STROKE_JOIN_KEYS, STROKE_OFFSET_KEYS, STROKE_TRIM_KEYS,
} from "../core/properties.js";
import * as T from "../core/transform.js";
import { ellipse, text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/**
 * The reference's own defaults, from `labeled_circle`'s signature and the demo
 * beside it (refs/Figures/labeled_circle/). The FUNCTION's colour defaults are a
 * placeholder magenta with `rim_color=None`, which resolves the rim to the fill and
 * therefore draws NO VISIBLE RIM; the shipped demo's green/red/black is what the
 * reference actually renders, so that is what a fresh widget starts as.
 *
 * @example REFERENCE.diameter // 257
 * @example REFERENCE.fontSizeFraction // 0.65
 */
export const REFERENCE = {
  text: "42",              // the demo's text_input default
  diameter: 257,           // diameter=257
  rimWidth: 20,            // rim_width=-20 — the sign is strokeOffset here
  fontSizeFraction: 0.65,  // font_size defaults to diameter*.65
  font: "futura",          // font="Futura", which this app's registry also ships
  fill: "#00ff00",         // the demo's fill_color_picker
  rim: "#ff0000",          // the demo's rim_color_picker
  ink: "#000000",          // text_color="black"
};

/**
 * The label's DEFAULT size: the reference's `font_size = diameter*.65`, evaluated once
 * against the default diameter exactly as the reference evaluates it once against its
 * `diameter` argument.
 *
 * IT IS A PLAIN NUMBER, AND THAT IS A CORRECTION. It was first written as the computed
 * default `self.h * 0.65`, so a resized disc would keep the proportion — and that broke
 * twice, in two different ways, which is why the constant is worth a docblock:
 *
 *   1. `self.h` reads the RAW STORED h, and a stored h may be NEGATIVE (that is how a
 *      vertical FLIP is stored — core/registry.js). No plugin HOOK ever sees the sign,
 *      but core/expressions.js runs before any node exists, so an equation does. A
 *      flipped disc asked for a negative font size and the four sign spellings of one
 *      footprint stopped deriving to the same state. tests/negative_size_test.js named
 *      both offending spellings.
 *   2. The obvious repair — `Math.abs(self.h) * 0.65` — SILENTLY IS NOT AN EQUATION.
 *      core/expressions.js isNumericSlot treats a string default as a computed default
 *      only when it BEGINS with "self.", which is what keeps every name/fill/text
 *      default out of the expression system. A default that merely CONTAINS `self.` is
 *      an ordinary string, so `size` arrived at the painter as text and the widget
 *      red-boxed with `"size" must be a finite number`. Measured in the browser, not
 *      reasoned about; tests/computed_default_test.js now gates the rule roster-wide.
 *
 * A caller who wants the proportion back can still type one — `= abs(self.h) * 0.65`
 * in the Size row is a perfectly good equation. It is only the DEFAULT that has to be
 * a literal, because a default is read before the slot's kind is known from it.
 *
 * @example // labeledCirclePlugin.defaults.size  →  167.05  (257 * 0.65)
 */
export const DEFAULT_LABEL_SIZE = REFERENCE.diameter * REFERENCE.fontSizeFraction;

// The alignment vocabularies, mirroring plugins/plaintext.js and
// plugins/clock_digital.js so every text-bearing widget offers the same controls.
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };

export const labeledCirclePlugin = {
  type: "labeled_circle",
  title: "Labeled Circle",
  // A SHAPE, declared by the widget (core/registry.js INSERT_MENUS): it joins the
  // Add Shape grid without any central list learning its name.
  insertMenu: "shape",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "labeled_circle", x: 200, y: 200, z: 0, rotation: 0, scale: 1,
    w: REFERENCE.diameter, h: REFERENCE.diameter,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: REFERENCE.fill,
    stroke: REFERENCE.rim,
    strokeWidth: REFERENCE.rimWidth,
    // -1 = the rim drawn entirely INSIDE the disc, which is what the reference's
    // NEGATIVE rim_width means (see the header).
    strokeOffset: -1,
    text: REFERENCE.text,
    font: REFERENCE.font,
    size: DEFAULT_LABEL_SIZE,
    bold: true, // text_style="bold"
    align: "center",
    valign: "middle",
    labelColor: REFERENCE.ink,
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("positioning"),
    // THE LABEL. `text` is spelled exactly as plugins/plaintext.js spells it, so a
    // retype between the two carries the string across (core/retype.js).
    { key: "text", label: "Text", kind: "text", category: "text", help: "The label drawn in the middle of the circle — a number, a letter, a word. Start with '=' to bind it to an equation." },
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the label is drawn in." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Label size in canvas units — 0.65 of the circle's diameter by default, the reference figure's proportion. Type '= abs(self.h) * 0.65' here to make it track the circle as you resize it." },
    { key: "bold", label: "Bold", kind: "boolean", category: "text", help: "Draw the label in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment of the label within the circle's box." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the label within the circle's box." },
    { key: "labelColor", label: "Label color", kind: "color", category: "text", help: "The colour or gradient the label is painted with." },
    // THE DISC + ITS RIM. No cornerRadius — an ellipse has no square corners to
    // round, which is why this composes the individual paint rows rather than the
    // whole strokedBox bundle (the plugins/circle.js precedent).
    ...props("fill", "stroke", "strokeWidth"),
    // The rim's SIDE: -1 inward (the reference's negative rim_width), 0 centred,
    // +1 outward.
    ...props(...STROKE_OFFSET_KEYS),
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → two display-list commands in local space: the disc
   * (an `ellipse` filling the box, with the rim as its stroke) and the label
   * (`text` centred in the same box). Both ride ONE applyEffects wrap, so a shadow
   * or bloom treats the disc and its label as one object.
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const ops = [ellipse({
      cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      strokeOffset: s.strokeOffset,
      opacity: s.opacity ?? 1,
    })];
    const label = typeof s.text === "string" ? s.text : "";
    // An EMPTY label emits no text op at all — a zero-glyph op is a layout and a
    // draw call that produce nothing, and the disc alone is a legitimate widget.
    if (label.length > 0)
      ops.push(text({
        text: label,
        x: 0, y: 0,
        size: s.size ?? h * REFERENCE.fontSizeFraction, // h here is already UNSIGNED (the hook contract)
        color: s.labelColor ?? REFERENCE.ink,
        bold: s.bold ?? false,
        font: s.font ?? DEFAULT_FONT,
        opacity: s.opacity ?? 1,
        boxW: w > 0 ? w : Infinity, // the box IS the disc, so centring here centres on it
        boxH: h > 0 ? h : Infinity,
        boxStyle: { align: s.align ?? "center", valign: s.valign ?? "middle" },
      }));
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    const nx = (lx - s.w / 2) / (s.w / 2), ny = (ly - s.h / 2) / (s.h / 2);
    return nx * nx + ny * ny <= 1;
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Radial point on the ellipse toward the target (exact when w === h), the
    // plugins/circle.js computed anchor.
    const local = T.apply(T.invert(world), wx, wy);
    const rx = state.w / 2, ry = state.h / 2;
    const theta = Math.atan2((local.y - ry) / ry, (local.x - rx) / rx);
    return { x: rx + rx * Math.cos(theta), y: ry + ry * Math.sin(theta) };
  },
  // GRADIENT HANDLES (core/paint_handles.js): center/direction beads for a gradient
  // FILL; none for a solid/material fill.
  modifierPoints: (s) => paintModifierPoints(s, "fill"),
  commands: [
    { id: "add-labeled-circle", title: "Add Labeled Circle", icon: "mdi:numeric-1-circle-outline", run: (app) => app.armCrosshairPlacement(labeledCirclePlugin) },
  ],
};
