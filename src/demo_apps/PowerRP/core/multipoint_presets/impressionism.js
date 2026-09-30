/**
 * "Impressionism" — native Multipoint presets. Monet's series and his circle: haystacks, Rouen, lilies, fog and harbour light.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { polylineNodes, waveNodes, rectNodes } from "../multipoint_shapes.js";
import { hline, ridge, disc, soft, stackNodes, pointedArch } from "./impressionism_helpers.js";

/**
 * Pure function. One Monet grainstack scene: sky, horizon glow, hills, ground, stacks and cast shadows.
 * @param {object} o - {sky, glow, hz, hills, far, near, stacks:[{cx,base,w,h,inside:[a,b,c]}], shadows:[{cx,cy,rx,ry,out,inside}]}.
 * @returns {object[]} Features.
 * @example haystackScene({sky:["#fff"],glow:["#eee"],hz:0.3,hills:["#88a"],far:["#ccc"],near:["#aaa"],stacks:[],shadows:[]}).length // 4
 */
export function haystackScene({ sky, glow, hz, hills, far, near, stacks, shadows }) {
  const hillsEnd = hz + 0.1;
  return [
    hline(0, sky),
    ridge([hz + 0.01, hz - 0.015, hz + 0.005, hz - 0.01], glow, hills),
    hline(hillsEnd, hills, far),
    hline(1, near),
    ...shadows.map(({ cx, cy, rx, ry, inside }) => soft(cx, cy, rx, ry, inside)),
    ...stacks.map(({ cx, base, w, h, ground, inside }) =>
      boundary(stackNodes(cx, base, w, h), [ground, hills[0], ground, ground], closedRamp(inside), true)),
  ];
}

/**
 * Pure function. Rouen-style broken-colour facade: soft vertical strokes (ellipse rows) in warm and cool
 * pigments, plus soft Gothic pointed arches, over a sky-to-pavement field.
 * @param {object} o - {sky[3], base[3], strokes:[[cx,cy,rx,ry,color]...], arches:[[cx,base,hw,spring,apex,color]...]}.
 * @returns {object[]} Features.
 * @example rouenStrokes({sky:["#fff"],base:["#000"],strokes:[[0.5,0.3,0.1,0.2,"#f00"]],arches:[]}).length // 3
 */
export function rouenStrokes({ sky, base, strokes, arches }) {
  return [hline(0, sky), hline(1, base),
    ...strokes.map(([cx, cy, rx, ry, color]) => soft(cx, cy, rx, ry, color)),
    ...arches.map(([cx, b, hw, spring, apex, color]) => boundary(pointedArch(cx, b, hw, spring, apex), [color], null, true))];
}

/**
 * Pure function. Five-column Rouen layout: five tall strokes above (staggered), a portal arch and two flanker arches.
 * @param {object} g - {xs[5], cys[5], rx, ry, portal:[cx,base,hw,spring,apex], flank:[dx,base,hw,spring,apex]}.
 * @param {string[]} top - Five stroke colours.
 * @param {string} portal - Portal colour.
 * @param {string[]} flank - Two flanker colours.
 * @returns {{strokes:number[][],arches:Array}} Inputs for rouenStrokes.
 * @example rouenLayout({xs:[.1,.3,.5,.7,.9],cys:[.3,.25,.3,.25,.3],rx:.08,ry:.2,portal:[.5,.98,.2,.74,.5],flank:[.3,.98,.07,.8,.62]},["#1","#2","#3","#4","#5"],"#p",["#a","#b"]).arches.length // 3
 */
export function rouenLayout({ xs, cys, rx, ry, portal: p, flank: f }, top, portal, flank) {
  return {
    strokes: xs.map((x, i) => [x, cys[i], rx, ry, top[i]]),
    arches: [[...p, portal], [p[0] - f[0], f[1], f[2], f[3], f[4], flank[0]], [p[0] + f[0], f[1], f[2], f[3], f[4], flank[1]]],
  };
}

const rouen = (sky, base, layout, top, portal, flank) => rouenStrokes({ sky, base, ...rouenLayout(layout, top, portal, flank) });

export const PRESETS = [
  preset("sunrise-harbour-haze", "Impression, Sunrise", "Le Havre harbour haze: blue-green mist, one small vermilion sun, ghostly cranes and a broken orange reflection.", [
    hline(0, ["#d98a68", "#aaa39a", "#7f9c9c"]),
    hline(0.5, ["#8aa5a6"], ["#6d8e90"]),
    hline(1, ["#3d5d5c", "#2f4d50"]),
    soft(0.6, 0.31, 0.11, 0.09, "#cf7a5a"),
    disc(0.6, 0.31, 0.045, 0.045, ["#d8683f"], ["#f4502a"]),
    ...[[0.62, 0.05], [0.74, 0.04], [0.88, 0.03]].map(([cy, rx]) => soft(0.6, cy, rx, 0.035, "#dc6a3e")),
    disc(0.32, 0.73, 0.09, 0.03, ["#597a7a"], ["#1d3a3c"]),
    soft(0.3, 0.14, 0.24, 0.03, "#f0a070"),
    boundary(rectNodes(0.13, 0.26, 0.15, 0.5), ["#6a8c8d"], null, true),
  ]),
  preset("haystack-sunset-snow", "Grainstack, sunset snow", "Monet 1890-91: yellow-orange sky, plum hills and rose-violet snow around a glowing orange stack.", haystackScene({
    sky: ["#e9a56c", "#f0c574"], glow: ["#f8dd90", "#f4bd6c"], hz: 0.34, hills: ["#8f68a8", "#7a5ea4"], far: ["#e79cb2"],
    near: ["#a56fb6", "#7b5eb0"],
    stacks: [{ cx: 0.64, base: 0.8, w: 0.46, h: 0.4, ground: "#c48ab8", inside: ["#f28a2a", "#ffd24a", "#a63a2e"] }],
    shadows: [{ cx: 0.3, cy: 0.9, rx: 0.28, ry: 0.05, out: "#a06cb6", inside: "#5b58b0" }],
  })),
  preset("haystacks-end-of-day", "Grainstacks, end of day", "Monet's autumn twilight: two rose-red stacks in mauve field under a green-to-peach sky.", haystackScene({
    sky: ["#a4d0c2", "#c9cfdc"], glow: ["#f7c8a6", "#f5d8a6"], hz: 0.32, hills: ["#6a76b4", "#7a7cb8"], far: ["#c88fa2"],
    near: ["#86b06e", "#c8d18a", "#a8b06c"],
    stacks: [{ cx: 0.7, base: 0.82, w: 0.5, h: 0.4, ground: "#c88fa2", inside: ["#df6e68", "#f3a486", "#9c4560"] },
      { cx: 0.17, base: 0.7, w: 0.24, h: 0.18, ground: "#c98fa4", inside: ["#df6e68", "#f0a888", "#9c4560"] }],
    shadows: [{ cx: 0.5, cy: 0.9, rx: 0.4, ry: 0.04, out: "#a6b07a", inside: "#7f8cb8" }],
  })),
  preset("parliament-fog", "Houses of Parliament, fog", "Monet's London: a gold sun bleeding through lilac fog, a violet tower and an orange Thames.", [
    hline(0, ["#e79e6e", "#c69aa8", "#9f90b8"]),
    hline(1, ["#8c80a8", "#cf8c78", "#7c78a8"]),
    ridge([0.55, 0.5, 0.56, 0.52], ["#a394b8"], ["#8f88b4"]),
    soft(0.3, 0.16, 0.19, 0.14, "#f0a664"),
    soft(0.3, 0.16, 0.06, 0.05, "#ffd56a"),
    boundary(polylineNodes([[0.66, 0.6], [0.66, 0.3], [0.71, 0.14], [0.76, 0.3], [0.76, 0.6]]), ["#a596b8"], ["#6c6aa2"], true),
    boundary(polylineNodes([[0.8, 0.6], [0.8, 0.4], [0.9, 0.4], [0.9, 0.6]]), ["#a596b8"], ["#8a84b6"], true),
    ...[[0.72, 0.28, 0.06], [0.84, 0.36, 0.04], [0.94, 0.2, 0.05]].map(([cy, rx, ry]) => soft(0.42, cy, rx, ry * 0.6, "#f08e44")),
  ]),
  preset("rouen-cathedral-sunset", "Rouen Cathedral, sunset", "Monet's facade dissolved into vertical strokes of coral, gold and cobalt around a glowing Gothic portal.",
    rouen(["#7fa0d6", "#9db8e6", "#7f9fd6"], ["#6a66b0", "#8f82b8", "#6a66b0"],
      { xs: [0.1, 0.3, 0.5, 0.7, 0.9], cys: [0.27, 0.2, 0.3, 0.22, 0.28], rx: 0.08, ry: 0.17, portal: [0.5, 0.98, 0.19, 0.76, 0.52], flank: [0.32, 0.98, 0.07, 0.82, 0.66] },
      ["#f4a35a", "#7fa0dc", "#f6c878", "#7290d0", "#f19a54"], "#d0682a", ["#8a74c0", "#9a80c8"])),
  preset("rouen-cathedral-blue-gold", "Rouen Cathedral, blue and gold", "Full sun: cobalt-shadow columns struck with lemon and gold around a deep ultramarine portal.",
    rouen(["#a8c4e8", "#c8dcf0", "#98b8e8"], ["#4a5cb0", "#7f88c8", "#4a5cb0"],
      { xs: [0.13, 0.32, 0.5, 0.68, 0.87], cys: [0.22, 0.28, 0.2, 0.28, 0.24], rx: 0.07, ry: 0.15, portal: [0.5, 0.98, 0.22, 0.72, 0.46], flank: [0.33, 0.98, 0.06, 0.8, 0.66] },
      ["#f0d060", "#5878c8", "#f6e090", "#6f8ad4", "#e8c250"], "#3e58a8", ["#e0b850", "#e6c060"])),
  preset("lilies-sunset-pond", "Water lilies, sunset", "Nymphéas at dusk: the pond mirrors a gold, crimson and violet sky under dark willow shadows.", [
    hline(0, ["#f2b04a", "#e0603c", "#7e4f96"]), hline(1, ["#2f3f7a", "#5a3f7f", "#2a4a68"]),
    soft(0.46, 0.3, 0.24, 0.05, "#f7c25a"), soft(0.6, 0.52, 0.2, 0.04, "#e8506a"),
    soft(0.1, 0.5, 0.05, 0.3, "#2c3f6a"), soft(0.9, 0.55, 0.05, 0.28, "#2c3f6a"),
    disc(0.42, 0.78, 0.09, 0.03, ["#5a4a86"], ["#3f8a5a"]), disc(0.68, 0.86, 0.07, 0.025, ["#5a4a86"], ["#4a9a62"]), disc(0.3, 0.66, 0.06, 0.02, ["#8a4a86"], ["#3f8a5a"]),
    point(0.44, 0.775, "#f7a0c0"), point(0.7, 0.855, "#fbc0d4"), point(0.31, 0.66, "#f890b4"),
  ]),
  preset("lilies-green-pond", "Water lilies, green pond", "Cool giverny water: aqua and sap-green reflections, lilac cloud streaks and white blossoms.", [
    hline(0, ["#9cc8d8", "#6aa8a8", "#4a8a90"]), hline(1, ["#2f5a66", "#3a6a5c", "#24505c"]),
    soft(0.5, 0.26, 0.38, 0.045, "#d2b4dc"), soft(0.3, 0.5, 0.26, 0.045, "#7fb8a0"), soft(0.72, 0.4, 0.22, 0.04, "#c8e08a"),
    disc(0.66, 0.66, 0.15, 0.06, ["#3f8a8a"], ["#4c8a4a"]), disc(0.3, 0.76, 0.12, 0.05, ["#3a7a80"], ["#5a9a4a"]), disc(0.8, 0.86, 0.1, 0.04, ["#3a7080"], ["#4c8a4a"]),
    point(0.64, 0.655, "#ffffff"), point(0.3, 0.76, "#f8b8d0"), point(0.8, 0.86, "#fff4fa"),
  ]),
  preset("temeraire-sunset", "The Fighting Temeraire", "Turner's last berth: a gold-white sunset, a pale ghost ship, a small black tug and a molten water road.", [
    hline(0, ["#6c8ca8", "#9fb0b4", "#d0a070"]),
    hline(0.66, ["#f6d288", "#f8dc98", "#f6c878"], ["#b48a64", "#c99a68", "#a8865c"]),
    hline(1, ["#2e3d52", "#3a4858"]),
    soft(0.74, 0.58, 0.17, 0.07, "#fff0b8"), soft(0.74, 0.585, 0.05, 0.04, "#fffbe8"),
    soft(0.27, 0.42, 0.09, 0.24, "#e2e0d6"), soft(0.74, 0.82, 0.045, 0.1, "#f4c070"),
    disc(0.52, 0.72, 0.07, 0.03, ["#b48a64"], ["#2a2a30"]),
  ]),
  preset("boulevard-night", "Boulevard Montmartre, night", "Pissarro's lamplit boulevard: indigo dusk, gold gas lamps and wet street reflections.", [
    hline(0, ["#20233a", "#303350", "#232640"]), hline(1, ["#3a3a58", "#b88c48", "#3a3a58"]),
    ridge([0.5, 0.48, 0.5, 0.48], ["#4b4a66", "#6a5a5a", "#4a4c68"], ["#7a6a5a", "#c9a050", "#7a6a5a"]),
    soft(0.28, 0.36, 0.07, 0.06, "#f4d16a"), soft(0.7, 0.32, 0.06, 0.06, "#f0c060"),
    soft(0.28, 0.78, 0.04, 0.14, "#e0b050"), soft(0.7, 0.76, 0.04, 0.16, "#d8a850"),
    disc(0.5, 0.7, 0.09, 0.04, ["#a08050"], ["#2a2a3a"]),
    point(0.12, 0.3, "#f2c860"), point(0.16, 0.36, "#f2c860"), point(0.88, 0.38, "#f2c860"),
  ]),
  preset("orchard-blossom", "Pontoise orchard", "Pissarro in spring: apple trees in white and pink blossom against cerulean sky over sunlit and shaded grass.", [
    hline(0, ["#8fbfe2", "#cfe2ee", "#9cc8e2"]), hline(1, ["#5f9040", "#a4c05a", "#6f9a48"]),
    ridge([0.6, 0.57, 0.6, 0.56], ["#a8cc9a", "#c0d8a0"], ["#7fa64a", "#98b854"]),
    soft(0.2, 0.3, 0.16, 0.13, "#ffeaf0"), soft(0.58, 0.24, 0.2, 0.13, "#f9cdd9"), soft(0.87, 0.38, 0.09, 0.12, "#ffffff"), soft(0.4, 0.44, 0.1, 0.05, "#e8a8c0"),
    soft(0.3, 0.78, 0.2, 0.06, "#e4ec9c"), soft(0.72, 0.86, 0.2, 0.05, "#3f6f30"),
  ]),
  preset("pearl-and-blush", "Morisot, pearl and blush", "Berthe Morisot's feathery whites: ivory, pearl blue, blush and sage in soft diagonal waves.", [
    hline(0, ["#f0f2f0", "#e6eef2", "#f2ece8"]), hline(1, ["#dbe4d8", "#efe4e2", "#d8e4ea"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.28, amplitude: 0.05, cycles: 0.5 }), ["#f4f0ea", "#f6f2f0"], ["#e2ecf0", "#e8f0f2"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.5, amplitude: 0.045, cycles: 1, phase: 1 }), ["#f0d8d8", "#f4e0dc"], ["#dfe8dc", "#e4ecdc"]),
    boundary(waveNodes({ x0: 0, x1: 1, y: 0.74, amplitude: 0.04, cycles: 0.5, phase: 2 }), ["#e6ecea", "#eef0ec"], ["#f4dcdc", "#f0dcd8"]),
    soft(0.3, 0.16, 0.14, 0.03, "#f7c6c8"), soft(0.75, 0.62, 0.15, 0.03, "#b8d0c0"), soft(0.5, 0.9, 0.2, 0.03, "#c8d8e8"),
  ]),
];
