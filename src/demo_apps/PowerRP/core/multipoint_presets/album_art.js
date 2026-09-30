/**
 * "Album art" — native Multipoint presets. Misty jazz covers, prog-rock airbrush worlds, 70s soul sunbursts, shoegaze haze, ambient and synth horizons.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { boxEdge, cornerFrame, atOffsets, arcNodes } from "./retro_eras.js";
import { trimEnds } from "./music_helpers.js";

/** Smooth closed blob through points (clockwise on screen). */
const blobPts = (pts) => catmullRomNodes(pts, true);

/** A rect-like clockwise polygon as closed two-sided feature. */
const same4 = (c) => [c, c, c, c];

export const PRESETS = [
  preset("jazz-fjord-mist", "Fjord mist", "Misty European-jazz cover: slate ridges dissolving into pale cold fog, water held dark below.", [
  boxEdge("top", ["#cfd6db", "#c4ccd3"]),
  boundary(catmullRomNodes([[0, 0.5], [0.3, 0.46], [0.62, 0.52], [1, 0.44]]), ["#c9d1d7", "#c2cbd2"], ["#8d9ba6", "#7d8c98"]),
  boundary(catmullRomNodes([[0, 0.66], [0.35, 0.6], [0.7, 0.68], [1, 0.62]]), ["#a2afb8", "#9aa8b2"], ["#596a76", "#4c5d6a"]),
  boundary(catmullRomNodes([[0, 0.82], [0.4, 0.78], [0.75, 0.84], [1, 0.8]]), ["#66778a", "#5a6b7a"], ["#27323c", "#1e2831"]),
  boxEdge("bottom", ["#1b252e"]),
]),
  preset("jazz-pale-horizon", "Pale horizon", "Near-white sea and sky meeting on one low line, the water barely darker than the air.", [
  boxEdge("top", ["#e7e5df", "#ecebe5"]),
  boundary(polylineNodes([[0, 0.64], [1, 0.64]]), ["#efeee8", "#f0efea"], ["#b9c2c4", "#aeb9bd"]),
  boxEdge("bottom", ["#6f8085", "#75878c"]),
  ...glow(0.66, 0.5, 0.12, ["#fffdf4", "#f8f3e6", "#efeee8"]),
]),
  preset("jazz-dusk-moor", "Dusk moor", "A cold mauve dusk pressing on a black moor, one seam of pink light along the horizon.", [
  atOffsets(boxEdge("left", ["#3a3a58", "#6d6484", "#e0a792"], 0, 0.64), [0, 0.5, 1]),
  atOffsets(boxEdge("right", ["#3a3a58", "#6d6484", "#e0a792"], 0, 0.58), [0, 0.5, 1]),
  boxEdge("left", ["#0f0d14"], 0.68, 1),
  boxEdge("right", ["#0f0d14"], 0.62, 1),
  boxEdge("top", ["#3a3a58"]),
  boundary(catmullRomNodes([[0, 0.66], [0.3, 0.62], [0.6, 0.68], [1, 0.6]]), ["#e0a792", "#c88d84", "#d8a08e"], ["#2a2530", "#221e28", "#1b1821"]),
  boxEdge("bottom", ["#0f0d14"]),
]),
  preset("prog-eclipse-lake", "Eclipse lake", "A black sun ringed in molten gold over a violet lake, mirrored in the water below.", [
  atOffsets(boxEdge("left", ["#1a1038", "#5a2f78", "#d8628a", "#f7a45a"], 0, 0.7), [0, 0.35, 0.75, 1]),
  atOffsets(boxEdge("right", ["#1a1038", "#5a2f78", "#d8628a", "#f7a45a"], 0, 0.7), [0, 0.35, 0.75, 1]),
  boxEdge("left", ["#4a2a72", "#140a2c"], 0.74, 1),
  boxEdge("right", ["#4a2a72", "#140a2c"], 0.74, 1),
  boundary(polylineNodes([[0, 0.72], [1, 0.72]]), ["#f9b46a"], ["#4a2a72"]),
  boxEdge("bottom", ["#140a2c"]),
  boundary(ellipseNodes(0.5, 0.4, 0.17), same4("#c0507e"), ["#fbd27a", "#ffb04a", "#d8628a", "#fbd27a"], true),
  boundary(ellipseNodes(0.5, 0.4, 0.13), ["#fbd27a", "#ffb04a", "#d8628a", "#fbd27a"], same4("#150a26"), true),
]),
  // 70s soul sunbursts
  preset("soul-sunburst-rings", "Soul sunburst", "A 1970s soul-label sunrise: flat concentric rings stepping from chocolate up to butter-gold.", [
  ...cornerFrame("#4a2010", "#3a1a12", "#2a1009", "#3c1a0c"),
  ...[[0.47, "#3b1a0c", "#9a430f"], [0.38, "#9a430f", "#d8701a"], [0.29, "#d8701a", "#f0a52c"], [0.2, "#f0a52c", "#ffd56a"]].map(([r, out, inn]) =>
    boundary(ellipseNodes(0.5, 0.52, r), [out], [inn], true)),
]),
  preset("soul-corner-arcs", "Soul arcs", "Four fat quarter-circle bands sweeping from a corner: mustard, tangerine, rust, brown on cream.", (() => {
  const cols = ["#f4e6c4", "#e0a526", "#d8621c", "#9a3418", "#4a2010"];
  // clockwise from top to right around bottom-left: right of travel points to the centre (inner band)
  return [0.94, 0.74, 0.54, 0.34].map((r, i) => boundary(trimEnds(arcNodes({ cx: 0, cy: 1, rx: r, from: -Math.PI / 2, to: 0 })), [cols[i]], [cols[i + 1]]));
})()),
  preset("soul-plum-halo", "Plum halo", "Velvet plum night with a hot coral-to-gold halo burning low behind a dark horizon hill.", [
  ...cornerFrame("#2a0c2e", "#3a1040", "#1c0620", "#2c0c30"),
  boundary(ellipseNodes(0.5, 0.56, 0.36), same4("#4a1a4a"), ["#ff8a5a", "#ffb84a", "#ff6a6a", "#ff8a5a"], true),
  boundary(ellipseNodes(0.5, 0.56, 0.2), ["#ffb84a", "#ffe08a", "#ff9a5a", "#ffb84a"], same4("#ff9a5a"), true),
]),
  // shoegaze haze
  preset("shoegaze-blush", "Shoegaze blush", "Smeared strawberry-pink light drowning in lilac fog, no edges anywhere.", [
  ...cornerFrame("#c8a8d0", "#b89ad0", "#8a78b8", "#d8a0b8"),
  boundary(blobPts([[0.36, 0.3], [0.62, 0.24], [0.8, 0.44], [0.66, 0.72], [0.38, 0.74], [0.22, 0.52]]), ["#ee6a92"], null, true),
  point(0.5, 0.46, "#ffd2dc"),
]),
  // ambient electronic
  preset("ambient-tide", "Ambient tide", "Electronic ambient gradient: deep teal washing into violet with a pale orb riding high.", [
  atOffsets(boxEdge("left", ["#0a2c3a", "#1c7a80", "#9ad8c8"]), [0, 0.55, 1]),
  atOffsets(boxEdge("right", ["#2a1a5a", "#7a4ab0", "#e0b0e0"]), [0, 0.55, 1]),
  boxEdge("top", ["#0a2c3a", "#2a1a5a"]),
  boxEdge("bottom", ["#9ad8c8", "#e0b0e0"]),
  ...glow(0.62, 0.34, 0.2, ["#f4fff8", "#c6b4ea", "#4a3a88"]),
]),
  // 80s synth chrome
  preset("synth-chrome-horizon", "Chrome horizon", "Eighties chrome-lettering gradient: cobalt sky burning white at a black ridge, then a gold-to-magenta reflection.", [
  atOffsets(boxEdge("left", ["#1b2a9a", "#6ac4ff", "#ffffff"], 0, 0.5), [0, 0.6, 1]),
  atOffsets(boxEdge("right", ["#1b2a9a", "#6ac4ff", "#ffffff"], 0, 0.44), [0, 0.6, 1]),
  boundary(catmullRomNodes([[0, 0.54], [0.22, 0.5], [0.4, 0.42], [0.55, 0.52], [0.78, 0.47], [1, 0.46]]), ["#ffffff"], ["#0c0628"]),
  boundary(polylineNodes([[0, 0.66], [1, 0.66]]), ["#0c0628"], ["#ffe066"]),
  boundary(polylineNodes([[0, 0.74], [1, 0.74]]), ["#ffb83a"], ["#ff5a8a"]),
  boxEdge("bottom", ["#b01a7a"]),
]),
  preset("ambient-dawn-bands", "Ambient dawn", "Soft ambient bands — lavender, rose, peach, cream — with a pale sun sitting low in the haze.", [
  atOffsets(boxEdge("left", ["#a898e8", "#e8a8d8", "#ffc4a0", "#fff0c8"]), [0, 0.35, 0.7, 1]),
  atOffsets(boxEdge("right", ["#8a8ce0", "#d898d0", "#ffb898", "#ffe4b8"]), [0, 0.35, 0.7, 1]),
  ...glow(0.5, 0.74, 0.17, ["#fffdf0", "#ffe6c0", "#ffc8a0"]),
]),
  preset("prog-crescent-world", "Crescent world", "An airbrushed crescent planet hanging in a teal-violet void, lit gold along its lower limb.", [
  atOffsets(boxEdge("left", ["#06303c", "#1a2a5a", "#4a2a6a"]), [0, 0.55, 1]),
  atOffsets(boxEdge("right", ["#0a2434", "#241a52", "#5a2a6a"]), [0, 0.55, 1]),
  boundary(ellipseNodes(0.5, 0.56, 0.34), same4("#2a2a5c"), ["#ffe0a0", "#ffb070", "#d8708a", "#ffe0a0"], true),
  boundary(ellipseNodes(0.45, 0.51, 0.27), same4("#ffd09a"), ["#12092a", "#241450", "#0a0620", "#12092a"], true),
  point(0.14, 0.14, "#fff4e0"), point(0.82, 0.2, "#e8f0ff"), point(0.9, 0.56, "#fff4e0"), point(0.12, 0.8, "#e8f0ff"),
]),
];
