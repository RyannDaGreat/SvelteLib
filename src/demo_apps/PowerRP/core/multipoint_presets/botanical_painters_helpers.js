/**
 * Geometry and paint helpers for the "Botanical art" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { hermiteNodes, ellipseNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

// Cubic tip handle as a fraction of leaf length: sharp enough to read as a point.
const LEAF_TIP_HANDLE = 1 / 6;

// A cubic's midpoint moves 3/4 of its (equal) control offsets; 2/3·width → width/2 bulge.
const LEAF_BULGE_HANDLE = 2 / 3;

/**
 * Pure function. Closed polar curve r(θ) about a center, with exact tangents.
 * x = cx + r·cos θ, y = cy + r·sin θ; increasing θ is clockwise on screen, so on a
 * two-sided boundary `colors` is OUTSIDE and `rightColors` INSIDE. No duplicate end node.
 * @param {object} options - {cx,cy,radius,slope,segments,phase=0}; radius(θ) → r > 0, slope(θ) → dr/dθ.
 * @returns {number[][]} [segments,6] anchor/relative-handle tuples.
 * @example polarNodes({cx:0.5,cy:0.5,radius:()=>0.25,slope:()=>0,segments:4})[0].slice(0,2) // [0.75,0.5]
 */
export function polarNodes({ cx, cy, radius, slope, segments, phase = 0 }) {
  if (!Number.isInteger(segments) || segments < 3) throw new Error("Polar curve needs at least 3 segments");
  finiteGeometry([cx, cy, phase]);
  const samples = Array.from({ length: segments }, (_, i) => {
    const angle = phase + FULL_TURN * i / segments, r = radius(angle), dr = slope(angle);
    if (!(r > 0)) throw new Error("Polar radius must be positive");
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + r * c, cy + r * s, dr * c - r * s, dr * s + r * c];
  });
  return hermiteNodes(samples, FULL_TURN / segments);
}

/**
 * Pure function. Petalled closed outline r(θ) = R·(1 − depth·(1 − cos(petals·θ))/2).
 * Petal tips sit at θ = phase + k·2π/petals; two anchors per petal (tip and notch).
 * Measured: ≈2% of radius maximum radial error at depth 0.3 — a shape, not an exact rose.
 * @param {object} options - {cx,cy,radius,depth,petals,phase=0}; depth in [0,1).
 * @returns {number[][]} [2·petals,6] clockwise anchor/relative-handle tuples.
 * @example blossomNodes({cx:0.5,cy:0.5,radius:0.3,depth:0.5,petals:5}).length // 10
 */
export function blossomNodes({ cx, cy, radius, depth, petals, phase = 0 }) {
  finiteGeometry([radius, depth, petals]);
  if (!(radius > 0) || depth < 0 || depth >= 1 || !Number.isInteger(petals) || petals < 2)
    throw new Error("Blossom needs positive radius, depth in [0,1) and at least 2 petals");
  return polarNodes({ cx, cy, phase, segments: 2 * petals,
    radius: (a) => radius * (1 - depth * (1 - Math.cos(petals * (a - phase))) / 2),
    slope: (a) => -radius * depth * petals * Math.sin(petals * (a - phase)) / 2 });
}

/**
 * Pure function. Two-anchor closed leaf outline, clockwise on screen.
 * Pointed tip at center + length/2 along `angle`, base opposite; arcs bulge ≈ width/2.
 * `taper` scales the base's axial handle: 1 = symmetric pointed lens (almond),
 * 0 = smooth round base (teardrop leaf).
 * @param {object} options - {cx,cy,length,width,angle,taper=1}; angle in radians, y down.
 * @returns {number[][]} [2,6] anchor/relative-handle tuples (tip, base).
 * @example leafNodes({cx:0.5,cy:0.5,length:0.4,width:0.2,angle:0})[0].slice(0,2) // [0.7,0.5]
 * @example leafNodes({cx:0.5,cy:0.5,length:0.4,width:0.3,angle:0,taper:0})[1] // [0.3,0.5,0,0.2,0,-0.2]
 */
export function leafNodes({ cx, cy, length, width, angle, taper = 1 }) {
  finiteGeometry([cx, cy, length, width, angle, taper]);
  if (!(length > 0) || !(width > 0) || taper < 0) throw new Error("Leaf needs positive length/width and nonnegative taper");
  const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
  const a = length * LEAF_TIP_HANDLE, t = a * taper, b = width * LEAF_BULGE_HANDLE, half = length / 2;
  return [
    [cx + ux * half, cy + uy * half, -ux * a - nx * b, -uy * a - ny * b, -ux * a + nx * b, -uy * a + ny * b],
    [cx - ux * half, cy - uy * half, ux * t + nx * b, uy * t + ny * b, ux * t - nx * b, uy * t - ny * b],
  ];
}

/**
 * Pure function. A straight line lying EXACTLY on one box edge (nodes on 0 or 1, so the
 * solve domain never grows): the cheapest broad "wash" source.
 * @param {"top"|"bottom"|"left"|"right"} side - Box edge.
 * @param {string[]} colors - Ramp along the edge (left to right, or top to bottom).
 * @returns {object} Open single-sided feature, 2 nodes.
 * @example edgeLine("top", ["#ffffff"]).nodes[1].slice(0,2) // [1,0]
 */
export function edgeLine(side, colors) {
  const ends = { top: [[0, 0], [1, 0]], bottom: [[0, 1], [1, 1]], left: [[0, 0], [0, 1]], right: [[1, 0], [1, 1]] }[side];
  if (!ends) throw new Error("Unknown box edge: " + side);
  return boundary(polylineNodes(ends), colors);
}

/**
 * Pure function. All four box edges as ONE closed single-sided feature (4 nodes): a smooth
 * ground of a single colour (or a ramp travelling clockwise from the top-left corner).
 * @param {string[]} colors - One colour, or a ramp that must already repeat its first colour at the end.
 * @returns {object} Closed feature.
 * @example frame(["#000000"]).nodes.length // 4
 */
export function frame(colors) {
  return boundary(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), colors, null, true);
}

/**
 * Pure function. Re-addresses a feature's existing stops at explicit arc-length offsets,
 * for ramps that must change quickly over one part of a curve (boundary() spaces evenly).
 * @param {object} feature - Feature whose stop count matches offsets.length.
 * @param {number[]} offsets - Strictly increasing values in [0,1].
 * @returns {object} Copy with the same colours at the new offsets.
 * @example withStopOffsets(boundary([[0,0,0,0,0,0],[1,0,0,0,0,0]], ["#000000","#ffffff"]), [0,0.2]).stops[1].offset // 0.2
 */
export function withStopOffsets(feature, offsets) {
  finiteGeometry(offsets);
  if (offsets.length !== feature.stops.length || offsets.some((o, i) => o < 0 || o > 1 || (i && o <= offsets[i - 1])))
    throw new Error("Stop offsets must match the stop count and increase strictly within [0,1]");
  return { ...feature, stops: feature.stops.map((stop, i) => ({ ...stop, offset: offsets[i] })) };
}

/**
 * Pure function. Closed "cusped star": sharp outer tips joined by smoothly curving spans that
 * sink to rounded notches — a trumpet / morning-glory / lily silhouette. Tips are zero-handle
 * corners; each notch has a tangential handle of `sag`·(notch radius). Clockwise on screen, first
 * anchor is the tip at `phase`; two-sided `colors` is OUTSIDE, `rightColors` INSIDE.
 * @param {object} o - {cx,cy,outer,inner,points,phase=0,sag=0.5,rx=1,ry=1}; rx/ry squash the result.
 * @returns {number[][]} [2·points,6] anchor/relative-handle tuples.
 * @example cuspedStarNodes({cx:0.5,cy:0.5,outer:0.4,inner:0.15,points:5}).length // 10
 */
export function cuspedStarNodes({ cx, cy, outer, inner, points, phase = 0, sag = 0.5, rx = 1, ry = 1 }) {
  finiteGeometry([cx, cy, outer, inner, points, phase, sag, rx, ry]);
  if (!(outer > inner) || !(inner > 0) || !Number.isInteger(points) || points < 2) throw new Error("Cusped star needs outer > inner > 0 and at least 2 points");
  return Array.from({ length: 2 * points }, (_, i) => {
    const a = phase + Math.PI * i / points, c = Math.cos(a), s = Math.sin(a);
    const x = cx + rx * (i % 2 ? inner : outer) * c, y = cy + ry * (i % 2 ? inner : outer) * s;
    if (i % 2 === 0) return [x, y, 0, 0, 0, 0];
    const h = inner * sag * Math.PI / points;
    return [x, y, rx * h * s, -ry * h * c, -rx * h * s, ry * h * c];
  });
}

/**
 * Pure function. A closed two-sided shape whose inside ramp is given (repeating first colour
 * at the end is done here). One ground colour outside.
 * @param {number[][]} nodes - Clockwise closed nodes.
 * @param {string} ground - Colour outside the rim.
 * @param {string[]} ramp - Open inside ramp (<=3 colours; first repeats at the end).
 * @returns {object} Closed two-sided feature.
 * @example shaded(ellipseNodes(0.5,0.5,0.2), "#000000", ["#ffffff","#888888"]).stops.length // 3
 */
export function shaded(nodes, ground, ramp) {
  const r = closedRamp(ramp);
  return boundary(nodes, r.map(() => ground), r, true);
}

/**
 * Pure function. A two-node petal/leaf with SIDE lighting: the closed inside ramp runs
 * tip -> right side -> left side -> tip, stops at 0, 1/4, 3/4, 1 (mid-arc of each side), so one flank can be
 * lit and the other in shadow while tip and base blend. "Right" = the screen-right flank when
 * looking from the base toward the tip (clockwise travel leaves the tip down that flank first).
 * @param {object} o - {bx,by,tx,ty,width,taper=0.5,ground,tip,right,left}.
 * @returns {object} Closed two-sided feature, 2 nodes, 4 stops.
 * @example sidePetal({bx:0.5,by:0.9,tx:0.5,ty:0.1,width:0.2,ground:"#000000",tip:"#ffffff",right:"#888888",left:"#222222"}).nodes.length // 2
 */
export function sidePetal({ bx, by, tx, ty, width, taper = 0.5, ground, tip, right, left }) {
  const nodes = leafNodes({ cx: (bx + tx) / 2, cy: (by + ty) / 2, length: Math.hypot(tx - bx, ty - by), width, angle: Math.atan2(ty - by, tx - bx), taper });
  return withStopOffsets(boundary(nodes, [ground, ground, ground, ground], [tip, right, left, tip], true), [0, 0.25, 0.75, 1]);
}
