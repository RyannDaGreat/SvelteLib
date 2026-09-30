/**
 * "Stage & club light" — native Multipoint presets. Haze beams, mirror-ball glints, jazz-club amber, follow-spots, theatre gels, velvet curtains and laser fans.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { ellipseNodes, polylineNodes } from "../multipoint_shapes.js";
import { boxEdge, cornerFrame, atOffsets, wavyLineNodes, starPolygonNodes } from "./retro_eras.js";
import { beam, trimEnds } from "./music_helpers.js";

/** A rect-like clockwise polygon as closed two-sided feature. */
const same4 = (c) => [c, c, c, c];

export const PRESETS = [
  preset("stage-haze-beams", "Concert haze", "Arena haze pierced by four coloured beams — cyan, blue, magenta and amber — each a hot core in a soft cone.", [
  boxEdge("left", ["#05061a", "#1c1a5c"]),
  boxEdge("right", ["#05061a", "#1c1a5c"]),
  ...[[0.14, 0.05, "#7af0ff", "#2a7fd0", "#16206a"], [0.39, 0.3, "#9aa8ff", "#4a48d8", "#1c1c78"],
    [0.63, 0.55, "#ff8ae8", "#c03ac8", "#2a1a78"], [0.86, 0.8, "#ffd27a", "#e0702a", "#2a1c60"]].flatMap(([ax, b0, core, cone, tail]) => [
    beam([ax, 0], [b0 + 0.17, 1], [b0 - 0.0, 1], [cone, tail, tail, cone], ["#0a0a2e", "#14145a", "#14145a", "#0a0a2e"]),
    beam([ax + (b0 + 0.085 - ax) * 0.04, 0.04], [b0 + 0.11, 1], [b0 + 0.06, 1], [core, cone, cone, core], [cone, tail, tail, cone])]),
]),
  preset("mirror-ball-glints", "Mirror-ball glints", "Disco night: magenta and cyan light pools on deep violet, scattered with crisp four-point mirror-ball glints.", [
  ...cornerFrame("#140a34", "#10143c", "#0a0820", "#1a0a30"),
  point(0.24, 0.3, "#ff6ad8"), boundary(ellipseNodes(0.24, 0.3, 0.22), ["#130a30"], null, true),
  point(0.76, 0.72, "#5ae8ff"), boundary(ellipseNodes(0.76, 0.72, 0.22), ["#0d1232"], null, true),
  ...[[0.62, 0.22, 0.1], [0.3, 0.72, 0.075], [0.86, 0.36, 0.05]].map(([cx, cy, r]) =>
    boundary(starPolygonNodes({ cx, cy, outer: r, inner: r * 0.16, points: 4, phase: -Math.PI / 2 }), same4("#1a1040"), ["#ffffff", "#ffe8ff", "#e8f8ff", "#ffffff"], true)),
]),
  preset("jazz-club-amber", "Jazz-club amber", "A smoky jazz cellar: one amber spotlight falling through brown smoke, a hot core inside a soft cone.", [
  boxEdge("left", ["#0a0705", "#34405a", "#1c120c"]), boxEdge("right", ["#0a0705", "#241308"]),
  beam([0.7, 0], [0.99, 1], [0.26, 1], ["#7a4a1c", "#2a1608", "#2a1608", "#7a4a1c"], ["#0c0806", "#1a0f08", "#1a0f08", "#0c0806"]),
  beam([0.7, 0.05], [0.88, 1], [0.42, 1], ["#d48a34", "#7a4a1c", "#7a4a1c", "#d48a34"], ["#7a4a1c", "#2a1608", "#2a1608", "#7a4a1c"]),
  beam([0.7, 0.1], [0.78, 1], [0.54, 1], ["#fff0c0", "#d48a34", "#d48a34", "#fff0c0"], ["#d48a34", "#7a4a1c", "#7a4a1c", "#d48a34"]),
]),
  // theatre gels (Rosco numbers for the colour family each one is drawn from)
  preset("gel-primary-blue-cyc", "Primary blue cyc", "A theatre cyclorama washed in a primary-blue lighting gel, fading to night at the top, a pale pool on the boards.", [
  atOffsets(boxEdge("left", ["#040c3c", "#0a44b4", "#3f86ec"], 0, 0.78), [0, 0.6, 1]),
  atOffsets(boxEdge("right", ["#040c3c", "#0a48bc", "#2a6ae0"], 0, 0.78), [0, 0.6, 1]),
  boundary(polylineNodes([[0, 0.8], [1, 0.8]]), ["#3a82e8", "#2a6ae0"], ["#060a1c", "#060a1c"]),
  boxEdge("left", ["#060a1c"], 0.84, 1), boxEdge("right", ["#060a1c"], 0.84, 1),
  boundary(ellipseNodes(0.5, 0.92, 0.34, 0.06), same4("#060a1c"), same4("#14306c"), true),
  boundary(ellipseNodes(0.5, 0.92, 0.22, 0.036), same4("#14306c"), ["#8cb8f8", "#4a82e0", "#2a5ac0", "#8cb8f8"], true),
]),
  preset("gel-amber-lavender", "Amber and lavender", "Cross-lit gel pair: deep amber against deep lavender with a rose seam between them and a pale moon disc.", [
  boxEdge("top", ["#e8731c", "#f0708a", "#6a3aa8"]),
  boxEdge("bottom", ["#7a3210", "#7a2a5a", "#2a1a5a"]),
  ...glow(0.5, 0.44, 0.17, ["#fff6e8", "#ffb4a4", "#b85a7c"]),
]),
  preset("laser-green-fan", "Laser fan", "Eight razor-thin green laser beams fanning up from one point through dark-green haze.", [
  ...cornerFrame("#010804", "#010804", "#0a3a1c", "#0a3a1c"),
  ...[0.04, 0.16, 0.28, 0.4, 0.6, 0.72, 0.84, 0.96].map((bx, i) => beam([0.46 + i * 0.011, 1], [bx - 0.016, 0], [bx + 0.016, 0],
    ["#d8ffd4", "#19d44c", "#19d44c", "#d8ffd4"], ["#0a3a1c", "#010a04", "#010a04", "#0a3a1c"])),
]),
  preset("velvet-curtain-red", "Velvet curtain", "A theatre's red velvet curtain in soft deep folds, lit from above so each ridge glows and each valley falls to oxblood.", (() => {
  // alternating ridge/valley fold lines; each is pinned to one colour on BOTH sides so the cloth blends smoothly between them
  const folds = [["#d83248", "#7a0e20"], ["#3a060e", "#1a0207"], ["#e03a50", "#8a1226"], ["#3a060e", "#1a0207"], ["#d02c44", "#741020"], ["#3a060e", "#1a0207"]];
  return folds.map((ramp, i) => boundary(trimEnds(wavyLineNodes({ x0: 0.1 + 0.16 * i, y0: 0, x1: 0.1 + 0.16 * i, y1: 1, amplitude: 0.02, cycles: 1, count: 6 })), ramp));
})()),
  preset("follow-spot-pool", "Follow-spot", "A single warm follow-spot pool on a dark stage, crisp at the rim with a white-hot centre, haze lifting behind.", [
  atOffsets(boxEdge("left", ["#0a0812", "#221a34", "#0a0812"]), [0, 0.45, 1]),
  atOffsets(boxEdge("right", ["#0a0812", "#221a34", "#0a0812"]), [0, 0.45, 1]),
  point(0.5, 0.66, "#fff0d0"),
  boundary(ellipseNodes(0.5, 0.66, 0.2, 0.11), ["#d09a5c"], null, true),
  boundary(ellipseNodes(0.5, 0.66, 0.38, 0.22), ["#0a0812"], null, true),
]),
  preset("gel-magenta-cyan", "Magenta and cyan wash", "Two-colour stage wash: hot-magenta gel from the left meeting cyan from the right through a violet seam.", [
  boxEdge("top", ["#e0208a", "#8a3ad8", "#14a8d8"]),
  boxEdge("bottom", ["#6a0e5a", "#3a1a78", "#0a5a78"]),
  boundary(wavyLineNodes({ x0: 0, y0: 0.74, x1: 1, y1: 0.7, amplitude: 0.02, cycles: 1, count: 5 }), ["#b81a78", "#1a6a8a"], ["#100818", "#0a0612"]),
]),
];
