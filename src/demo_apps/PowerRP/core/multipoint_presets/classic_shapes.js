/**
 * "Basics · classic shapes": Multipoint versions of the classic
 * linear/radial/conic/diamond gradient shapes, plus simple graphic splits, so a
 * user never has to leave the Multipoint editor for an everyday background.
 * Solver facts these presets rely on (measured with probe/presets.js):
 *  - Two straight lines on opposite box edges give an exact linear ramp (Laplace
 *    + no-flux sides). A single ramp line in the middle does NOT (its ends bend).
 *  - A two-sided open curve puts `color` on the side (dy, −dx) of travel and
 *    `rightColor` on (−dy, dx): a left→right line has color ABOVE, rightColor
 *    BELOW; a clockwise-on-screen closed curve has rightColor INSIDE.
 *  - A two-sided ray from a point to the box edge is a conic (angle) gradient.
 *  - Every pinned curve is a kink in the field (a Mach-band ridge/plateau edge),
 *    so smooth radial falloffs use several rings with a gradual value profile
 *    (dark-vignette), and single-sided ridges are avoided where no line is wanted.
 *  - A point is a log spike: fine as a light source, ugly as a mere dark accent
 *    (use a short corner segment instead). Open-curve endpoints leak colour around.
 *  - Keep all geometry inside [0,1]: anything outside grows the square solve
 *    domain and blurs the whole paint (the renderer warns once).
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, waveNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

// Cubic spans of at most an eighth turn, matching the shipped spiral/wave helpers.
const MAX_ANGLE_STEP = Math.PI / 4;

/**
 * Pure function. Cubic approximation of an elliptical arc, with exact tangents.
 * x = cx + rx·cos θ, y = cy + ry·sin θ, θ = start + (end − start)·t. Screen y
 * points down, so increasing θ runs clockwise on screen (0 = right, π/2 = down).
 * @param {object} options - {cx,cy,rx,ry=rx,start,end}; radians, positive radii, end ≠ start.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 3 nodes for a quarter turn.
 * @example arcNodes({cx:1,cy:0,rx:0.3,start:Math.PI/2,end:Math.PI})[0].slice(0,2) // [1,0.3]
 */
export function arcNodes({ cx, cy, rx, ry = rx, start, end }) {
  const sweep = end - start;
  finiteGeometry([cx, cy, rx, ry, start, end]);
  if (rx <= 0 || ry <= 0 || sweep === 0) throw new Error("Arc radii must be positive and sweep nonzero");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const angle = start + sweep * i / segments, c = Math.cos(angle), s = Math.sin(angle);
    return [cx + rx * c, cy + ry * s, -rx * sweep * s, ry * sweep * c];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Regular polygon with straight edges, clockwise on screen.
 * Vertex k sits at angle rotation + 2πk/sides; rotation −π/2 puts vertex 0 on top.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Positive circumradius.
 * @param {number} sides - Integer ≥ 3.
 * @param {number} rotation - Angle of vertex 0 in radians.
 * @returns {number[][]} [sides,6] anchor/zero-handle tuples; close the feature.
 * @example polygonNodes(0.5,0.5,0.4,4,-Math.PI/2).map((n) => n.slice(0,2)) // ≈[[0.5,0.1],[0.9,0.5],[0.5,0.9],[0.1,0.5]]
 */
export function polygonNodes(cx, cy, radius, sides, rotation = 0) {
  finiteGeometry([cx, cy, radius, rotation]);
  if (radius <= 0 || !Number.isInteger(sides) || sides < 3) throw new Error("Polygon needs a positive radius and ≥3 integer sides");
  return polylineNodes(Array.from({ length: sides }, (_, k) => {
    const angle = rotation + 2 * Math.PI * k / sides;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  }));
}

/**
 * Pure function. Rotates a closed node ring so arc-length offset 0 starts at `index`.
 * Geometry is unchanged; only where a closed colour ramp begins moves.
 * @param {number[][]} nodes - [N,6] closed-ring tuples.
 * @param {number} index - Integer in [0,N).
 * @returns {number[][]} [N,6] copy starting at nodes[index].
 * @example startAt(ellipseNodes(0.5,0.5,0.2), 3)[0].slice(0,2) // [0.5,0.3] (top)
 */
export function startAt(nodes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= nodes.length) throw new Error("startAt index out of range");
  return [...nodes.slice(index), ...nodes.slice(0, index)].map((n) => [...n]);
}

/** Pure function. Horizontal edge-to-edge line at height y. @example hLine(0)[1] // [1,0,0,0,0,0] */
const hLine = (y) => polylineNodes([[0, y], [1, y]]);
/** Pure function. Vertical edge-to-edge line at x. @example vLine(1)[0] // [1,0,0,0,0,0] */
const vLine = (x) => polylineNodes([[x, 0], [x, 1]]);
/** Pure function. The paint box's own border, clockwise. @example frameNodes().length // 4 */
const frameNodes = () => polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]);

export const PRESETS = [
  preset("clear-sky", "Clear sky", "Deep azure overhead easing into a pale, faintly warm horizon.", [
    boundary(hLine(0), ["#2a5ea8"]),
    boundary(hLine(0.62), ["#94c6ea"]),
    boundary(hLine(1), ["#f3ece0"]),
  ]),
  preset("side-fade", "Side fade", "A plain left-to-right duotone from coral into periwinkle.", [
    boundary(vLine(0), ["#f98b88"]),
    boundary(vLine(1), ["#8a9cf4"]),
  ]),
  preset("diagonal-sweep", "Diagonal sweep", "A clean corner-to-corner run from sea green into ocean blue.", [
    boundary(polylineNodes([[0, 0.35], [0.35, 0]]), ["#43cea2"]),
    boundary(polylineNodes([[0.65, 1], [1, 0.65]]), ["#185a9d"]),
  ]),
  preset("diagonal-split", "Diagonal split", "Navy and apricot halves meeting on one crisp corner-to-corner edge.", [
    boundary(polylineNodes([[0, 1], [1, 0]]), ["#2e4f93"], ["#ffb27a"]),
    boundary(polylineNodes([[0, 0.6], [0, 0], [0.6, 0]]), ["#141f42"]),
    boundary(polylineNodes([[1, 0.4], [1, 1], [0.4, 1]]), ["#ee6a55"]),
  ]),
  preset("conic-sweep", "Conic sweep", "An angle gradient turning once around the center: gold, coral, violet.", [
    boundary(polylineNodes([[0.5, 0.5], [0.5, 0]]), ["#6a3fd1"], ["#ffd36e"]),
    boundary(polylineNodes([[0.5, 0.5], [1, 0.79]]), ["#ff7a59"]),
    boundary(polylineNodes([[0.5, 0.5], [0, 0.79]]), ["#d9468f"]),
  ]),
  preset("center-glow", "Center glow", "One centered radial glow: white heart, teal body, deep sea-green rim.", [
    point(0.5, 0.5, "#f2fffb"),
    boundary(ellipseNodes(0.5, 0.5, 0.18), ["#45cdb8"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.5), ["#0a2830"], null, true),
  ]),
  preset("soft-spotlight", "Soft spotlight", "An off-center pool of lamplight on a warm charcoal wall.", [
    point(0.34, 0.3, "#fff3e0"),
    boundary(ellipseNodes(0.34, 0.3, 0.2, 0.16), ["#d7b394"], null, true),
    boundary(ellipseNodes(0.4, 0.4, 0.4, 0.36), ["#4a403b"], null, true),
    boundary(polylineNodes([[0.5, 1], [1, 0.5]]), ["#191615"]),
  ]),
  preset("dark-vignette", "Dark vignette", "A calm light-grey center darkening evenly toward every edge.", [
    boundary(ellipseNodes(0.5, 0.5, 0.14, 0.12), ["#c4bfb6"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.3, 0.27), ["#aca79f"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.43, 0.39), ["#6f6b66"], null, true),
    boundary(frameNodes(), ["#141518"], null, true),
  ]),
  preset("horizon-split", "Horizon split", "Dusk sky meeting a teal sea at one crisp horizon line.", [
    boundary(hLine(0), ["#5a73b3"]),
    boundary(hLine(0.6), ["#ffcfa3"], ["#2d6e8e"]),
    boundary(hLine(1), ["#0d2742"]),
  ]),
  preset("corner-flare", "Corner flare", "Light pouring in from the top-right corner across a dusky field.", [
    point(0.96, 0.04, "#ffffff"),
    boundary(arcNodes({ cx: 1, cy: 0, rx: 0.26, start: Math.PI / 2, end: Math.PI }), ["#ffd27a"]),
    boundary(arcNodes({ cx: 1, cy: 0, rx: 0.72, start: Math.PI / 2, end: Math.PI }), ["#d0587a"]),
    boundary(polylineNodes([[0, 0.78], [0.22, 1]]), ["#1b1435"]),
  ]),
  preset("soft-band", "Soft band", "A single luminous diagonal band fading into navy on both sides.", [
    boundary(polylineNodes([[0, 0.86], [1, 0.3]]), ["#8ef0e0", "#c3a8ff"]),
    boundary(polylineNodes([[0, 0.2], [0.35, 0]]), ["#0f1b36"]),
    boundary(polylineNodes([[0.62, 1], [1, 0.82]]), ["#0f1b36"]),
  ]),
  preset("stage-beam", "Stage beam", "A single spotlight cone falling onto a pool of light on a black stage.", [
    // Both edges run so their right side faces OUT: haze inside, near-black outside.
    boundary(polylineNodes([[0.47, 0], [0.22, 0.86]]), ["#7a7064", "#3a342d"], ["#1c1916", "#050505"]),
    boundary(polylineNodes([[0.78, 0.86], [0.53, 0]]), ["#3a342d", "#7a7064"], ["#050505", "#1c1916"]),
    boundary(polylineNodes([[0.5, 0.02], [0.5, 0.7]]), ["#fff6e0", "#b9ad99"]),
    point(0.5, 0.88, "#fff4dc"),
    boundary(ellipseNodes(0.5, 0.88, 0.26, 0.05), ["#9c907e"], null, true),
    boundary(polylineNodes([[0, 0], [0, 1], [1, 1], [1, 0]]), ["#000000"]),
  ]),
  preset("studio-paper", "Studio paper", "A grey seamless-paper backdrop, brightest where the floor light lands.", [
    boundary(hLine(0), ["#4a4b4d"]),
    boundary(hLine(1), ["#a3a3a1", "#d8d7d4", "#a3a3a1"]),
    boundary(vLine(0), ["#4a4b4d", "#8e8e8c"]),
    boundary(vLine(1), ["#4a4b4d", "#8e8e8c"]),
  ]),
  preset("four-corners", "Four corners", "Butter, coral, sky and orchid pinned to the four corners.", [
    boundary(hLine(0), ["#fbd786", "#f7797d"]),
    boundary(hLine(1), ["#6dd5ed", "#c471ed"]),
  ]),
  preset("black-white", "Black to white", "An exact black-to-white ramp whose mid-grey line can be dragged to bias it.", [
    boundary(vLine(0), ["#000000"]),
    boundary(vLine(0.5), ["#808080"]),
    boundary(vLine(1), ["#ffffff"]),
  ]),
  preset("blue-diamond", "Blue diamond", "A diamond gradient: ice-blue center stepping out to deep navy.", [
    point(0.5, 0.5, "#e6f4ff"),
    boundary(polygonNodes(0.5, 0.5, 0.22, 4, -Math.PI / 2), ["#6aaee8"], null, true),
    boundary(polygonNodes(0.5, 0.5, 0.5, 4, -Math.PI / 2), ["#0c2350"], null, true),
  ]),
  preset("green-hills", "Green hills", "Layered rolling hills, pale mint sky down to deep forest.", [
    boundary(hLine(0), ["#eef8e6"]),
    ...[[0.42, 0.06, 0.2], [0.62, 0.07, 2.4], [0.8, 0.05, 4.2]].map(([y, amplitude, phase], i) => boundary(
      waveNodes({ x0: 0, x1: 1, y, amplitude, cycles: 0.75, phase }),
      [["#cfeac2"], ["#86c07a"], ["#3f8a4a"]][i], [["#a6d596"], ["#5aa35c"], ["#1f5a33"]][i])),
    boundary(hLine(1), ["#123d24"]),
  ]),
  preset("crimson-disc", "Crimson disc", "A crisp red disc, lit from above, on a deep maroon field.", [
    boundary(startAt(ellipseNodes(0.5, 0.5, 0.3), 3), ["#5c0f1e", "#7e1a2a", "#5c0f1e"], ["#ff6f5e", "#a8142c", "#ff6f5e"], true),
    boundary(frameNodes(), ["#2c0710"], null, true),
  ]),
  preset("amber-rise", "Amber rise", "A half-sun of amber light rising from the bottom edge into brown.", [
    point(0.5, 0.99, "#fff4c9"),
    boundary(arcNodes({ cx: 0.5, cy: 1, rx: 0.22, start: Math.PI, end: 2 * Math.PI }), ["#ffbd3d"]),
    boundary(arcNodes({ cx: 0.5, cy: 1, rx: 0.5, ry: 0.7, start: Math.PI, end: 2 * Math.PI }), ["#b8600f"]),
    boundary(hLine(0), ["#3a1c06"]),
  ]),
  preset("violet-halo", "Violet halo", "A glowing lilac ring around a dark eclipsed center.", [
    boundary(ellipseNodes(0.5, 0.5, 0.07), ["#1a0b2e"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.28), ["#d8b8ff"], null, true),
    boundary(frameNodes(), ["#120724"], null, true),
  ]),
];

