/**
 * Geometry and paint helpers for the "Album art" and "Stage & club light" preset modules
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, finiteGeometry } from "../multipoint_shapes.js";

/**
 * Pure function. A thin wedge (light beam) from an apex on one box edge to a base segment on the
 * opposite edge. Closed, two-sided, clockwise on screen, so `inside` colours land inside the beam
 * and `outside` colours outside. Stops run apex -> base corner -> base corner -> apex, so a
 * [bright, dim, dim, bright] ramp fades the beam from its source to its far end.
 * @param {number[]} apex - (x,y) source point.
 * @param {number[]} baseA - (x,y) first base point.
 * @param {number[]} baseB - (x,y) second base point.
 * @param {string[]} inside - [apex, baseA, baseB, apex] colours (4).
 * @param {string[]} outside - Same shape, colours just outside the beam.
 * @returns {object} Closed two-sided feature.
 * @example beam([0.5,0],[0.7,1],[0.3,1],["#fff","#fff","#fff","#fff"].map(()=>"#ffffff"),["#000000","#000000","#000000","#000000"]).closed // true
 */
export function beam(apex, baseA, baseB, inside, outside) {
  finiteGeometry([...apex, ...baseA, ...baseB]);
  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const a = len(apex, baseA), b = len(baseA, baseB), c = len(baseB, apex), total = a + b + c;
  const feature = boundary(polylineNodes([apex, baseA, baseB]), outside, inside, true);
  const offsets = [0, a / total, (a + b) / total, 1];
  return { ...feature, stops: feature.stops.map((s, i) => ({ ...s, offset: offsets[i] })) };
}

/**
 * Pure function. Zeroes the unused outer handles of an open curve (first in-handle, last
 * out-handle) so they cannot push the solve domain past the unit box.
 * @param {number[][]} nodes - [N,6] open-curve nodes.
 * @returns {number[][]} Copy with nodes[0] in-handle and nodes[N-1] out-handle zeroed.
 * @example trimEnds([[0,0,-1,-1,1,1],[1,1,-1,-1,1,1]]) // [[0,0,0,0,1,1],[1,1,-1,-1,0,0]]
 */
export function trimEnds(nodes) {
  const copy = nodes.map((n) => [...n]);
  copy[0][2] = copy[0][3] = 0;
  copy.at(-1)[4] = copy.at(-1)[5] = 0;
  return copy;
}
