/**
 * "Prints & patterns" — native Multipoint presets. Knit zigzags, paisley, tie-dye, shibori, dip-dye, bold poppies, 1960s silk prints, Delaunay fabrics, velvet and satin.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, closedRamp } from "./builders.js";
import { mixHex, ellipseNodes, polylineNodes, waveNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { blobNodes, leafNodes } from "./art_homages.js";
import { coilNodes, wobbleRingNodes } from "./swirls.js";
import { slantNodes, iceCells, ground, edgeRails, zigzagNodes, teardropNodes, fallNodes } from "./prints_helpers.js";

/**
 * Pure function. Stacked parallel two-sided curves whose bands each take their colour from both bounding curves.
 * @param {function} nodesAt - y -> node list for the curve at that height.
 * @param {number[]} ys - Curve heights, increasing.
 * @param {string[]} bands - ys.length + 1 band colours, top to bottom.
 * @returns {object[]} One two-sided feature per curve.
 * @example bandCurves((y) => polylineNodes([[0,y],[1,y]]), [0.5], ["#fff","#000"]).length // 1
 */
const bandCurves = (nodesAt, ys, bands) => ys.map((y, i) => boundary(nodesAt(y), [bands[i]], [bands[i + 1]]));

const ZIG_BANDS = ["#f4ead2", "#e8702a", "#c2185b", "#f4ead2", "#0e8a8a", "#1d2b53", "#0e8a8a", "#f4ead2", "#f2b632"];

const ZIG_YS = Array.from({ length: 8 }, (_, i) => 0.1 + i * 0.11);

const BOTEH_RED = "#a8201c", BOTEH_INDIGO = "#1b2a5e";

const ICE_JITTER = [[[0, 0], [0.03, 0], [-0.04, 0], [0, 0]], [[0, 0.05], [0.05, -0.04], [-0.05, 0.05], [0, -0.03]],
  [[0, -0.04], [-0.04, 0.05], [0.06, -0.05], [0, 0.04]], [[0, 0], [0.04, 0], [-0.03, 0], [0, 0]]];

// [inside main, inside deep, pale halo tint] per cell, arranged so neighbours contrast.
const ICE_DYES = [["#d6247e", "#8d0f58"], ["#10b3ae", "#0a6f7c", "#dcf4f1"], ["#6d3fc0", "#3f1f86", "#e9e0f7"],
  ["#f2a93b", "#d9661f", "#fdf0d6"], ["#e65c9a", "#b0246a", "#fbe0ea"], ["#2a9fd6", "#15599a", "#dcedf8"],
  ["#2b3a9e", "#151e66", "#dfe3f6"], ["#ee6a4a", "#b72f2a", "#fbe2db"], ["#1fc08a", "#0d7a5a", "#dbf5ea"]];

const ICE_CELLS = iceCells(ICE_JITTER, 0.06).map((corners, i) => [corners, ...ICE_DYES[i].slice(0, 2), mixHex(ICE_DYES[i][0], "#ffffff", 0.66)]);

const CRUMPLE_JITTER = [[[0, 0], [-0.05, 0], [0.04, 0], [0, 0]], [[0, -0.06], [0.06, 0.05], [-0.05, -0.04], [0, 0.05]],
  [[0, 0.04], [-0.05, -0.05], [0.05, 0.06], [0, -0.05]], [[0, 0], [0.03, 0], [-0.05, 0], [0, 0]]];

// [main, deep] per cell.
const CRUMPLE_DYES = [["#1f4fb8", "#0f2a7a"], ["#7cc4ea", "#2f86c4"], ["#0f2a7a", "#081a52"], ["#2fb5d6", "#0f7aa0"], ["#173c98", "#0a1f66"],
  ["#a9dcf2", "#4aa2d8"], ["#0b1f6a", "#050f40"], ["#2f86c4", "#15508f"], ["#57c0dc", "#1a86a8"]];

const CRUMPLE_CELLS = iceCells(CRUMPLE_JITTER, 0.02).map((corners, i) => [corners, ...CRUMPLE_DYES[i]]);

const BULLSEYE = ["#ffd21f", "#ff8a1f", "#e6207a", "#7a2fc0", "#2a52d0", "#11a9c4"].reverse();

const TIE_SECTORS = ["#ffd23a", "#16b0c0", "#1f4fb0", "#ffb62e", "#2bbfa4", "#2f6fd0"];

const TIE_GROUND = "#1d5fb8", TIE_SECTOR_CORE = "#fff6cc";

const PUCCI_BANDS = ["#0a2a6b", "#e6007e", "#ff7a1a", "#ffe14a", "#a8d820", "#1ec8c8", "#6b2fa8", "#e6007e"];

export const PRESETS = [
  preset("zigzag-knit", "Zigzag knit", "Flame-stitch chevron stripes in orange, magenta, teal and navy on cream, as in Italian zigzag knitwear.",
    bandCurves((y) => zigzagNodes({ y, amp: 0.07, halves: 4, round: 0.1 }), ZIG_YS, ZIG_BANDS)),
  // Kashmir / Paisley shawl: two opposed boteh, each banded indigo, ivory and saffron, on Turkey red.
  preset("boteh-shawl", "Boteh shawl", "Two opposed banded boteh in indigo, ivory and saffron on Turkey red, after Kashmir and Paisley shawls.", [
    ground(BOTEH_RED),
    ...[[0.58, 0.72, 0.52, 0.21, -1.6, 0.6, [BOTEH_INDIGO, "#efe2c2", "#e7a82e"]],
      [0.2, 0.3, 0.26, 0.1, -1.6, -0.5, ["#efe2c2", BOTEH_INDIGO]]].flatMap(([cx, cy, length, width, angle, bend, bands]) =>
      bands.map((color, k) => boundary(teardropNodes({ cx: cx + k * 0.004, cy: cy + k * 0.01, length: length * (1 - k * 0.3), width: width * (1 - k * 0.3), bend, angle, n: k === bands.length - 1 ? 6 : 8 }),
        [k ? bands[k - 1] : BOTEH_RED], [color], true))),
  ]),
  // Tie-dye spiral: six twisted sectors that deepen toward the rim.
  preset("tie-dye-spiral", "Tie-dye spiral", "Six twisted sectors of sun yellow, teal and cobalt radiating from a white knot, after a spiral-folded shirt.", [
    boundary(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), [TIE_GROUND], null, true),
    ...[0, 1, 2, 3, 4, 5].map((i) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0.05, r1: 0.5, turns: 1, phase: i * Math.PI / 3 }),
      [TIE_SECTOR_CORE, TIE_SECTORS[(i + 5) % 6], TIE_SECTORS[(i + 5) % 6]], [TIE_SECTOR_CORE, TIE_SECTORS[i], TIE_SECTORS[i]])),
    boundary(ellipseNodes(0.5, 0.5, 0.03), [TIE_SECTOR_CORE], null, true),
  ]),
  // Dip-dye: pale cotton lowered into a vat — a soft gradient with a darker wet tide line.
  preset("ombre-dip-dye", "Ombré dip-dye", "Blush cotton dipped into coral and berry dye, with a darker tide line where the wet edge dried.", [
    ...edgeRails(["#fdeee0"], ["#7d1d52"], ["#fdeee0", "#f8c8a8", "#e8707a", "#7d1d52"], ["#fdeee0", "#f8c8a8", "#e8707a", "#7d1d52"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.42, amplitude: 0.025, cycles: 1.5, phase: 0.6 }), ["#f9d3b6", "#f7c4a4", "#f9d3b6", "#f7c4a4"], ["#f08a80", "#e4667a", "#f08a80", "#e4667a"]),
  ]),
  // Finnish bold poppy: one huge flat poppy, a dark eye ringed with stamens, and a small pink one.
  preset("poppy-print", "Bold poppy", "A huge flat red-orange poppy with a black eye and stamens, and a small fuchsia one, on cream, after Finnish poppy prints.", [
    ground("#f5eee0"),
    boundary(blobNodes({ cx: 0.42, cy: 0.46, rx: 0.36, harmonics: [[4, 0.1, 0.78]], count: 8 }), ["#f5eee0"], ["#ee3d22"], true),
    boundary(ellipseNodes(0.42, 0.46, 0.11), ["#ee3d22"], ["#1a1a26"], true),
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const a = i * Math.PI / 3 + 0.3, r0 = 0.15, r1 = 0.23;
      return boundary(leafNodes(0.42 + r0 * Math.cos(a), 0.46 + r0 * Math.sin(a), 0.42 + r1 * Math.cos(a), 0.46 + r1 * Math.sin(a), 0.024), ["#ee3d22"], ["#1a1a26"], true);
    }),
    boundary(blobNodes({ cx: 0.83, cy: 0.83, rx: 0.14, harmonics: [[4, 0.12, 0.3]], count: 8 }), ["#f5eee0"], ["#dd1f6c"], true),
    boundary(ellipseNodes(0.83, 0.83, 0.05), ["#dd1f6c"], ["#1a1a26"], true),
  ]),
  // 1960s Italian silk: concentric twisting rings in electric magenta, orange, lime, turquoise and violet.
  preset("capri-silk-print", "Capri silk print", "Concentric rings of magenta, tangerine, lime, turquoise and violet twisting around a navy eye, after 1960s Italian silk prints.", [
    ground(PUCCI_BANDS[0]),
    ...PUCCI_BANDS.slice(1, 7).map((color, i) => boundary(
      wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: 0.47 - i * 0.06, amp: 0.1, lobes: 3, phase: i * 1.1, n: 6 }),
      closedRamp([PUCCI_BANDS[i], PUCCI_BANDS[i], PUCCI_BANDS[i]]).slice(0, 3), closedRamp([color, color]), true)),
  ]),
  // Sonia Delaunay: one orange-yellow disc on three grounds; simultaneous contrast recolours it each time.
  preset("tissu-simultane", "Tissu simultané", "The same sunny disc sitting on vermilion, ultramarine and green bands, after Sonia Delaunay's simultaneous fabrics.", [
    boundary(fallNodes(0.34, 0.34, [0.05, -0.05]), ["#2247b0"], ["#e04a2a"]),
    boundary(fallNodes(0.66, 0.66, [-0.05, 0.05]), ["#2a9d6a"], ["#2247b0"]),
    ...[[0.14, 0.3], [0.5, 0.65], [0.85, 0.3]].flatMap(([cx, cy], i) => [
      boundary(ellipseNodes(cx, cy, 0.12), [["#e04a2a", "#2247b0", "#2a9d6a"][i]], ["#f7b733"], true),
      boundary(ellipseNodes(cx, cy, 0.06), ["#f7b733"], ["#16161f"], true),
    ]),
  ]),
  // Shibori arashi: pole-wrapped cloth leaves slanting indigo streaks with pale resist seams.
  preset("shibori-arashi", "Indigo arashi", "Slanting indigo streaks with pale resist seams, as if the cloth had been wrapped round a pole.",
    bandCurves((a) => catmullRomNodes([[0, a], [0.35, a - 0.12], [0.7, a - 0.2], [1, a - 0.3]].map(([x, y]) => [x, y])), [0.34, 0.43, 0.52, 0.61, 0.7, 0.79, 0.88, 0.97],
      ["#0f2250", "#1d4284", "#d9e8f2", "#2a5aa0", "#0f2250", "#c4d9ea", "#21498f", "#0f2250", "#2d62a8"])),
  // Ice-dye: powder dye bled through packed ice, leaving saturated cells haloed by their own pale tint.
  preset("ice-dye-crackle", "Ice-dye crackle", "Nine irregular cells of magenta, teal, violet, amber and indigo, each haloed by its own pale tint, as in powder ice-dyed cotton.",
    ICE_CELLS.map(([corners, main, deep, tint]) => boundary(catmullRomNodes(corners, true), [tint, tint, tint], [main, deep, main], true))),
  // Velvet drapery: pile catches light only on the crests of tall folds.
  preset("wine-velvet-drape", "Wine velvet drape", "Tall folds of claret velvet, soft rose light on the crests and black-wine valleys, falling from a dark top.",
    [0.05, 0.19, 0.32, 0.45, 0.58, 0.71, 0.84, 0.95].map((x, i) => boundary(
      fallNodes(x, x + (i % 2 ? 0.02 : -0.02), [i % 2 ? 0.04 : -0.04, i % 2 ? -0.03 : 0.03, 0.02 * (i % 3 - 1)]),
      i % 2 ? ["#3a0a16", "#b23050", "#f08aa0", "#b23050"] : ["#140206", "#26050d", "#3a0a16", "#26050d"]))),
  // Bias-cut satin: long diagonal folds with cool blue-grey shadows and warm champagne highlights.
  preset("champagne-satin", "Champagne satin", "Diagonal bias-cut folds of ivory and champagne satin over cool taupe shadows.",
    [0.15, 0.4, 0.65, 0.9, 1.15].map((c, i) => boundary(
      slantNodes(c, 0.3, 0.04 * (i % 2 ? 1 : -1)),
      i % 2 ? ["#b9a27a", "#fffdf5", "#e9d8b4", "#fffaf0"] : ["#5c4d60", "#7e6e7e", "#9b8a93", "#6e6070"]))),
  // Crumple dye: dye pools in the crushed folds and the creases stay white — indigo mottles split by pale veins.
  preset("crumple-dye", "Crumple dye", "Mottled indigo, cobalt and cyan cells split by white creases, as in scrunched and dyed cotton.",
    CRUMPLE_CELLS.map(([corners, main, deep]) => boundary(polylineNodes(corners), ["#f4f8fb", "#f4f8fb", "#f4f8fb"], [main, deep, main], true))),
  // Bullseye tie-dye: rings of dye feathered into one another around a bunched centre.
  preset("tie-dye-bullseye", "Tie-dye bullseye", "Wobbling rings of yellow, orange, magenta, violet and cobalt around a bunched centre on white, as in a banded shirt.",
    BULLSEYE.map((color, i) => boundary(wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: 0.47 - i * 0.075, amp: 0.05, lobes: 3, phase: i * 0.7, n: 6 }),
      [i ? BULLSEYE[i - 1] : "#fbf7ee", i ? BULLSEYE[i - 1] : "#fbf7ee", i ? BULLSEYE[i - 1] : "#fbf7ee"], [color, mixHex(color, "#ffffff", 0.3), color], true))),
];
