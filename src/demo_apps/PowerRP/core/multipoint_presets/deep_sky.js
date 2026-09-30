/**
 * "Deep sky" — native Multipoint presets. Nebulae, galaxies, moons and exoplanet impressions from telescope imagery.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, glow } from "./builders.js";
import { ellipseNodes, polylineNodes, catmullRomNodes } from "../multipoint_shapes.js";
import { blobNodes, affineNodes, pivotMatrix, frameNodes } from "./space.js";
import { boxedHandles } from "./swirls.js";

/**
 * Pure function. A smooth open curve through points whose ends may stand on the unit box border:
 * end handles are clipped so the drawn curve cannot leave the box.
 * @param {number[][]} pts - [N,2] (x,y) anchors, all inside [0,1].
 * @returns {number[][]} [N,6] tuples.
 * @example edgeCurve([[0, 0.5], [0.5, 0.4], [1, 0.5]]).length // 3
 */
const edgeCurve = (pts) => boxedHandles(catmullRomNodes(pts));

/**
 * Pure function. A closed shape tilted and squashed about its own centre (galaxy / nebula inclination).
 * @param {number[][]} nodes - [N,6] closed tuples.
 * @param {number} cx - Pivot x.
 * @param {number} cy - Pivot y.
 * @param {number} angle - Rotation, radians clockwise on screen.
 * @param {number} sy - Vertical squash applied before rotation, (0,1].
 * @returns {number[][]} [N,6] tuples.
 * @example tilt(ellipseNodes(0.5, 0.5, 0.2), 0.5, 0.5, 0, 0.5)[1].slice(0, 2) // [0.5,0.6]
 */
const tilt = (nodes, cx, cy, angle, sy = 1) => affineNodes(nodes, pivotMatrix({ cx, cy, angle, sy }));

/** Pure function. A single-colour closed ring (pins its colour on both sides). @example ring(ellipseNodes(0.5,0.5,0.1),"#fff").closed // true */
const ring = (nodes, color) => boundary(nodes, [color], null, true);

/**
 * Pure function. Anchor points along a wobbling spiral arc (radius r0 to r1 while the angle runs a0 to a1),
 * the raw material for filaments and nebula shells; feed to catmullRomNodes.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number[]} radii - [r0, r1] start and end radius.
 * @param {number[]} angles - [a0, a1] radians, clockwise on screen.
 * @param {number} n - Point count, at least 2.
 * @param {number} wobble - Radial wobble amplitude (0 = smooth arc).
 * @param {number} squash - Vertical squash of the whole arc.
 * @returns {number[][]} [n,2] (x,y) points.
 * @example arcPts(0.5, 0.5, [0.2, 0.2], [0, Math.PI / 2], 2, 0, 1) // [[0.7,0.5],[0.5,0.7]] (up to rounding)
 */
const arcPts = (cx, cy, [r0, r1], [a0, a1], n, wobble = 0, squash = 1) => {
  if (!Number.isInteger(n) || n < 2 || ![cx, cy, r0, r1, a0, a1, wobble, squash].every(Number.isFinite)) throw new Error("arcPts needs finite geometry and n >= 2");
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1), a = a0 + (a1 - a0) * t, r = r0 + (r1 - r0) * t + wobble * Math.sin(i * 2.1 + a0 * 3);
    return [cx + r * Math.cos(a), cy + squash * r * Math.sin(a)];
  });
};

/** Pure function. The full paint-box border pinned to one colour. @example vignette("#000000").closed // true */
const vignette = (color) => boundary(frameNodes(), [color], null, true);

const SPACE = "#03040a";

/**
 * Pure function. Re-spaces a feature's colour stops at chosen arc-length offsets (boundary() spaces them evenly),
 * e.g. to squeeze a lit crescent into a thin part of a closed ring.
 * @param {object} feature - Native feature with N stops.
 * @param {number[]} offsets - N strictly increasing offsets in [0,1].
 * @returns {object} Copy with the same colours at the new offsets.
 * @example stopsAt(boundary(ellipseNodes(0.5, 0.5, 0.2), ["#000000", "#ffffff"], null, true), [0, 0.2]).stops[1].offset // 0.2
 */
const stopsAt = (feature, offsets) => {
  if (offsets.length !== feature.stops.length || offsets.some((o, i) => !(o >= 0 && o <= 1) || (i && o <= offsets[i - 1]))) throw new Error("stopsAt needs one increasing offset in [0,1] per stop");
  return { ...feature, stops: feature.stops.map((stop, i) => ({ ...stop, offset: offsets[i] })) };
};

/**
 * Pure function. A closed circle whose stop 0 sits at a chosen screen angle, so one side can be lit.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Radius.
 * @param {number} lit - Angle of stop 0, radians clockwise from +x on screen (y down).
 * @returns {number[][]} [8,6] closed tuples, clockwise.
 * @example circleFrom(0.5, 0.5, 0.2, 0)[0].slice(0, 2) // [0.7,0.5]
 */
const circleFrom = (cx, cy, r, lit) => blobNodes({ cx, cy, radii: Array(8).fill(r), phase: lit });

/**
 * Pure function. A lit sphere on black: a limb ring shaded lit-to-dark around its circumference (outside colours fade
 * into space), an inner body ring and one highlight.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Radius.
 * @param {object} c - {litEdge, darkEdge, body, lit} colours (#rrggbb): rim on the lit and dark sides, surface, highlight.
 * @param {number} angle - Screen angle toward the light (radians clockwise from +x, y down).
 * @returns {object[]} Three features (8 + 4 + 1 nodes).
 * @example sphere(0.5, 0.5, 0.3, { litEdge: "#ffffff", darkEdge: "#222222", body: "#888888", lit: "#ffffff" }, -2).length // 3
 */
const sphere = (cx, cy, r, { litEdge, darkEdge, body, lit }, angle = -2.2) => [
  stopsAt(boundary(circleFrom(cx, cy, r, angle), [SPACE, SPACE, SPACE, SPACE], [litEdge, darkEdge, darkEdge, litEdge], true), [0, 0.3, 0.7, 1]),
  ring(ellipseNodes(cx + Math.cos(angle) * r * 0.2, cy + Math.sin(angle) * r * 0.2, r * 0.55), body),
  point(cx + Math.cos(angle) * r * 0.45, cy + Math.sin(angle) * r * 0.45, lit),
];

export const PRESETS = [
  preset("cosmic-cliffs", "Cosmic cliffs", "Layered gold-and-rust gas ridges glowing under a cobalt starfield, after the Carina Nebula's edge in the first Webb image.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#040822"]),
    boundary(edgeCurve([[0, 0.26], [0.18, 0.3], [0.27, 0.44], [0.46, 0.38], [0.66, 0.44], [0.82, 0.36], [1, 0.22]]),
      ["#2a5ec8", "#3a7ee4", "#2d68d0", "#2a56b0"], ["#ffd890", "#ffc878", "#f0b068", "#ffc078"]),
    boundary(edgeCurve([[0, 0.5], [0.22, 0.56], [0.4, 0.5], [0.62, 0.58], [0.82, 0.5], [1, 0.4]]), ["#e0904a", "#d88440", "#e0904a", "#d88440"], ["#7a2c14", "#6a2410", "#7a2c14", "#6a2410"]),
    boundary(edgeCurve([[0, 0.8], [0.3, 0.7], [0.6, 0.78], [1, 0.66]]), ["#b8582a", "#a84e24", "#b8582a", "#a04a22"], ["#2c0e08", "#240a06", "#2c0e08", "#240a06"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#1a0806"]),
    point(0.3, 0.14, "#dfeaff"), point(0.74, 0.16, "#ffe8c0"),
  ]),
  preset("horsehead-dark", "Horsehead", "A dark dust silhouette shaped like a horse's head rising against a raspberry emission glow, with a blue reflection nebula smouldering below.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#8a0a3e"]),
    boundary(edgeCurve([[0, 0.62], [0.28, 0.6], [0.4, 0.52], [0.41, 0.38], [0.48, 0.3], [0.56, 0.36], [0.59, 0.5], [0.68, 0.6], [1, 0.58]]),
      ["#ff3a7c", "#ff6a98", "#ff3a7c", "#f03070"], ["#160610", "#2a0a18", "#160610", "#22081a"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#0a0308"]),
    ...glow(0.2, 0.84, 0.14, ["#e8f8ff", "#3a8ac8", "#122a44"]),
  ]),
  preset("catseye-shells", "Cat's Eye shells", "Nested planetary-nebula shells: a white core in violet lobes, a crimson envelope and lime arcs of ionised gas, after Hubble's Cat's Eye.", [
    vignette("#030106"),
    ring(tilt(blobNodes({ cx: 0.5, cy: 0.5, radii: [0.45, 0.4, 0.44, 0.41], phase: 0.4 }), 0.5, 0.5, -0.5, 0.9), "#6a0f24"),
    boundary(catmullRomNodes(arcPts(0.5, 0.5, [0.35, 0.35], [3.7, 5.5], 4, 0.01, 0.9)), ["#6a0f24", "#c8ec68", "#a8d854", "#6a0f24"]),
    boundary(catmullRomNodes(arcPts(0.5, 0.5, [0.35, 0.35], [0.55, 2.35], 4, 0.01, 0.9)), ["#6a0f24", "#a8d854", "#c8ec68", "#6a0f24"]),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.26, 0.2), 0.5, 0.5, -0.5), "#d02a3a"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.17, 0.1), 0.5, 0.5, -0.5), "#5a3ad0"),
    ...glow(0.5, 0.5, 0.07, ["#ffffff", "#c8b8ff", "#7a5ae0"]),
  ]),
  preset("helix-eye", "Helix eye", "An eye of dying-star gas: a magenta pupil, pale periwinkle iris, cream cometary knots and a cobalt lid, in the infrared palette of the Helix Nebula.", [
    vignette("#03040f"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.47, 0.38), 0.5, 0.5, -0.25), "#1a2894"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.36, 0.3), 0.5, 0.5, -0.25), "#5a68d4"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.27, 0.22), 0.5, 0.5, -0.25), "#e6c8b0"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.2, 0.16), 0.5, 0.5, -0.25), "#aab4f2"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.12, 0.1), 0.5, 0.5, -0.25), "#d038c8"),
    point(0.5, 0.5, "#ffe8ff"),
  ]),
  preset("southern-ring", "Southern Ring", "A tilted planetary shell: cool blue-white interior, cream rim and orange fibrous halo on black, after Webb's near-infrared Southern Ring.", [
    vignette("#020205"),
    ring(tilt(blobNodes({ cx: 0.5, cy: 0.5, radii: [0.44, 0.4, 0.45, 0.39, 0.44, 0.4] }), 0.5, 0.5, -0.55, 0.78), "#5a1c10"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.34, 0.26), 0.5, 0.5, -0.55), "#ee8232"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.25, 0.18), 0.5, 0.5, -0.55), "#fff0d0"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.2, 0.13), 0.5, 0.5, -0.55), "#8ec4f4"),
    point(0.5, 0.5, "#ffffff"), point(0.6, 0.44, "#ffb8f0"),
  ]),
  preset("elliptical-glow", "Elliptical glow", "A smooth giant elliptical galaxy: a cream core fading through amber and umber to black, with a small dwarf companion.", [
    vignette("#020204"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.46, 0.4), 0.5, 0.5, -0.3), "#1c120c"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.33, 0.28), 0.5, 0.5, -0.3), "#6a4626"),
    ring(tilt(ellipseNodes(0.5, 0.5, 0.2, 0.17), 0.5, 0.5, -0.3), "#d0a262"),
    ...glow(0.5, 0.5, 0.1, ["#fffaf0", "#f8e0b0", "#c89a58"]),
    ...glow(0.83, 0.2, 0.07, ["#fff0d8", "#d8a868", "#1c120c"]),
  ]),
  preset("callisto-craters", "Callisto craters", "A dark, ancient, crater-saturated moon dusted with bright ice splashes and a Valhalla bullseye, after Galileo.", [
    vignette("#02030a"),
    ...sphere(0.5, 0.5, 0.4, { litEdge: "#7a7268", darkEdge: "#161412", body: "#5a524a", lit: "#8a8278" }, -2.3),
    ring(ellipseNodes(0.42, 0.46, 0.14), "#8c8478"),
    ring(ellipseNodes(0.42, 0.46, 0.07), "#3e3832"),
    point(0.42, 0.46, "#e4dfd2"),
    point(0.66, 0.36, "#eceae2"), point(0.6, 0.66, "#e0dcd0"), point(0.3, 0.68, "#d8d2c6"), point(0.7, 0.55, "#e4e0d6"), point(0.52, 0.26, "#d8d4c8"),
  ]),
  preset("ocean-exoplanet", "Ocean exoplanet", "A deep-blue water world with a bright cyan atmosphere limb and a pale sunlit haze, floating in a navy halo.", [
    vignette("#02040c"),
    ring(ellipseNodes(0.5, 0.5, 0.46), "#0a1e3a"),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, radii: Array(8).fill(0.34), phase: -3 * Math.PI / 4 }), ["#8adcf4", "#0c2c48", "#0c2c48", "#8adcf4"], ["#4aaad4", "#082238", "#082238", "#4aaad4"], true),
    ring(ellipseNodes(0.44, 0.44, 0.19), "#bfeaf6"),
    point(0.42, 0.42, "#ffffff"),
  ]),
  preset("twin-suns", "Twin suns", "A violet-to-amber sky at a circumbinary world's horizon: a big orange sun and a small blue-white one above black dunes.", [
    boundary(polylineNodes([[0, 0], [1, 0]]), ["#1c0e40"]),
    boundary(edgeCurve([[0, 0.7], [0.25, 0.66], [0.5, 0.72], [0.78, 0.66], [1, 0.7]]), ["#f6a04c", "#f08a44", "#f6a04c", "#f08a44"], ["#180a14", "#120810", "#180a14", "#120810"]),
    boundary(polylineNodes([[0, 1], [1, 1]]), ["#0a0508"]),
    ...glow(0.34, 0.5, 0.15, ["#fff8e2", "#ffb658", "#f08a44"]),
    ...glow(0.7, 0.3, 0.06, ["#ffffff", "#c8dcff", "#a04a8a"]),
  ]),
  preset("red-dwarf-sky", "Red dwarf sky", "A swollen red-orange dwarf star filling a burgundy sky beside two pale sibling planets, in the manner of TRAPPIST-1 artist impressions.", [
    vignette("#14040c"),
    ring(ellipseNodes(0.3, 0.5, 0.29), "#5a1408"),
    boundary(ellipseNodes(0.3, 0.5, 0.2), ["#5a1408"], ["#ff7a2c"], true),
    point(0.3, 0.5, "#ffd890"),
    boundary(ellipseNodes(0.72, 0.28, 0.08), ["#14040c"], ["#a8c8e8"], true),
    boundary(ellipseNodes(0.8, 0.68, 0.05), ["#14040c"], ["#d8b898"], true),
  ]),
];
