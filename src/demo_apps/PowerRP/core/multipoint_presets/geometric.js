/**
 * Geometric family: hard-edged graphic compositions. Crisp edges come from
 * TWO-SIDED boundaries (different colour on each side); softness lives inside
 * regions, where diffusion blends each boundary's own colour ramp.
 * Orientation rule used throughout: a closed shape traced CLOCKWISE on screen
 * (y down) has its rightColor INSIDE; an open curve's rightColor is on the
 * screen-clockwise side of its travel direction (heading east → below).
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, finiteGeometry, polylineNodes, mixHex } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
const TOP = -Math.PI / 2; // screen-up angle, since y points down
const MAX_ARC_STEP = Math.PI / 2; // one cubic per quarter turn; radial error < 0.03%
const PARALLEL_EPSILON = 1e-12;

/**
 * Pure function. Corners of a regular polygon, clockwise on screen from `rotation`.
 * @param {object} options - {cx,cy,radius,sides,rotation=-π/2}; radius is the circumradius.
 * @returns {number[][]} [sides,2] (x,y) vertices.
 * @example regularPolygonVertices({cx:0.5,cy:0.5,radius:0.5,sides:4,rotation:0})[1] // [0.5,1]
 */
export function regularPolygonVertices({ cx, cy, radius, sides, rotation = TOP }) {
  finiteGeometry([cx, cy, radius, sides, rotation]);
  if (radius <= 0 || !Number.isInteger(sides) || sides < 3) throw new Error("Regular polygon needs a positive radius and 3+ integer sides");
  return Array.from({ length: sides }, (_, i) => {
    const angle = rotation + FULL_TURN * i / sides;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

/**
 * Pure function. Star corners alternating outer tip / inner notch, clockwise on screen.
 * A regular five-point star has innerRadius ≈ 0.382·outerRadius.
 * @param {object} options - {cx,cy,outerRadius,innerRadius,points,rotation=-π/2}; first vertex is a tip.
 * @returns {number[][]} [2·points,2] (x,y) vertices.
 * @example starVertices({cx:0,cy:0,outerRadius:1,innerRadius:0.5,points:4,rotation:0}).slice(0,2) // [[1,0],[0.354,0.354]] (rounded)
 */
export function starVertices({ cx, cy, outerRadius, innerRadius, points, rotation = TOP }) {
  finiteGeometry([cx, cy, outerRadius, innerRadius, points, rotation]);
  if (outerRadius <= 0 || innerRadius <= 0 || !Number.isInteger(points) || points < 2) throw new Error("Star needs positive radii and 2+ integer points");
  return Array.from({ length: 2 * points }, (_, i) => {
    const angle = rotation + Math.PI * i / points, radius = i % 2 ? innerRadius : outerRadius;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

/**
 * Pure function. Shoelace signed area; POSITIVE means clockwise on screen (y down).
 * @param {number[][]} vertices - [N,2] closed-polygon corners.
 * @returns {number} Signed area.
 * @example signedArea([[0,0],[1,0],[1,1],[0,1]]) // 1
 */
export function signedArea(vertices) {
  return vertices.reduce((sum, [x, y], i) => {
    const [nx, ny] = vertices[(i + 1) % vertices.length];
    return sum + x * ny - nx * y;
  }, 0) / 2;
}

/**
 * Pure function. Intersection of lines p + s·u and q + t·v; parallel lines return null.
 * @param {number[]} p - Point on the first line [2].
 * @param {number[]} u - First direction [2].
 * @param {number[]} q - Point on the second line [2].
 * @param {number[]} v - Second direction [2].
 * @returns {number[]|null} (x,y) or null.
 * @example lineIntersection([0,0],[1,0],[0.5,-1],[0,1]) // [0.5,0]
 */
export function lineIntersection(p, u, q, v) {
  const det = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(det) < PARALLEL_EPSILON) return null;
  const s = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det;
  return [p[0] + s * u[0], p[1] + s * u[1]];
}

/**
 * Pure function. Offsets an open polyline sideways with mitred joins.
 * Positive distance moves to the screen-RIGHT of travel (heading east → down).
 * @param {number[][]} points - [N,2] (x,y), N >= 2, no zero-length segments.
 * @param {number} distance - Signed offset.
 * @returns {number[][]} [N,2] offset vertices.
 * @example offsetPolyline([[0,0],[1,0],[1,1]], 0.1) // [[0,0.1],[0.9,0.1],[0.9,1]]
 */
export function offsetPolyline(points, distance) {
  finiteGeometry([...points.flat(), distance]);
  const segments = points.slice(1).map((b, i) => {
    const a = points[i], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) throw new Error("offsetPolyline segments must have nonzero length");
    const n = [-dy / length * distance, dx / length * distance];
    return { a: [a[0] + n[0], a[1] + n[1]], b: [b[0] + n[0], b[1] + n[1]], u: [dx, dy] };
  });
  return points.map((_, i) => {
    if (i === 0) return segments[0].a;
    if (i === points.length - 1) return segments.at(-1).b;
    return lineIntersection(segments[i - 1].a, segments[i - 1].u, segments[i].a, segments[i].u) ?? segments[i].a;
  });
}

/**
 * Pure function. Closed outline of a thick straight stroke: mitred joins, butt caps.
 * Traced clockwise on screen, so a boundary's rightColor fills the stroke.
 * @param {number[][]} points - [N,2] centreline (x,y).
 * @param {number} halfWidth - Positive half thickness.
 * @returns {number[][]} [2N,2] (x,y) outline vertices.
 * @example strokeVertices([[0,0.5],[1,0.5]], 0.1) // [[0,0.4],[1,0.4],[1,0.6],[0,0.6]]
 */
export function strokeVertices(points, halfWidth) {
  if (!(halfWidth > 0)) throw new Error("strokeVertices needs a positive half width");
  return [...offsetPolyline(points, -halfWidth), ...offsetPolyline(points, halfWidth).reverse()];
}

/**
 * Pure function. Shrinks a CONVEX polygon by moving every edge inward a fixed distance.
 * Exact for convex input; used to leave uniform seams between touching tiles.
 * @param {number[][]} vertices - [N,2] convex corners, either orientation.
 * @param {number} distance - Nonnegative inset, smaller than the inradius.
 * @returns {number[][]} [N,2] inset corners, same orientation.
 * @example insetPolygon([[0,0],[1,0],[1,1],[0,1]], 0.1) // [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]
 */
export function insetPolygon(vertices, distance) {
  finiteGeometry([...vertices.flat(), distance]);
  const sign = Math.sign(signedArea(vertices));
  if (!sign || distance < 0) throw new Error("insetPolygon needs a nondegenerate polygon and nonnegative distance");
  const n = vertices.length;
  const edges = vertices.map((a, i) => {
    const b = vertices[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const k = sign * distance / length; // inward = screen-right for clockwise (positive) polygons
    return { p: [a[0] - dy * k, a[1] + dx * k], u: [dx, dy] };
  });
  return vertices.map((_, i) => {
    const hit = lineIntersection(edges[(i + n - 1) % n].p, edges[(i + n - 1) % n].u, edges[i].p, edges[i].u);
    if (!hit) throw new Error("insetPolygon hit parallel adjacent edges");
    return hit;
  });
}

/**
 * Pure function. Circular arc as cubics of at most a quarter turn, with exact
 * circle-tangent handles k = (4/3)·tan(step/4)·r. Increasing angle is clockwise
 * on screen. Open-end handles are zero so the arc's ends carry no stray controls.
 * @param {object} options - {cx,cy,radius,startAngle,endAngle}; angles in radians, sweep nonzero.
 * @returns {number[][]} [ceil(|sweep|/(π/2))+1, 6] anchor/relative-handle tuples.
 * @example arcNodes({cx:0,cy:0,radius:1,startAngle:0,endAngle:Math.PI/2}).map(n => n.slice(0,2)) // [[1,0],[0,1]] (rounded)
 */
export function arcNodes({ cx, cy, radius, startAngle, endAngle }) {
  const sweep = endAngle - startAngle;
  finiteGeometry([cx, cy, radius, startAngle, endAngle]);
  if (radius <= 0 || !sweep) throw new Error("Arc needs a positive radius and nonzero sweep");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ARC_STEP), step = sweep / segments;
  const k = (4 / 3) * Math.tan(step / 4) * radius;
  return Array.from({ length: segments + 1 }, (_, i) => {
    const angle = startAngle + step * i, c = Math.cos(angle), s = Math.sin(angle);
    const hx = -s * k, hy = c * k;
    return [cx + radius * c, cy + radius * s, i ? -hx : 0, i ? -hy : 0, i < segments ? hx : 0, i < segments ? hy : 0];
  });
}

/**
 * Pure function. Closed outline of a thick smooth stroke around a parametric
 * centreline, via the exact offset tangent o' = c' + h·n' (needs c''). Butt caps;
 * traced clockwise on screen, so a boundary's rightColor fills the ribbon.
 * @param {function} curve - t∈[0,1] → [x,y,dx/dt,dy/dt,d²x/dt²,d²y/dt²].
 * @param {number} halfWidth - Positive half thickness (keep below the curve's radius of curvature).
 * @param {number} segments - Cubic spans per side; nodes = 2·(segments+1).
 * @returns {number[][]} [2·(segments+1),6] anchor/relative-handle tuples.
 * @example ribbonNodes((t) => [t, 0.5, 1, 0, 0, 0], 0.1, 1).map(n => n.slice(0,2)) // [[0,0.4],[1,0.4],[1,0.6],[0,0.6]]
 */
export function ribbonNodes(curve, halfWidth, segments) {
  if (!(halfWidth > 0) || !Number.isInteger(segments) || segments < 1) throw new Error("ribbonNodes needs a positive half width and 1+ segments");
  const side = (h) => Array.from({ length: segments + 1 }, (_, i) => {
    const sample = curve(i / segments);
    finiteGeometry(sample);
    const [x, y, dx, dy, ddx, ddy] = sample, speed = Math.hypot(dx, dy);
    if (!speed) throw new Error("ribbonNodes centreline must have nonzero speed");
    // Unit right normal n = (−dy, dx)/|c'|; n' = perp(c'')/|c'| − perp(c')·(c'·c'')/|c'|³.
    const dot = (dx * ddx + dy * ddy) / speed ** 3;
    const nx = -dy / speed, ny = dx / speed, dnx = -ddy / speed + dy * dot, dny = ddx / speed - dx * dot;
    return [x + h * nx, y + h * ny, dx + h * dnx, dy + h * dny];
  });
  const left = hermiteNodes(side(-halfWidth), 1 / segments);
  const right = hermiteNodes(side(halfWidth), 1 / segments).reverse().map(([x, y, ix, iy, ox, oy]) => [x, y, ox, oy, ix, iy]);
  // Butt caps: the four corner handles facing a cap are zero, so caps are straight.
  for (const node of [left[0], right[0]]) node.splice(2, 2, 0, 0);
  for (const node of [left.at(-1), right.at(-1)]) node.splice(4, 2, 0, 0);
  return [...left, ...right];
}

/**
 * Pure function. Closed straight-edged shape; asserts clockwise so `inside` really is inside.
 * @param {number[][]} vertices - [N,2] clockwise-on-screen corners.
 * @param {string[]} inside - Interior ramp (first colour repeated at the end if multi-stop).
 * @param {string[]} outside - Exterior ramp, same length.
 * @returns {object} Two-sided closed feature.
 * @example shape([[0,0],[1,0],[0,1]], ["#ff0000"], ["#ffffff"]).stops[0].rightColor // "#ff0000"
 */
function shape(vertices, inside, outside) {
  if (!(signedArea(vertices) > 0)) throw new Error("shape vertices must run clockwise on screen");
  return boundary(polylineNodes(vertices), outside, inside, true);
}

/**
 * Pure function. Two-sided closed ellipse: ellipseNodes run clockwise, so rightColor is inside.
 * @param {number[]} circle - [cx,cy,rx,ry?].
 * @param {string[]} inside - Interior ramp starting at the rightmost point.
 * @param {string[]} outside - Exterior ramp, same length.
 * @returns {object} Two-sided closed feature.
 * @example disc([0.5,0.5,0.2], ["#ff0000"], ["#ffffff"]).closed // true
 */
function disc([cx, cy, rx, ry = rx], inside, outside) {
  return boundary(ellipseNodes(cx, cy, rx, ry), outside, inside, true);
}

// ───────────────────────── compositions ─────────────────────────
// Numeric rows below are authored composition data (unit-box positions, sizes,
// palettes), not solver parameters.

const BAUHAUS_PAPER = "#eee3c8", BAUHAUS_SQUARE_TILT = 0.2; // radians clockwise
const bauhaus = preset("bauhaus-balance", "Bauhaus", "A red circle, blue triangle, yellow square and black bar balanced on warm paper.", [
  disc([0.36, 0.39, 0.25], ["#e84a30", "#c02e28", "#f47a52", "#e84a30"], [BAUHAUS_PAPER, BAUHAUS_PAPER, BAUHAUS_PAPER, BAUHAUS_PAPER]),
  shape([[0.75, 0.47], [0.97, 0.91], [0.53, 0.91]], ["#3968c0", "#1c3a82", "#3968c0"], [BAUHAUS_PAPER, BAUHAUS_PAPER, BAUHAUS_PAPER]),
  shape(regularPolygonVertices({ cx: 0.78, cy: 0.21, radius: 0.17, sides: 4, rotation: BAUHAUS_SQUARE_TILT - 3 * Math.PI / 4 }),
    ["#fad04a", "#eaa51e", "#fad04a"], [BAUHAUS_PAPER, BAUHAUS_PAPER, BAUHAUS_PAPER]),
  shape([[0.09, 0.78], [0.45, 0.78], [0.45, 0.84], [0.09, 0.84]], ["#2a2622"], [BAUHAUS_PAPER]),
  point(0.06, 0.06, "#f6eedb"), point(0.05, 0.95, "#e2d2b0"),
]);

/**
 * Pure function. Sine centreline with first and second derivatives, for ribbonNodes.
 * @param {object} options - {x0,x1,y,amplitude,cycles,phase=0}.
 * @returns {function} t → [x,y,dx,dy,ddx,ddy].
 * @example sineCurve({x0:0,x1:1,y:0.5,amplitude:0.1,cycles:1})(0.25).slice(0,2) // [0.25,0.6]
 */
export function sineCurve({ x0, x1, y, amplitude, cycles, phase = 0 }) {
  finiteGeometry([x0, x1, y, amplitude, cycles, phase]);
  const w = FULL_TURN * cycles;
  return (t) => {
    const a = w * t + phase;
    return [x0 + (x1 - x0) * t, y + amplitude * Math.sin(a), x1 - x0, amplitude * w * Math.cos(a), 0, -amplitude * w * w * Math.sin(a)];
  };
}

const MEMPHIS_GROUND = "#fbe9e4";
const memphis = preset("memphis-party", "Memphis", "A teal squiggle, black zigzag, yellow dot, blue ring and pink triangle scattered on blush.", [
  boundary(ribbonNodes(sineCurve({ x0: 0.06, x1: 0.54, y: 0.2, amplitude: 0.065, cycles: 1.25 }), 0.033, 5),
    [MEMPHIS_GROUND], ["#2ec4b6"], true),
  shape(strokeVertices([[0.38, 0.9], [0.5, 0.74], [0.62, 0.9], [0.74, 0.74], [0.86, 0.9]], 0.028), ["#23203a"], [MEMPHIS_GROUND]),
  disc([0.8, 0.3, 0.13], ["#ffd23f", "#f5a524", "#ffd23f"], [MEMPHIS_GROUND, MEMPHIS_GROUND, MEMPHIS_GROUND]),
  shape([[0.2, 0.47], [0.36, 0.76], [0.06, 0.72]], ["#ff5d8f", "#e0356d", "#ff5d8f"], [MEMPHIS_GROUND, MEMPHIS_GROUND, MEMPHIS_GROUND]),
  disc([0.52, 0.53, 0.075], ["#4d7cff"], [MEMPHIS_GROUND]), disc([0.52, 0.53, 0.04], [MEMPHIS_GROUND], ["#4d7cff"]),
  point(0.05, 0.95, "#fff1dc"), point(0.97, 0.03, "#fde0ec"),
]);

const CHEVRON_BANDS = ["#eaf8f1", "#a3e4cf", "#43c2ae", "#1c8c97", "#175a7c", "#152c52"];
const chevrons = preset("chevron-stack", "Chevrons", "Folded V bands stepping from sea foam through teal to deep navy.",
  [-0.12, 0.1, 0.32, 0.54, 0.76].map((y, i) => boundary(polylineNodes([[-0.08, y], [0.5, y + 0.24], [1.08, y]]),
    [mixHex(CHEVRON_BANDS[i], "#ffffff", 0.18), CHEVRON_BANDS[i], mixHex(CHEVRON_BANDS[i], "#000000", 0.12)],
    [mixHex(CHEVRON_BANDS[i + 1], "#ffffff", 0.18), CHEVRON_BANDS[i + 1], mixHex(CHEVRON_BANDS[i + 1], "#000000", 0.12)])));

/**
 * Pure function. Bevel shade for a clockwise edge a→b lit from `light` (unit, screen coords).
 * @param {number[]} a - Edge start [2].
 * @param {number[]} b - Edge end [2].
 * @param {number[]} light - Unit direction TOWARD the light.
 * @returns {number} Brightness in [0,1]; 1 faces the light.
 * @example edgeLight([0,0],[1,0],[0,-1]) // 1
 */
export function edgeLight(a, b, light) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  return 0.5 + 0.5 * (dy * light[0] - dx * light[1]) / length;
}

const UPPER_LEFT_LIGHT = [-0.55, -0.835];
const STAR_CENTER = [0.5, 0.53];
const STAR = starVertices({ cx: STAR_CENTER[0], cy: STAR_CENTER[1], outerRadius: 0.45, innerRadius: 0.19, points: 5 });
const starFacet = (j) => mixHex("#9c5a12", "#ffe98a", edgeLight(STAR[j], STAR[(j + 1) % STAR.length], UPPER_LEFT_LIGHT));
const facetedStar = preset("faceted-star", "Faceted star", "A bevelled gold star whose ten facets catch light from the upper left.", [
  shape(STAR, ["#e0a83a"], ["#1a2250"]),
  ...STAR.map((v, j) => boundary(polylineNodes([STAR_CENTER, v]), [starFacet((j + 9) % 10)], [starFacet(j)])),
  point(0.08, 0.08, "#2c3a7a"),
]);

/**
 * Pure function. Three rhombus faces of an isometric cube (pointy-top hexagon), each clockwise.
 * @param {number} cx - Hexagon centre x.
 * @param {number} cy - Hexagon centre y.
 * @param {number} r - Circumradius.
 * @returns {number[][][]} [3,4,2] faces in order top, right, left.
 * @example isoCubeFaces(0,0,1)[0][1] // [0,-1]
 */
export function isoCubeFaces(cx, cy, r) {
  const [t, ur, lr, b, ll, ul] = regularPolygonVertices({ cx, cy, radius: r, sides: 6 });
  const c = [cx, cy];
  return [[ul, t, ur, c], [c, ur, lr, b], [ul, c, b, ll]];
}

const BLOCK_SEAM = "#1d2030", BLOCK_GAP = 0.013, BLOCK_RADIUS = 0.24;
const tumblingBlocks = preset("tumbling-blocks", "Tumbling blocks", "Three stacked isometric cubes in teal, coral and gold with dark seams.",
  [[0.5, 0.32, ["#aef0e2", "#2e9f97", "#185b67"]], [0.292, 0.68, ["#ffd1bd", "#ec6a5c", "#98334a"]], [0.708, 0.68, ["#fff0b8", "#f0b23e", "#a8661c"]]]
    .flatMap(([cx, cy, tones]) => isoCubeFaces(cx, cy, BLOCK_RADIUS).map((face, f) => shape(insetPolygon(face, BLOCK_GAP),
      [tones[f], mixHex(tones[f], "#000000", 0.14), tones[f]], [BLOCK_SEAM, BLOCK_SEAM, BLOCK_SEAM])))
    .concat([point(0.06, 0.06, "#2b3148"), point(0.94, 0.94, "#12141e")]));

/**
 * Pure function. Where a ray from (cx,cy) at `angle` leaves the square [lo,hi]².
 * @param {number} cx - Origin x (inside the square).
 * @param {number} cy - Origin y (inside the square).
 * @param {number} angle - Direction, radians (screen: increasing is clockwise).
 * @param {number} lo - Square minimum.
 * @param {number} hi - Square maximum.
 * @returns {number[]} (x,y) exit point.
 * @example rayExit(0.5,0.5,0,0,1) // [1,0.5]
 */
export function rayExit(cx, cy, angle, lo, hi) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const reach = (p, d) => (Math.abs(d) < PARALLEL_EPSILON ? Infinity : ((d > 0 ? hi : lo) - p) / d);
  const t = Math.min(reach(cx, dx), reach(cy, dy));
  return [cx + t * dx, cy + t * dy];
}

const SUN = [0.5, 0.99], SUN_RADIUS = 0.2, RAY_GAP = 0.05, WEDGES = 10;
const SUN_WEDGE = [["#fff4dc", "#ffe0ae"], ["#ffab5e", "#f0723c"]]; // [near, far] cream / tangerine
const sunburst = preset("retro-sunburst", "Sunburst", "Alternating cream and tangerine rays fanning from a low golden sun.", [
  disc([...SUN, SUN_RADIUS], ["#ffe066", "#ffc53d", "#fff3b0", "#ffe066"], ["#ffe7b8", "#ffe7b8", "#ffe7b8", "#ffe7b8"]),
  ...Array.from({ length: WEDGES - 1 }, (_, i) => {
    const angle = Math.PI + Math.PI * (i + 1) / WEDGES, c = Math.cos(angle), s = Math.sin(angle);
    const start = [SUN[0] + (SUN_RADIUS + RAY_GAP) * c, SUN[1] + (SUN_RADIUS + RAY_GAP) * s];
    const [before, after] = i % 2 ? [SUN_WEDGE[1], SUN_WEDGE[0]] : [SUN_WEDGE[0], SUN_WEDGE[1]];
    return boundary(polylineNodes([start, rayExit(...SUN, angle, -0.04, 1.04)]), before, after);
  }),
]);

const STRIPES = ["#ff3d7f", "#ffd84d", "#3ddcc0", "#ff8a3d", "#8b4bff", "#4ad4ff"];
const STRIPE_ANGLE = -Math.PI / 4; // boundaries run up-right; rightColor is the lower-right stripe
const boldStripes = preset("bold-stripes", "Bold stripes", "Six crisp diagonal candy stripes, each glowing brighter toward the top.",
  STRIPES.slice(0, -1).map((_, i) => {
    const c = 2 * (i + 1) / STRIPES.length, through = [c / 2, c / 2]; // on the line x + y = c
    return boundary(polylineNodes([rayExit(...through, STRIPE_ANGLE + Math.PI, -0.06, 1.06), rayExit(...through, STRIPE_ANGLE, -0.06, 1.06)]),
      [mixHex(STRIPES[i], "#000000", 0.18), STRIPES[i], mixHex(STRIPES[i], "#ffffff", 0.3)],
      [mixHex(STRIPES[i + 1], "#000000", 0.18), STRIPES[i + 1], mixHex(STRIPES[i + 1], "#ffffff", 0.3)]);
  }));

/**
 * Pure function. A circle split along a diameter: two arcs and the dividing chord.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Radius.
 * @param {number} angle - Diameter direction; the `first` half spans angle..angle+π (clockwise).
 * @param {string[]} first - Ramp of the first half.
 * @param {string[]} second - Ramp of the second half.
 * @param {string} ground - Colour outside the circle.
 * @returns {object[]} Three two-sided features.
 * @example splitCircle(0.5,0.5,0.3,0,["#ff0000"],["#0000ff"],"#ffffff").length // 3
 */
function splitCircle(cx, cy, r, angle, first, second, ground) {
  const at = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const groundRamp = first.map(() => ground);
  return [
    boundary(arcNodes({ cx, cy, radius: r, startAngle: angle, endAngle: angle + Math.PI }), groundRamp, first),
    boundary(arcNodes({ cx, cy, radius: r, startAngle: angle + Math.PI, endAngle: angle + FULL_TURN }), groundRamp, second),
    boundary(polylineNodes([at(angle + Math.PI), at(angle)]), [second[Math.floor(second.length / 2)]], [first[Math.floor(first.length / 2)]]),
  ];
}

const SPLIT_GROUND = "#1f2a3c";
const splitCircles = preset("split-circles", "Split circles", "Two diagonally halved discs in coral, peach and mustard on deep slate.", [
  ...splitCircle(0.4, 0.42, 0.3, -Math.PI / 5, ["#ff8a66", "#e8543f"], ["#ffe3c4", "#f7c49a"], SPLIT_GROUND),
  ...splitCircle(0.77, 0.79, 0.15, Math.PI / 3, ["#ffe3c4", "#f7c49a"], ["#f7bd45", "#e39424"], SPLIT_GROUND),
  point(0.05, 0.95, "#151d2b"), point(0.95, 0.05, "#2b3a52"),
]);

const SWISS_PAPER = "#efece5";
const swiss = preset("swiss-poster", "Swiss poster", "An oversized red disc cropped by the corner, cut across by a black bar.", [
  disc([0.68, 0.3, 0.38], ["#e5302b", "#c21f24", "#f0513f", "#e5302b"], [SWISS_PAPER, SWISS_PAPER, SWISS_PAPER, SWISS_PAPER]),
  shape(strokeVertices([[-0.06, 0.96], [1.06, 0.74]], 0.045), ["#1b1b1b", "#3a3a3a", "#1b1b1b"], [SWISS_PAPER, SWISS_PAPER, SWISS_PAPER]),
  disc([0.15, 0.22, 0.06], ["#1b1b1b"], [SWISS_PAPER]),
  shape(strokeVertices([[-0.06, 0.86], [1.06, 0.64]], 0.011), ["#1b1b1b"], [SWISS_PAPER]),
  shape([[0.1, 0.5], [0.22, 0.5], [0.22, 0.62], [0.1, 0.62]], ["#e5302b"], [SWISS_PAPER]),
  point(0.04, 0.55, "#f7f5f0"), point(0.96, 0.96, "#dedad0"),
]);

const FAN_PIVOT = [0.5, 1.0], FAN_INNER = 0.2, FAN_OUTER = 0.62, FAN_BAND = [0.67, 0.7], FAN_SWEEP = [0.97, 2.03], PLEATS = 8;
const decoFan = preset("deco-fan", "Deco fan", "A pleated gold fan with shaded ribs and a gilt rim rising over deep emerald.", [
  disc([...FAN_PIVOT, FAN_INNER], ["#ffe9a0", "#f5c451", "#fff4c4", "#ffe9a0"], ["#c8943a", "#c8943a", "#c8943a", "#c8943a"]),
  boundary(arcNodes({ cx: FAN_PIVOT[0], cy: FAN_PIVOT[1], radius: FAN_OUTER, startAngle: Math.PI * FAN_SWEEP[0], endAngle: Math.PI * FAN_SWEEP[1] }),
    ["#0d2b25", "#0f332c", "#0d2b25"], ["#b07d2c", "#d9a444", "#b07d2c"]),
  ...Array.from({ length: PLEATS - 1 }, (_, i) => {
    const angle = Math.PI + Math.PI * (i + 1) / PLEATS, c = Math.cos(angle), s = Math.sin(angle);
    const at = (r) => [FAN_PIVOT[0] + r * c, FAN_PIVOT[1] + r * s];
    return boundary(polylineNodes([at(FAN_INNER + 0.01), at(FAN_OUTER - 0.01)]), ["#7a4f16", "#8f5f1c"], ["#ffe7a3", "#f6cf72"]);
  }),
  ...FAN_BAND.map((radius, i) => boundary(arcNodes({ cx: FAN_PIVOT[0], cy: FAN_PIVOT[1], radius, startAngle: Math.PI * FAN_SWEEP[0], endAngle: Math.PI * FAN_SWEEP[1] }),
    // Increasing angle runs clockwise, so rightColor faces the pivot: inner arc = gap|band, outer = band|field.
    i ? ["#0d2b25", "#123a31", "#0d2b25"] : ["#c9973e", "#f3cc6c", "#c9973e"], i ? ["#e2b458", "#ffe08a", "#e2b458"] : ["#0d2b25", "#0f332c", "#0d2b25"])),
  point(0.5, 0.06, "#1a4a3e"),
]);

// Low-poly triangulation of a jittered 4×3 lattice; outer corners sit past the box edge.
const LATTICE = [
  [[-0.03, -0.03], [0.36, -0.03], [0.68, -0.03], [1.03, -0.03]],
  [[-0.03, 0.46], [0.3, 0.55], [0.72, 0.42], [1.03, 0.56]],
  [[-0.03, 1.03], [0.4, 1.03], [0.64, 1.03], [1.03, 1.03]],
];
const MOSAIC_RAMP = ["#2de2c4", "#3a86ff", "#8338ec", "#ff006e"]; // top-left → bottom-right
const MOSAIC_SEAM = "#16122b", MOSAIC_GAP = 0.011;
/**
 * Pure function. Piecewise-linear colour ramp with evenly spaced stops.
 * @param {string[]} colors - [K>=2] #rrggbb stops at i/(K−1).
 * @param {number} t - Position, clamped to [0,1].
 * @returns {string} #rrggbb.
 * @example rampHex(["#000000","#ffffff","#000000"], 0.25) // "#808080"
 */
export function rampHex(colors, t) {
  const u = Math.min(1, Math.max(0, t)) * (colors.length - 1), i = Math.min(colors.length - 2, Math.floor(u));
  return mixHex(colors[i], colors[i + 1], u - i);
}
const mosaicTriangles = LATTICE.slice(0, -1).flatMap((row, r) => row.slice(0, -1).flatMap((tl, c) => {
  const tr = row[c + 1], bl = LATTICE[r + 1][c], br = LATTICE[r + 1][c + 1];
  return (r + c) % 2 ? [[tl, tr, bl], [tr, br, bl]] : [[tl, tr, br], [tl, br, bl]];
}));
const triangleMosaic = preset("triangle-mosaic", "Triangle mosaic", "Twelve low-poly shards sliding from aqua through blue and violet to magenta.",
  mosaicTriangles.map((tri, i) => {
    const [x, y] = [0, 1].map((axis) => tri.reduce((sum, v) => sum + v[axis], 0) / 3);
    const base = rampHex(MOSAIC_RAMP, (x + y) / 2), lit = mixHex(base, i % 2 ? "#000000" : "#ffffff", 0.12);
    return shape(insetPolygon(tri, MOSAIC_GAP), [lit, base, lit], [MOSAIC_SEAM, MOSAIC_SEAM, MOSAIC_SEAM]);
  }));

const HEX_RADIUS = 0.3, HEX_WALL = 0.02; // pointy-top lattice: columns 2·0.866·R apart, rows 1.5·R
const HONEY_CELLS = [[0.24, 0.22], [0.76, 0.22], [-0.02, 0.67], [0.5, 0.67], [1.02, 0.67]];
const honeycomb = preset("honey-cells", "Honeycomb", "Five amber hexagon cells glowing honey-gold between dark wax walls.", [
  ...HONEY_CELLS.flatMap(([cx, cy], i) => [
    shape(insetPolygon(regularPolygonVertices({ cx, cy, radius: HEX_RADIUS, sides: 6 }), HEX_WALL),
      ["#ffd66b", mixHex("#e8961a", "#b8600e", i / 4), "#ffd66b"], ["#3a230c", "#3a230c", "#3a230c"]),
    point(cx, cy, "#fff3c2"),
  ]),
  point(0.24, 0.98, "#2a180a"), point(0.76, 0.98, "#3a230c"),
]);

/**
 * Pure function. Edges shared by two facets of a clockwise facet mesh, with sides.
 * A clockwise facet lies to the RIGHT of each of its own edges, so the facet
 * traversing a→b is the right side of edge (a,b), a < b.
 * @param {number[][]} facets - [F][k] vertex-index cycles, each clockwise on screen.
 * @returns {{a:number,b:number,left:number,right:number}[]} One entry per interior edge.
 * @example sharedEdges([[0,1,2],[0,2,3]]) // [{a:0,b:2,left:0,right:1}]
 */
export function sharedEdges(facets) {
  const owner = new Map();
  facets.forEach((cycle, f) => cycle.forEach((a, i) => owner.set(`${a},${cycle[(i + 1) % cycle.length]}`, f)));
  return [...owner].flatMap(([key, f]) => {
    const [a, b] = key.split(",").map(Number), twin = owner.get(`${b},${a}`);
    return a < b && twin !== undefined ? [{ a, b, left: twin, right: f }] : [];
  });
}

// Brilliant-cut profile: table, girdle points and culet; facets are clockwise index cycles.
const GEM_POINTS = [[0.33, 0.2], [0.67, 0.2], [0.9, 0.41], [0.5, 0.9], [0.1, 0.41], [0.3, 0.41], [0.5, 0.41], [0.7, 0.41]];
const GEM_OUTLINE = [0, 1, 2, 3, 4];
const GEM_FACETS = [[4, 0, 5], [0, 6, 5], [0, 1, 6], [1, 7, 6], [1, 2, 7], [4, 5, 3], [5, 6, 3], [6, 7, 3], [7, 2, 3]];
const GEM_TONES = ["#6fcbf2", "#c9f2ff", "#effcff", "#98dcf7", "#3f9bdb", "#4aaee6", "#b2e9fc", "#2f7fcb", "#1d4f9c"];
const gem = preset("cut-diamond", "Cut diamond", "An ice-blue brilliant with nine crisp facets on a blush ground.", [
  shape(GEM_OUTLINE.map((i) => GEM_POINTS[i]), ["#7fcdf2", "#7fcdf2", "#7fcdf2"], ["#fcf0f4", "#e7cadc", "#fcf0f4"]),
  ...sharedEdges(GEM_FACETS).map(({ a, b, left, right }) =>
    boundary(polylineNodes([GEM_POINTS[a], GEM_POINTS[b]]), [GEM_TONES[left]], [GEM_TONES[right]])),
]);

export const PRESETS = [bauhaus, memphis, chevrons, facetedStar, tumblingBlocks, sunburst, boldStripes,
  splitCircles, swiss, decoFan, triangleMosaic, honeycomb, gem];
