/**
 * "Film & print processes" — native Multipoint presets. Photographic and print processes: halation, instant fade, cyanotype, toning, risograph.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { waveNodes } from "../multipoint_shapes.js";
import { boxEdge, cornerFrame, roundedRectNodes } from "./retro_eras.js";
import { hline, vramp, streak, pool, glow, overlapArcs, leafletLines, leafNodes } from "./cinema_helpers.js";

const flat = (color, count) => Array(count).fill(color);

const PRUSSIAN = "#2c4d85", PRUSSIAN_LIT = "#3c5f95", FERN_PALE = "#a3bcc6";

/** One pinnate frond: a spine ribbon plus paired two-node leaflets, pale on Prussian blue. */
const fern = (() => {
  const spine = { p0: [0.5, 0.96], p1: [0.46, 0.5], p2: [0.54, 0.05] };
  const leaflets = leafletLines({ ...spine, count: 5, tStart: 0.25, tEnd: 0.88, length: 0.3, angle: 1.0, tipScale: 0.35, gap: 0.014 });
  return [
    streak([spine.p0, [0.47, 0.52], spine.p2], [0, 0.014, 0], PRUSSIAN, FERN_PALE),
    ...leaflets.map(([base, , tip], i) => boundary(leafNodes(base, tip, 0.034 * (1 - 0.5 * Math.floor(i / 2) / 4)), [PRUSSIAN_LIT], [FERN_PALE], true)),
  ];
})();

const PAPER = "#f4efe3", RISO_PINK = "#ff48b0", RISO_BLUE = "#0078bf", RISO_VIOLET = "#5b3aa6";

const riso = overlapArcs({ cx: 0.5, cy: 0.5, r: 0.3, d: 0.13 });

export const PRESETS = [
  preset("tungsten-halation", "Tungsten halation", "Tungsten night film without its anti-halation backing: cream lamp cores ringed in orange, a red halo bleeding into teal-black.", [
    ...cornerFrame("#06141c", "#08182a", "#07121a", "#05121a"),
    ...glow(0.28, 0.32, 0.18, ["#fff4dc", "#ffa040", "#7a1610"], 0.4),
    ...glow(0.72, 0.5, 0.2, ["#fff0d0", "#ff9438", "#761410"], 0.4),
    ...glow(0.3, 0.8, 0.1, ["#ffe8c0", "#ff8a30", "#701210"], 0.4),
  ]),
  preset("instant-film-fade", "Instant film fade", "A faded instant print: cream frame, milky teal-grey picture with a yellow chemical bleed and lifted, low-contrast blacks.", [
    ...cornerFrame(...flat("#efe9dc", 4)),
    boundary(roundedRectNodes({ x0: 0.1, y0: 0.08, x1: 0.9, y1: 0.76, r: 0.02 }), flat("#efe9dc", 4), ["#9fc1bc", "#c8c8a0", "#7f8f98", "#9fc1bc"], true),
    ...pool(0.62, 0.34, 0.2, 0.14, ["#fff0c0", "#e8d090", "#a6b8ae"]),
  ]),
  preset("cyanotype-fern", "Cyanotype", "Anna Atkins' sun-print: a pale fern frond on Prussian blue, the leaflets softly haloed where light crept under.", [
    boxEdge("top", [PRUSSIAN]),
    ...fern,
  ]),
  preset("sepia-toned-portrait", "Sepia toning", "A sepia-toned portrait print: creamy highlights sliding through warm brown into near-black umber at the edges.", [
    ...cornerFrame("#150c06", "#1c1108", "#120a05", "#1a0f07"),
    ...glow(0.44, 0.42, 0.4, ["#e8cdaa", "#a5764c", "#1e130b"], 0.42),
  ]),
  preset("selenium-toned-ridges", "Selenium toning", "Selenium-toned landscape: plum-black shadows and warm-grey highlights in misty ridges under a pale moon.", [
    ...vramp(["#b8aab4", "#e0d6d2"], undefined, 0, 0.48),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.02, cycles: 1 }), ["#e6ddd6"], ["#a898a6"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.68, amplitude: 0.025, cycles: 1.25 }), ["#a898a6"], ["#6c5566"]),
    hline(0.86, 0.82, ["#6c5566"], ["#241a26"]),
    ...glow(0.7, 0.22, 0.12, ["#fbf5f0", "#efe6e2", "#cbbcc6"]),
  ]),
  preset("riso-overprint-blue-pink", "Riso overprint", "Two-drum risograph: fluorescent pink and blue discs on warm paper, the overlap printing a deep violet.", [
    ...cornerFrame(...flat(PAPER, 4)),
    boundary(riso.rightOuter, [PAPER], [RISO_BLUE]),
    boundary(riso.leftOuter, [PAPER], [RISO_PINK]),
    boundary(riso.lensRight, [RISO_BLUE], [RISO_VIOLET]),
    boundary(riso.lensLeft, [RISO_PINK], [RISO_VIOLET]),
  ]),
];
