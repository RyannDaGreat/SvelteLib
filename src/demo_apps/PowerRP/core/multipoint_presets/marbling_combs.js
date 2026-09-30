/**
 * "Marbling" — native Multipoint presets. Combed ebru (gel-git, taraklı, get-gel), Spanish wave, hatip, suminagashi, stone cells, whirls, marbled paisley and acrylic pours.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes } from "../multipoint_shapes.js";
import { zigzagNodes, scallopNodes, bandStack, ringStack, satin, flowBands, lineBands, compose, twirl, blobStack, scalesDown, fan, swell, swell2, tilted, vlineBands, latticeSites, whirlArms, sawNodes, botehNodes, scaleAbout, rotateAbout, stoneSheet, bloomRings } from "./marbling_combs_helpers.js";

const PLUME = ["#ecdfc2", satin("#2f4fa8", "#16286e"), satin("#f5efe0", "#cfc7b0"), satin("#f3bf45", "#c98a22"), "#d9587a"];

const SKY = ["#d6e6ea", "#a9c6d2", "#6f97b0"], GOLD = ["#fbe9a8", "#e6c36a", "#b58a2c"];

const NEST_GROUND = "#f4e3cc";

const NEST_PLUM = ["#3f2a55", "#5a3a72", "#3a2650", "#3f2a55"], NEST_PEACH = ["#f4a994", "#f8bfa8", "#ee9684", "#f4a994"], NEST_CREAM = ["#f7e6d2", "#fbf0e2", "#f2dcc4", "#f7e6d2"];

const ramp4 = (a, b, c) => [a, b, c, a];

const IND = ramp4("#1c2a6e", "#2a3d96", "#16205a"), GLD = ramp4("#e3b04a", "#f3cb6a", "#cf9530"), IVY = ramp4("#f5eedc", "#fbf7ea", "#ebe1c6");

const { nodes: BOTEH, centre: BOTEH_CENTRE } = botehNodes();

const BOTEH_TURNED = rotateAbout(BOTEH, Math.PI, [0.5, 0.5]), BOTEH_TURNED_CENTRE = [1 - BOTEH_CENTRE[0], 1 - BOTEH_CENTRE[1]];

export const PRESETS = [
  preset("marble-gel-git", "Gel-git", "Come-and-go: a comb dragged back and forth folds violet, tangerine, saffron and ink into crisp chevrons, after Turkish gel-git marbling.",
    bandStack([[0.16, 0.05], [0.38, 0.065], [0.6, 0.08], [0.83, 0.09]].map(([y, amp]) => zigzagNodes({ y, amp, halves: 8, round: 0.11 })),
      [satin(["#4a2d7a", "#5d3a93", "#3c2468", "#4a2d7a"], ["#2a1a52", "#351f66", "#221446", "#2a1a52"], 0.25),
       satin(["#e8622c", "#f07a2e", "#dd4f25", "#e8622c"], ["#a8321c", "#b8401f", "#9a2c1a", "#a8321c"]),
       satin(["#f7cf3a", "#fbe06a", "#f2bd28", "#f7cf3a"], ["#cf8f1c", "#d9a022", "#c48418", "#cf8f1c"]),
       satin(["#6b4aa8", "#7d5bb8", "#5c3c98", "#6b4aa8"], ["#33205f", "#3c266e", "#2c1a55", "#33205f"]),
       ["#f0dfb8", "#f6e9c9", "#ead6a8", "#f0dfb8"]])),
  preset("marble-tarakli", "Taraklı", "Rows of combed arches in violet, vermilion, saffron and deep teal, each row shifting hue as the comb passed, after Turkish taraklı (comb) ebru.",
    bandStack([[0.2, 4], [0.42, 5], [0.64, 4], [0.86, 5]].map(([y, teeth]) => scallopNodes({ y: y - 0.06, depth: 0.12, teeth, hump: 0.3, tipX: 0.1, tipY: 0.85 })),
      [satin(["#4a2d86", "#5c3aa0", "#3a2470", "#4a2d86"], ["#2a1a58", "#35207a", "#221446", "#2a1a58"], 0.22),
       satin(["#e8552c", "#f0712e", "#d63e25", "#e8552c"], ["#9c2a1a", "#b03a1d", "#8a2418", "#9c2a1a"], 0.2),
       satin(["#f6c53a", "#fbdc68", "#f0ae28", "#f6c53a"], ["#c8861c", "#d9981f", "#b87616", "#c8861c"], 0.2),
       satin(["#2f9a88", "#3fb09a", "#2a8474", "#2f9a88"], ["#15574e", "#1b6a5e", "#124a42", "#15574e"], 0.2),
       ["#f4e7c8", "#faefd3", "#ecd9b0", "#f4e7c8"]])),
  preset("marble-spanish-wave", "Spanish wave", "Soft drapes of sage, mauve, taupe and teal rolling diagonally across the sheet like rippled cloth, after Spanish wave marbling and the shawl (şal) ebru.",
    lineBands(tilted([0.3, 0.5, 0.7, 0.9], -0.22), 10, swell(0.1, 1.6, 0.1),
      [satin(["#9fb08a", "#b4c39c", "#8da078", "#9fb08a"], ["#5f7552", "#6d8460", "#566a48", "#5f7552"], 0.25),
       satin(["#c08fb0", "#d3a4c4", "#a97a9c", "#c08fb0"], ["#74496e", "#835680", "#683f62", "#74496e"], 0.25),
       satin(["#d8c4a2", "#e8d8ba", "#c6b088", "#d8c4a2"], ["#9a8258", "#a98f62", "#8a7250", "#9a8258"], 0.25),
       satin(["#6fa3a3", "#84b8b6", "#5f9090", "#6fa3a3"], ["#35686a", "#3f7577", "#2c5a5c", "#35686a"], 0.25),
       "#f2e8d4"])),
  preset("suminagashi-rose", "Suminagashi rose", "Fine concentric rings of blush, rose, oxblood, cream and sage dropped one inside another on still water, after a floating-ink suminagashi series.",
    ringStack(blobStack({ from: [0.44, 0.47], to: [0.58, 0.55], rx: 0.43, ry: 0.4, wobble: 0.09, phase: 0.6, n: 5, scales: scalesDown(8, 0.12) }),
      ["#f2e7da", "#e9a7a6", "#faf2e8", "#b84a52", "#eddccf", "#8d9a7a", "#f8efe3", "#7a3450", "#f4e6dc"])),
  preset("suminagashi-gilt", "Suminagashi gilt", "Gold, teal and ivory ink rings floating on black water, each one a little off the last.",
    ringStack(blobStack({ from: [0.56, 0.46], to: [0.44, 0.56], rx: 0.43, ry: 0.4, wobble: 0.1, phase: 4.1, n: 5, scales: scalesDown(8, 0.12) }),
      ["#0d1018", "#d9a93f", "#0d1018", "#2f9a9a", "#0d1018", "#f3ead2", "#0d1018", "#d9a93f", "#0d1018"])),
  preset("marble-hatip-rings", "Hatip rings", "Concentric shapes of slate, rust, teal and ivory laid one inside another and crowding toward one side, after the nested rings of hatip ebru.",
    ringStack(blobStack({ from: [0.4, 0.44], to: [0.6, 0.56], rx: 0.4, ry: 0.36, wobble: 0.06, phase: 1.1, n: 5, scales: scalesDown(8, 0.1) }),
      ["#e9dfc9", satin("#5d7486", "#3c5060"), "#f2e9d3", satin("#b5583a", "#7d3422"), "#efe2c6", satin("#2f7f86", "#1d5258"), "#f1e6cc", satin("#22324a", "#121b2c"), "#d8a24a"])),
  preset("marble-bouquet", "Bouquet", "Three peacock plumes of cobalt, cream, gold and rose standing shoulder to shoulder on the tray floor, after the bouquet pattern.",
    [[0.17, 0.155, 0.3, 0.1], [0.5, 0.155, 0.08, 0], [0.83, 0.155, 0.3, -0.1]].flatMap(([cx, hw, apexY, lean]) =>
      bandStack(fan(cx, hw, apexY, [1, 0.74, 0.5, 0.26], lean, 0.7), PLUME))),
  preset("marble-turkish-stone", "Turkish stone", "Pale sky-blue and gold cobbles lit from one side and netted by bitter-chocolate veins, after the battal (stone) and kumlu (sandy) ebru of old endpapers.",
    stoneSheet([[0.17, 0.18], [0.52, 0.1], [0.86, 0.2], [0.3, 0.5], [0.76, 0.5], [0.14, 0.84], [0.54, 0.86], [0.9, 0.82]], 0.035, 0.12, ["#4b2e1f"],
      (i) => (i % 3 ? SKY : GOLD))),
  preset("marble-florentine-stone", "Florentine stone", "Emerald, vermilion and gold cobbles cut by ivory veins, after the bold stone papers of Florentine marblers.",
    stoneSheet(latticeSites(12, [3, 2, 3], 0.22).map((s) => [s.cx, s.cy]), 0.04, 0.16, ["#f3ead2"],
      (i) => [["#7fd3a8", "#2f9a72", "#14513c"], ["#f48a6a", "#d63e2c", "#7d1a18"], ["#fbe08a", "#e3b23c", "#9a6a16"]][i % 3])),
  preset("marble-dutch-coral", "Dutch coral", "Coral and rose cobbles lit from one side, parted by thin deep-teal veins, after old Dutch stone-marbled papers.",
    stoneSheet(latticeSites(42, [3, 2, 3], 0.22).map((s) => [s.cx, s.cy]), 0.04, 0.16, ["#143f45"],
      (i) => (i % 2 ? ["#ffd2c0", "#f59a84", "#c8584a"] : ["#ffe2d0", "#f4ae94", "#d06a58"]))),
  preset("acrylic-teal-gold", "Acrylic pour teal and gold", "A fluid-art pour of deep teal, white, gold leaf and black swirled into one slow eddy, after modern acrylic marbling.",
    flowBands([0.22, 0.4, 0.58, 0.78], compose(swell(0.04, 1, 0.1), twirl(0.38, 0.46, 0.4, 4.4), twirl(0.78, 0.66, 0.22, -3)), 10,
      ["#0b2c33", satin("#1b7a7f", "#0d4c54"), satin("#f7f3ea", "#d7d2c3"), satin("#d9a93f", "#9c6d1c"), "#0a1f25"])),
  preset("acrylic-ocean", "Acrylic pour ocean", "Aqua, turquoise, white foam and navy rolled into a breaking swell, after a modern beach-style acrylic pour.",
    lineBands(tilted([0.26, 0.44, 0.62, 0.8], -0.08), 10, compose(swell(0.08, 1.5, 0.05), twirl(0.66, 0.4, 0.3, -4.2), twirl(0.25, 0.62, 0.22, 2.8)),
      ["#0e2a52", satin("#1c78a8", "#0f4c78"), satin("#f4fbfb", "#b9dfe3"), satin("#3bc0c4", "#1e7f88"), "#7fd8d0"])),
  preset("marble-hatip-bloom", "Hatip bloom", "A five-petalled flower laid in nested layers of peach and aubergine over a dusky ground, after the hatip flowers of Turkish ebru.",
    ringStack(bloomRings({ cx: 0.5, cy: 0.5, lobes: 5, R: 0.47, notch: 0.56, scales: [1, 0.76, 0.54, 0.32] }),
      ["#3a2f48", satin("#f4a994", "#d97a6c"), satin("#5a4a70", "#2a2138"), satin("#f7bca6", "#e08a78"), "#3a2f48"])),
  preset("marble-zebra-wave", "Zebra wave", "Bold ink-black and ivory stripes with one band of vermilion, bent into long swells, after zebra marbling.",
    lineBands(tilted([0.14, 0.27, 0.4, 0.53, 0.66, 0.79], -0.1), 6, swell(0.09, 1, 0.05),
      ["#15141a", "#f4ecda", "#15141a", "#e0482f", "#15141a", "#f4ecda", "#15141a"])),
  preset("acrylic-sunset", "Acrylic pour sunset", "Plum, magenta, tangerine and lemon streams rising in one tall twist, after a modern acrylic pour.",
    vlineBands([0.2, 0.4, 0.6, 0.8], 10, compose(swell2(0.05, 1, 0.2), twirl(0.42, 0.36, 0.36, 4.2), twirl(0.68, 0.72, 0.22, -3)),
      ["#3a1248", satin("#b2247c", "#6e1258"), satin("#f4672a", "#b53a1c"), satin("#fbd040", "#d98f1c"), "#fff0c8"])),
  preset("acrylic-emerald", "Acrylic pour emerald", "Emerald, black, gold leaf and pearl white turning around two eddies, after a modern acrylic pour.",
    lineBands(tilted([0.12, 0.32, 0.52, 0.72], 0.18), 10, compose(swell(0.05, 1, 0.45), twirl(0.34, 0.44, 0.3, 4), twirl(0.74, 0.62, 0.24, -3.4)),
      ["#04140f", satin("#0f7a55", "#074a36"), satin("#f3efe2", "#cfcab8"), satin("#d6a43a", "#95661a"), "#062a20"])),
  preset("acrylic-terracotta", "Acrylic pour terracotta", "Terracotta, sand, sage and cream folded into warm slow waves, a boho acrylic pour.",
    flowBands([0.22, 0.42, 0.62, 0.8], compose(swell(0.07, 1.5, 0.3), twirl(0.72, 0.3, 0.26, 3.4), twirl(0.3, 0.66, 0.3, -3.6)), 10,
      ["#efe0c8", satin("#c9664a", "#8f3c2a"), satin("#8fa58a", "#5a7458"), satin("#e8c79a", "#b8945c"), "#b5523a"])),
  preset("marble-bulbul-nest", "Bülbül yuvası", "One big three-armed whirl of plum, peach and cream wound tight like a nightingale's nest, after the spiral bülbül yuvası of Turkish ebru.",
    [boundary(ellipseNodes(0.5, 0.5, 0.495), [NEST_GROUND], null, true),
      ...whirlArms({ cx: 0.5, cy: 0.5, r0: 0.02, r1: 0.46, turns: 2.5, ground: NEST_GROUND,
        order: [[NEST_PLUM, NEST_PEACH], [NEST_CREAM, NEST_PLUM], [NEST_PEACH, NEST_CREAM]] })]),
  preset("marble-whirl-indigo", "Indigo and gold whirl", "A two-armed coil of indigo and gold leaf wound over ivory paper, after the snail curls of marbled endpapers.",
    [boundary(ellipseNodes(0.5, 0.5, 0.495), ["#f3ecd8"], null, true),
      ...whirlArms({ cx: 0.5, cy: 0.5, r0: 0.02, r1: 0.46, turns: 3, ground: "#f3ecd8", order: [[IND, GLD], [GLD, IND]] })]),
  preset("marble-get-gel", "Get-gel", "Leaning comb teeth in cobalt, lilac, sea-green and pearl dragged one way then the other, after the get-gel (come-and-go) family of combed patterns.",
    bandStack([[0.24, 0.08], [0.44, 0.09], [0.64, 0.1], [0.86, 0.11]].map(([y, amp]) => sawNodes({ y, amp, teeth: 4, lean: 0.8, round: 0.2 })),
      [satin(["#2b3f9a", "#3c56b8", "#26377f", "#2b3f9a"], ["#141f5c", "#1b2a74", "#101a4c", "#141f5c"], 0.22),
       satin(["#b9a6e0", "#cdbdf0", "#a893d2", "#b9a6e0"], ["#7a64a8", "#8b75ba", "#6b5698", "#7a64a8"], 0.2),
       satin(["#7fc4ae", "#9ad6c2", "#6bb09a", "#7fc4ae"], ["#3f8a78", "#4b9b89", "#347a69", "#3f8a78"], 0.2),
       satin(["#f7f2e6", "#fcf9f0", "#ece5d2", "#f7f2e6"], ["#cfc6ac", "#d9d0b6", "#c2b99c", "#cfc6ac"], 0.1),
       ["#e9a1a8", "#f3b8bc", "#dd8c95", "#e9a1a8"]])),
  preset("marble-paisley-shawl", "Paisley shawl", "A curled paisley boteh nested five times in coral, ivory, teal, gold and plum on indigo, after the shawl (şal) patterns of Turkish ebru.",
    ringStack([1, 0.8, 0.6, 0.4, 0.22].map((k) => scaleAbout(BOTEH, k, BOTEH_CENTRE)),
      ["#1d2a5e", satin("#e8604a", "#a8301f"), satin("#f4ead0", "#cdbf98"), satin("#2f8f8c", "#185a58"), satin("#f0b53c", "#c08a1c"), "#7a2a52"])),
  preset("marble-paisley-gilt", "Paisley gilt", "A turned paisley boteh nested in gold, cream, rose and ink on deep teal, after the shawl (şal) patterns of Turkish ebru.",
    ringStack([1, 0.76, 0.54, 0.32].map((k) => scaleAbout(BOTEH_TURNED, k, BOTEH_TURNED_CENTRE)),
      ["#0f3b40", satin("#e2a93a", "#9a6a18"), satin("#f6eedb", "#d4c8a6"), satin("#e37a8c", "#a8405a"), "#1c1a2e"])),
];
