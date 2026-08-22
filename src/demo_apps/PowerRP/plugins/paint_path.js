/**
 * PAINT PATH — a PAINTABLE, EDITABLE cubic-bezier stroke. The user's ask: "a
 * paintable path widget that when I double click it, lets me draw … a path that
 * has curves that will be editable because it's all beziers … with the list
 * property with BREAKS so that there are multiple segments … properties such as
 * stroke length so that I can animate the drawing of it."
 *
 * ── WHAT IT IS, AND WHY IT IS ITS OWN WIDGET (not the polygon) ─────────────────
 * plugins/polygon.js is the closest sibling: a variable-length point list where
 * every element is a draggable handle and the whole list is one keyframable leaf.
 * This is that skeleton with two additions the polygon deliberately does not have:
 *   CURVES  — every anchor carries a MIRRORED bezier handle, so segments are cubic
 *             beziers rather than straight edges. A zero handle is a corner; a
 *             non-zero one is a smooth (C1) point.
 *   BREAKS  — an anchor may START A NEW SUBPATH (`brk`), so ONE widget draws as
 *             SEVERAL separate strokes (the user's "multiple segments").
 * Plus the DRAW-ON: this widget composes the UNIVERSAL STROKE-TRIM framework
 * (core/properties.js STROKE_TRIM_KEYS — strokeStart/strokeEnd/strokePhase +
 * the two caps, manifest E.12-15) rather than a private trim of its own. emit()
 * produces ONE full-length stroked `path` op; the arc-length window, phase and
 * caps are stamped onto it at the ports seam (render_gpu/ir.applyStrokeTrim) and
 * cut by paint_skia's ContourMeasure preprocessing — the SAME path every stroked
 * box takes. So `strokeEnd = t` animates the stroke drawing itself on across a
 * slide (the "stroke length" the user meant), and a paint path gets phase +
 * flat/round/taper caps for free. LEGACY docs that stored this widget's older
 * private `trimStart`/`trimEnd` pair migrate LOUDLY to strokeStart/strokeEnd at
 * load through the declarative `legacyKeys` seam (the arrow headSize→headLength
 * precedent, core/document.withLegacyKeysRenamed).
 *
 * ── STATE SHAPE (the "breaks" ruling, and why every field is a NUMBER) ─────────
 *   paintPoints: [[x, y, hx, hy, brk], ...]   a LIST PROPERTY (core/lists.js),
 *                                             declared once in core/properties.js
 *                                             PROPS.paintPoints (read back as
 *                                             PAINT_POINTS_LIST below)
 *     x, y    the anchor, as a box FRACTION (0..1 nominal, NOT clamped — a handle
 *             may be dragged outside the box), the polygon's normalized convention
 *     hx, hy  the anchor's MIRRORED bezier-handle OFFSET, also a box fraction:
 *             outgoing control = anchor + handle, incoming control = anchor − handle
 *     brk     0 continues the stroke; >= 0.5 STARTS A NEW SUBPATH at this anchor
 *   stroke / strokeWidth    the paint-capable stroke (composes with the stroke
 *                           material framework via props("stroke", "strokeWidth"))
 *   fill / closed           optional: when `closed`, each subpath closes and fills
 *   strokeStart / strokeEnd / strokePhase / strokeCapStart / strokeCapEnd
 *                           the UNIVERSAL stroke-trim window + phase + caps
 *                           (core/properties STROKE_TRIM_KEYS), absent-is-identity —
 *                           NOT stored in defaults, honored at the ports seam
 *
 * STORAGE IS A TUPLE OF NUMBERS, and `brk` is 0/1 rather than a boolean, ON
 * PURPOSE: core/interpolators.js interpolate() rounds a lerp between two integers,
 * so a RECORD — or a MIXED tuple carrying a boolean — would recurse to that integer
 * path and SNAP normalized 0↔1 anchor coordinates at alpha 0.5 mid-tween. An
 * all-number tuple takes interpolate's pure-numeric-array branch (a plain lerp, no
 * rounding), so the shape TWEENS correctly slide to slide. The full reasoning is in
 * core/lists.js's ELEMENT_STORAGE note and mirrored at PROPS.paintPoints.
 *
 * ── NORMALIZED, LOCAL, RESIZABLE — inherited verbatim from the polygon ─────────
 * Coordinates are box fractions so the widget is `bbox: true` + `resizable`: the
 * box governs the shape and a resize stretches the path. They are LOCAL (its own
 * frame), so a SIMILARITY transform (x/y/rotation/scale — no skew) moves the whole
 * widget as a unit and the handles never reason about rotation (CanvasView inverts
 * the drag through node.world before `apply`, exactly as for the polygon). Negative
 * w/h (a FLIP) is resolved at core/geometry.unsignedState before any hook here runs
 * — this file never sees a sign, the registry contract's guarantee.
 *
 * ── WHAT IS NOT HERE, and the honest bound ─────────────────────────────────────
 * The CREATION FLOW (click each anchor, Enter/double-click to finish) is DOM work,
 * so it lives in web/paintPathDraw.js (`placement: "paint_path_chain"`), reusing the
 * polygon's exact repeating-"point" creation-step mechanism. DOUBLE-CLICKING an
 * existing path inserts an anchor on the curve (`activate: "insert_point"`, the same
 * handler the polygon uses, via `insertPointAt` below). STATED BOUND: creation
 * places CORNER anchors by clicking; smooth bezier HANDLES and subpath BREAKS are
 * then edited after placement — via each anchor's on-canvas handle and the
 * Inspector's per-point fields. A click-DRAG "pen" gesture that lays a handle during
 * creation would need a new creation-gesture kind in web/creationSteps.js + the
 * CanvasView host, which is deferred; the geometry to support it (the mirrored
 * handle) is already in the state shape, so it is a UI addition, not a redesign.
 *
 * The pure functions the creation/insert flows and the emit path all need are
 * exported here (splitSubpaths, cubicSegments, subpathBezierD, pathBezierD,
 * sampleCubic, flattenSubpath, …) so everything they decide is testable from bare
 * node (tests/paint_path_test.js). Arc-length TRIMMING is no longer among them:
 * it moved to the universal ContourMeasure preprocessing in paint_skia.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { pointInPolygon, distToSegment, subpathsBBox } from "../core/outline.js";
import { num } from "../core/shapes.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { bundle, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS, STROKE_SPACE_KEYS } from "../core/properties.js";
import { elementActive, visibleElements, visibleIndices, withElementFieldValue, withElementInserted } from "../core/lists.js";
import { path } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";

/** Fewest anchors that draw a subpath: one cubic segment needs two ends. */
export const MIN_DRAWN_ANCHORS = 2;

/** A `brk` at or above this starts a new subpath. A threshold (not `=== 1`)
 *  because a brk that TWEENS between 0 and 1 must flip once, at the midpoint. */
export const BREAK_THRESHOLD = 0.5;

/** Line segments a single cubic is flattened into for arc-length trim + hit test.
 *  24 keeps a gentle curve visually smooth and its measured length within a
 *  fraction of a percent of the true arc length — plenty for a draw-on window. */
export const SAMPLES_PER_CUBIC = 24;

/** The default mirrored-handle reach (box fraction) a CORNER gets when its curve
 *  is ENABLED (the toolbar toggle / point menu) — a gentle tangent along +x, big
 *  enough that the bezier handle appears visibly off the anchor and can be grabbed
 *  and dragged. */
export const CURVE_HANDLE_REACH = 0.15;

/** A freshly placed path's stroke — a warm amber the green shape family does not
 *  use, so a placed paint path is visibly its own widget type. */
const DEFAULT_STROKE = "#e0af68";

/**
 * THE `paintPoints` LIST DECLARATION, read back off core/properties.js
 * PROPS.paintPoints rather than re-typed here — one declaration, so the element
 * storage form, the SEQUENCE order flavour and the visibility companion key
 * (`paintPointsActive`) cannot drift between the Inspector's list row and this
 * widget's own list operations. Carries `key`/`activeKey`, so a consumer holding
 * only a handle knows which state keys to write.
 */
export const PAINT_POINTS_LIST = props("paintPoints")[0];

/**
 * Pure function. A state's `paintPoints` in the LIST-VALUE shape core/lists.js
 * operates on: the element list plus its aligned visibility companion. The ONE
 * place this widget assembles the pair, so the list and its companion can never
 * be read out of step.
 *
 * @param {object} state - evaluated item state
 * @returns {{list: number[][], active: (boolean[]|undefined)}}
 *
 * @example pointsValue({paintPoints: [[0, 0, 0, 0, 0]]}) // {list: [[0, 0, 0, 0, 0]], active: undefined}
 * @example pointsValue({paintPoints: [[0, 0, 0, 0, 0]], paintPointsActive: [false]}) // {list: [[0, 0, 0, 0, 0]], active: [false]}
 */
export function pointsValue(state) {
  return { list: normalizedAnchors(state), active: state[PAINT_POINTS_LIST.activeKey] };
}

/**
 * Pure function. A state's raw normalized anchor list (every stored anchor,
 * hidden ones included). Absent → an empty list (the degenerate "nothing drawn"
 * case, which every consumer here handles).
 *
 * @param {object} state - evaluated item state
 * @returns {number[][]} [[x, y, hx, hy, brk], ...] box fractions
 *
 * @example normalizedAnchors({paintPoints: [[0.1, 0.5, 0, 0, 0]]}) // [[0.1, 0.5, 0, 0, 0]]
 * @example normalizedAnchors({}) // []
 */
export function normalizedAnchors(state) {
  return state.paintPoints ?? [];
}

/**
 * Pure function. A state's VISIBLE anchors — the ones actually on the path, with
 * hidden ones absent so the curve closes straight over them. Delegates the
 * filtering to core/lists.visibleElements (returns the stored list by identity
 * when nothing is hidden, so the common path allocates nothing).
 *
 * @param {object} state - evaluated item state
 * @returns {number[][]} [[x, y, hx, hy, brk], ...]
 *
 * @example visibleAnchors({paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]}) // [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]
 * @example visibleAnchors({paintPoints: [[0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0], [1, 1, 0, 0, 0]], paintPointsActive: [true, false, true]}) // [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]
 */
export function visibleAnchors(state) {
  return visibleElements(PAINT_POINTS_LIST, pointsValue(state));
}

/**
 * Pure function. The VISIBLE anchors in LOCAL units: the anchor and its handle
 * offset each scaled by the box extent → [x·w, y·h, hx·w, hy·h, brk]. THE mapping
 * the renderer, the hit test and the bounds all go through, so none can disagree
 * about where the curve is. HANDLES for editing deliberately do NOT come through
 * here — they are drawn for every STORED anchor (`modifierPoints`), hidden ones
 * included, or a hidden anchor could never be shown again.
 *
 * @param {object} state - evaluated item state ({paintPoints, paintPointsActive, w, h})
 * @returns {number[][]} [[x, y, hx, hy, brk], ...] in local units
 *
 * @example scaledAnchors({paintPoints: [[0, 0, 0.1, 0, 0], [1, 0.5, 0.1, 0, 0]], w: 200, h: 100}) // [[0, 0, 20, 0, 0], [200, 50, 20, 0, 0]]
 * @example scaledAnchors({paintPoints: [[0.5, 0.5, 0.2, 0.2, 0]], w: 0, h: 0}) // [[0, 0, 0, 0, 0]] (zero-extent box collapses to the origin)
 */
export function scaledAnchors(state) {
  const w = state.w ?? 0, h = state.h ?? 0;
  return visibleAnchors(state).map(([x, y, hx, hy, brk]) => [x * w, y * h, hx * w, hy * h, brk]);
}

/**
 * Pure function. Split an anchor list into SUBPATHS at every `brk` (an anchor
 * whose brk >= BREAK_THRESHOLD begins a new subpath; the first anchor always
 * begins subpath 0 regardless of its brk). This is what makes ONE widget draw as
 * several strokes.
 *
 * @param {number[][]} anchors - [[x, y, hx, hy, brk], ...]
 * @returns {number[][][]} an array of subpaths, each an array of anchors
 *
 * @example splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]) // [[[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]]
 * @example splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0], [2, 2, 0, 0, 1], [3, 3, 0, 0, 0]]) // [[[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]], [[2, 2, 0, 0, 1], [3, 3, 0, 0, 0]]]
 * @example splitSubpaths([]) // []
 */
export function splitSubpaths(anchors) {
  const out = [];
  for (let i = 0; i < anchors.length; i++) {
    if (i === 0 || anchors[i][4] >= BREAK_THRESHOLD) out.push([]);
    out[out.length - 1].push(anchors[i]);
  }
  return out;
}

/**
 * Pure function. The cubic CONTROL-POINT quads [P0, P1, P2, P3] of one subpath's
 * segments — between each consecutive pair of anchors, using their mirrored
 * handles: P1 = a + a.handle (outgoing), P2 = b − b.handle (incoming). A subpath
 * of one anchor has no segment.
 *
 * @param {number[][]} subpath - [[x, y, hx, hy, brk], ...] in local units
 * @returns {number[][][]} [[[x,y],[x,y],[x,y],[x,y]], ...]
 *
 * @example cubicSegments([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]]) // [[[0, 0], [10, 0], [90, 0], [100, 0]]]
 * @example cubicSegments([[5, 5, 0, 0, 0]]) // [] (a lone anchor has no segment)
 */
export function cubicSegments(subpath) {
  const out = [];
  for (let i = 1; i < subpath.length; i++) {
    const a = subpath[i - 1], b = subpath[i];
    out.push([[a[0], a[1]], [a[0] + a[2], a[1] + a[3]], [b[0] - b[2], b[1] - b[3]], [b[0], b[1]]]);
  }
  return out;
}

/**
 * Pure function. The closing cubic of a subpath — from its last anchor back to
 * its first, using their mirrored handles (so a closed loop stays smooth). Null
 * for a subpath that cannot enclose anything (fewer than MIN_DRAWN_ANCHORS).
 *
 * @param {number[][]} subpath - [[x, y, hx, hy, brk], ...] in local units
 * @returns {number[][]|null} [P0, P1, P2, P3]
 *
 * @example closingCubic([[0, 0, 5, 0, 0], [100, 0, 5, 0, 0]]) // [[100, 0], [105, 0], [-5, 0], [0, 0]]
 * @example closingCubic([[0, 0, 0, 0, 0]]) // null
 */
export function closingCubic(subpath) {
  if (subpath.length < MIN_DRAWN_ANCHORS) return null;
  const a = subpath[subpath.length - 1], b = subpath[0];
  return [[a[0], a[1]], [a[0] + a[2], a[1] + a[3]], [b[0] - b[2], b[1] - b[3]], [b[0], b[1]]];
}

/**
 * Pure function. An SVG path `d` for ONE subpath as EXACT cubic beziers: M to the
 * first anchor, a C per segment, and (when `closed`) a closing C … Z. All M/C, so
 * it round-trips through the raster, SVG and PDF backends identically.
 *
 * @param {number[][]} subpath - [[x, y, hx, hy, brk], ...] in local units
 * @param {boolean} closed - close the loop back to the first anchor
 * @returns {string} SVG path data ("" for an empty subpath)
 *
 * @example subpathBezierD([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]], false) // "M0 0 C10 0 90 0 100 0"
 * @example subpathBezierD([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]], true) // "M0 0 C10 0 90 0 100 0 C110 0 -10 0 0 0 Z"
 * @example subpathBezierD([], false) // ""
 */
export function subpathBezierD(subpath, closed) {
  if (subpath.length === 0) return "";
  const seg = (c) => `C${num(c[1][0])} ${num(c[1][1])} ${num(c[2][0])} ${num(c[2][1])} ${num(c[3][0])} ${num(c[3][1])}`;
  let d = `M${num(subpath[0][0])} ${num(subpath[0][1])}`;
  for (const c of cubicSegments(subpath)) d += ` ${seg(c)}`;
  if (closed) {
    const c = closingCubic(subpath);
    if (c) d += ` ${seg(c)} Z`;
  }
  return d;
}

/**
 * Pure function. THE exact-bezier `d` for a whole anchor list: each subpath's
 * bezier d, joined — several M commands, so breaks render as separate strokes.
 * Subpaths of fewer than MIN_DRAWN_ANCHORS contribute nothing.
 *
 * @param {number[][]} anchors - [[x, y, hx, hy, brk], ...] in local units
 * @param {boolean} closed - close each subpath
 * @returns {string} SVG path data ("" when nothing draws)
 *
 * @example pathBezierD([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]], false) // "M0 0 C10 0 90 0 100 0"
 * @example pathBezierD([[0, 0, 0, 0, 0], [10, 0, 0, 0, 0], [50, 50, 0, 0, 1], [80, 80, 0, 0, 0]], false) // "M0 0 C0 0 10 0 10 0 M50 50 C50 50 80 80 80 80"
 */
export function pathBezierD(anchors, closed) {
  return splitSubpaths(anchors)
    .filter((sp) => sp.length >= MIN_DRAWN_ANCHORS)
    .map((sp) => subpathBezierD(sp, closed))
    .join(" ");
}

/**
 * Pure function. Sample one cubic [P0, P1, P2, P3] at `samples` uniform steps of
 * the bezier parameter, returning `samples + 1` points (both ends included) via
 * the Bernstein form. NOT arc-length uniform — parameter uniform — which is the
 * right substrate for a polyline approximation; the arc-length work happens on the
 * resulting segments (trimPolylines).
 *
 * @param {number[][]} seg - [P0, P1, P2, P3], each [x, y]
 * @param {number} samples - segment count (>= 1)
 * @returns {number[][]} [[x, y], ...] of length samples + 1
 *
 * @example sampleCubic([[0, 0], [0, 0], [10, 0], [10, 0]], 2) // [[0, 0], [5, 0], [10, 0]]
 * @example sampleCubic([[0, 0], [10, 0], [10, 0], [10, 10]], 1) // [[0, 0], [10, 10]]
 */
export function sampleCubic(seg, samples) {
  const [p0, p1, p2, p3] = seg;
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, u = 1 - t;
    const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
    out.push([
      b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
      b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
    ]);
  }
  return out;
}

/**
 * Pure function. Flatten ONE subpath to a polyline: every cubic sampled and
 * concatenated, dropping each segment's duplicated join point. A subpath of fewer
 * than MIN_DRAWN_ANCHORS flattens to an empty polyline.
 *
 * @param {number[][]} subpath - [[x, y, hx, hy, brk], ...] in local units
 * @param {boolean} closed - append the closing cubic
 * @param {number} samples - samples per cubic
 * @returns {number[][]} [[x, y], ...]
 *
 * @example flattenSubpath([[0, 0, 0, 0, 0], [10, 0, 0, 0, 0]], false, 2) // [[0, 0], [5, 0], [10, 0]]
 * @example flattenSubpath([[7, 7, 0, 0, 0]], false, 4) // []
 */
export function flattenSubpath(subpath, closed, samples) {
  const segs = cubicSegments(subpath);
  if (closed) {
    const c = closingCubic(subpath);
    if (c) segs.push(c);
  }
  const poly = [];
  segs.forEach((seg, si) => {
    const pts = sampleCubic(seg, samples);
    for (let i = si === 0 ? 0 : 1; i < pts.length; i++) poly.push(pts[i]);
  });
  return poly;
}

/**
 * Pure function. Does this path FILL? Only when `closed` is on AND at least one
 * subpath can enclose an area (>= MIN_POLYGON area needs >= 3, but a cubic loop of
 * two smooth anchors already bounds a region, so MIN_DRAWN_ANCHORS is the honest
 * floor). An absent `closed` reads as OPEN.
 *
 * @param {object} state - evaluated item state
 * @returns {boolean}
 *
 * @example fillsInterior({closed: true, paintPoints: [[0, 0, 0.1, 0, 0], [1, 1, 0.1, 0, 0]]}) // true
 * @example fillsInterior({closed: false, paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]}) // false
 * @example fillsInterior({paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]}) // false (absent flag reads open)
 */
export function fillsInterior(state) {
  return state.closed === true && splitSubpaths(visibleAnchors(state)).some((sp) => sp.length >= MIN_DRAWN_ANCHORS);
}

/**
 * Pure function. An anchor list with element `index` replaced — the write a
 * handle drag makes. Returns a NEW list (deltas share arrays as immutable
 * leaves). An out-of-range index throws (a handle whose anchor vanished is a
 * caller bug, not a value to drop).
 *
 * @param {number[][]} anchors - [[x, y, hx, hy, brk], ...]
 * @param {number} index - which anchor to replace
 * @param {number[]} anchor - the replacement [x, y, hx, hy, brk]
 * @returns {number[][]} a new list
 *
 * @example withAnchorAt([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]], 1, [0.5, 0.5, 0.1, 0, 0]) // [[0, 0, 0, 0, 0], [0.5, 0.5, 0.1, 0, 0]]
 */
export function withAnchorAt(anchors, index, anchor) {
  if (!(index >= 0 && index < anchors.length))
    throw new Error(`withAnchorAt: index ${index} is outside a ${anchors.length}-anchor list`);
  return anchors.map((a, i) => (i === index ? anchor : a));
}

/**
 * Pure function. Is this anchor a CURVE point (it carries a non-zero mirrored
 * handle), as opposed to a sharp CORNER? THE "curve or not" state is encoded by
 * the handle ITSELF — a zero handle IS a corner (the stated paintPoints invariant,
 * core/properties.js) — so there is no separate per-point flag to keep in sync and
 * the all-number tuple law is untouched. The consequence, stated because it is a
 * deliberate decision: turning a curve OFF discards its handle (withPointCurve
 * zeroes it), so there is nothing to "remember" and turning it back ON gives the
 * DEFAULT tangent, not the old one.
 *
 * @param {number[]} el - [x, y, hx, hy, brk]
 * @returns {boolean}
 *
 * @example isCurvePoint([0, 0, 0.1, 0, 0]) // true
 * @example isCurvePoint([0, 0, 0, 0, 0]) // false (a corner)
 * @example isCurvePoint([0.2, 0.3, 0, -0.2, 1]) // true (hy alone is enough)
 */
export function isCurvePoint(el) {
  return el[2] !== 0 || el[3] !== 0;
}

/**
 * Pure function. The same anchor with its curve turned ON or OFF: OFF zeroes the
 * mirrored handle (a sharp corner); ON gives a CORNER a default tangent
 * (CURVE_HANDLE_REACH along +x) so a handle appears to drag, while leaving an
 * ALREADY-curved point's handle untouched. Position (x, y) and break are preserved.
 *
 * @param {number[]} el - [x, y, hx, hy, brk]
 * @param {boolean} on - enable the curve
 * @returns {number[]} a new element
 *
 * @example withPointCurve([0, 0, 0.1, 0.2, 0], false) // [0, 0, 0, 0, 0]
 * @example withPointCurve([0, 0, 0, 0, 0], true) // [0, 0, 0.15, 0, 0]
 * @example withPointCurve([0, 0, 0.3, 0, 1], true) // [0, 0, 0.3, 0, 1] (already a curve — handle kept)
 */
export function withPointCurve(el, on) {
  if (!on) return [el[0], el[1], 0, 0, el[4]];
  if (isCurvePoint(el)) return el;
  return [el[0], el[1], CURVE_HANDLE_REACH, 0, el[4]];
}

/**
 * Pure function. Does this anchor START A NEW SUBPATH (its break flag is set at or
 * above BREAK_THRESHOLD)?
 *
 * @param {number[]} el - [x, y, hx, hy, brk]
 * @returns {boolean}
 *
 * @example isBreakPoint([0, 0, 0, 0, 1]) // true
 * @example isBreakPoint([0, 0, 0, 0, 0]) // false
 */
export function isBreakPoint(el) {
  return el[4] >= BREAK_THRESHOLD;
}

/**
 * Pure function. The same anchor with its break flag set to 1 (start a new subpath
 * here) or 0 (continue the stroke). Stored 0/1 so the tuple stays numeric and
 * tweens (the paintPoints storage law).
 *
 * @param {number[]} el - [x, y, hx, hy, brk]
 * @param {boolean} on - start a new subpath here
 * @returns {number[]} a new element
 *
 * @example withPointBreak([0, 0, 0.1, 0, 0], true) // [0, 0, 0.1, 0, 1]
 * @example withPointBreak([0, 0, 0.1, 0, 1], false) // [0, 0, 0.1, 0, 0]
 */
export function withPointBreak(el, on) {
  return [el[0], el[1], el[2], el[3], on ? 1 : 0];
}

/**
 * Pure function. Which per-point INSPECTOR fields are INERT for a given anchor: a
 * CORNER's handle fields (hx, hy) are grayed, because a corner has no bezier handle
 * to edit — enabling the curve (the on-canvas toolbar toggle / point menu, which
 * gives the point a real tangent) is what brings them to life. Position and break
 * are always editable. Read by web/ListField.svelte through the optional
 * `elementFieldDisabled` declaration hook — absent on every other list, so those
 * render byte-identically.
 *
 * @param {number[]} el - [x, y, hx, hy, brk]
 * @param {string} fieldName - the element field's name
 * @returns {boolean}
 *
 * @example paintPointFieldDisabled([0, 0, 0, 0, 0], "hx") // true (a corner's handle)
 * @example paintPointFieldDisabled([0, 0, 0.1, 0, 0], "hx") // false (a curve point)
 * @example paintPointFieldDisabled([0, 0, 0, 0, 0], "x") // false (position is always editable)
 */
export function paintPointFieldDisabled(el, fieldName) {
  return (fieldName === "hx" || fieldName === "hy") && !isCurvePoint(el);
}

/**
 * Pure function. The nearest point ON the visible curve to a LOCAL query point,
 * reported as `{subpath, leg, x, y, dist}`, or null when nothing draws. Walks the
 * FLATTENED polylines (SAMPLES_PER_CUBIC per cubic), so `leg` indexes the segment
 * of the subpath's ANCHOR chain the projection landed on — which is what add-anchor
 * needs to know where in the sequence the new anchor belongs. The closing leg of a
 * closed subpath is not offered for insertion (its index would be the last anchor's).
 *
 * @param {number[][]} scaled - VISIBLE anchors in local units
 * @param {number} lx - query x, local
 * @param {number} ly - query y, local
 * @returns {{subpath: number, leg: number, x: number, y: number, dist: number}|null}
 *
 * @example closestOnCurve([[0, 0, 0, 0, 0], [100, 0, 0, 0, 0]], 40, 8) // {subpath: 0, leg: 0, x: 40, y: 0, dist: 8}
 * @example closestOnCurve([[0, 0, 0, 0, 0]], 5, 5) // null (no drawn segment)
 */
export function closestOnCurve(scaled, lx, ly) {
  const subpaths = splitSubpaths(scaled);
  let best = null;
  subpaths.forEach((sp, si) => {
    if (sp.length < MIN_DRAWN_ANCHORS) return;
    // One flattened polyline PER anchor-leg, so a sample maps back to its leg.
    cubicSegments(sp).forEach((seg, leg) => {
      const pts = sampleCubic(seg, SAMPLES_PER_CUBIC);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const abx = b[0] - a[0], aby = b[1] - a[1];
        const len2 = abx * abx + aby * aby;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lx - a[0]) * abx + (ly - a[1]) * aby) / len2));
        const qx = a[0] + abx * t, qy = a[1] + aby * t;
        const dist = Math.hypot(lx - qx, ly - qy);
        if (!best || dist < best.dist) best = { subpath: si, leg, x: qx, y: qy, dist };
      }
    });
  });
  return best;
}

/**
 * Pure function. THE add-anchor write: the `paintPoints` LIST VALUE with one new
 * CORNER anchor (zero handle) inserted on the curve nearest a LOCAL point, or null
 * when there is no drawn segment. The new anchor lands exactly on the projection,
 * so the curve through it does not jump; list surgery (splice, renumber, companion)
 * goes through core/lists.withElementInserted and only the coordinates are then
 * overwritten. RENUMBERS every later anchor (insert is a renumbering operation).
 *
 * The insert position is the STORAGE index just after the earlier anchor of the
 * clicked leg — mapped from the VISIBLE chain through visibleIndices, so a hidden
 * anchor between them does not misplace it. A zero-extent axis has no fraction, so
 * that coordinate becomes 0.5 (the polygon precedent).
 *
 * @param {object} state - evaluated item state
 * @param {number} lx - query x, LOCAL units
 * @param {number} ly - query y, LOCAL units
 * @returns {{list: number[][], active: (boolean[]|undefined)}|null}
 *
 * @example withAnchorInsertedNear({paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]], w: 100, h: 100}, 50, 6).list // [[0, 0, 0, 0, 0], [0.5, 0, 0, 0, 0], [1, 0, 0, 0, 0]]
 * @example withAnchorInsertedNear({paintPoints: [[0, 0, 0, 0, 0]], w: 100, h: 100}, 5, 5) // null
 */
export function withAnchorInsertedNear(state, lx, ly) {
  const scaled = scaledAnchors(state);
  const hit = closestOnCurve(scaled, lx, ly);
  if (!hit) return null;
  const value = pointsValue(state);
  const storageOf = visibleIndices(value);
  // The clicked leg runs between two VISIBLE anchors of subpath `hit.subpath`; the
  // earlier one's VISIBLE index is (anchors before this subpath) + hit.leg.
  const before = splitSubpaths(scaled).slice(0, hit.subpath).reduce((n, sp) => n + sp.length, 0);
  const index = storageOf[before + hit.leg] + 1;
  const w = state.w ?? 0, h = state.h ?? 0;
  const inserted = withElementInserted(PAINT_POINTS_LIST, value, index);
  const nx = w === 0 ? 0.5 : hit.x / w, ny = h === 0 ? 0.5 : hit.y / h;
  // A fresh CORNER anchor on the curve: overwrite the interpolated element's
  // coordinates with the exact projection and zero its handle / break.
  let el = inserted.list[index];
  el = withElementFieldValue(PAINT_POINTS_LIST.element, el, "x", nx);
  el = withElementFieldValue(PAINT_POINTS_LIST.element, el, "y", ny);
  el = withElementFieldValue(PAINT_POINTS_LIST.element, el, "hx", 0);
  el = withElementFieldValue(PAINT_POINTS_LIST.element, el, "hy", 0);
  el = withElementFieldValue(PAINT_POINTS_LIST.element, el, "brk", 0);
  return { list: withAnchorAt(inserted.list, index, el), active: inserted.active };
}

/**
 * Pure function. The LOCAL rect the path's INK occupies: the union of the box and
 * the hull of every anchor AND its control points, inflated by half the stroke
 * width — because a smooth handle throws a curve's bulge (and a dragged anchor)
 * OUTSIDE the box, which the box alone would under-report. THE BOUNDS PROTOCOL
 * (core/view.localBoundsOf): the one rect culling, band select, the copy/export
 * capture rect AND the effect substrate all read.
 *
 * @param {object} state - evaluated item state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example pathInkRect({paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]], w: 100, h: 100, strokeWidth: 0}) // {x: 0, y: 0, w: 100, h: 100}
 * @example pathInkRect({paintPoints: [[0, 0, 0.5, 0, 0], [1, 1, 0, 0, 0]], w: 100, h: 100, strokeWidth: 0}) // {x: -50, y: 0, w: 150, h: 100} (the mirrored handle reaches past BOTH box edges)
 */
export function pathInkRect(state) {
  const pad = (state.strokeWidth ?? 0) / 2;
  const pts = [];
  for (const [x, y, hx, hy] of scaledAnchors(state)) {
    pts.push([x, y], [x + hx, y + hy], [x - hx, y - hy]);
  }
  const hull = subpathsBBox([pts]);
  const minX = Math.min(0, hull.minX) - pad, minY = Math.min(0, hull.minY) - pad;
  const maxX = Math.max(state.w ?? 0, hull.maxX) + pad, maxY = Math.max(state.h ?? 0, hull.maxY) + pad;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * THE PAINT-PATH PRESET LIBRARY (R7-39 presets law) — STROKE IDIOMS ONLY, never
 * the drawing. `paintPoints` is the author's hand-drawn curve (see this file's
 * header, "IT IS THE AUTHOR'S DRAWING"), so no row here may write it — a preset
 * that redrew the path to demo a stroke look would be the cardinal content
 * violation the law forbids. What CAN vary is everything the stroke framework
 * exposes: paint (stroke colour, `fill` for a closed shape), weight, the two free
 * ends' caps, the corner join, the universal draw-on window (strokeStart/End +
 * phase), and screen-space width. Twelve classic drawing/pen media, the same
 * "recognisable on sight" bar rect.js's card table sets — a viewer should read
 * "chalk" or "highlighter" from the picture alone, no label needed.
 *
 * SPARSE AND STROKE-ONLY, the arrow.js precedent (plugins/arrow.js's 19-row
 * table: head/dash geometry, never colour or opacity) — this family never
 * touches the EFFECTS bundle core/registry.withUniversalEffects injects at
 * registration, so there is no bloom/shadow identity row to carry. "Neon Tube"
 * is built from screen-space saturated colour alone, on that same restraint —
 * a bloom effect would need the full six-key OFF identity on every OTHER row
 * for the hover-leak law, for one preset's glow.
 *
 * EVERY ROW WRITES THE SAME KEY SET (the identity law, restated for this
 * family): stroke, strokeWidth, the two caps, join + miter, the trim window +
 * phase, screen-space, fill and closed. A row that omitted, say, strokeCapStart
 * would leave a HOVERED preset's taper cap on after the click — application is
 * an OVERLAY (app.applyPreset), never a full replace.
 *
 * closed:false + fill:null on every row: this family draws OPEN strokes (a pen
 * idiom is a line, not a silhouette) — the shape stays whatever the author drew,
 * and Closed / Fill remain the user's own choice, untouched by a stroke preset.
 *
 * "Draw-In Reveal" is the one row that moves strokeEnd off 1 — mid-window on
 * purpose, so applying it visibly shows a PARTIAL stroke; pairs with keyframing
 * strokeEnd 0→1 across slides for the widget's own "stroke length" animation
 * (this file's header), which a preset cannot itself keyframe.
 */
const PATH_STROKE_TRIM_FULL = { strokeStart: 0, strokeEnd: 1, strokePhase: 0 };
const PATH_CAPS_ROUND = { strokeCapStart: "round", strokeCapEnd: "round" };
const PATH_CAPS_FLAT = { strokeCapStart: "flat", strokeCapEnd: "flat" };
const PATH_JOIN_ROUND = { strokeJoin: "round", strokeMiter: 4 };
const PATH_SHAPE_OFF = { fill: null, closed: false };

const PRESETS = [
  { name: "Calligraphy", description: "A broad nib's contrast: a heavy taper at both free ends narrows the stroke to a point, the way a flat pen lifts off the page.",
    props: { stroke: "#1a1a1a", strokeWidth: 10, strokeCapStart: "taper", strokeCapEnd: "taper", strokeJoin: "round", strokeMiter: 4, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Felt Marker", description: "A thick round-tipped marker: a fat, fully opaque stroke with soft round ends and no sharp corners anywhere along it.",
    props: { stroke: "#e63946", strokeWidth: 16, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Ballpoint", description: "A thin, precise, fully opaque line — the everyday pen stroke every other idiom in this table departs from.",
    props: { stroke: "#1d3461", strokeWidth: 2, ...PATH_CAPS_FLAT, strokeJoin: "miter", strokeMiter: 4, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Chalk", description: "A desaturated stick of chalk on slate: a wide, pale, slightly translucent stroke with soft round ends — dusty rather than crisp.",
    props: { stroke: "#e8e4d8cc", strokeWidth: 14, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Neon Tube", description: "A glowing acrylic tube: a slim, screaming-saturated stroke held at a constant on-screen width, so it reads as a light source at any zoom rather than a drawn line.",
    props: { stroke: "#00f0ffee", strokeWidth: 5, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: true, ...PATH_SHAPE_OFF } },
  { name: "Dashed Sketch", description: "A construction line broken into short gapped dashes via the universal stroke-trim window, phased so the rhythm starts a beat in rather than exactly at the first anchor.",
    props: { stroke: "#7a7a7a", strokeWidth: 2, ...PATH_CAPS_FLAT, strokeJoin: "miter", strokeMiter: 4, strokeStart: 0.04, strokeEnd: 0.96, strokePhase: 0.15, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Draw-In Reveal", description: "The stroke caught mid-draw, trimmed to its first half — apply this and then keyframe Stroke End from here to 1 across a slide for the path to finish drawing itself on screen.",
    props: { stroke: "#2ec4b6", strokeWidth: 7, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, strokeStart: 0, strokeEnd: 0.5, strokePhase: 0, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Airbrush", description: "A soft wide spray: a very wide, translucent stroke with round ends, so overlapping passes would build up density the way an airbrush does.",
    props: { stroke: "#ff6f9955", strokeWidth: 30, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Technical Pen", description: "A drafting pen's hairline: a fixed, very thin, fully opaque stroke with flat ends and mitered corners — precise construction geometry, not an expressive mark.",
    props: { stroke: "#111111", strokeWidth: 1, ...PATH_CAPS_FLAT, strokeJoin: "miter", strokeMiter: 8, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Crayon", description: "A waxy crayon stroke: a warm saturated colour, uneven-reading round caps, and a width between marker and pen — a child's drawing implement.",
    props: { stroke: "#f4a300e6", strokeWidth: 12, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Highlighter", description: "A translucent wide band meant to sit OVER existing content: a bright yellow stroke at low opacity-reading alpha, flat ends so a highlighted run stops cleanly.",
    props: { stroke: "#fff44f66", strokeWidth: 24, ...PATH_CAPS_FLAT, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
  { name: "Ink Wash", description: "A brush loaded with diluted ink: a broad, softly translucent stroke with round ends that bleeds slightly at the edges, the way wet ink pools on paper.",
    props: { stroke: "#1a1a2e99", strokeWidth: 20, ...PATH_CAPS_ROUND, ...PATH_JOIN_ROUND, ...PATH_STROKE_TRIM_FULL, strokeScreenSpace: false, ...PATH_SHAPE_OFF } },
];

export const paintPathPlugin = {
  type: "paint_path",
  ephemeral: EPHEMERAL.NONE,
  title: "Paint Path",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PRESETS,
  // THE CREATION GESTURE (web/paintPathDraw.js): click each anchor, Shift to
  // axis-lock, Enter or double-click to finish — the polygon's exact repeating-
  // "point" flow. One string; the geometry constructor is paintPathFromWorldPoints.
  placement: "paint_path_chain",
  // DOUBLE-CLICK ACTIVATION: add an anchor ON the curve where you clicked — the
  // SAME "insert_point" handler the polygon uses (web/widget_handlers.js), which
  // only needs the `insertPointAt` hook below.
  activate: "insert_point",
  defaults: {
    type: "paint_path", x: 160, y: 200, w: 360, h: 200, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A gentle default WAVE — two smooth crests — so a freshly placed path
    // immediately reads as an editable bezier curve (non-integer coords, and the
    // tuple storage makes even 0/1 tween-safe anyway).
    paintPoints: [
      [0.02, 0.5, 0.12, -0.42, 0],
      [0.5, 0.5, 0.12, 0.42, 0],
      [0.98, 0.5, 0.12, -0.42, 0],
    ],
    closed: false,
    fill: null,
    stroke: DEFAULT_STROKE, strokeWidth: 4,
    // NO strokeStart/End/Phase/cap defaults: the universal stroke-trim keys are
    // absent-is-identity (core/properties STROKE_TRIM_KEYS), so a fresh path draws
    // whole and renders byte-identically until a knob moves off full.
    ...defaults("opacity"), // opacity: 1
    // NO effects fragment: core/registry.withUniversalEffects injects the whole
    // bundle at REGISTRATION (matching the polygon).
  },
  inspector: [
    ...bundle("transform"),
    // THE ANCHOR LIST as ONE list row (web/ListField.svelte renders every element
    // with per-field `=`, a visibility eye, insert-between, purge) — the polygon's
    // `points` row, one field wider. Augmented with `elementFieldDisabled` so a
    // CORNER's handle (hx/hy) fields render grayed/inert — the ghost precedent, one
    // level down (a corner has no bezier handle to type into; enable the curve
    // first). The augmentation is a SHALLOW COPY per row, so the canonical
    // PAINT_POINTS_LIST declaration the handles carry by reference is untouched.
    ...props("paintPoints").map((row) => ({ ...row, elementFieldDisabled: paintPointFieldDisabled })),
    { key: "closed", label: "Closed", kind: "boolean", category: "formatting", help: "Join each subpath's last anchor back to its first, enclosing an area so it can be filled. Off draws open strokes with no fill." },
    ...props("stroke", "strokeWidth"),
    // THE DRAW-ON: the UNIVERSAL stroke-trim rows (STROKE_TRIM_KEYS —
    // strokeStart/strokeEnd window + strokePhase + the two caps), category
    // strokeMaterial, so they land in the Stroke Material Inspector section right
    // beside stroke/strokeWidth — the SAME rows every stroked box inherits. `= t`
    // on strokeEnd animates the stroke drawing itself on across a slide.
    ...props(...STROKE_SPACE_KEYS, ...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("fill", { fill: { help: "The color or gradient that fills the path's closed subpaths (only when Closed is on). Leave it transparent for a stroke-only path." } }),
    ...props("opacity"),
  ],
  /**
   * Pure function. Is this a GHOST (nothing to draw)? No subpath reaches
   * MIN_DRAWN_ANCHORS visible anchors — the polygon/svg isGhost precedent, so the
   * editor still gives the item an outline and it stays selectable and purgeable.
   *
   * @example paintPathPlugin.isGhost({paintPoints: []}) // true
   * @example paintPathPlugin.isGhost({paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]}) // false
   * @example paintPathPlugin.isGhost({paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 1]]}) // true (a break leaves two 1-anchor subpaths)
   */
  isGhost(state) {
    return !splitSubpaths(visibleAnchors(state)).some((sp) => sp.length >= MIN_DRAWN_ANCHORS);
  },
  // LEGACY MIGRATION: this widget once carried a PRIVATE trim pair
  // (trimStart/trimEnd) that predated the universal stroke-trim framework. A doc
  // that stored them migrates LOUDLY to the universal strokeStart/strokeEnd at
  // load through the declarative rename seam (core/document.withLegacyKeysRenamed;
  // the arrow headSize→headLength precedent), value verbatim — so a keyframed
  // draw-on animation survives the rename. Idempotent: a migrated doc reports
  // nothing. A `strokeStart`/`strokeEnd` already present wins (the `stale` drop).
  legacyKeys: { trimStart: "strokeStart", trimEnd: "strokeEnd" },
  /**
   * Pure function. State → ONE `path` display-list op in LOCAL coords: the WHOLE
   * bezier curve (exact cubics — crisp), with its fill and stroke. The universal
   * stroke-trim seam does the rest: render_gpu/ir.applyStrokeTrim (ports.js)
   * stamps this widget's strokeStart/End/Phase/cap STATE onto the op, and
   * paint_skia's ContourMeasure preprocessing cuts the stroke to that arc-length
   * window before painting — the SAME path every stroked box takes.
   *
   * THE FILL IS TRIM-INDEPENDENT and this shape preserves it BYTE-EQUIVALENTLY to
   * the two-op form 35a393a introduced: the op carries the FULL-path fill, which
   * drawPathOp paints unconditionally under the (separately) windowed stroke, so
   * a trimmed + filled path still shows its whole interior — a trim cuts the
   * stroke, never the fill (the universal law; concerns.md, 2026-07-28). An empty
   * window is resolved at PAINT time (a stroke that keeps nothing draws nothing,
   * the fill still shows), not by dropping the op here. Nothing drawable — no
   * subpath reaching MIN_DRAWN_ANCHORS, or neither a fill nor a stroke — emits
   * nothing. The effects wrap is applied by render_gpu/ports.js, never here.
   */
  emit(s) {
    const closed = fillsInterior(s);
    const d = pathBezierD(scaledAnchors(s), closed);
    if (!d) return [];
    const stroked = (s.strokeWidth ?? 0) > 0;
    const filled = closed && s.fill != null;
    if (!stroked && !filled) return [];
    return [path({
      d,
      fill: filled ? s.fill : null,
      stroke: stroked ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      fillRule: "nonzero",
      opacity: s.opacity ?? 1,
    })];
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the exact bezier `d` from the SAME `scaledAnchors` + `pathBezierD` pair emit()
   * draws with, so what morphs is what renders — every subpath, each open or
   * closed by the one `fillsInterior` predicate rather than a second copy of the
   * rule.
   *
   * UNLIKE THE REST OF THIS FAMILY, THIS WIDGET HAS A BOX. It is `bbox: true` with
   * real `w`/`h` state and box-local anchor coordinates, so it reports its BOX as
   * the space, exactly as the phase-2 shapes do — not the ink rect the connectors
   * must use for want of a box. The two are different rects here (`pathInkRect`
   * unions the box with the control-point hull, since a smooth handle bulges the
   * curve outside it), and the box is the correct one: it is the frame the
   * coordinates were authored in and the frame render_gpu/ports.js `morphIR`
   * multiplies back out by. Reporting the ink rect would re-scale the curve
   * against a frame it was never drawn in.
   *
   * The stroke-trim window (strokeStart/End/Phase) is NOT applied: it cuts the
   * painted stroke at paint time via ContourMeasure and never changes the path,
   * so the outline being morphed is the whole authored curve — the same one a
   * trim of 0..1 shows.
   */
  morphPaths(s) {
    const closed = fillsInterior(s);
    return morphPayloadFromPaths(
      [{ d: pathBezierD(scaledAnchors(s), closed), paint: statePaint(s) }],
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  /** Pure function. Why this path cannot morph YET, or null. Shares the GHOST
   * predicate, so "nothing to morph" and "nothing to draw" are one condition. */
  morphNotReady(s) {
    return paintPathPlugin.isGhost(s) ? "at least one subpath with two visible anchors (this one has nothing to draw)" : null;
  },
  // THE BOUNDS PROTOCOL: the ink rect (box ∪ anchor/control hull), not the box —
  // a smooth handle bulges the curve outside it. This one declaration answers every
  // bounds consumer (culling, band select, capture rect, effect substrate).
  localBounds: pathInkRect,
  // Effects halo (shadow/bloom spill) beyond the ink, as every widget declares it.
  cullMargin: effectsCullMargin,
  /**
   * Pure function. Hit test in LOCAL units. A filled path is hit inside any of its
   * closed subpaths; an open one within a grab band of the flattened curve. Below
   * MIN_DRAWN_ANCHORS there is no geometry, so it falls back to the BBOX (a
   * degenerate path stays selectable and purgeable).
   */
  hitTest(s, lx, ly, tol = 0) {
    const scaled = scaledAnchors(s);
    const subpaths = splitSubpaths(scaled).filter((sp) => sp.length >= MIN_DRAWN_ANCHORS);
    if (subpaths.length === 0)
      return lx >= 0 && lx <= (s.w ?? 0) && ly >= 0 && ly <= (s.h ?? 0);
    const closed = fillsInterior(s);
    const polys = subpaths.map((sp) => flattenSubpath(sp, closed, SAMPLES_PER_CUBIC));
    if (closed && polys.some((poly) => pointInPolygon(poly, lx, ly))) return true;
    const band = (s.strokeWidth ?? 0) / 2 + tol;
    for (const poly of polys)
      for (let i = 1; i < poly.length; i++)
        if (distToSegment(lx, ly, { x: poly[i - 1][0], y: poly[i - 1][1] }, { x: poly[i][0], y: poly[i][1] }) <= band) return true;
    return false;
  },
  // The 9 standard bbox anchors — NOT one per anchor: anchors are STORED
  // references, so index-keyed per-vertex anchors would silently rebind every
  // attached arrow on insert/purge (the polygon's recorded reasoning). The
  // path's anchors are offered as transient SNAP features instead.
  anchors: standardBBoxAnchors,
  /** Pure function. Every visible anchor is a snap POINT (local units), so
   *  dragging another widget aligns to the path's anchors. Index-keyed ids are
   *  safe: a snap feature is consumed within its drag and never stored. */
  snapFeatures(state) {
    return scaledAnchors(state).map(([x, y], i) => ({ kind: "point", x, y, id: `pp${i}` }));
  },
  /**
   * Pure function. THE add-anchor hook the "insert_point" activation calls: the
   * state keys to write plus the new LIST VALUE, or null when there is no curve to
   * insert on. Geometry is withAnchorInsertedNear; this is the declaration that
   * names WHICH keys the host writes, so the handler stays widget-agnostic.
   *
   * @example paintPathPlugin.insertPointAt({paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]], w: 100, h: 100}, 50, 6).key // "paintPoints"
   * @example paintPathPlugin.insertPointAt({paintPoints: [[0, 0, 0, 0, 0]], w: 100, h: 100}, 5, 5) // null
   */
  insertPointAt(state, localX, localY) {
    const value = withAnchorInsertedNear(state, localX, localY);
    return value ? { key: PAINT_POINTS_LIST.key, activeKey: PAINT_POINTS_LIST.activeKey, value } : null;
  },
  /**
   * Pure function. The draggable handles: a POSITION handle (`a<i>`) per STORED
   * anchor, plus a mirrored bezier HANDLE (`h<i>`) ONLY for a CURVE point — both
   * free (UNCONSTRAINED). Each `apply` writes the WHOLE list back with only its own
   * anchor changed. Every STORED anchor gets a position handle, hidden ones included
   * (a hidden anchor that lost its handle could never be shown again).
   *
   * WHY A CORNER GETS NO `h<i>` (the "line stays a line" fix): a corner's mirrored
   * handle sits exactly ON its anchor (offset zero), so a click-drag there would
   * grab the COINCIDENT handle and sprout a curve instead of moving the point. With
   * the handle omitted for a corner, the drag hits the position handle and MOVES the
   * point; a curve is enabled deliberately (the toolbar toggle / point menu), which
   * is when the handle appears.
   *
   * The curve handle declares two ADDITIVE render aspects the CanvasView handle
   * layer reads (both optional in the modifierPoints protocol, so every other widget
   * renders byte-identically): `shape: "triangle"` (drawn as a triangle, not the
   * anchors' square, so the two handle roles read apart) and `stem` (the LOCAL
   * anchor point it tethers to, drawn as a dashed GHOST line so which anchor a handle
   * belongs to is visible).
   *
   * Placed and driven in LOCAL units (CanvasView inverts through node.world first),
   * so rotation/scale need no reasoning here. A zero-extent axis yields no fraction,
   * so that coordinate is KEPT rather than returned as NaN (the polygon precedent).
   * The POSITION handle declares its `element` so the universal hide/show/purge
   * actions reach the list element; the bezier handle is a sub-handle and declares
   * none.
   *
   * @example paintPathPlugin.modifierPoints({paintPoints: [[0, 0, 0.1, 0, 0], [1, 1, 0, 0, 0]], w: 100, h: 50}).map((m) => m.id) // ["a0", "h0", "a1"]
   * @example paintPathPlugin.modifierPoints({paintPoints: [[0, 0, 0.1, 0, 0]], w: 100, h: 50})[1].x // 10
   * @example paintPathPlugin.modifierPoints({paintPoints: [[0, 0, 0.1, 0, 0]], w: 100, h: 50})[1].shape // "triangle"
   * @example paintPathPlugin.modifierPoints({paintPoints: [[0, 0, 0.1, 0, 0]], w: 100, h: 50})[0].element.index // 0
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const active = s[PAINT_POINTS_LIST.activeKey];
    const out = [];
    normalizedAnchors(s).forEach(([nx, ny, hx, hy], i) => {
      out.push({
        id: `a${i}`,
        x: nx * w, y: ny * h,
        element: { list: PAINT_POINTS_LIST, index: i },
        active: elementActive(active, i),
        apply(state, lp) {
          const a = normalizedAnchors(state), cur = a[i];
          const ww = state.w ?? 0, hh = state.h ?? 0;
          return { paintPoints: withAnchorAt(a, i, [
            ww === 0 ? cur[0] : lp.x / ww,
            hh === 0 ? cur[1] : lp.y / hh,
            cur[2], cur[3], cur[4],
          ]) };
        },
      });
      if (isCurvePoint([nx, ny, hx, hy])) {
        out.push({
          id: `h${i}`,
          x: (nx + hx) * w, y: (ny + hy) * h,
          shape: "triangle",
          stem: { x: nx * w, y: ny * h },
          apply(state, lp) {
            const a = normalizedAnchors(state), cur = a[i];
            const ww = state.w ?? 0, hh = state.h ?? 0;
            return { paintPoints: withAnchorAt(a, i, [
              cur[0], cur[1],
              ww === 0 ? cur[2] : lp.x / ww - cur[0],
              hh === 0 ? cur[3] : lp.y / hh - cur[1],
              cur[4],
            ]) };
          },
        });
      }
    });
    return out;
  },
  // POINT TOGGLES (F.20 toolbar, F.18 point menu): the on/off states a paint-path
  // anchor offers, declared so the UNIVERSAL surfaces render them without knowing
  // what a paint path is. web/HandleToolbar.svelte shows a toggle per entry for the
  // selected handles; the on-canvas point menu offers the same. Each is a pure
  // {isOn(element) → bool, set(element, on) → element} pair over the list element,
  // routed through app.transformHandleSelectionElements (one undo unit).
  handleToggles: [
    { key: "curve", label: "Curve", icon: "mdi:vector-curve", isOn: isCurvePoint, set: withPointCurve,
      help: "Give this point a bezier handle so the path curves through it (off makes a sharp corner)." },
    { key: "break", label: "New subpath", icon: "mdi:content-cut", isOn: isBreakPoint, set: withPointBreak,
      help: "Lift the pen at this point so the widget draws it as a separate stroke." },
  ],
  commands: [
    { id: "add-paint-path", title: "Add Paint Path", icon: "mdi:draw", aliases: ["draw", "pen", "paintable path"], run: (app) => app.armCrosshairPlacement(paintPathPlugin) },
  ],
};

/**
 * Pure function. THE paint-path item state for a list of WORLD-space points — the
 * constructor the click-click-click creation flow finalizes through. Fits the box
 * to the points' AABB and stores each as its box fraction, all CORNER anchors (zero
 * handle, no break), so the result is a normal bbox widget the user then curves by
 * dragging handles. A zero-extent axis has no fraction, so those coordinates become
 * 0.5 (the polygon's polygonFromWorldPoints precedent).
 *
 * @param {number[][]} worldPoints - [[x, y], ...] clicked in world units
 * @param {boolean} closed - did the user close the loop
 * @returns {{x: number, y: number, w: number, h: number, paintPoints: number[][], closed: boolean}}
 *
 * @example paintPathFromWorldPoints([[10, 20], [110, 20], [110, 120]], false) // {x: 10, y: 20, w: 100, h: 100, paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [1, 1, 0, 0, 0]], closed: false}
 * @example paintPathFromWorldPoints([[0, 50], [100, 50]], false) // {x: 0, y: 50, w: 100, h: 0, paintPoints: [[0, 0.5, 0, 0, 0], [1, 0.5, 0, 0, 0]], closed: false}
 */
export function paintPathFromWorldPoints(worldPoints, closed) {
  const { minX, minY, maxX, maxY } = subpathsBBox([worldPoints]);
  const w = maxX - minX, h = maxY - minY;
  const frac = (v, lo, extent) => (extent === 0 ? 0.5 : (v - lo) / extent);
  return {
    x: minX, y: minY, w, h,
    paintPoints: worldPoints.map(([x, y]) => [frac(x, minX, w), frac(y, minY, h), 0, 0, 0]),
    closed,
  };
}
