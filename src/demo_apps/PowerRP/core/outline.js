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
