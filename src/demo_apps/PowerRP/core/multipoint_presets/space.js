/**
 * "Space & sci-fi" Multipoint presets (no planets or moons).
 * Coordinates are the unit paint box, y down. For a clockwise closed path (ellipseNodes,
 * blobNodes with increasing angle) the rightColor side is INSIDE; for an open path the
 * rightColor side is the viewer's right when walking the path on screen.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, spiralNodes, finiteGeometry, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

/**
 * Pure function. Smooth closed star-convex blob: radius r_k at angle phase + 2πk/N.
 * Clockwise on screen (like ellipseNodes), so a two-sided rightColor lands INSIDE.
 * @param {object} options - {cx,cy,radii,phase=0,squash=1}; radii [N≥3] positive,
 *   squash scales the vertical radius (0.5 = twice as wide as tall).
 * @returns {number[][]} [N,6] anchor/relative-handle tuples (close the feature).
 * @example blobNodes({cx:0.5,cy:0.5,radii:[0.2,0.2,0.2,0.2]})[0].slice(0,2) // [0.7,0.5]
 */
export function blobNodes({ cx, cy, radii, phase = 0, squash = 1 }) {
  finiteGeometry([cx, cy, phase, squash, ...radii]);
  if (radii.length < 3 || radii.some((r) => r <= 0)) throw new Error("Blob needs ≥3 positive radii");
  return catmullRomNodes(radii.map((r, k) => {
    const angle = phase + FULL_TURN * k / radii.length;
    return [cx + r * Math.cos(angle), cy + r * squash * Math.sin(angle)];
  }), true);
}

/**
 * Pure function. Affine map of editable nodes: anchors get the full map, handles
 * (relative offsets) only its linear part. Matrix is SVG-style [a,b,c,d,e,f]:
 * x' = a·x + c·y + e, y' = b·x + d·y + f.
 * @param {number[][]} nodes - [N,6] anchor/relative-handle tuples.
 * @param {number[]} matrix - [a,b,c,d,e,f].
 * @returns {number[][]} [N,6] transformed tuples.
 * @example affineNodes([[1,0,0,0,1,0]], [0,1,-1,0,0,0]) // [[0,1,0,0,0,1]]
 */
export function affineNodes(nodes, [a, b, c, d, e, f]) {
  finiteGeometry([a, b, c, d, e, f]);
  const linear = (x, y) => [a * x + c * y, b * x + d * y];
  return nodes.map(([x, y, ix, iy, ox, oy]) => {
    const [px, py] = linear(x, y);
    return [px + e, py + f, ...linear(ix, iy), ...linear(ox, oy)];
  });
}

/**
 * Pure function. SVG-style matrix: scale by (sx,sy), then rotate by angle (radians,
 * clockwise on screen), both about the pivot (cx,cy).
 * @param {object} options - {cx,cy,angle=0,sx=1,sy=1}.
 * @returns {number[]} [a,b,c,d,e,f].
 * @example pivotMatrix({cx:0.5,cy:0.5,sy:0.5}) // [1,0,0,0.5,0,0.25]
 */
export function pivotMatrix({ cx, cy, angle = 0, sx = 1, sy = 1 }) {
  finiteGeometry([cx, cy, angle, sx, sy]);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const [a, b, c, d] = [cos * sx, sin * sx, -sin * sy, cos * sy];
  return [a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy];
}

/**
 * Pure function. Rotates a closed path's node list so it starts at `index`
 * (moves the arc-length origin of its colour stops; geometry is unchanged).
 * @param {number[][]} nodes - [N,6] closed-path tuples.
 * @param {number} index - Integer start node in [0,N).
 * @returns {number[][]} [N,6] reordered tuples.
 * @example startAtNode([[0],[1],[2],[3]], 3) // [[3],[0],[1],[2]]
 */
export function startAtNode(nodes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= nodes.length) throw new Error("startAtNode index out of range");
  return [...nodes.slice(index), ...nodes.slice(0, index)];
}

/**
 * Pure function. The paint box's own border as a closed square, clockwise from the
 * top-left corner. A single-sided colour here is a vignette: it pins every edge, so
 * unconstrained space settles toward it instead of toward the brightest source.
 * @returns {number[][]} [4,6] zero-handle tuples (close the feature).
 * @example frameNodes()[1] // [1,0,0,0,0,0]
 */
export function frameNodes() {
  return polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]);
}

/**
 * Pure function. Where a ray from an interior point first meets the unit box's border,
 * so a two-sided ray can split the paint all the way to its edge.
 * @param {number} x - Start x in (0,1).
 * @param {number} y - Start y in (0,1).
 * @param {number} angle - Direction in radians (0 = +x, π/2 = +y, i.e. down).
 * @returns {number[]} [x,y] on the border.
 * @example rayToBox(0.5, 0.5, 0) // [1,0.5]
 */
export function rayToBox(x, y, angle) {
  finiteGeometry([x, y, angle]);
  if (x <= 0 || x >= 1 || y <= 0 || y >= 1) throw new Error("rayToBox needs a start strictly inside the unit box");
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const reach = (p, d) => d > 0 ? (1 - p) / d : d < 0 ? -p / d : Infinity;
  const t = Math.min(reach(x, dx), reach(y, dy));
  return [x + t * dx, y + t * dy];
}

/**
 * Pure function. Clockwise trapezoid whose four corners sit ON a circle, between two
 * heights: a horizontal slice of a disc (e.g. a synthwave sun's cut-out stripe).
 * Two-sided with rightColor = slice colour, leftColor = the disc around it.
 * @param {number} cx - Circle center x.
 * @param {number} cy - Circle center y.
 * @param {number} r - Circle radius.
 * @param {number} top - Upper slice height, |top − cy| < r.
 * @param {number} bottom - Lower slice height, top < bottom, |bottom − cy| < r.
 * @returns {number[][]} [4,6] zero-handle tuples (close the feature).
 * @example circleSliceNodes(0.5, 0.5, 0.5, 0.5, 0.8)[0] // [0,0.5,0,0,0,0]
 */
export function circleSliceNodes(cx, cy, r, top, bottom) {
  finiteGeometry([cx, cy, r, top, bottom]);
  if (!(top < bottom) || Math.abs(top - cy) >= r || Math.abs(bottom - cy) >= r) throw new Error("Slice heights must be ordered and inside the circle");
  const half = (y) => Math.sqrt(r * r - (y - cy) ** 2);
  return polylineNodes([[cx - half(top), top], [cx + half(top), top], [cx + half(bottom), bottom], [cx - half(bottom), bottom]]);
}

/**
 * Pure function. Open arc of a rotated ellipse between two parameter angles.
 * Affine maps preserve Bézier curves, so this is a unit-circle arc (spiralNodes with
 * equal radii) mapped through the ellipse's matrix. Before rotation, angle 0 is the
 * rightmost point and π/2 the bottom (screen space).
 * @param {object} options - {cx,cy,rx,ry,from,to,angle=0}; radians, from ≠ to.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples (open feature).
 * @example ellipseArcNodes({cx:0.5,cy:0.5,rx:0.4,ry:0.1,from:0,to:Math.PI}).at(-1).slice(0,2) // [0.1,0.5] (±1e-16)
 */
export function ellipseArcNodes({ cx, cy, rx, ry, from, to, angle = 0 }) {
  finiteGeometry([cx, cy, rx, ry, from, to, angle]);
  if (rx <= 0 || ry <= 0 || from === to) throw new Error("Ellipse arc needs positive radii and a nonzero sweep");
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return affineNodes(spiralNodes({ cx: 0, cy: 0, startRadius: 1, endRadius: 1, turns: (to - from) / FULL_TURN, phase: from }),
    [rx * cos, rx * sin, -ry * sin, ry * cos, cx, cy]);
}

const DEEP_SPACE = "#05040c";
const TOP_OF_ELLIPSE = 3; // ellipseNodes order: right, bottom, left, top.
// Accretion disc ellipse shared by its near/far arcs (tilted slightly, below the shadow's center).
const EVENT_DISC = { cx: 0.5, cy: 0.52, rx: 0.47, ry: 0.06, angle: -0.08 };
// Solar limb: circle center/radius, and the half-angle at which it meets the box's side edges.
const LIMB = { cx: 0.5, cy: 1.6, r: 0.95 };
const LIMB_HALF_ANGLE = Math.asin(0.4999 / LIMB.r);
const LIMB_EDGE_Y = LIMB.cy - LIMB.r * Math.cos(LIMB_HALF_ANGLE);

export const PRESETS = [
  // Emission nebula: a pink hydrogen ridge and a teal oxygen ridge parted by a dark dust rift.
  preset("emission-nebula", "Emission nebula", "Hot pink and teal gas ridges parted by a dark dust rift, one white star in the glow.", [
    boundary(frameNodes(), [DEEP_SPACE], null, true),
    boundary(catmullRomNodes([[0.08, 0.72], [0.3, 0.52], [0.55, 0.64], [0.8, 0.42], [0.95, 0.22]]),
      ["#3a0d3a", "#ff3d8f", "#ff78b0", "#5a1250"]),
    boundary(catmullRomNodes([[0.12, 0.3], [0.36, 0.36], [0.6, 0.26], [0.84, 0.3]]), ["#0d2a3a", "#27d3c4", "#8af5e4", "#0f3a48"]),
    boundary(catmullRomNodes([[0.2, 0.46], [0.45, 0.47], [0.7, 0.36]]), ["#1a0a20", "#0a050e", "#1a0a20"]),
    point(0.7, 0.2, "#ffffff"),
  ]),
  // Planetary nebula: tilted concentric rims, teal eye to red halo.
  preset("ring-nebula", "Ring nebula", "A tilted planetary shell: teal eye, gold rim and a ragged crimson halo on black.", [
    boundary(frameNodes(), ["#030208"], null, true),
    point(0.5, 0.5, "#dffcff"),
    boundary(affineNodes(ellipseNodes(0.5, 0.5, 0.14, 0.1), pivotMatrix({ cx: 0.5, cy: 0.5, angle: -0.5 })), ["#35b8c8"], null, true),
    boundary(affineNodes(ellipseNodes(0.5, 0.5, 0.25, 0.19), pivotMatrix({ cx: 0.5, cy: 0.5, angle: -0.5 })),
      ["#ffd36e", "#ff8a4c", "#ffd36e"], null, true),
    boundary(affineNodes(blobNodes({ cx: 0.5, cy: 0.5, radii: [0.38, 0.33, 0.4, 0.3, 0.37, 0.31], squash: 0.8 }),
      pivotMatrix({ cx: 0.5, cy: 0.5, angle: -0.5 })), ["#8e1d45", "#5a1240", "#8e1d45"], null, true),
  ]),
  // Tilted two-arm galaxy: bright arm ridges, dark inter-arm ridges between them.
  preset("spiral-galaxy", "Spiral galaxy", "A tilted two-armed galaxy: blue-white arms, dusky lanes and a golden core.", [
    boundary(frameNodes(), [DEEP_SPACE], null, true),
    ...[0, Math.PI].map((phase) => boundary(affineNodes(
      spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.05, endRadius: 0.5, turns: 0.75, phase }),
      pivotMatrix({ cx: 0.5, cy: 0.5, angle: -0.45, sy: 0.62 })), ["#fff0c8", "#a9c8ff", "#5c62d8", "#171336"])),
    ...[Math.PI / 2, 3 * Math.PI / 2].map((phase) => boundary(affineNodes(
      spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.08, endRadius: 0.5, turns: 0.75, phase }),
      pivotMatrix({ cx: 0.5, cy: 0.5, angle: -0.45, sy: 0.62 })), ["#6b4a52", "#1d1638", "#0a0918"])),
    point(0.5, 0.5, "#fff6dc"),
  ]),
  // Quasar: needle jets from a blazing core; the frame alone darkens space (a host contour would pinch where jets cross it).
  preset("quasar-jet", "Quasar jet", "A needle-thin blue-violet jet lancing from a blazing core and its amber disc.", [
    boundary(frameNodes(), ["#04030b"], null, true),
    boundary(polylineNodes([[0.45, 0.55], rayToBox(0.45, 0.55, -0.75)]), ["#ffffff", "#8fc7ff", "#6b46ff", "#2a1670"]),
    boundary(polylineNodes([[0.45, 0.55], [0.12, 0.86]]), ["#ffffff", "#7aa8ff", "#2c1a6a"]),
    boundary(affineNodes(ellipseNodes(0.45, 0.55, 0.12, 0.04), pivotMatrix({ cx: 0.45, cy: 0.55, angle: 0.75 })),
      ["#ffb35a"], null, true),
    point(0.45, 0.55, "#fffbe8"),
  ]),
  // Eclipse: a crisp black moon disc cuts a pearl corona with equatorial streamers.
  preset("solar-eclipse", "Total eclipse", "A black moon disc ringed by a pearly corona that frays into navy sky.", [
    boundary(frameNodes(), ["#02040c"], null, true),
    boundary(ellipseNodes(0.44, 0.46, 0.19), ["#fffaf0"], ["#040308"], true),
    boundary(blobNodes({ cx: 0.44, cy: 0.46, radii: [0.5, 0.3, 0.26, 0.3, 0.42, 0.28, 0.25, 0.29], phase: -0.25 }),
      ["#5d6f9e", "#4a5a8c", "#5d6f9e"], null, true),
    point(0.57, 0.3, "#ffffff"),
  ]),
  // Solar limb: a crisp gold star edge with crimson prominence loops arching above.
  preset("solar-prominence", "Prominence", "A blazing solar limb with crimson prominence loops arching into black.", [
    boundary(polylineNodes([[0, LIMB_EDGE_Y], [0, 0], [1, 0], [1, LIMB_EDGE_Y]]), ["#1a0406", "#050106", "#1a0406"]),
    boundary(spiralNodes({ cx: LIMB.cx, cy: LIMB.cy, startRadius: LIMB.r, endRadius: LIMB.r,
      turns: -2 * LIMB_HALF_ANGLE / FULL_TURN, phase: LIMB_HALF_ANGLE - Math.PI / 2 }),
      ["#ffb84a", "#fff0a8", "#ffb84a"], ["#140306", "#200508", "#140306"]),
    boundary(catmullRomNodes([[0.18, 0.72], [0.24, 0.4], [0.4, 0.34], [0.46, 0.66]]), ["#ff6a3a", "#ff3a2a", "#ff8a3a"]),
    boundary(catmullRomNodes([[0.58, 0.66], [0.66, 0.5], [0.8, 0.52], [0.84, 0.7]]), ["#ff7a3a", "#e82a3a", "#ff7a3a"]),
  ]),
  // Black hole: shadow disc, lensed arc over the top, tilted beamed disc in front.
  preset("event-horizon", "Event horizon", "A black-hole shadow under a lensed arc of fire, a beamed accretion disc slicing across it.", [
    boundary(frameNodes(), ["#030103"], null, true),
    boundary(ellipseNodes(0.5, 0.46, 0.15), ["#ffd9a0"], ["#000000"], true),
    boundary(spiralNodes({ cx: 0.5, cy: 0.46, startRadius: 0.19, endRadius: 0.19, turns: 0.5, phase: Math.PI }),
      ["#ff8a3c", "#fff0c8", "#ff8a3c"]),
    boundary(ellipseNodes(0.5, 0.46, 0.26), ["#3a1008"], null, true),
    // Only the near half of the disc crosses the shadow; the far half shows either side of it.
    boundary(ellipseArcNodes({ ...EVENT_DISC, from: 0, to: Math.PI }), ["#b8381a", "#ffe6b0", "#fff8e8"]),
    boundary(ellipseArcNodes({ ...EVENT_DISC, from: Math.PI, to: Math.PI + 1.15 }), ["#fff0c8", "#ff9a4a"]),
    boundary(ellipseArcNodes({ ...EVENT_DISC, from: FULL_TURN - 1.15, to: FULL_TURN }), ["#e0582a", "#b8381a"]),
  ]),
  // Pulsar: twin cones along a tilted axis, faint dipole field lobes across it.
  preset("pulsar-beams", "Pulsar beams", "Two lighthouse cones of cyan light and faint violet field lobes around a white-hot star.", [
    boundary(frameNodes(), ["#07041a"], null, true),
    ...[-1.95, -1.4, 1.19, 1.74].map((angle) => boundary(polylineNodes([[0.5, 0.5], rayToBox(0.5, 0.5, angle)]),
      ["#f4fdff", "#5fe3ff", "#3b2a9a"])),
    ...[-1, 1].map((side) => boundary(affineNodes(ellipseNodes(0.5 + side * 0.17, 0.5, 0.17, 0.1),
      pivotMatrix({ cx: 0.5, cy: 0.5, angle: 0.1 })), ["#6a45c8"], null, true)),
    point(0.5, 0.5, "#ffffff"),
  ]),
  // Synthwave: sun with crisp cut-out stripes over a crisp horizon, soft magenta grid below.
  preset("synthwave-sun", "Synthwave sun", "A yellow-to-magenta sun with crisp cut-out stripes over a glowing magenta grid.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#150a3a"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#0d0420"]),
    boundary(startAtNode(ellipseNodes(0.5, 0.38, 0.23), TOP_OF_ELLIPSE),
      ["#2a0f57", "#c42f86", "#2a0f57"], ["#ffe86a", "#ff3d8b", "#ffe86a"], true),
    boundary(circleSliceNodes(0.5, 0.38, 0.23, 0.495, 0.52), ["#ff6f84"], ["#6a1f72"], true),
    boundary(circleSliceNodes(0.5, 0.38, 0.23, 0.55, 0.585), ["#ff4f8e"], ["#6a1f72"], true),
    boundary(polylineNodes([[0, 0.64], [1, 0.64]]), ["#c23a8e", "#ff6aae", "#c23a8e"], ["#1a0633", "#1a0633", "#1a0633"]),
    ...[[0, 0.92], [0.25, 1], [0.75, 1], [1, 0.92]].map((end) => boundary(polylineNodes([[0.5, 0.64], end]), ["#ff6ad8", "#9a2ab8"])),
    boundary(polylineNodes([[0, 0.8], [1, 0.8]]), ["#a02cc0"]),
  ]),
  // Cyberpunk: crisp stepped skyline under a magenta-to-cyan haze, neon signs on the towers.
  preset("neon-skyline", "Neon skyline", "Crisp black towers against a magenta-to-cyan haze, lit by stray neon signs.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#1a0a3a", "#0e0a2a"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#07040f"]),
    boundary(polylineNodes([[0, 0.6], [0.16, 0.6], [0.16, 0.42], [0.34, 0.42], [0.34, 0.66], [0.44, 0.66], [0.44, 0.3], [0.6, 0.3],
      [0.6, 0.54], [0.8, 0.54], [0.8, 0.38], [1, 0.38]]), ["#ff3fa4", "#c24cff", "#5a7cff", "#2fe8ff"],
      ["#0c0818", "#0c0818", "#0c0818", "#0c0818"]),
    boundary(polylineNodes([[0.52, 0.36], [0.52, 0.62]]), ["#ff4fbf"]),
    boundary(polylineNodes([[0.66, 0.66], [0.76, 0.66]]), ["#3ff0ff"]),
    boundary(polylineNodes([[0.22, 0.5], [0.22, 0.74]]), ["#ffb13b"]),
  ]),
  // Hologram: emitter at the base, a crisp light cone, a floating halo disc.
  preset("hologram-cone", "Hologram", "A crisp cyan projection cone rising from a tiny emitter to a floating halo disc.", [
    boundary(frameNodes(), ["#020a14"], null, true),
    boundary(polylineNodes([[0.5, 0.86], [0.16, 0.3]]), ["#062033", "#041424"], ["#bff9ff", "#1f7fa8"]),
    boundary(polylineNodes([[0.5, 0.86], [0.84, 0.3]]), ["#bff9ff", "#1f7fa8"], ["#062033", "#041424"]),
    boundary(ellipseNodes(0.5, 0.3, 0.34, 0.08), ["#9ffcff", "#2fb6d6", "#9ffcff"], null, true),
    ...[0.45, 0.57, 0.69].map((y) => {
      const half = 0.34 * (0.86 - y) / 0.56;
      return boundary(polylineNodes([[0.5 - half, y], [0.5 + half, y]]), ["#1f86a8"]);
    }),
    point(0.5, 0.86, "#ffffff"),
  ]),
  // Plasma globe: glass sphere, electrode core, forked tendrils to the glass.
  preset("plasma-globe", "Plasma globe", "Violet lightning tendrils reaching from a white electrode to a dark glass sphere.", [
    boundary(ellipseNodes(0.5, 0.5, 0.43), ["#030108"], ["#16052e"], true),
    ...[[[0.56, 0.45], [0.7, 0.3], [0.8, 0.15]], [[0.44, 0.44], [0.33, 0.3], [0.18, 0.28]], [[0.43, 0.56], [0.3, 0.7], [0.3, 0.88]],
      [[0.57, 0.55], [0.72, 0.64], [0.87, 0.7]], [[0.5, 0.42], [0.54, 0.25], [0.48, 0.08]]].map((pts) => boundary(
      catmullRomNodes(pts), ["#ffe0ff", "#a834ff", "#ff86f0"])),
    point(0.5, 0.5, "#fff0ff"),
  ]),
  // Warp: straight two-sided rays, bright on one bank and void on the other.
  preset("warp-tunnel", "Warp tunnel", "Star streaks torn radially from a white vanishing point, each with a crisp void edge.",
    [...Array.from({ length: 10 }, (_, k) => {
      const angle = FULL_TURN * k / 10 + 0.2;
      return boundary(polylineNodes([[0.5 + 0.04 * Math.cos(angle), 0.5 + 0.04 * Math.sin(angle)], rayToBox(0.5, 0.5, angle)]),
        ["#ffffff", "#8ec5ff"], ["#0a1238", "#050a22"]);
    }), point(0.5, 0.5, "#ffffff")]),
  // Portal: a tilted oval of gunmetal framing a rippling, glowing blue event surface.
  preset("portal-ring", "Portal ring", "A tilted gunmetal ring framing a rippling, glowing blue event surface.",
    [boundary(ellipseNodes(0.5, 0.5, 0.46), ["#05070f"], ["#8a96b0"], true),
      boundary(ellipseNodes(0.5, 0.5, 0.38), ["#2a3148"], ["#1b5cff"], true),
      boundary(blobNodes({ cx: 0.5, cy: 0.5, radii: [0.27, 0.22, 0.25, 0.28, 0.23, 0.26, 0.21], phase: 0.3 }), ["#7fe3ff"], null, true),
      boundary(blobNodes({ cx: 0.52, cy: 0.49, radii: [0.13, 0.1, 0.12, 0.09, 0.11], phase: 0.9 }), ["#1a3fbf"], null, true),
      point(0.52, 0.49, "#e8fbff"),
    ].map((f) => ({ ...f, nodes: affineNodes(f.nodes, pivotMatrix({ cx: 0.5, cy: 0.5, angle: 0.25, sx: 0.72 })) }))),
];

