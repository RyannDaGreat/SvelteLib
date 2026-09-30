/**
 * "Abstract": Multipoint presets drawn from how colour and composition are TAUGHT
 * and PRACTISED — Orphism (Robert Delaunay, Kupka), colour-field and quiet painting
 * (Newman, Louis, Noland, Agnes Martin, O'Keeffe's abstractions), light art (Turrell),
 * Albers' Interaction of Color, Itten's contrasts and Goethe's proportions, generative
 * art (the Chromie Squiggle), and the gradient-design craft of hue shifting and
 * perceptual (OKLab/OKLCH) ramps. Homages evoke palette and structure; none copies an
 * artwork. Coordinates are the unit paint box (y down). Sources: concerns.md (2026-09-30).
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, polylineNodes, rectNodes, hermiteNodes, finiteGeometry, mixHex } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;
// Unit-box corners clockwise from top-left; closed, it is the whole-box frame.
const BOX = [[0, 0], [1, 0], [1, 1], [0, 1]];

// ---------------------------------------------------------------- OKLab colour

// Björn Ottosson's OKLab (2020) matrices: linear sRGB → LMS, cube-rooted LMS → Lab, and inverses.
const RGB_TO_LMS = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]];
const LMS_TO_LAB = [[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]];
const LAB_TO_LMS = [[1, 0.3963377774, 0.2158037573], [1, -0.1055613458, -0.0638541728], [1, -0.0894841775, -1.2914855480]];
const LMS_TO_RGB = [[4.0767416621, -3.3077115913, 0.2309699292], [-1.2684380046, 2.6097574011, -0.3413193965], [-0.0041960863, -0.7034186147, 1.7076147010]];
const GAMUT_EPSILON = 1e-4;
const GAMUT_SEARCH_STEPS = 24; // halvings of chroma: far below one 8-bit code value

/** Pure function. 3×3 matrix times vector. @example mul3([[1,0,0],[0,2,0],[0,0,3]], [1,1,1]) // [1,2,3] */
const mul3 = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
/** Pure function. sRGB transfer, encoded → linear. @example toLinear(1) // 1 */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Pure function. sRGB transfer, linear → encoded. @example toEncoded(0) // 0 */
const toEncoded = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Pure function. #rrggbb → OKLCH [L, C, h] (h in radians; L, C in OKLab units).
 * @param {string} hex - #rrggbb colour.
 * @returns {number[]} [3] (lightness 0..1, chroma ≥ 0, hue radians).
 * @example hexToOklch("#ffffff").map((v) => +v.toFixed(3)) // [1,0,h] (h arbitrary at C = 0)
 * @example +hexToOklch("#ff0000")[0].toFixed(3) // 0.628
 */
export function hexToOklch(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`hexToOklch needs #rrggbb, got ${hex}`);
  const rgb = [0, 1, 2].map((i) => toLinear(parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255));
  const [L, a, b] = mul3(LMS_TO_LAB, mul3(RGB_TO_LMS, rgb).map(Math.cbrt));
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

/**
 * Pure function. OKLCH → linear sRGB, unclamped (may leave [0,1] out of gamut).
 * @param {number[]} lch - [L, C, h radians].
 * @returns {number[]} [3] linear (r,g,b).
 * @example oklchToLinear([1, 0, 0]).map((v) => +v.toFixed(3)) // [1,1,1]
 */
function oklchToLinear([L, C, h]) {
  return mul3(LMS_TO_RGB, mul3(LAB_TO_LMS, [L, C * Math.cos(h), C * Math.sin(h)]).map((v) => v ** 3));
}

/**
 * Pure function. OKLCH → #rrggbb, reducing chroma (keeping L and h) until in gamut,
 * so an over-saturated request lands on the nearest displayable colour of the SAME hue.
 * @param {number[]} lch - [L 0..1, C ≥ 0, h radians].
 * @returns {string} Lowercase #rrggbb.
 * @example oklchToHex([1, 0, 0]) // "#ffffff"
 * @example oklchToHex(hexToOklch("#3a86ff")) // "#3a86ff"
 */
export function oklchToHex([L, C, h]) {
  finiteGeometry([L, C, h]);
  const inGamut = (c) => oklchToLinear([L, c, h]).every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
  let chroma = C;
  if (!inGamut(chroma)) {
    let lo = 0, hi = C;
    for (let i = 0; i < GAMUT_SEARCH_STEPS; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
    chroma = lo;
  }
  return "#" + oklchToLinear([L, chroma, h]).map((v) =>
    Math.round(Math.min(1, Math.max(0, toEncoded(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * Pure function. Blend two colours in OKLCH along the SHORTER hue arc — the
 * perceptual fix for the sRGB "grey dead zone" (a straight sRGB line between
 * distant hues passes through desaturated grey). A near-grey end borrows the
 * other end's hue, so a fade to white does not swing through unrelated hues.
 * @param {string} a - Start #rrggbb.
 * @param {string} b - End #rrggbb.
 * @param {number} t - Fraction in [0,1].
 * @returns {string} #rrggbb.
 * @example oklchMix("#0000ff", "#ffff00", 0) // "#0000ff"
 * @example oklchMix("#2f6bff", "#ffd23f", 0.5) // a saturated green-teal, not sRGB's grey "#979f9f"
 */
export function oklchMix(a, b, t) {
  if (!(t >= 0 && t <= 1)) throw new Error(`oklchMix needs t in [0,1], got ${t}`);
  const GREY_CHROMA = 0.02;
  const [A, B] = [hexToOklch(a), hexToOklch(b)];
  if (A[1] < GREY_CHROMA) A[2] = B[2];
  if (B[1] < GREY_CHROMA) B[2] = A[2];
  let dh = B[2] - A[2];
  if (dh > Math.PI) dh -= FULL_TURN;
  if (dh < -Math.PI) dh += FULL_TURN;
  return oklchToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + dh * t]);
}

/**
 * Pure function. n colours evenly spaced from a to b in OKLCH (both ends included).
 * @param {string} a - Start #rrggbb.
 * @param {string} b - End #rrggbb.
 * @param {number} n - Count, integer ≥ 2.
 * @returns {string[]} [n] #rrggbb.
 * @example oklchRamp("#000000", "#ffffff", 3)[1] // "#636363" (perceptual mid-grey, not sRGB's #808080)
 */
export function oklchRamp(a, b, n) {
  if (!Number.isInteger(n) || n < 2) throw new Error("oklchRamp needs an integer count ≥ 2");
  return Array.from({ length: n }, (_, i) => oklchMix(a, b, i / (n - 1)));
}

/**
 * Pure function. A HUE-SHIFTED value ramp (the painter's / pixel artist's rule):
 * as a colour darkens its hue turns toward cool violet-blue, as it lightens toward
 * warm yellow, instead of only mixing in black or white ("straight ramps").
 * @param {string} base - Midtone #rrggbb.
 * @param {number} steps - Colours on EACH side of the base, integer ≥ 1.
 * @param {object} shift - {light: ΔL per step, hue: radians per step toward light (positive = warmer for reds/oranges)}.
 * @returns {string[]} [2·steps+1] from darkest to lightest, base in the middle.
 * @example hueShiftRamp("#e0603a", 1, {light: 0.15, hue: 0.3}).length // 3
 */
export function hueShiftRamp(base, steps, { light, hue }) {
  finiteGeometry([steps, light, hue]);
  if (!Number.isInteger(steps) || steps < 1) throw new Error("hueShiftRamp needs an integer steps ≥ 1");
  const [L, C, h] = hexToOklch(base);
  return Array.from({ length: 2 * steps + 1 }, (_, i) => {
    const k = i - steps;
    // Chroma peaks at the midtone and falls toward both ends, as on a real value ramp.
    return oklchToHex([Math.min(0.99, Math.max(0.05, L + light * k)), C * (1 - 0.12 * Math.abs(k)), h + hue * k]);
  });
}

// ------------------------------------------------------------------- geometry

/**
 * Pure function. Ellipse of `count` equal-angle cubics whose first node sits at screen
 * angle `phase` (0 = right, π/2 = down), clockwise on screen — so rightColor is INSIDE
 * and a closed colour ramp's origin is placed where the composition wants it.
 * Handle = radius · (4/3)·tan(π / (2·count)): 0.5523 for four spans (radial error
 * 0.03%), 0.7698 for three (0.16%, invisible) when the node budget is tight.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} rx - Positive horizontal radius.
 * @param {number} ry - Positive vertical radius.
 * @param {number} phase - Start angle in radians.
 * @param {number} count - Node count, integer ≥ 3; default 4.
 * @returns {number[][]} [count,6] anchor/relative-handle tuples; close the feature.
 * @example ellipseFrom(0.5, 0.5, 0.25, 0.25, 0)[0].map((v) => +v.toFixed(3)) // [0.75,0.5,0,-0.138,0,0.138]
 * @example ellipseFrom(0.5, 0.5, 0.25, 0.25, 0, 3).length // 3
 */
export function ellipseFrom(cx, cy, rx, ry, phase, count = 4) {
  finiteGeometry([cx, cy, rx, ry, phase, count]);
  if (rx <= 0 || ry <= 0 || !Number.isInteger(count) || count < 3) throw new Error("ellipseFrom needs positive radii and an integer count ≥ 3");
  const handle = 4 / 3 * Math.tan(Math.PI / (2 * count));
  return Array.from({ length: count }, (_, i) => {
    const angle = phase + i * FULL_TURN / count, c = Math.cos(angle), s = Math.sin(angle);
    const hx = -rx * s * handle, hy = ry * c * handle;
    return [cx + rx * c, cy + ry * s, -hx, -hy, hx, hy];
  });
}

/**
 * Pure function. Feature with explicitly placed arc-length stops (boundary() spaces
 * them evenly). Rows are [offset, leftColor, rightColor?]; a missing right colour
 * makes that stop single-valued, and any right colour at all makes the feature two-sided.
 * @param {number[][]} nodes - [N,6] geometry.
 * @param {Array[]} rows - [[offset, color, rightColor?], …] with increasing offsets in [0,1].
 * @param {boolean} closed - Connect last node to first.
 * @returns {object} Native feature with unit weight.
 * @example placedStops(polylineNodes([[0,0],[1,0]]), [[0,"#000000"],[0.8,"#ffffff"]]).stops[1].offset // 0.8
 */
export function placedStops(nodes, rows, closed = false) {
  if (!rows.length || rows.some(([offset], i) => !(offset >= 0 && offset <= 1) || (i && offset <= rows[i - 1][0])))
    throw new Error("placedStops needs increasing offsets in [0,1]");
  const twoSided = rows.some((row) => row.length > 2);
  return { nodes: nodes.map((node) => node.map((v) => v + 0)), stops: rows.map(([offset, color, right]) => ({ offset, color, rightColor: right ?? color })),
    twoSided, closed, weight: 1 };
}

/**
 * Pure function. Two-sided closed shape: `inside` colours face the interior of a clockwise outline.
 * @param {number[][]} nodes - [N,6] clockwise outline.
 * @param {string[]} inside - Interior ramp (closed ramps repeat the first colour last).
 * @param {string} outside - Constant exterior colour.
 * @returns {object} Closed two-sided feature.
 * @example disc(ellipseNodes(0.5,0.5,0.2), ["#ff0000"], "#ffffff").stops[0].rightColor // "#ff0000"
 */
export function disc(nodes, inside, outside) {
  return boundary(nodes, inside.map(() => outside), inside, true);
}

// Same span budget as the shared spiral/wave helpers: eight cubic spans per full turn.
const MAX_ANGLE_STEP = Math.PI / 4;

/**
 * Pure function. Circular arc with exact tangents, ≤ π/4 per cubic span.
 * Screen y points down, so increasing angle runs CLOCKWISE on screen and the
 * RIGHT of travel faces the centre.
 * @param {object} options - {cx, cy, radius > 0, start, end} angles in radians, start ≠ end.
 * @returns {number[][]} [N,6] tuples; 3 nodes for a quarter turn.
 * @example arcNodes({cx:0,cy:0,radius:1,start:0,end:Math.PI/2}).map((n)=>n.slice(0,2).map((v)=>+v.toFixed(3))) // [[1,0],[0.707,0.707],[0,1]]
 */
export function arcNodes({ cx, cy, radius, start, end }) {
  const sweep = end - start;
  finiteGeometry([cx, cy, radius, start, sweep]);
  if (radius <= 0 || sweep === 0) throw new Error("arcNodes needs a positive radius and a nonzero sweep");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP);
  return hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => {
    const angle = start + sweep * i / segments, c = Math.cos(angle), s = Math.sin(angle);
    return [cx + radius * c, cy + radius * s, -radius * sweep * s, radius * sweep * c];
  }), 1 / segments);
}

/**
 * Pure function. A sine wave pushed a constant distance along its LEFT normal
 * (screen-up for eastward travel) — one edge of a constant-width stroke.
 * Tangents come from a central difference of the offset curve (step 1e-6 of t).
 * Pick phase and cycles so the wave is flat at both ends (e.g. phase π/2, whole or
 * half cycles): then the offset ends stay exactly on x0 and x1.
 * @param {object} options - waveNodes' {x0,x1,y,amplitude,cycles,phase} plus offset (positive = left of travel).
 * @returns {number[][]} [N,6] tuples, N = one more than eight spans per cycle.
 * @example offsetWaveNodes({x0:0,x1:1,y:0.5,amplitude:0.1,cycles:1,phase:Math.PI/2,offset:0.05})[0].slice(0,2) // [0,0.55] (crest at y 0.6, lifted 0.05)
 */
export function offsetWaveNodes({ x0, x1, y, amplitude, cycles, phase, offset }) {
  const DIFF_STEP = 1e-6;
  const sweep = FULL_TURN * cycles, width = x1 - x0;
  finiteGeometry([x0, x1, y, amplitude, sweep, phase, offset]);
  if (!width || !cycles) throw new Error("offsetWaveNodes needs a nonzero width and cycle count");
  /** Pure function. Offset-curve point at parameter t. */
  const at = (t) => {
    const angle = sweep * t + phase, dx = width, dy = amplitude * sweep * Math.cos(angle), length = Math.hypot(dx, dy);
    return [x0 + width * t + offset * dy / length, y + amplitude * Math.sin(angle) - offset * dx / length];
  };
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP));
  return hermiteNodes(Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, [x, yy] = at(t), [xa, ya] = at(t - DIFF_STEP), [xb, yb] = at(t + DIFF_STEP);
    return [x, yy, (xb - xa) / (2 * DIFF_STEP), (yb - ya) / (2 * DIFF_STEP)];
  }), 1 / segments);
}

/**
 * Pure function. A thin painted line that fades into the field at both ends: two
 * parallel two-sided segments `width` apart hold the line colour between them, and
 * every stop at the ends is field-on-both-sides, so no open end leaves a speck.
 * @param {object} options - {from:[x,y], to:[x,y], width > 0, line:[start,end] colours,
 *   field:[start,end] colours around it, fade: fraction of length used by each end taper}.
 * @returns {object[]} Two open two-sided features (4 nodes).
 * @example taperedLine({from:[0.1,0.9], to:[0.9,0.9], width:0.01, line:["#ff0000","#ffff00"], field:["#cccccc","#cccccc"], fade:0.15}).length // 2
 */
export function taperedLine({ from, to, width, line, field, fade }) {
  finiteGeometry([...from, ...to, width, fade]);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (!length || width <= 0 || !(fade > 0 && fade < 0.5)) throw new Error("taperedLine needs distinct ends, a positive width and fade in (0, ½)");
  // Left normal of travel (screen y down): (dy, −dx)/length.
  const nx = (to[1] - from[1]) / length * width / 2, ny = -(to[0] - from[0]) / length * width / 2;
  const edge = (sign) => polylineNodes([[from[0] + sign * nx, from[1] + sign * ny], [to[0] + sign * nx, to[1] + sign * ny]]);
  // The left edge has the stroke on its RIGHT; the right edge has it on its LEFT.
  return [
    placedStops(edge(1), [[0, field[0]], [fade, field[0], line[0]], [1 - fade, field[1], line[1]], [1, field[1]]]),
    placedStops(edge(-1), [[0, field[0]], [fade, line[0], field[0]], [1 - fade, line[1], field[1]], [1, field[1]]]),
  ];
}

/** Pure function. A two-node straight segment. @example segment(0,0,1,0).length // 2 */
const segment = (x0, y0, x1, y1) => polylineNodes([[x0, y0], [x1, y1]]);

/**
 * Pure function. Stop rows for a closed curve whose ramp is split into two halves
 * with short soft seams: the SECOND pair holds from offset `seam` to ½, the FIRST
 * pair from ½ + seam to 1 (and wraps to 0). With ellipseFrom's phase φ, the second
 * pair occupies the half turning clockwise from φ. Four stops, first = last, so the
 * closed-ramp seam rule holds.
 * @param {string[]} first - [left, right] colours of the first half.
 * @param {string[]} second - [left, right] colours of the second half.
 * @param {number} seam - Seam width as a fraction of the perimeter, in (0, 0.25).
 * @returns {Array[]} [4,3] rows for placedStops.
 * @example halves(["#000000","#111111"], ["#ffffff","#eeeeee"], 0.01)[1] // [0.01,"#ffffff","#eeeeee"]
 */
export function halves(first, second, seam) {
  if (!(seam > 0 && seam < 0.25)) throw new Error("halves needs a seam in (0, 0.25)");
  return [[0, ...first], [seam, ...second], [0.5, ...second], [0.5 + seam, ...first]];
}

// ------------------------------------------------------------------- presets

// Robert Delaunay, "Premier Disque" (1913): a tondo of concentric bands, each band
// split so warm meets cool across the vertical diameter (Chevreul's simultaneous contrast).
// [left half, right half] per band, outermost first; the last entry is the centre.
const DISQUE_BANDS = [["#5b3d8f", "#7896d6"], ["#c98b2e", "#7b8a3c"], ["#efe6c8", "#a3302a"],
  ["#7a4aa0", "#243f7a"], ["#9fb2e6", "#e7b52e"], ["#b890d8", "#6c8fd0"], ["#e0432c", "#3f73c8"]];
const DISQUE_RADII = [0.47, 0.405, 0.34, 0.275, 0.21, 0.145, 0.075];
const DISQUE_GROUND = "#efe9dc";
const DISQUE_SEAM = 0.006;
const simultaneousDisc = preset("simultaneous-disc", "Simultaneous disc",
  "Concentric bands split down the middle so each warm half meets a cool one, after Delaunay's first disc.",
  DISQUE_RADII.map((radius, i) => {
    const outside = i ? DISQUE_BANDS[i - 1] : [DISQUE_GROUND, DISQUE_GROUND], inside = DISQUE_BANDS[i];
    // Phase −π/2 starts at the top, so the second (clockwise) half is the RIGHT half.
    return placedStops(ellipseFrom(0.5, 0.5, radius, radius, -Math.PI / 2),
      halves([outside[0], inside[0]], [outside[1], inside[1]], DISQUE_SEAM), true);
  }));

// Robert Delaunay, "Formes circulaires, Lune no. 1" (1913): an orange-red ring around a
// pale moon, a green crescent between, all on ultramarine.
const moonForms = preset("moon-forms", "Moon forms",
  "A pale moon cupped by a green crescent inside a red-orange ring, on ultramarine — Delaunay's circular forms.", [
    boundary(polylineNodes(BOX), ["#3557b8", "#4c70d2", "#5b3f98", "#3557b8"], null, true),
    boundary(ellipseFrom(0.5, 0.52, 0.43, 0.45, Math.PI), ["#3a5fc4", "#3a5fc4", "#3a5fc4", "#3a5fc4"],
      ["#c8412e", "#f08a3c", "#e98f8a", "#c8412e"], true),
    boundary(ellipseFrom(0.5, 0.52, 0.33, 0.35, Math.PI), ["#c8412e", "#f08a3c", "#e98f8a", "#c8412e"],
      ["#6d90dc", "#88a8e8", "#5476cc", "#6d90dc"], true),
    disc(ellipseNodes(0.44, 0.52, 0.21, 0.25), ["#76c49a"], "#6d90dc"),
    disc(ellipseNodes(0.49, 0.46, 0.13, 0.16), ["#f8eff2", "#ecc8d8", "#f8eff2"], "#76c49a"),
  ]);

// Barnett Newman, "Vir Heroicus Sublimis" (1950-51): one cadmium field, broken only by "zips".
const NEWMAN_RED = ["#d9301c", "#cf2419", "#c21c1c", "#d9301c"];
/** Pure function. A thin vertical zip as a two-sided rectangle. @example zip(0.3, 0.01, "#ffffff").closed // true */
const zip = (x, width, color) => disc(rectNodes(x - width / 2, 0, x + width / 2, 1), [color], NEWMAN_RED[1]);
const zipField = preset("zip-field", "Zip field",
  "A single cadmium-red field split by thin white, maroon and salmon zips, after Newman.", [
    boundary(polylineNodes(BOX), NEWMAN_RED, null, true),
    zip(0.08, 0.006, "#f2a07c"), zip(0.3, 0.012, "#f7f1e6"), zip(0.74, 0.016, "#3a0c10"), zip(0.9, 0.006, "#f2a07c"),
  ]);

// Morris Louis, "Alpha-Pi" (1960, an "Unfurled"): poured rivulets stream diagonally from the
// two lower corners and never meet; the raw canvas centre stays empty.
const LOUIS_CANVAS = "#f3efe6";
const LOUIS_LEFT = ["#e8742a", "#1f2a4a", "#f2c230", "#1f7a4a", "#c0282e", "#2a4aa0"];
const LOUIS_RIGHT = ["#1f5a3e", "#c79a3a", "#e05a2a", "#7a2a5a", "#2b3f8f", "#d0402a"];
/**
 * Pure function. Stripes of flat colour between parallel two-sided curves running from
 * a vertical box edge to the bottom edge: flat because each curve's corner-side colour
 * equals the next curve's canvas-side colour.
 * @param {number} side - 0 for the left edge, 1 for the right.
 * @param {string[]} colors - Stripe colours from the canvas side to the corner.
 * @returns {object[]} colors.length open two-sided features.
 * @example rivulets(0, ["#ff0000", "#0000ff"]).length // 2
 */
function rivulets(side, colors) {
  const RIVULET_TOP = 0.1, RIVULET_STEP = 0.055, RIVULET_FOOT = 0.42, RIVULET_SAG = 0.03;
  return colors.map((color, i) => {
    const y0 = RIVULET_TOP + i * RIVULET_STEP, reach = RIVULET_FOOT - i * RIVULET_STEP;
    const edgeX = side, footX = side ? 1 - reach : reach, dir = side ? -1 : 1;
    // Travel from the vertical edge down to the floor; a slight inward sag like pooled paint.
    const nodes = [[edgeX, y0, 0, 0, dir * RIVULET_SAG, (1 - y0) * 0.4], [footX, 1, -dir * RIVULET_SAG, -(1 - y0) * 0.25, 0, 0]];
    const canvasSide = i ? colors[i - 1] : LOUIS_CANVAS;
    // Leftward travel (right group) puts the canvas on the RIGHT of travel.
    return side ? boundary(nodes, [color], [canvasSide]) : boundary(nodes, [canvasSide], [color]);
  });
}
const unfurled = preset("unfurled-rivulets", "Unfurled",
  "Poured stripes of orange, ink, yellow and green streaming from the lower corners around bare canvas, after Morris Louis.",
  [...rivulets(0, LOUIS_LEFT), ...rivulets(1, LOUIS_RIGHT)]);

// Kenneth Noland, "Turnsole" (1961): concentric bands of colour on raw canvas.
const NOLAND_CANVAS = "#f1ede2";
/**
 * Pure function. A crisp annulus: two concentric two-sided circles with `ground` outside both.
 * @param {number} r0 - Inner radius.
 * @param {number} r1 - Outer radius, > r0.
 * @param {string} color - Band colour.
 * @param {string} ground - Colour on both sides of the band.
 * @returns {object[]} [outer, inner] features.
 * @example band(0.1, 0.2, "#ff0000", "#ffffff")[1].stops[0].color // "#ff0000"
 */
function band(r0, r1, color, ground) {
  return [disc(ellipseNodes(0.5, 0.5, r1), [color], ground), boundary(ellipseNodes(0.5, 0.5, r0), [color], [ground], true)];
}
const targetRings = preset("target-rings", "Target",
  "Sky-blue, marigold and black rings around a cobalt eye on raw canvas, after Noland's targets.", [
    ...band(0.44, 0.48, "#a9d6ea", NOLAND_CANVAS), ...band(0.37, 0.415, "#f2a93b", NOLAND_CANVAS),
    ...band(0.19, 0.245, "#26221f", NOLAND_CANVAS), ...band(0.05, 0.095, "#a9d6ea", NOLAND_CANVAS),
    disc(ellipseNodes(0.5, 0.5, 0.016), ["#2f56c0"], NOLAND_CANVAS),
  ]);

// James Turrell, "Aten Reign" (2013): nested ellipses of coloured light, each stepping
// a little lighter inward, rising toward the oculus. Moon white → dusk pink → magenta.
const ATEN = [["#7a1450", "#9a1c5e"], ["#b8286e", "#d03c78"], ["#e3608a", "#ec7a94"], ["#f4a09a", "#f8b8a4"], ["#fbdccc", "#fde9dc"]];
const skyspace = preset("skyspace-glow", "Skyspace",
  "Nested ellipses of light stepping from magenta to moon-white toward a high oculus, after Turrell.", [
    boundary(polylineNodes(BOX), ["#5e0e3e"], null, true),
    ...ATEN.map(([outside, inside], i) => boundary(ellipseNodes(0.5, 0.51 - 0.035 * i, 0.44 - 0.085 * i, 0.45 - 0.085 * i), [outside], [inside], true)),
  ]);

// Georgia O'Keeffe, "Light Coming on the Plains No. II" (1917): a Prussian-blue dome of
// watercolour on tan paper, dawn light welling up from its base.
const OKEEFFE_PAPER = "#d8ab78";
const plainsLight = preset("plains-light", "Plains light",
  "A blue watercolour dome on tan paper with pale dawn light welling up from its base, after O'Keeffe.", [
    boundary(polylineNodes(BOX), [OKEEFFE_PAPER, "#dcb382", "#d2a270", OKEEFFE_PAPER], null, true),
    boundary([[0.16, 0.9, 0, 0, 0, -0.5], [0.5, 0.08, -0.24, 0, 0.24, 0], [0.84, 0.9, 0, -0.5, 0, 0]],
      [OKEEFFE_PAPER, OKEEFFE_PAPER, OKEEFFE_PAPER, OKEEFFE_PAPER], ["#2a4e7a", "#1a3560", "#23456f", "#2a4e7a"], true),
    boundary(ellipseNodes(0.5, 0.75, 0.05, 0.03), ["#f4ecc4"], null, true),
    boundary(ellipseNodes(0.5, 0.69, 0.21, 0.15), ["#7aa0b4"], null, true),
    ...taperedLine({ from: [0.19, 0.872], to: [0.81, 0.872], width: 0.008, line: ["#d9b98a", "#d9b98a"], field: ["#2a4e7a", "#2a4e7a"], fade: 0.1 }),
  ]);

// Josef Albers, "Interaction of Color" — "1 color appears as 2": one violet laid on a
// light orchid ground and on a deep indigo ground reads lighter on the dark, darker on the light.
const ALBERS_LIGHT = "#b566a9", ALBERS_DARK = "#3c2160", ALBERS_SAME = "#8b4f97";
/** Pure function. A slightly tilted slab (clockwise quad). @example slab(0.25, 0.5, 0.1, 0.3, 0.02)[0][0] // 0.17 */
const slab = (cx, cy, hw, hh, tilt) => polylineNodes([[cx - hw + tilt, cy - hh], [cx + hw + tilt, cy - hh], [cx + hw - tilt, cy + hh], [cx - hw - tilt, cy + hh]]);
const oneAsTwo = preset("one-as-two", "One as two",
  "The same violet on light orchid and on deep indigo, reading as two colours — Albers' Interaction of Color.", [
    boundary(segment(0, 0, 0, 1), [ALBERS_LIGHT]),
    boundary(segment(0.5, 0, 0.5, 1), [ALBERS_DARK], [ALBERS_LIGHT]),
    boundary(segment(1, 0, 1, 1), [ALBERS_DARK]),
    disc(slab(0.25, 0.5, 0.11, 0.3, 0.015), [ALBERS_SAME], ALBERS_LIGHT),
    disc(slab(0.75, 0.5, 0.11, 0.3, 0.015), [ALBERS_SAME], ALBERS_DARK),
  ]);

// Goethe's light values (yellow 9 : violet 3) set Itten's "contrast of extension": for
// balance, yellow gets a THIRD of violet's area — a disc of a quarter of the box.
const GOETHE_YELLOW_SHARE = 1 / 4;
const GOETHE_RADIUS = Math.sqrt(GOETHE_YELLOW_SHARE / Math.PI);
const goetheBalance = preset("goethe-balance", "Goethe's balance",
  "A yellow sun holding exactly a quarter of a violet field — Goethe's 1:3 light proportion, as Itten taught it.", [
    boundary(polylineNodes(BOX), ["#4b2b8a", "#3a2074", "#281658", "#4b2b8a"], null, true),
    disc(ellipseFrom(0.6, 0.42, GOETHE_RADIUS, GOETHE_RADIUS, -3 * Math.PI / 4), ["#fff0a0", "#ffd43a", "#f5b425", "#fff0a0"], "#3c2378"),
  ]);

// Itten's cold-warm contrast: the warmest pole (red-orange) faces the coldest (blue-green)
// across one S-shaped seam; each side stays within its own analogous family.
const WARM = ["#ffc53d", "#f25a28", "#c81e3c"], COOL = ["#2f86d8", "#12a597", "#3b3f9e"];
const warmCold = preset("warm-cold", "Warm & cold",
  "Yellow, red-orange and crimson meet blue, blue-green and indigo along one S-curve — Itten's warm-cold contrast.", [
    boundary(segment(0, 0, 0, 1), [mixHex(WARM[0], "#ffffff", 0.15), WARM[1], mixHex(WARM[2], "#000000", 0.1)]),
    // Southward travel: the RIGHT of travel is the western (warm) half.
    boundary([[0.36, 0, 0, 0, 0.3, 0.25], [0.64, 1, -0.3, -0.25, 0, 0]], COOL, WARM),
    boundary(segment(1, 0, 1, 1), [mixHex(COOL[0], "#ffffff", 0.1), COOL[1], mixHex(COOL[2], "#000000", 0.15)]),
  ]);

// Perceptual (OKLCH) ramps: blue and yellow are near-complementary, so an sRGB blend
// between them sags into grey. Every edge here carries OKLCH-interpolated stops, so the
// diagonal travels AROUND the colour wheel (blue → teal → green → yellow) instead.
const SWEEP_FROM = "#2f6bff", SWEEP_TO = "#ffd23f";
const perceptualSweep = preset("perceptual-sweep", "Perceptual sweep",
  "Blue to yellow through teal and green with no grey dead zone: both L-shaped rims carry OKLCH stops.", [
    boundary(polylineNodes([BOX[0], BOX[1], BOX[2]]), oklchRamp(SWEEP_FROM, SWEEP_TO, 4)),
    boundary(polylineNodes([BOX[2], BOX[3], BOX[0]]), oklchRamp(SWEEP_TO, SWEEP_FROM, 4)),
  ]);

// Pixel-art / painting hue shifting: a value ramp whose darks turn cool violet and whose
// lights turn warm peach, posterized into crisp arcs around a light in the top-left corner.
const HUE_SHIFT = hueShiftRamp("#d8506a", 3, { light: 0.1, hue: 0.25 }).reverse(); // lightest first
const HUE_ARC_RADII = [0.2, 0.36, 0.52, 0.68, 0.84, 1];
const hueShiftArcs = preset("hue-shift-ramp", "Hue-shift ramp",
  "Seven posterized arcs from peach light to plum shadow, the hue turning as the value falls — the pixel artist's hue-shifted ramp.",
  HUE_ARC_RADII.map((radius, i) => boundary(arcNodes({ cx: 0, cy: 0, radius, start: 0, end: Math.PI / 2 }), [HUE_SHIFT[i + 1]], [HUE_SHIFT[i]])));

// Snowfro's "Chromie Squiggle" (Art Blocks, 2020): one fat sine stroke whose hue runs
// the spectrum end to end. The stroke is the band between two offset waves.
const SQUIGGLE = { x0: 0, x1: 1, y: 0.5, amplitude: 0.2, cycles: 1.5, phase: Math.PI / 2 };
const SQUIGGLE_HALF_WIDTH = 0.055, SQUIGGLE_GROUND = "#f6f2ea";
const SQUIGGLE_SPECTRUM = ["#ff4d6d", "#ffc23a", "#2fd8a0", "#5a63ff"];
const rainbowSquiggle = preset("rainbow-squiggle", "Squiggle",
  "One fat sine stroke running coral, amber, mint and violet-blue across warm white, after the generative Chromie Squiggle.", [
    boundary(segment(0, 0, 1, 0), [SQUIGGLE_GROUND]),
    // Eastward travel: the stroke lies RIGHT of its upper edge and LEFT of its lower edge.
    boundary(offsetWaveNodes({ ...SQUIGGLE, offset: SQUIGGLE_HALF_WIDTH }), SQUIGGLE_SPECTRUM.map(() => SQUIGGLE_GROUND), SQUIGGLE_SPECTRUM),
    boundary(offsetWaveNodes({ ...SQUIGGLE, offset: -SQUIGGLE_HALF_WIDTH }), SQUIGGLE_SPECTRUM, SQUIGGLE_SPECTRUM.map(() => SQUIGGLE_GROUND)),
    boundary(segment(0, 1, 1, 1), [SQUIGGLE_GROUND]),
  ]);

// Robert Delaunay, "Rythme" (1934): split black-and-white discs chained on a diagonal,
// each backed by a half-and-half halo of complementary colour, on grey canvas. Two large
// units rather than the painting's three: every split must be a real chord to stay crisp,
// and three chords per unit only fit the 12-feature budget twice.
const RYTHME_GROUND = "#d9d5cd", RYTHME_BLACK = "#16161a", RYTHME_WHITE = "#f4f1ea", RYTHME_SEAM = 0.006;
// Chain direction runs bottom-left → top-right; phase 3π/4 starts the ring at its lower-left,
// so a ring's SECOND half (clockwise) is its upper-left half.
const RYTHME_SPLIT = 3 * Math.PI / 4;
/**
 * Pure function. One Rythme unit whose every split is crisp: 3-node circles, a
 * core chord, and one 3-node chord on each side crossing the ring (halo | ring colours
 * switch where it crosses the ring circle).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number[]} radii - [halo, ring, core] radii, decreasing.
 * @param {string[]} halo - [lower-right, upper-left] halo colours.
 * @returns {object[]} Six features, 17 nodes.
 * @example rythmeUnit(0.5, 0.5, [0.24, 0.16, 0.1], ["#ff0000", "#0000ff"]).length // 6
 */
function rythmeUnit(cx, cy, [haloR, ringR, coreR], halo) {
  const NODES = 3, SWITCH = 0.02;
  const ring = [RYTHME_BLACK, RYTHME_WHITE], core = [RYTHME_WHITE, RYTHME_BLACK]; // [lower-right, upper-left]
  const circle = (r, outside, inside) => placedStops(ellipseFrom(cx, cy, r, r, RYTHME_SPLIT, NODES),
    halves([outside[0], inside[0]], [outside[1], inside[1]], RYTHME_SEAM), true);
  const seamAngle = RYTHME_SPLIT + Math.PI * RYTHME_SEAM;
  const at = (r, angle) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  const [low, high] = [seamAngle, seamAngle + Math.PI];
  // Every chord travels lower-left → upper-right, so rows are [upper-left, lower-right].
  const inward = (haloR - ringR) / (haloR - coreR), outward = (ringR - coreR) / (haloR - coreR);
  return [circle(haloR, [RYTHME_GROUND, RYTHME_GROUND], halo), circle(ringR, halo, ring), circle(coreR, ring, core),
    boundary(polylineNodes([at(coreR, low), at(coreR, high)]), [core[1]], [core[0]]),
    placedStops(polylineNodes([at(haloR, low), at(ringR, low), at(coreR, low)]),
      [[0, halo[1], halo[0]], [inward - SWITCH, halo[1], halo[0]], [inward + SWITCH, ring[1], ring[0]], [1, ring[1], ring[0]]]),
    placedStops(polylineNodes([at(coreR, high), at(ringR, high), at(haloR, high)]),
      [[0, ring[1], ring[0]], [outward - SWITCH, ring[1], ring[0]], [outward + SWITCH, halo[1], halo[0]], [1, halo[1], halo[0]]])];
}
const rythmePair = preset("rythme-pair", "Rythme",
  "Two crisp split discs, black against white, over red-green and yellow-blue halos, after Delaunay.", [
    ...rythmeUnit(0.33, 0.67, [0.24, 0.16, 0.105], ["#e0402a", "#1f8a6e"]),
    ...rythmeUnit(0.69, 0.31, [0.24, 0.16, 0.105], ["#f2d83a", "#2a45b0"]),
  ]);

// František Kupka, "Disks of Newton" (1912): nested, off-centre discs of spectral colour
// that seem to spin; each band carries its own three-hue ring of light.
const NEWTON_GROUND = "#1b2340";
const NEWTON_BANDS = [["#3a4fa8", "#8a5ac0", "#c4b2ec"], ["#e0506e", "#f08a3a", "#c23a4a"], ["#f5d04a", "#9bd06a", "#f5a83a"],
  ["#3aa89a", "#4a7ad8", "#6ac0e8"], ["#f04a3a", "#f7c0b0", "#e8703a"]];
const NEWTON_RADII = [0.45, 0.36, 0.27, 0.18, 0.09];
/** Pure function. A three-hue closed ramp (first repeated last). @example ring3(["#a","#b","#c"]) // ["#a","#b","#c","#a"] */
const ring3 = ([a, b, c]) => [a, b, c, a];
const newtonDiscs = preset("newton-discs", "Newton's discs",
  "Off-centre discs nested like spinning colour wheels — blue-violet, rose, yellow, teal and red — after Kupka.",
  NEWTON_RADII.map((radius, i) => boundary(ellipseFrom(0.46 + 0.025 * i, 0.54 - 0.025 * i, radius, radius, -Math.PI / 2 + i * 0.6),
    i ? ring3(NEWTON_BANDS[i - 1]) : ring3([NEWTON_GROUND, NEWTON_GROUND, NEWTON_GROUND]), ring3(NEWTON_BANDS[i]), true)));

// Agnes Martin, "Untitled" (1977, watercolour and graphite): pale bands of blue-grey and
// cream inside a square whose rim is stained warm ochre, on a paper margin.
const MARTIN_PAPER = "#f0e8d8", MARTIN_STAIN = "#e0b574";
// Top to bottom; the washes alternate cream and blue-grey as in the watercolour.
const MARTIN_WASHES = ["#efe6d2", "#c9d0da", "#efe6d2", "#c6cdd8", "#ede4d0", "#c9d0da", "#efe6d2", "#c6cdd8", "#efe6d2"];
const MARTIN_FRAME = [0.1, 0.1, 0.9, 0.9], MARTIN_FADE = 0.04;
const MARTIN_STEP = (MARTIN_FRAME[3] - MARTIN_FRAME[1]) / MARTIN_WASHES.length;
const paleBands = preset("pale-bands", "Pale bands",
  "Flat washes of cream and blue-grey ruled by fine lines inside an ochre-stained square, after Agnes Martin.", [
    boundary(polylineNodes(BOX), [MARTIN_PAPER], null, true),
    disc(rectNodes(...MARTIN_FRAME), [MARTIN_STAIN], MARTIN_PAPER),
    // Eastward rule lines: LEFT of travel is the wash above, RIGHT the wash below; both
    // turn stain-coloured where the line meets the rim, so the rim has no notch.
    ...MARTIN_WASHES.slice(1).map((below, i) => {
      const y = MARTIN_FRAME[1] + (i + 1) * MARTIN_STEP, above = MARTIN_WASHES[i];
      return placedStops(segment(MARTIN_FRAME[0], y, MARTIN_FRAME[2], y),
        [[0, MARTIN_STAIN], [MARTIN_FADE, above, below], [1 - MARTIN_FADE, above, below], [1, MARTIN_STAIN]]);
    }),
  ]);

export const PRESETS = [simultaneousDisc, rythmePair, moonForms, newtonDiscs, zipField, unfurled, targetRings, paleBands,
  skyspace, plainsLight, oneAsTwo, goetheBalance, warmCold, perceptualSweep, hueShiftArcs, rainbowSquiggle];
