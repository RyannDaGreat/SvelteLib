/**
 * "Animation backgrounds" — native Multipoint presets. Hand-painted cumulus skies, lens-flared dusks, UPA flat hills, Moebius, Syd Mead and McQuarrie matte paintings.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, glow } from "./builders.js";
import { ellipseNodes, polylineNodes, rectNodes } from "../multipoint_shapes.js";
import { sideRails } from "./minerals_phenomena.js";
import { cloud, ridge, hline, skylineShape, streak, lobeNodes } from "./animation_helpers.js";

/** Pure function. Flat angular ridge (straight segments) with crisp flat colours on both sides. @example flatRidge([[0,0.5],[1,0.5]],"#fff","#000").nodes.length // 2 */
const flatRidge = (points, above, below) => boundary(polylineNodes(points), [above], [below]);

/** Pure function. A lit window: a tiny crisp rectangle of colour c centred at (x, y). @example window(0.5,0.5,"#fff").nodes.length // 4 */
const window = (x, y, c, w = 0.018, h = 0.026) => boundary(rectNodes(x - w / 2, y - h / 2, x + w / 2, y + h / 2), [c], null, true);

/** Pure function. A lens-flare ghost: a crisp translucent-looking disc, `sky` outside and a light `tint` inside. @example ghost(0.5,0.5,0.05,"#88c","#fff").closed // true */
const ghost = (x, y, r, sky, tint) => boundary(ellipseNodes(x, y, r), [sky], [tint], true);

export const PRESETS = [
  preset("summer-cumulus", "Summer cumulus", "A hand-painted summer sky: cerulean deepening overhead, one huge white cumulus with lavender-blue undersides, blue-green hills and bright meadow.", [
  ...sideRails(["#2a78cc", "#5aa9e8", "#a6dbf0", "#e2f3f2"], 0.7, [0, 0.4, 0.75, 1]),
  boundary(lobeNodes([[0.1, 0.62], [0.05, 0.5], [0.16, 0.4], [0.3, 0.32], [0.4, 0.18], [0.56, 0.1], [0.7, 0.2], [0.84, 0.26], [0.95, 0.4], [0.9, 0.54], [0.82, 0.62], [0.5, 0.64]],
    [0.26, 0.28, 0.28, 0.3, 0.3, 0.28, 0.3, 0.28, 0.26, 0.24, 0.03, 0.03]),
    ["#b4dcf0", "#58a4e6", "#6cb0e8", "#b4dcf0"], ["#8c9cd8", "#ffffff", "#fffaf0", "#8c9cd8"], true),
  boundary(lobeNodes([[0.36, 0.34], [0.36, 0.24], [0.46, 0.18], [0.56, 0.16], [0.66, 0.24], [0.76, 0.34], [0.6, 0.4]], 0.3), ["#ffffff"], null, true),
  ridge([0.7, 0.67, 0.7, 0.7], ["#e2f3f2"], ["#5e9f93"]),
  ridge([0.84, 0.79, 0.86, 0.84], ["#79b47a"], ["#3f8a38"]),
  hline(1, ["#276a2a"]),
]),
  preset("flare-dusk", "Flare dusk", "A violet dusk pouring into magenta and amber at a low sun, a soft lens flare ring and dark rolling hills under it.", [
  ...sideRails(["#2c2468", "#a0449c", "#f0745c", "#ffd98a"], 0.74, [0, 0.4, 0.75, 1]),
  ...glow(0.66, 0.6, 0.12, ["#fffbe6", "#ffd98a", "#f0788e"]),
  ridge([0.76, 0.72, 0.78, 0.74, 0.77], ["#ffb070"], ["#3a2552"]),
  hline(1, ["#150f2a"]),
]),
  preset("blue-hill-mist", "Blue hill mist", "Receding blue-green ridges dissolving into valley mist under a pale sky warmed by a low sun, after hand-painted countryside backgrounds.", [
  ...sideRails(["#7aa6d8", "#c2d9e8", "#f6e8cc"], 0.52, [0, 0.55, 1]),
  hline(0, ["#7aa6d8"]),
  ...glow(0.36, 0.4, 0.09, ["#fffbe6", "#fde8b8", "#f4ecd6"]),
  ridge([0.56, 0.5, 0.55, 0.52], ["#f4ecd6"], ["#aac4cf"]),
  ridge([0.63, 0.58, 0.64, 0.6], ["#c3d6d8"], ["#6f9aa8"]),
  ridge([0.74, 0.7, 0.76, 0.72], ["#9dbcbc"], ["#3f7f74"]),
  ridge([0.88, 0.84, 0.9, 0.86], ["#6a9c6a"], ["#2f6a34"]),
  hline(1, ["#1f4c28"]),
]),
  preset("meadow-horizon", "Meadow horizon", "Cobalt summer sky down to a pale horizon over rows of sun-drenched grass, a low cumulus sitting on the far edge.", [
  ...sideRails(["#1f6fd0", "#4aa0ee", "#9fd8f4", "#e8f6f0"], 0.55, [0, 0.4, 0.75, 1]),
  boundary(lobeNodes([[0.06, 0.5], [0.04, 0.42], [0.16, 0.36], [0.26, 0.26], [0.4, 0.3], [0.5, 0.4], [0.44, 0.5], [0.26, 0.52]], [0.26, 0.28, 0.3, 0.3, 0.28, 0.24, 0.03, 0.03]),
    ["#b4e2f2", "#8ccaf0", "#8ccaf0", "#b4e2f2", "#b4e2f2"].slice(0, 4), ["#a8b8e6", "#ffffff", "#fffaf0", "#a8b8e6"], true),
  ridge([0.55, 0.53, 0.56, 0.55], ["#e8f6f0"], ["#b5d94a"]),
  ridge([0.66, 0.63, 0.67, 0.65], ["#b5d94a"], ["#7cbb2e"]),
  ridge([0.8, 0.77, 0.82, 0.79], ["#7cbb2e"], ["#3e9a26"]),
  hline(1, ["#1f6a1e"]),
]),
  preset("flat-modernist-hills", "Flat modernist hills", "Mid-century flat colour: a cream sky, a tomato sun, and angular teal, mustard and oxblood hills cut as crisp shapes, after UPA backgrounds.", [
  ...sideRails(["#f3e2bc"], 0.54),
  boundary(ellipseNodes(0.66, 0.3, 0.13), ["#f3e2bc"], ["#e4472b"], true),
  flatRidge([[0, 0.66], [0.3, 0.5], [0.62, 0.68], [1, 0.54]], "#f3e2bc", "#2f8f8a"),
  flatRidge([[0, 0.8], [0.4, 0.66], [0.72, 0.82], [1, 0.7]], "#2f8f8a", "#e2a526"),
  flatRidge([[0, 0.94], [0.5, 0.82], [1, 0.9]], "#e2a526", "#8c2f2b"),
  hline(1, ["#8c2f2b"]),
]),
  preset("giraud-violet-dawn", "Giraud violet dawn", "A lavender sky melting through pink to a peach dawn, long pink streak clouds and a pale rising sun above a rose-gold salt flat.", [
  ...sideRails(["#9c8ad8", "#e0a4c8", "#ffd4a8", "#ffe8c0"], 0.62, [0, 0.4, 0.8, 1]),
  hline(0, ["#9c8ad8"]),
  streak(0.3, 0.16, 0.22, 0.012, "#ae96dc", ["#f0b4d0", "#e89cc4"]),
  streak(0.72, 0.28, 0.2, 0.012, "#c8a0d8", ["#ffd0c4", "#f2a8c8"]),
  streak(0.26, 0.4, 0.2, 0.011, "#eaaecb", ["#ffe0c0", "#ffc4c0"]),
  ...glow(0.64, 0.5, 0.1, ["#fffce8", "#ffe8b8", "#ffd4a8"]),
  ridge([0.62, 0.62, 0.62, 0.62], ["#ffe8c0"], ["#e8b0a0"]),
  ridge([0.78, 0.76, 0.8, 0.78], ["#e8b0a0"], ["#c58a9c"]),
  hline(1, ["#8a6488"]),
]),
  preset("skyline-neon-dusk", "Skyline neon dusk", "A violet-to-amber dusk behind a stepped tower skyline, a few windows lit amber, cyan and pink, after Syd Mead gouaches.", [
  ...sideRails(["#1a1250", "#6c2c8c", "#e85a82", "#ffb468"], 0.68, [0, 0.35, 0.72, 1]),
  hline(0, ["#1a1250"]),
  ...glow(0.83, 0.52, 0.12, ["#fff0c8", "#ffc070", "#f07a8a"]),
  skylineShape([[0, 0.2, 0.78], [0.2, 0.36, 0.46], [0.36, 0.5, 0.66], [0.5, 0.68, 0.3], [0.68, 1, 0.7]], "#ff9a66", "#0c1424"),
  window(0.27, 0.6, "#ffc870"), window(0.59, 0.46, "#6ee8ff"), window(0.82, 0.84, "#ff5ea8"),
]),
  preset("twin-suns-dunes", "Twin suns dunes", "A tan-gold desert sky with two pale suns low over apricot dunes and a umber foreground, after Ralph McQuarrie's matte paintings.", [
  ...sideRails(["#d48f58", "#eebc84", "#fbe2ae"], 0.68, [0, 0.55, 1]),
  hline(0, ["#d48f58"]),
  ...glow(0.34, 0.5, 0.13, ["#fffbe0", "#fbe6b0", "#f6c88c"]),
  ...glow(0.62, 0.58, 0.06, ["#fffbe0", "#fbe6b0", "#f2c088"]),
  ridge([0.7, 0.68, 0.72, 0.7], ["#fbe2ae"], ["#e8a462"]),
  ridge([0.84, 0.8, 0.86, 0.83], ["#e8a462"], ["#8a4a30"]),
  hline(1, ["#3a2218"]),
]),
  preset("anvil-thunderhead", "Towering cumulus", "A cauliflower tower of cumulus, gold on its sunward flank and violet in its own shade, rising off a rose horizon into a navy evening sky.", [
  ...sideRails(["#121a4a", "#3a48a0", "#b8789e", "#f0a890"], 0.8, [0, 0.4, 0.8, 1]),
  hline(0, ["#121a4a"]),
  boundary(lobeNodes([[0.26, 0.8], [0.12, 0.66], [0.16, 0.48], [0.26, 0.32], [0.42, 0.18], [0.62, 0.12], [0.74, 0.26], [0.86, 0.42], [0.84, 0.6], [0.8, 0.8], [0.54, 0.8]],
    [0.2, 0.26, 0.26, 0.3, 0.3, 0.28, 0.28, 0.26, 0.2, 0.03, 0.03]),
    ["#d08aa0", "#3a48a0", "#7a5aa0", "#d08aa0"], ["#5a4a94", "#ffe2b8", "#ffb878", "#5a4a94"], true),
  boundary(lobeNodes([[0.44, 0.36], [0.42, 0.26], [0.5, 0.2], [0.6, 0.18], [0.68, 0.28], [0.72, 0.4], [0.6, 0.44]], 0.3), ["#fff4d0"], null, true),
  hline(0.86, ["#f0a890"], ["#3a2a50"]),
  hline(1, ["#120c22"]),
]),
  preset("ringed-planet-key", "Ringed planet key", "A violet night sky with a giant orange banded planet and a crisp magenta crag, Maurice Noble's science-fiction colour key.", [
  ...sideRails(["#1c0f4a", "#4a1c7a", "#8a2c8a"], 0.8, [0, 0.55, 1]),
  hline(0, ["#1c0f4a"]),
  boundary(ellipseNodes(0.58, 0.36, 0.22), ["#3a1868", "#5a2480", "#7a2a86", "#3a1868"], ["#f8a43c", "#ffd278", "#e86a34", "#f8a43c"], true),
  boundary(polylineNodes([[0, 1], [0, 0.62], [0.16, 0.8], [0.34, 0.56], [0.5, 0.82], [0.7, 0.7], [0.88, 0.84], [1, 0.66], [1, 1]]), ["#8a2c8a"], ["#e0308c"], true),
]),
  preset("flare-ghost-sky", "Flare ghost sky", "A clear blue-to-peach afternoon sky with a blazing sun in one corner and a diagonal chain of pale lens-flare discs marching across the frame.", [
  ...sideRails(["#2a6cc4", "#68aee6", "#f2d2bc", "#f6b8a0"], 1, [0, 0.4, 0.75, 1]),
  ...glow(0.2, 0.2, 0.16, ["#ffffff", "#fff3c4", "#9cc6ee"]),
  ghost(0.42, 0.4, 0.07, "#8cbcea", "#d2ecf0"),
  ghost(0.54, 0.54, 0.035, "#b2c6e4", "#ffe6c0"),
  ghost(0.68, 0.64, 0.1, "#dccac8", "#f8d6e4"),
  ghost(0.8, 0.78, 0.05, "#f2b8a2", "#d8f0e8"),
]),
  preset("cloud-break-gold", "Cloud break gold", "A slate-blue cloud mass splitting over a gold horizon, its torn lower edge lit from behind, after rain-clearing skies.", [
  ...sideRails(["#2c4468", "#6a7ea0", "#f2c270", "#ffe2a0"], 0.8, [0, 0.4, 0.75, 1]),
  hline(0, ["#2c4468"]),
  boundary(lobeNodes([[0, 0], [1, 0], [1, 0.3], [0.8, 0.4], [0.6, 0.48], [0.4, 0.38], [0.2, 0.46], [0, 0.34]], [0, 0, 0, 0.16, 0.16, 0.16, 0, 0]),
    ["#5a6c8c", "#e0b476", "#e0b476", "#5a6c8c"], ["#56688a", "#2c3a5c", "#2c3a5c", "#56688a"], true),
  ...glow(0.5, 0.64, 0.1, ["#fffbe0", "#ffe6a0", "#f6c878"]),
  ridge([0.8, 0.78, 0.81, 0.8], ["#ffe2a0"], ["#2a2838"]),
  hline(1, ["#14121c"]),
]),
  preset("matte-dusk-strata", "Matte dusk strata", "Long lit cloud strata stacked in a blue-to-copper dusk above dark jagged rock, after Ralph McQuarrie's matte skies.", [
  ...sideRails(["#1e3262", "#4c5e9a", "#d6907c", "#f8c078"], 0.74, [0, 0.4, 0.78, 1]),
  hline(0, ["#1e3262"]),
  streak(0.35, 0.2, 0.26, 0.014, "#3a4c88", ["#f2b89c", "#c87a84"]),
  streak(0.62, 0.36, 0.3, 0.016, "#5c6aa0", ["#f8c8a0", "#d88c86"]),
  streak(0.4, 0.52, 0.3, 0.015, "#a6788c", ["#ffd6a0", "#f0a07c"]),
  streak(0.7, 0.64, 0.22, 0.012, "#d68c80", ["#ffe0a8", "#f8b27a"]),
  boundary(polylineNodes([[0, 1], [0, 0.8], [0.14, 0.72], [0.26, 0.8], [0.42, 0.76], [0.6, 0.84], [0.78, 0.74], [1, 0.8], [1, 1]]), ["#f8c078"], ["#16121e"], true),
]),
];
