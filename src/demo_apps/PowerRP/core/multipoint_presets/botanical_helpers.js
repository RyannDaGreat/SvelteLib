/**
 * Geometry and paint helpers shared by the "Botanical art" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary, point } from "./builders.js";
import { hermiteNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

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
 * Pure function. All four box edges as ONE closed single-sided feature (4 nodes): a smooth
 * ground of a single colour (or a ramp travelling clockwise from the top-left corner).
 * @param {string[]} colors - One colour, or a ramp that must already repeat its first colour at the end.
 * @returns {object} Closed feature.
 * @example frame(["#000000"]).nodes.length // 4
 */
export function frame(colors) {
  return boundary(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), colors, null, true);
}
