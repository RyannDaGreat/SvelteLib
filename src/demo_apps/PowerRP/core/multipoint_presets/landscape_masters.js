/**
 * "Landscape painting" — native Multipoint presets. Church, Friedrich, Inness, Harris, O'Keeffe, Parrish, luminism, Carmichael and wet-on-wet mountain scenes.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { catmullRomNodes } from "../multipoint_shapes.js";
import { withStopOffsets } from "./nature.js";
import { dup, rail, skyField, ridge, streak, horizonNodes, bandRails, mass, railFromSky, jagged, rock, moundNodes } from "./landscape_helpers.js";

export const PRESETS = [
  (() => {
    const H = 0.62, sky = skyField(["#35393a", "#7c2b20", "#c4512a", "#e8b64c"], [0, 0.42, 0.8, 1], H);
    const bar = (y0, y1, hot) => streak([[0.3, y0], [0.6, (y0 + y1) / 2 - 0.02], [1, y1]], [sky.at(y0), hot, sky.at(y1)]);
    return preset("twilight-wilderness", "Twilight wilderness", "Church's Twilight in the Wilderness: a sky of torn crimson cloud over a burning yellow horizon, a dark ridge and a lake holding the red, framed by black forest.", [
      railFromSky(sky, 1, 0, 0.5), railFromSky(sky, 0, 0, 0.4), bar(0.08, 0.2, "#2a2024"), bar(0.2, 0.34, "#e04a26"), bar(0.36, 0.44, "#3a2424"), bar(0.46, 0.52, "#f58a3a"),
      streak([[0.06, 0.2], [0.16, 0.14], [0.26, 0.1]], [sky.at(0.2), "#4a7e80", sky.at(0.1)]),
      ridge([H, H - 0.03, H - 0.01, H + 0.005, H], ["#e8b64c"], ["#3a3f38"], 0.24, 0.93),
      streak([[0.3, 0.93], [0.9, 0.93]], ["#1c150e"]),
      streak([[0.3, 0.74], [0.6, 0.77], [0.9, 0.74]], ["#3a3f38", "#a04a2c", "#3a3f38"]),
      mass([[1, 0.92], [0.94, 0.85], [0.93, 0.72], [0.96, 0.64], [1, 0.58]], [], dup("#15160e", 3), ["#6a3a2a", "#3a2a20", "#6a3a2a"]),
      mass([[0, 0.42], [0.1, 0.52], [0.18, 0.62], [0.25, 0.78], [0.2, 1]], [[0, 1]], dup("#15160e", 3), ["#a0482a", "#3a2a20", "#a0482a"]),
    ]);
  })(),
  (() => {
    const H = 0.6, sky = skyField(["#3f4f66", "#8a92a0", "#e8c79a", "#f5dfb0"], [0, 0.4, 0.85, 1], H);
    return preset("moonrise-sea", "Moonrise over the sea", "Friedrich's Moonrise over the Sea: a peach horizon glowing under a slate dusk, a pale disc, dark water carrying one silver path and a black rock.", [
      ...sky.rails, ...glow(0.62, 0.44, 0.13, ["#fff8e0", "#f8e3b0", "#ecc890"]),
      streak([[0.08, 0.3], [0.3, 0.26], [0.44, 0.34]], [sky.at(0.3), "#56647a", sky.at(0.34)]),
      streak([[0.78, 0.2], [0.88, 0.17], [0.97, 0.22]], [sky.at(0.2), "#56647a", sky.at(0.22)]),
      boundary(catmullRomNodes([[0, H], [0.5, H + 0.002], [1, H]]), ["#f5dfb0"], ["#8e8064"]),
      ...bandRails(["#6e6658", "#2a4254", "#17222b"], H + 0.02, 1, [0, 0.3, 1]),
      streak([[0.62, 0.63], [0.62, 0.95]], ["#fbeac0", "#d6bf90", "#7a7866", "#1c2a34"]),
      mass([[0, 0.74], [0.08, 0.78], [0.16, 0.86], [0.2, 1]], [[0, 1]], dup("#0d1216", 3), ["#46535e", "#1a2228", "#46535e"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#9a7028", "#e8b858", "#f0c870"], [0, 0.7, 1], 0.4);
    return preset("tonal-dusk", "Tonal dusk", "Inness's tonalism: a low amber dusk dissolving three receding tree-lines into haze, each band a little darker and closer, one gleam of pond at their feet.", [
      ...sky.rails,
      ridge([0.52, 0.46, 0.5, 0.42, 0.49, 0.47, 0.41, 0.48, 0.5, 0.45], ["#f0c870"], ["#a08238"]),
      ridge([0.63, 0.55, 0.6, 0.52, 0.6, 0.56, 0.5, 0.58, 0.61, 0.55], ["#7a6228"], ["#4e3c16"]),
      ridge([0.76, 0.7, 0.75, 0.66, 0.74, 0.69, 0.64, 0.73], ["#3e300e"], ["#1e1606"]),
      streak([[0.2, 0.9], [0.5, 0.91], [0.8, 0.9]], ["#2a200a", "#b89038", "#2a200a"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#2c3c4e", "#4a6074", "#8ca5b6"], [0, 0.55, 1], 1);
    return preset("faceted-peak", "Faceted peak", "Lawren Harris's mountains: one smooth-planed peak cut from a cold blue dusk, a dark shadow face, a white lit crest and a pale ice ledge, all edges crisp.", [
      ...sky.rails, streak([[0.03, 0.33], [0.16, 0.3], [0.28, 0.35]], [sky.at(0.33), "#62788a", sky.at(0.35)]), streak([[0.72, 0.28], [0.85, 0.25], [0.97, 0.3]], [sky.at(0.28), "#62788a", sky.at(0.3)]),
      withStopOffsets(jagged([[0, 0.72], [0.2, 0.6], [0.38, 0.36], [0.5, 0.12], [0.62, 0.34], [0.75, 0.52], [0.9, 0.66], [1, 0.7]], dup("#8ca5b6", 4), ["#2b3947", "#2b3947", "#eef2f2", "#eef2f2"]), [0, 0.49, 0.51, 1]),
      jagged([[0.495, 0.15], [0.47, 0.4], [0.44, 0.56], [0.36, 0.86]], ["#eef2f2"], ["#2b3947"]),
      jagged([[0.47, 0.52], [0.6, 0.48], [0.72, 0.58], [0.85, 0.61]], ["#eef2f2"], ["#8ea2b1"]),
      jagged([[0, 0.9], [0.3, 0.88], [0.6, 0.92], [1, 0.9]], ["#2b3947", "#2b3947", "#8ea2b1", "#8ea2b1"], ["#e2eaee", "#e2eaee", "#e2eaee", "#e2eaee"]),
    ]);
  })(),
  (() => {
    const T = 0.5, flip = (ys) => ys.map((y) => 2 * T - y), line = (ys, above, below) => boundary(horizonNodes(ys), [above], [below]);
    // x = 0, 1/4, 1/2, 3/4, 1 ; reflection below the shore mirrors every height about T and swaps above/below.
    const S = [0.0, 0.05, 0.03, 0.09, 0.1], P = [0.02, 0.11, 0.17, 0.2, 0.3], G = [0.03, 0.18, 0.33, 0.43, 0.46];
    return preset("lake-reflection", "Lake reflection", "O'Keeffe's Lake George: teal-green, rose and lilac hills cut in soft pillows under a blue sky, doubled in a dark band of still water with their colours cooled.", [
      line(S, "#5a7cd0", "#9a72c8"), line(P, "#9a72c8", "#e0506a"), line(G, "#e0506a", "#1f7a66"),
      boundary(horizonNodes([T, T, T, T]), ["#e8c8d0"], ["#16262c"]),
      line(flip(G), "#2a8a7a", "#c85a86"), line(flip(P), "#c85a86", "#8a6cc0"), line(flip(S), "#8a6cc0", "#7a9ad8"),
    ]);
  })(),
  (() => {
    const line = (ys, above, below) => boundary(horizonNodes(ys), [above], [below]);
    return preset("desert-streak", "Desert streak", "O'Keeffe's abstracted Southwest: a lemon sky over one shaded rose cloud, a charcoal ridge, then a deep red plain rolling in yellow, orange and coral waves, each band graded between its two edges.", [
      line([0.2, 0.12, 0.24, 0.14, 0.2], "#d6d24c", "#f4e0e2"), line([0.38, 0.27, 0.42, 0.3, 0.36], "#cc7c9e", "#e8c8ee"),
      line([0.5, 0.44, 0.52, 0.42, 0.48], "#b0a8d0", "#2c2c30"), line([0.6, 0.58, 0.54, 0.6, 0.56], "#46464e", "#8a1c14"),
      line([0.72, 0.64, 0.78, 0.66, 0.74], "#560a06", "#f0b838"), line([0.84, 0.78, 0.9, 0.8, 0.86], "#c86a1c", "#8c2a1a"),
      line([0.97, 0.92, 0.98, 0.93, 0.97], "#d85a3a", "#f6d0c4"),
    ]);
  })(),
  (() => {
    return preset("cobalt-daybreak", "Cobalt daybreak", "Maxfield Parrish's blues: a saturated ultramarine sky, gold-lit cumulus, violet peaks touched with peach and a deep blue lake under dark banks edged in light.", [
      rail(0, 0, 0.5, ["#0e2a88", "#2a62d0", "#78b0ea"]), rail(1, 0, 0.5, ["#0e2a88", "#2a62d0", "#78b0ea"]),
      boundary(moundNodes(0.4, [0.1, 0.15, 0.09, 0.13], 0.6), ["#5c9ce4"], ["#fff0c6"]),
      boundary(catmullRomNodes([[0, 0.5], [0.33, 0.47], [0.66, 0.52], [1, 0.48]]), ["#b4a4e0"], ["#9cbcec"]),
      jagged([[0, 0.66], [0.14, 0.6], [0.24, 0.64], [0.4, 0.54], [0.5, 0.62], [0.66, 0.57], [0.8, 0.64], [1, 0.6]], dup("#9cbcec", 3), ["#4a3eaa", "#e8a08c", "#4a3eaa"]),
      ...bandRails(["#5a52b0", "#20308a", "#0c1650"], 0.7, 1, [0, 0.35, 1]),
      mass([[0, 0.84], [0.14, 0.86], [0.3, 1]], [[0, 1]], dup("#0a0e30", 3), ["#f0b84a", "#2a2a70", "#f0b84a"]),
      mass([[0.66, 1], [0.84, 0.9], [1, 0.88]], [[1, 1]], dup("#0a0e30", 3), ["#f0b84a", "#2a2a70", "#f0b84a"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#6f94cc", "#c8d6ec", "#f2e2cc"], [0, 0.5, 1], 0.6), pine = "#0e2a1c";
    return preset("alpine-lake-mist", "Alpine lake, wet on wet", "A soft-blended mountain scene: a cloud-streaked dawn, a violet range with two snow peaks, a mirror lake and dark evergreens on either shore.", [
      ...sky.rails,
      withStopOffsets(jagged([[0, 0.62], [0.14, 0.5], [0.3, 0.36], [0.46, 0.56], [0.62, 0.48], [0.8, 0.44], [1, 0.58]], dup("#f2e2cc", 4), ["#3a4888", "#3a4888", "#dfe6f6", "#c6cfee"]), [0, 0.31, 0.33, 1]),
      jagged([[0.3, 0.385], [0.315, 0.52], [0.33, 0.66]], ["#dfe6f6"], ["#3a4888"]),
      streak([[0.2, 0.7], [0.5, 0.71], [0.8, 0.7]], ["#8c92c4", "#e6ecfa", "#8c92c4"]),
      ...bandRails(["#56609c", "#2e3c70", "#141c3c"], 0.74, 1, [0, 0.35, 1]),
      rock([[0.05, 1], [0.09, 0.86], [0.075, 0.84], [0.105, 0.74], [0.09, 0.72], [0.12, 0.58], [0.15, 0.72], [0.135, 0.74], [0.165, 0.84], [0.15, 0.86], [0.19, 1]], [], [pine, "#245a3a", pine], ["#6c7aa8", "#3c4c80", "#6c7aa8"]),
      rock([[0.84, 1], [0.875, 0.66], [0.91, 1]], [], dup(pine, 3), ["#6c7aa8", "#3c4c80", "#6c7aa8"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#9cb4c8", "#ecd8b0", "#f8e6bc"], [0, 0.6, 1], 0.5);
    return preset("luminist-calm", "Luminist calm", "Kensett and Lane's luminism: a windless golden hour, a pale sky with two slate clouds, a hazy blue shore doubled in glass-still water, and a dark rock edged with light.", [
      ...sky.rails, streak([[0.05, 0.22], [0.3, 0.19], [0.55, 0.23]], [sky.at(0.22), "#a4a8b4", sky.at(0.23)]), streak([[0.5, 0.36], [0.75, 0.33], [0.97, 0.37]], [sky.at(0.36), "#b0b0b8", sky.at(0.37)]),
      boundary(catmullRomNodes([[0, 0.5], [0.25, 0.47], [0.5, 0.49], [0.78, 0.45], [1, 0.49]]), ["#f8e6bc"], ["#607088"]),
      boundary(catmullRomNodes([[0, 0.535], [0.5, 0.54], [1, 0.535]]), ["#607088"], ["#eed6a4"]),
      boundary(catmullRomNodes([[0, 0.61], [0.25, 0.64], [0.5, 0.62], [0.78, 0.66], [1, 0.62]]), ["#eed6a4"], ["#56647c"]),
      ...bandRails(["#56647c", "#8a9ab0", "#3e4e68"], 0.68, 1, [0, 0.4, 1]),
      mass([[0, 0.8], [0.12, 0.82], [0.22, 0.92], [0.28, 1]], [[0, 1]], dup("#1e1c18", 3), ["#e8c070", "#6a6a7a", "#e8c070"]),
      mass([[0.78, 1], [0.88, 0.94], [1, 0.92]], [[1, 1]], dup("#1e1c18", 3), ["#e8c070", "#6a6a7a", "#e8c070"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#2a3b4e", "#6c8498", "#e0d8b8"], [0, 0.6, 1], 0.82);
    return preset("sea-of-ice", "Sea of ice", "Friedrich's Sea of Ice: a wrecked pyramid of pale blue slabs against a heavy slate sky and a thin yellow horizon, every fracture a clean line between light and shadow faces.", [
      ...sky.rails,
      jagged([[0.5, 0.27], [0.46, 0.5], [0.52, 0.66], [0.44, 0.9]], ["#eef4f6"], ["#5d7790"]),
      jagged([[0.55, 0.46], [0.6, 0.66], [0.68, 0.9]], ["#5d7790"], ["#eef4f6"]),
      jagged([[0.3, 0.62], [0.26, 0.76], [0.2, 0.9]], ["#eef4f6"], ["#7d95a9"]),
      rock([[0, 0.93], [0.1, 0.78], [0.18, 0.8], [0.3, 0.55], [0.38, 0.6], [0.5, 0.2], [0.56, 0.42], [0.68, 0.5], [0.78, 0.68], [1, 0.88]], [[1, 1], [0, 1]].slice(0, 2), ["#e2ecf0", "#9ab0c2", "#e2ecf0"], ["#6c8498", "#d8d4bc", "#6c8498"]),
    ]);
  })(),
  (() => {
    const chalk = ["#f6f2e6", "#d6cdbc", "#f6f2e6"];
    return preset("chalk-cliffs", "Chalk cliffs", "Friedrich's Chalk Cliffs on Rügen: two pale chalk headlands pinched against a turquoise sea and a white-blue sky, framed by a dark green arch of beech boughs.", [
      boundary(catmullRomNodes([[0.3, 0.4], [0.5, 0.405], [0.7, 0.4]]), ["#d6e8f4"], ["#2f74b4"]),
      streak([[0.35, 0.92], [0.65, 0.92]], ["#1e4678"]), point(0.56, 0.52, "#f8f6ee"),
      mass([[0, 0.42], [0.1, 0.4], [0.18, 0.5], [0.26, 0.62], [0.22, 0.76], [0.3, 0.88], [0.27, 1]], [[0, 1]], chalk, ["#7ab0d8", "#2f74b4", "#7ab0d8"]),
      mass([[0.75, 1], [0.7, 0.86], [0.74, 0.72], [0.8, 0.58], [0.88, 0.5], [1, 0.46]], [[1, 1]], chalk, ["#7ab0d8", "#2f74b4", "#7ab0d8"]),
      mass([[1, 0.12], [0.82, 0.2], [0.6, 0.12], [0.38, 0.19], [0.16, 0.12], [0, 0.22]], [[0, 0], [1, 0]], ["#16341a", "#3a6a2c", "#16341a"], ["#7aa4d4", "#c8def0", "#7aa4d4"]),
    ]);
  })(),
  (() => {
    const hill = (ys, above, below) => boundary(horizonNodes(ys), [above], [below]), sky = ["#86b2d2", "#dce8ec"];
    return preset("cloche-hills", "Autumn hills", "Carmichael's La Cloche: great rounded hills stepping from blue haze through violet, rust and burning orange to a dark olive foreground, each dome a soft shoulder against the next.", [
      rail(0, 0, 0.3, sky), rail(1, 0, 0.3, sky),
      hill([0.42, 0.3, 0.2, 0.3, 0.37, 0.34, 0.4], "#dce8ec", "#6c8fb0"), hill([0.54, 0.44, 0.36, 0.43, 0.47, 0.42, 0.5], "#a8bccc", "#6a5c98"),
      hill([0.68, 0.6, 0.5, 0.57, 0.62, 0.54, 0.64], "#9a80b0", "#9c3c26"), hill([0.8, 0.74, 0.66, 0.73, 0.75, 0.68, 0.78], "#d8682c", "#e08a2c"),
      hill([0.93, 0.88, 0.8, 0.88, 0.9, 0.85, 0.92], "#f0b040", "#3c3a16"),
    ]);
  })(),
];
