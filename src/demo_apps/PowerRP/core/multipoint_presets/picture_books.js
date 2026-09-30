/**
 * "Picture-book illustration" — native Multipoint presets. Carle's tissue collage, Jansson's valley blues, Mary Blair, Shaun Tan and contemporary gouache.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes } from "../multipoint_shapes.js";
import { blobNodes, leafNodes } from "./art_homages.js";
import { graphNodes, verticalGround, paperShape, disc } from "./picture_book_helpers.js";

const TAU = 2 * Math.PI;

const wave = (y, amp, cycles, phase = 0) => graphNodes((x) => y + amp * Math.sin(TAU * cycles * x + phase), Math.ceil(cycles * 4));

const edge = (y, color) => boundary(polylineNodes([[0, y], [1, y]]), [color]);

export const PRESETS = [
  // Carle: hand-painted tissue strips stacked from cobalt through violet and magenta to a lemon ground.
  preset("tissue-dawn", "Tissue dawn", "Cobalt, violet, magenta, orange and lemon painted-paper strips, each brushed in streaks.", [
    edge(0, "#2f44b0"),
    boundary(wave(0.26, 0.02, 1.5, 1.0), ["#3449b4", "#4a5cc8", "#2f44b0"], ["#6c4cc0", "#8056c8", "#5f44b8"]),
    boundary(wave(0.44, 0.022, 1.5, 3.0), ["#6c4cc0", "#8056c8", "#5f44b8"], ["#d44a8c", "#e2609c", "#c8407f"]),
    boundary(wave(0.62, 0.022, 1.5, 0.2), ["#d44a8c", "#e2609c", "#c8407f"], ["#f2803a", "#f59a48", "#ec7030"]),
    boundary(wave(0.8, 0.02, 1.5, 2.0), ["#f2803a", "#f59a48", "#ec7030"], ["#f9cb3c", "#fbd95a", "#f6bd30"]),
    edge(1, "#f8d44c"),
  ]),
  // Jansson: a Moomin-valley night — ink-blue sky paling to teal at the hills, a moon, a lit window.
  preset("valley-night", "Valley night", "A deep ink-blue sky paling to teal over two dark pine-green hills, with a moon and a lit window.", [
    edge(0, "#0f1f48"),
    boundary(ellipseNodes(0.3, 0.22, 0.17), ["#3a6a90"], null, true),
    disc(0.3, 0.22, 0.075, "#6f98b4", ["#f8f3cf"]),
    boundary(wave(0.6, 0.04, 1, 0.6), ["#9fc6c2"], ["#2c6066"]),
    boundary(wave(0.78, 0.035, 1, 3.0), ["#1f4c58"], ["#0f2f3c"]),
    edge(1, "#0a202c"),
    point(0.74, 0.7, "#ffd56a"),
  ]),
  // Jansson: the comet sky — plum-red heavens burning to orange at a pale sea, the comet itself a white head with a tail.
  preset("comet-sky", "Comet sky", "A plum-red sky glowing orange at the horizon, a pale sea below and a white comet with a tail.", [
    edge(0, "#3d0f2a"),
    boundary(graphNodes((x) => 0.66 + 0.006 * Math.sin(TAU * 2 * x), 8), ["#f0874a"], ["#8fbfae"]),
    edge(1, "#2c5a5e"),
    paperShape(leafNodes(0.14, 0.46, 0.64, 0.2, 0.1), "#b8403a", ["#fff0c0", "#f28a4a", "#fff0c0"]),
    disc(0.74, 0.14, 0.06, "#a8343a", ["#fffbe6"]),
    paperShape(leafNodes(0.7, 0.7, 0.7, 0.93, 0.05), "#86b4a4", ["#fff0c0", "#f3a060", "#fff0c0"]),
  ]),
  // Potter: wet-in-wet watercolour — a blue-grey sky wash bleeding into sap-green meadow, foxglove pink and warm earth.
  preset("meadow-wash", "Meadow wash", "A blue-grey sky wash bleeding into sap-green grass, with foxglove pink and warm earth.", [
    ...verticalGround(["#c4d6de", "#a8c08a", "#8f7a52"]),
    boundary(blobNodes({ cx: 0.32, cy: 0.52, rx: 0.22, ry: 0.12, harmonics: [[2, 0.12, 0.4], [3, 0.08, 1.4]], count: 8 }), ["#7da05a"], null, true),
    boundary(blobNodes({ cx: 0.72, cy: 0.66, rx: 0.22, ry: 0.11, harmonics: [[2, 0.12, 2.0], [4, 0.06, 0.4]], count: 8 }), ["#9cae62"], null, true),
    boundary(blobNodes({ cx: 0.78, cy: 0.3, rx: 0.12, ry: 0.06, harmonics: [[3, 0.1, 1.0]], count: 6 }), ["#e7eef0"], null, true),
    boundary(blobNodes({ cx: 0.16, cy: 0.84, rx: 0.09, ry: 0.07, harmonics: [[3, 0.12, 0.2]], count: 6 }), ["#c48aa2"], null, true),
    point(0.24, 0.24, "#b2c7d3"),
  ]),
  // Jansson: midwinter — a lilac-blue sky over snow hills with blue shadow and one orange window.
  preset("winter-valley", "Winter valley", "A lilac-blue sky over white snow hills with blue shadows and one small orange window.", [
    edge(0, "#8e9cd0"),
    boundary(graphNodes((x) => 0.5 + 0.06 * Math.sin(TAU * x + 0.8), 6), ["#dde5f2"], ["#f4f7fb"]),
    boundary(graphNodes((x) => 0.72 + 0.04 * Math.sin(TAU * 1.5 * x + 2.2), 6), ["#f6f8fc"], ["#b7c6e4"]),
    edge(1, "#8fa2cf"),
    disc(0.3, 0.6, 0.03, "#f4f7fb", ["#f08c3a"]),
  ]),
  // Potter: a pond wash — pale reed-cream water shading to green-blue, three lily pads and a pink bloom.
  preset("lily-pond-wash", "Lily pond wash", "Pale cream water shading into green-blue wash, with three sap-green lily pads and a pink bloom.", [
    ...verticalGround(["#e4e6c8", "#a9c6b0", "#6d9b96"]),
    paperShape(blobNodes({ cx: 0.32, cy: 0.5, rx: 0.14, ry: 0.08, harmonics: [[3, 0.08, 0.6]], count: 6 }), "#b4cdb0", ["#5f9440", "#7aac52", "#4f8a3e"]),
    paperShape(blobNodes({ cx: 0.68, cy: 0.66, rx: 0.15, ry: 0.09, harmonics: [[3, 0.08, 1.9]], count: 6 }), "#8fb3a4", ["#6aa048", "#4e8a3a", "#7cb052"]),
    paperShape(blobNodes({ cx: 0.2, cy: 0.8, rx: 0.1, ry: 0.06, harmonics: [[3, 0.1, 0.2]], count: 6 }), "#78a29c", ["#5a9040"]),
    point(0.34, 0.49, "#eeaac0"), point(0.7, 0.2, "#d9e0c2"),
  ]),
  // Tan: a sepia harbour — pale airships hanging in a parchment haze over a dark roofline.
  preset("sepia-haze", "Sepia haze", "Pale airships hanging in a parchment haze over a dark, lamplit roofline.", [
    edge(0, "#dcc8a2"),
    boundary(graphNodes((x) => 0.72 + 0.03 * Math.sin(TAU * 2 * x + 0.5), 8), ["#b4a07e"], ["#4a3c2e"]),
    edge(1, "#2c231b"),
    paperShape(blobNodes({ cx: 0.46, cy: 0.36, rx: 0.3, ry: 0.07, harmonics: [[2, 0.1, 0.4]], count: 6 }), "#c7b38f", ["#efe2c2", "#e2d1a8", "#f3e8cc"]),
    paperShape(blobNodes({ cx: 0.78, cy: 0.16, rx: 0.14, ry: 0.035, harmonics: [[2, 0.1, 1.4]], count: 6 }), "#d0bd98", ["#ecdcb8"]),
    paperShape(blobNodes({ cx: 0.2, cy: 0.52, rx: 0.12, ry: 0.03, harmonics: [[2, 0.1, 0.4]], count: 6 }), "#b9a682", ["#dccaa2"]),
    point(0.3, 0.86, "#f0c070"), point(0.66, 0.9, "#f0c070"),
  ]),
  // Blair: flat unmixed paint — blue, violet and turquoise trees standing before an orange sky over lime grass.
  preset("blue-tree-forest", "Blue-tree forest", "Tall blue, violet, turquoise and magenta trees against an orange sky over lime grass.", [
    edge(0, "#ff8c55"),
    boundary(graphNodes((x) => 0.7 + 0.015 * Math.sin(TAU * 2 * x + 1), 8), ["#ffb562"], ["#b4d93c"]),
    edge(1, "#58b848"),
    ...[[0.12, 0.3, "#2a6fdc"], [0.3, 0.16, "#7b45c8"], [0.5, 0.26, "#18b5b0"], [0.7, 0.12, "#e03e98"], [0.88, 0.3, "#2a6fdc"]].map(([x, top, c]) =>
      paperShape(leafNodes(x, top, x, 0.64, 0.13), "#ff9a58", [c])),
  ]),
  // Blair: carnival scallops — hot pink, orange, turquoise and lime bands with contrasting polka dots.
  preset("carnival-scallops", "Carnival scallops", "Hot pink, orange, turquoise and lime scalloped bands with contrasting dots.", [
    edge(0, "#ee3f8c"),
    boundary(graphNodes((x) => 0.3 + 0.03 * Math.sin(TAU * 1.5 * x), 6), ["#ee3f8c"], ["#f7941d"]),
    boundary(graphNodes((x) => 0.52 + 0.03 * Math.sin(TAU * 1.5 * x + Math.PI), 6), ["#f7941d"], ["#16b5b0"]),
    boundary(graphNodes((x) => 0.74 + 0.03 * Math.sin(TAU * 1.5 * x), 6), ["#16b5b0"], ["#a8d21f"]),
    edge(1, "#a8d21f"),
    disc(0.3, 0.12, 0.05, "#ee3f8c", ["#f9d33a"]), disc(0.72, 0.12, 0.05, "#ee3f8c", ["#f9d33a"]),
    disc(0.5, 0.92, 0.04, "#a8d21f", ["#ee3f8c"]),
  ]),
  // Contemporary gouache: a terracotta sun setting behind sage, teal and dusty-blue hills.
  preset("gouache-dusk", "Gouache dusk", "A terracotta sun over layered sage, teal and dusty-blue hills in a peach sky.", [
    edge(0, "#f3c9a4"),
    disc(0.62, 0.3, 0.14, "#f3ccaa", ["#d1583a", "#dc6c44", "#c9502f"]),
    boundary(graphNodes((x) => 0.56 + 0.04 * Math.sin(TAU * x + 0.4), 4), ["#f2cfae"], ["#a9ae8a"]),
    boundary(graphNodes((x) => 0.72 + 0.04 * Math.sin(TAU * 1.5 * x + 2.4), 6), ["#9aa684"], ["#4f7a72"]),
    boundary(graphNodes((x) => 0.86 + 0.025 * Math.sin(TAU * x + 4), 4), ["#46706a"], ["#36505c"]),
    edge(1, "#2a3e4c"),
  ]),
  // Sendak: a fan of hatched-looking leaves in ochre and sage around a cream moon on a night ground.
  preset("jungle-fan", "Jungle fan", "Ochre, sage and teal leaves fanning up from the bottom around a pale moon on a deep night ground.", [
    ...verticalGround(["#1a1e34", "#20283a", "#1c2a24"]),
    disc(0.5, 0.22, 0.09, "#1f2640", ["#f4e9b0", "#ead98a", "#f6efc2"]),
    ...[[0.1, 0.4, 0.4, "#c9b25a"], [0.28, 0.22, 0.46, "#7b9a52"], [0.72, 0.22, 0.54, "#5e8a70"], [0.9, 0.4, 0.6, "#d0a84c"]].map(([x, top, base, c]) =>
      paperShape(leafNodes(x, top, base, 0.97, 0.1), "#1e2832", [c])),
  ]),
];
