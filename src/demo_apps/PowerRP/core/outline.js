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
 * AN OUTLINE REACHES PIXELS AS ONE `path` OP, NEVER AS TRIANGLES. Hand the point
 * list to core/shapes.js's polygonPathD (one loop) or subpathsPathD (a shape with
 * holes) and emit a single IR `path` with the `fillRule` the winding calls for.
 * That op takes arbitrary topology — concave, self-intersecting, multi-subpath,
 * holed — and has done in all three backends since 2026-07-23 (c0646a5).
 *
 * THIS PARAGRAPH USED TO SAY THE OPPOSITE, and saying it was the bug. It read
 * "triangulated() bridges outlines to today's CONVEX-only IR polygon op; when the
 * vector track adds an IR path op, generators are unchanged — emit() swaps N
 * triangles for one path command." The op landed and the swap never happened, so a
 * design note describing a temporary bridge went on instructing every widget
 * written after it to ear-clip. The donut fanned into 128 convex ops, the fancy
 * arrow into 5, a default filmstrip's two perforated bands into 480 — and two
 * abutting ANTIALIASED fills conflate to ~192/255 along their shared edge instead
 * of tiling to 255, so every one of those internal edges was a visible crack on
 * every surface in this app except the (uniquely multisampled) editor viewport.
 * That is R6-11, the user's "why is there a disconnect between the renderer and
 * what I see on my screen". A stale doctrine comment is a defect here, not a nit.
 *
 * triangulated() itself is UNRETIRED and correct — as GEOMETRY. A hit test, an
 * area, a point-in-shape query may use it freely. It is only the route from an
 * outline to PIXELS that is closed, and tests/triangulated_paint_ban_test.js is
 * what keeps it closed. Note also what is NOT implied: the convex `polygon` op is
 * fine and stays. One op per SHAPE has no neighbour to conflate with, which is why
 * arrow heads and line caps are correct exactly as they are. The sin was ever
 * splitting ONE shape across N ops.
 *
 * The intended growth path (design, not yet built):
 *   - GENERATORS (pure param → outline functions; fancyArrowOutline is #1):
 *     each new parametric shape is data + a generator here, not bespoke
 *     plugin geometry code.
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
  // The foot of the perpendicular IS closestPointOnSegment (declared below —
  // hoisted, so the order here is readability only): ONE segment-projection
  // derivation serves both the distance and the point.
  const q = closestPointOnSegment(a, b, { x: px, y: py });
  return Math.hypot(px - q.x, py - q.y);
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

// ── Constraint-set projections (the MODIFIER-POINT constraint vocabulary) ─────
// A constrained handle's ALLOWED SET is a curve or region, and the one operation
// every consumer needs is its CLOSEST-POINT MAP proj_S(desired) → the nearest
// point of S — the same "a rim IS its closest-point map" modeling the
// dynamic-anchor solvers below already use, applied to handle trajectories
// instead of rims. The functions here are the reusable sets (line / ray /
// segment / ring); core/derive.js declares the protocol that binds one to a
// handle. They are metric projections, hence IDEMPOTENT and nonexpansive.

/**
 * Pure function. The NEAREST point to `p` on the axis {o + t·d : t ∈ [tMin, tMax]}
 * — ONE derivation covering a full LINE, a RAY, and a SEGMENT, which is every
 * one-dimensional trajectory a MODIFIER POINT is pinned to (manifest ARCHITECTURE
 * PLAN #1: "highly-constrained ... often parameterized by ONE number").
 *
 *   t* = clamp((p − o)·d / (d·d), t_min, t_max),   proj = o + t*·d
 *
 * `t` is in units of `d`, NOT arc length: a SEGMENT a→b is o = a, d = b − a with
 * range [0, 1]; a RAY is a direction with range [0, ∞); a LINE is the default
 * unbounded range. A degenerate (zero-length) `d` describes the single point o,
 * which is then the only possible answer.
 *
 * EXACTNESS: the CONSTRAINED degrees of freedom come back exact (a coordinate
 * that d cannot move is copied through `o` untouched), while the free coordinate
 * re-rounds through the affine round-trip o + ((p−o)·d/|d|²)·d — so a point
 * already on an OBLIQUE axis returns equal to within floating-point rounding,
 * not bit-identical (measured bound in tests/handle_constraints_test.js).
 *
 * Args:
 *   o ({x, y}): a point on the axis (the ray's origin / the segment's start)
 *   d ({x, y}): the axis direction (need NOT be unit)
 *   p ({x, y}): the desired point
 *   tMin, tMax (number): the allowed range of t, in units of d
 *
 * Returns:
 *   {x, y}: the nearest allowed point
 *
 * @example closestPointOnAxisRange({x: 0, y: 0}, {x: 1, y: 0}, {x: 30, y: 5}) // {x: 30, y: 0} (full line — perpendicular foot)
 * @example closestPointOnAxisRange({x: 0, y: 0}, {x: 1, y: 0}, {x: -8, y: 5}, 0) // {x: 0, y: 0} (ray: t clamps to 0, NOT the mirrored +8)
 * @example closestPointOnAxisRange({x: 0, y: 0}, {x: 10, y: 0}, {x: 40, y: 5}, 0, 1) // {x: 10, y: 0} (segment: past the far end)
 * @example closestPointOnAxisRange({x: 3, y: 4}, {x: 0, y: 0}, {x: 9, y: 9}) // {x: 3, y: 4} (degenerate direction — the set is the point o)
 */
export function closestPointOnAxisRange(o, d, p, tMin = -Infinity, tMax = Infinity) {
  const dd = d.x * d.x + d.y * d.y;
  if (dd === 0) return { x: o.x, y: o.y };
  const t = Math.max(tMin, Math.min(((p.x - o.x) * d.x + (p.y - o.y) * d.y) / dd, tMax));
  return { x: o.x + t * d.x, y: o.y + t * d.y };
}

/**
 * Pure function. The NEAREST point to `p` on the SEGMENT a→b (the foot of the
 * perpendicular, clamped to the endpoints) — closestPointOnAxisRange over
 * t ∈ [0, 1]. Shared by distToSegment and by every handle pinned between two
 * geometric limits (a donut's inner radius runs center→rim, a fancy arrow's head
 * length runs tip→tail).
 *
 * @example closestPointOnSegment({x: 0, y: 0}, {x: 10, y: 0}, {x: 4, y: 7}) // {x: 4, y: 0}
 * @example closestPointOnSegment({x: 0, y: 0}, {x: 10, y: 0}, {x: -6, y: 3}) // {x: 0, y: 0} (before the start — clamped)
 * @example closestPointOnSegment({x: 2, y: 2}, {x: 2, y: 2}, {x: 9, y: 9}) // {x: 2, y: 2} (zero-length segment)
 */
export function closestPointOnSegment(a, b, p) {
  return closestPointOnAxisRange(a, { x: b.x - a.x, y: b.y - a.y }, p, 0, 1);
}

/**
 * Pure function. The NEAREST point to `p` in the closed ANNULUS (ring) of center
 * `c` and radii [rMin, rMax]: the RADIUS is clamped and the DIRECTION is kept,
 * which is the metric projection because the set is radially convex. This is the
 * allowed set of a handle free to swing to any angle but held between two
 * lengths — a clock hand's tip is the canonical one.
 *
 *   r* = clamp(|p − c|, r_min, r_max),   proj = c + r*·unit(p − c)
 *
 * A query ALREADY in the ring is returned bit-identically (no radial round-trip
 * is performed at all), so the set's fixed points are exact.
 *
 * A query exactly AT the center has no direction; `fallbackDir` (a UNIT vector)
 * decides, the same explicit-fallback convention polygon.js's closestPointOnChain
 * uses — callers pass the direction their own parameterization's degenerate case
 * already produces rather than inheriting an arbitrary house default.
 *
 * @example closestPointInAnnulus({x: 0, y: 0}, 2, 10, {x: 100, y: 0}, {x: 1, y: 0}) // {x: 10, y: 0} (outside → outer rim)
 * @example closestPointInAnnulus({x: 0, y: 0}, 2, 10, {x: 0.6, y: 0.8}, {x: 1, y: 0}) // {x: 1.2, y: 1.6} (inside the hole → inner rim, same heading)
 * @example closestPointInAnnulus({x: 0, y: 0}, 2, 10, {x: 3, y: 4}, {x: 1, y: 0}) // {x: 3, y: 4} (already in the ring — unchanged)
 * @example closestPointInAnnulus({x: 5, y: 5}, 2, 10, {x: 5, y: 5}, {x: 0, y: 1}) // {x: 5, y: 7} (at the center → fallbackDir at rMin)
 */
export function closestPointInAnnulus(c, rMin, rMax, p, fallbackDir) {
  const dx = p.x - c.x, dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: c.x + rMin * fallbackDir.x, y: c.y + rMin * fallbackDir.y };
  const r = Math.max(rMin, Math.min(d, rMax));
  if (r === d) return { x: p.x, y: p.y };
  return { x: c.x + (r * dx) / d, y: c.y + (r * dy) / d };
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
 * (concave allowed, either winding) into triangles.
 *
 * NOT A PAINT PATH — see the module header. This was written as "the bridge from
 * arbitrary outlines to the IR's CONVEX-only polygon op", and the claim it rested
 * on ("shared edges are watertight because vertices are shared verbatim") is FALSE
 * for an antialiased rasterizer: two abutting antialiased fills conflate along
 * their shared edge to ~192/255 rather than tiling to 255, so every internal
 * diagonal shows as a crack. That was R6-11, measured. An outline reaches pixels as
 * ONE `path` op with a `fillRule`; tests/triangulated_paint_ban_test.js keeps this
 * function out of that route. It remains correct and useful as GEOMETRY — areas,
 * point-in-shape, anything that wants convex pieces rather than ink.
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
 * the reachable single-parameter scrubs, which the plugin's pointInPolygon hit
 * test assumes and which is the only shape a reader recognizes as an arrow:
 *   - widths/lengths are non-negative;
 *   - tipLength ≤ arrow length (a longer head self-intersects at the tail);
 *   - tipDimple ≤ tipLength·(1 − (endWidth/2)/(tipWidth/2)): the shaft joins
 *     the head at the dimple point offset ±endWidth/2, and that junction must
 *     sit within the head's back edges (whose half-width at the dimple's
 *     axis position is (tipWidth/2)·(tipLength−D)/tipLength) or the shaft
 *     pokes through them and the outline self-intersects.
 * Residual multi-parameter corners (e.g. a tail wider than the head with the
 * head spanning the whole arrow) can still self-intersect. That is no longer a
 * failure: the plugin emits ONE `path` op and non-zero winding fills a
 * self-intersecting outline the same way in all three backends. It WAS one while
 * the plugin ear-clipped through triangulated(), which has no such rule and threw
 * — see plugins/fancy_arrow.js's emit for why that report was retired rather than
 * silenced.
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

// Circle tessellation resolution for donutOutline's outer/inner rims. The rims
// are SAMPLED rather than drawn as arcs because no backend-safe arc exists: the
// PDF backend's svgPathToPdfOps rejects `A` outright, so every curve in this
// module is a polyline (see this file's SHAPESHIFTER GEOMETRY header). 64 matches
// the visual smoothness the GPU's OWN circular resize-handle affordances read as
// "round" at typical on-screen widget sizes (no numeric precedent exists
// elsewhere in the codebase for polygon-approximated circles — flagged). PENDING
// USER RATIFICATION.
//
// THIS COMMENT USED TO SAY the ring was a polygon because "neither backend has a
// native ring/even-odd primitive (verified: grep for evenodd/fillRule across
// render_gpu turns up nothing)". That was true when written and FALSE from
// 2026-07-23, when the `path` op landed with `fillRule` in all three backends;
// the claim outlived its evidence and was quoted verbatim by both donut copies as
// the reason to ear-clip. The donut now emits ONE path op (see plugins/donut.js's
// RENDER note for the seam measurements that forced it). Sampling density is the
// only thing this constant still decides.
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
//
// VESTIGIAL FOR THE WIDGET SINCE R6-11, KEPT DELIBERATELY: the donut fills
// through one `path` op now, and a winding rule does not care about exact
// collinearity, so nothing in the render path needs this. tests/outline_test.js
// still ear-clips donutOutline, and removing the jitter would move every donut
// vertex by ~1e-5 units — a real geometry change to buy back nothing. Retiring
// it belongs with retiring the ear-clip test, not with the render fix.
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
 * disjoint circles into ONE simple closed polygon. Duplicating the angle-0 point
 * on each rim (rather than sharing an unduplicated index between the two loops,
 * which would make the bridge's "in" edge span from the LAST forward-loop angle
 * instead of angle 0 — a real chord, not a slit) is the detail that keeps the
 * bridge collinear.
 *
 * WHAT CONSUMES THE ONE-LOOP FORM, AND WHY THE OPPOSITE WINDING IS THE POINT.
 * plugins/donut.js turns this list straight into a `path` op's `d` and fills it
 * with the NON-ZERO rule: the reversed inner rim cancels the outer rim's winding,
 * so the hole is empty, and the zero-area bridge adds nothing to fill either way.
 * MEASURED on a 1-sample surface: no hairline along the bridge and no interior
 * seam at 100/200/400/600 px. The plugin's pointInPolygon hit test reads the SAME
 * list, which is why keeping it one flat loop (rather than splitting it into
 * [outer, inner] subpaths under even-odd, which renders pixel-identically) is
 * worth something: picture and hit region cannot drift apart. triangulated() can
 * also ear-clip this form — that USED to be its only consumer, and see
 * plugins/donut.js's RENDER note for why it stopped being.
 *
 * inner=0 degenerates to a full disk (the slit collapses to a single point at
 * the center — still a valid, if pathological, simple polygon). inner>=1 clamps
 * to <1 (a zero-thickness ring has no fill area and no meaningful modifier-point
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

// ══ SHAPESHIFTER GEOMETRY (data-driven parametric shape FAMILIES) ═════════════
// A family is ONE parametric shape that subsumes many concrete shapes (a Radial
// Sweep IS circle/donut/pie/arc/gauge; a Polygon/Star IS triangle/N-gon/star/
// burst). Each generator below is a PURE param → OUTLINE(s) function: it returns
// an ARRAY OF SUBPATHS (each subpath a closed [x,y] point list), the SAME value
// type donutOutline/fancyArrowOutline produce, so the shapeshifter plugin turns
// them into a `path` IR op via subpathsPathD (core/shapes.js) and hit-tests them
// via pointInOutlines. Two-subpath results (a true ring/frame/hole) render with
// fillRule "evenodd" — the ONE path op supports it across all three backends
// (GPU/SVG/PDF, verified), unlike the polygon op donut had to triangulate for.
// NO `A` arc commands ever reach the backends: every curve is SAMPLED into a
// polyline here (the pdf backend rejects `A`; core/shapes.js:12-17).

// Arc tessellation resolution for a FULL sweep — same rationale/precedent as
// DONUT_SEGMENTS (visual smoothness at typical widget sizes); partial sweeps
// use a proportional fraction so a thin slice isn't over-tessellated.
const ARC_SEGMENTS = 64;
// Samples per rounded corner fillet (roundedVerts). A corner turns at most 180°
// and reads as "round" at widget sizes with far fewer points than a full circle;
// ARC_SEGMENTS/8 = 8, the same "no stronger numeric precedent" caveat as
// DONUT_SEGMENTS/CURVE_SEGMENTS. PENDING USER RATIFICATION.
const CORNER_SEGMENTS = 8;

/**
 * Pure function. `segments+1` points sampled along an ELLIPTICAL arc (center
 * cx,cy, radii rx,ry) from angle a0 to a1 inclusive (radians, y-down screen
 * convention: 0 = +x/3-o'clock, increasing angle turns clockwise on screen).
 * The arc is a POLYLINE (never an `A` command) — the backend-safe way every
 * shapeshifter curve is drawn.
 *
 * Args:
 *   cx, cy (number): ellipse center (local space)
 *   rx, ry (number): ellipse radii
 *   a0, a1 (number): start/end angle in radians (a1 may be < a0 for a reverse walk)
 *   segments (number): number of line segments (rounded, clamped >= 1)
 *
 * Returns:
 *   number[][]: segments+1 points [[x, y], ...] from a0 to a1
 *
 * @example arcPoints({cx: 0, cy: 0, rx: 10, ry: 10, a0: 0, a1: Math.PI / 2, segments: 2}).map(([x, y]) => [Math.round(x), Math.round(y)]) // [[10, 0], [7, 7], [0, 10]]
 * @example arcPoints({cx: 0, cy: 0, rx: 10, ry: 10, a0: 0, a1: Math.PI, segments: 4}).length // 5
 */
export function arcPoints({ cx, cy, rx, ry, a0, a1, segments }) {
  const n = Math.max(1, Math.round(segments));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/**
 * Pure function. THE RADIAL SWEEP family outline — the highest-coverage
 * shapeshifter (circle / ellipse / disc / donut-ring / pie slice / arc band /
 * letter-C / chord / semicircle / gauge / progress-ring), all from ONE
 * generator. Returns 1 or 2 closed subpaths:
 *   - FULL sweep (|a1−a0| ≥ 2π), inner 0  → [disc]                (1 subpath)
 *   - FULL sweep, inner > 0               → [outerRing, innerRing] (2, evenodd hole)
 *   - PARTIAL sweep, inner 0, cap "pie"   → [center + outer arc]   (wedge)
 *   - PARTIAL sweep, inner 0, cap "chord" → [outer arc]            (segment; chord closes it)
 *   - PARTIAL sweep, inner > 0            → [outer arc → inner arc back] (annular sector / gauge)
 * `inner` is the hole radius as a PROPORTION (0..1) of the outer radius, so it
 * scales with the widget (donut's convention). Partial sweeps tessellate
 * proportionally to the swept fraction.
 *
 * Args:
 *   cx, cy (number): center; rx, ry (number): outer radii (bbox-fitted ellipse)
 *   inner (number): hole ratio 0..1 (clamped)
 *   a0, a1 (number): start/end angle in radians (sweep = a1 − a0, signed)
 *   cap ("pie"|"chord"): how an inner-0 partial slice closes (radial vs straight chord)
 *
 * Returns:
 *   number[][][]: 1 or 2 closed subpaths
 *
 * @example ringSectorOutline({cx: 50, cy: 50, rx: 50, ry: 50, inner: 0.5, a0: 0, a1: 2 * Math.PI}).length // 2 (ring: outer + inner)
 * @example ringSectorOutline({cx: 50, cy: 50, rx: 50, ry: 50, inner: 0, a0: 0, a1: 2 * Math.PI}).length // 1 (full disc)
 * @example ringSectorOutline({cx: 50, cy: 50, rx: 50, ry: 50, inner: 0, a0: -Math.PI / 2, a1: 0, cap: "pie"})[0][0] // [50, 50] (pie apex = center)
 * @example ringSectorOutline({cx: 50, cy: 50, rx: 50, ry: 50, inner: 0.5, a0: -Math.PI / 2, a1: Math.PI}).length // 1 (annular gauge band, single subpath)
 */
export function ringSectorOutline({ cx, cy, rx, ry, inner, a0, a1, cap = "pie" }) {
  const hole = Math.max(0, Math.min(inner, 1 - 1e-9));
  const sweep = a1 - a0;
  const full = Math.abs(sweep) >= 2 * Math.PI - 1e-9;
  const seg = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * ARC_SEGMENTS));
  if (full) {
    // Drop the duplicated wrap-around endpoint (the closing Z re-adds it).
    const outer = arcPoints({ cx, cy, rx, ry, a0, a1: a0 + 2 * Math.PI, segments: ARC_SEGMENTS }).slice(0, -1);
    if (hole <= 0) return [outer];
    const innerRing = arcPoints({ cx, cy, rx: rx * hole, ry: ry * hole, a0, a1: a0 + 2 * Math.PI, segments: ARC_SEGMENTS }).slice(0, -1);
    return [outer, innerRing];
  }
  const outer = arcPoints({ cx, cy, rx, ry, a0, a1, segments: seg });
  if (hole <= 0) {
    if (cap === "chord") return [outer];
    return [[[cx, cy], ...outer]]; // pie wedge: apex at center
  }
  const innerArc = arcPoints({ cx, cy, rx: rx * hole, ry: ry * hole, a0: a1, a1: a0, segments: seg });
  return [[...outer, ...innerArc]]; // annular sector: outer forward, inner back, radial caps
}

/**
 * Pure function. A polygon outline with SAMPLED rounded corners: each vertex is
 * cut back by radius `r` along both incident edges and bridged by a quadratic
 * fillet SAMPLED into CORNER_SEGMENTS+1 points (so the result stays a pure point
 * list — the all-polyline shapeshifter convention — unlike roundedPolygonPathD
 * which emits `Q` commands). `r` is clamped to half the shortest edge. r <= 0
 * returns the input unchanged. Generalizes the corner-rounding used across the
 * polygon-based families (polygon/star, cross, quad, corner rect).
 *
 * @example roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], 0) // [[0, 0], [20, 0], [20, 20], [0, 20]] (r<=0 unchanged)
 * @example roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], 5)[0] // [0, 5] (first fillet starts 5 up the left edge)
 * @example roundedVerts([[0, 0], [20, 0], [20, 20], [0, 20]], 5).length // 36 (4 corners x 9 samples)
 */
export function roundedVerts(points, r, seg = CORNER_SEGMENTS) {
  if (!(r > 0) || points.length < 3) return points;
  const n = points.length;
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    minEdge = Math.min(minEdge, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const rr = Math.min(r, minEdge / 2);
  const trimTo = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    return [from[0] + (dx / len) * rr, from[1] + (dy / len) * rr];
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = points[i], prev = points[(i - 1 + n) % n], next = points[(i + 1) % n];
    const entry = trimTo(v, prev), exit = trimTo(v, next);
    for (let k = 0; k <= seg; k++) {
      const p = quadraticBezierPoint({ x: entry[0], y: entry[1] }, { x: v[0], y: v[1] }, { x: exit[0], y: exit[1] }, k / seg);
      out.push([p.x, p.y]);
    }
  }
  return out;
}

/**
 * Pure function. Even-odd containment across MULTIPLE subpaths: a point is
 * inside the shape iff it is inside an ODD number of the closed subpaths — the
 * fillRule:"evenodd" rule, so a point in a ring's hole (inside outer, inside
 * inner) reads as OUTSIDE. THE hit test for every shapeshifter family (1 or 2
 * subpaths).
 *
 * @example pointInOutlines([[[0, 0], [10, 0], [10, 10], [0, 10]]], 5, 5) // true
 * @example pointInOutlines([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [7, 3], [7, 7], [3, 7]]], 5, 5) // false (in the hole)
 * @example pointInOutlines([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [7, 3], [7, 7], [3, 7]]], 1, 5) // true (in the ring band)
 */
export function pointInOutlines(subpaths, px, py) {
  let parity = false;
  for (const sp of subpaths) if (pointInPolygon(sp, px, py)) parity = !parity;
  return parity;
}

/**
 * Pure function. The AABB of a set of subpaths: {minX, minY, maxX, maxY}. Empty
 * input (no points) yields a zero box at the origin.
 *
 * @example subpathsBBox([[[0, 0], [10, 0], [10, 4]]]) // {minX: 0, minY: 0, maxX: 10, maxY: 4}
 */
export function subpathsBBox(subpaths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths) for (const [x, y] of sp) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Pure function. Uniformly scales + centers subpaths to fit inside a w×h box
 * (with `pad` margin), preserving aspect ratio — used by families defined in
 * their own natural coordinates whose extent varies with a parameter (the
 * curved arrow's arc), so the shape stays fully visible and centered in the
 * bbox at every parameter value. Returns {subpaths, scale, ox, oy}: a fitted
 * point maps as (ox + x·scale, oy + y·scale), and the inverse (used by a
 * modifier point's apply) is ((X − ox)/scale, (Y − oy)/scale).
 *
 * @example bboxFitSubpaths([[[0, 0], [100, 0], [100, 10], [0, 10]]], 100, 100).subpaths[0][0] // [0, 45] (thin bar centered vertically, scale 1)
 * @example bboxFitSubpaths([[[0, 0], [10, 0], [10, 10], [0, 10]]], 100, 100).scale // 10
 */
export function bboxFitSubpaths(subpaths, w, h, pad = 0) {
  const { minX, minY, maxX, maxY } = subpathsBBox(subpaths);
  const rw = maxX - minX || 1, rh = maxY - minY || 1;
  const scale = Math.min((w - 2 * pad) / rw, (h - 2 * pad) / rh);
  const ox = (w - rw * scale) / 2 - minX * scale;
  const oy = (h - rh * scale) / 2 - minY * scale;
  return { subpaths: subpaths.map((sp) => sp.map(([x, y]) => [ox + x * scale, oy + y * scale])), scale, ox, oy };
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
 *   elbow (number): 0..1, the mid-segment's position along the endpoint span
 *   orient ("hvh"|"vhv"): leg order — "hvh" (default, the PPT elbow) starts
 *     and ends HORIZONTAL with a vertical middle leg; "vhv" starts and ends
 *     VERTICAL with a horizontal middle leg (the flowchart TREE-BRANCH route:
 *     trunk down, rail across, drop into the target's top anchor)
 *   bulge (number): signed px OFFSET added to the middle leg's position
 *     beyond the span-relative `elbow` placement. THE LOOP ENABLER: two
 *     endpoints with a zero span (mr→mr, ml→ml — a feedback loop between two
 *     stacked boxes) collapse the elbow to a straight line for every t, and
 *     only an absolute offset can push the middle leg OUT of the boxes
 *
 * Returns:
 *   number[][]: 4 points, an OPEN polyline (not a closed outline; pass
 *     directly to render_gpu/ir.js's polyline())
 *
 * @example elbowRoute({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}) // [[0, 0], [50, 0], [50, 50], [100, 50]]
 * @example elbowRoute({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0}) // [[0, 0], [0, 0], [0, 50], [100, 50]] (flush at the start — a valid degenerate L)
 * @example elbowRoute({x0: 0, y0: 20, x1: 100, y1: 20, elbow: 0.5}) // [[0, 20], [50, 20], [50, 20], [100, 20]] (level span: the "vertical" run has zero length — still a straight line)
 * @example elbowRoute({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5, orient: "vhv"}) // [[0, 0], [0, 25], [100, 25], [100, 50]] (tree branch: down, across, down)
 * @example elbowRoute({x0: 200, y0: 0, x1: 200, y1: 100, elbow: 0.5, bulge: 40}) // [[200, 0], [240, 0], [240, 100], [200, 100]] (zero x-span + bulge = a rectangular loop)
 */
export function elbowRoute({ x0, y0, x1, y1, elbow, orient = "hvh", bulge = 0 }) {
  const t = Math.max(0, Math.min(elbow, 1));
  if (orient === "vhv") {
    const my = y0 + (y1 - y0) * t + bulge;
    return [[x0, y0], [x0, my], [x1, my], [x1, y1]];
  }
  const mx = x0 + (x1 - x0) * t + bulge;
  return [[x0, y0], [mx, y0], [mx, y1], [x1, y1]];
}

/**
 * Pure function. The midpoint of an elbow route's MIDDLE segment (the elbow's
 * ONE modifier point sits here — the manifest's "yellow square on the
 * elbow"): the middle leg's own coordinate (from elbowRoute, bulge included)
 * at the leg's midpoint along its length, so the handle sits centered on the
 * segment it controls regardless of how far apart the endpoints are.
 *
 * @example elbowHandle({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}) // {x: 50, y: 25}
 * @example elbowHandle({x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5, orient: "vhv"}) // {x: 50, y: 25}
 * @example elbowHandle({x0: 200, y0: 0, x1: 200, y1: 100, elbow: 0.5, bulge: 40}) // {x: 240, y: 50} (the handle rides the bulged leg)
 */
export function elbowHandle({ x0, y0, x1, y1, elbow, orient = "hvh", bulge = 0 }) {
  const t = Math.max(0, Math.min(elbow, 1));
  if (orient === "vhv") return { x: (x0 + x1) / 2, y: y0 + (y1 - y0) * t + bulge };
  return { x: x0 + (x1 - x0) * t + bulge, y: (y0 + y1) / 2 };
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

// ── SHAPESHIFTER FAMILY OUTLINE BUILDERS ──────────────────────────────────────
// Each is a PURE (w, h, params) → subpaths generator (the value type ringSector/
// donutOutline produce). All-polyline: rounded corners are SAMPLED (roundedVerts)
// so there is ONE representation for BOTH the `path` d (subpathsPathD) and the
// hit test (pointInOutlines) — and never an `A` command. Angle 0 points up
// (−π/2 in screen radians), matching core/shapes.js's polygon/star convention.

const SHAPE_TOP_UP = -Math.PI / 2;
// Widest bend the curved arrow reaches at curvature 1: ~281°. Kept under a full
// turn AND with headroom for the arrowhead's own angular reach, so at max
// curvature the head stays clear of the tail (a clean "circular arrow" with a
// visible gap) instead of overrunning it into a self-touching loop.
const ARROW_MAX_BEND = 2 * Math.PI * 0.78;

/**
 * Pure function. POLYGON / STAR family (triangle → N-gon → star → burst,
 * optionally corner-rounded). `innerRatio` 1 = a regular polygon; < 1 dents the
 * odd vertices inward into a star (small = spiky burst). `points` is the point
 * (or side) count. `startAngle` (radians) rotates vertex 0 off straight-up.
 *
 * @example polygonStarOutline(100, 100, {points: 3, innerRatio: 1})[0].map(([x, y]) => [Math.round(x), Math.round(y)]) // [[50, 0], [93, 75], [7, 75]]
 * @example polygonStarOutline(100, 100, {points: 5, innerRatio: 0.5})[0].length // 10 (5 outer + 5 inner)
 * @example polygonStarOutline(100, 100, {points: 6, innerRatio: 1})[0].length // 6 (hexagon)
 */
export function polygonStarOutline(w, h, { points = 5, innerRatio = 0.5, cornerRadius = 0, startAngle = 0 } = {}) {
  const p = Math.max(2, Math.round(points));
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const inner = Math.max(0, Math.min(1, innerRatio));
  const start = SHAPE_TOP_UP + startAngle;
  const verts = [];
  if (inner >= 1) {
    for (let i = 0; i < p; i++) {
      const a = start + (i * 2 * Math.PI) / p;
      verts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
  } else {
    const step = Math.PI / p;
    for (let i = 0; i < 2 * p; i++) {
      const a = start + i * step;
      const s = i % 2 === 0 ? 1 : inner;
      verts.push([cx + rx * s * Math.cos(a), cy + ry * s * Math.sin(a)]);
    }
  }
  return [roundedVerts(verts, cornerRadius * Math.min(rx, ry))];
}

/**
 * Pure function. CORNER RECTANGLE family (rectangle → rounded-rect → pill →
 * snipped/chamfered card). Per-corner radius ratios r0..r3 (TL, TR, BR, BL) as
 * fractions of min(w,h)/2; `cornerStyle` bends every non-zero corner: "round"
 * (sampled fillet), "snip"/"chamfer" (straight diagonal cut). r = 0 keeps a
 * sharp square corner.
 *
 * @example cornerRectOutline(100, 100, {r0: 0, r1: 0, r2: 0, r3: 0})[0] // [[0, 0], [100, 0], [100, 100], [0, 100]]
 * @example cornerRectOutline(100, 100, {r0: 0.4, r1: 0.4, r2: 0.4, r3: 0.4, cornerStyle: "snip"})[0].length // 8 (each corner cut to 2 points)
 * @example cornerRectOutline(100, 100, {r0: 1, r1: 0, r2: 0, r3: 0, cornerStyle: "snip"})[0].length // 5 (one corner snipped)
 */
export function cornerRectOutline(w, h, { r0 = 0, r1 = 0, r2 = 0, r3 = 0, cornerStyle = "round" } = {}) {
  const box = [[0, 0], [w, 0], [w, h], [0, h]];
  const radii = [r0, r1, r2, r3];
  const maxR = Math.min(w, h) / 2;
  const out = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const v = box[i], prev = box[(i - 1 + n) % n], next = box[(i + 1) % n];
    const rr = Math.max(0, Math.min(radii[i], 1)) * maxR;
    if (rr <= 0) { out.push(v); continue; }
    const trim = (from, to) => {
      const dx = to[0] - from[0], dy = to[1] - from[1];
      const len = Math.hypot(dx, dy) || 1;
      const t = Math.min(rr, len / 2);
      return [from[0] + (dx / len) * t, from[1] + (dy / len) * t];
    };
    const entry = trim(v, prev), exit = trim(v, next);
    if (cornerStyle === "snip" || cornerStyle === "chamfer") { out.push(entry, exit); continue; }
    for (let k = 0; k <= CORNER_SEGMENTS; k++) {
      const pt = quadraticBezierPoint({ x: entry[0], y: entry[1] }, { x: v[0], y: v[1] }, { x: exit[0], y: exit[1] }, k / CORNER_SEGMENTS);
      out.push([pt.x, pt.y]);
    }
  }
  return [out];
}

/**
 * Pure function. QUAD / WEDGE family (rectangle → parallelogram → trapezoid →
 * triangle → rhombus/kite). `taper` is the top edge width as a fraction of the
 * base (1 = rectangle, 0 = triangle apex, >1 = inverted); `shear` slants the top
 * edge sideways by that fraction of w; `topOffset` shifts the top edge's center
 * (right-trapezoid/keystone). `cornerRadius` rounds all four.
 *
 * `shear` LEANS THE QUAD INSIDE ITS BOX: the top edge slides right by shear·w and
 * the base slides left by the same amount, both edges NARROWING to keep every
 * corner within 0..w. Shearing the top edge alone (the earlier reading) slid the
 * silhouette out of the box — at shear 0.25 the top-right corner sat at x = 1.25w
 * while the base still spanned the full width, which is not a parallelogram but a
 * right-leaning trapezoid overflowing its own bounds. A parallelogram is exactly
 * `taper: 1` + a shear, and it is now expressible and bbox-tight: the classic 0.25
 * slant gives [[25, 0], [100, 0], [75, 100], [0, 100]].
 *
 * @example quadWedgeOutline(100, 100, {taper: 1, shear: 0})[0] // [[0, 0], [100, 0], [100, 100], [0, 100]]
 * @example quadWedgeOutline(100, 100, {taper: 1, shear: 0.25})[0] // [[25, 0], [100, 0], [75, 100], [0, 100]]
 * @example quadWedgeOutline(100, 100, {taper: 0, shear: 0})[0].map(([x, y]) => [Math.round(x), Math.round(y)]) // [[50, 0], [50, 0], [100, 100], [0, 100]]
 * @example quadWedgeOutline(100, 100, {taper: 0.4, shear: 0})[0][0].map(Math.round) // [30, 0]
 */
export function quadWedgeOutline(w, h, { taper = 1, shear = 0, topOffset = 0, cornerRadius = 0 } = {}) {
  const lean = shear * w; // the top edge starts `lean` in from the left, the base `lean` in from the right
  // The leaning quad is inscribed in the box, so each edge is `lean` shorter than
  // the box: at shear 0 this is the full width and the plain rectangle/trapezoid
  // geometry is untouched.
  const spanW = w - Math.abs(lean);
  const topW = Math.max(0, taper) * spanW; // floor 0 (a width can't be negative); no upper cap — a wider-than-2× funnel is valid
  const cxTop = Math.abs(lean) / 2 + lean / 2 + spanW / 2 + topOffset * w;
  const cxBase = Math.abs(lean) / 2 - lean / 2 + spanW / 2;
  const tl = cxTop - topW / 2, tr = cxTop + topW / 2;
  const verts = [[tl, 0], [tr, 0], [cxBase + spanW / 2, h], [cxBase - spanW / 2, h]];
  return [roundedVerts(verts, cornerRadius * Math.min(w, h) / 2)];
}

/**
 * Pure function. CROSS / PLUS family (plus → thin/thick cross → medical cross →
 * rounded plus). `armThickness` is each arm's width as a fraction of the box;
 * `armLengthRatio` shortens the VERTICAL arm (1 = a symmetric Greek cross, < 1 =
 * a squat plus). `cornerRadius` rounds the twelve corners.
 *
 * @example crossPlusOutline(90, 90, {armThickness: 1 / 3, armLengthRatio: 1})[0].map(([x, y]) => [Math.round(x), Math.round(y)]) // [[30, 0], [60, 0], [60, 30], [90, 30], [90, 60], [60, 60], [60, 90], [30, 90], [30, 60], [0, 60], [0, 30], [30, 30]]
 * @example crossPlusOutline(90, 90, {armThickness: 1 / 3, armLengthRatio: 1})[0].length // 12
 */
export function crossPlusOutline(w, h, { armThickness = 1 / 3, armLengthRatio = 1, cornerRadius = 0 } = {}) {
  const t = Math.max(0.02, Math.min(armThickness, 1));
  const half = t / 2;
  const x1 = (0.5 - half) * w, x2 = (0.5 + half) * w;
  const y1 = (0.5 - half) * h, y2 = (0.5 + half) * h;
  const lr = Math.max(0, Math.min(armLengthRatio, 1));
  const top = (1 - lr) * (0.5 - half) * h, bot = h - top; // shorten vertical arm inward
  const verts = [
    [x1, top], [x2, top], [x2, y1], [w, y1], [w, y2], [x2, y2],
    [x2, bot], [x1, bot], [x1, y2], [0, y2], [0, y1], [x1, y1],
  ];
  return [roundedVerts(verts, cornerRadius * Math.min(w, h) / 2)];
}

/**
 * Pure function. FRAME / L-SHAPE family (picture frame → half-frame → L-shape →
 * bar). `thickness` is the border width as a fraction of min(w,h). `sides`:
 * "frame" = all four (a hole → 2 subpaths, evenodd); "corner" = an L (left +
 * bottom); "half" = three sides (a U); "bar" = the top edge only.
 *
 * @example frameOutline(100, 100, {thickness: 0.15, sides: "frame"}).length // 2 (outer + inner hole)
 * @example frameOutline(100, 100, {thickness: 0.15, sides: "bar"}).length // 1
 * @example frameOutline(100, 100, {thickness: 0.5, sides: "corner"})[0].length // 6 (L polygon)
 */
export function frameOutline(w, h, { thickness = 0.15, sides = "frame" } = {}) {
  const b = Math.max(0, Math.min(thickness, 0.5)) * Math.min(w, h);
  const outer = [[0, 0], [w, 0], [w, h], [0, h]];
  if (sides === "bar") return [[[0, 0], [w, 0], [w, b], [0, b]]];
  if (sides === "corner") return [[[0, 0], [b, 0], [b, h - b], [w, h - b], [w, h], [0, h]]];
  if (sides === "half") return [[[0, 0], [b, 0], [b, h - b], [w - b, h - b], [w - b, 0], [w, 0], [w, h], [0, h]]];
  // frame: outer box + inner hole (reversed inner walk not required for evenodd)
  const inner = [[b, b], [w - b, b], [w - b, h - b], [b, h - b]];
  return [outer, inner];
}

/**
 * Pure function. GEAR / COG family (gear → sprocket → settings icon →
 * starburst → toothed ring). `teeth` N tooth count; `innerRatio` the root radius
 * (valley between teeth) as a fraction of the outer radius; `toothWidth` the
 * tooth-top angular width as a fraction of the pitch (→ 0 = sharp starburst,
 * → 1 = teeth merge); `holeRatio` a center hole (> 0 → a 2nd evenodd subpath).
 *
 * @example gearOutline(100, 100, {teeth: 8, innerRatio: 0.7, toothWidth: 0.5})[0].length // 32 (4 points per tooth)
 * @example gearOutline(100, 100, {teeth: 6, innerRatio: 0.7, toothWidth: 0.5, holeRatio: 0.3}).length // 2 (gear + center hole)
 * @example gearOutline(100, 100, {teeth: 3, innerRatio: 0.6, toothWidth: 0.5})[0].length // 12
 */
export function gearOutline(w, h, { teeth = 8, innerRatio = 0.7, toothWidth = 0.5, holeRatio = 0 } = {}) {
  const N = Math.max(3, Math.round(teeth));
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const root = Math.max(0.05, Math.min(innerRatio, 0.98));
  const tw = Math.max(0.02, Math.min(toothWidth, 0.98));
  const pitch = (2 * Math.PI) / N;
  const halfTop = (tw * pitch) / 2;
  const at = (rad, a) => [cx + rx * rad * Math.cos(a), cy + ry * rad * Math.sin(a)];
  const verts = [];
  for (let i = 0; i < N; i++) {
    const c = SHAPE_TOP_UP + i * pitch;
    verts.push(at(root, c - pitch / 2 + halfTop)); // valley → rise (left of tooth)
    verts.push(at(1, c - halfTop));                // outer, left top of tooth
    verts.push(at(1, c + halfTop));                // outer, right top of tooth
    verts.push(at(root, c + pitch / 2 - halfTop)); // fall → valley (right of tooth)
  }
  const hole = Math.max(0, Math.min(holeRatio, root - 0.02));
  if (hole > 0) {
    const inner = [];
    for (let i = 0; i < ARC_SEGMENTS; i++) inner.push(at(hole, (i * 2 * Math.PI) / ARC_SEGMENTS));
    return [verts, inner];
  }
  return [verts];
}

/**
 * Pure function. CALLOUT / BUBBLE family (rect/rounded speech bubble → oval-ish
 * → cloud-less pointer). A rounded-rect body with a triangular tail spliced into
 * the BOTTOM edge, pointing to (tailX, tailY) in local space (free-drag: the tip
 * may be anywhere). `tailWidth` is the tail base width as a fraction of w;
 * `cornerRadius` rounds the body corners. The tail's own short edges auto-clamp
 * to a near-sharp point.
 *
 * @example calloutOutline(100, 80, {cornerRadius: 0, tailX: 20, tailY: 100, tailWidth: 0.2})[0].some(([, y]) => y >= 99) // true (tail tip reaches y≈100)
 * @example calloutOutline(100, 80, {cornerRadius: 0, tailX: 20, tailY: 100, tailWidth: 0.2}).length // 1
 */
export function calloutOutline(w, h, { cornerRadius = 0.2, tailX = null, tailY = null, tailWidth = 0.22 } = {}) {
  const bodyH = h * 0.78; // body occupies the top; tail hangs below
  const tipX = tailX == null ? w * 0.25 : tailX;
  const tipY = tailY == null ? h : tailY;
  const baseW = Math.max(2, Math.min(tailWidth, 0.9) * w);
  const baseCx = Math.max(baseW / 2, Math.min(tipX, w - baseW / 2));
  const baseL = baseCx - baseW / 2, baseR = baseCx + baseW / 2;
  // Raw body corners CW from TL, with the tail spliced onto the bottom edge.
  const verts = [
    [0, 0], [w, 0], [w, bodyH], [baseR, bodyH], [tipX, tipY], [baseL, bodyH], [0, bodyH],
  ];
  return [roundedVerts(verts, cornerRadius * Math.min(w, bodyH) / 2)];
}

/**
 * Pure function. BANNER / RIBBON family (flat banner → forked-end ribbon). A
 * horizontal band filling the bbox; `endStyle` "flat" = straight ends, "forked"
 * = a chevron notch cut into each end (depth `notchDepth` as a fraction of w).
 *
 * @example bannerOutline(100, 60, {endStyle: "flat"})[0] // [[0, 0], [100, 0], [100, 60], [0, 60]]
 * @example bannerOutline(100, 60, {endStyle: "forked", notchDepth: 0.15})[0].length // 6
 * @example bannerOutline(100, 60, {endStyle: "forked", notchDepth: 0.15})[0][2].map(Math.round) // [85, 30]
 */
export function bannerOutline(w, h, { endStyle = "forked", notchDepth = 0.15 } = {}) {
  if (endStyle === "flat") return [[[0, 0], [w, 0], [w, h], [0, h]]];
  const nd = notchDepth * w; // unbounded: negative forks the ends outward, past ~0.5 the chevrons cross into a bowtie — both rasterize fine (fill rule)
  return [[[0, 0], [w, 0], [w - nd, h / 2], [w, h], [0, h], [nd, h / 2]]];
}

/**
 * Pure function. BRACKET / BRACE family (square bracket "[" → thick/thin). A
 * filled outline: a full-height SPINE on the left with an ARM reaching right at
 * the top and at the bottom. `orientation` is handled by the widget's rotation,
 * so this always draws a left "[".
 *
 * THREE INDEPENDENT THICKNESSES, because a bracket has three parts that a real
 * one sizes separately (user: "the one part could be skinnier than the other"):
 *   `thickness`   the vertical spine's width, as a fraction of w
 *   `armDepth`    each arm's vertical thickness, as a fraction of h
 *   `armLength`   how far the arms reach right, as a fraction of w
 * Each defaults to tracking `thickness` when absent, so a document written before
 * they existed — where one knob drove the spine and both arms — reads back the
 * shape it always had. That is the whole compatibility contract here: an omitted
 * `armDepth`/`armLength` is not "0", it is "same as the spine".
 *
 * @example bracketOutline(40, 100, {thickness: 0.25})[0] // [[0, 0], [40, 0], [40, 25], [10, 25], [10, 75], [40, 75], [40, 100], [0, 100]]
 * @example bracketOutline(40, 100, {thickness: 0.25})[0].length // 8
 * @example bracketOutline(40, 100, {thickness: 0.1, armDepth: 0.4})[0][2] // [40, 40] (a skinny spine under deep arms)
 * @example bracketOutline(40, 100, {thickness: 0.25, armLength: 0.5})[0][1] // [20, 0] (arms reach only halfway)
 */
export function bracketOutline(w, h, { thickness = 0.2, armDepth = null, armLength = null } = {}) {
  const t = Math.max(0.02, Math.min(thickness, 0.9)) * w;
  // An absent arm knob tracks the spine — the pre-three-knob shape, exactly.
  const ty = Math.max(0.02, Math.min(armDepth ?? thickness, 0.45)) * h;
  const ax = Math.max(t, Math.min(armLength ?? 1, 1) * w); // an arm never retracts behind its own spine
  return [[[0, 0], [ax, 0], [ax, ty], [t, ty], [t, h - ty], [ax, h - ty], [ax, h], [0, h]]];
}

// A cloud's lobes are sampled arcs; this is points-per-lobe, matched to
// CORNER_SEGMENTS' resolution so a bump reads round at poster scale.
const CLOUD_LOBE_SEGMENTS = 14;

/**
 * Pure function. CLOUD family (puffy cloud → thought bubble → foam → a single
 * dome). A ring of `bumps` circular lobes around the bbox ellipse, each lobe a
 * sampled outward arc, with the bottom `flatten`ed toward a straight base.
 *
 * The legacy cloud was FOUR fixed beziers with no knobs at all. Parameterizing it
 * is the whole reason this is a family: `bumps` is what a cloud actually varies
 * (three puffs vs a dozen), `lobeDepth` is how far each puff bulges past the body,
 * and `flatten` slides between a round cartoon cloud and a flat-bottomed one.
 *
 * A LOBE IS SIZED BY ITS SPACING, not by the body radius. Adjacent lobe centres
 * sit `2·sin(π/n)` apart on the body ellipse, so a lobe radius fixed as a fraction
 * of the body would leave visible flat chords between lobes at low counts — a
 * five-bump cloud rendered as a PENTAGON with dimples, which is exactly what the
 * first cut of this generator drew. Scaling the radius by that chord makes each
 * lobe overlap its neighbours at every count, so three bumps and twelve bumps both
 * read as a cloud. `lobeDepth` then means "how far past the body the crest sits",
 * which is what the knob's help text promises.
 *
 * Args:
 *   w, h (number): bbox size in local units
 *   bumps (number): lobe count around the rim (rounded, floored at 3)
 *   lobeDepth (number): each lobe's bulge as a fraction of the lobe spacing
 *   flatten (number): 0 = fully round, 1 = the bottom lobes pulled flat
 *
 * Returns:
 *   number[][][]: ONE closed subpath (a cloud has no hole)
 *
 * @example cloudOutline(100, 100, {bumps: 3}).length // 1
 * @example cloudOutline(100, 100, {bumps: 5})[0].length // 75 (5 lobes x 15 samples: the arc is closed, so both ends are kept)
 * @example cloudOutline(100, 100, {bumps: 3, lobeDepth: 0})[0].every(([x, y]) => x >= -0.01 && x <= 100.01) // true (depth 0 stays on the body ellipse)
 */
export function cloudOutline(w, h, { bumps = 6, lobeDepth = 0.28, flatten = 0.35 } = {}) {
  const n = Math.max(3, Math.round(bumps));
  const depth = Math.max(0, Math.min(lobeDepth, 1));
  const flat = Math.max(0, Math.min(flatten, 1));
  // A LOBE IS SIZED AGAINST ITS NEIGHBOURS, not against the body. Lobe centres end
  // up on a ring of radius (1 − bulge), so their half-spacing is (1 − bulge)·sin(π/n);
  // a lobe of exactly that radius touches its neighbours and a larger one overlaps.
  // Solving r = k·(1 − r)·sin(π/n) for r gives the closed form below, with the
  // overlap factor k > 1 running from "just touching" up to a deep merge. Fixing
  // the radius as a bare fraction of the BODY is the mistake that drew a five-bump
  // cloud as a pentagon with dimples: at low n the gap between centres is large and
  // a body-fraction lobe is nowhere near big enough to close it.
  // `lobeDepth` IS that overlap factor, remapped. The floor is well ABOVE 1 (the
  // "just touching" value) because a cloud reads as a cloud only when each lobe is
  // comparable in size to the body it rings: at a factor near 1 the lobes are small
  // dimples on a big disc and the silhouette is a rounded POLYGON, which is what
  // the first two cuts of this generator drew. At 1.6 the lobe is ~0.8 of the body
  // radius, at 3.2 it is ~1.6 of it — puffy through to billowing.
  const OVERLAP_MIN = 1.6, OVERLAP_MAX = 3.2;
  const overlap = OVERLAP_MIN + (OVERLAP_MAX - OVERLAP_MIN) * depth;
  const s = Math.sin(Math.PI / n);
  const lobeFrac = (overlap * s) / (1 + overlap * s);
  // No separate body inset: lobe centres ride a ring at (1 − bulge) and each lobe's
  // crest reaches exactly 1, so the outermost ink lands on the bbox ellipse by
  // construction and the cloud fills its box without escaping it.
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  // Lobe centres ride a ring pulled IN by the lobe radius, so a lobe's crest —
  // centre plus radius — lands back on the body rim regardless of how big the lobe
  // had to be to span the gap to its neighbours. The radius is CONSTANT around the
  // ring: resizing individual lobes would break the neighbour intersection the arc
  // sweep is solved from, so `flatten` MOVES a lobe instead of shrinking it. Every
  // centre is computed up front because each arc's extent depends on where its two
  // ACTUAL neighbours ended up, flatten displacement included.
  const ringT = 1 - lobeFrac;
  const centres = [];
  for (let i = 0; i < n; i++) {
    const a = SHAPE_TOP_UP + (i * 2 * Math.PI) / n;
    // A lobe centred low is pulled UP toward the base line by `flatten` (sin > 0 is
    // the bottom half in y-down space), flattening the underside. The pull is a
    // fraction of the lobe radius: displacing a centre by more than this opens the
    // seam wider than the symmetric sweep below covers, and the gap renders as a
    // spike where two arcs fail to meet.
    const FLATTEN_PULL = 0.5;
    const lowness = Math.max(0, Math.sin(a));
    centres.push({
      a,
      x: cx + rx * ringT * Math.cos(a),
      y: cy + ry * ringT * Math.sin(a) - ry * lobeFrac * flat * lowness * FLATTEN_PULL,
    });
  }
  // ONLY THE OUTWARD ARC of each lobe is drawn, centred on its own outward normal:
  // from where the PREVIOUS lobe's circle cuts this one, to where the NEXT one does.
  // Neighbouring lobes of radius r whose centres are d apart cross at ±acos(d / 2r)
  // off the line joining them, and on the undisplaced ring that line IS the tangent
  // direction, so the crossing is symmetric about the outward normal and ONE
  // half-sweep describes both ends. Sweeping further makes each lobe loop back
  // through its neighbours and the outline renders as a scribble of overlapping
  // circles; sweeping less leaves the chord between centres visible as a facet.
  //
  // The half-sweep is measured on the UNDISPLACED ring even when `flatten` has
  // moved the centres. Flatten slides a lobe along the body, which changes where
  // two neighbours cross by a hair; solving per-side for that hair needs the two
  // crossings ordered around the circle, and getting that ordering wrong turns the
  // arc inside out (it renders as loose overlapping discs). The symmetric sweep is
  // exact at flatten 0 and visually indistinguishable at flatten 1, so it is the
  // one that ships.
  // The sweep stops a little SHORT of the computed crossing. Past the crossing an
  // arc has re-entered its neighbour's disc, so its tail runs back INSIDE the
  // silhouette and the outline doubles back on itself — which the stroke draws as a
  // spike at every seam (plainly visible at 8+ bumps, and worse the further the
  // sweep overshoots). Stopping just before the crossing keeps every sampled point
  // on the true outer boundary; the tiny facet left between two arcs is far below
  // one pixel at any usable size.
  const SEAM_TRIM = 0.8; // tuned by eye on the contact sheet at 3…12 bumps
  const centreGap = 2 * ringT * s;
  const halfSweep = SEAM_TRIM * Math.acos(Math.max(-1, Math.min(1, centreGap / (2 * lobeFrac))));
  const out = [];
  for (const c of centres) {
    for (let k = 0; k <= CLOUD_LOBE_SEGMENTS; k++) {
      const a = c.a - halfSweep + (k * 2 * halfSweep) / CLOUD_LOBE_SEGMENTS;
      out.push([c.x + rx * lobeFrac * Math.cos(a), c.y + ry * lobeFrac * Math.sin(a)]);
    }
  }
  return [out];
}

/**
 * Pure function. HEART family (classic heart → wide/narrow → deep or shallow
 * cleft). Two lobe arcs meeting at a top cleft, falling to a single bottom tip.
 *
 * `cleft` is the ONE knob worth a handle: it sets how deep the notch between the
 * lobes cuts, which is the difference between a valentine and a spade. `lobeWidth`
 * spreads the lobes apart and `tipSharpness` pulls the bottom point to a spike.
 *
 * Args:
 *   w, h (number): bbox size in local units
 *   cleft (number): notch depth as a fraction of the height (0 = a domed top)
 *   lobeWidth (number): lobe half-width as a fraction of w
 *   tipSharpness (number): 0 = a round bottom, 1 = a drawn-out spike
 *
 * Returns:
 *   number[][][]: ONE closed subpath
 *
 * @example heartOutline(100, 100).length // 1
 * @example heartOutline(100, 100)[0][0].map(Math.round) // [50, 36] (the path opens where the right lobe meets the cleft)
 * @example heartOutline(100, 100, {cleft: 0.4})[0][0].map(Math.round) // [50, 51] (a deeper notch opens lower)
 */
export function heartOutline(w, h, { cleft = 0.25, lobeWidth = 0.5, tipSharpness = 0.5 } = {}) {
  const notch = Math.max(0, Math.min(cleft, 0.9)) * h;
  const lw = Math.max(0.05, Math.min(lobeWidth, 1));
  const sharp = Math.max(0, Math.min(tipSharpness, 1));
  const cx = w / 2, tipY = h;
  // BUILT DIRECTLY IN BBOX COORDINATES, deliberately NOT bbox-refitted. A refit
  // rescales whatever was drawn to fill the box, which cancels exactly the
  // parameter it is supposed to express: a narrow-lobed heart and a wide-lobed one
  // both got stretched back to full width, so `lobeWidth` had almost no visible
  // effect and the "Spade" preset came out WIDER than the plain Valentine. The
  // lobes span the full width here and the shape spans the full height by
  // construction, so there is nothing left for a refit to correct.
  // Two lobes side by side span 4 radii at lobeWidth 1, and the flank bulges a
  // little past the shoulder, so the radius is sized off the WIDEST point the
  // outline will reach rather than off the lobe alone — that is what keeps the ink
  // inside 0..w at every lobeWidth.
  const FLANK_BULGE = 1.15;             // flank control x, as a multiple of the shoulder offset
  const lobeR = (lw * w) / (2 * FLANK_BULGE * 2);
  const shoulderX = cx + 2 * lobeR;     // the widest point the flank reaches
  const lobeY = notch + lobeR;          // lobe centres sit one radius below the cleft
  const arcSteps = CURVE_SEGMENTS / 2;
  // Walk the RIGHT side down, then the LEFT side back up, so the ring is one
  // continuous closed loop: cleft → over the right lobe → down the right flank →
  // tip → up the left flank → over the left lobe → back to the cleft.
  const lobeArc = (side) => {
    // A lobe sweeps from the cleft, over the top, to its outward shoulder — a half
    // turn, so the flank leaves the lobe already heading downward.
    const pts = [];
    for (let k = 0; k <= arcSteps; k++) {
      const a = SHAPE_TOP_UP - side * Math.PI / 2 + side * (Math.PI * k) / arcSteps;
      pts.push([cx + side * lobeR + lobeR * Math.cos(a), lobeY + lobeR * Math.sin(a)]);
    }
    return pts;
  };
  // The flank's control point sits OUTSIDE the shoulder so the silhouette stays
  // full-width below the lobes; `tipSharpness` slides it DOWN, which holds that
  // width for longer and reads as a drawn-out point rather than a round bottom.
  const flankTo = (from, side) => {
    const ctrl = { x: cx + side * (shoulderX - cx) * 1.15, y: lobeY + (tipY - lobeY) * (0.1 + 0.6 * sharp) };
    const pts = [];
    for (let k = 1; k <= arcSteps; k++) {
      const p = quadraticBezierPoint({ x: from[0], y: from[1] }, ctrl, { x: cx, y: tipY }, k / arcSteps);
      pts.push([p.x, p.y]);
    }
    return pts;
  };
  const right = lobeArc(1);
  const left = lobeArc(-1);
  return [[
    ...right,
    ...flankTo(right[right.length - 1], 1),
    ...flankTo(left[left.length - 1], -1).reverse().slice(1),
    ...left.slice().reverse(),
  ]];
}

/**
 * Pure function. ARROW family (straight ↔ curved ↔ near-circular, single or
 * double head, flat ↔ chevron tail). Built in a canonical (along ℓ, perp q)
 * profile, bent onto a circular-arc centerline by `curvature` (0 = straight,
 * 1 ≈ a 331° loop → circular arrow), then UNIFORMLY fitted to the bbox so the
 * whole arrow stays visible at any curvature. `headRatio` head length / total;
 * `headWidth` head half-width; `shaftRatio` shaft thickness / head width;
 * `tailNotch` chevron cut at the tail; `doubleHead` a second head at the tail.
 *
 * @example arrowOutline(100, 100, {curvature: 0, headRatio: 0.4, headWidth: 0.6, shaftRatio: 0.4}).length // 1
 * @example arrowOutline(100, 100, {curvature: 0, doubleHead: false})[0].length // 7 (single-head block arrow)
 * @example arrowOutline(100, 100, {curvature: 0, doubleHead: true})[0].length // 10 (double-head)
 * @example arrowOutline(100, 100, {curvature: 0.5})[0].length > 7 // true (bent = sampled centerline)
 */
export function arrowOutline(w, h, { headRatio = 0.4, headWidth = 0.6, shaftRatio = 0.4, tailNotch = 0, curvature = 0, doubleHead = false } = {}) {
  const L = 100;
  const Hh = Math.max(0.02, Math.min(headWidth, 1)) * L * 0.5;   // head half-width
  const sh = Math.max(0.02, Math.min(shaftRatio, 1)) * Hh;        // shaft half-thickness
  const headLen = Math.max(0.02, Math.min(headRatio, 0.95)) * L;
  const headBase = L - headLen;
  // Canonical profile as (ℓ, q) pairs, CCW.
  let profile;
  if (doubleHead) {
    profile = [
      [0, 0], [headLen, -Hh], [headLen, -sh], [headBase, -sh], [headBase, -Hh],
      [L, 0], [headBase, Hh], [headBase, sh], [headLen, sh], [headLen, Hh],
    ];
  } else {
    const tn = Math.max(0, Math.min(tailNotch, 0.9)) * headLen;
    profile = [
      [0, -sh], [headBase, -sh], [headBase, -Hh], [L, 0], [headBase, Hh], [headBase, sh], [0, sh],
    ];
    if (tn > 0) profile.push([tn, 0]); // chevron tail notch (between tail bottom and top)
  }
  // floor 0 (a negative bend would silently hit the straight-arrow guard below); no upper cap — curvature > 1 winds tighter into overlapping loops
  const bend = Math.max(0, curvature) * ARROW_MAX_BEND;
  if (bend < 1e-4) return bboxFitSubpaths([profile], w, h, Math.min(w, h) * 0.06).subpaths;
  // Bent: densify each edge along ℓ so the shaft follows the arc smoothly (a
  // raw 7-point profile would bend into straight facets, not a curve).
  const R = L / bend;
  const map = (l, q) => {
    const ang = SHAPE_TOP_UP + l / R;
    return [(R + q) * Math.cos(ang), (R + q) * Math.sin(ang)];
  };
  const step = L / ARC_SEGMENTS;
  const raw = [];
  for (let i = 0; i < profile.length; i++) {
    const [l0, q0] = profile[i], [l1, q1] = profile[(i + 1) % profile.length];
    const n = Math.max(1, Math.ceil(Math.abs(l1 - l0) / step));
    for (let k = 0; k < n; k++) raw.push(map(l0 + ((l1 - l0) * k) / n, q0 + ((q1 - q0) * k) / n));
  }
  return bboxFitSubpaths([raw], w, h, Math.min(w, h) * 0.06).subpaths;
}

// ══ HARDWARE FAMILIES (bolt / screw / screw-head) ═════════════════════════════
// Metal fasteners as parametric vector silhouettes (manifest #56). Threads are a
// TRIANGLE-WAVE flank: the crest sits at the shank edge, the root cuts `depth`
// inward, and the LEFT flank is offset half a pitch from the RIGHT (a `phase`
// swap) so the crests on one side line up with the roots on the other — the same
// diagonal banding a real helical thread reads as in a side profile. Everything
// is a plain polyline (roundedVerts / sampled arcs only), so it round-trips
// through all three backends like every other shapeshifter outline.

/**
 * Pure function. One threaded FLANK: `2·threads + 1` points marching from `topY`
 * to `botY`, alternating between the crest x (`crestX`) and the root x (`rootX`)
 * — a triangle wave. `phase` (0 or 1) chooses whether the FIRST point is a crest
 * (0) or a root (1); the two flanks of a shank pass opposite phases so the thread
 * reads as a helix. `threads <= 0` returns a straight two-point edge (a smooth,
 * unthreaded shank — a legal degenerate, not an error).
 *
 * Args:
 *   topY, botY (number): the flank's vertical span (screen y-down)
 *   crestX, rootX (number): outer (crest) and inner (root) x of the thread
 *   threads (number): tooth count (rounded; <= 0 ⇒ smooth)
 *   phase (0|1): half-pitch offset selector
 *
 * Returns:
 *   number[][]: points top→bottom
 *
 * @example threadFlankPts(0, 40, 10, 6, 2, 0) // [[10, 0], [6, 10], [10, 20], [6, 30], [10, 40]]
 * @example threadFlankPts(0, 40, 10, 6, 2, 1) // [[6, 0], [10, 10], [6, 20], [10, 30], [6, 40]]
 * @example threadFlankPts(0, 40, 10, 6, 0, 0) // [[10, 0], [10, 40]] (no threads — smooth edge)
 */
export function threadFlankPts(topY, botY, crestX, rootX, threads, phase) {
  const n = Math.max(0, Math.round(threads));
  if (n <= 0) return [[crestX, topY], [crestX, botY]];
  const steps = 2 * n;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const y = topY + ((botY - topY) * i) / steps;
    const onCrest = (i + phase) % 2 === 0;
    pts.push([onCrest ? crestX : rootX, y]);
  }
  return pts;
}

/**
 * Pure function. HARDWARE: a hex-head BOLT seen from the side (manifest #56) —
 * chamfered hex head at the top, an optional washer, then a straight threaded
 * shank with a flat end. All fractions are of the bbox; the bolt points DOWN
 * (head at y=0) and is symmetric about x=w/2. `chamfer` bevels the head's four
 * corners (the hex bevel read side-on); `threads`/`threadDepth` drive the flank
 * zigzag; `washer` inserts a wider collar between head and shank.
 *
 * @example boltOutline(100, 200, {threads: 0, washer: false})[0].length // 15 (head bevel box + smooth shank)
 * @example boltOutline(100, 200, {threads: 6})[0].some(([, y]) => y === 200) // true (shank reaches the flat bottom)
 * @example boltOutline(100, 200, {washer: true})[0].length > boltOutline(100, 200, {washer: false})[0].length // true (washer adds vertices)
 */
export function boltOutline(w, h, { headWidth = 0.74, headHeight = 0.2, shankWidth = 0.42, threads = 8, threadDepth = 0.14, washer = false, washerWidth = 0.6, washerHeight = 0.05, chamfer = 0.24 } = {}) {
  const cx = w / 2;
  const headHalf = Math.max(0.02, Math.min(headWidth, 1)) * w / 2;
  const shankHalf = Math.max(0.02, Math.min(shankWidth, 1)) * w / 2;
  const washerHalf = Math.max(shankHalf, Math.min(washerWidth, 1) * w / 2);
  const headBot = Math.max(0.02, Math.min(headHeight, 0.8)) * h;
  const cham = Math.max(0, Math.min(chamfer, 0.9)) * Math.min(headHalf, headBot / 2);
  const washerBot = washer ? headBot + Math.max(0, washerHeight) * h : headBot;
  const shankTop = washerBot;
  const depth = Math.max(0, Math.min(threadDepth, 0.95)) * shankHalf;
  const poly = [];
  // Head: top bevel, right side, bottom bevel.
  poly.push([cx - headHalf + cham, 0], [cx + headHalf - cham, 0], [cx + headHalf, cham], [cx + headHalf, headBot - cham], [cx + headHalf - cham, headBot]);
  if (washer) poly.push([cx + washerHalf, headBot], [cx + washerHalf, washerBot]);
  poly.push([cx + shankHalf, shankTop]);
  for (const p of threadFlankPts(shankTop, h, cx + shankHalf, cx + shankHalf - depth, threads, 0)) poly.push(p);
  poly.push([cx - shankHalf, h]); // flat bottom
  for (const p of threadFlankPts(shankTop, h, cx - shankHalf, cx - shankHalf + depth, threads, 1).reverse()) poly.push(p);
  poly.push([cx - shankHalf, shankTop]);
  if (washer) poly.push([cx - washerHalf, washerBot], [cx - washerHalf, headBot]);
  poly.push([cx - headHalf + cham, headBot], [cx - headHalf, headBot - cham], [cx - headHalf, cham]);
  return [poly];
}

/**
 * Pure function. `headStyle` → the screw head's cap silhouette, a point list from
 * the body's LEFT top corner, UP and over the top, to the body's RIGHT top corner
 * (so it splices onto a downward-built body). "flat" = a countersunk cone (wide
 * flat top), "pan" = a low dome with a flattish top, "round" = a full elliptical
 * dome. Local coords, y-down, symmetric about `cx`.
 *
 * @example screwHeadCap("flat", 50, 35, 17, 30) // [[33, 30], [15, 0], [85, 0], [67, 30]]
 * @example screwHeadCap("round", 50, 35, 17, 30).length // 35 (sampled dome arc)
 * @example screwHeadCap("pan", 50, 35, 17, 30)[0] // [33, 30] (starts at body-left top)
 */
export function screwHeadCap(headStyle, cx, headHalf, shankHalf, bodyTop) {
  const L = [cx - shankHalf, bodyTop], R = [cx + shankHalf, bodyTop];
  if (headStyle === "flat") return [L, [cx - headHalf, 0], [cx + headHalf, 0], R];
  if (headStyle === "round") {
    const dome = [];
    for (let i = 0; i <= ARC_SEGMENTS / 4 * 2; i++) {
      const a = Math.PI - (Math.PI * i) / (ARC_SEGMENTS / 2); // π (left) → 0 (right)
      dome.push([cx + headHalf * Math.cos(a), bodyTop - bodyTop * Math.sin(a)]);
    }
    return [L, ...dome, R];
  }
  // pan: shallow rounded-top box, wider than the shank.
  const topY = bodyTop * 0.35;
  const box = [[cx - headHalf, bodyTop], [cx - headHalf, topY], [cx - headHalf * 0.72, 0], [cx + headHalf * 0.72, 0], [cx + headHalf, topY], [cx + headHalf, bodyTop]];
  return [L, ...box, R];
}

/**
 * Pure function. HARDWARE: a side-view wood/machine SCREW (manifest #56) — a
 * selectable head (flat / pan / round via `headStyle`), a threaded body that
 * TAPERS to a sharp point at the bottom, and a gimlet tip. `taper` is the
 * fraction of the body length over which it narrows to the point (large = a long
 * cone, small = a mostly-straight body with a short point). Threads shrink with
 * the taper so they vanish cleanly into the tip. Symmetric about x=w/2, points
 * DOWN.
 *
 * @example screwOutline(100, 220, {threads: 9})[0].some(([x, y]) => Math.abs(x - 50) < 1e-9 && y === 220) // true (sharp tip at bottom center)
 * @example screwOutline(100, 220, {headStyle: "flat"}).length // 1
 * @example screwOutline(100, 220, {headStyle: "round"})[0].length > 20 // true (domed head samples)
 */
export function screwOutline(w, h, { headStyle = "flat", headWidth = 0.72, headHeight = 0.16, shankWidth = 0.36, threads = 10, threadDepth = 0.18, taper = 0.5 } = {}) {
  const cx = w / 2;
  const headHalf = Math.max(0.02, Math.min(headWidth, 1)) * w / 2;
  const shankHalf = Math.max(0.02, Math.min(shankWidth, 1)) * w / 2;
  const bodyTop = Math.max(0.02, Math.min(headHeight, 0.6)) * h;
  const depth = Math.max(0, Math.min(threadDepth, 0.95)) * shankHalf;
  const nT = Math.max(0, Math.round(threads));
  const pointFrac = Math.max(0.05, Math.min(taper, 1));
  const narrowStart = 1 - pointFrac;
  const hwAt = (t) => (t <= narrowStart ? shankHalf : shankHalf * (1 - (t - narrowStart) / (1 - narrowStart)));
  const steps = Math.max(2, 2 * nT);
  const flank = (sign, phase) => {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const hw = hwAt(t);
      const onCrest = (i + phase) % 2 === 0;
      const off = onCrest ? hw : Math.max(0, hw - depth);
      out.push([cx + sign * off, bodyTop + (h - bodyTop) * t]);
    }
    return out;
  };
  const right = flank(1, 0);              // body top → tip
  const left = flank(-1, 1).reverse();    // tip → body top
  const cap = screwHeadCap(headStyle, cx, headHalf, shankHalf, bodyTop);
  return [[...right, ...left, ...cap]];
}

/**
 * Pure function. `drive` → the screw-head DRIVE RECESS as ONE closed inner
 * contour (the hole that reads under fillRule "evenodd"), centered at (cx,cy),
 * sized to radius `rad` (already the recess radius in local units). "slot" = a
 * single bar, "phillips" = a plus/cross, "hex" = a hexagon socket, "torx" = a
 * six-lobe rounded star. `barW` is the slot/cross bar half-width in local units.
 *
 * @example driveRecess("hex", 50, 50, 20).length // 6 (hexagon socket)
 * @example driveRecess("slot", 50, 50, 20, 6) // [[30, 44], [70, 44], [70, 56], [30, 56]]
 * @example driveRecess("phillips", 50, 50, 20, 6).length // 12 (plus-shaped cross)
 */
export function driveRecess(drive, cx, cy, rad, barW = 6) {
  if (drive === "slot") return [[cx - rad, cy - barW], [cx + rad, cy - barW], [cx + rad, cy + barW], [cx - rad, cy + barW]];
  if (drive === "phillips") {
    const a = rad, b = barW;
    return [
      [cx - b, cy - a], [cx + b, cy - a], [cx + b, cy - b], [cx + a, cy - b], [cx + a, cy + b], [cx + b, cy + b],
      [cx + b, cy + a], [cx - b, cy + a], [cx - b, cy + b], [cx - a, cy + b], [cx - a, cy - b], [cx - b, cy - b],
    ];
  }
  if (drive === "torx") {
    const lobes = 6, inner = 0.62;
    const verts = [];
    for (let i = 0; i < 2 * lobes; i++) {
      const ang = SHAPE_TOP_UP + (i * Math.PI) / lobes;
      const r = i % 2 === 0 ? rad : rad * inner;
      verts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    }
    return roundedVerts(verts, rad * 0.16);
  }
  // hex socket (default): a regular hexagon, flat-top up.
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const ang = SHAPE_TOP_UP + (i * 2 * Math.PI) / 6 + Math.PI / 6;
    verts.push([cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]);
  }
  return verts;
}

/**
 * Pure function. HARDWARE: a top-down SCREW HEAD (manifest #56) — the head disc
 * with the drive recess punched through it as an even-odd hole. Returns
 * [outerCircle, recess] (2 subpaths, fillRule "evenodd"). `drive` picks the
 * recess (slot / phillips / hex / torx); `driveSize` is its radius as a fraction
 * of the head radius; `barWidth` is the slot/cross bar width as a fraction of the
 * head radius.
 *
 * @example screwHeadOutline(100, 100, {drive: "hex"}).length // 2 (disc + hole)
 * @example screwHeadOutline(100, 100, {drive: "slot"})[0].length // 64 (sampled head circle)
 * @example screwHeadOutline(100, 100, {drive: "phillips"})[1].length // 12 (plus recess)
 */
export function screwHeadOutline(w, h, { drive = "phillips", driveSize = 0.55, barWidth = 0.16 } = {}) {
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const outer = [];
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const a = (i * 2 * Math.PI) / ARC_SEGMENTS;
    outer.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  const R = Math.max(0.05, Math.min(driveSize, 0.95)) * Math.min(rx, ry);
  const barW = Math.max(0.02, Math.min(barWidth, 0.9)) * Math.min(rx, ry);
  return [outer, driveRecess(drive, cx, cy, R, barW)];
}

// ══ VICTORIAN SCROLL-WORK FAMILIES (scroll / scroll-pair / iron finial) ═══════
// Wrought-iron ornament as parametric vector RIBBONS (manifest #57). The unit of
// construction is a CENTERLINE (a polyline) turned into a closed filled ribbon of
// given half-width by offsetting ±normal (ribbonOutline). A logarithmic spiral
// centerline gives the volute/scroll that reads as a fence-post curl. Multi-part
// pieces (a finial + its volutes) return several subpaths under fillRule
// "nonzero" so consistently-wound overlapping ribbons UNION into one iron shape
// (evenodd would punch holes where they cross).

const SPIRAL_SEGMENTS_PER_TURN = 48;

/**
 * Pure function. Centerline of a LOGARITHMIC spiral r(θ) = r0·growth^(θ/2π),
 * sampled `samples+1` points from angle a0 to a1 (radians). growth is the radius
 * multiplier PER FULL TURN (> 1 spirals outward); it is clamped just above 1 (a
 * growth of exactly 1 is a circle, below 1 an inward spiral — the caller always
 * passes the outward sense and controls direction by ordering the walk). This is
 * the volute skeleton every scroll ribbon rides.
 *
 * @example logSpiralPoints({cx: 0, cy: 0, r0: 1, growth: 2, a0: 0, a1: 0, samples: 1}) // [[1, 0], [1, 0]]
 * @example logSpiralPoints({cx: 0, cy: 0, r0: 1, growth: 2, a0: 0, a1: 2 * Math.PI, samples: 1})[1].map((v) => Math.round(v)) // [2, 0] (one full turn ⇒ radius doubled)
 * @example logSpiralPoints({cx: 0, cy: 0, r0: 1, growth: 2, a0: 0, a1: Math.PI, samples: 4}).length // 5
 */
export function logSpiralPoints({ cx, cy, r0, growth, a0, a1, samples }) {
  const k = Math.log(Math.max(1.0001, growth)) / (2 * Math.PI);
  const n = Math.max(1, Math.round(samples));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const r = r0 * Math.exp(k * a);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Pure function. Turn an open CENTERLINE polyline into a CLOSED filled ribbon of
 * the given half-width(s): offset each point ±(unit normal)·halfWidth (normal
 * from the central-difference tangent), walk the right edge forward then the left
 * edge back. `halfWidths` may be a single number (uniform) or a per-point array
 * (a tapering ribbon). This is the bridge from every scroll/volute skeleton to a
 * fillable outline — all-polyline, backend-safe.
 *
 * @example ribbonOutline([[0, 0], [10, 0], [20, 0]], 2) // [[0, 2], [10, 2], [20, 2], [20, -2], [10, -2], [0, -2]]
 * @example ribbonOutline([[0, 0], [10, 0]], 3).length // 4 (2 points ⇒ 4-vertex quad)
 * @example ribbonOutline([[0, 0], [0, 10], [0, 20]], [1, 2, 3])[0] // [-1, 0] (per-point width at the start)
 */
export function ribbonOutline(centerline, halfWidths) {
  const n = centerline.length;
  const hwAt = (i) => (Array.isArray(halfWidths) ? halfWidths[i] : halfWidths);
  const right = [], left = [];
  for (let i = 0; i < n; i++) {
    const p = centerline[i];
    const a = centerline[Math.max(0, i - 1)], b = centerline[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const nx = -ty, ny = tx;
    const hw = hwAt(i);
    right.push([p[0] + nx * hw, p[1] + ny * hw]);
    left.push([p[0] - nx * hw, p[1] - ny * hw]);
  }
  return [...right, ...left.reverse()];
}

/** Pure function. Rotate points by `ang` (rad) about (ox,oy).
 *  @example rotatePts([[1, 0]], Math.PI / 2).map(([x, y]) => [Math.round(x), Math.round(y)]) // [[0, 1]] */
function rotatePts(pts, ang, ox = 0, oy = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y]) => { const dx = x - ox, dy = y - oy; return [ox + dx * c - dy * s, oy + dx * s + dy * c]; });
}
/** Pure function. Reflect points across the horizontal line y = axisY.
 *  @example reflectPtsY([[3, 1]], 5) // [[3, 9]] */
function reflectPtsY(pts, axisY) { return pts.map(([x, y]) => [x, 2 * axisY - y]); }
/** Pure function. Angle (rad) of a polyline's final segment.
 *  @example endTangentAngle([[0, 0], [1, 1]]) // 0.7853981633974483 */
function endTangentAngle(pts) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/**
 * Pure function. A tapering half-width array for a scroll ribbon: width goes from
 * `hwMax·(1−taper)` at the EYE (t=0) to `hwMax` at the OUTER end (t=1). taper=0 is
 * a uniform ribbon; taper=1 tapers the eye to a point (the classic volute that
 * curls to nothing).
 *
 * @example scrollHalfWidths(3, 10, 0) // [10, 10, 10]
 * @example scrollHalfWidths(3, 10, 1) // [0, 5, 10]
 */
export function scrollHalfWidths(n, hwMax, taper) {
  const tp = Math.max(0, Math.min(taper, 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 1 : i / (n - 1);
    out.push(hwMax * ((1 - tp) + tp * t));
  }
  return out;
}

/**
 * Pure function. A single scroll centerline (eye at the origin → outer end),
 * already oriented so the OUTER END TANGENT points along +x (so pieces can be
 * chained by a horizontal stem). Returns {center, hws, outerR}: the point list,
 * the tapering half-widths (relative to outerR·ribbonWidth), and the outer radius.
 * Shared by ss_scroll, ss_scrollPair and ss_ironFinial's volutes.
 */
function scrollSkeleton({ turns, growth, ribbonWidth, taper }) {
  const T = Math.max(0.1, turns);
  const g = Math.max(1.05, growth);
  const a1 = T * 2 * Math.PI;
  const samples = Math.max(8, Math.round(SPIRAL_SEGMENTS_PER_TURN * T));
  let center = logSpiralPoints({ cx: 0, cy: 0, r0: 1, growth: g, a0: 0, a1, samples });
  center = rotatePts(center, -endTangentAngle(center)); // outer-end tangent → +x
  const outerR = Math.exp((Math.log(g) / (2 * Math.PI)) * a1);
  const hwMax = Math.max(0.01, ribbonWidth) * outerR;
  const hws = scrollHalfWidths(center.length, hwMax, taper);
  return { center, hws, outerR };
}

/**
 * Pure function. VICTORIAN: a single SCROLL / volute (manifest #57) — a
 * logarithmic-spiral ribbon curling into a tight eye, the wrought-iron building
 * block. `turns` how many revolutions; `growth` the radius multiplier per turn
 * (loose vs tight coil); `ribbonWidth` the iron bar width; `taper` narrows the
 * eye to a point. Uniformly fitted to the bbox so the whole curl stays visible.
 *
 * @example scrollOutline(200, 200, {turns: 2}).length // 1
 * @example scrollOutline(200, 200, {turns: 2})[0].length % 2 // 0 (ribbon = right edge + left edge)
 * @example scrollOutline(200, 200, {turns: 2})[0].every(([x, y]) => x >= 0 && x <= 200 && y >= 0 && y <= 200) // true (fitted in-bounds)
 */
export function scrollOutline(w, h, { turns = 2.25, growth = 2, ribbonWidth = 0.16, taper = 0.6 } = {}) {
  const { center, hws } = scrollSkeleton({ turns, growth, ribbonWidth, taper });
  const ribbon = ribbonOutline(center, hws);
  return bboxFitSubpaths([ribbon], w, h, Math.min(w, h) * 0.06).subpaths;
}

/**
 * Pure function. VICTORIAN: the classic S / C SCROLL PAIR (manifest #57) — two
 * mirrored volutes joined by a stem, as ONE continuous ribbon (eye → out → stem →
 * out → eye). `symmetry` "S" gives 180°-rotational symmetry (an S), "C" gives
 * mirror symmetry across the stem (a C); `stemLength` the bar between the coils
 * (fraction of a scroll's outer radius); `turns`/`growth`/`ribbonWidth`/`taper`
 * shape each coil. Uniformly fitted to the bbox.
 *
 * @example scrollPairOutline(300, 200, {symmetry: "S"}).length // 1 (one continuous ribbon)
 * @example scrollPairOutline(300, 200, {symmetry: "C"}).length // 1
 * @example scrollPairOutline(300, 200, {})[0].every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) // true
 */
export function scrollPairOutline(w, h, { symmetry = "S", stemLength = 1.4, turns = 1.5, growth = 2.1, ribbonWidth = 0.13, taper = 0.55 } = {}) {
  const { center, hws, outerR } = scrollSkeleton({ turns, growth, ribbonWidth, taper });
  const pEnd = center[center.length - 1];
  const stem = Math.max(0, stemLength) * outerR;
  const pStem = [pEnd[0] + stem, pEnd[1]];
  const stemPts = [pEnd, pStem];
  let centerB, hwsB;
  if (symmetry === "C") {
    // Reflect across the stem's horizontal axis, shift by the stem, walk out→eye.
    centerB = reflectPtsY(center, pEnd[1]).map(([x, y]) => [x + stem, y]);
    centerB = centerB.slice().reverse();
    hwsB = hws.slice().reverse();
  } else {
    // 180° about the stem midpoint: eye→out maps to (far)→pStem; walk out→eye.
    const mid = [(pEnd[0] + pStem[0]) / 2, (pEnd[1] + pStem[1]) / 2];
    centerB = rotatePts(center, Math.PI, mid[0], mid[1]).slice().reverse();
    hwsB = hws.slice().reverse();
  }
  const fullCenter = [...center, ...stemPts, ...centerB];
  const fullHws = [...hws, hws[hws.length - 1], hwsB[0], ...hwsB];
  const ribbon = ribbonOutline(fullCenter, fullHws);
  return bboxFitSubpaths([ribbon], w, h, Math.min(w, h) * 0.06).subpaths;
}

/**
 * Pure function. The central PROFILE polygon of a fence-post finial: "spear" is a
 * lance blade (a tall pointed leaf on a neck), "fleur" is a fleur-de-lis-ish
 * trefoil bud. Built in a natural [-1,1]×[0,H] frame (tip at top, base at y=H);
 * the caller fits it. Symmetric about x=0.
 *
 * @example ironFinialProfile("spear", 3).length // 7 (blade + neck)
 * @example ironFinialProfile("fleur", 3).length // 13 (trefoil bud has more lobes)
 * @example ironFinialProfile("spear", 3)[0] // [0, 0] (tip at top center)
 */
export function ironFinialProfile(profile, H) {
  if (profile === "fleur") {
    // A central pointed petal flanked by two side buds, over a neck.
    return [
      [0, 0], [0.16, 0.22 * H], [0.34, 0.36 * H], [0.16, 0.42 * H], [0.28, 0.6 * H],
      [0.1, 0.66 * H], [0.1, H], [-0.1, H], [-0.1, 0.66 * H], [-0.28, 0.6 * H],
      [-0.16, 0.42 * H], [-0.34, 0.36 * H], [-0.16, 0.22 * H],
    ];
  }
  // spear: a symmetric lance blade tapering to a neck.
  return [
    [0, 0], [0.34, 0.34 * H], [0.12, 0.6 * H], [0.12, H],
    [-0.12, H], [-0.12, 0.6 * H], [-0.34, 0.34 * H],
  ];
}

/**
 * Pure function. VICTORIAN: a wrought-iron FINIAL silhouette (manifest #57) — a
 * central spear/fleur blade (`profile`) with `voluteCount` scroll volutes flanking
 * each side of the base, curling outward, mirrored left/right. Returns the central
 * profile plus 2·voluteCount volute ribbons (fillRule "nonzero" so they union).
 * `voluteSize` scales the coils; `ribbonWidth`/`turns`/`growth` shape them.
 * Uniformly fitted to the bbox as one group.
 *
 * @example ironFinialOutline(200, 300, {voluteCount: 1}).length // 3 (profile + 2 volutes)
 * @example ironFinialOutline(200, 300, {voluteCount: 2}).length // 5 (profile + 4 volutes)
 * @example ironFinialOutline(200, 300, {voluteCount: 0}).length // 1 (bare profile)
 */
export function ironFinialOutline(w, h, { profile = "spear", voluteCount = 2, voluteSize = 0.9, ribbonWidth = 0.16, turns = 1.4, growth = 2.1, taper = 0.6 } = {}) {
  const H = 3; // natural profile height
  const central = ironFinialProfile(profile, H);
  const nV = Math.max(0, Math.round(voluteCount));
  const { center, hws, outerR } = scrollSkeleton({ turns, growth, ribbonWidth, taper });
  const scale = (Math.max(0.05, voluteSize) * 0.8) / outerR; // coil size in natural units
  const unit = center.map(([x, y]) => [x * scale, y * scale]);
  const unitHws = hws.map((v) => v * scale);
  const subs = [central];
  for (let i = 0; i < nV; i++) {
    const t = nV <= 1 ? 0.5 : i / (nV - 1);
    const anchorY = (0.62 + 0.32 * t) * H; // stack volutes up the lower blade
    // Right volute: place the eye near the blade, curl outward-and-down.
    const right = rotatePts(unit, Math.PI * 0.75).map(([x, y]) => [x + 0.18 * H, y + anchorY]);
    subs.push(ribbonOutline(right, unitHws));
    // Left volute: mirror of the right across x=0.
    const left = right.map(([x, y]) => [-x, y]);
    subs.push(ribbonOutline(left.slice().reverse(), unitHws.slice().reverse()));
  }
  return bboxFitSubpaths(subs, w, h, Math.min(w, h) * 0.06).subpaths;
}
