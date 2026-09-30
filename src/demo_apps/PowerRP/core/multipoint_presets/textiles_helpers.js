/**
 * Geometry and paint helpers shared by the "World textiles" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { catmullRomNodes, finiteGeometry, polylineNodes, rectNodes } from "../multipoint_shapes.js";
import { ribbonNodes } from "./retro_eras.js";

/**
 * Pure function. A flat background: the whole box as a single-sided clockwise frame of one colour,
 * which pins that colour along every edge so the interior diffuses toward it.
 * @param {string} color - #rrggbb.
 * @returns {object} Closed single-sided feature over the unit box.
 * @example ground("#102040").closed // true
 */
export function ground(color) {
  return boundary(rectNodes(0, 0, 1, 1), [color], null, true);
}

/**
 * Pure function. A diamond (rhombus) with sharp corners, clockwise on screen from the top vertex.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Half-width.
 * @param {number} ry - Half-height.
 * @returns {number[][]} [4,6] zero-handle nodes.
 * @example diamondNodes(0.5, 0.5, 0.2, 0.3)[1].slice(0, 2) // [0.7,0.5]
 */
export function diamondNodes(cx, cy, rx, ry) {
  finiteGeometry([cx, cy, rx, ry]);
  return polylineNodes([[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]]);
}

/**
 * Pure function. A line on the anti-diagonal x + y = c clipped to the unit box, bent sideways by
 * perpendicular offsets, walked from the lower-left end to the upper-right end. Its rightColor lies on
 * the larger-c side (towards the bottom-right corner). Endpoints are exact.
 * @param {number} c - Diagonal constant in (0,2).
 * @param {number[]} offsets - Perpendicular offsets at even spacing; first and last must be 0.
 * @returns {number[][]} [offsets.length,6] Catmull-Rom nodes.
 * @example antiDiagonalNodes(1, [0, 0, 0]).map((n) => n.slice(0, 2)) // [[0,1],[0.5,0.5],[1,0]]
 */
export function antiDiagonalNodes(c, offsets) {
  finiteGeometry([c, ...offsets]);
  if (!(c > 0 && c < 2) || offsets.length < 2 || offsets[0] !== 0 || offsets.at(-1) !== 0) throw new Error("antiDiagonalNodes needs c in (0,2) and zero end offsets");
  const a = c <= 1 ? [0, c] : [c - 1, 1], b = c <= 1 ? [c, 0] : [1, c - 1], n = offsets.length;
  return catmullRomNodes(offsets.map((o, i) => {
    const t = i / (n - 1);
    return [a[0] + (b[0] - a[0]) * t + o * Math.SQRT1_2, a[1] + (b[1] - a[1]) * t + o * Math.SQRT1_2];
  }));
}

/**
 * Pure function. Points along an S-curve laid on a direction: centre + along·s + across·amp·sin(π·s/half),
 * for s evenly from −half to +half. The classic parang / cloud scroll spine.
 * @param {number[]} centre - [x,y].
 * @param {number[]} along - Unit direction vector of travel.
 * @param {number} half - Half-length along the direction.
 * @param {number} amp - Sideways amplitude (across = the direction turned 90 degrees clockwise on screen).
 * @param {number} count - Number of points >= 3.
 * @returns {number[][]} [count,2].
 * @example sSpine([0.5,0.5],[1,0],0.4,0.1,3).map((p)=>p.map((v)=>+v.toFixed(2))) // [[0.1,0.5],[0.5,0.5],[0.9,0.5]]
 */
export function sSpine([cx, cy], [ux, uy], half, amp, count) {
  finiteGeometry([cx, cy, ux, uy, half, amp, count]);
  if (count < 3) throw new Error("sSpine needs at least three points");
  return Array.from({ length: count }, (_, i) => {
    const s = -half + (2 * half * i) / (count - 1), off = amp * Math.sin(Math.PI * s / half);
    return [cx + ux * s - uy * off, cy + uy * s + ux * off];
  });
}

/**
 * Pure function. A ribbon with a crisp coloured edge: an outer ribbon (outside `ground`, inside `edge`) wrapped
 * around an inner one (outside `edge`, inside `fill`). Two closed two-sided features, both clockwise.
 * @param {number[][]} spine - [N,2] centreline points.
 * @param {number[]} widths - [N] full widths of the FILL ribbon.
 * @param {number} rim - Edge thickness on each side.
 * @param {string} ground - Colour outside the whole ribbon.
 * @param {string} edge - Edge colour.
 * @param {string} fill - Body colour.
 * @returns {object[]} Two features.
 * @example edgedRibbon([[0.2,0.5],[0.5,0.4],[0.8,0.5]], [0.05,0.06,0.05], 0.01, "#000000", "#ff8800", "#ffffff").length // 2
 */
export function edgedRibbon(spine, widths, rim, ground, edge, fill) {
  return [
    boundary(ribbonNodes(spine, widths.map((w) => w + 2 * rim)), [ground], [edge], true),
    boundary(ribbonNodes(spine, widths), [edge], [fill], true),
  ];
}

/**
 * Pure function. A star with concave curved sides: `points` cusps on a circle, each side bowed toward the centre
 * by handles of length `pull` times the cusp radius. Clockwise on screen from the first cusp.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Cusp radius.
 * @param {number} points - Integer cusp count >= 3.
 * @param {number} pull - Handle length as a fraction of r (0 = straight polygon, ~0.45 = deep astroid).
 * @param {number} rotation - Angle of the first cusp (default straight up).
 * @returns {number[][]} [points,6] nodes; close the feature.
 * @example cuspStarNodes(0.5, 0.5, 0.4, 4, 0.3)[0].map((v) => +v.toFixed(2)) // [0.5,0.1,0,0.12,0,0.12]
 */
export function cuspStarNodes(cx, cy, r, points, pull, rotation = -Math.PI / 2) {
  finiteGeometry([cx, cy, r, points, pull, rotation]);
  if (!Number.isInteger(points) || points < 3 || r <= 0) throw new Error("cuspStarNodes needs a positive radius and integer points >= 3");
  return Array.from({ length: points }, (_, i) => {
    const a = rotation + 2 * Math.PI * i / points, hx = -Math.cos(a) * r * pull, hy = -Math.sin(a) * r * pull;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), hx, hy, hx, hy];
  });
}
