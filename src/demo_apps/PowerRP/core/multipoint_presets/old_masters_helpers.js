/**
 * Geometry and paint helpers for the "Old masters light" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, finiteGeometry } from "../multipoint_shapes.js";

/**
 * Pure function. Four single-sided edges pinned exactly on the unit box, each ramping between its two corner colours.
 * Corners are shared by two edges with the same colour, so the frame is a seamless smooth background.
 * @param {string} tl - Top-left colour.
 * @param {string} tr - Top-right colour.
 * @param {string} br - Bottom-right colour.
 * @param {string} bl - Bottom-left colour.
 * @returns {object[]} Four open features (2 nodes each).
 * @example frame("#000000","#111111","#222222","#333333").length // 4
 */
export function frame(tl, tr, br, bl) {
  for (const c of [tl, tr, br, bl]) if (!/^#[0-9a-f]{6}$/.test(c)) throw new Error("frame needs lowercase #rrggbb colours");
  return [
    boundary(polylineNodes([[0, 0], [1, 0]]), [tl, tr]),
    boundary(polylineNodes([[1, 0], [1, 1]]), [tr, br]),
    boundary(polylineNodes([[1, 1], [0, 1]]), [br, bl]),
    boundary(polylineNodes([[0, 1], [0, 0]]), [bl, tl]),
  ];
}

/**
 * Pure function. Rotates a node list about a pivot; anchors rotate about it, relative handles rotate in place.
 * Positive angle turns clockwise on screen (y down).
 * @param {number[][]} nodes - [N,6] (x,y,inX,inY,outX,outY) tuples.
 * @param {number} cx - Pivot x.
 * @param {number} cy - Pivot y.
 * @param {number} angle - Radians, clockwise on screen.
 * @returns {number[][]} [N,6] rotated tuples.
 * @example rotateNodes([[1,0,0,0,0,0]],0,0,Math.PI/2)[0].map((v) => Math.round(v)) // [0,1,0,0,0,0]
 */
export function rotateNodes(nodes, cx, cy, angle) {
  finiteGeometry([cx, cy, angle, ...nodes.flat()]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const turn = (x, y) => [x * c - y * s, x * s + y * c];
  return nodes.map(([x, y, ix, iy, ox, oy]) => {
    const [px, py] = turn(x - cx, y - cy);
    return [cx + px, cy + py, ...turn(ix, iy), ...turn(ox, oy)];
  });
}
