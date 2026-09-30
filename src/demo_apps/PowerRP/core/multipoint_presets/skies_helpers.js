/**
 * Geometry and paint helpers shared by the "Skies & atmospheres" and "Landscape painting" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { catmullRomNodes, polylineNodes, mixHex, finiteGeometry } from "../multipoint_shapes.js";
import { sideRails } from "./minerals_phenomena.js";
import { withStopOffsets } from "./nature.js";

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

/**
 * Pure function. A one-sided streak (cloud, ray, band) over a smooth field: ramp end colours should equal the
 * local field so the ends vanish.
 * @param {number[][]} pts - [N,2] anchors.
 * @param {string[]} colors - Ramp along the streak.
 * @returns {object} Open single-sided feature.
 * @example streak([[0,0.5],[1,0.5]], ["#fff"]).twoSided // false
 */
export function streak(pts, colors) {
  return boundary(catmullRomNodes(pts), colors);
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
 * Pure function. A full-width row across the box at height y, optionally sagging in the middle: a horizontal
 * constraint whose colours may vary along x (sun glow, cloud tint). Its side ends sit on the box edges.
 * @param {number} y - Height at both ends.
 * @param {string[]} colors - 1..4 stops left→right.
 * @param {object} options - {sag=0 (mid rise, negative = up), offsets=null, mid=0.5 (x of the middle anchor)}.
 * @returns {object} Open single-sided feature, 3 nodes.
 * @example row(0.5, ["#000000"]).nodes.length // 3
 */
export function row(y, colors, { sag = 0, offsets = null, mid = 0.5 } = {}) {
  finiteGeometry([y, sag, mid]);
  const f = streak([[0, y], [mid, y + sag], [1, y]], colors);
  return offsets ? withStopOffsets(f, offsets) : f;
}

/**
 * Pure function. Mixes a colour toward another by t (alias with clamping) for glow/tint variants.
 * @param {string} c - #rrggbb.
 * @param {string} toward - #rrggbb.
 * @param {number} t - Fraction, clamped to [0,1].
 * @returns {string} #rrggbb.
 * @example tint("#000000", "#ffffff", 2) // "#ffffff"
 */
export function tint(c, toward, t) {
  return mixHex(c, toward, Math.min(1, Math.max(0, t)));
}

/**
 * Pure function. Point at distance t from (cx,cy) along a screen angle (radians, y down).
 * @param {number} cx - Origin x.
 * @param {number} cy - Origin y.
 * @param {number} angle - Screen radians.
 * @param {number} t - Distance.
 * @returns {number[]} [x, y].
 * @example polar(0.5, 0.5, 0, 0.25) // [0.75,0.5]
 */
export function polar(cx, cy, angle, t) {
  finiteGeometry([cx, cy, angle, t]);
  return [cx + t * Math.cos(angle), cy + t * Math.sin(angle)];
}

/**
 * Pure function. Distance from an interior origin to the first wall hit along an angle within a sub-rectangle.
 * @param {number} cx - Origin x.
 * @param {number} cy - Origin y.
 * @param {number} angle - Screen radians.
 * @param {number[]} rect - [x0,y0,x1,y1] clip rectangle (default the unit box).
 * @returns {number} Distance to the wall.
 * @example reach(0.5, 0.5, Math.PI / 2, [0, 0, 1, 0.8]) // 0.3
 */
export function reach(cx, cy, angle, rect = [0, 0, 1, 1]) {
  finiteGeometry([cx, cy, angle, ...rect]);
  const dx = Math.cos(angle), dy = Math.sin(angle), [x0, y0, x1, y1] = rect, e = 1e-12;
  return Math.min(dx > e ? (x1 - cx) / dx : Infinity, dx < -e ? (x0 - cx) / dx : Infinity, dy > e ? (y1 - cy) / dy : Infinity, dy < -e ? (y0 - cy) / dy : Infinity);
}

/**
 * Pure function. A slender closed lens (leaf) shape from tip to tip, bowed by `bow` on both sides:
 * a soft brush-stroke or cirrus wisp when used as a two-sided closed ribbon.
 * @param {number[]} a - [x, y] left tip.
 * @param {number[]} b - [x, y] right tip.
 * @param {number} bow - Half thickness at the middle (positive).
 * @returns {number[][]} [4,6] closed catmull-rom nodes, counterclockwise on screen when a is left of b (the INSIDE is the walker's LEFT colour).
 * @example lensNodes([0.1, 0.5], [0.9, 0.5], 0.02).length // 4
 */
export function lensNodes(a, b, bow) {
  finiteGeometry([...a, ...b, bow]);
  if (!(bow > 0)) throw new Error("lensNodes needs a positive bow");
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  const nx = -dy / len * bow, ny = dx / len * bow;
  return catmullRomNodes([a, [mx + nx, my + ny], b, [mx - nx, my - ny]], true);
}

/**
 * Pure function. An open scalloped line of rounded pouches hanging below a ceiling: pointed cusps (zero handles) at
 * yCusp alternating with rounded bottoms at each depth, from x = 0 to x = 1. The mammatus / cumulus-underside edge.
 * @param {number} yCusp - Height of the cusps.
 * @param {number[]} depths - Bottom height of each pouch (one per pouch), each > yCusp.
 * @param {number} round - Handle length as a fraction of the half pouch width (0.55 = near-circular).
 * @returns {number[][]} [2n+1, 6] tuples, first node at x = 0, last at x = 1.
 * @example scallopNodes(0.2, [0.4, 0.4]).length // 5
 */
export function scallopNodes(yCusp, depths, round = 0.55) {
  finiteGeometry([yCusp, round, ...depths]);
  if (!depths.length || depths.some((d) => !(d > yCusp))) throw new Error("scallopNodes needs pouch depths below the cusp line");
  const n = depths.length, w = 0.5 / n, nodes = [[0, yCusp, 0, 0, 0, 0]];
  depths.forEach((d, i) => {
    nodes.push([(2 * i + 1) * w, d, -w * round, 0, w * round, 0], [(2 * i + 2) * w, yCusp, 0, 0, 0, 0]);
  });
  nodes.at(-1)[0] = 1;
  return nodes;
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
