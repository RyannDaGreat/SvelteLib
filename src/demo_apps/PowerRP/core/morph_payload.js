/**
 * THE PROVIDER SIDE OF THE MORPH — a widget's `d` strings becoming a MorphPaths.
 *
 * core/morph.js is the ENGINE: given two payloads and an alpha it returns the
 * intermediate. This module is the other half of that contract, and it exists
 * because of one measured fact about this codebase: EVERY morphable widget here
 * already produces SVG path data. plugins/shape.js calls core/shapes.js
 * `shapePath`, plugins/polygon.js calls `polygonChainPathD`, plugins/svg.js and
 * plugins/iconify.js both flatten through core/svg_paths.js `flattenSvgTree` to
 * `path` ops carrying `d`, and rect/circle are two one-line generators away
 * (`rectPathD`, `ellipsePathD`) from the same thing. So the honest shape of a
 * `morphPaths(state)` capability is NOT "each plugin hand-builds cubic
 * sextuples" — it is "each plugin says which `d` strings it draws", and ONE
 * converter turns those into the engine's currency.
 *
 * WHY THAT MATTERS RATHER THAN BEING A CONVENIENCE: a hand-built payload can
 * disagree with what the widget actually PAINTS, and nothing would catch it —
 * the morph would render a shape the widget never draws at either endpoint. By
 * routing both through the same `d` string, the payload is derived from the ink
 * rather than described alongside it. A plugin that changes its outline changes
 * its morph for free, and cannot forget to.
 *
 * ── WHAT THIS MODULE DOES ────────────────────────────────────────────────────
 *   1. NORMALIZES the grammar. `pathDToSubpaths` runs the `d` through
 *      core/svg_paths.js `transformPathD` at IDENTITY first, which is not a
 *      no-op: that function is already the codebase's absolute-izer, and it
 *      resolves relative commands, implicit-repeat coordinates, H/V, S/T
 *      smoothing and — critically — ARCS, which it converts to cubics via
 *      `arcToCubics`. Re-implementing any of that here would be a second
 *      spelling of a solved problem, and the arc case is exactly where a second
 *      spelling would silently differ (real icon sets lean on `A`).
 *   2. ELEVATES to cubics. After that pass only M/L/C/Q/Z survive; L and Q
 *      elevate EXACTLY (see `lineToCubic` / `quadToCubic`), never by sampling.
 *   3. DECLARES `winding` per subpath, in SCREEN space, via
 *      core/morph_geometry.js `shoelaceWinding` — the same function the engine
 *      re-derives with, so the provider and the engine cannot disagree about a
 *      frame convention.
 *
 * ── THE SPACE IS THE WIDGET'S BOX, AND THE ENGINE UNIT-IZES IT ───────────────
 * A payload carries `space: {w, h}` — the box-local frame its coordinates live
 * in — and the engine normalizes both payloads into a shared UNIT box before
 * aligning, handing back UNIT-space output. That is the whole reason the two
 * halves are separable: the widget's box tweens as ordinary property state
 * through core/interpolators.js, so a morph that worked in box-local coordinates
 * would count the box change TWICE. Providers here therefore report the box they
 * drew in and do NOT pre-divide; the render seam maps the unit output back out
 * through the (separately tweened) box.
 *
 * ── GEOMETRY LAW ─────────────────────────────────────────────────────────────
 * `space` must be NON-NEGATIVE. A stored w/h may be negative in this app — that
 * is a REFLECTION, and it is how Flip is stored — and it is resolved at
 * core/geometry.js `unsignedState` before a plugin ever sees it. Providers below
 * take the state they are handed; `assertMorphPaths` refuses a negative space
 * LOUDLY rather than morphing a flipped shape against an unflipped one.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { shoelaceWinding } from "./morph_geometry.js";
import { matIdentity, tokenizePathD, transformPathD } from "./svg_paths.js";

/**
 * Pure function. A line segment elevated to a cubic, EXACTLY: the two handles
 * sit at the 1/3 and 2/3 points, which reproduces the straight segment
 * identically (a cubic with collinear evenly-spaced controls IS its chord).
 *
 * This is not an approximation and the distinction is load-bearing — the engine
 * lerps control points, and a lerp of control points is AFFINE, so two segments
 * that are both exactly straight stay exactly straight at every intermediate
 * alpha. Sampling instead would put a wobble in a morph between two rectangles.
 *
 * Args:
 *   p0 ([number, number]): the segment's start
 *   p1 ([number, number]): the segment's end
 *
 * Returns:
 *   number[]: a cubic sextuple [c1x, c1y, c2x, c2y, ex, ey]
 *
 * Examples:
 *     >>> lineToCubic([0, 0], [3, 0])
 *     [ 1, 0, 2, 0, 3, 0 ]
 *     >>> lineToCubic([0, 0], [0, 9])
 *     [ 0, 3, 0, 6, 0, 9 ]
 */
export function lineToCubic(p0, p1) {
  return [
    p0[0] + (p1[0] - p0[0]) / 3, p0[1] + (p1[1] - p0[1]) / 3,
    p0[0] + (2 * (p1[0] - p0[0])) / 3, p0[1] + (2 * (p1[1] - p0[1])) / 3,
    p1[0], p1[1],
  ];
}

/**
 * Pure function. A quadratic Bézier elevated to a cubic, EXACTLY — the standard
 * degree elevation c1 = p0 + 2/3(q − p0), c2 = p2 + 2/3(q − p2). The two curves
 * are the same curve, point for point, not merely close.
 *
 * Args:
 *   p0 ([number, number]): start anchor
 *   q ([number, number]): the quadratic's single control point
 *   p2 ([number, number]): end anchor
 *
 * Returns:
 *   number[]: a cubic sextuple [c1x, c1y, c2x, c2y, ex, ey]
 *
 * Examples:
 *     >>> quadToCubic([0, 0], [3, 3], [6, 0])
 *     [ 2, 2, 4, 2, 6, 0 ]
 *     >>> // a degenerate quad whose control sits on the chord stays a line
 *     >>> quadToCubic([0, 0], [3, 0], [6, 0])
 *     [ 2, 0, 4, 0, 6, 0 ]
 */
export function quadToCubic(p0, q, p2) {
  return [
    p0[0] + (2 * (q[0] - p0[0])) / 3, p0[1] + (2 * (q[1] - p0[1])) / 3,
    p2[0] + (2 * (q[0] - p2[0])) / 3, p2[1] + (2 * (q[1] - p2[1])) / 3,
    p2[0], p2[1],
  ];
}

/**
 * Pure function. An SVG path `d` string → the engine's Subpath list, with every
 * segment elevated to a cubic and every subpath's screen-space winding computed.
 *
 * THE GRAMMAR IS NOT PARSED TWICE. The string first goes through
 * core/svg_paths.js `transformPathD` at the IDENTITY matrix, which is this
 * codebase's existing absolute-izer: relative commands, implicit repeats, H/V,
 * S/T smoothing and ARCS all come out as plain absolute M/L/C/Q/Z. Only those
 * five cases are handled below, and an unexpected sixth is a LOUD throw rather
 * than a skipped segment — a silently dropped curve would morph into a shape the
 * widget does not draw.
 *
 * A `Z` sets `closed` on the subpath it terminates and returns the pen to that
 * subpath's start. An `M` following geometry begins a new subpath. A subpath
 * with a start but NO curves (a bare `M`, or `M…Z`) is DROPPED: it has no ink,
 * and feeding a curve-less subpath to the aligner would pair a real contour
 * against nothing.
 *
 * Args:
 *   d (string): SVG path data, any valid grammar
 *
 * Returns:
 *   object[]: Subpaths — {start, curves, closed, winding}
 *
 * Examples:
 *     >>> pathDToSubpaths("M0 0L10 0")
 *     [ { start: [ 0, 0 ], curves: [ [ 3.3333333333333335, 0, 6.666666666666667, 0, 10, 0 ] ], closed: false, winding: 1 } ]
 *     >>> // a closed triangle: three segments, the Z-closing edge included
 *     >>> pathDToSubpaths("M0 0L10 0L5 8Z")[0].curves.length
 *     3
 *     >>> pathDToSubpaths("M0 0L10 0L5 8Z")[0].closed
 *     true
 *     >>> pathDToSubpaths("")
 *     []
 */
export function pathDToSubpaths(d) {
  if (typeof d !== "string" || d.trim() === "") return [];
  // The identity pass IS the parse — see the docblock. It also validates the
  // grammar for us: an unknown command throws there, with its own message.
  const toks = tokenizePathD(transformPathD(d, matIdentity()));
  const out = [];
  let cur = null;          // the subpath being built
  let pen = [0, 0];        // absolute current point
  let i = 0;
  // A subpath is only kept if it drew something; `Z` on a curve-less subpath is
  // as inert as a bare `M`.
  const flush = () => {
    if (cur && cur.curves.length) out.push({ ...cur, winding: shoelaceWinding(cur) });
    cur = null;
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === "M") {
      flush();
      pen = [toks[i++], toks[i++]];
      cur = { start: [pen[0], pen[1]], curves: [], closed: false };
    } else if (cmd === "L") {
      const p1 = [toks[i++], toks[i++]];
      cur.curves.push(lineToCubic(pen, p1));
      pen = p1;
    } else if (cmd === "C") {
      const c = [toks[i++], toks[i++], toks[i++], toks[i++], toks[i++], toks[i++]];
      cur.curves.push(c);
      pen = [c[4], c[5]];
    } else if (cmd === "Q") {
      const q = [toks[i++], toks[i++]], p2 = [toks[i++], toks[i++]];
      cur.curves.push(quadToCubic(pen, q, p2));
      pen = p2;
    } else if (cmd === "Z") {
      // A `Z` DRAWS the closing edge when the pen is not already home. Skia and
      // every exporter paint that edge, so omitting it here would make the
      // payload describe less ink than the widget shows — and the closing edge
      // of a triangle is a third of its outline.
      if (cur && (pen[0] !== cur.start[0] || pen[1] !== cur.start[1]))
        cur.curves.push(lineToCubic(pen, cur.start));
      if (cur) cur.closed = true;
      pen = cur ? [cur.start[0], cur.start[1]] : pen;
      flush();
    } else {
      throw new Error(
        `pathDToSubpaths: unexpected command "${cmd}" after absolute normalization — ` +
        `transformPathD emits only M/L/C/Q/Z, so this is a grammar the parser did not resolve.`);
    }
  }
  flush();
  return out;
}

/**
 * Pure function. THE PROVIDER HELPER every `morphPaths(state)` capability is
 * built on: a list of `d` strings (with optional per-subpath paint) plus the box
 * they were drawn in → one MorphPaths payload.
 *
 * PAINT RIDES ALONG UNBLENDED. Each source entry's `paint` is attached to every
 * subpath that entry's `d` produced, because an SVG icon's contours genuinely
 * carry different fills and the engine pairs subpaths, not widgets. The engine
 * does not blend paint — it carries the target's through — and the render seam
 * hands the pair to core/interpolators.js, which already lerps hex colours and
 * already snaps unlike values. See core/morph.js's header.
 *
 * Args:
 *   sources (Array<{d: string, paint?: object}>): the widget's drawn paths, in
 *     PAINT ORDER (first painted first)
 *   box ({w: number, h: number}): the box-local space those `d` strings use.
 *     NON-NEGATIVE — see the module header's geometry law.
 *   fillRule (string): "nonzero" (default) or "evenodd"
 *
 * Returns:
 *   object: a MorphPaths payload
 *
 * Examples:
 *     >>> const p = morphPayloadFromPaths([{d: "M0 0L10 0L10 10L0 10Z"}], {w: 10, h: 10});
 *     >>> p.space
 *     { w: 10, h: 10 }
 *     >>> p.subpaths.length
 *     1
 *     >>> p.subpaths[0].closed
 *     true
 *     >>> // paint travels with every subpath the entry drew
 *     >>> morphPayloadFromPaths([{d: "M0 0L1 0", paint: {fill: "#f00"}}], {w: 1, h: 1}).subpaths[0].paint
 *     { fill: '#f00' }
 *     >>> morphPayloadFromPaths([], {w: 5, h: 5}).subpaths
 *     []
 */
export function morphPayloadFromPaths(sources, box, fillRule = "nonzero") {
  const subpaths = [];
  for (const src of sources)
    for (const sp of pathDToSubpaths(src.d))
      subpaths.push(src.paint ? { ...sp, paint: src.paint } : sp);
  return { space: { w: box.w ?? 0, h: box.h ?? 0 }, subpaths, fillRule };
}

/**
 * Pure function. The PAINT a widget's own fill/stroke state contributes to its
 * subpaths — the four fields core/morph.js's Subpath.paint carries, read off an
 * ordinary stroked-box state bag.
 *
 * Centralized because six plugins would otherwise each spell out the same
 * `(s.strokeWidth ?? 0) > 0 ? s.stroke : null` dance their own emit() already
 * spells out, and a seventh would spell it differently. `null` fields are kept
 * rather than omitted: the engine hands the whole record to the render seam, and
 * "no stroke" must be expressible as a VALUE so an interpolator can see a pair.
 *
 * Args:
 *   s (object): a widget state bag with fill/stroke/strokeWidth/opacity
 *
 * Returns:
 *   {fill, stroke, strokeWidth, opacity}
 *
 * Examples:
 *     >>> statePaint({fill: "#7aa2f7", stroke: "#000", strokeWidth: 2, opacity: 1})
 *     { fill: '#7aa2f7', stroke: '#000', strokeWidth: 2, opacity: 1 }
 *     >>> // a zero stroke width means NO stroke, exactly as every emit() reads it
 *     >>> statePaint({fill: "#fff", stroke: "#000", strokeWidth: 0})
 *     { fill: '#fff', stroke: null, strokeWidth: 0, opacity: 1 }
 */
export function statePaint(s) {
  const strokeWidth = s.strokeWidth ?? 0;
  return {
    fill: s.fill ?? null,
    stroke: strokeWidth > 0 ? (s.stroke ?? null) : null,
    strokeWidth,
    opacity: s.opacity ?? 1,
  };
}
