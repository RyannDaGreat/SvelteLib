/**
 * Geometry and paint helpers shared by the "Suprematism & Constructivism" and "Hard-edge & De Stijl" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { finiteGeometry, polylineNodes, rectNodes } from "../multipoint_shapes.js";

const SNAP = 1e-9;

/**
 * Pure function. Corner list of a rotated rectangle, clockwise on screen.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} hw - Positive half-width along the rotated x axis.
 * @param {number} hh - Positive half-height.
 * @param {number} angle - Rotation in radians (positive = clockwise on screen).
 * @returns {number[][]} [4,2] (x,y) corners.
 * @example rotRect(0.5, 0.5, 0.2, 0.1, 0).map((p) => p.map((v) => +v.toFixed(2))) // [[0.3,0.4],[0.7,0.4],[0.7,0.6],[0.3,0.6]]
 */
export function rotRect(cx, cy, hw, hh, angle) {
  finiteGeometry([cx, cy, hw, hh, angle]);
  if (!(hw > 0) || !(hh > 0)) throw new Error("rotRect needs positive half sizes");
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
}

/**
 * Pure function. Clips a convex or simple polygon to an axis-aligned rectangle (Sutherland-Hodgman),
 * snapping coordinates that land on the rectangle edge exactly onto it.
 * @param {number[][]} poly - [N,2] (x,y) vertices, N >= 3.
 * @param {number[]} box - [x0,y0,x1,y1] clip rectangle.
 * @returns {number[][]} [M,2] clipped vertices (possibly empty).
 * @example clipPolygon([[-1,0.5],[0.5,-1],[2,0.5],[0.5,2]], [0,0,1,1]).length // 4 (the diamond covers the whole box, which comes back)
 * @example clipPolygon([[0.2,0.2],[0.8,0.2],[0.8,0.8]], [0,0,1,1]).length // 3
 */
export function clipPolygon(poly, [x0, y0, x1, y1]) {
  finiteGeometry([x0, y0, x1, y1, ...poly.flat()]);
  const planes = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]]; // [axis, limit, inside sign]
  let out = poly;
  for (const [axis, limit, sign] of planes) {
    const src = out; out = [];
    const inside = (p) => sign * (p[axis] - limit) >= -SNAP;
    src.forEach((p, i) => {
      const q = src[(i + 1) % src.length], pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (limit - p[axis]) / (q[axis] - p[axis]), pt = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        pt[axis] = limit; out.push(pt);
      }
    });
  }
  return out.map(([x, y]) => [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))]);
}

/**
 * Pure function. A flat coloured panel: a closed two-sided polygon whose OUTSIDE is `outside`
 * (the ground/line colour) and whose INSIDE is `fill`, so its edge is a crisp step.
 * @param {number[][]} points - [N,2] vertices, clockwise on screen.
 * @param {string} outside - Colour just outside the edge.
 * @param {string|string[]} fill - Colour inside (one colour, or a ramp for a shaded panel).
 * @param {string|string[]} [outsideRamp] - Optional ramp outside, same length as a fill ramp.
 * @returns {object} Closed feature.
 * @example panel(rotRect(0.5,0.5,0.1,0.1,0), "#ffffff", "#000000").twoSided // true
 */
export function panel(points, outside, fill, outsideRamp) {
  const inner = [].concat(fill), outer = outsideRamp ? [].concat(outsideRamp) : inner.map(() => outside);
  return boundary(polylineNodes(points), outer, inner, true);
}

/**
 * Pure function. Axis-aligned panel inset by half a gap on every interior side, so neighbouring
 * panels are separated by a `gap`-wide strip of `line` colour; edges lying on the unit box are not inset.
 * @param {number[]} rect - [x0,y0,x1,y1].
 * @param {string} line - Gap/outside colour.
 * @param {string} fill - Panel colour.
 * @param {number} gap - Total gap between neighbours.
 * @returns {object} Closed two-sided feature.
 * @example gapPanel([0,0,0.5,1], "#000000", "#ff0000", 0.04).nodes[1].slice(0,2) // [0.48,0]
 */
export function gapPanel([x0, y0, x1, y1], line, fill, gap) {
  const h = gap / 2, lo = (v) => (v === 0 ? 0 : v + h), hi = (v) => (v === 1 ? 1 : v - h);
  return boundary(rectNodes(lo(x0), lo(y0), hi(x1), hi(y1)), [line], [fill], true);
}

/**
 * Pure function. Single-sided constant frame around the whole unit box: a crease-free backdrop.
 * @param {string[]} colors - Open ramp of at most 3 colours (seam colour appended when >1).
 * @returns {object} Closed four-node feature.
 * @example boxFrame(["#101010"]).stops.length // 1
 */
export function boxFrame(colors) {
  return boundary(rectNodes(0, 0, 1, 1), colors.length > 1 ? closedRamp(colors) : colors, null, true);
}

/**
 * Pure function. A two-sided divider polyline between two flat colour regions. Walking from
 * first to last point, `colors` lies on the walker's LEFT and `rightColors` on the RIGHT.
 * (Left→right walk: left = above. Downward walk on screen: left = east.)
 * @param {number[][]} points - [N,2] vertices.
 * @param {string} left - Colour on the walker's left.
 * @param {string} right - Colour on the walker's right.
 * @returns {object} Open two-sided feature.
 * @example divider([[0.5,0],[0.5,1]], "#ff0000", "#0000ff").stops[0].rightColor // "#0000ff"
 */
export function divider(points, left, right) {
  return boundary(polylineNodes(points), [left], [right], false);
}

const ARC_STEP = Math.PI / 2;

/**
 * Pure function. Cubic nodes of a circular arc, one span per <= 90 degrees, exact at the ends.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Positive radius.
 * @param {number} a0 - Start angle (screen radians, 0 = right, pi/2 = down).
 * @param {number} a1 - End angle; a1 > a0 sweeps clockwise on screen.
 * @returns {number[][]} [K,6] nodes with relative handles.
 * @example arcNodes(0.5, 0.5, 0.25, 0, Math.PI / 2).map((n) => n.slice(0, 2).map((v) => +v.toFixed(2))) // [[0.75,0.5],[0.5,0.75]]
 */
export function arcNodes(cx, cy, r, a0, a1) {
  finiteGeometry([cx, cy, r, a0, a1]);
  if (!(r > 0) || a0 === a1) throw new Error("arcNodes needs a positive radius and a nonzero sweep");
  const spans = Math.ceil(Math.abs(a1 - a0) / ARC_STEP - 1e-9), da = (a1 - a0) / spans, k = 4 / 3 * Math.tan(da / 4) * r;
  return Array.from({ length: spans + 1 }, (_, i) => {
    const a = a0 + da * i, c = Math.cos(a), s = Math.sin(a), tx = -s * k, ty = c * k;
    return [cx + r * c, cy + r * s, -tx, -ty, tx, ty];
  });
}

/**
 * Pure function. Closed annular sector (a ring slice), clockwise on screen: outer arc a0->a1,
 * then straight in, inner arc back, straight out. r0 = 0 gives a pie wedge (two nodes on the centre are merged).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r0 - Inner radius >= 0.
 * @param {number} r1 - Outer radius > r0.
 * @param {number} a0 - Start angle.
 * @param {number} a1 - End angle > a0.
 * @returns {number[][]} Closed-shape nodes; corners have handles only along the arcs.
 * @example annularSectorNodes(0.5, 0.5, 0.1, 0.3, 0, Math.PI / 2).length // 4
 */
export function annularSectorNodes(cx, cy, r0, r1, a0, a1) {
  if (!(r1 > r0) || !(r0 >= 0) || !(a1 > a0)) throw new Error("annularSectorNodes needs r1 > r0 >= 0 and a1 > a0");
  const outer = arcNodes(cx, cy, r1, a0, a1);
  outer[0][2] = outer[0][3] = 0; outer.at(-1)[4] = outer.at(-1)[5] = 0;
  if (r0 === 0) return [...outer, [cx, cy, 0, 0, 0, 0]];
  const inner = arcNodes(cx, cy, r0, a1, a0);
  inner[0][2] = inner[0][3] = 0; inner.at(-1)[4] = inner.at(-1)[5] = 0;
  return [...outer, ...inner];
}

const MIN_CELL_AREA = 1e-4;

/**
 * Pure function. Polygon area (shoelace, absolute).
 * @param {number[][]} poly - [N,2] vertices.
 * @returns {number} Area.
 * @example polygonArea([[0,0],[1,0],[1,1],[0,1]]) // 1
 */
export function polygonArea(poly) {
  finiteGeometry(poly.flat());
  return Math.abs(poly.reduce((sum, [x, y], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return sum + x * y2 - x2 * y; }, 0)) / 2;
}

/**
 * Pure function. A cell of a grid rotated about the box centre, shrunk by half a gap on
 * every side and clipped to the unit box (so edges on the box are not inset).
 * Cell is [u0,u1]x[v0,v1] in grid coordinates (origin at the box centre); returns null if
 * the clipped remainder is negligible.
 * @param {number[]} cell - [u0,v0,u1,v1] in grid coordinates.
 * @param {number} angle - Grid rotation in radians.
 * @param {number} gap - Total gap between neighbours in grid units.
 * @returns {number[][]|null} Clockwise clipped polygon, or null.
 * @example rotCell([-1,-1,1,1], 0.5, 0)?.length // 4
 * @example rotCell([5,5,6,6], 0.5, 0) // null
 */
export function rotCell([u0, v0, u1, v1], angle, gap) {
  const h = gap / 2, c = Math.cos(angle), s = Math.sin(angle);
  const poly = [[u0 + h, v0 + h], [u1 - h, v0 + h], [u1 - h, v1 - h], [u0 + h, v1 - h]].map(([u, v]) => [0.5 + u * c - v * s, 0.5 + u * s + v * c]);
  const clipped = clipPolygon(poly, [0, 0, 1, 1]);
  return clipped.length >= 3 && polygonArea(clipped) > MIN_CELL_AREA ? clipped : null;
}
