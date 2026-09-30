/**
 * "3D gradients & renders" — native Multipoint presets. Soft studio renders: chrome, glass, clay, jelly and iridescent blobs.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, closedRamp } from "./builders.js";
import { rectNodes, polylineNodes, catmullRomNodes, ellipseNodes } from "../multipoint_shapes.js";
import { blobNodes } from "./fluid_materials.js";
import { heartNodes } from "./swirls.js";
import { ringNodes, withOffsets } from "./generative_helpers.js";

/** Backdrop: clockwise closed ramp around the box border (from top-left), one colour = flat. */
const frame = (colors) => boundary(rectNodes(0, 0, 1, 1), colors.length > 1 ? closedRamp(colors.slice(0, 3)) : colors, null, true);

const solid = (color, n) => Array(n).fill(color);

export const PRESETS = [
  (() => {
  const bg = "#e6e2f0";
  const blob = blobNodes({ cx: 0.5, cy: 0.5, rx: 0.34, ry: 0.3, lobes: [[2, 0.08, 0.5], [3, 0.06, 1.2]], count: 8, start: -Math.PI / 2 });
  return preset("chrome-blob", "Chrome blob", "A soft liquid-chrome pebble reflecting a sky, a dark horizon and a warm floor, with a softbox highlight, in the 3D-gradient style.", [
    frame([bg, "#f2eef8", bg, "#dad4e8"]),
    boundary(blob, solid(bg, 4), ["#c9dcff", "#141a3c", "#f0d2b4", "#c9dcff"], true),
    boundary(catmullRomNodes([[0.2, 0.53], [0.4, 0.46], [0.6, 0.55], [0.8, 0.49]]), ["#a9c6f7", "#7ea4ea"], ["#0f1432", "#1b2350"]),
    boundary(ellipseNodes(0.4, 0.3, 0.09, 0.045), ["#dbe8ff"], ["#ffffff"], true),
    boundary(catmullRomNodes([[0.34, 0.7], [0.5, 0.74], [0.66, 0.7]]), ["#f6d3b4"]),
  ]);
})(),
  (() => {
  const bg = "#fbe9f0";
  return preset("inflated-heart", "Inflated heart", "A glossy balloon-plastic pink heart, dark at the crease and glowing at its puffed centre, with a wet specular dot.", [
    frame([bg, "#fff3f7", bg, "#f6dbe6"]),
    withOffsets(boundary(heartNodes(0.5, 0.5, 0.33), solid(bg, 4), ["#d8407f", "#b0245f", "#ff9ec9", "#d8407f"], true), [0, 0.4, 0.8, 1]),
    boundary(heartNodes(0.48, 0.48, 0.17), ["#ff7fb5"], null, true),
    boundary(ellipseNodes(0.34, 0.34, 0.06, 0.03), ["#ffb6d6"], ["#ffffff"], true),
  ]);
})(),
  (() => {
  const bg = "#eaf0f6";
  const surface = ["#7be0ff", "#ff7bd3", "#ffe27a", "#7be0ff"];
  const shade = ["#3b3ea8", "#6b2a8c", "#3b6fa8", "#3b3ea8"];
  return preset("iridescent-torus", "Iridescent torus", "A tilted torus whose tube shifts cyan, pink and yellow between deep violet edges, in the Blender iridescent-render look.", [
    frame([bg, "#f6f9fc", bg, "#dfe6ee"]),
    boundary(ringNodes({ cx: 0.5, cy: 0.5, rx: 0.38, ry: 0.27, tilt: -0.25 }), solid(bg, 4), shade, true),
    boundary(ringNodes({ cx: 0.5, cy: 0.5, rx: 0.26, ry: 0.17, tilt: -0.25 }), surface, null, true),
    boundary(ringNodes({ cx: 0.5, cy: 0.5, rx: 0.15, ry: 0.085, tilt: -0.25 }), shade, solid(bg, 4), true),
  ]);
})(),
  // ---- clay sphere on a paper floor
  (() => {
  const wall = "#f1e6da", floor = "#dcc4ad";
  return preset("clay-sphere", "Clay sphere", "A matte peach clay sphere lit from the upper left, with a terracotta terminator and a soft contact shadow on paper.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), [wall]),
    boundary(polylineNodes([[0, 1], [1, 1]]), [floor]),
    boundary(ellipseNodes(0.56, 0.8, 0.27, 0.05), ["#c8ad95"], null, true),
    boundary(ellipseNodes(0.55, 0.78, 0.15, 0.02), ["#8f6f58"], null, true),
    withOffsets(boundary(ringNodes({ cx: 0.5, cy: 0.46, rx: 0.27, start: Math.PI * 0.5 }), solid("#ead8c5", 4),
      ["#b8654d", "#f5c3a3", "#e8977a", "#b8654d"], true), [0, 0.45, 0.75, 1]),
    boundary(ellipseNodes(0.43, 0.35, 0.12, 0.1), ["#fbdcc6"], null, true),
    boundary(ellipseNodes(0.59, 0.6, 0.1, 0.075), ["#d2836a"], null, true),
  ]);
})(),
  // ---- glass orb over a colour field
  (() => {
  return preset("glass-orb", "Glass orb", "A glassmorphic orb: bright frosted rim, violet interior, and pink and amber lights refracted through it over deep indigo.", [
    frame(["#2a1f6b", "#3b2a8c", "#1d1650", "#2f2378"]),
    boundary(ellipseNodes(0.14, 0.86, 0.075), ["#ff5fb0"], null, true),
    boundary(ellipseNodes(0.87, 0.14, 0.06), ["#ff9a3c"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.3), solid("#241a5c", 4), ["#fbe3f6", "#ffffff", "#d9e4ff", "#fbe3f6"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.25), ["#5a3fa8", "#7c4ab8", "#4a3aa0", "#5a3fa8"], null, true),
    boundary(ellipseNodes(0.41, 0.6, 0.045), ["#ff6fb8"], null, true),
    boundary(ellipseNodes(0.6, 0.41, 0.03), ["#ffab55"], null, true),
  ]);
})(),
  // ---- lime jelly
  (() => {
  const bg = "#f0f3e6";
  const shape = catmullRomNodes([[0.27, 0.74], [0.5, 0.78], [0.73, 0.74], [0.68, 0.5], [0.62, 0.3], [0.5, 0.26], [0.38, 0.3], [0.32, 0.5]].reverse(), true);
  const core = catmullRomNodes([[0.38, 0.68], [0.5, 0.7], [0.62, 0.68], [0.58, 0.5], [0.55, 0.38], [0.45, 0.38], [0.42, 0.5]].reverse(), true);
  return preset("lime-jelly", "Lime jelly", "Subsurface-scattering jelly: deep green skin, a glowing lime core, a wet highlight and a lime caustic on the table.", [
    frame([bg, "#f6f8ee", "#dde6c4", "#e8efd6"]),
    boundary(ellipseNodes(0.5, 0.82, 0.3, 0.04), ["#b5e05a"], null, true),
    boundary(shape, solid("#d3e3ad", 4), ["#0f7a30", "#2fa83c", "#5cc63a", "#0f7a30"], true),
    boundary(core, ["#e2ff6e"], null, true),
    boundary(ellipseNodes(0.4, 0.4, 0.025, 0.07), ["#a6e86a"], ["#ffffff"], true),
  ]);
})(),
  // ---- holo blob
  (() => {
  const bg = "#f4f0f8";
  const at = (s, cx = 0.5, cy = 0.5) => blobNodes({ cx, cy, rx: 0.35 * s, ry: 0.3 * s, lobes: [[2, 0.07, 2.2], [3, 0.06, 0.4]], count: 8, start: -Math.PI / 2 });
  return preset("holo-blob", "Holo blob", "A holographic pastel blob swirling pink, cyan, lime and lilac, after iridescent 3D-gradient blob illustrations.", [
    frame([bg, "#fbf8ff", bg, "#e9e3f2"]),
    boundary(at(1), solid(bg, 4), ["#ff9fd4", "#8fe8ff", "#e0ff9a", "#ff9fd4"], true),
    boundary(at(0.74, 0.52, 0.48), ["#8fe0ff", "#ffe0a6", "#c2a6ff", "#8fe0ff"], null, true),
    boundary(at(0.42, 0.55, 0.45), ["#fff0a8", "#ff9fd4", "#a6f0d0", "#fff0a8"], null, true),
  ]);
})(),
  // ---- water drop
  (() => {
  const bg = "#e8f4f2";
  const drop = (s, cy = 0.62) => catmullRomNodes([[0.5, 0.14], [0.6, 0.3], [0.71, 0.5], [0.74, 0.62], [0.68, 0.77], [0.5, 0.86], [0.32, 0.77], [0.26, 0.62], [0.29, 0.5], [0.4, 0.3]]
    .map(([x, y]) => [0.5 + (x - 0.5) * s, cy + (y - 0.6) * s]), true);
  return preset("water-drop", "Water drop", "An aqua glass droplet with dark teal edges, a bright caustic at its base and a pinpoint highlight.", [
    frame([bg, "#f3fbfa", "#d5ebe8", bg]),
    boundary(ellipseNodes(0.52, 0.92, 0.2, 0.025), ["#7fc4c0"], null, true),
    withOffsets(boundary(drop(1), solid(bg, 4), ["#48bfe0", "#0a5d82", "#9af5e6", "#48bfe0"], true), [0, 0.35, 0.6, 1]),
    boundary(drop(0.62, 0.6), ["#56c9e6"], null, true),
    boundary(ellipseNodes(0.41, 0.42, 0.028, 0.06), ["#bff3ff"], ["#ffffff"], true),
  ]);
})(),
  // ---- gummy star
  (() => {
  const bg = "#efe6fa";
  const star = (s) => blobNodes({ cx: 0.5, cy: 0.52, rx: 0.29 * s, count: 10, lobes: [[5, 0.3, Math.PI / 2]], start: -Math.PI / 2 });
  return preset("gummy-star", "Gummy star", "An inflated gummy star in translucent green, darker at the arms and lit at the core, with a glossy dot.", [
    frame([bg, "#f8f2ff", "#ddd0f0", bg]),
    withOffsets(boundary(star(1), solid(bg, 4), ["#2a9d3c", "#1c7a30", "#a8f060", "#2a9d3c"], true), [0, 0.4, 0.7, 1]),
    boundary(star(0.6), ["#6fe04a"], null, true),
    boundary(ellipseNodes(0.41, 0.45, 0.03, 0.05), ["#d5ffa0"], ["#ffffff"], true),
  ]);
})(),
  // ---- puffy cloud
  (() => {
  const pts = [[0.22, 0.68], [0.14, 0.56], [0.2, 0.44], [0.31, 0.41], [0.36, 0.3], [0.5, 0.25], [0.62, 0.3], [0.68, 0.4], [0.8, 0.41], [0.87, 0.53], [0.82, 0.66], [0.5, 0.7]];
  const cloud = (s, cx = 0.5, cy = 0.48) => catmullRomNodes(pts.map(([x, y]) => [cx + (x - 0.5) * s, cy + (y - 0.48) * s]), true);
  return preset("puffy-cloud", "Puffy cloud", "A 3D-icon cloud in soft white with lavender undersides, floating over a sky-blue gradient with a faint shadow.", [
    frame(["#5fa8f0", "#7ab8f5", "#cfe4ff", "#8cc0f7"]),
    boundary(ellipseNodes(0.5, 0.86, 0.3, 0.03), ["#7aa8e8"], null, true),
    boundary(cloud(1), solid("#a8cdf8", 4), ["#ffffff", "#c4cff5", "#93a4e4", "#ffffff"], true),
    boundary(cloud(0.6, 0.45, 0.42), ["#f4f7ff"], null, true),
  ]);
})(),
  // ---- clay trio
  (() => {
  const bg = "#e8e0f2";
  const ball = (cx, cy, r, edge, mid, lite, shadow) => [
    boundary(ellipseNodes(cx + 0.05, cy + r + 0.05, r * 0.95, r * 0.15), [shadow], null, true),
    boundary(ringNodes({ cx, cy, rx: r, start: Math.PI / 2 }), solid("#dcd2ea", 4), [edge, lite, mid, edge], true),
    boundary(ellipseNodes(cx - r * 0.3, cy - r * 0.32, r * 0.42, r * 0.34), [lite], null, true),
  ];
  return preset("clay-trio", "Clay trio", "Three pastel clay spheres (rose, mint, butter) with soft highlights and contact shadows on a lilac backdrop.", [
    frame([bg, "#f2ecf8", "#d6cce6", bg]),
    ...ball(0.3, 0.54, 0.19, "#c9607e", "#f2a3b8", "#ffd6e0", "#b9a5cc"),
    ...ball(0.68, 0.4, 0.14, "#3f9c80", "#8fd6b8", "#d6f7e8", "#b9a5cc"),
    ...ball(0.68, 0.76, 0.1, "#c8952c", "#f2cf72", "#fff2c0", "#b9a5cc"),
  ]);
})(),
];
