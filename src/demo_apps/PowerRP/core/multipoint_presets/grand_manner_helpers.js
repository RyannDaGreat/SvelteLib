/**
 * Geometry and paint helpers for the "Old masters light" and "Romantic & sublime" preset modules
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, point } from "./builders.js";
import { polylineNodes, finiteGeometry, catmullRomNodes } from "../multipoint_shapes.js";

/**
 * Pure function. A left-to-right horizon line across the whole box, `colors` ABOVE, `rightColors` BELOW.
 * Both ends sit exactly on the side walls (x = 0 and x = 1), so the solve domain never grows.
 * @param {number[]} ys - [K] heights at evenly spaced anchors, K >= 2 (a Catmull-Rom curve through them).
 * @param {string[]} above - Ramp above the line (1..4 stops).
 * @param {string[]} below - Ramp below the line; the same length as `above`, or one colour (broadcast).
 * @returns {object} Open two-sided feature with K nodes.
 * @example horizon([0.6, 0.6], ["#000000"], ["#ffffff"]).nodes.length // 2
 */
export function horizon(ys, above, below) {
  finiteGeometry(ys);
  if (ys.length < 2) throw new Error("horizon needs at least two heights");
  const width = Math.max(above.length, below.length), widen = (colors) => (colors.length === 1 ? Array(width).fill(colors[0]) : colors);
  return boundary(catmullRomNodes(ys.map((y, i) => [i / (ys.length - 1), y])), widen(above), widen(below));
}

/**
 * Pure function. A vertical ramp on both side walls of the box (no interior crease), top to bottom.
 * @param {string[]} colors - Top-to-bottom ramp, 1..4 stops.
 * @returns {object[]} Two open features.
 * @example verticalRails(["#000000", "#ffffff"]).length // 2
 */
export function verticalRails(colors) {
  return [0, 1].map((x) => boundary(polylineNodes([[x, 0], [x, 1]]), colors));
}

/**
 * Pure function. Horizontal ramp along top and bottom edges. The top edge runs left->right and the
 * bottom edge is walked right->left, so `colors` should be given left->right for both.
 * @param {string[]} topColors - Left-to-right ramp along the top edge.
 * @param {string[]} bottomColors - Left-to-right ramp along the bottom edge (same length).
 * @returns {object[]} Two open features.
 * @example horizontalRails(["#000000"], ["#ffffff"]).length // 2
 */
export function horizontalRails(topColors, bottomColors) {
  return [boundary(polylineNodes([[0, 0], [1, 0]]), topColors), boundary(polylineNodes([[1, 1], [0, 1]]), [...bottomColors].reverse())];
}

/**
 * Pure function. A soft glow source: light core point, then a shoulder ring and a rim ring squashed
 * to an ellipse. Same idea as builders.glow but with independent radii.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Outer horizontal radius.
 * @param {number} ry - Outer vertical radius.
 * @param {string[]} colors - [core, shoulder, rim].
 * @param {function} ring - (cx, cy, rx, ry) -> [N,6] closed-curve nodes.
 * @returns {object[]} Three features.
 * @example softGlow(0.5, 0.5, 0.2, 0.1, ["#fff", "#f80", "#210"], (x, y, a, b) => [[x, y, 0, 0, 0, 0]]).length // 3
 */
export function softGlow(cx, cy, rx, ry, [core, shoulder, rim], ring) {
  const shoulderRatio = 0.55;
  return [point(cx, cy, core), boundary(ring(cx, cy, rx * shoulderRatio, ry * shoulderRatio), [shoulder], null, true),
    boundary(ring(cx, cy, rx, ry), [rim], null, true)];
}
