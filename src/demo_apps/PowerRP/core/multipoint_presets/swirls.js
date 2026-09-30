/**
 * "Swirls": vortices, curls, S-flows and twirls traced from real
 * art and craft (paper marbling, fluid pours, 1960s posters and light shows, op art,
 * latte art, whirlpools, Māori kōwhaiwhai, the Newgrange triple spiral).
 * Numeric rows are authored composition data in the unit paint box (y down); the 2026-09-30
 * research-preset merge entry in concerns.md names the source behind every preset. Side convention (verified by render): walking
 * a curve on screen, rightColor lies to the walker's right — BELOW a left-to-right
 * curve, INSIDE a clockwise closed curve, and on the INNER side of a coil whose turns
 * are positive (clockwise on screen) as it grows outward.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { hermiteNodes, catmullRomNodes, polylineNodes, rectNodes, ellipseNodes, finiteGeometry } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
// Four cubic spans per turn: a quarter-turn Hermite arc is visually exact, and it
// lets one 13-node feature carry three full turns (spiralNodes' eight spans cap at 1.5).
const SPANS_PER_TURN = 4;
// The classic heart curve's natural half-height (x = 16 sin³t spans ±16, y spans −17..+12).
const HEART_UNIT = 17;

/** Pure function. The whole-box frame as a closed clockwise rectangle (pins colour along the edges). @returns {number[][]} [4,6] zero-handle tuples. @example boxNodes()[2].slice(0, 2) // [1,1] */
export function boxNodes() {
  return rectNodes(0, 0, 1, 1);
}

/**
 * Pure function. Editable nodes for any parametric curve at evenly spaced parameters.
 * Each span is the exact cubic Hermite interpolant of the curve's samples and tangents.
 * @param {function} curve - t ↦ [x, y, dx/dt, dy/dt] in the unit box (y down).
 * @param {number} t0 - First parameter.
 * @param {number} t1 - Last parameter (≠ t0).
 * @param {number} spans - Positive integer cubic span count; returns spans + 1 nodes.
 * @returns {number[][]} [spans+1, 6] anchor/relative-handle tuples.
 * @example sampledNodes((t) => [t, 0.5, 1, 0], 0, 1, 2).map((n) => n[0]) // [0,0.5,1]
 * @example sampledNodes((t) => [t, 0.5, 1, 0], 0, 1, 2)[1] // [0.5,0.5,-1/6,-0,1/6,0]
 */
export function sampledNodes(curve, t0, t1, spans) {
  finiteGeometry([t0, t1, spans]);
  if (!Number.isInteger(spans) || spans < 1 || t0 === t1) throw new Error("sampledNodes needs a positive integer span count and t0 ≠ t1");
  const step = (t1 - t0) / spans;
  return hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => curve(t0 + step * i)), step);
}

/**
 * Pure function. Archimedean spiral with a coarse (four spans per turn) node budget.
 * r(t) = r0 + (r1 − r0)·t; θ(t) = phase + 2π·turns·t, t ∈ [0,1]; x = cx + r·cos θ,
 * y = cy + squash·r·sin θ. Positive turns run clockwise on screen (y down).
 * @param {object} options - {cx, cy, r0, r1, turns, phase=0, squash=1}; radii ≥ 0, turns ≠ 0;
 *   squash scales the vertical offsets (0.6 = the spiral seen in perspective, as a flattened ellipse).
 * @returns {number[][]} [⌈4·|turns|⌉+1, 6] tuples; 13 nodes for three turns.
 * @example coilNodes({cx:0.5,cy:0.5,r0:0,r1:0.4,turns:1}).length // 5
 * @example coilNodes({cx:0.5,cy:0.5,r0:0,r1:0.4,turns:1})[4].slice(0,2) // [0.9,0.5]
 * @example coilNodes({cx:0.5,cy:0.5,r0:0,r1:0.4,turns:1,squash:0.5})[3].slice(0,2) // ≈[0.5,0.35] (three quarters of a turn, squashed)
 */
export function coilNodes({ cx, cy, r0, r1, turns, phase = 0, squash = 1 }) {
  finiteGeometry([cx, cy, r0, r1, turns, phase, squash]);
  if (r0 < 0 || r1 < 0 || turns === 0 || squash <= 0) throw new Error("coilNodes needs nonnegative radii, nonzero turns and a positive squash");
  const sweep = FULL_TURN * turns, grow = r1 - r0;
  return sampledNodes((t) => {
    const r = r0 + grow * t, a = phase + sweep * t, c = Math.cos(a), s = Math.sin(a);
    return [cx + r * c, cy + squash * r * s, grow * c - r * sweep * s, squash * (grow * s + r * sweep * c)];
  }, 0, 1, Math.ceil(Math.abs(turns) * SPANS_PER_TURN));
}

/**
 * Pure function. Photoshop-style twirl: rotates a point about a centre by an angle
 * that fades as ((R − r)/R)² to zero at radius R; points at r ≥ R are unchanged.
 * A bijection, so curves that did not cross before twirling never cross after.
 * @param {number[]} p - (x, y) point.
 * @param {object} twirl - {cx, cy, radius, angle}: centre, fade radius, full rotation at the centre (radians, clockwise on screen).
 * @returns {number[]} Twirled (x, y).
 * @example twirlPoint([0.9, 0.5], {cx:0.5,cy:0.5,radius:0.3,angle:1}) // [0.9,0.5] (outside the radius)
 * @example twirlPoint([0.65, 0.5], {cx:0.5,cy:0.5,radius:0.3,angle:Math.PI*2}) // ≈[0.5,0.65] (a quarter turn at mid-radius)
 */
export function twirlPoint([x, y], { cx, cy, radius, angle }) {
  finiteGeometry([x, y, cx, cy, radius, angle]);
  if (radius <= 0) throw new Error("twirlPoint needs a positive radius");
  const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
  if (r >= radius) return [x, y];
  const a = angle * ((radius - r) / radius) ** 2, c = Math.cos(a), s = Math.sin(a);
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/**
 * Pure function. A straight segment, sampled evenly and passed through a twirl, as a smooth open curve.
 * @param {number[]} from - Start (x, y).
 * @param {number[]} to - End (x, y).
 * @param {number} samples - Anchor count (≥ 2); more anchors follow a stronger twirl faithfully.
 * @param {object} twirl - twirlPoint's {cx, cy, radius, angle}.
 * @returns {number[][]} [samples, 6] Catmull–Rom tuples.
 * @example twirledLineNodes([0, 0.5], [1, 0.5], 3, {cx:0.5,cy:0.5,radius:0.2,angle:3}).map((n) => n.slice(0, 2)) // [[0,0.5],[0.5,0.5],[1,0.5]] (only the centre is inside, and it stays put)
 */
export function twirledLineNodes([x0, y0], [x1, y1], samples, twirl) {
  if (!Number.isInteger(samples) || samples < 2) throw new Error("twirledLineNodes needs at least two samples");
  return catmullRomNodes(Array.from({ length: samples }, (_, j) => {
    const t = j / (samples - 1);
    return twirlPoint([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], twirl);
  }));
}

/**
 * Pure function. A closed wobbly ring: radius r·(1 + amp·sin(lobes·θ + phase)) through n anchors.
 * Anchors run clockwise on screen, so a two-sided feature's rightColor is INSIDE.
 * @param {object} options - {cx, cy, rx, ry=rx, amp=0, lobes=3, phase=0, n=8}.
 * @returns {number[][]} [n, 6] closed Catmull–Rom tuples (close the feature).
 * @example wobbleRingNodes({cx:0.5,cy:0.5,rx:0.2,n:4})[0].slice(0,2) // [0.7,0.5]
 * @example wobbleRingNodes({cx:0.5,cy:0.5,rx:0.2,amp:0.5,lobes:1,phase:Math.PI/2,n:4})[0].slice(0,2) // [0.8,0.5] (the lobe bulges at θ = 0)
 */
export function wobbleRingNodes({ cx, cy, rx, ry = rx, amp = 0, lobes = 3, phase = 0, n = 8 }) {
  finiteGeometry([cx, cy, rx, ry, amp, lobes, phase, n]);
  if (rx <= 0 || ry <= 0 || n < 3) throw new Error("wobbleRingNodes needs positive radii and at least three anchors");
  return catmullRomNodes(Array.from({ length: n }, (_, i) => {
    const a = FULL_TURN * i / n, k = 1 + amp * Math.sin(lobes * a + phase);
    return [cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)];
  }), true);
}

/**
 * Pure function. The classic heart curve as eight editable nodes, clockwise from the top cleft.
 * x = 16·sin³t, y = −(13cos t − 5cos 2t − 2cos 3t − cos 4t), scaled by size/17. The cleft
 * (t = 0) and the tip (t = π) have zero derivative, so they come out as sharp nodes.
 * @param {number} cx - Centre x (the curve's origin, a little above the heart's middle).
 * @param {number} cy - Centre y.
 * @param {number} size - Positive half-height scale (the tip lies at cy + size).
 * @returns {number[][]} [8, 6] tuples; close the feature.
 * @example heartNodes(0.5, 0.5, 0.34)[0].slice(0, 2) // [0.5,0.4] (the cleft)
 * @example heartNodes(0.5, 0.5, 0.34)[4].slice(0, 2) // [0.5,0.84] (the tip)
 */
export function heartNodes(cx, cy, size) {
  finiteGeometry([cx, cy, size]);
  if (size <= 0) throw new Error("heartNodes needs a positive size");
  const k = size / HEART_UNIT;
  const curve = (t) => [cx + k * 16 * Math.sin(t) ** 3,
    cy - k * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    k * 48 * Math.sin(t) ** 2 * Math.cos(t),
    -k * (-13 * Math.sin(t) + 10 * Math.sin(2 * t) + 6 * Math.sin(3 * t) + 4 * Math.sin(4 * t))];
  return sampledNodes(curve, 0, FULL_TURN, 8).slice(0, 8);
}

/**
 * Pure function. Closed outline of a brush stroke along a centreline: the left offsets
 * forward, one cap point past the end, then the right offsets back. Normals come from
 * central differences, so the stroke's width follows its turns.
 * @param {number[][]} points - [N,2] centreline anchors, N ≥ 2.
 * @param {number[]} widths - [N] half-widths, one per anchor.
 * @returns {number[][]} [2N+1, 2] outline anchors (feed catmullRomNodes(…, true)).
 * @example ribbonOutline([[0, 0.5], [1, 0.5]], [0.1, 0.1]) // [[0,0.6],[1,0.6],[1.1,0.5],[1,0.4],[0,0.4]]
 */
export function ribbonOutline(points, widths) {
  const n = points.length;
  if (n < 2 || widths.length !== n) throw new Error("ribbonOutline needs ≥ 2 anchors and one width per anchor");
  finiteGeometry([...points.flat(), ...widths]);
  const normal = (i) => {
    const [ax, ay] = points[Math.max(0, i - 1)], [bx, by] = points[Math.min(n - 1, i + 1)], len = Math.hypot(bx - ax, by - ay);
    if (!len) throw new Error("ribbonOutline needs distinct neighbouring anchors");
    return [-(by - ay) / len, (bx - ax) / len];
  };
  const left = [], right = [];
  points.forEach(([x, y], i) => {
    const [nx, ny] = normal(i), w = widths[i];
    left.push([x + nx * w, y + ny * w]);
    right.push([x - nx * w, y - ny * w]);
  });
  const [ex, ey] = points[n - 1], [nx, ny] = normal(n - 1), w = widths[n - 1];
  return [...left, [ex + ny * w, ey - nx * w], ...right.reverse()];
}

/**
 * Pure function. Shortens any handle whose tip would leave the unit box, keeping its
 * direction. A cubic lies inside the hull of its anchors and handle tips, so after
 * this the drawn curve cannot leave the box (and cannot enlarge the solve domain).
 * @param {number[][]} nodes - [N,6] tuples whose anchors already lie in the box.
 * @returns {number[][]} New [N,6] tuples.
 * @example boxedHandles([[0.9, 0.5, 0, 0, 0.2, 0.1]]) // [[0.9,0.5,0,0,0.1,0.05]]
 */
export function boxedHandles(nodes) {
  return nodes.map(([x, y, ix, iy, ox, oy]) => {
    finiteGeometry([x, y, ix, iy, ox, oy]);
    if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error(`boxedHandles: anchor (${x}, ${y}) lies outside the unit box`);
    const fit = (hx, hy) => {
      let k = 1;
      for (const [p, h] of [[x, hx], [y, hy]]) {
        if (p + h > 1) k = Math.min(k, (1 - p) / h);
        if (p + h < 0) k = Math.min(k, -p / h);
      }
      return [hx * k, hy * k];
    };
    return [x, y, ...fit(ix, iy), ...fit(ox, oy)];
  });
}

/**
 * Pure function. A tilted sine across the box: y = y0 + slope·x + amp·sin(2π·cycles·x + phase), x ∈ [0,1].
 * @param {object} options - {y0, slope=0, amp, cycles, phase=0, spans}; spans = cubic span count.
 * @returns {number[][]} [spans+1, 6] tuples.
 * @example waveLineNodes({y0:0.5, amp:0.1, cycles:1, spans:4}).map((n) => +n[1].toFixed(2)) // [0.5,0.6,0.5,0.4,0.5]
 */
export function waveLineNodes({ y0, slope = 0, amp, cycles, phase = 0, spans }) {
  finiteGeometry([y0, slope, amp, cycles, phase]);
  const w = FULL_TURN * cycles;
  return sampledNodes((x) => [x, y0 + slope * x + amp * Math.sin(w * x + phase), 1, slope + amp * w * Math.cos(w * x + phase)], 0, 1, spans);
}

// Kōwhaiwhai koru: a stroke rising from the bottom edge, arching over and curling into a bulb.
// The tail's first two anchors share x so its normal is horizontal and both outline ends sit ON the edge.
const KORU_PATH = [[0.16, 1], [0.16, 0.5], [0.4, 0.2], [0.76, 0.26], [0.8, 0.56], [0.58, 0.64]];
const KORU_WIDTHS = [0.075, 0.075, 0.08, 0.09, 0.12, 0.16];
const KORU_CORE = 0.45; // the black core's width as a fraction of the cream band's
/**
 * Pure function. The koru outline at a width scale, as an OPEN curve whose two ends stand on
 * the bottom edge: a closed outline would run its seam along the edge and smear the core there.
 * @param {number} scale - Width multiplier.
 * @returns {number[][]} [13,6] open tuples.
 * @example koruNodes(1).length // 13
 */
function koruNodes(scale) {
  return boxedHandles(catmullRomNodes(ribbonOutline(KORU_PATH, KORU_WIDTHS.map((w) => w * scale))));
}

// Psychedelic poster bands and the spectrum wheel each pass through one centred twirl.
const MELT_TWIRL = { cx: 0.5, cy: 0.5, radius: 0.5, angle: 6.5 };
const MELT_BANDS = [["#ff8a1f", "#ffb02e"], ["#d8207a", "#8a2bd8"], ["#ffd23a", "#ff8a1f"], ["#2b6bff", "#18b6d8"]];
const SPECTRUM = ["#ff4f6d", "#ffb14a", "#f4f06a", "#4fe0a0", "#44a8ff", "#b46cff"];
const SPECTRUM_TWIRL = { cx: 0.5, cy: 0.5, radius: 0.71, angle: 2.8 }; // reaches the corners, so the whole square turns
const SPECTRUM_CORE = 0.06; // white hub radius: keeps six hues from meeting (and greying) at one point
/** Pure function. A spoke from just outside the hub to the inscribed circle (which the twirl only slides along, so it stays in the box). @param {number} angle - Screen radians. @returns {number[][]} [2,2] endpoints. @example spokeEnds(0) // [[0.59,0.5],[1,0.5]] */
function spokeEnds(angle) {
  const inner = SPECTRUM_CORE + 0.03, outer = 0.5;
  return [[0.5 + inner * Math.cos(angle), 0.5 + inner * Math.sin(angle)], [0.5 + outer * Math.cos(angle), 0.5 + outer * Math.sin(angle)]];
}

// Soft flow marble: horizontal isolines of a warm-grey/rose ramp, stirred by one broad twirl.
const MARBLE_TWIRL = { cx: 0.5, cy: 0.5, radius: 0.5, angle: 4.5 };
const MARBLE_ROWS = [[0, ["#e9ddd5", "#f3ebe3"]], [0.3, ["#b9a3a6", "#8d7f86", "#c9aeb0"]], [0.5, ["#fbf6ef", "#fffaf3", "#f6ede4"]],
  [0.7, ["#d7aeb0", "#9c8e95", "#d9c0bd"]], [1, ["#efe5dc", "#e3d5cd"]]];

const INK = "#1a1414", PAPER = "#f4ecdc", VERTIGO = "#e4502c";
const FOAM = "#fbf3e3", CREMA = "#c17c42", RIM = "#7e4520";

export const PRESETS = [
  preset("vertigo-spiral", "Vertigo spiral", "A hypnotic two-arm spiral of ink and paper dissolving into poster orange, after Saul Bass's 1958 Vertigo.", [
    ...[0, Math.PI].map((phase, i) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0, r1: 0.44, turns: 3, phase }),
      [...Array(3).fill(i ? PAPER : INK), VERTIGO], [...Array(3).fill(i ? INK : PAPER), VERTIGO])),
    boundary(boxNodes(), [VERTIGO], null, true),
  ]),
  preset("maelstrom-eye", "Maelstrom", "Three foam-crested arms pulled down into a dark eye, like the Corryvreckan whirlpool seen from above.", [
    boundary(boxNodes(), closedRamp(["#123a66", "#0d2c52", "#174a78"]), null, true),
    ...[0, 1, 2].map((i) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0.02, r1: 0.47, turns: 1.25, phase: i * FULL_TURN / 3 }),
      ["#081a34", "#2a6f9c", "#1d5a8a", "#174a78"], ["#081a34", "#f2fbf8", "#6cc6c8", "#1f5f92"])),
  ]),
  preset("naruto-whirlpool", "Naruto whirlpool", "A cream-foamed whirlpool in Prussian blue under a pale sky, after Hiroshige's Awa: Naruto Whirlpools (1855).", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#f5ead4"]),
    boundary(polylineNodes([[0, 0.24], [1, 0.24]]), ["#f0d6b8"], ["#2c6a9c"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#173a66"]),
    ...[0, 1, 2].map((i) => boundary(coilNodes({ cx: 0.5, cy: 0.66, r0: 0.02, r1: 0.5, turns: -1.2, phase: i * FULL_TURN / 3, squash: 0.6 }),
      ["#f5ecd6", "#f5ecd6", "#e6ddc4", "#8fb8d2"], ["#1d4a7c", "#2f6f9e", "#3f82b0", "#2c6a9c"])),
  ]),
  preset("fillmore-melt", "Fillmore melt", "Flat orange, magenta, gold and blue poster bands twisted into one crisp curl, after 1960s San Francisco concert posters.",
    MELT_BANDS.slice(0, -1).map((band, i) => boundary(
      twirledLineNodes([0, 0.32 + 0.18 * i], [1, 0.32 + 0.18 * i], 13, MELT_TWIRL), band, MELT_BANDS[i + 1]))),
  preset("spectrum-twirl", "Spectrum twirl", "A colour wheel's six hues twisted around a white hub, as a twirl filter bends a conic gradient.", [
    ...SPECTRUM.map((color, i) => boundary(twirledLineNodes(...spokeEnds(i * FULL_TURN / SPECTRUM.length), 5, SPECTRUM_TWIRL), [color])),
    boundary(ellipseNodes(0.5, 0.5, SPECTRUM_CORE), ["#fff8ee"], null, true),
  ]),
  preset("swirl-lollipop", "Swirl lollipop", "A rainbow pinwheel lollipop: six spiral bands winding into the centre on black.", [
    ...["#ff4d5e", "#ff9f40", "#ffe156", "#4fd67a", "#3fb8f0", "#9a6cf0"].map((color, i, colors) => boundary(
      coilNodes({ cx: 0.5, cy: 0.5, r0: 0, r1: 0.4, turns: 0.9, phase: i * FULL_TURN / colors.length }),
      [color], [colors[(i + 1) % colors.length]])),
    boundary(ellipseNodes(0.5, 0.5, 0.4), ["#101014"], ["#ffffff"], true),
  ]),
  preset("triple-spiral", "Triple spiral", "Three gold coils turning as one, after the Neolithic triple spiral carved at Newgrange.", [
    boundary(boxNodes(), closedRamp(["#1d3b3a", "#12292b", "#1d3b3a"]), null, true),
    ...[0, 1, 2].map((i) => {
      const a = -Math.PI / 2 + i * FULL_TURN / 3;
      return boundary(coilNodes({ cx: 0.5 + 0.215 * Math.cos(a), cy: 0.55 + 0.215 * Math.sin(a), r0: 0.01, r1: 0.19, turns: 2, phase: a + Math.PI * 0.75 }),
        ["#f6d77a", "#d9a63c", "#b07a26", "#8a5a1c"], ["#12292b", "#1a3533", "#20403d", "#1d3b3a"]);
    }),
  ]),
  preset("french-curl", "French curl", "Pastel coral, butter and sage curls stirred through a peach bath, after a 1647 French-curl endpaper.", [
    boundary(boxNodes(), closedRamp(["#f6b393", "#f9d59a", "#f3a488"]), null, true),
    ...[[0.27, 0.3, 0.22, 0], [0.74, 0.42, 0.21, 2.2], [0.34, 0.77, 0.19, 4.1]].map(([cx, cy, r1, phase], i) => boundary(
      coilNodes({ cx, cy, r0: 0.01, r1, turns: -2.25, phase }),
      [["#fff1cf", "#ee8a76", "#f6dc7c", "#f3a488"], ["#fdf0d4", "#a8c4cc", "#f7c98f", "#f6b393"], ["#fff3d6", "#9bb28a", "#f09b83", "#f9d59a"]][i],
      [["#f6dc7c", "#9bb28a", "#ee8a76", "#f3a488"], ["#ee8a76", "#f6dc7c", "#a8c4cc", "#f6b393"], ["#f6dc7c", "#ee8a76", "#a8c4cc", "#f9d59a"]][i])),
  ]),
  preset("nightingale-nest", "Nightingale's nest", "Four tight ebru snail curls in indigo, madder and saffron on cream, after the Turkish bülbül yuvası pattern.", [
    boundary(boxNodes(), closedRamp(["#efe2c6", "#e6d3ae", "#f2e6cc"]), null, true),
    ...[[0.27, 0.27, 1], [0.73, 0.27, -1], [0.27, 0.73, -1], [0.73, 0.73, 1]].map(([cx, cy, dir], i) => boundary(
      coilNodes({ cx, cy, r0: 0.005, r1: 0.19, turns: 2 * dir, phase: i * 1.3 }),
      ["#f4ead4", "#2c3e7a", "#b8412e", "#e6d3ae"], ["#2c3e7a", "#b8412e", "#e0a53a", "#e6d3ae"])),
  ]),
  preset("rose-marble", "Rose marble", "A quiet S of dove grey and rose through warm white, after a Dutch flow-marbled paper.",
    MARBLE_ROWS.map(([y, ramp], i) => boundary(i === 0 || i === MARBLE_ROWS.length - 1
      ? polylineNodes([[0, y], [1, y]]) : twirledLineNodes([0, y], [1, y], 12, MARBLE_TWIRL), ramp))),
  preset("kowhaiwhai-koru", "Kōwhaiwhai koru", "A cream-and-black koru stroke unfurling into its bulb on kōkōwai red, after Māori rafter painting.", [
    boundary(koruNodes(1), ["#f3e9d4"], ["#d4453b"]),
    boundary(koruNodes(KORU_CORE), ["#1d1b1f"], ["#f3e9d4"]),
  ]),
  preset("liquid-light", "Liquid light show", "Wobbling rings of red, blue and white oil in a projector dish, after 1960s wet light shows.", [
    boundary(boxNodes(), closedRamp(["#ffd84a", "#f7a52c", "#ffd84a"]), null, true),
    boundary(wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: 0.45, amp: 0.04, lobes: 3, n: 8 }), ["#f7a52c"], ["#f0561e"], true),
    boundary(wobbleRingNodes({ cx: 0.49, cy: 0.5, rx: 0.36, amp: 0.08, lobes: 2, phase: 1, n: 8 }), ["#f6f1e8"], ["#2f7fd6"], true),
    boundary(wobbleRingNodes({ cx: 0.51, cy: 0.49, rx: 0.25, amp: 0.1, lobes: 3, phase: 2, n: 8 }), ["#1d5fb8"], ["#7e0f2a"], true),
    boundary(wobbleRingNodes({ cx: 0.5, cy: 0.5, rx: 0.13, amp: 0.06, lobes: 2, phase: 0.5, n: 6 }), ["#a0142a"], ["#e0321f"], true),
    point(0.4, 0.62, "#8fd0ff"), point(0.6, 0.38, "#ffb070"),
  ]),
  preset("cataract-waves", "Cataract waves", "Crisp-edged diagonal waves of turquoise and vermilion fading to white, after Bridget Riley's Cataract 3 (1967).",
    ["#6d8fa6", "#3aa7d0", "#e0413a", "#3aa7d0", "#6d8fa6"].map((color, i) => boundary(
      waveLineNodes({ y0: 0.02 + i * 0.2, slope: 0.14, amp: 0.035, cycles: 1.5, spans: 6 }), ["#fbfbf8"], [color]))),
  preset("latte-heart", "Latte heart", "A layered milk-foam heart poured into crema in a white cup.", [
    boundary(boxNodes(), ["#eeeae3"], null, true),
    boundary(ellipseNodes(0.5, 0.5, 0.46), ["#e6e1d8"], [RIM], true),
    boundary(heartNodes(0.5, 0.5, 0.33), [CREMA], [FOAM], true),
    boundary(heartNodes(0.5, 0.45, 0.24), [FOAM], [CREMA], true),
    boundary(heartNodes(0.5, 0.42, 0.2), [CREMA], [FOAM], true),
  ]),
  preset("scream-sky", "Scream sky", "Blood-orange sky bands above a swirling blue fjord, after Munch's The Scream (1893).", [
    ...[[0.05, "#c9432a"], [0.15, "#e79a36"], [0.25, "#d4512c"], [0.35, "#eab553"]].map(([y, color], i) =>
      boundary(waveLineNodes({ y0: y, amp: 0.025, cycles: 1.25, phase: i * 1.3, spans: 5 }), [color])),
    boundary(catmullRomNodes([[0, 0.46], [0.35, 0.44], [0.6, 0.55], [0.42, 0.7], [0.66, 0.82], [1, 0.66]]),
      ["#e8b460", "#e7b963", "#d0a25a", "#8a86b0"], ["#2a347a", "#38479a", "#2c3a86", "#3a4d9c"]),
    boundary(catmullRomNodes([[0, 0.62], [0.2, 0.66], [0.26, 0.82], [0.2, 1]]), ["#3a4d9c"], ["#6a4c4a"]),
    boundary(polylineNodes([[0.2, 1], [1, 1]]), ["#b06a38"]),
  ]),
];

