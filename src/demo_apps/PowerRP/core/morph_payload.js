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

import { fitBox } from "./geometry.js";
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
 * ── `piece`: ONE AUTHORED PATH IS ONE PIECE (workstream AQ) ──────────────────
 * Each emitted subpath carries `piece: srcIndex` — WHICH ENTRY OF `sources` it
 * came from. That single integer is the whole of the glyph-awareness this engine
 * has, and stating it that way is deliberate: it is not a text feature.
 *
 * WHY IT MATTERS AND WHAT IT REPLACED. This loop used to dissolve every entry's
 * `d` into peer contours and push them into one undifferentiated list, so after
 * it ran there was NO representation anywhere of "these two contours were the
 * same letter". `textMorphPayload` hands one entry per GLYPH and plugins/latex.js
 * hands one per MathJax glyph, so an `O`'s counter became a sibling of every
 * other letter's outer — and pairing then matched it to whatever contour was
 * cheapest ANYWHERE IN THE STRING, while `morphPaintRuns` put the whole string
 * into one fill computation. The user's report ("is it really taking into account
 * the fact that it's text... it looks like it's just morphing it like any old
 * shape") was a literally accurate description of that data model, not an
 * impression. refs/manim_morph_holes_research.md §2.1 names this loop as THE gap.
 *
 * Manim's containment is the thing being adopted, and it is structural rather
 * than clever: a glyph is ONE VMobject holding ALL its contours, Transform aligns
 * one leaf against one leaf, and each leaf gets its own `ctx.fill()`. So the only
 * contours that ever share a fill computation — or a pairing candidate set — are
 * the contours of ONE glyph. Nothing can drift across a counter mid-flight
 * because nothing else is in the path (research note §1.4).
 *
 * WHY AN ID AND NOT A CONTAINER. The payload stays a FLAT array of peer subpaths,
 * so `payloadKey`, the serialized shape, `assertMorphPaths` and every existing
 * reader are untouched — this is a grouping annotation, not a new type. A payload
 * with NO `piece` (an older memo entry, a provider not yet updated) is read as one
 * piece containing everything, which is exactly the pre-AQ behaviour, so absence
 * degrades silently and bit-for-bit rather than being a flag day.
 *
 * WHY IT IS UNIVERSAL RATHER THAN TEXT-SPECIFIC. Every provider already passes
 * `sources` as a list: an SVG icon's `path` ops, an equation's glyphs, a shape's
 * single `d`. "One authored path" is therefore meaningful for all of them, and
 * text/latex get glyph grouping FOR FREE with no text branch anywhere in the
 * engine. A single-source widget gets one piece — i.e. today, exactly.
 *
 * Args:
 *   sources (Array<{d: string, paint?: object}>): the widget's drawn paths, in
 *     PAINT ORDER (first painted first). ONE ENTRY = ONE PIECE.
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
 *     >>> // TWO GLYPHS, each an outer plus a counter: the piece id is what says
 *     >>> // which contours are the same letter. A ring is "M…Z" twice.
 *     >>> const ring = "M0 0L4 0L4 4L0 4ZM1 1L1 3L3 3L3 1Z";
 *     >>> morphPayloadFromPaths([{d: ring}, {d: ring}], {w: 8, h: 4})
 *     ...   .subpaths.map((sp) => sp.piece)
 *     [ 0, 0, 1, 1 ]
 *     >>> // a one-source widget is ONE piece — i.e. the pre-AQ whole-payload grain
 *     >>> morphPayloadFromPaths([{d: ring}], {w: 4, h: 4}).subpaths.map((sp) => sp.piece)
 *     [ 0, 0 ]
 *     >>> morphPayloadFromPaths([], {w: 5, h: 5}).subpaths
 *     []
 */
export function morphPayloadFromPaths(sources, box, fillRule = "nonzero") {
  const subpaths = [];
  sources.forEach((src, piece) => {
    for (const sp of pathDToSubpaths(src.d))
      subpaths.push(src.paint ? { ...sp, paint: src.paint, piece } : { ...sp, piece });
  });
  return { space: { w: box.w ?? 0, h: box.h ?? 0 }, subpaths, fillRule };
}

/**
 * Pure function. The viewBox→box matrix carried by a flatten's enclosing
 * `pushTransform`, or null when the ops are already box-local.
 *
 * BOTH FLATTEN BRANCHES ARE HANDLED, and that is the point of reading the op list
 * rather than recomputing a fit: with preserveAspect ON, `flattenSvgTree` returns
 * a uniform push and leaves the coordinates in viewBox space (null would be
 * wrong); with it OFF, it bakes a non-uniform affine into the coordinates and
 * emits NO push (a recomputed fit would be applied twice). Taking the answer from
 * the ops themselves means this cannot disagree with the flatten that produced
 * them — the same argument that makes the payload derive from the ink.
 *
 * It is the op-list twin of `viewBoxToBoxMatrix` below, which computes the same
 * mapping from a viewBox the caller already parsed (the latex provider's route).
 * Same matrix, different source of truth: there, the artwork frame; here, the
 * flatten's own answer.
 *
 * `signX`/`signY` are read because the op permits them; the flatten never sets
 * them here (a widget-level Flip is resolved at core/geometry.js `normalizedBox`
 * long before this), so they are +1 in practice and cost one multiply to be right
 * if that ever changes.
 *
 * Args:
 *   ops (object[]): a flatten's IR ops
 *
 * Returns:
 *   object|null: an {a,b,c,d,e,f} affine, or null when there is no push
 *
 * Examples:
 *     >>> flattenTransformMatrix([{op: "path", d: "M0 0"}])
 *     null
 *     >>> // a uniform x10 fit offset 3 right: viewBox point (2, 0) → box point (23, 0)
 *     >>> flattenTransformMatrix([{op: "pushTransform", x: 3, y: 0, rotation: 0, scale: 10}])
 *     { a: 10, b: 0, c: 0, d: 10, e: 3, f: 0 }
 */
function flattenTransformMatrix(ops) {
  const push = ops.find((o) => o.op === "pushTransform");
  if (!push) return null;
  const { x = 0, y = 0, rotation = 0, scale = 1, signX = 1, signY = 1 } = push;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return {
    a: cos * scale * signX, b: sin * scale * signX,
    c: -sin * scale * signY, d: cos * scale * signY,
    e: x, f: y,
  };
}

/**
 * Pure function. FLATTENED `path` OPS → a MorphPaths payload — the provider body
 * the two SVG-backed widgets share (plugins/svg.js and plugins/iconify.js).
 *
 * It takes the ops from the SAME `svgToIRWithWarnings` flatten those widgets'
 * emit() draws with, so the morph outline is the artwork piece for piece rather
 * than a second interpretation of it — the identical argument core/shatter.js
 * `svgOpsToParts` makes for the shatter command, and the reason both widgets can
 * share one body at all.
 *
 * NON-PATH OPS ARE DROPPED, deliberately and narrowly: a flatten emits `path` for
 * every drawable element (that is the whole point of core/svg_paths.js — "no new
 * IR op"), so the only things filtered here are the warning/error affordances the
 * widget overlays on damaged art. Morphing into a notice band would be nonsense;
 * the notice still draws at the endpoints, where the widget's own emit() runs.
 *
 * ── THE ENCLOSING pushTransform IS BAKED IN, NOT DROPPED ─────────────────────
 * THIS IS THE WHOLE REASON THIS FUNCTION IS NOT A ONE-LINE FILTER, and it was
 * wrong for a day in exactly the way that is hardest to see. With preserveAspect
 * ON — the default for both widgets — `flattenSvgTree` leaves every `d` in
 * VIEWBOX coordinates and returns the viewBox→box mapping SEPARATELY, as the one
 * `pushTransform` that `svgToIRWithWarnings` wraps the path ops in (its comment:
 * "ON: a uniform pushTransform; coords stay in viewBox space"). Filtering to
 * `op === "path"` therefore keeps the artwork and THROWS AWAY THE ONLY THING
 * THAT SAYS WHERE IT SITS.
 *
 * Nothing downstream can recover it, and nothing downstream complains: the
 * payload's `space` is the widget's box, so the engine unit-izes 24×24 viewBox
 * coordinates by a 200px box and the icon lands at 1%–11% of its own frame,
 * hard against the top-left corner. MEASURED on a 24×24 star in a 200×200 box:
 * bounds (2, 2)–(22, 21) against `space: {w: 200, h: 200}`. The user's report is
 * that picture exactly — "it morphed into the wrong place and turned into a
 * teeny tiny little star" — and then "flicked to the red one" at the endpoint,
 * because `morphPaths` short-circuits at alpha 0/1 to the ORIGINAL payload and
 * ports.morphIR rescales by that payload's own space, so only the ENDPOINTS
 * happened to draw correctly. A bug that is right at both ends and wrong
 * everywhere between is invisible to any test that only checks the endpoints.
 *
 * Baking it here rather than at the two call sites is deliberate: this is the
 * ONE place that already knows a flatten's op list is a transform plus paths, and
 * the two SVG-backed plugins may not import each other to share a fix. Note that
 * `morphPayloadFromViewBox` below has ALWAYS done exactly this for the latex
 * provider, for exactly the stated reason ("the coordinates handed to the engine
 * are the box-local ones the widget actually paints"). The mapping was never in
 * dispute — this route just skipped it.
 *
 * Args:
 *   ops (object[]): IR ops from a flatten — `path` ops for the artwork, plus the
 *     optional enclosing `pushTransform` carrying the viewBox→box mapping
 *   box ({w, h}): the box those ops were flattened into
 *
 * Returns:
 *   object: a MorphPaths payload in BOX-LOCAL coordinates, per-op paint carried
 *   per subpath
 *
 * Examples:
 *     >>> const ops = [{op: "path", d: "M0 0L4 0L4 4Z", fill: "#f00", strokeWidth: 0}];
 *     >>> morphPayloadFromOps(ops, {w: 4, h: 4}).subpaths[0].paint.fill
 *     '#f00'
 *     >>> morphPayloadFromOps(ops, {w: 4, h: 4}).subpaths.length
 *     1
 *     >>> // a rect op (an affordance box) is not artwork and is dropped
 *     >>> morphPayloadFromOps([{op: "rect", x: 0, y: 0, w: 4, h: 4}], {w: 4, h: 4}).subpaths
 *     []
 *     >>> // THE FIX: a 4-unit viewBox scaled x10 into a 40px box lands at 40, not 4
 *     >>> const scaled = [{op: "pushTransform", x: 0, y: 0, rotation: 0, scale: 10},
 *     ...   {op: "path", d: "M0 0L4 0L4 4Z"}, {op: "popTransform"}];
 *     >>> morphPayloadFromOps(scaled, {w: 40, h: 40}).subpaths[0].curves[0].slice(4)
 *     [ 40, 0 ]
 *     >>> // letterboxing rides along: a centered fit keeps its offset
 *     >>> const offset = [{op: "pushTransform", x: 5, y: 0, rotation: 0, scale: 1},
 *     ...   {op: "path", d: "M0 0L4 0"}, {op: "popTransform"}];
 *     >>> morphPayloadFromOps(offset, {w: 14, h: 4}).subpaths[0].start
 *     [ 5, 0 ]
 */
export function morphPayloadFromOps(ops, box) {
  const paths = ops.filter((o) => o.op === "path" && typeof o.d === "string" && o.d.trim() !== "");
  const toBox = flattenTransformMatrix(ops);
  return morphPayloadFromPaths(
    paths.map((o) => ({
      d: toBox ? transformPathD(o.d, toBox) : o.d,
      paint: { fill: o.fill ?? null, stroke: o.stroke ?? null, strokeWidth: o.strokeWidth ?? 0, opacity: o.opacity ?? 1 },
    })),
    box,
    // ONE fillRule for the payload, taken from the FIRST drawable path. The
    // engine's payload carries a single rule (a `d` is one op) while an SVG may
    // mix rules per element; the first path's rule is the honest approximation
    // and matches how the widget's own dominant contour fills. A mixed-rule icon
    // morphs with its leading contour's rule, which is visible only on
    // self-intersecting art.
    paths[0]?.fillRule ?? "nonzero",
  );
}

/**
 * Pure function. A polyline of {x, y} points → the SVG `d` string that draws it,
 * as ONE open subpath. The centerline form the whole connector family morphs by
 * (see `morphPayloadFromConnector`), and the reason it exists here rather than in
 * seven plugins: an arrow, an elbow, a curve and a tangent pair all reduce to
 * "some points, joined", and a second spelling of that would be a second chance
 * to get the M/L grammar wrong.
 *
 * Args:
 *   points (Array<{x, y}>): the polyline's vertices, in draw order
 *
 * Returns:
 *   string: SVG path data ("" for fewer than two points — no ink, and
 *     `pathDToSubpaths` drops a curve-less subpath anyway)
 *
 * Examples:
 *     >>> polylinePathD([{x: 0, y: 0}, {x: 10, y: 0}])
 *     'M0 0L10 0'
 *     >>> // an elbow route: three legs, one open subpath
 *     >>> polylinePathD([{x: 0, y: 0}, {x: 50, y: 0}, {x: 50, y: 40}])
 *     'M0 0L50 0L50 40'
 *     >>> polylinePathD([{x: 3, y: 4}])
 *     ''
 */
export function polylinePathD(points) {
  if (!Array.isArray(points) || points.length < 2) return "";
  return `M${points[0].x} ${points[0].y}` + points.slice(1).map((p) => `L${p.x} ${p.y}`).join("");
}

/**
 * Pure function. THE CONNECTOR PROVIDER: a boxless widget's ABSOLUTE-coordinate
 * `d` strings + its ink rect → a MorphPaths whose space is that rect and whose
 * coordinates are rect-relative.
 *
 * ── WHY THE ARROW FAMILY CANNOT USE `morphPayloadFromPaths` DIRECTLY ─────────
 * Every phase-2 provider so far was a BBOX widget: it has `w`/`h` state, its
 * emit() draws in box-local coordinates, and `space: {w: s.w, h: s.h}` is
 * therefore both true and free. The whole arrow/line/brace family is the
 * opposite — `capabilities: {bbox: false, transform: false}`, NO `w`/`h` state at
 * all, and endpoints stored as ABSOLUTE canvas positions (that is why these
 * plugins emit world coordinates directly and why every one of them declares a
 * `localBounds` ink rect instead of a box).
 *
 * That difference is not cosmetic, and it was MEASURED rather than reasoned
 * about: render_gpu/ports.js `morphIR` scales the engine's unit output by
 * `node.state.w`/`h`, so a connector handing over `space: {w: s.w, h: s.h}`
 * yields `space: {w: 0, h: 0}` and `sx = sy = 0` — the morph paints
 * `M0 0C0 0 0 0 0 0…`, a degenerate zero-size path. NO error, NO warning: a
 * silently invisible widget for the whole interior of its own transition, which
 * is precisely the silent-wrong-picture failure the morph seam's LOUD asserts
 * exist to prevent. `assertMorphPaths` does not catch it either — a zero space
 * is non-negative and every coordinate is finite.
 *
 * So the honest frame for a connector is ITS INK RECT — the same rect its
 * `localBounds` publishes, which is what culling, band select and the effect
 * substrate already agree is "where this widget is". Coordinates are translated
 * by the rect's origin so they are rect-relative, exactly as a bbox widget's are
 * box-relative, and the rect's `w`/`h` become the payload's space. The engine
 * then unit-izes both sides as usual and the morph is frame-correct at both ends.
 *
 * THE NODE BOX STILL HAS TO AGREE, AND AS OF THIS COMMIT IT DOES NOT. This
 * function makes the PAYLOAD honest, and that is all it can do from here:
 * render_gpu/ports.js `morphIR` scales by `node.state.w`/`h`, and a boxless
 * connector's state has neither, so `?? 0` collapses the result exactly as the
 * naive payload did. MEASURED, not feared — tests/morph_connector_test.js pins
 * it as an expected failure of the SEAM (with instructions to invert the test
 * when it closes), so the shortfall is recorded rather than discovered later as
 * a mystery.
 *
 * WHAT CLOSING IT TAKES: a mid-morph node with a boxless endpoint needs the
 * tweened INK RECT as its box AND the rect's origin as its offset — these
 * widgets draw at absolute coordinates under an identity world transform, so a
 * payload measured from the rect's corner has to be placed back at that corner.
 * That is a derive/ports decision about node construction, not a provider one,
 * and it is NOT silently papered over here.
 *
 * Args:
 *   sources (Array<{d: string, paint?: object}>): the widget's drawn paths, in
 *     ABSOLUTE canvas coordinates, in paint order
 *   rect ({x, y, w, h}): the widget's ink rect (its `localBounds`)
 *   fillRule (string): "nonzero" (default) or "evenodd"
 *
 * Returns:
 *   object: a MorphPaths payload, rect-relative, space = the rect's extent
 *
 * Examples:
 *     >>> // a horizontal line from (200,300) to (420,300), ink rect padded by the stroke
 *     >>> const p = morphPayloadFromConnector(
 *     ...   [{d: "M200 300L420 300"}], {x: 197, y: 297, w: 226, h: 6});
 *     >>> p.space
 *     { w: 226, h: 6 }
 *     >>> p.subpaths[0].start
 *     [ 3, 3 ]
 *     >>> p.subpaths[0].closed
 *     false
 */
export function morphPayloadFromConnector(sources, rect, fillRule = "nonzero") {
  const payload = morphPayloadFromPaths(sources, { w: rect.w, h: rect.h }, fillRule);
  const ox = rect.x ?? 0, oy = rect.y ?? 0;
  return {
    ...payload,
    // THE ORIGIN THE COORDINATES WERE MEASURED FROM. A bbox widget has no such
    // field — its box IS its frame and the world transform places it — but a
    // connector draws at ABSOLUTE coordinates under an identity world, so the
    // corner its geometry was made relative to has to travel with the payload or
    // the morph lands at the canvas origin instead of at the widget.
    // render_gpu/ports.js `morphBox` tweens this between the two endpoints and
    // puts the result back as the mid-morph node's offset.
    origin: { x: ox, y: oy },
    subpaths: payload.subpaths.map((sp) => ({
      ...sp,
      start: [sp.start[0] - ox, sp.start[1] - oy],
      curves: sp.curves.map((c) => [c[0] - ox, c[1] - oy, c[2] - ox, c[3] - oy, c[4] - ox, c[5] - oy]),
    })),
  };
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

/**
 * Pure function. The affine matrix mapping a VIEWBOX-framed artwork onto a
 * widget's box — the third provider shape, after `morphPayloadFromPaths` (a
 * widget that draws in its own box) and `morphPayloadFromOps` (a widget whose
 * flatten already mapped for it).
 *
 * WHY IT EXISTS AS A NAMED FUNCTION rather than six lines inside one plugin: a
 * `latexVector` op carries its glyphs in MathJax's ROOT VIEWBOX frame, not in the
 * widget box, and the three places that draw it (render_gpu/pdf_backend.js's
 * latexVector case, render_gpu/svg_backend.js's, and now the morph provider) must
 * agree to the pixel or the morph's first frame jumps away from what the widget
 * was showing at alpha 0. The backends spell this mapping out inline; a FOURTH
 * inline spelling is exactly how the morph would come to disagree with the ink.
 *
 * BOTH FRAMES ARE y-DOWN, so there is no flip here — unlike an image placement,
 * whose unit square has v=1 at its top row. That asymmetry is stated because the
 * PDF backend's own comment has to state it too.
 *
 * `preserveAspect` (the widget default, and latexVector's) is the UNIFORM
 * letterbox fit: scale by min(w/vb.w, h/vb.h) and center the slack, which is what
 * the on-screen render does. OFF is the legacy non-uniform box→box stretch.
 *
 * Args:
 *   viewBox ({minX, minY, w, h}): the artwork's own frame
 *   box ({w, h}): the widget box to map onto
 *   preserveAspect (boolean): uniform letterbox fit (default true)
 *
 * Returns:
 *   object: a 2×3 matrix in core/svg_paths.js's {a,b,c,d,e,f} form
 *
 * Examples:
 *     >>> // a square viewBox into a square box: a plain 2× scale, no offset
 *     >>> viewBoxToBoxMatrix({minX: 0, minY: 0, w: 10, h: 10}, {w: 20, h: 20})
 *     { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }
 *     >>> // a WIDE viewBox letterboxed into a square box: centered vertically
 *     >>> viewBoxToBoxMatrix({minX: 0, minY: 0, w: 20, h: 10}, {w: 20, h: 20})
 *     { a: 1, b: 0, c: 0, d: 1, e: 0, f: 5 }
 *     >>> // preserveAspect OFF stretches each axis independently
 *     >>> viewBoxToBoxMatrix({minX: 0, minY: 0, w: 20, h: 10}, {w: 20, h: 20}, false)
 *     { a: 1, b: 0, c: 0, d: 2, e: 0, f: 0 }
 *     >>> // a non-zero viewBox ORIGIN is subtracted before scaling (MathJax's
 *     >>> // roots have a negative minY — the ascender space above the baseline)
 *     >>> viewBoxToBoxMatrix({minX: 0, minY: -10, w: 10, h: 10}, {w: 10, h: 10})
 *     { a: 1, b: 0, c: 0, d: 1, e: 0, f: 10 }
 */
export function viewBoxToBoxMatrix(viewBox, box, preserveAspect = true) {
  const bw = box.w ?? 0, bh = box.h ?? 0;
  let sx, sy, ox = 0, oy = 0;
  if (preserveAspect) {
    const f = fitBox(viewBox.w, viewBox.h, bw, bh);
    sx = sy = f.scale; ox = f.offsetX; oy = f.offsetY;
  } else {
    sx = bw / viewBox.w; sy = bh / viewBox.h;
  }
  return { a: sx, b: 0, c: 0, d: sy, e: ox - viewBox.minX * sx, f: oy - viewBox.minY * sy };
}

/**
 * Pure function. VIEWBOX-framed `{d, paint?}` artwork → a MorphPaths payload in
 * the widget's box — the provider body for every widget whose outline source is
 * an artwork frame rather than its own box (plugins/latex.js's MathJax glyphs
 * today; a mermaid diagram's shapes the same way if it ever morphs).
 *
 * The `d` strings are baked through `viewBoxToBoxMatrix` by
 * core/svg_paths.js `transformPathD` — the SAME absolute-izer `pathDToSubpaths`
 * runs anyway — so the coordinates handed to the engine are the box-local ones
 * the widget actually paints, and the payload's `space` is honestly the box.
 *
 * Args:
 *   sources (Array<{d: string, paint?: object}>): artwork paths in viewBox coords
 *   viewBox ({minX, minY, w, h}): their frame
 *   box ({w, h}): the widget box. NON-NEGATIVE (the module header's geometry law)
 *   preserveAspect (boolean): uniform letterbox fit (default true)
 *
 * Returns:
 *   object: a MorphPaths payload in box-local space
 *
 * Examples:
 *     >>> const vb = {minX: 0, minY: 0, w: 10, h: 10};
 *     >>> const p = morphPayloadFromViewBox([{d: "M0 0L10 0L10 10Z"}], vb, {w: 20, h: 20});
 *     >>> p.space
 *     { w: 20, h: 20 }
 *     >>> // the 2× bake landed: the first corner sits at the box's far edge
 *     >>> p.subpaths[0].curves[0].slice(4)
 *     [ 20, 0 ]
 *     >>> morphPayloadFromViewBox([], vb, {w: 20, h: 20}).subpaths
 *     []
 */
export function morphPayloadFromViewBox(sources, viewBox, box, preserveAspect = true) {
  const m = viewBoxToBoxMatrix(viewBox, box, preserveAspect);
  return morphPayloadFromPaths(
    sources.map((s) => ({ ...s, d: transformPathD(s.d, m) })),
    box,
    // FONT-DERIVED OUTLINES ARE NONZERO-WOUND, always. A glyph's counters (the
    // holes in e/a/0/8) are wound OPPOSITE its outer contour, so nonzero winding
    // leaves them as holes and even-odd would misfill nested or self-intersecting
    // letterforms — the identical argument render_gpu/pdf_backend.js's
    // latexVector case makes for filling those same glyphs with `f`.
    "nonzero",
  );
}
