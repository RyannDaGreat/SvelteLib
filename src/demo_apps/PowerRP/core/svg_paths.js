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
 * path's own getBounds). Path grammar M L H V C S Q T Z A (abs+rel, implicit
 * repeats, S/T smoothing; `A` arcs are CONVERTED to cubic Béziers at bake time —
 * arcToCubics — so downstream stays PDF-safe; real-world icon sets lean on arcs,
 * which is why they are supported rather than punted). PUNTED, loudly (a
 * `warnings` string naming the FEATURE and the ELEMENT — reported to the console
 * AND drawn as the SVG widget's in-widget notice band, never silent):
 * radial/userSpaceOnUse gradients (→ first-stop solid), masks/clip-paths/filters
 * (rendered UNMASKED), <use>/<image>/<text>, inline `style=` (attributes only),
 * and crammed arc-flag syntax ("A20 20 0 0120 0" — flags must be their own
 * tokens; transformPathD throws rather than misreading geometry).
 *
 * ── STROKE-LINECAP ON DEGENERATE SUBPATHS (the round-dot idiom) ───────────────
 * render_gpu/ir.js's `path` op carries no cap/join fields at all — Skia strokes
 * every path with its own default (BUTT cap, MITER join), and that default is
 * off-limits to change here (ir.js/paint_skia.js are a live sibling's). Most
 * stroked art never notices: a real (non-degenerate) open segment looks the
 * same with a butt cap as SVG's own default butt cap. But stroke-based icon
 * sets (tabler, and the "outline" style generally) draw a DOT as a
 * near-zero-length subpath — the idiomatic `M12 16h.01` — which is a round
 * disc ONLY because `stroke-linecap="round"` extends a half-stroke-width cap
 * past each of its two (coincident) ends. Under Skia's default butt cap a
 * zero-length segment has no length to paint and disappears entirely (measured:
 * a tabler dot goes from ~330px of native ink to 0px).
 *
 * A SEPARATE symptom was also reported and investigated: a faint diagonal
 * hairline near a near-closed rounded outline's seam (e.g. alert-triangle's
 * apex, drawn as one OPEN subpath whose start/end points coincide almost
 * exactly, relying on `stroke-linejoin="round"`'s two overlapping end-caps to
 * read as a smooth corner). MEASURED (tests/svg_stroke_cap_oracle_probe.js,
 * the apex/join region checks) against the browser's own rasterizer at several
 * sizes: no stray-ink discrepancy versus native was found once the dot fix
 * above landed — Skia's own default miter join already closes that seam
 * acceptably at every size tested. `stroke-linejoin` is therefore NOT parsed
 * or acted on here; only `stroke-linecap` is. If a genuine linejoin artifact
 * turns up later (a different icon, a different size), re-run that probe
 * first — it is the oracle this conclusion rests on, not a guess.
 *
 * THE FIX, at this layer (no ir.js change): `stroke-linecap` is read like any
 * other inherited presentation attribute. A drawn shape's `d` is split into its
 * subpaths (splitSubpaths); any subpath whose extent from its own start point
 * is below a small FRACTION of the stroke width (a genuinely zero-or-near-zero
 * -length dot, not a small-but-real segment — DEGENERATE_EXTENT_FRACTION) is
 * pulled OUT of the stroked path and reissued as its own FILLED circle (round
 * cap) or square (square cap) op sized to the stroke width —
 * capExtendsPastEndpoint + degenerateCapShapeD do the geometry; the remaining
 * non-degenerate subpaths keep stroking exactly as before, UNCHANGED (the
 * original `d` string, not a re-serialized equivalent, when nothing in it was
 * degenerate — see degenerateCapSplit). A "butt" cap (the SVG default) leaves a
 * degenerate subpath alone: butt-on-zero-length is legitimately invisible, and
 * that is what plain unstyled strokes have always done here.
 */

import { num, PATH_DECIMALS } from "./shapes.js";
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
 * stroke width, nonzero winding, full opacity, BUTT cap (no cap ink at all —
 * see the module header's stroke-linecap section). Inherited down the tree. */
const ROOT_PAINT = { fill: "#000000", stroke: "none", strokeWidth: 1, fillRule: "nonzero", opacity: 1, strokeLinecap: "butt" };

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
 * grammar `M L H V C S Q T Z A`, ABSOLUTE and RELATIVE (lowercase), implicit
 * coordinate repeats, and S/T smooth-curve reflection. Because a general
 * matrix rotates axes, H/V become L (both endpoints transform like any point).
 * `A` (elliptic arc) is CONVERTED to cubic Béziers (arcToCubics) BEFORE the
 * matrix is applied — an affine maps a Bézier to a Bézier but not an arc to an
 * arc, and pdf_backend rejects arcs, so the output `d` never contains one.
 * Arc FLAGS must be standalone 0/1 tokens; the crammed form ("0120" for
 * "0 1 20") THROWS loudly rather than misreading geometry.
 *
 * Args:
 *   d (string): SVG path data (any M L H V C S Q T Z A, abs or rel)
 *   m ({a,b,c,d,e,f}): the affine matrix to bake in
 *
 * Returns:
 *   string: the transformed ABSOLUTE-coordinate `d` (arc-free)
 *
 * @example transformPathD("M0 0L10 0", {a: 2, b: 0, c: 0, d: 2, e: 5, f: 5}) // "M5 5L25 5"
 * @example transformPathD("m1 1 l2 0", {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}) // "M1 1L3 1" (relative resolved to absolute)
 * @example transformPathD("M0 0H10", {a: 1, b: 0, c: 0, d: -1, e: 0, f: 100}) // "M0 100L10 100" (y-flip: H → L)
 * @example transformPathD("M0 0c1 1 2 1 3 0", {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}) // "M0 0C1 1 2 1 3 0" (relative cubic)
 * @example transformPathD("M0 0A5 5 0 0 1 10 0", matIdentity()).includes("A") // false (arc → cubics)
 * @example transformPathD("M0 0A0 5 0 0 1 10 0", matIdentity()) // "M0 0L10 0" (zero radius → line, per spec)
 */
export function transformPathD(d, m, decimals = undefined) {
  const px = (x, y) => m.a * x + m.c * y + m.e;
  const py = (x, y) => m.b * x + m.d * y + m.f;
  const P = (x, y) => `${num(px(x, y), decimals)} ${num(py(x, y), decimals)}`;
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
      while (typeof toks[i] === "number") {
        const arx = toks[i++], ary = toks[i++], phi = toks[i++];
        const fa = toks[i++], fs = toks[i++];
        if ((fa !== 0 && fa !== 1) || (fs !== 0 && fs !== 1))
          throw new Error(`transformPathD: arc flags must be standalone 0/1 tokens (crammed flag syntax is unsupported), got large-arc=${fa} sweep=${fs}`);
        const ex = toks[i++] + rx0(rel, cx), ey = toks[i++] + rx0(rel, cy);
        if (arx === 0 || ary === 0) {
          // Spec (F.6.6): a zero radius degrades the arc to a straight line.
          out.push(`L${P(ex, ey)}`);
        } else {
          for (const s of arcToCubics(cx, cy, arx, ary, phi, fa, fs, ex, ey))
            out.push(`C${P(s[0], s[1])} ${P(s[2], s[3])} ${P(s[4], s[5])}`);
        }
        cx = ex; cy = ey; pcx = pcy = pqx = pqy = null;
      }
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

// ── degenerate-subpath cap handling (the round-dot idiom, see module header) ──

/** The two-letter tag counts as "M"/"m" (a new subpath) — everything else is a
 * drawing command that belongs to the CURRENT subpath. */
const MOVE_COMMANDS = new Set(["M", "m"]);

/**
 * Pure function. Splits a path `d` (any grammar — an original authored string
 * OR transformPathD's baked M L C Q Z output; splitting only ever looks for
 * "M"/"m" boundaries, so it is agnostic to which other commands appear between
 * them) into one `d` string per subpath, each starting at its own "M"/"m". A
 * `d` with no leading "M" (malformed upstream) returns it as a single subpath
 * unchanged.
 *
 * @example splitSubpaths("M0 0L1 1M5 5L6 6") // ["M0 0L1 1", "M5 5L6 6"]
 * @example splitSubpaths("M0 0L1 1") // ["M0 0L1 1"]
 * @example splitSubpaths("M0 0L1 1Z") // ["M0 0L1 1Z"] (Z stays with its subpath)
 */
export function splitSubpaths(d) {
  const toks = tokenizePathD(d);
  const subpaths = [];
  let current = [];
  for (const t of toks) {
    if (MOVE_COMMANDS.has(t) && current.length) { subpaths.push(current); current = []; }
    current.push(t);
  }
  if (current.length) subpaths.push(current);
  return subpaths.map(tokensToPathD);
}

/** Pure helper. Re-renders a token array (as tokenizePathD would have produced
 * it) back into a `d` string — the exact inverse, used only to hand a subpath's
 * slice back to callers as ordinary path data. */
function tokensToPathD(toks) {
  let out = "", lastWasNum = false;
  for (const t of toks) {
    if (typeof t === "number") {
      out += (lastWasNum && t >= 0 ? " " : "") + num(t);
      lastWasNum = true;
    } else {
      out += t;
      lastWasNum = false;
    }
  }
  return out;
}

/**
 * Pure function. The subpath's own start point (its "M"/"m" coordinate) — the
 * center a degenerate dot collapses to. Throws if `d` does not start with M/m
 * (every subpath splitSubpaths produces does).
 *
 * @example subpathStart("M12 16L12.01 16") // {x: 12, y: 16}
 * @example subpathStart("M3 4") // {x: 3, y: 4}
 */
export function subpathStart(d) {
  const toks = tokenizePathD(d);
  if (!MOVE_COMMANDS.has(toks[0]))
    throw new Error(`subpathStart: expected a subpath starting with M/m, got ${JSON.stringify(d).slice(0, 40)}`);
  return { x: toks[1], y: toks[2] };
}

/**
 * Pure function. The subpath's total EXTENT: the largest distance from its own
 * start point reached by any point ON it — every visited endpoint AND control
 * point (a curve can bow away from a start/end that are themselves coincident,
 * though the dot idiom in practice is always a straight `h`/`l`). A subpath
 * consisting of ONLY its initial "M" (no drawn segment at all) has extent 0.
 *
 * Walks the FULL path grammar (M L H V C S Q T Z A, absolute + relative,
 * exactly transformPathD's command loop) rather than scanning raw number pairs
 * — H/V/S/T/A do not write plain (x,y) pairs (H/V write ONE coordinate; S/T
 * reflect an implicit control point; A's radii/flags are not coordinates at
 * all), so this MUST track the running current point like a real renderer
 * would, not assume every two numbers are a point. This is what lets it run on
 * a shape's ORIGINAL authored `d` (arbitrary grammar, any casing) rather than
 * only on transformPathD's post-bake M/L/C/Q/Z output — which matters because
 * an identity-CTM shape (the common case: preserveAspect ON, no element
 * transform) is never baked at all (see the module's `matIsIdentity` fast
 * path), so a raw `v6` or `h.01` reaches this function verbatim.
 *
 * This is what tells a genuine short segment (e.g. a 3px tick mark, extent 3)
 * apart from the SVG "dot" idiom (`M12 16h.01`, extent 0.01) — the caller
 * compares it to a fraction of the stroke width, not to a fixed epsilon (see
 * DEGENERATE_EXTENT_FRACTION), because the idiom is authored independent of
 * how thick the stroke drawing it happens to be.
 *
 * @example subpathExtent("M12 16L12.01 16") // 0.01
 * @example subpathExtent("M0 0L10 0") // 10
 * @example subpathExtent("M5 5") // 0
 * @example subpathExtent("M12 7v6") // 6 (V writes one coordinate — a raw, unbaked idiom)
 * @example subpathExtent("M12 16h.01") // 0.01 (the exact tabler dot, unbaked)
 */
export function subpathExtent(d) {
  const toks = tokenizePathD(d);
  const { x: sx, y: sy } = subpathStart(d);
  let maxD = 0;
  const visit = (x, y) => { maxD = Math.max(maxD, Math.hypot(x - sx, y - sy)); };
  let cx = sx, cy = sy;
  let i = 0;
  while (i < toks.length) {
    const cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "M" || C === "L") {
      while (typeof toks[i] === "number") { cx = toks[i++] + rx0(rel, cx); cy = toks[i++] + rx0(rel, cy); visit(cx, cy); }
    } else if (C === "H") {
      while (typeof toks[i] === "number") { cx = toks[i++] + rx0(rel, cx); visit(cx, cy); }
    } else if (C === "V") {
      while (typeof toks[i] === "number") { cy = toks[i++] + rx0(rel, cy); visit(cx, cy); }
    } else if (C === "C") {
      while (typeof toks[i] === "number") {
        visit(toks[i] + rx0(rel, cx), toks[i + 1] + rx0(rel, cy)); i += 2;
        visit(toks[i] + rx0(rel, cx), toks[i + 1] + rx0(rel, cy)); i += 2;
        cx = toks[i++] + rx0(rel, cx); cy = toks[i++] + rx0(rel, cy); visit(cx, cy);
      }
    } else if (C === "S" || C === "Q") {
      while (typeof toks[i] === "number") {
        visit(toks[i] + rx0(rel, cx), toks[i + 1] + rx0(rel, cy)); i += 2;
        cx = toks[i++] + rx0(rel, cx); cy = toks[i++] + rx0(rel, cy); visit(cx, cy);
      }
    } else if (C === "T") {
      while (typeof toks[i] === "number") { cx = toks[i++] + rx0(rel, cx); cy = toks[i++] + rx0(rel, cy); visit(cx, cy); }
    } else if (C === "A") {
      while (typeof toks[i] === "number") {
        i += 3; // rx, ry, x-axis-rotation are not coordinates
        i += 2; // large-arc-flag, sweep-flag are not coordinates
        cx = toks[i++] + rx0(rel, cx); cy = toks[i++] + rx0(rel, cy); visit(cx, cy);
      }
    } else if (C === "Z") {
      cx = sx; cy = sy; // Z returns to the subpath start — no new extent
    } else {
      throw new Error(`subpathExtent: unknown path command "${cmd}"`);
    }
  }
  return maxD;
}

/** Fraction of the stroke width below which a subpath's extent counts as "the
 * SVG dot idiom" rather than a genuine short segment. RELATIVE to strokeWidth,
 * not an absolute coordinate epsilon, because `d`'s own units vary with
 * flattenSvgTree's preserveAspect: ON leaves `d` in viewBox space (a `pushTransform`
 * applies the uniform scale later) while OFF bakes the box→box affine directly
 * into `d` — the SAME two modes strokeWidth is computed in (matScale(ctm) *
 * boxScale), so comparing extent to a strokeWidth fraction stays correct in
 * both. Tabler's idiom (`h.01` against `stroke-width="2"`) has extent/width =
 * 0.005; a real short tick mark is drawn at LEAST comparable to the stroke that
 * draws it (extent/width tends to be >= ~1), so 0.1 sits in the wide gap
 * between the two and is not a knife-edge tuned to one icon set. */
const DEGENERATE_EXTENT_FRACTION = 0.1;

/** Pure function. True iff a `stroke-linecap` value renders extra ink past a
 * bare endpoint (the SVG default, "butt", does not — a butt cap ends exactly at
 * the path's own point, so a zero-length segment is legitimately invisible,
 * same as this pipeline's un-capped default).
 * @example capExtendsPastEndpoint("round") // true
 * @example capExtendsPastEndpoint("square") // true
 * @example capExtendsPastEndpoint("butt") // false
 * @example capExtendsPastEndpoint(undefined) // false (the spec default)
 */
export function capExtendsPastEndpoint(cap) {
  return cap === "round" || cap === "square";
}

/**
 * Pure function. The filled `d` for a degenerate stroked subpath's cap: a
 * circle of radius `strokeWidth/2` (round cap) or an axis-aligned square of
 * side `strokeWidth` (square cap) centered on the subpath's single point — the
 * exact shape stroke-linecap paints past a zero-length endpoint per the SVG
 * spec (a round cap is a half-disc at EACH end; two coincident ends' half-discs
 * union into one full disc, and likewise two half-squares into one square).
 *
 * Args:
 *   cx, cy (number): the degenerate subpath's point, box-local
 *   strokeWidth (number): the artwork's (already CTM-scaled) stroke width
 *   cap ("round"|"square"): which shape to build
 *
 * Returns:
 *   string: a `d` path (ellipsePathD for round, a rectPathD-equivalent square
 *   for square)
 *
 * @example degenerateCapShapeD(12, 16, 2, "round").startsWith("M13 16") // true (ellipsePathD at r=1)
 * @example degenerateCapShapeD(0, 0, 4, "square") // "M-2 -2H2V2H-2Z" (a 4x4 square, half-width 2, centered)
 */
export function degenerateCapShapeD(cx, cy, strokeWidth, cap) {
  const r = strokeWidth / 2;
  if (cap === "round") return ellipsePathD(cx, cy, r, r);
  if (cap === "square") return rectPathD(cx - r, cy - r, strokeWidth, strokeWidth, 0, 0);
  throw new Error(`degenerateCapShapeD: cap must be "round" or "square", got ${JSON.stringify(cap)}`);
}

/**
 * Pure function. One drawn shape's `d`, stroke cap and stroke width →
 * `{strokeD, capOps}`: `strokeD` is the `d` for the subpaths that should still
 * be STROKED (joined back into one `d`, or null if none remain), and `capOps`
 * is an array of `{d}` fill shapes for every degenerate subpath the cap turns
 * into a disc/square (see the module header — this is the whole fix). When the
 * cap does not extend past an endpoint (`capExtendsPastEndpoint` false) or the
 * stroke has no width, every subpath is left alone: `{strokeD: d, capOps: []}`,
 * byte-identical to pre-fix behaviour.
 *
 * When NO subpath is degenerate, `strokeD` is `d` BY IDENTITY (the original
 * string, not a re-serialized equivalent) — splitSubpaths/tokensToPathD never
 * runs on the common case, so the overwhelming majority of stroked art (real
 * segments only) stays byte-identical down to formatting, not just geometry
 * (measured: without this, `d`s like "M14 12 L14 48" round-tripped to
 * "M14 12L14 48" — the SAME path, but a needless diff against every existing
 * document and export).
 *
 * @example degenerateCapSplit("M0 0L10 0", "round", 2) // {strokeD: "M0 0L10 0", capOps: []} (a real segment, untouched)
 * @example degenerateCapSplit("M12 16L12.01 16", "round", 2).strokeD // null (the WHOLE d was one dot)
 * @example degenerateCapSplit("M12 16L12.01 16", "round", 2).capOps.length // 1
 * @example degenerateCapSplit("M12 16L12.01 16", "butt", 2) // {strokeD: "M12 16L12.01 16", capOps: []} (butt: no extra ink, left as a real stroke)
 * @example degenerateCapSplit("M0 0L10 0M12 16L12.01 16", "round", 2).capOps.length // 1 (mixed: one real segment kept, one dot pulled out)
 */
export function degenerateCapSplit(d, cap, strokeWidth) {
  if (!capExtendsPastEndpoint(cap) || !(strokeWidth > 0)) return { strokeD: d, capOps: [] };
  const eps = strokeWidth * DEGENERATE_EXTENT_FRACTION;
  const subpaths = splitSubpaths(d);
  const kept = [], capOps = [];
  for (const sub of subpaths) {
    if (subpathExtent(sub) < eps) {
      const { x, y } = subpathStart(sub);
      capOps.push({ d: degenerateCapShapeD(x, y, strokeWidth, cap) });
    } else {
      kept.push(sub);
    }
  }
  if (capOps.length === 0) return { strokeD: d, capOps: [] }; // untouched: original string, not a re-join
  return { strokeD: kept.length ? kept.join("") : null, capOps };
}

/**
 * Pure function. One SVG elliptic-arc segment → cubic Bézier segments, per the
 * SVG spec's endpoint→center parameterization (appendix F.6) split into ≤90°
 * slices, each approximated by one cubic whose control arms are 4/3·tan(δ/4)
 * along the ellipse tangents (the same on-curve-midpoint criterion as KAPPA,
 * which is this formula at δ = 90°). Max radial error of a 90° slice is ~2.7e-4
 * of the radius — invisible at any zoom the app reaches.
 *
 * Degenerate inputs follow the spec: identical endpoints → no segments (the arc
 * is omitted); zero radii are the CALLER's line-fallback (transformPathD), so
 * rx/ry here are assumed non-zero and are |abs|'d and inflated when too small
 * to span the endpoints (F.6.6).
 *
 * Args:
 *   x1, y1 (number): segment start (absolute)
 *   rx, ry (number): ellipse radii (non-zero; sign ignored)
 *   phiDeg (number): ellipse x-axis rotation, degrees
 *   largeArc (0|1): pick the >180° arc of the two candidates
 *   sweep (0|1): 1 = positive-angle (clockwise in y-down SVG space) direction
 *   x2, y2 (number): segment end (absolute)
 *
 * Returns:
 *   number[][]: cubic segments [c1x, c1y, c2x, c2y, ex, ey], start point implied
 *
 * @example arcToCubics(0, 0, 5, 5, 0, 0, 1, 10, 0).length // 2 (a semicircle → two 90° slices)
 * @example arcToCubics(0, 0, 5, 5, 0, 0, 1, 10, 0)[1].slice(4) // [10, 0] (lands exactly on the endpoint)
 * @example arcToCubics(3, 4, 5, 5, 0, 0, 1, 3, 4) // [] (identical endpoints → arc omitted per spec)
 * @example arcToCubics(0, 0, 5, 5, 0, 1, 1, 5, 5).length // 3 (large-arc 270° → three slices)
 */
export function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  // F.6.5 step 1: midpoint-difference vector in the ellipse's axis-aligned frame.
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  // F.6.6 step 3: inflate radii that cannot span the endpoints.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

  // F.6.5 step 2: center in the primed frame (sign picks the arc pair).
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * (rx * y1p) / ry;
  const cyp = coef * (-ry * x1p) / rx;

  // F.6.5 step 3: center back in user space.
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  // F.6.5 steps 4-6: start angle and sweep extent on the unit circle.
  const ang = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = ux * vx + uy * vy;
    return sign * Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
  };
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;

  // Ellipse point + tangent at parameter θ (user space).
  const E = (t) => [cx + rx * cosP * Math.cos(t) - ry * sinP * Math.sin(t),
                    cy + rx * sinP * Math.cos(t) + ry * cosP * Math.sin(t)];
  const dE = (t) => [-rx * cosP * Math.sin(t) - ry * sinP * Math.cos(t),
                     -rx * sinP * Math.sin(t) + ry * cosP * Math.cos(t)];

  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const delta = dth / n;
  const alpha = (4 / 3) * Math.tan(delta / 4);
  const segs = [];
  for (let k = 0; k < n; k++) {
    const ta = th1 + k * delta, tb = ta + delta;
    const [ax, ay] = E(ta), [bx, by] = E(tb);
    const [dax, day] = dE(ta), [dbx, dby] = dE(tb);
    // The final slice lands EXACTLY on the authored endpoint (no float drift).
    const [fx, fy] = k === n - 1 ? [x2, y2] : [bx, by];
    segs.push([ax + alpha * dax, ay + alpha * day, bx - alpha * dbx, by - alpha * dby, fx, fy]);
  }
  return segs;
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
  // A plain CSS color string, validated downstream by render_gpu/ir.js parsePaint.
  // #hex, rgb()/rgba() AND the CSS NAMED colours all get through — the name table
  // lives in ir.js CSS_NAMED_COLORS, the general home where the other two spellings
  // already live, so `red` resolves identically here and when typed into a colour
  // row. It used to be refused, which made the WHOLE widget throw and draw the red
  // error affordance in the EDITOR (measured on skill-icons:fediverse-light, which
  // is `fill="red"`). An unrecognized string still throws there, loudly.
  return v;
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
 * unsupported elements), each naming the ELEMENT it happened on. The pure core
 * stays pure (no console side effect); the adapter reports them once to the
 * console AND the SVG widget draws them as an in-widget notice band
 * (plugins/svg.js warningAffordance) — a degraded SVG must never look correct.
 *
 * ── THE FILL OVERRIDE (`overridePaint`) — MONOCHROME RECOLOUR ────────────────
 * `overridePaint` is the SVG widget's Fill-material row (plugins/svg.js,
 * plugins/iconify.js), and it answers the user ruling "we need to be able to color
 * them, because right now it's just always black". When it is null/absent —
 * the DEFAULT, and what every document written before it stores — this flatten is
 * BYTE-IDENTICAL: the artwork keeps its own intrinsic paints, and `ink` still
 * resolves `currentColor` exactly as before. When it is a paint, EVERY drawn op
 * takes it for BOTH its fill and its stroke, as a MASK would: a multi-colour icon
 * becomes one flat tint, which is what "colour an SVG" means for artwork the widget
 * did not author. Two consequences worth stating because they are choices:
 *   - fill AND stroke, not fill alone. Half the icon sets (tabler, lucide) draw
 *     with `fill="none" stroke="currentColor"`; a fill-only override would leave
 *     those completely unaffected and read as a broken control.
 *   - an op that painted NOTHING still paints nothing. `fill: null` means the
 *     author wrote fill="none" — overriding it would ADD ink the artwork never had
 *     (filling in the middle of a stroked outline icon), so the override REPLACES
 *     paint, it does not create it. That keeps the override an isomorphism on the
 *     artwork's own shape.
 *   - the stroke slot may take a DIFFERENT paint (`overrideStrokePaint`, defaulting to
 *     `overridePaint` so the ordinary case is the one paint described above). It exists
 *     for exactly one asymmetry: fill materials and STROKE materials are separate
 *     registries with DISJOINT rosters, so a fill-only material ("crt") landing in a
 *     stroke slot is a painter CRASH, not a wrong colour. The CALLER decides the
 *     substitution (render_gpu/gpu/svg_raster.svgOverrideStrokePaint asks the stroke
 *     registry and degrades to the material's solid fallback); this flatten stays pure
 *     and knows about neither registry.
 * It lives HERE, in the one pure shared flatten, so both widgets and every backend
 * (Skia GPU, bare-node CLI, PDF/SVG export) get it through the display list with
 * zero backend code — and neither plugin imports the other.
 *
 * Args:
 *   root ({tag, attrs, children}): the parsed <svg> tree
 *   boxW, boxH (number): the target widget box size (box-local units)
 *   opts ({ink, preserveAspect, opacity, overridePaint}): ink for currentColor;
 *     preserveAspect default true; opacity is the widget GROUP opacity seeded onto
 *     the root and compounded into every op (default 1); overridePaint (default
 *     null) recolours every op's fill AND stroke — see above; overrideStrokePaint
 *     (default: overridePaint) is the stroke slot's paint when it must differ
 *
 * Returns:
 *   {ops: object[], transform: {x,y,rotation,scale}|null, warnings: string[]}
 *
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "rect", attrs: {x: "0", y: "0", width: "10", height: "10", fill: "#f00"}, children: []}]}, 20, 20, {preserveAspect: false}).ops[0].fill // "#f00"
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: []}, 20, 20, {}).ops.length // 0
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "rect", attrs: {width: "10", height: "10", fill: "#0f0"}, children: []}]}, 40, 20, {preserveAspect: true}).transform.scale // 2
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "rect", attrs: {width: "10", height: "10", fill: "#0f0"}, children: []}]}, 20, 20, {preserveAspect: false, overridePaint: "#f0f"}).ops[0].fill // "#f0f" (the override wins over the artwork's own green)
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "path", attrs: {d: "M0 0L10 10", fill: "none", stroke: "#000", "stroke-width": "2"}, children: []}]}, 20, 20, {preserveAspect: false, overridePaint: "#f0f"}).ops[0].stroke // "#f0f" (a STROKED outline icon recolours too)
 * @example flattenSvgTree({tag: "svg", attrs: {viewBox: "0 0 10 10"}, children: [{tag: "path", attrs: {d: "M0 0L10 10", fill: "none", stroke: "#000", "stroke-width": "2"}, children: []}]}, 20, 20, {preserveAspect: false, overridePaint: "#f0f"}).ops[0].fill // null (an unpainted fill stays unpainted — the override replaces paint, never adds it)
 */
export function flattenSvgTree(root, boxW, boxH, opts = {}) {
  const ink = opts.ink ?? "#000000";
  const preserveAspect = opts.preserveAspect !== false;
  const overridePaint = opts.overridePaint ?? null;
  // Defaults to the fill's own paint, so a caller that does not distinguish the two
  // slots (every caller before the stroke-material split, and every test that passes a
  // solid) gets the byte-identical monochrome recolour it always got.
  const overrideStrokePaint = opts.overrideStrokePaint ?? overridePaint;
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
  walkSvgNode(root, baseCTM, rootPaint, { ink, gradients, warnings, boxScale, overridePaint, overrideStrokePaint }, ops, true);
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
  // Every punt names the ELEMENT it happened on, not just the feature: the
  // warnings are surfaced to the USER in-widget (plugins/svg.js warningAffordance),
  // and "which element" is what makes one actionable.
  const el = `<${tag || "?"}>`;
  if (attrs.style) ctx.warnings.add(`svg: ${el} inline style= is ignored (v1 reads presentation attributes only)`);
  for (const ref of ["mask", "clip-path", "filter"]) {
    if (attrs[ref]) ctx.warnings.add(`svg: ${el} ${ref}= is unsupported (v1) — the element is rendered without it`);
  }
  const ctm = matMul(parentCTM, parseTransform(attrs.transform));
  // Inherit paint, overriding with this element's own presentation attributes.
  const paint = {
    fill: attrs.fill !== undefined ? attrs.fill : inherited.fill,
    stroke: attrs.stroke !== undefined ? attrs.stroke : inherited.stroke,
    strokeWidth: attrs["stroke-width"] !== undefined ? parseFloat(attrs["stroke-width"]) : inherited.strokeWidth,
    fillRule: attrs["fill-rule"] !== undefined ? attrs["fill-rule"] : inherited.fillRule,
    strokeLinecap: attrs["stroke-linecap"] !== undefined ? attrs["stroke-linecap"] : inherited.strokeLinecap,
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
  // Identity CTM skips the coordinate bake — EXCEPT when the path contains arc
  // commands, which must still be rewritten to cubics ('A'/'a' letters can only
  // be commands in path data, so the regex is a precise arc detector).
  const d = matIsIdentity(ctm) && !/[Aa]/.test(d0) ? d0 : transformPathD(d0, ctm);
  const fill = foldPaintAlpha(resolvePaint(paint.fill, ctx.ink, ctx.gradients, ctx.warnings), paint.fillOpacity);
  const stroke = foldPaintAlpha(resolvePaint(paint.stroke, ctx.ink, ctx.gradients, ctx.warnings), paint.strokeOpacity);
  const strokeWidth = (Number.isFinite(paint.strokeWidth) ? paint.strokeWidth : 1) * matScale(ctm) * ctx.boxScale;
  // fill is never `undefined` (inheritance seeds it from the spec BLACK root); the
  // guard only catches an explicit empty fill="" → no paint.
  const ownFill = fill === undefined ? null : fill;
  const ownStroke = stroke === undefined ? null : stroke;
  const fillRule = paint.fillRule === "evenodd" ? "evenodd" : "nonzero";
  const opacity = Number.isFinite(paint.opacity) ? paint.opacity : 1;
  // STROKE-LINECAP on degenerate subpaths (the round-dot idiom — module header).
  // Only meaningful when this shape is actually stroked; an unstroked shape's
  // `d` is never split, so a fill-only path is untouched (byte-identical).
  const { strokeD, capOps } = ownStroke === null
    ? { strokeD: d, capOps: [] }
    : degenerateCapSplit(d, paint.strokeLinecap, strokeWidth);
  // THE FILL OVERRIDE (flattenSvgTree's `overridePaint`): a monochrome recolour of
  // this op's fill AND stroke. `overridePaintOf` keeps an UNPAINTED slot unpainted,
  // so the override never invents ink the artwork did not have (see the flatten
  // docblock), and returns the own paint UNCHANGED — by identity — when there is
  // no override, which is why an off/absent override is byte-identical.
  const paintedFill = overridePaintOf(ownFill, ctx.overridePaint);
  // The STROKE slot takes `overrideStrokePaint`, which is the same paint as the fill's
  // in every ordinary case and DIFFERS in exactly one: a fill-only MATERIAL, which the
  // stroke registry cannot paint at all (see svg_raster.svgOverrideStrokePaint). The
  // split lives at the call site, not here, so this flatten stays a pure substitution
  // and knows nothing about either material registry.
  const paintedStroke = overridePaintOf(ownStroke, ctx.overrideStrokePaint);
  if (strokeD !== null) {
    ops.push({
      d: strokeD,
      fill: paintedFill,
      stroke: paintedStroke,
      // The stroke WIDTH is a property of the artwork, not of the paint, so it is
      // decided by whether the ARTWORK stroked this shape — the override changes the
      // colour of an existing outline, never its thickness (and never turns a
      // fill-only shape into a stroked one).
      strokeWidth: ownStroke === null ? 0 : strokeWidth,
      fillRule,
      opacity,
    });
  }
  // Every degenerate subpath the cap pulled out becomes its own FILLED disc/
  // square op — a stroke-linecap dot is filled ink, not a stroked line, so it
  // paints with the STROKE's own (possibly overridden) colour and no stroke of
  // its own. `d` was ALREADY baked (degenerateCapSplit runs on the post-CTM
  // `d`), so no further transform applies here.
  for (const capOp of capOps) {
    ops.push({ d: capOp.d, fill: paintedStroke, stroke: null, strokeWidth: 0, fillRule: "nonzero", opacity });
  }
}

/**
 * Pure function. One paint slot under the widget's fill override: the override when
 * BOTH an override is active AND the artwork painted this slot, else the artwork's
 * own paint, returned by identity.
 *
 * The "artwork painted this slot" condition is what makes the override a RECOLOUR
 * rather than a redraw: an op whose fill is null was authored `fill="none"` (an
 * outline icon's interior), and painting it would fill in a shape the artist left
 * open. So null is preserved, and the recolour is exactly a substitution on the
 * paints that exist.
 *
 * Args:
 *   own (string|object|null): the paint the artwork resolved for this slot
 *   override (string|object|null): the widget's override paint, or null when off
 *
 * Returns:
 *   string|object|null
 *
 * Examples:
 *     >>> // an override replaces a painted slot
 *     >>> overridePaintOf("#00ff00", "#ff00ff")
 *     '#ff00ff'
 *     >>> // ...but never creates paint where there was none (fill="none")
 *     >>> overridePaintOf(null, "#ff00ff")
 *     null
 *     >>> // no override: the artwork's own paint, untouched
 *     >>> overridePaintOf("#00ff00", null)
 *     '#00ff00'
 */
export function overridePaintOf(own, override) {
  return override !== null && override !== undefined && own !== null ? override : own;
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
