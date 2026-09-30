/**
 * "Suprematism & Constructivism" — native Multipoint presets. Malevich, Lissitzky and Rodchenko: flat planes flying on white ground.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, mixHex } from "../multipoint_shapes.js";
import { rotRect, panel, boxFrame, annularSectorNodes } from "./abstraction_helpers.js";

/**
 * Pure function. Maps pixel corner lists from a cropped reference image into the unit box.
 * @param {number[][]} pts - [N,2] pixel (x,y).
 * @param {number[]} crop - [x0,y0,size] square crop in pixels.
 * @returns {number[][]} [N,2] unit coordinates.
 * @example toUnit([[10,60],[490,540]], [10,60,480]) // [[0,0],[1,1]]
 */
const toUnit = (pts, [x0, y0, size]) => pts.map(([x, y]) => [(x - x0) / size, (y - y0) / size]);

const PROUN_RINGS = 8;

const AIRPLANE_CROP = [10, 60, 480];

const AIRPLANE = [
  ["#d7981a", [[262, 75], [306, 118], [184, 264], [135, 222]]],
  ["#d7981a", [[268, 165], [293, 185], [250, 242], [228, 225]]],
  ["#d7981a", [[298, 182], [332, 202], [304, 248], [268, 228]]],
  ["#d7981a", [[155, 246], [183, 262], [140, 334], [98, 300]]],
  ["#252d30", [[226, 247], [338, 320], [220, 502], [106, 405]]],
  ["#252d30", [[325, 375], [372, 410], [286, 528], [238, 490]]],
  ["#252d30", [[360, 452], [412, 478], [384, 534], [330, 500]]],
  ["#cf3a30", [[118, 135], [196, 128], [196, 141], [118, 148]]],
  ["#cf3a30", [[318, 122], [369, 114], [370, 130], [318, 134]]],
  ["#27335c", [[72, 457], [176, 510], [168, 527], [68, 483]]],
];

export const PRESETS = [
  preset("malevich-red-square", "Red square", "A tilted vermilion square filling a pale grey ground, painterly-realism style.", [
    boxFrame(["#e3e5e1", "#d3d7d3"]),
    panel([[0.13, 0.11], [0.88, 0.09], [0.87, 0.89], [0.12, 0.9]], "#dfe2de", ["#e24216", "#d23a12", "#e24216"]),
  ]),
  preset("malevich-airplane-flying", "Airplane flying", "Ochre, black, red and blue planes swooping across cream, after the 1915 Suprematist Composition.", [
    ...AIRPLANE.map(([color, pts]) => panel(toUnit(pts, AIRPLANE_CROP), "#dbd9cd", color)),
  ]),
  // Lissitzky, Beat the Whites with the Red Wedge (1919): red wedge into a white disc on black.
  preset("lissitzky-red-wedge", "Red wedge", "A vermilion wedge driving at a white disc across a black diagonal on white.", [
    panel([[0.56, 0], [1, 0], [1, 1], [0.1, 1]], "#f1eee6", "#0d0d0f"),
    boundary(ellipseNodes(0.7, 0.58, 0.25), ["#0d0d0f"], ["#f1eee6"], true),
    panel([[0.03, 0.08], [0.42, 0.03], [0.31, 0.5]], "#f1eee6", ["#e8412a"]),
  ]),
  // Lissitzky, Proun 93 (c.1923): drifting concentric black rings on a cream disc set in marbled tan.
  preset("lissitzky-proun-rings", "Proun rings", "Black and cream rings drifting toward a bullseye on a cream disc, with a leaning black shard.", [
    boundary(ellipseNodes(0.5, 0.5, 0.47), ["#c8b184"], ["#d6cebd"], true),
    ...Array.from({ length: PROUN_RINGS }, (_, k) => {
      const t = k / (PROUN_RINGS - 1), r = 0.27 * (1 - k / PROUN_RINGS);
      return boundary(ellipseNodes(0.58 - 0.04 * t, 0.4 + 0.05 * t, r), [k % 2 ? "#15130f" : "#d6cebd"], [k % 2 ? "#d6cebd" : "#15130f"], true);
    }),
    panel([[0.2, 0.7], [0.3, 0.58], [0.32, 0.72], [0.22, 0.83]], "#d6cebd", "#15130f"),
  ]),
  // Lissitzky, Proun 5A (c.1919): a grey prism falling past crimson discs, red rods and dark slats.
  preset("lissitzky-proun-prism", "Proun prism", "A three-faced grey prism tumbling between crimson discs, red rods and dark slats on cream.", [
    boundary(ellipseNodes(0.2, 0.2, 0.14), ["#dbd7cb", "#dbd7cb", "#dbd7cb"], ["#8a1c2a", "#6c1520", "#8a1c2a"], true),
    boundary(annularSectorNodes(0, 1, 0, 0.5, -Math.PI / 2, 0), ["#dbd7cb"], ["#7d1a26"], true),
    panel([[0.5, 0.21], [0.6, 0.13], [0.79, 0.22], [0.68, 0.31]], "#dbd7cb", "#a1a3a8"),
    panel([[0.5, 0.23], [0.67, 0.33], [0.64, 0.6], [0.49, 0.48]], "#dbd7cb", "#6c7076"),
    panel([[0.69, 0.33], [0.8, 0.24], [0.77, 0.5], [0.66, 0.58]], "#dbd7cb", "#36373c"),
    panel(rotRect(0.66, 0.09, 0.014, 0.07, 0.42), "#dbd7cb", "#d8323a"),
    panel(rotRect(0.86, 0.72, 0.012, 0.15, -0.55), "#dbd7cb", "#d8323a"),
    panel(rotRect(0.44, 0.6, 0.014, 0.12, 0.14), "#dbd7cb", "#2a2a2e"),
    panel(rotRect(0.64, 0.8, 0.02, 0.11, 0.2), "#dbd7cb", "#7a8493"),
    panel(rotRect(0.2, 0.84, 0.02, 0.1, -0.1), "#7d1a26", "#7a8493"),
  ]),
  // Malevich, Eight Red Rectangles (1915): eight vermilion bars falling askew across white.
  preset("malevich-eight-rectangles", "Eight red bars", "Eight vermilion bars of unequal length tumbling on a diagonal across warm white.", [
    ...[[0.24, 0.3, 0.03, 0.11], [0.34, 0.14, 0.028, 0.07], [0.46, 0.4, 0.03, 0.13], [0.6, 0.22, 0.026, 0.06],
      [0.65, 0.57, 0.03, 0.14], [0.81, 0.74, 0.028, 0.08], [0.4, 0.75, 0.028, 0.1], [0.82, 0.4, 0.026, 0.07]]
      .map(([cx, cy, hw, hh]) => panel(rotRect(cx, cy, hw, hh, -0.45), "#efece2", "#d8291f")),
  ]),
  // Malevich, Supremus No. 58 (1916): black, ochre and cream bars thrown across a white field.
  preset("malevich-supremus-bars", "Supremus bars", "Long black, ochre and cream bars crossing a white field in a Supremus No. 58 spread.", [
    ...[[0.52, 0.62, 0.36, 0.028, 1.0, "#141312"], [0.28, 0.2, 0.26, 0.04, -0.5, "#e3a72a"], [0.18, 0.5, 0.14, 0.035, -0.5, "#141312"],
      [0.76, 0.28, 0.2, 0.03, -0.5, "#f3eecf"], [0.86, 0.6, 0.1, 0.022, 0, "#141312"], [0.26, 0.78, 0.2, 0.05, -0.25, "#ebe6c3"],
      [0.6, 0.12, 0.1, 0.03, -0.5, "#e3a72a"], [0.16, 0.92, 0.06, 0.02, -0.25, "#3b6ea8"], [0.9, 0.85, 0.05, 0.05, 0, "#141312"]]
      .map(([cx, cy, hw, hh, a, color]) => panel(rotRect(cx, cy, hw, hh, a), "#eef0e8", color)),
  ]),
  // Malevich, Black Trapezium and Red Square (1915): a heavy black quadrilateral with a red square below it.
  preset("malevich-trapezium-square", "Trapezium & red square", "A leaning black trapezium above a small vermilion square on ivory.", [
    panel([[0.16, 0.2], [0.72, 0.1], [0.84, 0.5], [0.1, 0.6]], "#e9e6da", ["#141416", "#232326", "#141416"]),
    panel(rotRect(0.66, 0.79, 0.1, 0.1, 0.18), "#e9e6da", "#d9301f"),
  ]),
  // Malevich, Yellow Quadrilateral on White (1917-18): one warm ochre plane floating on white.
  preset("malevich-yellow-quadrilateral", "Yellow quadrilateral", "A single ochre quadrilateral with a hand-painted warmth, floating on chalk white.", [
    boxFrame(["#eeece4", "#e3e2da"]),
    panel([[0.17, 0.32], [0.8, 0.15], [0.87, 0.7], [0.25, 0.86]], "#e9e8e0", ["#e6b431", "#d9a01d", "#e6b431"]),
  ]),
  // Rodchenko, Pure Red, Yellow, Blue Colour (1921): three monochrome panels, the "last painting".
  preset("rodchenko-pure-colours", "Pure colours", "Three tall monochrome panels, red, yellow and blue, hung on bare wall grey.", [
    ...[[0.17, "#cc2f26"], [0.5, "#efc12b"], [0.83, "#2d55a6"]].map(([x, color]) =>
      panel(rotRect(x, 0.5, 0.135, 0.44, 0), "#d8d3c7", [color, color, color].map((c, i) => (i === 1 ? mixHex(c, "#000000", 0.08) : c)))),
  ]),
];
