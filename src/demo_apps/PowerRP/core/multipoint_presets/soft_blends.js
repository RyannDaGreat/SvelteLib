/**
 * "Basics · soft blends": restrained, text-friendly background
 * blends. Each preset is a distinct point/curve LAYOUT, not a palette swap.
 * Numeric rows are authored composition data in the unit paint box (y down).
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, waveNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

// Same span budget as spiralNodes/waveNodes: eight cubic spans per full turn.
const MAX_ANGLE_STEP = Math.PI / 4;
// Unit-box corners clockwise from top-left; as a closed polyline it is the box frame.
const BOX = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * Pure function. Elliptical arc with exact tangents, ≤ π/4 per cubic span.
 * x(θ) = cx + rx·cos θ, y(θ) = cy + ry·sin θ, θ from startAngle to endAngle.
 * Screen y points down, so increasing θ runs CLOCKWISE on screen.
 * @param {object} options - {cx,cy,rx,ry=rx,startAngle,endAngle}; radii positive, angles distinct.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 3 nodes for a quarter turn.
 * @example arcNodes({cx:0,cy:0,rx:1,startAngle:0,endAngle:Math.PI/2}).map((n)=>n.slice(0,2)) // [[1,0],[0.707,0.707],[0,1]]
 */
export function arcNodes({ cx, cy, rx, ry = rx, startAngle, endAngle }) {
  const sweep = endAngle - startAngle;
  finiteGeometry([cx, cy, rx, ry, startAngle, sweep]);
  if (rx <= 0 || ry <= 0 || sweep === 0) throw new Error("Arc radii must be positive and its sweep nonzero");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const angle = startAngle + sweep * i / segments, c = Math.cos(angle), s = Math.sin(angle);
    return [cx + rx * c, cy + ry * s, -rx * sweep * s, ry * sweep * c];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Quarter circle around a unit-box corner, lying inside the box.
 * Runs from the corner's horizontal edge to its vertical edge.
 * @param {0|1} x - Corner x (0 left, 1 right).
 * @param {0|1} y - Corner y (0 top, 1 bottom).
 * @param {number} radius - Positive radius.
 * @returns {number[][]} [3,6] anchor/relative-handle tuples.
 * @example cornerArcNodes(1, 0, 0.3).map((n) => n.slice(0, 2)) // [[0.7,0],[0.788,0.212],[1,0.3]]
 */
export function cornerArcNodes(x, y, radius) {
  if (![0, 1].includes(x) || ![0, 1].includes(y)) throw new Error("Corner coordinates must be 0 or 1");
  const startAngle = x ? Math.PI : 0;
  return arcNodes({ cx: x, cy: y, rx: radius, startAngle, endAngle: startAngle + (x === y ? 1 : -1) * Math.PI / 2 });
}

/**
 * Pure function. A small closed single-colour ring: a soft blob with a flat core.
 * Unlike a point source (a 0.04 disk with a steep logarithmic rim that reads as a
 * dimple), the ring's larger radius gives a gentle shoulder.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Positive ring radius, typically 0.05–0.12.
 * @param {string} color - Core colour.
 * @returns {object} Closed feature with [4,6] nodes and one stop.
 * @example softSpot(0.4, 0.4, 0.08, "#ffeedd").closed // true
 */
export function softSpot(cx, cy, radius, color) {
  return boundary(ellipseNodes(cx, cy, radius), [color], null, true);
}

/**
 * Pure function. Straight segment cutting off a unit-box corner at equal reach.
 * Runs from the corner's horizontal edge to its vertical edge, like cornerArcNodes.
 * @param {0|1} x - Corner x (0 left, 1 right).
 * @param {0|1} y - Corner y (0 top, 1 bottom).
 * @param {number} reach - Distance from the corner along each edge, in (0,1].
 * @returns {number[][]} [2,6] anchor/relative-handle tuples.
 * @example cornerCapNodes(1, 1, 0.3).map((n) => n.slice(0, 2)) // [[0.7,1],[1,0.7]]
 */
export function cornerCapNodes(x, y, reach) {
  if (![0, 1].includes(x) || ![0, 1].includes(y)) throw new Error("Corner coordinates must be 0 or 1");
  finiteGeometry([reach]);
  if (reach <= 0 || reach > 1) throw new Error("Corner cap reach must be in (0,1]");
  return polylineNodes([[x ? 1 - reach : reach, y], [x, y ? 1 - reach : reach]]);
}

/**
 * Pure function. Four edge ramps sharing their corner colours: a Coons-style mesh.
 * Edges sit on the box boundary, so the interior blend has no crease.
 * @param {string[]} colors - [topLeft, topRight, bottomRight, bottomLeft].
 * @returns {object[]} Four open two-stop features, clockwise from the top edge.
 * @example cornerMesh(["#ff0000","#00ff00","#0000ff","#ffffff"])[1].stops.map((s) => s.color) // ["#00ff00","#0000ff"]
 */
export function cornerMesh(colors) {
  if (colors.length !== BOX.length) throw new Error("cornerMesh needs one colour per corner");
  return BOX.map((corner, i) => boundary(polylineNodes([corner, BOX[(i + 1) % BOX.length]]), [colors[i], colors[(i + 1) % BOX.length]]));
}

/** Pure function. A two-node straight segment. @example line(0,0,1,0).length // 2 */
const line = (x0, y0, x1, y1) => polylineNodes([[x0, y0], [x1, y1]]);

export const PRESETS = [
  // Two short corner caps: the cleanest possible two-colour diagonal.
  preset("peach-lilac", "Peach & lilac", "A calm diagonal from warm peach to soft lilac, set by two corner caps.", [
    boundary(cornerCapNodes(0, 0, 0.42), ["#fbd3b9"]),
    boundary(cornerCapNodes(1, 1, 0.42), ["#c9bdf0"]),
  ]),
  // Four edge ramps meeting at shared corner colours: a four-corner mesh.
  preset("pastel-quartet", "Pastel quartet", "Rose, apricot, sky and lavender corners meshed by four edge ramps.",
    cornerMesh(["#f8c4d0", "#fde0b4", "#b5dbf3", "#cbc3f3"])),
  // One closed ramp around the whole rim: three colours chase the perimeter.
  preset("tri-tone", "Tri-tone", "Butter, blush and sky chasing each other around the frame.", [
    boundary(polylineNodes(BOX), ["#ffe7a8", "#f5bdd3", "#a9d6ef", "#ffe7a8"], null, true),
  ]),
  // Three corner quarter-arcs; the free fourth corner is their blend.
  preset("sorbet-trio", "Sorbet trio", "Apricot, raspberry and mint scoops pooled in three corners.", [
    boundary(cornerArcNodes(0, 0, 0.32), ["#ffd7b8"]),
    boundary(cornerArcNodes(1, 0, 0.26), ["#f6b6c8"]),
    boundary(cornerArcNodes(0, 1, 0.3), ["#c3ecd9"]),
  ]),
  // Soft light core inside the whole-box frame: a crease-free vignette.
  preset("dusty-rose", "Dusty rose", "A pale rose light spilling from upper left into a muted mauve vignette.", [
    softSpot(0.4, 0.36, 0.06, "#efd7d5"),
    boundary(polylineNodes(BOX), ["#b98c99"], null, true),
  ]),
  // Left/right edges with a cream S-ridge between them.
  preset("sage-sand", "Sage & sand", "Sand and sage fields parted by a meandering ridge of cream.", [
    boundary(line(0, 0, 0, 1), ["#e8d6b6"]),
    boundary([[0.32, 0, 0, 0, 0.1, 0.4], [0.66, 1, -0.1, -0.4, 0, 0]], ["#efe7d0"]),
    boundary(line(1, 0, 1, 1), ["#b3c4a4"]),
  ]),
  // Sky edge, a glowing horizon wave, and a mauve foreground edge.
  preset("pastel-dawn", "Pastel dawn", "Periwinkle sky warming to a gold-and-rose horizon above mauve water.", [
    boundary(line(0, 0, 1, 0), ["#b3c1ea"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.64, amplitude: 0.025, cycles: 0.5 }), ["#f6c6c6", "#fde6bb", "#f6c6c6"]),
    boundary(line(0, 1, 1, 1), ["#cfbcd8"]),
  ]),
  // Top/bottom edges as backdrop, three soft spots as pools.
  preset("lavender-haze", "Lavender haze", "Blush, powder-blue and lilac pools drifting on a lavender wash.", [
    boundary(line(0, 0, 1, 0), ["#e6ddf6"]),
    boundary(line(0, 1, 1, 1), ["#c8c4ee"]),
    softSpot(0.26, 0.32, 0.08, "#f2d3e6"), softSpot(0.74, 0.44, 0.08, "#d3dcf8"), softSpot(0.44, 0.74, 0.08, "#ead9f7"),
  ]),
  // A single two-stop line corner to corner: the most minimal blend.
  preset("cool-greys", "Cool greys", "One quiet blue-grey fade, pale at the top right, for dense slides.", [
    boundary(line(0, 1, 1, 0), ["#c6ceda", "#f4f6f9"]),
  ]),
  // A semicircular arc rising from the bottom edge under a deep top edge.
  preset("apricot-rise", "Apricot rise", "A low apricot dome rising into a dusky blue upper sky.", [
    boundary(arcNodes({ cx: 0.5, cy: 1, rx: 0.36, startAngle: Math.PI, endAngle: 2 * Math.PI }), ["#ffc9a3", "#ffe3c2", "#ffc9a3"]),
    boundary(line(0, 0, 1, 0), ["#7f8fbf"]),
  ]),
  // A lit edge against one dark corner cap: side lighting on slate.
  preset("slate-sidelight", "Slate sidelight", "Cool light raking in from the left edge across dark slate.", [
    boundary(line(0, 0, 0, 1), ["#7a8aa0", "#5d6c82"]),
    boundary(line(0.45, 1, 1, 0.3), ["#1f2632"]),
  ]),
  // An off-centre soft spot, a far corner cap and one low-contrast point.
  preset("linen-halo", "Linen halo", "A warm cream halo resting on linen, settling into taupe at the corner.", [
    softSpot(0.36, 0.4, 0.09, "#fbf4e8"),
    boundary(cornerCapNodes(1, 1, 0.5), ["#c7b39c"]),
    point(0.86, 0.14, "#ebdfcf"),
  ]),
  // A free ramped bar of light between two dark corner caps.
  preset("teal-lumen", "Teal lumen", "A soft bar of teal light hanging across a deep ocean field.", [
    boundary(line(0.1, 0.55, 0.9, 0.45), ["#2d7f86", "#56bdb2", "#2d7f86"]),
    boundary(cornerCapNodes(0, 0, 0.3), ["#0f2f47"]),
    boundary(cornerCapNodes(1, 1, 0.3), ["#0b273a"]),
  ]),
  // Two concentric quarter arcs at one corner: a jewel bloom.
  preset("amethyst-bloom", "Amethyst bloom", "A violet bloom opening from the lower right into deep plum.", [
    boundary(cornerArcNodes(1, 1, 0.28), ["#b07cd6"]),
    boundary(cornerArcNodes(1, 1, 0.62), ["#5a2f7c"]),
    boundary(cornerCapNodes(0, 0, 0.3), ["#221330"]),
  ]),
  // Four dark corner caps around a small glow: a cushion.
  preset("garnet-cushion", "Garnet cushion", "A rose-lit centre sinking into four deep garnet corners.", [
    point(0.5, 0.48, "#d77a8c"),
    boundary(ellipseNodes(0.5, 0.48, 0.14), ["#9c3a55"], null, true),
    ...BOX.map(([x, y]) => boundary(cornerCapNodes(x, y, 0.3), ["#3a0f20"])),
  ]),
  // Two gentle horizontal waves: soft neutral folds.
  preset("oat-folds", "Oat folds", "Two slow oat and latte folds for a warm neutral backdrop.", [
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.3, amplitude: 0.08, cycles: 0.75 }), ["#f4eadb"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.72, amplitude: 0.08, cycles: 0.75, phase: Math.PI }), ["#d8c5aa"]),
  ]),
  // A corner arc of light against an L hugging the two far edges.
  preset("emerald-glade", "Emerald glade", "Emerald light pooling in the upper left of a deep sapphire glade.", [
    boundary(cornerArcNodes(0, 0, 0.36), ["#3eae86"]),
    boundary(polylineNodes([[1, 0.12], [1, 1], [0.12, 1]]), ["#123d56", "#0a1c2c", "#0f3345"]),
  ]),
  // Bottom edge ramp plus a large top-right arc: ocean shallows.
  preset("ocean-mint", "Ocean to mint", "Deep ocean along the bottom shoaling up into a pale mint corner.", [
    boundary(line(0, 1, 1, 1), ["#23628c", "#2f86a0"]),
    boundary(cornerArcNodes(1, 0, 0.5), ["#cdf2df"]),
  ]),
  // A partial top edge: light from a window over a pale floor.
  preset("window-light", "Window light", "Soft daylight falling from a high window onto pale stone.", [
    boundary(line(0.12, 0, 0.58, 0), ["#fffbf2"]),
    boundary(line(0, 1, 1, 1), ["#dcd7cf"]),
    boundary(line(1, 0, 1, 0.35), ["#e8e4dc"]),
  ]),
];

