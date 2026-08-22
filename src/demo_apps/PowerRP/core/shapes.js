/**
 * The PRESET-SHAPE LIBRARY (Wave 2 — unified path shapes). A pure, DOM-free
 * module mapping a preset NAME to a parametric SVG-path-data string drawn in a
 * BBOX-LOCAL box: coordinates run 0..w horizontally and 0..h vertically, y-DOWN
 * (the same local space every render_gpu/ir.js geometry op uses), so the shape
 * plugin can hand a generated `d` straight to the `path` IR op with no extra
 * scale. ONE generator per interesting PowerPoint shape family (star, regular
 * polygons, diamond, heart, cloud, speech bubble, chevron, block arrow, cross,
 * lightning, parallelogram, trapezoid, rounded triangle), each adjustable
 * through a small options bag (point count, inner ratio, …).
 *
 * ── BACKEND CONTRACT (why only lines + beziers, never arcs) ───────────────────
 * The generated `d` must round-trip through ALL THREE backends. paint_skia and
 * svg_backend accept the full SVG path grammar, but pdf_backend's svgPathToPdfOps
 * supports only M L H V C S Q T Z (it throws loudly on `A`). So every curve here
 * is a cubic (C) or quadratic (Q) bezier — never an elliptical arc — which keeps
 * a shape identical across the GPU raster, SVG export, and PDF export.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

// ── shape-defining ratios (fractions of w/h; named, not magic — each traces a
// recognizable silhouette; tuned by eye, verified by VLM render check) ─────────
const STAR_DEFAULT_POINTS = 5;      // a classic 5-point star
const STAR_DEFAULT_INNER = 0.5;     // inner radius = half the outer (deep, pointy)
const POLYGON_DEFAULT_SIDES = 6;    // hexagon when the generic polygon is unparameterized
const ROUND_CORNER_FRACTION = 0.14; // corner-round radius as a fraction of min(w,h)
const PARALLELOGRAM_SLANT = 0.25;   // horizontal shear as a fraction of w
const TRAPEZOID_TOP_INSET = 0.2;    // each top corner pulled in by this fraction of w
const CROSS_ARM = 1 / 3;            // plus-sign arm thickness as a fraction of the box
const TOP_UP = -Math.PI / 2;        // start angle so polygons/stars point straight up

/** The default decimals for authored path data — short `d` strings, stable doctests. */
export const PATH_DECIMALS = 3;

/** Pure function. Compact fixed-precision number for path data (trailing zeros
 * trimmed) — keeps `d` short and doctests stable.
 *
 * `decimals` exists so a CONSUMER can normalize a path through transformPathD
 * without losing precision it was going to keep: the PDF backend writes 4-decimal
 * operands (pdfNum), so rounding to 3 on the way through would be a fidelity loss
 * introduced by the normalization step alone. Every authoring caller keeps the
 * 3-decimal default and is byte-identical.
 *
 * @param {number} n - the value
 * @param {number} [decimals] - decimals to keep; defaults to PATH_DECIMALS
 * @returns {string}
 *
 * @example num(50) // "50"
 * @example num(33.333333) // "33.333"
 * @example num(-0) // "0"
 * @example num(33.333333, 4) // "33.3333"
 */
export function num(n, decimals = PATH_DECIMALS) {
  return String(+(+n).toFixed(decimals) + 0); // + 0 normalizes -0 → 0
}

/**
 * Pure function. A closed polygon path from a vertex list (M, then L to each
 * subsequent vertex, then Z). Points are [x, y] pairs in local (bbox) space.
 *
 * @example polygonPathD([[0, 0], [10, 0], [5, 8]]) // "M0 0 L10 0 L5 8 Z"
 * @example polygonPathD([[0, 0], [10, 0], [10, 10], [0, 10]]) // "M0 0 L10 0 L10 10 L0 10 Z"
 */
export function polygonPathD(points) {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`polygonPathD: need >= 3 points, got ${JSON.stringify(points)}`);
  const [first, ...rest] = points;
  return `M${num(first[0])} ${num(first[1])} ` + rest.map(([x, y]) => `L${num(x)} ${num(y)}`).join(" ") + " Z";
}

/**
 * Pure function. Joins MULTIPLE closed polygon subpaths into ONE SVG path `d`
 * ("M..Z M..Z") — the multi-subpath sibling of polygonPathD. THE bridge from the
 * shapeshifter family outline builders (core/outline.js, which return an array
 * of closed [x,y] subpaths) to the `path` IR op: a single-subpath result is a
 * plain filled shape; a two-subpath result (ring / frame / gear-with-hole)
 * renders as a hole under fillRule "evenodd". Every subpath is all M/L/Z (arcs
 * are pre-sampled to polylines upstream), so the output is PDF-export-safe (no
 * `A`). Empty subpaths are skipped; no subpaths at all throws (a widget that
 * emits nothing should not reach here).
 *
 * @example subpathsPathD([[[0, 0], [10, 0], [5, 8]]]) // "M0 0 L10 0 L5 8 Z"
 * @example subpathsPathD([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [7, 3], [7, 7], [3, 7]]]) // "M0 0 L10 0 L10 10 L0 10 Z M3 3 L7 3 L7 7 L3 7 Z"
 * @example subpathsPathD([[[0, 0], [10, 0], [5, 8]]]).includes("A") // false (never an arc command)
 */
export function subpathsPathD(subpaths) {
  const closed = (subpaths ?? []).filter((sp) => Array.isArray(sp) && sp.length >= 3);
  if (closed.length === 0) throw new Error(`subpathsPathD: need >= 1 subpath with >= 3 points, got ${JSON.stringify(subpaths)}`);
  return closed.map(polygonPathD).join(" ");
}

/**
 * Pure function. A closed polygon with ROUNDED corners: each vertex is cut back
 * by radius `r` along both incident edges and bridged by a quadratic bezier
 * (control point = the true vertex). `r` is clamped to half the shortest edge so
 * adjacent rounds never overrun each other. r <= 0 degrades to polygonPathD.
 *
 * @example roundedPolygonPathD([[0, 0], [10, 0], [5, 8]], 0) // "M0 0 L10 0 L5 8 Z"
 * @example roundedPolygonPathD([[0, 0], [20, 0], [20, 20], [0, 20]], 4).startsWith("M0 4") // true (corner 0 trimmed 4 up the left edge)
 * @example roundedPolygonPathD([[0, 0], [20, 0], [20, 20], [0, 20]], 4).includes("Q20 0") // true (control = the true corner)
 */
export function roundedPolygonPathD(points, r, cornerStyle = "round") {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`roundedPolygonPathD: need >= 3 points, got ${JSON.stringify(points)}`);
  if (!CORNER_STYLES.includes(cornerStyle)) throw new Error(`roundedPolygonPathD: unknown cornerStyle ${JSON.stringify(cornerStyle)} (known: ${CORNER_STYLES.join(", ")})`);
  if (!(r > 0)) return polygonPathD(points);
  const n = points.length;
  // Clamp r to half the shortest edge (both trims of an edge must fit inside it).
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    minEdge = Math.min(minEdge, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const rr = Math.min(r, minEdge / 2);
  const trimTo = (from, to) => {
    // Point `rr` away from `from` toward `to` (unit step along the edge).
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    return [from[0] + (dx / len) * rr, from[1] + (dy / len) * rr];
  };
  const segs = [];
  for (let i = 0; i < n; i++) {
    const v = points[i], prev = points[(i - 1 + n) % n], next = points[(i + 1) % n];
    segs.push({ entry: trimTo(v, prev), vertex: v, exit: trimTo(v, next) });
  }
  let d = `M${num(segs[0].entry[0])} ${num(segs[0].entry[1])}`;
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    // ROUND bridges the two trim points through the true corner (a quadratic);
    // CHAMFER cuts straight between them — the same trim, a line instead of a curve,
    // which is exactly what a chamfer is. Same `r`, same clamp, same vertices.
    d += cornerStyle === "chamfer"
      ? ` L${num(s.exit[0])} ${num(s.exit[1])}`
      : ` Q${num(s.vertex[0])} ${num(s.vertex[1])} ${num(s.exit[0])} ${num(s.exit[1])}`;
    if (i < n - 1) d += ` L${num(segs[i + 1].entry[0])} ${num(segs[i + 1].entry[1])}`;
  }
  return d + " Z"; // closing edge = exit(last) → entry(first), the final straight side
}

/** The two ways a polygon's corner may be cut back by `r` (roundedPolygonPathD):
 *  bridged by a curve, or by a straight line. */
export const CORNER_STYLES = ["round", "chamfer"];

/** The cubic-bezier control distance that best approximates a quarter circle:
 *  4·(√2 − 1)/3. The standard figure every vector tool draws its circles with. */
const ELLIPSE_KAPPA = 0.5522847498;

/**
 * Pure function. An ellipse filling the bbox as FOUR CUBIC BEZIERS (the kappa
 * construction), starting at the right-hand extreme and going clockwise — a cubic
 * rather than an arc command because of this module's backend contract (the PDF
 * exporter throws on `A`).
 *
 * @param {number} w - the box width
 * @param {number} h - the box height
 * @returns {string} SVG path data in bbox-local (0..w, 0..h, y-down) space
 *
 * @example ellipsePathD(100, 50).startsWith("M100 25 C100 38.807") // true
 * @example (ellipsePathD(100, 100).match(/C/g) || []).length // 4
 * @example ellipsePathD(100, 100).includes("A") // false (never an arc command)
 */
export function ellipsePathD(w, h) {
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const kx = rx * ELLIPSE_KAPPA, ky = ry * ELLIPSE_KAPPA;
  return `M${num(cx + rx)} ${num(cy)}`
    + ` C${num(cx + rx)} ${num(cy + ky)} ${num(cx + kx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)}`
    + ` C${num(cx - kx)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ky)} ${num(cx - rx)} ${num(cy)}`
    + ` C${num(cx - rx)} ${num(cy - ky)} ${num(cx - kx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)}`
    + ` C${num(cx + kx)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ky)} ${num(cx + rx)} ${num(cy)} Z`;
}

/**
 * Pure function. `count` points evenly spaced on the bbox-inscribed ellipse
 * (center w/2,h/2; radii w/2,h/2), starting at `startAngle` and going clockwise.
 *
 * @example ellipsePoints(100, 100, 4, -Math.PI / 2).map(([x, y]) => [Math.round(x), Math.round(y)]) // [[50, 0], [100, 50], [50, 100], [0, 50]]
 */
export function ellipsePoints(w, h, count, startAngle = TOP_UP) {
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = startAngle + (i * 2 * Math.PI) / count;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/**
 * Pure function. A regular polygon inscribed in the bbox, pointing up.
 * sides 3 = triangle, 5 = pentagon, 6 = hexagon, 8 = octagon, …
 * `sides` is rounded and clamped UP to 3 — fewer is not a polygon, and throwing
 * inside a widget's emit() would blank the whole canvas (review HIGH: the shared
 * shapePoints inspector row floors at 2 for star, which reaches this generator).
 *
 * @example regularPolygonPathD(100, 100, 4) // "M50 0 L100 50 L50 100 L0 50 Z"
 * @example regularPolygonPathD(100, 100, 3).split("L").length // 3
 * @example regularPolygonPathD(100, 100, 2).split("L").length // 3 (clamped up to a triangle)
 */
export function regularPolygonPathD(w, h, sides) {
  const n = Math.max(3, Math.round(sides));
  return polygonPathD(ellipsePoints(w, h, n));
}

/**
 * Pure function. An n-pointed star inscribed in the bbox, pointing up. Outer
 * vertices sit on the bbox ellipse; inner vertices on that ellipse scaled by
 * `innerRatio` (0..1 — smaller = spikier).
 *
 * @example starPathD(100, 100, 5, 0.5).startsWith("M50 0") // true
 * @example starPathD(100, 100, 5, 0.5).split("L").length // 10 (5 outer + 5 inner vertices)
 * @example starPathD(100, 100, 4, 0.4).split("L").length // 8
 */
export function starPathD(w, h, points = STAR_DEFAULT_POINTS, innerRatio = STAR_DEFAULT_INNER) {
  const p = Math.max(2, Math.round(points));
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const inner = Math.max(0, Math.min(1, innerRatio));
  const step = Math.PI / p; // half a full point-to-point sweep
  const verts = [];
  for (let i = 0; i < 2 * p; i++) {
    const a = TOP_UP + i * step;
    const s = i % 2 === 0 ? 1 : inner; // even = outer tip, odd = inner notch
    verts.push([cx + rx * s * Math.cos(a), cy + ry * s * Math.sin(a)]);
  }
  return polygonPathD(verts);
}

/**
 * Pure function. A diamond / rhombus inscribed in the bbox (the 4-point regular
 * polygon: top, right, bottom, left).
 *
 * @example diamondPathD(100, 100) // "M50 0 L100 50 L50 100 L0 50 Z"
 */
export function diamondPathD(w, h) {
  return regularPolygonPathD(w, h, 4);
}

/**
 * Pure function. A rounded-corner equilateral-ish triangle inscribed in the
 * bbox (the pointing-up triangle with each corner rounded by ROUND_CORNER_
 * FRACTION of the shorter side).
 *
 * @example roundedTrianglePathD(100, 100).startsWith("M") // true
 * @example roundedTrianglePathD(100, 100).includes("Q") // true
 */
export function roundedTrianglePathD(w, h) {
  return roundedPolygonPathD(ellipsePoints(w, h, 3), Math.min(w, h) * ROUND_CORNER_FRACTION);
}

/**
 * Pure function. A heart filling the bbox (two lobes on top, tip at the bottom),
 * built from four cubic beziers. Coefficients are the heart's control-point
 * positions as fractions of w/h, traced tip → left flank → left lobe → right
 * lobe → right flank.
 *
 * @example heartPathD(100, 100).startsWith("M50") // true
 * @example (heartPathD(100, 100).match(/C/g) || []).length // 4
 */
export function heartPathD(w, h) {
  const X = (f) => num(f * w), Y = (f) => num(f * h);
  return [
    `M${X(0.5)} ${Y(0.98)}`,
    `C${X(0.2)} ${Y(0.75)} ${X(0)} ${Y(0.55)} ${X(0)} ${Y(0.35)}`,   // down-left flank up to the left side
    `C${X(0)} ${Y(0.12)} ${X(0.3)} ${Y(0.06)} ${X(0.5)} ${Y(0.25)}`, // over the left lobe to the center dip
    `C${X(0.7)} ${Y(0.06)} ${X(1)} ${Y(0.12)} ${X(1)} ${Y(0.35)}`,   // over the right lobe
    `C${X(1)} ${Y(0.55)} ${X(0.8)} ${Y(0.75)} ${X(0.5)} ${Y(0.98)}`, // down the right flank back to the tip
    "Z",
  ].join(" ");
}

/**
 * Pure function. A puffy cloud filling the bbox (three top lobes over a flatter
 * base), built from cubic beziers. Coefficients are lobe control points as
 * fractions of w/h.
 *
 * @example cloudPathD(100, 100).startsWith("M") // true
 * @example (cloudPathD(100, 100).match(/C/g) || []).length // 5
 */
export function cloudPathD(w, h) {
  const X = (f) => num(f * w), Y = (f) => num(f * h);
  return [
    `M${X(0.25)} ${Y(0.95)}`,
    `C${X(0.1)} ${Y(0.95)} ${X(0.05)} ${Y(0.8)} ${X(0.15)} ${Y(0.7)}`,   // lower-left curl in
    `C${X(0.05)} ${Y(0.55)} ${X(0.15)} ${Y(0.35)} ${X(0.32)} ${Y(0.42)}`, // left lobe
    `C${X(0.38)} ${Y(0.22)} ${X(0.62)} ${Y(0.22)} ${X(0.68)} ${Y(0.42)}`, // top lobe
    `C${X(0.85)} ${Y(0.35)} ${X(0.95)} ${Y(0.55)} ${X(0.85)} ${Y(0.7)}`,  // right lobe
    `C${X(0.95)} ${Y(0.8)} ${X(0.9)} ${Y(0.95)} ${X(0.75)} ${Y(0.95)}`,   // lower-right curl in
    "Z",
  ].join(" ");
}

/**
 * Pure function. A speech bubble: a rounded-rect body across the top ~78% of the
 * bbox with a triangular tail dropping to the bottom-left. Quadratic corners
 * (radius = ROUND_CORNER_FRACTION of the body's shorter side).
 *
 * @example speechBubblePathD(100, 100).startsWith("M") // true
 * @example speechBubblePathD(100, 100).includes("Q") // true
 */
export function speechBubblePathD(w, h) {
  const bodyH = 0.75 * h;               // body occupies the top portion; tail hangs below
  const r = Math.min(w, bodyH) * ROUND_CORNER_FRACTION;
  const X = (f) => f * w, Y = (f) => f * h;
  const n = num;
  return [
    `M${n(r)} 0`,
    `L${n(w - r)} 0`,
    `Q${n(w)} 0 ${n(w)} ${n(r)}`,
    `L${n(w)} ${n(bodyH - r)}`,
    `Q${n(w)} ${n(bodyH)} ${n(w - r)} ${n(bodyH)}`,
    `L${n(X(0.42))} ${n(bodyH)}`,       // right base of the tail
    `L${n(X(0.2))} ${n(Y(1))}`,         // tail tip at the bottom edge
    `L${n(X(0.28))} ${n(bodyH)}`,       // left base of the tail
    `L${n(r)} ${n(bodyH)}`,
    `Q0 ${n(bodyH)} 0 ${n(bodyH - r)}`,
    `L0 ${n(r)}`,
    `Q0 0 ${n(r)} 0`,
    "Z",
  ].join(" ");
}

/**
 * Pure function. A rightward chevron band (a ">" arrow ribbon spanning the
 * bbox).
 *
 * @example chevronPathD(100, 100).startsWith("M0 0") // true
 * @example chevronPathD(100, 100).split("L").length // 6 (6 vertices: M + 5 L)
 */
export function chevronPathD(w, h) {
  return polygonPathD([
    [0, 0], [0.55 * w, 0], [w, 0.5 * h], [0.55 * w, h], [0, h], [0.45 * w, 0.5 * h],
  ]);
}

/**
 * Pure function. A rightward block arrow (rectangular shaft + triangular head)
 * filling the bbox.
 *
 * @example arrowBlockPathD(100, 100).startsWith("M0 30") // true
 * @example arrowBlockPathD(100, 100).split("L").length // 7 (7 vertices: M + 6 L)
 */
export function arrowBlockPathD(w, h) {
  return polygonPathD([
    [0, 0.3 * h], [0.6 * w, 0.3 * h], [0.6 * w, 0.1 * h],
    [w, 0.5 * h],
    [0.6 * w, 0.9 * h], [0.6 * w, 0.7 * h], [0, 0.7 * h],
  ]);
}

/**
 * Pure function. A plus / cross filling the bbox, with arms `CROSS_ARM` of the
 * box wide.
 *
 * @example crossPathD(90, 90) // "M30 0 L60 0 L60 30 L90 30 L90 60 L60 60 L60 90 L30 90 L30 60 L0 60 L0 30 L30 30 Z"
 */
export function crossPathD(w, h) {
  const x1 = CROSS_ARM * w, x2 = (1 - CROSS_ARM) * w;
  const y1 = CROSS_ARM * h, y2 = (1 - CROSS_ARM) * h;
  return polygonPathD([
    [x1, 0], [x2, 0], [x2, y1], [w, y1], [w, y2], [x2, y2],
    [x2, h], [x1, h], [x1, y2], [0, y2], [0, y1], [x1, y1],
  ]);
}

/**
 * Pure function. A lightning bolt zigzag filling the bbox.
 *
 * @example lightningPathD(100, 100).startsWith("M60 0") // true
 * @example lightningPathD(100, 100).split("L").length // 7 (7 vertices: M + 6 L)
 */
export function lightningPathD(w, h) {
  return polygonPathD([
    [0.6 * w, 0], [0.2 * w, 0.55 * h], [0.45 * w, 0.55 * h],
    [0.35 * w, h], [0.8 * w, 0.4 * h], [0.5 * w, 0.4 * h], [0.7 * w, 0],
  ]);
}

/**
 * Pure function. A parallelogram (top edge sheared right by PARALLELOGRAM_SLANT
 * of w) filling the bbox.
 *
 * @example parallelogramPathD(100, 100) // "M25 0 L100 0 L75 100 L0 100 Z"
 */
export function parallelogramPathD(w, h) {
  const s = PARALLELOGRAM_SLANT * w;
  return polygonPathD([[s, 0], [w, 0], [w - s, h], [0, h]]);
}

/**
 * Pure function. A trapezoid (narrower top, full-width base) filling the bbox.
 *
 * @example trapezoidPathD(100, 100) // "M20 0 L80 0 L100 100 L0 100 Z"
 */
export function trapezoidPathD(w, h) {
  const ti = TRAPEZOID_TOP_INSET * w;
  return polygonPathD([[ti, 0], [w - ti, 0], [w, h], [0, h]]);
}

/**
 * The preset registry: name → generator (w, h, params) → SVG path `d`. Ordered
 * for the toolbar grid. `params` carries the adjustable knobs (points/innerRatio
 * for star; sides for the generic polygon) — each generator reads what it needs
 * and ignores the rest. A pure lookup table (near-pure generators — all pure).
 */
export const SHAPE_GENERATORS = {
  star: (w, h, p = {}) => starPathD(w, h, p.points ?? STAR_DEFAULT_POINTS, p.innerRatio ?? STAR_DEFAULT_INNER),
  triangle: (w, h) => regularPolygonPathD(w, h, 3),
  roundedTriangle: (w, h) => roundedTrianglePathD(w, h),
  pentagon: (w, h) => regularPolygonPathD(w, h, 5),
  hexagon: (w, h) => regularPolygonPathD(w, h, 6),
  octagon: (w, h) => regularPolygonPathD(w, h, 8),
  polygon: (w, h, p = {}) => regularPolygonPathD(w, h, p.points ?? POLYGON_DEFAULT_SIDES),
  diamond: (w, h) => diamondPathD(w, h),
  heart: (w, h) => heartPathD(w, h),
  cloud: (w, h) => cloudPathD(w, h),
  speechBubble: (w, h) => speechBubblePathD(w, h),
  chevron: (w, h) => chevronPathD(w, h),
  arrowBlock: (w, h) => arrowBlockPathD(w, h),
  cross: (w, h) => crossPathD(w, h),
  lightning: (w, h) => lightningPathD(w, h),
  parallelogram: (w, h) => parallelogramPathD(w, h),
  trapezoid: (w, h) => trapezoidPathD(w, h),
};

/** Every preset name, in toolbar/grid order. */
export const SHAPE_NAMES = Object.keys(SHAPE_GENERATORS);

/** Human labels for the picker + the Inspector select (single-sourced here). */
export const SHAPE_LABELS = {
  star: "Star", triangle: "Triangle", roundedTriangle: "Rounded Triangle",
  pentagon: "Pentagon", hexagon: "Hexagon", octagon: "Octagon", polygon: "Polygon",
  diamond: "Diamond", heart: "Heart", cloud: "Cloud", speechBubble: "Speech Bubble",
  chevron: "Chevron", arrowBlock: "Block Arrow", cross: "Cross", lightning: "Lightning",
  parallelogram: "Parallelogram", trapezoid: "Trapezoid",
};

/**
 * Pure function. THE dispatcher: preset name → SVG path `d` for a w×h bbox.
 * Unknown names throw loudly (a typo must not silently draw nothing). `params`
 * forwards adjustable knobs to the generator.
 *
 * Args:
 *   name (string): a SHAPE_NAMES key
 *   w, h (number): the bbox size in local units
 *   params (object): {points?, innerRatio?} — generator knobs (optional)
 *
 * Returns:
 *   string: SVG path data in bbox-local (0..w, 0..h, y-down) space
 *
 * @example shapePath("diamond", 100, 100) // "M50 0 L100 50 L50 100 L0 50 Z"
 * @example shapePath("star", 100, 100).split("L").length // 10
 * @example shapePath("star", 100, 100, {points: 6}).split("L").length // 12
 */
export function shapePath(name, w, h, params = {}) {
  const gen = SHAPE_GENERATORS[name];
  if (!gen) throw new Error(`shapePath: unknown shape "${name}" (known: ${SHAPE_NAMES.join(", ")})`);
  return gen(w, h, params);
}
