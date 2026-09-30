/**
 * "Hard-edge & De Stijl" — native Multipoint presets. Mondrian, van Doesburg, Ellsworth Kelly and Albers: crisp flat fields and grids.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { rectNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { panel, boxFrame, gapPanel, divider, rotCell } from "./abstraction_helpers.js";

const LINE = "#151516";

const MONDRIAN_GAP = 0.03;

const KELLY_SPECTRUM = ["#f4dc1e", "#f0a91b", "#ea6f1c", "#d9302a", "#b8286e", "#7c3c93", "#3b479b", "#2b6ab0", "#2196a8", "#1f9a6c", "#5db44b", "#b8cf2f"];

/**
 * Pure function. Mondrian-style panel list to features (black gaps are the lines).
 * @param {Array} cells - [[x0,y0,x1,y1,color], ...] unit rectangles tiling the box.
 * @returns {object[]} Closed two-sided features.
 * @example mondrianPanels([[0,0,1,1,"#ffffff"]]).length // 1
 */
const mondrianPanels = (cells) => cells.map(([x0, y0, x1, y1, color]) => gapPanel([x0, y0, x1, y1], LINE, color, MONDRIAN_GAP));

/**
 * Pure function. The tilted-grid cells of the Counter-composition, each with its colour.
 * @returns {Array} [[[u0,v0,u1,v1], colour], ...] in grid units (origin at the box centre).
 * @example counterCells().length // 10
 */
function counterCells() {
  return [[[-0.8, -0.8, -0.28, -0.05], "#f1eee6"], [[-0.28, -0.8, 0.12, -0.05], "#151516"], [[0.12, -0.8, 0.46, -0.05], "#c7c6c1"], [[0.46, -0.8, 0.8, -0.05], "#eec32c"],
    [[-0.8, -0.05, -0.28, 0.3], "#8b8c8c"], [[-0.28, -0.05, 0.12, 0.3], "#f1eee6"], [[0.12, -0.05, 0.8, 0.3], "#151516"],
    [[-0.8, 0.3, -0.28, 0.8], "#d33a2f"], [[-0.28, 0.3, 0.38, 0.8], "#f1eee6"], [[0.38, 0.3, 0.8, 0.8], "#2c4d9c"]];
}

/**
 * Pure function. An Albers Homage to the Square preset: nested squares sunk toward the bottom edge,
 * each square's outside being the previous colour so every step is a hard edge.
 * @param {string} id - Preset id.
 * @param {string} label - Menu label.
 * @param {string} description - Description.
 * @param {string[]} colors - Outer to inner colours (>= 2).
 * @param {number[]} shape - [ratio, lower]: child/parent width and how far (0..0.5) the child sinks below centre.
 * @returns {object} Preset entry.
 * @example homage("a-b", "A", "d", ["#000000", "#ffffff"], [0.5, 0.25]).paint.type // "multipointGradient"
 */
function homage(id, label, description, colors, [ratio, lower]) {
  let rect = [0, 0, 1, 1];
  const inner = colors.slice(1).map((color, k) => {
    const [x0, , x1, y1] = rect, size = x1 - x0, w = size * ratio, gap = size - w;
    rect = [x0 + gap / 2, y1 - gap * lower - w, x0 + gap / 2 + w, y1 - gap * lower];
    return boundary(rectNodes(...rect), [colors[k]], [color], true);
  });
  return preset(id, label, description, [boxFrame([colors[0]]), ...inner]);
}

export const PRESETS = [
  // Mondrian, Composition with Large Blue Plane, Red, Black, Yellow and Gray (1921).
  preset("mondrian-large-blue-plane", "Large blue plane", "A heavy cobalt plane with red, yellow and grey accents held by black grid lines.",
    mondrianPanels([[0, 0, 0.6, 0.62, "#2a4a9c"], [0.6, 0, 1, 0.3, "#efece2"], [0.6, 0.3, 1, 0.62, "#cd3a2c"],
      [0, 0.62, 0.22, 1, "#f1eee5"], [0.22, 0.62, 0.75, 1, "#b9b9b3"], [0.75, 0.62, 1, 0.8, "#f0ede3"], [0.75, 0.8, 1, 1, "#efc22c"]])),
  // Mondrian, Composition with Yellow, Blue and Red (1937-42): a big luminous yellow plane.
  preset("mondrian-yellow-plane", "Yellow plane", "A big lemon-yellow plane with a red corner and a blue block on a white grid.",
    mondrianPanels([[0, 0, 0.3, 0.24, "#cb3a2d"], [0.3, 0, 1, 0.38, "#f1eee4"], [0, 0.24, 0.3, 0.7, "#eeebe1"],
      [0, 0.7, 0.3, 1, "#2b4c9a"], [0.3, 0.38, 1, 1, "#f0c72b"]])),
  // Mondrian, Composition with Grid: Checkerboard, Bright Colors (1919): a lattice of soft pastel cells.
  preset("mondrian-pastel-lattice", "Pastel lattice", "A three-by-three lattice of rose, powder blue, ochre and grey cells outlined in pale grey.",
    [[0, 0, "#d9727a"], [1, 0, "#eeebe0"], [2, 0, "#9fb6dc"], [0, 1, "#e9cf62"], [1, 1, "#c7cacc"], [2, 1, "#eeebe0"], [0, 2, "#5a82c8"], [1, 2, "#eeebe0"], [2, 2, "#d9727a"]]
      .map(([i, j, color]) => gapPanel([i / 3, j / 3, (i + 1) / 3, (j + 1) / 3].map((v) => (v > 0.999 ? 1 : +v.toFixed(6))), "#d3d5d6", color, 0.03))),
  // van Doesburg, Counter-Composition (1924-25): planes on a 45-degree grid, black and white with primaries.
  preset("doesburg-counter-composition", "Counter-composition", "A 45-degree grid of black, white and grey planes with tiny red, blue and yellow accents.",
    counterCells().flatMap(([cell, color]) => { const poly = rotCell(cell, Math.PI / 4, 0.02); return poly ? [panel(poly, "#e9e6dc", color)] : []; })),
  // Kelly, Spectrum Colors Arranged by Chance / Spectrum I (1951-53): twelve hard vertical colour bands.
  preset("kelly-spectrum", "Spectrum bands", "Twelve flat spectrum panels, yellow through violet to green, meeting at hard vertical edges.",
    KELLY_SPECTRUM.slice(1).map((east, i) => divider([[(i + 1) / KELLY_SPECTRUM.length, 1], [(i + 1) / KELLY_SPECTRUM.length, 0]], KELLY_SPECTRUM[i], east))),
  // Kelly, Blue Green Red (1963): three swelling curves stack white, blue, green and red fields.
  preset("kelly-curved-fields", "Curved fields", "White, cobalt, green and red fields separated by three gently arching curves.", [
    ["#f3f1e8", "#2b4da6", [[0, 0.3], [0.5, 0.18], [1, 0.36]]], ["#2b4da6", "#3a9b4a", [[0, 0.55], [0.5, 0.42], [1, 0.62]]],
    ["#3a9b4a", "#d63a26", [[0, 0.8], [0.5, 0.66], [1, 0.86]]],
  ].map(([above, below, pts]) => boundary(catmullRomNodes(pts), [above], [below], false))),
  // Albers, Homage to the Square: Yellow Climate.
  homage("albers-yellow-climate", "Yellow climate", "Nested squares climbing from olive shade through ochre to a pale lemon core.", ["#8b7c39", "#b89c3a", "#dcc248", "#f3e07a"], [0.68, 0.28]),
  // Albers, Homage to the Square: Glow.
  homage("albers-glow", "Homage glow", "Nested squares warming from oxblood through vermilion and amber to a pale gold heart.", ["#8f2b29", "#c9502a", "#e88f3a", "#f6c968"], [0.62, 0.2]),
  // Albers, Homage to the Square: Apparition (1959).
  homage("albers-apparition", "Homage apparition", "A pale luminous core floating inside squares of steel blue, slate and charcoal.", ["#4c4b52", "#2c3a6c", "#5f7cb0", "#dde4ee"], [0.74, 0.34]),
];
