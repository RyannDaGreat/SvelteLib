/**
 * "Ornament & tile" — native Multipoint presets. Girih, Isfahan, Ardabil, zellige, Iznik, talavera, Book of Kells, Ravenna mosaic and Gothic glass.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, rectNodes, waveNodes } from "../multipoint_shapes.js";
import { blobNodes, leafNodes, polar } from "./art_homages.js";
import { ground, cuspStarNodes, archNodes, crossNodes, spiralRibbonNodes } from "./ornament_helpers.js";

/**
 * Pure function. boundary() whose single outside colour is repeated to match a longer inside ramp, so a
 * crisp rim can border a glazed multi-stop body.
 * @param {number[][]} nodes - [N,6] geometry.
 * @param {string[]} colors - Outside (left) palette; one colour is repeated to the inside length.
 * @param {string[]|null} rightColors - Inside palette or null.
 * @param {boolean} closed - Close the feature.
 * @returns {object} Feature.
 * @example edged([[0,0,0,0,0,0]], ["#000000"], ["#ffffff", "#ff0000"], true).stops.length // 2
 */
function edged(nodes, colors, rightColors = null, closed = false) {
  const outside = rightColors && colors.length === 1 ? rightColors.map(() => colors[0]) : colors;
  return boundary(nodes, outside, rightColors, closed);
}

const PAPER = "#f4f1e8", COBALT = "#1b3a9c", TURQUOISE = "#22b0c2", TOMATO = "#d8401f";

const CREAM = "#f2ead4", BLACK_GROUT = "#14100e";

export const PRESETS = [
  // Isfahan girih: a ten-pointed star rosette in layered lapis, turquoise and cream.
  preset("girih-decagram", "Girih decagram", "A ten-pointed tile star in nested lapis, turquoise and cream with a glazed-blue heart.", [
    edged(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), ["#16226e", "#22358f", "#16226e"], null, true),
    edged(cuspStarNodes(0.5, 0.5, 0.48, 10, 0.07), ["#0c1448"], ["#f1e7c6"], true),
    edged(cuspStarNodes(0.5, 0.5, 0.455, 10, 0.07), ["#f1e7c6"], ["#1f8fa6", "#36b9bd", "#1f8fa6"], true),
    edged(cuspStarNodes(0.5, 0.5, 0.29, 10, 0.07, -Math.PI / 2 + Math.PI / 10), ["#0f5d78"], ["#f3e9c9"], true),
    edged(ellipseNodes(0.5, 0.5, 0.09), ["#f3e9c9"], ["#1c2f86"], true),
  ]),
  // Isfahan iwan: a pointed-arch niche in cobalt and turquoise mosaic, its recess dark indigo with a lamp-lit floor.
  preset("isfahan-iwan-arch", "Isfahan iwan arch", "A pointed arch in cobalt and turquoise tile with a cream inlay line, framing a deep indigo recess.", [
    ground("#1f88a8"),
    edged(archNodes(0.08, 0.92, 1, 0.72, 0.7), ["#0c2466"], ["#1f4fa8"], true),
    edged(archNodes(0.17, 0.83, 1, 0.72, 0.61), ["#1f4fa8"], ["#efe3bd"], true),
    edged(archNodes(0.185, 0.815, 1, 0.72, 0.585), ["#efe3bd"], ["#23a2b4"], true),
    edged(archNodes(0.27, 0.73, 1, 0.72, 0.43), ["#23a2b4"], ["#0d1438"], true),
    point(0.5, 0.96, "#f0b84a"),
  ]),
  // Ardabil-style carpet: indigo field, lobed madder medallion, cream inlay lines, madder border.
  preset("ardabil-medallion", "Ardabil medallion", "A lobed crimson medallion with an ivory heart on an indigo field, inside cream-lined madder borders.", [
    ground("#8a1f2c"),
    edged(rectNodes(0.07, 0.07, 0.93, 0.93), ["#8a1f2c"], ["#eadaa8"], true),
    edged(rectNodes(0.085, 0.085, 0.915, 0.915), ["#eadaa8"], ["#1a2158"], true),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.32, harmonics: [[4, 0.28, 0]], count: 8 }), ["#1a2158"], ["#eadaa8"], true),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.3, harmonics: [[4, 0.28, 0]], count: 8 }), ["#eadaa8"], ["#b3263a"], true),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.135, harmonics: [[4, 0.3, Math.PI / 4]], count: 8 }), ["#7a1626"], ["#f2e3ae"], true),
    edged(ellipseNodes(0.5, 0.5, 0.045), ["#f2e3ae"], ["#1a2b7a"], true),
  ]),
  // Moroccan zellige: hand-cut glazed tesserae fitted into an eight-pointed star, black gaps, terracotta field.
  preset("zellige-eight-star", "Zellige eight-star", "An eight-pointed star of cobalt, cream and emerald cut-tile rings on terracotta, edged in black grout.", [
    ground("#b9492a"),
    edged(cuspStarNodes(0.5, 0.5, 0.485, 8, 0.12), ["#b9492a"], [BLACK_GROUT], true),
    edged(cuspStarNodes(0.5, 0.5, 0.465, 8, 0.12), [BLACK_GROUT], ["#1d41a0", "#2e5dc4", "#1d41a0"], true),
    edged(cuspStarNodes(0.5, 0.5, 0.33, 8, 0.12, -Math.PI / 2 + Math.PI / 8), ["#1d41a0"], [CREAM], true),
    edged(cuspStarNodes(0.5, 0.5, 0.19, 8, 0.12), [CREAM], ["#1b7c56"], true),
    edged(ellipseNodes(0.5, 0.5, 0.06), ["#1b7c56"], ["#e2a82a"], true),
  ]),
  // Fez zellige: a twelve-pointed star of glazed tile in emerald, cream and cobalt on black grout.
  preset("zellige-twelve-star", "Zellige twelve-star", "A twelve-pointed star of emerald, cream and cobalt cut tile on black grout, as in Fez zellige.", [
    ground(BLACK_GROUT),
    edged(cuspStarNodes(0.5, 0.5, 0.49, 12, 0.1), [BLACK_GROUT], ["#1b7c56"], true),
    edged(cuspStarNodes(0.5, 0.5, 0.37, 12, 0.1, -Math.PI / 2 + Math.PI / 12), ["#1b7c56"], [CREAM], true),
    edged(cuspStarNodes(0.5, 0.5, 0.24, 12, 0.1), [CREAM], ["#1d41a0"], true),
  ]),
  // Iznik: cobalt ring, serrated saz leaves in turquoise and cobalt, tomato-red blossom on white.
  preset("iznik-saz-rosette", "Iznik saz rosette", "A cobalt ring around saz leaves and a tomato-red blossom, painted on white like Ottoman Iznik ware.", [
    ground(PAPER),
    edged(ellipseNodes(0.5, 0.5, 0.485), [PAPER], [COBALT], true),
    edged(ellipseNodes(0.5, 0.5, 0.435), [COBALT], [PAPER], true),
    ...[1, 3, 5, 7].map((k) => edged(leafNodes(...polar(0.5, 0.5, 0.15, k * Math.PI / 4), ...polar(0.5, 0.5, 0.385, k * Math.PI / 4), 0.14), [PAPER], [COBALT], true)),
    ...[0, 2, 4, 6].map((k) => edged(leafNodes(...polar(0.5, 0.5, 0.17, k * Math.PI / 4), ...polar(0.5, 0.5, 0.36, k * Math.PI / 4), 0.09), [PAPER], [TURQUOISE], true)),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.11, harmonics: [[5, 0.18, 0]], count: 10 }), [COBALT], [TOMATO], true),
  ]),
  // Talavera de Puebla: concentric cobalt and yellow rings, an orange flower and green leaves on milk-white glaze.
  preset("talavera-puebla-plate", "Talavera Puebla plate", "Cobalt and yellow rings around an orange flower with green leaves on milk-white glaze, in Puebla talavera colours.", [
    ground("#f3efe3"),
    edged(ellipseNodes(0.5, 0.5, 0.485), ["#f3efe3"], ["#23409c"], true),
    edged(ellipseNodes(0.5, 0.5, 0.435), ["#23409c"], ["#f2b92e"], true),
    edged(ellipseNodes(0.5, 0.5, 0.39), ["#f2b92e"], ["#f6f3ea"], true),
    ...[0, 1, 2, 3].map((k) => edged(leafNodes(...polar(0.5, 0.5, 0.26, k * Math.PI / 2), ...polar(0.5, 0.5, 0.36, k * Math.PI / 2), 0.07), ["#f6f3ea"], ["#2f8a4a"], true)),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.19, harmonics: [[6, 0.14, Math.PI / 6]], count: 12 }), ["#23409c"], ["#e2572b"], true),
    edged(ellipseNodes(0.5, 0.5, 0.08), ["#e2572b"], ["#f2b92e"], true),
  ]),
  // Book of Kells: three coiled arms in orange, gold and green over a madder roundel on dark vellum-ink.
  preset("kells-triskele-roundel", "Kells triskele roundel", "Three spiral arms in orange, gold and green coiling on madder vellum-ink, in the manner of the Book of Kells.", [
    edged(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), ["#7d2a20", "#5a1d18", "#7d2a20"], null, true),
    ...[["#e0702a", -Math.PI / 2], ["#ecbc3c", -Math.PI / 2 + 2 * Math.PI / 3], ["#4f8a48", -Math.PI / 2 + 4 * Math.PI / 3]].map(([color, angle]) => {
      const [cx, cy] = polar(0.5, 0.5, 0.235, angle);
      return edged(spiralRibbonNodes({ cx, cy, r0: 0.19, r1: 0.04, turns: 1.25, phase: angle + 2.4, spans: 5, width: (t) => 0.085 * Math.sin(Math.PI * t) }), ["#7d2a20"], [color], true);
    }),
  ]),
  // Galla Placidia: lapis starry vault with a gold cross and four gold stars.
  preset("galla-placidia-vault", "Galla Placidia vault", "A gold cross and four gold stars on a deep lapis mosaic sky, as in the Ravenna mausoleum vault.", [
    ground("#091443"),
    edged(ellipseNodes(0.5, 0.5, 0.47), ["#091443"], ["#1a3aa8", "#13298a", "#1a3aa8"], true),
    edged(crossNodes(0.5, 0.5, 0.27, 0.05), ["#8a6a1a"], ["#f7d86a", "#d39a25", "#f7d86a"], true),
    ...[[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => edged(cuspStarNodes(x, y, 0.06, 4, 0.3), ["#13298a"], ["#f2cc55"], true)),
    point(0.5, 0.5, "#fff2b0"),
  ]),
  // Ravenna gold ground: concentric gold tesserae rings around a lapis halo above a green meadow.
  preset("ravenna-gold-halo", "Ravenna gold halo", "A lapis halo bearing a gold cross in rings of light and dark gold tesserae above a green flowered meadow.", [
    edged(rectNodes(0, 0, 1, 1), ["#c99a2e", "#e3bc50", "#a87c1c", "#c99a2e"], null, true),
    edged(ellipseNodes(0.5, 0.4, 0.34), ["#c99a2e"], ["#e9c860"], true),
    edged(ellipseNodes(0.5, 0.4, 0.26), ["#e9c860"], ["#a87a1a"], true),
    edged(ellipseNodes(0.5, 0.4, 0.185), ["#a87a1a"], ["#f0d478"], true),
    edged(ellipseNodes(0.5, 0.4, 0.125), ["#7a5410"], ["#2a4f8a"], true),
    edged(crossNodes(0.5, 0.4, 0.075, 0.02), ["#2a4f8a"], ["#f0c850"], true),
    edged(waveNodes({ x0: 0, x1: 1, y: 0.88, amplitude: -0.03, cycles: 0.5 }), ["#c99a2e"], ["#3d7a4a"]),
    point(0.2, 0.96, "#f4ecd8"), point(0.8, 0.95, "#c4453a"),
  ]),
  // Chartres: deep cobalt glass with a leaded ruby quatrefoil medallion, blue heart and lemon-gold boss.
  preset("chartres-blue-medallion", "Chartres blue medallion", "A leaded ruby quatrefoil medallion with a blue heart and gold boss on deep cobalt glass.", [
    edged(rectNodes(0, 0, 1, 1), ["#0f2078", "#1d3aa8", "#0f2078"], null, true),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.36, harmonics: [[4, 0.22, 0]], count: 8 }), ["#1d3aa8"], ["#08060c"], true),
    edged(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.335, harmonics: [[4, 0.22, 0]], count: 8 }), ["#08060c"], ["#b0122c", "#d42a44", "#b0122c"], true),
    edged(ellipseNodes(0.5, 0.5, 0.17), ["#6a0a1c"], ["#08060c"], true),
    edged(ellipseNodes(0.5, 0.5, 0.15), ["#08060c"], ["#1d3aa8"], true),
    edged(ellipseNodes(0.5, 0.5, 0.07), ["#0f2078"], ["#ffd45a"], true),
    ...[[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => point(x, y, "#8aa8ff")),
  ]),
  // Sainte-Chapelle: three tall lancets of ruby and cobalt glass set in dark stone.
  preset("sainte-chapelle-lancets", "Sainte-Chapelle lancets", "Three pointed lancets of ruby and cobalt glass glowing in dark stone, in the spirit of the Paris palace chapel.", [
    ground("#17121f"),
    edged(archNodes(0.06, 0.32, 1, 0.42, 0.26), ["#17121f"], ["#b01a2e", "#1a2f9a", "#b01a2e"], true),
    edged(archNodes(0.37, 0.63, 1, 0.34, 0.26), ["#17121f"], ["#1a2f9a", "#b01a2e", "#1a2f9a"], true),
    edged(archNodes(0.68, 0.94, 1, 0.42, 0.26), ["#17121f"], ["#b01a2e", "#1a2f9a", "#b01a2e"], true),
    ...[[0.19, 0.5, 0.05], [0.5, 0.42, 0.06], [0.81, 0.5, 0.05]].map(([x, y, r]) => edged(ellipseNodes(x, y, r), ["#17121f"], ["#ffcf7a", "#ffe9b8", "#ffcf7a"], true)),
    point(0.19, 0.78, "#ffd9a0"), point(0.5, 0.74, "#ffe6b8"), point(0.81, 0.78, "#ffd9a0"),
  ]),
  // Insular double spiral: two interleaved arms, red-lead and verdigris, winding out from a gold boss on vellum.
  preset("kells-double-spiral", "Kells double spiral", "Two interleaved spiral arms in red lead and verdigris winding out from a gold boss on warm vellum.", [
    ground("#e4d0a0"),
    ...[["#c8452a", 0], ["#3f7d5a", Math.PI]].map(([color, phase]) => edged(spiralRibbonNodes({ cx: 0.5, cy: 0.5, r0: 0.03, r1: 0.44, turns: 1.5, phase, spans: 6, width: (t) => 0.1 * Math.sin(Math.PI * t) }), ["#e4d0a0"], [color], true)),
    edged(ellipseNodes(0.5, 0.5, 0.045), ["#7a5410"], ["#e8b83a"], true),
  ]),
];
