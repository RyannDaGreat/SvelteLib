/**
 * SVG → PowerRP display-list FLATTEN (the pure, DOM-free core). Given a PARSED
 * SVG tree (plain `{tag, attrs, children}` objects — the DOM parse itself lives
 * in the browser/CLI adapter render_gpu/gpu/svg_raster.js), this module turns it
 * into a list of `path`-op inputs ({d, fill, stroke, ...}) mapped into a target
 * bbox, so both the SVG widget (plugins/svg.js) and the cursor demo widget
 * (plugins/demo/cursor.js) render arbitrary SVG as FIRST-CLASS VECTOR content
 * (crisp at any zoom; real vector in SVG/PDF export).
 *
 * ── WHY THIS SHAPE (the codebase split, verbatim) ─────────────────────────────
 * The idiomatic PowerRP split is "pure math in core/ (bare-node testable),
 * DOM/parse glue outside" — exactly core/shapes.js (a `d`-string generator) +
 * plugins/shape.js (builds the `path` op), and core/particles.js (pure sim) +
 * render_gpu/particle_clock.js (the ambient clock). Mirroring it:
 *   - THIS module is PURE: it never touches the DOM, never imports render_gpu/
 *     (the "core/ never imports render_gpu/" rule, core/properties.js), and
 *     never builds an IR op (it returns `d` strings + paint values, like
 *     core/shapes.js returns a `d`). The PLUGIN builds the `path()` op.
 *   - The DOM parse (string → `{tag, attrs, children}` tree via DOMParser) lives
 *     in the browser/CLI adapter svg_raster.js (the latex_raster.js sibling).
 *
 * ── REUSE, NO NEW IR OP ───────────────────────────────────────────────────────
 * Every SVG shape is flattened to ONE SVG-path-data `d` string — the exact input
 * render_gpu/ir.js `path({d, fill, stroke, strokeWidth, fillRule, opacity})`
 * already takes (its docstring calls itself "the ONE op behind ... any future
 * arbitrary-path widget"). rect/circle/ellipse/polygon/polyline/line all become
 * `d` too (via the shape→path converters below), so a single `path` op renders
 * them all — crisp vector, effects-complete, PDF/SVG-exportable — with NO new IR
 * op (render_gpu/ir.js is off-limits and needs no change).
 *
 * ── COORDINATE FRAMES (documented, since geometry crosses three) ──────────────
 *   1. SHAPE-LOCAL — coordinates as authored in an element, before its own and
 *      ancestor `transform`s.
 *   2. VIEWBOX — after baking the element→root CTM (transformPathD).
 *   3. BOX-LOCAL — the widget's `0..w × 0..h`, y-DOWN space (the frame every
 *      render_gpu/ir.js op uses). The viewBox→box mapping is either a UNIFORM
 *      pushTransform (preserveAspect ON — returned as `transform`) or a
 *      non-uniform affine BAKED into the coords (OFF — `transform` is null).
 *
 * ── HONEST v1 SUPPORT (enough for the cursors + simple icons) ─────────────────
 * Elements: path, rect (incl. rx/ry), circle, ellipse, polygon, polyline, line,
 * g (transforms + inherited paint), nested svg. Paint: fill/stroke/stroke-width/
 * fill-opacity/stroke-opacity/opacity/fill-rule, fill|stroke = "none"/currentColor
 * (→ widget ink)/hex/rgb()/url(#id) → an objectBoundingBox linearGradient (mapped
 * onto ir.js's existing gradient Paint seam — the Skia path op fills it via the
 * path's own getBounds). Path grammar M L H V C S Q T Z (abs+rel, implicit
 * repeats, S/T smoothing). PUNTED, loudly (a `warnings` string, never silent):
 * arcs (`A` — transformPathD throws; PDF-unsafe anyway), radial/userSpaceOnUse
 * gradients (→ first-stop solid), masks/clip-paths/filters (rendered UNMASKED),
 * <use>/<image>/<text>, and inline `style=` (attributes only).
 */

import { num } from "./shapes.js";
import { fitBox } from "./geometry.js";

// Circle→cubic-bezier control-arm length as a fraction of the radius (the
// standard 4-arc circle approximation): a quarter arc's off-tangent control
// point sits KAPPA·r along the tangent. Keeps ellipses PDF-safe (cubics, never
// the `A` arc pdf_backend rejects) and transform-safe (an affine maps a Bézier
// to a Bézier). 4/3·(√2−1) is the exact value that puts the mid-arc on-circle.
const KAPPA = (4 / 3) * (Math.SQRT2 - 1);

/** Elements that DEFINE (don't draw) — never recursed into for geometry. */
const NON_RENDERING_TAGS = new Set([
  "defs", "lineargradient", "radialgradient", "clippath", "mask", "filter",
  "pattern", "symbol", "marker", "metadata", "title", "desc", "style",
]);

/** SVG paint defaults at the document root (spec): fill BLACK, no stroke, unit
 * stroke width, nonzero winding, full opacity. Inherited down the tree. */
const ROOT_PAINT = { fill: "#000000", stroke: "none", strokeWidth: 1, fillRule: "nonzero", opacity: 1 };

// ── matrices (SVG/DOMMatrix convention: x' = a·x + c·y + e, y' = b·x + d·y + f) ─

/** Pure function. The 2×3 identity matrix.
 * @example matIdentity() // {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}
 */
export function matIdentity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/**
 * Pure function. Composes two affine matrices: `m ∘ n` (apply `n` first, then
 * `m`) — the SVG transform-list order (leftmost transform is outermost).
 *
 * @example matMul(matIdentity(), {a: 2, b: 0, c: 0, d: 2, e: 0, f: 0}) // {a: 2, b: 0, c: 0, d: 2, e: 0, f: 0}
 * @example matMul({a: 1, b: 0, c: 0, d: 1, e: 5, f: 6}, {a: 2, b: 0, c: 0, d: 2, e: 0, f: 0}) // {a: 2, b: 0, c: 0, d: 2, e: 5, f: 6}
 */
export function matMul(m, n) {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Pure function. True iff a matrix is (numerically) the identity — the fast-path
 * gate: an identity CTM needs no coordinate baking.
 * @example matIsIdentity(matIdentity()) // true
 * @example matIsIdentity({a: 1, b: 0, c: 0, d: 1, e: 5, f: 0}) // false
 */
export function matIsIdentity(m) {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

/**
 * Pure function. The isotropic LINEAR scale of a matrix — √|det| (√ of the
 * area-scale). Used to scale a scalar stroke width through a bake (a non-uniform
 * matrix has no single scale, so the geometric mean is the honest isotropic
 * approximation). A pure translate → 1 (strokes unchanged).
 *
 * @example matScale(matIdentity()) // 1
 * @example matScale({a: 2, b: 0, c: 0, d: 2, e: 0, f: 0}) // 2
 * @example matScale({a: 4, b: 0, c: 0, d: 1, e: 0, f: 0}) // 2
 */
export function matScale(m) {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/**
 * Pure function. Parses an SVG `transform` attribute (a whitespace/comma
 * separated list of translate/scale/rotate/matrix) into ONE composed matrix.
 * Unknown functions are ignored (v1: skewX/skewY are not composed — they'd need
 * the full 6-param matrix a user can pass via matrix(...) instead). An empty /
 * absent string is the identity.
 *
 * @example parseTransform("") // {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}
 * @example parseTransform("translate(6 7)") // {a: 1, b: 0, c: 0, d: 1, e: 6, f: 7}
 * @example parseTransform("translate(10,7) scale(2)") // {a: 2, b: 0, c: 0, d: 2, e: 10, f: 7}
 * @example parseTransform("matrix(1 0 0 1 3 4)") // {a: 1, b: 0, c: 0, d: 1, e: 3, f: 4}
 */
export function parseTransform(str) {
  let m = matIdentity();
  if (typeof str !== "string") return m;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    const name = match[1];
    const a = match[2].trim().split(/[\s,]+/).filter((s) => s.length).map(Number);
    m = matMul(m, transformFnMatrix(name, a));
  }
  return m;
}

/** Pure function. One transform function name + its numeric args → a matrix.
 * @example transformFnMatrix("scale", [2]) // {a: 2, b: 0, c: 0, d: 2, e: 0, f: 0}
 * @example transformFnMatrix("rotate", [90]).b // 1
 */
export function transformFnMatrix(name, a) {
  if (name === "translate") return { a: 1, b: 0, c: 0, d: 1, e: a[0] || 0, f: a[1] || 0 };
  if (name === "scale") return { a: a[0] ?? 1, b: 0, c: 0, d: a[1] ?? a[0] ?? 1, e: 0, f: 0 };
  if (name === "matrix") return { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] };
  if (name === "rotate") {
    const rad = ((a[0] || 0) * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const rot = { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
    if (a.length >= 3) {
      // rotate(deg cx cy) = translate(cx,cy) · rotate · translate(-cx,-cy)
      const [, cx, cy] = a;
      return matMul(matMul({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rot), { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy });
    }
    return rot;
  }
  return matIdentity(); // skewX/skewY/unknown: not composed in v1 (use matrix())
}

// ── path-data baking ──────────────────────────────────────────────────────────

/**
 * Pure function. Applies an affine matrix to an SVG path `d` string, returning a
 * new ABSOLUTE-coordinate `d`. Supersedes render_gpu/gpu/latex_raster.js's
 * MathJax-only `transformSvgPathD` (which throws on `C`): this handles the full
 * PDF-safe grammar `M L H V C S Q T Z`, ABSOLUTE and RELATIVE (lowercase),
 * implicit coordinate repeats, and S/T smooth-curve reflection. Because a general
 * matrix rotates axes, H/V become L (both endpoints transform like any point).
 * `A` (elliptic arc) THROWS — arcs are PDF-unsafe (pdf_backend rejects them) and
 * the shape converters here never emit one, so a baked arc is an unsupported
 * user SVG, failed loudly (no silent geometry drop).
 *
 * Args:
 *   d (string): SVG path data (any M L H V C S Q T Z, abs or rel)
 *   m ({a,b,c,d,e,f}): the affine matrix to bake in
 *
 * Returns:
 *   string: the transformed ABSOLUTE-coordinate `d`
 *
 * @example transformPathD("M0 0L10 0", {a: 2, b: 0, c: 0, d: 2, e: 5, f: 5}) // "M5 5L25 5"
 * @example transformPathD("m1 1 l2 0", {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}) // "M1 1L3 1" (relative resolved to absolute)
 * @example transformPathD("M0 0H10", {a: 1, b: 0, c: 0, d: -1, e: 0, f: 100}) // "M0 100L10 100" (y-flip: H → L)
 * @example transformPathD("M0 0c1 1 2 1 3 0", {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}) // "M0 0C1 1 2 1 3 0" (relative cubic)
 */
export function transformPathD(d, m) {
  const px = (x, y) => m.a * x + m.c * y + m.e;
  const py = (x, y) => m.b * x + m.d * y + m.f;
  const P = (x, y) => `${num(px(x, y))} ${num(py(x, y))}`;
  const toks = tokenizePathD(d);
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;        // current point + subpath start (absolute)
  let pcx = null, pcy = null, pqx = null, pqy = null; // previous cubic / quad control (absolute) for S / T
  let i = 0;
  while (i < toks.length) {
    const cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "M") {
      // A moveto's SUBSEQUENT coordinate pairs are implicit L (SVG spec); each
      // relative pair steps from the running current point (cx/cy).
      let first = true;
      while (typeof toks[i] === "number") {
        cx = toks[i++] + (rel ? cx : 0); cy = toks[i++] + (rel ? cy : 0);
        out.push(`${first ? "M" : "L"}${P(cx, cy)}`);
        if (first) { sx = cx; sy = cy; first = false; }
        pcx = pcy = pqx = pqy = null;
      }
    } else if (C === "L") {
      while (typeof toks[i] === "number") {
        cx = toks[i++] + (rel ? cx : 0); cy = toks[i++] + (rel ? cy : 0);
        out.push(`L${P(cx, cy)}`); pcx = pcy = pqx = pqy = null;
      }
    } else if (C === "H") {
      while (typeof toks[i] === "number") { cx = toks[i++] + (rel ? cx : 0); out.push(`L${P(cx, cy)}`); pcx = pcy = pqx = pqy = null; }
    } else if (C === "V") {
      while (typeof toks[i] === "number") { cy = toks[i++] + (rel ? cy : 0); out.push(`L${P(cx, cy)}`); pcx = pcy = pqx = pqy = null; }
    } else if (C === "C") {
      while (typeof toks[i] === "number") {
        const x1 = toks[i++] + rx0(rel, cx), y1 = toks[i++] + rx0(rel, cy);
        const x2 = toks[i++] + rx0(rel, cx), y2 = toks[i++] + rx0(rel, cy);
        const ex = toks[i++] + rx0(rel, cx), ey = toks[i++] + rx0(rel, cy);
        out.push(`C${P(x1, y1)} ${P(x2, y2)} ${P(ex, ey)}`);
        pcx = x2; pcy = y2; pqx = pqy = null; cx = ex; cy = ey;
      }
    } else if (C === "S") {
      while (typeof toks[i] === "number") {
        const x1 = pcx === null ? cx : 2 * cx - pcx, y1 = pcy === null ? cy : 2 * cy - pcy;
        const x2 = toks[i++] + rx0(rel, cx), y2 = toks[i++] + rx0(rel, cy);
        const ex = toks[i++] + rx0(rel, cx), ey = toks[i++] + rx0(rel, cy);
        out.push(`C${P(x1, y1)} ${P(x2, y2)} ${P(ex, ey)}`);
        pcx = x2; pcy = y2; pqx = pqy = null; cx = ex; cy = ey;
      }
    } else if (C === "Q") {
      while (typeof toks[i] === "number") {
        const x1 = toks[i++] + rx0(rel, cx), y1 = toks[i++] + rx0(rel, cy);
        const ex = toks[i++] + rx0(rel, cx), ey = toks[i++] + rx0(rel, cy);
        out.push(`Q${P(x1, y1)} ${P(ex, ey)}`);
        pqx = x1; pqy = y1; pcx = pcy = null; cx = ex; cy = ey;
      }
    } else if (C === "T") {
      while (typeof toks[i] === "number") {
        const x1 = pqx === null ? cx : 2 * cx - pqx, y1 = pqy === null ? cy : 2 * cy - pqy;
        const ex = toks[i++] + rx0(rel, cx), ey = toks[i++] + rx0(rel, cy);
        out.push(`Q${P(x1, y1)} ${P(ex, ey)}`);
        pqx = x1; pqy = y1; pcx = pcy = null; cx = ex; cy = ey;
      }
    } else if (C === "Z") {
      out.push("Z"); cx = sx; cy = sy; pcx = pcy = pqx = pqy = null;
    } else if (C === "A") {
      throw new Error(`transformPathD: elliptic arc "A" is unsupported (PDF-unsafe; the SVG flatten does not emit arcs)`);
    } else {
      throw new Error(`transformPathD: unknown path command "${cmd}"`);
    }
  }
  return out.join("");
}

/** Pure helper. Relative-offset selector for a coordinate: the running current
 * value when relative, else 0. Curve control points in ONE segment are all
 * relative to the SAME start point (not the moving end), which is why cx/cy are
 * captured once per command iteration by the caller. */
function rx0(rel, base) {
  return rel ? base : 0;
}

/**
 * Pure function. Tokenizes an SVG path `d` into an array of command letters
 * (strings) and numbers, splitting run-together numbers like ".7.3" → 0.7, 0.3
 * and signed/scientific forms. The number grammar matches the SVG spec's
 * "wsp-separated OR sign/decimal-delimited" numbers.
 *
 * @example tokenizePathD("M0 0L10 0") // ["M", 0, 0, "L", 10, 0]
 * @example tokenizePathD("m1.5.5z") // ["m", 1.5, 0.5, "z"]
 * @example tokenizePathD("c.7.09 1.5.3 2.1-.2") // ["c", 0.7, 0.09, 1.5, 0.3, 2.1, -0.2]
 */
export function tokenizePathD(d) {
  const toks = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let match;
  while ((match = re.exec(d)) !== null) {
    if (match[1] !== undefined) toks.push(match[1]);
    else toks.push(Number(match[2]));
  }
  return toks;
}

// ── shape → path-data converters (everything becomes ONE `d` for the path op) ──

/**
 * Pure function. A rectangle (optionally rounded) as a `d` string, in the rect's
 * own coordinate space. rx/ry round the corners with cubic beziers (never the
 * `A` arc pdf_backend rejects); rx=ry=0 is a sharp rectangle. Missing ry mirrors
 * rx (the SVG rule), each clamped to half the side.
 *
 * @example rectPathD(0, 0, 10, 6, 0, 0) // "M0 0H10V6H0Z"
 * @example rectPathD(0, 0, 20, 20, 5, 5).startsWith("M5 0") // true
 * @example rectPathD(0, 0, 20, 20, 5, 5).includes("C") // true
 */
export function rectPathD(x, y, w, h, rx = 0, ry = 0) {
  let RX = rx > 0 ? rx : (ry > 0 ? ry : 0);
  let RY = ry > 0 ? ry : (rx > 0 ? rx : 0);
  RX = Math.min(RX, w / 2); RY = Math.min(RY, h / 2);
  if (!(RX > 0) || !(RY > 0)) return `M${num(x)} ${num(y)}H${num(x + w)}V${num(y + h)}H${num(x)}Z`;
  const kx = RX * KAPPA, ky = RY * KAPPA;
  const x0 = x, x1 = x + w, y0 = y, y1 = y + h;
  return [
    `M${num(x0 + RX)} ${num(y0)}`,
    `H${num(x1 - RX)}`,
    `C${num(x1 - RX + kx)} ${num(y0)} ${num(x1)} ${num(y0 + RY - ky)} ${num(x1)} ${num(y0 + RY)}`,
    `V${num(y1 - RY)}`,
    `C${num(x1)} ${num(y1 - RY + ky)} ${num(x1 - RX + kx)} ${num(y1)} ${num(x1 - RX)} ${num(y1)}`,
    `H${num(x0 + RX)}`,
    `C${num(x0 + RX - kx)} ${num(y1)} ${num(x0)} ${num(y1 - RY + ky)} ${num(x0)} ${num(y1 - RY)}`,
    `V${num(y0 + RY)}`,
    `C${num(x0)} ${num(y0 + RY - ky)} ${num(x0 + RX - kx)} ${num(y0)} ${num(x0 + RX)} ${num(y0)}`,
    "Z",
  ].join("");
}

/**
 * Pure function. An ellipse (center cx,cy; radii rx,ry) as a 4-cubic-bezier `d`
 * string (the KAPPA circle approximation) — PDF-safe (no `A`) and transform-safe.
 * A circle is the rx==ry case.
 *
 * @example ellipsePathD(0, 0, 10, 10).startsWith("M10 0") // true
 * @example (ellipsePathD(5, 5, 5, 3).match(/C/g) || []).length // 4
 */
export function ellipsePathD(cx, cy, rx, ry) {
  const ox = rx * KAPPA, oy = ry * KAPPA;
  return [
    `M${num(cx + rx)} ${num(cy)}`,
    `C${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)}`,
    `C${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)}`,
    `C${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)}`,
    `C${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)}`,
    "Z",
  ].join("");
}

/**
 * Pure function. A points list ("x,y x,y ..." or "x y x y ...") → a `d` (M then
 * L to each point; closed adds Z). Backs `<polygon>` (closed) and `<polyline>`
 * (open). Fewer than 2 points → "" (nothing to draw).
 *
 * @example pointsToPathD("0,0 10,0 5,8", true) // "M0 0L10 0L5 8Z"
 * @example pointsToPathD("0 0 10 0", false) // "M0 0L10 0"
 * @example pointsToPathD("0,0", true) // ""
 */
export function pointsToPathD(pointsStr, closed) {
  const nums = (pointsStr ?? "").trim().split(/[\s,]+/).filter((s) => s.length).map(Number);
  if (nums.length < 4) return "";
  let d = `M${num(nums[0])} ${num(nums[1])}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += `L${num(nums[i])} ${num(nums[i + 1])}`;
  return closed ? d + "Z" : d;
}

/** Pure helper. Numeric attribute with a default (strips a trailing unit like
 * "px"; a percentage or unparseable value falls back to `dflt`). */
function attrNum(attrs, name, dflt = 0) {
  const v = attrs[name];
  if (v === undefined || v === null) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Pure function. One SVG shape element → its `d` string (in the element's own
 * coordinate space), or null for a non-shape / empty element (the caller warns +
 * skips). Dispatches path/rect/circle/ellipse/polygon/polyline/line.
 *
 * @example elementToPathD("path", {d: "M0 0L1 1"}) // "M0 0L1 1"
 * @example elementToPathD("rect", {x: "0", y: "0", width: "10", height: "6"}) // "M0 0H10V6H0Z"
 * @example elementToPathD("line", {x1: "0", y1: "0", x2: "4", y2: "3"}) // "M0 0L4 3"
 * @example elementToPathD("g", {}) // null
 */
export function elementToPathD(tag, attrs) {
  switch (tag) {
    case "path": {
      const d = attrs.d;
      return typeof d === "string" && d.trim().length ? d : null;
    }
    case "rect":
      return rectPathD(attrNum(attrs, "x"), attrNum(attrs, "y"), attrNum(attrs, "width"), attrNum(attrs, "height"), attrNum(attrs, "rx", 0), attrNum(attrs, "ry", 0));
    case "circle": {
      const r = attrNum(attrs, "r");
      return r > 0 ? ellipsePathD(attrNum(attrs, "cx"), attrNum(attrs, "cy"), r, r) : null;
    }
    case "ellipse": {
      const rx = attrNum(attrs, "rx"), ry = attrNum(attrs, "ry");
      return rx > 0 && ry > 0 ? ellipsePathD(attrNum(attrs, "cx"), attrNum(attrs, "cy"), rx, ry) : null;
    }
    case "polygon":
      return pointsToPathD(attrs.points, true) || null;
    case "polyline":
      return pointsToPathD(attrs.points, false) || null;
    case "line":
      return `M${num(attrNum(attrs, "x1"))} ${num(attrNum(attrs, "y1"))}L${num(attrNum(attrs, "x2"))} ${num(attrNum(attrs, "y2"))}`;
    default:
      return null;
  }
}

// ── paint resolution ──────────────────────────────────────────────────────────

/**
 * Pure function. Resolves an SVG paint value (a fill/stroke attribute) to a
 * PowerRP `path`-op paint: a CSS color STRING (solid), a GRADIENT object (the
 * render_gpu/ir.js parsePaint linearGradient shape), or null ("none"/absent).
 * "currentColor" resolves to `ink` (the latex ink precedent). `url(#id)` looks
 * the gradient up in `gradients` (a {id → {type, stops, from, to}} map the
 * caller built); a missing/unsupported gradient falls back to its first-stop
 * solid (or null) and pushes a `warnings` note — never a silent blank.
 *
 * Args:
 *   value (string|undefined): the raw attribute value
 *   ink (string): the widget ink color for "currentColor"
 *   gradients (object): {id → gradient paint} from collectGradients
 *   warnings (Set<string>): accumulator for loud, deduped punt notices
 *
 * Returns:
 *   string | object | null
 *
 * @example resolvePaint("#fff", "#000", {}, new Set()) // "#fff"
 * @example resolvePaint("none", "#000", {}, new Set()) // null
 * @example resolvePaint("currentColor", "#e11", {}, new Set()) // "#e11"
 * @example resolvePaint(undefined, "#000", {}, new Set()) // undefined (inherit — caller supplies)
 */
export function resolvePaint(value, ink, gradients, warnings) {
  if (value === undefined || value === null) return undefined; // inherit
  const v = String(value).trim();
  if (v === "" || v === "none") return v === "none" ? null : undefined;
  if (v === "currentColor") return ink;
  const url = v.match(/^url\(\s*#([^)\s]+)\s*\)/);
  if (url) {
    const g = gradients[url[1]];
    if (g && g.type === "linearGradient") return g;
    // radial / userSpaceOnUse / missing def → the honest first-stop solid.
    const solid = g?.stops?.[0]?.color ?? null;
    warnings.add(g ? `svg: gradient "${url[1]}" (${g.type ?? "unknown"}) approximated as its first-stop solid color (v1 supports objectBoundingBox linearGradient only)` : `svg: gradient reference "url(#${url[1]})" not found — filled with no paint`);
    return solid;
  }
  return v; // a plain CSS color string (hex / rgb() / named) — parsePaint validates it
}

/**
 * Pure function. A single gradient `offset` attribute → a 0..1 number
 * ("50%" → 0.5, "0.25" → 0.25, "" → 0). Clamped into [0,1].
 *
 * @example parseGradientOffset("50%") // 0.5
 * @example parseGradientOffset("0.25") // 0.25
 * @example parseGradientOffset(undefined) // 0
 */
export function parseGradientOffset(s) {
  if (typeof s !== "string") return 0;
  const pct = s.trim().endsWith("%");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, pct ? n / 100 : n));
}

/** Pure function. A gradient coordinate ("50%" / "0.5" / number) → objectBounding
 * Box fraction. Same rule as an offset (a percentage divides by 100), but NOT
 * clamped (an SVG gradient may place a stop axis slightly outside the box).
 * @example parseGradientCoord("100%") // 1
 * @example parseGradientCoord("0") // 0
 */
export function parseGradientCoord(s) {
  if (s === undefined || s === null) return null;
  const str = String(s).trim();
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return null;
  return str.endsWith("%") ? n / 100 : n;
}

/**
 * Pure function. Walks a parsed SVG tree collecting `<linearGradient>` /
 * `<radialGradient>` defs into a {id → paint} map. A linearGradient with the
 * default (or explicit objectBoundingBox) units becomes the ir.js linearGradient
 * paint {type, stops, from, to}; a radial / userSpaceOnUse gradient is recorded
 * with its type + stops so resolvePaint can fall back to the first stop and warn.
 * Gradients with fewer than 2 stops are skipped (a 1-stop gradient is a solid).
 *
 * @example collectGradients({tag: "svg", children: [{tag: "linearGradient", attrs: {id: "g"}, children: [{tag: "stop", attrs: {offset: "0", "stop-color": "#000"}}, {tag: "stop", attrs: {offset: "1", "stop-color": "#fff"}}]}]}).g.type // "linearGradient"
 * @example collectGradients({tag: "svg", children: []}) // {}
 */
export function collectGradients(root) {
  const out = {};
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const tag = (node.tag || "").toLowerCase();
    if ((tag === "lineargradient" || tag === "radialgradient") && node.attrs?.id) {
      const stops = (node.children ?? [])
        .filter((c) => (c.tag || "").toLowerCase() === "stop")
        .map((c) => ({ offset: parseGradientOffset(c.attrs?.offset), color: stopColor(c.attrs) }));
      if (stops.length >= 2) {
        const units = node.attrs.gradientUnits ?? "objectBoundingBox";
        if (tag === "lineargradient" && units === "objectBoundingBox") {
          out[node.attrs.id] = {
            type: "linearGradient", stops,
            from: { x: parseGradientCoord(node.attrs.x1) ?? 0, y: parseGradientCoord(node.attrs.y1) ?? 0 },
            to: { x: parseGradientCoord(node.attrs.x2) ?? 1, y: parseGradientCoord(node.attrs.y2) ?? 0 },
          };
        } else {
          out[node.attrs.id] = { type: tag === "radialgradient" ? "radialGradient" : "linearGradient", stops };
        }
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** Pure helper. A `<stop>`'s color, folding stop-opacity into an rgba() string
 * when present (so a translucent stop survives into parsePaint). */
function stopColor(attrs) {
  const c = attrs?.["stop-color"] ?? "#000000";
  const op = attrs?.["stop-opacity"];
  if (op === undefined || op === null) return c;
  const a = parseFloat(op);
  return Number.isFinite(a) ? applyAlpha(c, a) : c;
}

/** Pure helper. Folds an alpha into a #rrggbb / #rgb color as rgba(); passes
 * through anything it can't parse (parsePaint reports a genuinely bad color). */
function applyAlpha(color, alpha) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return color;
  const h = m[1];
  const b = h.length === 3 ? [...h].map((x) => parseInt(x + x, 16)) : h.match(/../g).map((x) => parseInt(x, 16));
  return `rgba(${b[0]},${b[1]},${b[2]},${+alpha.toFixed(4)})`;
}

// ── viewBox + the top-level flatten ────────────────────────────────────────────

/**
 * Pure function. The content coordinate frame of an SVG: the `viewBox`
 * (minX minY w h), else a `0 0 width height` box from the width/height
 * attributes. Throws if neither is present (a sizeless SVG can't map to a box —
 * fail loud, no guessed 1×1).
 *
 * @example parseViewBox({viewBox: "0 0 32 32"}) // {minX: 0, minY: 0, w: 32, h: 32}
 * @example parseViewBox({viewBox: "-4 -4 40 40"}) // {minX: -4, minY: -4, w: 40, h: 40}
 * @example parseViewBox({width: "24", height: "16"}) // {minX: 0, minY: 0, w: 24, h: 16}
 */
export function parseViewBox(attrs) {
  if (typeof attrs?.viewBox === "string") {
    const p = attrs.viewBox.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0)
      return { minX: p[0], minY: p[1], w: p[2], h: p[3] };
  }
  const w = parseFloat(attrs?.width), h = parseFloat(attrs?.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { minX: 0, minY: 0, w, h };
  throw new Error(`parseViewBox: <svg> needs a viewBox or positive width/height, got ${JSON.stringify({ viewBox: attrs?.viewBox, width: attrs?.width, height: attrs?.height })}`);
}

/**
 * Pure function. THE flatten: a parsed SVG tree (root `{tag:"svg", attrs,
 * children}`) → `{ops, transform, warnings}` mapped into a `boxW × boxH` widget
 * box. Each op is a `path()`-op input {d, fill, stroke, strokeWidth, fillRule,
 * opacity}; the caller builds the IR `path()` and (when `transform` is non-null)
 * wraps the ops in one pushTransform/popTransform.
 *
 *   preserveAspect ON (default) — the viewBox is UNIFORM-scaled to FIT the box,
 *     centered (letterbox, no squash, the latex/user default). Coordinates stay
 *     in viewBox space (element transforms baked in); `transform` is the
 *     pushTransform ({x, y, scale}) that maps viewBox → box.
 *   preserveAspect OFF — a non-uniform box→box stretch (which the similarity
 *     pushTransform cannot express) is BAKED into every op's coordinates; a
 *     resized box then distorts the art. `transform` is null.
 *
 * `warnings` is a deduped list of loud punt notices (arcs, gradients, masks,
 * unsupported elements) the DOM adapter reports once — the pure core stays pure
 * (no console side effect), the adapter surfaces them.
 *
 * Args:
 *   root ({tag, attrs, children}): the parsed <svg> tree
 *   boxW, boxH (number): the target widget box size (box-local units)
 *   opts ({ink, preserveAspect, opacity}): ink for currentColor; preserveAspect
 *     default true; opacity is the widget GROUP opacity seeded onto the root and
 *     compounded into every op (default 1)
 *
 * Returns:
 *   {ops: object[], transform: {x,y,rotation,scale}|null, warnings: string[]}
 *
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "rect", attrs: {x: "0", y: "0", width: "10", height: "10", fill: "#f00"}, children: []}]}, 20, 20, {preserveAspect: false}).ops[0].fill // "#f00"
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: []}, 20, 20, {}).ops.length // 0
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "rect", attrs: {width: "10", height: "10", fill: "#0f0"}, children: []}]}, 40, 20, {preserveAspect: true}).transform.scale // 2
 */
export function flattenSvgTree(root, boxW, boxH, opts = {}) {
  const ink = opts.ink ?? "#000000";
  const preserveAspect = opts.preserveAspect !== false;
  const vb = parseViewBox(root.attrs ?? {});
  const gradients = collectGradients(root);
  const warnings = new Set();

  // viewBox → box mapping. ON: a uniform pushTransform; coords stay in viewBox
  // space. OFF: bake the non-uniform box→box affine into a base CTM.
  let transform = null, baseCTM = matIdentity();
  if (preserveAspect) {
    const fit = fitBox(vb.w, vb.h, boxW, boxH);
    transform = { x: fit.offsetX - vb.minX * fit.scale, y: fit.offsetY - vb.minY * fit.scale, rotation: 0, scale: fit.scale };
  } else {
    const sx = boxW / vb.w, sy = boxH / vb.h;
    baseCTM = { a: sx, b: 0, c: 0, d: sy, e: -vb.minX * sx, f: -vb.minY * sy };
  }
  const boxScale = preserveAspect ? 1 : matScale(baseCTM); // extra stroke scale baked into OFF coords (ON's is in `transform`)

  const ops = [];
  const rootPaint = { ...ROOT_PAINT, opacity: Number.isFinite(opts.opacity) ? opts.opacity : 1 };
  walkSvgNode(root, baseCTM, rootPaint, { ink, gradients, warnings, boxScale }, ops, true);
  return { ops, transform, warnings: [...warnings] };
}

/** Near-pure helper (pushes into `ops`, adds to `warnings`). Recursively walks
 * one node, composing its transform + inherited paint, and appends a path op per
 * drawn shape. `isRoot` suppresses the root <svg>'s own (rare) paint attrs from
 * masking the spec default. */
function walkSvgNode(node, parentCTM, inherited, ctx, ops, isRoot) {
  const tag = (node.tag || "").toLowerCase();
  if (!isRoot && NON_RENDERING_TAGS.has(tag)) return;
  const attrs = node.attrs ?? {};
  if (attrs.style) ctx.warnings.add("svg: inline style= is ignored (v1 reads presentation attributes only)");
  for (const ref of ["mask", "clip-path", "filter"]) {
    if (attrs[ref]) ctx.warnings.add(`svg: ${ref} is unsupported (v1) — the element is rendered without it`);
  }
  const ctm = matMul(parentCTM, parseTransform(attrs.transform));
  // Inherit paint, overriding with this element's own presentation attributes.
  const paint = {
    fill: attrs.fill !== undefined ? attrs.fill : inherited.fill,
    stroke: attrs.stroke !== undefined ? attrs.stroke : inherited.stroke,
    strokeWidth: attrs["stroke-width"] !== undefined ? parseFloat(attrs["stroke-width"]) : inherited.strokeWidth,
    fillRule: attrs["fill-rule"] !== undefined ? attrs["fill-rule"] : inherited.fillRule,
    // Group opacity COMPOUNDS down the tree (a v1 approximation of true group
    // compositing: exact for non-overlapping content, which covers the cursors).
    opacity: inherited.opacity * (attrs.opacity !== undefined ? clamp01(parseFloat(attrs.opacity)) : 1),
    fillOpacity: attrs["fill-opacity"], strokeOpacity: attrs["stroke-opacity"],
  };

  if (tag === "g" || (tag === "svg" && !isRoot) || isRoot) {
    for (const child of node.children ?? []) walkSvgNode(child, ctm, paint, ctx, ops, false);
    return;
  }

  const d0 = elementToPathD(tag, attrs);
  if (d0 === null) {
    ctx.warnings.add(`svg: <${tag || "?"}> is unsupported in v1 (skipped)`);
    return;
  }
  const d = matIsIdentity(ctm) ? d0 : transformPathD(d0, ctm);
  const fill = foldPaintAlpha(resolvePaint(paint.fill, ctx.ink, ctx.gradients, ctx.warnings), paint.fillOpacity);
  const stroke = foldPaintAlpha(resolvePaint(paint.stroke, ctx.ink, ctx.gradients, ctx.warnings), paint.strokeOpacity);
  const strokeWidth = (Number.isFinite(paint.strokeWidth) ? paint.strokeWidth : 1) * matScale(ctm) * ctx.boxScale;
  ops.push({
    d,
    // fill is never `undefined` (inheritance seeds it from the spec BLACK root);
    // the guard only catches an explicit empty fill="" → no paint.
    fill: fill === undefined ? null : fill,
    stroke: stroke === undefined ? null : stroke,
    strokeWidth: stroke === undefined || stroke === null ? 0 : strokeWidth,
    fillRule: paint.fillRule === "evenodd" ? "evenodd" : "nonzero",
    opacity: Number.isFinite(paint.opacity) ? paint.opacity : 1,
  });
}

/** Pure helper. Folds a fill-opacity / stroke-opacity into a SOLID string paint
 * (gradients + null pass through unchanged; per-stop opacity is handled at the
 * stop). Undefined opacity → the paint unchanged. */
function foldPaintAlpha(paint, opacityAttr) {
  if (opacityAttr === undefined || opacityAttr === null) return paint;
  if (typeof paint !== "string") return paint;
  const a = parseFloat(opacityAttr);
  return Number.isFinite(a) ? applyAlpha(paint, a) : paint;
}

/** Pure helper. Clamp to [0,1], NaN → 1. */
function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
