/**
 * Signature family: the original fourteen native presets (2026-09-28) — spirals,
 * psychedelic ribbons/rings and bokeh glows. Numeric rows are authored composition
 * data (unit-box positions/radii), not solver parameters. Repeated endpoint colors
 * make closed ramps seam-free.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { ellipseNodes, spiralNodes, waveNodes } from "../multipoint_shapes.js";

export const PRESETS = [
  preset("neon-spiral", "Neon spiral", "A cyan–pink spiral with violet opposite banks.", [
    boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.06, endRadius: 0.49, turns: 1.5 }),
      ["#fff5b2", "#29f5dd", "#ff41b4"], ["#5727a3", "#102764", "#350a55"]),
    point(0.08, 0.1, "#120d30"), point(0.92, 0.9, "#191342"),
  ]),
  preset("twin-spiral", "Twin spiral", "Two interleaved arms: hot coral and cool turquoise.",
    [0, Math.PI].map((phase, i) => boundary(
      spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.5, turns: 1.25, phase }),
      i ? ["#ecffb8", "#34e7ce", "#307fff"] : ["#fff0c2", "#ff647c", "#ae36d9"],
      i ? ["#153657", "#10234e", "#271646"] : ["#6b255d", "#491c66", "#28174d"]))),
  preset("acid-ribbons", "Acid ribbons", "Three broad sine boundaries in lime, pink and electric blue.",
    [0.22, 0.5, 0.78].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.12, cycles: 1.25 }),
      [["#faff52", "#62ff8a", "#fe70ea"], ["#ff54d5", "#faff65", "#44fff0"], ["#52b5ff", "#dd67ff", "#a1ff55"]][i],
      ["#301255", "#202071", "#441343"]))),
  preset("chromatic-rings", "Chromatic rings", "Nested off-center circles with contrasting rainbow banks.",
    [0.13, 0.27, 0.43, 0.61].map((radius, i) => boundary(ellipseNodes(0.42, 0.48, radius),
      ["#ff737e", "#ffe46e", "#58eddb", "#ff737e"],
      ["#6b1c8e", "#123777", "#30236c", "#6b1c8e"].map((color, j, colors) => colors[(j + i) % (colors.length - 1)]), true))),
  preset("aurora-curtains", "Aurora curtains", "Sweeping green, cyan and lilac curtains over deep blue.", [
    ...[0.25, 0.49, 0.73].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.1, cycles: 0.75, phase: -Math.PI / 2 }),
      [["#215e78", "#91ffc4", "#427fc1"], ["#38568f", "#46eed7", "#cc92ff"], ["#263968", "#648dca", "#ac6ce0"]][i],
      ["#09182f", "#122e4c", "#201738"])),
    point(0.5, 0.02, "#080f28"), point(0.5, 0.98, "#11172d"),
  ]),
  preset("prism-fan", "Prism fan", "Separated straight rays spread from a narrow throat into a spectrum.",
    ["#fa4869", "#ffb84d", "#e4f878", "#51e6cb", "#718cff", "#c579f0"].map((color, i, colors) => {
      const t = i / (colors.length - 1);
      return boundary([[0.06, 0.36 + 0.28 * t, 0, 0, 0, 0], [1.06, -0.06 + 1.12 * t, 0, 0, 0, 0]],
        ["#fff1ce", color]);
    })),
  preset("rainbow-arches", "Rainbow arches", "Six broad nested rainbow waves with independent color stops.",
    ["#ff527a", "#ffae55", "#ffe77a", "#73efb8", "#65c6ff", "#ae8bfa"].map((color, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y: 0.4 + i * 0.1, amplitude: -0.3, cycles: 0.5 }),
      [color, "#fff0ec", color]))),
  preset("warm-bokeh", "Warm bokeh", "Three amber, rose and peach circular glows on a wine-dark field.", [
    ...glow(0.23, 0.27, 0.2, ["#fff7d6", "#edaa58", "#2e1525"]),
    ...glow(0.73, 0.37, 0.23, ["#ffe3d8", "#ef7884", "#2e1525"]),
    ...glow(0.43, 0.79, 0.16, ["#fff0cf", "#d98551", "#2e1525"]),
  ]),
  preset("cool-bokeh", "Cool bokeh", "Four mint, ice-blue and lavender glows on midnight blue.", [
    ...glow(0.2, 0.22, 0.16, ["#ecffff", "#70d8ea", "#101b38"]),
    ...glow(0.7, 0.26, 0.21, ["#f1edff", "#a493ed", "#101b38"]),
    ...glow(0.3, 0.72, 0.22, ["#e3fff4", "#62c8b9", "#101b38"]),
    ...glow(0.8, 0.78, 0.13, ["#e5eeff", "#699bdf", "#101b38"]),
  ]),
  preset("lava-lagoons", "Lava lagoons", "Tall molten pools, orange rims and dark plum surrounding banks.", [
    ...[[0.22, 0.36, 0.13, 0.3], [0.73, 0.66, 0.18, 0.29], [0.68, 0.13, 0.23, 0.09]].flatMap(([cx, cy, rx, ry]) => [
      point(cx, cy, "#ffe79b"),
      boundary(ellipseNodes(cx, cy, rx, ry), ["#ff8148", "#ef345f", "#ff8148"], ["#431027", "#210e31", "#431027"], true),
    ]),
  ]),
  preset("candy-vortex", "Candy vortex", "A reverse pastel spiral with strawberry and mint opposite banks.", [
    boundary(spiralNodes({ cx: 0.47, cy: 0.52, startRadius: 0.08, endRadius: 0.48, turns: -1.25, phase: Math.PI / 3 }),
      ["#fff2c5", "#ff9dc7", "#d7b4ff", "#a6f3ed"], ["#f29bbc", "#b88ce6", "#75ced7", "#ffe0ed"]),
    boundary(ellipseNodes(0.5, 0.5, 0.68), ["#fce4ee"], null, true),
  ]),
  preset("sunset-tide", "Sunset tide", "A peach sun above plum, coral and indigo tidal bands.", [
    ...glow(0.5, 0.2, 0.15, ["#fff4b8", "#ffbb76", "#ef7f89"]),
    ...[0.48, 0.69, 0.9].map((y, i) => boundary(
      waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.055, cycles: 0.75 }),
      [["#ba5b89", "#ffc19a", "#ad538c"], ["#5b4a87", "#f38c9c", "#514b89"], ["#223357", "#79669f", "#283956"]][i])),
  ]),
  preset("tidal-lagoon", "Tidal lagoon", "An open turquoise curl winding between sand and deep ocean.", [
    boundary(spiralNodes({ cx: 0.4, cy: 0.5, startRadius: 0.12, endRadius: 0.59, turns: 0.75, phase: Math.PI }),
      ["#fff1c6", "#70e1c6", "#259bc0"], ["#34a1b0", "#17617e", "#112e57"]),
    point(0.08, 0.08, "#f3d9a7"), point(0.93, 0.88, "#122e59"),
  ]),
  preset("velvet-folds", "Velvet folds", "Two slow burgundy waves edged with mauve and warm rose.", [
    ...[0.3, 0.7].map((y) => boundary(waveNodes({ x0: -0.08, x1: 1.08, y, amplitude: 0.18, cycles: 0.5, phase: -Math.PI / 2 }),
      ["#4b1949", "#e69bb6", "#83345d"], ["#190e2b", "#642449", "#251030"])),
    point(0.82, 0.12, "#d39aa4"),
  ]),
];
