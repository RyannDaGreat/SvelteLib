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
 *   font_size default = diameter·0.65  → the `size` DEFAULT is that equation
 *   padding, with_checkerboard, crop_zeros
 *                                      → dropped, deliberately. `padding` only
 *     grew the reference's output raster around the disc; here the disc IS the
 *     widget's box and a caller who wants room around it moves the box. The
 *     checkerboard is a transparency PREVIEW (this app has a canvas behind the
 *     widget already) and `crop_zeros` is an artefact of stamping one raster into
 *     another, which a display list does not do.
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
 * The `size` DEFAULT: an EQUATION, so the label keeps the reference's diameter·0.65
 * proportion when the disc is resized instead of freezing at whatever the disc measured
 * when it was placed. Typing a number over it pins the size, which is the ordinary
 * equation-slot behaviour.
 *
 * `Math.abs` IS LOAD-BEARING, and this is the one place in this widget where the
 * NEGATIVE-EXTENTS contract is visible. A stored `h` may be negative — that is how a
 * vertical FLIP is stored (core/registry.js) — and while no plugin HOOK ever sees the
 * sign, an equation does: core/expressions.js runs before any node exists and `self.h`
 * reads the raw stored value. Without the abs a flipped circle asked for a NEGATIVE
 * font size, so the four sign spellings of one footprint stopped deriving to the same
 * state. Caught by tests/negative_size_test.js, which sweeps the roster for exactly
 * this and named the two offending spellings.
 */
export const LABEL_SIZE_EQ = `Math.abs(self.h) * ${REFERENCE.fontSizeFraction}`;

// The alignment vocabularies, mirroring plugins/plaintext.js and
// plugins/clock_digital.js so every text-bearing widget offers the same controls.
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };

export const labeledCirclePlugin = {
  type: "labeled_circle",
  title: "Labeled Circle",
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
    size: LABEL_SIZE_EQ,
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
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Label size in canvas units. Its default is an equation holding the reference proportion (0.65 of the circle's height), so it grows with the circle until you type a number here." },
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
