/**
 * "Old masters light" — native Multipoint presets. Rembrandt, La Tour, Vermeer, Titian, Leonardo, Tiepolo, Lorrain and Elsheimer: chiaroscuro, sfumato and golden haze.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, waveNodes } from "../multipoint_shapes.js";
import { blobNodes, leafNodes } from "./art_homages.js";
import { frame, rotateNodes } from "./old_masters_helpers.js";

const soft = (nodes, color) => boundary(nodes, [color], null, true);

const tilted = (cx, cy, rx, ry, angle) => rotateNodes(ellipseNodes(cx, cy, rx, ry), cx, cy, angle);

const organic = (cx, cy, rx, ry, angle, harmonics) => rotateNodes(blobNodes({ cx, cy, rx, ry, harmonics, count: 8 }), cx, cy, angle);

const lit = (nodes, outside, [shadow, mid, light]) => boundary(nodes, [outside, outside, outside, outside], [shadow, mid, light, shadow], true);

const halo = (cx, cy, rx, ry, angle, color) => soft(tilted(cx, cy, rx, ry, angle), color);

const rembrandt = preset("rembrandt-glow", "Rembrandt glow", "A broad umber pool of warm light, brightest at one cheek, sinking into black with a pale collar catching the edge.", [
  ...frame("#0a0705", "#140d08", "#1a120c", "#0c0806"),
  ...[[0.38, "#2a1a0f"], [0.26, "#6a4428"], [0.14, "#b98450"], [0.06, "#e8c08a"]].map(([r, c]) => soft(ellipseNodes(0.4, 0.4, r), c)),
  point(0.34, 0.34, "#f6dcb0"),
]);

const pearl = preset("pearl-ground", "Pearl ground", "An ultramarine turban, ochre fold and pearl against an inky ground.", [
  ...frame("#05070d", "#070a12", "#0a0a0c", "#05060a"),
  halo(0.5, 0.26, 0.29, 0.14, -0.22, "#0b1330"),
  lit(tilted(0.5, 0.27, 0.24, 0.11, -0.22), "#0b1330", ["#16265a", "#3f68b4", "#a9c2ee"]),
  lit(tilted(0.79, 0.56, 0.07, 0.24, 0.08), "#0a0a0c", ["#6b5426", "#c9a24e", "#efd891"]),
  halo(0.36, 0.66, 0.18, 0.2, -0.12, "#2a1a16"),
  lit(organic(0.36, 0.66, 0.14, 0.16, -0.12, [[2, 0.05, 0.4], [3, 0.03, 2]]), "#2a1a16", ["#6a4a3c", "#d0a48c", "#f2d4c0"]),
  lit(ellipseNodes(0.56, 0.93, 0.3, 0.06), "#07080c", ["#3a2c12", "#8a6a2a", "#c8a24a"]),
  point(0.58, 0.8, "#f4f1ea"), point(0.3, 0.7, "#c2504a"),
]);

const foldsCream = "#e8dfc8";

const folds = preset("ultramarine-folds", "Ultramarine folds", "Ultramarine drapery in layered folds, from sunlit cobalt to deep lapis under a cream wall.", [
  boundary(waveNodes({ x0: 0, x1: 1, y: 0.15, amplitude: 0.05, cycles: 0.5 }), [foldsCream, foldsCream], ["#3c63c4", "#5a82d6"]),
  boundary(waveNodes({ x0: 0, x1: 1, y: 0.33, amplitude: 0.055, cycles: 1, phase: 1.5 }), ["#3c63c4", "#5a82d6"], ["#1d3a96", "#2a4cab"]),
  boundary(waveNodes({ x0: 0, x1: 1, y: 0.52, amplitude: 0.065, cycles: 1, phase: 0.2 }), ["#1d3a96", "#2a4cab"], ["#4a72d0", "#7fa0e6"]),
  boundary(waveNodes({ x0: 0, x1: 1, y: 0.7, amplitude: 0.055, cycles: 1, phase: 2.6 }), ["#4a72d0", "#7fa0e6"], ["#0f2a7a", "#183aa0"]),
  boundary(waveNodes({ x0: 0, x1: 1, y: 0.88, amplitude: 0.03, cycles: 0.5, phase: 6 }), ["#0f2a7a", "#183aa0"], ["#0a1c5a", "#0a1c5a"]),
]);

const sfumato = preset("leonardo-sfumato", "Sfumato", "A smoky green-gold distance and a face built of a dozen thin glazes, with no hard edge anywhere.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#6c7d56", "#768a62"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#768a62", "#5c7a6a", "#8f6d3b", "#14100a"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#14100a", "#1a150e"]),
  boundary(polylineNodes([[0, 1], [0, 0]]), ["#1a150e", "#8f6d3b", "#5c7a6a", "#6c7d56"]),
  soft(tilted(0.5, 0.55, 0.3, 0.4, 0), "#2a1e12"),
  ...[[0.2, 0.26, "#5f4020"], [0.14, 0.18, "#a07a48"], [0.075, 0.1, "#dcc084"]].map(([rx, ry, c]) => soft(ellipseNodes(0.5, 0.48, rx, ry), c)),
  point(0.46, 0.43, "#f0dca0"),
]);

const tiepolo = preset("tiepolo-heaven", "Tiepolo heaven", "Pale azure ceiling sky with pearl clouds underlit in rose and a saffron drape.", [
  ...frame("#9dbbd8", "#b5cde0", "#dfe6e8", "#cfdde6"),
  soft(tilted(0.34, 0.7, 0.3, 0.2, 0.05), "#e8b9a4"), halo(0.34, 0.66, 0.22, 0.12, 0.05, "#f6e4d2"), point(0.28, 0.62, "#fffaf0"),
  soft(tilted(0.78, 0.3, 0.17, 0.1, -0.1), "#f2dcc4"), point(0.78, 0.28, "#fff6ea"),
  soft(tilted(0.84, 0.78, 0.1, 0.07, 0), "#7d93ae"),
  soft(leafNodes(0.4, 0.3, 0.56, 0.2, 0.06), "#e6b84f"),
  point(0.12, 0.12, "#ffeaa0"),
]);

const verdaccio = preset("verdaccio-flesh", "Verdaccio flesh", "Olive-green underpaint glowing through layers of rose and cream flesh glazes, like a forearm in a Renaissance portrait.", [
  ...frame("#5e6648", "#6f7656", "#2c3022", "#3a3f2c"),
  ...[[0.42, 0.17, "#8a8a62"], [0.3, 0.12, "#b8a27c"], [0.19, 0.075, "#dcab92"], [0.09, 0.035, "#f4d8c0"]].map(([rx, ry, c]) => soft(tilted(0.5, 0.5, rx, ry, -0.45), c)),
]);

export const PRESETS = [
  preset("rembrandt-glow", "Rembrandt glow", "A broad umber pool of warm light, brightest at one cheek, sinking into black with a pale collar catching the edge.", [
  ...frame("#0a0705", "#140d08", "#1a120c", "#0c0806"),
  ...[[0.38, "#2a1a0f"], [0.26, "#6a4428"], [0.14, "#b98450"], [0.06, "#e8c08a"]].map(([r, c]) => soft(ellipseNodes(0.4, 0.4, r), c)),
  point(0.34, 0.34, "#f6dcb0"),
]),
  preset("candle-flame", "Candle flame", "A single flame ringed by amber and ember red, lighting a pale sleeve and red skirt in the dark.", [
  ...frame("#0a0504", "#120806", "#0a0504", "#060302"),
  boundary(leafNodes(0.72, 0.22, 0.72, 0.34, 0.05), ["#c2601e", "#c2601e", "#c2601e"], ["#fff3c4", "#ffd27a", "#fff3c4"], true),
  ...[[0.1, "#d8772a"], [0.17, "#8a3816"], [0.27, "#3a160a"]].map(([r, c]) => soft(ellipseNodes(0.72, 0.29, r), c)),
  soft(tilted(0.26, 0.52, 0.14, 0.11, -0.3), "#5a2a18"), soft(tilted(0.26, 0.5, 0.075, 0.055, -0.3), "#d2a27a"),
  soft(tilted(0.34, 0.84, 0.22, 0.1, -0.1), "#3a1008"), soft(tilted(0.34, 0.84, 0.12, 0.05, -0.1), "#8a2214"),
]),
  preset("vermeer-blue-room", "Vermeer blue room", "A cool grey-blue plaster wall, a glowing ultramarine jacket and a dim ochre map in window light.", [
  ...frame("#c7cfd4", "#9aa8b4", "#4a5a70", "#6a7a8a"),
  ...[[0.26, 0.3, "#4a6fa8"], [0.18, 0.22, "#2f58a0"], [0.09, 0.11, "#6f93cf"]].map(([rx, ry, c]) => soft(tilted(0.4, 0.66, rx, ry, 0.1), c)),
  soft(tilted(0.78, 0.26, 0.14, 0.12, 0), "#b89a62"), soft(tilted(0.78, 0.26, 0.07, 0.06, 0), "#d8bb7c"),
]),
  preset("titian-crimson", "Titian crimson", "Glazed crimson velvet folds with a gold-orange sheen against a green-black curtain.", [
  boundary([[0.3, 0, 0, 0, 0, 0.1], [0.2, 0.5, 0, -0.12, 0, 0.12], [0.24, 1, 0, -0.1, 0, 0]], ["#0a1610", "#0d1f16", "#08130d"], ["#2a0a0c", "#3a1012", "#1e0708"]),
  boundary(polylineNodes([[0.36, 0], [1, 0]]), ["#3a1012", "#2a0a0a"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#2a0a0a", "#1e0708"]),
  boundary(polylineNodes([[1, 1], [0.3, 1]]), ["#1e0708", "#1e0708"]),
  ...[[0.15, 0.42, "#6a1016"], [0.1, 0.34, "#b01c22"], [0.045, 0.24, "#ea6a44"]].map(([rx, ry, c]) => soft(tilted(0.55, 0.5, rx, ry, 0.12), c)),
  ...[[0.085, 0.32, "#55101a"], [0.04, 0.2, "#c2321f"]].map(([rx, ry, c]) => soft(tilted(0.84, 0.5, rx, ry, 0.08), c)),
]),
  preset("leonardo-sfumato", "Sfumato", "A smoky green-gold distance and a face built of a dozen thin glazes, with no hard edge anywhere.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#6c7d56", "#768a62"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#768a62", "#5c7a6a", "#8f6d3b", "#14100a"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#14100a", "#1a150e"]),
  boundary(polylineNodes([[0, 1], [0, 0]]), ["#1a150e", "#8f6d3b", "#5c7a6a", "#6c7d56"]),
  soft(tilted(0.5, 0.55, 0.3, 0.4, 0), "#2a1e12"),
  ...[[0.2, 0.26, "#5f4020"], [0.14, 0.18, "#a07a48"], [0.075, 0.1, "#dcc084"]].map(([rx, ry, c]) => soft(ellipseNodes(0.5, 0.48, rx, ry), c)),
  point(0.46, 0.43, "#f0dca0"),
]),
  preset("tiepolo-heaven", "Tiepolo heaven", "Pale azure ceiling sky with pearl clouds underlit in rose and a saffron drape.", [
  ...frame("#9dbbd8", "#b5cde0", "#dfe6e8", "#cfdde6"),
  soft(tilted(0.34, 0.7, 0.3, 0.2, 0.05), "#e8b9a4"), halo(0.34, 0.66, 0.22, 0.12, 0.05, "#f6e4d2"), point(0.28, 0.62, "#fffaf0"),
  soft(tilted(0.78, 0.3, 0.17, 0.1, -0.1), "#f2dcc4"), point(0.78, 0.28, "#fff6ea"),
  soft(tilted(0.84, 0.78, 0.1, 0.07, 0), "#7d93ae"),
  soft(leafNodes(0.4, 0.3, 0.56, 0.2, 0.06), "#e6b84f"),
  point(0.12, 0.12, "#ffeaa0"),
]),
  preset("lorrain-haze", "Lorrain haze", "A low white-gold sun melting a pale morning harbour haze between dark framing trees.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#9fb3b2", "#b3bfb0"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#b3bfb0", "#d8c48c", "#6b6a44", "#1c1a0e"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#1c1a0e", "#1a170c"]),
  boundary(polylineNodes([[0, 1], [0, 0]]), ["#1a170c", "#6b6a44", "#d8c48c", "#9fb3b2"]),
  ...[[0.05, "#fff3c8"], [0.14, "#f3d189"], [0.26, "#c9a45e"]].map(([r, c]) => soft(ellipseNodes(0.5, 0.5, r, r * 0.8), c)),
]),
  preset("lorrain-amber", "Lorrain amber", "A low evening sun in molten amber over a blue-grey sky, a dark tree mass at the right.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#4f5f80", "#6a6a82"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#6a6a82", "#b87a4a", "#3a2a14", "#14100a"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#14100a", "#1a140a"]),
  boundary(polylineNodes([[0, 1], [0, 0]]), ["#1a140a", "#5a3a1c", "#d08a4c", "#4f5f80"]),
  ...[[0.05, "#fff0c4"], [0.12, "#f6a848"], [0.22, "#b85a2a"]].map(([r, c]) => soft(ellipseNodes(0.38, 0.52, r, r * 0.75), c)),
  soft(tilted(0.88, 0.45, 0.095, 0.34, 0), "#3a2a14"), soft(tilted(0.88, 0.45, 0.05, 0.28, 0), "#15170b"),
]),
  preset("delft-clouds", "Delft sky", "Heavy pearl-grey clouds parting over a thin golden strip of sunlit rooftops and dark water.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#56616e", "#6b7684"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#6b7684", "#a9a99a", "#2b3238", "#141a20"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#141a20", "#141a20"]),
  boundary(polylineNodes([[0, 1], [0, 0]]), ["#141a20", "#2b3238", "#a9a99a", "#56616e"]),
  soft(tilted(0.62, 0.28, 0.2, 0.1, 0), "#e6e0cc"), point(0.64, 0.26, "#fdf6dc"),
  soft(tilted(0.25, 0.22, 0.16, 0.1, 0), "#7f8894"),
  boundary(leafNodes(0.08, 0.6, 0.92, 0.6, 0.04), ["#8a8f96", "#8a8f96", "#8a8f96"], ["#e0b453", "#c48a30", "#e0b453"], true),
]),
  preset("hand-over-flame", "Hand over flame", "A dark hand shielding a candle, its edge rim-lit, inside concentric rings of hot amber and ember.", [
  ...frame("#080403", "#0c0605", "#080403", "#050302"),
  ...[[0.36, "#4a1c0e"], [0.25, "#b04c1c"], [0.14, "#f0a850"]].map(([r, c]) => soft(ellipseNodes(0.5, 0.5, r), c)),
  boundary(tilted(0.46, 0.52, 0.055, 0.09, 0.3), ["#f0a850"], ["#1a0806"], true),
  point(0.58, 0.46, "#fff3c4"),
]),
  preset("verdaccio-flesh", "Verdaccio flesh", "Olive-green underpaint glowing through layers of rose and cream flesh glazes, like a forearm in a Renaissance portrait.", [
  ...frame("#5e6648", "#6f7656", "#2c3022", "#3a3f2c"),
  ...[[0.42, 0.17, "#8a8a62"], [0.3, 0.12, "#b8a27c"], [0.19, 0.075, "#dcab92"], [0.09, 0.035, "#f4d8c0"]].map(([rx, ry, c]) => soft(tilted(0.5, 0.5, rx, ry, -0.45), c)),
]),
  preset("moon-and-campfire", "Moon and campfire", "A cold moon glow and a warm campfire glow sharing a blue-black night.", [
  ...frame("#050914", "#070c18", "#0a0806", "#070608"),
  ...[[0.05, "#f4f6ff"], [0.14, "#9fb4da"], [0.27, "#22365a"]].map(([r, c]) => soft(ellipseNodes(0.7, 0.3, r), c)),
  ...[[0.03, "#ffe08a"], [0.08, "#f08a30"], [0.19, "#5a2410"]].map(([r, c]) => soft(ellipseNodes(0.26, 0.74, r), c)),
  point(0.16, 0.14, "#c8d4f0"), point(0.42, 0.1, "#b8c6e6"),
]),
];
