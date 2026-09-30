/**
 * "Marbling" — native Multipoint presets. Turkish ebru and European endpaper marbling: combed bands, stone cells and curls.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { mixHex } from "../multipoint_shapes.js";
import { boxNodes, twirlPoint } from "./swirls.js";
import { bandStack, placeNodes, scaleNodes, tulipNodes, lensNodes, voronoiCells, roundedPolygon, warpedLine, ringStack, dropNodes } from "./marbling_helpers.js";

/** Pure function. Satin band: `base` lightened on its leading edge, `deep` on its trailing edge. @example satin("#000000","#000000",0.5).a // "#808080" */
const satin = (base, deep = base, lift = 0.3) => ({ a: mixHex(base, "#ffffff", lift), b: deep });

/**
 * Pure function. A tulip whose belly-bottom sits at `base`, its axis leaning `tilt` radians clockwise from vertical,
 * as a closed two-sided feature: ground colour outside, petal ramp inside (light tips to deep belly).
 * @example tulipAt([0.5,0.5],0.1,0.15,0,"#fff",["#f00","#f00","#800"]).closed // true
 */
const tulipAt = ([bx, by], w, h, tilt, ground, petal) => boundary(
  placeNodes(scaleNodes(tulipNodes(), w, h), tilt, [bx + Math.sin(tilt) * h / 2, by - Math.cos(tilt) * h / 2]), petal.map(() => ground), petal, true);

/** Pure function. A pointed lens (leaf or slim stem), ground outside and `colour` inside. @example leaf([0,0],[1,0],0.1,"#000","#fff").closed // true */
const leaf = (a, b, bulge, ground, colour, lean = 0, bow = 0) => boundary(lensNodes(a, b, bulge, lean, bow), [ground], [colour], true);

const STONE_TEAL = "#86a9a4", STONE_DEEP = "#3b6863", LEAF_GREEN = "#1f4a45";

const RED_TULIP = ["#f4553c", "#e0402c", "#a31f1c", "#f4553c"], WHITE_TULIP = ["#fbf6ec", "#f1eadc", "#cfc8b8", "#fbf6ec"];

const VEIN_BLUE = ["#f5f2e6", "#f0c92a", "#16142a", "#f5f2e6"];

/** Pure function. Voronoi stone cells as two-sided rings: veins outside, body inside. */
const stoneCells = (sites, gap, margin, aspect, round, veins, bodyOf) =>
  voronoiCells(sites, gap, margin, aspect).map((c, i) => boundary(roundedPolygon(c, round), veins(i), bodyOf(i), true));

/** Pure function. Composes point warps left to right. @example compose((p) => [p[0] + 1, p[1]], (p) => [p[0], p[1] * 2])([0, 1]) // [1,2] */
const compose = (...warps) => (p) => warps.reduce((q, w) => w(q), p);

const twirl = (cx, cy, radius, angle) => (p) => twirlPoint(p, { cx, cy, radius, angle });

const flowBands = (ys, warp, n, bands) => bandStack(ys.map((y) => warpedLine([0, y], [1, y], n, warp)), bands);

export const PRESETS = [
  preset("ebru-lale", "Ebru lale", "Tulips drawn with a stylus: red and white blooms on dark stems over a grey-teal stone ground, after Turkish çiçekli ebru.", [
    boundary(boxNodes(), closedRamp([STONE_TEAL, "#7aa09b", "#9dbdb7"]), null, true),
    tulipAt([0.5, 0.36], 0.18, 0.25, 0, STONE_TEAL, RED_TULIP),
    tulipAt([0.27, 0.36], 0.16, 0.21, -0.6, STONE_TEAL, WHITE_TULIP),
    tulipAt([0.75, 0.42], 0.16, 0.21, 0.6, STONE_TEAL, WHITE_TULIP),
    tulipAt([0.3, 0.62], 0.16, 0.2, -0.85, STONE_TEAL, RED_TULIP),
    leaf([0.5, 0.97], [0.5, 0.37], 0.03, STONE_TEAL, LEAF_GREEN),
    leaf([0.47, 0.57], [0.28, 0.38], 0.04, STONE_TEAL, LEAF_GREEN, 0, 0.05),
    leaf([0.53, 0.6], [0.74, 0.44], 0.04, STONE_TEAL, LEAF_GREEN, 0, -0.05),
    leaf([0.47, 0.78], [0.31, 0.64], 0.04, STONE_TEAL, LEAF_GREEN, 0, 0.05),
    leaf([0.46, 0.95], [0.1, 0.78], 0.11, STONE_TEAL, STONE_DEEP, 0.1, -0.08),
    leaf([0.54, 0.95], [0.9, 0.78], 0.11, STONE_TEAL, STONE_DEEP, 0.1, 0.08),
  ]),
  preset("ebru-battal", "Ebru battal", "Stone ebru: royal-blue drops in a lattice of white, yellow and black veins, each holding pale turpentine holes.",
    (() => {
      const sites = [[0.22, 0.18], [0.7, 0.13], [0.42, 0.46], [0.86, 0.45], [0.15, 0.78], [0.66, 0.82]];
      const cells = voronoiCells(sites, 0.035, 0.012);
      return [...cells.map((c) => boundary(roundedPolygon(c, 0.12), VEIN_BLUE, ["#2440d6", "#1c34b8", "#2a4be0", "#2440d6"], true)),
        ...sites.map(([x, y]) => point(x, y, "#d4e4dc"))];
    })()),
  preset("ebru-stone-teal", "Ebru stone teal", "Pale grey-teal drops laced with dark teal veins and white specks, the stone ground behind tulip ebru.",
    stoneCells([[0.18, 0.18], [0.52, 0.1], [0.84, 0.22], [0.3, 0.46], [0.66, 0.48], [0.14, 0.76], [0.5, 0.82], [0.86, 0.78]], 0.03, 0.008, 1, 0.1,
      () => ["#f2f1e8", "#2b5a55", "#2b5a55", "#f2f1e8"].map((c, k, a) => (k === a.length - 1 ? a[0] : c)),
      (i) => (i % 2 ? ["#94b8b2", "#86aaa5", "#a2c4be", "#94b8b2"] : ["#8db3ae", "#9cbfb9", "#80a6a1", "#8db3ae"]))),
  preset("marble-curl-stone", "Curl and stone", "Burgundy, cobalt, moss and ochre streaks wound into one vortex, after a French curl endpaper.",
    (() => {
      const warp = (p) => twirlPoint(p, { cx: 0.5, cy: 0.5, radius: 0.5, angle: 6 });
      return bandStack([0.2, 0.38, 0.55, 0.72].map((y) => warpedLine([0, y], [1, y], 10, warp)),
        ["#7a1f2a", satin("#3d7fb0", "#2a5f8c"), satin("#e8c27a", "#c8963a"), satin("#4c7a3c", "#2f5a2a"), "#7a1f2a"]);
    })()),
  preset("marble-stroom", "Dutch stroom", "Navy, brick, ochre and cream streams pulled into one S by opposed whirls, after Dutch stroom marbling.",
    flowBands([0.14, 0.3, 0.46, 0.62, 0.78], compose(twirl(0.32, 0.42, 0.32, 2.6), twirl(0.68, 0.6, 0.32, -2.6)), 8,
      ["#1f2f5a", satin("#c8543a", "#8f2f26"), satin("#efd9a6", "#d9b26a"), satin("#3f6fa0", "#26466f"), satin("#b8452e", "#7a2222"), "#1f2f5a"])),
  preset("marble-peacock-eye", "Peacock feather eye", "Nested teardrops of cobalt, cream, olive and midnight, like a peacock feather laid into fantasy ebru.",
    ringStack([1, 0.8, 0.62, 0.45, 0.3, 0.17].map((k) => dropNodes(0.5, 0.48, 0.9 * k, 0.94 * k)),
      [satin("#8fa8d6", "#6a84c0"), satin("#1c2a70", "#101a4a"), satin("#f4f2ec", "#c9d0e0"), satin("#7d8f3a", "#55662a"), satin("#2a8f9c", "#155f70"), satin("#161a4a", "#0c1030"), "#d9b04a"])),
];
