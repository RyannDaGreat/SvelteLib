/**
 * GRAPH TICK MARKS — the RULER (manifest item 66): "a ruler widget that measures
 * tick points like 0 1 2 3 4 5 on either the x, the y or both axes… very much
 * like Matplotlib." Driven entirely by the shared data window (`xRange`/`yRange`)
 * and the core scale module, so a graphTickMarks, a graphGrid and a graphLine
 * authored with the SAME ranges line up exactly.
 *
 * ── THE MAXIMALIST KNOB SET (digest 01, tiered A + much of B) ──────────────────
 * Axis selection (x/y/both), spine position (zero-line "math textbook" vs box
 * edge), axis line color/width, Manim-style arrow TIPS (includeTip), major +
 * minor ticks with direction/length/width/color, the AutoMinorLocator 4-vs-5
 * subdivision rule, numeric labels with auto/fixed/percent/scientific formatting,
 * skip-every-N label thinning (the pragmatic collision knob — matplotlib has no
 * auto-avoidance, digest 01 trap #8), prefix/suffix, and origin-tick suppression.
 *
 * ── LOAD-BEARING CORRECTNESS ──────────────────────────────────────────────────
 * Tick VALUES come from core/graph_scale (integer-index × rational step, never a
 * float accumulator — digest 01 trap #1) and labels round to the step's own
 * precision with a negative-zero clamp (trap #11). Ticks and axis lines are
 * stroked ops, so the universal STROKE_TRIM_KEYS draw them on with a keyframe
 * (the ruler snakes in too); labels are text ops (untrimmable, drawn whole).
 *
 * No plugin imports another: composition is through the shared core scale module
 * and the shared data-window convention, never a cross-plugin import.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { parseRange, dataToLocal, tickValues, minorTickValues, minorSubdivisions, formatTick } from "../core/graph_scale.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { morphPayloadFromPaths } from "../core/morph_payload.js";
import * as T from "../core/transform.js";
import { path, text } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";
import { GRAPH_TICK_PRESETS } from "./graph_presets.js";

const CAT = "formatting";
const AXES = ["x", "y", "both"];
const AXIS_LABELS = { x: "X only", y: "Y only", both: "Both axes" };
const SPINE_MODES = ["zero", "edge"];
const SPINE_LABELS = { zero: "At value 0 (centered)", edge: "At the box edge" };
const TICK_DIRS = ["out", "in", "inout"];
const TICK_DIR_LABELS = { out: "Outward", in: "Inward", inout: "Both sides" };
const FORMATS = ["auto", "fixed", "percent", "scientific"];
const FORMAT_LABELS = { auto: "Auto (step precision)", fixed: "Fixed decimals", percent: "Percent", scientific: "Scientific" };

const DEFAULT_AXIS_COLOR = "#DDEEFF"; // near-white ink on a dark deck (Manim look)
const DEFAULT_TICK_COLOR = "#DDEEFF";
const DEFAULT_LABEL_COLOR = "#DDEEFF";
const DEFAULT_AXIS_WIDTH = 2;
const DEFAULT_TICK_WIDTH = 2;
const DEFAULT_MAJOR_LEN = 10;
const DEFAULT_MINOR_LEN = 5;
const DEFAULT_LABEL_SIZE = 16;
const DEFAULT_TIP_SIZE = 12;
const LABEL_PAD = 6; // gap between a tick and its label (local units)

/** Approximate mean glyph advance as a fraction of font size, for a proportional
 *  digit string — used to CENTER a label without a DOM text-measure (the bare-
 *  node renderer has none). Good enough to visually center short numeric labels;
 *  perfect metrics would need the font, which core cannot load. */
const GLYPH_ADVANCE_RATIO = 0.55;

/**
 * Pure function. The LOCAL position of the two axis lines for a data window:
 * `{axisX, axisY}`, where `axisY` is the local y of the horizontal (x-)axis and
 * `axisX` the local x of the vertical (y-)axis. "zero" spine puts each axis at
 * data value 0 when 0 is inside the range (clamped to the box otherwise — the
 * value can never fall off the widget); "edge" pins the x-axis to the bottom and
 * the y-axis to the left.
 *
 * @param {object} win - {xmin, xmax, ymin, ymax}
 * @param {number} w - local width
 * @param {number} h - local height
 * @param {string} spine - "zero" | "edge"
 * @returns {{axisX: number, axisY: number}}
 *
 * @example axisPositions({xmin: -5, xmax: 5, ymin: -5, ymax: 5}, 200, 200, "zero") // {axisX: 100, axisY: 100}
 * @example axisPositions({xmin: 0, xmax: 10, ymin: 0, ymax: 10}, 200, 200, "edge") // {axisX: 0, axisY: 200}
 * @example axisPositions({xmin: 0, xmax: 10, ymin: 0, ymax: 10}, 200, 200, "zero") // {axisX: 0, axisY: 200}
 */
export function axisPositions(win, w, h, spine) {
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  if (spine === "edge") return { axisX: 0, axisY: h };
  return {
    axisX: clamp(dataToLocal(0, win.xmin, win.xmax, w, false), w),
    axisY: clamp(dataToLocal(0, win.ymin, win.ymax, h, true), h),
  };
}

/**
 * Pure function. A single tick MARK segment as `[[x0, y0], [x1, y1]]` in local
 * units. `axis` is "x" (a vertical mark straddling the horizontal axis) or "y"
 * (a horizontal mark straddling the vertical axis); `along` is the tick's local
 * position along its axis; `base` is the local position of the axis line it sits
 * on; `len`/`dir` set the mark's reach and side ("out" = away from the positive
 * quadrant, "in" = toward it, "inout" = centered).
 *
 * @param {string} axis - "x" | "y"
 * @param {number} along - tick position along the axis (local)
 * @param {number} base - the axis line's cross position (local)
 * @param {number} len - mark length
 * @param {string} dir - "out" | "in" | "inout"
 * @returns {number[][]} [[x0, y0], [x1, y1]]
 *
 * @example tickMark("x", 40, 100, 10, "out") // [[40, 100], [40, 110]]
 * @example tickMark("x", 40, 100, 10, "in") // [[40, 90], [40, 100]]
 * @example tickMark("x", 40, 100, 10, "inout") // [[40, 95], [40, 105]]
 * @example tickMark("y", 60, 30, 10, "out") // [[30, 60], [20, 60]]
 */
export function tickMark(axis, along, base, len, dir) {
  const lo = dir === "in" ? -len : dir === "inout" ? -len / 2 : 0;
  const hi = dir === "out" ? len : dir === "inout" ? len / 2 : 0;
  // x-axis mark grows DOWN (+y) for "out"; y-axis mark grows LEFT (−x) for "out".
  if (axis === "x") return [[along, base + lo], [along, base + hi]];
  return [[base - lo, along], [base - hi, along]];
}

/**
 * Pure function. A filled arrowhead TRIANGLE at an axis's positive end
 * (Manim includeTip) as an SVG path `d`. `axis` "x" points right at (w, base);
 * "y" points up at (base, 0). `size` is the tip length.
 *
 * @example axisTipD("x", 100, 200, 12) // "M200 100 L188 106 L188 94 Z"
 * @example axisTipD("y", 50, 0, 12) // "M50 0 L44 12 L56 12 Z"
 */
export function axisTipD(axis, base, end, size) {
  const hw = size / 2;
  if (axis === "x") return `M${end} ${base} L${end - size} ${base + hw} L${end - size} ${base - hw} Z`;
  return `M${base} ${end} L${base - hw} ${end + size} L${base + hw} ${end + size} Z`;
}

/** Pure helper. The major step for an axis = the range's own 3rd tuple value. */
function majorStepOf(range) {
  return range.step > 0 ? range.step : 1;
}

export const graphTickMarksPlugin = {
  type: "graph_tick_marks",
  ephemeral: EPHEMERAL.NONE,
  title: "Graph Ticks",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "graph_tick_marks", x: 120, y: 120, w: 400, h: 300, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    xRange: "[0, 5, 1]", yRange: "[0, 5, 1]",
    axes: "both", spine: "zero",
    axisColor: DEFAULT_AXIS_COLOR, axisWidth: DEFAULT_AXIS_WIDTH, showAxisLine: true,
    includeTip: false, tipSize: DEFAULT_TIP_SIZE,
    showTicks: true, tickDirection: "out", majorTickLength: DEFAULT_MAJOR_LEN, tickWidth: DEFAULT_TICK_WIDTH, tickColor: DEFAULT_TICK_COLOR,
    showMinorTicks: false, minorSubdivisions: 0, minorTickLength: DEFAULT_MINOR_LEN,
    showLabels: true, labelFormat: "auto", labelDecimals: -1, labelSize: DEFAULT_LABEL_SIZE, labelColor: DEFAULT_LABEL_COLOR,
    labelPrefix: "", labelSuffix: "", skipEveryN: 1, excludeOriginTick: false,
    opacity: 1,
  },
  inspector: [
    ...bundle("transform"),
    { key: "xRange", label: "X data range", kind: "text", category: CAT, help: "[min, max, step] mapped across the box width. The step is the spacing between major ticks. Share it with a graphLine/graphGrid to line them up." },
    { key: "yRange", label: "Y data range", kind: "text", category: CAT, help: "[min, max, step] mapped across the box height (math up-is-positive)." },
    { key: "axes", label: "Axes", kind: "select", options: AXES, optionLabels: AXIS_LABELS, category: CAT, help: "Which axes to draw: x, y, or both." },
    { key: "spine", label: "Axis position", kind: "select", options: SPINE_MODES, optionLabels: SPINE_LABELS, category: CAT, help: "Where the axis lines sit: at data value 0 (the centered math-textbook look) or at the box edge (a boxed plot)." },
    { key: "showAxisLine", label: "Show axis line", kind: "boolean", category: CAT, help: "Draw the axis line itself (turn off for ticks-only)." },
    { key: "axisColor", label: "Axis color", kind: "color", category: CAT, help: "Color of the axis line(s)." },
    { key: "axisWidth", label: "Axis width", kind: "number", min: 0, category: CAT, help: "Thickness of the axis line(s)." },
    { key: "includeTip", label: "Arrow tips", kind: "boolean", category: CAT, help: "Add a Manim-style arrowhead at the positive end of each axis." },
    { key: "tipSize", label: "Tip size", kind: "number", min: 0, category: CAT, help: "Length of the axis arrowheads." },
    { key: "showTicks", label: "Show ticks", kind: "boolean", category: CAT, help: "Draw the major tick marks." },
    { key: "tickDirection", label: "Tick direction", kind: "select", options: TICK_DIRS, optionLabels: TICK_DIR_LABELS, category: CAT, help: "Which side of the axis the tick marks extend: outward, inward, or both (the centered Manim look)." },
    { key: "majorTickLength", label: "Major tick length", kind: "number", min: 0, category: CAT, help: "Length of the major tick marks in pixels." },
    { key: "tickWidth", label: "Tick width", kind: "number", min: 0, category: CAT, help: "Thickness of the tick marks." },
    { key: "tickColor", label: "Tick color", kind: "color", category: CAT, help: "Color of the tick marks." },
    { key: "showMinorTicks", label: "Show minor ticks", kind: "boolean", category: CAT, help: "Add shorter minor ticks between the major ones." },
    { key: "minorSubdivisions", label: "Minor subdivisions", kind: "number", min: 0, category: CAT, help: "Minor intervals per major interval. 0 = auto (matplotlib's 4-or-5 rule based on the step)." },
    { key: "minorTickLength", label: "Minor tick length", kind: "number", min: 0, category: CAT, help: "Length of the minor tick marks." },
    { key: "showLabels", label: "Show labels", kind: "boolean", category: CAT, help: "Draw the numeric labels at each major tick." },
    { key: "labelFormat", label: "Label format", kind: "select", options: FORMATS, optionLabels: FORMAT_LABELS, category: CAT, help: "Auto rounds to the step's precision; Fixed uses a set decimal count; Percent shows a 0..1 fraction as %; Scientific uses 1e3 notation." },
    { key: "labelDecimals", label: "Label decimals", kind: "number", category: CAT, help: "Decimal places for the Fixed/Scientific formats. -1 = derive from the step." },
    { key: "labelSize", label: "Label size", kind: "number", min: 1, category: CAT, help: "Font size of the tick labels." },
    { key: "labelColor", label: "Label color", kind: "color", category: CAT, help: "Color of the tick labels." },
    { key: "labelPrefix", label: "Label prefix", kind: "text", category: CAT, help: "Text prepended to every label (e.g. '$')." },
    { key: "labelSuffix", label: "Label suffix", kind: "text", category: CAT, help: "Text appended to every label (e.g. '°' or 'ms')." },
    { key: "skipEveryN", label: "Label every N", kind: "number", min: 1, category: CAT, help: "Draw a label only every Nth major tick — the pragmatic way to thin dense labels (matplotlib has no auto collision-avoidance)." },
    { key: "excludeOriginTick", label: "Hide origin tick", kind: "boolean", category: CAT, help: "Suppress the redundant '0' where the axes cross." },
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
  ],
  /**
   * Query (reads only its own numeric state — no clock). State → display-list:
   * axis lines + tips (one path), major ticks (one stroked path so trim snakes
   * them on), minor ticks (one path), and label text ops. Everything derives from
   * the shared scale module, so ticks land on integer-index × step values (never
   * a float accumulator) and labels round to the step's precision.
   */
  emit(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const xr = parseRange(s.xRange ?? "[0, 5, 1]");
    const yr = parseRange(s.yRange ?? "[0, 5, 1]");
    const win = { xmin: xr.min, xmax: xr.max, ymin: yr.min, ymax: yr.max };
    const { axisX, axisY } = axisPositions(win, w, h, s.spine ?? "zero");
    const doX = (s.axes ?? "both") !== "y";
    const doY = (s.axes ?? "both") !== "x";
    const opacity = s.opacity ?? 1;
    const ops = [];

    const { axisSubpaths, tipDs, majorMarks, minorMarks, xMajor, yMajor } = rulerGeometry(s);
    if (axisSubpaths.length)
      ops.push(path({ d: subpathsD(axisSubpaths), stroke: s.axisColor, strokeWidth: s.axisWidth ?? DEFAULT_AXIS_WIDTH, opacity }));
    if (tipDs.length)
      ops.push(path({ d: tipDs.join(" "), fill: s.axisColor, opacity }));
    if (majorMarks.length) ops.push(path({ d: subpathsD(majorMarks), stroke: s.tickColor, strokeWidth: s.tickWidth ?? DEFAULT_TICK_WIDTH, opacity }));
    if (minorMarks.length) ops.push(path({ d: subpathsD(minorMarks), stroke: s.tickColor, strokeWidth: (s.tickWidth ?? DEFAULT_TICK_WIDTH) * 0.7, opacity }));

    // ── labels ──
    if (s.showLabels !== false) {
      const size = s.labelSize ?? DEFAULT_LABEL_SIZE;
      const fmt = { format: s.labelFormat ?? "auto", prefix: s.labelPrefix ?? "", suffix: s.labelSuffix ?? "", decimals: (s.labelDecimals ?? -1) >= 0 ? s.labelDecimals : undefined };
      const skip = Math.max(1, Math.floor(s.skipEveryN ?? 1));
      const reach = (s.majorTickLength ?? DEFAULT_MAJOR_LEN) + LABEL_PAD;
      xMajor.forEach((v, i) => {
        if (i % skip !== 0) return;
        if (s.excludeOriginTick && Math.abs(v) < 1e-9) return;
        const str = formatTick(v, { ...fmt, step: majorStepOf(xr) });
        const lx = dataToLocal(v, xr.min, xr.max, w, false) - (str.length * size * GLYPH_ADVANCE_RATIO) / 2;
        ops.push(text({ text: str, x: lx, y: axisY + reach, size, color: s.labelColor ?? DEFAULT_LABEL_COLOR, opacity }));
      });
      yMajor.forEach((v, i) => {
        if (i % skip !== 0) return;
        if (s.excludeOriginTick && Math.abs(v) < 1e-9) return;
        const str = formatTick(v, { ...fmt, step: majorStepOf(yr) });
        const lx = axisX - reach - str.length * size * GLYPH_ADVANCE_RATIO;
        ops.push(text({ text: str, x: lx, y: dataToLocal(v, yr.min, yr.max, h, true) - size / 2, size, color: s.labelColor ?? DEFAULT_LABEL_COLOR, opacity }));
      });
    }
    return ops;
  },
  /**
   * Query (reads only its own numeric state). THE MORPH OUTLINE
   * (core/registry.js's `morphPaths` protocol): the axes, their arrow tips and
   * every tick, as cubic contours, from the SAME `rulerGeometry` + `subpathsD`
   * pair emit() draws with.
   *
   * THE LABELS ARE NOT IN THE PAYLOAD. They are `text` ops, and text becomes
   * morphable through the glyph-outline seam (core/glyph_outlines.js), not by a
   * plugin inventing letterforms; a ruler whose numerals stayed put while its
   * ticks flowed would be worse than one that hands over its rulings alone. This
   * is the same line plaintext/latex sit on the other side of, and if the seam
   * ever becomes cheap to call from here the labels can join without changing
   * anything else.
   *
   * ONE SUBPATH PER MARK, not one per op group: emit() batches every major tick
   * into a single `path` for stroke-trim's sake, but the aligner pairs subpaths,
   * and a ruler morphing into a comb should pair tick-to-tooth.
   */
  morphPaths(s) {
    const { axisSubpaths, tipDs, majorMarks, minorMarks } = rulerGeometry(s);
    const stroke = { fill: null, stroke: s.tickColor ?? null, strokeWidth: s.tickWidth ?? DEFAULT_TICK_WIDTH, opacity: s.opacity ?? 1 };
    const axisPaint = { fill: null, stroke: s.axisColor ?? null, strokeWidth: s.axisWidth ?? DEFAULT_AXIS_WIDTH, opacity: s.opacity ?? 1 };
    return morphPayloadFromPaths(
      [
        ...axisSubpaths.map((sp) => ({ d: subpathsD([sp]), paint: axisPaint })),
        // A tip is FILLED, not stroked — it is the one solid contour on the ruler.
        ...tipDs.map((d) => ({ d, paint: { fill: s.axisColor ?? null, stroke: null, strokeWidth: 0, opacity: s.opacity ?? 1 } })),
        ...[...majorMarks, ...minorMarks].map((m) => ({ d: subpathsD([m]), paint: stroke })),
      ],
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  /** Pure function. Why this ruler cannot morph YET, or null — emit()'s own
   * "nothing drawn" case, with the labels excluded for the reason morphPaths
   * gives: a ruler showing only numerals has no outline to pair. */
  morphNotReady(s) {
    const { axisSubpaths, tipDs, majorMarks, minorMarks } = rulerGeometry(s);
    return axisSubpaths.length + tipDs.length + majorMarks.length + minorMarks.length > 0
      ? null : "an axis or a tick (this ruler draws only labels)";
  },
  // Ink can reach past the box (labels below/left, tips beyond the ends): report a
  // generous inflated rect so culling/capture never clip a visible label.
  localBounds(state) {
    const reach = (state.majorTickLength ?? DEFAULT_MAJOR_LEN) + (state.labelSize ?? DEFAULT_LABEL_SIZE) * 2 + LABEL_PAD + (state.tipSize ?? 0);
    return { x: -reach, y: -reach, w: (state.w ?? 0) + 2 * reach, h: (state.h ?? 0) + 2 * reach };
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
  presetFamilies: [{ id: "rulers", title: "Ruler presets", presets: GRAPH_TICK_PRESETS }],
  commands: [
    { id: "add-graph-ticks", title: "Add Graph Ticks", icon: "mdi:ruler", run: (app) => app.armCrosshairPlacement(graphTickMarksPlugin) },
  ],
};

/**
 * Pure function. THE RULER'S VECTOR GEOMETRY in box-local space — the ONE
 * sampler emit() and `morphPaths` share. Labels are NOT here: they are `text`
 * ops, a different kind of ink with a different seam.
 *
 * IT WAS INLINE IN emit() UNTIL THIS COMMIT, and extracting it is what lets this
 * widget morph honestly. core/registry.js's protocol says "derive the payload
 * from the ink, never alongside it" — a provider that rebuilt these ticks from
 * the same ranges would be a second spelling free to drift from the drawn one,
 * and the drift would show only as a morph flowing into a ruler nobody sees.
 * `xMajor`/`yMajor` come back too because emit()'s label pass needs exactly the
 * tick VALUES this computed, and recomputing them there would reintroduce the
 * same duplication one level down.
 *
 * Args:
 *   s (object): the widget's folded state
 *
 * Returns:
 *   {axisSubpaths, tipDs, majorMarks, minorMarks, xMajor, yMajor} — segments as
 *   [[x0,y0],[x1,y1]], tips as `d` strings (they are filled triangles, not
 *   segments), and the two tick-value lists
 *
 * Examples:
 *     >>> // the default both-axes ruler: two axis lines
 *     >>> rulerGeometry({w: 200, h: 200}).axisSubpaths.length
 *     2
 *     >>> // axes off leaves the ticks alone
 *     >>> rulerGeometry({w: 200, h: 200, showAxisLine: false}).axisSubpaths.length
 *     0
 */
export function rulerGeometry(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const xr = parseRange(s.xRange ?? "[0, 5, 1]");
  const yr = parseRange(s.yRange ?? "[0, 5, 1]");
  const win = { xmin: xr.min, xmax: xr.max, ymin: yr.min, ymax: yr.max };
  const { axisX, axisY } = axisPositions(win, w, h, s.spine ?? "zero");
  const doX = (s.axes ?? "both") !== "y";
  const doY = (s.axes ?? "both") !== "x";

  // ── axis lines + arrow tips ──
  const axisSubpaths = [];
  const tipDs = [];
  if (s.showAxisLine !== false && (s.axisWidth ?? 0) > 0) {
    if (doX) axisSubpaths.push([[0, axisY], [w, axisY]]);
    if (doY) axisSubpaths.push([[axisX, 0], [axisX, h]]);
  }
  if (s.includeTip && (s.tipSize ?? 0) > 0) {
    if (doX) tipDs.push(axisTipD("x", axisY, w, s.tipSize));
    if (doY) tipDs.push(axisTipD("y", axisX, 0, s.tipSize));
  }

  // ── tick values (integer-index × step) ──
  const xMajor = doX ? tickValues(xr.min, xr.max, majorStepOf(xr)) : [];
  const yMajor = doY ? tickValues(yr.min, yr.max, majorStepOf(yr)) : [];

  // ── major tick marks ──
  const majorMarks = [];
  if (s.showTicks !== false && (s.majorTickLength ?? 0) > 0) {
    for (const v of xMajor) {
      if (s.excludeOriginTick && Math.abs(v) < 1e-9) continue;
      majorMarks.push(tickMark("x", dataToLocal(v, xr.min, xr.max, w, false), axisY, s.majorTickLength, s.tickDirection ?? "out"));
    }
    for (const v of yMajor) {
      if (s.excludeOriginTick && Math.abs(v) < 1e-9) continue;
      majorMarks.push(tickMark("y", dataToLocal(v, yr.min, yr.max, h, true), axisX, s.majorTickLength, s.tickDirection ?? "out"));
    }
  }

  // ── minor tick marks ──
  const minorMarks = [];
  if (s.showMinorTicks && (s.minorTickLength ?? 0) > 0) {
    if (doX) {
      const sub = (s.minorSubdivisions ?? 0) > 0 ? s.minorSubdivisions : minorSubdivisions(majorStepOf(xr));
      for (const v of minorTickValues(xr.min, xr.max, majorStepOf(xr), sub))
        minorMarks.push(tickMark("x", dataToLocal(v, xr.min, xr.max, w, false), axisY, s.minorTickLength, s.tickDirection ?? "out"));
    }
    if (doY) {
      const sub = (s.minorSubdivisions ?? 0) > 0 ? s.minorSubdivisions : minorSubdivisions(majorStepOf(yr));
      for (const v of minorTickValues(yr.min, yr.max, majorStepOf(yr), sub))
        minorMarks.push(tickMark("y", dataToLocal(v, yr.min, yr.max, h, true), axisX, s.minorTickLength, s.tickDirection ?? "out"));
    }
  }
  return { axisSubpaths, tipDs, majorMarks, minorMarks, xMajor, yMajor };
}

/** Pure helper. An SVG `d` for a set of two-point segments (each its own M/L
 *  subpath) — the multi-tick / multi-axis path builder. */
function subpathsD(segments) {
  return segments.map(([a, b]) => `M${round(a[0])} ${round(a[1])} L${round(b[0])} ${round(b[1])}`).join(" ");
}
function round(v) { return +v.toFixed(3); }
