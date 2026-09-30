/**
 * "Art Nouveau & Symbolism" — native Multipoint presets. Mucha halos and whorls, Klimt's gold, serpents and birch forests.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, closedRamp } from "./builders.js";
import { ellipseNodes, spiralNodes, mixHex } from "../multipoint_shapes.js";
import { polar } from "./art_homages.js";
import { disc, edge, frame, ribbonThrough } from "./expressionism_helpers.js";

// Mucha, zodiac calendar (1896): a gilded roundel-halo, its metal sheen turning around the ring.
const GOLD_SHEEN = closedRamp(["#f6d878", "#b8801a", "#e8b040"]);

// Mucha, Autumn (1896): a cluster of lit plum grapes ringed in gold, in a harvest haze.
const grape = (x, y, r, dark, light) => boundary(ellipseNodes(x, y, r), ["#d9a03a", "#d9a03a", "#d9a03a", "#d9a03a"], [mixHex(dark, light, 0.3), dark, light, mixHex(dark, light, 0.3)], true);

export const PRESETS = [
  // Mucha, Spring (1896 lithograph): russet blossom-bough above, pale meadow below, a halo and streaming tresses.
  preset("mucha-spring-bough", "Mucha spring", "Russet blossom-bough over a pale meadow, a cream halo and drifting orange and cream drapery.", [
  edge("top", ["#b84a2c", "#c8642e"]), edge("right", ["#a8492f", "#d5cc82"]), edge("bottom", ["#d5cc82", "#bcc27a"]), edge("left", ["#8a9a52", "#c8642e"]),
  boundary(ellipseNodes(0.5, 0.24, 0.17), ["#f8e6bc"], null, true), boundary(ellipseNodes(0.5, 0.24, 0.09), ["#fdf5e0"], null, true),
  ribbonThrough([[0.06, 0.66], [0.28, 0.5], [0.56, 0.6], [0.94, 0.42]], [0.02, 0.1, 0.1, 0.02], null, "#c8642e", "#e8842e"),
  ribbonThrough([[0.06, 0.86], [0.3, 0.72], [0.58, 0.82], [0.94, 0.64]], [0.02, 0.09, 0.09, 0.02], null, "#c8b070", "#fbf1dc"),
]),
  preset("mucha-zodiac-halo", "Zodiac halo", "A gilded roundel whose gold sheen turns around the ring, with teal glow and four ruby jewels.", [
  ...frame(["#e6d2a2", "#e9d7ac", "#dcc48e", "#e9d7ac"]),
  boundary(ellipseNodes(0.5, 0.46, 0.42), GOLD_SHEEN.map(() => "#e6d2a2"), GOLD_SHEEN, true), boundary(ellipseNodes(0.5, 0.46, 0.31), GOLD_SHEEN, ["#f7edd2", "#f7edd2", "#f7edd2", "#f7edd2"], true),
  boundary(ellipseNodes(0.5, 0.46, 0.2), ["#3a8a86"], null, true), boundary(ellipseNodes(0.5, 0.46, 0.09), ["#fff6dc"], null, true),
  ...[0, 1, 2, 3].map((i) => { const [x, y] = polar(0.5, 0.46, 0.365, Math.PI / 4 + i * Math.PI / 2); return disc(x, y, 0.028, null, "#d9a03a", "#b8302a"); }),
]),
  preset("mucha-autumn-grapes", "Mucha autumn", "A cluster of gold-ringed plum grapes, lit from the upper left, in a harvest haze over deep aubergine.", [
  edge("top", ["#2f1a44", "#4a2450"]), edge("right", ["#6a2a3a", "#8a4a1a"]), edge("bottom", ["#8a4a1a", "#6a2a3a"]), edge("left", ["#4a2450", "#2f1a44"]),
  boundary(ellipseNodes(0.5, 0.5, 0.42), ["#c8801a"], null, true),
  grape(0.4, 0.3, 0.075, "#3a1a5a", "#a878d0"), grape(0.6, 0.3, 0.075, "#4a2a7a", "#b890dc"), grape(0.31, 0.5, 0.075, "#4a2a7a", "#b890dc"),
  grape(0.5, 0.5, 0.075, "#2f1650", "#9868c0"), grape(0.69, 0.5, 0.075, "#3a1a5a", "#a878d0"), grape(0.41, 0.7, 0.075, "#2f1650", "#9868c0"),
]),
  // Mucha, Job cigarette papers (1896): hair swirling into a double whorl of amber and umber on warm cream.
  preset("mucha-job-whorl", "Job whorl", "Two interleaved whorls of amber and umber tresses turning on warm cream, like smoke and hair.", [
  ...frame(["#f1e3c0", "#ecd9ae", "#e6d0a0", "#efe0b8"]),
  boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.03, endRadius: 0.44, turns: 1.25 }),
    ["#fff0c0", "#f0a848", "#c8641e"], ["#d9782a", "#8a4a1a", "#5a2a10"]),
  boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.03, endRadius: 0.44, turns: 1.25, phase: Math.PI }),
    ["#5a2a10", "#a8541a", "#e0902a"], ["#f2d890", "#e8b866", "#f6e4b0"]),
]),
  // Klimt, Tree of Life (Stoclet Frieze, 1909-11): bronze arms unwinding as interleaved spirals over ivory-gold, an eye among them.
  preset("klimt-tree-of-life", "Tree of life", "Bronze and ivory spirals unwinding over gold, with a black-and-white eye disc.", [
  edge("top", ["#ecdcb2"]), edge("bottom", ["#e2cf9c"]),
  boundary(spiralNodes({ cx: 0.32, cy: 0.34, startRadius: 0.02, endRadius: 0.24, turns: 1 }), ["#e0c060", "#b8902a", "#8a6418"], ["#f4ead0", "#efe0b8", "#e8d5a0"]),
  boundary(spiralNodes({ cx: 0.74, cy: 0.42, startRadius: 0.02, endRadius: 0.2, turns: -1 }), ["#8a6418", "#b8902a", "#e0c060"], ["#e8d5a0", "#efe0b8", "#f4ead0"]),
  boundary(spiralNodes({ cx: 0.36, cy: 0.78, startRadius: 0.02, endRadius: 0.14, turns: 1 }), ["#e0c060", "#b8902a", "#8a6418"], ["#f4ead0", "#efe0b8", "#e8d5a0"]),
  disc(0.7, 0.82, 0.055, null, "#e8d5a0", "#1a1410"), disc(0.7, 0.82, 0.025, null, "#1a1410", "#f4ecd6"),
]),
  // Klimt, Water Serpents (1904-07): golden sinuous bodies with rose and violet flourishes swimming in emerald-teal water.
  preset("klimt-water-serpents", "Water serpents", "Two golden sinuous bodies with rose and violet flourishes swimming in emerald-teal water.", [
  edge("top", ["#1f8a80", "#2a6a72"]), edge("right", ["#2a6a72", "#0f4a52"]), edge("bottom", ["#0f4a52", "#16646a"]), edge("left", ["#16646a", "#1f8a80"]),
  ribbonThrough([[0.08, 0.28], [0.3, 0.16], [0.52, 0.34], [0.72, 0.2], [0.92, 0.3]], [0.03, 0.09, 0.1, 0.09, 0.03], null, "#1f7f80", "#e8b84a"),
  ribbonThrough([[0.08, 0.7], [0.3, 0.82], [0.52, 0.64], [0.72, 0.8], [0.92, 0.7]], [0.03, 0.09, 0.1, 0.09, 0.03], null, "#1a6a72", "#f0c85a"),
  ...[[0.52, 0.34, "#d47a9a"], [0.52, 0.64, "#7a5ac0"]].map(([x, y, c]) => disc(x, y, 0.028, null, "#e8b84a", c)),
]),
  // Klimt, Beech Forest / Birch Forest (1902-03): dappled green light between pale, slender trunks.
  preset("klimt-birch-forest", "Birch forest", "Dappled green and yellow light between four pale, slender birch trunks.", [
  edge("top", ["#c8d878"]), edge("bottom", ["#1f4a2a"]), edge("left", ["#1f4a2a", "#2d6a3a"]), edge("right", ["#3a7a48", "#1f4a2a"]),
  ...[[0.18, 0.02, "#e4e0cc"], [0.4, 0.0, "#efe9d4"], [0.63, -0.02, "#e4e0cc"], [0.84, 0.01, "#efe9d4"]].map(([x, lean, c]) =>
    ribbonThrough([[x, 0.08], [x + lean, 0.5], [x - lean * 0.5, 0.92]], [0.03, 0.05, 0.04], null, "#2a5a34", c)),
]),
];
