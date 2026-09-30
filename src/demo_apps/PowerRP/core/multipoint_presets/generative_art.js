/**
 * "Generative art" — native Multipoint presets. Flow fields, Vera Molnár, Georg Nees and Manfred Mohr: plotter-era and generative structures.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, closedRamp } from "./builders.js";
import { rectNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { insetConvex } from "./retro_eras.js";
import { flowBandNodes, withOffsets, alongSpine, fitRange, quadSpine, spunSquare, cubeFaces } from "./generative_helpers.js";

const band = (pts, widths, fill, ground) => boundary(flowBandNodes(pts, widths), [ground], [fill], true);

const bandAlong = (spine, d, t0, t1, w, fill, ground, n = 3) => band(alongSpine(spine, d, t0, t1, n), Array(n).fill(w), fill, ground);

const MARGIN = 0.03;

const bandFit = (spine, d, w, fill, ground, lo = -0.5, hi = 1.5, n = 3) => {
  const [a, b] = fitRange(spine, d, w, lo, hi, MARGIN);
  return bandAlong(spine, d, a, b, w, fill, ground, n);
};

const FID_GROUND = "#e9e4d9", FID_INK = "#1a1a1a";

const fidA = quadSpine([0.06, 0.4], [0.5, 0.42], [0.42, 0.92]), fidB = quadSpine([0.14, 0.1], [0.88, 0.12], [0.86, 0.92]);

/** Backdrop: clockwise closed ramp around the box border (from top-left), one colour = flat. */
const frame = (colors) => boundary(rectNodes(0, 0, 1, 1), colors.length > 1 ? closedRamp(colors.slice(0, 3)) : colors, null, true);

const sharp = (pts) => polylineNodes(pts);

const RAD = Math.PI / 180;

export const PRESETS = [
  preset("fidenza-ink", "Fidenza ink", "Six square-cut ink ribbons sweeping in two nested hooks across warm cream, after Tyler Hobbs's flow-field Fidenza (2021).", [
  ...[[-0.1, 0.05], [0, 0.09], [0.11, 0.06]].map(([d, w]) => bandFit(fidA, d, w, FID_INK, FID_GROUND, 0, 1)),
  ...[[-0.1, 0.06], [0.0, 0.1], [0.12, 0.05]].map(([d, w]) => bandFit(fidB, d, w, FID_INK, FID_GROUND, 0, 1)),
]),
  // ---- Fidenza tangerine
  (() => {
  const ground = "#efe6d4";
  const A = quadSpine([0.06, 0.88], [0.56, 0.9], [0.9, 0.52]), B = quadSpine([0.08, 0.5], [0.38, 0.5], [0.66, 0.08]);
  return preset("fidenza-tangerine", "Fidenza tangerine", "Tangerine, ink, teal, mustard and red ribbons riding two upward flow-field arcs on cream, after Tyler Hobbs's Fidenza palettes.", [
    ...[[-0.1, 0.06, "#e8541e"], [0.0, 0.1, "#1b1b1b"], [0.12, 0.05, "#2c7f8a"]].map(([d, w, c]) => bandFit(A, d, w, c, ground, 0, 1)),
    ...[[-0.1, 0.05, "#f2b632"], [0.0, 0.09, "#c8353a"], [0.11, 0.06, "#1b1b1b"]].map(([d, w, c]) => bandFit(B, d, w, c, ground, 0, 1)),
  ]);
})(),
  // ---- Molnar nested squares
  (() => {
  const ground = "#efe9dc";
  const bands = [ground, "#c8342b", ground, "#1f3d7a", ground, "#e2a83b"];
  const rings = [[0.44, 0.44, 0], [0.36, 0.35, 3.5], [0.28, 0.28, -2.5], [0.2, 0.21, 6], [0.12, 0.12, -5]];
  return preset("molnar-nested-squares", "Molnar nested squares", "Red, cream, blue and gold squares nested and slightly askew, after Vera Molnar's Structures de quadrilateres.", rings.map(([hw, hh, deg], i) =>
    boundary(sharp(spunSquare(0.5, 0.5, hw, hh, deg * RAD)), [bands[i]], [bands[i + 1]], true)));
})(),
  // ---- Nees Schotter
  (() => {
  const ground = "#efe9dc", inks = ["#1c1c22", "#d4402f", "#2d5fa8"];
  const cells = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const k = row * 3 + col, disorder = k / 8;
    cells.push(boundary(sharp(spunSquare(0.2 + col * 0.3, 0.2 + row * 0.3, 0.1, 0.1, (k % 2 ? 1 : -1) * disorder * 0.55 + 0.0,
      [[0, 0], [disorder * 0.02, -disorder * 0.01], [0, disorder * 0.015], [-disorder * 0.012, 0]])), [ground], [inks[k % 3]], true));
  }
  return preset("schotter-grid", "Schotter grid", "A three-by-three grid of ink, red and blue squares tumbling into disorder, after Georg Nees's Schotter (1968).", [frame([ground]), ...cells]);
})(),
  // ---- Mohr cube
  (() => {
  const NIGHT = "#0b0b10", SHADE = "#2b3140", LIT = "#f6f2e6";
  const perimeter = (q) => q.map((p, i) => Math.hypot(q[(i + 1) % 4][0] - p[0], q[(i + 1) % 4][1] - p[1]));
  const face = ({ quad, shade }, focus) => {
    const q = insetConvex(quad, 0.006), lens = perimeter(q), total = lens.reduce((a, b) => a + b);
    // Brightness falls off with distance from the lamp position `focus`, on top of the face's own orientation shade.
    const colorAt = ([x, y]) => mixHex(SHADE, LIT, Math.min(1, Math.max(0, 0.18 + shade * 0.9 - 0.55 * Math.hypot(x - focus[0], y - focus[1]))));
    const offs = [0, lens[0] / total, (lens[0] + lens[1]) / total, 1];
    return withOffsets(boundary(sharp(q), [NIGHT, NIGHT, NIGHT, NIGHT], [colorAt(q[0]), colorAt(q[1]), colorAt(q[2]), colorAt(q[0])], true), offs);
  };
  const cube = (o, focus) => cubeFaces(o).map((f) => face(f, focus));
  return preset("mohr-cube", "Mohr cube", "Two lit cubes tumbling in black space with thin gaps between faces, after Manfred Mohr's cube studies.", [
    ...cube({ cx: 0.46, cy: 0.56, size: 0.46, rx: 0.62, ry: 0.55, rz: 0.15 }, [0.3, 0.3]),
    ...cube({ cx: 0.83, cy: 0.19, size: 0.18, rx: -0.5, ry: 0.4, rz: 0.4 }, [0.7, 0.1]),
  ]);
})(),
];
