/**
 * "Romantic & sublime" — native Multipoint presets. Leighton, Aivazovsky, John Martin, Constable, Turner and Friedrich: storms, moons, fire and luminous seas.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { catmullRomNodes, ellipseNodes, polylineNodes } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { skyField, ridge, floor, shape, crag } from "./romantic_helpers.js";

// Leighton, Flaming June (1895): sheer orange drapery in heavy folds against a pale sea and wall, brown hair and crimson cloth around it.
const JUNE = "#e07a26";

const fold = (pts, lit, shade) => boundary(catmullRomNodes(pts), [JUNE, lit, JUNE], [JUNE, shade, JUNE]);

export const PRESETS = [
  preset("flaming-june", "Flaming June", "Sheer orange drapery in glowing folds over crimson cloth, a pale marble wall and a strip of sea behind, after Leighton.", [
  boundary(polylineNodes([[0, 0.15], [0.5, 0.145], [1, 0.15]]), ["#ecdec6"], ["#8cc0c0"]),
  boundary(polylineNodes([[0, 0.2], [1, 0.2]]), ["#8cc0c0"], ["#7a5030"]),
  boundary([[0, 0.5, 0, 0, 0.06, -0.08], [0.3, 0.3, -0.08, 0.02, 0.08, -0.02], [0.56, 0.27, -0.08, 0, 0.08, 0.01], [0.82, 0.38, -0.07, -0.03, 0.06, 0.05], [1, 0.58, -0.04, -0.06, 0, 0], [1, 1, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0]],
    ["#5a3418", "#6e1c14", "#5a3418"], [JUNE, "#f9ac4c", JUNE], true),
  fold([[0.14, 0.5], [0.36, 0.46], [0.58, 0.6], [0.88, 0.62]], "#fbb862", "#a2400a"),
  fold([[0.2, 0.64], [0.42, 0.58], [0.6, 0.72], [0.84, 0.82]], "#f7a84c", "#8f3608"),
  fold([[0.3, 0.34], [0.5, 0.35], [0.68, 0.44], [0.86, 0.5]], "#ffc878", "#b64e0c"),
  fold([[0.14, 0.76], [0.36, 0.8], [0.6, 0.88]], "#f29a3c", "#963a08"),
  point(0.42, 0.36, "#ffd692"), point(0.7, 0.56, "#ffc070"),
]),
  // Constable, Rainstorm over the Sea (c.1824-28): a bruised plum cloud mass, grey rain curtains trailing to a pale horizon and a dark lead sea.
  (() => {
  const sky = skyField(["#35293a", "#6c5f70", "#b8aaae", "#d0c3bd"], [0, 0.35, 0.8, 1], 0.645);
  // A rain curtain: two slanted two-sided edges, dark cloud at the top fading to the horizon glow at the foot (ends equal on both sides, so they vanish).
  const curtain = (x, slant, width, shade) => {
    const out = sky.at(0.45), edge = (dx, east, west) => boundary(polylineNodes([[x + dx, 0.3], [x + dx + slant, 0.6]]), ["#3a2f44", east, sky.at(0.6)], ["#3a2f44", west, sky.at(0.6)]);
    return [edge(0, shade, out), edge(width, out, shade)];
  };
  return preset("rainstorm-sea", "Rainstorm at sea", "A bruised plum cloud trailing grey curtains of rain toward a pale horizon over a dark lead sea, after Constable's oil sketch.", [
    ...sky.rails,
    boundary(blobNodes({ cx: 0.42, cy: 0.15, rx: 0.36, ry: 0.11, harmonics: [[3, 0.14, 0.5], [2, 0.1, 2.0]], count: 6 }), ["#241b2a"], null, true),
    ...curtain(0.46, 0.05, 0.07, "#403648"),
    ...curtain(0.68, 0.06, 0.09, "#4a3f52"),
    boundary(polylineNodes([[0, 0.645], [1, 0.645]]), ["#d2c5bf"], ["#485660"]),
    boundary(polylineNodes([[0, 0.72], [0.5, 0.715], [1, 0.72]]), ["#485660"], ["#26323a"]),
    boundary(blobNodes({ cx: 0.4, cy: 0.68, rx: 0.2, ry: 0.012, count: 4 }), ["#8d9ba0"], null, true),
    floor(["#151b20"]),
  ]);
})(),
  // Friedrich's nocturnes: a cold moon high in a navy sky, silver mist lying in layered valleys, black spruces on the near ridge.
  (() => {
  const ridgeTop = 0.76;
  return preset("moonlit-mist", "Moonlit mist", "A cold moon in a navy sky over silver mist lying in layered valleys and black spruces on the nearest ridge, after Friedrich's nocturnes.", [
    ...skyField(["#111c3a", "#33507a", "#a3b7cc"], [0, 0.45, 1], 0.62).rails,
    ...glow(0.64, 0.2, 0.13, ["#fffbea", "#cdd9ec", "#243a66"]),
    ridge([0.54, 0.5, 0.54], ["#a3b7cc"], ["#8aa0bd"]),
    ridge([0.66, 0.63, 0.67], ["#8aa0bd"], ["#6a81a1"]),
    ridge([0.8, 0.77, 0.81], ["#6a81a1"], ["#22354f"]),
    crag([[0.06, 0.78], [0.1, 0.66], [0.14, 0.78]], ["#0c1720"], ["#6a81a1"]),
    crag([[0.14, 0.785], [0.19, 0.64], [0.24, 0.785]], ["#0c1720"], ["#6a81a1"]),
    crag([[0.25, 0.79], [0.28, 0.69], [0.31, 0.79]], ["#0c1720"], ["#6a81a1"]),
    floor(["#0a1216"]),
  ]);
})(),
  // Martin, The Destruction of Sodom and Gomorrah (1852): a white-hot firestorm swallowed by orange and blood-red smoke, black ground, one fork of lightning.
  (() => {
  const lump = (rx, ry, phase, harmonics, count) => blobNodes({ cx: 0.4, cy: 0.42, rx, ry, harmonics: harmonics.map(([k, a], i) => [k, a, phase + i]), count });
  return preset("sodom-firestorm", "Firestorm", "A white-hot core wrapped in rings of orange and blood-red smoke over a black plain, one fork of lightning at the edge, after John Martin.", [
    ...skyField(["#3a2424", "#5a2e28", "#221414"], [0, 0.6, 1]).rails,
    point(0.4, 0.42, "#fff6d0"),
    boundary(lump(0.07, 0.06, 0.4, [[2, 0.1]], 4), ["#ffd567"], null, true),
    boundary(lump(0.16, 0.13, 1.1, [[2, 0.15], [3, 0.1]], 6), ["#f08a2e"], null, true),
    boundary(lump(0.27, 0.22, 2.0, [[2, 0.18], [3, 0.12]], 6), ["#b03a22"], null, true),
    boundary(blobNodes({ cx: 0.8, cy: 0.14, rx: 0.16, ry: 0.09, harmonics: [[2, 0.2, 0.4]], count: 6 }), ["#2a1616"], null, true),
    point(0.8, 0.64, "#ffc060"),
    boundary(ellipseNodes(0.8, 0.64, 0.075, 0.05), ["#c4482a"], null, true),
    point(0.12, 0.6, "#f2a04a"),
    boundary(catmullRomNodes([[0, 0.78], [0.3, 0.74], [0.6, 0.79], [1, 0.75]]), ["#82402a"], ["#0f0808"]),
    floor(["#070404"]),
  ]);
})(),
  // Aivazovsky, The Rainbow (1873): pearl mist and lilac cloud over a green-glass gale, pale foam rolling diagonally up to the right.
  preset("pearl-gale", "Pearl gale", "Pearl-white mist with a lilac cloud breaking over green-glass swells and foam, after Aivazovsky's Rainbow.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#b1c4ce", "#dfe2e0", "#fcf4de"]),
  boundary(blobNodes({ cx: 0.4, cy: 0.17, rx: 0.2, ry: 0.07, harmonics: [[2, 0.15, 0.3]], count: 6 }), ["#b7a6c6"], null, true),
  boundary(catmullRomNodes([[0, 0.66], [0.4, 0.6], [0.72, 0.46], [1, 0.4]]), ["#b9cdd2", "#cfdedd", "#f3f0e2"], ["#3f7079", "#5f9a94", "#b4d0c8"]),
  boundary(catmullRomNodes([[0, 0.86], [0.4, 0.82], [0.75, 0.68], [1, 0.62]]), ["#3f7079", "#9fc4bc", "#dbe8e2"], ["#1e4450", "#2f5d66", "#5c918f"]),
  point(0.66, 0.3, "#fffbe8"),
  boundary(polylineNodes([[0, 1], [1, 1]]), ["#1e4450", "#2b5560", "#4f8684"]),
]),
  // Aivazovsky, Moonlit Night in Crimea (1853): a low gold moon on a navy sea, a black cypress, blue dusk.
  preset("crimean-moon", "Crimean moon", "A low gold moon laying a path on a navy sea under a black cypress and a deepening blue dusk, after Aivazovsky.", [
  ...skyField(["#16264a", "#2a4272", "#6f82a6"], [0, 0.6, 1], 0.6).rails,
  ...glow(0.42, 0.5, 0.075, ["#fff4c6", "#f3d27a", "#6f82a6"]),
  boundary(catmullRomNodes([[0, 0.6], [0.3, 0.59], [0.6, 0.6], [1, 0.59]]), ["#6f82a6"], ["#1d2f52"]),
  boundary(polylineNodes([[0.42, 0.63], [0.42, 0.9]]), ["#e8cc7c", "#7a7f8c", "#16243f"]),
  crag([[0.78, 0.585], [0.8, 0.4], [0.825, 0.2], [0.85, 0.4], [0.87, 0.585]], ["#0d1712"], ["#3f5582"]),
  floor(["#0a1324"]),
]),
  // Rossetti, Lady Lilith (1867): hair in rolling copper and gold waves over cream silk, an olive wall above, a navy fold below, red roses.
  (() => {
  const wave = (y0, phase, amp) => catmullRomNodes([0, 0.25, 0.5, 0.75, 1].map((x) => [x, y0 + amp * Math.sin(2 * Math.PI * (0.8 * x + phase))]));
  const thread = (y0, phase, amp, [a, , c], lit, shade) => boundary(wave(y0, phase, amp), [a, lit, c], [a, shade, c]);
  const band = (y0, phase, amp, above, below) => boundary(wave(y0, phase, amp), above, below);
  const WALL = ["#6f5e30", "#8a7a44", "#6f5e30"], UMBER = ["#8a4c1c", "#a85c22", "#7a3e14"], COPPER_R = ["#c67a2c", "#e09a42", "#b86a22"];
  const GOLD = ["#e9b658", "#ffe08a", "#d9a240"], RUST = ["#b8662a", "#d88a3a", "#a65820"], SILK = ["#ead9ba", "#fff4dc", "#ead9ba"];
  return preset("copper-tresses", "Copper tresses", "Rolling waves of copper and gold hair over cream silk under an olive wall, with two red roses, after Rossetti's Lady Lilith.", [
    band(0.2, 0.0, 0.07, WALL, UMBER),
    band(0.36, 0.08, 0.09, UMBER, COPPER_R),
    band(0.52, 0.16, 0.1, COPPER_R, GOLD),
    band(0.67, 0.24, 0.09, GOLD, RUST),
    band(0.82, 0.32, 0.07, RUST, SILK),
    thread(0.595, 0.2, 0.095, GOLD, "#fff0b0", "#c48a30"),
    thread(0.435, 0.12, 0.095, COPPER_R, "#f7c070", "#9a5a1c"),
    point(0.78, 0.92, "#c8262c"), point(0.9, 0.94, "#e0525a"),
  ]);
})(),
  // Turner, The Dark Rigi (1842): a blue mountain dissolving in a cream-gold sunrise, the lake mirroring both.
  preset("blue-rigi", "Blue Rigi", "A blue mountain dissolving into a cream-gold sunrise over a lake that mirrors the gold and the blue, after Turner's Rigi watercolours.", [
  ...skyField(["#e7d7a8", "#f0dc9c", "#d8c8a2"], [0, 0.5, 1], 0.58).rails,
  ...glow(0.82, 0.4, 0.11, ["#fff6d0", "#f6dd8a", "#ecd8a0"]),
  shape([[0.04, 0.57], [0.2, 0.44], [0.36, 0.3], [0.48, 0.34], [0.6, 0.46], [0.74, 0.55], [0.76, 0.57]], ["#5f7898", "#a6bbd0", "#5f7898"], ["#dcd0a8", "#dcd0a8", "#dcd0a8"]),
  boundary(polylineNodes([[0, 0.6], [1, 0.6]]), ["#d6c9a0"], ["#8fabb4"]),
  boundary(polylineNodes([[0.82, 0.62], [0.82, 0.92]]), ["#f0d888", "#b8b8a0", "#4a6878"]),
  boundary(blobNodes({ cx: 0.26, cy: 0.74, rx: 0.17, ry: 0.06, count: 4 }), ["#6a86a0"], null, true),
  floor(["#3e5a6c"]),
]),
  // Turner, Light and Colour (Goethe's Theory), the Morning after the Deluge (1843): a bubble of yellow-white light ringed in violet, orange and red, a dark mass sinking in it.
  preset("deluge-morning", "Deluge morning", "A bubble of yellow-white light ringed in violet, amber and oxblood with a dark mass sinking at its heart, after Turner's Morning after the Deluge.", [
  boundary(polylineNodes([[0, 0], [0, 1]]), ["#8a5422", "#9c6a2a", "#4a2123"]),
  boundary(blobNodes({ cx: 0.5, cy: 0.965, rx: 0.2, ry: 0.028, count: 4 }), ["#3a1a16"], null, true),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#7a4a1c", "#a3742c", "#4a2123"]),
  boundary(ellipseNodes(0.5, 0.48, 0.43, 0.42), ["#c4862e"], null, true),
  boundary(blobNodes({ cx: 0.5, cy: 0.48, rx: 0.35, ry: 0.34, harmonics: [[2, 0.06, 1.2], [3, 0.04, 0.3]], count: 8 }), ["#dccb52"], null, true),
  boundary(blobNodes({ cx: 0.5, cy: 0.48, rx: 0.27, ry: 0.26, harmonics: [[3, 0.05, 0.4]], count: 6 }), ["#eee9b8"], null, true),
  point(0.52, 0.38, "#fffbe4"),
  point(0.1, 0.12, "#8f86cf"), point(0.92, 0.82, "#8a82c8"), point(0.4, 0.3, "#f6f0c8"),
]),
  // Friedrich, Woman before the Setting Sun (c.1818): a smooth sky burning from ochre to butter-gold at the horizon over lilac-umber hills and a black foreground.
  preset("amber-evening", "Amber evening", "A smooth sky burning from deep ochre to butter-gold at the horizon over receding umber hills and a black foreground, after Friedrich's Woman before the Setting Sun.", [
  ...skyField(["#9c6428", "#c98234", "#ecd08c"], [0, 0.5, 1], 0.6).rails,
  point(0.5, 0.56, "#fff0c0"),
  ridge([0.6, 0.57, 0.61], ["#ecd08c"], ["#9a8660"]),
  ridge([0.68, 0.65, 0.7], ["#9a8660"], ["#6a5a42"]),
  ridge([0.77, 0.75, 0.79], ["#6a5a42"], ["#2a2415"]),
  floor(["#15120b"]),
]),
  // Aivazovsky, The Battle of Chesma (1848): a night sea torn open by red-orange fire, smoke and a pale moon above it.
  preset("chesma-night", "Chesma night", "Red-orange fire tearing a blue-black night, its glare broken across dark water under smoke and a pale moon, after Aivazovsky's Battle of Chesma.", [
  ...skyField(["#090d22", "#1c2040", "#3a2034"], [0, 0.5, 1], 0.68).rails,
  point(0.82, 0.13, "#eef0ff"),
  boundary(ellipseNodes(0.82, 0.13, 0.07, 0.055), ["#7e86b0"], null, true),
  point(0.44, 0.47, "#ffe08a"),
  boundary(ellipseNodes(0.44, 0.47, 0.08, 0.12), ["#ff9a3c"], null, true),
  boundary(ellipseNodes(0.44, 0.47, 0.16, 0.19), ["#c93a2a"], null, true),
  point(0.74, 0.58, "#ffd070"),
  boundary(ellipseNodes(0.74, 0.58, 0.07, 0.07), ["#e8632c"], null, true),
  boundary(polylineNodes([[0, 0.69], [0.5, 0.685], [1, 0.69]]), ["#3a2034"], ["#1a1830"]),
  boundary(polylineNodes([[0.45, 0.72], [0.45, 0.95]]), ["#e0602c", "#7a2a28", "#0a0a16"]),
  floor(["#06060e"]),
]),
  // Aivazovsky, The Bay of Naples by Moonlight (1842): a silver moon and a glowing Vesuvius, each laying its own path on a dark bay.
  preset("naples-moonlight", "Naples moonlight", "A silver moon and a smouldering volcano under a navy sky, each laying its own path of light on the dark bay, after Aivazovsky.", [
  ...skyField(["#0f1838", "#2a3f78", "#6a7fa8"], [0, 0.55, 1], 0.62).rails,
  ...glow(0.24, 0.2, 0.11, ["#ffffff", "#d8e2f6", "#2a3f78"]),
  boundary(blobNodes({ cx: 0.74, cy: 0.16, rx: 0.14, ry: 0.07, harmonics: [[2, 0.2, 0.6]], count: 5 }), ["#4a3a52"], null, true),
  crag([[0.46, 0.605], [0.6, 0.55], [0.7, 0.44], [0.73, 0.4], [0.76, 0.42], [0.79, 0.395], [0.84, 0.45], [0.92, 0.55], [0.99, 0.605]], ["#14131c"], ["#5a6a98"]),
  point(0.76, 0.37, "#ffb050"),
  boundary(polylineNodes([[0, 0.62], [0.5, 0.615], [1, 0.62]]), ["#6a7fa8"], ["#1a2850"]),
  boundary(polylineNodes([[0.24, 0.64], [0.24, 0.94]]), ["#d8e2f6", "#7a8ab0", "#0d1430"]),
  boundary(polylineNodes([[0.76, 0.64], [0.76, 0.88]]), ["#e0702c", "#6a2a28", "#0d1430"]),
  floor(["#070b1e"]),
]),
];
