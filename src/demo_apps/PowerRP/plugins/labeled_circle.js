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

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import {
  BUNDLES, bundle, bundleNestedDefaults, defaults, props,
  STROKE_JOIN_KEYS, STROKE_OFFSET_KEYS, STROKE_TRIM_KEYS,
} from "../core/properties.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { ellipsePathD } from "../core/svg_paths.js";
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

// LABELED-CIRCLE NUMBERED-CALLOUT IDIOMS (R7-39 presets law) — this widget IS the
// numbered callout (see the header: a reproduction of the user's own Figures
// library `labeled_circle`), so the family is not a colour-swap set but a table of
// named, physically-recognisable ROUNDEL idioms: a thing you would recognise on
// sight (a subway line marker, a poker chip, a warning triangle's round cousin)
// rather than "Red Circle" / "Blue Circle". Every row is an OVERLAY over BOTH the
// ring/fill keys (fill/stroke/strokeWidth/strokeOffset) AND the full label key set
// (font/size/bold/align/valign/labelColor) AND the six-key effects bundle — the
// rect.js/group.js identity law, restated for a widget with a LABEL as well as a
// ring: a preset that left `font` or `align` unwritten would inherit whatever the
// previously-hovered preset left behind, and a hover-compare between two presets
// must never bleed one into the other.
//
// NO PRESET SETS `text` — the shipped default "42" is AUTHOR CONTENT (the header's
// own reference-fidelity note), the exact rule tests/qrcode presets pins for its
// `data` payload. A preset only ever describes the LOOK a label sits inside.
//
// THE SIX-KEY EFFECTS SET IS DERIVED FROM BUNDLES.effects, not transcribed (the
// rect.js precedent): the day a seventh effect lands, this file fails loudly with
// the missing key named instead of silently leaking the previous row's value on
// hover.
const EFFECT_HEADS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
if (EFFECT_HEADS.length !== 6)
  throw new Error(`labeled_circle presets: BUNDLES.effects grew a new head (${EFFECT_HEADS.join(", ")}) — add its OFF identity below and extend every preset row`);
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0; // gaussianBlur's identity: 0 = no blur
const EFFECTS_OFF = { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF };

// Sizes below are literal numbers scaled against the widget's own default
// diameter (REFERENCE.diameter = 257) and its default label proportion
// (DEFAULT_LABEL_SIZE = 167.05, i.e. 0.65 of the diameter) — never a computed
// default (the header's DEFAULT_LABEL_SIZE docblock: a `self.h`-relative string
// is silently NOT an equation unless it begins with "self.", and a preset's
// PROPS are plain data, not equation text, so a relative size has to be a
// literal computed once here rather than typed as "= abs(self.h) * k").
const PRESETS = [
  { name: "Step Badge", description: "The plain numbered-step marker for a pipeline figure: bold white numeral on a solid brand-blue disc, with the rim drawn inward so the outline never eats into the badge's outer silhouette.",
    props: { font: "inter", size: DEFAULT_LABEL_SIZE, bold: true, align: "center", valign: "middle", labelColor: "#ffffff", fill: "#2f6fed", stroke: "#1a3f8f", strokeWidth: 8, strokeOffset: -1, ...EFFECTS_OFF } },
  { name: "Map Pin Roundel", description: "The round head of a map-pin marker: a warm red disc with a crisp white ring and a close-fitted contact shadow, as if the pin were sitting just above the page.",
    props: { font: "inter", size: DEFAULT_LABEL_SIZE * 0.85, bold: true, align: "center", valign: "middle", labelColor: "#ffffff", fill: "#e0392b", stroke: "#ffffff", strokeWidth: 10, strokeOffset: 0, shadow: { dx: 0, dy: 6, blur: 10, color: "#000000", opacity: 0.35 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Medal", description: "A gold medallion: a warm metallic-gold fill inside a darker bronze inner ring, with a low sheen shadow underneath so the disc reads as struck metal rather than flat colour.",
    props: { font: "playfair-display", size: DEFAULT_LABEL_SIZE * 0.7, bold: true, align: "center", valign: "middle", labelColor: "#5a3d0a", fill: "#e8c15a", stroke: "#9c6b12", strokeWidth: 14, strokeOffset: -1, shadow: { dx: 0, dy: 5, blur: 8, color: "#000000", opacity: 0.4 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Poker Chip", description: "A casino chip's edge: a thick, high-contrast rim banding a dark centre, the ring wide enough to read as the chip's own stacked-edge pattern rather than a thin border.",
    props: { font: "jetbrains-mono", size: DEFAULT_LABEL_SIZE * 0.6, bold: true, align: "center", valign: "middle", labelColor: "#ffffff", fill: "#1a1a1a", stroke: "#c9302c", strokeWidth: 34, strokeOffset: -1, ...EFFECTS_OFF } },
  { name: "Warning Roundel", description: "The round cousin of a hazard triangle: black bold text on saturated safety amber, no rim at all, so the whole disc is the warning colour.",
    props: { font: "oswald", size: DEFAULT_LABEL_SIZE * 0.9, bold: true, align: "center", valign: "middle", labelColor: "#1a1400", fill: "#ffb300", stroke: "#00000000", strokeWidth: 0, strokeOffset: 0, ...EFFECTS_OFF } },
  { name: "Subway Roundel", description: "A transit line marker: a thin line-colour ring around a white core, the label in a plain geometric sans — the disc a station map draws around a stop's number.",
    props: { font: "roboto", size: DEFAULT_LABEL_SIZE * 0.75, bold: true, align: "center", valign: "middle", labelColor: "#0a0a0a", fill: "#ffffff", stroke: "#00843d", strokeWidth: 16, strokeOffset: -1, ...EFFECTS_OFF } },
  { name: "Minimal Outline", description: "The lightest possible callout: no fill at all, a thin dark ring, and a dark label — a marker meant to sit unobtrusively over busy artwork instead of covering it.",
    props: { font: "inter", size: DEFAULT_LABEL_SIZE * 0.8, bold: false, align: "center", valign: "middle", labelColor: "#1a1a1a", fill: "#00000000", stroke: "#1a1a1a", strokeWidth: 3, strokeOffset: 0, ...EFFECTS_OFF } },
  { name: "Neon Token", description: "A glowing disc with almost no face of its own: a dim near-black fill under a saturated magenta rim, screen-blended and bloomed so the ring reads as a lit tube rather than a painted line.",
    props: { font: "jost", size: DEFAULT_LABEL_SIZE * 0.75, bold: true, align: "center", valign: "middle", labelColor: "#ff6bf0", fill: "#120014", stroke: "#ff2ec4", strokeWidth: 6, strokeOffset: 0, shadow: SHADOW_OFF, bloom: { radius: 26, strength: 0.8 }, blendMode: "screen", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Enamel Pin", description: "A glossy enamel-pin roundel: a saturated teal face with a thin gold outline, an inner shadow along the rim standing in for the recessed metal channel between colour fields, and a soft drop shadow lifting the whole pin off the page.",
    props: { font: "poppins", size: DEFAULT_LABEL_SIZE * 0.7, bold: true, align: "center", valign: "middle", labelColor: "#fff6d8", fill: "#0e7c73", stroke: "#d9b23c", strokeWidth: 8, strokeOffset: -1, shadow: { dx: 0, dy: 4, blur: 8, color: "#000000", opacity: 0.35 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 0, blur: 10, color: "#000000", opacity: 0.4 }, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Gauge Cap", description: "The round cap on a dashboard gauge or dial centre: a brushed-metal grey face, a dark bezel ring, and a tight offset shadow — mechanical rather than graphic.",
    props: { font: "jetbrains-mono", size: DEFAULT_LABEL_SIZE * 0.65, bold: false, align: "center", valign: "middle", labelColor: "#1a1a1a", fill: "#b7bec6", stroke: "#3a3f45", strokeWidth: 12, strokeOffset: -1, shadow: { dx: 0, dy: 2, blur: 4, color: "#000000", opacity: 0.5 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Chalk Number", description: "A number chalked onto a slate disc: a soft desaturated green-black fill with a slightly smudged edge, and an off-white label with no gloss or shine of any kind.",
    props: { font: "lora", size: DEFAULT_LABEL_SIZE * 0.85, bold: false, align: "center", valign: "middle", labelColor: "#e8e4d8", fill: "#243328", stroke: "#00000000", strokeWidth: 0, strokeOffset: 0, shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 10, gaussianBlur: BLUR_OFF } },
  { name: "Scoreboard", description: "A stadium scoreboard digit roundel: a seven-segment-style numeral glowing amber on a near-black disc with a thin dark bezel, as if lit from inside by a bank of bulbs.",
    props: { font: "seg7", size: DEFAULT_LABEL_SIZE * 0.95, bold: true, align: "center", valign: "middle", labelColor: "#ffb000", fill: "#0a0a0a", stroke: "#2a2a2a", strokeWidth: 10, strokeOffset: -1, shadow: SHADOW_OFF, bloom: { radius: 18, strength: 0.5 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
];

export const labeledCirclePlugin = {
  type: "labeled_circle",
  ephemeral: EPHEMERAL.NONE,
  title: "Labeled Circle",
  presets: PRESETS,
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
    ...bundle("transform"),
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
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the DISC as cubic contours, from `ellipsePathD` — the same four-arc kappa
   * circle plugins/circle.js hands over, and the same figure this widget's own
   * `ellipse` op paints and its `hitTest` accepts.
   *
   * THE LABEL IS NOT IN THE PAYLOAD, and this widget is the clearest case of the
   * line: it is a disc PLUS a text run, drawn as two ops, and text becomes
   * morphable through the glyph-outline seam (core/glyph_outlines.js) rather than
   * by a plugin inventing letterforms. So the disc flows and the numeral steps,
   * which is the same reading a mermaid label and a graph tick label get. When
   * the seam is reachable from a general provider the label can join with no
   * other change here.
   *
   * THE DISC ALONE IS STILL THE WIDGET'S SHAPE — an empty label emits no text op
   * at all (see emit()), so for the unlabelled case this payload is the ENTIRE
   * ink, not a part of it.
   */
  morphPaths(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    return morphPayloadFromPaths(
      [{ d: ellipsePathD(w / 2, h / 2, w / 2, h / 2), paint: statePaint(s) }],
      { w, h },
    );
  },
  /** Pure function. Why this widget cannot morph YET, or null — emit()'s own
   * threshold: a zero-size disc has no outline to pair. */
  morphNotReady(s) {
    return (s.w ?? 0) > 0 && (s.h ?? 0) > 0 ? null : "a disc with extent (this one has zero size)";
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
  // NO `modifierPoints`: the GRADIENT beads are appended by core/derive.js
  // nodeModifierPoints for every paint-capable widget (off the `paint: true` rows
  // above), not spread per plugin — see that function and core/paint_handles.js.
  commands: [
    { id: "add-labeled-circle", title: "Add Labeled Circle", icon: "mdi:numeric-1-circle-outline", run: (app) => app.armCrosshairPlacement(labeledCirclePlugin) },
  ],
};
