/**
 * Geometry and paint helpers for the "Romantic & sublime" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { catmullRomNodes, polylineNodes, mixHex, finiteGeometry } from "../multipoint_shapes.js";
import { sideRails } from "./minerals_phenomena.js";

/**
 * Pure function. Left→right wandering line across the box on catmull-rom anchors, ends pinned on the side edges.
 * @param {number[]} ys - Anchor heights, >= 3 values, evenly spaced in x from 0 to 1.
 * @param {number} x0 - Left end x (default 0).
 * @param {number} x1 - Right end x (default 1).
 * @returns {number[][]} [N,6] catmull-rom nodes.
 * @example horizonNodes([0.7, 0.68, 0.7]).length // 3
 */
export function horizonNodes(ys, x0 = 0, x1 = 1) {
  finiteGeometry([...ys, x0, x1]);
  if (ys.length < 2) throw new Error("horizonNodes needs at least two heights");
  return catmullRomNodes(ys.map((y, i) => [x0 + (x1 - x0) * i / (ys.length - 1), y]));
}

/**
 * Pure function. A two-sided horizon/ridge: `above` on the walker's left (sky), `below` on the right (land).
 * @param {number[]} ys - Anchor heights (see horizonNodes).
 * @param {string[]} above - Colours above the line (1..4).
 * @param {string[]} below - Colours below the line (same count).
 * @returns {object} Open two-sided feature.
 * @example ridge([0.7,0.7,0.7], ["#fff"], ["#000"]).twoSided // true
 */
export function ridge(ys, above, below, x0 = 0, x1 = 1) {
  return boundary(horizonNodes(ys, x0, x1), above, below);
}

/** Pure function. The bottom box edge as a one-sided dark base. @example floor(["#000000"]).nodes.length // 2 */
export function floor(colors) {
  return boundary(polylineNodes([[0, 1], [1, 1]]), colors);
}

/**
 * Pure function. A vertical sky ramp carried by two side rails, plus a sampler for the ramp colour at any height,
 * so streaks can end on the exact local field colour (the end then vanishes).
 * @param {string[]} colors - Top→bottom ramp, 2..4 stops.
 * @param {number[]} offsets - Stop offsets in [0,1] along the rail (0 top, 1 = bottom).
 * @param {number} bottom - Rail end height in (0,1].
 * @returns {{rails: object[], at: function}} rails = 2 open features; at(y) → #rrggbb.
 * @example skyField(["#000000","#ffffff"], [0,1], 1).at(0.5) // "#808080"
 */
export function skyField(colors, offsets, bottom = 1) {
  const rails = sideRails(colors, bottom, offsets);
  const at = (y) => {
    const t = Math.min(1, Math.max(0, y / bottom));
    let i = 0;
    while (i < colors.length - 2 && t > offsets[i + 1]) i++;
    const span = offsets[i + 1] - offsets[i];
    return mixHex(colors[i], colors[i + 1], Math.min(1, Math.max(0, (t - offsets[i]) / span)));
  };
  return { rails, at };
}

/**
 * Pure function. Signed area of a polygon of [x, y] points (positive = clockwise on screen, y down).
 * @param {number[][]} pts - [N,2] polygon corners.
 * @returns {number} Signed area.
 * @example screenArea([[0, 0], [1, 0], [1, 1], [0, 1]]) // 1
 */
export function screenArea(pts) {
  finiteGeometry(pts.flat());
  return pts.reduce((sum, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return sum + (x * y2 - x2 * y) / 2; }, 0);
}

/**
 * Pure function. A smooth closed silhouette through the given points whose `inside` colour is always the interior,
 * whichever way the points wind (reverses them when they run counterclockwise).
 * @param {number[][]} pts - [N,2] anchors, N >= 3.
 * @param {string[]} inside - Interior colours (closed ramps must repeat their first colour).
 * @param {string[]} outside - Outside colours, same length.
 * @returns {object} Closed two-sided feature.
 * @example shape([[0.2,0.2],[0.8,0.2],[0.5,0.8]], ["#000000"], ["#ffffff"]).closed // true
 */
export function shape(pts, inside, outside) {
  const cw = screenArea(pts) > 0;
  return boundary(catmullRomNodes(cw ? pts : [...pts].reverse(), true), outside, inside, true);
}

/**
 * Pure function. A silhouette with straight edges (hard corners): crags, roofs, pine trees.
 * @param {number[][]} pts - [N,2] corners, N >= 3.
 * @param {string[]} inside - Interior colours.
 * @param {string[]} outside - Outside colours, same length.
 * @returns {object} Closed two-sided feature with zero handles.
 * @example crag([[0.2,0.8],[0.5,0.2],[0.8,0.8]], ["#000000"], ["#ffffff"]).nodes.length // 3
 */
export function crag(pts, inside, outside) {
  const cw = screenArea(pts) > 0;
  return boundary(polylineNodes(cw ? pts : [...pts].reverse()), outside, inside, true);
}
