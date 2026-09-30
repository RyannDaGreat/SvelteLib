/**
 * "Fluid & materials" Multipoint presets (draft for the lead to merge).
 * Geometry helpers are pure builders in the catalog's house style; each returns
 * [N,6] anchor/relative-handle tuples (or [N,2] anchors) in the unit paint box, y down.
 * Side convention (verified by render): walking a curve on screen, rightColor lies to
 * the walker's right — BELOW a left-to-right curve, INSIDE a clockwise closed curve.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { hermiteNodes, ellipseNodes, waveNodes, finiteGeometry } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
const MAX_ANGLE_STEP = Math.PI / 4; // same eight-spans-per-turn budget as spiralNodes
const EDGE_OVERHANG = 0.02; // edge lines poke past the box so its corners are covered

/**
 * Pure function. Smooth Catmull-Rom path through anchors, as editable cubic nodes.
 * Each anchor's tangent is half the chord between its neighbours (one-sided at open ends).
 * @param {number[][]} points - [N,2] (x,y) anchors, N ≥ 2.
 * @param {boolean} closed - Wrap tangents around the seam (pair with a closed feature).
 * @returns {number[][]} [N,6] anchor/relative-handle tuples.
 * @example smoothNodes([[0,0],[0.5,0.5],[1,0]])[1] // [0.5,0.5,-1/6,-0,1/6,0]
 */
export function smoothNodes(points, closed = false) {
  if (points.length < 2) throw new Error("smoothNodes needs at least two anchors");
  finiteGeometry(points.flat());
  const n = points.length;
  const at = (i) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  return hermiteNodes(points.map(([x, y], i) => {
    const [ax, ay] = at(i - 1), [bx, by] = at(i + 1);
    const span = closed || (i > 0 && i < n - 1) ? 2 : 1;
    return [x, y, (bx - ax) / span, (by - ay) / span];
  }), 1);
}

/**
 * Pure function. Moves each anchor sideways along its smoothNodes normal by its own distance.
 * Pair a colour curve with offset "guard" curves to set how wide its ridge spreads:
 * diffusion ramps linearly across the gap, so a small offset makes a hairline.
 * Positive distances go to the walker's right on screen (below a left-to-right curve).
 * @param {number[][]} points - [N,2] (x,y) anchors, N ≥ 2, as given to smoothNodes.
 * @param {number[]} distances - [N] signed offsets, one per anchor.
 * @param {boolean} closed - Use wrapped tangents, matching smoothNodes(points, true).
 * @returns {number[][]} [N,2] offset anchors.
 * @example offsetPoints([[0,0],[1,0]], [0.1,0.2]) // [[0,0.1],[1,0.2]]
 */
export function offsetPoints(points, distances, closed = false) {
  if (points.length < 2 || distances.length !== points.length) throw new Error("offsetPoints needs ≥ 2 anchors and one distance per anchor");
  finiteGeometry([...points.flat(), ...distances]);
  const n = points.length;
  const at = (i) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  return points.map(([x, y], i) => {
    const [ax, ay] = at(i - 1), [bx, by] = at(i + 1), length = Math.hypot(bx - ax, by - ay);
    if (!length) throw new Error("offsetPoints cannot find a normal where neighbouring anchors coincide");
    return [x - distances[i] * (by - ay) / length, y + distances[i] * (bx - ax) / length];
  });
}

/**
 * Pure function. Closed organic blob: an ellipse whose radius wobbles by Fourier lobes.
 * ρ(θ) = 1 + Σ amp_k·cos(k·θ + phase_k); x = cx + rx·ρ·cos θ, y = cy + ry·ρ·sin θ.
 * θ increases from `start` (where the colour ramp begins), clockwise on screen like ellipseNodes.
 * @param {object} options - {cx,cy,rx,ry=rx,lobes=[[k,amp,phase]...],count=8,start=0}; Σ|amp| < 1.
 * @returns {number[][]} [count,6] anchor/relative-handle tuples (close the feature).
 * @example blobNodes({cx:0.5,cy:0.5,rx:0.2,count:4})[0].slice(0,2) // [0.7,0.5]
 */
export function blobNodes({ cx, cy, rx, ry = rx, lobes = [], count = 8, start = 0 }) {
  finiteGeometry([cx, cy, rx, ry, count, start, ...lobes.flat()]);
  if (rx <= 0 || ry <= 0 || !Number.isInteger(count) || count < 3) throw new Error("Blob radii must be positive and count an integer ≥ 3");
  if (lobes.reduce((sum, [, amp]) => sum + Math.abs(amp), 0) >= 1) throw new Error("Blob lobe amplitudes must sum below 1 (radius stays positive)");
  const step = FULL_TURN / count;
  return hermiteNodes(Array.from({ length: count }, (_, i) => {
    const theta = start + step * i, c = Math.cos(theta), s = Math.sin(theta);
    const rho = 1 + lobes.reduce((sum, [k, amp, phase]) => sum + amp * Math.cos(k * theta + phase), 0);
    const drho = lobes.reduce((sum, [k, amp, phase]) => sum - amp * k * Math.sin(k * theta + phase), 0);
    return [cx + rx * rho * c, cy + ry * rho * s, rx * (drho * c - rho * s), ry * (drho * s + rho * c)];
  }), step);
}

/**
 * Pure function. Open elliptical arc from angle `from` to `to` (radians, screen y down).
 * @param {object} options - {cx,cy,rx,ry=rx,from,to}; to ≠ from; to > from runs clockwise on screen.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 3 nodes for a quarter turn.
 * @example arcNodes({cx:0.5,cy:0.5,rx:0.25,from:0,to:Math.PI/2})[0].slice(0,2) // [0.75,0.5]
 */
export function arcNodes({ cx, cy, rx, ry = rx, from, to }) {
  const sweep = to - from;
  finiteGeometry([cx, cy, rx, ry, from, to]);
  if (rx <= 0 || ry <= 0 || sweep === 0) throw new Error("Arc radii must be positive and sweep nonzero");
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP));
  return hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => {
    const theta = from + sweep * i / segments;
    return [cx + rx * Math.cos(theta), cy + ry * Math.sin(theta), -rx * sweep * Math.sin(theta), ry * sweep * Math.cos(theta)];
  }), 1 / segments);
}

/**
 * Pure function. Rotated rectangle corners as sharp (zero-handle) nodes, clockwise on screen.
 * @param {object} options - {cx,cy,w,h,angle=0}; angle in radians, positive turns clockwise on screen.
 * @returns {number[][]} [4,6] tuples starting at the top-left corner.
 * @example rectNodes({cx:0.5,cy:0.5,w:0.2,h:0.2})[0] // [0.4,0.4,0,0,0,0]
 */
export function rectNodes({ cx, cy, w, h, angle = 0 }) {
  finiteGeometry([cx, cy, w, h, angle]);
  if (w <= 0 || h <= 0) throw new Error("Rectangle sides must be positive");
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const dx = u * w / 2, dy = v * h / 2;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c, 0, 0, 0, 0];
  });
}

/**
 * Pure function. Moves each polygon vertex toward the vertex centroid by a fixed distance.
 * @param {number[][]} points - [N,2] (x,y) vertices, none at the centroid.
 * @param {number} inset - Distance each vertex moves (e.g. half a fissure's width).
 * @returns {number[][]} [N,2] inset vertices.
 * @example insetPolygon([[1,0],[2,1],[1,2],[0,1]], 0.5) // [[1,0.5],[1.5,1],[1,1.5],[0.5,1]]
 */
export function insetPolygon(points, inset) {
  finiteGeometry([...points.flat(), inset]);
  const cx = points.reduce((s, [x]) => s + x, 0) / points.length, cy = points.reduce((s, [, y]) => s + y, 0) / points.length;
  return points.map(([x, y]) => {
    const d = Math.hypot(cx - x, cy - y);
    if (!d) throw new Error("insetPolygon vertex sits on the centroid; no direction to move");
    return [x + (cx - x) * inset / d, y + (cy - y) * inset / d];
  });
}

/**
 * Pure function. A constant palette of `count` stops, to pair with a ramp on the other side.
 * @param {string} color - The single colour.
 * @param {number} count - Stops, matching the opposite palette's length.
 * @returns {string[]} [count] copies.
 * @example solid("#000000", 3) // ["#000000","#000000","#000000"]
 */
function solid(color, count) {
  return Array(count).fill(color);
}

/**
 * Pure function. Translates anchors horizontally.
 * @param {number[][]} points - [N,2] (x,y) anchors.
 * @param {number} dx - Horizontal shift.
 * @returns {number[][]} [N,2] shifted anchors.
 * @example shiftX([[0.25,0.5]], 0.25) // [[0.5,0.5]]
 */
function shiftX(points, dx) {
  return points.map(([x, y]) => [x + dx, y]);
}

/**
 * Pure function. A straight single-sided line across the box at height y: pins one edge's colour.
 * Two of these (top and bottom) give an exact vertical background gradient, unlike weak points.
 * @param {number} y - Height in the unit box.
 * @param {string} color - Pinned colour.
 * @returns {object} Two-node open feature.
 * @example edgeLine(0, "#000000").nodes[1] // [1.02,0,0,0,0,0]
 */
function edgeLine(y, color) {
  return boundary([[-EDGE_OVERHANG, y, 0, 0, 0, 0], [1 + EDGE_OVERHANG, y, 0, 0, 0, 0]], [color]);
}

/**
 * Pure function. A closed single-sided ramp around the paint box border: a background that
 * the interior diffuses toward, without the visible dimples corner point sources leave.
 * @param {string[]} colors - Open ramp walked clockwise from the top-left corner.
 * @returns {object} Closed four-node feature.
 * @example boxFrame(["#000000", "#ffffff"]).stops.length // 3
 */
function boxFrame(colors) {
  return boundary(rectNodes({ cx: 0.5, cy: 0.5, w: 1, h: 1 }), colors.length > 1 ? closedRamp(colors) : colors, null, true);
}

// Vein spine + per-anchor half-width to its white guards (the gap sets how far the grey feathers).
const MARBLE_MAIN = [[-0.05, 0.1], [0.2, 0.22], [0.42, 0.3], [0.6, 0.52], [0.8, 0.66], [1.05, 0.9]];
const MARBLE_MAIN_WIDTH = [0.06, 0.02, 0.04, 0.012, 0.05, 0.08];
const MARBLE_BRANCH = [[-0.05, 0.56], [0.18, 0.63], [0.35, 0.78], [0.55, 0.86], [0.72, 1.05]];
const MARBLE_BRANCH_WIDTH = [0.05, 0.014, 0.03, 0.018, 0.05];
// Smoke threads rise bottom → top; each is flanked by charcoal guards this far to either side.
const WISPS = [[[0.3, 1.05], [0.36, 0.76], [0.25, 0.52], [0.37, 0.3], [0.3, 0.12], [0.18, 0.06]],
  [[0.7, 1.05], [0.64, 0.82], [0.75, 0.62], [0.62, 0.44], [0.66, 0.27], [0.8, 0.2]]];
const WISP_GUARD = 0.09;
// Jittered 4×3 lattice → six quad cells; each cell is shrunk toward its centroid to leave a fissure.
const OPAL_LATTICE = [[[-0.05, -0.05], [0.36, -0.05], [0.66, -0.05], [1.05, -0.05]],
  [[-0.05, 0.47], [0.3, 0.55], [0.7, 0.42], [1.05, 0.52]],
  [[-0.05, 1.05], [0.38, 1.05], [0.62, 1.05], [1.05, 1.05]]];
const OPAL_FISSURE = 0.02;
const INK_LINE_WIDTH = 0.045; // paper guard ring sits this far inside each ink ring

export const PRESETS = [
  preset("carrara-marble", "Carrara marble", "Grey veins feathering diagonally through warm white stone.", [
    ...[[MARBLE_MAIN, MARBLE_MAIN_WIDTH, ["#a29d96", "#5f5b57", "#8a857f", "#b3aea7"]], [MARBLE_BRANCH, MARBLE_BRANCH_WIDTH, ["#c2bdb6", "#7d7872", "#a39e98"]]]
      .flatMap(([vein, widths, colors]) => [
        boundary(smoothNodes(offsetPoints(vein, widths.map((w) => -w))), ["#f8f6f2", "#f1eee9"]),
        boundary(smoothNodes(vein), colors),
        boundary(smoothNodes(offsetPoints(vein, widths)), ["#f4f1ec", "#faf8f5"]),
      ]),
  ]),
  preset("watercolor-bloom", "Watercolor bloom", "Two wet-in-wet blooms with dark pigment rims and pale hearts on a soft blue wash.", [
    boxFrame(["#fbfaf6", "#f5f2ea", "#faf8f3"]),
    boundary(blobNodes({ cx: 0.5, cy: 0.52, rx: 0.44, ry: 0.4, lobes: [[3, 0.08, 1], [5, 0.04, 0]], count: 7 }), ["#c3d5e8"], null, true),
    ...[[0.37, 0.39, 0.2, ["#2f5f99", "#1f4b86", "#3f70ad"], "#dbe6f1", 0.3], [0.64, 0.65, 0.12, ["#1c6b78", "#2a8088", "#15596a"], "#d8ece9", 2.1]]
      .flatMap(([cx, cy, r, rim, heart, phase]) => [
        boundary(blobNodes({ cx, cy, rx: r, lobes: [[5, 0.07, phase], [7, 0.04, 2 * phase]] }), solid("#a9c1dc", 4), closedRamp(rim), true),
        boundary(blobNodes({ cx, cy, rx: r * 0.45, lobes: [[3, 0.08, phase]], count: 5 }), [heart], null, true),
      ]),
  ]),
  preset("oil-slick", "Oil slick", "Thin-film rainbow bands floating on wet black asphalt.", [
    boxFrame(["#0c0e13", "#12151c", "#0a0c10"]),
    ...[[0.44, ["#0d1016"]], [0.37, closedRamp(["#7a3fb0", "#2a8fd9", "#3fcf8a"])], [0.29, ["#0e1118"]], [0.22, closedRamp(["#f0bf41", "#e2476f", "#f08a3c"])],
      [0.15, ["#10131b"]], [0.08, closedRamp(["#39d7c8", "#6d58e6", "#a7f06a"])]].map(([r, colors], i) => boundary(
      blobNodes({ cx: 0.48 + 0.012 * i, cy: 0.52 - 0.008 * i, rx: r, ry: r * 0.84, lobes: [[2, 0.08, 0.5 + 0.4 * i], [3, 0.06, 2 - 0.3 * i]], count: i < 4 ? 6 : 5 }),
      colors, null, true)),
  ]),
  preset("holo-foil", "Holo foil", "Diagonal holographic facets sliding from brushed silver into vivid pastel.",
    [0, 1, 2, 3].map((i) => boundary(smoothNodes([[-0.12 + 0.28 * i, 1.08], [0.1 + 0.28 * i, 0.5], [0.33 + 0.28 * i, -0.08]]),
      [["#ff9ad9", "#8fe9ff", "#c9a8ff"], ["#9dffc8", "#ffb0e4", "#9cc4ff"], ["#d2a8ff", "#96ffe6", "#ffd39a"], ["#8fe9ff", "#ffbcdc", "#a8ffc4"]][i],
      [["#aeaacd", "#e4e1f4", "#9f9bc4"], ["#e8e6f6", "#a3a0c8", "#d6d3ec"], ["#a7a3ca", "#e2dff3", "#b2aed2"], ["#e4e1f4", "#aca8cd", "#ebe9f7"]][i]))),
  preset("liquid-chrome", "Liquid chrome", "A rippled horizon splitting cobalt sky reflections from dark polished ground.", [
    edgeLine(-0.02, "#16346c"),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.32, amplitude: 0.04, cycles: 1.5 }), ["#5c8ad0"], ["#b9d3f2"]),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.56, amplitude: 0.06, cycles: 1.25, phase: 1 }), ["#fbfcff"], ["#15100d"]),
    edgeLine(1.02, "#d4ae84"),
  ]),
  preset("molten-gold", "Molten gold", "A lip of liquid gold sagging into two heavy drips over black.", [
    edgeLine(0, "#8a5412"),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.14, amplitude: 0.025, cycles: 1 }), ["#fff1b8", "#ffe28a", "#fff4c8"]),
    boundary(smoothNodes([[-0.05, 0.3], [0.1, 0.34], [0.15, 0.55], [0.19, 0.61], [0.23, 0.55], [0.29, 0.37], [0.47, 0.39],
      [0.5, 0.74], [0.545, 0.81], [0.59, 0.74], [0.63, 0.41], [0.8, 0.35], [1.05, 0.32]]),
      ["#c98a1f", "#f2b93f", "#d99a2a", "#f5c451"], ["#140d06", "#0b0704", "#120b05", "#0d0805"]),
    edgeLine(1, "#241608"),
  ]),
  preset("pearl-drops", "Pearl drops", "Three lustrous pearls with pink-green orient on navy velvet.", [
    boxFrame(["#1b2340", "#121a33", "#0e142a"]),
    ...[[0.36, 0.38, 0.22], [0.74, 0.7, 0.14], [0.26, 0.8, 0.08]].flatMap(([cx, cy, r]) => [
      boundary(blobNodes({ cx, cy, rx: r, lobes: [[2, 0.03, 0]], start: -Math.PI / 2, count: 6 }),
        solid("#161d38", 4), closedRamp(["#fffaf2", "#d9b7c4", "#a7b8b0"]), true),
      point(cx - r * 0.35, cy - r * 0.4, "#ffffff"),
    ]),
  ]),
  preset("sapphire-satin", "Sapphire satin", "Blue silk folds falling from a gathered corner, each with a crisp sheen.",
    [0, 1, 2, 3, 4].map((i) => {
      const hem = 0.05 + 0.25 * i, highlight = i % 2 === 0;
      return boundary(smoothNodes([[0.08, -0.06], [0.15 + 0.12 * i, 0.3], [hem + 0.05, 0.65], [hem, 1.08]]),
        highlight ? ["#1a2b5c", "#8fb0ec", "#dbe7ff"] : ["#070d24", "#0d1a45", "#16275e"]);
    })),
  preset("gilded-bole", "Gilded bole", "Four gold-leaf squares over red clay bole, each catching light differently.",
    [[0.27, 0.27, 0.05], [0.74, 0.26, -0.06], [0.26, 0.74, -0.04], [0.74, 0.74, 0.07]].map(([cx, cy, angle], i) => boundary(
      rectNodes({ cx, cy, w: 0.44, h: 0.44, angle }), closedRamp(["#7d2e1c", "#8e3a22", "#6f2718"]),
      closedRamp([["#fff2b3", "#e2af45", "#a8751f"], ["#f5d77c", "#c48a25", "#fbe7a1"], ["#e8bc55", "#fff0b8", "#b98226"], ["#fde6a0", "#d19b34", "#f0c969"]][i]), true))),
  preset("black-opal", "Black opal", "Harlequin flashes of green, cyan and fire glinting out of dark stone.",
    [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]].map(([r, c], i) => boundary(
      insetPolygon([OPAL_LATTICE[r][c], OPAL_LATTICE[r][c + 1], OPAL_LATTICE[r + 1][c + 1], OPAL_LATTICE[r + 1][c]], OPAL_FISSURE).map(([x, y]) => [x, y, 0, 0, 0, 0]),
      solid("#080d26", 4),
      closedRamp([["#2df0a0", "#0b1238", "#1a9cff"], ["#ff6a2e", "#0d1238", "#ffb52e"], ["#7b4dff", "#0a1034", "#23d6e0"],
        ["#1ec8ff", "#0b1238", "#b8ff3a"], ["#3b5bff", "#0d1036", "#ff3dbb"], ["#ffc02e", "#0a1238", "#16c9a8"]][i]), true))),
  preset("smoke-wisps", "Smoke wisps", "Two pale threads curling upward between charcoal currents, fading at both ends.",
    WISPS.flatMap((wisp, i) => [
      boundary(smoothNodes(shiftX(wisp, -WISP_GUARD)), ["#121419"]),
      boundary(smoothNodes(wisp), [["#1b1e24", "#d5dae1", "#8d949e", "#1c1f25"], ["#1b1e24", "#b9c0c9", "#6f7680", "#1c1f25"]][i]),
      boundary(smoothNodes(shiftX(wisp, WISP_GUARD)), ["#15171c"]),
    ])),
  preset("lava-lamp", "Lava lamp", "Molten orange blobs rising through glowing violet wax.", [
    edgeLine(0, "#1f0833"), edgeLine(1, "#7d1f5e"),
    ...[[0.56, 0.24, 0.2, 0.15, [[3, 0.1, 0.3]]], [0.38, 0.62, 0.12, 0.19, [[2, 0.12, 0], [3, 0.05, 1]]], [0.72, 0.84, 0.07, 0.07, []]].flatMap(([cx, cy, rx, ry, lobes]) => [
      boundary(blobNodes({ cx, cy, rx, ry, lobes, count: lobes.length ? 8 : 4, start: Math.PI / 2 }),
        closedRamp(["#4a1260", "#35104a", "#35104a"]), closedRamp(["#ff9a3c", "#ff4f6a", "#ff4f6a"]), true),
      point(cx, cy + ry * 0.2, "#ffd36b"),
    ]),
  ]),
  preset("soap-bubble", "Soap bubble", "Thin-film bubbles whose rims swirl magenta, gold and cyan over soft air.", [
    boxFrame(["#c7d4e6", "#dfe7f1", "#eef2f7"]),
    boundary(ellipseNodes(0.42, 0.53, 0.32), solid("#c9d6e8", 4), closedRamp(["#e37fd0", "#ffd36e", "#5fd6ec"]), true),
    boundary(ellipseNodes(0.42, 0.53, 0.22), ["#dde6f1"], null, true),
    boundary(arcNodes({ cx: 0.42, cy: 0.53, rx: 0.27, from: Math.PI * 1.08, to: Math.PI * 1.42 }), ["#ffffff"]),
    boundary(ellipseNodes(0.82, 0.19, 0.1), solid("#cfdbea", 4), closedRamp(["#72dcc9", "#b98af0", "#ffc27e"]), true),
    point(0.82, 0.19, "#dfe7f1"),
  ]),
  preset("ink-marbling", "Ink marbling", "Suminagashi rings of indigo ink floating on cream paper.",
    [0.42, 0.29, 0.16].flatMap((r, i) => {
      const ring = blobNodes({ cx: 0.48 + 0.02 * i, cy: 0.5 - 0.015 * i, rx: r, ry: r * 0.92, lobes: [[3, 0.06, i], [2, 0.05, 2 * i]], count: 6 })
        .map(([x, y]) => [x, y]);
      return [boundary(smoothNodes(ring, true), solid("#f4ecdc", 4), closedRamp(["#223157", "#2b3d6b", "#1b284a"]), true),
        boundary(smoothNodes(offsetPoints(ring, solid(INK_LINE_WIDTH, ring.length), true), true), ["#f3ebdb"], null, true)];
    })),
];

