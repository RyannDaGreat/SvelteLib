/**
 * "Op art & spirals" — native Multipoint presets. Riley, Vasarely, Soto, Duchamp's Rotoreliefs, Cruz-Diez, Anuszkiewicz, Stanczak and Agam: vibrating stripes, bulges and spirals.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, rectNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { squircleNodes } from "./art_homages.js";
import { sampledNodes, coilNodes } from "./swirls.js";
import { bandStack, ringStack, vLine, hLine, graphNodes, vWaveNodes, geometricStops, polyNodes, rotated } from "./op_art_helpers.js";

const INK = "#0b090c", PAPER = "#f3f1ee";

export const PRESETS = [
  // Riley, Arrest 1 (1965): vertical waves whose black/white bands grade to cool grey at the edges.
  (() => {
  const xs = [0.07, 0.17, 0.28, 0.38, 0.47, 0.53, 0.62, 0.72, 0.83, 0.93];
  const fade = (i) => mixHex(INK, "#b9c0d2", (Math.abs(i - 5) / 5) ** 1.15 * 0.95);
  const bands = Array.from({ length: 11 }, (_, i) => (i % 2 ? PAPER : fade(i)));
  return preset("arrest-waves", "Arrest waves", "Vertical black and white waves that swell at the centre and dissolve into cool grey at the edges, after Bridget Riley's Arrest 1 (1965).",
    xs.map((x, i) => boundary(vWaveNodes({ x0: x, amp: 0.04, cycles: 1, phase: 0.3 + 0.12 * i, spans: 3 }), [bands[i]], [bands[i + 1]])));
})(),
  // Riley, Fall (1963): one swinging curve repeated, the rhythm compressing geometrically toward the bottom edge.
  (() => {
  const edges = geometricStops(9, 0.74);
  const curves = edges.slice(1, 9).map((y, i) => {
    const gap = edges[i + 1] - edges[i];
    return graphNodes((x) => y + gap * 0.3 * Math.sin(Math.PI * 2.5 * x + 0.5), 4);
  });
  const bands = Array.from({ length: 9 }, (_, i) => (i % 2 ? PAPER : INK));
  return preset("fall-descent", "Fall descent", "Black and white bands swinging gently at the top and compressing to a fine rhythm below, after Bridget Riley's Fall (1963).",
    bandStack(curves, bands));
})(),
  // Vasarely, Vega-Nor (1969): a bulging grid, cells swelling toward a warm centre on cobalt.
  (() => {
  const radii = [0.47, 0.4, 0.33, 0.265, 0.2, 0.14, 0.09];
  const rings = radii.map((r, i) => squircleNodes(0.5, 0.5, r, r, 0.62 + 0.03 * i));
  return preset("vega-expansion", "Vega expansion", "Nested squircles of cobalt, pink and gold swelling toward a glowing centre, after Victor Vasarely's Vega-Nor (1969).",
    ringStack(rings, ["#0f1a66", "#2a46d8", "#e0338a", "#2a46d8", "#f2b81c", "#e0338a", "#ff7a1c", "#ffe066"]));
})(),
  // Vasarely, Keple Gestalt (1968): an impossible hexagonal tunnel of lime, white and violet facets on black.
  (() => {
  const hexPts = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => [cx + r * Math.cos(-Math.PI / 2 + i * Math.PI / 3), cy + r * Math.sin(-Math.PI / 2 + i * Math.PI / 3)]);
  const outer = hexPts(0.5, 0.5, 0.49), inner = hexPts(0.57, 0.55, 0.24), GAP = 0.006;
  /** Pure function. Pulls a point toward a centre by `gap` so neighbouring facets never touch. */
  const pull = ([x, y], [cx, cy]) => { const d = Math.hypot(x - cx, y - cy); return [x + (cx - x) * GAP / d, y + (cy - y) * GAP / d]; };
  const faceColours = [["#f1f9d2", "#c8f26a"], ["#e6f4d4", "#a6dc58"], ["#8fd04a", "#5ea92a"], ["#4b9a26", "#2f7a1c"], ["#6fba38", "#3e8f22"], ["#c4ee6c", "#9fdc4c"]];
  const faces = faceColours.map(([light, deep], i) => {
    const j = (i + 1) % 6, centre = [(outer[i][0] + outer[j][0] + inner[i][0] + inner[j][0]) / 4, (outer[i][1] + outer[j][1] + inner[i][1] + inner[j][1]) / 4];
    const pts = [outer[i], outer[j], inner[j], inner[i]].map((p) => pull(p, centre));
    return boundary(polylineNodes(pts), ["#050505", "#050505", "#050505", "#050505"], [light, deep, deep, light], true);
  });
  return preset("keple-hexagon", "Keple hexagon", "A hexagonal tunnel of six lime and green facets around a violet floor, on black, after Victor Vasarely's Keple Gestalt (1968).", [
    ...faces,
    boundary(polylineNodes(hexPts(0.57, 0.55, 0.24 - GAP * 2)), ["#050505", "#050505", "#050505", "#050505"], ["#3a2a9a", "#b9b2f0", "#f4f2ff", "#3a2a9a"], true),
  ]);
})(),
  // Soto, Spirales (1967): eccentric rings whose crowding on one side makes the picture shimmer.
  (() => {
  const rings = Array.from({ length: 9 }, (_, k) => ellipseNodes(0.5 + 0.034 * k, 0.5, 0.47 * (1 - k / 9.5)));
  return preset("soto-eccentric", "Soto eccentric", "Nine black and white rings crowded toward one side so the flat disc seems to swirl, after Jesus Rafael Soto's Spirales.",
    ringStack(rings, [PAPER, INK, PAPER, INK, PAPER, INK, PAPER, INK, PAPER, INK]));
})(),
  // Riley, Breathe (1966): black wedges thickening downward until the white is a hairline.
  (() => {
  const TIP_HALF = 0.006, count = 10, pitch = 1 / count, gap = 0.014;
  return preset("breathe-wedges", "Breathe wedges", "Ten black wedges rising from the floor and tapering to hairline tips in white, after Bridget Riley's Breathe (1966).",
    Array.from({ length: count }, (_, i) => {
      const left = i * pitch + gap / 2, right = (i + 1) * pitch - gap / 2, mid = (left + right) / 2;
      return boundary(polylineNodes([[mid - TIP_HALF, 0], [mid + TIP_HALF, 0], [right, 1], [left, 1]]), [PAPER], [INK], true);
    }));
})(),
  // Cruz-Diez, Physichromie: vertical lamellae whose colour climbs the strip, each strip a step out of phase with its neighbour.
  (() => {
  const palette = ["#ff8a1a", "#8ad81e", "#1e90e8", "#e8308c"]; // a full hue loop in 90-degree steps, so no pair of neighbours mixes to grey
  const xs = [0.09, 0.18, 0.27, 0.36, 0.45, 0.55, 0.64, 0.73, 0.82, 0.91];
  const bands = Array.from({ length: 11 }, (_, i) => rotated(palette, i));
  return preset("physichromie-lamellae", "Physichromie lamellae", "Vertical strips whose orange, magenta, violet and cyan climb at a different phase in each strip, after Carlos Cruz-Diez's Physichromies.",
    bandStack(xs.map(vLine), bands));
})(),
  // Anuszkiewicz, Splendor of Red (1965): a red square turned on its corner, fine orange lines radiating out over cool grey-blue.
  (() => {
  const ground = ["#a4b8ca", "#adc0d1", "#b8c9d8", "#c4d3df", "#d2dde6"], line = "#ee7b22", red = "#d8221d";
  // Outer radius of each hairline; every hairline is a 0.013-wide band, and the gaps between them widen outward.
  const outers = [0.5, 0.41, 0.335, 0.27], HAIR = 0.013, CORE = 0.218;
  const rings = [...outers.flatMap((r) => [r, r - HAIR]), CORE].map((k) => polyNodes(0.5, 0.5, k, k, 4));
  return preset("splendor-diamond", "Splendor diamond", "A red square balanced on its corner, circled by fine orange lines over cool grey-blue, after Richard Anuszkiewicz's Splendor of Red (1965).",
    ringStack(rings, [ground[0], line, ground[1], line, ground[2], line, ground[3], line, ground[4], red]));
})(),
  // Anuszkiewicz: nested squares of magenta cut by hairlines of complementary green so the centre glows.
  (() => {
  const h = [0.49, 0.472, 0.4, 0.384, 0.31, 0.295, 0.225, 0.21, 0.14];
  const rings = h.map((k) => rectNodes(0.5 - k, 0.5 - k, 0.5 + k, 0.5 + k));
  const green = "#2ee08a";
  return preset("magenta-squared", "Magenta squared", "Square after square of deepening magenta divided by hairlines of green, so the centre seems lit from within, after Richard Anuszkiewicz.",
    ringStack(rings, ["#2a1a86", green, "#7a1670", green, "#b3158e", green, "#e0289f", green, "#ff6fc8", "#ffd9f0"]));
})(),
  // Vasarely: straight strips magnified by a spherical lens at the middle, like a grid swelling off the canvas.
  (() => {
  const R = 0.46, M = 1.3, DX = 1e-5;
  /** Pure function. Radial lens: r -> R*h(r/R), h(s) = s*(1 + M*(1 - s^2)^2), identity beyond R. */
  const lens = ([dx, dy]) => {
    const s = Math.hypot(dx, dy) / R;
    const k = s >= 1 ? 1 : 1 + M * (1 - s * s) ** 2;
    return [dx * k, dy * k];
  };
  const strip = (dx) => Math.abs(dx) >= R ? [[0.5 + dx, 1, 0, 0, 0, 0], [0.5 + dx, 0, 0, 0, 0, 0]] : sampledNodes((u) => {
    const at = (v) => lens([dx, 0.5 - v])[0];
    return [0.5 + at(u), 1 - u, (at(u + DX) - at(u - DX)) / (2 * DX), -1];
  }, 0, 1, 4);
  const dxs = [-0.45, -0.3, -0.17, -0.06, 0.06, 0.17, 0.3, 0.45];
  const bands = Array.from({ length: 9 }, (_, i) => (i % 2 ? "#ffb21e" : "#2b3fd6"));
  return preset("bulge-stripes", "Bulge stripes", "Blue and saffron strips thrown apart by a hidden sphere at the centre, after Victor Vasarely's bulging Vega grids.",
    bandStack(dxs.map(strip), bands));
})(),
  // Riley, Current (1964): waves out of step with one another, so the stripes pinch and swell along their length.
  (() => {
  const d = 0.085, A = 0.03, drift = 1.15;
  const curves = Array.from({ length: 10 }, (_, i) => graphNodes((x) => 0.06 + d * i + A * Math.sin(2 * Math.PI * x + i * drift), 3));
  const bands = Array.from({ length: 11 }, (_, i) => (i % 2 ? PAPER : INK));
  return preset("current-surge", "Current surge", "Waves slipping out of step so each black stripe pinches and swells along its length, after Bridget Riley's Current (1964).",
    bandStack(curves, bands));
})(),
  // Square vortex: each square turned a few degrees inside the last, so the alternating bands wind inward like a spiral.
  (() => {
  const turn = 11 * Math.PI / 180, shrink = 0.83, rings = Array.from({ length: 9 }, (_, k) => {
    const h = 0.49 * shrink ** k, a = turn * k;
    return polyNodes(0.5, 0.5, h * Math.SQRT2, h * Math.SQRT2, 4, -3 * Math.PI / 4 + a);
  });
  return preset("square-vortex", "Square vortex", "Nine squares, each turned a few degrees inside the last, winding alternating bands of ink and cream into the centre.",
    ringStack(rings, [PAPER, INK, PAPER, INK, PAPER, INK, PAPER, INK, PAPER, INK]));
})(),
  // Rotorelief tunnel: rings crowded against one edge and spread on the other, so the flat disc reads as a tunnel bending away.
  (() => {
  const RIGHT_STEP = 0.02, N = 8;
  const rings = Array.from({ length: N }, (_, k) => {
    const r = 0.47 * (1 - 0.8 * k / (N - 1)) ** 1.15, right = 0.97 - RIGHT_STEP * k;
    return ellipseNodes(right - r, 0.5 - 0.05 * k / (N - 1), r);
  });
  return preset("rotorelief-tunnel", "Rotorelief tunnel", "Eight rings crowded against one edge and spread on the other so a flat disc reads as a tunnel bending away, after Marcel Duchamp's Rotoreliefs.",
    ringStack(rings, ["#f4ead5", "#c8321f", "#f4ead5", "#1f2a5a", "#f4ead5", "#c8321f", "#f4ead5", "#1f2a5a", "#f4ead5"]));
})(),
  // Hypnotic four-arm pinwheel: each arm ends on the midpoint of a box edge, so the corners take their colour cleanly.
  (() => {
  const colours = [INK, PAPER, "#d8321f", PAPER], FULL = 2 * Math.PI;
  return preset("hypno-pinwheel", "Hypno pinwheel", "Four wound spiral arms in ink, cream and vermilion turning the flat square into a slow whirlpool.",
    colours.map((c, i) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0.01, r1: 0.5, turns: 2, phase: i * FULL / 4 }), [c], [colours[(i + 1) % 4]])));
})(),
  // Agam, Agamograph: vertical lamellae folded like an accordion, a spectrum sliding past as you walk by.
  (() => {
  const hues = ["#e8382b", "#f07a1a", "#f5c518", "#6cbf3a", "#1fa4a0", "#2a6fd6", "#6a43c4", "#c0389a", "#e8382b", "#f07a1a"];
  const fold = 0.04, ys = [1, 2 / 3, 1 / 3, 0];
  const xs = Array.from({ length: 9 }, (_, i) => 0.1 + 0.1 * i);
  const shade = (c) => [mixHex(c, "#ffffff", 0.3), mixHex(c, "#000000", 0.22), mixHex(c, "#ffffff", 0.3), mixHex(c, "#000000", 0.22)];
  const bands = hues.map(shade);
  return preset("agam-accordion", "Agam accordion", "A folded spectrum: vertical strips zigzag like an accordion, each fold lit on one face and shaded on the other, after Yaacov Agam's agamographs.",
    xs.map((x, i) => boundary(polylineNodes(ys.map((y, k) => [x + fold * (k % 2 ? -1 : 1), y])), bands[i], bands[i + 1])));
})(),
  // Stanczak, Receding Red: stripes whose colour slides one way in one stripe and back in the next, so the field seems to tilt and vibrate.
  (() => {
  const hot = ["#ff3b1f", "#e0246a", "#7a1f8a", "#2a2f9a"], cool = [...hot].reverse();
  const ys = Array.from({ length: 11 }, (_, i) => 0.08 + 0.084 * i);
  const bands = Array.from({ length: 12 }, (_, i) => (i % 2 ? cool : hot));
  return preset("stanczak-vibration", "Stanczak vibration", "Stripes that slide from vermilion to indigo in one row and back in the next, so the rows seem to tilt against each other, after Julian Stanczak.",
    bandStack(ys.map(hLine), bands));
})(),
];
