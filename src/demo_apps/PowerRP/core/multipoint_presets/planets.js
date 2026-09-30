/**
 * Planets & moons: Multipoint presets modelled on real bodies. Globes use an honest
 * orthographic projection (latitude bands are the visible halves of projected
 * latitude circles, ending exactly on the limb) and one limb-darkening law, so
 * every pinned colour agrees about where the sphere curves away.
 * Side convention (verified by render): walking a curve on screen, rightColor is on
 * the walker's right. Ellipses, arcs, blobs and hearts with increasing angle run
 * clockwise, so rightColor is INSIDE; latitude arcs run west → east, so color is
 * north and rightColor is south.
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, finiteGeometry, catmullRomNodes, mixHex } from "../multipoint_shapes.js";
import { featurePolyline, pointAlongPolyline } from "../multipoint.js";

const DEG = Math.PI / 180;
const QUARTER_TURN_DEG = 90; // Widest cubic span per helper segment (radial error < 0.1%).
export const SPACE = "#05070f";
const LATITUDE_STOPS = [0, 0.3, 0.7, 1]; // Limb, two lit shoulders, limb: a flat-topped dome.
// Band ends stop just inside the limb: an endpoint ON the disc's cut leaks its colour into space.
const LIMB_INSET = 0.99;

/**
 * Pure function. Samples any differentiable parametric curve into editable cubic nodes.
 * Handles come from exact derivatives (Hermite → Bézier), so few nodes stay smooth.
 * @param {(t:number)=>number[]} curve - t → [x, y, dx/dt, dy/dt].
 * @param {object} options - {t0, t1, segments, closed=false}; t1 may be below t0 (reversed walk).
 *   closed drops the final sample, which must coincide with the first.
 * @returns {number[][]} [N,6] nodes; N = segments+1 (open) or segments (closed).
 * @example parametricNodes((t) => [t, 0, 1, 0], {t0: 0, t1: 1, segments: 1})
 *   // [[0,0,-1/3,0,1/3,0], [1,0,-1/3,0,1/3,0]]
 */
export function parametricNodes(curve, { t0, t1, segments, closed = false }) {
  finiteGeometry([t0, t1, segments]);
  if (!Number.isInteger(segments) || segments < 1 || t0 === t1) throw new Error("parametricNodes needs integer segments ≥ 1 and t0 ≠ t1");
  const step = (t1 - t0) / segments, sign = Math.sign(step);
  const samples = Array.from({ length: closed ? segments : segments + 1 }, (_, i) => {
    const [x, y, dx, dy] = curve(t0 + step * i);
    return [x, y, dx * sign, dy * sign];
  });
  return hermiteNodes(samples, Math.abs(step));
}

/**
 * Pure function. Orthographic projection of a sphere point onto the screen (y down).
 * Tilt is the sub-observer latitude: positive tips the north pole toward the viewer.
 * @param {object} globe - {cx, cy, radius, tilt=0}, tilt in degrees.
 * @param {number} latitude - Degrees, +north (up on screen).
 * @param {number} longitude - Degrees from the central meridian, +east (right).
 * @returns {number[]} [x, y, z]; z = cosine of the view angle (1 at disc centre, 0 on the limb).
 * @example globePoint({cx: 0.5, cy: 0.5, radius: 0.4}, 30, 0) // [0.5, 0.3, 0.866…]
 */
export function globePoint({ cx, cy, radius, tilt = 0 }, latitude, longitude) {
  finiteGeometry([cx, cy, radius, tilt, latitude, longitude]);
  const p = latitude * DEG, l = longitude * DEG, b = tilt * DEG;
  return [cx + radius * Math.cos(p) * Math.sin(l),
    cy - radius * (Math.sin(p) * Math.cos(b) - Math.cos(p) * Math.sin(b) * Math.cos(l)),
    Math.sin(p) * Math.sin(b) + Math.cos(p) * Math.cos(l) * Math.cos(b)];
}

/**
 * Pure function. Visible (near-side) half of a projected latitude circle, west → east.
 * Both ends lie exactly on the limb, so two-sided arcs seal belts against it.
 * x(λ) = cx + R·cosφ·sinλ;  y(λ) = cy − R·(sinφ·cosβ − cosφ·sinβ·cosλ);  visible where cosλ > −tanφ·tanβ.
 * @param {object} globe - {cx, cy, radius, tilt=0} (degrees).
 * @param {number} latitude - Degrees; the circle must cross the limb at this tilt.
 * @param {number} segments - Cubic spans (2 is plenty for a half circle).
 * @returns {number[][]} [segments+1, 6] nodes; color side = north, rightColor side = south.
 * @example latitudeNodes({cx: 0.5, cy: 0.5, radius: 0.4}, 0).map((n) => n.slice(0, 2))
 *   // [[0.1,0.5],[0.5,0.5],[0.9,0.5]] (equator, edge-on)
 */
export function latitudeNodes(globe, latitude, segments = 2) {
  const { cx, cy, radius, tilt = 0 } = globe;
  finiteGeometry([cx, cy, radius, tilt, latitude]);
  const p = latitude * DEG, b = tilt * DEG, cosEdge = -Math.tan(p) * Math.tan(b);
  if (Math.abs(cosEdge) >= 1) throw new Error(`Latitude ${latitude}° has no limb crossings at tilt ${tilt}°`);
  const edge = Math.acos(cosEdge), r = radius * Math.cos(p);
  return parametricNodes((l) => [cx + r * Math.sin(l), cy - radius * Math.sin(p) * Math.cos(b) + r * Math.sin(b) * Math.cos(l),
    r * Math.cos(l), -r * Math.sin(b) * Math.sin(l)], { t0: -edge, t1: edge, segments });
}

/**
 * Pure function. The whole projected latitude circle as a closed ellipse (a polar cap outline).
 * Only meaningful when the circle is entirely on the near side (|tanφ·tanβ| ≥ 1).
 * @param {object} globe - {cx, cy, radius, tilt} (degrees).
 * @param {number} latitude - Degrees.
 * @returns {number[][]} [4,6] clockwise nodes; rightColor inside (the cap).
 * @example latitudeRingNodes({cx: .5, cy: .5, radius: .4, tilt: 90}, 60)[0].slice(0, 2) // [0.7, 0.5] (pole-on)
 */
export function latitudeRingNodes({ cx, cy, radius, tilt = 0 }, latitude) {
  const p = latitude * DEG, b = tilt * DEG;
  if (Math.abs(Math.tan(p) * Math.tan(b)) < 1) throw new Error(`Latitude ${latitude}° is not wholly visible at tilt ${tilt}°`);
  return ellipseNodes(cx, cy - radius * Math.sin(p) * Math.cos(b), radius * Math.cos(p), radius * Math.cos(p) * Math.abs(Math.sin(b)));
}

/**
 * Pure function. Arc of an (optionally rotated) ellipse between two parametric angles.
 * Increasing angle runs clockwise on screen, so rightColor is inside when from < to.
 * @param {object} options - {cx, cy, rx, ry=rx, from, to, rotation=0, segments?}; angles in degrees;
 *   segments defaults to one per quarter turn.
 * @returns {number[][]} [segments+1, 6] open-arc nodes.
 * @example arcNodes({cx: 0.5, cy: 0.5, rx: 0.2, from: 0, to: 180}).map((n) => n.slice(0, 2))
 *   // [[0.7,0.5],[0.5,0.7],[0.3,0.5]]
 */
export function arcNodes({ cx, cy, rx, ry = rx, from, to, rotation = 0, segments }) {
  finiteGeometry([cx, cy, rx, ry, from, to, rotation]);
  if (rx <= 0 || ry <= 0) throw new Error("Arc radii must be positive");
  const spans = segments ?? Math.max(1, Math.ceil(Math.abs(to - from) / QUARTER_TURN_DEG));
  const c = Math.cos(rotation * DEG), s = Math.sin(rotation * DEG);
  return parametricNodes((t) => {
    const x = rx * Math.cos(t), y = ry * Math.sin(t), dx = -rx * Math.sin(t), dy = ry * Math.cos(t);
    return [cx + x * c - y * s, cy + x * s + y * c, dx * c - dy * s, dx * s + dy * c];
  }, { t0: from * DEG, t1: to * DEG, segments: spans });
}

/**
 * Pure function. Parametric angle (degrees, in [0, 90]) where the ellipse (a·cosθ, b·sinθ)
 * meets a concentric circle of radius r; the four crossings are ±θ and 180° ± θ.
 * cos²θ = (r² − b²)/(a² − b²), requiring b < r < a.
 * @param {number} a - Semi-axis along x.
 * @param {number} b - Semi-axis along y.
 * @param {number} r - Circle radius.
 * @returns {number} θ in degrees.
 * @example ellipseCircleCrossing(2, 1, Math.sqrt(2.5)) // 60.000…
 */
export function ellipseCircleCrossing(a, b, r) {
  finiteGeometry([a, b, r]);
  if (!(b < r && r < a)) throw new Error(`Ellipse (${a}, ${b}) does not cross circle ${r}`);
  return Math.acos(Math.sqrt((r * r - b * b) / (a * a - b * b))) / DEG;
}

/**
 * Pure function. Closed organic blob: an ellipse whose radius is modulated by cosine lobes.
 * r(θ) = 1 + Σ a_k·cos(k·θ + p_k), scaled by (rx, ry), then rotated. Runs clockwise
 * (rightColor inside), like ellipseNodes.
 * @param {object} options - {cx, cy, rx, ry=rx, lobes=[[k, amplitude, phaseDeg]...], rotation=0 (deg), count=6}.
 * @returns {number[][]} [count, 6] closed nodes.
 * @example blobNodes({cx: 0.5, cy: 0.5, rx: 0.2, count: 4})[0].slice(0, 2) // [0.7, 0.5]
 * @example blobNodes({cx: 0.5, cy: 0.5, rx: 0.2, lobes: [[2, 0.25, 0]], count: 4})[0].slice(0, 2) // [0.75, 0.5]
 */
export function blobNodes({ cx, cy, rx, ry = rx, lobes = [], rotation = 0, count = 6 }) {
  finiteGeometry([cx, cy, rx, ry, rotation, count, ...lobes.flat()]);
  if (rx <= 0 || ry <= 0 || count < 3) throw new Error("Blob needs positive radii and ≥ 3 nodes");
  const c = Math.cos(rotation * DEG), s = Math.sin(rotation * DEG);
  return parametricNodes((t) => {
    const r = 1 + lobes.reduce((sum, [k, a, p]) => sum + a * Math.cos(k * t + p * DEG), 0);
    const dr = lobes.reduce((sum, [k, a, p]) => sum - a * k * Math.sin(k * t + p * DEG), 0);
    if (r <= 0) throw new Error("Blob lobes make the radius nonpositive");
    const x = rx * r * Math.cos(t), y = ry * r * Math.sin(t);
    const dx = rx * (dr * Math.cos(t) - r * Math.sin(t)), dy = ry * (dr * Math.sin(t) + r * Math.cos(t));
    return [cx + x * c - y * s, cy + x * s + y * c, dx * c - dy * s, dx * s + dy * c];
  }, { t0: 0, t1: 2 * Math.PI, segments: count, closed: true });
}

/**
 * Pure function. Feature whose stop colours are sampled from a colour field at the stops' own
 * positions along the curve — e.g. a band edge that darkens exactly as the sphere does.
 * @param {number[][]} nodes - [N,6] geometry.
 * @param {number[]} offsets - Increasing arc-length stops in [0,1] (≤ 4); closed curves should span 0..1.
 * @param {(x:number, y:number)=>string|string[]} field - Colour, or [color, rightColor] when two-sided.
 * @param {object} options - {twoSided=false, closed=false}.
 * @returns {object} Native feature with unit weight.
 * @example fieldBoundary([[0,0,0,0,0,0],[1,0,0,0,0,0]], [0, 1], (x) => mixHex("#000000", "#ffffff", x)).stops[1].color // "#ffffff"
 */
export function fieldBoundary(nodes, offsets, field, { twoSided = false, closed = false } = {}) {
  const line = featurePolyline(nodes, closed);
  const stops = offsets.map((offset) => {
    const { x, y } = pointAlongPolyline(line, offset);
    const [color, rightColor = color] = [].concat(field(x, y));
    return { offset, color, rightColor };
  });
  // Offsets 0 and 1 of a closed curve are the same spot; copy rather than re-sample, so
  // float noise in the closing cubic cannot round one channel differently and open a seam.
  if (closed && offsets[0] === 0 && offsets.at(-1) === 1) Object.assign(stops.at(-1), { color: stops[0].color, rightColor: stops[0].rightColor });
  return { nodes: nodes.map((n) => [...n]), stops, twoSided, closed, weight: 1 };
}

/**
 * Pure function. Linear-law limb darkening: the surface colour where the sphere faces the
 * viewer, sliding to the limb colour where it turns away. μ = √(1 − r²/R²); mix(limb, color, μ^k).
 * @param {object} globe - {cx, cy, radius}.
 * @param {number} x - Screen x.
 * @param {number} y - Screen y.
 * @param {string} color - Face-on colour.
 * @param {string} limb - Colour at the limb.
 * @param {number} exponent - k; below 1 flattens the dome (weaker darkening), above 1 sharpens it.
 * @returns {string} #rrggbb.
 * @example limbShade({cx: .5, cy: .5, radius: .4}, .5, .5, "#ffffff", "#000000", 1) // "#ffffff"
 * @example limbShade({cx: .5, cy: .5, radius: .4}, .9, .5, "#ffffff", "#000000", 1) // "#000000"
 */
export function limbShade({ cx, cy, radius }, x, y, color, limb, exponent = 1) {
  const mu = Math.sqrt(Math.max(0, 1 - ((x - cx) ** 2 + (y - cy) ** 2) / radius ** 2));
  return mixHex(limb, color, mu ** exponent);
}

/**
 * Pure function. A closed smooth outline drawn in geographic coordinates on a globe
 * (continents, albedo regions), projected then threaded with Catmull-Rom tangents.
 * List the corners clockwise as seen on screen so rightColor is inside.
 * @param {object} globe - {cx, cy, radius, tilt}.
 * @param {number[][]} corners - [N,2] (latitude, longitude) degrees, all on the near side.
 * @returns {number[][]} [N,6] closed nodes.
 * @example globeOutline({cx:.5,cy:.5,radius:.4}, [[10,-10],[10,10],[-10,10],[-10,-10]]).length // 4
 */
export function globeOutline(globe, corners) {
  return catmullRomNodes(corners.map(([lat, lon]) => {
    const [x, y, z] = globePoint(globe, lat, lon);
    if (z <= 0) throw new Error(`Outline corner (${lat}, ${lon}) is on the far side`);
    return [x, y];
  }), true);
}

/**
 * Pure function. The disc silhouette: a closed two-sided circle, limb colour inside, space outside.
 * @param {object} globe - {cx, cy, radius}.
 * @param {string} limb - Inside colour at the limb.
 * @param {string} space - Outside colour.
 * @returns {object} One closed two-sided feature (4 nodes).
 * @example disc({cx: 0.5, cy: 0.5, radius: 0.4}, "#553311").twoSided // true
 */
export function disc({ cx, cy, radius }, limb, space = SPACE) {
  return boundary(ellipseNodes(cx, cy, radius), [space], [limb], true);
}

/**
 * Pure function. A latitude edge whose two sides are limb-shaded; one colour makes it a soft
 * single-sided shading line, two make a crisp belt edge.
 * @param {object} globe - {cx, cy, radius, tilt}.
 * @param {number} latitude - Degrees.
 * @param {string} north - Face-on colour on the north side.
 * @param {string|null} south - Face-on colour on the south side, or null for single-sided.
 * @param {string} limb - Limb colour.
 * @param {number} exponent - limbShade exponent.
 * @returns {object} Open feature with LATITUDE_STOPS.
 * @example latitudeBand({cx:.5,cy:.5,radius:.4}, 0, "#ffffff", null, "#000000", 1).stops[0].color // "#242424"
 */
export function latitudeBand(globe, latitude, north, south, limb, exponent = 1) {
  const shade = (x, y, c) => limbShade(globe, x, y, c, limb, exponent);
  return fieldBoundary(latitudeNodes({ ...globe, radius: globe.radius * LIMB_INSET }, latitude), LATITUDE_STOPS,
    (x, y) => (south ? [shade(x, y, north), shade(x, y, south)] : shade(x, y, north)), { twoSided: south !== null });
}

/**
 * Pure function. Stack of crisp belt edges from north to south, band colours in between.
 * @param {object} globe - {cx, cy, radius, tilt}.
 * @param {number[]} latitudes - Edge latitudes, north first, length L.
 * @param {string[]} bands - L+1 face-on band colours, north cap first; a [top, bottom] pair
 *   gives that band an internal gradient.
 * @param {string} limb - Limb colour.
 * @param {number} exponent - limbShade exponent.
 * @returns {object[]} L two-sided features.
 * @example beltStack({cx:.5,cy:.5,radius:.4}, [10,-10], ["#111111","#eeeeee","#111111"], "#000000").length // 2
 */
export function beltStack(globe, latitudes, bands, limb, exponent = 1) {
  if (bands.length !== latitudes.length + 1) throw new Error("beltStack needs one more band than edges");
  const bottom = (band) => [].concat(band).at(-1), top = (band) => [].concat(band)[0];
  return latitudes.map((lat, i) => latitudeBand(globe, lat, bottom(bands[i]), top(bands[i + 1]), limb, exponent));
}

/**
 * Pure function. A limb-shaded closed spot at a globe position (storm, crater, mare).
 * @param {object} globe - {cx, cy, radius, tilt}.
 * @param {number[][]} nodes - Closed clockwise nodes.
 * @param {string} outside - Face-on colour around it.
 * @param {string|null} inside - Face-on colour inside; null for a soft single-sided outline.
 * @param {string} limb - Limb colour.
 * @returns {object} Closed feature with 3 sampled stops (start, half, start).
 * @example shadedSpot({cx:.5,cy:.5,radius:.4}, ellipseNodes(.5,.5,.1), "#ffffff", "#000000", "#808080").twoSided // true
 */
export function shadedSpot(globe, nodes, outside, inside, limb) {
  return fieldBoundary(nodes, [0, 0.5, 1], (x, y) => {
    const o = limbShade(globe, x, y, outside, limb);
    return inside ? [o, limbShade(globe, x, y, inside, limb)] : o;
  }, { twoSided: inside !== null, closed: true });
}


/**
 * Pure function. The two banks of a thin ribbon along a smooth path: Catmull-Rom curves offset
 * ± halfWidth along the path's normals. Walking the path, index 0 is the LEFT bank and index 1
 * the RIGHT bank, so give bank 0 [outside] / [inside] and bank 1 [inside] / [outside].
 * @param {number[][]} corners - [N,2] (x,y) path points, N ≥ 2.
 * @param {number} halfWidth - Offset from the path to each bank.
 * @returns {number[][][]} [leftNodes, rightNodes], each [N,6].
 * @example ribbonSides([[0, 0.5], [1, 0.5]], 0.01)[0][0].slice(0, 2) // [0, 0.49] (left bank is above)
 */
export function ribbonSides(corners, halfWidth) {
  finiteGeometry([halfWidth, ...corners.flat()]);
  const last = corners.length - 1;
  const normals = corners.map((_, i) => {
    const [ax, ay] = corners[Math.max(0, i - 1)], [bx, by] = corners[Math.min(last, i + 1)], length = Math.hypot(bx - ax, by - ay);
    if (!length) throw new Error("Ribbon path needs distinct neighbouring points");
    return [-(by - ay) / length, (bx - ax) / length]; // Screen-right of the walking direction (y down).
  });
  return [-1, 1].map((side) => catmullRomNodes(corners.map(([x, y], i) => [x + side * halfWidth * normals[i][0], y + side * halfWidth * normals[i][1]]), false));
}

/**
 * Pure function. A thin two-banked stripe: crisp on both banks, `inside` between them.
 * @param {number[][]} corners - [N,2] path points.
 * @param {number} halfWidth - Half the stripe width.
 * @param {string} inside - Stripe colour.
 * @param {string|string[]} outside - Surround colour, or [leftBank, rightBank] surrounds.
 * @returns {object[]} Two open two-sided features.
 * @example ribbon([[0, .5], [1, .5]], .01, "#aa0000", "#ffffff")[0].stops[0].rightColor // "#aa0000"
 */
export function ribbon(corners, halfWidth, inside, outside) {
  const [left, right] = [].concat(outside, outside).slice(0, 2);
  const [leftBank, rightBank] = ribbonSides(corners, halfWidth);
  return [boundary(leftBank, [left], [inside]), boundary(rightBank, [inside], [right])];
}

/**
 * Pure function. Limb-darkening rim: a single-sided concentric circle a little inside the limb.
 * Inside it the field is flat; between it and the limb it falls off like ln r — a clean
 * darkened edge with no interior creases (see LIMB_INSET for why bands avoid the limb itself).
 * A colour FUNCTION is sampled at the right, bottom, top and right again (offsets 0, ¼, ¾, 1);
 * the left side interpolates bottom↔top, which is exact for a north–south gradient, and the
 * flat interior then becomes a smooth harmonic blend of it (a darker hood, a lit side).
 * @param {object} globe - {cx, cy, radius}.
 * @param {number} fraction - Rim radius as a fraction of the globe radius, e.g. 0.88.
 * @param {string|((x:number, y:number)=>string)} colors - Rim colour, or a colour field.
 * @returns {object} Closed single-sided feature.
 * @example rim({cx:.5,cy:.5,radius:.4}, .9, "#ffcc66").closed // true
 * @example rim({cx:.5,cy:.5,radius:.4}, .9, (x, y) => (y < .5 ? "#000000" : "#ffffff")).stops.map((s) => s.color)
 *   // ["#ffffff", "#ffffff", "#000000", "#ffffff"] (right, bottom, top, right)
 */
export function rim({ cx, cy, radius }, fraction, colors) {
  const nodes = ellipseNodes(cx, cy, radius * fraction);
  return typeof colors === "function" ? fieldBoundary(nodes, [0, 0.25, 0.75, 1], colors, { closed: true }) : boundary(nodes, [colors], null, true);
}

/**
 * Pure function. Short single-sided streak along a latitude whose ends melt into the surface.
 * @param {object} globe - {cx, cy, radius, tilt}.
 * @param {number} latitude - Degrees.
 * @param {number} from - Start longitude, degrees.
 * @param {number} to - End longitude, degrees (east of from).
 * @param {string} color - Streak colour at its middle.
 * @param {(x:number, y:number)=>string} surface - Surface colour field for the ends.
 * @returns {object} Open 3-node, 3-stop feature.
 * @example latitudeStreak({cx:.5,cy:.5,radius:.4}, 0, -20, 20, "#ffffff", () => "#0000ff").stops[1].color // "#ffffff"
 */
export function latitudeStreak(globe, latitude, from, to, color, surface) {
  const corners = [from, (from + to) / 2, to].map((lon) => globePoint(globe, latitude, lon).slice(0, 2));
  return boundary(catmullRomNodes(corners, false), [surface(...corners[0]), color, surface(...corners[2])]);
}

// ─── Jupiter ────────────────────────────────────────────────────────────────
const JUPITER = { cx: 0.5, cy: 0.5, radius: 0.45, tilt: 5 };
const JUPITER_LIMB = "#5e4636";
const jupiterGlobe = (() => {
  const [x, y] = globePoint(JUPITER, -22, 22);
  return preset("jupiter-globe", "Jupiter", "Jupiter as a lit globe: projected cream zones and rust belts, the Great Red Spot riding the south belt.", [
    disc(JUPITER, JUPITER_LIMB),
    ...beltStack(JUPITER, [36, 25, 17, 7, -8, -19, -28, -36],
      ["#a09483", "#9a806a", "#ecdfc7", ["#8e5132", "#b2744d"], "#f2e4c8", ["#b77c52", "#9a5634"], "#f1e2c9", "#a58a72", "#9e9384"], JUPITER_LIMB),
    shadedSpot(JUPITER, ellipseNodes(x, y, 0.095, 0.052), "#f2e0c8", "#bf4f2d", JUPITER_LIMB),
    point(x, y, "#d98657"),
  ]);
})();

const jupiterBelts = (() => {
  const wave = (y, amplitude, cycles, phase) => parametricNodes((t) => {
    const angle = 2 * Math.PI * cycles * t + phase;
    return [t, y + amplitude * Math.sin(angle), 1, amplitude * 2 * Math.PI * cycles * Math.cos(angle)];
  }, { t0: -0.05, t1: 1.05, segments: Math.max(2, Math.ceil(cycles * 4)) });
  return preset("jupiter-belts", "Jovian belts", "A close-up of wavy cream zones and rust belts wrapping around the Great Red Spot.", [
    boundary(wave(0.1, 0.012, 0.9, 0.3), ["#efe2c8", "#e6d3b2", "#f2e7d2"], ["#9c5a3a", "#8a4c31", "#a8653f"]),
    boundary(wave(0.27, 0.02, 1.3, 2.2), ["#b7704a", "#c07a50", "#a9643f"], ["#f3e6cc", "#ecd9b8", "#f5eadb"]),
    boundary(wave(0.42, 0.018, 1.1, 1.0), ["#ead3a8", "#f0dfc0", "#e4c89a"], ["#8f4f33", "#9d5a38", "#874a30"]),
    boundary(wave(0.55, 0.035, 0.5, 0.0), ["#a9643f", "#b36e45", "#9e5b3a"], ["#f5e3c8", "#f7e8cf", "#f2dfc2"]),
    boundary(wave(0.86, 0.015, 1.2, 1.7), ["#efdcbf", "#f2e2c8", "#ead6b6"], ["#8a6a52", "#9a7a5f", "#80614b"]),
    boundary(ellipseNodes(0.56, 0.7, 0.21, 0.1), ["#f6e6d0"], ["#b9482a"], true),
    boundary(ellipseNodes(0.56, 0.7, 0.12, 0.05), ["#c75a33"], null, true),
    point(0.56, 0.7, "#e3955f"),
  ]);
})();

// ─── Saturn ─────────────────────────────────────────────────────────────────
const saturnRings = (() => {
  const globe = { cx: 0.5, cy: 0.52, radius: 0.21, tilt: 18 };
  const { cx, cy, radius: R } = globe, lean = Math.sin(globe.tilt * DEG);
  const limb = "#5f4a2f";
  const outer = { a: 2.27 * R }, inner = { a: 1.53 * R }, cassini = { a: 1.97 * R };
  for (const ring of [outer, inner, cassini]) { ring.b = ring.a * lean; ring.cross = ellipseCircleCrossing(ring.a, ring.b, R); }
  // Limb angle where a ring ellipse crosses the lower limb (front pass), degrees.
  const limbAngle = (ring) => Math.atan2(ring.b * Math.sin(ring.cross * DEG), ring.a * Math.cos(ring.cross * DEG)) / DEG;
  const ringArc = (ring, from, to) => arcNodes({ cx, cy, rx: ring.a, ry: ring.b, from, to });
  // Right ansa, front pass (over the planet), left ansa; the back pass is hidden behind the globe.
  const pieces = (ring) => [[-ring.cross, ring.cross], [ring.cross, 180 - ring.cross], [180 - ring.cross, 180 + ring.cross]];
  const shade = (x, y, c) => limbShade(globe, x, y, c, limb);
  const [aRing, bRing, capShadow] = ["#b9a88a", "#e9d8b4", "#3e3122"];
  return preset("saturn-rings", "Saturn", "Butterscotch Saturn behind a tilted ring system; the rings pass in front of its southern limb.", [
    boundary(arcNodes({ cx, cy, rx: R, from: 180 - limbAngle(inner), to: 360 + limbAngle(inner) }), [SPACE], [limb]),
    boundary(arcNodes({ cx, cy, rx: R, from: limbAngle(outer), to: 180 - limbAngle(outer) }), [SPACE], [capShadow]),
    latitudeBand(globe, 22, "#dcb77a", "#ecd5a0", limb),
    latitudeBand(globe, 48, "#b39a73", "#d2ae70", limb),
    ...pieces(outer).map(([from, to], i) => boundary(ringArc(outer, from, to), [i === 1 ? capShadow : SPACE], [aRing])),
    ...pieces(inner).map(([from, to], i) => fieldBoundary(ringArc(inner, from, to), [0, 0.5, 1],
      (x, y) => [bRing, i === 1 ? shade(x, y, "#e2c58e") : SPACE], { twoSided: true })),
    ...[pieces(cassini)[0], pieces(cassini)[2]].map(([from, to]) => boundary(ringArc(cassini, from, to), ["#6e604c"])),
  ]);
})();

// ─── Ice giants ─────────────────────────────────────────────────────────────
const NEPTUNE = { cx: 0.5, cy: 0.5, radius: 0.44, tilt: -22 };
const NEPTUNE_LIMB = "#101a57";
const neptuneGlobe = (() => {
  const [gx, gy] = globePoint(NEPTUNE, -20, -14);
  const surface = (x, y) => limbShade(NEPTUNE, x, y, "#4a70e0", NEPTUNE_LIMB);
  return preset("neptune-globe", "Neptune", "Deep azure Neptune: the Great Dark Spot, its white companion cloud and thin cirrus streaks.", [
    disc(NEPTUNE, NEPTUNE_LIMB),
    latitudeBand(NEPTUNE, 30, "#4d74e2", null, NEPTUNE_LIMB),
    latitudeBand(NEPTUNE, 0, "#4167da", null, NEPTUNE_LIMB),
    latitudeBand(NEPTUNE, -48, "#3656c8", null, NEPTUNE_LIMB),
    shadedSpot(NEPTUNE, ellipseNodes(gx, gy, 0.075, 0.042), "#3d62d6", "#172266", NEPTUNE_LIMB),
    boundary(arcNodes({ cx: gx + 0.01, cy: gy + 0.012, rx: 0.1, ry: 0.058, from: 25, to: 115 }), ["#e7f0ff"]),
    latitudeStreak(NEPTUNE, 22, -58, -8, "#eef4ff", surface),
    latitudeStreak(NEPTUNE, -38, 12, 58, "#e3ecff", surface),
  ]);
})();

const URANUS = { cx: 0.5, cy: 0.5, radius: 0.3, tilt: 55 };
const URANUS_LIMB = "#4f8e9f";
const uranusGlobe = (() => {
  const lean = Math.sin(URANUS.tilt * DEG);
  const ringEdge = (r, inside, outside) => boundary(ellipseNodes(0.5, 0.5, r, r * lean), [outside], [inside], true);
  return preset("uranus-globe", "Uranus", "Pale cyan Uranus, pole toward us: faint bands, a bright polar cap and a thin ring.", [
    disc(URANUS, URANUS_LIMB),
    latitudeBand(URANUS, 10, "#a8dde3", null, URANUS_LIMB, 0.7),
    latitudeBand(URANUS, 28, "#b5e4e8", "#a3d8df", URANUS_LIMB, 0.7),
    shadedSpot(URANUS, latitudeRingNodes(URANUS, 62), "#c4ecee", "#ecfdfb", URANUS_LIMB),
    ringEdge(0.434, SPACE, "#a9ccd4"),
    ringEdge(0.446, "#a9ccd4", SPACE),
  ]);
})();

// ─── Terrestrial planets ────────────────────────────────────────────────────
/**
 * Pure function. Clamped 0..1 fraction of the way down a globe, top of disc → bottom of disc.
 * @param {object} globe - {cy, radius}.
 * @param {number} y - Screen y.
 * @returns {number} 0 at the north limb, 1 at the south limb.
 * @example southward({cy: .5, radius: .4}, .5) // 0.5
 */
export function southward({ cy, radius }, y) {
  return Math.min(1, Math.max(0, (y - cy + radius) / (2 * radius)));
}

const MARS = { cx: 0.5, cy: 0.5, radius: 0.44, tilt: 25 };
const MARS_LIMB = "#5c2614";
const marsGlobe = (() => {
  const [hx, hy] = globePoint(MARS, -36, 12), [sx, sy] = globePoint(MARS, 4, 2);
  return preset("mars-globe", "Mars", "Rust Mars from Hubble's angle: the dark Syrtis Major wedge and southern maria, pale Hellas and a white polar cap.", [
    disc(MARS, MARS_LIMB),
    latitudeBand(MARS, 35, "#d38d57", null, MARS_LIMB, 0.8),
    latitudeBand(MARS, -32, "#c9794a", null, MARS_LIMB, 0.8),
    shadedSpot(MARS, globeOutline(MARS, [[-4, -62], [-4, -36], [0, -16], [18, -9], [21, 7], [4, 22], [-10, 40], [-16, 58], [-29, 48], [-25, 16], [-28, -24], [-18, -56]]),
      "#b0643c", "#7a432d", MARS_LIMB),
    point(sx, sy, "#5c3122"),
    shadedSpot(MARS, ellipseNodes(hx, hy, 0.065, 0.03), "#c67748", "#dfa77e", MARS_LIMB),
    boundary(latitudeRingNodes(MARS, 74), ["#dca482"], ["#f6f2ec"], true),
  ]);
})();

const VENUS = { cx: 0.5, cy: 0.5, radius: 0.44, tilt: 0 };
const VENUS_LIMB = "#9c7a3a";
const venusGlobe = (() => {
  const shade = (x, y, c) => limbShade(VENUS, x, y, c, VENUS_LIMB, 0.7);
  // A chevron edge: from the north-east limb, west to a vertex on the equator, back to the south-east limb.
  const chevron = (vertex, reach, east, west) => fieldBoundary(catmullRomNodes([[reach, 72], [reach / 2, (vertex + 72) / 2], [0, vertex], [-reach / 2, (vertex + 72) / 2], [-reach, 72]]
    .map(([lat, lon]) => globePoint(VENUS, lat, lon).slice(0, 2)), false), [0, 0.5, 1], (x, y) => [shade(x, y, east), shade(x, y, west)], { twoSided: true });
  return preset("venus-globe", "Venus", "Sulfur-veiled Venus: its cloud bands sheared into the nested chevrons of the sideways Y.", [
    disc(VENUS, VENUS_LIMB),
    chevron(-62, 58, "#ecd594", "#faf1d4"),
    chevron(-30, 50, "#f7ebc4", "#e3c784"),
    chevron(4, 40, "#dcbc78", "#f4e5bb"),
    chevron(36, 30, "#f1dfaa", "#d6b36c"),
    latitudeBand(VENUS, 62, "#fbf4dc", null, VENUS_LIMB, 0.7),
    latitudeBand(VENUS, -62, "#f9f1d6", null, VENUS_LIMB, 0.7),
  ]);
})();

const EARTH = { cx: 0.5, cy: 0.5, radius: 0.42, tilt: -18 };
const OCEAN = "#123a84";
const earthMarble = (() => {
  const land = (x, y) => (y < 0.4 ? "#c9a86c" : y < 0.58 ? "#6b8a3e" : "#958152");
  const africa = [[35, -26], [37, -10], [31, 12], [11, 31], [-10, 20], [-34, 0], [-17, -8], [4, -11], [5, -25], [15, -37], [27, -33]];
  const cloud = (corners) => boundary(catmullRomNodes(corners.map(([lat, lon]) => globePoint(EARTH, lat, lon).slice(0, 2)), false), ["#f2f6fb"], [OCEAN]);
  return preset("earth-marble", "Blue marble", "Earth from deep space: Africa and Arabia, white storm fronts, the Antarctic ice and a thin blue halo.", [
    disc(EARTH, "#2c62b4", "#2f6ccc"),
    boundary(ellipseNodes(0.5, 0.5, 0.47), [SPACE], null, true),
    fieldBoundary(globeOutline(EARTH, africa), [0, 1 / 3, 2 / 3, 1], (x, y) => [OCEAN, land(x, y)], { twoSided: true, closed: true }),
    boundary(globeOutline(EARTH, [[28, 36], [22, 58], [14, 50], [16, 42]]), [OCEAN], ["#caa46a"], true),
    boundary(globeOutline(EARTH, [[-64, -50], [-63, -12], [-67, 22], [-64, 52], [-78, 58], [-80, -56]]), [OCEAN], ["#eef3f8"], true),
    cloud([[-26, -54], [-42, -34], [-36, -10]]),
    cloud([[-34, 20], [-48, 40], [-40, 64]]),
    cloud([[10, -52], [3, -34], [9, -20]]),
  ]);
})();

// ─── Moons ──────────────────────────────────────────────────────────────────
const MOON = { cx: 0.5, cy: 0.5, radius: 0.44 };
const moonMaria = (() => {
  const mare = (u, v, rx, ry, rotation, lobes = []) => boundary(blobNodes({ cx: 0.5 + u * MOON.radius, cy: 0.5 + v * MOON.radius,
    rx: rx * MOON.radius, ry: ry * MOON.radius, rotation, lobes, count: 4 }), ["#aaa69e"], ["#7c7a75"], true);
  return preset("moon-maria", "Full moon", "The full Moon's pale highlands and the familiar dark maria of the man in the moon.", [
    disc(MOON, "#b3afa6"),
    mare(-0.3, -0.42, 0.26, 0.22, 0),                    // Imbrium
    mare(-0.62, 0.05, 0.18, 0.36, 10, [[3, 0.12, 40]]),  // Procellarum
    mare(0.2, -0.38, 0.14, 0.14, 0),                     // Serenitatis
    mare(0.38, -0.08, 0.17, 0.14, -20),                  // Tranquillitatis
    mare(0.78, -0.25, 0.09, 0.11, 0),                    // Crisium
    mare(0.6, 0.14, 0.08, 0.13, 10),                     // Fecunditatis
    mare(0.36, 0.3, 0.07, 0.06, 0),                      // Nectaris
    mare(-0.18, 0.32, 0.17, 0.12, 20),                   // Nubium
  ]);
})();

const IO = { cx: 0.5, cy: 0.5, radius: 0.44, tilt: 0 };
const IO_LIMB = "#7a561c";
const ioGlobe = (() => {
  const at = (lat, lon) => globePoint(IO, lat, lon).slice(0, 2);
  const [px, py] = at(-19, 12);
  return preset("io-volcanic", "Io", "Mottled sulfur-yellow Io: rusty poles, white frost, black vents and Pele's red plume ring.", [
    disc(IO, IO_LIMB),
    rim(IO, 0.9, "#d6bc55"),
    point(...at(2, -8), "#ecdc6e"),
    point(...at(24, 28), "#f4efd6"),
    point(...at(-44, -32), "#cf8f40"),
    point(...at(56, -5), "#9f6d38"),
    point(...at(-2, 48), "#e7d9a0"),
    point(...at(-8, -52), "#3a2819"),
    point(...at(14, -28), "#3f2d1f"),
    boundary(ellipseNodes(px, py, 0.08, 0.066), ["#c24f2c"], null, true),
    point(px, py, "#2d1d14"),
  ]);
})();

const TITAN = { cx: 0.5, cy: 0.5, radius: 0.37, tilt: 0 };
const TITAN_LIMB = "#7e4312";
const titanHaze = preset("titan-haze", "Titan", "Titan's orange smog globe, darker under its northern hood, wrapped in a detached blue haze layer.", [
  disc(TITAN, TITAN_LIMB, "#233a60"),
  rim(TITAN, 0.9, (x, y) => mixHex("#a4632a", "#e4a852", southward(TITAN, y))),
  boundary(ellipseNodes(0.5, 0.5, TITAN.radius * 1.06), ["#8dbbe6"], null, true),
  boundary(ellipseNodes(0.5, 0.5, TITAN.radius * 1.2), [SPACE], null, true),
]);

// ─── The Sun ────────────────────────────────────────────────────────────────
const SUN = { cx: 0.5, cy: 0.5, radius: 0.34, tilt: 0 };
const SUN_LIMB = "#d4501a";
const SUN_CORONA = "#ffa54a";
const CORONA_EDGE = { radius: 0.5, color: "#1c0703" };
const sunDisc = (() => {
  const [sx, sy] = globePoint(SUN, 14, -22), [tx, ty] = globePoint(SUN, 10, -8);
  // Corona between limb and edge circle is harmonic: colour ∝ ln(r / R_sun) / ln(R_edge / R_sun).
  const corona = (x, y) => mixHex(SUN_CORONA, CORONA_EDGE.color,
    Math.min(1, Math.max(0, Math.log(Math.hypot(x - SUN.cx, y - SUN.cy) / SUN.radius) / Math.log(CORONA_EDGE.radius / SUN.radius))));
  const loop = [-60, -52, -42, -32, -24].map((deg, i) => {
    const r = SUN.radius * [1.02, 1.17, 1.22, 1.16, 1.02][i];
    return [SUN.cx + r * Math.cos(deg * DEG), SUN.cy + r * Math.sin(deg * DEG)];
  });
  const [left, right] = ribbonSides(loop, 0.009);
  return preset("sun-disc", "The Sun", "A limb-darkened Sun in a warm corona, a sunspot pair and a prominence arching off the limb.", [
    disc(SUN, SUN_LIMB, SUN_CORONA),
    boundary(ellipseNodes(SUN.cx, SUN.cy, CORONA_EDGE.radius), [CORONA_EDGE.color], null, true),
    rim(SUN, 0.86, "#ffc766"),
    rim(SUN, 0.55, "#fff1c8"),
    shadedSpot(SUN, ellipseNodes(sx, sy, 0.04, 0.03), "#fff3cf", "#a2461a", SUN_LIMB),
    point(sx, sy, "#3a1204"),
    shadedSpot(SUN, ellipseNodes(tx, ty, 0.022, 0.017), "#fff3cf", "#8a3712", SUN_LIMB),
    fieldBoundary(left, [0, 0.5, 1], (x, y) => [corona(x, y), "#ff5a22"], { twoSided: true }),
    fieldBoundary(right, [0, 0.5, 1], (x, y) => ["#ff5a22", corona(x, y)], { twoSided: true }),
  ]);
})();

// ─── Europa (full-bleed surface) ────────────────────────────────────────────
const europaLineae = preset("europa-lineae", "Europa ice", "Europa's pale water-ice crust crossed by thin rust-brown lineae and a stained chaos patch.", [
  ...ribbon([[-0.05, 0.22], [0.35, 0.3], [0.7, 0.18], [1.05, 0.3]], 0.012, "#9a5a3e", "#ece4d6"),
  ...ribbon([[-0.05, 0.75], [0.4, 0.58], [0.75, 0.64], [1.05, 0.48]], 0.009, "#a2654a", "#e8e2d8"),
  ...ribbon([[0.2, -0.05], [0.3, 0.4], [0.22, 0.75], [0.32, 1.05]], 0.014, "#8e4c34", "#efe9df"),
  ...ribbon([[0.8, -0.05], [0.63, 0.45], [0.72, 1.05]], 0.008, "#a86a4c", "#e6ded0"),
  boundary(blobNodes({ cx: 0.56, cy: 0.86, rx: 0.1, ry: 0.06, lobes: [[3, 0.18, 10]], count: 4 }), ["#c49474"], null, true),
  point(0.5, 0.45, "#f1ece2"),
  point(0.08, 0.92, "#d9c6a8"),
  point(0.9, 0.08, "#dfe4e4"),
]);

export const PRESETS = [jupiterGlobe, jupiterBelts, saturnRings, neptuneGlobe, uranusGlobe, marsGlobe, venusGlobe, earthMarble,
  moonMaria, ioGlobe, europaLineae, titanHaze, sunDisc];
