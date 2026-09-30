/**
 * "Microscopy & natural science" — native Multipoint presets. BZ reaction waves, polarised crystals, soap film, Chladni figures, field lines, diatoms, confocal stains and Haeckel.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes, mixHex } from "../multipoint_shapes.js";
import { blobNodes } from "./fluid_materials.js";
import { orientedEllipseNodes, leafNodes } from "./nature.js";
import { boxNodes, coilNodes, wobbleRingNodes } from "./swirls.js";
import { stroke, tile, slab, exitOf } from "./microscopy_helpers.js";

const TAU = 2 * Math.PI;

const DEG = Math.PI / 180;

const cyc = (list, i) => list[i % list.length];

// ---- BZ reaction -------------------------------------------------------------------------
const FERROIN_RED = "#b3221f", FERROIN_DEEP = "#8c1519", CREST = "#f4d8c9";

const SPHERULITE = [["#f3d04a", "#e0449b"], ["#2fb36b", "#2a2a8a"], ["#c65bd6", "#f7b24a"], ["#19a9b6", "#b6e64a"],
  ["#f06a8c", "#5b2bbd"], ["#f5e26a", "#20b6b0"], ["#8d3fd0", "#ff5fa0"], ["#1ea47a", "#2f8fd0"]];

const SPHERULITE_APEX = [0.46, 0.56], SPHERULITE_HUB = 0.075, SPHERULITE_BEND = 0.16;

/** Pure function. A bent crystal-boundary ray from near the apex to the box edge; bend is a fraction of its length. @example sphRay(0).length // 3 */
const sphRay = (angle) => {
  const [ax, ay] = SPHERULITE_APEX, { point } = exitOf(ax, ay, angle);
  const start = [ax + Math.cos(angle) * SPHERULITE_HUB, ay + Math.sin(angle) * SPHERULITE_HUB];
  const len = Math.hypot(point[0] - start[0], point[1] - start[1]);
  const mid = [(start[0] + point[0]) / 2 - Math.sin(angle) * len * SPHERULITE_BEND, (start[1] + point[1]) / 2 + Math.cos(angle) * len * SPHERULITE_BEND];
  return catmullRomNodes([start, mid, point]);
};

const BOX = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Strips of the box cut by parallel lines at fractions of its extent along `angle`.
const strips = (angle, fractions) => {
  const along = BOX.map(([x, y]) => x * Math.cos(angle) + y * Math.sin(angle)), lo = Math.min(...along), span = Math.max(...along) - lo;
  return fractions.slice(0, -1).map((f, i) => slab(BOX, angle, lo + f * span, lo + fractions[i + 1] * span));
};

const LATH_ORDER = [["#2b3fb0", "#1f9bd6", "#35c2a0", "#f4d43a"], ["#f4d43a", "#f08a24", "#d8337e", "#6a3fc0"], ["#6a3fc0", "#2b6ae0", "#21b7c9", "#35c27a"],
  ["#f0a13a", "#e04a66", "#8a3cc0", "#2b6ae0"], ["#19a9b6", "#35c27a", "#e2d84a", "#f08a24"]];

const citric = preset("citric-acid-laths", "Citric acid laths", "Long birefringent strips of citric acid crystal cycling through Michel-Levy blues, teals, golds and magentas, split by black cracks.", strips(-62 * DEG, [0, 0.09, 0.27, 0.36, 0.58, 0.69, 0.83, 1]).map((poly, i) =>
  tile(poly, 0.007, [...cyc(LATH_ORDER, i * 2 + 1 - (i % 2))].slice(0, 3), "#0a0a1c")));

// ---- caffeine needles ------------------------------------------------------------------------
const NEEDLE_GROUND = "#0b0717";

const NEEDLE_HUES = [["#ff3fa4", "#ffb02e", "#ffe66b"], ["#27d3ff", "#7a5cff", "#ff6fd0"], ["#41e38c", "#f4ff6b", "#ff9a3c"], ["#ffd23f", "#ff5d8f", "#8a4dff"], ["#5ef2ff", "#3a7bff", "#c15cff"]];

const needleFan = (hub, from, step, count, r0, length, width, hueShift) => Array.from({ length: count }, (_, i) => {
  const a = (from + i * step) * DEG, start = r0 + (i % 3) * 0.03;
  const reach = Math.hypot(...exitOf(hub[0], hub[1], a).point.map((v, k) => v - hub[k])) - start - 0.04;
  const len = Math.min(length + ((i * 7) % 5) * 0.05, reach);
  const [c1, c2, c3] = cyc(NEEDLE_HUES, i + hueShift);
  return boundary(leafNodes({ cx: hub[0] + Math.cos(a) * (start + len / 2), cy: hub[1] + Math.sin(a) * (start + len / 2), length: len, width, angle: a }),
    [NEEDLE_GROUND, NEEDLE_GROUND, NEEDLE_GROUND, NEEDLE_GROUND], [c1, c2, c3, c1], true);
});

const caffeine = preset("caffeine-needles", "Caffeine needles", "A sheaf of fine caffeine needles radiating from one nucleus, pastel pink, mint, sky and lemon under polarised light on violet-black.", [
  boundary(boxNodes(), closedRamp(["#0b0717", "#0a2a3a", "#26103f"]), null, true),
  ...needleFan([0.2, 0.8], -90, 11.5, 9, 0.12, 0.55, 0.06, 0),
]);

// ---- thin-film interference ---------------------------------------------------------------
// Newton's colour sequence of a draining vertical soap film, thinnest (black) at the top: [top, bottom] of each band.
const FILM_BANDS = [["#08080f", "#14121f"], ["#aab0bf", "#d9dce4"], ["#f5e090", "#eab84a"], ["#e58a2e", "#d3387f"], ["#b02a94", "#3a3fc7"],
  ["#2a66d8", "#27b7c9"], ["#35c79c", "#9ad44f"], ["#e2dc45", "#f08a3a"], ["#ee5d83", "#8a4fd0"], ["#4a6ae0", "#2a2f8f"]];

const FILM_BASES = [0.07, 0.15, 0.23, 0.32, 0.42, 0.52, 0.62, 0.73, 0.85];

 // wave centres, bands widen downward
const FILM_XS = [0, 0.33, 0.67, 1];

// ---- Chladni figures -----------------------------------------------------------------------
const SAND = "#eadcb8", SAND_LINE = 0.007;

/**
 * Pure function. One crisp closed line: two nested closed curves a hair apart with `ink` between them.
 * @param {function} nodesAt - Offset-from-centre-line -> [N,6] clockwise nodes of that curve.
 * @param {number} lineHalf - Half the line's thickness.
 * @param {string} outside - Field colour outside the line.
 * @param {string} inside - Field colour inside the line.
 * @param {string} ink - The line's colour.
 * @returns {object[]} Two closed features.
 * @example inkRing((d) => ellipseNodes(0.5, 0.5, 0.2 + d), 0.007, "#000000", "#111111", "#ffffff").length // 2
 */
const inkRing = (nodesAt, lineHalf, outside, inside, ink) => [
  boundary(nodesAt(lineHalf), [outside], [ink], true),
  boundary(nodesAt(-lineHalf), [ink], [inside], true),
];

const sandLine = (nodesAt, radius, outside, inside) => inkRing((d) => nodesAt(radius + d), SAND_LINE, outside, inside, SAND);

const rosette = (r) => wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: r, amp: 0.16, lobes: 6, phase: Math.PI / 2, n: 12 });

const chladni = preset("chladni-sand-plate", "Chladni sand plate", "Sand shaken to the nodal lines of a vibrating metal plate: pale grains tracing a six-petalled rosette, a small circle and an outer ring on deep blue-slate.", [
  ...sandLine((r) => ellipseNodes(0.5, 0.5, r), 0.46, "#0d1824", "#23405a"),
  ...sandLine(rosette, 0.27, "#23405a", "#1a2f45"),
  ...sandLine((r) => ellipseNodes(0.5, 0.5, r), 0.1, "#1a2f45", "#34597a"),
]);

const squareRing = (r) => wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: r, amp: 0.08, lobes: 4, phase: Math.PI / 2, n: 8 });

const quatrefoil = (r) => wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: r, amp: 0.3, lobes: 4, phase: Math.PI / 2, n: 8 });

// ---- magnetic field lines ------------------------------------------------------------------
const FIELD_RINGS = [[0.14, 0.065], [0.24, 0.16], [0.34, 0.27], [0.46, 0.41]];

 // [rx, ry] of each field loop
const FIELD_TONES = ["#0a2446", "#123a6a", "#1a5590", "#2275b8", "#0a2040"];

 // outside -> inside shading; innermost is the magnet body
const fieldLoop = (rx, ry) => (d) => ellipseNodes(0.5, 0.5, rx + d, ry + d);

// ---- diatoms -------------------------------------------------------------------------------
const DIATOM_SEA = "#040915", DIATOM_MID = "#1f5a9c", DIATOM_DEEP = "#0a2348", DIATOM_PEARL = "#e4f7ff", DIATOM_LIGHT = "#8fdcff";

const TRI_C = [0.5, 0.55];

/** Pure function. A rounded triangle about TRI_C: radius rx·(1 + 0.28·cos(3θ + phase)); phase 3π/2 points a vertex up. @example triNodes(0.3, 3 * Math.PI / 2).length // 6 */
const triNodes = (rx, phase) => blobNodes({ cx: TRI_C[0], cy: TRI_C[1], rx, lobes: [[3, 0.28, phase]], count: 6 });

const TRI_UP = 3 * Math.PI / 2, TRI_DOWN = Math.PI / 2;

const knob = (angle) => boundary(ellipseNodes(TRI_C[0] + Math.cos(angle) * 0.285, TRI_C[1] + Math.sin(angle) * 0.285, 0.045), [DIATOM_MID, DIATOM_MID, DIATOM_MID], [DIATOM_PEARL, DIATOM_LIGHT, DIATOM_PEARL], true);

const triceratium = preset("diatom-triceratium", "Diatom triceratium", "A triangular diatom in dark-field: a pearl rim around blue glass, a counter-turned inner triangle, three corner knobs and a bright hub glowing in black water.", [
  boundary(boxNodes(), [DIATOM_SEA], null, true),
  boundary(triNodes(0.33, TRI_UP), [DIATOM_SEA, DIATOM_SEA, DIATOM_SEA], [DIATOM_PEARL, DIATOM_LIGHT, DIATOM_PEARL], true),
  boundary(triNodes(0.29, TRI_UP), [DIATOM_PEARL, DIATOM_LIGHT, DIATOM_PEARL], [DIATOM_MID, DIATOM_DEEP, DIATOM_MID], true),
  boundary(triNodes(0.15, TRI_DOWN), [DIATOM_MID, DIATOM_DEEP, DIATOM_MID], ["#9fe6ff", "#3f8fd6", "#9fe6ff"], true),
  boundary(ellipseNodes(...TRI_C, 0.045), ["#9fe6ff"], [DIATOM_PEARL], true),
  ...[-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6].map(knob),
]);

// ---- confocal fluorescence -----------------------------------------------------------------
const CONFOCAL_DARK = "#010b06";

const fibre = (points, colors) => boundary(catmullRomNodes(points), colors);

const confocal = preset("confocal-dapi-gfp", "Confocal DAPI and GFP", "A three-channel confocal image: DAPI-blue nuclei, a web of GFP-green actin fibres and orange mitochondria scattered on black.", [
  boundary(boxNodes(), [CONFOCAL_DARK], null, true),
  fibre([[0, 0.45], [0.3, 0.42], [0.62, 0.24], [1, 0.05]], ["#062e12", "#2fb84c", "#062e12"]),
  stroke([[0.004, 0.96], [0.35, 0.93], [0.7, 0.77], [0.996, 0.6]], [0, 0.014, 0.016, 0], "#7dff7a", "#073516"),
  stroke([[0.004, 0.3], [0.3, 0.27], [0.62, 0.12], [0.85, 0.004]], [0, 0.012, 0.012, 0], "#5df56a", "#073516"),
  stroke([[0.42, 0.996], [0.6, 0.85], [0.85, 0.72], [0.996, 0.74]], [0, 0.012, 0.012, 0], "#6af07a", "#073516"),
  boundary(orientedEllipseNodes({ cx: 0.3, cy: 0.68, rx: 0.1, ry: 0.12, rotation: 0.4 }), [CONFOCAL_DARK, "#04240f", CONFOCAL_DARK, CONFOCAL_DARK].slice(0, 3), ["#4a86ff", "#1d3fd0", "#4a86ff"], true),
  boundary(orientedEllipseNodes({ cx: 0.68, cy: 0.5, rx: 0.075, ry: 0.09, rotation: -0.5 }), [CONFOCAL_DARK, "#04240f", CONFOCAL_DARK].slice(0, 3), ["#5a92ff", "#2448d8", "#5a92ff"], true),
  ...[[0.44, 0.74], [0.17, 0.52], [0.82, 0.36], [0.54, 0.6]].map(([x, y]) => point(x, y, "#ff9a26")),
]);

// ---- Haeckel: Kunstformen der Natur ----------------------------------------------------------
const PLATE_BLACK = "#0b0d0a", BONE = "#e2ded0";

const spine = (angle, r0, r1, width) => boundary(leafNodes({ cx: 0.5 + Math.cos(angle) * (r0 + r1) / 2, cy: 0.5 + Math.sin(angle) * (r0 + r1) / 2, length: r1 - r0, width, angle }),
  [PLATE_BLACK, PLATE_BLACK, PLATE_BLACK], [BONE, "#ffffff", BONE], true);

const SPINE_REACH = [0.485, 0.42, 0.485, 0.4, 0.485, 0.43, 0.485, 0.4, 0.485, 0.42];

 // long and short spines alternate, as in an Acanthometra
const radiolaria = preset("haeckel-radiolaria", "Haeckel radiolarian", "An Acanthometra radiolarian after Haeckel's Art Forms in Nature: ten bone-white spines of alternating length radiating from a rose-gold capsule on a black lithographic plate.", [
  boundary(boxNodes(), [PLATE_BLACK], null, true),
  ...SPINE_REACH.map((reach, i) => spine(TAU * i / SPINE_REACH.length + 0.15, 0.17, reach, i % 2 ? 0.022 : 0.03)),
  boundary(ellipseNodes(0.5, 0.5, 0.14), ["#7a3a24", "#7a3a24", "#7a3a24", "#7a3a24"], ["#f2a27a", "#fff0c0", "#d8744f", "#f2a27a"], true),
]);

const scallop = (r, lobes, amp, phase, n = 8) => wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: r, amp, lobes, phase, n });

const SLATE = "#6a5a62", GILT = ["#b89140", "#f0d99a", "#b89140"];

const discomedusa = preset("haeckel-discomedusa", "Haeckel gilded medusa", "A disc jellyfish seen from above in the manner of Haeckel's Discomedusae plate: scalloped gilt bell rings, a cream crown and a four-lobed centre on a mauve-slate ground.", [
  boundary(boxNodes(), [SLATE], null, true),
  boundary(scallop(0.45, 4, 0.05, 0), [SLATE, SLATE, SLATE], GILT, true),
  boundary(scallop(0.35, 4, 0.05, Math.PI / 4), ["#8a6a34", "#8a6a34", "#8a6a34"], ["#f2e3b4", "#d9bd76", "#f2e3b4"], true),
  boundary(ellipseNodes(0.5, 0.5, 0.22), ["#f2e3b4", "#f2e3b4", "#f2e3b4"], ["#c6a45c", "#8a6a34", "#c6a45c"], true),
  ...[0, 1, 2, 3].map((i) => boundary(leafNodes({ cx: 0.5 + Math.cos(i * Math.PI / 2) * 0.1, cy: 0.5 + Math.sin(i * Math.PI / 2) * 0.1, length: 0.17, width: 0.06, angle: i * Math.PI / 2 }),
    ["#9a7a3a", "#9a7a3a", "#9a7a3a"], ["#4a3a44", "#7a6a72", "#4a3a44"], true)),
]);

const BRAIN_DARK = "#03030b", SOMA = [0.46, 0.52];

const DENDRITES = [[-158, "#ff3fb0", 0.5, 0.5], [-100, "#39e6ff", 0.5, -0.4], [-42, "#b6ff3a", 0.56, 0.4], [18, "#ff9a2e", 0.52, -0.5], [100, "#8a5cff", 0.5, 0.45], [160, "#ff5b6a", 0.46, -0.5]];

/** Pure function. A dendrite: a bent, tapering ribbon leaving the soma at `deg` degrees and ending `reach` away (bend = sideways fraction). @example dendrite(0, "#fff", 0.3, 0.2).closed // true */
const dendrite = (deg, color, reach, bend) => {
  const a = deg * DEG, p = (r, side) => [SOMA[0] + Math.cos(a) * r - Math.sin(a) * side, SOMA[1] + Math.sin(a) * r + Math.cos(a) * side];
  const end = p(reach, bend * reach * 0.5);
  const tip = [Math.min(0.996, Math.max(0.004, end[0])), Math.min(0.996, Math.max(0.004, end[1]))];
  return stroke([p(0.088, 0), p(reach * 0.5, bend * reach * 0.4), tip], [0.036, 0.02, 0], color, BRAIN_DARK);
};

const brainbow = preset("confocal-brainbow", "Confocal brainbow", "A multicolour neuron in a brainbow confocal stack: a glowing magenta soma sending six dendrites, each a different fluorescent hue, into black tissue.", [
  boundary(boxNodes(), [BRAIN_DARK], null, true),
  boundary(ellipseNodes(...SOMA, 0.065), [BRAIN_DARK], ["#ff7fd0"], true),
  ...DENDRITES.map(([deg, color, reach, bend]) => dendrite(deg, color, reach, bend)),
]);

// ---- confocal mitosis ------------------------------------------------------------------------
const CELL_DARK = "#02080a";

const CHROMOSOME_XS = [0.3, 0.4, 0.5, 0.6, 0.7];

const mitosis = preset("confocal-mitosis", "Confocal mitosis", "A cell at metaphase in a three-channel confocal stack: a green tubulin spindle between two orange centrosomes, blue chromosomes lined up on the plate, a red actin cortex round the edge.", [
  boundary(boxNodes(), [CELL_DARK], null, true),
  ...inkRing((d) => ellipseNodes(0.5, 0.5, 0.46 + d, 0.43 + d), 0.007, CELL_DARK, "#14080a", "#d8352e"),
  ...inkRing((d) => leafNodes({ cx: 0.5, cy: 0.5, length: 0.78 + 2 * d, width: 0.52 + 2 * d, angle: Math.PI / 2 }), 0.008, "#14080a", "#0c4a24", "#58e68a"),
  ...CHROMOSOME_XS.map((x, i) => boundary(leafNodes({ cx: x, cy: 0.5 + (i % 2 ? 0.012 : -0.012), length: 0.105, width: 0.06, angle: Math.PI / 2 + (i - 2) * 0.12 }), ["#36d066", "#36d066", "#36d066"], ["#6aa0ff", "#e8f0ff", "#6aa0ff"], true)),
  point(0.5, 0.17, "#ffa030"), point(0.5, 0.83, "#ffa030"),
].slice(0, 12));

export const PRESETS = [
  preset("bz-spiral-dish", "BZ spiral dish", "Two interleaved spiral wave fronts of a Belousov-Zhabotinsky reaction: pale crests riding a ferroin-red petri dish.", [
  boundary(boxNodes(), ["#dfe3e2"], null, true),
  boundary(ellipseNodes(0.5, 0.5, 0.47), ["#e9ecec"], ["#a6a8a8"], true),
  boundary(ellipseNodes(0.5, 0.5, 0.45), ["#a6a8a8"], [FERROIN_RED], true),
  ...[0, 1, 2].map((i) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0.03, r1: 0.42, turns: 2, phase: i * TAU / 3 }),
    [FERROIN_RED, FERROIN_DEEP, FERROIN_DEEP, FERROIN_RED], [FERROIN_RED, CREST, CREST, FERROIN_RED])),
]),
  // ---- BZ target waves -----------------------------------------------------------------------
  preset("bz-target-waves", "BZ target waves", "Target waves spreading from a pacemaker in an amber Belousov-Zhabotinsky dish: each crest an aqua-white edge that decays inward, drifting off-centre.", [
  boundary(boxNodes(), ["#b4521a"], null, true),
  ...[0.055, 0.125, 0.2, 0.275, 0.355, 0.44].map((r, i) => {
    const cx = 0.40 + i * 0.024, cy = 0.52 - i * 0.01;
    return boundary(ellipseNodes(cx, cy, r, r * (1 - i * 0.012)), ["#b4521a"], ["#c6f3ef"], true);
  }),
]),
  preset("vitamin-c-spherulite", "Vitamin C spherulite", "Curved crystal fronts radiating from one nucleus of ascorbic acid under crossed polarisers: gold, magenta, green and violet interference colours.", [
  ...[-166, -128, -92, -55, -14, 32, 80, 124].map((deg, i, all) => boundary(sphRay(deg * DEG),
    SPHERULITE[(i + all.length - 1) % all.length], SPHERULITE[i])),
  boundary(ellipseNodes(...SPHERULITE_APEX, SPHERULITE_HUB * 0.55), ["#1a1030"], null, true),
]),
  preset("citric-acid-laths", "Citric acid laths", "Long birefringent strips of citric acid crystal cycling through Michel-Levy blues, teals, golds and magentas, split by black cracks.", strips(-62 * DEG, [0, 0.09, 0.27, 0.36, 0.58, 0.69, 0.83, 1]).map((poly, i) =>
  tile(poly, 0.007, [...cyc(LATH_ORDER, i * 2 + 1 - (i % 2))].slice(0, 3), "#0a0a1c"))),
  preset("caffeine-needles", "Caffeine needles", "A sheaf of fine caffeine needles radiating from one nucleus, pastel pink, mint, sky and lemon under polarised light on violet-black.", [
  boundary(boxNodes(), closedRamp(["#0b0717", "#0a2a3a", "#26103f"]), null, true),
  ...needleFan([0.2, 0.8], -90, 11.5, 9, 0.12, 0.55, 0.06, 0),
]),
  preset("soap-film-drain", "Soap film drain", "A draining vertical soap film: a black top, then Newton's interference bands of silver, straw, amber, magenta, blue, teal and green rippling down the sheet.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), [FILM_BANDS[0][0]]),
  ...FILM_BASES.map((y, k) => {
    const amp = 0.018 + k * 0.006, phase = 0.55 * k;
    const nodes = catmullRomNodes(FILM_XS.map((x) => [x, y + amp * Math.sin(TAU * 0.85 * x + phase)]));
    const up = FILM_BANDS[k][1], down = FILM_BANDS[k + 1][0];
    return boundary(nodes, [up, mixHex(up, down, 0.3)], [down, mixHex(down, up, 0.3)]);
  }),
  boundary(polylineNodes([[1, 1], [0, 1]]), [FILM_BANDS[9][1]]),
]),
  preset("chladni-sand-plate", "Chladni sand plate", "Sand shaken to the nodal lines of a vibrating metal plate: pale grains tracing a six-petalled rosette, a small circle and an outer ring on deep blue-slate.", [
  ...sandLine((r) => ellipseNodes(0.5, 0.5, r), 0.46, "#0d1824", "#23405a"),
  ...sandLine(rosette, 0.27, "#23405a", "#1a2f45"),
  ...sandLine((r) => ellipseNodes(0.5, 0.5, r), 0.1, "#1a2f45", "#34597a"),
]),
  preset("chladni-quatrefoil", "Chladni quatrefoil", "A second Chladni figure on a verdigris plate: sand gathered into a rounded square, a four-petalled quatrefoil and a central ring.", [
  ...sandLine(squareRing, 0.43, "#0c2523", "#1f4f4a"),
  ...sandLine(quatrefoil, 0.24, "#1f4f4a", "#153a37"),
  ...sandLine((r) => ellipseNodes(0.5, 0.5, r), 0.06, "#153a37", "#2f7a6e"),
]),
  preset("iron-filings-dipole", "Iron filings dipole", "A bar magnet's field loops printed like a cyanotype: pale filing-white curves wrapping a coral north pole and an aqua south pole on Prussian blue.", [
  boundary(boxNodes(), [FIELD_TONES[0]], null, true),
  ...FIELD_RINGS.flatMap(([rx, ry], i) => inkRing(fieldLoop(rx, ry), 0.005, FIELD_TONES[i], FIELD_TONES[i + 1], "#d9ecff")),
  point(0.57, 0.5, "#ff6a5a"), point(0.43, 0.5, "#57d8ff"),
]),
  preset("diatom-triceratium", "Diatom triceratium", "A triangular diatom in dark-field: a pearl rim around blue glass, a counter-turned inner triangle, three corner knobs and a bright hub glowing in black water.", [
  boundary(boxNodes(), [DIATOM_SEA], null, true),
  boundary(triNodes(0.33, TRI_UP), [DIATOM_SEA, DIATOM_SEA, DIATOM_SEA], [DIATOM_PEARL, DIATOM_LIGHT, DIATOM_PEARL], true),
  boundary(triNodes(0.29, TRI_UP), [DIATOM_PEARL, DIATOM_LIGHT, DIATOM_PEARL], [DIATOM_MID, DIATOM_DEEP, DIATOM_MID], true),
  boundary(triNodes(0.15, TRI_DOWN), [DIATOM_MID, DIATOM_DEEP, DIATOM_MID], ["#9fe6ff", "#3f8fd6", "#9fe6ff"], true),
  boundary(ellipseNodes(...TRI_C, 0.045), ["#9fe6ff"], [DIATOM_PEARL], true),
  ...[-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6].map(knob),
]),
  preset("confocal-dapi-gfp", "Confocal DAPI and GFP", "A three-channel confocal image: DAPI-blue nuclei, a web of GFP-green actin fibres and orange mitochondria scattered on black.", [
  boundary(boxNodes(), [CONFOCAL_DARK], null, true),
  fibre([[0, 0.45], [0.3, 0.42], [0.62, 0.24], [1, 0.05]], ["#062e12", "#2fb84c", "#062e12"]),
  stroke([[0.004, 0.96], [0.35, 0.93], [0.7, 0.77], [0.996, 0.6]], [0, 0.014, 0.016, 0], "#7dff7a", "#073516"),
  stroke([[0.004, 0.3], [0.3, 0.27], [0.62, 0.12], [0.85, 0.004]], [0, 0.012, 0.012, 0], "#5df56a", "#073516"),
  stroke([[0.42, 0.996], [0.6, 0.85], [0.85, 0.72], [0.996, 0.74]], [0, 0.012, 0.012, 0], "#6af07a", "#073516"),
  boundary(orientedEllipseNodes({ cx: 0.3, cy: 0.68, rx: 0.1, ry: 0.12, rotation: 0.4 }), [CONFOCAL_DARK, "#04240f", CONFOCAL_DARK, CONFOCAL_DARK].slice(0, 3), ["#4a86ff", "#1d3fd0", "#4a86ff"], true),
  boundary(orientedEllipseNodes({ cx: 0.68, cy: 0.5, rx: 0.075, ry: 0.09, rotation: -0.5 }), [CONFOCAL_DARK, "#04240f", CONFOCAL_DARK].slice(0, 3), ["#5a92ff", "#2448d8", "#5a92ff"], true),
  ...[[0.44, 0.74], [0.17, 0.52], [0.82, 0.36], [0.54, 0.6]].map(([x, y]) => point(x, y, "#ff9a26")),
]),
  preset("confocal-brainbow", "Confocal brainbow", "A multicolour neuron in a brainbow confocal stack: a glowing magenta soma sending six dendrites, each a different fluorescent hue, into black tissue.", [
  boundary(boxNodes(), [BRAIN_DARK], null, true),
  boundary(ellipseNodes(...SOMA, 0.065), [BRAIN_DARK], ["#ff7fd0"], true),
  ...DENDRITES.map(([deg, color, reach, bend]) => dendrite(deg, color, reach, bend)),
]),
  preset("confocal-mitosis", "Confocal mitosis", "A cell at metaphase in a three-channel confocal stack: a green tubulin spindle between two orange centrosomes, blue chromosomes lined up on the plate, a red actin cortex round the edge.", [
  boundary(boxNodes(), [CELL_DARK], null, true),
  ...inkRing((d) => ellipseNodes(0.5, 0.5, 0.46 + d, 0.43 + d), 0.007, CELL_DARK, "#14080a", "#d8352e"),
  ...inkRing((d) => leafNodes({ cx: 0.5, cy: 0.5, length: 0.78 + 2 * d, width: 0.52 + 2 * d, angle: Math.PI / 2 }), 0.008, "#14080a", "#0c4a24", "#58e68a"),
  ...CHROMOSOME_XS.map((x, i) => boundary(leafNodes({ cx: x, cy: 0.5 + (i % 2 ? 0.012 : -0.012), length: 0.105, width: 0.06, angle: Math.PI / 2 + (i - 2) * 0.12 }), ["#36d066", "#36d066", "#36d066"], ["#6aa0ff", "#e8f0ff", "#6aa0ff"], true)),
  point(0.5, 0.17, "#ffa030"), point(0.5, 0.83, "#ffa030"),
].slice(0, 12)),
  preset("haeckel-radiolaria", "Haeckel radiolarian", "An Acanthometra radiolarian after Haeckel's Art Forms in Nature: ten bone-white spines of alternating length radiating from a rose-gold capsule on a black lithographic plate.", [
  boundary(boxNodes(), [PLATE_BLACK], null, true),
  ...SPINE_REACH.map((reach, i) => spine(TAU * i / SPINE_REACH.length + 0.15, 0.17, reach, i % 2 ? 0.022 : 0.03)),
  boundary(ellipseNodes(0.5, 0.5, 0.14), ["#7a3a24", "#7a3a24", "#7a3a24", "#7a3a24"], ["#f2a27a", "#fff0c0", "#d8744f", "#f2a27a"], true),
]),
  preset("haeckel-discomedusa", "Haeckel gilded medusa", "A disc jellyfish seen from above in the manner of Haeckel's Discomedusae plate: scalloped gilt bell rings, a cream crown and a four-lobed centre on a mauve-slate ground.", [
  boundary(boxNodes(), [SLATE], null, true),
  boundary(scallop(0.45, 4, 0.05, 0), [SLATE, SLATE, SLATE], GILT, true),
  boundary(scallop(0.35, 4, 0.05, Math.PI / 4), ["#8a6a34", "#8a6a34", "#8a6a34"], ["#f2e3b4", "#d9bd76", "#f2e3b4"], true),
  boundary(ellipseNodes(0.5, 0.5, 0.22), ["#f2e3b4", "#f2e3b4", "#f2e3b4"], ["#c6a45c", "#8a6a34", "#c6a45c"], true),
  ...[0, 1, 2, 3].map((i) => boundary(leafNodes({ cx: 0.5 + Math.cos(i * Math.PI / 2) * 0.1, cy: 0.5 + Math.sin(i * Math.PI / 2) * 0.1, length: 0.17, width: 0.06, angle: i * Math.PI / 2 }),
    ["#9a7a3a", "#9a7a3a", "#9a7a3a"], ["#4a3a44", "#7a6a72", "#4a3a44"], true)),
]),
];
