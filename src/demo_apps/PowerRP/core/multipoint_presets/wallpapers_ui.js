/**
 * "Wallpapers & UI" Multipoint presets.
 * Evokes desktop/phone OS wallpapers and modern web hero backgrounds — layered
 * colour waves, folded fabric ribbons, light fans, rim-lit orbs, mesh-gradient
 * blobs — without naming any product. Sources per preset: concerns.md, 2026-09-30 research-preset merge.
 * Coordinates are the unit paint box (y down). On a left→right open curve
 * `colors` is ABOVE and `rightColors` BELOW; on a clockwise closed curve
 * `colors` is OUTSIDE and `rightColors` INSIDE.
 */
import { preset, boundary, closedRamp } from "./builders.js";
import { hermiteNodes, finiteGeometry, polylineNodes, rectNodes, catmullRomNodes, spiralNodes, ellipseNodes }
  from "../multipoint_shapes.js";
import { orientedEllipseNodes, withStopOffsets } from "./nature.js";
import { offsetPoints, blobNodes } from "./fluid_materials.js";
import { affineNodes } from "./space.js";
import { ribbonNodes } from "./geometric.js";

const MAX_ANGLE_STEP = Math.PI / 4; // same eight-spans-per-turn budget as waveNodes
// Unit-box edges as [start, end], each walked so the box interior is on the walker's RIGHT.
const BOX_EDGES = { top: [[0, 0], [1, 0]], right: [[1, 0], [1, 1]], bottom: [[1, 1], [0, 1]], left: [[0, 1], [0, 0]] };

/**
 * Pure function. A sine wave riding a sloped baseline, as a parametric curve with exact
 * first and second derivatives (the form geometric.js ribbonNodes needs for thick strokes).
 * x(t) = x0 + (x1 − x0)·t; y(t) = y0 + (y1 − y0)·t + amplitude·sin(2π·cycles·t + phase).
 * @param {object} options - {x0,x1,y0,y1,amplitude,cycles=1,phase=0}.
 * @returns {function} t∈[0,1] → [x, y, dx/dt, dy/dt, d²x/dt², d²y/dt²].
 * @example slopedWave({x0:0,x1:1,y0:1,y1:0,amplitude:0})(0.5) // [0.5,0.5,1,-1,0,0]
 * @example slopedWave({x0:0,x1:1,y0:0.5,y1:0.5,amplitude:0.1,cycles:0.5})(0.5).slice(0, 2) // [0.5,0.6] (the crest)
 */
export function slopedWave({ x0, x1, y0, y1, amplitude, cycles = 1, phase = 0 }) {
  const sweep = 2 * Math.PI * cycles, width = x1 - x0, rise = y1 - y0;
  finiteGeometry([x0, x1, y0, y1, amplitude, sweep, phase]);
  return (t) => {
    const angle = sweep * t + phase, s = Math.sin(angle);
    return [x0 + width * t, y0 + rise * t + amplitude * s, width, rise + amplitude * sweep * Math.cos(angle), 0, -amplitude * sweep * sweep * s];
  };
}

/**
 * Pure function. slopedWave as editable cubic nodes, eight spans per full cycle (≥ 2 spans).
 * Traversed left→right when x1 > x0, so `colors` lies above the wave.
 * @param {object} options - {x0,x1,y0,y1,amplitude,cycles=1,phase=0}.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 9 nodes for one cycle.
 * @example slopedWaveNodes({x0:0,x1:1,y0:0.8,y1:0.2,amplitude:0,cycles:0.25}).map((n)=>n.slice(0,2)) // [[0,0.8],[0.5,0.5],[1,0.2]]
 * @example slopedWaveNodes({x0:0,x1:1,y0:0.5,y1:0.5,amplitude:0.1,cycles:0.5})[1].slice(0,2) // [0.25,0.5707] (t = 0.25, halfway up to the crest's sine)
 */
export function slopedWaveNodes(options) {
  const curve = slopedWave(options);
  const segments = Math.max(2, Math.ceil(Math.abs(2 * Math.PI * (options.cycles ?? 1)) / MAX_ANGLE_STEP));
  return hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => curve(i / segments).slice(0, 4)), 1 / segments);
}

/**
 * Pure function. A single-sided constant ramp lying exactly ON one unit-box edge,
 * walked with the interior on its right (so the box never grows past [0,1]).
 * @param {"top"|"right"|"bottom"|"left"} side - Box edge.
 * @param {string[]} colors - Ramp along the walk (top: left→right, bottom: right→left).
 * @returns {object} Open two-node feature.
 * @example boxEdge("bottom", ["#000000"]).nodes.map((n) => n.slice(0, 2)) // [[1,1],[0,1]]
 */
export function boxEdge(side, colors) {
  const ends = BOX_EDGES[side];
  if (!ends) throw new Error(`Unknown box edge: ${side}`);
  return boundary(polylineNodes(ends), colors);
}

/**
 * Pure function. Single-sided closed ramp around the whole unit-box border, clockwise
 * from the top-left corner: a crease-free backdrop the interior diffuses toward.
 * @param {string[]} colors - Open ramp (≤ 3 colours; the seam colour is appended).
 * @returns {object} Closed four-node feature.
 * @example boxFrame(["#101010"]).stops.length // 1
 */
export function boxFrame(colors) {
  return boundary(rectNodes(0, 0, 1, 1), colors.length > 1 ? closedRamp(colors) : colors, null, true);
}

/**
 * Pure function. Parallel copies of one smooth path, offset sideways: the stripes of a ribbon.
 * Positive offsets go to the walker's right (below a left→right path). Each copy's end
 * anchors keep the spine's end x, so a spine running wall to wall stays inside the box.
 * @param {number[][]} points - [N,2] Catmull–Rom anchors, N ≥ 2.
 * @param {number[]} offsets - Signed sideways distance of each copy.
 * @returns {number[][][]} [K][N,6] node lists, one per offset.
 * @example parallelPaths([[0,0.5],[1,0.5]], [0, 0.1])[1][0].slice(0, 2) // [0,0.6]
 * @example parallelPaths([[0,0],[1,1]], [0.1])[0][0][0] // 0 (not −0.0707: the end is pinned to the spine's wall)
 */
export function parallelPaths(points, offsets) {
  return offsets.map((d) => catmullRomNodes(offsetPoints(points, points.map(() => d))
    .map(([x, y], i) => [i === 0 ? points[0][0] : i === points.length - 1 ? points.at(-1)[0] : x, y])));
}

/**
 * Pure function. Half-ellipse arch standing on the line y = base, walked left → over the
 * top → right, so `colors` is OUTSIDE (above) and `rightColors` INSIDE. Its feet are exact
 * (no float overshoot past base, which would grow the solve domain).
 * @param {object} options - {cx,base,rx,ry}; radii positive.
 * @returns {number[][]} [5,6] anchor/relative-handle tuples.
 * @example archNodes({cx:0.5,base:1,rx:0.3,ry:0.4}).map((n) => n.slice(0, 2))[2] // [0.5,0.6]
 * @example archNodes({cx:0.5,base:1,rx:0.3,ry:0.4})[4].slice(0, 2) // [0.8,1]
 */
export function archNodes({ cx, base, rx, ry }) {
  finiteGeometry([cx, base, rx, ry]);
  if (!(rx > 0) || !(ry > 0)) throw new Error("Arch radii must be positive");
  const segments = 4, sweep = Math.PI;
  return hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => {
    const angle = Math.PI + sweep * i / segments;
    const c = [-1, -Math.SQRT1_2, 0, Math.SQRT1_2, 1][i], s = [0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0][i];
    return [cx + rx * c, base + ry * s, -rx * sweep * Math.sin(angle), ry * sweep * Math.cos(angle)];
  }), 1 / segments);
}

/**
 * Pure function. Archimedean spiral squashed into a rotated ellipse (affine image of
 * spiralNodes with unit end radius), for rosettes and swirls seen at an angle.
 * P(t) = c + Rot(angle)·(rx·ρ(t)·cos θ(t), ry·ρ(t)·sin θ(t)), ρ from startRadius to 1.
 * Positive turns wind clockwise on screen, so a two-sided walker's RIGHT is the centre side.
 * @param {object} options - {cx,cy,rx,ry,startRadius,turns,phase=0,angle=0}; startRadius in [0,1).
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 13 nodes for 1.5 turns.
 * @example ellipticSpiralNodes({cx:0.5,cy:0.5,rx:0.4,ry:0.2,startRadius:0.1,turns:1}).at(-1).slice(0, 2) // [0.9,0.5]
 */
export function ellipticSpiralNodes({ cx, cy, rx, ry, startRadius, turns, phase = 0, angle = 0 }) {
  finiteGeometry([cx, cy, rx, ry, angle]);
  if (!(rx > 0) || !(ry > 0) || !(startRadius >= 0 && startRadius < 1)) throw new Error("Elliptic spiral needs positive radii and startRadius in [0,1)");
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return affineNodes(spiralNodes({ cx: 0, cy: 0, startRadius, endRadius: 1, turns, phase }),
    [rx * cos, rx * sin, -ry * sin, ry * cos, cx, cy]);
}

/** Pure function. Catmull–Rom shorthand. @example smooth([[0,0],[1,1]]).length // 2 */
const smooth = (points) => catmullRomNodes(points);

// Phone-wallpaper stacked S-waves: [y0, y1, amplitude, phase, shadow above, lit below].
const DUSK_WAVES = [
  [0.2, 0.06, 0.06, 0.6, ["#3b0d2c", "#6a1830"], ["#e2442a", "#e6552c"]],
  [0.44, 0.3, 0.07, 0.9, ["#c8321e", "#d6402a"], ["#f2a04c", "#f0b060"]],
  [0.68, 0.54, 0.07, 1.2, ["#e0703e", "#e58a70"], ["#e45ac8", "#e678c0"]],
  [0.92, 0.78, 0.06, 1.5, ["#a64ed8", "#c050d0"], ["#4a8ff0", "#6fd8f0"]],
];
// The unlit side of every night ribbon: the black form itself.
const NIGHT_SHADE = ["#050308", "#050308", "#050308", "#050308"];
// Two-arm twirl: [light arm ramp, deep arm ramp], centre → rim. Alternating arms give adjacent
// turns contrasting VALUES, which is what makes a soft single-sided spiral read as a swirl.
// Each arm's last stop matches the other arm's field where it ends, so the open tips leave no streak.
const TWIRL_ARMS = [["#ff7a8a", "#ffc890", "#fff0d8", "#c06090"], ["#ff7a8a", "#c0307a", "#5a1070", "#f0c0a8"]];
const TWIRL_STOPS = [0, 0.4, 0.82, 1]; // the tip fade is confined to the outer fifth of each arm
// Silk ribbon centreline, wall to wall, and its half width. No box frame: the banks end ON the side
// walls, and a frame there would pin the ribbon's own ends to the page colour (a notch at each wall).
const SILK_SPINE = [[0, 0.34], [0.2, 0.5], [0.42, 0.62], [0.66, 0.48], [0.84, 0.56], [1, 0.72]];
const SILK_HALF_WIDTH = 0.036;
const SILK_GROUND = ["#eae4ee", "#eae4ee", "#eae4ee", "#eae4ee"];

// Nested wobbly fabric layers, outer → inner: [cx, cy, rx, ry, lobes, colour outside the layer's rim].
// Centres drift up-right so the folds crowd on one side, like a ruffle seen at an angle; the lobe
// phases advance per layer so the folds twist instead of stacking as contour lines.
const RUFFLE_LAYERS = [[0.48, 0.64, 0.42, 0.33, [[5, 0.06, 0]], "#a0c0da"], [0.54, 0.58, 0.3, 0.24, [[5, 0.07, 0.8]], "#0b2a80"],
  [0.6, 0.53, 0.19, 0.15, [[5, 0.08, 1.6]], "#0b2a80"], [0.64, 0.5, 0.09, 0.07, [[4, 0.08, 2.4]], "#0a216d"]];
const RUFFLE_SEAM = -2.2; // radians: each layer's lit ramp starts at its upper left, facing the light
const GLOW_SQUASH = 0.45; // aurora glows are wide low clouds, not discs

export const PRESETS = [
  preset("layered-dusk", "Layered dusk", "Stacked S-waves glide from plum through red, orange and magenta into cyan, each lit along its crest.",
    DUSK_WAVES.map(([y0, y1, amplitude, phase, above, below]) =>
      boundary(slopedWaveNodes({ x0: 0, x1: 1, y0, y1, amplitude, cycles: 0.8, phase }), above, below))),
  preset("coastal-layers", "Coastal layers", "A coral headland slides under sky-blue swells, with white and gold surf along the crest.", [
    boxEdge("top", ["#8cc0ee", "#3a76b4"]),
    boundary(smooth([[0.35, 0], [0.6, 0.18], [0.8, 0.3], [1, 0.4]]), ["#5f9ad2", "#3a76b4"], ["#6ea6da", "#4a84c0"]),
    boundary(smooth([[0, 0.22], [0.22, 0.16], [0.5, 0.3], [0.75, 0.45], [1, 0.56]]),
      ["#8cc0ee", "#9fbfe2", "#eef0f8", "#f4f2f8"], ["#e65a63", "#ea6a5e", "#f2a268", "#f4b870"]),
    boundary(smooth([[0, 0.62], [0.3, 0.64], [0.6, 0.76], [1, 0.9]]), ["#d84a60", "#e0505a"], ["#8a3c78", "#a04070"]),
    boxEdge("bottom", ["#2a4874", "#1d4068"]),
  ]),
  preset("violet-canyon", "Violet canyon", "Magenta and indigo ridges fold down into a misty pink valley.", [
    boxEdge("top", ["#d5cfe6", "#dcd6ea"]),
    boundary(smooth([[0, 0.1], [0.2, 0.2], [0.4, 0.45], [0.55, 0.72], [0.62, 1]]),
      ["#d8cfe4", "#e0c4d8", "#d8a8c8", "#c070c8"], ["#d86ab0", "#c050b8", "#9030c8", "#7a24c4"]),
    boundary(smooth([[0, 0.42], [0.2, 0.52], [0.36, 0.74], [0.44, 1]]), ["#8a2ab0", "#6a20c0"], ["#5a1ab8", "#3a14a8"]),
    boundary(smooth([[0, 0.74], [0.16, 0.84], [0.26, 1]]), ["#40169d", "#3a14a0"], ["#2a1480", "#241472"]),
    boundary(smooth([[1, 0.22], [0.86, 0.5], [0.76, 0.8], [0.72, 1]]), ["#d8b0cc", "#d070b0", "#b050c8"], ["#dcd6e6", "#d8b8d4", "#c070c8"]),
    boundary(smooth([[1, 0.56], [0.92, 0.8], [0.88, 1]]), ["#c850a0", "#b83cb0"], ["#d890c0", "#c060b8"]),
  ]),
  preset("sunrise-rays", "Sunrise rays", "Peach and cobalt light streams fanning down from a bright point at the top.",
    [[0.42, [0, 0.35], "#0a2a95"], [0.46, [0, 0.9], "#f3a571"], [0.5, [0.3, 1], "#1a64c0"], [0.54, [0.6, 1], "#efb587"],
      [0.58, [0.9, 1], "#3a50b8"], [0.62, [1, 0.6], "#ed976a"], [0.66, [1, 0.2], "#6a5aa8"]].map(([x, end, color]) =>
      boundary(polylineNodes([[x, 0], end]), ["#fde8c4", color]))),
  preset("midnight-silk", "Midnight silk", "A single sheet of blue silk sweeps up through a violet horizon under a navy sky.", [
    boxEdge("top", ["#02033a", "#030740"]),
    boundary(smooth([[0, 0.72], [0.3, 0.6], [0.55, 0.38], [0.8, 0.2], [1, 0.18]]),
      ["#4a34c0", "#3a2ab8", "#2a2aa8", "#1a1e80"], ["#5a70e8", "#6a80f0", "#4a60d8", "#3a50c8"]),
    boundary(smooth([[0, 0.9], [0.3, 0.8], [0.6, 0.62], [1, 0.5]]), ["#2a3a9a", "#2a3890"], ["#3b4faa", "#4a5aa8"]),
    boxEdge("bottom", ["#1f2a5e", "#16225d"]),
  ]),
  preset("glassy-aurora", "Glassy aurora", "Lime and cyan light ribbons sweep across a deep teal glass sky above a white flare.", [
    boxEdge("top", ["#0a7a6c", "#05606a"]),
    boxEdge("bottom", ["#72dcd7", "#b8e8a0", "#d8e04a"]),
    boundary(smooth([[0, 0.16], [0.35, 0.34], [0.7, 0.5], [1, 0.58]]), ["#0a7a6c", "#58d0b0", "#a8f0e0"]),
    boundary(smooth([[0, 0.4], [0.3, 0.62], [0.62, 0.78], [1, 0.84]]),
      ["#1c9a7a", "#7ed070", "#cff0b0", "#8ee8e0"], ["#60c060", "#c8e860", "#f4ffe4", "#b0f4f0"]),
    boundary(smooth([[0, 0.3], [0.34, 0.52], [0.66, 0.68], [1, 0.74]]), ["#12907a", "#d8ffc0", "#f0fff8"]),
    boundary(smooth([[0.84, 0], [0.92, 0.22], [1, 0.4]]), ["#06646a", "#0a6e74"], ["#06646a", "#80e8e8"]),
    boundary(smooth([[0.28, 0.93], [0.6, 0.91], [1, 0.92]]), ["#c4e27a", "#ffffff", "#e0fffc"]),
  ]),
  preset("rim-orb", "Rim-lit orb", "A dark violet sphere whose lower rim burns hot pink and amber against night.", [
    withStopOffsets(boxFrame(["#0d012b", "#12011b", "#4a0a26"]), [0, 0.25, 0.625, 1]),
    withStopOffsets(boundary(orientedEllipseNodes({ cx: 0.5, cy: 0.42, rx: 0.4, ry: 0.4, start: -Math.PI / 2 }),
      ["#0e012c", "#6a0a5a", "#c8401e", "#0e012c"], ["#10022e", "#ff4fa0", "#ffc890", "#10022e"], true), [0, 0.42, 0.56, 1]),
    boundary(orientedEllipseNodes({ cx: 0.5, cy: 0.39, rx: 0.35, ry: 0.35, start: -Math.PI / 2 }), ["#14022e", "#7a12a8", "#14022e"], null, true),
  ]),
  preset("porcelain-swirl", "Porcelain swirl", "Pale blue-grey paper sheets curling into a soft double spiral, shadowed in slate.", [
    boxFrame(["#b4babe", "#a8adb3", "#b7bdc3"]),
    ...[0, Math.PI].map((phase) => boundary(ellipticSpiralNodes({ cx: 0.46, cy: 0.58, rx: 0.44, ry: 0.36, startRadius: 0.08, turns: 1.25, phase, angle: 0.25 }),
      ["#dfe8ee", "#c8d6e0", "#b4c6cf", "#aab4bc"], ["#3b546c", "#526c8b", "#7a95a8", "#98acbc"])),
  ]),
  preset("night-ribbons", "Night ribbons", "Dark ribbons curling through black, their edges caught by pink and periwinkle rim light.", [
    boxFrame(["#050308"]),
    boundary(smooth([[0.5, 0], [0.34, 0.22], [0.18, 0.5], [0.14, 0.8], [0.2, 1]]), NIGHT_SHADE, ["#0a0610", "#b04aa0", "#6a3ab8", "#0a0610"]),
    boundary(smooth([[1, 0.3], [0.7, 0.34], [0.5, 0.5], [0.42, 0.8], [0.45, 1]]), NIGHT_SHADE, ["#0a0610", "#4a46c8", "#8a50d0", "#0a0610"]),
    boundary(smooth([[0.8, 0], [0.9, 0.12], [1, 0.16]]), NIGHT_SHADE, ["#0a0610", "#a050c0", "#7040b0", "#0a0610"]),
    boundary(smooth([[0.62, 1], [0.8, 0.82], [1, 0.76]]), ["#0a0610", "#c04a90", "#6a3ab8", "#0a0610"], NIGHT_SHADE),
  ]),
  preset("blush-folds", "Blush folds", "Pale rose paper shells stacked in soft layers on a dove-grey wall.", [
    boxEdge("top", ["#b9bec6", "#c6cbd2"]),
    ...[[0.46, 0.46, 0.7], [0.49, 0.37, 0.58], [0.52, 0.28, 0.46], [0.55, 0.19, 0.33], [0.57, 0.1, 0.2]].map(([cx, rx, ry], i) =>
      boundary(archNodes({ cx, base: 1, rx, ry }), [i ? "#c4a09c" : "#bcc2ca"], ["#f2e0dc"])),
  ]),
  preset("aurora-hero", "Aurora hero", "Violet, teal and pink light clouds glowing at the top of a near-black page.", [
    boxFrame(["#0c1030", "#080b20", "#05070f"]),
    ...[[0.3, 0.22, 0.09, "#7c5cff"], [0.7, 0.13, 0.07, "#2dd4bf"], [0.78, 0.36, 0.055, "#f472b6"]].map(([cx, cy, rx, color]) =>
      boundary(ellipseNodes(cx, cy, rx, rx * GLOW_SQUASH), [color], null, true)),
  ]),
  preset("tilted-mesh", "Tilted mesh", "Gold, magenta, violet and sky blue folded into a slanted silky mesh.", [
    boundary(slopedWaveNodes({ x0: 0, x1: 1, y0: 0.4, y1: 0.05, amplitude: 0.05, cycles: 1 }), ["#ffba27", "#ff7a3c", "#ef008f"]),
    boundary(slopedWaveNodes({ x0: 0, x1: 1, y0: 0.8, y1: 0.4, amplitude: 0.06, cycles: 1, phase: 1 }), ["#ef008f", "#b020d0", "#7038ff"]),
    boundary(slopedWaveNodes({ x0: 0, x1: 1, y0: 1, y1: 0.8, amplitude: 0.03, cycles: 0.5 }), ["#7038ff", "#6ec3f4"]),
  ]),
  preset("golden-petals", "Golden petals", "Broad orange petals curling open against a clear blue sky, lit gold along their rims.", [
    boxEdge("top", ["#86c6ee", "#4f90d2"]),
    boundary(smooth([[0, 0.46], [0.12, 0.24], [0.3, 0.12], [0.5, 0.16], [0.64, 0.36], [0.7, 0.66], [0.68, 1]]),
      ["#7ab8e8", "#8ec8f0", "#5e9ad8", "#3e6fb0"], ["#fcd46a", "#fde07a", "#f4a444", "#d8602e"]),
    boundary(smooth([[0, 0.62], [0.28, 0.44], [0.5, 0.52], [0.56, 0.76], [0.54, 1]]), ["#f6b04a", "#e88838", "#c8501e"], ["#fbd06a", "#f6a040", "#e07030"]),
    boundary(smooth([[0, 0.8], [0.14, 0.72], [0.26, 0.84], [0.3, 1]]), ["#c8521e", "#d86428", "#c04a1c"], ["#f8c060", "#f4aa48", "#e88a38"]),
    boundary(smooth([[0.8, 1], [0.8, 0.7], [0.88, 0.46], [1, 0.34]]), ["#3e70b4", "#4a80c4", "#5a94d4"], ["#d8602e", "#f09a40", "#fcd46a"]),
  ]),
  preset("cobalt-ruffle", "Cobalt ruffle", "Vivid blue fabric gathered into a layered ruffle, each fold lit at its rim, over pale blue-grey.", [
    boxFrame(["#a6c5dc", "#93b8d1", "#b4cadb"]),
    ...RUFFLE_LAYERS.map(([cx, cy, rx, ry, lobes, outside]) => boundary(blobNodes({ cx, cy, rx, ry, lobes, count: 8, start: RUFFLE_SEAM }),
      closedRamp([outside, outside, outside]), closedRamp(["#7ec0ff", "#2f7af4", "#1a5ad8"]), true)),
  ]),
  // Soft-shape mesh gradient: flat-cored shapes blur into a pale frame (a single-sided closed
  // curve's interior is a smooth blend of its rim, and its outside falls off toward the frame).
  preset("magenta-swoosh", "Magenta swoosh", "A blurred magenta swoosh deepening to violet sweeps under a cobalt cloud on blush pink.", [
    boxFrame(["#fbe0dc", "#f6d4d6", "#f8dcd8"]),
    boundary(blobNodes({ cx: 0.34, cy: 0.3, rx: 0.15, ry: 0.11, lobes: [[2, 0.08, 0.5]], count: 6 }), ["#3f7fd0"], null, true),
    withStopOffsets(boundary(ribbonNodes(slopedWave({ x0: 0.14, x1: 0.84, y0: 0.74, y1: 0.24, amplitude: 0.13, cycles: 0.5, phase: -0.3 }), 0.07, 4),
      ["#f0508a", "#e0147c", "#5a34a8", "#f0508a"], null, true), [0, 0.25, 0.5, 1]),
  ]),
  preset("sunset-twirl", "Sunset twirl", "A soft two-armed twirl of peach cream and plum, blurred like a warped mesh gradient.",
    TWIRL_ARMS.map((ramp, i) => withStopOffsets(boundary(ellipticSpiralNodes({ cx: 0.5, cy: 0.5, rx: 0.48, ry: 0.48, startRadius: 0.04, turns: 1.5, phase: i * Math.PI, angle: 0.6 }), ramp), TWIRL_STOPS))),
  preset("silk-ribbon", "Silk ribbon", "One thin glossy pink ribbon twisting across a pale lilac page.", [
    ...parallelPaths(SILK_SPINE, [-SILK_HALF_WIDTH, SILK_HALF_WIDTH]).map((nodes, i) => i
      ? boundary(nodes, ["#e05a9a", "#b0288a", "#f090b0", "#d04890"], SILK_GROUND)
      : boundary(nodes, SILK_GROUND, ["#f8b0c8", "#e04890", "#ffd0e0", "#f070a8"])),
  ]),
];

