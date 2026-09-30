/**
 * "Murals & street colour" — native Multipoint presets. Chroma-glitch murals, Okuda's faceted rainbows, spray fades, Chefchaouen blue, Jaipur pink, Valparaíso and La Boca tin.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { polylineNodes, ellipseNodes, mixHex, waveNodes } from "../multipoint_shapes.js";
import { boxEdge, boxFrame, archNodes, ring, bandStack, openEnds, clockwise, shrink, delaunay } from "./murals_helpers.js";

// ---------------------------------------------------------------------------------------------- shared small pieces
const CREAM = "#f4efe2", CONCRETE = ["#d6d3cc", "#a9a69f"], CONCRETE_LOCAL = "#c9c6bf";

/** Half-ellipse arch (feet on y = base) with a flat inside colour. */
const arch = (cx, base, rx, ry, inside, outside) => boundary(archNodes(cx, base, rx, ry), [outside], [inside], true);

/** Four copies of one colour: a constant ramp along a curve that carries four stops. */
const flat4 = (c) => [c, c, c, c];

const INK = "#0a0a12", PAPER = "#f3efe8";

/** Horizontal staircase polyline at height y: jogs by d1 at x = a and by d2 at x = b (pixel-chip edge). */
const stairLine = (y, [a, b], [d1, d2]) => polylineNodes([[0, y], [a, y], [a, y + d1], [b, y + d1], [b, y + d2], [1, y + d2]]);

export const PRESETS = [
  preset("chroma-glitch-bands", "Glitch bands", "Horizontal bands of black, white and drifting neon, their edges chipped into pixel stairs like a failing display.", bandStack([
  stairLine(0.14, [0.22, 0.61], [0.035, -0.02]), stairLine(0.3, [0.35, 0.78], [-0.03, 0.025]), stairLine(0.43, [0.15, 0.52], [0.03, -0.03]),
  stairLine(0.58, [0.42, 0.86], [-0.02, 0.03]), stairLine(0.73, [0.27, 0.66], [0.03, -0.025]), stairLine(0.86, [0.5, 0.8], [-0.03, 0.02]),
], [flat4("#090912"), ["#27c4e8", "#2a5cdc", "#7a2ae0", "#e0257e"], flat4(PAPER), ["#ffd21f", "#ff8a1f", "#ff2f6a", "#b0259e"], flat4("#090912"), ["#14b8c8", "#67d05a", "#ffd21f", "#ff8a1f"], flat4(PAPER)])),
  preset("chroma-speed-stripes", "Chroma speed stripes", "Diagonal racing stripes, each crossing from black through saturated hues to white, separated by hard black and white bands.", (() => {
  const curves = Array.from({ length: 7 }, (_, k) => { const y0 = 0.48 + 0.075 * k; return polylineNodes([[0, y0], [1, y0 - 0.46]]); });
  return bandStack(curves, [flat4(PAPER), ["#ffffff", "#27c4e8", "#2a5cdc", "#0b0b22"], flat4("#0b0b12"), ["#0b0b22", "#e0257e", "#ff4a2a", "#ffd21f"],
    flat4(PAPER), ["#ffd21f", "#67d05a", "#14b8c8", "#2a3fd0"], flat4("#0b0b12"), flat4(PAPER)]);
})()),
  preset("chroma-chevron-ramp", "Chroma chevron ramp", "Stacked zigzag bands, black and white alternating with spectral ramps that slide from one hue to the next along each chevron.", (() => {
  const zigzag = (y, dip) => polylineNodes([[0, y], [0.25, y - dip], [0.5, y], [0.75, y - dip], [1, y]]);
  return bandStack([0.2, 0.31, 0.42, 0.53, 0.64, 0.75, 0.86].map((y) => zigzag(y, 0.09)),
    [flat4(PAPER), ["#ffffff", "#27c4e8", "#2a5cdc", "#3a1aa8"], flat4(INK), ["#ff2e93", "#ff6a2a", "#ffd21f", "#ffb21f"], flat4(PAPER), ["#ffd21f", "#67d05a", "#14b8c8", "#2a3fd0"], flat4(INK), flat4(PAPER)]);
})()),
  // ---------------------------------------------------------------------------------------------------- Okuda San Miguel
  preset("okuda-grey-to-rainbow", "Okuda grey to rainbow", "Eleven faceted triangles that run from pewter greys on the left to a full rainbow on the right, each shaded toward a lighter corner.", (() => {
  // okuda_berlin.jpg: his grey-skinned figures stand beside rainbow-skinned ones, both built from triangular facets.
  const pts = [[0, 0], [0.42, 0], [1, 0], [1, 0.55], [1, 1], [0.62, 1], [0, 1], [0, 0.4], [0.3, 0.32], [0.68, 0.4], [0.45, 0.72]];
  const leftToRight = delaunay(pts).sort((a, b) => a.reduce((s, p) => s + p[0], 0) - b.reduce((s, p) => s + p[0], 0));
  const colors = ["#f0f0ee", "#c9c9cc", "#9d9da3", "#dcdce0", "#7d7d84", "#b2b2b8", "#f7c31a", "#f58a1f", "#e8383d", "#d63a8b", "#6a49b8", "#2a6fc9", "#1fa39a", "#6cbf3a"];
  return leftToRight.map((tri, i) => boundary(polylineNodes(clockwise(shrink(tri, 0.035))), flat4(CREAM).slice(0, 3), [colors[i], mixHex(colors[i], "#ffffff", 0.3), colors[i]], true));
})()),
  // ------------------------------------------------------------------------------------------------ spray-can gradients
  preset("spray-fade-bloom", "Spray fade bloom", "Nested clouds of cyan, violet, hot pink and sunny yellow, overlapping like three nozzle bursts on raw concrete.", (() => {
  const blob = (cx, cy, rx, ry, phase) => ring(cx, cy, (a) => [rx * (1 + 0.08 * Math.cos(2 * a + phase)), ry * (1 + 0.1 * Math.sin(3 * a + phase))], 6);
  return [
    boxFrame(CONCRETE),
    boundary(blob(0.46, 0.46, 0.38, 0.34, 0.4), ["#3cc6e8"], null, true),
    boundary(blob(0.52, 0.5, 0.27, 0.24, 1.3), ["#8a5ad8"], null, true),
    boundary(blob(0.56, 0.54, 0.17, 0.15, 2.2), ["#e8408a"], null, true),
    boundary(blob(0.6, 0.57, 0.08, 0.07, 0.7), ["#ffd83a"], null, true),
  ];
})()),
  preset("chefchaouen-dado-wash", "Chefchaouen dado wash", "A hand-brushed wavy line where whitewash gives way to layered blue lime-wash, mottled darker toward the foot of the wall.", (() => {
  // chef_blue.jpg / chef_2018.jpg: uneven cobalt and cerulean lime-wash under a whitewashed upper wall.
  const wave = openEnds(waveNodes({ x0: 0, x1: 1, y: 0.46, amplitude: 0.028, cycles: 1.5, phase: 0.6 }));
  wave[0][0] = 0; wave[wave.length - 1][0] = 1;
  return [
    boxEdge("top", ["#e9eef6"]),
    boundary(wave, ["#e9eef6", "#dfe6f2", "#eef2f8", "#d9e2f0"], ["#6aa8de", "#4f8fd2", "#6aa8de", "#3f7fc8"]),
    boxEdge("bottom", ["#0a3c96"]),
    boundary(ring(0.26, 0.74, (a) => [0.22 * (1 + 0.25 * Math.cos(2 * a + 0.5)), 0.11 * (1 + 0.3 * Math.sin(3 * a))], 7), ["#1b56b6"], null, true),
    boundary(ring(0.72, 0.64, (a) => [0.16 * (1 + 0.3 * Math.sin(2 * a + 1)), 0.07 * (1 + 0.3 * Math.cos(3 * a + 2))], 7), ["#8fc0ea"], null, true),
    boundary(ring(0.6, 0.89, (a) => [0.26 * (1 + 0.2 * Math.cos(3 * a)), 0.06 * (1 + 0.25 * Math.sin(2 * a))], 7), ["#0d43a2"], null, true),
  ];
})()),
  // -------------------------------------------------------------------------------------------------------------- Jaipur
  preset("jaipur-rose-gateway", "Jaipur rose gateway", "A cream-trimmed arch cut into rose sandstone, opening on a deep green courtyard, flanked by two small arched niches.", [
  // jaipur_hawa.jpg / jaipur_pink5.jpg: rose sandstone, cream stucco trim, green glass and shadow.
  boxFrame(["#ec9f8a", "#b9523f"]),
  arch(0.5, 0.985, 0.35, 0.78, "#f4e3d0", "#d98770"),
  arch(0.5, 0.985, 0.29, 0.7, "#e58f78", "#f4e3d0"),
  arch(0.5, 0.985, 0.21, 0.56, "#1d5f55", "#e58f78"),
  arch(0.07, 0.985, 0.05, 0.3, "#f4e3d0", "#de8c75"),
  arch(0.07, 0.985, 0.03, 0.24, "#1d5f55", "#f4e3d0"),
  arch(0.93, 0.985, 0.05, 0.3, "#f4e3d0", "#c9644d"),
  arch(0.93, 0.985, 0.03, 0.24, "#1d5f55", "#f4e3d0"),
]),
  // --------------------------------------------------------------------------------------------- Valparaiso and La Boca
  preset("valparaiso-dusk-patches", "Valparaiso dusk patches", "Soft patches of green, violet, tangerine and turquoise packed on a dark hillside beneath a cobalt dusk.", (() => {
  // valpo_houses.jpg: houses stacked up a cerro, every facade its own paint, here as lit windows at dusk.
  const patches = [
    [0.17, 0.83, 0.13, 0.09, "#6fd057"], [0.41, 0.86, 0.1, 0.08, "#f27fb0"], [0.66, 0.84, 0.12, 0.09, "#f6c431"], [0.88, 0.88, 0.07, 0.07, "#46c6cf"],
    [0.29, 0.64, 0.1, 0.08, "#9177e6"], [0.53, 0.66, 0.1, 0.08, "#2bbcc6"], [0.77, 0.66, 0.1, 0.08, "#f58b3b"],
    [0.41, 0.46, 0.08, 0.07, "#c2d94a"], [0.64, 0.46, 0.08, 0.07, "#cc449f"],
  ];
  return [boxFrame(["#1c4fa8", "#0c1a44"]), ...patches.map(([x, y, rx, ry, color]) => boundary(ellipseNodes(x, y, rx, ry), [color], null, true))];
})()),
  preset("caminito-corrugated-tin", "Caminito corrugated tin", "Corrugated iron sheets in ship-paint yellow, cobalt, red lead, jade and tangerine, each ridge catching the light.", (() => {
  // caminito_casa.jpg / caminito_calle.jpg: La Boca's houses are clad in tin painted with leftover ship paint.
  const sheets = [["#ffc400", 2], ["#2a70d4", 1], ["#e8302a", 1], ["#16a060", 1], ["#ff7a14", 1]];
  const valley = (c) => mixHex(c, "#1a0c22", 0.34), ridge = (c) => mixHex(c, "#fff4cc", 0.3);
  const bands = sheets.flatMap(([c, ridges]) => Array.from({ length: ridges }, () => [{ a: valley(c), b: ridge(c) }, { a: ridge(c), b: valley(c) }]).flat());
  // Each colour is a short ramp (rust at the foot, lighter at the top) so the sheets weather.
  const weathered = bands.map(({ a, b }) => ({ a: [mixHex(a, "#5a1808", 0.2), mixHex(a, "#ffffff", 0.1)], b: [mixHex(b, "#5a1808", 0.2), mixHex(b, "#ffffff", 0.1)] }));
  const curves = Array.from({ length: bands.length - 1 }, (_, i) => { const x = (i + 1) / bands.length + 0.013 * Math.sin(i * 1.7); return polylineNodes([[x, 1], [x, 0]]); });
  return bandStack(curves, weathered);
})()),
];
