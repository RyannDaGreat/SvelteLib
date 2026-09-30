/**
 * "Food & moods" Multipoint presets, plus the geometry helpers
 * they need (candidates for merging into core/multipoint_presets.js).
 * Coordinates are the unit paint box, y down. Numeric rows are authored
 * composition data (positions/radii/colours), not solver parameters.
 */
import { preset, boundary, point } from "./builders.js";
import { hermiteNodes, ellipseNodes, waveNodes, finiteGeometry, polylineNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

/**
 * Pure function (given a pure `curve`). Samples a parametric curve with exact derivatives into cubic nodes.
 * `curve(t)` returns [x, y, dx/dt, dy/dt]. A closed curve drops the duplicate end
 * sample (t1 must then trace back to t0's point). Zero derivatives become corners.
 * @param {Function} curve - t ↦ [x,y,dx/dt,dy/dt], e.g. a circle.
 * @param {number} t0 - Start parameter.
 * @param {number} t1 - End parameter (> t0).
 * @param {number} segments - Positive integer cubic count.
 * @param {boolean} closed - True for a loop whose end equals its start.
 * @returns {number[][]} [segments (+1 if open), 6] anchor/relative-handle tuples.
 * @example parametricNodes((t) => [t, 0.5, 1, 0], 0, 1, 2, false).map((n) => n[0]) // [0,0.5,1]
 */
export function parametricNodes(curve, t0, t1, segments, closed) {
  finiteGeometry([t0, t1, segments]);
  if (!(t1 > t0) || !Number.isInteger(segments) || segments < 1) throw new Error("Parametric sampling needs t1 > t0 and a positive integer segment count");
  const step = (t1 - t0) / segments;
  const samples = Array.from({ length: segments + (closed ? 0 : 1) }, (_, i) => curve(t0 + step * i));
  return hermiteNodes(samples, step);
}

/**
 * Pure function. Rotates anchors about a centre; handles rotate as vectors.
 * Rotation preserves traversal orientation, so two-sided colours keep their sides.
 * @param {number[][]} nodes - [N,6] anchor/relative-handle tuples.
 * @param {number} cx - Pivot x.
 * @param {number} cy - Pivot y.
 * @param {number} angle - Radians; positive turns clockwise on screen (y down).
 * @returns {number[][]} [N,6] rotated copy.
 * @example rotateNodes([[1,0,0,0,0.5,0]], 0, 0, Math.PI / 2)[0].map((v) => +v.toFixed(6)) // [0,1,0,0,0,0.5]
 */
export function rotateNodes(nodes, cx, cy, angle) {
  finiteGeometry([cx, cy, angle]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const turn = (x, y) => [c * x - s * y, s * x + c * y];
  return nodes.map(([x, y, ix, iy, ox, oy]) => {
    const [ax, ay] = turn(x - cx, y - cy);
    const node = [cx + ax, cy + ay, ...turn(ix, iy), ...turn(ox, oy)];
    finiteGeometry(node);
    return node;
  });
}

/**
 * Pure function. One cubic approximating a circular arc from a to b with signed sagitta.
 * Positive sagitta bulges to the LEFT of travel on screen (y down). Handle length
 * L = chord / (3·cos²(φ/2)), φ = 2·atan(2|s|/chord) — the standard (4/3)·tan(θ/4)·R.
 * @param {number[]} a - Start (x,y).
 * @param {number[]} b - End (x,y), distinct from a.
 * @param {number} sagitta - Signed bulge height at the chord midpoint.
 * @returns {{out:number[], in:number[]}} Relative handles at a (outgoing) and b (incoming).
 * @example arcHandles([0,0],[1,0],0).out // [1/3, 0]
 */
function arcHandles(a, b, sagitta) {
  finiteGeometry([...a, ...b, sagitta]);
  const dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
  if (!chord) throw new Error("An arc needs distinct endpoints");
  const ux = dx / chord, uy = dy / chord, nx = uy, ny = -ux; // (nx,ny) = screen-left of travel
  const phi = 2 * Math.atan(2 * Math.abs(sagitta) / chord), side = Math.sign(sagitta);
  const length = chord / (3 * Math.cos(phi / 2) ** 2), c = Math.cos(phi), s = Math.sin(phi) * side;
  return { out: [length * (c * ux + s * nx), length * (c * uy + s * ny)],
    in: [-length * (c * ux - s * nx), -length * (c * uy - s * ny)] };
}

/**
 * Pure function. Two-node closed shape bounded by two circular arcs: a lens (leaf,
 * seed, eye) when both sagittas are positive, a crescent when bulgeBack is negative
 * and smaller in magnitude. Both anchors are sharp corners. Traversal a→b then b→a.
 * SIDES: with bulgeOut > 0 the shape lies to the right of travel, so a two-sided
 * feature's rightColor is INSIDE; with bulgeOut < 0 it is OUTSIDE (swap palettes).
 * @param {number} ax - Tip a x.
 * @param {number} ay - Tip a y.
 * @param {number} bx - Tip b x.
 * @param {number} by - Tip b y.
 * @param {number} bulgeOut - Sagitta of the a→b arc, positive = left of a→b.
 * @param {number} bulgeBack - Sagitta of the b→a arc, positive = left of b→a.
 * @returns {number[][]} [2,6] anchor/relative-handle tuples; close the feature.
 * @example lensNodes(0.2, 0.5, 0.8, 0.5, 0.1, 0.1).map((n) => n.slice(0, 2)) // [[0.2,0.5],[0.8,0.5]]
 */
export function lensNodes(ax, ay, bx, by, bulgeOut, bulgeBack) {
  const out = arcHandles([ax, ay], [bx, by], bulgeOut), back = arcHandles([bx, by], [ax, ay], bulgeBack);
  return [[ax, ay, ...back.in, ...out.out], [bx, by, ...out.in, ...back.out]];
}

/**
 * Pure function. Cloud / scalloped outline: `puffs` corner nodes on an ellipse joined
 * by outward circular arcs (sagitta = bulge·chord). Clockwise on screen, so a
 * two-sided feature's rightColor is INSIDE. Unlike a sine blob, the troughs are
 * sharp creases and the crests round, which reads as puffs rather than petals.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius of the trough ellipse (> 0).
 * @param {number} ry - Vertical radius of the trough ellipse (> 0).
 * @param {number} puffs - Integer puff count ≥ 2 (= node count).
 * @param {number|number[]} bulge - Crest height as a fraction of each chord (0.5 = semicircles);
 *   an array gives one value per arc (arc k runs trough k → k+1), e.g. a flat cloud base.
 * @param {number} phase - Angle of the first trough, radians.
 * @returns {number[][]} [puffs,6] anchor/relative-handle tuples; close the feature.
 * @example cloudNodes(0.5, 0.5, 0.3, 0.2, 6, 0.4, 0)[0].slice(0, 2) // [0.8,0.5]
 */
export function cloudNodes(cx, cy, rx, ry, puffs, bulge, phase) {
  const bulges = Array.isArray(bulge) ? bulge : Array(puffs).fill(bulge);
  finiteGeometry([cx, cy, rx, ry, puffs, phase, ...bulges]);
  if (!Number.isInteger(puffs) || puffs < 2 || rx <= 0 || ry <= 0 || bulges.length !== puffs)
    throw new Error("A cloud needs ≥2 integer puffs, positive radii and one bulge per puff");
  const troughs = Array.from({ length: puffs }, (_, k) => {
    const angle = phase + k * FULL_TURN / puffs;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });
  const arcs = troughs.map((a, k) => {
    const b = troughs[(k + 1) % puffs];
    return arcHandles(a, b, bulges[k] * Math.hypot(b[0] - a[0], b[1] - a[1]));
  });
  return troughs.map((p, k) => [...p, ...arcs[(k + puffs - 1) % puffs].in, ...arcs[k].out]);
}

/**
 * Pure function. Classic heart x = 16·sin³t, y = 13cos t − 5cos 2t − 2cos 3t − cos 4t,
 * scaled so its width is `width`, centred on its bounding box, y flipped for screen.
 * Starts at the top cleft and runs clockwise; the cleft and tip become corners.
 * @param {number} cx - Bounding-box centre x.
 * @param {number} cy - Bounding-box centre y.
 * @param {number} width - Full width (> 0); height is ≈ 0.9·width.
 * @param {number} segments - Even cubic count (12 keeps lobes round).
 * @returns {number[][]} [segments,6] anchor/relative-handle tuples; close the feature.
 * @example heartNodes(0.5, 0.5, 0.64, 12)[6].slice(0, 2).map((v) => +v.toFixed(3)) // [0.5,0.789]
 */
export function heartNodes(cx, cy, width, segments) {
  finiteGeometry([cx, cy, width, segments]);
  if (width <= 0 || segments % 2) throw new Error("A heart needs positive width and an even segment count");
  const scale = width / 32, middle = (11.923 - 17) / 2; // measured y-extremes of the classic curve
  return parametricNodes((t) => {
    const s = Math.sin(t), c = Math.cos(t);
    const y = 13 * c - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const dy = -13 * s + 10 * Math.sin(2 * t) + 6 * Math.sin(3 * t) + 4 * Math.sin(4 * t);
    return [cx + scale * 16 * s ** 3, cy - scale * (y - middle), scale * 48 * s * s * c, -scale * dy];
  }, 0, FULL_TURN, segments, true);
}

/**
 * Pure function. The chord of the infinite line through (x,y) at `angle` inside the
 * square [lo,hi]², as two corner nodes traversed along +angle (useful for stripes).
 * @param {number} x - A point on the line.
 * @param {number} y - A point on the line.
 * @param {number} angle - Direction in radians (screen, y down).
 * @param {number} lo - Square minimum.
 * @param {number} hi - Square maximum.
 * @returns {number[][]} [2,6] corner nodes.
 * @example lineAcrossBox(0.5, 0.5, 0, 0, 1).map((n) => n.slice(0, 2)) // [[0,0.5],[1,0.5]]
 */
export function lineAcrossBox(x, y, angle, lo, hi) {
  finiteGeometry([x, y, angle, lo, hi]);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  // Slab clipping: parameter interval where the line is inside both coordinate ranges.
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d] of [[x, dx], [y, dy]]) {
    if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) throw new Error("Line misses the box"); continue; }
    const a = (lo - p) / d, b = (hi - p) / d;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  if (!(t1 > t0)) throw new Error("Line misses the box");
  return polylineNodes([[x + t0 * dx, y + t0 * dy], [x + t1 * dx, y + t1 * dy]]);
}

/**
 * Pure function. A horizontal melt edge with rounded drips hanging below `y`.
 * Shoulders sit between drips on the baseline; each drip bottom is a smooth node.
 * @param {object} options - {x0, x1, y, drips: [[x, depth, halfWidth], ...] sorted by x}.
 * @returns {number[][]} [2·drips + 1, 6] anchor/relative-handle tuples, left to right.
 * @example dripNodes({x0:0,x1:1,y:0.3,drips:[[0.5,0.2,0.1]]}).map((n) => n.slice(0, 2)) // [[0,0.3],[0.5,0.5],[1,0.3]]
 */
export function dripNodes({ x0, x1, y, drips }) {
  finiteGeometry([x0, x1, y, ...drips.flat()]);
  if (!drips.length || drips.some((d, i) => i && d[0] <= drips[i - 1][0])) throw new Error("Drips must be nonempty and sorted by x");
  const shoulders = [x0, ...drips.slice(1).map((d, i) => (drips[i][0] + d[0]) / 2), x1];
  const nodes = [];
  drips.forEach(([x, depth, half], i) => {
    const left = shoulders[i], right = shoulders[i + 1];
    if (!i) nodes.push([left, y, 0, 0, (x - left) / 2, 0]);
    nodes.push([x, y + depth, -half, 0, half, 0]);
    const next = drips[i + 1]?.[0] ?? right;
    nodes.push([right, y, -(right - x) / 2, 0, (next - right) / 2, 0]);
  });
  nodes.at(-1)[4] = 0;
  return nodes;
}

/**
 * Pure function. Two-sided straight segments radiating from a centre (citrus/pinwheel wedges).
 * Every ray travels outward, so `left` is the counter-clockwise side on screen.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r0 - Start radius (leave a small core so rays don't pile up).
 * @param {number} r1 - End radius.
 * @param {number} count - Ray count.
 * @param {number} rotation - First ray angle.
 * @param {string[]} left - Ramp on the counter-clockwise side, centre → rim.
 * @param {string[]} right - Ramp on the clockwise side, centre → rim.
 * @returns {object[]} `count` two-sided features.
 * @example spokes(0.5,0.5,0.1,0.4,4,0,["#ff0000"],["#0000ff"]).length // 4
 */
function spokes(cx, cy, r0, r1, count, rotation, left, right) {
  return Array.from({ length: count }, (_, k) => {
    const a = rotation + k * FULL_TURN / count, c = Math.cos(a), s = Math.sin(a);
    return boundary(polylineNodes([[cx + r0 * c, cy + r0 * s], [cx + r1 * c, cy + r1 * s]]), left, right);
  });
}

// ---------------------------------------------------------------------------

/**
 * Pure function. A pumpkin rib: the meridian at normalised longitude u of an ellipse,
 * trimmed short of both poles so the ribs never pile up on one grid cell.
 * @param {number} cx - Ellipse centre x.
 * @param {number} cy - Ellipse centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius.
 * @param {number} u - Longitude in [-1,1]; 0 is the vertical centre line.
 * @returns {number[][]} [3,6] top → bottom anchor/relative-handle tuples.
 * @example meridianNodes(0.5, 0.5, 0.4, 0.3, 0)[1].slice(0, 2) // [0.5,0.5]
 */
function meridianNodes(cx, cy, rx, ry, u) {
  return parametricNodes((t) => [cx + rx * u * Math.sin(Math.PI * t), cy - ry * Math.cos(Math.PI * t),
    rx * u * Math.PI * Math.cos(Math.PI * t), ry * Math.PI * Math.sin(Math.PI * t)], 0.1, 0.9, 2, false);
}

const MATCHA_FOAM = ["#fffbea"], MATCHA = ["#9fbf5c"];

export const PRESETS = [
  preset("citrus-slice", "Citrus slice", "Eight juicy faceted wedges inside a pith ring and bright orange peel.", [
    ...spokes(0.5, 0.5, 0.035, 0.34, 8, -Math.PI / 8, ["#ffe7a3", "#ff9a1f"], ["#fff3c8", "#ffc04a"]),
    boundary(ellipseNodes(0.5, 0.5, 0.35), ["#fff6dc"], ["#ffb13b"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.39), ["#ff9424"], ["#fffbea"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.44), ["#fbeedd"], ["#e8680f"], true),
    point(0.5, 0.5, "#fff8e0"),
  ]),
  preset("watermelon-slice", "Watermelon", "A bowl of crisp rind bands under deep red flesh dotted with almond seeds.", [
    boundary(polylineNodes([[0, 0.02], [1, 0.02]]), ["#e0213f"]),
    ...[[0.5, "#ff5f6f", "#f6ffe6"], [0.58, "#e9f8cf", "#8fd05e"], [0.65, "#3f9b40", "#1c5a2c"]].map(([y, above, below]) =>
      boundary(parametricNodes((t) => [t, y + 0.33 * Math.sin(Math.PI * t), 1, 0.33 * Math.PI * Math.cos(Math.PI * t)], 0, 1, 4, false),
        [above], [below])),
    ...[[0.22, 0.42], [0.36, 0.56], [0.5, 0.6], [0.64, 0.56], [0.78, 0.42], [0.36, 0.3], [0.64, 0.3]].map(([x, y]) => {
      const a = Math.atan2(y + 0.3, x - 0.5), l = 0.03;
      return boundary(lensNodes(x - l * Math.cos(a), y - l * Math.sin(a), x + l * Math.cos(a), y + l * Math.sin(a), 0.016, 0.016),
        ["#f0405a"], ["#2b1512"], true);
    }),
  ]),
  preset("peach-sorbet", "Peach sorbet", "One crisp scoop-swoosh of cream parting peach from mango.", [
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#ffb08c", "#ffc79c", "#ffe0b0"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#ff8a78", "#ffa46a", "#ffbf5a"]),
    boundary(parametricNodes((t) => [0.08 + 0.84 * t, 0.82 - 0.64 * t + 0.16 * Math.sin(FULL_TURN * t), 0.84, -0.64 + 0.16 * FULL_TURN * Math.cos(FULL_TURN * t)], 0, 1, 4, false),
      ["#ffe9d6", "#fff3e6", "#ffe6c8"], ["#ffcaa8", "#ffd8b0", "#ffd49a"]),
  ]),
  preset("strawberry-milk", "Strawberry milk", "Cream milk dripping into a soft strawberry pink pool.", [
    boundary(dripNodes({ x0: 0, x1: 1, y: 0.3, drips: [[0.14, 0.12, 0.06], [0.38, 0.26, 0.07], [0.62, 0.08, 0.06], [0.84, 0.2, 0.06]] }),
      ["#fffaf2", "#ffffff", "#fff6ef"], ["#ffc1d1", "#ffd3de", "#ffb8ca"]),
    point(0.5, 0.04, "#fffdf8"),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#f47f9f", "#ff9bb5", "#f98aa9"]),
  ]),
  preset("matcha-latte", "Matcha latte", "A poured foam tulip — two arches over a round heart — in jade matcha.", [
    boundary(ellipseNodes(0.5, 0.5, 0.46), ["#d8ccb4"], ["#fbf7ee"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.39), ["#ece5d6"], ["#6e9440"], true),
    ...[[0.22, 0.18], [0.35, 0.16]].map(([y, half]) => boundary(lensNodes(0.5 - half, y + 0.1, 0.5 + half, y + 0.1, 0.13, -0.05), MATCHA, MATCHA_FOAM, true)),
    boundary(ellipseNodes(0.5, 0.6, 0.13, 0.11), MATCHA, MATCHA_FOAM, true),
    point(0.5, 0.6, "#fffdf4"),
  ]),
  preset("cotton-candy", "Cotton candy", "A flat-bottomed puff cloud melting from bubblegum pink into baby blue.", [
    boundary(cloudNodes(0.5, 0.55, 0.38, 0.22, 6, [0.4, 0.5, 0.55, 0.5, 0.4, 0.06], Math.PI / 2 + Math.PI / 6),
      ["#e6d6ff", "#d9ccff", "#d2dcff", "#e6d6ff"], ["#ffa8d2", "#e7b3ff", "#9fd2ff", "#ffa8d2"], true),
    point(0.42, 0.44, "#fff2f9"), point(0.62, 0.52, "#f2f8ff"),
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#f6ecff", "#ecdfff", "#e2e4ff"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#d4c6ff", "#cdd2ff", "#c2d6ff"]),
  ]),
  preset("candy-cane", "Candy cane", "Crisp diagonal peppermint stripes with a glossy highlight across their middle.",
    // Offsets avoid the exact corner diagonal: a line clipped to within float noise of two box edges leaked a smudge.
    [-0.5, -0.3, -0.1, 0.1, 0.3, 0.5].map((d, k) => {
      const red = ["#b8102c", "#ff4d63", "#b8102c"], white = ["#f1dcdc", "#ffffff", "#f1dcdc"];
      return boundary(lineAcrossBox(0.5 + d * Math.SQRT1_2, 0.5 + d * Math.SQRT1_2, -Math.PI / 4, 0, 1),
        k % 2 ? red : white, k % 2 ? white : red);
    })),
  preset("pumpkin-spice", "Pumpkin spice", "A ribbed burnt-orange pumpkin, glowing lobes between soft creases, on cinnamon.", [
    boundary(ellipseNodes(0.5, 0.57, 0.42, 0.33), ["#4a2416"], ["#d9661a"], true),
    ...[-0.55, -0.35, -0.18, 0, 0.18, 0.35, 0.55].map((u, i) => boundary(meridianNodes(0.5, 0.57, 0.42, 0.33, u),
      i % 2 ? ["#a8400e"] : ["#ff9a3a", "#ffb862", "#f08a2e"])),
    boundary(lensNodes(0.49, 0.27, 0.53, 0.14, 0.02, 0.02), ["#4a2416"], ["#6b7a32"], true),
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#6e3520", "#5a2a19", "#4a2416"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#2e140c", "#3a1b10", "#2e140c"]),
  ]),
  preset("valentine-heart", "Valentine", "A glossy crimson heart with rose lobes on a blush-pink card.", [
    boundary(heartNodes(0.5, 0.52, 0.72, 12), ["#ffd1dc", "#ffb0c4", "#ffd1dc"], ["#ff4f7b", "#c3103f", "#ff4f7b"], true),
    point(0.36, 0.34, "#ffc2d2"),
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#ffe4ea", "#ffeef2", "#fff5f7"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#f58aa8", "#f7a0b8", "#f9b3c5"]),
  ]),
  preset("lucky-coin", "Lucky coin", "A lustrous gold coin with a square hole, glowing on lacquer red.", [
    boundary(rotateNodes(ellipseNodes(0.5, 0.5, 0.4), 0.5, 0.5, -3 * Math.PI / 4), ["#a50e1c", "#7d0914", "#a50e1c"], ["#ffeaa0", "#c07d12", "#ffeaa0"], true),
    boundary(rotateNodes(ellipseNodes(0.5, 0.5, 0.31), 0.5, 0.5, -3 * Math.PI / 4), ["#b9780f", "#ffe79a", "#b9780f"], ["#ffd766", "#d99a22", "#ffd766"], true),
    boundary(polylineNodes([[0.41, 0.41], [0.59, 0.41], [0.59, 0.59], [0.41, 0.59]]), ["#f6c14a"], ["#8f0b18"], true),
    point(0.08, 0.08, "#c8182a"), point(0.92, 0.92, "#5e0610"),
  ]),
  preset("calm-ripples", "Calm", "Soft sea-glass ripples spreading across a still pond under lavender haze.", [
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#d9def5", "#e6e4f6", "#d9def5"]),
    ...[[0.12, "#dff3ef"], [0.24, "#a9d3cf"], [0.36, "#e3f4f0"], [0.48, "#9ccbc8"]].map(([r, color]) =>
      boundary(ellipseNodes(0.5, 0.64, r, r * 0.55), [color], null, true)),
    point(0.5, 0.64, "#b7dcd8"),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#86b7b9"]),
  ]),
  preset("energetic-zigzag", "Energetic", "Two lightning zigzags splitting hot pink, tangerine and lemon.",
    [[0.28, ["#ff3d8b", "#ff1f66"], ["#ff7a1f", "#ff9a22"]], [0.62, ["#ff9422", "#ffb02a"], ["#ffe53b", "#fff58a"]]].map(([y, above, below]) => boundary(
      polylineNodes([[0, y + 0.18], [0.2, y - 0.1], [0.36, y + 0.12], [0.58, y - 0.16], [0.72, y + 0.06], [1, y - 0.24]]), above, below))),
  preset("foggy-lamp", "Melancholy", "One dim amber lamp and its wet reflection in slate-blue fog.", [
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#4a5670", "#56627a", "#465169"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.03, cycles: 0.5 }), ["#6f7a90", "#8d93a6", "#6f7a90"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#1e2431", "#262c3a", "#1e2431"]),
    point(0.72, 0.6, "#f0c083"),
    boundary(polylineNodes([[0.72, 0.67], [0.72, 0.96]]), ["#b08a62", "#343a48"]),
  ]),
  preset("dream-crescent", "Dreamy", "A cream crescent moon haloed in lilac, dusk violet fading into candy pink.", [
    boundary(lensNodes(0.4, 0.2, 0.44, 0.74, -0.2, 0.12), ["#fff1cf", "#fffaf0", "#fff1cf"], ["#c8b8f6", "#e2d6ff", "#c8b8f6"], true),
    boundary(polylineNodes([[0, 0.01], [1, 0.01]]), ["#6a5bc4", "#7d63cf", "#8a6ccc"]),
    boundary(polylineNodes([[0, 0.99], [1, 0.99]]), ["#ffb7d5", "#ffc9c9", "#f7b2e0"]),
    point(0.8, 0.3, "#f3e8ff"), point(0.72, 0.62, "#ffe6f2"),
  ]),
];

