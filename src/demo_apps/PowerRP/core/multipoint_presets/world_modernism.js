/**
 * "World modernism" — native Multipoint presets. Tarsila, Kahlo, Rivera, Lam, Raza, Anatsui, Adnan, Zao Wou-Ki and Chu Teh-Chun.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { polylineNodes, ellipseNodes } from "../multipoint_shapes.js";
import { leafNodes } from "./art_homages.js";
import { cornered, brushStroke, smooth, loop, facet, boxEdge, boxFrame, shadedCell, seg, bandStack } from "./world_modernism_helpers.js";

const same = (c, n) => Array(n).fill(c);

const CLOTH = [
  [[[0.04, 0.04], [0.36, 0.05], [0.35, 0.33], [0.05, 0.34]], "#f0cf6a", "#a9761f"],
  [[[0.39, 0.05], [0.64, 0.04], [0.66, 0.3], [0.38, 0.33]], "#dfe1e4", "#8d9299"],
  [[[0.67, 0.04], [0.96, 0.05], [0.95, 0.36], [0.69, 0.31]], "#d0382b", "#7d1a14"],
  [[[0.05, 0.37], [0.3, 0.36], [0.31, 0.66], [0.04, 0.67]], "#d98c5a", "#8a4422"],
  [[[0.34, 0.36], [0.7, 0.35], [0.69, 0.64], [0.35, 0.67]], "#f4d878", "#b98a2c"],
  [[[0.73, 0.4], [0.96, 0.39], [0.95, 0.68], [0.72, 0.67]], "#4a3a34", "#15100d"],
  [[[0.04, 0.7], [0.36, 0.7], [0.37, 0.96], [0.05, 0.95]], "#e6e8ea", "#9a9fa6"],
  [[[0.4, 0.7], [0.66, 0.71], [0.65, 0.96], [0.4, 0.96]], "#d0382b", "#8a1e16"],
  [[[0.7, 0.72], [0.96, 0.71], [0.95, 0.96], [0.69, 0.95]], "#f0cf6a", "#b07a22"],
];

const sky = "#7aa6d6";

export const PRESETS = [
  // Tarsila, the Antropofagia / Pau-Brasil years: rolling morros in "caipira" pink, canary, singing green and blue.
  preset("tarsila-morros", "Tarsila morros", "Rolling hills in caipira violet-pink, canary, leaf green and river blue under a cobalt sky with a low sun.", [
    boxEdge("top", ["#2a5fb8"]),
    boxEdge("bottom", ["#e9603a"]),
    ...bandStack([
      smooth([[0, 0.38], [0.25, 0.28], [0.6, 0.42], [1, 0.3]]),
      smooth([[0, 0.5], [0.35, 0.56], [0.7, 0.46], [1, 0.52]]),
      smooth([[0, 0.66], [0.3, 0.6], [0.7, 0.68], [1, 0.62]]),
      smooth([[0, 0.78], [0.4, 0.83], [0.75, 0.76], [1, 0.8]]),
      smooth([[0, 0.92], [0.35, 0.88], [0.7, 0.93], [1, 0.9]]),
    ], ["#3a78cc", { a: "#dc5ca0", b: "#a93a7c" }, { a: "#fbe25a", b: "#e6b82c" }, { a: "#52b85c", b: "#278a3c" }, { a: "#46a8e6", b: "#1f74c0" }, "#e9603a"]),
    boundary(ellipseNodes(0.22, 0.17, 0.09), ["#3a78cc"], ["#f7e04a"], true),
  ]),
  // Frida Kahlo, the thorn-necklace period: banana-leaf jungle in near-black viridian with a single red bloom.
  preset("kahlo-leaf-jungle", "Kahlo leaf jungle", "Overlapping banana leaves in viridian, bottle and moss green, with one crimson bloom.", [
    boxEdge("top", ["#071a11"]), boxEdge("bottom", ["#1a5035"]),
    boxEdge("right", ["#071a11", "#1a5035"]), boxEdge("left", ["#1a5035", "#071a11"]),
    boundary(leafNodes(0.07, 0.92, 0.2, 0.1, 0.16), ["#0d2c1c", "#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#2f7a48", "#64b064", "#1b5a36", "#2f7a48"], true),
    boundary(leafNodes(0.34, 0.94, 0.29, 0.52, 0.09), ["#0d2c1c", "#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#1f6a45", "#4d9a5a", "#124a30", "#1f6a45"], true),
    boundary(leafNodes(0.57, 0.97, 0.52, 0.04, 0.25), ["#0d2c1c", "#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#3c8a4e", "#8cc070", "#226a3e", "#3c8a4e"], true),
    boundary(leafNodes(0.8, 0.92, 0.88, 0.14, 0.19), ["#0d2c1c", "#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#1d5f3e", "#4f9a58", "#10412b", "#1d5f3e"], true),
    boundary(leafNodes(0.96, 0.96, 0.96, 0.6, 0.07), ["#0d2c1c", "#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#2d7a4a", "#5aa860", "#184c30", "#2d7a4a"], true),
    boundary(ellipseNodes(0.33, 0.2, 0.06), ["#0d2c1c", "#0d2c1c", "#0d2c1c"], ["#e8304e", "#8d1234", "#e8304e"], true),
    point(0.33, 0.2, "#f6d25c"),
  ]),
  // Diego Rivera, Flower Day / calla-lily pictures: monumental white spathes and dark leaves against warm ochre earth.
  preset("rivera-calla-lilies", "Rivera calla lilies", "Two monumental white calla spathes with golden hearts and dark blade leaves, on warm ochre earth.", [
    boxEdge("top", ["#d09a54"]),
    boxEdge("bottom", ["#a04d2a"]),
    boxEdge("right", ["#d09a54", "#a04d2a"]),
    boxEdge("left", ["#a04d2a", "#d09a54"]),
    boundary(leafNodes(0.05, 0.9, 0.08, 0.36, 0.07), same("#b8703c", 4), ["#2f6a3c", "#4f8a4c", "#1d4a2c", "#2f6a3c"], true),
    boundary(cornered([[0.36, 0.9], [0.19, 0.62], [0.22, 0.32], [0.4, 0.06], [0.5, 0.34], [0.54, 0.62]], [0, 3]), same("#b8703c", 4), ["#fffaf0", "#ddd2bc", "#b8a6b4", "#fffaf0"], true),
    boundary(cornered([[0.75, 0.94], [0.64, 0.72], [0.66, 0.5], [0.75, 0.3], [0.82, 0.5], [0.84, 0.72]], [0, 3]), same("#b8703c", 4), ["#fffaf0", "#d8ccb6", "#a898b0", "#fffaf0"], true),
    boundary(leafNodes(0.94, 0.94, 0.95, 0.16, 0.07), same("#b8703c", 4), ["#2a603a", "#4a8448", "#1a4228", "#2a603a"], true),
    point(0.37, 0.4, "#e8b23a"),
    point(0.75, 0.56, "#e8b23a"),
  ]),
  // Wifredo Lam, La Jungla (1943): a cane-brake of tall stems in olive, moss, ochre and umber, with a pale moon-yellow gap.
  preset("lam-jungla", "Lam jungle", "Tall cane stems in olive, moss, ochre and umber, pierced by a pale moon-yellow gap.", [
    ...bandStack([
      smooth([[0.1, 1], [0.14, 0.66], [0.08, 0.3], [0.12, 0]]),
      smooth([[0.24, 1], [0.2, 0.7], [0.27, 0.34], [0.23, 0]]),
      smooth([[0.34, 1], [0.38, 0.6], [0.32, 0.3], [0.36, 0]]),
      smooth([[0.5, 1], [0.46, 0.62], [0.54, 0.3], [0.49, 0]]),
      smooth([[0.6, 1], [0.64, 0.66], [0.58, 0.34], [0.63, 0]]),
      smooth([[0.76, 1], [0.72, 0.6], [0.78, 0.28], [0.74, 0]]),
      smooth([[0.88, 1], [0.91, 0.64], [0.86, 0.3], [0.9, 0]]),
    ], [
      ["#1f2412", "#3a4420", "#1f2412"], ["#56662c", "#8a9a44", "#56662c"], ["#b88a2c", "#e0b84a", "#a8761e"], ["#2a1a10", "#46301a", "#2a1a10"],
      ["#e9dc92", "#f4eaa8", "#cfc070"], ["#7e8c3e", "#a8ae52", "#6c7c34"], ["#3a2514", "#6a4220", "#3a2514"], ["#182010", "#2c3618", "#182010"],
    ]),
  ]),
  // S. H. Raza, the bindu paintings (1980s on): a black point of concentration ringed by flame colours over saffron and earth bands.
  preset("raza-bindu", "Raza bindu", "A black bindu ringed in gold, orange and vermilion over saffron, with bands of madder red and dark earth below.", [
    boxEdge("top", ["#ec9c2e"]),
    boxEdge("bottom", ["#2e1a12"]),
    ...bandStack([
      smooth([[0, 0.7], [0.35, 0.69], [0.7, 0.71], [1, 0.7]]),
      smooth([[0, 0.84], [0.35, 0.83], [0.7, 0.85], [1, 0.84]]),
    ], [{ a: "#f0a832", b: "#dc8a26" }, { a: "#c23a22", b: "#9a2a1a" }, { a: "#5a2f1c", b: "#2e1a12" }]),
    boundary(ellipseNodes(0.5, 0.38, 0.29), ["#e89828"], ["#c63a20", "#a92c1a", "#c63a20"].slice(0, 1), true),
    boundary(ellipseNodes(0.5, 0.38, 0.22), ["#c63a20"], ["#f2a42c"], true),
    boundary(ellipseNodes(0.5, 0.38, 0.15), ["#f2a42c"], ["#fbd66a"], true),
    boundary(ellipseNodes(0.5, 0.38, 0.1), ["#fbd66a"], ["#15100e"], true),
  ]),
  // El Anatsui, Man's Cloth (ref anatsui_mans_cloth.jpg): bottle-top metal cloth — gold, silver, copper, red and black panels stitched with dark seams.
  preset("anatsui-metal-cloth", "Anatsui metal cloth", "Gold, silver, copper, red and black metal panels draped together, each with its own shimmer and dark seams.", [
    boxFrame(["#17100d"]),
    ...CLOTH.map(([quad, light, dark]) => shadedCell(polylineNodes(quad), [light, dark], "#17100d")),
  ]),
  // Etel Adnan, the small Mount Tamalpais paintings: palette-knife slabs of cobalt, violet, green and lemon under a vermilion sun.
  preset("adnan-tamalpais", "Adnan Tamalpais", "Flat palette-knife slabs of cobalt sky, violet mountain, green slope and lemon foreground under a vermilion sun.", [
    boxEdge("top", ["#2a62cc"]),
    boxEdge("bottom", ["#f4d648"]),
    ...bandStack([
      seg([0, 0.52], [1, 0.45]),
      seg([0, 0.66], [1, 0.7]),
      seg([0, 0.82], [1, 0.76]),
    ], [{ a: "#2a62cc", b: "#7fc0ee" }, "#6b4fb4", "#3fa566", "#f4d648"]),
    boundary(ellipseNodes(0.3, 0.24, 0.12), ["#6aa8e6"], ["#e8402a"], true),
    facet([[0.5, 0.64], [0.72, 0.53], [0.9, 0.56], [0.78, 0.64]], "#ee6fa0", "#6b4fb4"),
  ]),
  // Zao Wou-Ki, the 1950s-70s lyrical abstractions (refs zao_stcosme.jpg): light breaking through indigo and aquamarine atmosphere.
  preset("zao-breaking-light", "Zao breaking light", "Pale gold light opening through aquamarine and deep indigo atmosphere, crossed by one dark ink stroke.", [
    boxFrame(["#16263f"]),
    boundary(loop([[0.22, 0.42], [0.46, 0.16], [0.78, 0.3], [0.84, 0.62], [0.6, 0.86], [0.3, 0.74]]), ["#3f7f94"], null, true),
    boundary(loop([[0.34, 0.46], [0.48, 0.3], [0.68, 0.38], [0.7, 0.58], [0.52, 0.7], [0.38, 0.62]]), ["#b9d6c8"], null, true),
    boundary(loop([[0.44, 0.48], [0.52, 0.42], [0.6, 0.48], [0.54, 0.56]]), ["#f6e7b4"], null, true),
    point(0.52, 0.49, "#fff6d6"),
    boundary(brushStroke([[0.07, 0.92], [0.1, 0.78], [0.12, 0.64], [0.13, 0.46]], [0.004, 0.024, 0.016, 0.004]), ["#27507a"], ["#0b1424"], true),
    point(0.78, 0.76, "#c8623a"),
  ]),
  // Chu Teh-Chun, the 1970s-80s lyrical "Neige" / Sevres-porcelain pictures (ref chu_sevres.jpg): white and cerulean strokes thrown across deep ultramarine.
  preset("chu-ultramarine-strokes", "Chu ultramarine strokes", "Leaning white, cerulean and one ember stroke thrown across a deep ultramarine field.", [
    boxEdge("top", ["#0c1d52"]),
    boxEdge("bottom", ["#10338a"]),
    boxEdge("right", ["#0c1d52", "#10338a"]),
    boxEdge("left", ["#10338a", "#0c1d52"]),
    boundary(brushStroke([[0.1, 0.92], [0.16, 0.66], [0.24, 0.4], [0.3, 0.1]], [0.004, 0.03, 0.026, 0.004]), ["#153a9a"], ["#f4f7fb"], true),
    boundary(brushStroke([[0.36, 0.94], [0.42, 0.7], [0.5, 0.44], [0.54, 0.14]], [0.004, 0.024, 0.02, 0.004]), ["#153a9a"], ["#5fb4ea"], true),
    boundary(brushStroke([[0.62, 0.9], [0.68, 0.66], [0.74, 0.4], [0.78, 0.1]], [0.004, 0.034, 0.028, 0.004]), ["#153a9a"], ["#e9f0f8"], true),
    boundary(brushStroke([[0.86, 0.92], [0.88, 0.76], [0.9, 0.58], [0.93, 0.42]], [0.004, 0.018, 0.014, 0.004]), ["#153a9a"], ["#f07a2a"], true),
  ]),
  // El Anatsui, Gravity and Grace / Earth's Skin: a draped cloth of gold, silver, red and black strips, each fold catching light differently.
  preset("anatsui-gold-drape", "Anatsui gold drape", "Horizontal strips of burnished gold, silver, oxblood and black folding over one another like a hung metal cloth.", [
    ...bandStack([
      smooth([[0, 0.1], [0.3, 0.15], [0.65, 0.07], [1, 0.12]]),
      smooth([[0, 0.22], [0.3, 0.3], [0.65, 0.2], [1, 0.27]]),
      smooth([[0, 0.36], [0.3, 0.42], [0.65, 0.35], [1, 0.4]]),
      smooth([[0, 0.5], [0.3, 0.57], [0.65, 0.47], [1, 0.55]]),
      smooth([[0, 0.66], [0.3, 0.72], [0.65, 0.62], [1, 0.7]]),
      smooth([[0, 0.78], [0.3, 0.85], [0.65, 0.76], [1, 0.82]]),
      smooth([[0, 0.9], [0.3, 0.94], [0.65, 0.89], [1, 0.93]]),
    ], [
      "#1a1210", { a: "#f3d277", b: "#b4801f" }, "#7c1a16", { a: "#e3e5e8", b: "#8d939b" },
      { a: "#d9a645", b: "#8a5a18" }, "#1f1512", { a: "#c93326", b: "#7c1a16" }, { a: "#f0cc6c", b: "#a87420" },
    ]),
  ]),
  // Zao Wou-Ki, the warm 1950s-60s canvases: ember light from deep umber, with a cool blue-grey counterweight and black gestures.
  preset("zao-ember-depths", "Zao ember depths", "An ember glow of rust, orange and pale gold rising out of umber, with a cool slate counterweight and dark gestures.", [
    boxFrame(["#2a1810"]),
    boundary(loop([[0.42, 0.52], [0.64, 0.3], [0.88, 0.5], [0.84, 0.78], [0.56, 0.9], [0.36, 0.74]]), ["#a8482a"], null, true),
    boundary(loop([[0.54, 0.56], [0.66, 0.44], [0.78, 0.56], [0.72, 0.72], [0.58, 0.72]]), ["#eba042"], null, true),
    boundary(loop([[0.62, 0.58], [0.68, 0.53], [0.73, 0.6], [0.66, 0.66]]), ["#fbe6a6"], null, true),
    boundary(loop([[0.1, 0.16], [0.26, 0.08], [0.36, 0.22], [0.22, 0.32]]), ["#6f8aa0"], null, true),
    point(0.22, 0.2, "#c9d6de"),
    boundary(brushStroke([[0.06, 0.92], [0.12, 0.74], [0.2, 0.6], [0.3, 0.5]], [0.004, 0.022, 0.016, 0.004]), ["#3c2416"], ["#0a0605"], true),
    boundary(brushStroke([[0.48, 0.12], [0.6, 0.1], [0.74, 0.14], [0.9, 0.12]], [0.004, 0.018, 0.014, 0.004]), ["#3c2416"], ["#0a0605"], true),
  ]),
  // Chu Teh-Chun, the porcelain and "Neige" pictures (ref chu_sevres.jpg): cobalt and cerulean pooled into white like glaze on a Sevres vase.
  preset("chu-glaze-pools", "Chu glaze pools", "Cobalt and cerulean glaze pooling into white porcelain, with one navy drip of ink.", [
    boxFrame(["#f3f6fa"]),
    boundary(loop([[0.14, 0.56], [0.3, 0.34], [0.54, 0.4], [0.6, 0.66], [0.4, 0.86], [0.2, 0.78]]), ["#2b5fc2"], null, true),
    boundary(loop([[0.28, 0.58], [0.38, 0.48], [0.48, 0.56], [0.44, 0.7], [0.32, 0.7]]), ["#8cbcec"], null, true),
    boundary(loop([[0.66, 0.2], [0.8, 0.12], [0.9, 0.26], [0.78, 0.36]]), ["#173e96"], null, true),
    boundary(loop([[0.7, 0.62], [0.84, 0.56], [0.92, 0.72], [0.78, 0.86]]), ["#57a6dc"], null, true),
  ]),
];
