/**
 * Geometry and paint helpers shared by the "Impressionism" and "Post-Impressionism" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { ellipseNodes, polylineNodes, finiteGeometry, hermiteNodes, catmullRomNodes } from "../multipoint_shapes.js";

/**
 * Pure function. Two-sided palette pair where a one-colour side is repeated to match the other.
 * @param {string[]} a - Main palette.
 * @param {string[]|null} b - Opposite palette or null.
 * @returns {Array} [a2, b2] equal lengths (b2 null when b is null).
 * @example match(["#000"], ["#111","#222"]) // [["#000","#000"],["#111","#222"]]
 */
export function match(a, b) {
  if (!b) return [a, null];
  const n = Math.max(a.length, b.length);
  const grow = (c) => (c.length === n ? c : c.length === 1 ? Array(n).fill(c[0]) : null);
  const [a2, b2] = [grow(a), grow(b)];
  if (!a2 || !b2) throw new Error("match: palettes must have equal length or one side a single colour");
  return [a2, b2];
}

/**
 * Pure function. Open horizontal line across the full box at height y. Colours run
 * left to right along it; rightColors (if given) are BELOW the line (two-sided).
 * @param {number} y - Height in [0,1].
 * @param {string[]} colors - Colours above / on the line.
 * @param {string[]|null} below - Colours below the line, same length, or null.
 * @returns {object} Feature.
 * @example hline(0.5, ["#ff0000"]).nodes.length // 2
 */
export function hline(y, colors, below = null) {
  finiteGeometry([y]);
  return boundary(polylineNodes([[0, y], [1, y]]), ...match(colors, below));
}

/**
 * Pure function. Open smooth horizontal-ish ridge across the box through given heights.
 * @param {number[]} ys - Heights at evenly spaced x from 0 to 1 (at least 2).
 * @param {string[]} above - Colours above (left to right).
 * @param {string[]} below - Colours below.
 * @returns {object} Two-sided feature; ends snap exactly to x=0 and x=1.
 * @example ridge([0.5,0.4,0.5], ["#fff"], ["#000"]).nodes.length // 3
 */
export function ridge(ys, above, below) {
  finiteGeometry(ys);
  const n = ys.length;
  const samples = ys.map((y, i) => {
    const dy = ((ys[Math.min(n - 1, i + 1)] - ys[Math.max(0, i - 1)]) / (i === 0 || i === n - 1 ? 1 : 2)) * (n - 1);
    return [i / (n - 1), y, 1, dy];
  });
  const nodes = hermiteNodes(samples, 1 / (n - 1));
  nodes[0][2] = nodes[0][3] = 0;
  nodes[n - 1][4] = nodes[n - 1][5] = 0;
  return boundary(nodes, ...match(above, below));
}

/**
 * Pure function. Two-sided ellipse: rim colour outside, fill colours inside.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius.
 * @param {string[]} outside - Ramp (closed ramps repeat their first colour) outside.
 * @param {string[]} inside - Ramp inside, same length.
 * @returns {object} Closed feature.
 * @example disc(0.5,0.5,0.1,0.1,["#000"],["#fff"]).closed // true
 */
export function disc(cx, cy, rx, ry, outside, inside) {
  return boundary(ellipseNodes(cx, cy, rx, ry), ...match(outside, inside), true);
}

/**
 * Pure function. Haystack silhouette (closed, clockwise): bottom-left, rounded apex,
 * bottom-right, belly. rightColor lands inside.
 * @param {number} cx - Centre x.
 * @param {number} base - Baseline y.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @returns {number[][]} [4,6] nodes.
 * @example stackNodes(0.5,0.8,0.3,0.4).length // 4
 */
export function stackNodes(cx, base, w, h) {
  finiteGeometry([cx, base, w, h]);
  return [
    [cx - w / 2, base, 0, h * 0.08, 0, -h * 0.62],
    [cx, base - h, -w * 0.26, h * 0.1, w * 0.26, h * 0.1],
    [cx + w / 2, base, 0, -h * 0.62, 0, h * 0.08],
    [cx, base + h * 0.07, w * 0.3, 0, -w * 0.3, 0],
  ];
}

/**
 * Pure function. Gothic pointed arch with a flat base, clockwise on screen (inside is rightColor).
 * @param {number} cx - Centre x.
 * @param {number} base - Base y.
 * @param {number} hw - Half width.
 * @param {number} spring - y where the straight jambs turn into the arch.
 * @param {number} apex - y of the point.
 * @returns {number[][]} [5,6] nodes; close the feature.
 * @example pointedArch(0.5,0.9,0.1,0.5,0.3).length // 5
 */
export function pointedArch(cx, base, hw, spring, apex) {
  finiteGeometry([cx, base, hw, spring, apex]);
  const rise = spring - apex;
  return [[cx - hw, base, 0, 0, 0, 0], [cx - hw, spring, 0, 0, 0, -rise * 0.5],
    [cx, apex, -hw * 0.5, rise * 0.3, hw * 0.5, rise * 0.3], [cx + hw, spring, 0, -rise * 0.5, 0, 0], [cx + hw, base, 0, 0, 0, 0]];
}

/**
 * Pure function. Soft-edged patch: a one-sided closed ellipse whose colour bleeds outward
 * (colour is pinned on both sides of the rim, so the edge fades into its surroundings).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius.
 * @param {string} color - Patch colour.
 * @returns {object} Closed single-sided feature.
 * @example soft(0.5,0.5,0.1,0.1,"#fff").twoSided // false
 */
export function soft(cx, cy, rx, ry, color) {
  return boundary(ellipseNodes(cx, cy, rx, ry), [color], null, true);
}

/**
 * Pure function. Closed two-sided shape from any nodes; a one-colour side is repeated to match the other.
 * rightColor (inside for clockwise nodes) is `inside`.
 * @param {number[][]} nodes - [N,6] nodes, clockwise on screen.
 * @param {string[]} outside - Outside palette.
 * @param {string[]} inside - Inside palette (closed ramps repeat their first colour).
 * @returns {object} Closed two-sided feature.
 * @example shape(polylineNodes([[0,0],[1,0],[1,1]]), ["#000"], ["#fff"]).twoSided // true
 */
export function shape(nodes, outside, inside) {
  return boundary(nodes, ...match(outside, inside), true);
}

/**
 * Pure function. Clockwise-on-screen signed area test: positive when the polygon runs clockwise (y down).
 * @param {number[][]} points - [N,2] (x,y) vertices.
 * @returns {number} Twice the shoelace area; > 0 means clockwise on screen.
 * @example area2([[0,0],[1,0],[1,1],[0,1]]) // 2
 */
export function area2(points) {
  return points.reduce((sum, [x, y], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    return sum + x * y2 - x2 * y;
  }, 0);
}

/**
 * Pure function. A tapering closed ribbon (thin two-sided line) along a centreline, as smooth closed nodes.
 * Offsets each centre point by ±width/2 along its normal, walks out along one side and back along the other,
 * and orients the loop clockwise so rightColor is INSIDE the ribbon. Ends are rounded.
 * @param {number[][]} centre - [N,2] (x,y) centreline points, N >= 2.
 * @param {number[]} widths - [N] full ribbon width at each point.
 * @returns {number[][]} [2N,6] closed nodes (close the feature).
 * @example ribbonNodes([[0.1,0.5],[0.9,0.5]], [0.02,0.02]).length // 4
 */
export function ribbonNodes(centre, widths) {
  if (centre.length < 2 || widths.length !== centre.length) throw new Error("ribbonNodes needs matching centre points and widths");
  finiteGeometry([...centre.flat(), ...widths]);
  const n = centre.length;
  const normal = (i) => {
    const [a, b] = [centre[Math.max(0, i - 1)], centre[Math.min(n - 1, i + 1)]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(dx, dy);
    return [-dy / len, dx / len];
  };
  const side = (sign) => centre.map(([x, y], i) => [x + sign * normal(i)[0] * widths[i] / 2, y + sign * normal(i)[1] * widths[i] / 2]);
  let loop = [...side(1), ...side(-1).reverse()];
  if (area2(loop) < 0) loop = loop.reverse();
  return catmullRomNodes(loop, true);
}
