/**
 * "Retro & eras" Multipoint presets: swirls, bands and
 * gradients traced to real artefacts — Art Nouveau whiplash (1895–97), Art Deco airbrush
 * (1927), 1960s psychedelic posters, 1970s flower-power textiles and rainbow stripes,
 * 1980s airbrush and city pop, Y2K/Aqua OS wallpapers, ukiyo-e bokashi and seigaiha, and
 * 2020s liquid-3D wallpapers. Sources: concerns.md (2026-09-30 research-preset merge).
 * Side convention (verified by render): walking a curve on screen, rightColor lies to the
 * walker's RIGHT — below a left-to-right curve, INSIDE a clockwise closed curve.
 * All geometry stays inside the unit box: overhang enlarges the solve domain and blurs.
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, polylineNodes, catmullRomNodes, rectNodes, waveNodes, finiteGeometry }
  from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
const QUARTER_ARC_SPAN = Math.PI / 2; // widest span one cubic takes before its error shows

/**
 * Pure function. Exact-tangent cubic handle length for a circular span of `span` radians.
 * @param {number} span - Span angle in radians, |span| ≤ π/2 for sub-0.03% error.
 * @returns {number} Handle length as a fraction of the radius.
 * @example arcHandle(Math.PI / 2) // 0.5522847498307933
 */
export function arcHandle(span) {
  finiteGeometry([span]);
  return 4 / 3 * Math.tan(span / 4);
}

/**
 * Pure function. Open elliptical arc from angle `from` to `to`, in cubic spans of at most
 * a quarter turn. Screen y is down, so to > from runs clockwise on screen.
 * P(θ) = (cx + rx·cos θ, cy + ry·sin θ).
 * @param {object} options - {cx,cy,rx,ry=rx,from,to}; radians, to ≠ from.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 3 nodes for a half turn.
 * @example arcNodes({cx:0.5,cy:1,rx:0.25,from:Math.PI,to:2*Math.PI}).map((n) => n.slice(0,2)) // [[0.25,1],[0.5,0.75],[0.75,1]] (≈, float noise)
 */
export function arcNodes({ cx, cy, rx, ry = rx, from, to }) {
  finiteGeometry([cx, cy, rx, ry, from, to]);
  if (!(rx > 0) || !(ry > 0) || from === to) throw new Error("Arc needs positive radii and a nonzero sweep");
  const segments = Math.ceil(Math.abs(to - from) / QUARTER_ARC_SPAN - 1e-9);
  const span = (to - from) / segments, k = arcHandle(span);
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = from + span * i, tx = -rx * Math.sin(a) * k, ty = ry * Math.cos(a) * k;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a), -tx, -ty, tx, ty];
  });
}

/**
 * Pure function. Rounded rectangle, clockwise on screen from the top edge's left tangent point,
 * so on a two-sided closed boundary `colors` is OUTSIDE and `rightColors` INSIDE.
 * @param {object} options - {x0,y0,x1,y1,r}; 0 < r ≤ half the shorter side.
 * @returns {number[][]} [8,6] tuples: two tangent points per corner, straight sides between.
 * @example roundedRectNodes({x0:0,y0:0,x1:1,y1:1,r:0.1})[0] // [0.1,0,-0.05522847498307934,0,0,0]
 */
export function roundedRectNodes({ x0, y0, x1, y1, r }) {
  finiteGeometry([x0, y0, x1, y1, r]);
  if (!(x1 > x0 && y1 > y0) || !(r > 0) || 2 * r > Math.min(x1 - x0, y1 - y0)) throw new Error("Rounded rect needs x1>x0, y1>y0 and 0<r≤half side");
  const k = r * arcHandle(QUARTER_ARC_SPAN);
  return [
    [x0 + r, y0, -k, 0, 0, 0], [x1 - r, y0, 0, 0, k, 0],
    [x1, y0 + r, 0, -k, 0, 0], [x1, y1 - r, 0, 0, 0, k],
    [x1 - r, y1, k, 0, 0, 0], [x0 + r, y1, 0, 0, -k, 0],
    [x0, y1 - r, 0, k, 0, 0], [x0, y0 + r, 0, 0, 0, -k],
  ];
}

/**
 * Pure function. Scalloped (flower-power) outline: one sharp-cornered anchor per notch on a
 * circle of radius `radius`, each petal a cubic bulging outward by roughly `bulge`·radius.
 * Clockwise on screen, so a two-sided boundary's `rightColors` lands INSIDE.
 * @param {object} options - {cx,cy,radius,petals,bulge=0.35,phase=0}; petals ≥ 3.
 * @returns {number[][]} [petals,6] anchor/relative-handle tuples.
 * @example scallopNodes({cx:0.5,cy:0.5,radius:0.2,petals:4}).length // 4
 */
export function scallopNodes({ cx, cy, radius, petals, bulge = 0.35, phase = 0 }) {
  finiteGeometry([cx, cy, radius, petals, bulge, phase]);
  if (!(radius > 0) || !Number.isInteger(petals) || petals < 3 || !(bulge > 0)) throw new Error("Scallop needs positive radius/bulge and ≥ 3 petals");
  const chord = 2 * radius * Math.sin(Math.PI / petals), out = bulge * radius * 4 / 3, along = chord / 4;
  return Array.from({ length: petals }, (_, i) => {
    const a = phase + FULL_TURN * i / petals, ux = Math.cos(a), uy = Math.sin(a), tx = -uy, ty = ux;
    return [cx + radius * ux, cy + radius * uy,
      out * ux - along * tx, out * uy - along * ty, out * ux + along * tx, out * uy + along * ty];
  });
}

/**
 * Pure function. One arm of an Archimedean pinwheel as three Hermite nodes.
 * r(s) = r0 + (r1 − r0)·s, θ(s) = angle + sweep·s for s ∈ [0,1]; walks outward from the hub.
 * @param {object} options - {cx,cy,r0,r1,angle,sweep}; radians, sweep ≠ 0, |sweep| ≲ 2.
 * @returns {number[][]} [3,6] anchor/relative-handle tuples.
 * @example pinwheelArmNodes({cx:0.5,cy:0.5,r0:0.1,r1:0.4,angle:0,sweep:1})[0].slice(0,2) // [0.6,0.5]
 */
export function pinwheelArmNodes({ cx, cy, r0, r1, angle, sweep }) {
  finiteGeometry([cx, cy, r0, r1, angle, sweep]);
  if (!(r0 >= 0) || !(r1 > r0) || sweep === 0) throw new Error("Pinwheel arm needs 0 ≤ r0 < r1 and nonzero sweep");
  return hermiteNodes([0, 0.5, 1].map((s) => {
    const r = r0 + (r1 - r0) * s, a = angle + sweep * s, c = Math.cos(a), n = Math.sin(a);
    return [cx + r * c, cy + r * n, (r1 - r0) * c - r * sweep * n, (r1 - r0) * n + r * sweep * c];
  }), 0.5);
}

/**
 * Pure function. A 1970s "bend" stripe edge: in from the left box edge at height y, a
 * quarter-circle turn about (cx, cy), then straight down to the bottom box edge.
 * Walking it, the RIGHT side is the inside of the bend.
 * @param {object} options - {y,cx,cy}; y < cy so the turn radius cy − y is positive.
 * @returns {number[][]} [4,6] tuples: edge start, turn start, turn end, bottom end.
 * @example bendNodes({y:0.2,cx:0.5,cy:0.6}).map((n) => n.slice(0,2)) // [[0,0.2],[0.5,0.2],[0.9,0.6],[0.9,1]] (≈)
 */
export function bendNodes({ y, cx, cy }) {
  finiteGeometry([y, cx, cy]);
  const r = cy - y, k = r * arcHandle(QUARTER_ARC_SPAN);
  if (!(r > 0) || cx < 0 || cx + r > 1) throw new Error("Bend needs y < cy and must stay inside the box");
  return [[0, y, 0, 0, 0, 0], [cx, y, 0, 0, k, 0], [cx + r, cy, 0, -k, 0, 0], [cx + r, 1, 0, 0, 0, 0]];
}

/**
 * Pure function. A constant or ramped single-sided line lying exactly ON one box edge —
 * pins that edge without enlarging the solve domain.
 * @param {"top"|"bottom"|"left"|"right"} side - Box edge.
 * @param {string[]} colors - Ramp along the edge (left→right or top→bottom).
 * @param {number} from - Start fraction along the edge (lets two edges avoid touching at a corner).
 * @param {number} to - End fraction along the edge.
 * @returns {object} Open single-sided feature.
 * @example boxEdge("top", ["#ffffff"]).nodes.map((n) => n.slice(0,2)) // [[0,0],[1,0]]
 */
export function boxEdge(side, colors, from = 0, to = 1) {
  finiteGeometry([from, to]);
  const at = { top: (t) => [t, 0], bottom: (t) => [t, 1], left: (t) => [0, t], right: (t) => [1, t] }[side];
  if (!at || !(from >= 0 && to <= 1 && to > from)) throw new Error(`Bad box edge ${side} [${from}, ${to}]`);
  return boundary(polylineNodes([at(from), at(to)]), colors);
}

/**
 * Pure function. Four corner colours pinned around the whole box by two L-shaped edges
 * (left+top, right+bottom) that meet only at the two shared corners, with matching colours.
 * @param {string} tl - Top-left colour.
 * @param {string} tr - Top-right colour.
 * @param {string} br - Bottom-right colour.
 * @param {string} bl - Bottom-left colour.
 * @returns {object[]} Two open single-sided features, 3 nodes each.
 * @example cornerFrame("#000000","#111111","#222222","#333333")[0].stops.map((s) => s.color) // ["#333333","#000000","#111111"]
 */
export function cornerFrame(tl, tr, br, bl) {
  return [boundary(polylineNodes([[0, 1], [0, 0], [1, 0]]), [bl, tl, tr]),
    boundary(polylineNodes([[1, 0], [1, 1], [0, 1]]), [tr, br, bl])];
}

/**
 * Pure function. Re-addresses a feature's stops at explicit arc-length offsets.
 * @param {object} feature - Feature whose stop count matches offsets.length.
 * @param {number[]} offsets - Strictly increasing values in [0,1].
 * @returns {object} Copy with the same colours at the new offsets.
 * @example atOffsets(boundary(polylineNodes([[0,0],[1,0]]), ["#000000","#ffffff"]), [0,0.3]).stops[1].offset // 0.3
 */
export function atOffsets(feature, offsets) {
  finiteGeometry(offsets);
  if (offsets.length !== feature.stops.length || offsets.some((o, i) => o < 0 || o > 1 || (i && o <= offsets[i - 1])))
    throw new Error("Offsets must match the stop count and increase strictly within [0,1]");
  return { ...feature, stops: feature.stops.map((s, i) => ({ ...s, offset: offsets[i] })) };
}

/**
 * Pure function. Straight-edged n-point star, first tip at `phase`, clockwise on screen.
 * @param {object} options - {cx,cy,outer,inner,points,phase=0}.
 * @returns {number[][]} [2·points,6] zero-handle tuples.
 * @example starPolygonNodes({cx:0.5,cy:0.5,outer:0.2,inner:0.1,points:5}).length // 10
 */
export function starPolygonNodes({ cx, cy, outer, inner, points, phase = 0 }) {
  finiteGeometry([cx, cy, outer, inner, points, phase]);
  if (!(outer > inner && inner > 0) || !Number.isInteger(points) || points < 3) throw new Error("Star needs outer > inner > 0 and ≥ 3 points");
  return polylineNodes(Array.from({ length: 2 * points }, (_, i) => {
    const r = i % 2 ? inner : outer, a = phase + Math.PI * i / points;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }));
}

/**
 * Pure function. Moves each point a fraction t of the way toward a target point.
 * @param {number[]} p - (x,y).
 * @param {number[]} q - (x,y) target.
 * @param {number} t - Fraction in [0,1].
 * @returns {number[]} (x,y).
 * @example lerpPoint([0,0],[1,2],0.5) // [0.5,1]
 */
export function lerpPoint([px, py], [qx, qy], t) {
  finiteGeometry([px, py, qx, qy, t]);
  return [px + (qx - px) * t, py + (qy - py) * t];
}

/**
 * Pure function. Closed outline of a tapered stroke along a centerline — the crisp way to draw
 * a line: as a two-sided CLOSED shape whose interior sees only its own rim, instead of a
 * single-sided curve that diffuses into a wide soft glow. Normals come from Catmull–Rom chords;
 * a zero width is a pointed tip (one shared anchor). Clockwise on screen (out along the
 * walker's left edge, back along the right), so `rightColors` is the stroke's fill.
 * Arc-length 0 is the start tip; the far tip sits near 0.5.
 * @param {number[][]} points - [N,2] centerline anchors, N ≥ 2.
 * @param {number[]} widths - [N] full widths ≥ 0; keep each below twice the local bend radius.
 * @returns {number[][]} [2N − tips, 6] anchor/relative-handle tuples (close the feature).
 * @example ribbonNodes([[0.2,0.5],[0.5,0.5],[0.8,0.5]], [0,0.1,0]).map((n) => n.slice(0,2)) // [[0.2,0.5],[0.5,0.45],[0.8,0.5],[0.5,0.55]]
 */
export function ribbonNodes(points, widths) {
  if (points.length < 2 || widths.length !== points.length || widths.some((w) => !(w >= 0))) throw new Error("Ribbon needs ≥ 2 anchors and one nonnegative width per anchor");
  finiteGeometry([...points.flat(), ...widths]);
  const n = points.length, at = (i) => points[Math.max(0, Math.min(n - 1, i))];
  const sides = points.map(([x, y], i) => {
    const [ax, ay] = at(i - 1), [bx, by] = at(i + 1), length = Math.hypot(bx - ax, by - ay);
    if (!length) throw new Error("Ribbon anchors must not coincide with their neighbours");
    const nx = (by - ay) / length, ny = -(bx - ax) / length, h = widths[i] / 2; // walker's left
    return [[x + nx * h, y + ny * h], [x - nx * h, y - ny * h]];
  });
  const left = sides.map(([l]) => l), right = sides.map(([, r]) => r).reverse();
  const outline = [...left, ...right.filter((_, j) => !((j === 0 && widths[n - 1] === 0) || (j === n - 1 && widths[0] === 0)))];
  return catmullRomNodes(outline, true);
}

/**
 * Pure function. Parallel inset of a convex polygon: every edge moves inward by `d` and the
 * new corners are the intersections of neighbouring moved edges (mitred, so edges stay parallel).
 * @param {number[][]} points - [N,2] convex polygon, clockwise on screen (y down).
 * @param {number} d - Inset distance; negative grows the polygon outward.
 * @returns {number[][]} [N,2] inset polygon.
 * @example insetConvex([[0,0],[1,0],[1,1],[0,1]], 0.1) // [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]] (≈)
 */
export function insetConvex(points, d) {
  finiteGeometry([...points.flat(), d]);
  const n = points.length;
  // Clockwise on screen ⇒ the inward normal of edge (dx,dy) is (−dy, dx)/|e|.
  const lines = points.map(([x, y], i) => {
    const [x2, y2] = points[(i + 1) % n], dx = x2 - x, dy = y2 - y, len = Math.hypot(dx, dy);
    if (!len) throw new Error("insetConvex needs distinct consecutive vertices");
    return { px: x - dy / len * d, py: y + dx / len * d, dx, dy };
  });
  return lines.map((b, i) => {
    const a = lines[(i + n - 1) % n], det = a.dx * b.dy - a.dy * b.dx;
    if (!det) throw new Error("insetConvex needs non-parallel neighbouring edges");
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
}

/**
 * Pure function. Evenly spaced points along a (rotated) elliptical arc — centerlines for ribbons.
 * P(θ) = c + Rot(rotation)·(rx·cos θ, ry·sin θ), θ from \`from\` to \`to\` (radians, y down).
 * @param {object} options - {cx,cy,rx,ry,rotation=0,from,to,count}; count ≥ 2.
 * @returns {number[][]} [count,2] (x,y) points.
 * @example ellipsePoints({cx:0.5,cy:0.5,rx:0.25,ry:0.25,from:0,to:Math.PI,count:3}).map(([x,y]) => [x.toFixed(2), y.toFixed(2)]) // [["0.75","0.50"],["0.50","0.75"],["0.25","0.50"]]
 */
export function ellipsePoints({ cx, cy, rx, ry, rotation = 0, from, to, count }) {
  finiteGeometry([cx, cy, rx, ry, rotation, from, to, count]);
  if (!(rx > 0 && ry > 0) || !Number.isInteger(count) || count < 2) throw new Error("ellipsePoints needs positive radii and count ≥ 2");
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return Array.from({ length: count }, (_, i) => {
    const a = from + (to - from) * i / (count - 1), x = rx * Math.cos(a), y = ry * Math.sin(a);
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}

/**
 * Pure function. One edge of a 1970s supergraphic serpentine band: in from the left box edge,
 * a clockwise U-turn about x = xR, back left, a counter-clockwise U-turn about x = xL, and out
 * to the right box edge. \`d\` offsets it to the walker's right, so several edges with stepped
 * \`d\` stay parallel (the right turn tightens by d, the left turn widens by d) and never touch.
 * @param {object} options - {y0,xR,xL,r1,r2,d}; centerline top height, turn centres/radii, offset.
 * @returns {number[][]} [8,6] anchor/relative-handle tuples, left edge → right edge.
 * @example serpentineNodes({y0:0.2,xR:0.6,xL:0.4,r1:0.2,r2:0.2,d:0}).map((n) => n.slice(0,2)) // [[0,0.2],[0.6,0.2],[0.8,0.4],[0.6,0.6],[0.4,0.6],[0.2,0.8],[0.4,1],[1,1]] (≈)
 */
export function serpentineNodes({ y0, xR, xL, r1, r2, d }) {
  finiteGeometry([y0, xR, xL, r1, r2, d]);
  const ra = r1 - d, rb = r2 + d, k = arcHandle(QUARTER_ARC_SPAN);
  if (!(ra > 0 && rb > 0) || !(xR > xL)) throw new Error("Serpentine needs positive offset turn radii and xR > xL");
  const yA = y0 + d, yB = yA + 2 * ra, yC = yB + 2 * rb;
  return [[0, yA, 0, 0, 0, 0], [xR, yA, 0, 0, ra * k, 0], [xR + ra, yA + ra, 0, -ra * k, 0, ra * k], [xR, yB, ra * k, 0, 0, 0],
    [xL, yB, 0, 0, -rb * k, 0], [xL - rb, yB + rb, 0, -rb * k, 0, rb * k], [xL, yC, -rb * k, 0, 0, 0], [1, yC, 0, 0, 0, 0]];
}

/**
 * Pure function. A sine wave laid along an arbitrary segment A→B, with exact tangents.
 * P(t) = A + t·(B − A) + N·amplitude·sin(2π·cycles·t), N the unit left-hand normal of B − A
 * (y down), so a whole number of cycles starts and ends exactly on A and B.
 * @param {object} options - {x0,y0,x1,y1,amplitude,cycles,count}; count ≥ 2 anchors.
 * @returns {number[][]} [count,6] anchor/relative-handle tuples.
 * @example wavyLineNodes({x0:0,y0:0.5,x1:1,y1:0.5,amplitude:0.1,cycles:1,count:5}).map((n) => n.slice(0,2)) // [[0,0.5],[0.25,0.4],[0.5,0.5],[0.75,0.6],[1,0.5]] (≈; left-hand normal is UP for a rightward line)
 */
export function wavyLineNodes({ x0, y0, x1, y1, amplitude, cycles, count }) {
  finiteGeometry([x0, y0, x1, y1, amplitude, cycles, count]);
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  if (!length || !Number.isInteger(count) || count < 2) throw new Error("wavyLineNodes needs distinct ends and count ≥ 2");
  const nx = dy / length, ny = -dx / length, w = FULL_TURN * cycles;
  return hermiteNodes(Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1), s = amplitude * Math.sin(w * t), ds = amplitude * w * Math.cos(w * t);
    return [x0 + dx * t + nx * s, y0 + dy * t + ny * s, dx + nx * ds, dy + ny * ds];
  }), 1 / (count - 1));
}

// ── 1895–1897 Art Nouveau ─────────────────────────────────────────────────────────────
const OBRIST_SILK = ["#7b938f", "#667f7b", "#556b67"]; // blue-green wool, lit top-left
const OBRIST_GOLD = ["#86672c", "#c9a352", "#a8843a", "#86672c"]; // closed ramp around each thread
const RAJAH = { paper: "#e3d4bc", gold: "#dcaa3c", maroon: "#6b3430", steam: "#e6c3b6" };

// ── 1927 Art Deco ─────────────────────────────────────────────────────────────────────
const ETOILE_HORIZON = 0.21, ETOILE_VANISH = [0.6, 0.225];

export const PRESETS = [
  preset("whiplash-silk", "Whiplash", "Obrist's 1895 whiplash: tapering gold stems lashing across blue-green silk and doubling back.", [
    boxEdge("top", [OBRIST_SILK[0], OBRIST_SILK[1]]),
    boxEdge("bottom", [OBRIST_SILK[1], OBRIST_SILK[2]]),
    // [centerline, widths]: each stroke runs out, snaps round a tight hairpin and returns above itself.
    ...[[[[0.06, 0.84], [0.32, 0.7], [0.6, 0.58], [0.82, 0.47], [0.86, 0.4], [0.78, 0.36], [0.56, 0.4]], [0, 0.035, 0.05, 0.03, 0.015, 0.03, 0]],
      [[[0.14, 0.5], [0.3, 0.38], [0.48, 0.3], [0.62, 0.24], [0.66, 0.18], [0.58, 0.15], [0.44, 0.2]], [0, 0.026, 0.036, 0.022, 0.012, 0.022, 0]],
      [[[0.5, 0.92], [0.66, 0.8], [0.84, 0.74], [0.94, 0.78]], [0, 0.02, 0.024, 0]]].map(([line, widths]) =>
      boundary(ribbonNodes(line, widths), Array(4).fill(OBRIST_SILK[1]), OBRIST_GOLD, true)),
    boundary(ribbonNodes([[0.548, 0.405], [0.49, 0.43], [0.44, 0.48]], [0, 0.05, 0]), Array(4).fill(OBRIST_SILK[1]),
      ["#5f4a22", "#9a7634", "#7a5e28", "#5f4a22"], true),
  ]),
  preset("rajah-steam", "Tea steam", "Meunier's 1897 Thé Rajah: pale steam whiplashes on maroon inside a gilt frame.", [
    boundary(roundedRectNodes({ x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95, r: 0.08 }), [RAJAH.paper], [RAJAH.gold], true),
    boundary(roundedRectNodes({ x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.92, r: 0.06 }), [RAJAH.gold], [RAJAH.maroon], true),
    ...[[[[0.12, 0.26], [0.25, 0.16], [0.41, 0.24], [0.55, 0.15], [0.69, 0.22], [0.76, 0.36], [0.68, 0.46]], [0, 0.028, 0.04, 0.04, 0.034, 0.028, 0]],
      [[[0.14, 0.48], [0.27, 0.39], [0.42, 0.46], [0.55, 0.39], [0.64, 0.5], [0.58, 0.62]], [0, 0.024, 0.034, 0.03, 0.026, 0]]].map(([line, widths]) =>
      atOffsets(boundary(ribbonNodes(line, widths), Array(4).fill(RAJAH.maroon), ["#7f453d", RAJAH.steam, "#d9b0a4", "#7f453d"], true),
        [0, 0.3, 0.7, 1])),
  ]),
  preset("etoile-rails", "Étoile du Nord", "Cassandre's 1927 rails converging on a white star over an airbrushed dusk.", [
    boxEdge("top", ["#a4a7bc", "#7c87ad"]),
    atOffsets(boundary(polylineNodes([[0, ETOILE_HORIZON], [1, ETOILE_HORIZON]]),
      ["#cbc6c6", "#f1eadf", "#cfcac9"], ["#5d5f5a", "#74756e", "#5d5f5a"]), [0, 0.6, 1]),
    boxEdge("bottom", ["#060606"]),
    // Each rail is a thin wedge whose base sits on the box edge: cream inside, ground outside.
    ...[[[0, 0.4], [0, 0.44]], [[0, 0.64], [0, 0.7]], [[0.3, 1], [0.38, 1]], [[0.5, 1], [0.58, 1]], [[1, 0.36], [1, 0.4]]].map(([a, b]) => {
      const apex = lerpPoint(lerpPoint(a, b, 0.5), ETOILE_VANISH, 0.95);
      const [first, last] = a[0] === 1 ? [b, a] : [a, b]; // clockwise on screen: base → apex → base
      return atOffsets(boundary(polylineNodes([first, apex, last]), ["#111111", "#5c5d58", "#111111"],
        ["#f2eadc", "#b9b4aa", "#f2eadc"], true), [0, 0.49, 1]);
    }),
    boundary(starPolygonNodes({ cx: 0.6, cy: 0.105, outer: 0.075, inner: 0.03, points: 5, phase: -Math.PI / 2 }),
      ["#e6dfd8"], ["#fdfaf3"], true),
  ]),
  // ── 1966–1967 San Francisco psychedelic posters ──
  preset("fillmore-vortex", "Fillmore vortex", "Wes Wilson's 1966 Winterland pinwheel: red and blue arms spinning in a blue-rimmed disc.", [
    boundary(ellipseNodes(0.5, 0.5, 0.46), ["#f2ede1"], ["#2f57b6"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.415), ["#2f57b6"], ["#f6f2e8"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.05), ["#f6f2e8"], null, true),
    ...Array.from({ length: 8 }, (_, k) => boundary(
      pinwheelArmNodes({ cx: 0.5, cy: 0.5, r0: 0.075, r1: 0.39, angle: FULL_TURN * k / 8, sweep: 1.5 }),
      [k % 2 ? "#4468c4" : "#d7373d"], [k % 2 ? "#d7373d" : "#4468c4"])),
  ]),
  preset("neon-rose", "Neon rose", "Moscoso's 1967 Neon Rose: vibrating magenta, cyan and yellow ovals around a red rose on green.", [
    boundary(rectNodes(0.05, 0.05, 0.95, 0.95), ["#d23c8c"], ["#1d8fd6"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.37, 0.42), ["#1d8fd6"], ["#f1e54a"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.35, 0.4), ["#f1e54a"], ["#d23c8c"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.29, 0.34), ["#d23c8c"], ["#2e9a57"], true),
    boundary(scallopNodes({ cx: 0.5, cy: 0.52, radius: 0.15, petals: 7, bulge: 0.3, phase: -Math.PI / 2 }), ["#2e9a57"], ["#e4533a"], true),
    point(0.5, 0.52, "#f6a0b8"),
  ]),
  // ── c.1970 flower power / 1977 stripes ──
  preset("flower-power", "Flower power", "Susan Cook's c.1970 Florida print: scalloped marigold and cream blooms on dark olive.", [
    boundary(scallopNodes({ cx: 0.42, cy: 0.44, radius: 0.3, petals: 10, bulge: 0.28 }), ["#3a3312"], ["#d4661a"], true),
    boundary(scallopNodes({ cx: 0.42, cy: 0.44, radius: 0.2, petals: 10, bulge: 0.3, phase: Math.PI / 10 }), ["#f3a93a"], ["#f6e2ad"], true),
    boundary(ellipseNodes(0.42, 0.44, 0.085), ["#e5bd4f"], ["#5a360e"], true),
    boundary(scallopNodes({ cx: 0.81, cy: 0.81, radius: 0.13, petals: 8, bulge: 0.32 }), ["#3a3312"], ["#efbd2e"], true),
    boundary(ellipseNodes(0.81, 0.81, 0.05), ["#f7dc80"], ["#c4521a"], true),
  ]),
  preset("rainbow-bend", "Rainbow bend", "Six 1977 rainbow-logo stripes sweeping in and bending down around one corner on cream.", (() => {
    const stripes = ["#61bb46", "#fdb827", "#f5821f", "#e03a3e", "#963d97", "#009ddc"], cream = "#f5ebd3";
    return Array.from({ length: 7 }, (_, i) => boundary(bendNodes({ y: 0.12 + 0.075 * i, cx: 0.44, cy: 0.64 }),
      [i ? stripes[i - 1] : cream], [stripes[i] ?? cream]));
  })()),
  preset("supergraphic-serpentine", "Supergraphic", "A 1970s wall supergraphic: blue, cream and sand bands winding in one big S across the room.",
    [-0.105, -0.035, 0.035, 0.105].map((d, i, all) => {
      const wall = "#e2d8c5", bands = ["#2e7fd0", "#f7f0e1", "#c6b596"];
      return boundary(serpentineNodes({ y0: 0.16, xR: 0.66, xL: 0.34, r1: 0.18, r2: 0.18, d }),
        [i ? bands[i - 1] : wall], [i < all.length - 1 ? bands[i] : wall]);
    })),
  // ── 1980s airbrush ──
  preset("airbrush-waves", "Airbrush waves", "Laura Smith's 1983 LA Games diver poster: seafoam waves airbrushed into apricot below a plum band.", [
    boundary(polylineNodes([[0, 0.13], [1, 0.13]]), ["#7b4b5d"], ["#f7dcaa"]),
    boxEdge("right", ["#f5d49c", "#f1c887"], 0.2, 1),
    // [left-edge start y, bottom-edge end x, whole/half cycles, anchors (4 per cycle)]
    ...[[0.2, 0.66, 2.5, 11], [0.44, 0.46, 2, 9], [0.68, 0.26, 1, 5]].map(([y, x, cycles, count]) =>
      boundary(wavyLineNodes({ x0: 0, y0: y, x1: x, y1: 1, amplitude: 0.035, cycles, count }), ["#ec9f60"], ["#9fcbba"])),
  ]),
  preset("city-pop", "City pop", "Hiroshi Nagai's 1981 resort: ultramarine sky airbrushed white at the horizon over a turquoise pool.", [
    boxEdge("top", ["#16339a", "#2146aa"]),
    boundary(polylineNodes([[0, 0.55], [1, 0.55]]), ["#f3f6f1", "#e9f1f4"], ["#1a4a9c", "#1d52a6"]),
    boundary(polylineNodes([[0, 0.6], [1, 0.585]]), ["#3a7cc0", "#3a7cc0"], ["#fbf9f1", "#fbf9f1"]),
    boundary(polylineNodes([[0, 0.72], [1, 0.64]]), ["#f1ede0", "#f1ede0"], ["#55cbef", "#3dbcea"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.86, amplitude: 0.012, cycles: 1.25 }), ["#8fdcf5"]),
    boxEdge("bottom", ["#0662b4", "#0a78c4"]),
  ]),
  // ── 1990s–2000s OS wallpapers ──
  preset("aqua-arcs", "Aqua arcs", "Early-2000s glossy desktop wallpaper: fine glowing elliptical arcs on a deep-to-sky blue field.", [
    ...cornerFrame("#3a70b2", "#7ab4dd", "#4b88c4", "#2a5b9f"),
    ...[[0.66, 0.34, 0.52, 0.28, 0.02], [0.72, 0.36, 0.62, 0.38, 0.026], [0.7, 0.3, 0.38, 0.18, 0.016]].map(([cx, cy, rx, ry, w]) =>
      boundary(ribbonNodes(ellipsePoints({ cx, cy, rx, ry, rotation: -0.15, from: 1.25, to: 4.3, count: 6 }),
        [0, 0.7 * w, w, w, 0.7 * w, 0]), ["#5a94cc", "#62a0d6", "#5a94cc"], ["#bfe0f8", "#f4fcff", "#bfe0f8"], true)),
  ]),
  preset("aero-streaks", "Aero streaks", "Mid-2000s glassy desktop aurora: lit lime and cyan ribbons sweeping into a white flare over deep teal.", [
    boxEdge("top", ["#0b5e48", "#04736f", "#0d5c68"]),
    boxEdge("left", ["#0b5e48", "#17835a"], 0, 0.22),
    boxEdge("right", ["#0d5c68"], 0, 0.1),
    boundary(catmullRomNodes([[0, 0.28], [0.2, 0.5], [0.42, 0.76], [0.64, 1]]),
      ["#1e8a64", "#0f8f80", "#1aa39a", "#58c9c9"], ["#b6f07a", "#d6f7a6", "#f2ffe6", "#ffffff"]),
    boundary(catmullRomNodes([[0, 0.52], [0.2, 0.72], [0.4, 0.9], [0.5, 1]]),
      ["#6fbf4e", "#8fd36a", "#c9ef9e", "#e8ffd6"], ["#d9e04a", "#e6ea7a", "#f4f8c8", "#ffffff"]),
    boundary(catmullRomNodes([[0.74, 1], [0.86, 0.72], [0.95, 0.42], [1, 0.14]]),
      ["#bff4f4", "#2aa6b0", "#15808f", "#0f6d7c"], ["#e8fdff", "#7fe3f2", "#3cbded", "#2596c0"]),
    boxEdge("bottom", ["#fbfff4"], 0.66, 0.72),
    boundary(ribbonNodes([[0.28, 0.02], [0.42, 0.4], [0.56, 0.72], [0.68, 0.95]], [0, 0.012, 0.012, 0]),
      ["#0a6d62", "#2aa79f", "#0a6d62"], ["#9ff0c8", "#effff6", "#9ff0c8"], true),
  ]),
  preset("bloom-petals", "Bloom petals", "Early-2020s desktop bloom: electric-blue petals fanning up from a corner, each with a lit edge.", [
    boxEdge("top", ["#b8d0e6", "#c4d8ea"]),
    ...[[0.14, 0.1, "#bcd3e7", "#56baff"], [0.34, 0.3, "#0a74e6", "#3aa9ff"], [0.52, 0.47, "#0664d8", "#2c9dfd"],
      [0.68, 0.63, "#055ad0", "#2296fb"], [0.83, 0.79, "#044fc4", "#1b8cf4"]].map(([x, y, outside, inside]) =>
      boundary([[x, 1, 0, 0, 0, -(1 - y) * 0.75], [1, y, -(1 - x) * 0.75, 0, 0, 0]], [outside], [inside])),
  ]),
  // ── Edo prints ──
  preset("red-fuji", "Red Fuji", "Hokusai's c.1831 Red Fuji: a bokashi-shaded red cone under a Prussian sky, forest at its foot.", [
    boxEdge("top", ["#0f2a6e"]),
    boxEdge("left", ["#1f3f86", "#5f80b4", "#b7d2c6"], 0.04, 0.84),
    atOffsets(boundary([[0, 0.86, 0, 0, 0.25, -0.03], [0.5, 0.53, -0.12, 0.1, 0.12, -0.1], [0.745, 0.2, -0.08, 0.1, 0.02, -0.004],
      [0.8, 0.2, -0.02, 0, 0.05, 0.05], [1, 0.46, -0.08, -0.07, 0, 0]],
    ["#b8d2c6", "#5d80b4", "#3b60a6", "#3b60a6"], ["#7a4a36", "#b23a24", "#4b1e15", "#a4331f"]), [0, 0.45, 0.8, 1]),
    boundary(catmullRomNodes([[0, 0.92], [0.4, 0.78], [0.7, 0.8], [1, 0.84]]), ["#c77a5d"], ["#43604f"]),
    boxEdge("bottom", ["#243434", "#34483f"]),
    ...[[[0.755, 0.23], [0.7, 0.33]], [[0.775, 0.23], [0.785, 0.36]], [[0.795, 0.23], [0.86, 0.32]]].map(([a, b]) =>
      boundary(polylineNodes([a, b]), ["#f6f1e6", "#e2d4c4", "#8c3120"])),
  ]),
  preset("seigaiha-waves", "Seigaiha", "Edo seigaiha wave scales, each crescent shaded from a pale rim into deep indigo.", (() => {
    const deep = "#18305f", rim = "#d6e6f1", r = 0.25;
    const semis = [[0.25, 1], [0.75, 1], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25]].map(([cx, cy]) =>
      boundary(arcNodes({ cx, cy, rx: r, from: Math.PI, to: FULL_TURN }), [deep], [rim]));
    const quarters = [[0, 0.75], [0, 0.25]].flatMap(([, cy]) => [
      boundary(arcNodes({ cx: 0, cy, rx: r, from: -Math.PI / 2, to: 0 }), [deep], [rim]),
      boundary(arcNodes({ cx: 1, cy, rx: r, from: Math.PI, to: 1.5 * Math.PI }), [deep], [rim])]);
    return [boxEdge("top", ["#5a7eab"]), boxEdge("bottom", [deep]), ...semis, ...quarters];
  })()),
  // ── 1969 op art / 1990s screensavers ──
  preset("record-swirl", "Record swirl", "A 1969 progressive-rock record-label swirl: ink and cream rings nesting down into a hypnotic eye.",
    Array.from({ length: 9 }, (_, k) => boundary(ellipseNodes(0.5, 0.5 + 0.034 * k, 0.46 - 0.052 * k),
      [k % 2 ? "#1b1714" : "#f1e9d6"], [k % 2 ? "#f1e9d6" : "#1b1714"], true))),
  preset("screensaver-trails", "Screensaver trails", "A 1990s desktop screensaver: two neon quadrilaterals trailing echoes across black.",
    [[[[0.06, 0.2], [0.6, 0.06], [0.5, 0.5], [0.14, 0.44]], "#5ff6ff", "#1f7fc4"],
      [[[0.46, 0.6], [0.94, 0.5], [0.88, 0.94], [0.54, 0.96]], "#ff5ce1", "#8f2fa8"]].flatMap(([quad, head, trail]) =>
      [[-0.018, "#03040a"], [0, head], [0.018, "#03040a"], [0.036, trail], [0.054, "#03040a"]].map(([d, color]) =>
        boundary(polylineNodes(insetConvex(quad, d)), [color], null, true)))),
  // ── Y2K / 2020s ──
  preset("bondi-blobs", "Bondi blobs", "Y2K blobjects: a translucent Bondi-blue drop and an iridescent chrome bead on frosted white.", [
    ...cornerFrame("#f5f8fb", "#e5eef5", "#dde7f0", "#eef3f8"),
    boundary(ellipseNodes(0.42, 0.56, 0.27, 0.3), ["#e8eff5"], ["#0b8995"], true),
    boundary(ellipseNodes(0.4, 0.52, 0.16, 0.18), ["#63cdd0"], null, true),
    point(0.34, 0.42, "#e8fbfa"),
    boundary(ellipseNodes(0.77, 0.25, 0.13), Array(4).fill("#e6eef5"), ["#c7b6ff", "#a6f0da", "#ffc4e6", "#c7b6ff"], true),
    point(0.73, 0.21, "#ffffff"),
  ]),
];

