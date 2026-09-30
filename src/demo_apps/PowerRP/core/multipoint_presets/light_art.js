/**
 * "Light art" — native Multipoint presets. Eliasson, Turrell, Flavin, McCall, Nauman and teamLab: light as material.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { ellipseNodes, polylineNodes, rectNodes, waveNodes, mixHex } from "../multipoint_shapes.js";
import { arcNodes, placedStops } from "./abstract.js";
import { rotateNodes } from "./food_moods.js";
import { roundedRectNodes } from "./retro_eras.js";
import { sampledNodes, coilNodes } from "./swirls.js";
import { offsetCurveNodes } from "./light_art_helpers.js";

const TAU = 2 * Math.PI;

// Turrell, "Wedgework" (1974 on): a slab of projected light leaning into the room, its glowing edge razor sharp
// against a magenta-flooded wall. Two nested wedges give the hot inner core and the pale leading face.
const WEDGE = [[0.03, 0.97], [0.97, 0.16], [0.97, 0.78]];

// Eliasson, "Beauty" (1993): a fine mist lit from one side breaks into a spectral arc that floats in a dark room.
const RAINBOW = ["#ff4a4a", "#ff9a3a", "#f4dc3c", "#4cd06c", "#3a8cff", "#8a52ff"];

const MIST = "#0c1119";

// Eliasson, "Your rainbow panorama" (ARoS Aarhus, 2011): a circular walkway of coloured glass around the museum
// roof, so the whole city is seen through one band that runs through the spectrum.
const PANORAMA = ["#ff4f5e", "#ffd84a", "#4ad8e8", "#8a5cff"];

const panoramaEdge = (y) => waveNodes({ x0: 0, x1: 1, y, amplitude: 0.035, cycles: 0.5, phase: Math.PI });

// teamLab, "Forest of Resonating Lamps": mirrored floor and dark air, each lamp a saturated orb whose colour
// changes when touched. Lamps recede in three rows; nearer ones are larger.
const LAMPS = [[0.26, 0.26, 0.1, "#ff3ea5"], [0.74, 0.28, 0.1, "#2ee6ff"], [0.5, 0.5, 0.13, "#ffb62e"],
  [0.22, 0.76, 0.14, "#9a5cff"], [0.78, 0.76, 0.14, "#46ff9c"]];

// teamLab, "Universe of Water Particles" waterfalls: vertical streams of light-particles pouring down a dark wall,
// each stream a different cool hue that brightens mid-fall.
const STREAM = (x0, phase) => (t) => [x0 + 0.03 * Math.sin(TAU * t + phase), t, 0.03 * TAU * Math.cos(TAU * t + phase), 1];

const NIGHT_WALL = "#040a1e";

// Nauman-style neon spiral (cf. "The True Artist Helps the World by Revealing Mystic Truths", 1967): tube
// coils in red and blue with dark spacer arms so the two hues glow side by side without blending to mud.
const NEON_SPIRAL_ARMS = [["#ff2a3a", 0], ["#0a0410", 0.5], ["#2a5cff", 1], ["#0a0410", 1.5]];

// Emin-style neon scrawl: one hand-bent tube (white-pink core, hot-pink shoulders, near-black outer guards) so
// the glow is bounded and saturated instead of washing out to grey.
const SCRAWL = (t) => [0.08 + 0.84 * t, 0.5 + 0.2 * Math.sin(TAU * 1.5 * t + 0.6)];

const SCRAWL_LAYERS = [[0.075, "#12040e"], [0.03, "#ff2d95"], [0, "#ffe2f0"], [-0.03, "#ff2d95"], [-0.075, "#12040e"]];

// Eliasson, "Your uncertain shadow (colour)" (2010): coloured lamps throw a visitor's shadow onto a white wall in
// several hues at once, each lamp's shadow fully saturated where the others do not reach.
const SHADOWS = [[0.13, 0.5, 0.06, 0.36, "#18b4ec", "#7fd8f6"], [0.31, 0.44, 0.06, 0.32, "#ee2c92", "#f78cc6"],
  [0.5, 0.52, 0.065, 0.38, "#ffe61c", "#fff59a"], [0.69, 0.46, 0.06, 0.33, "#6a4cf0", "#a898f6"], [0.87, 0.5, 0.06, 0.35, "#20c46a", "#86e4ae"]];

export const PRESETS = [
  // Eliasson, "The Weather Project" (Tate Modern, 2003): a half-disc of mono-frequency yellow lamps mirrored
  // into a full sun, hung in amber mist. Only yellow and black exist there, so the palette is a duotone.
  preset("weather-project", "The Weather Project", "A mirrored mono-yellow sun hung in a burnt-amber mist, after Eliasson's Tate Modern hall.", [
  boundary(rectNodes(0, 0, 1, 1), ["#0f0703"], null, true),
  boundary(polylineNodes([[0.06, 0.02], [0.94, 0.02]]), ["#7a3d08"]),
  boundary(ellipseNodes(0.5, 0.56, 0.46, 0.4), ["#5e2f07"], null, true),
  boundary(ellipseNodes(0.5, 0.56, 0.3, 0.3), ["#d9891a"], null, true),
  boundary(ellipseNodes(0.5, 0.56, 0.17, 0.17), ["#f5b524"], ["#ffdc3a"], true),
  point(0.5, 0.56, "#fff7b0"),
]),
  // Turrell Ganzfeld ("Aten Reign"-adjacent works, 2013 on): an entire room of one saturated colour whose far
  // end dissolves into a softly lit rounded aperture. The photo reference is a cyan-azure field with a paler window.
  preset("ganzfeld-blue", "Ganzfeld blue", "A whole field of saturated cyan-blue light around a paler, soft-cornered aperture, after Turrell's Ganzfeld.", [
  boundary(rectNodes(0, 0, 1, 1), ["#1568b8"], null, true),
  boundary(roundedRectNodes({ x0: 0.24, y0: 0.2, x1: 0.74, y1: 0.8, r: 0.09 }), ["#3aa0ee"], null, true),
  point(0.49, 0.5, "#62bdf8"),
]),
  // Flavin, "untitled (to the 'innovator' of Wheeling Peachblow)" (1966-68): a gold and a pink tube stacked
  // vertically; their light washes overlap into peach on the wall between.
  preset("peachblow-tubes", "Peachblow tubes", "A pink tube and a gold tube washing a dark wall in overlapping rose and amber, after Flavin.", [
  boundary(polylineNodes([[0, 0], [0, 1]]), ["#3a0f2a"]),
  boundary(polylineNodes([[1, 0], [1, 1]]), ["#3a2406"]),
  boundary(rectNodes(0.425, 0.04, 0.455, 0.96), ["#ea5c98"], ["#ffdcec"], true),
  boundary(rectNodes(0.485, 0.04, 0.515, 0.96), ["#f4b634"], ["#fff2b8"], true),
]),
  // McCall, "Line Describing a Cone" (1973): a projector at the right edge of a hazed black room throws a beam
  // whose circle grows over 30 minutes; the haze makes the growing cone read as solid. Only white light exists.
  preset("solid-light-cone", "Solid light cone", "A hollow cone of white haze fanning from a projector point, with a thin arc of light, after McCall.", [
  boundary(rectNodes(0, 0, 1, 1), ["#030304"], null, true),
  boundary(polylineNodes([[0.97, 0.49], [0.24, 0.2]]), ["#d0d0d6", "#0a0a0d"], ["#030304", "#030304"]),
  boundary(polylineNodes([[0.97, 0.51], [0.24, 0.8]]), ["#030304", "#030304"], ["#d0d0d6", "#0a0a0d"]),
  boundary(ellipseNodes(0.14, 0.5, 0.05, 0.3), ["#030304"], ["#b4b4bc"], true),
  boundary(ellipseNodes(0.14, 0.5, 0.036, 0.28), ["#b4b4bc"], ["#08080b"], true),
  point(0.985, 0.5, "#ffffff"),
]),
  preset("wedgework-light", "Wedgework", "A razor-edged wedge of peach-white light leaning into a magenta-flooded room, after Turrell.", [
  boundary(rectNodes(0, 0, 1, 1), ["#4a0f4c"], null, true),
  boundary(polylineNodes(WEDGE), ["#8a2a80", "#8a2a80", "#8a2a80", "#8a2a80"], ["#d8407e", "#ffb48c", "#fff2e2", "#d8407e"], true),
  point(0.78, 0.52, "#fff6ec"),
]),
  // Turrell, Roden Crater skyspaces: a sky oculus cut in a dark cinder ceiling, its dusk gradient glowing
  // from deep indigo overhead to a peach horizon.
  preset("crater-oculus", "Crater oculus", "An elliptical sky opening in dark cinder, from indigo zenith to a peach horizon glow, after Roden Crater.", [
  boundary(rectNodes(0, 0, 1, 1), ["#241612"], null, true),
  placedStops(ellipseNodes(0.5, 0.5, 0.42, 0.34), [[0, "#241612", "#e58f98"], [0.25, "#241612", "#f8bc8c"], [0.75, "#241612", "#28308a"], [1, "#241612", "#e58f98"]], true),
  point(0.5, 0.78, "#ffc79a"),
]),
  preset("mist-rainbow", "Mist rainbow", "Six spectral arcs floating in a dark misted room, after Eliasson's Beauty.", [
  boundary(rectNodes(0, 0, 1, 1), [MIST], null, true),
  ...RAINBOW.map((color, i) => placedStops(arcNodes({ cx: 0.5, cy: 0.72, radius: 0.45 - 0.04 * i, start: Math.PI, end: TAU }),
    [[0, MIST], [0.16, color], [0.84, color], [1, MIST]])),
]),
  preset("rainbow-panorama", "Rainbow panorama", "A curving band of coloured glass running the whole spectrum across a pale city sky, after Eliasson.", [
  boundary(polylineNodes([[0, 0], [1, 0]]), ["#7fb4e6"]),
  boundary(polylineNodes([[1, 1], [0, 1]]), ["#5c7a86"]),
  boundary(panoramaEdge(0.4), ["#cfe4f2", "#cfe4f2", "#cfe4f2", "#cfe4f2"], PANORAMA),
  boundary(panoramaEdge(0.6), PANORAMA, ["#93aeb8", "#93aeb8", "#93aeb8", "#93aeb8"]),
]),
  preset("resonating-lamps", "Resonating lamps", "Five saturated orbs of light glowing in a dark mirrored hall, after teamLab.", [
  boundary(rectNodes(0, 0, 1, 1), ["#05040c"], null, true),
  ...LAMPS.flatMap(([cx, cy, r, color]) => [boundary(ellipseNodes(cx, cy, r), [color], null, true), point(cx, cy, mixHex(color, "#ffffff", 0.7))]),
]),
  preset("particle-waterfall", "Particle waterfall", "Four cool streams of light pouring down a dark wall between black spacers, each brightest mid-fall, after teamLab.", [
  boundary(rectNodes(0, 0, 1, 1), [NIGHT_WALL], null, true),
  ...[[0.16, 0, "#26d2ff", "#b8f4ff"], [0.38, 1.6, "#3a6cff", "#9ab8ff"], [0.62, 3.2, "#c8f6ff", "#ffffff"], [0.84, 4.8, "#8a5cff", "#d2b8ff"]]
    .map(([x, phase, body, crest]) => placedStops(sampledNodes(STREAM(x, phase), 0, 1, 4),
      [[0, NIGHT_WALL], [0.3, body], [0.6, crest], [1, NIGHT_WALL]])),
  ...[[0.27, 0.8], [0.5, 2.4], [0.73, 4]].map(([x, phase]) => boundary(sampledNodes(STREAM(x, phase), 0, 1, 4), [NIGHT_WALL])),
]),
  preset("neon-coil", "Neon coil", "A red and a blue neon tube coiling out from a white core between dark spacer arms.", [
  boundary(rectNodes(0, 0, 1, 1), ["#0a0410"], null, true),
  ...NEON_SPIRAL_ARMS.map(([color, half]) => boundary(coilNodes({ cx: 0.5, cy: 0.5, r0: 0.03 + 0.012 * half, r1: 0.44 + 0.012 * half - 0.012, turns: 1.75, phase: Math.PI * half }), [color])),
  point(0.5, 0.5, "#ffffff"),
]),
  preset("neon-scrawl", "Neon scrawl", "A single hand-bent pink neon tube glowing in a black room, after Tracey Emin's neon handwriting.", [
  ...SCRAWL_LAYERS.map(([offset, color]) => boundary(offsetCurveNodes(SCRAWL, 0, 1, 6, offset), [color])),
]),
  preset("coloured-shadows", "Coloured shadows", "Five saturated cyan, magenta, yellow, violet and green shadows cast on a white wall, after Eliasson.", [
  boundary(rectNodes(0, 0, 1, 1), ["#f4f2ee"], null, true),
  ...SHADOWS.map(([cx, cy, rx, ry, deep, soft]) => boundary(ellipseNodes(cx, cy, rx, ry), Array(3).fill(mixHex(deep, "#f4f2ee", 0.82)), closedRamp([deep, soft]), true)),
]),
  // Flavin, "the diagonal of May 25, 1963" (1963): one gold fluorescent tube at 45 degrees, the first work he
  // showed as art, warming a dark wall.
  preset("gold-diagonal", "Gold diagonal", "One 45-degree gold fluorescent tube warming a dark wall, after Flavin's first tube piece.", [
  boundary(rectNodes(0, 0, 1, 1), ["#1c1305"], null, true),
  boundary(rotateNodes(rectNodes(0.12, 0.485, 0.88, 0.515), 0.5, 0.5, -Math.PI / 4), ["#e9a818"], ["#fff3b4"], true),
]),
];
