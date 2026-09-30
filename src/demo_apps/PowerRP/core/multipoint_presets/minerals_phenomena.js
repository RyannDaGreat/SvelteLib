/**
 * "Minerals & phenomena" Multipoint presets:
 * banded stones, iridescence, twilight skies, water light and bioluminescence, each
 * traced to a studied photograph (sources: concerns.md, 2026-09-30). Coordinates are the unit paint box
 * (y down) and ALL geometry stays inside [0,1]. Side convention (verified by render):
 * `colors` = the walker's LEFT (above a left→right line, OUTSIDE a clockwise loop),
 * `rightColors` = RIGHT (below, INSIDE).
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { catmullRomNodes, ellipseNodes, polylineNodes, rectNodes, spiralNodes, hermiteNodes, finiteGeometry, mixHex }
  from "../multipoint_shapes.js";
import { blobNodes, insetPolygon, rectNodes as turnedRectNodes } from "./fluid_materials.js";
import { leafNodes, withStopOffsets } from "./nature.js";

const EIGHTH_TURN = Math.PI / 4; // spiralNodes' span: accurate for varying radii
// A quarter-circle cubic is already within 0.03% of the circle, so constant-radius
// arcs may take quarter-turn spans and spend a third of the node budget.
const QUARTER_TURN = Math.PI / 2;
const EDGE_SNAP = 1e-9; // anchors this close to a box edge are placed ON it (no solve-domain growth)

/**
 * Pure function. Places anchors within EDGE_SNAP of a box edge exactly on it, so trig
 * round-off (cos(−π) = −1 − ε) cannot grow the square solve domain past the unit box.
 * @param {number[][]} nodes - [N,6] anchor/relative-handle tuples.
 * @returns {number[][]} [N,6] copies, anchors snapped.
 * @example snapToBox([[-1e-17, 0.5, 0, 0, 0, 0]]) // [[0,0.5,0,0,0,0]]
 */
export function snapToBox(nodes) {
  finiteGeometry(nodes.flat());
  const snap = (v) => (Math.abs(v) < EDGE_SNAP ? 0 : Math.abs(v - 1) < EDGE_SNAP ? 1 : v);
  return nodes.map(([x, y, ...handles]) => [snap(x), snap(y), ...handles]);
}

/**
 * Pure function. Zeroes an open chain's two unused handles (the first node's incoming,
 * the last node's outgoing): hermiteNodes mirrors them, and on an arc that starts on a
 * box edge the mirror points far outside the box while drawing nothing.
 * @param {number[][]} nodes - [N,6] open-chain tuples.
 * @returns {number[][]} [N,6] copies with those two handles zero.
 * @example trimOpenHandles([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function trimOpenHandles(nodes) {
  const out = nodes.map((node) => [...node]);
  out[0][2] = out[0][3] = 0;
  out.at(-1)[4] = out.at(-1)[5] = 0;
  return out;
}

/**
 * Pure function. Two single-sided rails on the box's left and right edges carrying one
 * top→bottom ramp: a multi-stop vertical background with no interior crease (a line
 * across the box leaves a ridge; rails on the edges do not).
 * @param {string[]} colors - Top→bottom ramp, 1..4 stops.
 * @param {number} bottom - Where the rails end (a horizon line may continue below).
 * @param {number[]|null} offsets - Optional explicit arc-length offsets for the stops.
 * @returns {object[]} Two open features, [2,6] nodes each.
 * @example sideRails(["#000000", "#ffffff"], 0.5)[1].nodes // [[1,0,0,0,0,0],[1,0.5,0,0,0,0]]
 */
export function sideRails(colors, bottom = 1, offsets = null) {
  finiteGeometry([bottom]);
  if (!(bottom > 0 && bottom <= 1)) throw new Error(`sideRails bottom must lie in (0,1], got ${bottom}`);
  return [0, 1].map((x) => {
    const rail = boundary(polylineNodes([[x, 0], [x, bottom]]), colors);
    return offsets ? withStopOffsets(rail, offsets) : rail;
  });
}

/**
 * Pure function. Open polar arc r(θ) about a centre with exact tangents, θ in screen
 * radians (y down): increasing θ runs clockwise on screen, so `rightColors` faces the centre.
 * x = cx + r·cos θ, y = cy + r·sin θ. Anchors landing on a box edge are snapped onto it and
 * the two unused end handles are zeroed (open arcs only).
 * @param {object} options - {cx,cy,from,to,radius,slope=()=>0,maxStep=π/4}; radius(θ) → r > 0,
 *   slope(θ) → dr/dθ; a constant radius may use maxStep = π/2 (quarter-circle accuracy).
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 3 nodes for a quarter turn at π/4.
 * @example polarArcNodes({cx:0, cy:1, from:-Math.PI/2, to:0, radius:() => 0.5}).map((n) => n.slice(0, 2).map((v) => +v.toFixed(3))) // [[0,0.5],[0.354,0.646],[0.5,1]]
 * @example polarArcNodes({cx:0, cy:1, from:-Math.PI/2, to:0, radius:() => 0.5, maxStep:Math.PI/2}).length // 2
 */
export function polarArcNodes({ cx, cy, from, to, radius, slope = () => 0, maxStep = EIGHTH_TURN }) {
  const sweep = to - from;
  finiteGeometry([cx, cy, from, to, maxStep]);
  if (sweep === 0 || !(maxStep > 0)) throw new Error("polarArcNodes needs a nonzero sweep and a positive step");
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep - 1e-9));
  return trimOpenHandles(snapToBox(hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => {
    const angle = from + sweep * i / segments, r = radius(angle), dr = slope(angle);
    if (!(r > 0)) throw new Error(`polarArcNodes radius must be positive, got ${r}`);
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + r * c, cy + r * s, sweep * (dr * c - r * s), sweep * (dr * s + r * c)];
  }), 1 / segments)));
}

/**
 * Pure function. The screen angles where a circle about (cx, cy) crosses the box's left
 * and right edges on its upper half — the span of a fan band clipped to the unit box.
 * @param {number} cx - Centre x in (0,1).
 * @param {number} r - Radius.
 * @returns {number[]} [from, to] radians in [−π, 0]; the full upper half when r ≤ min(cx, 1−cx).
 * @example upperSpan(0.5, 0.25) // [-3.141592653589793, 0]
 * @example upperSpan(0.5, 1).map((a) => +a.toFixed(4)) // [-2.0944,-1.0472]
 */
export function upperSpan(cx, r) {
  finiteGeometry([cx, r]);
  if (!(r > 0) || !(cx > 0 && cx < 1)) throw new Error("upperSpan needs r > 0 and a centre inside the box");
  const from = r <= cx ? -Math.PI : -Math.acos(-cx / r);
  const to = r <= 1 - cx ? 0 : -Math.acos((1 - cx) / r);
  return [from, to];
}

/**
 * Pure function. Distance from an interior point to the unit box's edge along a direction.
 * @param {number} x - Start x in [0,1].
 * @param {number} y - Start y in [0,1].
 * @param {number} angle - Screen radians (y down).
 * @returns {number} Nonnegative distance.
 * @example distanceToEdge(0.5, 0.5, 0) // 0.5
 * @example +distanceToEdge(0.5, 0.5, Math.PI / 4).toFixed(4) // 0.7071
 */
export function distanceToEdge(x, y, angle) {
  finiteGeometry([x, y, angle]);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const hits = [dx > 1e-12 ? (1 - x) / dx : Infinity, dx < -1e-12 ? -x / dx : Infinity,
    dy > 1e-12 ? (1 - y) / dy : Infinity, dy < -1e-12 ? -y / dy : Infinity];
  return Math.min(...hits);
}

/**
 * Pure function. A gently swirled ray from radius r0 about a centre out to the box edge:
 * anchors at r0, the midpoint and the edge, the midpoint twisted by `twist` radians.
 * @param {object} options - {cx,cy,angle,r0,twist=0}; angle in screen radians.
 * @returns {number[][]} [3,6] Catmull–Rom nodes ending exactly on the box edge.
 * @example swirlRayNodes({cx:0.5, cy:0.5, angle:0, r0:0.1}).at(-1).slice(0, 2) // [1,0.5]
 */
export function swirlRayNodes({ cx, cy, angle, r0, twist = 0 }) {
  const reach = distanceToEdge(cx, cy, angle);
  if (!(r0 > 0 && r0 < reach)) throw new Error("swirlRayNodes needs 0 < r0 < distance to the box edge");
  const mid = (r0 + reach) / 2, a = angle + twist;
  if (mid >= distanceToEdge(cx, cy, a)) throw new Error("swirlRayNodes: the twisted midpoint leaves the box");
  return snapToBox(catmullRomNodes([[cx + r0 * Math.cos(angle), cy + r0 * Math.sin(angle)],
    [cx + mid * Math.cos(a), cy + mid * Math.sin(a)], [cx + reach * Math.cos(angle), cy + reach * Math.sin(angle)]]));
}

/**
 * Pure function. Closed polygon path whose edge i bends by moving BOTH its control points by
 * the same vector bends[i]. Two cells sharing an edge and passing the same vector draw the same
 * curve (up to their inset), so the seam between them stays evenly wide. Corners stay sharp.
 * Edge i is the cubic V_i, V_i + (V_(i+1) − V_i)/3 + b_i, V_(i+1) − (V_(i+1) − V_i)/3 + b_i, V_(i+1);
 * its midpoint moves 3/4·b_i.
 * @param {number[][]} vertices - [N,2] corners in order (clockwise puts rightColors inside).
 * @param {number[][]} bends - [N,2] (dx,dy) per edge, edge i joining vertex i to i+1.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; close the feature.
 * @example bentPolygonNodes([[0,0],[0.3,0],[0,0.3]], [[0,0],[0,0],[0,0]])[0] // [0,0,0,0.1,0.1,0]
 * @example bentPolygonNodes([[0,0],[0.3,0],[0,0.3]], [[0,-0.04],[0,0],[0,0]])[0][5] // -0.04
 */
export function bentPolygonNodes(vertices, bends) {
  if (vertices.length < 3 || bends.length !== vertices.length) throw new Error("bentPolygonNodes needs ≥ 3 vertices and one bend per edge");
  finiteGeometry([...vertices.flat(), ...bends.flat()]);
  const n = vertices.length;
  return vertices.map(([x, y], i) => {
    const [px, py] = vertices[(i + n - 1) % n], [nx, ny] = vertices[(i + 1) % n];
    const [bx, by] = bends[i], [ax, ay] = bends[(i + n - 1) % n];
    return [x, y, (px - x) / 3 + ax, (py - y) / 3 + ay, (nx - x) / 3 + bx, (ny - y) / 3 + by];
  });
}

/**
 * Pure function. After an inset, puts back every coordinate that lay ON a box edge, so a cell
 * of a box-filling lattice keeps its outer sides on the box boundary (no strip left outside it).
 * @param {number[][]} original - [N,2] vertices before the inset.
 * @param {number[][]} moved - [N,2] the same vertices after it.
 * @returns {number[][]} [N,2] moved vertices with box-edge coordinates restored.
 * @example keepOnBox([[0, 0.5], [0.5, 0.5]], [[0.01, 0.49], [0.49, 0.49]]) // [[0,0.49],[0.49,0.49]]
 */
export function keepOnBox(original, moved) {
  finiteGeometry([...original.flat(), ...moved.flat()]);
  if (original.length !== moved.length) throw new Error("keepOnBox needs matching vertex lists");
  return moved.map((p, i) => p.map((v, k) => (original[i][k] === 0 || original[i][k] === 1 ? original[i][k] : v)));
}

/**
 * Pure function. A wing-case stripe boundary from the left edge to the right edge whose
 * stripes converge toward the tail: its height is pulled toward 0.5 along x.
 * @param {number} y - Height at the left edge.
 * @returns {number[][]} [3,6] Catmull–Rom nodes, left→right, ending on the right edge.
 * @example taperNodes(0.5).map((n) => n.slice(0, 2)) // [[0,0.5],[0.55,0.5],[1,0.5]]
 */
export function taperNodes(y) {
  finiteGeometry([y]);
  const pulled = (keep) => 0.5 + (y - 0.5) * keep;
  return catmullRomNodes([[0, y], [0.55, pulled(0.9)], [1, pulled(0.5)]]);
}

// Brazilian lens agate: nested pointed lenses along the diagonal, [scale, outside, inside]
// from the rind inward — thin slate and white lines between pale chalcedony, blue eye.
const AGATE_LENS = { cx: 0.5, cy: 0.5, length: 1.22, width: 0.72, angle: -0.72 };
const AGATE_BANDS = [[1, "#3d3531", "#7a6c60"], [0.94, "#665c55", "#dde2eb"], [0.88, "#aab5c9", "#394054"],
  [0.83, "#5b6680", "#c7d0e1"], [0.73, "#95a3c0", "#e8ecf3"], [0.65, "#b3bfd6", "#6a799b"], [0.56, "#8595b8", "#d4dbe8"],
  [0.46, "#a1afcb", "#4b5877"], [0.41, "#6e7ea2", "#dfe5ef"], [0.29, "#b8c5db", "#8a9cc3"], [0.17, "#a2b3d4", "#eaeef6"],
  [0.07, "#c3d0e7", "#7d93c2"]];
// Malachite growth arcs about the bottom-left corner: [radius, outside (light), inside (dark)].
const MALACHITE_ARCS = [[0.97, "#3db878", "#06341d"], [0.9, "#1c8f51", "#0a4a2a"], [0.83, "#52c88a", "#073a21"],
  [0.74, "#2ca465", "#0d5632"], [0.69, "#8fe0b2", "#0a4527"], [0.6, "#33ae6e", "#062f1a"], [0.5, "#1f9457", "#0b4b2b"],
  [0.42, "#64d196", "#083c22"], [0.33, "#2a9f62", "#06301b"], [0.24, "#49c07f", "#042615"]];
// Bullseye eye beyond the arcs: [radius, outside, inside].
const MALACHITE_EYE = { cx: 0.82, cy: 0.2, rings: [[0.13, "#2aa465", "#05301a"], [0.065, "#5fd093", "#0a4a2a"]] };
// Rhodochrosite stalactite fan about its nucleus at the bottom edge: [radius, outside, inside].
const RHODO_BANDS = [[0.98, "#5a4a3c", "#f1b9c6"], [0.92, "#e9a0b2", "#fbe5ea"], [0.88, "#f6cdd6", "#df5a7e"],
  [0.78, "#ec86a0", "#f9d2da"], [0.72, "#f2aabb", "#d8446b"], [0.6, "#e56f8e", "#fce4ea"], [0.56, "#f4b8c6", "#e2607f"],
  [0.44, "#ef93a9", "#f8cbd5"], [0.36, "#f3b0bf", "#cf3a61"], [0.24, "#e6698a", "#fbdde4"], [0.16, "#f6c2ce", "#c83c5c"],
  [0.07, "#d95a78", "#6e5446"]];
// Pool-floor caustics: a jittered 4×4 lattice of 3×3 cells. Each interior lattice edge
// bends by one shared vector, so neighbouring cells curve together and the bright seam
// (the focused light) keeps an even width while wandering like a real caustic web.
const CAUSTIC_LATTICE = [[[0, 0], [0.35, 0], [0.66, 0], [1, 0]],
  [[0, 0.34], [0.31, 0.38], [0.68, 0.3], [1, 0.36]],
  [[0, 0.68], [0.37, 0.63], [0.63, 0.71], [1, 0.66]],
  [[0, 1], [0.33, 1], [0.69, 1], [1, 1]]];
// Vertical bend of the horizontal edge (row r, from column c to c+1); rows 0 and 3 lie along the box.
const CAUSTIC_ROW_BENDS = [[0, 0, 0], [0.035, -0.045, 0.03], [-0.04, 0.035, -0.03], [0, 0, 0]];
// Horizontal bend of the vertical edge (column c, from row r to r+1); columns 0 and 3 lie along the box.
const CAUSTIC_COLUMN_BENDS = [[0, 0, 0], [0.035, -0.03, 0.04], [-0.04, 0.035, -0.03], [0, 0, 0]];
const CAUSTIC_SEAM = 0.01; // each cell's corners pull this far toward its centre
// Night-shining clouds: bright filaments rising to the right, each held narrow between navy
// guard lines of the same shape. [height at the left end, colour or ramp].
const NLC_RISE = 0.2; // how much each filament climbs across the box
const NLC_SAG = 0.01; // a slight droop at mid-span, so the filaments don't read as ruled lines
const NLC_GUARDS = [[0.2, "#0a1c50"], [0.35, "#11286a"], [0.5, "#183576"], [0.65, "#21428a"]];
const NLC_FILAMENTS = [[0.28, ["#0d2158", "#8cc0fa", "#e0f0ff", "#0f255e"]], [0.43, ["#132c70", "#78aef0", "#c9e3ff", "#16316f"]],
  [0.58, ["#1b3a7e", "#5f96e0", "#a9d0ff", "#1d3d80"]]];
// Bismuth hopper terraces, outer → inner: [half-size, centre shift, outside ramp (the step
// below, in shadow), inside ramp (the lit tread)]; oxide thin-film colours shift along each edge.
const BISMUTH_TWIST = 0.06; // each terrace turns this much more (radians): the hopper's spiral staircase
const BISMUTH_TERRACES = [
  [0.46, [0, 0], Array(4).fill("#26252c"), closedRamp(["#fbe38a", "#e0b43e", "#9c7424"])],
  [0.4, [0.012, -0.008], closedRamp(["#7c5a1c", "#6a4a18", "#5a3c14"]), closedRamp(["#f6a8c8", "#dc5e98", "#8e2e62"])],
  [0.34, [0.02, -0.004], closedRamp(["#7a2a58", "#62224a", "#4e1c3e"]), closedRamp(["#b8a4f4", "#7c5ed8", "#3e2c86"])],
  [0.28, [0.024, 0.006], closedRamp(["#3a2c7c", "#2e2466", "#241c52"]), closedRamp(["#9cd4fa", "#3f92e2", "#1c4c8c"])],
  [0.22, [0.02, 0.014], closedRamp(["#1c4c88", "#163e70", "#10305a"]), closedRamp(["#a6f2dc", "#38c4a4", "#156a58"])],
  [0.16, [0.012, 0.018], closedRamp(["#156454", "#105044", "#0c4036"]), closedRamp(["#f4f4a0", "#cfd046", "#6c7020"])],
  [0.1, [0.004, 0.016], closedRamp(["#6c6c20", "#58581a", "#464614"]), closedRamp(["#ffe0a0", "#f0b050", "#8c5a1c"])],
  [0.05, [0, 0.012], closedRamp(["#8a5a1a", "#704814", "#583810"]), closedRamp(["#ffc0dc", "#e8709e", "#9c3a66"])]];
// Geode outline shared by every nested band (rind → chalcedony → agate → crystal → cavity).
const GEODE = { cx: 0.5, cy: 0.5, lobes: [[3, 0.05, 0.3], [4, 0.03, 1]], count: 6 };

export const PRESETS = [
  preset("fortress-agate", "Fortification agate", "A sliced Brazilian agate: pointed nested bands of slate and pale chalcedony around a blue eye.",
    AGATE_BANDS.map(([scale, outside, inside]) => boundary(snapToBox(leafNodes({ ...AGATE_LENS,
      length: AGATE_LENS.length * scale, width: AGATE_LENS.width * scale })), [outside], [inside], true))),
  preset("malachite-bands", "Malachite bands", "Saw-tooth growth bands of polished malachite sweeping around a corner, with one bullseye.", [
    ...MALACHITE_ARCS.map(([r, outside, inside]) => boundary(
      polarArcNodes({ cx: 0, cy: 1, from: -QUARTER_TURN, to: 0, radius: () => r, maxStep: QUARTER_TURN }), [outside], [inside])),
    ...MALACHITE_EYE.rings.map(([r, outside, inside]) => boundary(ellipseNodes(MALACHITE_EYE.cx, MALACHITE_EYE.cy, r), [outside], [inside], true)),
  ]),
  preset("rhodochrosite-fan", "Rhodochrosite fan", "Raspberry, blush and white growth bands fanning out from a stalactite's core.",
    RHODO_BANDS.map(([r, outside, inside]) => {
      const [from, to] = upperSpan(0.5, r);
      return boundary(polarArcNodes({ cx: 0.5, cy: 1, from, to, radius: () => r, maxStep: QUARTER_TURN }), [outside], [inside]);
    })),
  preset("peacock-eye", "Peacock eye", "A peacock feather's ocellus: indigo pupil, turquoise ring and a bronze disc in lime and olive barbs.", [
    ...[[0.47, 0.44, 0.5, ["#34461a"], ["#b9d24a"]], [0.4, 0.37, 0.52, Array(4).fill("#93b43a"), closedRamp(["#c98c3e", "#a86c2c", "#dcaa56"])],
      [0.27, 0.25, 0.55, ["#a8682a"], ["#23a89c"]], [0.22, 0.2, 0.56, ["#25bccd"], ["#2366c0"]], [0.14, 0.13, 0.585, ["#2f4fb0"], ["#16174f"]]]
      .map(([rx, ry, cy, outside, inside]) => boundary(ellipseNodes(0.5, cy, rx, ry), outside, inside, true)),
    boundary(rectNodes(0, 0, 1, 1), closedRamp(["#2c3a10", "#141c08", "#3a3a14"]), null, true),
  ]),
  preset("prismatic-spring", "Prismatic spring", "A hot spring from the air: deep blue vent, cyan and yellow rings, orange mats streaking out.", [
    boundary(rectNodes(0, 0, 1, 1), closedRamp(["#dcd7cd", "#c9c2b6", "#e2ded6"]), null, true),
    ...[[0.43, 0.39, "#d9742e", "#e4822c"], [0.35, 0.31, "#eca23c", "#eed64e"], [0.3, 0.26, "#bcd25e", "#42b4be"], [0.19, 0.16, "#2b95cf", "#0e5fb8"]]
      .map(([rx, ry, outside, inside], i) => boundary(blobNodes({ cx: 0.5, cy: 0.48, rx, ry, lobes: [[3, 0.05, 0.4 + 0.2 * i], [5, 0.025, 1]], count: 6 }),
        [outside], [inside], true)),
    ...[[0.07, 0.63, 0.0, 0.8], [0.3, 0.89, 0.2, 1.0], [0.93, 0.66, 1.0, 0.84], [0.86, 0.22, 1.0, 0.08]].map(([x0, y0, x1, y1]) =>
      boundary(polylineNodes([[x0, y0], [x1, y1]]), ["#d9742e", "#c2744a", "#d6cfc4"])),
  ]),
  preset("venus-belt", "Belt of Venus", "Twilight opposite the sunset: a pink belt resting on Earth's blue-grey shadow above a dark treeline.", [
    ...sideRails(["#7d84ba", "#b49ccc", "#eba9b8", "#7c8fbd"], 0.8, [0, 0.4, 0.7, 1]),
    boundary(polylineNodes([[0.02, 0.56], [0.98, 0.56]]), ["#e2a6bb", "#eeadb8", "#e2a6bb"]),
    boundary(catmullRomNodes([[0, 0.8], [0.3, 0.79], [0.62, 0.81], [1, 0.8]]), ["#7c8fbd"], ["#2c2a38"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#1a1824"]),
  ]),
  preset("noctilucent-night", "Noctilucent clouds", "Electric-blue night-shining filaments high in a navy twilight above an orange horizon.", [
    ...sideRails(["#050e33", "#0e2462", "#23478f", "#e07b3e"], 0.82, [0, 0.4, 0.8, 1]),
    ...[...NLC_GUARDS, ...NLC_FILAMENTS].map(([y, colors]) =>
      boundary(catmullRomNodes([[0.03, y], [0.5, y - NLC_RISE / 2 + NLC_SAG], [0.97, y - NLC_RISE]]), [colors].flat())),
    boundary(polylineNodes([[0, 0.82], [1, 0.82]]), ["#e07b3e"], ["#0d1428"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#060a16"]),
  ]),
  preset("pool-caustics", "Pool caustics", "Sunlight focused by ripples into a bright web of seams over a turquoise pool floor.", [
    ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => {
      const L = CAUSTIC_LATTICE, corners = [L[r][c], L[r][c + 1], L[r + 1][c + 1], L[r + 1][c]];
      const bends = [[0, CAUSTIC_ROW_BENDS[r][c]], [CAUSTIC_COLUMN_BENDS[c + 1][r], 0], [0, CAUSTIC_ROW_BENDS[r + 1][c]], [CAUSTIC_COLUMN_BENDS[c][r], 0]];
      const k = r * 3 + c;
      return boundary(bentPolygonNodes(keepOnBox(corners, insetPolygon(corners, CAUSTIC_SEAM)), bends),
        closedRamp([["#b4f7f1", "#e6fffc", "#9ff0eb"], ["#dcfffb", "#a4f2ed", "#c6fbf6"], ["#a0efea", "#d4fdf8", "#b8f6f1"]][k % 3]),
        closedRamp([["#127488", "#0b5c70", "#0f6a7e"], ["#0c6074", "#13798c", "#0a566a"], ["#0f6c80", "#0a586c", "#157e90"]][(k + r) % 3]), true);
    })),
  ]),
  preset("aurora-corona", "Aurora corona", "Auroral rays streaming from the zenith in a slow swirl, green at the core and crimson at the fringe.",
    [-3.0, -2.55, -2.05, -1.55, -1.2, -0.7, -0.15, 0.3, 0.85, 1.45, 2.0, 2.5].map((angle, i) => boundary(
      swirlRayNodes({ cx: 0.52, cy: 0.46, angle, r0: i % 2 ? 0.15 : 0.05, twist: 0.32 }), i % 2 ? ["#0f2a26", "#0a1a18", "#0b1114", "#1c1020"]
      : [["#eaffef", "#7fe8a4", "#2a8a5a", "#1c1020"], ["#f2ffe6", "#a6ef8e", "#3b8f4c", "#1c1020"], ["#e4fff6", "#6fe0b0", "#227a62", "#1c1020"]][i / 2 % 3]))),
  preset("jewel-beetle", "Jewel beetle", "Metallic wing-case stripes of a jewel beetle: emerald, gold and copper-red between violet edges.",
    [[0.08, ["#2f33a0", "#4a50c4", "#3438a8"]], [0.29, ["#15a050", "#3fd878", "#1c9c56"]],
      [0.43, ["#d8cc3e", "#f6ea80", "#d0b83a"], ["#b0361a", "#e0602c", "#a8341c"]],
      [0.57, ["#b43c1c", "#e46a30", "#a8341c"], ["#d4c03a", "#f2e27a", "#cbb238"]],
      [0.71, ["#17a052", "#44d67a", "#1a9a54"]], [0.92, ["#2c30a0", "#474cc0", "#3136a6"]]]
      .map(([y, above, below]) => boundary(taperNodes(y), above, below ?? null))),
  preset("bismuth-hopper", "Bismuth hopper", "Stepped square terraces of a bismuth hopper crystal in oxide gold, rose, violet, blue and teal.", [
    boundary(rectNodes(0, 0, 1, 1), ["#26252c"], null, true),
    ...BISMUTH_TERRACES.map(([half, [dx, dy], outside, inside], i) => boundary(
      turnedRectNodes({ cx: 0.5 + dx, cy: 0.5 + dy, w: 2 * half, h: 2 * half, angle: BISMUTH_TWIST * i }), outside, inside, true)),
  ]),
  preset("glowing-eddy", "Glowing eddy", "A paddle-stirred whirl of bioluminescent plankton: cyan light coiling through black water.", [
    boundary(rectNodes(0, 0, 1, 1), ["#050f1a"], null, true),
    boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.02, endRadius: 0.44, turns: 1.5, phase: 0.6 }), ["#eaffff", "#5fe6ff", "#1a9ad4", "#0a3050"]),
    boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.02, endRadius: 0.44, turns: 1.5, phase: 0.6 + Math.PI }), ["#0a3a50", "#041826", "#031420", "#06121e"]),
  ]),
  preset("tiger-eye", "Tiger's eye", "Silky golden and umber bands of polished tiger's eye, with a chatoyant sheen crossing them.",
    [[[0.2, 0.16, 0.22, 0.18], ["#c48a2e", "#f3c96a", "#c48a2e", "#a8741f"], ["#2e1c0c", "#523418", "#2e1c0c", "#24160a"]],
      [[0.36, 0.33, 0.39, 0.35], ["#3d2611", "#634018", "#3d2611", "#2e1c0c"], ["#b27a24", "#eab95a", "#b27a24", "#9a6618"]],
      [[0.55, 0.52, 0.58, 0.53], ["#c48a2e", "#f5cf74", "#c48a2e", "#a8741f"], ["#4a3014", "#6e4a22", "#4a3014", "#3a2410"]],
      [[0.68, 0.66, 0.7, 0.67], ["#5a3a18", "#7a5226", "#5a3a18", "#46300f"], ["#b8822a", "#e8b85a", "#b8822a", "#9a6618"]],
      [[0.85, 0.82, 0.87, 0.84], ["#a8741f", "#d9a445", "#a8741f", "#8a5a18"], ["#2a190b", "#3f2812", "#2a190b", "#20140a"]]]
      .map(([ys, above, below]) => boundary(catmullRomNodes(ys.map((y, i) => [i / 3, y])), above, below))),
  preset("fire-opal", "Fire opal", "Glowing amber pockets of fire opal in dark brown rhyolite, with a deeper red vein of colour.", [
    boundary(rectNodes(0, 0, 1, 1), closedRamp(["#4a3b2c", "#6a5a46", "#3a2d21"]), null, true),
    boundary(blobNodes({ cx: 0.5, cy: 0.52, rx: 0.3, ry: 0.38, lobes: [[2, 0.1, 0.5], [3, 0.09, 1.2], [5, 0.04, 0]], count: 8 }),
      Array(4).fill("#21170f"), closedRamp(["#e06a0e", "#f39a1c", "#d4580a"]), true),
    boundary(blobNodes({ cx: 0.52, cy: 0.46, rx: 0.12, ry: 0.18, lobes: [[3, 0.12, 0.4]], count: 5 }), ["#ffc93a"], null, true),
    point(0.52, 0.44, "#fff2b0"),
    boundary(catmullRomNodes([[0.3, 0.7], [0.46, 0.76], [0.62, 0.72]]), ["#e9801a", "#c2400c", "#e47416"]),
    boundary(blobNodes({ cx: 0.83, cy: 0.17, rx: 0.08, ry: 0.07, lobes: [[2, 0.12, 1]], count: 4 }), Array(4).fill("#21170f"),
      closedRamp(["#d85a0c", "#ffb02a", "#e87414"]), true),
  ]),
  preset("amethyst-geode", "Amethyst geode", "A split geode: brown rind, white chalcedony and blue agate lining a cave of violet crystal.", [
    boundary(rectNodes(0, 0, 1, 1), ["#2a2420"], null, true),
    ...[[0.46, 0.43, "#3a3029", "#8c7662"], [0.415, 0.385, "#6e5a49", "#efeae4"], [0.375, 0.345, "#d6d3dc", "#9ea8c2"],
      [0.335, 0.305, "#b9bfd4", "#dccbef"], [0.17, 0.14, "#6d3aa2", "#2b1244"]].map(([rx, ry, outside, inside]) =>
      boundary(blobNodes({ ...GEODE, rx, ry }), [outside], [inside], true)),
    point(0.36, 0.38, "#f6ecff"), point(0.62, 0.66, "#efe2ff"), point(0.66, 0.36, "#e6d6ff"),
  ]),
  preset("golden-hour", "Golden hour", "Low sun under a slate-blue sky: amber haze at the treeline and thin gilded cloud streaks.", [
    ...sideRails(["#34507c", "#8c7f9c", "#eaa04e", "#fbd07a"], 0.8, [0, 0.4, 0.82, 1]),
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#34507c"]),
    boundary(catmullRomNodes([[0.04, 0.5], [0.3, 0.55], [0.62, 0.6]]), [mixHex("#be9576", "#ffe2a6", 0.35), "#ffe2a6", "#f7c27a", mixHex("#d4b987", "#f7c27a", 0.35)]),
    boundary(catmullRomNodes([[0.5, 0.28], [0.72, 0.25], [0.96, 0.29]]), [mixHex("#808085", "#f4c98e", 0.35), "#f4c98e", "#e8b07a", mixHex("#847b92", "#e8b07a", 0.35)]),
    point(0.4, 0.72, "#fff4cc"),
    boundary(catmullRomNodes([[0, 0.8], [0.14, 0.77], [0.3, 0.795], [0.5, 0.76], [0.72, 0.795], [0.88, 0.77], [1, 0.8]]), ["#fbd07a"], ["#140b08"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#070404"]),
  ]),
  preset("glowing-surf", "Bioluminescent surf", "Night surf lit electric cyan by plankton, under a grey-blue sky over dark sand.", [
    ...sideRails(["#232b3a", "#3a4658", "#5a687e"], 0.4),
    boundary(polylineNodes([[0, 0.4], [1, 0.4]]), ["#5a687e"], ["#18253c"]),
    boundary(catmullRomNodes([[0, 0.52], [0.35, 0.5], [0.7, 0.53], [1, 0.5]]), ["#132038"]),
    boundary(catmullRomNodes([[0, 0.575], [0.35, 0.555], [0.7, 0.585], [1, 0.555]]), ["#35d6ff", "#a8f7ff", "#56e0ff", "#2cc8f5"]),
    boundary(catmullRomNodes([[0, 0.66], [0.35, 0.64], [0.7, 0.67], [1, 0.64]]), ["#50708a"]),
    boundary(catmullRomNodes([[0, 0.76], [0.4, 0.74], [0.75, 0.77], [1, 0.75]]), ["#3f586c"], ["#7d7063"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#3a322b"]),
  ]),
];

