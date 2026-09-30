/**
 * "Art homages": Multipoint presets that evoke painters and
 * movements through palette and composition (not copies of any artwork).
 * Coordinates are the unit paint box (y down); see core/multipoint_presets.js.
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, spiralNodes, waveNodes, finiteGeometry, polylineNodes, rectNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

/**
 * Pure function. Four-node superellipse ("squircle"): ellipseNodes with longer handles.
 * Handle length = squareness·radius. squareness ≈ 0.5523 is ellipseNodes' circle;
 * 1 puts both controls on the bounding-box corner (a softly rounded rectangle).
 * Starts at the rightmost point; clockwise on screen, so rightColor is INSIDE.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} rx - Positive half-width.
 * @param {number} ry - Positive half-height.
 * @param {number} squareness - Handle/radius ratio in (0, 1].
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example squircleNodes(0.5, 0.5, 0.4, 0.2, 1)[0] // [0.9,0.5,0,-0.2,0,0.2]
 */
export function squircleNodes(cx, cy, rx, ry, squareness) {
  finiteGeometry([cx, cy, rx, ry, squareness]);
  if (rx <= 0 || ry <= 0 || squareness <= 0 || squareness > 1) throw new Error("squircleNodes needs positive radii and squareness in (0,1]");
  const kx = rx * squareness, ky = ry * squareness;
  return [
    [cx + rx, cy, 0, -ky, 0, ky],
    [cx, cy + ry, kx, 0, -kx, 0],
    [cx - rx, cy, 0, ky, 0, -ky],
    [cx, cy - ry, -kx, 0, kx, 0],
  ];
}

/**
 * Pure function. Regular polygon with sharp corners, clockwise on screen.
 * Vertex i sits at angle rotation + 2π·i/sides (screen angles: 0 = right, π/2 = down).
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Positive circumradius.
 * @param {number} sides - Integer ≥ 3.
 * @param {number} rotation - First vertex angle; default −π/2 puts it on top.
 * @returns {number[][]} [sides,6] zero-handle tuples.
 * @example polygonNodes(0.5, 0.5, 0.4, 4)[0].map((v) => +v.toFixed(3)) // [0.5,0.1,0,0,0,0]
 */
export function polygonNodes(cx, cy, radius, sides, rotation = -Math.PI / 2) {
  finiteGeometry([cx, cy, radius, sides, rotation]);
  if (radius <= 0 || !Number.isInteger(sides) || sides < 3) throw new Error("polygonNodes needs a positive radius and integer sides ≥ 3");
  return polylineNodes(Array.from({ length: sides }, (_, i) => {
    const angle = rotation + FULL_TURN * i / sides;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  }));
}

/**
 * Pure function. Star polygon alternating outer/inner radii, clockwise on screen.
 * @param {object} options - {cx,cy,outer,inner,points,rotation=−π/2}; points integer ≥ 2.
 * @returns {number[][]} [2·points,6] zero-handle tuples; first vertex is an outer tip.
 * @example starNodes({cx:0.5,cy:0.5,outer:0.4,inner:0.2,points:5}).length // 10
 */
export function starNodes({ cx, cy, outer, inner, points, rotation = -Math.PI / 2 }) {
  finiteGeometry([cx, cy, outer, inner, points, rotation]);
  if (outer <= 0 || inner <= 0 || !Number.isInteger(points) || points < 2) throw new Error("starNodes needs positive radii and integer points ≥ 2");
  return polylineNodes(Array.from({ length: 2 * points }, (_, i) => {
    const angle = rotation + Math.PI * i / points, r = i % 2 ? inner : outer;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  }));
}

/**
 * Pure function. Closed radial blob r(θ) = f(θ)·(rx cosθ, ry sinθ) with exact tangents.
 * f(θ) = 1 + Σ amp·cos(k·θ + phase) over harmonics [k, amp, phase]; θ runs clockwise
 * on screen from the rightmost direction, so rightColor is INSIDE. One harmonic with
 * integer k gives a k-lobed flower; several small ones give an organic pebble.
 * @param {object} options - {cx,cy,rx,ry=rx,harmonics=[],count}; count ≥ 3 nodes.
 * @returns {number[][]} [count,6] anchor/relative-handle tuples; close the feature.
 * @example blobNodes({cx:0.5,cy:0.5,rx:0.2,count:4})[0].slice(0,2) // [0.7,0.5]
 * @example blobNodes({cx:0.5,cy:0.5,rx:0.2,harmonics:[[4,0.5,0]],count:8})[0].slice(0,2) // [0.8,0.5] (lobe tip)
 */
export function blobNodes({ cx, cy, rx, ry = rx, harmonics = [], count }) {
  finiteGeometry([cx, cy, rx, ry, count, ...harmonics.flat()]);
  if (rx <= 0 || ry <= 0 || !Number.isInteger(count) || count < 3) throw new Error("blobNodes needs positive radii and integer count ≥ 3");
  const samples = Array.from({ length: count }, (_, i) => {
    const theta = FULL_TURN * i / count, c = Math.cos(theta), s = Math.sin(theta);
    const f = 1 + harmonics.reduce((sum, [k, amp, phase]) => sum + amp * Math.cos(k * theta + phase), 0);
    const df = -harmonics.reduce((sum, [k, amp, phase]) => sum + amp * k * Math.sin(k * theta + phase), 0);
    if (f <= 0) throw new Error("blobNodes harmonics must keep the radius positive");
    return [cx + rx * f * c, cy + ry * f * s, FULL_TURN * rx * (df * c - f * s), FULL_TURN * ry * (df * s + f * c)];
  });
  return hermiteNodes(samples, 1 / count);
}

/**
 * Pure function. Two-node pointed leaf (vesica) from tip to tip, clockwise on screen.
 * The first span bulges to the LEFT of tip→tip travel, so rightColor is INSIDE.
 * A cubic whose inner controls sit β off the chord bulges 0.75·β, so β = (2/3)·width.
 * @param {number} x0 - First tip x.
 * @param {number} y0 - First tip y.
 * @param {number} x1 - Second tip x.
 * @param {number} y1 - Second tip y.
 * @param {number} width - Positive maximum leaf width.
 * @returns {number[][]} [2,6] anchor/relative-handle tuples; close the feature.
 * @example leafNodes(0.5, 0, 0.5, 1, 0.3)[0].map((v) => +v.toFixed(2)) // [0.5,0,-0.2,0.2,0.2,0.2]
 */
export function leafNodes(x0, y0, x1, y1, width) {
  finiteGeometry([x0, y0, x1, y1, width]);
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  if (!length || width <= 0) throw new Error("leafNodes needs distinct tips and a positive width");
  const bulge = 2 * width / 3, lx = dy / length * bulge, ly = -dx / length * bulge, tx = dx / 5, ty = dy / 5;
  return [[x0, y0, tx - lx, ty - ly, tx + lx, ty + ly], [x1, y1, -tx + lx, -ty + ly, -tx - lx, -ty - ly]];
}

/**
 * Pure function. The point at a screen angle on a circle (0 = right, π/2 = down).
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Distance from the center.
 * @param {number} angle - Screen angle in radians.
 * @returns {number[]} [2] (x,y).
 * @example polar(0.5, 0.5, 0.25, Math.PI / 2).map((v) => +v.toFixed(3)) // [0.5,0.75]
 */
export function polar(cx, cy, radius, angle) {
  finiteGeometry([cx, cy, radius, angle]);
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

// Numeric rows below are authored composition data (unit-box positions/radii/colours).
// All geometry stays inside the unit box: any overhang enlarges the square solve domain
// and lowers the texels spent on the visible paint.
const ROTHKO_GROUND = "#5e1a1c";
const MATISSE_GROUND = "#f4ecdc";
const KLIMT_GOLD = "#d9a93a";
const MONDRIAN_LINE = "#17171a";
const MONDRIAN_GAP = 0.03;
const GLASS_LEAD = "#16121c";
// [light inner tip, deep outer tip] per pane; ruby, cobalt, emerald repeat around the rose.
const GLASS_JEWELS = [["#ff7f8c", "#b0102f"], ["#8aa2ff", "#1c34b8"], ["#79e3b0", "#0f7a4a"]];
export const PRESETS = [
  // Rothko: luminous soft-edged blocks floating on an oxblood ground; ground lines keep the gaps dark.
  preset("rothko-field", "Color field", "Soft-edged orange and red blocks glowing on an oxblood ground.", [
    boundary(rectNodes(0.015, 0.015, 0.985, 0.985), ["#4a1418"], null, true),
    boundary(squircleNodes(0.5, 0.29, 0.39, 0.21, 0.95), ["#d9481f"], null, true), point(0.5, 0.25, "#ec6a2c"),
    boundary(squircleNodes(0.5, 0.585, 0.39, 0.03, 0.95), ["#8c2a22"], null, true),
    boundary(squircleNodes(0.5, 0.8, 0.39, 0.13, 0.95), ["#a8232a"], null, true), point(0.5, 0.8, "#b92c2c"),
    boundary(polylineNodes([[0.015, 0.528], [0.985, 0.528]]), [ROTHKO_GROUND]),
    boundary(polylineNodes([[0.015, 0.643], [0.985, 0.643]]), [ROTHKO_GROUND]),
  ]),
  // Albers: nested squares sinking toward the bottom edge, each band faintly lighter inward.
  preset("homage-square", "Homage square", "Nested squares from burnt orange to lemon, set low for weight.",
    [["#c4622d", "#e0892f"], ["#e5943a", "#efb23f"], ["#f2bd4c", "#f7d66a"]].map(([outside, inside], i) => {
      const k = i + 1;
      return boundary(rectNodes(0.1 * k, 0.15 * k, 1 - 0.1 * k, 1 - 0.05 * k), [outside], [inside], true);
    })),
  // Monet: soft lilac/green reflections under crisp pads, each with an off-centre blossom.
  preset("water-lilies", "Water lilies", "Lilac and green reflections under lily pads with pink blossoms.", [
    ...[[0.14, ["#8fa9dc", "#c4b1e4", "#9cc9d4"]], [0.5, ["#3d5f8f", "#5f8f7a", "#4a4f8f"]], [0.9, ["#8aa6d6", "#c6b3e3", "#6f9ac2"]]]
      .map(([y, colors]) => boundary(waveNodes({ x0: 0, x1: 1, y, amplitude: 0.03, cycles: 0.5 }), colors)),
    ...[[0.28, 0.32, 0.13, 0.05, "#4f8a4a", "#f6a9bf"], [0.7, 0.68, 0.15, 0.055, "#5f9244", "#fbd3df"], [0.24, 0.74, 0.1, 0.04, "#6aa052", "#f28fad"]]
      .flatMap(([cx, cy, rx, ry, pad, blossom]) => [boundary(ellipseNodes(cx, cy, rx, ry), ["#7f9fc9"], [pad], true), point(cx + rx * 0.35, cy, blossom)]),
  ]),
  // Van Gogh: a turning sky, ringed stars, an orange moon and a dark cypress flame.
  preset("starry-swirl", "Starry swirl", "An ultramarine sky with a pale swirl, ringed stars and a cypress.", [
    boundary(spiralNodes({ cx: 0.6, cy: 0.37, startRadius: 0.03, endRadius: 0.28, turns: 1.25 }),
      ["#f4f7e0", "#8fbde9", "#3a66bd"], ["#bcd8f2", "#3f6fca", "#1b347f"]),
    ...[[0.14, 0.14, 0.055, "#fff6c2", "#d8dc8e"], [0.9, 0.11, 0.075, "#fff3b8", "#f0a83a"], [0.87, 0.7, 0.05, "#fffadf", "#cfe0a0"]]
      .flatMap(([cx, cy, r, core, halo]) => [point(cx, cy, core), boundary(ellipseNodes(cx, cy, r), ["#223f8c"], [halo], true)]),
    boundary([[0.05, 1, 0, 0, 0, -0.18], [0.12, 0.62, 0, 0.1, 0.02, -0.12], [0.2, 0.2, -0.02, 0.1, 0.02, 0.1],
      [0.28, 0.62, -0.02, -0.12, 0, 0.1], [0.34, 1, 0, -0.18, 0, 0]], ["#1c3478"], ["#0f1d16"], true),
    boundary(polylineNodes([[0.34, 0.985], [1, 0.985]]), ["#142554"]), point(0.04, 0.42, "#1d3a86"),
  ]),
  // Hokusai: one open two-sided stroke traces the wave's back, claw and inner face; sky left, water right.
  preset("great-wave", "Great wave", "A Prussian-blue wave with a foam claw over paper sky and a far peak.", [
    boundary([[0, 1, 0, 0, 0.02, -0.14], [0.1, 0.5, -0.03, 0.12, 0.04, -0.14], [0.38, 0.12, -0.15, 0.03, 0.13, -0.02],
      [0.66, 0.2, -0.07, -0.06, 0.05, 0.05], [0.66, 0.38, 0.04, -0.06, -0.04, 0.03], [0.54, 0.31, 0.05, 0.02, -0.04, 0.06],
      [0.44, 0.62, 0.02, -0.12, -0.01, 0.12], [0.5, 1, -0.04, -0.12, 0, 0]],
      ["#e6d6b2", "#efe3c8", "#f8f5ec", "#d6d2c2"], ["#10285a", "#2f5f9a", "#e8f1f4", "#1c3c72"]),
    boundary(polylineNodes([[0.78, 0.63], [0.9, 0.8], [0.66, 0.8]]), ["#dcd8ca", "#dcd8ca", "#dcd8ca", "#dcd8ca"],
      ["#fbf8f0", "#39598a", "#39598a", "#fbf8f0"], true),
    boundary(waveNodes({ x0: 0.47, x1: 1, y: 0.9, amplitude: 0.025, cycles: 1 }), ["#e2ddd0"], ["#2f5f9a"]),
    point(0.92, 0.06, "#d9c49a"),
  ]),
  // Klimt: burnished gold leaf, an embossed tree-of-life coil, a mosaic eye and tesserae.
  preset("klimt-gold", "Klimt gold", "Burnished gold leaf with an embossed coil, a mosaic eye and tesserae.", [
    ...[[0.06, 0.06, "#b8862b"], [0.94, 0.08, "#f0cf6a"], [0.94, 0.94, "#a8761f"]].map(([x, y, color]) => point(x, y, color)),
    boundary(spiralNodes({ cx: 0.36, cy: 0.38, startRadius: 0.02, endRadius: 0.26, turns: 1.5 }),
      ["#fff3b8", "#f2cc58", KLIMT_GOLD], ["#8a5a1c", "#b07a26", "#c8932e"]),
    boundary(ellipseNodes(0.7, 0.68, 0.13), [KLIMT_GOLD], ["#1c1712"], true),
    boundary(ellipseNodes(0.7, 0.68, 0.065), ["#1c1712"], ["#f2e8cf"], true),
    ...[[0.78, 0.2, 0.06, 0.13, "#1c1712"], [0.88, 0.3, 0.05, 0.05, "#f2e8cf"]].map(([cx, cy, w, h, color]) =>
      boundary(rectNodes(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), [KLIMT_GOLD], [color], true)),
    ...[[0.14, 0.8, 0.05, "#b8392a"], [0.27, 0.88, 0.035, "#2d7f86"]]
      .map(([cx, cy, r, inside]) => boundary(ellipseNodes(cx, cy, r), [KLIMT_GOLD], [inside], true)),
  ]),
  // Turner: one soft single-sided vortex, sun-white at the eye to rose and pearl grey at the rim.
  preset("turner-haze", "Turner haze", "A white-gold sun at the eye of a soft ochre, rose and pearl vortex.", [
    boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.1, endRadius: 0.48, turns: 1.5, phase: Math.PI / 2 }),
      ["#fff1c4", "#f0b070", "#c7707a", "#8c93b0"]),
    point(0.5, 0.5, "#fffdf2"),
  ]),
  // Matisse: flat cut-paper shapes — an algae form, two leaves, a star and a dot on cream.
  preset("paper-cutouts", "Paper cut-outs", "Crisp ultramarine, coral, green and lemon paper shapes on cream.", [
    boundary(blobNodes({ cx: 0.38, cy: 0.46, rx: 0.23, ry: 0.28, harmonics: [[6, 0.28, 0.4], [2, 0.12, 1.2]], count: 12 }),
      [MATISSE_GROUND], ["#1d3aa6"], true),
    boundary(leafNodes(0.72, 0.1, 0.88, 0.48, 0.14), [MATISSE_GROUND], ["#ee6b4d"], true),
    boundary(leafNodes(0.6, 0.93, 0.92, 0.7, 0.12), [MATISSE_GROUND], ["#2f8f5a"], true),
    boundary(starNodes({ cx: 0.16, cy: 0.86, outer: 0.09, inner: 0.04, points: 5 }), [MATISSE_GROUND], ["#f5c230"], true),
    boundary(ellipseNodes(0.86, 0.6, 0.045), [MATISSE_GROUND], ["#e0508a"], true),
  ]),
  // Hilma af Klint: a spectral pyramid rising to a golden disc on a night ground.
  preset("klint-altarpiece", "Altarpiece", "A spectral pyramid rising to a golden sun disc on a night-blue ground.", [
    boundary(polylineNodes([[0.5, 0.4], [0.92, 0.96], [0.08, 0.96]]),
      ["#1c2040", "#1c2040", "#1c2040", "#1c2040"], ["#fff0b3", "#5b3b8c", "#5b3b8c", "#fff0b3"], true),
    boundary(polylineNodes([[0.38, 0.58], [0.62, 0.58]]), ["#f2a93b"]),
    boundary(polylineNodes([[0.25, 0.76], [0.75, 0.76]]), ["#d8392b"]),
    boundary(ellipseNodes(0.5, 0.24, 0.14), ["#1c2040"], ["#e9b737"], true),
    point(0.5, 0.24, "#fbe7a1"),
  ]),
  // Stained glass: separate two-sided panes whose shared lead-dark outsides ARE the tracery.
  preset("rose-window", "Rose window", "Ruby, cobalt and emerald glass panes leaded into an amber-rimmed rose.", [
    boundary(ellipseNodes(0.5, 0.5, 0.47), [GLASS_LEAD, GLASS_LEAD, GLASS_LEAD], ["#f0a830", "#e0572e", "#f0a830"], true),
    ...GLASS_JEWELS.concat(GLASS_JEWELS).map(([light, deep], i) => boundary(
      leafNodes(...polar(0.5, 0.5, 0.11, i * Math.PI / 3), ...polar(0.5, 0.5, 0.43, i * Math.PI / 3), 0.22),
      [GLASS_LEAD, GLASS_LEAD, GLASS_LEAD], [light, deep, light], true)),
    boundary(ellipseNodes(0.5, 0.5, 0.075), [GLASS_LEAD], ["#ffe8a8"], true),
    point(0.5, 0.5, "#fff8e0"),
  ]),
  // Ukiyo-e: Prussian-blue bokashi sky over a vermilion sun and layered indigo hills.
  preset("floating-world", "Floating world", "A Prussian bokashi sky, vermilion sun and layered indigo hills.", [
    boundary(polylineNodes([[0, 0.02], [1, 0.02]]), ["#1b3a6b"]),
    boundary(ellipseNodes(0.66, 0.38, 0.09), ["#f1cfa0"], ["#d4402c"], true),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.6, amplitude: -0.07, cycles: 0.5 }), ["#f2d2a4"], ["#7285ad"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.74, amplitude: 0.05, cycles: 1 }), ["#5d6f9a"], ["#25335e"]),
    boundary(polylineNodes([[0, 0.98], [1, 0.98]]), ["#141c38"]),
  ]),
  // Kandinsky: crisp coloured circles; the big blue disc wears a violet corona and a black core.
  preset("several-circles", "Several circles", "Crisp yellow, red and turquoise circles around a haloed blue disc.", [
    ...[[0.42, 0.4, 0.22, "#5b3f9e", "#1d2a7a"], [0.42, 0.4, 0.1, "#1d2a7a", "#0d0d18"], [0.78, 0.2, 0.08, "#3a3040", "#f2c63a"],
      [0.8, 0.7, 0.12, "#3a2230", "#d9442f"], [0.2, 0.8, 0.07, "#1f2f3a", "#3fb6a8"], [0.56, 0.84, 0.045, "#2a2030", "#f08bb0"],
      [0.13, 0.18, 0.05, "#28263a", "#f4f1e6"], [0.63, 0.67, 0.035, "#2a2030", "#f08a2c"]]
      .map(([cx, cy, r, outside, inside]) => boundary(ellipseNodes(cx, cy, r), [outside], [inside], true)),
    point(0.95, 0.05, "#16151f"), point(0.05, 0.55, "#1c1a28"),
  ]),
  // Frankenthaler: stains with a crisp pigment line, a paler soaked core and a tinted halo into raw canvas.
  preset("soak-stain", "Soak stain", "Pink, blue and green stains on raw canvas, each ringed by a pale halo.", [
    ...[[0.34, 0.32, 0.26, 0.2, [[2, 0.1, 0.5], [3, 0.08, 1.3], [5, 0.04, 0.2]], "#e0708f", "#f4bccb", "#f2d9d6"],
      [0.7, 0.62, 0.2, 0.26, [[2, 0.12, 2], [3, 0.1, 0.4], [5, 0.035, 1]], "#4f86cf", "#a9c8ee", "#d8e2ec"],
      [0.26, 0.78, 0.18, 0.13, [[2, 0.14, 1], [3, 0.07, 2.5], [4, 0.04, 0]], "#6fae7c", "#c6e4c0", "#dfe8d4"]]
      .flatMap(([cx, cy, rx, ry, harmonics, rim, core, halo]) => [
        boundary(blobNodes({ cx, cy, rx, ry, harmonics, count: 8 }), [halo], [rim], true), point(cx, cy, core)]),
    point(0.92, 0.08, "#f1e8d6"), point(0.94, 0.95, "#f1e8d6"), point(0.04, 0.04, "#efe5d0"), point(0.62, 0.95, "#f1e8d6"),
  ]),
  // Mondrian: primary panels whose shared black gaps ARE the grid lines — no boundary ever crosses another.
  preset("primary-grid", "Primary grid", "A red, blue and yellow grid whose black lines are gaps between panels.",
    [[0, 0, 0.28, 0.3, "#f2efe6"], [0, 0.3, 0.28, 0.68, "#ece8dc"], [0.28, 0, 1, 0.68, "#d6302a"], [0, 0.68, 0.28, 1, "#1f3c8f"],
      [0.28, 0.68, 0.9, 1, "#f4f1ea"], [0.9, 0.68, 1, 0.84, "#efeadf"], [0.9, 0.84, 1, 1, "#f2cf3a"]]
      .map(([x0, y0, x1, y1, color]) => {
        const inset = (edge) => (edge === 0 || edge === 1 ? 0 : MONDRIAN_GAP / 2);
        return boundary(rectNodes(x0 + inset(x0), y0 + inset(y0), x1 - inset(x1), y1 - inset(y1)), [MONDRIAN_LINE], [color], true);
      })),
];

