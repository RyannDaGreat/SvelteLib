/**
 * "Cinema grades" — native Multipoint presets. Colour grades from the cinematographer's toolbox: teal-orange, neon noir, day-for-night, magic hour.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { polylineNodes, ellipseNodes, waveNodes, rectNodes } from "../multipoint_shapes.js";
import { boxEdge, cornerFrame } from "./retro_eras.js";
import { hline, vramp, streak, pool, glow, archNodes } from "./cinema_helpers.js";

export const PRESETS = [
  preset("teal-orange-blockbuster", "Teal and orange", "The blockbuster grade: shadows pushed to teal, skin and highlights pushed to orange, one warm glow against a cool field.", [
    boxEdge("top", ["#0b3944", "#0f4d59"]),
    boxEdge("left", ["#0b3944", "#0a3038", "#0a2c34"]),
    boxEdge("right", ["#0f4d59", "#175a5e", "#1f5658"]),
    boxEdge("bottom", ["#0a2c34", "#123f46", "#1d5256"], 0.05, 0.95),
    ...glow(0.6, 0.58, 0.4, ["#ffc48a", "#c8763a", "#2a6664"], 0.4),
  ]),
  preset("neon-noir-rain", "Neon noir", "Rain-soaked night street: magenta, cyan and amber neon hairlines over near-black, smeared down the wet asphalt.", [
    ...cornerFrame("#07061a", "#0a0a24", "#0e0616", "#05040f"),
    hline(0.6, 0.6, ["#0a0820"], ["#150a26"]),
    streak([[0.3, 0.1], [0.3, 0.3], [0.3, 0.55]], [0, 0.03, 0], "#8a1a78", "#ff3cb4"),
    streak([[0.7, 0.2], [0.7, 0.36], [0.7, 0.55]], [0, 0.025, 0], "#0e5a88", "#3cf0ff"),
    streak([[0.12, 0.34], [0.12, 0.42], [0.12, 0.5]], [0, 0.02, 0], "#6a3a10", "#ffa030"),
    streak([[0.3, 0.64], [0.3, 0.78], [0.3, 0.95]], [0, 0.08, 0], "#26102e", "#a02a86"),
    streak([[0.7, 0.64], [0.7, 0.78], [0.7, 0.95]], [0, 0.07, 0], "#0c1e34", "#2a9ab0"),
  ]),
  preset("pastel-symmetry", "Pastel symmetry", "Centred storybook-hotel palette: pale sky over a pink facade, a crimson-framed gold arch, mint round windows, a plum base.", [
    hline(0.2, 0.2, ["#a7c5eb"], ["#f4a8b9"]),
    hline(0.86, 0.86, ["#f4a8b9"], ["#7b3b8b"]),
    boundary(archNodes(0.36, 0.64, 0.3, 0.8), ["#f4a8b9"], ["#c41311"], true),
    boundary(archNodes(0.42, 0.58, 0.4, 0.74), ["#c41311"], ["#f4d35e"], true),
    boundary(ellipseNodes(0.16, 0.42, 0.06), ["#f4a8b9"], ["#8bc4a8"], true),
    boundary(ellipseNodes(0.84, 0.42, 0.06), ["#f4a8b9"], ["#8bc4a8"], true),
  ]),
  preset("day-for-night-blue", "Day for night", "Underexposed daylight passed off as night: blue-graded sky, a bleached sun-moon, blackened ground.", [
    ...vramp(["#0b1a3d", "#1f3f78", "#5b83b8", "#8fb0d8"], undefined, 0, 0.66),
    hline(0.7, 0.66, ["#8aabd4"], ["#0c1a30"]),
    boxEdge("bottom", ["#060c18", "#0a1526"]),
    ...glow(0.68, 0.3, 0.22, ["#f4f8ff", "#a8c4e8", "#4a70a8"]),
  ]),
  preset("magic-hour-glow", "Magic hour", "Backlit magic hour: a bleached, blue-free sky, gold haze at the horizon and a wheat field falling into dark amber.", [
    ...vramp(["#c9c4b0", "#f3dfb0", "#ffd27a"], ["#b8b8ae", "#efd9ab", "#ffc36a"], 0, 0.6),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.62, amplitude: 0.012, cycles: 1.5 }), ["#ffc36a"], ["#d99a34"]),
    hline(0.82, 0.78, ["#d99a34"], ["#4a2e0c"]),
    boxEdge("bottom", ["#2a1806"]),
    ...glow(0.7, 0.44, 0.14, ["#fffbe8", "#ffe6a0", "#fbd38a"]),
  ]),
  preset("sodium-vapour-night", "Sodium vapour", "Snowy suburban night: one amber lamp pooling warm light on the ground, a cold teal lamp far off, murky grey-teal dark.", [
    ...cornerFrame("#1a2226", "#161c20", "#12181a", "#1a2428"),
    ...pool(0.68, 0.76, 0.3, 0.2, ["#ffd48a", "#c98a3a", "#1f2426"]),
    ...glow(0.16, 0.52, 0.1, ["#c8f4ff", "#5aa8b8", "#1a2428"]),
    point(0.84, 0.16, "#ffe6a8"),
  ]),
  preset("step-printed-smear", "Step-printed smear", "Smeared saturated trails: green, red and amber light dragged diagonally across a dark, slow-shutter frame.", [
    ...cornerFrame("#12060a", "#0a1a14", "#1a0808", "#08100c"),
    streak([[0.05, 0.85], [0.3, 0.6], [0.55, 0.38], [0.85, 0.2]], [0, 0.1, 0.12, 0], "#1a5a3a", "#22b06a"),
    streak([[0.15, 0.95], [0.4, 0.75], [0.65, 0.55], [0.95, 0.4]], [0, 0.08, 0.1, 0], "#5a1218", "#e02b3a"),
    streak([[0.02, 0.5], [0.25, 0.32], [0.5, 0.18], [0.7, 0.05]], [0, 0.06, 0.07, 0], "#5a3a10", "#ffb030"),
  ]),
  preset("one-point-corridor", "One-point corridor", "Perfect one-point symmetry: red walls, pale fluorescent ceiling and floor, all converging on a lit far door.", [
    boundary(polylineNodes([[0, 0], [0.39, 0.37]]), ["#d6e6da", "#a8c0b0"], ["#c4202a", "#8a1219"]),
    boundary(polylineNodes([[1, 0], [0.61, 0.37]]), ["#c4202a", "#8a1219"], ["#d6e6da", "#a8c0b0"]),
    boundary(polylineNodes([[1, 1], [0.61, 0.53]]), ["#e0d0ae", "#b8a884"], ["#c4202a", "#8a1219"]),
    boundary(polylineNodes([[0, 1], [0.39, 0.53]]), ["#c4202a", "#8a1219"], ["#e0d0ae", "#b8a884"]),
    boundary(rectNodes(0.42, 0.4, 0.58, 0.5), ["#5a0a10"], ["#fff3d0"], true),
  ]),
  preset("desert-orange-teal", "Desert orange-teal", "Wasteland grade: teal sky bleaching into a hot haze over orange dunes lit gold on one face and rust on the other.", [
    ...vramp(["#0f4d5a", "#2f8a8a", "#8cc4b8"], undefined, 0, 0.5),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.53, amplitude: 0.02, cycles: 1.25 }), ["#b8dcc8"], ["#f3a252"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.73, amplitude: 0.03, cycles: 1 }), ["#f3a252"], ["#8a3a1c"]),
    hline(0.9, 0.86, ["#8a3a1c"], ["#d0682a"]),
    ...glow(0.7, 0.24, 0.12, ["#fff6d8", "#ffe6b0", "#b8e0c8"]),
  ]),
  preset("desert-planet-haze", "Desert planet haze", "A blue-free hot haze: a bleached sun in a sand-coloured sky over ochre dunes stepping down to umber.", [
    ...vramp(["#c98a58", "#e0b483", "#ecd2a8"], undefined, 0, 0.52),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.55, amplitude: 0.02, cycles: 1 }), ["#ecd2a8"], ["#b07a48"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.72, amplitude: 0.025, cycles: 1.25 }), ["#b07a48"], ["#7a4a2a"]),
    hline(0.9, 0.88, ["#7a4a2a"], ["#3e2616"]),
    ...glow(0.42, 0.26, 0.2, ["#fff8e6", "#f6e3bf", "#e4bf90"]),
  ]),
  preset("venetian-noir", "Venetian noir", "Noir light through blinds: hard diagonal bars of cold light and pitch black fading across the frame.", (() => {
    const bands = ["#dfe6ea", "#080a0d", "#b8c2c8", "#080a0d", "#8d99a1", "#080a0d", "#5e6a72"];
    return [0.06, 0.2, 0.34, 0.48, 0.62, 0.76].map((y, i) => hline(y, y + 0.14, [bands[i]], [bands[i + 1]]));
  })()),
  preset("anamorphic-flare", "Anamorphic flare", "The horizontal lens streak: a cyan-white flare stretched across a deep blue-black frame, an amber ghost beneath.", [
    ...cornerFrame("#04081a", "#060c22", "#03061a", "#050a1e"),
    streak([[0.03, 0.5], [0.3, 0.5], [0.7, 0.5], [0.97, 0.5]], [0, 0.05, 0.05, 0], "#1a78d8", "#eefcff"),
    streak([[0.2, 0.6], [0.5, 0.6], [0.8, 0.6]], [0, 0.03, 0], "#6a3a10", "#ffb04a"),
  ]),
  preset("two-strip-sunset", "Two-strip sunset", "Two-colour dye process: only orange-red and cyan-green exist, so a sun setting over a sea shows just those two.", [
    ...vramp(["#c2451f", "#f08a3e", "#f7b26a"], undefined, 0, 0.53),
    hline(0.55, 0.55, ["#f7b26a"], ["#3aa89c"]),
    ...vramp(["#3aa89c", "#15877f", "#0d5f5d"], undefined, 0.57, 1),
    ...glow(0.5, 0.38, 0.12, ["#fff0c8", "#fbd38a", "#f7b26a"]),
    streak([[0.5, 0.6], [0.5, 0.76], [0.5, 0.94]], [0, 0.07, 0], "#2a9a90", "#f9dfae"),
  ]),
  preset("amber-gloom", "Amber gloom", "Seventies interior gloom: a desk lamp's amber pool in umber dark, a dull green window slit at the edge.", [
    ...cornerFrame("#0d0803", "#120b05", "#0a0602", "#100904"),
    ...pool(0.4, 0.56, 0.36, 0.4, ["#f9d078", "#a5651b", "#1a0e05"]),
    boundary(rectNodes(0.84, 0.1, 0.9, 0.9), ["#3a3a28"], ["#7a8a6a"], true),
  ]),
];
