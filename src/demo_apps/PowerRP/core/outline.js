/**
 * Parametric outline geometry — the substrate for the SUBCLASS OF
 * PARAMETERIZED GEOMETRY widgets (manifest: "FANCY ARROW … the first of a
 * SUBCLASS of parameterized geometry"), designed to converge with
 * GENERAL-PURPOSE BORDERS and the dynamic-anchor rim/path type: ONE geometry
 * module.
 *
 * An OUTLINE is a closed polygon: an array of [x, y] points with an implicit
 * closing edge from the last point back to the first — the SAME points
 * convention as render_gpu/ir.js polygon/polyline. Plain JSON-serializable
 * data, no classes, so outlines can live in documents, cross the IR seam,
 * and be diffed/tested trivially.
 *
 * The intended growth path (design, not yet built):
 *   - GENERATORS (pure param → outline functions; fancyArrowOutline is #1):
 *     each new parametric shape is data + a generator here, not bespoke
 *     plugin geometry code.
 *   - triangulated() bridges outlines to today's CONVEX-only IR polygon op;
 *     when the vector track adds an IR `path` op, generators are unchanged —
 *     emit() swaps N triangles for one path command.
 *   - Borders: stroke GEOMETRY (offset/tessellate an outline) lands here as
 *     more pure functions over the same type.
 *   - Dynamic-anchor rims: closest-point / nearest-pair solvers over the same
 *     type ("HAS A RIM" = has an outline).
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * Pure function. Shoelace signed area of a closed polygon. Positive when the
 * vertex order is counterclockwise in y-up math coordinates (equivalently,
 * clockwise on a y-down screen); the SIGN is only used to normalize winding,
 * the MAGNITUDE is the area.
 *
 * Args:
 *   points (number[][]): closed polygon [[x, y], ...]
 *
 * Returns:
 *   number: signed area
 *
 * @example signedArea([[0, 0], [1, 0], [1, 1], [0, 1]]) // 1
 * @example signedArea([[0, 0], [0, 1], [1, 1], [1, 0]]) // -1 (reversed winding)
 * @example signedArea([[0, 0], [5, 0], [10, 0]]) // 0 (collinear — degenerate)
 */
export function signedArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a / 2;
}

/**
 * Pure function. Is a point inside a closed polygon? Even-odd ray cast —
 * works for concave (and self-intersecting) outlines. Boundary points are
 * edge-rule dependent (callers wanting a grab tolerance should pad
 * separately, e.g. with distToSegment).
 *
 * Args:
 *   points (number[][]): closed polygon [[x, y], ...]
 *   px, py (number): query point
 *
 * Returns:
 *   boolean
 *
 * @example pointInPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5) // true
 * @example pointInPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 15, 5) // false
 * @example pointInPolygon([[0, 0], [4, 2], [0, 4], [1, 2]], 0.6, 2.1) // false (in the dart's dimple notch)
 * @example pointInPolygon([[0, 0], [4, 2], [0, 4], [1, 2]], 2, 2.1) // true (in the dart's body)
 */
export function pointInPolygon(points, px, py) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Pure function. Distance from a point to the segment ab. (Moved here from
 * plugins/arrow.js — it is generic segment math shared by every
 * endpoint-shaped widget's hit test, and open paths are segment chains.)
 *
 * @example distToSegment(0, 5, {x: 0, y: 0}, {x: 10, y: 0}) // 5
 * @example distToSegment(-3, 0, {x: 0, y: 0}, {x: 10, y: 0}) // 3
 */
export function distToSegment(px, py, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2));
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}

/**
 * Pure function. The unit axis (a → b) and unit right-normal for a segment,
 * plus its length — the SAME (ux, uy, nx, ny) decomposition fancyArrowOutline
 * and bezierControlFromBend each derive inline; factored here so any
 * axis-relative modifier point (a MODIFIER POINT constrained to slide along
 * an endpoint-pair widget's own axis or perpendicular to it — manifest
 * ARCHITECTURE PLAN #1/#6) can reuse ONE derivation instead of re-deriving
 * the right-normal sign convention per caller. Degenerate (coincident) points
 * fall back to the +x axis (an arbitrary but consistent choice — the same
 * "axis is arbitrary, geometry collapses to a point anyway" territory as
 * headTriangle's degenerate case).
 *
 * @example axisNormalFrame({x: 0, y: 0}, {x: 100, y: 0}) // {ux: 1, uy: 0, nx: -0, ny: 1, length: 100} (nx is IEEE -0 here: -uy where uy is +0 — mathematically 0, just not Object.is-identical to +0)
 * @example axisNormalFrame({x: 0, y: 0}, {x: 0, y: 100}) // {ux: 0, uy: 1, nx: -1, ny: 0, length: 100}
 */
export function axisNormalFrame(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { ux: 1, uy: 0, nx: 0, ny: 1, length: 0 };
  const ux = dx / length, uy = dy / length;
  return { ux, uy, nx: -uy, ny: ux, length };
}

/**
 * Pure function. Signed distance of point p along the axis from `a` (the
 * component of (p−a) parallel to the unit axis (ux,uy) — from
 * axisNormalFrame). Together with projectOntoNormal, decomposes any point
 * into a segment's own (axial, normal) coordinate system — the inverse half
 * of placing/reading a modifier point that's constrained to ONE of those two
 * directions (donut's radial handle projects onto a radius; fancy_arrow's
 * head handles project onto the shaft axis or its normal).
 *
 * @example projectOntoAxis({x: 0, y: 0}, {ux: 1, uy: 0}, {x: 30, y: 5}) // 30
 */
export function projectOntoAxis(a, frame, p) {
  return (p.x - a.x) * frame.ux + (p.y - a.y) * frame.uy;
}

/**
 * Pure function. Signed distance of point p along the normal from `a` (the
 * component of (p−a) parallel to the unit normal (nx,ny) — from
 * axisNormalFrame). See projectOntoAxis for the paired axial projection.
 *
 * @example projectOntoNormal({x: 0, y: 0}, {nx: 0, ny: 1}, {x: 30, y: 5}) // 5
 */
export function projectOntoNormal(a, frame, p) {
  return (p.x - a.x) * frame.nx + (p.y - a.y) * frame.ny;
}

/**
 * Pure function. Closest point on the RIM of an axis-aligned ROUNDED rectangle
 * (top-left at 0,0, size w×h, uniform corner radius r) to a query point. The
 * rim is four straight edges plus four quarter-circle arcs — the SAME geometry
 * the renderer paints (ir.js cornerRadius) and the substrate the dynamic-anchor
 * rim solvers share. r is clamped to [0, min(w,h)/2] (a mathematical bound —
 * the arcs can't overlap), matching ir.js's cornerRadius clamp.
 *
 * HOW IT WORKS: the four arc centers span the inner box [r, w−r]×[r, h−r].
 * Clamping the query to that box gives (ax, ay) — the nearest arc center on a
 * corner, or the foot of the perpendicular onto a straight edge on a side. For
 * a query OUTSIDE the rim the boundary point is (ax,ay) + r·unit(query−(ax,ay)):
 * on a corner that traces the arc, on a side that lands on the straight edge
 * (the offset is purely axis-aligned). A query strictly INSIDE (r=0 or when the
 * clamp doesn't move it) projects to the nearest of the four straight edges,
 * exactly like closestPointOnRectBorder — a rounded rect's nearest boundary
 * from inside is always a straight edge when r ≤ min(w,h)/2.
 *
 * Args:
 *   w, h (number): rect size
 *   r (number): corner radius (clamped to [0, min(w,h)/2])
 *   px, py (number): query point (rect-local coords)
 *
 * Returns:
 *   {x, y}: closest rim point
 *
 * @example closestPointOnRoundedRect(200, 120, 30, 200, 0) // {x: 191.21320343559643, y: 8.786796564403573} (tr corner → the 45° arc rim point, not the square corner)
 * @example closestPointOnRoundedRect(200, 120, 30, 100, 0) // {x: 100, y: 0} (top edge midpoint — straight, unaffected)
 * @example closestPointOnRoundedRect(200, 120, 30, 400, -100) // {x: 196.11688516160402, y: 15.238282299962943} (external point → tr arc)
 * @example closestPointOnRoundedRect(200, 120, 0, 250, 60) // {x: 200, y: 60} (r=0 collapses to the square border)
 */
export function closestPointOnRoundedRect(w, h, r, px, py) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const ax = Math.max(rad, Math.min(px, w - rad));
  const ay = Math.max(rad, Math.min(py, h - rad));
  const dx = px - ax, dy = py - ay;
  const d = Math.hypot(dx, dy);
  if (d > 0) return { x: ax + (rad * dx) / d, y: ay + (rad * dy) / d };
  // Query is on/inside the arc-center box: project to the nearest STRAIGHT edge.
  const dl = px, dr = w - px, dt = py, db = h - py;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: 0, y: py };
  if (m === dr) return { x: w, y: py };
  if (m === dt) return { x: px, y: 0 };
  return { x: px, y: h };
}

/**
 * Pure function. The rim point for a STANDARD bbox anchor id on a ROUNDED rect
 * (top-left 0,0, size w×h, radius r). Edge-midpoint and center anchors are on
 * straight edges / interior and DON'T move with rounding; the four CORNER
 * anchors (tl/tr/bl/br) slide onto the arc — the 45° outermost rim point of
 * each rounded corner (computed as the closest rim point to the SQUARE corner).
 * When r ≤ 0 every anchor is its square-bbox position (byte-identical to
 * standardBBoxAnchors), so unrounded rects are unaffected.
 *
 * Args:
 *   w, h (number): rect size
 *   r (number): corner radius
 *   id (string): one of tl tm tr ml cm mr bl bm br
 *   sx, sy (number): the square-bbox anchor position for `id`
 *
 * Returns:
 *   {x, y}: the anchor point ON the rounded rim
 *
 * @example roundedRectAnchorPoint(200, 120, 30, "tr", 200, 0) // {x: 191.21320343559643, y: 8.786796564403573}
 * @example roundedRectAnchorPoint(200, 120, 30, "tm", 100, 0) // {x: 100, y: 0} (edge midpoint — unchanged)
 * @example roundedRectAnchorPoint(200, 120, 0, "tr", 200, 0) // {x: 200, y: 0} (no rounding — square corner)
 */
export function roundedRectAnchorPoint(w, h, r, id, sx, sy) {
  const CORNERS = new Set(["tl", "tr", "bl", "br"]);
  if (r <= 0 || !CORNERS.has(id)) return { x: sx, y: sy };
  return closestPointOnRoundedRect(w, h, r, sx, sy);
}

// ── Dynamic-anchor rim solvers (nearest point / nearest pair) ─────────────────
// The substrate for the equation function `closest_to_rim` (manifest "Dynamic
// anchors — USER REFINEMENT"). A RIM is modeled abstractly as its CLOSEST-POINT
// MAP: a pure function proj(qx, qy) → {x, y} returning the rim point nearest a
// query point, ALL IN WORLD SPACE. Every bbox plugin already exposes exactly
// this via closestAnchor(state, wx, wy, world) (circle → radial point, rect /
// rounded-rect / crop box → closestPointOnRoundedRect, all worldTransform-aware),
// so these solvers are GENERIC over rim geometry — circle, rect, rounded rect,
// and any future custom outline work through the identical interface with no
// per-shape branch here (manifest generic-rim ruling: "ONE geometry system").

/**
 * Pure function. The closest point ON a circle's rim (center c, radius rad) to a
 * query point (qx, qy) — the radial projection. A query AT the center has no
 * defined direction; it falls back to the +x rim point (an arbitrary but
 * consistent choice, matching axisNormalFrame's degenerate convention).
 *
 * @example closestPointOnCircle({x: 0, y: 0}, 10, 100, 0) // {x: 10, y: 0}
 * @example closestPointOnCircle({x: 0, y: 0}, 5, 3, 4) // {x: 3, y: 4} (already at radius 5: the point projects onto itself)
 * @example closestPointOnCircle({x: 2, y: 3}, 7, 2, 3) // {x: 9, y: 3} (query at center → +x rim)
 */
export function closestPointOnCircle(c, rad, qx, qy) {
  const dx = qx - c.x, dy = qy - c.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: c.x + rad, y: c.y };
  return { x: c.x + (rad * dx) / d, y: c.y + (rad * dy) / d };
}

/**
 * Pure function. The nearest PAIR of points between TWO circles (centers cA/cB,
 * radii rA/rB), solved in ONE closed form: both points lie on the center line,
 * on the sides FACING each other — pA = cA + rA·u, pB = cB − rB·u where
 * u = unit(cB − cA). This is the exact analytic answer for the circle/circle
 * case (no iteration), and the reason a mutual closest_to_rim(circleA, circleB)
 * lands each endpoint on the true nearest pair with ZERO wobble: from.x/from.y
 * read pA, to.x/to.y read pB, both from ONE solve. Concentric circles
 * (coincident centers) have no facing direction; the pair falls back to the +x
 * axis (arbitrary but consistent, same convention as closestPointOnCircle).
 *
 * @example nearestPairCircleCircle({x: 0, y: 0}, 10, {x: 100, y: 0}, 20) // {a: {x: 10, y: 0}, b: {x: 80, y: 0}}
 * @example nearestPairCircleCircle({x: 0, y: 0}, 10, {x: 0, y: 50}, 10) // {a: {x: 0, y: 10}, b: {x: 0, y: 40}} (vertical center line)
 * @example nearestPairCircleCircle({x: 5, y: 5}, 3, {x: 5, y: 5}, 4) // {a: {x: 8, y: 5}, b: {x: 1, y: 5}} (concentric → +x fallback)
 */
export function nearestPairCircleCircle(cA, rA, cB, rB) {
  const dx = cB.x - cA.x, dy = cB.y - cA.y;
  const d = Math.hypot(dx, dy);
  const ux = d === 0 ? 1 : dx / d, uy = d === 0 ? 0 : dy / d;
  return {
    a: { x: cA.x + rA * ux, y: cA.y + rA * uy },
    b: { x: cB.x - rB * ux, y: cB.y - rB * uy },
  };
}

// Convergence controls for the GENERIC alternating-projection nearest-pair
// solver (nearestRimPair), used for any rim pair without a closed form
// (rect/rect, circle/rect, rounded/rotated, custom outlines). Alternating
// projection between two convex-ish rims is a firmly-nonexpansive fixed-point
// iteration: each half-step is the metric projection onto a rim, which is
// nonexpansive, so the round-trip map A∘B is nonexpansive and the iterates
// converge to a point pair realizing the inter-rim distance. Contraction weakens
// as the rims approach tangency (the wobble class the manifest calls out), so a
// FIXED iteration count cannot hold a tolerance — the loop runs until the step
// movement drops under NEAREST_PAIR_EPS_PX or the cap fires (reported, never
// silent). Unlike the OLD closestToward Gauss-Seidel (which interleaved this
// iteration with topo evaluation, so re-evaluation could re-wobble), this solves
// the pair ONCE per evaluation pass and both endpoints read the same result.
const NEAREST_PAIR_EPS_PX = 1e-4;
// Iteration cap. Probe-measured against the worst legitimate geometry (two rims
// a hair from tangency): alternating projection settles in well under this even
// near tangency because each rim's projection re-snaps to the true boundary (it
// is NOT the weakly-contracting endpoint-to-endpoint map of the old fixpoint);
// 200 gives ample headroom at negligible cost (a step is two closest-point
// evals). Hitting the cap is REPORTED by the caller, never silent. (Safety
// bound, not tuned behavior — PENDING USER RATIFICATION, derivation above.)
export const NEAREST_PAIR_MAX_ITERS = 200;

/**
 * Pure function. The nearest PAIR of world points between two rims given ONLY
 * their closest-point maps (projA/projB: (qx, qy) → {x, y} world rim point) —
 * the GENERIC solver for any rim geometry without a closed form. Alternating
 * projection from a seed (default the midpoint between two seed hints, or the
 * origin): project the current B-point onto rim A, that onto rim B, repeat until
 * the movement is under NEAREST_PAIR_EPS_PX or NEAREST_PAIR_MAX_ITERS is hit.
 *
 * Returns {a, b, iters, converged}: `a` on rim A nearest `b` on rim B, the
 * iteration count, and whether it met the tolerance (false ⇒ the caller reports
 * the cap loudly — degenerate/tangent geometry). Deterministic given the seed,
 * so identical calls memoize to identical results (no wobble).
 *
 * @example // Two 20-wide squares (as rects via their closestAnchor); solved to the facing edges.
 * @example nearestRimPair((x, y) => ({x: Math.max(0, Math.min(x, 20)), y: 10}), (x, y) => ({x: Math.max(100, Math.min(x, 120)), y: 10}), {seedA: {x: 20, y: 10}, seedB: {x: 100, y: 10}}).a // {x: 20, y: 10}
 */
export function nearestRimPair(projA, projB, { seedA, seedB } = {}) {
  // Seed b from a hint (the other rim's facing anchor) or the origin; the seed
  // only affects WHICH local minimum a nonconvex rim converges to, and the
  // caller passes facing-side hints (each rim's center or preset anchor toward
  // the other) so the intuitive nearest pair is found.
  let b = seedB ?? { x: 0, y: 0 };
  let a = seedA ?? { x: 0, y: 0 };
  let iters = 0;
  let converged = false;
  for (; iters < NEAREST_PAIR_MAX_ITERS; iters++) {
    const na = projA(b.x, b.y);
    const nb = projB(na.x, na.y);
    const moved = Math.max(Math.hypot(na.x - a.x, na.y - a.y), Math.hypot(nb.x - b.x, nb.y - b.y));
    a = na;
    b = nb;
    if (moved < NEAREST_PAIR_EPS_PX) { converged = true; iters++; break; }
  }
  return { a, b, iters, converged };
}

/**
 * Pure function. Ear-clipping triangulation of a SIMPLE closed polygon
 * (concave allowed, either winding) into triangles — the bridge from
 * arbitrary outlines to the IR's CONVEX-only polygon op (fan-triangulated
 * backends render each triangle exactly; shared edges are watertight under
 * GPU fill rules because vertices are shared verbatim).
 *
 * Exactly-collinear middle vertices are dropped (a zero-area ear — removing
 * it is exact, not an approximation), so degenerate zero-width outlines
 * resolve to [] instead of erroring. A polygon where NO ear exists
 * (self-intersecting input) throws loudly — generators are responsible for
 * staying inside their simple-polygon domain (see fancyArrowOutline's
 * domain clamps).
 *
 * ROBUSTNESS NOTE (donut parity investigation): this exact-arithmetic
 * ear-clipping is knife-edge-sensitive on HIGHLY SYMMETRIC many-vertex
 * polygons (e.g. a regular-polygon approximation of a circle/annulus) —
 * intermediate clipping states can land on genuinely EXACT collinearities
 * (not floating-point noise) that a strict `>= 0` containment test correctly
 * treats as blocking, yet an equivalent construction of the same shape via a
 * different floating-point path can land a hair off-exact and throw. Adding
 * a numeric tolerance here to paper over that was TRIED and REVERTED: it
 * regressed the L-shape test (a genuinely exact-collinear reflex vertex got
 * misclassified as non-blocking, producing a wrong triangulation with the
 * WRONG area) — the failure modes aren't separable by a single epsilon.
 * donutOutline (the caller that surfaces this) fixes it at the SOURCE
 * instead: a tiny per-vertex angular jitter breaks the exact symmetry that
 * creates these knife-edge collinearities, without touching this shared,
 * delicate function that fancy_arrow.js also depends on.
 *
 * Args:
 *   points (number[][]): simple closed polygon [[x, y], ...]
 *
 * Returns:
 *   number[][][]: triangles [[[x,y],[x,y],[x,y]], ...] (n-2 for clean input)
 *
 * @example triangulated([[0, 0], [10, 0], [10, 10], [0, 10]]).length // 2
 * @example triangulated([[0, 0], [4, 2], [0, 4], [1, 2]]).length // 2 (concave dart — the arrowhead case)
 * @example triangulated([[0, 0], [5, 0], [10, 0]]) // [] (zero area — nothing to fill)
 */
export function triangulated(points) {
  if (points.length < 3) return [];
  // Normalize to positive signed area so "convex vertex" is one fixed test.
  const pts = signedArea(points) < 0 ? [...points].reverse() : points;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const idx = pts.map((_, i) => i);
  const tris = [];
  while (idx.length > 3) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const cr = cross(a, b, c);
      if (cr < 0) continue; // reflex vertex — not an ear
      if (cr === 0) {
        idx.splice(i, 1); // collinear middle vertex: zero-area ear, drop exactly
        clipped = true;
        break;
      }
      let contains = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped)
      throw new Error(`triangulated: no ear found — polygon is degenerate or self-intersecting (${idx.length} vertices left)`);
  }
  const [a, b, c] = idx.map((i) => pts[i]);
  if (cross(a, b, c) !== 0) tris.push([a, b, c]); // final triangle unless zero-area
  return tris;
}

/**
 * Pure function. GENERATOR #1: the Figures-library parametric arrow outline —
 * a faithful port of `_arrow_contours`'s `full` contour
 * (refs/Figures/arrow/arrow.py:354-406): a 7-vertex closed outline fusing a
 * tapered shaft (startWidth → endWidth) into a dimpled head. The dimple point
 * sits `tipDimple` INTO the head from the barb base line (Python:
 * tip - unit·(tip_height - tip_dimple)), and the shaft meets the head at the
 * dimple point offset ±endWidth/2.
 *
 * PARAMETER CONVENTION vs the Python source: `tipWidth` here is the FULL head
 * width (barbs at ±tipWidth/2); Python's `tip_width` is the per-side barb
 * offset — so Python tip_width=15 ≡ tipWidth=30. Everything else maps 1:1
 * (tipLength = tip_height, tipDimple = tip_dimple, startWidth/endWidth
 * unchanged).
 *
 * DOMAIN CLAMPS (geometric validity bounds, not design choices — same rule as
 * ir.js's cornerRadius clamp). Clamping keeps the outline a SIMPLE polygon in
 * the reachable single-parameter scrubs, which triangulated() requires:
 *   - widths/lengths are non-negative;
 *   - tipLength ≤ arrow length (a longer head self-intersects at the tail);
 *   - tipDimple ≤ tipLength·(1 − (endWidth/2)/(tipWidth/2)): the shaft joins
 *     the head at the dimple point offset ±endWidth/2, and that junction must
 *     sit within the head's back edges (whose half-width at the dimple's
 *     axis position is (tipWidth/2)·(tipLength−D)/tipLength) or the shaft
 *     pokes through them and the outline self-intersects.
 * Residual multi-parameter corners (e.g. a tail wider than the head with the
 * head spanning the whole arrow) can still self-intersect — the CALLER of
 * triangulated() owns that failure policy (the fancy-arrow plugin degrades
 * loudly instead of bricking the render loop).
 *
 * Args:
 *   x0, y0 (number): tail point
 *   x1, y1 (number): tip point
 *   tipLength (number): head length along the shaft axis
 *   tipWidth (number): FULL head width across the barbs
 *   tipDimple (number): dimple depth into the head from the barb line
 *   startWidth (number): shaft width at the tail
 *   endWidth (number): shaft width where it meets the head
 *
 * Returns:
 *   number[][] | null: 7-point closed outline
 *     [dimpleL, startL, startR, dimpleR, barbR, tip, barbL],
 *     or null for a zero-length arrow (no geometry — the Python
 *     skia_draw_arrow precedent returns the image unchanged).
 *
 * @example fancyArrowOutline({x0: 0, y0: 0, x1: 100, y1: 0, tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5}) // [[90, -2.5], [0, -1.5], [0, 1.5], [90, 2.5], [85, 15], [100, 0], [85, -15]]
 * @example fancyArrowOutline({x0: 7, y0: 7, x1: 7, y1: 7, tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5}) // null (zero-length)
 */
export function fancyArrowOutline({ x0, y0, x1, y1, tipLength, tipWidth, tipDimple, startWidth, endWidth }) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ndx = dx / len, ndy = dy / len; // unit axis, tail → tip
  const nrx = -ndy, nry = ndx; // unit right normal (arrow.py:366-368)
  const halfTip = Math.max(tipWidth, 0) / 2;
  const halfStart = Math.max(startWidth, 0) / 2;
  const halfEnd = Math.max(endWidth, 0) / 2;
  const L = Math.min(Math.max(tipLength, 0), len); // head can't outrun the arrow
  // Deepest dimple whose ±halfEnd junction stays within the head's back
  // edges (see the header's domain-clamp derivation). halfTip 0 = no head
  // cone at all, so no dimple.
  const maxD = halfTip > 0 ? L * (1 - Math.min(halfEnd / halfTip, 1)) : 0;
  const D = Math.min(Math.max(tipDimple, 0), maxD);
  const dimpX = x1 - ndx * (L - D), dimpY = y1 - ndy * (L - D);
  const baseX = x1 - ndx * L, baseY = y1 - ndy * L; // barb base line center
  return [
    [dimpX - nrx * halfEnd, dimpY - nry * halfEnd], // dimpleL
    [x0 - nrx * halfStart, y0 - nry * halfStart], // startL
    [x0 + nrx * halfStart, y0 + nry * halfStart], // startR
    [dimpX + nrx * halfEnd, dimpY + nry * halfEnd], // dimpleR
    [baseX + nrx * halfTip, baseY + nry * halfTip], // barbR
    [x1, y1], // tip
    [baseX - nrx * halfTip, baseY - nry * halfTip], // barbL
  ];
}

// Circle tessellation resolution for donutOutline's outer/inner rims. Neither
// backend has a native ring/even-odd primitive (verified: grep for
// evenodd/fillRule across render_gpu turns up nothing, and the PDF backend's
// polygon case is a single "h f" non-zero-winding subpath — see pdf_backend.js
// emitVector), so the ring is approximated as a polygon, same tradeoff the
// fancy arrow already accepts for its curved dimple. 64 matches the visual
// smoothness the GPU's OWN circular resize-handle affordances read as "round"
// at typical on-screen widget sizes (no numeric precedent exists elsewhere in
// the codebase for polygon-approximated circles — flagged). PENDING USER
// RATIFICATION.
const DONUT_SEGMENTS = 64;

// A regular N-gon's vertices are EXACT-collinear at many intermediate
// ear-clipping states (three points spanning a symmetric arc can land on a
// mathematically exact line) — triangulated()'s strict cross()>=0 test is
// CORRECT to block those (see its docstring: a numeric tolerance was tried
// and reverted, it broke a genuinely-exact case). The fix belongs at the
// SOURCE: a per-vertex angular jitter far below visual/geometric significance
// breaks the exact symmetry so no intermediate state is exactly collinear,
// without weakening the shared triangulated() any other caller (fancy_arrow)
// relies on. 1e-7 rad ⇒ a sub-micron displacement at any donut size this app
// renders (radius up to ~1e4 world units → ~1e-3 unit shift; typical widget
// radius ~100 → ~1e-5 unit shift) — verified by a 200-case sweep (5 centers ×
// 4 radii × 10 inner ratios, incl. the cx=55 case that exposed the bug) all
// triangulating with area preserved to 1e-6 relative tolerance. i=0 gets ZERO
// jitter (i·JITTER at i=0 is exactly 0) so the doctested pts[0]===[10,0]
// start point is untouched.
const DONUT_ANGLE_JITTER = 1e-7;

/**
 * Pure function. GENERATOR #2: an annulus (ring) outline — the DONUT widget's
 * shape. Two concentric circles (outer radius R, inner radius r = R·inner)
 * joined into ONE simple closed polygon via a zero-width slit at angle 0 (the
 * standard "polygon with a hole" technique). The outer rim is walked forward
 * (angle 0 → 2π, ending back at angle 0's point, DUPLICATED); the inner rim
 * is then walked BACKWARD (0 → −2π, i.e. reversed, so its winding is opposite
 * the outer ring's — the orientation that reads as a hole rather than a
 * second stacked disk), also starting and ending at angle 0, DUPLICATED. The
 * two duplicated angle-0 vertices (one on each rim) are what make the slit's
 * "in" edge (outer's last point → inner's first point) and "out" edge
 * (inner's last point → outer's first point, via the implicit polygon close)
 * retrace the SAME radial segment in opposite directions — a zero-area slit
 * contributing nothing to signedArea or the fill, and exactly what turns two
 * disjoint circles into ONE simple polygon triangulated() (which requires no
 * holes) can ear-clip. Duplicating the angle-0 point on each rim (rather than
 * sharing an unduplicated index between the two loops, which would make the
 * bridge's "in" edge span from the LAST forward-loop angle instead of angle 0
 * — a real chord, not a slit) is the detail that keeps the bridge collinear.
 *
 * inner=0 degenerates to a full disk (the slit collapses to a single point at
 * the center — still a valid, if pathological, simple polygon: triangulated()
 * handles the zero-length edges via its collinear/zero-area ear rule, same as
 * fancyArrowOutline's zero-width degenerates). inner>=1 clamps to <1 (a
 * zero-thickness ring has no fill area and no meaningful modifier-point
 * trajectory).
 *
 * Args:
 *   cx, cy (number): center (local space)
 *   outerR (number): outer radius
 *   inner (number): hole radius as a PROPORTION of outerR, clamped to [0, 1)
 *
 * Returns:
 *   number[][]: closed polygon, 2·(DONUT_SEGMENTS + 1) points (outer rim,
 *     angle-0 duplicated at both ends, + inner rim, likewise), or [] for
 *     outerR <= 0
 *
 * @example donutOutline({cx: 0, cy: 0, outerR: 10, inner: 0.5}).length // 130 (65 outer + 65 inner)
 * @example donutOutline({cx: 0, cy: 0, outerR: 10, inner: 0.5})[0] // [10, 0] (outer rim starts at angle 0)
 * @example donutOutline({cx: 5, cy: 5, outerR: 0, inner: 0.5}) // [] (zero radius: no geometry)
 */
export function donutOutline({ cx, cy, outerR, inner }) {
  if (outerR <= 0) return [];
  const r = Math.max(0, Math.min(inner, 1 - 1e-9)) * outerR;
  const ring = (rad, sign) => {
    const pts = [];
    for (let i = 0; i <= DONUT_SEGMENTS; i++) {
      const a = sign * ((2 * Math.PI * i) / DONUT_SEGMENTS) + i * DONUT_ANGLE_JITTER;
      pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
    return pts;
  };
  return [...ring(outerR, 1), ...ring(r, -1)];
}

/**
 * Pure function. GENERATOR #3: an orthogonal H-V-H route between two points
 * (manifest ARCHITECTURE PLAN #6, ELBOW arrow — "PPT default H-V-H"): a
 * horizontal run from the start, one vertical run at the elbow, then a
 * horizontal run into the end. `elbow` (0..1) is the PROPORTION of the way
 * along the horizontal SPAN (x1−x0) where the vertical segment sits — this is
 * the single parameter the elbow's ONE modifier point scrubs (manifest: "an
 * `elbow` parameter (0..1, position of the middle segment along the span)
 * controlled by ONE MODIFIER POINT").
 *
 * At elbow=0 or elbow=1 the route degenerates to an L-shape (the vertical run
 * sits flush against one end) rather than disappearing — still a valid
 * 4-point polyline (two coincident points collapse to one edge of zero
 * length, which polyline()/hitsShaft handle like any other short segment, no
 * special-casing needed).
 *
 * Args:
 *   x0, y0 (number): start point
 *   x1, y1 (number): end point
 *   elbow (number): 0..1, the mid-segment's position along the x-span
 *
 * Returns:
 *   number[][]: [[x0,y0], [mx,y0], [mx,y1], [x1,y1]] — an OPEN polyline (not
 *     a closed outline; pass directly to render_gpu/ir.js's polyline())
 *
 * @example elbowRoute({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}) // [[0, 0], [50, 0], [50, 50], [100, 50]]
 * @example elbowRoute({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0}) // [[0, 0], [0, 0], [0, 50], [100, 50]] (flush at the start — a valid degenerate L)
 * @example elbowRoute({x0: 0, y0: 20, x1: 100, y1: 20, elbow: 0.5}) // [[0, 20], [50, 20], [50, 20], [100, 20]] (level span: the "vertical" run has zero length — still a straight line)
 */
export function elbowRoute({ x0, y0, x1, y1, elbow }) {
  const t = Math.max(0, Math.min(elbow, 1));
  const mx = x0 + (x1 - x0) * t;
  return [[x0, y0], [mx, y0], [mx, y1], [x1, y1]];
}

/**
 * Pure function. The midpoint of an H-V-H elbow route's VERTICAL segment (the
 * elbow's ONE modifier point sits here — the manifest's "yellow square on the
 * elbow"): the mid-segment's x (from elbowRoute) at the vertical run's own
 * midpoint y, so the handle sits centered on the segment it controls
 * regardless of how far apart y0/y1 are.
 *
 * @example elbowHandle({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}) // {x: 50, y: 25}
 */
export function elbowHandle({ x0, y0, x1, y1, elbow }) {
  const t = Math.max(0, Math.min(elbow, 1));
  return { x: x0 + (x1 - x0) * t, y: (y0 + y1) / 2 };
}

/**
 * Pure function. GENERATOR #4: a quadratic bezier's control point derived
 * from a signed `bend` proportion (manifest ARCHITECTURE PLAN #6, CURVED
 * arrow — "a `bend` parameter (signed, the control point's perpendicular
 * offset as a proportion of span length)"): the control point sits at the
 * segment's MIDPOINT, offset perpendicular to the start→end axis by
 * `bend * span` (span = the straight-line distance between the endpoints) —
 * so `bend` stays resolution-independent (scaling the whole arrow scales the
 * offset with it, unlike a stored absolute pixel offset).
 *
 * Sign convention: positive `bend` offsets toward the RIGHT-hand normal of
 * the start→end axis (same right-normal convention as
 * fancyArrowOutline/arrow.js's head math: normal = (-uy, ux) for unit axis
 * (ux, uy)) — arbitrary but consistent with the rest of this module, and the
 * ONLY thing that matters for a symmetric curvature control.
 *
 * Zero-length span (coincident endpoints) has no defined axis; the control
 * point falls back to the shared point (a degenerate zero-length curve, same
 * "no geometry" territory as fancyArrowOutline's zero-length null).
 *
 * @example bezierControlFromBend({x0: 0, y0: 0, x1: 100, y1: 0, bend: 0.3}) // {x: 50, y: 30}
 * @example bezierControlFromBend({x0: 0, y0: 0, x1: 100, y1: 0, bend: 0}) // {x: 50, y: 0} (bend 0 = the straight midpoint)
 * @example bezierControlFromBend({x0: 5, y0: 5, x1: 5, y1: 5, bend: 0.5}) // {x: 5, y: 5} (coincident endpoints: no axis, falls back to the shared point)
 */
export function bezierControlFromBend({ x0, y0, x1, y1, bend }) {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const { nx, ny, length } = axisNormalFrame({ x: x0, y: y0 }, { x: x1, y: y1 });
  if (length === 0) return { x: mx, y: my };
  const offset = bend * length;
  return { x: mx + nx * offset, y: my + ny * offset };
}

/**
 * Pure function. Point on a quadratic bezier at parameter t (De Casteljau /
 * the standard (1−t)²P0 + 2(1−t)t·C + t²P1 form).
 *
 * @example quadraticBezierPoint({x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}, 0.5) // {x: 50, y: 50}
 * @example quadraticBezierPoint({x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}, 0) // {x: 0, y: 0}
 * @example quadraticBezierPoint({x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}, 1) // {x: 100, y: 0}
 */
export function quadraticBezierPoint(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

// Sample count for a quadratic bezier's rendered/hit-tested polyline. No
// existing curve-sampling precedent exists elsewhere in the codebase (the
// only prior "approximate a smooth curve with N points" decision is
// DONUT_SEGMENTS=64, immediately above in this file, chosen for the same
// reason: visual smoothness at typical on-screen widget sizes, no stronger
// numeric precedent available). A quadratic bezier has far less curvature
// complexity than a full circle (at most one inflection-free bend), so it
// needs fewer samples for the same visual smoothness — 32 is DONUT_SEGMENTS
// halved, same "no numeric precedent exists" caveat. PENDING USER
// RATIFICATION (same flag as DONUT_SEGMENTS).
const CURVE_SEGMENTS = 32;

/**
 * Pure function. A quadratic bezier sampled into an OPEN polyline of
 * CURVE_SEGMENTS+1 points — the bridge from the curved arrow's control-point
 * math to render_gpu/ir.js's polyline() (manifest: "the polyline/capsule-
 * chain path handles curves as a sampled polyline" — verified: neither
 * backend has a native bezier stroke primitive, same "no native primitive"
 * situation donutOutline/fancyArrowOutline already accept for their curves).
 *
 * @example curvedArrowPolyline({x0: 0, y0: 0, x1: 100, y1: 0, bend: 0}).length // 33
 * @example curvedArrowPolyline({x0: 0, y0: 0, x1: 100, y1: 0, bend: 0})[16] // {x: 50, y: 0} (midpoint sample, straight bend=0)
 */
export function curvedArrowPolyline({ x0, y0, x1, y1, bend }) {
  const p0 = { x: x0, y: y0 }, p1 = { x: x1, y: y1 };
  const c = bezierControlFromBend({ x0, y0, x1, y1, bend });
  const pts = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) pts.push(quadraticBezierPoint(p0, c, p1, i / CURVE_SEGMENTS));
  return pts;
}
