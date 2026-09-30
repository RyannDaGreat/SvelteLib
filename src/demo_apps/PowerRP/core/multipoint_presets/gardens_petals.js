/**
 * "Gardens & petals" — native Multipoint presets. Bulb and lavender fields from above, petal macros, Monet's Giverny, maples, wisteria, magnolia and roses.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, point, boundary, closedRamp } from "./builders.js";
import { ellipseNodes, mixHex } from "../multipoint_shapes.js";
import { leafNodes } from "./nature.js";
import { wobbleRingNodes, coilNodes } from "./swirls.js";
import { boxFrame, boxEdge } from "./wallpapers_ui.js";
import { bandStack, smoothOpen, insideNodes, ellipseCurve, rayNodes, mapleNodes } from "./gardens_helpers.js";

// ── Tulip field from above: long colour strips divided by green verges, converging toward the horizon ──
const GRASS = ["#5f8f36", "#86b04e"];

const DITCH = ["#2f6f6a", "#4f9a8e"];

const STRIPS = [ // [strip colour, bottom->top drift]
  [["#b9152f", "#e93a52"], 0.15], [["#f1c22c", "#fde76e"], 0.12], [["#d8458f", "#f59cc6"], 0.14],
  [["#f4eede", "#fffaf0"], 0.1], [["#6f2fa8", "#a26bdc"], 0.12], [["#ec6a1e", "#ffa858"], 0.11],
];

export const PRESETS = [
  (() => {
  const widths = [0.04, 0.15, 0.03, 0.12, 0.05, 0.13, 0.03, 0.11, 0.05, 0.14, 0.04, 0.1, 0.06];
  const lines = []; let x = 0;
  widths.forEach((w) => { x += w; lines.push(x); });
  lines.pop(); // 12 curves between 13 bands
  const scale = 1 / (x - widths.at(-1) + widths.at(-1)); 
  const curves = lines.map((lx) => { const u = lx * scale; return smoothOpen([[u, 1], [0.5 + (u - 0.5) * 0.62 + 0.02, 0.5], [0.5 + (u - 0.5) * 0.3, 0]]); });
  const bands = [GRASS];
  STRIPS.forEach(([c], i) => { bands.push(c, i === 2 ? DITCH : GRASS); });
  return preset("tulip-field-rows", "Tulip field rows", "An aerial Dutch bulb field: crimson, butter, pink, cream, violet and orange strips converging between green verges.", bandStack(curves, bands));
})(),
  // ── Lavender contours: hill rows arching over a Provencal slope, hazier and narrower toward the far crest ──
  (() => {
  const rowYs = Array.from({ length: 11 }, (_, k) => 0.2 + 0.77 * ((k + 1) / 11) ** 1.25); // row/soil edges, tighter toward the crest
  const arch = (y, k) => {
    const rise = Math.min(0.012 + 0.11 * (y - 0.15), y - 0.06);
    return smoothOpen([0, 0.5, 1].map((x) => [x, Math.min(0.99, y - rise * (1 - 4 * (x - 0.5) ** 2) - 0.004 * k * (x - 0.5))]));
  };
  const curves = rowYs.map(arch);
  const ROW = (far, near) => [near, far, near];
  const SOIL = (c) => [c, mixHex(c, "#ffffff", 0.18), c];
  const bands = ["#f3d6c6", ROW("#a690dc", "#9478d0"), SOIL("#ecdba0"), ROW("#9278d2", "#7e62c6"), SOIL("#e4c986"), ROW("#8066c8", "#6c50bc"),
    SOIL("#dcbd74"), ROW("#6c52bc", "#5a40ae"), SOIL("#d2ad62"), ROW("#5c42ae", "#4a30a0"), SOIL("#c79f52"), ROW("#4c32a0", "#3c2290")];
  return preset("lavender-contours", "Lavender contours", "Provencal lavender rows arching over a hilltop from above, violet stripes between honey-gold soil, hazier toward the crest.",
    [boxEdge("top", ["#8c96da", "#a8a2e0", "#8c96da"]), ...bandStack(curves, bands)]);
})(),
  // ── Tulip flame: concentric petal edges wrapping a tulip bud, yellow rims over crimson flame ──
  (() => {
  // [radius, outside flame colour, inside rim colour] per petal edge, bud (small radius) to outer petal.
  const EDGES = [[0.27, "#e2343a", "#eaf0a8"], [0.43, "#c8223a", "#f8e47c"], [0.61, "#d2303a", "#f9cf4e"], [0.81, "#b51a38", "#f6c244"],
    [1.03, "#a4173a", "#f4b840"], [1.27, ["#5e0a30", "#8f1038", "#c42a3c"], ["#ee9e36", "#f2a83a", "#f6b840"]]];
  const curves = EDGES.map(([r], k) => insideNodes(ellipseCurve(1.2 - 0.03 * k, 1.12 + 0.02 * k, r * 1.05, r * 0.88), Math.PI, 1.5 * Math.PI, 4));
  return preset("tulip-flame", "Tulip flame", "Macro of a flamed tulip: silk petal edges wrap a pale green bud, butter-yellow rims over crimson flame.",
    curves.map((nodes, k) => boundary(nodes, [EDGES[k][1]].flat(), [EDGES[k][2]].flat())));
})(),
  // ── Poppy silk: crinkled pleats radiating from a dark-blotched heart ──
  (() => {
  const N = 8, ctr = [0.5, 0.52];
  const lightSide = (i) => (i % 2 ? ["#9b1424", "#ee4a26", "#ff9a66"] : ["#8a1022", "#e23a1e", "#ff8658"]);
  const darkSide = (i) => (i % 2 ? ["#5e0d20", "#b8161e", "#e8482c"] : ["#6a0e22", "#c81d1c", "#ef5a32"]);
  const rays = Array.from({ length: N }, (_, i) => rayNodes(ctr[0], ctr[1], (2 * Math.PI * (i + 0.3 * Math.sin(i * 2.1))) / N, 0.19, 0.05 * (i % 2 ? 1 : -1)));
  return preset("poppy-silk", "Poppy silk", "Macro of a scarlet poppy: crinkled silk pleats radiating from a violet-black heart.", [
    boundary(ellipseNodes(ctr[0], ctr[1], 0.095), ["#6a0e22"], ["#140818"], true),
    ...rays.map((nodes, i) => boundary(nodes, darkSide(i), lightSide(i))),
  ]);
})(),
  // ── Moth orchid: blush-white petals layered outward from a magenta-veined, golden-lipped heart at the left ──
  (() => {
  // [rx, ry factor, centre y, outside colours (the next petal's veined inner edge), inside colours (this petal's pale outer edge)]
  const EDGES = [[0.36, 1.5, 0.52, ["#f2b32a", "#e8902a"], ["#6d1058", "#8c1a6c"]], [0.52, 1.4, 0.5, ["#b32a86", "#c23a84"], ["#f4b72c", "#f0a030"]],
    [0.7, 1.35, 0.49, ["#c64a9c", "#cf5aa2"], ["#f7e9f2", "#f8e1ee"]], [0.86, 1.3, 0.5, ["#d873b2", "#e084ba"], ["#fdf3f8", "#fdeaf3"]],
    [1.0, 1.27, 0.52, ["#e8a1c9", "#eeb0d0"], ["#fff8fb", "#fff2f8"]], [1.12, 1.25, 0.5, ["#f3cde1", "#f6d8e8"], ["#fffafc", "#fff6fa"]]];
  const curves = EDGES.map(([rx, f, cy], k) => insideNodes(ellipseCurve(-0.3 - 0.012 * k, cy, rx, rx * f), -Math.PI / 2, Math.PI / 2, 5));
  return preset("moth-orchid", "Moth orchid", "Macro of a phalaenopsis: layered blush-white petals veined magenta toward a golden lip at the heart.",
    curves.map((nodes, k) => boundary(nodes, EDGES[k][3], EDGES[k][4])));
})(),
  // ── Lotus dawn: five pink-tipped petals fanning over dark teal pond leaves ──
  (() => {
  // [base x, base y, lean from vertical (radians, + = clockwise), length, width]
  const FAN = [[0.3, 0.97, -1.0, 0.33, 0.11], [0.7, 0.97, 1.0, 0.33, 0.11], [0.41, 0.985, -0.33, 0.7, 0.14], [0.59, 0.985, 0.33, 0.7, 0.14], [0.5, 0.99, 0, 0.9, 0.17]];
  const petal = ([bx, by, lean, length, width], i) => {
    const angle = -Math.PI / 2 + lean, cx = bx + Math.cos(angle) * length / 2, cy = by + Math.sin(angle) * length / 2;
    const c = i === 4 ? ["#e5508f", "#fde0ec"] : ["#ec6fa4", "#fcdbe8"];
    return boundary(leafNodes({ cx, cy, length, width, angle, taper: 0.4 }), Array(4).fill("#1a4a4a"), [c[0], c[1], "#fff6ee", c[0]], true);
  };
  return preset("lotus-dawn", "Lotus dawn", "A lotus seen at dawn: five white petals flushed rose at the tips, fanning over a dark teal pond.", [
    boxEdge("top", ["#3f8a80"]), boxEdge("bottom", ["#08262b"]),
    ...FAN.map(petal),
  ]);
})(),
  // ── Coral peony: ruffled petal rings, each lit pale at its outer lip and deepening coral where the next overlaps ──
  (() => {
  const CX = 0.5, CY = 0.5;
  // [radius, anchors, lobes, phase, outside colour, inside (lip) colour]
  const RINGS = [[0.47, 10, 5, 0.3, "#3d6a45", "#ffd9c8"], [0.36, 10, 5, 1.3, "#ee6f5e", "#ffcab6"], [0.25, 8, 4, 0.6, "#e0565a", "#ffb9a4"], [0.135, 6, 3, 2.1, "#cf3e52", "#fff0cc"], [0.055, 4, 2, 0.4, "#fff0cc", "#f2b32e"]];
  return preset("coral-peony", "Coral peony", "Macro of a coral-charm peony: ruffled petal rings, pale at each lip and deepening to cherry toward a cream heart.",
    RINGS.map(([r, n, lobes, phase, out, inn], k) => boundary(wobbleRingNodes({ cx: CX + 0.012 * k, cy: CY - 0.008 * k, rx: r, ry: r * 0.96, amp: 0.045, lobes, phase, n }), [out], [inn], true)));
})(),
  // ── Giverny pond: Monet's water garden, sky and willow reflections in cobalt/violet/viridian washes, pads and pink blooms ──
  (() => {
  const wave = (y, k) => smoothOpen([0, 1 / 3, 2 / 3, 1].map((x) => [x, y + 0.02 * Math.sin(5.2 * x + 1.7 * k)]));
  const curves = [0.2, 0.4, 0.6, 0.8].map(wave);
  const bands = [{ a: ["#7ea2da", "#86a8e0", "#7a9cd6"], b: ["#98a2de", "#a49ce0", "#8e9ede"] },
    { a: ["#a298e0", "#b2a2e4", "#9a94dc"], b: ["#6fa0d2", "#7cb8d4", "#6898d0"] },
    { a: ["#6aa8cc", "#7cc2c8", "#5e9ec8"], b: ["#5a86c0", "#4a9aa8", "#6a86c6"] },
    { a: ["#6070c0", "#4a94a4", "#6a72c8"], b: ["#58867e", "#3f8a78", "#5a8a86"] },
    { a: ["#4f9a78", "#5aa880", "#4a9478"], b: ["#3f7a5e", "#447f66", "#3a7a62"] }];
  const pad = (cx, cy, rx, ry, rim, lit, deep) => boundary(ellipseNodes(cx, cy, rx, ry), Array(4).fill(rim), [lit, deep, deep, lit], true);
  return preset("giverny-pond", "Giverny pond", "Monet's water garden: sky and willow reflections washed in cobalt, violet and viridian with pale lily pads and pink blooms.", [
    ...bandStack(curves, bands),
    pad(0.22, 0.3, 0.11, 0.035, "#a9a2dc", "#a4dcae", "#3f8f6c"), pad(0.5, 0.3, 0.06, 0.022, "#a39ade", "#8ed0a2", "#3a8464"),
    pad(0.72, 0.5, 0.15, 0.04, "#7fa6d6", "#a8e0b0", "#3a8a68"), pad(0.3, 0.69, 0.14, 0.04, "#6a8ec4", "#98dcaa", "#3a8a66"),
    pad(0.66, 0.7, 0.07, 0.026, "#6a84c2", "#8ad0a2", "#2f7a5c"),
    point(0.76, 0.5, "#f4789e"), point(0.2, 0.3, "#fdc0d0"), point(0.34, 0.69, "#fff2d6"),
  ]);
})(),
  // ── Poppy hillside: Monet's Argenteuil field, a cloud-pale sky over a grey-green meadow flecked scarlet ──
  (() => {
  const c1 = smoothOpen([[0, 0.36], [0.35, 0.34], [0.7, 0.37], [1, 0.35]]);
  const c2 = smoothOpen([[0, 0.44], [0.35, 0.42], [0.7, 0.45], [1, 0.42]]);
  const c3 = smoothOpen([[0, 0.52], [0.3, 0.6], [0.65, 0.78], [1, 0.9]]);
  const bands = [{ a: "#9cc0e0", b: "#eaeadf" }, { a: ["#3f6244", "#56764c", "#4a6c4a"], b: ["#4e6e4a", "#66844e", "#56744c"] },
    { a: ["#b2b89a", "#c2c4ac", "#aeb694"], b: ["#9aa880", "#aab488", "#94a47c"] }, { a: ["#8c9f66", "#9bab72", "#8a9d62"], b: ["#5f7d42", "#6a8848", "#5a7a40"] }];
  const pops = [[0.1, 0.64], [0.3, 0.74], [0.14, 0.86], [0.42, 0.93], [0.27, 0.97], [0.68, 0.94]];
  return preset("poppy-hillside", "Poppy hillside", "Monet's Argenteuil poppy field: a cloud-pale sky over a dark tree line and a grey-green meadow, scarlet flecks spilling down the slope.", [
    boxEdge("top", ["#86b0dc", "#9cbfe2", "#8ab2da"]), boxEdge("bottom", ["#5e7e42"]), ...bandStack([c1, c2, c3], bands),
    ...pops.map(([x, y], i) => point(x, y, i % 2 ? "#e2432a" : "#f2643a")),
  ]);
})(),
  // ── Momiji scarlet: backlit Japanese maple leaves, crimson veins glowing to orange tips on a honeyed autumn haze ──
  (() => {
  const LEAVES = [[0.27, 0.29, 0.24, -1.25, ["#e2321c", "#8e0f22", "#f07a24"]], [0.7, 0.52, 0.26, -0.35, ["#d42a1e", "#a01428", "#f2902a"]], [0.3, 0.8, 0.2, -1.6, ["#ec4a1e", "#b01a24", "#f6a030"]]];
  return preset("momiji-scarlet", "Momiji scarlet", "Backlit Japanese maple leaves: crimson veins glowing to orange tips against a honeyed autumn haze.", [
    boxFrame(["#a8a03a", "#e0a33a", "#b8541e"]),
    ...LEAVES.flatMap(([cx, cy, outer, phase, ramp]) => [
      boundary(mapleNodes({ cx, cy, outer, inner: outer * 0.3, lobes: 5, phase, bulge: 0.22 }), Array(4).fill("#e9b03c"), closedRamp(ramp), true),
      point(cx, cy, "#ffb24a"),
    ]),
    point(0.9, 0.12, "#fff0a0"), point(0.12, 0.56, "#9cb04a"),
  ]);
})(),
  // ── Wisteria rain: pendant racemes in violet fading to white at the tips, hung over a Giverny-blue haze ──
  (() => {
  // [top x, length, width, lean (radians off vertical)]; the base stays at y = 0.025 so each raceme hangs from the top edge.
  const RACEMES = [[0.13, 0.52, 0.11, 0.05], [0.3, 0.78, 0.15, -0.04], [0.5, 0.62, 0.13, 0.03], [0.69, 0.88, 0.15, -0.03], [0.87, 0.48, 0.11, -0.06]];
  const raceme = ([x, length, width, lean], i) => {
    const angle = Math.PI / 2 + lean, tip = ["#fff6fb", "#f4ecff", "#fdeaf6"][i % 3];
    return boundary(leafNodes({ cx: x + Math.cos(angle) * length / 2, cy: 0.025 + Math.sin(angle) * length / 2, length, width, angle, taper: 0.1 }),
      Array(4).fill("#6a9cd2"), [tip, i % 2 ? "#9a78de" : "#b48ae8", "#4e2aa8", tip], true);
  };
  return preset("wisteria-rain", "Wisteria rain", "Wisteria racemes hanging in violet, fading to white at the tips, over a Giverny-blue haze.", [
    boxEdge("top", ["#2c5a98"]), boxEdge("bottom", ["#a4d2dc"]), ...RACEMES.map(raceme),
  ]);
})(),
  // ── Magnolia wax: overlapping waxy petals sweeping up-right, rose-flushed at their base, each edge lit cream ──
  (() => {
  const y0s = [1.2, 1.0, 0.82, 0.64, 0.48, 0.34, 0.2]; // where each petal edge would meet x = 0 (the first enters through the bottom edge)
  const curves = y0s.map((y, k) => insideNodes((t) => [t, y - 0.5 * t + 0.04 * Math.sin(5.5 * t + 1.4 * k)], 0, 1, 4));
  const LIT = ["#f2b8cb", "#fde8ea", "#ffffff"], SHADE = ["#a95682", "#d08ca8", "#e9c6d2"], EDGE = { a: LIT, b: SHADE };
  return preset("magnolia-wax", "Magnolia wax", "Overlapping magnolia petals sweeping up the frame: waxy cream edges lit over rose-flushed, shadowed bases.",
    bandStack(curves, [SHADE, EDGE, EDGE, EDGE, EDGE, EDGE, EDGE, LIT]));
})(),
  // ── Hibiscus sunrise: five pinwheel petals burning from a crimson throat through orange to a yellow lip ──
  (() => {
  const C = [0.5, 0.5], N = 5;
  const LIT = ["#6a0820", "#e3243a", "#ff7a2c", "#ffd04a"], SHADE = ["#4a0618", "#b81a34", "#f0501e", "#ffae3a"];
  const rays = Array.from({ length: N }, (_, i) => rayNodes(C[0], C[1], 2 * Math.PI * i / N + 0.2, 0.13, 0.13));
  return preset("hibiscus-sunrise", "Hibiscus sunrise", "Macro of a hibiscus: five pinwheel petals burn from a crimson throat through orange to a yellow lip.", [
    boundary(ellipseNodes(C[0], C[1], 0.055), Array(4).fill("#7a0f22"), ["#ff9a34", "#ffd860", "#ffd860", "#ff9a34"], true),
    ...rays.map((nodes) => boundary(nodes, SHADE, LIT)),
  ]);
})(),
  // ── Rose whorl: two interleaved spiral petal edges, deep crimson at each overlap and blush at each lit lip ──
  (() => {
  const CX = 0.5, CY = 0.5;
  const SHADE = ["#4e0820", "#8e1238", "#c02a58", "#dc5a82"], LIT = ["#8e1238", "#c02a58", "#e8608a", "#f8a8c0"];
  const arm = (phase) => coilNodes({ cx: CX, cy: CY, r0: 0.04, r1: 0.47, turns: 2, phase });
  return preset("rose-whorl", "Rose whorl", "A rose seen from above: two interleaved spiral petal edges, crimson where they overlap and blush at each lit lip.", [
    boundary(arm(0), SHADE, LIT),
    boundary(arm(Math.PI), SHADE, LIT),
    point(CX, CY, "#3a0618"),
  ]);
})(),
];
