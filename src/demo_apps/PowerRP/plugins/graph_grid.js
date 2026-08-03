/**
 * GRAPH GRID — the coordinate GRID (manifest item 66): "optional grid options,
 * very much like Matplotlib", plus the 3Blue1Brown NumberPlane look (major lines
 * + dimmer FADED sub-lines) and — the headline ask — the ability to "SNAKE into
 * existence… draw the columns and rows in staggered, Manim style." Driven by the
 * shared data window (`xRange`/`yRange`) so it overlays a graphLine/graphTickMarks
 * authored with the same ranges exactly.
 *
 * ── THE SNAKE-IN (item 66), and why it is NOT the stroke-trim framework ────────
 * The obvious mechanism (the task's own suggestion) is universal stroke-trim, but
 * paint_skia trims each CONTOUR independently — a multi-line grid trimmed to 0.5
 * grows every line halfway at once, never the staggered "verticals then
 * horizontals" recipe (digest 02). So the stagger is baked into GEOMETRY instead:
 * a single tweenable `growth` ∈ [0,1] drives each line's DRAWN LENGTH through the
 * SHARED lagged-reveal formula (core/graph_scale.easedReveal — the very formula
 * graphBars grows its bars with), ordered verticals-first. Keyframe `growth` 0→1
 * and the columns sweep in left-to-right, then the rows top-to-bottom. This is
 * PROPERTY STATE (a tweened number), so it records/shards like any other, and the
 * STROKE_TRIM_KEYS are ALSO exposed for the simpler synchronized draw-on.
 *
 * ── FADED SUB-LINES (Manim faded_line_ratio) ──────────────────────────────────
 * Minor grid lines are drawn dimmer than the majors (`fadedLineOpacity`) — the
 * core of the 3b1b plane look — and fade in with the overall growth so they never
 * pop ahead of the structural lines.
 *
 * No plugin imports another: shared core scale module + shared data-window
 * convention only.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { parseRange, dataToLocal, tickValues, minorTickValues, minorSubdivisions, easedReveal, clamp01 } from "../core/graph_scale.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { morphPayloadFromPaths } from "../core/morph_payload.js";
import * as T from "../core/transform.js";
import { path } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";
import { GRAPH_GRID_PRESETS } from "./graph_presets.js";

const CAT = "formatting";
const GRID_AXES = ["x", "y", "both"];
const GRID_AXIS_LABELS = { x: "Vertical lines only", y: "Horizontal lines only", both: "Both" };
const EASES = ["linear", "cubic", "quad_in", "quad_out"];
const GROW_DIRS = ["index-ascending", "index-descending", "center-out", "edges-in"];
const GROW_DIR_LABELS = { "index-ascending": "Verticals→Horizontals", "index-descending": "Reversed", "center-out": "Center out", "edges-in": "Edges in" };

const DEFAULT_GRID_COLOR = "#5C7A99";  // muted blue — the NumberPlane line color
const DEFAULT_GRID_WIDTH = 1.5;
const DEFAULT_GRID_OPACITY = 0.85;
const DEFAULT_FADED_OPACITY = 0.3;
const DEFAULT_MINOR_WIDTH = 1;

/**
 * Pure function. The DRAWN endpoints of one grid line at a given growth factor —
 * a vertical line grows bottom→top, a horizontal grows left→right, so a snake-in
 * reads as columns rising then rows extending. `factor` 1 draws the whole line; 0
 * draws nothing (the caller drops it).
 *
 * @param {string} orient - "v" (vertical) | "h" (horizontal)
 * @param {number} pos - the line's fixed local coordinate (x for v, y for h)
 * @param {number} w - local width
 * @param {number} h - local height
 * @param {number} factor - drawn fraction 0..1
 * @returns {number[][]|null} [[x0, y0], [x1, y1]], or null when nothing is drawn
 *
 * @example gridLineSegment("v", 40, 200, 100, 1) // [[40, 100], [40, 0]]
 * @example gridLineSegment("v", 40, 200, 100, 0.5) // [[40, 100], [40, 50]]
 * @example gridLineSegment("h", 30, 200, 100, 1) // [[0, 30], [200, 30]]
 * @example gridLineSegment("h", 30, 200, 100, 0) // null
 */
export function gridLineSegment(orient, pos, w, h, factor) {
  if (!(factor > 0)) return null;
  if (orient === "v") return [[pos, h], [pos, h - factor * h]];
  return [[0, pos], [factor * w, pos]];
}

export const graphGridPlugin = {
  type: "graph_grid",
  ephemeral: EPHEMERAL.NONE,
  title: "Graph Grid",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "graph_grid", x: 120, y: 120, w: 400, h: 300, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    xRange: "[0, 10, 1]", yRange: "[0, 10, 1]",
    gridAxis: "both",
    gridColor: DEFAULT_GRID_COLOR, gridWidth: DEFAULT_GRID_WIDTH, gridOpacity: DEFAULT_GRID_OPACITY,
    showMinor: false, minorSubdivisions: 0, fadedLineOpacity: DEFAULT_FADED_OPACITY, minorWidth: DEFAULT_MINOR_WIDTH,
    growth: 1, growLagRatio: 0.3, growEase: "cubic", growDirection: "index-ascending",
    opacity: 1,
  },
  inspector: [
    ...bundle("transform"),
    { key: "xRange", label: "X data range", kind: "text", category: CAT, help: "[min, max, step] mapped across the box width. The step sets the spacing of the vertical grid lines. Share it with a graphLine/graphTickMarks to line up." },
    { key: "yRange", label: "Y data range", kind: "text", category: CAT, help: "[min, max, step] mapped across the box height (step = horizontal line spacing)." },
    { key: "gridAxis", label: "Grid lines", kind: "select", options: GRID_AXES, optionLabels: GRID_AXIS_LABELS, category: CAT, help: "Draw vertical lines, horizontal lines, or both." },
    { key: "gridColor", label: "Grid color", kind: "color", category: CAT, help: "Color of the grid lines." },
    { key: "gridWidth", label: "Grid width", kind: "number", min: 0, category: CAT, help: "Thickness of the major grid lines." },
    { key: "gridOpacity", label: "Grid opacity", kind: "number", min: 0, max: 1, category: CAT, help: "Opacity of the major grid lines." },
    { key: "showMinor", label: "Faded sub-lines", kind: "boolean", category: CAT, help: "Add dimmer minor lines between the majors — the 3Blue1Brown NumberPlane look (a finer grid inside each cell)." },
    { key: "minorSubdivisions", label: "Sub-line count", kind: "number", min: 0, category: CAT, help: "Minor lines per major cell. 0 = auto (matplotlib's 4-or-5 rule from the step)." },
    { key: "fadedLineOpacity", label: "Sub-line opacity", kind: "number", min: 0, max: 1, category: CAT, help: "Opacity of the faded minor lines — set below the major opacity for the layered plane look." },
    { key: "minorWidth", label: "Sub-line width", kind: "number", min: 0, category: CAT, help: "Thickness of the minor lines (usually thinner than the majors)." },
    { key: "growth", label: "Snake-in", kind: "number", min: 0, max: 1, category: CAT, help: "How much of the grid has drawn on, 0..1. Keyframe 0→1 across a slide and the columns snake in, then the rows — the Manim NumberPlane entrance. Leave at 1 for a static grid." },
    { key: "growLagRatio", label: "Stagger", kind: "number", min: 0, max: 1, category: CAT, help: "How staggered the snake-in is: 0 draws every line together, 1 draws them strictly one after another." },
    { key: "growEase", label: "Grow ease", kind: "select", options: EASES, category: CAT, help: "Easing applied to each line's draw-on." },
    { key: "growDirection", label: "Grow order", kind: "select", options: GROW_DIRS, optionLabels: GROW_DIR_LABELS, category: CAT, help: "The order lines snake in: verticals-then-horizontals (the classic), reversed, from the center out, or from the edges in." },
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
  ],
  /**
   * Query (reads only its own numeric state). State → up to two `path` ops: the
   * MAJOR grid lines (each drawn to its lagged `growth` length so the grid snakes
   * in) and the faded MINOR lines (fading in with overall growth). Line positions
   * come from the shared scale module (integer-index × step). Empty when growth is
   * 0.
   */
  emit(s) {
    const { major, minor } = gridSegments(s);
    const opacity = s.opacity ?? 1;
    const growth = clamp01(s.growth ?? 1);
    const ops = [];
    if (major.length) ops.push(path({ d: segsD(major), stroke: s.gridColor, strokeWidth: s.gridWidth ?? DEFAULT_GRID_WIDTH, opacity: opacity * (s.gridOpacity ?? DEFAULT_GRID_OPACITY) }));
    if (minor.length) ops.push(path({ d: segsD(minor), stroke: s.gridColor, strokeWidth: s.minorWidth ?? DEFAULT_MINOR_WIDTH, opacity: opacity * (s.fadedLineOpacity ?? DEFAULT_FADED_OPACITY) * growth }));
    return ops;
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the rulings as cubic contours, from the SAME `gridSegments` + `segsD` pair
   * emit() draws with — so the grid that morphs is the grid on screen, at
   * whatever point of its staggered reveal it currently sits (a half-grown line
   * is genuinely half-length ink, and pairing against its full length would be
   * pairing against a picture nobody is looking at).
   *
   * MAJOR AND MINOR IN ONE PAYLOAD, in emit()'s own order. They are two `path`
   * ops only because they carry different stroke widths and opacities; as ink
   * they are one family of rulings, and the aligner pairs subpaths, so keeping
   * them together lets a dense grid distribute evenly into a target rather than
   * having its faint half orphaned.
   *
   * EVERY SUBPATH IS OPEN — a ruling is a stroke, not a region. The engine steps
   * `closed` to the target's flag at alpha > 0, which is the documented reading.
   */
  morphPaths(s) {
    const { major, minor } = gridSegments(s);
    return morphPayloadFromPaths(
      [...major, ...minor].map((seg) => ({ d: segsD([seg]), paint: { fill: null, stroke: s.gridColor ?? null, strokeWidth: s.gridWidth ?? DEFAULT_GRID_WIDTH, opacity: s.opacity ?? 1 } })),
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  /** Pure function. Why this grid cannot morph YET, or null — emit()'s own
   * "nothing to draw" case: a fully-ungrown or line-less grid has no ink. */
  morphNotReady(s) {
    const { major, minor } = gridSegments(s);
    return major.length + minor.length > 0 ? null : "at least one ruling (this grid draws nothing)";
  },
  localBounds(state) {
    return { x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 };
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
  presetFamilies: [{ id: "grids", title: "Grid presets", presets: GRAPH_GRID_PRESETS }],
  commands: [
    { id: "add-graph-grid", title: "Add Graph Grid", icon: "mdi:grid", run: (app) => app.armCrosshairPlacement(graphGridPlugin) },
  ],
};

/**
 * Pure function. THE GRID'S GEOMETRY, as two lists of two-point segments in
 * box-local space — the ONE sampler emit() and `morphPaths` share.
 *
 * IT WAS INLINE IN emit() UNTIL THIS COMMIT, and extracting it is the whole
 * reason this widget can morph honestly. core/registry.js's morph protocol says
 * "derive the payload from the ink, never alongside it": a provider that rebuilt
 * these rulings from the same ranges would be a SECOND spelling that could drift
 * from the drawn one, and the drift would be invisible — the morph would flow
 * into a grid the widget never shows.
 *
 * THE STAGGERED REVEAL IS INSIDE, not applied afterwards, because a partly-grown
 * major line is genuinely SHORTER ink (`gridLineSegment` trims it), not a full
 * line drawn faintly. Minor lines are always full length; their reveal is carried
 * by opacity at the call site, which is why `growth` gates them but does not
 * shorten them.
 *
 * Args:
 *   s (object): the widget's folded state
 *
 * Returns:
 *   {major: number[][][], minor: number[][][]} — each entry a [[x0,y0],[x1,y1]]
 *
 * Examples:
 *     >>> // an ungrown grid draws nothing at all
 *     >>> gridSegments({w: 100, h: 100, growth: 0}).major.length
 *     0
 *     >>> // a default 0..10 step-1 range at full growth: 11 verticals + 11 horizontals
 *     >>> gridSegments({w: 100, h: 100}).major.length
 *     22
 *     >>> gridSegments({w: 100, h: 100}).major[0]
 *     [ [ 0, 0 ], [ 0, 100 ] ]
 */
export function gridSegments(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const xr = parseRange(s.xRange ?? "[0, 10, 1]");
  const yr = parseRange(s.yRange ?? "[0, 10, 1]");
  const doV = (s.gridAxis ?? "both") !== "y";
  const doH = (s.gridAxis ?? "both") !== "x";
  const growth = clamp01(s.growth ?? 1);
  const lag = s.growLagRatio ?? 0.3;
  const easeName = s.growEase ?? "cubic";
  const dir = s.growDirection ?? "index-ascending";

  // The lines, ordered verticals-first (left→right) then horizontals
  // (top→bottom) — the order the lagged reveal staggers along.
  const xMajor = doV ? tickValues(xr.min, xr.max, xr.step > 0 ? xr.step : 1) : [];
  const yMajor = doH ? tickValues(yr.min, yr.max, yr.step > 0 ? yr.step : 1) : [];
  const total = xMajor.length + yMajor.length;

  const major = [];
  if (total > 0 && growth > 0 && (s.gridWidth ?? 0) > 0) {
    let idx = 0;
    for (const v of xMajor) {
      const f = easedReveal(idx++, total, growth, lag, easeName, dir);
      const seg = gridLineSegment("v", dataToLocal(v, xr.min, xr.max, w, false), w, h, f);
      if (seg) major.push(seg);
    }
    for (const v of yMajor) {
      const f = easedReveal(idx++, total, growth, lag, easeName, dir);
      const seg = gridLineSegment("h", dataToLocal(v, yr.min, yr.max, h, true), w, h, f);
      if (seg) major.push(seg);
    }
  }

  // Minor (faded) lines — full length, opacity scaled by overall growth so they
  // arrive with the structure rather than snaking independently.
  const minor = [];
  if (s.showMinor && growth > 0 && (s.minorWidth ?? 0) > 0) {
    if (doV) {
      const sub = (s.minorSubdivisions ?? 0) > 0 ? s.minorSubdivisions : minorSubdivisions(xr.step > 0 ? xr.step : 1);
      for (const v of minorTickValues(xr.min, xr.max, xr.step > 0 ? xr.step : 1, sub))
        minor.push([[dataToLocal(v, xr.min, xr.max, w, false), 0], [dataToLocal(v, xr.min, xr.max, w, false), h]]);
    }
    if (doH) {
      const sub = (s.minorSubdivisions ?? 0) > 0 ? s.minorSubdivisions : minorSubdivisions(yr.step > 0 ? yr.step : 1);
      for (const v of minorTickValues(yr.min, yr.max, yr.step > 0 ? yr.step : 1, sub))
        minor.push([[0, dataToLocal(v, yr.min, yr.max, h, true)], [w, dataToLocal(v, yr.min, yr.max, h, true)]]);
    }
  }
  return { major, minor };
}

/** Pure helper. An SVG `d` for a set of two-point segments, each its own subpath. */
function segsD(segments) {
  return segments.map(([a, b]) => `M${r(a[0])} ${r(a[1])} L${r(b[0])} ${r(b[1])}`).join(" ");
}
function r(v) { return +v.toFixed(3); }
