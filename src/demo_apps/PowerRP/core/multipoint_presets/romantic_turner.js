/**
 * "Romantic & sublime" — native Multipoint presets. Turner's snowstorm and Norham dawn, Friedrich's fog and dusk, Martin's pandemonium, the Ninth Wave and Pre-Raphaelite drapery.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes, spiralNodes } from "../multipoint_shapes.js";
import { sideRails } from "./minerals_phenomena.js";
import { boxFrame, slopedWaveNodes, archNodes } from "./wallpapers_ui.js";
import { horizon, verticalRails, softGlow } from "./grand_manner_helpers.js";

const ring = (cx, cy, rx, ry) => ellipseNodes(cx, cy, rx, ry);

const edge = (from, to, colors) => boundary(polylineNodes([from, to]), colors);

const TOP = ([0, 0]), TR = [1, 0], BR = [1, 1], BL = [0, 1];

export const PRESETS = [
  // Turner, Snow Storm - Steam-Boat off a Harbour's Mouth: a sea and sky wound into one vortex.
  preset("snowstorm-vortex", "Snowstorm vortex", "Sea and sky wound into one grey-green vortex, dark and pale arms turning about a luminous eye.", [
  boxFrame(["#566464"]),
  ...[0, Math.PI].map((phase) => boundary(spiralNodes({ cx: 0.5, cy: 0.46, startRadius: 0.05, endRadius: 0.44, turns: 1, phase }),
    phase ? ["#d6ceb8", "#c8c2a8", "#b0b09c"] : ["#3a4644", "#2a2c2a", "#20221f"],
    phase ? ["#26282a", "#3a3c38", "#4a4c46"] : ["#a9a596", "#d0c8b0", "#e8e0c8"])),
  point(0.5, 0.46, "#f6f0dc"),
]),
  // Friedrich, Moonrise over the Sea / Women on the Beach: violet cloud, one gold seam at the horizon, dark red rocks.
  preset("friedrich-dusk", "Friedrich dusk", "Layered violet cloud over one gold seam of horizon light, a dim sea and dark rust-brown rocks.", [
  ...sideRails(["#423942", "#6b6080", "#a08880", "#f0b466"], 0.56),
  horizon([0.56, 0.56, 0.57], ["#f0b466"], ["#5a5470"]),
  horizon([0.78, 0.74, 0.79, 0.76], ["#4a4668"], ["#241810"]),
  edge(BR, BL, ["#160e09"]),
  ...softGlow(0.42, 0.54, 0.12, 0.04, ["#fff0c0", "#f8d080", "#e6b060"], ring),
]),
  // Friedrich, Wanderer above the Sea of Fog: pale blue-lilac fog banks, a dark rock at the foot.
  preset("fog-wanderer", "Sea of fog", "Banks of pale blue-white fog with a far peak above them and a black rock at the foot, after the Wanderer.", [
  ...sideRails(["#bac4d9", "#ccd2e5"], 0.42),
  horizon([0.42, 0.38, 0.43], ["#ccd2e5"], ["#9aa4b8"]),
  horizon([0.56, 0.52, 0.58, 0.54], ["#c8cee0"], ["#eef0f6"]),
  horizon([0.68, 0.66, 0.7, 0.68], ["#eef0f6"], ["#8c94a6"]),
  horizon([0.82, 0.78, 0.83], ["#6a7080"], ["#18161c"]),
  edge(BR, BL, ["#0f0d12"]),
]),
  // John Martin, The Great Day of His Wrath: a red furnace glow between falling black-teal rock faces.
  preset("day-of-wrath", "Day of wrath", "A red-orange furnace glow between black-teal rock faces under a cold, luminous cloud.", [
  edge(TOP, TR, ["#9ba9aa", "#c4bcbd", "#7d8991"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#0d242a"]),
  boundary(catmullRomNodes([[0, 0.35], [0.2, 0.42], [0.34, 0.62], [0.28, 1]]), ["#a8b4b4", "#b96a4a", "#8a5a4a"], ["#0f2c34", "#0f2c34", "#0f2c34"]),
  boundary(catmullRomNodes([[1, 0.3], [0.85, 0.4], [0.72, 0.62], [0.78, 1]]), ["#0f2c34", "#0f2c34", "#0f2c34"], ["#a8b4b4", "#b96a4a", "#8a5a4a"]),
  ...softGlow(0.52, 0.66, 0.2, 0.14, ["#fff0a0", "#f0602a", "#3a3030"], ring),
]),
  // Martin, Pandemonium: nested black arches around a furnace hall.
  preset("pandemonium-hall", "Pandemonium hall", "Nested black arches opening onto a white-hot furnace hall, a molten red floor at their feet.", [
  boxFrame(["#1c0f08"]),
  ...[[0.42, 0.6, "#2a140a", "#5a2a10"], [0.3, 0.44, "#5a2a10", "#a04a14"], [0.18, 0.28, "#a04a14", "#f0c060"]].map(([rx, ry, outside, inside]) =>
    boundary(archNodes({ cx: 0.5, base: 0.82, rx, ry }), [outside, outside, outside], [inside, inside, inside])),
  point(0.5, 0.7, "#fff0b0"),
  horizon([0.88, 0.86, 0.9, 0.88], ["#f08a30"], ["#7a2a0c"]),
  edge(BR, BL, ["#2a0e06"]),
]),
  // Aivazovsky, The Ninth Wave: a blazing amber sky over a translucent green wave.
  preset("ninth-wave", "Ninth wave", "A blazing amber-and-orange sunrise over a translucent green wave lit from within.", [
  ...sideRails(["#a65930", "#dd8628", "#f2b030"], 0.5),
  ...softGlow(0.55, 0.34, 0.26, 0.2, ["#fff4a8", "#f6c030", "#e07a2a"], ring),
  horizon([0.6, 0.5, 0.56, 0.6], ["#e8a038"], ["#2f7a5a", "#7ab088", "#2f6a4c", "#2f7a5a"]),
  horizon([0.82, 0.78, 0.84, 0.8], ["#1f3a2a"], ["#0f1c14"]),
  edge(BR, BL, ["#0b140c"]),
  point(0.58, 0.9, "#f0b040"),
]),
  // Aivazovsky, Among the Waves: glass-green surf under a black-blue storm sky.
  preset("glass-surf", "Glass surf", "Stacked breakers of translucent turquoise glass under a black-blue storm, foam pale on each crest.",
  [[0.14, 0.34, 0.3], [0.4, 0.56, 1.6], [0.66, 0.84, 2.6]].map(([y0, y1, phase]) => boundary(
    slopedWaveNodes({ x0: 0, x1: 1, y0, y1, amplitude: 0.06, cycles: 0.75, phase }),
    ["#14293f", "#1c3654", "#122742", "#14293f"], ["#4d6f84", "#a3c5b6", "#eef6ee", "#6d96a0"]))),
  // Rossetti, Proserpine: viridian and teal drapery folds, lit on one side, a pomegranate glowing red in the dark.
  preset("proserpine-drape", "Proserpine drape", "Deep viridian and teal drapery folds falling in vertical shadow, a single pomegranate glowing red in the dark.", [
  ...verticalRails(["#1e3a34", "#173028"]),
  ...[[0.34, 0.03], [0.5, -0.03], [0.66, 0.03], [0.82, -0.03]].map(([x, lean], i) => boundary(
    catmullRomNodes([[x, 0], [x + lean, 0.33], [x - lean, 0.66], [x, 1]]),
    i % 2 ? ["#5aa6a0", "#3a8a86", "#2a6a6a"] : ["#3f8a86", "#2f7a78", "#1e5a5c"], ["#0c2226", "#0c2226", "#0c2226"])),
  ...softGlow(0.16, 0.5, 0.1, 0.1, ["#f06a4a", "#b02a2a", "#1a3630"], ring),
]),
  // Turner, Norham Castle, Sunrise: near-abstract veils of pale blue and gold, a ghost tower dissolving in the light.
  preset("norham-dawn", "Norham dawn", "Veils of pale blue and gold dissolving into one another, a faint blue tower and a low sun reflected in the river.", [
  ...sideRails(["#b8d0e0", "#f4e6b8", "#f0c8a0"], 0.62),
  ...softGlow(0.66, 0.4, 0.16, 0.14, ["#fffbe6", "#fbeab0", "#f2d8a8"], ring),
  ...softGlow(0.22, 0.44, 0.06, 0.16, ["#6a8ab0", "#9ab0cc", "#e2d6b6"], ring),
  horizon([0.62, 0.6, 0.63], ["#f0c8a0"], ["#a8c4d8"]),
  boundary(polylineNodes([[0.66, 0.66], [0.66, 0.98]]), ["#fff2c0", "#e0c890", "#8aa8c4"]),
  edge(BR, BL, ["#7a9ab8"]),
]),
];
