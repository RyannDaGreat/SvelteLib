/**
 * Geometry and paint helpers for the "Landscape painting" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
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
 * Pure function. Two single-sided rails on the box's side edges carrying one ramp over a BAND of the height
 * (from y0 to y1): a smooth vertical field below a horizon ridge, stopped just short of the ridge ends.
 * @param {string[]} colors - Top→bottom ramp, 1..4 stops.
 * @param {number} y0 - Band top in [0,1).
 * @param {number} y1 - Band bottom in (y0,1].
 * @param {number[]|null} offsets - Optional explicit stop offsets.
 * @returns {object[]} Two open features.
 * @example bandRails(["#000000","#ffffff"], 0.6, 1).length // 2
 */
export function bandRails(colors, y0, y1 = 1, offsets = null) {
  finiteGeometry([y0, y1]);
  if (!(y0 >= 0 && y1 <= 1 && y1 > y0)) throw new Error("bandRails needs 0 <= y0 < y1 <= 1");
  return [0, 1].map((x) => {
    const r = boundary(polylineNodes([[x, y0], [x, y1]]), colors);
    return offsets ? withStopOffsets(r, offsets) : r;
  });
}

/**
 * Pure function. A colour repeated n times (closed ramps need equal-length palettes on both sides).
 * @param {string} c - #rrggbb.
 * @param {number} n - Count, >= 1.
 * @returns {string[]} n copies.
 * @example dup("#000000", 2) // ["#000000","#000000"]
 */
export function dup(c, n) {
  finiteGeometry([n]);
  if (n < 1) throw new Error("dup needs n >= 1");
  return Array(n).fill(c);
}

/**
 * Pure function. One single-sided vertical rail on a chosen x (usually a box edge) carrying a ramp from y0 to y1:
 * lets the left and right edges hold DIFFERENT vertical ramps, for skies that change across the picture.
 * @param {number} x - Rail x in [0,1].
 * @param {number} y0 - Top y.
 * @param {number} y1 - Bottom y (> y0).
 * @param {string[]} colors - Top→bottom ramp, 1..4 stops.
 * @param {number[]|null} offsets - Optional explicit stop offsets.
 * @returns {object} Open single-sided feature, 2 nodes.
 * @example rail(0, 0, 0.5, ["#000000","#ffffff"]).nodes.length // 2
 */
export function rail(x, y0, y1, colors, offsets = null) {
  finiteGeometry([x, y0, y1]);
  if (!(y1 > y0)) throw new Error("rail needs y1 > y0");
  const r = boundary(polylineNodes([[x, y0], [x, y1]]), colors);
  return offsets ? withStopOffsets(r, offsets) : r;
}

/**
 * Pure function. A dark mass hugging the box: a SMOOTH visible edge (catmull-rom through `edge`, whose two
 * ends lie on the box boundary) closed by straight runs through box corners, so nothing overshoots the unit
 * box (a plain closed catmull through a corner bulges past it). Points must run CLOCKWISE on screen (y down).
 * @param {number[][]} edge - [N,2] visible edge points, N >= 3, both ends on the box boundary.
 * @param {number[][]} corners - [M,2] box corners closing the loop (clockwise continuation); may be empty
 *   when both ends sit on the same side and the loop closes straight along it.
 * @param {string[]} inside - Interior colours (closed ramp: first colour repeated last), length = outside.length.
 * @param {string[]} outside - Colours just off the edge, 2..4 stops; also closed, so first repeats last.
 * @returns {object} Closed two-sided feature.
 * @example mass([[0,0.5],[0.2,0.6],[0,0.8]], [], ["#000000","#000000"], ["#ffffff","#ffffff"]).closed // true
 */
export function mass(edge, corners, inside, outside) {
  finiteGeometry([...edge.flat(), ...corners.flat()]);
  if (screenArea([...edge, ...corners]) <= 0) throw new Error("mass points must run clockwise on screen");
  const nodes = catmullRomNodes(edge);
  nodes[0][2] = nodes[0][3] = 0;
  nodes.at(-1)[4] = nodes.at(-1)[5] = 0;
  corners.forEach(([x, y]) => nodes.push([x, y, 0, 0, 0, 0]));
  return boundary(nodes, outside, inside, true);
}

/**
 * Pure function. A vertical rail on x carrying the SAME colours as a skyField between y0 and y1, resampled to
 * 4 evenly spaced stops: shortens one side rail where a mass hugs that edge, so the rail cannot run under it.
 * @param {{at: function}} sky - Result of skyField.
 * @param {number} x - Rail x.
 * @param {number} y0 - Top y.
 * @param {number} y1 - Bottom y.
 * @returns {object} Open single-sided feature, 2 nodes, 4 stops.
 * @example railFromSky(skyField(["#000000","#ffffff"],[0,1],1), 0, 0, 0.5).stops.length // 4
 */
export function railFromSky(sky, x, y0, y1) {
  return rail(x, y0, y1, [0, 1, 2, 3].map((i) => sky.at(y0 + (y1 - y0) * i / 3)));
}

/**
 * Pure function. A jagged two-sided horizon (straight segments, hard corners): alpine ridges and crags.
 * @param {number[][]} pts - [N,2] corner points from left to right, N >= 2, ends ideally on the box sides.
 * @param {string[]} above - Colours on the walker's left (above a left→right line).
 * @param {string[]} below - Colours on the right (below), same length.
 * @returns {object} Open two-sided feature with zero handles.
 * @example jagged([[0,0.5],[0.5,0.2],[1,0.5]], ["#fff"], ["#000"]).nodes.length // 3
 */
export function jagged(pts, above, below) {
  finiteGeometry(pts.flat());
  return boundary(polylineNodes(pts), above, below);
}

/**
 * Pure function. Like `mass` but with straight facets and hard corners (rock, crags, pines): the visible edge
 * runs through `edge` with no smoothing, closed by straight runs through `corners`. Points run CLOCKWISE on screen.
 * @param {number[][]} edge - [N,2] visible edge points, N >= 2.
 * @param {number[][]} corners - [M,2] closing corners (may be empty).
 * @param {string[]} inside - Interior colours (first repeated last), same length as outside.
 * @param {string[]} outside - Colours just off the edge, 2..4 stops, first repeated last.
 * @returns {object} Closed two-sided feature with zero handles.
 * @example rock([[0,1],[0.5,0.5]], [[1,1]], ["#000000","#000000"], ["#ffffff","#ffffff"]).nodes.length // 3
 */
export function rock(edge, corners, inside, outside) {
  finiteGeometry([...edge.flat(), ...corners.flat()]);
  const pts = [...edge, ...corners];
  if (screenArea(pts) <= 0) throw new Error("rock points must run clockwise on screen");
  return boundary(polylineNodes(pts), outside, inside, true);
}

/**
 * Pure function. An open two-sided line of rounded mounds standing on a base line (cauliflower cloud tops,
 * hummocks): pointed cusps at yBase alternating with rounded crowns of the given heights, between x0 and x1.
 * @param {number} yBase - Height of the cusps.
 * @param {number[]} heights - Crown rise above the base, one per mound, each > 0.
 * @param {number} round - Handle length as a fraction of the half mound width (0.55 = near circular).
 * @param {number} x0 - Left end x (default 0).
 * @param {number} x1 - Right end x (default 1).
 * @returns {number[][]} [2n+1, 6] tuples, first at x0, last at x1.
 * @example moundNodes(0.5, [0.1, 0.1]).length // 5
 */
export function moundNodes(yBase, heights, round = 0.55, x0 = 0, x1 = 1) {
  finiteGeometry([yBase, round, x0, x1, ...heights]);
  if (!heights.length || heights.some((h) => !(h > 0)) || !(x1 > x0)) throw new Error("moundNodes needs positive crown heights and x1 > x0");
  const n = heights.length, w = (x1 - x0) / (2 * n), nodes = [[x0, yBase, 0, 0, 0, 0]];
  heights.forEach((h, i) => {
    nodes.push([x0 + (2 * i + 1) * w, yBase - h, -w * round, 0, w * round, 0], [x0 + (2 * i + 2) * w, yBase, 0, 0, 0, 0]);
  });
  nodes.at(-1)[0] = x1;
  return nodes;
}
