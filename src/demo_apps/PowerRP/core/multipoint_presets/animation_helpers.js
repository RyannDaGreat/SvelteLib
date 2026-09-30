/**
 * Geometry and paint helpers for the "Animation backgrounds" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { catmullRomNodes, polylineNodes, ellipseNodes, finiteGeometry } from "../multipoint_shapes.js";

/**
 * Pure function. Closed cumulus outline, clockwise on screen: corner-pinched valleys between round
 * domes (horizontal handles on each dome crown) over a gently sagging base.
 * @param {object} o - {cx, base, w, h, heights=[...], widths=null, sag=0.1}; heights are per-dome fractions of h.
 * @returns {number[][]} [2*domes+2, 6] closed nodes, e.g. 3 domes -> 8.
 * @example cloudNodes({cx:0.5,base:0.5,w:0.4,h:0.2,heights:[0.6,1,0.7]}).length // 8
 */
export function cloudNodes({ cx, base, w, h, heights = [0.6, 1, 0.75], widths = null, sag = 0.04 }) {
  finiteGeometry([cx, base, w, h, sag, ...heights]);
  if (!(w > 0 && h > 0) || !heights.length) throw new Error("cloudNodes needs positive size and at least one dome");
  const n = heights.length, ws = widths ?? heights.map(() => 1), total = ws.reduce((a, b) => a + b, 0);
  const x0 = cx - w / 2, edges = ws.reduce((acc, k) => [...acc, acc.at(-1) + k * w / total], [x0]);
  const SHOULDER = 0.3, VALLEY = 0.72, HANDLE = 0.62;
  const nodes = [[edges[0], base - h * SHOULDER, 0, 0, 0, 0]];
  heights.forEach((k, i) => {
    const half = (edges[i + 1] - edges[i]) / 2, hx = half * HANDLE * 1.7;
    nodes.push([edges[i] + half, base - h * k, -hx, 0, hx, 0]);
    if (i < n - 1) nodes.push([edges[i + 1], base - h * Math.max(SHOULDER, VALLEY * Math.min(k, heights[i + 1])), 0, 0, 0, 0]);
  });
  nodes.push([edges[n], base - h * SHOULDER, 0, 0, 0, 0]);
  nodes.push([cx, base + h * sag, w * 0.22, 0, -w * 0.22, 0]);
  return nodes;
}

/**
 * Pure function. A two-sided cloud: `sky` colour outside, a lit-to-shaded ramp inside
 * (ramp starts at the lower-left, climbs over the crown and returns to shade).
 * @param {number[][]} nodes - closed clockwise outline.
 * @param {string} sky - Colour of the surrounding sky.
 * @param {string[]} ramp - Interior colours, 2-3 of them, e.g. [shade, light, shade].
 * @returns {object} closed feature
 * @example cloud(cloudNodes({cx:.5,base:.5,w:.4,h:.2}),"#88aaee",["#99a","#fff"]).closed // true
 */
export function cloud(nodes, sky, ramp) {
  const inside = closedRamp(ramp);
  return boundary(nodes, inside.map(() => sky), inside, true);
}

/**
 * Pure function. Horizontal box-width ridge line y(x) through given anchors, pinned to x=0 and x=1.
 * Walked left to right, so `colors` is ABOVE (sky side) and `rightColors` BELOW (land side).
 * @param {number[]} ys - Heights at evenly spaced x from 0 to 1, at least two.
 * @param {string[]} above - Colours above.
 * @param {string[]} below - Colours below.
 * @returns {object} open two-sided feature
 * @example ridge([0.5,0.4,0.5],["#fff"],["#000"]).nodes.length // 3
 */
export function ridge(ys, above, below) {
  if (ys.length < 2) throw new Error("ridge needs at least two heights");
  finiteGeometry(ys);
  return boundary(catmullRomNodes(ys.map((y, i) => [i / (ys.length - 1), y])), above, below);
}

/**
 * Pure function. Constant-colour horizontal line across the box (an edge pin or a flat band edge).
 * @param {number} y - Height.
 * @param {string[]} colors - Above colours (single-sided).
 * @param {string[]|null} below - Below colours for a two-sided crisp edge.
 * @returns {object} open feature
 * @example hline(0,["#fff"]).nodes // [[0,0,0,0,0,0],[1,0,0,0,0,0]]
 */
export function hline(y, colors, below = null) {
  finiteGeometry([y]);
  return boundary(polylineNodes([[0, y], [1, y]]), colors, below);
}

/**
 * Pure function. Contiguous block towers as one clockwise silhouette polygon sitting on the box bottom:
 * each tower contributes its two top corners, adjacent towers share the vertical step between them.
 * @param {number[][]} towers - [x0, x1, top] rows, contiguous in x (x1 of one = x0 of the next), spanning 0..1.
 * @param {string} haze - Sky colour around it.
 * @param {string} dark - Silhouette colour.
 * @returns {object} closed two-sided feature, 2 * towers + 2 nodes
 * @example skylineShape([[0,0.5,0.6],[0.5,1,0.4]],"#f80","#012").nodes.length // 6
 */
export function skylineShape(towers, haze, dark) {
  finiteGeometry(towers.flat());
  towers.slice(1).forEach(([x0], i) => { if (x0 !== towers[i][1]) throw new Error("skylineShape towers must be contiguous"); });
  const pts = [[towers[0][0], 1], ...towers.flatMap(([x0, x1, top]) => [[x0, top], [x1, top]]), [towers.at(-1)[1], 1]];
  return boundary(polylineNodes(pts), [haze], [dark], true);
}

/**
 * Pure function. A thin horizontal streak cloud (closed ellipse), light inside and sky outside; crisp like a matte-painting cirrus band.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Half length.
 * @param {number} ry - Half thickness.
 * @param {string} sky - Colour outside.
 * @param {string[]} lit - Interior ramp, top to bottom around the ellipse (2 or 3 colours).
 * @returns {object} closed two-sided feature
 * @example streak(0.5,0.3,0.3,0.015,"#88a",["#fff","#fc8"]).closed // true
 */
export function streak(cx, cy, rx, ry, sky, lit) {
  const ramp = closedRamp(lit);
  return boundary(ellipseNodes(cx, cy, rx, ry), ramp.map(() => sky), ramp, true);
}

/**
 * Pure function. Cauliflower outline: pinched corner nodes joined by outward-bulging domes, the silhouette of a
 * cumulus tower. Corners must run CLOCKWISE on screen (y down); each edge becomes a cubic whose control points
 * push along the outward normal by `bulge` times the chord length (negative bulge dents inward).
 * @param {number[][]} corners - [N,2] clockwise corner anchors, N >= 3 (N cubics, N nodes).
 * @param {number|number[]} bulge - Dome height as a fraction of each chord (one value or one per edge, edge i joins corner i to i+1).
 * @returns {number[][]} [N,6] closed-shape nodes with cusp corners (handles relative).
 * @example lobeNodes([[0,0],[1,0],[1,1],[0,1]], 0.2)[0].slice(0,2) // [0,0]
 */
export function lobeNodes(corners, bulge) {
  finiteGeometry(corners.flat());
  const n = corners.length;
  if (n < 3) throw new Error("lobeNodes needs at least three corners");
  const bulges = Array.isArray(bulge) ? bulge : corners.map(() => bulge);
  const SIDE_PULL = 0.12, DOME_PULL = 1.3;
  const nodes = corners.map(([x, y]) => [x, y, 0, 0, 0, 0]);
  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % n], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (!len) throw new Error("lobeNodes corners must be distinct");
    const nx = dy / len, ny = -dx / len, lift = len * bulges[i] * DOME_PULL;
    const out = [dx * SIDE_PULL + nx * lift, dy * SIDE_PULL + ny * lift];
    const back = [-dx * SIDE_PULL + nx * lift, -dy * SIDE_PULL + ny * lift];
    nodes[i][4] = out[0]; nodes[i][5] = out[1];
    nodes[(i + 1) % n][2] = back[0]; nodes[(i + 1) % n][3] = back[1];
  });
  return nodes;
}
