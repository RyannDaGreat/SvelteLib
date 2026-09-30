/**
 * "World textiles" — native Multipoint presets. Batik, ikat, shibori, kente and Nordic knit: dyed and woven colour.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { ground, diamondNodes, antiDiagonalNodes, sSpine, edgedRibbon, cuspStarNodes } from "./textiles_helpers.js";

const UP_RIGHT = [Math.SQRT1_2, -Math.SQRT1_2];

/**
 * Pure function. A horizontal zigzag row across the box: `vees` V shapes of depth `depth`, endpoints on x=0 and x=1.
 * @param {number} y - Row centre line.
 * @param {number} depth - Peak-to-trough drop.
 * @param {number} vees - Integer V count >= 1 (nodes = 2*vees + 1).
 * @returns {number[][]} Sharp polyline nodes.
 * @example zigzagRow(0.5, 0.1, 1).map((n) => n.slice(0, 2)) // [[0,0.5],[0.5,0.6],[1,0.5]]
 */
const zigzagRow = (y, depth, vees) =>
  polylineNodes(Array.from({ length: 2 * vees + 1 }, (_, i) => [i / (2 * vees), i % 2 ? y + depth : y]));

export const PRESETS = [
  // Parang: cream S-ribbons with knobbed ends on a dark soga ground, each edged in burnt orange (Yogyakarta court batik).
  preset("parang-rusak", "Parang rusak", "Cream S-ribbons with knobbed ends, edged in burnt orange, running diagonally over dark soga brown.", [
    ground("#2a140b"),
    ...[[0.34, 0.34, 0.34], [0.66, 0.66, 0.34]].flatMap(([cx, cy, half]) =>
      edgedRibbon(sSpine([cx, cy], UP_RIGHT, half, 0.1, 4), [0.12, 0.07, 0.07, 0.12], 0.016, "#2a140b", "#c2611f", "#f1e2b8")),
  ]),
  // Ikat: dye-resist warp threads bleed at every colour change; rows of feathered arrows in white on deep teal.
  preset("teal-chevron-ikat", "Teal chevron ikat", "Rows of soft-edged white arrowheads on deep teal, the dye-bleed feather of warp ikat.",
    Array.from({ length: 8 }, (_, i) => boundary(zigzagRow(0.05 + i * 0.115, 0.09, 2),
      i % 2 ? ["#f4f1e6", "#dfe9e6", "#f4f1e6"] : ["#0c4a58", "#15707a", "#0c4a58"]))),
  // Shibori kumo: pleated-and-bound spider burst; scalloped rings of pale blue fade from the tied centre into indigo.
  preset("kumo-shibori", "Kumo shibori", "Scalloped spider-web rings of pale blue fading into deep indigo, as in bound-and-dipped kumo shibori.", [
    ground("#0e2058"),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.4, harmonics: [[6, 0.14, 0]], count: 12 }), ["#3e6cb8"], null, true),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.25, harmonics: [[6, 0.16, Math.PI / 6]], count: 12 }), ["#7ea3dc"], ["#eef4fc"], true),
    point(0.5, 0.5, "#ffffff"),
  ]),
  // Adras ikat: vertical warp stripes, each colour change bleeding into the next through a jagged feathered seam.
  preset("adras-ikat", "Adras ikat", "Cherry, cream, indigo and saffron warp stripes bleeding through jagged feathered seams, as in Uzbek adras.",
    ["#c4122f", "#f1e5d0", "#232b78", "#e8a11c", "#c4122f", "#d02a74", "#f1e5d0", "#232b78"].map((color, i) =>
      boundary(polylineNodes(Array.from({ length: 5 }, (_, k) => [0.06 + i * 0.125 + (k % 2 ? 0.045 : -0.045) * (i % 2 ? 1 : -1), k / 4].map((v, axis) => (axis ? v : Math.min(0.999, Math.max(0.001, v)))))), [color, mixHex(color, "#000000", 0.18), color]))),
  // Arashi shibori: cloth wound round a pole and dyed leaves diagonal, rain-like streaks of indigo and white.
  preset("arashi-shibori", "Arashi shibori", "Diagonal storm-streaks of indigo and white, as if rain were dyed into the cloth (pole-wound arashi).",
    [0.14, 0.4, 0.66, 0.92, 1.1, 1.36, 1.62, 1.86].map((c, i) =>
      boundary(antiDiagonalNodes(c, [0, 0.018 * (i % 3 - 1), -0.02, 0.016, 0]), i % 2 ? ["#eef3f8", "#cfdcec", "#eef3f8"] : ["#0d2260", "#1e3f8c", "#0d2260"]))),
  // Kente weft-float: horizontal bands of Asante colour, every second seam stepping into a zigzag like patterned strip-weave.
  preset("kente-zigzag", "Kente zigzag", "Gold, green, red, blue and black bands whose seams alternate straight and zigzag, like Asante strip-weave.", (() => {
    const seams = [[0.08, 1], [0.19, 0], [0.28, 1], [0.4, 1], [0.49, 0], [0.6, 1], [0.69, 1], [0.79, 0], [0.87, 1]];
    const bands = ["#15130e", "#f4b41a", "#1c8a3a", "#c81e28", "#f4b41a", "#1856a8", "#f07a1a", "#15130e", "#1c8a3a", "#f4b41a"];
    return seams.map(([y, zig], i) => boundary(zig ? zigzagRow(y, 0.045, 2) : polylineNodes([[0, y], [1, y]]), [bands[i]], [bands[i + 1]]));
  })()),
  // Selburose: the eight-petalled star of Norwegian knitting in white on red.
  preset("selbu-rose", "Selbu rose", "A cream eight-petalled star on Norwegian knit red, with a red heart and corner lozenges.", [
    ground("#b3202a"),
    boundary(cuspStarNodes(0.5, 0.5, 0.44, 8, 0.2), ["#b3202a"], ["#f3ebda"], true),
    boundary(cuspStarNodes(0.5, 0.5, 0.25, 8, 0.2, -Math.PI / 2 + Math.PI / 8), ["#f3ebda"], ["#b3202a"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.07), ["#b3202a"], ["#f3ebda"], true),
    ...[[0.09, 0.09], [0.91, 0.09], [0.09, 0.91], [0.91, 0.91]].map(([x, y]) => boundary(diamondNodes(x, y, 0.06, 0.06), ["#b3202a"], ["#f3ebda"], true)),
  ]),
];
