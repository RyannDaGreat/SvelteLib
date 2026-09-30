/**
 * Geometry and paint helpers for the "Glass & windows" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { finiteGeometry } from "../multipoint_shapes.js";
import { parametricNodes } from "./food_moods.js";
import { insetConvex } from "./retro_eras.js";
import { sampledNodes } from "./swirls.js";

/**
 * Pure function. A glass pane: a closed clockwise outline whose OUTSIDE is the lead colour and
 * whose INSIDE carries the jewel ramp (a multi-stop ramp gets its seam-free closing colour).
 * @param {number[][]} nodes - [N,6] clockwise outline.
 * @param {string[]} jewel - Interior colours (1..3 colours; closed-ramp rule applied when > 1).
 * @param {string} lead - Exterior (lead came) colour.
 * @returns {object} Closed two-sided feature.
 * @example pane([[0,0,0,0,0,0]], ["#f00"], "#000").stops[0].rightColor // "#f00"
 */
export function pane(nodes, jewel, lead) {
  if (!jewel.length) throw new Error("pane needs at least one jewel colour");
  const inside = jewel.length > 1 ? closedRamp(jewel) : jewel;
  return boundary(nodes, inside.map(() => lead), inside, true);
}

/**
 * Pure function. Gothic lancet: flat base, straight sides to the spring line, and a pointed arch whose two
 * arcs are centred on the spring line, each offset d toward the far side (d = 0 is a semicircle, d = rx is
 * equilateral). Clockwise on screen from the bottom-left, so rightColor is INSIDE.
 * @param {number} cx - Axis x.
 * @param {number} base - Base y (bottom edge).
 * @param {number} rx - Half-width (> 0).
 * @param {number} spring - Spring-line y, above base.
 * @param {number} rise - Apex height above the spring line (>= rx).
 * @returns {number[][]} [5,6] tuples; close the feature.
 * @example lancetNodes(0.5, 1, 0.2, 0.5, 0.2)[2].slice(0, 2) // [0.5,0.3]
 */
export function lancetNodes(cx, base, rx, spring, rise) {
  finiteGeometry([cx, base, rx, spring, rise]);
  if (rx <= 0 || rise < rx || spring >= base) throw new Error("lancetNodes needs rx > 0, rise >= rx and spring above base");
  const d = (rise * rise - rx * rx) / (2 * rx), radius = rx + d, phi = Math.atan2(rise, d);
  const arc = (centreX, from) => sampledNodes((t) => {
    const a = from + phi * t;
    return [centreX + radius * Math.cos(a), spring + radius * Math.sin(a), -radius * phi * Math.sin(a), radius * phi * Math.cos(a)];
  }, 0, 1, 1);
  const left = arc(cx + d, Math.PI), right = arc(cx - d, -phi);
  return [[cx - rx, base, 0, 0, 0, 0], [left[0][0], left[0][1], 0, 0, left[0][4], left[0][5]],
    [cx, spring - rise, left[1][2], left[1][3], right[0][4], right[0][5]],
    [right[1][0], right[1][1], right[1][2], right[1][3], 0, 0], [cx + rx, base, 0, 0, 0, 0]].map((n) => n.map((v) => v + 0));
}

/**
 * Pure function. Clockwise glass pieces from a (rows+1) x (cols+1) lattice of shared corners, each inset by
 * `gap` so the dark band left between neighbours IS the lead. Lattice rows run top to bottom, columns left to
 * right, so each cell's corners TL, TR, BR, BL are clockwise on screen (y down).
 * @param {number[][][]} lattice - [rows+1][cols+1] of [x, y] corners.
 * @param {number} gap - Inset distance on every side of every piece (lead is 2 * gap wide between pieces).
 * @returns {number[][][]} [rows*cols] arrays of four [x, y] corners, row-major.
 * @example latticeCells([[[0, 0], [1, 0]], [[0, 1], [1, 1]]], 0)[0] // [[0,0],[1,0],[1,1],[0,1]]
 */
export function latticeCells(lattice, gap) {
  finiteGeometry([gap, ...lattice.flat(2)]);
  const cells = [];
  for (let r = 0; r + 1 < lattice.length; r++) for (let c = 0; c + 1 < lattice[r].length; c++)
    cells.push(insetConvex([lattice[r][c], lattice[r][c + 1], lattice[r + 1][c + 1], lattice[r + 1][c]], gap));
  return cells;
}

/**
 * Pure function. The colour of each side of each boundary between stacked bands: boundary i separates band i
 * (above, LEFT of a west-to-east curve) from band i + 1 (below, RIGHT of it). Band colours are ramps along the
 * curves, so a band may drift through hues from one end to the other.
 * @param {string[][]} bands - [B][K] colour ramps, top band first, all the same length K.
 * @returns {{above: string[], below: string[]}[]} [B-1] pairs of [K] ramps (left side, right side).
 * @example bandSides([["#000000"], ["#ffffff"], ["#ff0000"]])[1].below // ["#ff0000"]
 */
export function bandSides(bands) {
  if (bands.length < 2 || bands.some((b) => b.length !== bands[0].length)) throw new Error("bandSides needs >= 2 bands of equal ramp length");
  return bands.slice(1).map((below, i) => ({ above: bands[i], below }));
}

const TEARDROP_SEGMENTS = 6;

/**
 * Pure function. Closed upright teardrop (neck at the top, belly below), clockwise on screen so rightColor is INSIDE.
 * x(t) = cx + w·sin t·taper(t), y(t) = cy − h·cos t, taper = neck + (1 − neck)(1 − cos t)/2, t from 0 (top) round.
 * @param {number} cx - Axis x.
 * @param {number} cy - Centre y (the bounding box centre).
 * @param {number} w - Half-width at the belly (> 0).
 * @param {number} h - Half-height (> 0).
 * @param {number} neck - Relative width at the very top, in [0, 1) (0 = a point, 1 = an ellipse).
 * @returns {number[][]} [6,6] tuples; close the feature.
 * @example teardropNodes(0.5, 0.5, 0.2, 0.4, 0.2)[0].slice(0, 2) // [0.5,0.1]
 */
export function teardropNodes(cx, cy, w, h, neck) {
  finiteGeometry([cx, cy, w, h, neck]);
  if (w <= 0 || h <= 0 || neck < 0 || neck >= 1) throw new Error("teardropNodes needs w, h > 0 and 0 <= neck < 1");
  return parametricNodes((t) => {
    const taper = neck + (1 - neck) * (1 - Math.cos(t)) / 2, dTaper = (1 - neck) * Math.sin(t) / 2;
    return [cx + w * Math.sin(t) * taper, cy - h * Math.cos(t), w * (Math.cos(t) * taper + Math.sin(t) * dTaper), h * Math.sin(t)];
  }, 0, 2 * Math.PI, TEARDROP_SEGMENTS, true);
}
