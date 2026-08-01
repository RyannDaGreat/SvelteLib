/**
 * GRAPH LINE — the PARAMETERIZED-CURVE widget (manifest items 63/64): "the
 * parameterized polygon widget… instead of a list of parameters for each point,
 * tStart, tEnd, number of points, interpolate between those." An equation is
 * sampled over `[tStart, tEnd]` at `numPoints` samples → a polyline mapped through
 * a data window (`xRange`/`yRange`) into the widget's local box, emitted as ONE
 * `path` op. Used for "sine waves and stuff that can wiggle and swiggle around the
 * whole screen."
 *
 * ── INHERITS FROM POLYGON WITHOUT IMPORTING IT ────────────────────────────────
 * "Inherit from the polygon widget" = share the SAME shape (one `path` op, bbox
 * anchors, registry-injected effects, the universal stroke-trim rows) and the
 * SAME core geometry (core/outline distToSegment / subpathsBBox), NOT a JS import
 * — no plugin may import another (core/registry.js). polygon stores its data as a
 * vertex list; graphLine stores an EQUATION and samples it, so it is polygon's
 * sibling, not a shapeshifter family (a curve's data is unbounded — the exact
 * reason polygon.js gives for standing alone).
 *
 * ── ONE Monaco SOURCE, THREE MODES (digest 05 sugar) ──────────────────────────
 * `source` is ONE JavaScript equation, edited inline OR in the full-screen Monaco
 * editor via the declarative `codeEditor` descriptor (the mermaid code-button
 * pattern). `mode` interprets its return (core/graph_equation.sampleCurve):
 *   parametric → returns [x, y]      explicit → returns y (x = t)     polar → returns r
 * so polar and explicit are pure sugar over one parametric core (GeoGebra
 * precedent). `t` is the plot domain; `time` is the presentation clock — DIFFERENT
 * meanings, both available (a `time`-reading source is RECORDABLE state, seekable,
 * Δt=0-stable). `^` is JavaScript XOR, not power — use `**` or `pow()`.
 *
 * ── DRAW-IN IS FREE (digest 05 / report 07 §4) ────────────────────────────────
 * The widget spreads STROKE_TRIM_KEYS, so keyframing `strokeEnd` 0 → 1 draws the
 * curve on "like on a chalkboard" with ZERO widget render code — the trim is
 * stamped universally at the ports seam. Widening tStart→tEnd across slides is a
 * second, independent draw-in (the curve grows its domain), also free (ordinary
 * tweened numbers). Both compose with every fill/stroke material and bloom.
 *
 * ── DISCONTINUITIES (digest 05 Tier A) ────────────────────────────────────────
 * `jumpThreshold` (LOCAL pixels) breaks the polyline where consecutive samples
 * jump farther than it — the pragmatic asymptote heuristic (a `tan` graph does
 * not streak a line across the frame). A non-finite sample (∞/NaN) is always a
 * break. 0 = never break (the continuous-curve default). This is why emit is ONE
 * `path` op with SEVERAL M-started subpaths.
 *
 * ── ERRORS ARE WHOLE-CURVE AND LOUD ───────────────────────────────────────────
 * A source that fails to compile, or throws on the first sample, renders the
 * shared red error box (core/graph_equation.errorAffordance) — never a silently
 * holed or blank curve.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { pointInPolygon, distToSegment, subpathsBBox } from "../core/outline.js";
import { parseRange, dataToLocal, breakSubpaths, polylinePathD } from "../core/graph_scale.js";
import { sampleCurve, errorAffordance, DEFAULT_NUM_POINTS } from "../core/graph_equation.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import * as T from "../core/transform.js";
import { path } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";
import { GRAPH_LINE_PRESETS } from "./graph_presets.js";

const CAT_EQ = "text";          // groups source + code button with mermaid-style "text" rows
const CAT_FMT = "formatting";   // groups the plotting knobs

const MODES = ["parametric", "explicit", "polar"];
const MODE_LABELS = { parametric: "Parametric [x, y]", explicit: "Explicit y = f(x)", polar: "Polar r(θ)" };

/** A fresh graphLine draws a couple of sine periods — instantly recognizable as
 *  "a graph you can rewrite", the way polygon's default pentagon reads as "a
 *  shape you can drag". */
const DEFAULT_SOURCE = "Math.sin(x)";
const DEFAULT_STROKE = "#58C4DD"; // Manim BLUE_C (digest 02) — visibly its own family
const DEFAULT_STROKE_WIDTH = 3;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Fewest points that draw a segment. */
const MIN_DRAWN = 2;

/**
 * Pure function. A state's DATA WINDOW as `{xmin, xmax, ymin, ymax}`, parsed from
 * the `xRange`/`yRange` 3-tuples (the shared graph-family convention). Absent
 * ranges fall back to a unit window so a half-authored widget still renders
 * something rather than dividing by a zero span.
 *
 * @param {object} state - evaluated item state
 * @returns {{xmin: number, xmax: number, ymin: number, ymax: number}}
 *
 * @example graphWindow({xRange: "[0, 10, 1]", yRange: "[-1, 1, 0.5]"}) // {xmin: 0, xmax: 10, ymin: -1, ymax: 1}
 * @example graphWindow({}) // {xmin: -1, xmax: 1, ymin: -1, ymax: 1}
 */
export function graphWindow(state) {
  const x = parseRange(state.xRange ?? "[-1, 1, 1]");
  const y = parseRange(state.yRange ?? "[-1, 1, 1]");
  return { xmin: x.min, xmax: x.max, ymin: y.min, ymax: y.max };
}

/**
 * Pure function. Maps ONE data point to the widget's LOCAL box (y flipped so
 * math's "up is positive" reads correctly on a screen whose local y grows down).
 * A non-finite input stays non-finite (the caller breaks the polyline there).
 *
 * @param {number[]} pt - [dataX, dataY]
 * @param {object} win - {xmin, xmax, ymin, ymax}
 * @param {number} w - local width
 * @param {number} h - local height
 * @returns {number[]|null} [localX, localY], or null for a non-finite input
 *
 * @example dataPointToLocal([5, 0], {xmin: 0, xmax: 10, ymin: -1, ymax: 1}, 200, 100) // [100, 50]
 * @example dataPointToLocal(null, {xmin: 0, xmax: 10, ymin: -1, ymax: 1}, 200, 100) // null
 */
export function dataPointToLocal(pt, win, w, h) {
  if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;
  return [dataToLocal(pt[0], win.xmin, win.xmax, w, false), dataToLocal(pt[1], win.ymin, win.ymax, h, true)];
}

/**
 * Query (samples the source, which reads the presentation clock). The widget's
 * curve as LOCAL-space subpaths plus any error: `{subpaths, error}`. On an
 * equation failure `subpaths` is empty and `error` carries the loud message.
 * Shared by emit (to draw) and localBounds (to bound), so they can never disagree
 * about where the ink is.
 *
 * @param {object} state - evaluated item state
 * @returns {{subpaths: number[][][], error: (string|null)}}
 */
export function curveLocal(state) {
  const { points, error } = sampleCurve({
    mode: state.mode ?? "parametric",
    source: state.source ?? "",
    tStart: state.tStart ?? 0,
    tEnd: state.tEnd ?? 1,
    numPoints: state.numPoints ?? DEFAULT_NUM_POINTS,
    vars: { ...(state.docVars ?? {}), ...(state.vars ?? {}) }, // doc vars, item vars shadowing (digest 09)
  });
  if (error) return { subpaths: [], error };
  const win = graphWindow(state);
  const w = state.w ?? 0, h = state.h ?? 0;
  const local = points.map((p) => dataPointToLocal(p, win, w, h));
  return { subpaths: breakSubpaths(local, state.jumpThreshold ?? 0), error: null };
}

export const graphLinePlugin = {
  type: "graph_line",
  title: "Graph Line",
  capabilities: { docVars: true,  bbox: true, transform: true, resizable: true, backdrop: false },
  // The full-screen Monaco editor for the equation — double-click OR the "</>"
  // Inspector row, both routed through the widget-agnostic edit-code-source
  // command (the mermaid/latex seam; report 07 §2). One descriptor, no UI code.
  // `activate: "code_modal"` is REQUIRED alongside codeEditor (the migration gate
  // tests/activation_migration_test.js: a codeEditor-carrying widget must NAME its
  // double-click handler, not rely on the retired claims() bridge) — exactly what
  // mermaid.js:432 declares.
  activate: "code_modal",
  codeEditor: { property: "source", language: "javascript", title: "Edit Curve Equation" },
  defaults: {
    type: "graph_line", x: 120, y: 120, w: 400, h: 300, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    mode: "explicit",
    source: DEFAULT_SOURCE,
    tStart: -TWO_PI, tEnd: TWO_PI, numPoints: DEFAULT_NUM_POINTS,
    xRange: "[-6.2832, 6.2832, 1.5708]",
    yRange: "[-1.5, 1.5, 0.5]",
    closed: false,
    jumpThreshold: 0,
    fill: null, stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH,
    ...defaults("opacity"),
    // NO effects/strokeTrim fragment: the registry injects the effects bundle at
    // registration, and strokeStart/End/Phase are ABSENT-IS-IDENTITY (byte-
    // identical to an untrimmed stroke until keyframed).
  },
  inspector: [
    ...bundle("positioning"),
    { key: "mode", label: "Mode", kind: "select", options: MODES, optionLabels: MODE_LABELS, category: CAT_EQ, help: "How the equation's result is read. Parametric: return [x, y]. Explicit: return y (x is the domain t). Polar: return r (x,y = r·cos t, r·sin t)." },
    { key: "source", label: "Equation", kind: "text", category: CAT_EQ, help: "The JavaScript curve equation, sampled once per point over [tStart, tEnd] with the domain value in both `t` and `x`. Use Math.sin, `**` or pow() for powers (`^` is bitwise XOR in JS!). `time` is the presentation clock (a time-reading curve animates and is deterministic). Bind with '=' or type a literal expression." },
    { key: "__editsource", label: "Edit in code editor…", kind: "action", command: "edit-code-source", category: CAT_EQ, help: "Opens the full-screen VS-Code-style editor (autocomplete, minimap) on the equation — the same editor double-clicking the curve opens. Write multi-line JS via an IIFE, e.g. a for-loop returning a value." },
    { key: "tStart", label: "t start", kind: "number", category: CAT_FMT, help: "Start of the parameter domain. Keyframe tStart→tEnd across slides to draw the curve on by growing its domain." },
    { key: "tEnd", label: "t end", kind: "number", category: CAT_FMT, help: "End of the parameter domain." },
    { key: "numPoints", label: "Samples", kind: "number", min: 2, category: CAT_FMT, help: "How many points the curve is sampled at (resolution-independent). 256 is smooth for most curves; raise it for many-turn spirals or harmonographs." },
    { key: "xRange", label: "X data range", kind: "text", category: CAT_FMT, help: "The data window mapped to the box width: [min, max, step]. A graphTickMarks/graphGrid with the same range lines up exactly. Set it to frame the curve's natural x-extent." },
    { key: "yRange", label: "Y data range", kind: "text", category: CAT_FMT, help: "The data window mapped to the box height: [min, max, step]. Math's up-is-positive convention is used (data max is at the top)." },
    { key: "closed", label: "Closed", kind: "boolean", category: CAT_FMT, help: "Join the curve's end back to its start (encloses an area so a fill shows). Leave off for an open curve like a sine wave." },
    { key: "jumpThreshold", label: "Break at jumps", kind: "number", min: 0, category: CAT_FMT, help: "Break the line where consecutive points jump farther than this many pixels — the pragmatic way to stop a tan-style asymptote from streaking across the frame. 0 never breaks (for continuous curves)." },
    ...props("fill", { fill: { label: "Fill", help: "Fill under a closed curve (transparent by default — most graphs are stroke-only). Also paints an area when Closed is on." } }),
    ...props("stroke", "strokeWidth"),
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
  ],
  /**
   * Pure function. Is this a GHOST (nothing drawable)? True when the source is
   * blank — an empty equation has no curve, but the item stays selectable (the
   * svg/polygon isGhost precedent). A non-empty source that ERRORS is NOT a ghost:
   * it draws the loud red box.
   *
   * @example graphLinePlugin.isGhost({ source: "" }) // true
   * @example graphLinePlugin.isGhost({ source: "Math.sin(x)" }) // false
   */
  isGhost(state) {
    return !((state.source ?? "").trim());
  },
  /**
   * Query (samples the source). State → ONE `path` op (the polyline, with M-split
   * subpaths at discontinuities), OR the red error box on an equation failure.
   * Filled with the fill paint only when `closed` and a fill is set; always
   * stroked when strokeWidth > 0. Effects/stroke-trim are applied at the ports
   * seam (registry-injected), never here.
   */
  emit(s) {
    const { subpaths, error } = curveLocal(s);
    if (error) return errorAffordance(s.w ?? 0, s.h ?? 0, `Graph error: ${error}`);
    const d = polylinePathD(subpaths, s.closed === true);
    if (!d) return [];
    const closed = s.closed === true;
    return [path({
      d,
      fill: closed ? (s.fill ?? null) : null,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      fillRule: "evenodd",
      opacity: s.opacity ?? 1,
    })];
  },
  /**
   * Query (samples the source). THE BOUNDS PROTOCOL: the LOCAL rect the curve's
   * ink occupies — the union of its sampled point hull, inflated by half the
   * stroke, since a curve may (legitimately) leave the data window and draw past
   * the box. Falls back to the box when the curve is empty/errored (so the error
   * box and a blank widget stay selectable and cullable).
   */
  localBounds(state) {
    const { subpaths } = curveLocal(state);
    const pts = subpaths.flat();
    if (pts.length < MIN_DRAWN) return { x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 };
    const pad = (state.strokeWidth ?? 0) / 2;
    const b = subpathsBBox([pts]);
    return { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
  },
  cullMargin: effectsCullMargin,
  /**
   * Query (samples the source). Hit test in LOCAL units: within a grab band of
   * any subpath segment, or inside a closed+filled loop (even-odd). Falls back to
   * the bbox when there is no drawable geometry, so a blank/errored curve stays
   * selectable.
   */
  hitTest(s, lx, ly, tol = 0) {
    const { subpaths } = curveLocal(s);
    const band = (s.strokeWidth ?? 0) / 2 + tol;
    let any = false;
    for (const sp of subpaths) {
      if (sp.length < MIN_DRAWN) continue;
      any = true;
      if (s.closed === true && s.fill && sp.length >= 3 && pointInPolygon(sp, lx, ly)) return true;
      for (let i = 0; i < sp.length - 1; i++)
        if (distToSegment(lx, ly, { x: sp[i][0], y: sp[i][1] }, { x: sp[i + 1][0], y: sp[i + 1][1] }) <= band) return true;
    }
    if (!any) return lx >= 0 && lx <= (s.w ?? 0) && ly >= 0 && ly <= (s.h ?? 0);
    return false;
  },
  anchors: standardBBoxAnchors,
  // The plot FRAME's border. This used to CLAMP the query into the box, which is
  // not the same map: a clamp returns an INTERIOR query unchanged, so
  // closest_to_rim against an overlapping widget answered with a point inside the
  // chart rather than on its edge. closestPointOnRectBorder is the projection the
  // old comment already claimed ("the rect convention"). The plotted CURVE, not
  // the frame, would be the truer rim here — see W4-L's report; the frame is at
  // least a rim.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 }, local.x, local.y);
  },
  presetFamilies: [{ id: "zoo", title: "Equation zoo", presets: GRAPH_LINE_PRESETS }],
  commands: [
    { id: "add-graph-line", title: "Add Graph Line", icon: "mdi:chart-bell-curve", run: (app) => app.armCrosshairPlacement(graphLinePlugin) },
  ],
};
