/**
 * "Nature" family: landscapes, water, weather and seasons.
 * Coordinates are the unit paint box (y down). Colours on a left-to-right open
 * curve: `colors` = the side ABOVE it, `rightColors` = BELOW. On a clockwise
 * closed curve: `colors` = OUTSIDE, `rightColors` = INSIDE.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { hermiteNodes, ellipseNodes, waveNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
const QUARTER_CIRCLE_HANDLE = 4 * (Math.SQRT2 - 1) / 3;
// Cubic tip handle as a fraction of leaf length: sharp enough to read as a point.
const LEAF_TIP_HANDLE = 1 / 6;
// A cubic's midpoint moves 3/4 of its (equal) control offsets; 2/3·width → width/2 bulge.
const LEAF_BULGE_HANDLE = 2 / 3;

/**
 * Pure function. Cubic approximation of a function graph y = f(x), exact slopes.
 * Traverses left to right when x1 > x0, so `colors` is the side above the graph.
 * @param {object} options - {x0,x1,segments,f,slope}; f(x) → y, slope(x) → dy/dx.
 * @returns {number[][]} [segments+1,6] anchor/relative-handle tuples.
 * @example graphNodes({x0:0,x1:1,segments:1,f:(x)=>x,slope:()=>1})[1] // [1,1,-1/3,-1/3,1/3,1/3]
 */
export function graphNodes({ x0, x1, segments, f, slope }) {
  if (!Number.isInteger(segments) || segments < 1) throw new Error("Graph needs a positive integer segment count");
  const width = x1 - x0;
  finiteGeometry([x0, x1, width]);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const x = x0 + width * i / segments;
    return [x, f(x), width, slope(x) * width];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Closed polar curve r(θ) about a center, with exact tangents.
 * x = cx + r·cos θ, y = cy + r·sin θ; increasing θ is clockwise on screen, so on a
 * two-sided boundary `colors` is OUTSIDE and `rightColors` INSIDE. No duplicate end node.
 * @param {object} options - {cx,cy,radius,slope,segments,phase=0}; radius(θ) → r > 0, slope(θ) → dr/dθ.
 * @returns {number[][]} [segments,6] anchor/relative-handle tuples.
 * @example polarNodes({cx:0.5,cy:0.5,radius:()=>0.25,slope:()=>0,segments:4})[0].slice(0,2) // [0.75,0.5]
 */
export function polarNodes({ cx, cy, radius, slope, segments, phase = 0 }) {
  if (!Number.isInteger(segments) || segments < 3) throw new Error("Polar curve needs at least 3 segments");
  finiteGeometry([cx, cy, phase]);
  const samples = Array.from({ length: segments }, (_, i) => {
    const angle = phase + FULL_TURN * i / segments, r = radius(angle), dr = slope(angle);
    if (!(r > 0)) throw new Error("Polar radius must be positive");
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + r * c, cy + r * s, dr * c - r * s, dr * s + r * c];
  });
  return hermiteNodes(samples, FULL_TURN / segments);
}

/**
 * Pure function. Petalled closed outline r(θ) = R·(1 − depth·(1 − cos(petals·θ))/2).
 * Petal tips sit at θ = phase + k·2π/petals; two anchors per petal (tip and notch).
 * Measured: ≈2% of radius maximum radial error at depth 0.3 — a shape, not an exact rose.
 * @param {object} options - {cx,cy,radius,depth,petals,phase=0}; depth in [0,1).
 * @returns {number[][]} [2·petals,6] clockwise anchor/relative-handle tuples.
 * @example blossomNodes({cx:0.5,cy:0.5,radius:0.3,depth:0.5,petals:5}).length // 10
 */
export function blossomNodes({ cx, cy, radius, depth, petals, phase = 0 }) {
  finiteGeometry([radius, depth, petals]);
  if (!(radius > 0) || depth < 0 || depth >= 1 || !Number.isInteger(petals) || petals < 2)
    throw new Error("Blossom needs positive radius, depth in [0,1) and at least 2 petals");
  return polarNodes({ cx, cy, phase, segments: 2 * petals,
    radius: (a) => radius * (1 - depth * (1 - Math.cos(petals * (a - phase))) / 2),
    slope: (a) => -radius * depth * petals * Math.sin(petals * (a - phase)) / 2 });
}

/**
 * Pure function. Rotated ellipse from four quarter-arc cubics, clockwise on screen.
 * P(θ) = c + Rot(rotation)·(rx·cos θ, ry·sin θ), first anchor at θ = start, so
 * closed-ramp arc length 0 sits wherever the author wants the colour seam.
 * @param {object} options - {cx,cy,rx,ry,rotation=0,start=0}; radians.
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example orientedEllipseNodes({cx:0.5,cy:0.5,rx:0.2,ry:0.1})[0].slice(0,2) // [0.7,0.5]
 */
export function orientedEllipseNodes({ cx, cy, rx, ry, rotation = 0, start = 0 }) {
  finiteGeometry([cx, cy, rx, ry, rotation, start]);
  if (!(rx > 0) || !(ry > 0)) throw new Error("Ellipse radii must be positive");
  const cr = Math.cos(rotation), sr = Math.sin(rotation);
  const turn = ([x, y]) => [x * cr - y * sr, x * sr + y * cr];
  return [0, 1, 2, 3].map((i) => {
    const a = start + i * Math.PI / 2;
    const [px, py] = turn([rx * Math.cos(a), ry * Math.sin(a)]);
    const [tx, ty] = turn([-rx * Math.sin(a) * QUARTER_CIRCLE_HANDLE, ry * Math.cos(a) * QUARTER_CIRCLE_HANDLE]);
    return [cx + px, cy + py, -tx, -ty, tx, ty];
  });
}

/**
 * Pure function. Two-anchor closed leaf outline, clockwise on screen.
 * Pointed tip at center + length/2 along `angle`, base opposite; arcs bulge ≈ width/2.
 * `taper` scales the base's axial handle: 1 = symmetric pointed lens (almond),
 * 0 = smooth round base (teardrop leaf).
 * @param {object} options - {cx,cy,length,width,angle,taper=1}; angle in radians, y down.
 * @returns {number[][]} [2,6] anchor/relative-handle tuples (tip, base).
 * @example leafNodes({cx:0.5,cy:0.5,length:0.4,width:0.2,angle:0})[0].slice(0,2) // [0.7,0.5]
 * @example leafNodes({cx:0.5,cy:0.5,length:0.4,width:0.3,angle:0,taper:0})[1] // [0.3,0.5,0,0.2,0,-0.2]
 */
export function leafNodes({ cx, cy, length, width, angle, taper = 1 }) {
  finiteGeometry([cx, cy, length, width, angle, taper]);
  if (!(length > 0) || !(width > 0) || taper < 0) throw new Error("Leaf needs positive length/width and nonnegative taper");
  const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
  const a = length * LEAF_TIP_HANDLE, t = a * taper, b = width * LEAF_BULGE_HANDLE, half = length / 2;
  return [
    [cx + ux * half, cy + uy * half, -ux * a - nx * b, -uy * a - ny * b, -ux * a + nx * b, -uy * a + ny * b],
    [cx - ux * half, cy - uy * half, ux * t + nx * b, uy * t + ny * b, ux * t - nx * b, uy * t - ny * b],
  ];
}

/**
 * Pure function. A straight, constant-colour line just outside one box edge —
 * the cheapest broad "wash" source (a point is only a 0.04-radius spot).
 * @param {"top"|"bottom"|"left"|"right"} side - Box edge.
 * @param {string[]} colors - Ramp along the edge (left→right or top→bottom).
 * @returns {object} Open single-sided feature.
 * @example edgeLine("top", ["#ffffff"]).nodes[0].slice(0,2) // [-0.05,-0.02]
 */
export function edgeLine(side, colors) {
  const OVER = 0.05, OUT = 0.02;
  const ends = { top: [[-OVER, -OUT], [1 + OVER, -OUT]], bottom: [[-OVER, 1 + OUT], [1 + OVER, 1 + OUT]],
    left: [[-OUT, -OVER], [-OUT, 1 + OVER]], right: [[1 + OUT, -OVER], [1 + OUT, 1 + OVER]] }[side];
  if (!ends) throw new Error(`Unknown box edge: ${side}`);
  return boundary(polylineNodes(ends), colors);
}

/**
 * Pure function. Straight-edged star polygon alternating outer tips and inner notches.
 * First anchor is the tip at `phase`; increasing angle is clockwise on screen, so on
 * a two-sided closed boundary `colors` is OUTSIDE and `rightColors` INSIDE.
 * @param {object} options - {cx,cy,outer,inner,points,phase=0}; radii positive, points ≥ 2.
 * @returns {number[][]} [2·points,6] zero-handle anchor tuples.
 * @example starNodes({cx:0.5,cy:0.5,outer:0.4,inner:0.1,points:6}).length // 12
 */
export function starNodes({ cx, cy, outer, inner, points, phase = 0 }) {
  finiteGeometry([cx, cy, outer, inner, points, phase]);
  if (!(outer > 0) || !(inner > 0) || !Number.isInteger(points) || points < 2)
    throw new Error("Star needs positive radii and at least 2 points");
  return polylineNodes(Array.from({ length: 2 * points }, (_, i) => {
    const r = i % 2 ? inner : outer, angle = phase + Math.PI * i / points;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  }));
}

/**
 * Pure function. Re-addresses a feature's existing stops at explicit arc-length offsets,
 * for ramps that must change quickly over one part of a curve (boundary() spaces evenly).
 * @param {object} feature - Feature whose stop count matches offsets.length.
 * @param {number[]} offsets - Strictly increasing values in [0,1].
 * @returns {object} Copy with the same colours at the new offsets.
 * @example withStopOffsets(boundary([[0,0,0,0,0,0],[1,0,0,0,0,0]], ["#000000","#ffffff"]), [0,0.2]).stops[1].offset // 0.2
 */
export function withStopOffsets(feature, offsets) {
  finiteGeometry(offsets);
  if (offsets.length !== feature.stops.length || offsets.some((o, i) => o < 0 || o > 1 || (i && o <= offsets[i - 1])))
    throw new Error("Stop offsets must match the stop count and increase strictly within [0,1]");
  return { ...feature, stops: feature.stops.map((stop, i) => ({ ...stop, offset: offsets[i] })) };
}

const sin = Math.sin, cos = Math.cos;

// Numeric rows below are authored composition data (unit-box positions/radii).
export const PRESETS = [
  preset("hillside-dawn", "Hillside dawn", "A pale sun rising behind two rolling green hills under a periwinkle-to-peach sky.", [
    edgeLine("top", ["#7f8fd6"]),
    ...glow(0.64, 0.36, 0.13, ["#fffbe8", "#ffe2a6", "#ffc39a"]),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.56, amplitude: 0.06, cycles: 0.8, phase: 0.4 }),
      ["#ffcaa2", "#ffd3a8", "#f7b49a"], ["#a9c48c", "#9ebb86", "#8fb07c"]),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.76, amplitude: 0.07, cycles: 0.6, phase: 2.4 }),
      ["#86a96c", "#7ea566", "#76a060"], ["#3f7a3e", "#356f37", "#2f6534"]),
    edgeLine("bottom", ["#1f4a2a"]),
  ]),
  preset("sunlit-shafts", "Sunlit shafts", "Pale light shafts fanning down through teal water into the navy deep.", [
    edgeLine("top", ["#5ccfcc"]),
    ...[[0.2, 0.04, 0.8], [0.3, 0.5, 0.9], [0.4, 1.02, 0.78]].map(([x0, x1, y1]) =>
      boundary(polylineNodes([[x0, -0.02], [x1, y1]]), ["#effff8", "#76cfcf", "#0f3f6c"])),
    ...[[0.25, 0.24], [0.35, 0.8]].map(([x0, x1]) =>
      boundary(polylineNodes([[x0, -0.02], [x1, 1.02]]), ["#3aa9b8", "#16587e", "#061a3e"])),
    edgeLine("bottom", ["#030a22"]),
  ]),
  preset("coral-atoll", "Coral atoll", "An aerial sand ring around a pale lagoon, turquoise reef and deep blue sea.", [
    point(0.52, 0.5, "#35bfc4"),
    boundary(polarNodes({ cx: 0.5, cy: 0.5, segments: 6, phase: 0.3,
      radius: (a) => 0.24 + 0.035 * cos(3 * a) + 0.02 * sin(2 * a), slope: (a) => -0.105 * sin(3 * a) + 0.04 * cos(2 * a) }),
    ["#fff0cc"], ["#9af0de"], true),
    boundary(polarNodes({ cx: 0.5, cy: 0.5, segments: 6, phase: 0.3,
      radius: (a) => 0.36 + 0.04 * cos(3 * a) + 0.025 * sin(2 * a), slope: (a) => -0.12 * sin(3 * a) + 0.05 * cos(2 * a) }),
    ["#37d4c8"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.68), ["#0c3f7c"], null, true),
  ]),
  preset("sunlit-grove", "Sunlit grove", "Crisp dark trunks against golden forest haze, with the sun low between them.", [
    // [x, width, lean, west-side haze, east-side haze]; trunk faces toward the sun are lit.
    ...[[0.14, 0.075, -0.03, "#d9d79a", "#ecdf9f"], [0.4, 0.05, 0.02, "#f3e6aa", "#fff4c8"],
      [0.69, 0.09, -0.02, "#fff2c2", "#eadb9c"], [0.92, 0.05, 0.03, "#dcd497", "#cfcb8c"]].flatMap(([x, w, lean, west, east]) => {
      const sunward = x < 0.54;
      return [
        boundary(polylineNodes([[x - 0.4 * w + lean, -0.06], [x - 0.5 * w - lean, 1.06]]),
          [sunward ? "#2a221a" : "#8a6a44", "#1b1611"], [west, "#5f7c3e"]),
        boundary(polylineNodes([[x + 0.4 * w + lean, -0.06], [x + 0.5 * w - lean, 1.06]]),
          [east, "#5f7c3e"], [sunward ? "#8a6a44" : "#2a221a", "#1b1611"]),
      ];
    }),
    point(0.54, 0.26, "#fffbe6"),
    boundary(ellipseNodes(0.54, 0.26, 0.06), ["#ffe9a6"], null, true),
    edgeLine("bottom", ["#26361c"]),
  ]),
  preset("dune-crests", "Dune crests", "Sharp sand ridges: lit gold faces above burnt-sienna shadow slopes.", [
    edgeLine("top", ["#a7cbe0"]),
    ...[[0.3, 0.05, 0.4, ["#f6ddb6", "#f3d3a6", "#f1cea0"], ["#cf8246", "#c4763e", "#b86c38"]],
      [0.56, 0.08, 1.9, ["#f2bb72", "#efb166", "#eaa95e"], ["#a9542a", "#9e4c26", "#944524"]],
      [0.82, 0.07, 3.6, ["#eba45a", "#e59a52", "#df924c"], ["#7c3a1e", "#71331b", "#672e19"]]].map(([y, a, p, top, bottom]) =>
      boundary(graphNodes({ x0: -0.08, x1: 1.08, segments: 6,
        f: (x) => y + a * sin(4.2 * x + p) + 0.35 * a * sin(8.4 * x + 2 * p),
        slope: (x) => a * 4.2 * cos(4.2 * x + p) + 0.35 * a * 8.4 * cos(8.4 * x + 2 * p) }),
      top, bottom)),
  ]),
  preset("glacier-facets", "Glacier facets", "Crossing straight fractures split ice into white, glacial cyan and cobalt facets.", [
    boundary(polylineNodes([[-0.1, 0.25], [1.1, 0.62]]), ["#f6fdff"], ["#a6e3ef"]),
    boundary(polylineNodes([[0.18, -0.1], [0.5, 1.1]]), ["#d9f5fa"], ["#4fb3d0"]),
    boundary(polylineNodes([[0.95, -0.1], [0.62, 1.1]]), ["#bdeaf4"], ["#2a7cb0"]),
    boundary(polylineNodes([[-0.1, 0.86], [1.1, 0.7]]), ["#7ccde2"], ["#16427a"]),
  ]),
  preset("lavender-rows", "Lavender rows", "Violet crop rows converging on a warm horizon under a dusk-blue sky.", [
    edgeLine("top", ["#8b98d6"]),
    boundary(polylineNodes([[-0.1, 0.4], [1.1, 0.4]]), ["#ffd4a8"], ["#b9a4d6"]),
    point(0.5, 0.34, "#fff6dc"),
    ...[-0.3, 0.1, 0.5, 0.9, 1.3].map((x) => boundary(polylineNodes([[0.5 + (x - 0.5) * 0.04, 0.42], [x, 1.08]]),
      ["#b09ada", "#8c5ed0", "#7433c4"])),
    ...[-0.1, 0.3, 0.7, 1.1].map((x) => boundary(polylineNodes([[0.5 + (x - 0.5) * 0.04, 0.42], [x, 1.08]]),
      ["#a9a48e", "#5f8446", "#36602a"])),
  ]),
  preset("misty-ridges", "Misty ridges", "Four forested ridgelines fading back into pale rainforest fog.", [
    edgeLine("top", ["#eef2ec"]),
    ...[[0.3, 0.035, 0.7, "#dde6e0", "#9fb5aa"], [0.47, 0.045, 2.1, "#c9d8cf", "#6e8f7f"],
      [0.64, 0.05, 4.0, "#b3c8bb", "#416b58"], [0.82, 0.055, 5.2, "#98b3a3", "#1d3f31"]].map(([y, a, p, mist, ridge]) =>
      boundary(graphNodes({ x0: -0.08, x1: 1.08, segments: 8,
        f: (x) => y + a * sin(6.5 * x + p) + 0.5 * a * sin(15 * x + 1.7 * p),
        slope: (x) => a * 6.5 * cos(6.5 * x + p) + 0.5 * a * 15 * cos(15 * x + 1.7 * p) }),
      [mist], [ridge])),
    edgeLine("bottom", ["#11271e"]),
  ]),
  preset("lightning-strike", "Lightning strike", "A jagged white-violet bolt dropping from a bruised indigo cloud base.", [
    edgeLine("top", ["#0c0a1f"]),
    boundary(waveNodes({ x0: -0.08, x1: 1.08, y: 0.24, amplitude: 0.035, cycles: 1.5 }),
      ["#151130", "#3c3175", "#151130"], ["#211a48", "#5a4aa6", "#211a48"]),
    // The bolt, then two dim copies shifted sideways: they hold its glow to a narrow aura.
    ...[[0, ["#ffffff", "#f3eeff", "#c4b0ff"]], [-0.1, ["#2f2566", "#3a2d7c", "#2c2266"]], [0.1, ["#2f2566", "#3a2d7c", "#2c2266"]]]
      .map(([shift, colors]) => boundary(polylineNodes([[0.56, 0.27], [0.62, 0.4], [0.45, 0.56], [0.55, 0.68], [0.4, 0.86], [0.46, 1.04]]
        .map(([x, y]) => [x + shift, y + (shift ? 0.02 : 0)])), colors)),
    edgeLine("left", ["#1a1440", "#140f33"]), edgeLine("right", ["#1a1440", "#140f33"]),
    edgeLine("bottom", ["#221a4e"]),
  ]),
  preset("autumn-leaves", "Autumn leaves", "Five tilted leaves in amber, crimson and ochre on dark bark brown.", [
    ...[[0.28, 0.26, 0.4, 0.2, -0.6, "#f5b13a", "#ffe08a"], [0.72, 0.3, 0.36, 0.18, 0.5, "#d8432c", "#ff8a5c"],
      [0.5, 0.62, 0.44, 0.22, -0.2, "#e5782a", "#ffc070"], [0.2, 0.78, 0.3, 0.15, 0.9, "#b99a2e", "#f0dc72"],
      [0.82, 0.8, 0.32, 0.16, -1.1, "#9e2b2a", "#e0604a"]].flatMap(([cx, cy, length, width, angle, rim, heart]) => {
      const stem = 0.62 * length, vein = 0.34 * length, ux = Math.cos(angle), uy = Math.sin(angle);
      return [
        // Stem pokes out past the round base in dark bark tones, turning to the bright midrib inside.
        withStopOffsets(boundary(polylineNodes([[cx - ux * stem, cy - uy * stem], [cx + ux * vein, cy + uy * vein]]),
          ["#3a1d12", "#7a4c28", heart, heart]), [0, 0.1, 0.22, 1]),
        boundary(leafNodes({ cx, cy, length, width, angle, taper: 0.2 }), ["#34190f", "#34190f", "#34190f"], [rim, "#6b2a18", rim], true),
      ];
    }),
    edgeLine("top", ["#4d2a18"]), edgeLine("bottom", ["#1e0e09"]),
  ]),
  preset("sakura-bloom", "Sakura bloom", "Three pale-pink five-petal blossoms with rose hearts on soft spring sky.", [
    edgeLine("top", ["#bcdcf2"]),
    ...[[0.3, 0.32, 0.23, 0.3], [0.73, 0.52, 0.19, 1.1], [0.34, 0.8, 0.15, 0.7]].flatMap(([cx, cy, r, phase]) => [
      point(cx, cy, "#e0527e"),
      boundary(blossomNodes({ cx, cy, radius: r, depth: 0.3, petals: 5, phase }), ["#f3f8fc"], ["#ffc2d6"], true),
    ]),
    edgeLine("bottom", ["#f4dce8"]),
  ]),
  preset("frost-star", "Frost star", "A crisp six-pointed ice crystal with a hexagonal heart on frozen sapphire.", [
    boundary(ellipseNodes(0.5, 0.5, 0.66), ["#173f7e"], null, true),
    boundary(starNodes({ cx: 0.5, cy: 0.5, outer: 0.42, inner: 0.1, points: 6, phase: -Math.PI / 2 }),
      ["#5d93cf"], ["#f4fbff"], true),
    boundary(starNodes({ cx: 0.5, cy: 0.5, outer: 0.1, inner: 0.1, points: 3, phase: -Math.PI / 2 }),
      ["#f4fbff"], ["#b3dbf5"], true),
    point(0.5, 0.5, "#ffffff"),
  ]),
  preset("mossy-stones", "Mossy stones", "Three rounded grey stones, lit from the upper left, bedded in moss.", [
    // [cx, cy, rx, ry, rotation, [shadow, mid, highlight]]; seam (arc 0) faces the lower right.
    ...[[0.32, 0.36, 0.22, 0.16, -0.3, ["#4f5357", "#8a8e90", "#d4d6d2"]],
      [0.72, 0.6, 0.2, 0.15, 0.4, ["#5a5048", "#9a8e80", "#e0d6c6"]],
      [0.3, 0.8, 0.14, 0.1, 0.1, ["#445058", "#7c8c96", "#c6d2d8"]]].map(([cx, cy, rx, ry, rot, stone]) =>
      boundary(orientedEllipseNodes({ cx, cy, rx, ry, rotation: rot, start: Math.PI / 4 - rot }),
        ["#2e4a1f", "#5d7a33", "#8aa846", "#2e4a1f"], [...stone, stone[0]], true)),
    point(0.84, 0.18, "#a2bd55"), point(0.08, 0.6, "#4f6e2c"),
  ]),
  preset("ember-volcano", "Ember volcano", "A dark cone venting an orange lava tongue beneath an ash-grey sky.", [
    edgeLine("top", ["#17121d"]),
    // Hand-authored ridge: concave flanks, two sharp rim corners, a shallow crater dip.
    boundary([[-0.08, 0.95, 0, 0, 0.3, -0.01], [0.41, 0.42, -0.05, 0.22, 0.03, -0.01], [0.5, 0.445, -0.04, 0, 0.04, 0],
      [0.59, 0.42, -0.03, -0.01, 0.05, 0.22], [1.08, 0.96, -0.3, -0.01, 0, 0]],
    ["#4e434c", "#d08a62", "#4e434c"], ["#1a1214", "#2e1b18", "#1a1214"]),
    point(0.5, 0.425, "#ffcf70"),
    boundary(graphNodes({ x0: 0.49, x1: 0.2, segments: 3, f: (x) => 0.39 - 0.95 * (0.49 - x) + 0.03 * sin(25 * x),
      slope: (x) => 0.95 + 0.75 * cos(25 * x) }), ["#e89a70", "#8e7179", "#4a3f48"]),
    boundary(graphNodes({ x0: 0.52, x1: 0.7, segments: 3, f: (x) => 0.47 + 2.7 * (x - 0.52) + 0.025 * sin(22 * x),
      slope: (x) => 2.7 + 0.55 * cos(22 * x) }), ["#fff0a0", "#ff7a2a", "#a8221c"]),
    edgeLine("bottom", ["#0e090a"]),
  ]),
  preset("moonlit-sea", "Moonlit sea", "A pale moon over a navy horizon, its silver path running down the water.", [
    edgeLine("top", ["#0a0f2e"]),
    ...glow(0.64, 0.27, 0.11, ["#fdfbef", "#c8d2f2", "#34457f"]),
    boundary(polylineNodes([[-0.1, 0.56], [1.1, 0.56]]), ["#3a4b86"], ["#16244d"]),
    // Moon path: one soft vertical streak, brightest mid-water.
    boundary(polylineNodes([[0.64, 0.58], [0.64, 1.04]]), ["#9fb1e6", "#eef2ff", "#8196d4"]),
    edgeLine("bottom", ["#050b20"]),
  ]),
];

