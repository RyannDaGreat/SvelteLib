/**
 * "Colour field" — native Multipoint presets. Rothko, Morris Louis, Noland, Clyfford Still, Olitski and Newman: feathered fields, veils, chevrons and zips.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp } from "./builders.js";
import { rectNodes, ellipseNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { squircleNodes, blobNodes } from "./art_homages.js";
import { chevronBand, rotRect, clipPolygon } from "./colour_field_helpers.js";

const BOX = [0, 0, 1, 1];

/**
 * Pure function. Single-sided soft block: a squircle whose rim colour floods its interior.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Half width.
 * @param {number} ry - Half height.
 * @param {string} color - Rim/fill colour #rrggbb.
 * @returns {object} Closed single-sided feature.
 * @example block(0.5, 0.5, 0.3, 0.2, "#ff0000").closed // true
 */
const block = (cx, cy, rx, ry, color) => boundary(squircleNodes(cx, cy, rx, ry, 0.95), [color], null, true);

/**
 * Pure function. Single-sided constant frame around the whole unit box (crease-free ground).
 * @param {string[]} colors - 1..3 colours around the perimeter.
 * @returns {object} Closed four-node feature.
 * @example ground(["#000000"]).nodes.length // 4
 */
const ground = (colors) => boundary(rectNodes(...BOX), colors.length > 1 ? closedRamp(colors) : colors, null, true);

// Rothko: the Seagram maroon window.
const seagram = preset("seagram-maroon", "Seagram maroon",
  "A near-black window frame holding two lilac-maroon panes on a wine maroon ground, after Rothko's Seagram murals.", [
    ground(["#862631"]),
    block(0.5, 0.5, 0.42, 0.41, "#14080b"),
    block(0.315, 0.5, 0.085, 0.28, "#7a2f48"), point(0.315, 0.5, "#94405c"),
    block(0.685, 0.5, 0.085, 0.28, "#8a3650"), point(0.685, 0.5, "#a24863"),
  ]);

// Rothko Chapel: plum-black panels that barely separate.
const chapel = preset("chapel-plum", "Chapel plum",
  "Aubergine and blue-black panels that only just separate from each other, after the Rothko Chapel.", [
    ground(["#0d0910"]),
    block(0.5, 0.5, 0.43, 0.43, "#1d1230"),
    block(0.5, 0.27, 0.3, 0.13, "#2b315f"), point(0.5, 0.27, "#3d4a86"),
    block(0.5, 0.7, 0.3, 0.14, "#4d2142"), point(0.5, 0.7, "#6a2f59"),
  ]);

// Louis: Veil — nested translucent curtains, colour emerging only at the fringes.
const veil = preset("veil-curtain", "Veil curtain",
  "Nested scalloped veils of viridian, wine and indigo on a grey-green stained canvas, after Morris Louis.", [
    ground(["#c9d0c0"]),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.44, harmonics: [[3, 0.06, 0.6], [7, 0.035, 1.2]], count: 8 }), ["#c0ccbd", "#c0ccbd", "#c0ccbd", "#c0ccbd"], closedRamp(["#2aa08c", "#15685f", "#3eb49a"]), true),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.35, harmonics: [[3, 0.07, 2.2], [6, 0.04, 0.4]], count: 8 }), ["#1d7d70", "#1d7d70", "#1d7d70", "#1d7d70"], closedRamp(["#9a2f68", "#6a2052", "#a83a6c"]), true),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.19, ry: 0.25, harmonics: [[2, 0.1, 1], [5, 0.05, 2]], count: 8 }), ["#7c2a5e", "#7c2a5e", "#7c2a5e", "#7c2a5e"], closedRamp(["#231c60", "#14103a", "#2c2470"]), true),
    point(0.5, 0.5, "#2e2a78"),
  ]);

// Louis: Stripe paintings — vertical poured stripes on raw canvas, each thinning paler toward the bottom.
const STRIPE_CANVAS = "#f1ebdd";

const STRIPE_LEAN = 0.05;

const STRIPE_FADE = 0.42;

// [x0, x1, colour]; touching stripes share an edge, the others leave bare canvas between them.
const STRIPES = [[0.1, 0.22, "#b8245e"], [0.22, 0.3, "#e0632a"], [0.3, 0.44, "#e9b83a"], [0.52, 0.62, "#1f8a6a"], [0.62, 0.71, "#2c5aa8"], [0.78, 0.9, "#5c2f8f"]];

/**
 * Pure function. The [top, bottom] ramp of one poured stripe (saturated top, paler bottom).
 * @param {string|null} color - Stripe colour #rrggbb; null gives the bare-canvas ramp.
 * @returns {string[]} [2] colours, top to bottom.
 * @example stripeRamp(null)[0] // "#f1ebdd"
 */
const stripeRamp = (color) => (color ? [color, mixHex(color, STRIPE_CANVAS, STRIPE_FADE)] : [STRIPE_CANVAS, STRIPE_CANVAS]);

/**
 * Pure function. A leaning two-sided stripe edge. Walking DOWN the screen the walker's left is EAST.
 * @param {number} x - Mid-height x.
 * @param {string|null} east - Colour east of the edge (null = canvas).
 * @param {string|null} west - Colour west of the edge (null = canvas).
 * @returns {object} Open two-sided feature.
 * @example stripeEdge(0.5, "#ff0000", null).twoSided // true
 */
const stripeEdge = (x, east, west) => boundary(polylineNodes([[x + STRIPE_LEAN / 2, 0], [x - STRIPE_LEAN / 2, 1]]), stripeRamp(east), stripeRamp(west), false);

// Noland: chevron — nested bands pointing down, separated by bare canvas.
const NOLAND_CANVAS = "#f3efe4";

const chevron = preset("noland-chevron", "Noland chevron",
  "Nested V bands of crimson, butter, sky and navy falling to a low apex over bare canvas, after Kenneth Noland.", [
    ["#c72c3c", 0.0, 0.085], ["#f2df86", 0.15, 0.06], ["#6fa8d8", 0.28, 0.1], ["#1f2f66", 0.45, 0.065], ["#e8953a", 0.6, 0.11],
  ].map(([color, top, thick]) => boundary(polylineNodes(chevronBand(top, 0.26, thick)), [NOLAND_CANVAS], [color], true)));

// Noland: diagonal stripes.
const BEND = [[-0.36, 0.05, "#e5562e"], [-0.22, 0.03, "#f0c53a"], [-0.08, 0.075, "#3e7f86"], [0.1, 0.03, "#2a2f66"], [0.22, 0.055, "#d87aa0"], [0.4, 0.04, "#6cae6a"]];

// Clyfford Still: a jagged flame torn up through a dark field, hot yellow at its core.
const STILL_DARK = "#171210";

// Clyfford Still: blue-black field, a cream slab down one side and a crimson flame rising from below.
const STILL_NIGHT = "#0d1634";

// Jules Olitski: sprayed mist — a perimeter ramp diffusing inward, with a few colour flecks.
const olitski = preset("olitski-mist", "Sprayed mist",
  "A peach, lilac and mint mist sprayed from the edges inward around a rose cloud, after Jules Olitski.", [
    ground(["#f7c9a8", "#a48fd6", "#86d3c0"]),
    boundary(ellipseNodes(0.5, 0.5, 0.17, 0.23), ["#f59bb4"], null, true),
    point(0.5, 0.5, "#ffd9a0"), point(0.72, 0.3, "#fff0b0"), point(0.28, 0.72, "#ff7fa0"),
  ]);

// Barnett Newman: Cathedra — an ultramarine field and one pale zip.
const NEWMAN_BLUE = ["#1c2e88", "#22399c", "#16246d"];

const zipOn = (x, width, field, color) => boundary(rectNodes(x - width / 2, 0, x + width / 2, 1), [field], [color], true);

const cathedra = preset("cathedra-blue", "Cathedra blue",
  "A deep ultramarine field split by one pale sky-blue zip and a hairline of ink, after Barnett Newman's Cathedra.", [
    ground(NEWMAN_BLUE),
    zipOn(0.64, 0.036, "#22399c", "#a8c6f2"),
    zipOn(0.2, 0.012, "#1c2e88", "#0a1450"),
  ]);

// Clyfford Still: crimson field, a black slab torn down one side and a bone-white shard rising from below.
const STILL_RED = "#b3221f";

export const PRESETS = [
  // Rothko: the Seagram maroon window.
  preset("seagram-maroon", "Seagram maroon",
  "A near-black window frame holding two lilac-maroon panes on a wine maroon ground, after Rothko's Seagram murals.", [
    ground(["#862631"]),
    block(0.5, 0.5, 0.42, 0.41, "#14080b"),
    block(0.315, 0.5, 0.085, 0.28, "#7a2f48"), point(0.315, 0.5, "#94405c"),
    block(0.685, 0.5, 0.085, 0.28, "#8a3650"), point(0.685, 0.5, "#a24863"),
  ]),
  // Rothko: the lilac Seagram — two pale panes held in a plum-black wall.
  preset("seagram-lilac", "Seagram lilac",
  "Two pale lilac panes standing in a plum-black wall, divided by a dark pier, after Rothko's Seagram murals.", [
    ground(["#2a1626"]),
    block(0.31, 0.5, 0.105, 0.31, "#9a7aab"), point(0.31, 0.5, "#b89ac6"),
    block(0.69, 0.5, 0.105, 0.31, "#ab8bb9"), point(0.69, 0.5, "#c6aad2"),
  ]),
  // Rothko: No. 61 (Rust and Blue).
  preset("rust-and-blue", "Rust and blue",
  "A luminous rust block between a cobalt top band and a deep blue base on a burnt-red ground, after Rothko's No. 61.", [
    ground(["#8a2c1c"]),
    block(0.5, 0.2, 0.41, 0.13, "#2d4f8f"), point(0.5, 0.2, "#4a72b0"),
    block(0.5, 0.54, 0.41, 0.2, "#c9532a"), point(0.5, 0.52, "#e06a30"),
    block(0.5, 0.85, 0.41, 0.085, "#1f3263"),
  ]),
  // Rothko: Orange and Yellow.
  preset("orange-yellow", "Orange and yellow",
  "A saffron-yellow glow floating over a blood orange block on a crimson ground, after Rothko's Orange and Yellow.", [
    ground(["#8f1e1c"]),
    block(0.5, 0.22, 0.4, 0.14, "#f2bf2f"), point(0.5, 0.22, "#ffd84a"),
    block(0.5, 0.65, 0.4, 0.22, "#e9692a"), point(0.5, 0.63, "#f58a36"),
  ]),
  // Rothko Chapel: plum-black panels that barely separate.
  preset("chapel-plum", "Chapel plum",
  "Aubergine and blue-black panels that only just separate from each other, after the Rothko Chapel.", [
    ground(["#0d0910"]),
    block(0.5, 0.5, 0.43, 0.43, "#1d1230"),
    block(0.5, 0.27, 0.3, 0.13, "#2b315f"), point(0.5, 0.27, "#3d4a86"),
    block(0.5, 0.7, 0.3, 0.14, "#4d2142"), point(0.5, 0.7, "#6a2f59"),
  ]),
  // Rothko: White Center.
  preset("white-center", "White center",
  "A chalk-white block between lavender and saffron bands on a rose ground, after Rothko's White Center.", [
    ground(["#c65676"]),
    block(0.5, 0.17, 0.4, 0.09, "#b59fd0"),
    block(0.5, 0.46, 0.4, 0.17, "#f3ead8"), point(0.5, 0.46, "#fffaf0"),
    block(0.5, 0.78, 0.4, 0.1, "#f0bf3c"),
  ]),
  // Rothko: Green and Tangerine on Red.
  preset("tangerine-green", "Tangerine green",
  "A tangerine block over an emerald one on a cadmium red ground, after Rothko's Green and Tangerine on Red.", [
    ground(["#b22a20"]),
    block(0.5, 0.29, 0.4, 0.2, "#f28a2a"), point(0.5, 0.28, "#ffa640"),
    block(0.5, 0.74, 0.4, 0.15, "#2f7f55"), point(0.5, 0.74, "#3f9a68"),
  ]),
  // Rothko: Light Red Over Black.
  preset("red-over-black", "Red over black",
  "A luminous scarlet block and a smouldering crimson band on a coal-black ground, after Rothko's Light Red Over Black.", [
    ground(["#100b0c"]),
    block(0.5, 0.36, 0.4, 0.28, "#d8382a"), point(0.5, 0.34, "#ee5a38"),
    block(0.5, 0.82, 0.4, 0.09, "#8f1f25"),
  ]),
  // Louis: Veil — nested translucent curtains, colour emerging only at the fringes.
  preset("veil-curtain", "Veil curtain",
  "Nested scalloped veils of viridian, wine and indigo on a grey-green stained canvas, after Morris Louis.", [
    ground(["#c9d0c0"]),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.44, harmonics: [[3, 0.06, 0.6], [7, 0.035, 1.2]], count: 8 }), ["#c0ccbd", "#c0ccbd", "#c0ccbd", "#c0ccbd"], closedRamp(["#2aa08c", "#15685f", "#3eb49a"]), true),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.35, harmonics: [[3, 0.07, 2.2], [6, 0.04, 0.4]], count: 8 }), ["#1d7d70", "#1d7d70", "#1d7d70", "#1d7d70"], closedRamp(["#9a2f68", "#6a2052", "#a83a6c"]), true),
    boundary(blobNodes({ cx: 0.5, cy: 0.5, rx: 0.19, ry: 0.25, harmonics: [[2, 0.1, 1], [5, 0.05, 2]], count: 8 }), ["#7c2a5e", "#7c2a5e", "#7c2a5e", "#7c2a5e"], closedRamp(["#231c60", "#14103a", "#2c2470"]), true),
    point(0.5, 0.5, "#2e2a78"),
  ]),
  preset("pour-stripes", "Pour stripes",
  "Leaning poured stripes of magenta, vermilion, ochre, viridian, cobalt and violet, each paling downward on raw canvas, after Morris Louis.",
  STRIPES.flatMap(([x0, x1, color], i) => [
    stripeEdge(x0, color, STRIPES[i - 1]?.[1] === x0 ? STRIPES[i - 1][2] : null),
    ...(STRIPES[i + 1]?.[0] === x1 ? [] : [stripeEdge(x1, null, color)]),
  ])),
  preset("noland-chevron", "Noland chevron",
  "Nested V bands of crimson, butter, sky and navy falling to a low apex over bare canvas, after Kenneth Noland.", [
    ["#c72c3c", 0.0, 0.085], ["#f2df86", 0.15, 0.06], ["#6fa8d8", 0.28, 0.1], ["#1f2f66", 0.45, 0.065], ["#e8953a", 0.6, 0.11],
  ].map(([color, top, thick]) => boundary(polylineNodes(chevronBand(top, 0.26, thick)), [NOLAND_CANVAS], [color], true))),
  preset("bend-sinister", "Bend sinister",
  "Parallel diagonal bars of vermilion, saffron, teal, ink and rose running across bare canvas, after Kenneth Noland.",
  [ground([NOLAND_CANVAS]), ...BEND.map(([u, hh, color]) => {
    const angle = Math.PI / 4, cx = 0.5 + u * Math.cos(angle + Math.PI / 2), cy = 0.5 + u * Math.sin(angle + Math.PI / 2);
    return boundary(polylineNodes(clipPolygon(rotRect(cx, cy, 1.5, hh, angle), BOX)), [NOLAND_CANVAS], [color], true);
  })]),
  preset("still-ember", "Still ember",
  "An umber-black field with a torn ochre tongue, a dried-blood core and a cream shard hanging from above, after Clyfford Still.", [
    boundary(polylineNodes([[0, 1], [0, 0.42], [0.08, 0.46], [0.1, 0.3], [0.17, 0.36], [0.2, 0.1], [0.27, 0.3], [0.31, 0.44], [0.4, 0.5], [0.42, 0.72], [0.52, 0.8], [0.54, 1]]),
      Array(4).fill(STILL_DARK), closedRamp(["#e6b23a", "#c9701e", "#f2d070"]), true),
    boundary(polylineNodes([[0.05, 0.96], [0.06, 0.7], [0.13, 0.62], [0.16, 0.46], [0.21, 0.5], [0.24, 0.36], [0.3, 0.52], [0.27, 0.7], [0.34, 0.78], [0.33, 0.96]]),
      Array(4).fill("#e6b23a"), closedRamp(["#7a1e18", "#4a1012", "#9a2a1c"]), true),
    boundary(polylineNodes([[0.7, 0], [0.92, 0], [0.9, 0.14], [0.85, 0.22], [0.87, 0.36], [0.79, 0.3], [0.77, 0.14]]), [STILL_DARK], ["#e9dcbb"], true),
  ]),
  preset("still-ultramarine", "Still ultramarine",
  "A blue-black field with a ragged cream slab down the left and a crimson flame flickering up the right, after Clyfford Still.", [
    boundary(polylineNodes([[0, 0], [0.3, 0], [0.26, 0.14], [0.34, 0.3], [0.27, 0.44], [0.36, 0.6], [0.3, 0.78], [0.37, 0.92], [0.33, 1], [0, 1]]), [STILL_NIGHT], ["#ece2c8"], true),
    boundary(polylineNodes([[0.66, 1], [0.69, 0.8], [0.68, 0.62], [0.75, 0.44], [0.77, 0.66], [0.8, 0.8], [0.82, 1]]), Array(4).fill(STILL_NIGHT), closedRamp(["#c2272d", "#e8583a", "#9c1e26"]), true),
  ]),
  // Jules Olitski: sprayed mist — a perimeter ramp diffusing inward, with a few colour flecks.
  preset("olitski-mist", "Sprayed mist",
  "A peach, lilac and mint mist sprayed from the edges inward around a rose cloud, after Jules Olitski.", [
    ground(["#f7c9a8", "#a48fd6", "#86d3c0"]),
    boundary(ellipseNodes(0.5, 0.5, 0.17, 0.23), ["#f59bb4"], null, true),
    point(0.5, 0.5, "#ffd9a0"), point(0.72, 0.3, "#fff0b0"), point(0.28, 0.72, "#ff7fa0"),
  ]),
  preset("cathedra-blue", "Cathedra blue",
  "A deep ultramarine field split by one pale sky-blue zip and a hairline of ink, after Barnett Newman's Cathedra.", [
    ground(NEWMAN_BLUE),
    zipOn(0.64, 0.036, "#22399c", "#a8c6f2"),
    zipOn(0.2, 0.012, "#1c2e88", "#0a1450"),
  ]),
  // Rothko: Magenta, Black, Green on Orange (1949) — a searing orange ground and a black slab between two cool notes.
  preset("magenta-green-orange", "Magenta and green",
  "A magenta block, a black slab and an emerald block stacked on a searing orange ground, after Rothko's Magenta, Black, Green on Orange.", [
    ground(["#e5782a"]),
    block(0.5, 0.2, 0.4, 0.13, "#c0247a"), point(0.5, 0.2, "#d8408e"),
    block(0.5, 0.47, 0.4, 0.06, "#1c1214"),
    block(0.5, 0.75, 0.4, 0.15, "#2c7a4c"), point(0.5, 0.75, "#3e9560"),
  ]),
  preset("still-crimson", "Still crimson",
  "A crimson field with a ragged black slab down the left, a bone-white shard rising from below and a saffron splinter, after Clyfford Still.", [
    boundary(polylineNodes([[0, 0], [0.4, 0], [0.34, 0.18], [0.42, 0.36], [0.3, 0.5], [0.38, 0.7], [0.28, 0.86], [0.33, 1], [0, 1]]), Array(4).fill(STILL_RED), closedRamp(["#14100f", "#2a1a18", "#0c0909"]), true),
    boundary(polylineNodes([[0.6, 1], [0.63, 0.8], [0.6, 0.66], [0.68, 0.6], [0.7, 0.76], [0.74, 0.9], [0.76, 1]]), Array(4).fill(STILL_RED), closedRamp(["#efe8d8", "#d9cfb8", "#f8f3e6"]), true),
    boundary(polylineNodes([[0.86, 0], [0.96, 0], [0.93, 0.12], [0.94, 0.24], [0.88, 0.16]]), [STILL_RED], ["#f0b830"], true),
  ]),
  // Jules Olitski: dusk spray — an indigo, plum and ember mist with one hot cloud.
  preset("olitski-dusk", "Dusk spray",
  "An indigo, plum and ember mist sprayed inward from the edges around a hot coral cloud, after Jules Olitski.", [
    ground(["#23236a", "#8a3a8c", "#e8704a"]),
    boundary(ellipseNodes(0.5, 0.52, 0.2, 0.15), ["#f2806a"], null, true),
    point(0.5, 0.52, "#ffc98a"), point(0.2, 0.3, "#5a5ad0"),
  ]),
];
