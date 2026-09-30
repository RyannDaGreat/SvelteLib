/**
 * "Old masters light" — native Multipoint presets. Candlelight, Venetian skies and glazes, Titian drapery, Tiepolo's oculus and Danaë's gold shower.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { blobNodes } from "./art_homages.js";
import { sideRails } from "./minerals_phenomena.js";
import { boxFrame, slopedWaveNodes } from "./wallpapers_ui.js";
import { horizon, horizontalRails, softGlow } from "./grand_manner_helpers.js";

const ring = (cx, cy, rx, ry) => ellipseNodes(cx, cy, rx, ry);

const organic = (harmonics) => (cx, cy, rx, ry) => blobNodes({ cx, cy, rx, ry, harmonics, count: 6 });

const edge = (from, to, colors) => boundary(polylineNodes([from, to]), colors);

const TOP = ([0, 0]), TR = [1, 0], BR = [1, 1], BL = [0, 1];

export const PRESETS = [
  // Georges de La Tour, St Joseph the Carpenter / The Newborn: a hand screening the flame glows red.
  preset("candle-hand", "Candle through the hand", "A hand shielding a candle, its flesh gone translucent orange-red against a black room.", [
  boxFrame(["#090403"]),
  boundary(ellipseNodes(0.5, 0.5, 0.45, 0.43), ["#1d0b06"], null, true),
  boundary(ellipseNodes(0.5, 0.5, 0.33, 0.35), ["#8a2c10"], null, true),
  boundary(ellipseNodes(0.5, 0.5, 0.17, 0.2), ["#f0602a"], null, true),
  point(0.5, 0.52, "#ffe28a"),
]),
  // La Tour, The Newborn: a monochrome of red and orange, the swaddled child the one pale thing in it.
  preset("newborn-warmth", "Newborn warmth", "A pale swaddled bundle glowing in a lap of vermilion cloth, everything else sinking into oxblood.", [
  boxFrame(["#150b08"]),
  boundary(ellipseNodes(0.56, 0.62, 0.42, 0.34), ["#2a120a"], null, true),
  boundary(ellipseNodes(0.58, 0.68, 0.3, 0.22), ["#b03a18"], null, true),
  ...softGlow(0.42, 0.64, 0.11, 0.08, ["#fff0d0", "#f0c890", "#b03a18"], ring),
  ...softGlow(0.2, 0.28, 0.12, 0.15, ["#f0b890", "#8a4a2c", "#1a0d08"], ring),
]),
  // Titian's glazed reds: layered vermilion and madder folds, a gold sheen along each crest.
  preset("titian-drapery", "Titian drapery", "Layered folds of glazed vermilion and madder velvet, a warm gold sheen along each crest.",
  [[0.16, 0.24, 0.3], [0.38, 0.5, 1.4], [0.6, 0.72, 2.4], [0.82, 0.9, 3.4]].map(([y0, y1, phase]) => boundary(
    slopedWaveNodes({ x0: 0, x1: 1, y0, y1, amplitude: 0.06, cycles: 0.75, phase }),
    ["#3e0a10", "#5a1016", "#4a0c12", "#3a0a10"], ["#a3201e", "#e8563a", "#f0a05a", "#b8281e"]))),
  // Titian, Bacchus and Ariadne: lapis sky paling toward a sea horizon, white clouds, olive hills.
  preset("venetian-sky", "Venetian lapis", "Titian's lapis sky paling to turquoise at the horizon over blue mountains and dark olive hills, white clouds sailing in it.", [
  ...sideRails(["#1a44a0", "#3b74c8", "#b4d4ea"], 0.6),
  horizon([0.6, 0.58, 0.6], ["#b4d4ea"], ["#6b8ba0"]),
  horizon([0.68, 0.64, 0.67], ["#6b8ba0"], ["#3c4a2a"]),
  horizon([0.82, 0.78, 0.8], ["#3c4a2a"], ["#241f12"]),
  edge(BR, BL, ["#1c170e"]),
  ...softGlow(0.3, 0.24, 0.22, 0.08, ["#ffffff", "#eaf1f9", "#3a6cbc"], organic([[3, 0.12, 0.6]])),
  ...softGlow(0.72, 0.42, 0.18, 0.06, ["#ffffff", "#eaf1f9", "#7aa4d8"], ring),
]),
  // Leonardo's sfumato: ridge behind ridge dissolving into blue-green haze, no edge drawn hard.
  preset("sfumato-distance", "Sfumato distance", "Ridge behind smoky ridge in blue-green haze above olive slopes sinking to umber, Leonardo's dissolved edges.", [
  ...sideRails(["#8ea296", "#c9cbb6"], 0.42),
  horizon([0.42, 0.38, 0.44, 0.4], ["#c9cbb6"], ["#9fb4aa"]),
  horizon([0.58, 0.54, 0.6, 0.56], ["#b8c4b0"], ["#7c8a5a"]),
  horizon([0.76, 0.72, 0.78, 0.74], ["#8a7a48"], ["#3a2c16"]),
  edge(BR, BL, ["#1c140c"]),
  point(0.32, 0.66, "#d9c47c"),
]),
  // Tiepolo's ceiling skies: a glory of peach and rose cloud opening onto blue, ringed by a dark cornice.
  preset("tiepolo-oculus", "Tiepolo sky", "Tiepolo's ceiling heaven: pale blue above, peach and rose cloud banks glowing gold from beneath.", [
  ...sideRails(["#7fa8dc", "#c9d4ea", "#f6d2bc", "#e0a58a"], 1),
  horizon([0.36, 0.3, 0.38, 0.32], ["#c9d4ea"], ["#fbe6d2"]),
  horizon([0.6, 0.66, 0.58, 0.64], ["#f6d2bc"], ["#e8a894"]),
  horizon([0.84, 0.8, 0.86, 0.82], ["#e0a58a"], ["#8a5a4a"]),
  edge(BR, BL, ["#5a3a2e"]),
  ...softGlow(0.66, 0.46, 0.2, 0.07, ["#fff0c0", "#f8dca0", "#f2c8a8"], ring),
]),
  // Rembrandt, Danae: a golden interior light against a crimson curtain and umber shadow.
  preset("danae-gold", "Danae gold", "A golden interior glowing amber and cream against a dark crimson curtain, umber shadow above and below.", [
  ...horizontalRails(["#2a1610", "#3a2414", "#4a3418", "#6a4a20"], ["#1a0e08", "#2a1a0e", "#3a2814", "#4a3418"]),
  boundary(catmullRomNodes([[0.14, 0], [0.1, 0.3], [0.16, 0.62], [0.12, 1]]), ["#a02a22"], ["#2a0608"]),
  boundary(catmullRomNodes([[0.26, 0], [0.22, 0.3], [0.28, 0.62], [0.24, 1]]), ["#9a2a20"], ["#4a0e10"]),
  ...softGlow(0.64, 0.52, 0.31, 0.3, ["#fff0b0", "#e8b050", "#4a2a12"], ring),
]),
];
