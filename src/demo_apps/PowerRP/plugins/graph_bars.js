/**
 * GRAPH BARS — the programmatic BAR GRAPH (manifest item 71): "bar graph
 * widgets… programmatic — program the number of bars and the area under the curve
 * and stuff, so we can animate all the bars going up, very Manim-like." N bars,
 * each valued by an equation, growing up through ONE tweened `reveal` — the exact
 * shape of progress_bar's single `fraction`, generalized to a whole chart.
 *
 * ── THREE VALUE MODES (digest 10 §1) ──────────────────────────────────────────
 *   direct  — bar i's height = f(i)               (Manim BarChart, as a formula)
 *   riemann — bar i samples f(x) at x_i over [xStart, xEnd] (the "area under the
 *             curve"; left/right/center sample rule, the actual MIDPOINT rule for
 *             center, NOT a trapezoid — digest 10 trap #6)
 *   literal — explicit comma-separated values (a data histogram / categorical)
 * `barCount` is DISCRETE (digest 10 trap #2): rounded in emit so it steps through
 * integers rather than smoothly interpolating a fractional bar count; the
 * refinement-sequence story (dx halving 4→8→16→32) is authored as per-slide
 * keyframes. `reveal` is the ONLY smooth animation surface.
 *
 * ── THE GROW-UP (digest 10 §5) ────────────────────────────────────────────────
 * A single `reveal` ∈ [0,1] grows every bar through the SHARED lagged-reveal
 * formula (core/graph_scale.easedReveal), unifying Manim's LaggedStart and D3's
 * per-index delay: `growLagRatio` 0 grows all bars together, 1 strictly in
 * sequence. Keyframe `reveal` 0→1 across a slide transition for the entrance.
 * `reveal` is PROPERTY STATE; a `time`-reading `valueEquation` (the equalizer
 * preset) is RECORDABLE STATE — a pure function of elapsed time, seekable.
 *
 * ── ANTI-SEAM + ANTI-JUMP (digest 10 traps) ───────────────────────────────────
 * `barOverlapFudge` (1.001, Manim's width_scale_factor) overscales each bar's
 * width so adjacent Riemann rectangles show no hairline seam. `autoscale` stays
 * OFF: `yRange` is authored once and fixed, so the axis never jumps as `reveal`
 * uncovers a taller bar (which would fight the smooth grow).
 *
 * No plugin imports another: the companion "area under the curve" graphLine is a
 * SECOND item the author overlays (composition in the document), not an import.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { parseRange, dataToLocal, easedReveal, clamp01 } from "../core/graph_scale.js";
import { sampleIndexed, errorAffordance } from "../core/graph_equation.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { morphPayloadFromPaths } from "../core/morph_payload.js";
import { rectPathD } from "../core/svg_paths.js";
import * as T from "../core/transform.js";
import { rect, text } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";
import { GRAPH_BARS_PRESETS } from "./graph_presets.js";

const CAT = "formatting";
const MODES = ["direct", "riemann", "literal"];
const MODE_LABELS = { direct: "Direct f(i)", riemann: "Riemann f(x)", literal: "Literal values" };
const SAMPLE_TYPES = ["left", "right", "center"];
const SAMPLE_LABELS = { left: "Left", right: "Right", center: "Center (midpoint)" };
const ORIENTS = ["vertical", "horizontal"];
const ORIENT_LABELS = { vertical: "Vertical (grow up)", horizontal: "Horizontal (grow right)" };
const COLOR_MODES = ["solid", "gradient-index", "palette-cycle", "by-value"];
const COLOR_MODE_LABELS = { solid: "Solid", "gradient-index": "Gradient across bars", "palette-cycle": "Palette cycle", "by-value": "By sign (± )" };
const EASES = ["linear", "cubic", "quad_in", "quad_out"];
const GROW_DIRS = ["index-ascending", "index-descending", "center-out", "edges-in"];
const GROW_DIR_LABELS = { "index-ascending": "Left to right", "index-descending": "Right to left", "center-out": "Center out", "edges-in": "Edges in" };

// digest 10 §4 — the two Manim APIs DISAGREE on fill opacity (BarChart 0.7 vs
// get_riemann_rectangles 1.0); 0.7 is the categorical default here, Riemann
// presets override to 1.0. Do NOT "fix" this to 1.0 — see the doc.
const DEFAULT_FILL_OPACITY = 0.7;
const DEFAULT_BAR_COLOR = "#58C4DD";   // Manim BLUE_C
const DEFAULT_GRAD_FROM = "#58C4DD";   // BLUE_C
const DEFAULT_GRAD_TO = "#83C167";     // GREEN_C
const DEFAULT_BELOW_ZERO = "#FC6255";  // RED_C (signed-area convention)
const DEFAULT_PALETTE = "#003f5c, #58508d, #bc5090, #ff6361, #ffa600"; // Manim BarChart bar_colors
const DEFAULT_STROKE = "#000000";
const DEFAULT_STROKE_WIDTH = 1;
const DEFAULT_BAR_WIDTH_FRACTION = 0.6; // Manim bar_width
const DEFAULT_OVERLAP_FUDGE = 1.001;    // Manim width_scale_factor (anti-seam)
const DEFAULT_LABEL_SIZE = 14;
const GLYPH_ADVANCE_RATIO = 0.55;       // see graph_tick_marks.js
const LABEL_PAD = 6;

/**
 * Pure function. Parses a comma-separated string of numbers into an array,
 * dropping blank entries — the storage for literal bar values / a value list
 * typed in one field (no core/lists plumbing). Non-numeric entries become NaN
 * (the caller reads a NaN bar as height 0).
 *
 * @param {string} csv - "2, 5, 9, 14"
 * @returns {number[]}
 *
 * @example parseNumberList("2, 5, 9") // [2, 5, 9]
 * @example parseNumberList("") // []
 * @example parseNumberList("1,,3") // [1, 3]
 */
export function parseNumberList(csv) {
  return String(csv ?? "").split(",").map((s) => s.trim()).filter((s) => s.length).map(Number);
}

/**
 * Pure function. Parses a comma-separated string into trimmed string entries —
 * bar names / palette colors typed in one field.
 *
 * @example parseStringList("Q1, Q2, Q3") // ["Q1", "Q2", "Q3"]
 * @example parseStringList("") // []
 */
export function parseStringList(csv) {
  return String(csv ?? "").split(",").map((s) => s.trim()).filter((s) => s.length);
}

/**
 * Pure function. Linear interpolation between two "#rrggbb" hex colors → a hex
 * string. Clamps t to [0,1]. The gradient-across-index bar coloring
 * (get_riemann_rectangles' BLUE→GREEN default).
 *
 * @param {string} a - start "#rrggbb"
 * @param {string} b - end "#rrggbb"
 * @param {number} t - 0..1
 * @returns {string} "#rrggbb"
 *
 * @example hexLerp("#000000", "#ffffff", 0.5) // "#808080"
 * @example hexLerp("#ff0000", "#00ff00", 0) // "#ff0000"
 * @example hexLerp("#ff0000", "#00ff00", 1) // "#00ff00"
 */
export function hexLerp(a, b, t) {
  const p = clamp01(t);
  const ca = parseHex(a), cb = parseHex(b);
  const mix = (i) => Math.round(ca[i] + (cb[i] - ca[i]) * p);
  return `#${[mix(0), mix(1), mix(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Pure helper. "#rgb"/"#rrggbb" → [r, g, b] bytes. */
function parseHex(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/**
 * Pure function. The DATA x-value bar `i` of `N` samples in riemann mode, per the
 * sample rule: left = interval start, right = interval end, center = midpoint (the
 * true MIDPOINT rule — digest 10 trap #6, NOT a trapezoid average).
 *
 * @example riemannX(0, 4, 0, 4, "left") // 0
 * @example riemannX(0, 4, 0, 4, "right") // 1
 * @example riemannX(0, 4, 0, 4, "center") // 0.5
 * @example riemannX(0, 4, 3, 4, "center") // 3.5
 */
export function riemannX(xStart, xEnd, i, N, sampleType) {
  const dx = (xEnd - xStart) / N;
  const off = sampleType === "right" ? 1 : sampleType === "center" ? 0.5 : 0;
  return xStart + (i + off) * dx;
}

/**
 * Pure function. The FILL color for bar `i` of `N` with value `v`, per colorMode:
 * solid → barColor; gradient-index → barColor…gradientTo lerp across i;
 * palette-cycle → palette[i % len]; by-value → belowZero color when v < 0 else
 * barColor.
 *
 * @param {number} i - bar index
 * @param {number} n - bar count
 * @param {number} v - bar value
 * @param {object} c - {colorMode, barColor, gradientFrom, gradientTo, palette, belowZero}
 * @returns {string} hex color
 *
 * @example barColorFor(0, 2, 5, {colorMode: "solid", barColor: "#58C4DD"}) // "#58C4DD"
 * @example barColorFor(0, 2, 5, {colorMode: "palette-cycle", palette: ["#111111", "#222222"]}) // "#111111"
 * @example barColorFor(1, 2, 5, {colorMode: "palette-cycle", palette: ["#111111", "#222222"]}) // "#222222"
 * @example barColorFor(-1, 2, -3, {colorMode: "by-value", barColor: "#58C4DD", belowZero: "#FC6255"}) // "#FC6255"
 * @example barColorFor(0, 3, 5, {colorMode: "gradient-index", gradientFrom: "#000000", gradientTo: "#ffffff"}) // "#000000"
 */
export function barColorFor(i, n, v, c) {
  if (c.colorMode === "palette-cycle") {
    const pal = c.palette && c.palette.length ? c.palette : [c.barColor];
    return pal[((i % pal.length) + pal.length) % pal.length];
  }
  if (c.colorMode === "gradient-index") return hexLerp(c.gradientFrom, c.gradientTo, n <= 1 ? 0 : i / (n - 1));
  if (c.colorMode === "by-value") return v < 0 ? c.belowZero : c.barColor;
  return c.barColor;
}

/** Pure helper. One bar's grown RECT (local top-left origin) given its full
 *  value extent and growth factor, for either orientation. Vertical: grows from
 *  the baseline up (progress_bar's bottom→top convention); horizontal: grows from
 *  the baseline rightward. `slot0`/`slotSize` place the bar along its axis. */
function barRect(orientation, slot0, slotSize, barFrac, fudge, base, valPix, factor) {
  const thick = slotSize * barFrac * fudge;
  const inset = (slotSize - slotSize * barFrac) / 2; // center within the slot (edge align passes barFrac at slot0)
  const grownEnd = base + (valPix - base) * factor;
  if (orientation === "horizontal") {
    // base/valPix are LOCAL X; bars stack down the height (slot along y)
    const lo = Math.min(base, grownEnd), hi = Math.max(base, grownEnd);
    return { x: lo, y: slot0 + inset, w: hi - lo, h: thick };
  }
  const lo = Math.min(base, grownEnd), hi = Math.max(base, grownEnd);
  return { x: slot0 + inset, y: lo, w: thick, h: hi - lo };
}

/**
 * Query (samples the value equation, which may read the clock). The widget's bars
 * as `{rects, labels, error}` — rects are `{x, y, w, h, color}` local, labels are
 * `{text, x, y}` under each bar (empty unless barNames set). On an equation
 * failure `rects` is empty and `error` carries the loud message. Shared by emit
 * and localBounds.
 *
 * @param {object} state - evaluated item state
 * @returns {{rects: object[], labels: object[], error: (string|null)}}
 */
export function barGeometry(state) {
  const w = state.w ?? 0, h = state.h ?? 0;
  const mode = state.mode ?? "direct";
  const N = Math.max(1, Math.round(state.barCount ?? 8));
  const yr = parseRange(state.yRange ?? "[0, 10, 1]");
  const orientation = state.orientation ?? "vertical";

  // ── values ──
  let values, error = null;
  if (mode === "literal") {
    values = parseNumberList(state.barValues);
  } else if (mode === "riemann") {
    const xs = [];
    for (let i = 0; i < N; i++) xs.push(riemannX(state.xStart ?? 0, state.xEnd ?? 4, i, N, state.inputSampleType ?? "left"));
    const r = sampleIndexed({ equation: state.valueEquation ?? "0", count: N, xs, vars: { ...(state.docVars ?? {}), ...(state.vars ?? {}) } });
    values = r.values; error = r.error;
  } else {
    const r = sampleIndexed({ equation: state.valueEquation ?? "0", count: N, vars: { ...(state.docVars ?? {}), ...(state.vars ?? {}) } });
    values = r.values; error = r.error;
  }
  if (error) return { rects: [], labels: [], error };

  const count = mode === "literal" ? values.length : N;
  const names = parseStringList(state.barNames);
  const palette = parseStringList(state.paletteColors);
  const colorOpts = {
    colorMode: state.colorMode ?? "solid",
    barColor: state.barColor ?? DEFAULT_BAR_COLOR,
    gradientFrom: state.gradientFrom ?? DEFAULT_GRAD_FROM,
    gradientTo: state.gradientTo ?? DEFAULT_GRAD_TO,
    palette,
    belowZero: state.colorByValueBelowZero ?? DEFAULT_BELOW_ZERO,
  };
  const barFrac = clamp01(state.barWidthFraction ?? DEFAULT_BAR_WIDTH_FRACTION);
  const fudge = state.barOverlapFudge ?? DEFAULT_OVERLAP_FUDGE;
  const reveal = state.reveal ?? 1;
  const lag = state.growLagRatio ?? 0.5;
  const easeName = state.growEase ?? "cubic";
  const dir = state.growDirection ?? "index-ascending";
  const flip = orientation === "vertical"; // y flipped (value up); horizontal maps value to +x (no flip)
  const axisExtent = orientation === "vertical" ? h : w;
  const slotExtent = orientation === "vertical" ? w : h;
  const slotSize = count > 0 ? slotExtent / count : slotExtent;
  const base = dataToLocal(state.baselineY ?? 0, yr.min, yr.max, axisExtent, flip);

  const rects = [], labels = [];
  for (let i = 0; i < count; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    const valPix = dataToLocal(v, yr.min, yr.max, axisExtent, flip);
    const factor = easedReveal(i, count, reveal, lag, easeName, dir);
    const r = barRect(orientation, i * slotSize, slotSize, barFrac, fudge, base, valPix, factor);
    rects.push({ ...r, color: barColorFor(i, count, v, colorOpts) });
    if (names[i]) {
      const size = state.labelSize ?? DEFAULT_LABEL_SIZE;
      const cx = i * slotSize + slotSize / 2;
      labels.push({ text: names[i], x: cx - (names[i].length * size * GLYPH_ADVANCE_RATIO) / 2, y: h + LABEL_PAD, size });
    }
  }
  return { rects, labels, error: null };
}

export const graphBarsPlugin = {
  type: "graph_bars",
  ephemeral: EPHEMERAL.NONE,
  title: "Graph Bars",
  capabilities: { docVars: true,  bbox: true, transform: true, resizable: true, backdrop: false },
  // codeEditor + its REQUIRED double-click declaration (see graph_line.js / the
  // migration gate) — double-clicking the chart opens Monaco on the value equation.
  activate: "code_modal",
  codeEditor: { property: "valueEquation", language: "javascript", title: "Edit Bar Value Equation" },
  defaults: {
    type: "graph_bars", x: 120, y: 120, w: 400, h: 300, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    mode: "direct", barCount: 8, valueEquation: "3 + 2*Math.sin(i)",
    barValues: "", barNames: "",
    xStart: 0, xEnd: 4, inputSampleType: "left",
    yRange: "[0, 10, 1]", baselineY: 0, orientation: "vertical",
    barWidthFraction: DEFAULT_BAR_WIDTH_FRACTION, barOverlapFudge: DEFAULT_OVERLAP_FUDGE, cornerRadius: 0,
    colorMode: "solid", barColor: DEFAULT_BAR_COLOR, gradientFrom: DEFAULT_GRAD_FROM, gradientTo: DEFAULT_GRAD_TO,
    paletteColors: DEFAULT_PALETTE, colorByValueBelowZero: DEFAULT_BELOW_ZERO, fillOpacity: DEFAULT_FILL_OPACITY,
    strokeColor: DEFAULT_STROKE, barStrokeWidth: DEFAULT_STROKE_WIDTH,
    reveal: 1, growLagRatio: 0.5, growEase: "cubic", growDirection: "index-ascending", labelSize: DEFAULT_LABEL_SIZE,
    opacity: 1,
  },
  inspector: [
    ...bundle("positioning"),
    { key: "mode", label: "Mode", kind: "select", options: MODES, optionLabels: MODE_LABELS, category: CAT, help: "Direct: bar i's height = f(i). Riemann: sample f(x) over [xStart, xEnd] (area under the curve). Literal: explicit comma-separated values." },
    { key: "barCount", label: "Bar count", kind: "number", min: 1, category: CAT, help: "How many bars (direct/riemann modes). DISCRETE — it snaps between integers rather than smoothly interpolating; author a refinement sequence (4→8→16→32) as per-slide keyframes." },
    // `code: {language}` — the row aspect that puts the `{}` full-screen-editor
    // button IN this row (core/properties.js), replacing the full-width "Edit in
    // code editor…" action row that used to follow it.
    { key: "valueEquation", label: "Value equation", kind: "text", category: CAT, code: { language: "javascript" }, help: "JavaScript for each bar's value: sees `i` (direct) or `x` (riemann), plus `time`, N and vars. Use `**`/pow() for powers. Bind with '=', or open the {} button for the full-screen editor." },
    { key: "barValues", label: "Literal values", kind: "text", category: CAT, help: "Comma-separated bar values for Literal mode, e.g. '2, 5, 9, 14'." },
    { key: "barNames", label: "Bar labels", kind: "text", category: CAT, help: "Comma-separated labels drawn under each bar, e.g. 'Q1, Q2, Q3'. Leave blank for none." },
    { key: "xStart", label: "x start", kind: "number", category: CAT, help: "Riemann domain start." },
    { key: "xEnd", label: "x end", kind: "number", category: CAT, help: "Riemann domain end." },
    { key: "inputSampleType", label: "Sample point", kind: "select", options: SAMPLE_TYPES, optionLabels: SAMPLE_LABELS, category: CAT, help: "Where in each interval f(x) is sampled: left edge, right edge, or midpoint (the true midpoint rule)." },
    { key: "yRange", label: "Value range", kind: "text", category: CAT, help: "[min, max, step] mapping bar values to pixel height. Authored once and fixed (no autoscale) so bars don't jump as the reveal grows." },
    { key: "baselineY", label: "Baseline", kind: "number", category: CAT, help: "The value bars grow FROM (default 0). Bars for negative values grow the other way." },
    { key: "orientation", label: "Orientation", kind: "select", options: ORIENTS, optionLabels: ORIENT_LABELS, category: CAT, help: "Vertical bars grow up; horizontal bars grow right." },
    { key: "barWidthFraction", label: "Bar width", kind: "number", min: 0, max: 1, category: CAT, help: "Fraction of each slot the bar fills (the rest is gap). 1.0 = flush bars (true Riemann rectangles / histogram)." },
    { key: "barOverlapFudge", label: "Anti-seam", kind: "number", min: 1, category: CAT, help: "Slightly overscales each bar's width (Manim's 1.001) so adjacent flush bars show no hairline seam." },
    ...props("cornerRadius", { cornerRadius: { label: "Corner radius", category: CAT, help: "Rounds bar corners. Large values make pill/rounded-top bars." } }),
    { key: "colorMode", label: "Color mode", kind: "select", options: COLOR_MODES, optionLabels: COLOR_MODE_LABELS, category: CAT, help: "Solid: one color. Gradient across bars: from→to across the index. Palette cycle: cycle a color list. By sign: negative bars use the below-zero color." },
    { key: "barColor", label: "Bar color", kind: "color", category: CAT, help: "The solid / positive bar color." },
    { key: "gradientFrom", label: "Gradient from", kind: "color", category: CAT, help: "Start color for the gradient-across-bars mode." },
    { key: "gradientTo", label: "Gradient to", kind: "color", category: CAT, help: "End color for the gradient-across-bars mode." },
    { key: "paletteColors", label: "Palette", kind: "text", category: CAT, help: "Comma-separated colors cycled in palette mode, e.g. '#003f5c, #58508d, #bc5090'." },
    { key: "colorByValueBelowZero", label: "Negative color", kind: "color", category: CAT, help: "Color for bars whose value is negative (by-sign mode) — the signed-area convention." },
    { key: "fillOpacity", label: "Fill opacity", kind: "number", min: 0, max: 1, category: CAT, help: "Bar fill opacity. 0.7 (categorical) by default; Riemann presets set 1.0." },
    { key: "strokeColor", label: "Bar outline", kind: "color", category: CAT, help: "Color of the outline around each bar." },
    { key: "barStrokeWidth", label: "Outline width", kind: "number", min: 0, category: CAT, help: "Thickness of each bar's outline (0 for none)." },
    { key: "reveal", label: "Reveal", kind: "number", min: 0, max: 1, category: CAT, help: "How grown the bars are, 0..1 — THE entrance driver. Keyframe 0→1 across a slide and the bars grow up, Manim-style." },
    { key: "growLagRatio", label: "Stagger", kind: "number", min: 0, max: 1, category: CAT, help: "0 grows all bars together; 1 grows them strictly one after another (a cascade). Between = a smooth blend." },
    { key: "growEase", label: "Grow ease", kind: "select", options: EASES, category: CAT, help: "Easing applied to each bar's grow-up." },
    { key: "growDirection", label: "Grow order", kind: "select", options: GROW_DIRS, optionLabels: GROW_DIR_LABELS, category: CAT, help: "The order bars grow in when staggered." },
    { key: "labelSize", label: "Label size", kind: "number", min: 1, category: CAT, help: "Font size of the bar labels." },
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
  ],
  /**
   * Query (samples the value equation). State → one rect op per bar (+ label text
   * ops), or the loud red error box on an equation failure. A zero-height bar
   * (reveal 0, or a value at the baseline) emits a degenerate rect the backend
   * skips.
   */
  emit(s) {
    const { rects, labels, error } = barGeometry(s);
    if (error) return errorAffordance(s.w ?? 0, s.h ?? 0, `Graph error: ${error}`);
    const opacity = (s.opacity ?? 1) * (s.fillOpacity ?? DEFAULT_FILL_OPACITY);
    const cr = s.cornerRadius ?? 0;
    const sw = s.barStrokeWidth ?? 0;
    const ops = rects.map((r) => rect({
      x: r.x, y: r.y, w: r.w, h: r.h,
      cornerRadius: Math.min(cr, Math.min(r.w, r.h) / 2),
      fill: r.color, stroke: sw > 0 ? s.strokeColor : null, strokeWidth: sw, opacity,
    }));
    for (const l of labels)
      ops.push(text({ text: l.text, x: l.x, y: l.y, size: l.size, color: s.barColor ?? DEFAULT_BAR_COLOR, opacity: s.opacity ?? 1 }));
    return ops;
  },
  /**
   * Query (samples the value equation). THE MORPH OUTLINE (core/registry.js's
   * `morphPaths` protocol): one cubic contour per BAR, from the SAME
   * `barGeometry` emit() draws with, through `rectPathD` — which is this
   * codebase's one spelling of "a rect's outline" (core/svg_paths.js uses it to
   * flatten an SVG `<rect>`, and plugins/rect.js's own provider is the same call).
   *
   * THE CORNER RADIUS AND THE REVEAL BOTH RIDE ALONG, because both are already in
   * the geometry: `barGeometry` returns the bar's CURRENT height at its current
   * `reveal`, and the radius is capped per bar exactly as emit() caps it. A bar
   * chart caught mid-grow morphs from what is on screen, not from its finished
   * state.
   *
   * ONE SUBPATH PER BAR is the whole point of declaring here at all — a bar chart
   * flowing into a row of circles should pair bar-to-circle, which is what makes
   * this widget worth a morph rather than a crossfade.
   *
   * THE LABELS ARE NOT IN THE PAYLOAD: they are `text` ops, and text morphs
   * through the glyph-outline seam, not by a plugin inventing letterforms.
   */
  morphPaths(s) {
    const { rects } = barGeometry(s);
    const cr = s.cornerRadius ?? 0;
    const sw = s.barStrokeWidth ?? 0;
    return morphPayloadFromPaths(
      rects.map((r) => {
        const radius = Math.min(cr, Math.min(r.w, r.h) / 2);
        return {
          d: rectPathD(r.x, r.y, r.w, r.h, radius, radius),
          paint: { fill: r.color ?? null, stroke: sw > 0 ? (s.strokeColor ?? null) : null, strokeWidth: sw, opacity: (s.opacity ?? 1) * (s.fillOpacity ?? DEFAULT_FILL_OPACITY) },
        };
      }),
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  /** Query (samples the value equation). Why this chart cannot morph YET, or
   * null. It shares `barGeometry` with emit(), so the gate cannot disagree with
   * what is drawn: an equation ERROR draws the red notice box, which is a notice
   * and not ink, and a chart with no bars has nothing to pair. */
  morphNotReady(s) {
    const { rects, error } = barGeometry(s);
    if (error) return `values that evaluate (this chart fails: ${error})`;
    return rects.some((r) => r.w > 0 && r.h > 0) ? null : "at least one bar with extent (this chart draws nothing)";
  },
  localBounds(state) {
    const { rects } = barGeometry(state);
    const reachBelow = (state.barNames ?? "").trim() ? (state.labelSize ?? DEFAULT_LABEL_SIZE) + LABEL_PAD * 2 : 0;
    if (!rects.length) return { x: 0, y: 0, w: state.w ?? 0, h: (state.h ?? 0) + reachBelow };
    let minX = 0, minY = 0, maxX = state.w ?? 0, maxY = (state.h ?? 0) + reachBelow;
    for (const r of rects) { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  // The plot FRAME's border. This used to CLAMP the query into the box, which is
  // not the same map: a clamp returns an INTERIOR query unchanged, so
  // closest_to_rim against an overlapping widget answered with a point inside the
  // chart instead of on its edge. closestPointOnRectBorder is the projection —
  // five widgets now share the one spelling of it. Pinned by
  // tests/anchor_ink_test.js section 7.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 }, local.x, local.y);
  },
  presetFamilies: [{ id: "bars", title: "Bar presets", presets: GRAPH_BARS_PRESETS }],
  commands: [
    { id: "add-graph-bars", title: "Add Graph Bars", icon: "mdi:chart-bar", run: (app) => app.armCrosshairPlacement(graphBarsPlugin) },
  ],
};
