/**
 * "Post-Impressionism" — native Multipoint presets. Van Gogh, Gauguin, Signac and the Nabis: starry skies, cypresses, blossom and vermilion fields.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, point } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { hline, ridge, disc, soft, shape, ribbonNodes } from "./impressionism_helpers.js";

/**
 * Pure function. Van Gogh sunflower head: a two-sided golden-brown disc holding a dark seed centre.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Head radius.
 * @param {string} ground - Colour just outside the head.
 * @param {string[]} petals - Three petal-side colours (closed automatically).
 * @param {string} seeds - Seed-disc colour.
 * @returns {object[]} Two features (8 nodes).
 * @example sunflower(0.5,0.5,0.1,"#ee0",["#a","#b","#c"],"#432").length // 2
 */
export function sunflower(cx, cy, r, ground, petals, seeds) {
  return [shape(ellipseNodes(cx, cy, r), [ground], [...petals, petals[0]]), shape(ellipseNodes(cx, cy, r * 0.36), [petals[0]], [seeds])];
}

/** Cypress flame: smooth Catmull-Rom sides with a sharpened tip (nodes[3]); clockwise, close the feature. */
const CYPRESS = (() => {
  const nodes = catmullRomNodes([[0.65, 0.97], [0.64, 0.66], [0.7, 0.36], [0.77, 0.05], [0.86, 0.36], [0.91, 0.66], [0.89, 0.97]]);
  nodes[3] = [nodes[3][0], nodes[3][1], ...nodes[3].slice(2).map((v) => v * 0.25)];
  nodes[0] = [...nodes[0].slice(0, 2), 0, 0, ...nodes[0].slice(4)];
  nodes[6] = [...nodes[6].slice(0, 4), 0, 0];
  return nodes;
})();

export const PRESETS = [
  preset("starry-night-rhone", "Starry Night over the Rhône", "Arles at night: cobalt sky, ringed gold stars, a dark shore and long gas-light reflections in the river.", [
    hline(0, ["#0f1f5c", "#1a3a8f", "#0f2a6a"]), hline(1, ["#101a44", "#1c2c6a", "#0f1f4a"]),
    ridge([0.52, 0.5, 0.53, 0.5], ["#1a3a8f", "#22449a", "#1a3a8f"], ["#0d1a3a", "#0f1f44", "#0d1a3a"]),
    ...[[0.2, 0.16, 0.05], [0.55, 0.1, 0.045], [0.82, 0.24, 0.055]].map(([x, y, r]) => shape(ellipseNodes(x, y, r), ["#12308a"], ["#fff4b8", "#f0c850", "#fff4b8"])),
    ...[0.22, 0.5, 0.78].map((x, i) => soft(x, 0.78, 0.028, 0.13 - i * 0.01, i === 1 ? "#f6d860" : "#f0b840")),
    point(0.3, 0.55, "#f4c850"), point(0.62, 0.56, "#f4c850"), point(0.85, 0.54, "#f4c850"),
  ]),
  preset("sunflowers-turquoise", "Three sunflowers, turquoise", "Van Gogh's Munich vase: orange-gold blooms tilted across an intense blue-green wall.", [
    hline(0, ["#3a9aa8", "#50b0b4", "#3a8a9a"]), hline(1, ["#2f7a8a", "#3f96a0", "#2a6a80"]),
    ...sunflower(0.3, 0.32, 0.15, "#3a9aa8", ["#d87a10", "#f2b220", "#b85a10"], "#4a4a18"),
    ...sunflower(0.66, 0.26, 0.13, "#50b0b4", ["#e08a14", "#f8c630", "#c06a12"], "#5a4a18"),
    ...sunflower(0.56, 0.68, 0.14, "#3f96a0", ["#d47410", "#f0ae1c", "#b25610"], "#3a4a1a"),
    soft(0.16, 0.8, 0.09, 0.09, "#245c70"), soft(0.88, 0.7, 0.08, 0.08, "#f0c040"),
  ]),
  preset("wheatfield-cypresses", "Wheatfield with Cypresses", "Saint-Rémy 1889: rolling turquoise and white clouds, blue hills, a golden wheatfield and a black-green cypress flame.", [
    hline(0, ["#4a8ac0", "#8ec0d8", "#6aa8d0"]), hline(1, ["#e8b820", "#f0d040", "#c89a20"]),
    soft(0.3, 0.2, 0.2, 0.07, "#f6f4ec"), soft(0.5, 0.36, 0.1, 0.04, "#7fd0c8"), soft(0.3, 0.46, 0.28, 0.045, "#6f90c8"),
    soft(0.18, 0.64, 0.14, 0.07, "#9ab878"), soft(0.32, 0.86, 0.22, 0.06, "#f8e070"),
    shape(CYPRESS, ["#7aa872"], ["#1a3a2a", "#2f5a3a", "#12281e", "#1a3a2a"]),
  ]),
  preset("almond-blossom", "Almond Blossom", "Saint-Rémy 1890: cream and pink blossom beside dark tapering branches on a soft turquoise sky.", [
    hline(0, ["#6fb0c0", "#90ccd0", "#7cbac8"]), hline(1, ["#5aa0b4", "#7cc0c4", "#66aab8"]),
    shape(ribbonNodes([[0.05, 0.94], [0.26, 0.68], [0.5, 0.5], [0.86, 0.1]], [0.04, 0.03, 0.022, 0.01]), ["#7cc0c4"], ["#3f6a5a", "#4a7a62", "#3a6250", "#3f6a5a"]),
    shape(ribbonNodes([[0.95, 0.74], [0.76, 0.7], [0.58, 0.8], [0.42, 0.95]], [0.03, 0.026, 0.02, 0.012]), ["#7cc0c4"], ["#446e5c", "#3f6a5a", "#4a7a62", "#446e5c"]),
    soft(0.2, 0.46, 0.06, 0.045, "#fff8e4"), soft(0.44, 0.3, 0.06, 0.045, "#f9dde4"), soft(0.72, 0.11, 0.055, 0.04, "#fffbe8"),
    soft(0.62, 0.55, 0.055, 0.04, "#fff0e8"), soft(0.84, 0.88, 0.05, 0.04, "#fdeae6"),
  ]),
  preset("saint-tropez-harbour", "Signac, Port of Saint-Tropez", "Divisionist dusk: rose and lilac sky, warm roofs along the quay, pale sails and confetti reflections.", [
    hline(0, ["#a0c8d8", "#e8b8c8", "#c0d0e8"]),
    ridge([0.5, 0.48, 0.5, 0.48], ["#f0c8b0", "#f4d0b8", "#f0c8b0"], ["#8fa8d8", "#a0a8d8", "#8fa8d8"]),
    hline(1, ["#4a5ab0", "#7a6ab8"]),
    soft(0.18, 0.38, 0.09, 0.05, "#e8845a"), soft(0.36, 0.37, 0.09, 0.06, "#f0a868"), soft(0.52, 0.28, 0.025, 0.1, "#f6e8cc"), soft(0.66, 0.39, 0.07, 0.05, "#d8685a"),
    soft(0.84, 0.24, 0.05, 0.14, "#f8eee0"),
    soft(0.4, 0.72, 0.03, 0.13, "#f09a5a"), soft(0.52, 0.75, 0.03, 0.12, "#f4c880"), soft(0.64, 0.72, 0.03, 0.13, "#e87a6a"),
  ]),
  preset("venice-salute-sails", "Signac, Venice, the pink cloud", "A pink-orange cloud over a pale dome, three small sails and ultramarine water shot with vermilion reflections.", [
    hline(0, ["#5a90d8", "#a0c4ee", "#78a8e0"]),
    ridge([0.56, 0.55, 0.56, 0.55], ["#d0b0d0", "#c8b8d8"], ["#2a4a9a", "#3a5ab0"]),
    hline(1, ["#1f3a8a", "#2f4aa0"]),
    soft(0.3, 0.22, 0.24, 0.1, "#f4a4b4"), soft(0.34, 0.2, 0.1, 0.045, "#ffd8d0"), soft(0.74, 0.4, 0.13, 0.09, "#f0d0c8"),
    soft(0.18, 0.66, 0.03, 0.06, "#f08a30"), soft(0.42, 0.68, 0.03, 0.06, "#e85a4a"), soft(0.66, 0.66, 0.03, 0.06, "#f8a040"),
    soft(0.3, 0.86, 0.14, 0.045, "#e8703a"),
  ]),
  preset("vision-vermilion", "Gauguin, Vision after the Sermon", "Brittany 1888: an unmodulated vermilion field cut by a dark diagonal apple trunk, white coifs and a jade sea corner.", [
    shape(polylineNodes([[0.2, 0], [0.3, 0], [0.85, 1], [0.75, 1]]), ["#d8321c"], ["#3a2418", "#5a3420", "#2a1a14", "#3a2418"]),
    soft(0.16, 0.86, 0.08, 0.06, "#f6f0e0"), soft(0.32, 0.9, 0.06, 0.05, "#f0e8d8"),
    soft(0.92, 0.12, 0.08, 0.09, "#3a6a70"), soft(0.6, 0.15, 0.1, 0.05, "#e8a83a"),
  ]),
  preset("yellow-christ-field", "Gauguin, The Yellow Christ", "Pont-Aven 1889: a lemon field, flat orange trees and a blue hill, painted in cloisonné colour zones.", [
    hline(0, ["#5a88c8", "#8ab8e0"]),
    ridge([0.3, 0.28, 0.31, 0.29], ["#a8c8e0", "#b8d4e6"], ["#e8c030", "#f0d040"]),
    hline(1, ["#e0a820", "#f0c838"]),
    soft(0.22, 0.5, 0.1, 0.12, "#e26a20"), soft(0.8, 0.55, 0.1, 0.1, "#d85a1a"), soft(0.5, 0.78, 0.06, 0.1, "#a06080"),
    soft(0.5, 0.12, 0.2, 0.05, "#d8ecf6"),
  ]),
  preset("vuillard-lamplit-room", "Vuillard, lamplit interior", "A Paris parlour after dark: oxblood wallpaper, a golden lamp glow, green upholstery and rose figures.", [
    hline(0, ["#4a2418", "#6a2c20", "#3a2a2a"]), hline(1, ["#5a3a2a", "#8a5a30", "#3a2a30"]),
    soft(0.5, 0.38, 0.2, 0.16, "#f2b04a"), soft(0.5, 0.38, 0.06, 0.06, "#ffe090"),
    soft(0.12, 0.28, 0.06, 0.06, "#c8583a"), soft(0.88, 0.22, 0.06, 0.07, "#a84a58"),
    soft(0.28, 0.78, 0.18, 0.09, "#4a6a3a"), soft(0.76, 0.72, 0.14, 0.1, "#7a3a4a"), soft(0.52, 0.86, 0.1, 0.05, "#3a6a70"),
  ]),
];
