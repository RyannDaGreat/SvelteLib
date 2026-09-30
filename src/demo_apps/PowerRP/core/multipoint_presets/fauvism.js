/**
 * "Fauvism & Expressionism" — native Multipoint presets. Derain, Kirchner, Marc, Munch, Nolde and Jawlensky: unmixed colour and charged skies.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { waveNodes, ellipseNodes } from "../multipoint_shapes.js";
import { poly, panel, disc, edge, blobThrough, ribbonThrough } from "./expressionism_helpers.js";

const wave = (y, amplitude, cycles, above, below, phase = 0) =>
  boundary(waveNodes({ x0: 0, x1: 1, y, amplitude, cycles, phase }), above, below);

// Kirchner, Berlin Street Scene (1913): acid pink pavement wedge, green and yellow facades, spiky ink-black figures.
const INK = "#1e1030";

function glowRing(cx, cy, r) {
  return [boundary(ellipseNodes(cx, cy, r), ["#f8ce6a"], null, true), boundary(ellipseNodes(cx, cy, r * 0.5), ["#fff2b8"], null, true)];
}

export const PRESETS = [
  // Derain, Charing Cross Bridge (1906): peach sky, a vermilion bridge, the Thames in long strokes of turquoise, orange, cobalt and rose.
  preset("derain-thames", "Thames bridge", "A peach sky, vermilion bridge and river bands of turquoise, orange, cobalt and rose.", [
  edge("top", ["#7f9fe6"]),
  wave(0.53, 0.012, 0.5, ["#f9dfae"], ["#59c8be"], 0),
  ribbonThrough([[0.06, 0.47], [0.35, 0.43], [0.65, 0.43], [0.94, 0.47]], 0.05, 0.05, "#f9dfae", "#e2342a"),
  wave(0.65, 0.02, 0.5, ["#59c8be"], ["#f28a3a"], 0.5), wave(0.76, 0.025, 0.5, ["#f28a3a"], ["#4a58cc"], 1),
  wave(0.87, 0.03, 0.5, ["#4a58cc"], ["#dc4a8c"], 1.5), edge("bottom", ["#2c8f6a"]),
]),
  preset("kirchner-street", "Berlin street", "An acid-pink pavement wedge between green and yellow facades, with spiky ink figures.", [
  poly([[0.05, 1], [0.3, 0.5], [0.7, 0.5], [0.95, 1]], INK, "#ec4a86"),
  poly([[0, 0], [0.3, 0.06], [0.28, 0.48], [0, 0.66]], INK, "#2f9a86"),
  poly([[0.7, 0.06], [1, 0], [1, 0.66], [0.72, 0.48]], INK, "#f2c83a"),
  poly([[0.34, 0.1], [0.66, 0.1], [0.66, 0.46], [0.34, 0.46]], INK, "#8f7ad8"),
  poly([[0.34, 0.62], [0.4, 0.58], [0.44, 0.92], [0.36, 0.96]], "#ec4a86", "#1c1230"),
  poly([[0.6, 0.6], [0.66, 0.62], [0.72, 0.94], [0.62, 0.9]], "#ec4a86", "#3a1a5a"),
  poly([[0.5, 0.56], [0.53, 0.54], [0.55, 0.8], [0.49, 0.82]], "#ec4a86", "#f08a2a"),
]),
  // Franz Marc, Large Blue Horses (1911): three cobalt rhythm-forms stacked over a hill-band of yellow, red and violet.
  preset("marc-blue-horses", "Blue horses", "Three stacked cobalt horse-forms over yellow, red-orange, green and violet hills.", [
  edge("top", ["#f4c93e", "#f39a30"]), edge("right", ["#f39a30", "#7a3aa0"]), edge("bottom", ["#7a3aa0", "#2e9a5a"]), edge("left", ["#2e9a5a", "#e2492a", "#f4c93e"]),
  blobThrough([[0.1, 0.25], [0.3, 0.09], [0.62, 0.1], [0.9, 0.22], [0.85, 0.34], [0.5, 0.3], [0.2, 0.36]], "#f2a13a", "#17278f"),
  blobThrough([[0.16, 0.5], [0.34, 0.37], [0.66, 0.4], [0.9, 0.5], [0.84, 0.6], [0.5, 0.56], [0.24, 0.62]], "#c8482e", "#2b5bd0"),
  blobThrough([[0.1, 0.78], [0.3, 0.64], [0.6, 0.66], [0.88, 0.76], [0.8, 0.88], [0.5, 0.84], [0.2, 0.9]], "#4a8a4a", "#4a86e6"),
]),
  // Munch, The Scream (1893): the blood-orange sky undulating over a cold fjord; the screaming head below.
  preset("munch-scream-sky", "Fjord scream sky", "Undulating blood-red, orange and ochre sky bands over a cold blue fjord.", [
  edge("top", ["#c8382a"]), edge("bottom", ["#2a2244"]),
  wave(0.2, 0.05, 0.75, ["#c8382a"], ["#ee9a3a"], Math.PI / 2), wave(0.34, 0.05, 0.75, ["#ee9a3a"], ["#f3cf6f"], Math.PI / 2),
  wave(0.5, 0.045, 0.75, ["#f3cf6f"], ["#3b7c95"], Math.PI / 2), wave(0.66, 0.04, 0.75, ["#3b7c95"], ["#1f2760"], Math.PI / 2),
  disc(0.56, 0.86, 0.06, 0.08, "#1f2760", "#dcc98a"),
]),
  // Munch, The Sun (1911): a white-hot disc radiating rings of gold, orange and rose over a violet fjord.
  preset("munch-the-sun", "Munch sun", "A white-hot sun radiating rings of gold, orange and rose over a violet fjord.", [
  edge("top", ["#4a5aa8"]), edge("bottom", ["#1c2a66"]),
  boundary(ellipseNodes(0.5, 0.42, 0.08), ["#fff6c0"], null, true), boundary(ellipseNodes(0.5, 0.42, 0.17), ["#ffc94a"], null, true),
  boundary(ellipseNodes(0.5, 0.42, 0.27), ["#f08a3a"], null, true), boundary(ellipseNodes(0.5, 0.42, 0.36), ["#c94a6a"], null, true),
  wave(0.82, 0.02, 0.5, ["#5a5aa0"], ["#1c2a66"]),
]),
  // Nolde, sunset over the sea (c. 1930s watercolours): wet-in-wet crimson and gold bleeding into deep violet.
  preset("nolde-sea-sunset", "Nolde sunset", "A wet-in-wet watercolour sunset of crimson and gold bleeding into violet over a dark sea.", [
  edge("top", ["#2a2a5a"]), edge("bottom", ["#1a2350"]),
  wave(0.22, 0.04, 0.75, ["#4a3a8a", "#7a3a9a", "#4a3a8a"], ["#b8306a", "#e0503a", "#c8306a"], 0),
  ...glowRing(0.5, 0.5, 0.15),
  wave(0.72, 0.02, 0.5, ["#f4a84a"], ["#26346f"]),
]),
  // Nolde, Flower Garden: incandescent red and yellow blossoms glowing out of a night-green ground.
  preset("nolde-flower-garden", "Nolde flower garden", "Incandescent red and yellow blossoms glowing from a deep blue-green night garden.", [
  edge("top", ["#0f2f3a", "#1a2e5a"]), edge("right", ["#1a2e5a", "#123a2a"]), edge("bottom", ["#123a2a", "#1b3a4a"]), edge("left", ["#1b3a4a", "#0f2f3a"]),
  boundary(ellipseNodes(0.3, 0.32, 0.16, 0.14), ["#c81f3a"], null, true), boundary(ellipseNodes(0.3, 0.32, 0.07, 0.06), ["#ffb43a"], null, true),
  boundary(ellipseNodes(0.7, 0.5, 0.15, 0.17), ["#f0a020"], null, true), boundary(ellipseNodes(0.7, 0.5, 0.06, 0.07), ["#fff0a0"], null, true),
  boundary(ellipseNodes(0.34, 0.78, 0.12, 0.1), ["#d2306a"], null, true), boundary(ellipseNodes(0.34, 0.78, 0.05, 0.04), ["#ff9a4a"], null, true),
]),
  // Jawlensky, Abstract Head (1918-1920s): a gold face in dark contour, bars for brow and cheeks, blocks of pure colour behind.
  preset("jawlensky-head", "Abstract head", "A gold face in dark contour with blue eyes, red lips and blocks of pure colour behind.", [
  edge("top", ["#3a2a6a"]), edge("bottom", ["#1f5a4a"]), edge("left", ["#d4552a"]), edge("right", ["#2a4f9a"]),
  disc(0.5, 0.5, 0.27, 0.4, "#141018", "#e6a83a"),
  panel([0.32, 0.22, 0.68, 0.3], "#e6a83a", "#c8402a"), disc(0.4, 0.42, 0.06, 0.035, "#141018", "#2a4f9a"), disc(0.6, 0.42, 0.06, 0.035, "#141018", "#2a4f9a"),
  poly([[0.5, 0.36], [0.53, 0.6], [0.47, 0.6]], "#e6a83a", "#7a3a1a"), disc(0.5, 0.72, 0.09, 0.03, "#e6a83a", "#c8242c"),
  disc(0.38, 0.6, 0.05, 0.04, "#e6a83a", "#e8664a"), disc(0.62, 0.6, 0.05, 0.04, "#e6a83a", "#e8664a"),
]),
];
