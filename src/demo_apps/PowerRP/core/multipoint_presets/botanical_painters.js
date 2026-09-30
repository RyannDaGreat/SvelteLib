/**
 * "Botanical art" — native Multipoint presets. O'Keeffe close-ups, Dutch and Redouté flower painting, and Blossfeldt's plant forms.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, spiralNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { leafNodes, edgeLine, cuspedStarNodes, shaded, sidePetal, blossomNodes, frame } from "./botanical_painters_helpers.js";

export const PRESETS = [
  (() => {
const pleat = (cx, cy, r0, r1, a, width, ink) =>
  boundary(leafNodes({ cx: cx + Math.cos(a) * (r0 + r1) / 2, cy: cy + Math.sin(a) * (r0 + r1) / 2, length: r1 - r0, width, angle: a, taper: 1 }), [ink], null, true);
const PHASE = -Math.PI / 2 + 0.2, STEP = Math.PI * 2 / 5;
return preset("jimson-weed-trumpet", "Jimson weed trumpet", "O'Keeffe's Jimson Weed: a white trumpet flower filling the frame, lilac shadows, a green throat, against deep blue-green leaf and sky.", [
  edgeLine("top", ["#8fb4c4", "#5c8c9c"]), edgeLine("bottom", ["#0f2a30", "#14343a"]),
  edgeLine("left", ["#7aa4b4", "#10303a"]), edgeLine("right", ["#4a7c8c", "#0e2a34"]),
  shaded(cuspedStarNodes({ cx: 0.5, cy: 0.5, outer: 0.49, inner: 0.34, points: 5, phase: PHASE, sag: 0.5 }), "#143840", ["#fbfaf6", "#d8d6e6", "#f2f0ea"]),
  ...[0, 1, 2, 3, 4].map((k) => pleat(0.5, 0.5, 0.2, 0.29, PHASE + STEP * (k + 0.5), 0.035, "#c4c0e0")),
  shaded(ellipseNodes(0.5, 0.5, 0.16, 0.15), "#eae8ee", ["#c6dc8a", "#6f9a4a", "#dfe8b0"]),
  point(0.5, 0.5, "#f2f2c2"),
]);
})(),
  (() => {
const PAPER = "#efe3c6", TAU = Math.PI * 2;
const CENTER = 0.5, PETALS = 6, R_BASE = 0.07, R_TIP = 0.45, PETAL_WIDTH = 0.2, TILT = 0.25;
const petal = (k) => {
  const a = -Math.PI / 2 + TILT + TAU * k / PETALS, c = Math.cos(a), s = Math.sin(a);
  return sidePetal({ bx: CENTER + R_BASE * c, by: CENTER + R_BASE * s, tx: CENTER + R_TIP * c, ty: CENTER + R_TIP * s, width: PETAL_WIDTH, taper: 0.3,
    ground: PAPER, tip: "#fffdf6", right: "#f4d6d2", left: "#94ab7c" });
};
const anther = (k) => {
  const a = -Math.PI / 2 + TILT + TAU * (k + 0.5) / PETALS;
  return point(CENTER + 0.2 * Math.cos(a), CENTER + 0.2 * Math.sin(a), "#a8431e");
};
return preset("redoute-white-lily", "Redouté white lily", "A Redouté lily on cream paper: six recurved petals, pearl white with blush and green shadow, a green throat and rust anthers.", [
  boundary(ellipseNodes(CENTER, CENTER, 0.075), ["#dcd884"], null, true),
  ...[0, 1, 2, 3, 4, 5].map(petal),
  ...[0, 2, 4].map(anther),
  point(CENTER, CENTER, "#c8d070"),
]);
})(),
  (() => {
const PAPER = "#efe2c8";
return preset("redoute-blush-rose", "Redouté blush rose", "A full-blown pink China rose seen from above, petals whorled in blush and deep rose on warm paper, with a rosehip and leaves.", [
  boundary(blossomNodes({ cx: 0.45, cy: 0.42, radius: 0.36, depth: 0.22, petals: 5, phase: 0.3 }), [PAPER, PAPER, PAPER, PAPER], ["#f4c8c8", "#e6a0ac", "#f8d8d4", "#f4c8c8"], true),
  boundary(spiralNodes({ cx: 0.45, cy: 0.42, startRadius: 0.02, endRadius: 0.22, turns: 1.25 }), ["#fdeeee", "#e48a9c", "#b83c58"], ["#c8506a", "#f4b4bc", "#fbd8d8"]),
  sidePetal({ bx: 0.78, by: 0.72, tx: 0.95, ty: 0.92, width: 0.12, taper: 0.4, ground: PAPER, tip: "#4a7a44", right: "#7fa870", left: "#345a34" }),
  sidePetal({ bx: 0.26, by: 0.8, tx: 0.06, ty: 0.94, width: 0.1, taper: 0.4, ground: PAPER, tip: "#4a7a44", right: "#7fa870", left: "#345a34" }),
  boundary(ellipseNodes(0.62, 0.86, 0.045, 0.055), [PAPER], ["#e0643a"], true),
]);
})(),
  (() => {
const PAPER = "#e2d6bb";
const right = [[0.6, 0.17], [0.94, 0.12], [0.64, 0.4], [0.96, 0.35], [0.6, 0.64]];
const left = right.map(([x, y]) => [1 - x, y]).reverse();
const points = [[0.5, 0.03], ...right, [0.56, 1], [0.44, 1], ...left];
const SHARP = new Set([0, 2, 4, 6, 7, 9, 11]);
const silhouette = catmullRomNodes(points, true).map((n, i) => (SHARP.has(i) ? [n[0], n[1], 0, 0, 0, 0] : n));
const DARK = "#4a3524";
const bud = (y, length, width) => sidePetal({ bx: 0.5, by: y + length / 2, tx: 0.5, ty: y - length / 2, width, taper: 0.3, ground: DARK, tip: "#7a6040", right: "#fff6dc", left: "#e4d6b0" });
return preset("blossfeldt-acanthus-spike", "Blossfeldt acanthus spike", "Karl Blossfeldt's Acanthus mollis: a sepia photogram of a spined stem, translucent buds glowing inside it, on a warm cream ground.", [
  shaded(silhouette, PAPER, ["#2e2016", "#a8906a", "#6a5238"]),
  bud(0.29, 0.2, 0.13), bud(0.56, 0.2, 0.13), bud(0.83, 0.2, 0.06),
]);
})(),
  // Blossfeldt, Nigella: a horned seed capsule seen end-on, dark spined star around a glowing translucent core.
  (() => {
const PAPER = "#e6dbc2", TAU = Math.PI * 2, POINTS = 6;
return preset("blossfeldt-horned-capsule", "Blossfeldt horned capsule", "A Blossfeldt seed capsule seen end-on: six swept horns in dark sepia around a pale glowing core, on warm photographic paper.", [
  shaded(cuspedStarNodes({ cx: 0.5, cy: 0.5, outer: 0.48, inner: 0.17, points: POINTS, phase: -Math.PI / 2, sag: 0.9 }), PAPER, ["#2a1a10", "#7a6244", "#4a3422"]),
  boundary(cuspedStarNodes({ cx: 0.5, cy: 0.5, outer: 0.3, inner: 0.1, points: POINTS, phase: -Math.PI / 2 + TAU / 12, sag: 0.9 }), ["#3a2718"], ["#b89c74", "#f0e4c4", "#d8c8a0", "#b89c74"].slice(0, 1), true),
  boundary(ellipseNodes(0.5, 0.5, 0.05), ["#f6eed8"], null, true),
]);
})(),
  // Blossfeldt, fern crozier: a coiled frond, dark furled back and pale translucent flank, on photographic paper.
  (() => {
const PAPER = "#e4d9c0";
return preset("blossfeldt-fern-crozier", "Blossfeldt fern crozier", "A Blossfeldt fern crozier: one sepia frond coiling into a tight spiral, dark on its furled back and pale and translucent on its open side.", [
  frame([PAPER]),
  boundary(spiralNodes({ cx: 0.5, cy: 0.42, startRadius: 0.03, endRadius: 0.3, turns: 1.5, phase: -Math.PI / 2 }),
    ["#f4ecd6", "#b89c74", "#3a281a"], ["#2a1a10", "#6a5238", "#e8dcbc"]),
]);
})(),
  // Ruysch / Dutch tulip mania: a flamed parrot tulip, cream with crimson feathering, glowing from a near-black ground.
  (() => {
const BLACK = "#08090b", WINE = "#2c0a12";
const tulipPetal = (bx, by, tx, ty, w, tip, right, left) => sidePetal({ bx, by, tx, ty, width: w, taper: 0.4, ground: WINE, tip, right, left });
const greenLeaf = (bx, by, tx, ty, w) => sidePetal({ bx, by, tx, ty, width: w, taper: 0.5, ground: BLACK, tip: "#5f9250", right: "#1b3a22", left: "#3a6a3a" });
return preset("dutch-flamed-tulip", "Dutch flamed tulip", "A Dutch Golden Age parrot tulip: cream petals feathered with crimson flame, lit from the left against a near-black ground with green leaves.", [
  edgeLine("top", ["#101a1c", "#1c2c2c"]), edgeLine("left", ["#101a1c", BLACK]), edgeLine("bottom", [BLACK]),
  greenLeaf(0.56, 0.93, 0.92, 0.62, 0.16), greenLeaf(0.44, 0.93, 0.08, 0.68, 0.13),
  sidePetal({ bx: 0.5, by: 0.98, tx: 0.5, ty: 0.7, width: 0.05, taper: 0.5, ground: BLACK, tip: "#6a9a52", right: "#2a5030", left: "#1c3a22" }),
  tulipPetal(0.5, 0.68, 0.5, 0.08, 0.2, "#fff2e6", "#d23a2c", "#fbeadb"),
  tulipPetal(0.43, 0.66, 0.12, 0.3, 0.14, "#e8765a", "#fbe6d6", "#b82a2a"),
  tulipPetal(0.57, 0.66, 0.88, 0.26, 0.14, "#fff0e0", "#c22e2a", "#f8e0d0"),
]);
})(),
  // O'Keeffe-like close-up poppy: four broad crimson petals, a dark seed boss and a dark blotch at the base of every petal, against a midnight teal ground.
  (() => {
const GROUND = "#14202a", TAU = Math.PI * 2, PETALS = 4, TILT = 0.4;
const petal = (k) => {
  const a = TILT + TAU * k / PETALS, c = Math.cos(a), s = Math.sin(a);
  return sidePetal({ bx: 0.5 + 0.09 * c, by: 0.5 + 0.09 * s, tx: 0.5 + 0.47 * c, ty: 0.5 + 0.47 * s, width: 0.33, taper: 0.1, ground: GROUND,
    tip: "#ffb48a", right: "#e23a24", left: "#ff6a3c" });
};
const blotch = (k) => { const a = TILT + TAU * k / PETALS; return point(0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), "#3a0a0e"); };
return preset("poppy-close-up", "Poppy close-up", "A poppy filling the frame: four broad scarlet petals with a dark blotch at each base around a black seed boss, against midnight teal.", [
  ...[0, 1, 2, 3].map(petal),
  boundary(ellipseNodes(0.5, 0.5, 0.07), ["#b8321e"], ["#10080a"], true),
  ...[0, 1, 2, 3].map(blotch),
]);
})(),
  // O'Keeffe, Calla Lily on grey: a single white spathe sweeping out of the frame with a yellow spadix, against cool grey.
  (() => {
const GREY = "#9aa6a0";
const spathe = catmullRomNodes([[0.3, 0.05], [0.6, 0.18], [0.86, 0.5], [0.76, 0.84], [0.48, 0.96], [0.2, 0.8], [0.13, 0.44]], true).map((n, i) => (i ? n : [n[0], n[1], 0, 0, 0, 0]));
return preset("calla-lily-grey", "Calla lily on grey", "O'Keeffe's calla lily: one sweeping white spathe with soft grey-green shadow folds and a golden spadix against a cool grey field.", [
  edgeLine("top", ["#c4ccc8", "#8e9a96"]), edgeLine("bottom", ["#6f7c78", "#8e9a96"]), edgeLine("left", ["#c4ccc8", "#6f7c78"]), edgeLine("right", ["#8e9a96", "#7a8682"]),
  shaded(spathe, GREY, ["#ffffff", "#dde5df", "#eef2ec"]),
  boundary(leafNodes({ cx: 0.36, cy: 0.66, length: 0.42, width: 0.07, angle: 1.2, taper: 0.8 }), ["#b4c2b8"], null, true),
  boundary(leafNodes({ cx: 0.64, cy: 0.6, length: 0.36, width: 0.06, angle: 1.9, taper: 0.8 }), ["#c2cec6"], null, true),
  boundary(leafNodes({ cx: 0.5, cy: 0.42, length: 0.36, width: 0.085, angle: -1.75, taper: 0.4 }), ["#e9e2b8"], ["#e8b82a"], true),
]);
})(),
  // Ruysch-style cabbage rose: a full bloom of peach and rose whorls glowing out of a near-black ground, with a bud and leaves.
  (() => {
const BLACK = "#08090b", LEAF = "#11271a";
return preset("ruysch-cabbage-rose", "Ruysch cabbage rose", "A Dutch Golden Age cabbage rose: layered peach and deep-rose petals whorling to a dark heart, a bud and green leaves, glowing out of a near-black ground.", [
  edgeLine("top", ["#101c1c", "#1b2c2a"]),
  sidePetal({ bx: 0.78, by: 0.74, tx: 0.96, ty: 0.92, width: 0.13, taper: 0.4, ground: BLACK, tip: "#5a8a50", right: "#2a5030", left: "#1a3a24" }),
  sidePetal({ bx: 0.22, by: 0.8, tx: 0.05, ty: 0.94, width: 0.11, taper: 0.4, ground: BLACK, tip: "#4a7a48", right: "#1f4028", left: "#2c5232" }),
  boundary(blossomNodes({ cx: 0.46, cy: 0.42, radius: 0.4, depth: 0.16, petals: 6, phase: 0.2 }), [BLACK, BLACK, BLACK, BLACK], ["#5a1626", "#dc8a86", "#ffe4d0", "#5a1626"], true),
  boundary(spiralNodes({ cx: 0.46, cy: 0.42, startRadius: 0.02, endRadius: 0.24, turns: 1.25, phase: 0.3 }), ["#ffe8d6", "#d87884", "#6a1c2e"], ["#5a1626", "#e89a92", "#ffdcc8"]),
]);
})(),
];
