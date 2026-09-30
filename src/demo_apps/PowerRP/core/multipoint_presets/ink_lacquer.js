/**
 * "Ink, lacquer & gold" — native Multipoint presets. Song and Ming ink landscapes, sumi-e washes, Rinpa gold, maki-e and red lacquer, kintsugi and Goryeo celadon.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes, rectNodes } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { boxEdge, atOffsets, ribbonNodes } from "./retro_eras.js";
import { ridge, frame, fieldAt, fieldFrame, inkMass, zigzagRibbon } from "./ink_lacquer_helpers.js";

const MIPAPER = [[0, "#e6dfca"], [0.45, "#ddd7c3"], [1, "#b8b8a8"]];

/**
 * Pure function. A wide, soft hump as six clockwise anchors: crown, right shoulder, base, base, left shoulder, upper left.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} w - Half width.
 * @param {number} h - Half height.
 * @returns {number[][]} [6,2] anchors, clockwise on screen, crown first.
 * @example dome(0.5, 0.5, 0.2, 0.1).length // 6
 */
function dome(cx, cy, w, h) {
  return [[cx, cy - h], [cx + 0.95 * w, cy + 0.1 * h], [cx + 0.35 * w, cy + 0.6 * h], [cx - 0.35 * w, cy + 0.6 * h], [cx - 0.95 * w, cy + 0.1 * h], [cx - 0.55 * w, cy - 0.65 * h]];
}

const MAPALE = ["#d7cca6", "#cbbf99", "#bdb08b"];

const MAFIELD = [[0, "#d7cca6"], [0.5, "#cbbf99"], [1, "#bdb08b"]];

const MAINK = "#22231a";

const WANGSILK = [[0, "#8f7a43"], [0.3, "#b09a55"], [0.6, "#9a8848"], [0.8, "#8c7e48"], [1, "#2c5f5d"]];

const SUMIPAPER = ["#f3eee0", "#ebe5d4", "#e0dac6"];

/**
 * Pure function. Anchors along a circle arc (screen angles, clockwise), for the enso stroke.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Radius.
 * @param {number[]} angles - Screen angles in radians.
 * @returns {number[][]} [N,2] points.
 * @example arcPoints(0.5, 0.5, 0.25, [0, Math.PI / 2]).map((p) => p.map((v) => +v.toFixed(2))) // [[0.75,0.5],[0.5,0.75]]
 */
function arcPoints(cx, cy, r, angles) {
  return angles.map((a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
}

const ENSO_PTS = arcPoints(0.46, 0.5, 0.3, [-2.3, -1.3, -0.3, 0.7, 1.7, 2.7, 3.6]);

const GOLDTOP = ["#d9ad68", "#ecc981"];

const RIVER = ["#3a2c30", "#24202c", "#1a161f"];

const ROIRO = [[0, "#0b070a"], [0.5, "#1c130c"], [1, "#33250f"]];

const NASHIJI = [[0, "#6b3d12"], [0.5, "#a8651e"], [1, "#7a4514"]];

const RAKU = [[0, "#1d2126"], [0.5, "#2b3138"], [1, "#16191d"]];

const GOLDSEAM = ["#7a5a1e", "#f3cc66", "#b8892c", "#7a5a1e"];

const CELADON = [[0, "#bdd6c3"], [0.35, "#a4c5b0"], [0.8, "#86ab98"], [1, "#6c8f7c"]];

/**
 * Pure function. A thin concentric ring (a band of inlay) as two nested crisp circles centred at the box centre.
 * @param {number} r - Outer radius.
 * @param {number} t - Band thickness.
 * @param {string} glaze - Colour outside and inside the band.
 * @param {string} inlay - Band colour.
 * @returns {object[]} Two closed two-sided features (8 nodes).
 * @example ring(0.3, 0.02, "#888888", "#ffffff").length // 2
 */
function ring(r, t, glaze, inlay) {
  const flat = Array(glaze.length).fill(inlay);
  return [boundary(ellipseNodes(0.5, 0.5, r), glaze, flat, true), boundary(ellipseNodes(0.5, 0.5, r - t), flat, glaze, true)];
}

const RAIN = [[0, "#ebe9df"], [0.5, "#d3d5cb"], [1, "#22292a"]];

const NIGHTINK = [[0, "#1e2325"], [0.5, "#353b3b"], [1, "#2a2f30"]];

export const PRESETS = [
  // Mi Fu and Mi Youren, "cloudy mountains": wet horizontal ink humps floating in pale mist, darkest nearest.
  preset("cloudy-mountains", "Cloudy mountains", "Mi Fu's cloudy mountains: rows of wet ink humps afloat in pale rice-paper mist, each fading at the base into the cloud below it.", [
      ...fieldFrame(MIPAPER),
      ...[[0.32, 0.27, 0.27, 0.085, "#a9aca2", "#c4c6bb"], [0.80, 0.22, 0.16, 0.06, "#b6b9ae", "#cdcfc4"],
        [0.66, 0.5, 0.3, 0.1, "#6b7166", "#9da197"], [0.2, 0.56, 0.18, 0.07, "#7d8378", "#aeb1a5"],
        [0.4, 0.8, 0.36, 0.1, "#2a302b", "#575d54"]].map(([cx, cy, w, h, top, right]) =>
        inkMass(dome(cx, cy, w, h), MIPAPER, { rightIdx: 1, baseIdx: 2, top, right, base: fieldAt(MIPAPER, cy + 0.6 * h) })),
    ]),
  // Ma Yuan, Viewing the Waterfall (c.1200): the one-corner composition — a dark crag and pine branch in the corners, vast empty mist.
  preset("one-corner-mist", "One-corner mist", "Ma Yuan's one-corner composition: a dark crag and a pine canopy hold two corners of pale silk and leave the rest as mist.", [
      boxEdge("top", [MAINK], 0, 0.42), boxEdge("top", [MAPALE[0]], 0.42, 1), boxEdge("right", MAPALE),
      boxEdge("left", [MAINK], 0, 0.3), boxEdge("left", [MAPALE[0], MAPALE[1]], 0.3, 0.5), boxEdge("left", [MAINK], 0.5, 1),
      boxEdge("bottom", [MAINK], 0, 0.46), boxEdge("bottom", [MAPALE[2]], 0.46, 1),
      boundary(catmullRomNodes([[0, 0.5], [0.12, 0.54], [0.22, 0.64], [0.32, 0.72], [0.37, 0.86], [0.46, 1]]), [MAPALE[1], MAPALE[1], MAPALE[2]], [MAINK, "#34342a", MAINK]),
      boundary(catmullRomNodes([[0, 0.3], [0.06, 0.26], [0.1, 0.3], [0.16, 0.2], [0.22, 0.24], [0.27, 0.12], [0.34, 0.15], [0.37, 0.05], [0.42, 0]]), [MAINK], [MAPALE[0]]),
      inkMass(dome(0.76, 0.66, 0.22, 0.07), MAFIELD, { rightIdx: 1, baseIdx: 2, top: "#a09c82", right: "#b2ad92", base: fieldAt(MAFIELD, 0.7) }),
    ]),
  // Wang Ximeng, A Thousand Li of Rivers and Mountains (1113): mineral azurite and malachite peaks with rust ochre on olive silk.
  preset("blue-green-peaks", "Blue-green peaks", "Wang Ximeng's blue-green landscape: azurite and malachite peaks with rust-ochre shoulders rising from mist on olive silk above a jade river.", [
      ...fieldFrame(WANGSILK),
      inkMass([[0.42, 0.1], [0.48, 0.24], [0.56, 0.2], [0.63, 0.32], [0.66, 0.46], [0.72, 0.66], [0.3, 0.68], [0.28, 0.48], [0.35, 0.3]], WANGSILK,
        { rightIdx: 4, baseIdx: 6, top: "#1f4f95", right: "#3d8b63", base: fieldAt(WANGSILK, 0.68), sharp: true }),
      inkMass([[0.14, 0.38], [0.2, 0.46], [0.26, 0.42], [0.3, 0.68], [0.04, 0.7], [0.08, 0.5]], WANGSILK,
        { rightIdx: 2, baseIdx: 4, top: "#3a78a8", right: "#4c9a6c", base: fieldAt(WANGSILK, 0.7), sharp: true }),
      inkMass([[0.8, 0.3], [0.86, 0.4], [0.9, 0.36], [0.96, 0.68], [0.7, 0.7], [0.74, 0.48]], WANGSILK,
        { rightIdx: 3, baseIdx: 4, top: "#b0673a", right: "#4f8f5f", base: fieldAt(WANGSILK, 0.7), sharp: true }),
      ridge(0.82, [[6, 0.012, 1], [14, 0.008, 0.3]], [fieldAt(WANGSILK, 0.82)], ["#3f7a78"], 6),
    ]),
  // Sumi-e wet-on-wet (tarashikomi/bokashi): ink dropped into a damp sheet blooms outward in nested, feathered greys.
  preset("wet-ink-bloom", "Wet ink bloom", "Sumi-e wet-on-wet: ink dropped on damp rice paper blooms into nested feathered greys with a black heart and a smaller echo.", [
      ...frame(SUMIPAPER[0], SUMIPAPER[2], SUMIPAPER),
      boundary(blobNodes({ cx: 0.44, cy: 0.46, rx: 0.3, ry: 0.27, harmonics: [[2, 0.12, 0.6], [3, 0.1, 2.1]], count: 8 }), ["#ccc9bd"], null, true),
      boundary(blobNodes({ cx: 0.42, cy: 0.48, rx: 0.17, ry: 0.15, harmonics: [[2, 0.14, 1.2], [3, 0.1, 0.4]], count: 6 }), ["#7d817c"], null, true),
      boundary(blobNodes({ cx: 0.4, cy: 0.5, rx: 0.07, ry: 0.06, harmonics: [[2, 0.2, 0.3]], count: 4 }), ["#1d2020"], null, true),
      boundary(blobNodes({ cx: 0.79, cy: 0.77, rx: 0.12, ry: 0.1, harmonics: [[3, 0.14, 0.9]], count: 5 }), ["#b9b9ae"], null, true),
      boundary(blobNodes({ cx: 0.78, cy: 0.78, rx: 0.045, ry: 0.04, harmonics: [[2, 0.2, 0.3]], count: 4 }), ["#4a4e4b"], null, true),
    ]),
  // Zen enso: one breath, one brushstroke; thick wet start, dry thinning tail, open gap, and a vermilion seal.
  preset("enso-seal", "Enso and seal", "A zen enso: one ink brushstroke ring, heavy where the brush landed and thinning to a dry tail, with a vermilion seal on warm paper.", [
      ...frame(SUMIPAPER[0], SUMIPAPER[2], SUMIPAPER),
      boundary(ribbonNodes(ENSO_PTS, [0.05, 0.074, 0.066, 0.054, 0.042, 0.026, 0]), ["#ece6d6"], ["#1b1b1c"], true),
      boundary(rectNodes(0.76, 0.76, 0.86, 0.88), ["#e6dfcc"], ["#b8342a"], true),
    ]),
  // Ogata Korin, Red and White Plum Blossoms (Edo, 18th c.): gold-leaf ground, a dark stylised river of swirling currents, plum branch.
  preset("plum-river-gold", "Plum and river", "Kōrin's Red and White Plum Blossoms: burnished gold leaf under a blossoming branch, cut by a sweeping river of indigo-black swirls.", [
      boundary(polylineNodes([[0, 0.86], [0, 0], [1, 0], [1, 0.1]]), ["#d3a45f", "#d9ae6a", "#e9c47a", "#ecc981"]),
      boundary(polylineNodes([[1, 0.1], [1, 1], [0, 1], [0, 0.86]]), [RIVER[2], RIVER[2], RIVER[2], RIVER[2]]),
      boundary(catmullRomNodes([[0, 0.86], [0.2, 0.83], [0.4, 0.72], [0.56, 0.45], [0.74, 0.26], [1, 0.1]]),
        ["#d3a45f", "#d9ae6a", "#e2b872", "#ecc981"], [RIVER[0], RIVER[1], "#2a2230", RIVER[2]]),
      boundary(ribbonNodes([[0.5, 0.92], [0.62, 0.78], [0.78, 0.7], [0.92, 0.72]], [0.012, 0.028, 0.02, 0]), [RIVER[1]], ["#8a6a48"], true),
      boundary(ribbonNodes([[0.04, 0.06], [0.12, 0.24], [0.26, 0.36], [0.42, 0.3]], [0.05, 0.04, 0.028, 0]), [GOLDTOP[0]], ["#2e2326"], true),
      ...[[0.2, 0.14], [0.32, 0.3]].map(([cx, cy]) => boundary(ellipseNodes(cx, cy, 0.019), ["#dcae68"], ["#c2413a"], true)),
      point(0.42, 0.14, "#f6dc98"),
    ]),
  // Ming-Qing ink-wash ranges: serrated grey crags stacked back into rain-mist, each ridge darker and lower than the last.
  preset("rain-crag-ranges", "Rain crag ranges", "Serrated ink-wash crags stacked into rain mist: four ridges from pale ghost peaks to near black, each dissolving at its foot.", [
      ...fieldFrame(RAIN),
      boundary(polylineNodes([[0, 0.36], [0.14, 0.3], [0.26, 0.17], [0.36, 0.3], [0.52, 0.24], [0.68, 0.11], [0.8, 0.26], [1, 0.3]]), ["#ebe9df"], ["#c4c7be"]),
      boundary(polylineNodes([[0, 0.5], [0.12, 0.42], [0.3, 0.35], [0.44, 0.46], [0.6, 0.4], [0.78, 0.31], [0.9, 0.42], [1, 0.44]]), ["#d9dbd1"], ["#949990"]),
      boundary(polylineNodes([[0, 0.68], [0.16, 0.6], [0.34, 0.52], [0.5, 0.64], [0.72, 0.56], [1, 0.6]]), ["#b7bbb2"], ["#596059"]),
      ridge(0.82, [[5, 0.03, 0.4], [13, 0.012, 1.3]], ["#8b908a"], ["#1f2526"], 6),
    ]),
  // Ink moon over a dark wash: a pale disc with a breathing halo above black ridges.
  preset("ink-moonrise", "Ink moonrise", "Sumi-e moonlight: a pale disc in a feathered halo over a charcoal ink-wash night, black ridges cutting across the foot.", [
      ...fieldFrame(NIGHTINK),
      boundary(blobNodes({ cx: 0.6, cy: 0.38, rx: 0.3, ry: 0.28, harmonics: [[2, 0.08, 0.4], [3, 0.05, 1.3]], count: 6 }), ["#9a9d96"], null, true),
      boundary(ellipseNodes(0.6, 0.38, 0.13), ["#b3b5ac"], ["#f3f1e6"], true),
      boundary(polylineNodes([[0, 0.84], [0.14, 0.78], [0.26, 0.72], [0.38, 0.8], [0.5, 0.86], [0.7, 0.8], [0.86, 0.74], [1, 0.8]]), [fieldAt(NIGHTINK, 0.8)], ["#0b0e0f"]),
    ]),
  // Maki-e on black lacquer: a moonlit pond drawn as concentric gold ripples, thinner and dimmer as they travel out.
  preset("maki-e-ripples", "Maki-e ripples", "Maki-e pond: concentric gold-powder ripples widening across black lacquer, each ring thinner and dimmer than the last, under a pale silver moon.", [
      ...fieldFrame(ROIRO),
      ...[[0.34, 0.03, "#f0c860"], [0.22, 0.022, "#d6a845"], [0.11, 0.016, "#a8812f"]].flatMap(([rx, t, gold]) => {
        const flat = Array(3).fill(gold), bg = Array(3).fill(fieldAt(ROIRO, 0.6));
        return [boundary(ellipseNodes(0.5, 0.66, rx, rx * 0.42), bg, flat, true), boundary(ellipseNodes(0.5, 0.66, rx - t, rx * 0.42 - t * 0.42), flat, bg, true)];
      }),
      boundary(ellipseNodes(0.72, 0.2, 0.06), Array(3).fill(fieldAt(ROIRO, 0.2)), ["#e9e7e2", "#8c8c96", "#e9e7e2"], true),
    ]),
  // Shunkei-style red lacquer tray: black-lacquered rim, a fine gold line, then vermilion shading from a lit upper left to a deep lower right.
  preset("red-lacquer-tray", "Red lacquer tray", "A vermilion lacquer tray seen from above: a black rim, a hairline of gold powder, and a mirror-polished red well lit from the upper left.", [
      boundary(rectNodes(0, 0, 1, 1), ["#170b0a"], null, true),
      boundary(ellipseNodes(0.5, 0.5, 0.46), Array(4).fill("#170b0a"), ["#7a1810", "#5c0f0a", "#b8301c", "#7a1810"], true),
      boundary(ellipseNodes(0.5, 0.5, 0.42), ["#7a1810", "#5c0f0a", "#b8301c", "#7a1810"], Array(4).fill("#e8bd55"), true),
      boundary(ellipseNodes(0.5, 0.5, 0.405), Array(4).fill("#e8bd55"), ["#b8301c", "#8e1e12", "#e0502f", "#b8301c"], true),
      boundary(blobNodes({ cx: 0.36, cy: 0.33, rx: 0.13, ry: 0.06, harmonics: [[2, 0.2, 0.5]], count: 4 }), ["#f07a55"], null, true),
    ]),
  // Rinpa waves (Sotatsu / Korin tradition): a gold-leaf sky over a stylised sea of repeating combed wave-crests, cream foam on deepening blue-green.
  preset("rinpa-wave-gold", "Rinpa waves", "Rinpa's stylised sea: a burnished gold-leaf sky over rows of repeating wave crests, cream foam riding ever deeper blue-green.", [
      boxEdge("top", ["#d9ad68"]), boxEdge("bottom", ["#143c4a"]),
      ...["left", "right"].map((side) => atOffsets(boxEdge(side, ["#d9ad68", "#e8c57c", "#7fb0ab", "#143c4a"]), [0, 0.295, 0.305, 1])),
      boundary(polylineNodes([[0, 0.3], [1, 0.3]]), ["#e8c57c"], ["#7fb0ab"]),
      ...[[0.47, "#dfe6cd", "#4c8e93"], [0.64, "#b5d2bd", "#2a6f7e"], [0.81, "#7fb0a3", "#173f4f"]].map(([y, foam, deep], i) =>
        ridge(y, [[11.5, 0.03, i * 1.3], [5.5, 0.012, i]], [foam], [deep], 7)),
    ]),
  // Maki-e on black roiro lacquer (Edo inro): gold-powder sprinkled grasses, each blade heavier at the root, under a silver moon.
  preset("maki-e-reeds", "Maki-e reeds", "Edo maki-e: gold-powder reed blades fanning up from the foot of deep black roiro lacquer, a silver moon and sparks of gold dust above.", [
      ...fieldFrame(ROIRO),
      ...[[[0.14, 0.95], [0.1, 0.62], [0.15, 0.3]], [[0.23, 0.95], [0.23, 0.6], [0.36, 0.2]], [[0.32, 0.95], [0.38, 0.6], [0.54, 0.36]],
        [[0.42, 0.95], [0.52, 0.72], [0.74, 0.52]], [[0.54, 0.95], [0.7, 0.82], [0.92, 0.76]]].map((pts) =>
        boundary(ribbonNodes(pts, [0, 0.03, 0]), Array(3).fill(fieldAt(ROIRO, pts[1][1])), ["#7a5a1e", "#f3cc66", "#7a5a1e"], true)),
      boundary(ellipseNodes(0.78, 0.2, 0.075), Array(3).fill(fieldAt(ROIRO, 0.2)), ["#e9e7e2", "#8c8c96", "#e9e7e2"], true),
      point(0.4, 0.14, "#b8892c"), point(0.9, 0.5, "#b8892c"),
    ]),
  // Nashiji (pear-skin) ground: flat gold flakes sprinkled into amber lacquer and polished — a warm translucent brown speckled with gold.
  preset("nashiji-pear-skin", "Nashiji pear skin", "Nashiji lacquer: amber-brown translucent lacquer glowing from within, sprinkled with soft flecks of gold powder.", [
      ...fieldFrame(NASHIJI),
      ...[[0.2, 0.2, "#f2c766"], [0.64, 0.12, "#e0a94a"], [0.4, 0.4, "#f6d27a"], [0.84, 0.3, "#e8b758"], [0.14, 0.56, "#d9a040"],
        [0.66, 0.6, "#f2c766"], [0.36, 0.8, "#e0a94a"], [0.88, 0.86, "#f6d27a"]].map(([x, y, c]) => point(x, y, c)),
    ]),
  // Kintsugi: a black raku bowl mended with urushi and gold powder; the repair is the ornament.
  preset("kintsugi-black", "Kintsugi black", "Kintsugi on a black raku bowl: three jagged gold-powder seams, fat where the lacquer pooled and hair-thin where it ran out.", [
      ...fieldFrame(RAKU),
      boundary(zigzagRibbon([[0.1, 0.1], [0.26, 0.2], [0.3, 0.36], [0.46, 0.44], [0.5, 0.62], [0.68, 0.72], [0.9, 0.9]], [0, 0.016, 0.03, 0.022, 0.03, 0.02, 0]), Array(4).fill(fieldAt(RAKU, 0.5)), GOLDSEAM, true),
      boundary(zigzagRibbon([[0.9, 0.12], [0.78, 0.22], [0.74, 0.4], [0.84, 0.52]], [0, 0.02, 0.014, 0]), Array(4).fill(fieldAt(RAKU, 0.3)), GOLDSEAM, true),
      boundary(zigzagRibbon([[0.12, 0.68], [0.24, 0.76], [0.2, 0.9]], [0, 0.016, 0]), Array(4).fill(fieldAt(RAKU, 0.8)), GOLDSEAM, true),
      point(0.3, 0.16, "#59616b"),
    ]),
  // Goryeo celadon, bisaek ("kingfisher colour"): a cool jade glaze, glassy window highlight, dark pooling at the foot.
  preset("celadon-bisaek", "Celadon bisaek", "Goryeo celadon glaze: the cool jade-blue bisaek, a glassy window highlight, glaze pooling deeper toward the foot.", [
      ...fieldFrame(CELADON),
      boundary(blobNodes({ cx: 0.34, cy: 0.4, rx: 0.045, ry: 0.22, harmonics: [[2, 0.08, 0.4]], count: 4 }), ["#e9f4ea"], null, true),
      boundary(blobNodes({ cx: 0.46, cy: 0.3, rx: 0.02, ry: 0.06, harmonics: [], count: 4 }), ["#dcece0"], null, true),
      ridge(0.84, [[5, 0.012, 0.6], [11, 0.008, 1.9]], [fieldAt(CELADON, 0.84)], ["#4d7463"], 6),
    ]),
];
