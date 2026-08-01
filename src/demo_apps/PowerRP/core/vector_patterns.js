/**
 * VECTOR PATTERNS — the tiling engine behind the `pattern` material kind.
 *
 * ── THE USER RULING (verbatim intent) ─────────────────────────────────────────
 * "We should have a vector material… vector pattern material… like stripes or
 * checkerboard or diamonds or polka dots or even random polka dots… or plaid…
 * We'd want tons of presets, of course. Or maybe just like repeated SVG and we
 * could have a few SVG things that are tiled either hexagonally or triangularly
 * or most commonly grid-wise. And it's a special material because it uses vector
 * graphics to do it… Of course, we would want to have like a scale and an offset
 * for this too, like X and Y offset."
 *
 * ── ONE TILING ENGINE, NO PER-FAMILY TILING MATH ──────────────────────────────
 * THE DESIGN DECISION worth reading before touching anything here: every pattern
 * in this file is a RECTANGULAR fundamental domain, tiled by simple repetition in
 * both axes. There is no hexagonal tiler, no triangular tiler, no brick tiler.
 *
 * A hexagonal tiling's repeat unit IS a rectangle — one containing two half-offset
 * hexes. A brick/half-drop layout is a rectangle containing two offset rows. So the
 * offset lives in the CELL'S CONTENT, generated once by a pure function, and the
 * tiler stays a single `repeat in x, repeat in y`. This is what lets Skia's picture
 * shader, SVG's `<pattern>` and the PDF stamping loop all consume the SAME cell
 * with no backend knowing which family it came from.
 *
 * The alternative — a tiling `kind` each backend branches on — was rejected: it
 * would mean three implementations of hex offsetting that must agree pixel-for-
 * pixel across a raster backend and two vector exporters, which is precisely the
 * shape of defect this codebase has repeatedly paid for.
 *
 * ── THE CELL CONTRACT ─────────────────────────────────────────────────────────
 * A generator is a PURE function `(params) => cell`, where a cell is
 *
 *     {w, h, shapes: [{d, paint, fillRule?}, …]}
 *
 *   · `w`, `h`   — the fundamental domain in PATTERN units (before scale). The
 *                  tile steps by exactly this, so seamlessness is a property of
 *                  the generator: any ink crossing an edge must ALSO appear,
 *                  identically, across the opposite edge. patternCellSeamProblem
 *                  checks that mechanically rather than by eye.
 *   · `shapes`   — z-ordered path records. `d` is an SVG path string (the ONE
 *                  geometry currency this codebase already speaks — core/svg_paths
 *                  builds it, all three backends consume it). `paint` is "ink" or
 *                  "background", resolved to real colours by the CONSUMER, so one
 *                  cell serves every colour scheme without regeneration.
 *
 * A generator NEVER draws colours and never reads the document. It is pure
 * geometry over its own params, which is what makes the doctests meaningful and
 * the three backends agree.
 *
 * ── DETERMINISM (CLAUDE.md's three kinds) ─────────────────────────────────────
 * A pattern is PROPERTY STATE, full stop. The random-dot generators take a stored
 * integer `seed` and hash it — there is no wall clock and no Math.random anywhere
 * in this file, so Δt = 0 renders a byte-identical picture and a seed round-trips
 * through a save. Scattering is a pure function of (seed, index), the same
 * discipline core/particles.js already uses.
 *
 * DOM-free and bare-node loadable, like the rest of core/.
 */

import { rectPathD, ellipsePathD, arcToCubics, transformPathD } from "./svg_paths.js";

/** The two abstract paint slots a cell shape may name. The cell is colour-blind:
 *  a consumer maps these to real colours (and "background" may be OFF entirely),
 *  so recolouring a pattern never regenerates its geometry. */
export const CELL_PAINTS = Object.freeze(["ink", "background"]);

/** Decimal places cell geometry is rounded to. Patterns are authored in units of
 *  ~1-100 and scaled at paint time, so 4 places is far below a device pixel while
 *  keeping the emitted `d` strings (and the SVG/PDF byte streams) short. */
const CELL_PRECISION = 4;

/** Pure. A number as a compact cell-geometry string (no exponent, no -0, trailing
 *  zeros stripped) — the same rounding all three backends see, so a seam that
 *  matches here matches everywhere.
 *
 *  @example cellNum(1.5) // "1.5"
 *  @example cellNum(0.30000000000000004) // "0.3"
 *  @example cellNum(-0) // "0"
 */
export function cellNum(v) {
  if (!Number.isFinite(v)) throw new Error(`vector_patterns: non-finite coordinate (${v}) — a cell's geometry must be finite`);
  const r = Number(v.toFixed(CELL_PRECISION));
  return Object.is(r, -0) ? "0" : String(r);
}

/**
 * Pure function. A 32-bit integer hash of (seed, index, stream) → a float in
 * [0, 1). The ONE randomness source in this file, and the reason "random polka
 * dots" is property state rather than ephemeral state: it reads no clock and no
 * global RNG, so the same seed always lays out the same dots.
 *
 * Deliberately the same shape as core/particles.js's hash — an integer avalanche
 * (xorshift-multiply), not a linear congruential step, so consecutive indices do
 * not produce visibly correlated positions (which would read as a grid, defeating
 * the point of scattering).
 *
 * @param {number} seed - the stored document seed
 * @param {number} index - which item in the scatter
 * @param {number} stream - which coordinate (0 = x, 1 = y, 2 = radius, …)
 * @returns {number} a float in [0, 1)
 *
 * @example hashUnit(1, 0, 0) < 1 && hashUnit(1, 0, 0) >= 0 // true
 * @example hashUnit(7, 3, 0) === hashUnit(7, 3, 0) // true (deterministic)
 * @example hashUnit(7, 3, 0) === hashUnit(7, 3, 1) // false (streams differ)
 */
export function hashUnit(seed, index, stream) {
  let h = (Math.trunc(seed) | 0) ^ Math.imul(Math.trunc(index) | 0, 0x9e3779b1) ^ Math.imul(Math.trunc(stream) | 0, 0x85ebca6b);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Pure. A full-cell background rectangle — the first shape of nearly every
 *  generator. Kept as one helper so "the background covers exactly the domain"
 *  is stated once instead of in fifteen generators.
 *
 *  @example backgroundShape(4, 4) // {d: "M0 0H4V4H0Z", paint: "background"}
 */
function backgroundShape(w, h) {
  return { d: rectPathD(0, 0, w, h), paint: "background" };
}

/** Pure. An axis-aligned rectangle of ink.
 *  @example inkRect(0, 0, 2, 4) // {d: "M0 0H2V4H0Z", paint: "ink"}
 */
function inkRect(x, y, w, h) {
  return { d: rectPathD(x, y, w, h), paint: "ink" };
}

/** Pure. A circle of ink.
 *  @example inkCircle(5, 5, 2).paint // "ink"
 */
function inkCircle(cx, cy, r) {
  return { d: ellipsePathD(cx, cy, r, r), paint: "ink" };
}

/** Pure. A closed polygon of ink from [x, y] pairs.
 *  @example inkPolygon([[0, 0], [2, 0], [1, 2]]) // {d: "M0 0L2 0L1 2Z", paint: "ink"}
 */
function inkPolygon(points) {
  const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${cellNum(x)} ${cellNum(y)}`).join("") + "Z";
  return { d, paint: "ink" };
}

/**
 * Pure function. Clamps a value into [lo, hi], LOUD on a non-finite input — the
 * one guard every generator's params pass through, so a NaN from a broken equation
 * is reported by name instead of producing an empty (silently invisible) cell.
 *
 * @example clampParam("width", 0.5, 0, 1) // 0.5
 * @example clampParam("width", 2, 0, 1) // 1
 */
function clampParam(name, v, lo, hi) {
  if (!Number.isFinite(v)) throw new Error(`vector_patterns: parameter "${name}" is ${v} — a pattern parameter must be a finite number`);
  return Math.min(hi, Math.max(lo, v));
}

// ── THE GENERATORS ────────────────────────────────────────────────────────────
// Each is a pure (params) => cell. Every one is registered in PATTERN_GENERATORS
// below; nothing else in the codebase may hold a generator, so the roster and the
// engine cannot drift apart.

/**
 * Pure function. STRIPES — vertical bands, `ratio` of the cell inked. The
 * simplest fundamental domain there is: one period wide, full height.
 *
 * Seamless because the ink is strictly inside [0, ratio·w] and the domain steps by
 * exactly `w`.
 *
 * @param {{period: number, ratio: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example stripesCell({period: 10, ratio: 0.5}).w // 10
 * @example stripesCell({period: 10, ratio: 0.5}).shapes[1].d // "M0 0H5V10H0Z"
 */
export function stripesCell({ period = 10, ratio = 0.5 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const r = clampParam("ratio", ratio, 0, 1);
  return { w, h: w, shapes: [backgroundShape(w, w), inkRect(0, 0, w * r, w)] };
}

/**
 * Pure function. CHECKERBOARD — the 2x2 fundamental domain of a checker, i.e. two
 * inked squares on the diagonal. A 1x1 cell cannot express a checker (it has no
 * alternation), which is the canonical illustration of why the domain is a
 * PARAMETER of the pattern and not always one "square".
 *
 * @param {{period: number}} params - one SQUARE's side; the domain is 2x that
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example checkerboardCell({period: 5}).w // 10
 * @example checkerboardCell({period: 5}).shapes.length // 3 (background + two squares)
 */
export function checkerboardCell({ period = 10 } = {}) {
  const s = clampParam("period", period, 0.01, 1e6);
  const w = s * 2;
  return { w, h: w, shapes: [backgroundShape(w, w), inkRect(0, 0, s, s), inkRect(s, s, s, s)] };
}

/**
 * Pure function. GINGHAM — the two-tone woven check of the reference imagery: a
 * half-opacity band in each axis, whose CROSSING reads as a third, darker tone.
 * One ink colour produces three apparent tones because the bands overlap, which is
 * what makes real gingham read as fabric rather than as a checkerboard.
 *
 * @param {{period: number, ratio: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example ginghamCell({period: 10, ratio: 0.5}).shapes.length // 4 (bg + band + band + crossing)
 * @example ginghamCell({period: 10, ratio: 0.5}).w // 10
 */
export function ginghamCell({ period = 10, ratio = 0.5 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const b = w * clampParam("ratio", ratio, 0, 1);
  return {
    w, h: w,
    shapes: [
      backgroundShape(w, w),
      { d: rectPathD(0, 0, b, w), paint: "ink", alpha: 0.45 },
      { d: rectPathD(0, 0, w, b), paint: "ink", alpha: 0.45 },
      { d: rectPathD(0, 0, b, b), paint: "ink", alpha: 0.35 },
    ],
  };
}

/**
 * Pure function. DIAMONDS (harlequin) — a diamond centred in the cell PLUS the
 * four quarter-diamonds its corners imply. The corner pieces are what make it
 * seamless: a lone centred diamond tiles as isolated diamonds, whereas the corner
 * quarters reassemble across the seam into the offset row a harlequin needs.
 *
 * `size` is the diamond's extent as a FRACTION of its cell — the same quantity
 * star8 calls `size`, NOT the inked-fraction stripes and gingham call `ratio`.
 * It was spelled `ratio` until the flat pattern schema started deriving its rows
 * from these declarations and refused the name for carrying two quantities:
 * gingham's ratio tops out at 0.95 while a diamond at 1 is the harlequin's whole
 * point, so one leaf could not serve both.
 *
 * @param {{period: number, size: number}} params - `size` as a fraction of the cell
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example diamondsCell({period: 10, size: 1}).shapes.length // 6 (bg + centre + 4 corners)
 */
export function diamondsCell({ period = 10, size = 1 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const k = clampParam("size", size, 0, 1) / 2;
  const cx = w / 2, hw = w * k;
  const centre = inkPolygon([[cx, cx - hw], [cx + hw, cx], [cx, cx + hw], [cx - hw, cx]]);
  // The four corner quarters: the same diamond centred on each corner. Together
  // with the centre one they tile without a seam.
  const corners = [[0, 0], [w, 0], [0, w], [w, w]].map(([x, y]) =>
    inkPolygon([[x, y - hw], [x + hw, y], [x, y + hw], [x - hw, y]]));
  return { w, h: w, shapes: [backgroundShape(w, w), centre, ...corners] };
}

/**
 * Pure function. POLKA DOTS on a HALF-DROP grid — a dot at the cell centre plus
 * the four corner quarter-dots. Same seam logic as diamonds: the corner dots
 * reassemble across the boundary, so the result is a staggered dot field rather
 * than dots in visible columns.
 *
 * @param {{period: number, radius: number}} params - radius as a FRACTION of period
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example polkaDotsCell({period: 10, radius: 0.2}).shapes.length // 6
 */
export function polkaDotsCell({ period = 10, radius = 0.2 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const r = w * clampParam("radius", radius, 0, 0.5);
  const corners = [[0, 0], [w, 0], [0, w], [w, w]].map(([x, y]) => inkCircle(x, y, r));
  return { w, h: w, shapes: [backgroundShape(w, w), inkCircle(w / 2, w / 2, r), ...corners] };
}

/**
 * Pure function. RANDOM POLKA DOTS — `count` dots scattered by a stored `seed`
 * inside a LARGER fundamental domain (`domain` cells across), so the repeat is
 * unobtrusive: at domain 4 the eye must scan 4 periods before a motif recurs.
 *
 * SEAMLESSNESS IS BY CONSTRUCTION, not by rejection sampling: every dot is emitted
 * in all NINE positions (itself plus the eight neighbouring-domain translates), so
 * a dot straddling an edge is drawn on both sides. Rejecting edge-crossing dots
 * instead would thin the density near the seams, which reads as a visible grid.
 *
 * PROPERTY STATE: the layout is a pure function of (seed, count, domain). Two
 * renders at the same seed are byte-identical, which pattern_seam_test pins.
 *
 * @param {{period: number, radius: number, count: number, seed: number, domain: number, jitterSize: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example randomDotsCell({count: 3, domain: 1, seed: 5}).shapes.length // 28 (bg + 3 dots x 9 translates)
 * @example randomDotsCell({count: 2, seed: 5}).shapes[1].d === randomDotsCell({count: 2, seed: 5}).shapes[1].d // true
 * @example randomDotsCell({count: 2, seed: 5}).shapes[1].d === randomDotsCell({count: 2, seed: 6}).shapes[1].d // false
 */
export function randomDotsCell({ period = 10, radius = 0.12, count = 8, seed = 1, domain = 3, jitterSize = 0.4 } = {}) {
  const p = clampParam("period", period, 0.01, 1e6);
  const n = Math.round(clampParam("domain", domain, 1, 8));
  const w = p * n;
  const baseR = p * clampParam("radius", radius, 0.001, 0.5);
  const sizeJitter = clampParam("jitterSize", jitterSize, 0, 1);
  const many = Math.round(clampParam("count", count, 1, 400));
  const shapes = [backgroundShape(w, w)];
  for (let i = 0; i < many; i++) {
    const x = hashUnit(seed, i, 0) * w;
    const y = hashUnit(seed, i, 1) * w;
    // Size varies by up to ±jitterSize/2 around the base radius — a field of
    // identical dots reads as mechanical even when the POSITIONS are scattered.
    const r = baseR * (1 + (hashUnit(seed, i, 2) - 0.5) * sizeJitter);
    for (const dx of [-w, 0, w]) for (const dy of [-w, 0, w]) shapes.push(inkCircle(x + dx, y + dy, r));
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. PLAID / TARTAN — a band SPEC (a list of {width, alpha} entries in
 * pattern units) laid down in BOTH axes, so the crossings build the deeper tones
 * automatically. The spec is data, which is what lets a preset describe a tartan
 * without a new generator.
 *
 * @param {{bands: Array<{width: number, alpha: number}>}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example plaidCell({bands: [{width: 6, alpha: 0.5}, {width: 3, alpha: 0}]}).w // 9
 * @example plaidCell({bands: [{width: 4, alpha: 0.6}, {width: 2, alpha: 0}]}).shapes.length // 3 (bg + one h + one v; alpha-0 bands emit nothing)
 */
export function plaidCell({ bands = [{ width: 8, alpha: 0.55 }, { width: 4, alpha: 0 }, { width: 2, alpha: 0.8 }, { width: 4, alpha: 0 }] } = {}) {
  if (!Array.isArray(bands) || bands.length === 0)
    throw new Error("vector_patterns.plaidCell: `bands` must be a non-empty array of {width, alpha}");
  const widths = bands.map((b, i) => clampParam(`bands[${i}].width`, b.width, 0.01, 1e6));
  const w = widths.reduce((a, b) => a + b, 0);
  const shapes = [backgroundShape(w, w)];
  // Horizontal then vertical, both from the same spec. Drawing both sets as
  // translucent ink is what produces the third/fourth tones at the crossings —
  // the same trick gingham uses, generalized to an arbitrary band list.
  for (const axis of [0, 1]) {
    let at = 0;
    for (let i = 0; i < bands.length; i++) {
      const bw = widths[i];
      const alpha = clampParam(`bands[${i}].alpha`, bands[i].alpha ?? 0, 0, 1);
      if (alpha > 0) shapes.push({ d: axis === 0 ? rectPathD(0, at, w, bw) : rectPathD(at, 0, bw, w), paint: "ink", alpha });
      at += bw;
    }
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. CHEVRON / ZIGZAG — a stroked V repeated down the cell, emitted as
 * a FILLED band (an outlined zigzag, not a stroke) so every backend renders it
 * identically without a stroker.
 *
 * The domain is one full zigzag period wide and `rows` tall; the band wraps
 * vertically because each row is drawn at the same phase.
 *
 * @param {{period: number, thickness: number, rows: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example chevronCell({period: 10, thickness: 0.25, rows: 2}).w // 10
 * @example chevronCell({period: 10, thickness: 0.25, rows: 2}).shapes.length // 3 (bg + 2 rows)
 */
export function chevronCell({ period = 10, thickness = 0.28, rows = 2 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const rowCount = Math.round(clampParam("rows", rows, 1, 16));
  const rowH = w / rowCount;
  const t = rowH * clampParam("thickness", thickness, 0.02, 0.9);
  const shapes = [backgroundShape(w, w)];
  for (let i = 0; i < rowCount; i++) {
    const y0 = i * rowH;
    // A closed band: up-stroke then back down offset by the thickness. Drawn one
    // period wide with the apex at the midpoint, so consecutive tiles join into a
    // continuous zigzag across the seam.
    const mid = w / 2, top = y0 + rowH - t, bot = y0 + rowH;
    shapes.push(inkPolygon([
      [0, bot], [mid, y0 + t], [w, bot], [w, bot - t], [mid, y0], [0, bot - t],
    ].map(([x, y]) => [x, y])));
    void top;
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. HONEYCOMB — the CAD hatch sheet's hex grid, and the worked
 * example of the engine's central claim: a hexagonal tiling is a RECTANGULAR cell
 * whose content encodes the offset.
 *
 * The repeat unit of a regular hex grid is a rectangle of width 3·s and height
 * s·√3 (s = side), containing TWO half-offset hexes. Drawing those two — plus the
 * translates that straddle the edges — yields a seamless honeycomb through the
 * same plain x/y repetition stripes use.
 *
 * @param {{side: number, thickness: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example Math.round(honeycombCell({side: 10}).w) // 30
 * @example Math.round(honeycombCell({side: 10}).h) // 17 (10·√3)
 */
export function honeycombCell({ side = 10, thickness = 0.12 } = {}) {
  const s = clampParam("side", side, 0.01, 1e6);
  const t = s * clampParam("thickness", thickness, 0.01, 0.5);
  const w = 3 * s, h = s * Math.sqrt(3);
  const shapes = [backgroundShape(w, h)];
  // A hexagon outline as a filled ring: outer hex, then the inner hex as a
  // reversed subpath (even-odd fill punches the middle out). Two hex centres —
  // (0, h/2) and (1.5s, 0) — are the two-per-rect repeat unit; each is emitted
  // with its wrapping translates so the ring survives the seam.
  const hexRing = (cx, cy) => {
    const ring = (radius) => {
      const pts = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k);
        pts.push(`${k === 0 ? "M" : "L"}${cellNum(cx + radius * Math.cos(a))} ${cellNum(cy + radius * Math.sin(a))}`);
      }
      return pts.join("") + "Z";
    };
    return { d: ring(s) + ring(s - t), paint: "ink", fillRule: "evenodd" };
  };
  for (const [cx, cy] of [[0, h / 2], [1.5 * s, 0], [1.5 * s, h], [3 * s, h / 2]]) shapes.push(hexRing(cx, cy));
  return { w, h, shapes };
}

/**
 * Pure function. TRIANGLES — an equilateral triangle grid, the second offset-row
 * family, again as a plain rectangle.
 *
 * ONLY THE UP-TRIANGLE IS INKED, and that is the whole design. The cell is exactly
 * tiled by one up-triangle plus the two half down-triangles beside it, so inking
 * all three would cover the domain completely and render as a SOLID BLOCK with the
 * background never visible — which is precisely the defect the first version of
 * this generator shipped (caught by rendering the preset roster and looking at it:
 * the triangles swatch came out flat orange). Leaving the down-triangles as
 * background is what makes the grid read as alternating tones.
 *
 * @param {{side: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example triangleCell({side: 10}).w // 10
 * @example triangleCell({side: 10}).shapes.length // 2 (background + the up-triangle)
 */
export function triangleCell({ side = 10 } = {}) {
  const s = clampParam("side", side, 0.01, 1e6);
  const h = (s * Math.sqrt(3)) / 2;
  return { w: s, h, shapes: [backgroundShape(s, h), inkPolygon([[s / 2, 0], [s, h], [0, h]])] };
}

/**
 * Pure function. CROSSHATCH — the CAD sheet's diagonal hatch, in one or both
 * diagonal directions. Each line is emitted as a filled parallelogram plus its
 * wrapping translate, so the lines run unbroken across tile edges.
 *
 * @param {{period: number, thickness: number, both: boolean}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example crosshatchCell({period: 10, both: false}).shapes.length // 4 (bg + 3 wrapping translates)
 * @example crosshatchCell({period: 10, both: true}).shapes.length // 7 (bg + 2 directions x 3)
 */
export function crosshatchCell({ period = 10, thickness = 0.12, both = true } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const t = w * clampParam("thickness", thickness, 0.01, 0.7);
  const shapes = [backgroundShape(w, w)];
  // A 45° band is the line y = x + c thickened VERTICALLY by t. THE SEAM RULE,
  // learned from this generator failing the seam probe twice: a slope-±1 diagonal
  // exits the cell through BOTH a side and the top/bottom, so one band per
  // direction cannot be continuous. Bands at c ∈ {-w, 0, w} supply the pieces that
  // re-enter, and the offset must be VERTICAL rather than horizontal — translation
  // by (w, w) then maps each band exactly onto itself, which is precisely the
  // condition for the tile to repeat without a cut. (An x-offset shears the band's
  // ends and reintroduces the seam; that was the second failed attempt.)
  for (const c of [-w, 0, w]) shapes.push(inkPolygon([[0, c], [w, c + w], [w, c + w + t], [0, c + t]]));
  if (both) for (const c of [0, w, 2 * w]) shapes.push(inkPolygon([[0, c], [w, c - w], [w, c - w + t], [0, c + t]]));
  return { w, h: w, shapes };
}

/**
 * Pure function. HERRINGBONE — interlocking brick courses, the fabric sheet's
 * signature weave. Bricks of `ratio`:1 aspect laid in two perpendicular runs.
 *
 * @param {{period: number, thickness: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example herringboneCell({period: 10}).w // 20
 */
export function herringboneCell({ period = 10, thickness = 0.16 } = {}) {
  const s = clampParam("period", period, 0.01, 1e6);
  const t = s * clampParam("thickness", thickness, 0.01, 0.5);
  const w = s * 2;
  const shapes = [backgroundShape(w, w)];
  // Four L-runs: horizontal bars stepping up, vertical bars stepping across. The
  // pattern's repeat unit is 2s square; each bar is emitted with the translate
  // that carries it across the seam.
  for (const [x, y, horiz] of [[0, 0, true], [s, s, true], [s, 0, false], [0, s, false]]) {
    for (const [dx, dy] of [[0, 0], [-w, 0], [0, -w]]) {
      const px = x + dx, py = y + dy;
      shapes.push(horiz ? inkRect(px, py, s + t, t) : inkRect(px, py, t, s + t));
    }
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. HOUNDSTOOTH — the classic broken check. Built as a checker plus
 * the four "teeth" that turn each square into the pointed motif.
 *
 * @param {{period: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example houndstoothCell({period: 8}).w // 16
 */
export function houndstoothCell({ period = 8 } = {}) {
  const s = clampParam("period", period, 0.01, 1e6);
  const w = s * 2, q = s / 2;
  const shapes = [backgroundShape(w, w), inkRect(0, 0, s, s), inkRect(s, s, s, s)];
  // The teeth: triangular spurs off two corners of each solid square, which is
  // what distinguishes houndstooth from a plain checker. Emitted with wrapping
  // translates so the motif survives the seam.
  const tooth = (pts) => shapes.push(inkPolygon(pts));
  for (const [dx, dy] of [[0, 0], [w, 0], [0, w], [-w, 0], [0, -w]]) {
    tooth([[s + dx, dy], [s + q + dx, dy], [s + dx, q + dy]]);
    tooth([[dx, s + dy], [q + dx, s + dy], [dx, s + q + dy]]);
    tooth([[s + dx, s + q + dy], [s + dx, s + s + dy], [s - q + dx, s + s + dy]]);
    tooth([[s + q + dx, s + dy], [s + s + dx, s + dy], [s + s + dx, s - q + dy]]);
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. LATTICE / QUATREFOIL-ish — overlapping circle arcs forming an
 * interlaced grid, the fabric sheet's lattice. Circles at the cell corners and
 * centre, drawn as rings so they read as an interlace rather than as dots.
 *
 * @param {{period: number, thickness: number, radius: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example latticeCell({period: 10}).w // 10
 */
export function latticeCell({ period = 10, thickness = 0.1, radius = 0.5 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const r = w * clampParam("radius", radius, 0.05, 1.5);
  const t = w * clampParam("thickness", thickness, 0.01, 0.5);
  const ring = (cx, cy) => ({
    d: ellipsePathD(cx, cy, r, r) + ellipsePathD(cx, cy, Math.max(r - t, 0.001), Math.max(r - t, 0.001)),
    paint: "ink", fillRule: "evenodd",
  });
  const shapes = [backgroundShape(w, w)];
  for (const [cx, cy] of [[0, 0], [w, 0], [0, w], [w, w], [w / 2, w / 2]]) shapes.push(ring(cx, cy));
  return { w, h: w, shapes };
}

/**
 * Pure function. BASKET WEAVE — pairs of parallel slats laid alternately
 * horizontal and vertical, the fabric sheet's over-under weave. The domain is
 * a 2x2 grid of slat-pairs: a horizontal pair occupies one diagonal, a
 * vertical pair the other, exactly like checkerboard's diagonal alternation
 * but each "square" is itself split into two slats with a gap between them
 * (the woven look) rather than a solid block.
 *
 * Seamless for the same reason checkerboard is: the 2x2 domain is the whole
 * repeat unit, and each pair sits fully inside its own quadrant.
 *
 * @param {{period: number, gap: number}} params - `period` is one quadrant's
 *   side; `gap` is the slat gap as a fraction of period
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example basketWeaveCell({period: 10}).w // 20
 * @example basketWeaveCell({period: 10}).shapes.length // 5 (bg + 2 h-slats + 2 v-slats)
 */
export function basketWeaveCell({ period = 10, gap = 0.12 } = {}) {
  const s = clampParam("period", period, 0.01, 1e6);
  const g = s * clampParam("gap", gap, 0, 0.45);
  const slat = (s - g) / 2;
  const w = s * 2;
  const shapes = [backgroundShape(w, w)];
  // Horizontal quadrant (top-left): two stacked horizontal slats spanning the
  // full quadrant width. Vertical quadrant (bottom-right): the transpose.
  shapes.push(inkRect(0, 0, s, slat), inkRect(0, slat + g, s, slat));
  shapes.push(inkRect(s, s, slat, s), inkRect(s + slat + g, s, slat, s));
  return { w, h: w, shapes };
}

/**
 * Pure function. GREEK KEY / FRET — a right-angle spiral-step meander built
 * from axis-aligned bars only (no diagonals), the fabric sheet's key/fret
 * border turned into a tileable field.
 *
 * THE MOTIF IS A ONE-SIDED STAIRCASE, not a symmetric up-and-down spike (the
 * first version of this generator drew a spike that went up AND down at the
 * mid-line, which is a plus-sign, not a key — caught by rendering the roster
 * and looking, exactly the failure mode this file's own QUALITY BAR names).
 * A real Greek key climbs monotonically away from a baseline band in a
 * square staircase, then the NEXT period's staircase descends back — that
 * asymmetry (climb, then fall) is what makes it read as a running key rather
 * than a row of crosses.
 *
 * Traced as ONE outline: a baseline band of thickness `t` runs the full
 * width; a staircase of `steps` treads climbs from it on the LEFT half of
 * the period and descends back to it on the RIGHT half, so consecutive
 * periods interlock. Both the left and right ends sit on the baseline band
 * at the same y, so translating by (±period, 0) reconnects the line exactly.
 *
 * @param {{period: number, thickness: number, steps: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example fretCell({period: 12}).w // 12
 * @example fretCell({period: 12}).shapes.length // 4 (bg + 3 wrapping copies)
 */
export function fretCell({ period = 12, thickness = 0.16, steps = 3 } = {}) {
  const s = clampParam("period", period, 0.01, 1e6);
  const t = s * clampParam("thickness", thickness, 0.05, 0.3);
  const nSteps = Math.round(clampParam("steps", steps, 2, 5));
  const shapes = [backgroundShape(s, s)];
  // The baseline band sits low in the cell; the staircase climbs from its
  // LEFT end, treads across the top, then the NEXT copy's staircase (drawn by
  // the x=+s translate) descends symmetrically back down on ITS left end —
  // so the two staircases together read as one continuous running key.
  const baseY = s * 0.78;
  const top = t * 1.5;
  const climbW = s * 0.5; // the staircase occupies the left half of the period
  const treadW = climbW / nSteps;
  // Outer edge: baseline-left -> climbs in `nSteps` treads up to `top` ->
  // continues along `top` to the period's right edge -> back down the
  // baseline's thickness to close the band. Inner edge (the return path)
  // retraces one step lower/right, `t` thick, back to the start.
  const outer = [[0, baseY + t]];
  for (let k = 0; k < nSteps; k++) {
    outer.push([k * treadW, baseY - k * ((baseY - top) / nSteps)]);
    outer.push([(k + 1) * treadW, baseY - k * ((baseY - top) / nSteps)]);
  }
  outer.push([climbW, top]);
  outer.push([s, top]);
  outer.push([s, top + t]);
  outer.push([climbW, top + t]);
  for (let k = nSteps - 1; k >= 0; k--) {
    outer.push([(k + 1) * treadW, baseY - k * ((baseY - top) / nSteps) + t]);
    outer.push([k * treadW, baseY - k * ((baseY - top) / nSteps) + t]);
  }
  outer.push([0, baseY + t]);
  for (const dx of [-s, 0, s]) shapes.push(inkPolygon(outer.map(([x, y]) => [x + dx, y])));
  return { w: s, h: s, shapes };
}

/**
 * Pure function. QUATREFOIL / MOROCCAN — four overlapping lens shapes (each a
 * thin ellipse rotated 45° from the last) meeting at the cell centre, the
 * fabric sheet's four-lobed medallion. The corner quarter-lobes reassemble
 * across the seam exactly as diamonds' corner quarters do, so the motif reads
 * as an unbroken lattice of medallions rather than isolated flowers.
 *
 * @param {{period: number, lobe: number}} params - `lobe` is lobe length as a
 *   fraction of period
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example quatrefoilCell({period: 16}).w // 16
 * @example quatrefoilCell({period: 16}).shapes.length // 6 (bg + 1 centre medallion + 4 corner medallions)
 */
export function quatrefoilCell({ period = 16, lobe = 0.42 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const L = w * clampParam("lobe", lobe, 0.1, 0.5);
  const thin = L * 0.42;
  // A "petal" is a lens: a thin ellipse (major L, minor `thin`) centred L/2
  // out from the medallion centre, ROTATED so its long axis points outward.
  // Built by rotating+translating a plain ellipsePathD via transformPathD's
  // general affine (which converts nothing to `A` — the ellipse is already
  // cubic beziers, so the rotation stays exactly PDF-safe).
  const petal = (cx, cy, angleDeg) => {
    const a = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const petalCentre = ellipsePathD(L / 2, 0, L / 2, thin);
    // Rotate about the ORIGIN then translate to (cx, cy): m = R(a) then +(cx,cy).
    return transformPathD(petalCentre, { a: cos, b: sin, c: -sin, d: cos, e: cx, f: cy });
  };
  // Four petals at 0/90/180/270 make one medallion; all four wound the same
  // way, drawn as one nonzero-fill shape so the overlap at the centre reads
  // as solid ink rather than a punched hole.
  const lensAt = (cx, cy) => ({ d: [0, 90, 180, 270].map((deg) => petal(cx, cy, deg)).join(""), paint: "ink" });
  // The centre medallion PLUS its four corner quarters — same seam logic
  // diamonds/polka_dots already use: a corner medallion straddles all four
  // neighbouring cells, so drawing it once per corner reassembles across
  // every edge into an unbroken lattice.
  const shapes = [backgroundShape(w, w), lensAt(w / 2, w / 2)];
  for (const [x, y] of [[0, 0], [w, 0], [0, w], [w, w]]) shapes.push(lensAt(x, y));
  return { w, h: w, shapes };
}

/**
 * Pure function. EIGHT-POINT STAR — two overlapping squares, one rotated 45°,
 * the classic quilt/tile star (and the CAD sheet's "star" hatch). Built as a
 * single 8-point outline rather than two overlapping squares so it is ONE
 * nonzero-fill shape with a clean silhouette (two overlapping filled squares
 * would double-cover their intersection, which is harmless for opaque ink but
 * would show through at partial alpha — the outline avoids that entirely).
 *
 * @param {{period: number, size: number}} params - `size` as a fraction of period
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example starCell({period: 14}).w // 14
 * @example starCell({period: 14}).shapes.length // 2 (background + the star)
 */
export function starCell({ period = 14, size = 0.85 } = {}) {
  const w = clampParam("period", period, 0.01, 1e6);
  const R = (w / 2) * clampParam("size", size, 0.2, 1);
  const r = R * 0.42; // inner radius — the concave points between the 8 outer tips
  const cx = w / 2, cy = w / 2;
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const a = (Math.PI / 8) * k - Math.PI / 2;
    const rad = k % 2 === 0 ? R : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return { w, h: w, shapes: [backgroundShape(w, w), inkPolygon(pts)] };
}

/**
 * Pure function. RUNNING-BOND BRICK — offset courses of rectangles with
 * mortar gaps, the CAD sheet's plain brick/block hatch (and, at a tall narrow
 * ratio, its floorboard/plank sibling — the same generator, different knobs,
 * per the engine's "family via params" idiom already used by plaid).
 *
 * The domain is TWO courses tall (one full brick, one half-offset brick),
 * which is what makes alternating-course brick a plain rectangular tile: the
 * half-brick at each end of the offset course is what reassembles across the
 * left/right seam.
 *
 * @param {{brickW: number, brickH: number, mortar: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example brickCell({brickW: 20, brickH: 10}).h // 20
 * @example brickCell({brickW: 20, brickH: 10}).shapes.length // 4 (bg + 1 brick row1 + 2 half-bricks row2)
 */
export function brickCell({ brickW = 20, brickH = 10, mortar = 0.08 } = {}) {
  const bw = clampParam("brickW", brickW, 0.5, 1e6);
  const bh = clampParam("brickH", brickH, 0.5, 1e6);
  const m = Math.min(bw, bh) * clampParam("mortar", mortar, 0, 0.3);
  const w = bw, h = bh * 2;
  const shapes = [backgroundShape(w, h)];
  // Row 1: one full brick spanning the domain width. Row 2: offset by half a
  // brick, so it is drawn as two half-bricks — one at each edge — which is
  // exactly the piece that must wrap for the course to read as continuous.
  shapes.push(inkRect(m / 2, m / 2, bw - m, bh - m));
  const half = bw / 2;
  shapes.push(inkRect(m / 2, bh + m / 2, half - m, bh - m));
  shapes.push(inkRect(half + m / 2, bh + m / 2, half - m, bh - m));
  return { w, h, shapes };
}

/**
 * Pure function. SCALLOP / FAN — rows of overlapping half-circle arcs, the
 * CAD sheet's fanned/scallop hatch and the fabric sheet's shell trim. Each
 * arc is a true circular arc SAMPLED TO CUBIC BEZIERS via arcToCubics (never
 * an SVG `A` command — the codebase's PDF-export-safety rule), closed against
 * the row's baseline into a filled half-disc "scale".
 *
 * The domain is one scallop wide and one row tall; alternating rows offset by
 * half a scallop is expressed as TWO rows in the domain (the same half-drop
 * idiom svgTileCell documents), so plain x/y repetition still suffices.
 *
 * THE SCALE RADIUS IS SPELLED `period` because it is an ABSOLUTE length in
 * pattern units, like every other generator's spacing knob — it was `radius`
 * until the flat pattern schema started deriving its rows from these
 * declarations and refused the name: every other `radius` in the roster is a
 * FRACTION of a spacing (0.01–0.5 for dots), and one document leaf cannot be
 * both a fraction and a length. Its 0.5–400 range and 0.5 step were already
 * byte-identical to the `period` family it now joins.
 *
 * @param {{period: number, overlap: number}} params - `overlap` as a fraction of the scale radius
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example scallopCell({period: 10}).h // 16 (2 rows of 0.8*radius each)
 */
export function scallopCell({ period = 10, overlap = 0.15 } = {}) {
  const R = clampParam("period", period, 0.5, 1e6);
  const ov = clampParam("overlap", overlap, 0, 0.5);
  const stride = R * 2 * (1 - ov * 0.5);
  const rowH = R * 0.8;
  const w = stride, h = rowH * 2;
  const shapes = [backgroundShape(w, h)];
  // A half-disc: flat diameter along the baseline, arc bulging DOWN into the
  // row (a "scale" hanging from the course above). In this y-DOWN space,
  // sweep=false is the flag that bulges the arc toward +y (down the screen);
  // sweep=true bulges up, which was the FIRST version's bug (the roster
  // rendered upward-pointing chevrons instead of hanging scales — caught by
  // rendering the contact sheet and looking, per this file's own QUALITY BAR).
  // arcToCubics(x1,y1, R,R, 0, false, false, x2,y2) sweeps the semicircle;
  // segs are the pre-sampled cubics.
  const scale = (cx, baseY) => {
    const segs = arcToCubics(cx - R, baseY, R, R, 0, false, false, cx + R, baseY);
    let d = `M${cellNum(cx - R)} ${cellNum(baseY)}`;
    for (const [c1x, c1y, c2x, c2y, ex, ey] of segs)
      d += `C${cellNum(c1x)} ${cellNum(c1y)} ${cellNum(c2x)} ${cellNum(c2y)} ${cellNum(ex)} ${cellNum(ey)}`;
    d += "Z";
    return { d, paint: "ink" };
  };
  // Row 0 centred at x=0 (plus its wrap at x=w) and x=w/2; row 1 (half-drop)
  // the same, one rowH lower — the two rows are what makes the arcs stagger.
  for (let row = 0; row < 2; row++) {
    const baseY = rowH * (row + 1);
    const xOff = row === 1 ? w / 2 : 0;
    for (const cx of [xOff, xOff + w, xOff - w]) shapes.push(scale(cx, baseY));
  }
  return { w, h, shapes };
}

/**
 * Pure function. STONE COURSING — seeded irregular polygon "stones" over a
 * mortar background, the CAD sheet's cobblestone/pebble/rubblestone/granules/
 * gravel/squared-stones/stonewall/paving/limestone family. ONE generator, the
 * family distinguished by params exactly like plaid's band spec: `roundness`
 * near 0 gives hard-edged squared masonry (limestone, paving, squared
 * stones), near 1 gives lumpy rounded pebbles (cobblestone, gravel,
 * rubblestone); `count`/`domain` set how coarse (few big stones) or fine
 * (many small ones, granules) the aggregate reads.
 *
 * THE STONE EXTENT IS SPELLED `stoneSize`, not `size`: a stone's fraction of the
 * domain (0.05–0.6, a stone at 0.85 is a blob) is not star8's fraction of its
 * cell (0.2–1, a star at 0.85 is a star), and while the flat pattern schema
 * merged them under one name the shared default made every fresh cobble
 * degenerate. Two ranges that disagree about what is sane are two knobs.
 *
 * Each stone is a jittered-radius polygon around a scattered centre — the
 * same hashUnit scatter randomDotsCell uses, so it is PROPERTY STATE (a pure
 * function of seed) for the same reason. SEAMLESS BY THE SAME CONSTRUCTION
 * randomDotsCell documents: every stone is emitted at all nine domain
 * translates, so one straddling an edge is drawn whole on both sides.
 *
 * @param {{count: number, seed: number, domain: number, size: number, roundness: number, sides: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example cobbleCell({count: 4, domain: 1, seed: 3}).shapes.length // 37 (bg + 4 stones x 9 translates)
 * @example cobbleCell({seed: 3}).shapes[1].d === cobbleCell({seed: 3}).shapes[1].d // true (deterministic)
 */
export function cobbleCell({ count = 10, seed = 1, domain = 3, stoneSize = 0.28, roundness = 0.6, sides = 7 } = {}) {
  const unit = 10; // pattern-unit scale, matching the other generators' "period ~10" convention
  const n = Math.round(clampParam("domain", domain, 1, 8));
  const w = unit * n;
  const baseR = unit * clampParam("stoneSize", stoneSize, 0.05, 0.6);
  const round = clampParam("roundness", roundness, 0, 1);
  const nSides = Math.round(clampParam("sides", sides, 4, 12));
  const many = Math.round(clampParam("count", count, 1, 200));
  const shapes = [backgroundShape(w, w)];
  for (let i = 0; i < many; i++) {
    const x = hashUnit(seed, i, 0) * w;
    const y = hashUnit(seed, i, 1) * w;
    const r = baseR * (0.7 + hashUnit(seed, i, 2) * 0.6);
    const rot = hashUnit(seed, i, 3) * Math.PI * 2;
    const pts = [];
    for (let k = 0; k < nSides; k++) {
      const a = rot + (Math.PI * 2 * k) / nSides;
      // roundness jitters each vertex radius independently (irregular pebble
      // outline); roundness=0 keeps every vertex at r (a hard regular
      // polygon — squared stone).
      const jitter = 1 + (hashUnit(seed, i * 100 + k, 4) - 0.5) * round * 0.7;
      pts.push([x + r * jitter * Math.cos(a), y + r * jitter * Math.sin(a)]);
    }
    for (const dx of [-w, 0, w]) for (const dy of [-w, 0, w])
      shapes.push(inkPolygon(pts.map(([px, py]) => [px + dx, py + dy])));
  }
  return { w, h: w, shapes };
}

/**
 * Pure function. PLANK COURSING — offset rows of wide flat boards, each
 * carrying one wavy grain line, the CAD sheet's floorboard/woodgrain/
 * wavygrain/cedarshake/roofslate/spanish-roof family. Same running-bond
 * offset brickCell uses (a full board on row 1, two half-boards on row 2),
 * generalized with a per-board sinusoidal grain stroke — the ONE knob
 * (`waveAmp`) that turns a plain plank (amp 0) into a wood-grain or shake
 * texture (amp > 0), so the whole family is this one generator plus params.
 *
 * The grain line is built from sampled points joined by `L` segments rather
 * than a smooth curve fit, which keeps it trivially exact at the board's own
 * left/right edges (the sample always lands there) — a fitted curve would
 * need its tangents pinned to guarantee that, for no visual benefit at this
 * line thickness.
 *
 * @param {{boardW: number, boardH: number, gap: number, waveAmp: number, waveCycles: number, seed: number}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example plankCell({boardW: 20, boardH: 8}).h // 16
 * @example plankCell({boardW: 20, boardH: 8, waveAmp: 0}).shapes.length // 4 (bg + 1 board row1 + 2 half-boards row2, grain off)
 * @example plankCell({boardW: 20, boardH: 8, waveAmp: 0.2}).shapes.length // 7 (same 3 outlines, each plus a grain ribbon)
 */
export function plankCell({ boardW = 24, boardH = 8, gap = 0.1, waveAmp = 0.18, waveCycles = 3, seed = 1 } = {}) {
  const bw = clampParam("boardW", boardW, 0.5, 1e6);
  const bh = clampParam("boardH", boardH, 0.5, 1e6);
  const g = Math.min(bw, bh) * clampParam("gap", gap, 0, 0.3);
  const amp = bh * clampParam("waveAmp", waveAmp, 0, 0.45);
  const cycles = Math.max(1, Math.round(clampParam("waveCycles", waveCycles, 1, 8)));
  const w = bw, h = bh * 2;
  const shapes = [backgroundShape(w, h)];
  const SAMPLES = 16;
  // A board outline (the gap-inset rect) plus its grain line, sampled as a
  // sine wave whose PHASE is seeded per board so neighbouring boards do not
  // read as mechanically identical (matching cedarshake/wavygrain reference
  // texture, where each course's wave is visibly offset from its neighbours).
  const grainThickness = Math.max(bh * 0.03, 0.05);
  const board = (x, y, bWidth, phaseSeedIndex) => {
    const outline = inkRect(x + g / 2, y + g / 2, bWidth - g, bh - g);
    const phase = hashUnit(seed, phaseSeedIndex, 0) * Math.PI * 2;
    const midY = y + bh / 2;
    const innerW = bWidth - g * 3;
    const x0 = x + g * 1.5;
    // The grain is a THICKENED ribbon (forward samples along the top edge,
    // backward along the bottom edge of the ribbon), not a stroke — this
    // engine draws filled shapes only, the same idiom chevron's V-band uses.
    if (amp <= 0) return [outline];
    const top = [], bottom = [];
    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const gx = x0 + t * innerW;
      const gy = midY + amp * Math.sin(phase + t * cycles * Math.PI * 2);
      top.push([gx, gy - grainThickness / 2]);
      bottom.push([gx, gy + grainThickness / 2]);
    }
    const ribbon = { d: inkPolygon([...top, ...bottom.reverse()]).d, paint: "background" };
    return [outline, ribbon];
  };
  // Row 1: one full board. Row 2 (half-drop, as brickCell's offset row is):
  // two half-boards, one per edge, so the course wraps across the seam.
  shapes.push(...board(0, 0, bw, 0));
  const half = bw / 2;
  shapes.push(...board(0, bh, half, 1));
  shapes.push(...board(half, bh, half, 2));
  return { w, h, shapes };
}

/**
 * Pure function. A TILED SVG ASSET's cell — an already-flattened SVG (a list of
 * {d, paint} records produced by core/svg_paths.flattenSvgTree) placed on a grid,
 * optionally HALF-DROPPED so alternate rows offset by half a cell.
 *
 * This is the "or maybe just like repeated SVG" half of the ruling: any drawing in
 * the project becomes a pattern, through the SAME rectangular-domain engine. A
 * half-drop is expressed by making the domain 1x2 cells and drawing the motif
 * twice — not by a special tiler — which is the engine's whole thesis restated for
 * asset content.
 *
 * @param {{paths: Array<{d: string}>, motifW: number, motifH: number, gap: number, halfDrop: boolean}} params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example svgTileCell({paths: [{d: "M0 0H2V2H0Z"}], motifW: 2, motifH: 2, gap: 1}).w // 3
 * @example svgTileCell({paths: [{d: "M0 0H2V2H0Z"}], motifW: 2, motifH: 2, gap: 0, halfDrop: true}).h // 4 (two rows)
 */
export function svgTileCell({ paths = [], motifW = 10, motifH = 10, gap = 0, halfDrop = false } = {}) {
  if (!Array.isArray(paths)) throw new Error("vector_patterns.svgTileCell: `paths` must be an array of {d} records");
  const mw = clampParam("motifW", motifW, 0.01, 1e6);
  const mh = clampParam("motifH", motifH, 0.01, 1e6);
  const g = clampParam("gap", gap, 0, 1e6);
  const cellW = mw + g, cellH = mh + g;
  const w = cellW, h = halfDrop ? cellH * 2 : cellH;
  const shapes = [backgroundShape(w, h)];
  // Placements: one motif per logical cell, plus the horizontal wrap for a
  // half-dropped second row (whose x offset pushes half of it past the edge).
  const placements = halfDrop
    ? [[0, 0], [cellW / 2, cellH], [-cellW / 2, cellH]]
    : [[0, 0]];
  for (const [ox, oy] of placements)
    for (const p of paths)
      shapes.push({ d: translatePathD(p.d, ox, oy), paint: p.paint === "background" ? "background" : "ink", ...(p.fillRule ? { fillRule: p.fillRule } : {}) });
  return { w, h, shapes };
}

/**
 * Pure function. Translates an SVG path `d` by (dx, dy) — a pure-translation
 * special case, so a motif can be placed without pulling in the full affine
 * machinery (core/svg_paths.transformPathD does the general case; this stays here
 * because it must be exact for the seam checks, and a translate never introduces
 * the arc-to-cubic conversion the general path does).
 *
 * @example translatePathD("M0 0H2V2H0Z", 1, 1) // "M1 1H3V3H1Z"
 * @example translatePathD("M0 0L2 3Z", 5, 0) // "M5 0L7 3Z"
 */
export function translatePathD(d, dx, dy) {
  if (dx === 0 && dy === 0) return d;
  // Absolute commands only (every generator and flattenSvgTree emit absolute);
  // a relative command would translate incorrectly, so it is refused LOUDLY.
  return d.replace(/([A-Za-z])([^A-Za-z]*)/g, (_, cmd, args) => {
    if (cmd >= "a" && cmd <= "z" && cmd !== "z") throw new Error(`vector_patterns.translatePathD: relative command "${cmd}" is not supported — cells are authored in absolute coordinates`);
    const nums = args.trim().length ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (cmd === "Z" || cmd === "z") return "Z";
    if (cmd === "H") return "H" + nums.map((n) => cellNum(n + dx)).join(" ");
    if (cmd === "V") return "V" + nums.map((n) => cellNum(n + dy)).join(" ");
    return cmd + nums.map((n, i) => cellNum(n + (i % 2 === 0 ? dx : dy))).join(" ");
  });
}

/**
 * THE GENERATOR ROSTER — id → {title, generate, params}. The ONE registry a
 * consumer reads; a preset names a generator by id and supplies its params.
 *
 * `params` is a customProps-shaped schema (the same row vocabulary a material's
 * fillParams uses), so the Inspector rows for a pattern come from the same
 * machinery every other material's knobs do, and every one is equation-bindable
 * through the normal property path.
 */
export const PATTERN_GENERATORS = Object.freeze({
  stripes: {
    title: "Stripes", generate: stripesCell,
    params: [
      { name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Stripe repeat width, in pattern units" },
      { name: "ratio", kind: "number", default: 0.5, min: 0, max: 1, step: 0.01, help: "Fraction of each period that is inked" },
    ],
  },
  checkerboard: {
    title: "Checkerboard", generate: checkerboardCell,
    params: [{ name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "One square's side" }],
  },
  gingham: {
    title: "Gingham", generate: ginghamCell,
    params: [
      { name: "period", kind: "number", default: 12, min: 0.5, max: 400, step: 0.5, help: "Check repeat" },
      { name: "ratio", kind: "number", default: 0.5, min: 0.05, max: 0.95, step: 0.01, help: "Band width as a fraction of the repeat" },
    ],
  },
  diamonds: {
    title: "Diamonds", generate: diamondsCell,
    params: [
      { name: "period", kind: "number", default: 14, min: 0.5, max: 400, step: 0.5, help: "Diamond repeat" },
      { name: "size", kind: "number", default: 1, min: 0.05, max: 1, step: 0.01, help: "Diamond size within its cell" },
    ],
  },
  polka_dots: {
    title: "Polka Dots", generate: polkaDotsCell,
    params: [
      { name: "period", kind: "number", default: 14, min: 0.5, max: 400, step: 0.5, help: "Dot spacing" },
      { name: "radius", kind: "number", default: 0.2, min: 0.01, max: 0.5, step: 0.01, help: "Dot radius, as a fraction of the spacing" },
    ],
  },
  random_dots: {
    title: "Random Dots", generate: randomDotsCell,
    params: [
      { name: "period", kind: "number", default: 12, min: 0.5, max: 400, step: 0.5, help: "Nominal dot spacing" },
      { name: "radius", kind: "number", default: 0.12, min: 0.01, max: 0.5, step: 0.01, help: "Base dot radius, as a fraction of the spacing" },
      { name: "count", kind: "number", default: 14, min: 1, max: 200, step: 1, help: "Dots per fundamental domain" },
      { name: "seed", kind: "number", default: 1, min: 0, max: 99999, step: 1, help: "Scatter seed — the same seed always lays out the same dots" },
      { name: "domain", kind: "number", default: 3, min: 1, max: 8, step: 1, help: "Domain size in cells — larger hides the repeat" },
      { name: "jitterSize", kind: "number", default: 0.4, min: 0, max: 1, step: 0.01, help: "How much dot sizes vary" },
    ],
  },
  plaid: {
    title: "Plaid", generate: plaidCell,
    params: [],
  },
  chevron: {
    title: "Chevron", generate: chevronCell,
    params: [
      { name: "period", kind: "number", default: 16, min: 0.5, max: 400, step: 0.5, help: "Zigzag period" },
      { name: "thickness", kind: "number", default: 0.28, min: 0.02, max: 0.9, step: 0.01, help: "Band thickness within a row" },
      { name: "rows", kind: "number", default: 2, min: 1, max: 16, step: 1, help: "Zigzag rows per cell" },
    ],
  },
  honeycomb: {
    title: "Honeycomb", generate: honeycombCell,
    params: [
      { name: "side", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Hexagon side length" },
      { name: "thickness", kind: "number", default: 0.12, min: 0.01, max: 0.5, step: 0.01, help: "Cell wall thickness" },
    ],
  },
  triangles: {
    title: "Triangles", generate: triangleCell,
    params: [{ name: "side", kind: "number", default: 12, min: 0.5, max: 400, step: 0.5, help: "Triangle side length" }],
  },
  crosshatch: {
    title: "Crosshatch", generate: crosshatchCell,
    params: [
      { name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Hatch spacing" },
      { name: "thickness", kind: "number", default: 0.12, min: 0.01, max: 0.7, step: 0.01, help: "Line thickness" },
      { name: "both", kind: "boolean", default: true, help: "Hatch in both diagonal directions" },
    ],
  },
  herringbone: {
    title: "Herringbone", generate: herringboneCell,
    params: [
      { name: "period", kind: "number", default: 12, min: 0.5, max: 400, step: 0.5, help: "Brick length" },
      { name: "thickness", kind: "number", default: 0.16, min: 0.01, max: 0.5, step: 0.01, help: "Brick thickness" },
    ],
  },
  houndstooth: {
    title: "Houndstooth", generate: houndstoothCell,
    params: [{ name: "period", kind: "number", default: 8, min: 0.5, max: 400, step: 0.5, help: "Motif size" }],
  },
  lattice: {
    title: "Lattice", generate: latticeCell,
    params: [
      { name: "period", kind: "number", default: 14, min: 0.5, max: 400, step: 0.5, help: "Lattice spacing" },
      { name: "radius", kind: "number", default: 0.5, min: 0.05, max: 1.5, step: 0.01, help: "Ring radius, as a fraction of spacing" },
      { name: "thickness", kind: "number", default: 0.1, min: 0.01, max: 0.5, step: 0.01, help: "Ring thickness" },
    ],
  },
  basket_weave: {
    title: "Basket Weave", generate: basketWeaveCell,
    params: [
      { name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "One quadrant's side" },
      { name: "gap", kind: "number", default: 0.12, min: 0, max: 0.45, step: 0.01, help: "Gap between the two slats, as a fraction of the quadrant" },
    ],
  },
  fret: {
    title: "Greek Key", generate: fretCell,
    params: [
      { name: "period", kind: "number", default: 12, min: 0.5, max: 400, step: 0.5, help: "Meander repeat width" },
      { name: "thickness", kind: "number", default: 0.16, min: 0.05, max: 0.3, step: 0.01, help: "Line thickness, as a fraction of the repeat" },
      { name: "steps", kind: "number", default: 3, min: 2, max: 5, step: 1, help: "Staircase treads per meander" },
    ],
  },
  quatrefoil: {
    title: "Quatrefoil", generate: quatrefoilCell,
    params: [
      { name: "period", kind: "number", default: 16, min: 0.5, max: 400, step: 0.5, help: "Medallion spacing" },
      { name: "lobe", kind: "number", default: 0.42, min: 0.1, max: 0.5, step: 0.01, help: "Petal length, as a fraction of the spacing" },
    ],
  },
  star8: {
    title: "Eight-Point Star", generate: starCell,
    params: [
      { name: "period", kind: "number", default: 14, min: 0.5, max: 400, step: 0.5, help: "Star spacing" },
      { name: "size", kind: "number", default: 0.85, min: 0.2, max: 1, step: 0.01, help: "Star size, as a fraction of the spacing" },
    ],
  },
  brick: {
    title: "Running Bond Brick", generate: brickCell,
    params: [
      { name: "brickW", kind: "number", default: 20, min: 0.5, max: 400, step: 0.5, help: "Brick length" },
      { name: "brickH", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Brick (course) height" },
      { name: "mortar", kind: "number", default: 0.08, min: 0, max: 0.3, step: 0.01, help: "Mortar gap, as a fraction of the smaller brick dimension" },
    ],
  },
  scallop: {
    title: "Scallop / Fan", generate: scallopCell,
    params: [
      { name: "period", kind: "number", default: 10, min: 0.5, max: 400, step: 0.5, help: "Scale radius, in pattern units" },
      { name: "overlap", kind: "number", default: 0.15, min: 0, max: 0.5, step: 0.01, help: "How much each scale overlaps its neighbour" },
    ],
  },
  cobble: {
    title: "Stone Coursing", generate: cobbleCell,
    params: [
      { name: "count", kind: "number", default: 10, min: 1, max: 200, step: 1, help: "Stones per fundamental domain" },
      { name: "seed", kind: "number", default: 1, min: 0, max: 99999, step: 1, help: "Scatter seed — the same seed always lays out the same stones" },
      { name: "domain", kind: "number", default: 3, min: 1, max: 8, step: 1, help: "Domain size in cells — larger hides the repeat" },
      { name: "stoneSize", kind: "number", default: 0.28, min: 0.05, max: 0.6, step: 0.01, help: "Stone size, as a fraction of the domain" },
      { name: "roundness", kind: "number", default: 0.6, min: 0, max: 1, step: 0.01, help: "0 = hard squared masonry, 1 = lumpy rounded pebbles" },
      { name: "sides", kind: "number", default: 7, min: 4, max: 12, step: 1, help: "Polygon sides per stone" },
    ],
  },
  plank: {
    title: "Plank / Wood Grain", generate: plankCell,
    params: [
      { name: "boardW", kind: "number", default: 24, min: 0.5, max: 400, step: 0.5, help: "Board length" },
      { name: "boardH", kind: "number", default: 8, min: 0.5, max: 400, step: 0.5, help: "Board (course) height" },
      { name: "gap", kind: "number", default: 0.1, min: 0, max: 0.3, step: 0.01, help: "Gap between boards" },
      { name: "waveAmp", kind: "number", default: 0.18, min: 0, max: 0.45, step: 0.01, help: "Grain wave amplitude — 0 leaves a plain board" },
      { name: "waveCycles", kind: "number", default: 3, min: 1, max: 8, step: 1, help: "Grain wave cycles across one board" },
      { name: "seed", kind: "number", default: 1, min: 0, max: 99999, step: 1, help: "Grain phase seed, per board" },
    ],
  },
});

/** Query. Every registered generator id — the pattern picker's list and the
 *  seam test's axis, so both grow automatically as generators are added.
 *  @example patternGeneratorIds().includes("honeycomb") // true */
export function patternGeneratorIds() {
  return Object.keys(PATTERN_GENERATORS);
}

/**
 * Query. Builds a generator's cell from its id and (possibly sparse) params,
 * resolving each knob against the generator's own schema default. Throws LOUDLY on
 * an unknown id — a typo must not silently render an empty pattern.
 *
 * @param {string} id - a PATTERN_GENERATORS key
 * @param {object} params - sparse stored params
 * @returns {{w: number, h: number, shapes: Array}}
 *
 * @example buildPatternCell("stripes", {period: 4}).w // 4
 * @example buildPatternCell("checkerboard", {}).w // 20 (schema default period 10, doubled)
 */
export function buildPatternCell(id, params = {}) {
  const gen = PATTERN_GENERATORS[id];
  if (!gen) throw new Error(`vector_patterns.buildPatternCell: unknown generator "${id}" (known: ${patternGeneratorIds().join(", ")})`);
  const resolved = { ...Object.fromEntries(gen.params.map((r) => [r.name, r.default])), ...params };
  const cell = gen.generate(resolved);
  const problem = patternCellProblem(cell);
  if (problem) throw new Error(`vector_patterns: generator "${id}" produced an invalid cell — ${problem}`);
  return cell;
}

/**
 * Pure function. Why is this value not a usable CELL? Returns a reason, or null.
 * The shape gate every generator's output passes through, so a broken generator is
 * refused by name rather than rendering an empty (invisible) pattern.
 *
 * @param {*} cell
 * @returns {string|null}
 *
 * @example patternCellProblem({w: 4, h: 4, shapes: [{d: "M0 0Z", paint: "ink"}]}) // null
 * @example patternCellProblem({w: 0, h: 4, shapes: []}) // 'w must be a positive finite number, got 0'
 * @example patternCellProblem({w: 4, h: 4, shapes: [{d: "M0 0Z", paint: "purple"}]}) // 'shapes[0].paint is "purple" — must be one of ink, background'
 */
export function patternCellProblem(cell) {
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return `must be a {w, h, shapes} object, got ${JSON.stringify(cell)}`;
  for (const dim of ["w", "h"])
    if (!Number.isFinite(cell[dim]) || cell[dim] <= 0) return `${dim} must be a positive finite number, got ${cell[dim]}`;
  if (!Array.isArray(cell.shapes)) return "shapes must be an array of {d, paint} records";
  for (let i = 0; i < cell.shapes.length; i++) {
    const s = cell.shapes[i];
    if (s === null || typeof s !== "object") return `shapes[${i}] is not a shape record`;
    if (typeof s.d !== "string" || !s.d) return `shapes[${i}].d must be a non-empty SVG path string`;
    if (!CELL_PAINTS.includes(s.paint)) return `shapes[${i}].paint is ${JSON.stringify(s.paint)} — must be one of ${CELL_PAINTS.join(", ")}`;
    if (s.alpha !== undefined && (!Number.isFinite(s.alpha) || s.alpha < 0 || s.alpha > 1)) return `shapes[${i}].alpha must be within 0..1, got ${s.alpha}`;
  }
  return null;
}
