/**
 * "Ukiyo-e & shin-hanga" — native Multipoint presets. Hiroshige, Hokusai and shin-hanga prints: bokashi skies, snow, rain and sail silhouettes.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes, rectNodes, waveNodes, mixHex } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { boxEdge, atOffsets, ribbonNodes } from "./retro_eras.js";

/**
 * Pure function. A horizontal (or gently waved) crisp horizon: colour above it, colour below it.
 * Left-to-right travel puts rightColor BELOW.
 * @param {number} y - Mean height.
 * @param {string[]} above - Palette left to right, on the upper side.
 * @param {string[]} below - Matching palette on the lower side.
 * @param {number} amplitude - Half-wave height (0 = ruler-straight).
 * @returns {object} Open two-sided feature spanning the box exactly edge to edge.
 * @example horizon(0.5, ["#fff"], ["#000"], 0).nodes.length // 2
 */
export function horizon(y, above, below, amplitude = 0, cycles = 0.5, phase = 0) {
  const nodes = amplitude === 0 ? polylineNodes([[0, y], [1, y]]) : waveNodes({ x0: 0, x1: 1, y, amplitude, cycles, phase });
  nodes[0][0] = 0; nodes[nodes.length - 1][0] = 1;
  return boundary(nodes, above, below);
}

/**
 * Pure function. Piecewise-linear colour of a vertical bokashi: `stops` are [y, colour] pairs, y increasing.
 * Used to give a crisp shape the exact field colour on its outside, so it does not glow.
 * @param {number[][]|Array<[number,string]>} stops - [[y0,"#rrggbb"],...] sorted by y.
 * @param {number} y - Query height; clamped to the first/last stop.
 * @returns {string} Lowercase #rrggbb.
 * @example fieldAt([[0,"#000000"],[1,"#ffffff"]], 0.5) // "#808080"
 */
export function fieldAt(stops, y) {
  if (y <= stops[0][0]) return stops[0][1];
  const j = stops.findIndex(([sy]) => sy >= y);
  if (j < 0) return stops.at(-1)[1];
  const [y0, c0] = stops[j - 1], [y1, c1] = stops[j];
  return mixHex(c0, c1, (y - y0) / (y1 - y0));
}

/**
 * Pure function. A crisp triangle whose outside colour at each vertex is the surrounding field colour there,
 * with stops sitting exactly on the vertices (arc-length offsets), so the shape has no halo.
 * Vertices should be clockwise on screen; inside[i] is the colour at vertex i.
 * @param {number[][]} tri - [3,2] vertices, clockwise.
 * @param {string[]} outside - [3] field colours at the vertices.
 * @param {string[]} inside - [3] fill colours at the vertices.
 * @returns {object} Closed two-sided feature with 4 stops (first vertex repeated).
 * @example triangleAt([[0.5,0.1],[0.9,0.9],[0.1,0.9]], ["#fff","#fff","#fff"], ["#000","#111","#222"]).stops.length // 4
 */
export function triangleAt(tri, outside, inside) {
  const lens = tri.map((p, i) => Math.hypot(tri[(i + 1) % 3][0] - p[0], tri[(i + 1) % 3][1] - p[1]));
  const total = lens[0] + lens[1] + lens[2];
  const feature = boundary(polylineNodes(tri), [...outside, outside[0]], [...inside, inside[0]], true);
  return atOffsets(feature, [0, lens[0] / total, (lens[0] + lens[1]) / total, 1]);
}

// Yoshida sailing-boat compositions: shared sail triangles (clockwise) and the vertical sky ramps behind them.
const SAILS = [[[0.3, 0.16], [0.46, 0.66], [0.16, 0.66]], [[0.66, 0.3], [0.78, 0.68], [0.55, 0.68]], [[0.88, 0.4], [0.96, 0.68], [0.82, 0.68]]];

const EVENING_SAILS = [[[0.2, 0.28], [0.34, 0.68], [0.08, 0.68]], [[0.55, 0.1], [0.72, 0.66], [0.4, 0.66]], [[0.86, 0.36], [0.94, 0.7], [0.78, 0.7]]];

const NIGHT_SAILS = [[[0.24, 0.2], [0.4, 0.66], [0.1, 0.66]], [[0.58, 0.38], [0.66, 0.7], [0.48, 0.7]]];

const MORNING_SKY = [[0, "#8fb3d4"], [0.72, "#f9dcc4"]];

const EVENING_SKY = [[0, "#5a4f98"], [0.72, "#f6a05a"]];

const NIGHT_SKY = [[0, "#111a38"], [0.72, "#34497c"]];

const FLAT_PAPER = ["#f0d9ba", "#f0d9ba", "#f0d9ba", "#f0d9ba"];

// Ohashi bridge underside, left to right (x,y): the trestles hang from this line.
const DECK_UNDERSIDE = [[0, 0.88], [0.35, 0.8], [0.7, 0.71], [0.998, 0.63]];

const TRESTLE_GAP = 0.012;

/**
 * Pure function. Height of the bridge underside at x, by piecewise-linear interpolation.
 * @param {number} x - Position in [0,0.998].
 * @returns {number} y.
 * @example deckUnderside(0.35) // 0.8
 */
export function deckUnderside(x) {
  const i = DECK_UNDERSIDE.findIndex(([px], j) => j < DECK_UNDERSIDE.length - 1 && x <= DECK_UNDERSIDE[j + 1][0]);
  const [x0, y0] = DECK_UNDERSIDE[i], [x1, y1] = DECK_UNDERSIDE[i + 1];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

export const PRESETS = [
  // Hiroshige, "Yoshiwara at dawn" (100 Famous Views of Edo, 1857): soot-black bokashi, turquoise dawn, straw glow, receding grey roofs.
  preset("edo-dawn", "Edo dawn", "After Hiroshige's Yoshiwara at Dawn palette: soot-black bokashi easing through turquoise to a straw glow over misty grey ridges.", [
      boxEdge("top", ["#35373a"]),
      boundary(polylineNodes([[0, 0.2], [1, 0.2]]), ["#5c6a68"]),
      boundary(polylineNodes([[0, 0.37], [1, 0.37]]), ["#88b2af"]),
      boundary(catmullRomNodes([[0, 0.5], [0.22, 0.44], [0.45, 0.5], [0.7, 0.42], [1, 0.48]]), ["#d6cfa9"], ["#7c8b89"]),
      boundary(catmullRomNodes([[0, 0.64], [0.28, 0.57], [0.55, 0.65], [0.8, 0.56], [1, 0.6]]), ["#a9b4ab"], ["#4d4b47"]),
      boundary(polylineNodes([[0, 0.8], [1, 0.8]]), ["#4d4b47"], ["#7d8377"]),
      boxEdge("bottom", ["#6c7a66"]),
    ]),
  // Hiroshige, "Sudden Shower over Shin-Ohashi Bridge and Atake" (1857): rain-grey sky, dark tree bank, jade river, tan bridge on dark trestles, indigo foreground.
  preset("ohashi-shower", "Ohashi shower", "Hiroshige's sudden shower: slate rain sky, a dark far bank, jade river and a tan bridge on dark trestles over indigo water.", [
      boxEdge("top", ["#3f3f40"]),
      boundary(polylineNodes([[0, 0.2], [1, 0.2]]), ["#8a9592"]),
      horizon(0.34, ["#8a9592"], ["#5d6862"], 0.012, 0.5),
      horizon(0.42, ["#5d6862"], ["#9bb2a4"], 0.008, 0.5, 3),
      boundary(polylineNodes([[0, 0.72], [0.35, 0.63], [0.7, 0.56], [0.998, 0.5], [0.998, 0.63], [0.7, 0.71], [0.35, 0.8], [0, 0.88]]), ["#98ad9e"], ["#e0b78c"], true),
      ...[[0.16, 0.26], [0.46, 0.56], [0.76, 0.86]].map(([xl, xr]) =>
        boundary(polylineNodes([[xl, deckUnderside(xl) + TRESTLE_GAP], [xr, deckUnderside(xr) + TRESTLE_GAP], [xr, 0.98], [xl, 0.98]]), ["#7a9490"], ["#4b4342"], true)),
      boxEdge("bottom", ["#304d66"]),
    ]),
  // Hiroshige, "Evening Snow at Kanbara" (Tokaido, c.1833): black-bokashi night, snow-white peaks, umber house walls under snow roofs.
  preset("kanbara-snow", "Kanbara snow", "Hiroshige's Tokaido night: grey-to-black bokashi sky over cream snow peaks, umber house walls and a red cartouche.", [
      boxEdge("top", ["#7c7873"]),
      boundary(polylineNodes([[0, 0.28], [1, 0.28]]), ["#2b2a29"]),
      boundary(polylineNodes([[0, 0.5], [0.12, 0.44], [0.24, 0.36], [0.33, 0.31], [0.42, 0.4], [0.49, 0.44], [0.54, 0.5], [0.72, 0.5], [0.8, 0.44], [0.9, 0.47], [1, 0.42]]), ["#2b2a29"], ["#f4e6d0"]),
      boundary(polylineNodes([[0.36, 0.42], [0.46, 0.5], [0.4, 0.62]]), ["#f4e6d0"], ["#c9baa6"], true),
      boundary(rectNodes(0.58, 0.56, 0.7, 0.64), ["#f4e6d0"], ["#5a514b"], true),
      boundary(rectNodes(0.76, 0.52, 0.95, 0.6), ["#f4e6d0"], ["#4f4741"], true),
      boundary(polylineNodes([[0, 0.84], [0.3, 0.72], [0.65, 0.68], [1, 0.74]]), ["#f4e6d0"], ["#d3c3b0"]),
      boxEdge("bottom", ["#c7b8a4"]),
      boundary(rectNodes(0.85, 0.06, 0.93, 0.2), ["#5f5a56"], ["#d4502f"], true),
    ]),
  // Hiroshige, "Tenmangu Shrine at Kameido in Snow": charcoal pine ridge, cerulean pond, cream snow banks, rust shrine.
  preset("kameido-snow", "Kameido in snow", "Hiroshige's shrine pond in snow: a charcoal pine ridge under a grey sky, cerulean water, cream banks and a rust-red hall.", [
      boxEdge("top", ["#4a4646"]),
      boundary(polylineNodes([[0, 0.3], [0.08, 0.2], [0.14, 0.31], [0.24, 0.16], [0.32, 0.3], [0.44, 0.22], [0.5, 0.3], [0.62, 0.15], [0.7, 0.29], [0.82, 0.19], [0.9, 0.3], [0.96, 0.22], [1, 0.3]]), ["#aaa296"], ["#46504d"]),
      boundary(polylineNodes([[0, 0.4], [0.5, 0.37], [1, 0.4]]), ["#46504d"], ["#f6e7cf"]),
      boundary(blobNodes({ cx: 0.36, cy: 0.68, rx: 0.3, ry: 0.19, harmonics: [[2, 0.12, 0.4], [3, 0.08, 1.4]], count: 6 }), ["#f6e7cf", "#f6e7cf", "#f6e7cf", "#f6e7cf"], ["#5ab4c8", "#2f86a6", "#2a7c9e", "#5ab4c8"], true),
      boundary(rectNodes(0.72, 0.5, 0.95, 0.53), ["#f6e7cf"], ["#4a3b38"], true),
      boundary(rectNodes(0.74, 0.55, 0.93, 0.68), ["#f6e7cf"], ["#96685a"], true),
      boxEdge("bottom", ["#e3d3b8"]),
    ]),
  // Hokusai, "Fishermen at Kajikazawa" (Thirty-six Views, c.1831): Prussian-blue aizuri-e — one blue on cream paper.
  preset("kajikazawa-blues", "Kajikazawa blues", "Hokusai's all-blue aizuri-e: a pale Fuji and stripe-ruled sea on cream paper, a rock in tonal blues, foam below.", [
      boxEdge("top", ["#5d8a94"]),
      boundary(polylineNodes([[0.1, 0.42], [0.48, 0.24], [0.62, 0.14], [0.75, 0.25], [1, 0.42]]), FLAT_PAPER, ["#c2cdbb", "#8da8a2", "#a5b8ad", "#c2cdbb"], true),
      ...[[0.66, 0.53, 0.94], [0.7, 0.6, 0.97]].map(([x0, y, x1]) =>
        boundary(ribbonNodes([[x0, y], [(x0 + x1) / 2, y], [x1, y + 0.012]], [0, 0.014, 0.014]), ["#f0d9ba"], ["#5a8ea1"], true)),
      boundary(blobNodes({ cx: 0.29, cy: 0.62, rx: 0.22, ry: 0.15, harmonics: [[2, 0.14, 0.2], [3, 0.1, 2]], count: 6 }), FLAT_PAPER, ["#76a0a4", "#4f8399", "#46788f", "#76a0a4"], true),
      horizon(0.8, ["#f0d9ba"], ["#4b7f95"], 0.03, 0.5),
      ...[[0.3, 0.9, 0.09, 0.03], [0.68, 0.93, 0.1, 0.03]].map(([cx, cy, rx, ry], i) =>
        boundary(blobNodes({ cx, cy, rx, ry, harmonics: [[3, 0.2, i]], count: 4 }), ["#3f7188"], ["#f4ecda"], true)),
      boxEdge("bottom", ["#3c697c"]),
    ]),
  // Yoshida Hiroshi, "Sailing Boats" series (1926): pastel morning sky, sunlit cream sails with rose shadow sides.
  preset("sailing-morning", "Sailing boats, morning", "Yoshida's 1926 sailing boats at sunrise: powder-blue sky warming to peach, cream sails with rose shadow, blue sea.", [
      boxEdge("top", ["#8fb3d4"]),
            horizon(0.72, ["#f9dcc4"], ["#6a9dbf"], 0.008, 0.5),
      boxEdge("bottom", ["#2f6396"]),
      ...SAILS.map((tri) => triangleAt(tri, tri.map(([, y]) => fieldAt(MORNING_SKY, y)), [["#fbf3e4", "#eabfb3", "#fbf3e4"]][0])),
    ]),
  // Yoshida Hiroshi, "Sailing Boats — Evening": vermilion horizon, violet zenith, sails lit orange on their sun side.
  preset("sailing-evening", "Sailing boats, evening", "Yoshida's evening sails: an orange-red horizon under a violet zenith, sails glowing amber over a plum sea.", [
      boxEdge("top", ["#5a4f98"]),
      horizon(0.72, ["#f6a05a"], ["#7a5a8f"], 0.008, 0.5),
      boxEdge("bottom", ["#2f2a5c"]),
      ...EVENING_SAILS.map((tri) => triangleAt(tri, tri.map(([, y]) => fieldAt(EVENING_SKY, y)), ["#ffd59a", "#a5507a", "#ffd59a"])),
    ]),
  // Yoshida Hiroshi, "Sailing Boats — Night": indigo sky, low moon, pale blue-grey sails, a moon path on black water.
  preset("sailing-night", "Sailing boats, night", "Yoshida's moonlit sails: an indigo night, a small ivory moon, ghostly blue sails over black water.", [
      boxEdge("top", ["#111a38"]),
      horizon(0.72, ["#34497c"], ["#0e1630"], 0.008, 0.5),
      boxEdge("bottom", ["#080d1f"]),
      boundary(ellipseNodes(0.8, 0.2, 0.055), ["#20305c"], ["#f4ecd0"], true),
      boundary(ellipseNodes(0.8, 0.85, 0.02, 0.09), ["#0b1229"], ["#7f93b8"], true),
      ...NIGHT_SAILS.map((tri) => triangleAt(tri, tri.map(([, y]) => fieldAt(NIGHT_SKY, y)), ["#a9b9d2", "#5f759c", "#a9b9d2"])),
    ]),
];
