/**
 * "Surrealism" — native Multipoint presets. Dalí, Magritte, Tanguy, Miró and de Chirico: dream horizons and floating forms.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { graphNodes, hLine, bump, bandStack, poly, disc, shaded, starNodesFor, strokeNodes } from "./surreal_pop_helpers.js";

/**
 * Pure function. A Tanguy plain: three horizontal colour lines (top, haze, bottom) make a horizonless field; soft-shaded
 * forms and long flat shadows sit on it, each ringed by the field colour at its own height so nothing haloes.
 * @param {object} o - {top, haze, bottom, hazeAt, ink: [mid, dark, light] form ramp, shadow, accents: [[x,y,r,colour]...]}.
 * @returns {object[]} 12-ish features, 37 nodes.
 * @example tanguyScene({top:"#cccccc",haze:"#eeeeee",bottom:"#777777",hazeAt:0.5,ink:["#888888","#222222","#dddddd"],shadow:"#333333",accents:[]}).length // 9
 */
function tanguyScene({ top, haze, bottom, hazeAt, ink, shadow, accents }) {
  const field = (y) => (y < hazeAt ? mixHex(top, haze, y / hazeAt) : mixHex(haze, bottom, (y - hazeAt) / (1 - hazeAt)));
  return [
    boundary(hLine(0), [top]), boundary(graphNodes(() => hazeAt, 2), [haze]), boundary(hLine(1), [bottom]),
    shaded(blobNodes({ cx: 0.6, cy: 0.64, rx: 0.13, ry: 0.075, harmonics: [[2, 0.2, 0.5], [3, 0.1, 1]], count: 5 }), field(0.64), ink),
    shaded(ellipseNodes(0.22, 0.58, 0.028, 0.13), field(0.58), ink),
    shaded(ellipseNodes(0.45, 0.8, 0.05, 0.035), field(0.8), ink),
    disc(0.84, 0.72, 0.08, field(0.72), shadow, 0.014),
    disc(0.34, 0.71, 0.08, field(0.71), shadow, 0.012),
    ...accents.map(([x, y, r, colour]) => disc(x, y, r, field(y), colour)),
  ];
}

export const PRESETS = [
  // Dali, The Persistence of Memory: turquoise-to-gold dusk over a dark brown plain, a golden cliff on the far shore.
  preset("dali-desert-dusk", "Dali desert dusk", "A turquoise sky glowing gold at the horizon over a dark umber plain and a far ochre cliff.", [
    boundary(hLine(0), ["#2f6f86"]),
    boundary(graphNodes((x) => 0.3 + 0.01 * Math.sin(6 * x), 4), ["#7fb4a6"]),
    boundary(graphNodes((x) => 0.5 - bump(x, 0.85, 0.32, 0.09) - 0.01 * x, 8),
      ["#f4d9a0", "#f4d9a0", "#f0c988", "#f0c988"], ["#6b4a24", "#5a3c1c", "#d9a95a", "#b98446"]),
    boundary(graphNodes((x) => 0.72 + 0.03 * Math.sin(4 * x + 1), 4), ["#4a3018"]),
    boundary(hLine(1), ["#1f130a"]),
  ]),
  // Dali, Temptation of St Anthony: a storm sky tilted into bands of amber, teal, ivory and rose over dark earth.
  preset("dali-amber-storm", "Dali amber storm", "Slanting storm bands of teal, amber, ivory and dusty rose above a bruise-dark earth.",
    bandStack([
      graphNodes((x) => 0.18 + 0.12 * x + 0.03 * Math.sin(7 * x), 6),
      graphNodes((x) => 0.36 + 0.06 * x - 0.03 * Math.sin(5 * x + 1), 6),
      graphNodes((x) => 0.56 - 0.1 * x + 0.03 * Math.sin(6 * x + 2), 6),
      graphNodes((x) => 0.8 - 0.04 * x, 4),
    ], [["#1f3a44", "#2b5762", "#1f3a44"], ["#f2b444", "#d88f2f", "#b8641f"], ["#fff2c8", "#f4e2b2", "#e6c48c"],
      ["#c8806e", "#b4645a", "#8a4048"], ["#2a1a14", "#1d1410", "#110b09"]])),
  // Magritte, cumulus skies (Golconda, The Voice of Space): cerulean deepening upward behind rounded white clouds.
  preset("magritte-fair-weather", "Fair-weather clouds", "Rounded white cumulus with lilac-grey undersides drifting on a cerulean sky.", [
    boundary(hLine(0), ["#2f6fbd"]),
    boundary(hLine(1), ["#a9d2f2"]),
    ...[[0.3, 0.3, 0.24, 0.12, 0.3], [0.72, 0.52, 0.22, 0.11, 1.2], [0.36, 0.78, 0.2, 0.09, 2]].map(([cx, cy, rx, ry, ph]) =>
      shaded(blobNodes({ cx, cy, rx, ry, harmonics: [[3, 0.14, ph], [2, 0.08, ph + 1]], count: 6 }),
        mixHex("#2f6fbd", "#a9d2f2", cy), ["#e8eef8", "#aebbd6", "#ffffff"])),
  ]),
  // Tanguy, Indefinite Divisibility: a horizonless pearl-grey plain, soft-shaded bone forms and long flat shadows.
  preset("tanguy-grey-plain", "Tanguy grey plain", "A horizonless pearl-grey plain with soft-shaded pebbles, a spindle and long flat shadows.", tanguyScene({
    top: "#c6c8c0", haze: "#ece8dc", bottom: "#7c7a72", hazeAt: 0.55, ink: ["#e8e4d8", "#5e5a54", "#f6f3ec"], shadow: "#4b4842",
    accents: [[0.84, 0.86, 0.026, "#d9532b"], [0.3, 0.4, 0.016, "#3b6ea5"]],
  })),
  // Tanguy, 1930s: rose-and-ochre haze where sky and earth are one blurred field, with dark bone pebbles.
  preset("tanguy-rose-ochre", "Tanguy rose ochre", "A blurred rose and ochre haze with sky and earth merged, dark pebbles and long shadows.", tanguyScene({
    top: "#efd3c6", haze: "#f8e6d2", bottom: "#8a6350", hazeAt: 0.5, ink: ["#4a3a36", "#1c1818", "#b08e7a"], shadow: "#5a3f38",
    accents: [[0.14, 0.86, 0.022, "#f2c15a"], [0.88, 0.46, 0.018, "#e8735a"]],
  })),
  // Tanguy, late American work: a sunless sea-green light with nasturtium, slate and cinnamon forms.
  preset("tanguy-sea-floor", "Tanguy sea floor", "A sunless green-grey light with nasturtium, slate and cinnamon forms on a silent floor.", tanguyScene({
    top: "#d9e2d6", haze: "#eef0df", bottom: "#3f5a56", hazeAt: 0.45, ink: ["#e2652c", "#7a2a12", "#f6b070"], shadow: "#25352f",
    accents: [[0.12, 0.5, 0.026, "#4b5f70"], [0.78, 0.9, 0.024, "#9c5a36"]],
  })),
  // Miro, Constellations: washed cream ground, one black star, red, blue and yellow discs joined by a calligraphic line.
  preset("miro-constellation", "Miro constellation", "A cream wash with a black star, red, blue and yellow discs and a calligraphic black line.", [
    boundary(hLine(0), ["#eadab4"]),
    boundary(hLine(1), ["#c8b48a"]),
    boundary(starNodesFor(0.3, 0.3, 0.09, 0.035, 6), ["#e2cfa4"], ["#141212"], true),
    disc(0.72, 0.26, 0.065, "#e0cca2", "#d8392b"),
    disc(0.56, 0.72, 0.045, "#d2be94", "#2a4fa8"),
    disc(0.2, 0.76, 0.04, "#d0bc92", "#f2c630"),
    boundary(strokeNodes([[0.08, 0.5], [0.34, 0.46], [0.6, 0.55], [0.92, 0.48]], [0.012, 0.014, 0.012, 0.01]),
      ["#dcc8a0"], ["#141212"], true),
  ]),
  // Miro, Blue II: an ultramarine field, one red sun, a fat black stroke and a white star.
  preset("miro-blue-field", "Miro blue field", "An ultramarine field with a red sun, a fat black stroke and a small white star.", [
    boundary(hLine(0), ["#12388c"]),
    boundary(hLine(1), ["#2f78d0"]),
    shaded(ellipseNodes(0.7, 0.32, 0.11), mixHex("#12388c", "#2f78d0", 0.32), ["#e8503a", "#c02420", "#f06a4a"]),
    boundary(strokeNodes([[0.08, 0.72], [0.3, 0.6], [0.52, 0.78], [0.8, 0.7]], [0.02, 0.028, 0.022, 0.014]),
      [mixHex("#12388c", "#2f78d0", 0.7)], ["#0c0e14"], true),
    boundary(starNodesFor(0.28, 0.24, 0.05, 0.02, 5), [mixHex("#12388c", "#2f78d0", 0.24)], ["#f4f1e8"], true),
  ]),
  // Miro, The Harlequin's Carnival: dusty rose wall over a mauve floor with a lilac window, a green moon and a black wave.
  preset("miro-carnival", "Miro carnival", "A dusty rose wall over a mauve floor with a lilac window, a green disc, a black wave and red and yellow accents.", [
    boundary(graphNodes((x) => 0.56 + 0.012 * Math.sin(5 * x), 3), ["#cfa892"], ["#b2766e"]),
    poly([[0.66, 0.06], [0.88, 0.06], [0.88, 0.26], [0.66, 0.26]], "#cfa892", "#7c8cd2"),
    poly([[0.7, 0.24], [0.77, 0.1], [0.84, 0.24]], "#7c8cd2", "#15121a"),
    shaded(ellipseNodes(0.78, 0.4, 0.09), "#cfa892", ["#3f8a5a", "#1f4d33", "#3a7a50"]),
    disc(0.3, 0.3, 0.09, "#cfa892", "#8492d6"),
    disc(0.16, 0.14, 0.04, "#cfa892", "#d8392b"),
    disc(0.5, 0.15, 0.03, "#cfa892", "#f2c53a"),
    boundary(strokeNodes([[0.08, 0.47], [0.3, 0.43], [0.52, 0.48], [0.7, 0.44]], [0.011, 0.014, 0.011, 0.008]),
      ["#cfa892"], ["#15121a"], true),
  ]),
  // De Chirico, Mystery and Melancholy of a Street: a bottle-green sky over a white arcade, a sunlit orange road and a black shadow.
  preset("dechirico-empty-piazza", "De Chirico piazza", "A bottle-green sky over a white arcade, a slanting sunlit ochre road and a black shadowed building.", [
    boundary(polylineNodes([[0, 0], [0.68, 0], [0.68, 0.32], [0.03, 0.11]]), ["#1c2622"],
      ["#1f353c"], true),
    poly([[0.03, 0.14], [0.6, 0.35], [0.6, 0.43], [0.03, 0.63]], "#1c2622", "#efe6cf"),
    disc(0.12, 0.42, 0.028, "#efe6cf", "#26302a", 0.11),
    disc(0.28, 0.44, 0.024, "#efe6cf", "#26302a", 0.09),
    disc(0.43, 0.42, 0.018, "#efe6cf", "#26302a", 0.06),
    poly([[0, 0.7], [0.62, 0.46], [0.7, 0.6], [0.4, 0.82], [0, 0.92]], "#1c2622", "#eaa64a"),
    poly([[0.72, 0], [1, 0], [1, 0.9], [0.72, 0.7]], "#1c2622", "#3a4030"),
    disc(0.15, 0.78, 0.014, "#eaa64a", "#7a2a26", 0.035),
  ]),
];
