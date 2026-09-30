/**
 * "Architecture & light" — native Multipoint presets. Ando, Gaudí, Hadid, Niemeyer, Hundertwasser, Le Corbusier's polychromy and Ronchamp, shoji light and Itten's wheel.
 * Authored by the 2026-09-30 Sonnet research frenzy (round 4) from real references and style
 * manuals (sources: concerns.md, "round-4 preset merge"), curated and merged by the lead. Family-specific
 * geometry lives here; shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, spiralNodes, mixHex } from "../multipoint_shapes.js";
import { frame, shape, panel, softBlob, insetPolygon, vLine, hLine, archNodes, verticalPane, eggNodes, nodeShape, voronoiCells, roundedPolygon } from "./architecture_modern_helpers.js";

const SEAM = 0.0035;

// Ando: bare concrete room in one-point perspective, a cruciform slit through the altar wall; cool glare bleeds into grey.
const CONCRETE_DARK = "#15181c", GLARE = "#f6f9ff", BLOOM = "#c0d3ee";

const ROOM = { l: 0.2, r: 0.8, t: 0.14, b: 0.8 };

 // altar wall rectangle
const CROSS_V = [0.472, 0.5], CROSS_H = [0.4, 0.425], CROSS_BOTTOM = ROOM.b - 0.01, CROSS_LEFT = ROOM.l + 0.02, CROSS_RIGHT = ROOM.r - 0.02;

const crossPoints = [[CROSS_V[0], ROOM.t + 0.02], [CROSS_V[1], ROOM.t + 0.02], [CROSS_V[1], CROSS_H[0]], [CROSS_RIGHT, CROSS_H[0]],
  [CROSS_RIGHT, CROSS_H[1]], [CROSS_V[1], CROSS_H[1]], [CROSS_V[1], CROSS_BOTTOM], [CROSS_V[0], CROSS_BOTTOM],
  [CROSS_V[0], CROSS_H[1]], [CROSS_LEFT, CROSS_H[1]], [CROSS_LEFT, CROSS_H[0]], [CROSS_V[0], CROSS_H[0]]];

const roomPlanes = {
  back: [[ROOM.l, ROOM.t], [ROOM.r, ROOM.t], [ROOM.r, ROOM.b], [ROOM.l, ROOM.b]],
  ceiling: [[0, 0], [1, 0], [ROOM.r, ROOM.t], [ROOM.l, ROOM.t]],
  right: [[1, 0], [1, 1], [ROOM.r, ROOM.b], [ROOM.r, ROOM.t]],
  floor: [[ROOM.l, ROOM.b], [ROOM.r, ROOM.b], [1, 1], [0, 1]],
  left: [[0, 0], [ROOM.l, ROOM.t], [ROOM.l, ROOM.b], [0, 1]],
};

const plane = (points, inside, edges) => shape(insetPolygon(points, edges.map((e) => (e ? SEAM : 0))), inside, CONCRETE_DARK);

// Gaudi/Sagrada Familia: a spectrum of tall lancet lights, each glass a vertical gradient glowing against dark ribbed stone.
const VAULT_TOP = "#d9b77a", VAULT_BOTTOM = "#140c0a", STONE_SHADOW = "#241814";

// [crown glow, sill glass, oculus]: red-orange on the west, green-blue on the east.
const LANCETS = [["#ff9a5a", "#b0102a", "#ffd2a0"], ["#ffcf5a", "#e8531a", "#fff0b0"], ["#fff49a", "#f0a020", "#ffffd0"],
  ["#a6f5b0", "#1f9a5a", "#e8ffd8"], ["#8ac4ff", "#1f3fc0", "#dcecff"]];

const LANCET_TOPS = [0.34, 0.26, 0.2, 0.26, 0.34];

const lancet = ([crown, sill, oculus], i) => {
  const cx = 0.14 + 0.18 * i, top = LANCET_TOPS[i];
  return [boundary(archNodes(cx - 0.06, cx + 0.06, top, 0.95, 0.09), [mixHex(sill, STONE_SHADOW, 0.55), STONE_SHADOW, mixHex(sill, STONE_SHADOW, 0.55)], [crown, sill, crown], true),
    point(cx, top - 0.07, oculus)];
};

// Zaha Hadid, Heydar Aliyev auditorium: nested flowing wood bands swelling around the stage opening, lit along each lip.
// [cx, cy, top, right, bottom, left radii, squareness] per nested ring, then the band colour (ramps) between it and the next.
const FLOW_RINGS = [[0.5, 0.5, [0.47, 0.47, 0.47, 0.47], 0.72], [0.52, 0.49, [0.37, 0.4, 0.44, 0.43], 0.7], [0.54, 0.47, [0.29, 0.33, 0.39, 0.38], 0.68],
  [0.55, 0.45, [0.215, 0.26, 0.335, 0.33], 0.66], [0.55, 0.44, [0.15, 0.2, 0.26, 0.27], 0.64], [0.55, 0.43, [0.085, 0.13, 0.17, 0.16], 0.6]];

// Each plate is a gradient from a dark outer edge to a lit inner lip; the next plate starts dark again, so the ribbons read as overlapped.
const FLOW_PLATES = [["#1c0f07", "#4a2810"], ["#5a3214", "#b27a34"], ["#7d4a1a", "#d6a24e"], ["#a0672a", "#eec06a"], ["#c48a3c", "#fbe0a0"]];

const FLOW_STAGE = ["#0e0805", "#d9b98a", "#0e0805", "#0e0805"];

// Niemeyer, Cathedral of Brasilia: sixteen white concrete ribs curving up to a crown, blue glass wedges between them (eight drawn).
const RIB_WHITE = ["#f8f8f4", "#d4d8da", "#f8f8f4", "#f8f8f4"];

const GLASS_SETS = [["#e6f7ff", "#1b3fd0", "#22b8da", "#e6f7ff"], ["#ffffff", "#9fd6ea", "#56c4dc", "#ffffff"]];

const WEDGE_HALF = Math.PI / 16, WEDGE_INNER = 0.13, BOX_REACH = 0.485;

/** Pure function. Distance from the centre along `angle` to the box border, inset by BOX_REACH. @example boxRadius(0) // 0.485 */
const boxRadius = (angle) => BOX_REACH / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));

const glassWedge = (k) => {
  const mid = Math.PI / 8 + k * Math.PI / 4, a0 = mid - WEDGE_HALF, a1 = mid + WEDGE_HALF;
  const at = (angle, r) => [0.5 + r * Math.cos(angle), 0.5 + r * Math.sin(angle)];
  return shape([at(a0, WEDGE_INNER), at(a0, boxRadius(a0)), at(a1, boxRadius(a1)), at(a1, WEDGE_INNER)], GLASS_SETS[k % 2].slice(0, 3), RIB_WHITE.slice(0, 3));
};

// Hundertwasser, Hundertwasserhaus: uneven patches of soft plaster with rounded corners, each edged by a stripe of navy and white tile.
const HW_TILE = ["#1f2f66", "#8fa4d8", "#1f2f66"];

const HW_SITES = [[0.17, 0.2], [0.55, 0.12], [0.86, 0.3], [0.3, 0.55], [0.68, 0.6], [0.14, 0.88], [0.55, 0.9]];

const HW_PLASTER = [["#7fa0e6", "#4a6fc8"], ["#eeb95e", "#d8923a"], ["#e58aa0", "#c95c7c"], ["#d6d6d8", "#b3b3b8"], ["#9dc08a", "#6a9a5c"], ["#d98a5c", "#b25a34"], ["#7fa0e6", "#4a6fc8"]];

// Japanese shoji at dusk: a row of tall paper panes lit from behind by one lamp, brightest in the middle.
const SHOJI_WOOD = "#2c1d15", SHOJI_PANE_W = 0.15, SHOJI_PITCH = 0.18, SHOJI_LEFT = 0.065;

// [top, bottom] paper colours, dimmer toward the edges (distance from the lamp).
const SHOJI_PAPER = [["#f4d9a6", "#c98846"], ["#fbe6bc", "#e0a45a"], ["#fff6de", "#f4c77e"], ["#fbe6bc", "#e0a45a"], ["#f4d9a6", "#c98846"]];

const shojiX = (i) => [SHOJI_LEFT + SHOJI_PITCH * i, SHOJI_LEFT + SHOJI_PITCH * i + SHOJI_PANE_W];

// Bauhaus, Johannes Itten's twelve-part colour circle (yellow at the top, hues clockwise), cut into wedges on warm paper.
const ITTEN_PAPER = "#f1ead9";

const ITTEN_HUES = ["#fde82e", "#fcc01f", "#f58a1c", "#e9571f", "#d9262b", "#a8206a", "#6a2c91", "#3f3a9c", "#2150b0", "#1a8aa0", "#2fa055", "#a4c93a"];

const ITTEN_GAP = 0.02, ITTEN_RADIUS = 0.47, ITTEN_APEX = 0.07;

const ittenWedge = (hue, k) => {
  const step = Math.PI / 6, mid = -Math.PI / 2 + k * step, a0 = mid - step / 2 + ITTEN_GAP, a1 = mid + step / 2 - ITTEN_GAP;
  const at = (angle, r) => [0.5 + r * Math.cos(angle), 0.5 + r * Math.sin(angle)];
  return shape([at(mid, ITTEN_APEX), at(a0, ITTEN_RADIUS), at(a1, ITTEN_RADIUS)], [mixHex(hue, "#ffffff", 0.55), hue, hue], ITTEN_PAPER);
};

// Le Corbusier, Unite d'Habitation: deep loggias each painted one polychromie colour, set in raw board-formed concrete.
const CORB_CONCRETE = ["#bab5a9", "#8c877c", "#ada89c"];

const CORB_COLOURS = [["#d4413a", "#7a1c22"], ["#f3efe2", "#a9a596"], ["#f4bd2a", "#9a6a10"], ["#2f62b4", "#15305e"], ["#e0702a", "#7c3410"],
  ["#3f8f58", "#154a2c"], ["#f4bd2a", "#9a6a10"], ["#d4413a", "#7a1c22"], ["#2f62b4", "#15305e"]];

// Irregular Modulor-like column and row spans (concrete gaps of 0.04 between them).
const CORB_COLS = [[0.06, 0.3], [0.34, 0.68], [0.72, 0.94]], CORB_ROWS = [[0.06, 0.4], [0.44, 0.62], [0.66, 0.94]];

const corbLoggia = ([light, shade], i) => {
  const [x0, x1] = CORB_COLS[i % 3], [y0, y1] = CORB_ROWS[Math.floor(i / 3)];
  return panel(x0, y0, x1, y1, [shade, light, light], "#9c978b");
};

// Le Corbusier, Ronchamp south wall: deep splayed openings in limewashed concrete, each pane throwing its own colour into the reveal.
const RONCHAMP_WALL = ["#f4f0e4", "#d5cfc0", "#ece7da"];

// [outer reveal rect, inner glass rect, glass colour]: the glass sits off-centre, which is the splay.
const RONCHAMP_WINDOWS = [[[0.07, 0.08, 0.43, 0.47], [0.2, 0.15, 0.32, 0.33], "#2d5fd0"], [[0.54, 0.05, 0.8, 0.31], [0.62, 0.11, 0.69, 0.2], "#d8342b"],
  [[0.58, 0.44, 0.93, 0.74], [0.71, 0.5, 0.82, 0.63], "#f4c22a"], [[0.09, 0.6, 0.45, 0.92], [0.2, 0.68, 0.32, 0.81], "#2f9a5e"]];

const ronchampWindow = ([[ox0, oy0, ox1, oy1], [ix0, iy0, ix1, iy1], glass]) => [
  panel(ox0, oy0, ox1, oy1, ["#bdb6a5", "#ece6d6", "#b3ac9b"], RONCHAMP_WALL[1]),
  panel(ix0, iy0, ix1, iy1, [mixHex(glass, "#ffffff", 0.15), glass, mixHex(glass, "#000000", 0.25)], mixHex(glass, "#fff7e6", 0.7)),
];

// Brutalism in raking light: board-formed concrete ribs, each lit along its near edge and shadowed on its far one.
// Two-sided vertical lines put the dark far edge of one rib and the lit near edge of the next on either side of one seam,
// so the field between seams is an exact sawtooth; single-sided pins on the box edges close the first and last rib.
const RAKE_LIT = "#efe7d5", RAKE_SHADE = "#4f4a42", RAKE_DEEP = "#1e1c19";

const RAKE_SEAMS = [0.085, 0.17, 0.262, 0.345, 0.44, 0.525, 0.615, 0.7, 0.795, 0.89];

 // rib boundaries, deliberately uneven (boards)
const RAKE_OVERHANG = [0.55, 0.22, 0.08, 0];

 // darkening by height (bottom -> top): a slab above shades the top of every rib
const rakeTone = (x, base, weight = 1) => RAKE_OVERHANG.map((shadow) => mixHex(mixHex(base, RAKE_DEEP, x * 0.72), RAKE_DEEP, Math.min(1, shadow * weight)));

const rakeSeam = (x) => boundary(vLine(x), rakeTone(x, RAKE_SHADE, 0.6).reverse(), rakeTone(x, RAKE_LIT, 0.6).reverse());

// Hundertwasser, spiral paintings: a two-armed spiral whose interleaved bands run hot (red, pink, gold) and cool (blue, green, teal).
const HW_HOT = ["#d8242a", "#f07ab0", "#f7d21a", "#f08a1c"], HW_COOL = ["#2a4fb5", "#2f9d48", "#19a6b8", "#6a3fa8"], HW_GROUND = "#e9b73c";

// Both sides of an arm fade to the ground colour at its outer tip, so the tip vanishes instead of leaving a colour seam.
const fadeTip = (ramp) => [...ramp.slice(0, 3), HW_GROUND];

const hwArm = (phase) => boundary(spiralNodes({ cx: 0.5, cy: 0.5, startRadius: 0.035, endRadius: 0.45, turns: 1.5, phase }),
  fadeTip(phase === 0 ? HW_HOT : HW_COOL), fadeTip(phase === 0 ? HW_COOL : HW_HOT));

export const PRESETS = [
  preset("church-of-light", "Church of the Light", "A cruciform slit of cool glare blooming into grey board-formed concrete, after Tadao Ando.", [
    plane(roomPlanes.back, ["#4d565e", "#6b747c", "#3a4148"], [1, 1, 1, 1]),
    plane(roomPlanes.ceiling, ["#3d444a", "#555c63", "#33393f"], [0, 1, 1, 1]),
    plane(roomPlanes.right, "#23282d", [0, 1, 1, 1]),
    plane(roomPlanes.floor, "#0f1114", [1, 1, 0, 1]),
    plane(roomPlanes.left, "#2b3035", [1, 1, 1, 0]),
    shape(crossPoints, GLARE, BLOOM),
    softBlob([[0.03, 0.16], [0.12, 0.2], [0.12, 0.33], [0.03, 0.3]], "#aebfd4"),
    softBlob([[0.475, 0.83], [0.525, 0.83], [0.565, 0.93], [0.435, 0.93]], "#5d6a79"),
  ]),
  preset("sagrada-nave", "Nave windows", "A spectrum of tall leaded lancets, red and amber in the west to green and blue in the east, glowing in dark ribbed stone, after Gaudi's Sagrada Familia.", [
    boundary(hLine(0), [VAULT_TOP]), boundary(hLine(1), [VAULT_BOTTOM]),
    ...LANCETS.flatMap(lancet),
  ]),
  preset("zaha-auditorium", "Flowing auditorium", "Overlapping ribbons of amber timber swelling around a dark stage opening, each lip lit gold, after Zaha Hadid.",
    FLOW_RINGS.map(([cx, cy, radii, squareness], i) => {
      const outside = i ? FLOW_PLATES[i - 1][1] : FLOW_PLATES[0][0], inside = i < FLOW_PLATES.length ? FLOW_PLATES[i][0] : null;
      return boundary(eggNodes(cx, cy, radii, squareness), [outside, outside, outside, outside], inside ? [inside, inside, inside, inside] : FLOW_STAGE, true);
    })),
  preset("brasilia-crown", "Hyperboloid crown", "Blue and turquoise glass wedges between white concrete ribs fanning from a pale crown, after Oscar Niemeyer's cathedral.", [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(glassWedge),
    boundary(ellipseNodes(0.5, 0.5, 0.085), ["#f8f8f4", "#f8f8f4", "#f8f8f4"], ["#fff8e6", "#cfc29f", "#fff8e6"], true),
  ]),
  preset("hundertwasser-wall", "Patchwork house", "Uneven rounded patches of blue, ochre, rose and green plaster, each edged with a stripe of navy and white tile, after Hundertwasser.",
    voronoiCells(HW_SITES, 0.055).map((cell, i) => nodeShape(roundedPolygon(cell, 0.08), [HW_PLASTER[i][0], HW_PLASTER[i][1], HW_PLASTER[i][0]], HW_TILE))),
  preset("shoji-dusk", "Shoji glow", "Five tall paper panes in dark lattice wood, one lamp behind them glowing brightest in the middle.", [
    ...SHOJI_PAPER.map(([top, bottom], i) => verticalPane(...shojiX(i).slice(0, 1), 0.3, shojiX(i)[1], 0.94, top, bottom, SHOJI_WOOD)),
    ...[[0.065, 0.345, 0], [0.365, 0.635, 2], [0.655, 0.935, 4]].map(([x0, x1, i]) => panel(x0, 0.06, x1, 0.26, [mixHex(SHOJI_PAPER[i][0], "#ffffff", 0.4), SHOJI_PAPER[i][0], mixHex(SHOJI_PAPER[i][0], "#ffffff", 0.4)], SHOJI_WOOD)),
  ]),
  preset("itten-wheel", "Colour circle", "Twelve pure hues from yellow round to yellow-green as paper-cut wedges, after the Bauhaus teacher Johannes Itten.", ITTEN_HUES.map(ittenWedge)),
  preset("unite-loggias", "Loggia colours", "Nine deep loggias in red, yellow, blue and green polychromy set in raw board-formed concrete, after Le Corbusier.", [
    frame(CORB_CONCRETE),
    ...CORB_COLOURS.map(corbLoggia),
  ]),
  preset("ronchamp-wall", "Window wall", "Deep splayed openings in limewashed concrete, each coloured pane spilling its own light across the reveal, after Ronchamp.", [
    frame(RONCHAMP_WALL),
    ...RONCHAMP_WINDOWS.flatMap(ronchampWindow),
  ]),
  preset("raking-concrete", "Raking light", "Board-formed concrete ribs, each lit along its near edge and shadowed on the far one as low sun rakes across.", [
    boundary(vLine(0), rakeTone(0, RAKE_LIT, 0.6).reverse()),
    ...RAKE_SEAMS.map(rakeSeam),
    boundary(vLine(1), rakeTone(1, RAKE_SHADE, 0.6).reverse()),
  ]),
  preset("hundertwasser-spiral", "Spiral of life", "A two-armed spiral of interleaved hot and cool bands growing from a gold heart, after Hundertwasser's spiral paintings.", [
    hwArm(0), hwArm(Math.PI), point(0.5, 0.5, HW_GROUND),
  ]),
];
