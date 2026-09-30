/**
 * Geometry and paint helpers for the "Picture-book illustration" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { hermiteNodes, finiteGeometry, polylineNodes, ellipseNodes } from "../multipoint_shapes.js";

const DERIVATIVE_STEP = 1e-5;

/**
 * Pure function. A graph y = f(x) over x in [0,1] as cubic nodes, walked left to right, so `colors`
 * lie ABOVE and `rightColors` BELOW. Endpoints land exactly on x = 0 and x = 1 with flat end handles.
 * @param {function} f - x -> y in the unit box.
 * @param {number} spans - Positive integer cubic span count (spans + 1 nodes).
 * @returns {number[][]} [spans+1, 6] tuples.
 * @example graphNodes((x) => 0.5, 2).map((n) => n[0]) // [0,0.5,1]
 */
export function graphNodes(f, spans) {
  finiteGeometry([spans]);
  if (!Number.isInteger(spans) || spans < 1) throw new Error("graphNodes needs a positive integer span count");
  const nodes = hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => {
    const x = i / spans, y = f(x);
    return [x, y, 1, (f(x + DERIVATIVE_STEP) - f(x - DERIVATIVE_STEP)) / (2 * DERIVATIVE_STEP)];
  }), 1 / spans);
  nodes[0][2] = 0; nodes[0][3] = 0; nodes.at(-1)[4] = 0; nodes.at(-1)[5] = 0;
  return nodes;
}

/**
 * Pure function. Two full-height edge lines (x = 0 and x = 1) whose stops run top to bottom: a vertical
 * gradient ground that pins the whole box edge without any interior crease.
 * @param {string[]} colors - 2-4 #rrggbb stops, top first.
 * @returns {object[]} Two single-sided open features.
 * @example verticalGround(["#000000", "#ffffff"]).length // 2
 */
export function verticalGround(colors) {
  return [0, 1].map((x) => boundary(polylineNodes([[x, 0], [x, 1]]), colors));
}

/**
 * Pure function. A flat painted-paper shape: a closed two-sided curve whose outside is the ground and whose
 * inside is a short ramp (2+ colours repeat into a closed ramp), so the paper looks streaky/brushed.
 * @param {number[][]} nodes - Clockwise closed outline.
 * @param {string} outside - Colour just outside the rim.
 * @param {string[]} inside - One colour, or a ramp that is closed automatically.
 * @returns {object} Feature.
 * @example paperShape(ellipseNodes(0.5,0.5,0.2), "#ffffff", ["#ff0000"]).closed // true
 */
export function paperShape(nodes, outside, inside) {
  const ring = inside.length === 1 ? inside : closedRamp(inside);
  return boundary(nodes, ring.map(() => outside), ring, true);
}

/**
 * Pure function. A disc as paperShape.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Radius.
 * @param {string} outside - Colour just outside.
 * @param {string[]} inside - Inside colour(s).
 * @returns {object} Feature.
 * @example disc(0.5,0.5,0.1,"#fff",["#f00"]).nodes.length // 4
 */
export function disc(cx, cy, r, outside, inside) {
  return paperShape(ellipseNodes(cx, cy, r), outside, inside);
}
