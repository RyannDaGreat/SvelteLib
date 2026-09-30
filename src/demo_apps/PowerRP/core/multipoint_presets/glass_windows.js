/**
 * "Glass & windows" — native Multipoint presets. Chagall's windows, Richter's Cologne window, Tiffany iridescence, Chihuly, sommerso, dichroic glass and rose windows.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes } from "../multipoint_shapes.js";
import { ellipseFrom } from "./abstract.js";
import { leafNodes, blobNodes, polar } from "./art_homages.js";
import { boxNodes, sampledNodes } from "./swirls.js";
import { pane, lancetNodes, latticeCells, bandSides, teardropNodes } from "./glass_helpers.js";

const TAU = 2 * Math.PI;

// Chagall, Hadassah windows (Jerusalem, 1962): the yellow tribe windows glow lemon between black leading,
// with figures broken into shards of cobalt, ruby, green and orange. Nine irregular shards share a jittered lattice.
const JER_LEAD = "#0d0a06";

const JER_LATTICE = [
  [[0.04, 0.04], [0.36, 0.04], [0.66, 0.04], [0.96, 0.04]],
  [[0.04, 0.34], [0.30, 0.30], [0.70, 0.38], [0.96, 0.32]],
  [[0.04, 0.66], [0.38, 0.70], [0.62, 0.62], [0.96, 0.70]],
  [[0.04, 0.96], [0.34, 0.96], [0.68, 0.96], [0.96, 0.96]],
];

const GOLD = ["#fbf07a", "#e4b41c", "#f6dc3e"], LEMON = ["#f6e84e", "#d9a716", "#fbf28a"];

const JER_JEWELS = [GOLD, ["#e0304a", "#7a0a1e", "#f27c70"], LEMON, LEMON, ["#2a48d0", "#10206e", "#6c92f2"], ["#22a06c", "#0a523a", "#86d8a2"],
  GOLD, ["#f2801e", "#b82c0c", "#ffbe48"], LEMON];

// Chagall, Reims cathedral axial chapel (1974): thousands of cobalt, ultramarine and sky-blue shards in tall
// lancets under a rose, with a few ruby and green embers. Each lancet is a pointed cap over two slanted shards.
const REIMS_STONE = "#06061a", LANCET_RX = 0.17, LANCET_BASE = 0.5, LEAD_HALF = 0.008;

/** Pure-ish geometry: a pointed cap whose flat base is tilted (left corner lowered by tilt, right raised). */
const tiltedCap = (cx, tilt) => {
  const nodes = lancetNodes(cx, LANCET_BASE - LEAD_HALF, LANCET_RX, 0.42, 0.26);
  nodes[0][1] += tilt; nodes[4][1] -= tilt;
  return nodes;
};

const lancetShards = (cx, tilt, blues) => {
  const l = cx - LANCET_RX, r = cx + LANCET_RX;
  return [
    pane(tiltedCap(cx, tilt), blues[0], REIMS_STONE),
    pane(polylineNodes([[l, LANCET_BASE + tilt + LEAD_HALF], [r, LANCET_BASE - tilt + LEAD_HALF], [r, 0.74 - tilt - LEAD_HALF], [l, 0.74 + tilt - LEAD_HALF]]), blues[1], REIMS_STONE),
    pane(polylineNodes([[l, 0.74 + tilt + LEAD_HALF], [r, 0.74 - tilt + LEAD_HALF], [r, 0.97], [l, 0.97]]), blues[2], REIMS_STONE),
  ];
};

// Richter, Cologne Cathedral south transept window (2007): 11,263 hand-blown squares in 72 colours, placed by a
// random generator. Here a 3 x 3 field of square panes, each hand-blown so it glows brighter at one corner.
const COLOGNE_LEAD = "#120c14";

const COLOGNE_PANES = [["#e8b020", "#b8201c", "#f8d878"], ["#1f5ec4", "#16164e", "#5a8ae8"], ["#c83a70", "#7a2a8a", "#f08ab0"],
  ["#2a2a9a", "#0e0e3a", "#6a6ad0"], ["#e06a1c", "#8a1626", "#f8a860"], ["#3a8a3c", "#124a1c", "#88c878"],
  ["#8a1626", "#3a0a14", "#d04a4a"], ["#1e8c8c", "#0c4a5a", "#7adad0"], ["#7a2a8a", "#2a0a4a", "#b86ad0"]];

const COLOGNE_LATTICE = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => [c / 3, r / 3]));

// Tiffany Favrile glass (patented 1894): iridescence made by metallic-oxide fumes on hot glass, so the colour
// slides gold -> green -> blue -> violet with the angle of view. Six drifting bands whose hues shift end to end.
const FAVRILE_BANDS = [["#0b1236", "#241470", "#0b1236"], ["#e8b83a", "#2aa89a", "#2a48c8"], ["#5a2a9a", "#e8b83a", "#2aa89a"],
  ["#2aa89a", "#2a48c8", "#b03ab0"], ["#2a48c8", "#b03ab0", "#e8b83a"], ["#120a30", "#0a1c4c", "#120a30"]];

const favrileEdge = (i) => sampledNodes((t) => [t, 0.1 + 0.17 * i + (0.05 + 0.008 * i) * Math.cos(TAU * t),
  1, -TAU * (0.05 + 0.008 * i) * Math.sin(TAU * t)], 0, 1, 4);

// Chihuly, Sole del Sole / Sun (2000s): spiked suns of yellow, orange and red glass reach out like fire against
// a blue sky. Nine thorns radiate from a hot ring, tips in tangerine, roots in lemon.
const SOLE_SKY = "#13247a";

const SOLE_THORNS = Array.from({ length: 9 }, (_, i) => -Math.PI / 2 + i * TAU / 9);

// Murano sommerso ("submerged", Venini/Seguso, 1930s-60s): a coloured gather dipped into clear glass and again
// into another colour, so each colour floats inside the next without mixing. Flavio Poli's vases in amber and green.
const SOMMERSO_WALL = "#e6dcc8";

// Dichroic glass (NASA-derived thin-film coatings, 1990s craft glass): stacked metal-oxide layers transmit one
// colour and reflect its complement, so a single pane is gold-orange one way and blue-violet the other.
// Three vertical fields - copper/magenta, blue-black, lime/gold - meeting along wavering fused edges.
const DICHROIC = [["#ff7a1a", "#e02e8c", "#ff9a2a", "#c83ab8"], ["#0a0a26", "#1a40d0", "#0a1a5a", "#2a8ae8"], ["#b4f030", "#ffd030", "#5ce05a", "#d8f040"]];

const dichroicEdge = (x0, amp, cycles, phase) => sampledNodes((t) => [x0 + amp * Math.sin(TAU * cycles * t + phase), 1 - t,
  TAU * cycles * amp * Math.cos(TAU * cycles * t + phase), -1], 0, 1, 6);

/**
 * Pure function. The features of a rose window: a tracery ring, rings of leaf-shaped lights radiating from a
 * hub, and the hub's jewel. Light k of the whole window takes jewel k % jewels.length.
 * @param {object} o - {rings: [{petals, r0, r1, width, phase}], ring, hubRadius, stone, rim (3 colours), hub (2), jewels}.
 * @returns {object[]} Features (2 nodes per petal + 4 + 4; 12 features at most).
 */
function roseWindow({ rings, ring, hubRadius, stone, rim, hub, jewels }) {
  let k = 0;
  return [
    pane(ellipseNodes(0.5, 0.5, ring), rim, stone),
    ...rings.flatMap(({ petals, r0, r1, width, phase }) => Array.from({ length: petals }, (_, i) => pane(
      leafNodes(...polar(0.5, 0.5, r0, phase + i * TAU / petals), ...polar(0.5, 0.5, r1, phase + i * TAU / petals), width), jewels[k++ % jewels.length], rim[1]))),
    pane(ellipseNodes(0.5, 0.5, hubRadius), hub, rim[1]),
  ];
}

// Chihuly, Persian Ceiling (Bellagio-style installations, 1990s-): hundreds of ruffled, translucent "Persians" lie
// on a sheet of glass lit from above, so the room below is washed in tangerine, turquoise, magenta and lime.
const PERSIAN_DARK = "#0a060e";

const persian = (cx, cy, r, squash, ruffle, rim, lip) => [
  pane(blobNodes({ cx, cy, rx: r, ry: r * squash, harmonics: [[3, 0.09, ruffle], [5, 0.04, ruffle * 2]], count: 7 }), rim, PERSIAN_DARK),
  pane(ellipseFrom(cx + 0.02, cy + 0.015, r * 0.42, r * 0.36 * squash, 0.4, 3), lip, rim[1]),
];

// Dichroic glass, fused rods: strips of coated glass laid side by side on black, each one passing through gold,
// magenta, violet and cyan along its length as the film's interference colour turns with the angle.
const DICHROIC_BLACK = "#050308";

const DICHROIC_RODS = [["#ffc83a", "#e8308a", "#7a3ae0"], ["#2ad8e8", "#3a6af0", "#c83ae0"], ["#b8f040", "#f8d030", "#ff5a3a"], ["#e8308a", "#7a3ae0", "#2ad8e8"]];

// Murano sommerso, cold variant (Seguso "submarine" vases, 1950s): ice-clear glass over cobalt over a violet
// core, lit on a slate ground; the same submerging, none of the amber.
const SOMMERSO_SLATE = "#10182a";

export const PRESETS = [
  preset("jerusalem-yellow", "Jerusalem yellow", "Lemon-yellow glass broken into leaded shards with ruby, cobalt, green and orange figures, after Chagall's Jerusalem windows.", [
  ...latticeCells(JER_LATTICE, 0.011).map((corners, i) => pane(polylineNodes(corners), JER_JEWELS[i], JER_LEAD)),
  point(0.2, 0.17, "#fffcc0"), point(0.82, 0.83, "#fffbb0"),
]),
  preset("reims-blue", "Reims blue", "Two lancets of shattered cobalt, ultramarine, violet and sky-blue shards under a ruby-hearted rose, after Chagall's Reims windows.", [
  ...lancetShards(0.29, 0.03, [["#86b0ff", "#2a48d6", "#16238e"], ["#1a2cb4", "#3f70ee", "#4a2cc0"], ["#2a9ae0", "#1a2c9c", "#6a8cf6"]]),
  ...lancetShards(0.71, -0.03, [["#3a5ce0", "#1a2a9e", "#7aa4ff"], ["#5a3cc8", "#2c4cd4", "#7ca6f8"], ["#1a2cb0", "#3c78e8", "#10197a"]]),
  pane(leafNodes(0.3, 0.56, 0.26, 0.68, 0.07), ["#d2e4ff", "#7ea8fa"], "#1a2cb4"),
  pane(ellipseNodes(0.7, 0.88, 0.05, 0.045), ["#ee4a3a", "#b81c22"], "#1c2cb0"),
  pane(ellipseNodes(0.5, 0.17, 0.09), ["#86b0ff", "#2c4fd8", "#1c2c9c"], REIMS_STONE),
  boundary(ellipseNodes(0.5, 0.17, 0.04), ["#2c4fd8"], ["#e8402e"], true),
]),
  preset("cologne-window", "Cologne window", "A mosaic of jewel-coloured squares of glass in garnet, cobalt, amber, green and violet, after Richter's Cologne Cathedral window.", [
  ...latticeCells(COLOGNE_LATTICE, 0.012).map((corners, i) => pane(polylineNodes(corners), [...COLOGNE_PANES[i].slice(i * 2 % 3), ...COLOGNE_PANES[i].slice(0, i * 2 % 3)], COLOGNE_LEAD)),
]),
  preset("iridescent-lustre", "Iridescent lustre", "Six drifting bands of gold, teal, cobalt and violet iridescence on midnight glass, after Louis Comfort Tiffany's iridescent art glass.", [
  ...bandSides(FAVRILE_BANDS).map(({ above, below }, i) => boundary(favrileEdge(i), above, below)),
]),
  preset("sole-spikes", "Sole spikes", "Nine lemon-to-tangerine glass thorns bursting from a white-hot ring on cobalt sky, after Chihuly's Sole del Sole.", [
  boundary(boxNodes(), [SOLE_SKY], null, true),
  ...SOLE_THORNS.map((a, i) => pane(leafNodes(...polar(0.5, 0.5, 0.17, a), ...polar(0.5, 0.5, i % 2 ? 0.41 : 0.47, a), 0.075), ["#ffef5a", "#ff9a1c", "#ff5a1c"], "#1c2f98")),
  pane(ellipseNodes(0.5, 0.5, 0.11), ["#ffffff", "#ffe066", "#ffb02a"], "#e8601c"),
]),
  preset("sommerso-amber", "Sommerso amber", "Nested teardrops of amber, emerald and deep teal glass, each colour submerged in the next, after Flavio Poli's vases.", [
  boundary(boxNodes(), [SOMMERSO_WALL], null, true),
  pane(teardropNodes(0.5, 0.5, 0.33, 0.43, 0.3), ["#ffe9a0", "#f4a82a", "#c8741a"], SOMMERSO_WALL),
  pane(teardropNodes(0.5, 0.6, 0.23, 0.29, 0.3), ["#b8e888", "#3aac5a", "#1a7c48"], "#e89a22"),
  pane(teardropNodes(0.5, 0.68, 0.12, 0.15, 0.3), ["#0e5a4c", "#083a34", "#106a5a"], "#2a9c58"),
]),
  preset("dichroic-fusion", "Dichroic fusion", "Three fused fields of dichroic glass - copper to magenta, blue-black and lime-gold - meeting on wavering edges.", [
  boundary(polylineNodes([[0, 1], [0, 0]]), DICHROIC[0]),
  boundary(dichroicEdge(0.38, 0.05, 1.5, 0.4), DICHROIC[0], DICHROIC[1]),
  boundary(dichroicEdge(0.66, 0.045, 1.5, 2.2), DICHROIC[1], DICHROIC[2]),
  boundary(polylineNodes([[1, 1], [1, 0]]), DICHROIC[2]),
]),
  // Amiens cathedral west rose (c. 1500, "Flamboyant"): ten lights radiate from a hub, ruby, cobalt, emerald and
  // gold in turn, framed by a gold-bronze ring of tracery.
  preset("rose-noon", "Rose at noon", "Ten ruby, cobalt, emerald and gold petals burning in a bronze ring at full noon light, after the Amiens rose.", roseWindow({
  rings: [{ petals: 10, r0: 0.12, r1: 0.42, width: 0.12, phase: 0 }], stone: "#0a0708", ring: 0.47, hubRadius: 0.07,
  rim: ["#f4b23a", "#b8761c", "#f4b23a"], hub: ["#fff4c0", "#f4b23a"],
  jewels: [["#ff4a5a", "#b0102a"], ["#3a62f0", "#1a2a98"], ["#2ed08a", "#0c7a52"], ["#ffc83a", "#e0781c"]],
})),
  // A rose seen at sunset: the low sun floods the glass from behind, so every colour is pulled toward amber and
  // the ruby petals glow like coals while the blue ones turn violet.
  preset("rose-ember", "Rose at sunset", "Eight broad petals of a rose window lit by the low sun, every pane pulled toward ember-orange, rose and violet.", roseWindow({
  rings: [{ petals: 8, r0: 0.1, r1: 0.43, width: 0.16, phase: Math.PI / 8 }], stone: "#0c0508", ring: 0.47, hubRadius: 0.065,
  rim: ["#ff9a3a", "#8a3410", "#ff9a3a"], hub: ["#ffffff", "#ffc04a"],
  jewels: [["#ff6a3a", "#c0220e"], ["#c83a9a", "#6a1a6a"], ["#ffb43a", "#f06a1a"], ["#9a3ac8", "#4a1a8a"]],
})),
  // A rose by moonlight seen from outside: the glass is nearly black, each light a cold silvery blue with a faint
  // green and violet cast; five long lights alternate with five short ones.
  preset("rose-moonlit", "Rose by moonlight", "Long and short silver-blue petals of a rose window in a night-black wall, a faint teal and violet cast in the glass.", roseWindow({
  rings: [{ petals: 5, r0: 0.12, r1: 0.43, width: 0.13, phase: 0 }, { petals: 5, r0: 0.2, r1: 0.4, width: 0.085, phase: Math.PI / 5 }],
  stone: "#03040a", ring: 0.47, hubRadius: 0.06,
  rim: ["#9ab4d8", "#3a4a70", "#9ab4d8"], hub: ["#f2f6ff", "#9ab8e8"],
  jewels: [["#7aa0e8", "#1a2a70"], ["#58c0c8", "#0e3a50"], ["#8a7ae0", "#221a66"]],
})),
  preset("persian-ceiling", "Persian ceiling", "Four ruffled translucent glass bowls of coral, turquoise, magenta and lime glowing on a dark ceiling, after Chihuly's Persians.", [
  ...persian(0.27, 0.28, 0.21, 0.92, 0.5, ["#ff6a3a", "#d8281a", "#ffae4a"], ["#ffe080", "#ff9a30"]),
  ...persian(0.73, 0.3, 0.2, 0.95, 1.8, ["#20ccd8", "#0a64b8", "#7af0e0"], ["#a8f4ec", "#30c0d0"]),
  ...persian(0.3, 0.75, 0.2, 0.95, 2.6, ["#ea3aa4", "#7a1682", "#ff84c8"], ["#ffb4e0", "#ee4ab0"]),
  ...persian(0.72, 0.73, 0.22, 0.9, 0.9, ["#d8ee3c", "#2a9a3a", "#f4ff80"], ["#eaff9a", "#8ad83a"]),
]),
  preset("dichroic-rods", "Dichroic rods", "Four diagonal rods of dichroic glass shifting gold, magenta, violet and cyan along their length on black.", [
  boundary(boxNodes(), [DICHROIC_BLACK], null, true),
  ...DICHROIC_RODS.map((ramp, i) => {
    const x = 0.2 + 0.2 * i;
    return pane(leafNodes(x + 0.1, 0.96 - 0.03 * i, x - 0.1, 0.04 + 0.03 * i, 0.17), [...ramp], DICHROIC_BLACK);
  }),
]),
  preset("sommerso-submarine", "Sommerso submarine", "A fat vase of ice-clear, cobalt and violet glass submerged one in the next on dark slate, after Murano's submarine vases.", [
  boundary(boxNodes(), [SOMMERSO_SLATE], null, true),
  pane(teardropNodes(0.5, 0.52, 0.36, 0.41, 0.42), ["#f2fbff", "#9ad0ee", "#5aa0d8"], SOMMERSO_SLATE),
  pane(teardropNodes(0.5, 0.58, 0.26, 0.3, 0.42), ["#6a9aff", "#1a3ac8", "#0e1e80"], "#5aa0d8"),
  pane(teardropNodes(0.5, 0.64, 0.14, 0.17, 0.42), ["#d070ff", "#7a26c8", "#3a1070"], "#1a3ac8"),
]),
];
