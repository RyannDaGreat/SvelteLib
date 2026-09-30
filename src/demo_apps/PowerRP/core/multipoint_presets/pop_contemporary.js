/**
 * "Pop & contemporary" — native Multipoint presets. Hockney, Warhol, Lichtenstein, Kusama, Haring, Murakami and Peter Max.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { ellipseNodes, rectNodes } from "../multipoint_shapes.js";
import { leafNodes, polar } from "./art_homages.js";
import { graphNodes, hLine, bandStack, poly, disc, shaded } from "./surreal_pop_helpers.js";

const FULL_TURN = 2 * Math.PI;

/** Pure function. Closed rectangle feature, outside/inside colours. @example panel(0,0,1,1,"#000","#fff").nodes.length // 4 */
const panel = (x0, y0, x1, y1, outside, inside) => boundary(rectNodes(x0, y0, x1, y1), [outside], [inside], true);

export const PRESETS = [
  // Hockney, Portrait of an Artist / Peter Getting Out of Nick's Pool: wavering water-light lines, crisp blue bands.
  preset("hockney-pool-ripples", "Hockney ripples", "Wavering turquoise, aqua and white water-light bands in a sunlit California pool.",
    bandStack([0.16, 0.34, 0.5, 0.68, 0.84].map((y, i) =>
      graphNodes((x) => y + 0.05 * Math.sin(FULL_TURN * 1.25 * x + i * 1.3), 6)),
    ["#1a9bd4", "#7fd6ee", "#0f83c0", "#f2fbfd", "#1a9bd4", "#0d78b8"])),
  // Warhol, Flowers (1964): one neon blossom of four petals on a blurred dark-green ground with two leaves.
  preset("warhol-flowers", "Warhol flowers", "A neon four-petal blossom with a lemon heart and two leaves on a near-black green ground.", [
    boundary(rectNodes(0, 0, 1, 1), ["#12301b"], null, true),
    ...[[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => shaded(ellipseNodes(0.5 + 0.19 * dx, 0.44 + 0.19 * dy, 0.115), "#14341e",
      ["#ff7ab6", "#d81b78", "#ffa0cc"])),
    disc(0.5, 0.44, 0.07, "#e8206e", "#f8e21e"),
    boundary(leafNodes(0.1, 0.96, 0.32, 0.78, 0.1), ["#12301b"], ["#3d9a52"], true),
    boundary(leafNodes(0.92, 0.96, 0.68, 0.8, 0.1), ["#12301b"], ["#57b25f"], true),
  ]),
  // Lichtenstein, Ben-Day dots: the newspaper printer's dot as the picture itself, red on cream, in staggered rows.
  preset("lichtenstein-ben-day-dots", "Ben-Day dots", "Staggered rows of big red printer's dots on a cream ground, as in a blown-up comic panel.",
    [[0.2, 0.2, 0.06], [0.5, 0.2, 0.06], [0.8, 0.2, 0.06], [0.35, 0.5, 0.085], [0.65, 0.5, 0.085], [0.2, 0.8, 0.11], [0.5, 0.8, 0.11], [0.8, 0.8, 0.11]]
      .map(([cx, cy, r]) => disc(cx, cy, r, "#f6dfd2", "#e5202a"))),
  // Lichtenstein, Drowning Girl: navy and pale-blue comic waves in crisp bands with black-blue shadows.
  preset("lichtenstein-comic-waves", "Comic waves", "Crisp navy, cornflower and paper-white comic waves with dark blue shadow bands.",
    bandStack([0.22, 0.42, 0.62, 0.8].map((y, i) =>
      graphNodes((x) => y + 0.07 * Math.sin(FULL_TURN * 1.25 * x + i * 1.9) + 0.02 * Math.sin(FULL_TURN * 2.5 * x + i), 8)),
    ["#f4efe2", "#b6c6e6", "#1c2a8c", "#dfe6f4", "#101a5c"])),
  // Kusama, yellow dot fields: black dots of every size floating on a saturated yellow, an infinity of them.
  preset("kusama-dot-field", "Kusama dot field", "Black polka dots of every size swimming on a saturated yellow.", [
    [0.16, 0.18, 0.09], [0.5, 0.12, 0.05], [0.82, 0.2, 0.11], [0.32, 0.42, 0.06], [0.66, 0.5, 0.08],
    [0.14, 0.68, 0.11], [0.44, 0.72, 0.07], [0.8, 0.84, 0.06], [0.52, 0.92, 0.04],
  ].map(([cx, cy, r]) => disc(cx, cy, r, "#f8c414", "#131110"))),
  // Haring, Radiant Baby: rays of thick black strokes around a red sun on a hot yellow field.
  preset("haring-radiant-rays", "Haring radiant", "Bold black rays radiating from a red and blue sun on a hot yellow field.", [
    boundary(hLine(0), ["#fbe03a"]),
    ...Array.from({ length: 9 }, (_, i) => {
      const a = FULL_TURN * i / 9 - Math.PI / 2, w = 0.12;
      return poly([polar(0.5, 0.5, 0.2, a + w), polar(0.5, 0.5, 0.46, a), polar(0.5, 0.5, 0.2, a - w)].reverse(), "#fbe03a", "#101010");
    }),
    disc(0.5, 0.5, 0.17, "#fbe03a", "#e8322a"),
    disc(0.5, 0.5, 0.07, "#e8322a", "#1f6fd0"),
  ]),
  // Murakami, Superflat flowers: rainbow petals with a yellow face on a candy sky.
  preset("murakami-smile-flower", "Superflat flower", "A flat five-petal flower in pink, yellow, orange, blue and lilac with a yellow face on a candy sky.", [
    boundary(hLine(0), ["#a8e0ff"]),
    ...["#ff5ea8", "#ffd21f", "#ff8a2a", "#4cc7ff", "#a06cf6"].map((color, i) => {
      const [x, y] = polar(0.5, 0.5, 0.27, FULL_TURN * i / 5 - Math.PI / 2);
      return disc(x, y, 0.14, "#a8e0ff", color);
    }),
    disc(0.5, 0.5, 0.16, "#f6f0c8", "#ffe92a"),
    disc(0.44, 0.46, 0.02, "#ffe92a", "#141414", 0.035),
    disc(0.56, 0.46, 0.02, "#ffe92a", "#141414", 0.035),
  ]),
  // Peter Max, cosmic rings: concentric psychedelic bands drifting off-centre, hot yellow to violet to night.
  preset("petermax-cosmic-rings", "Peter Max rings", "Off-centre concentric bands of yellow, orange, hot pink, violet and cyan around a night-blue edge.", [
    boundary(rectNodes(0, 0, 1, 1), ["#101a6a"], null, true),
    ...[["#101a6a", "#22d0e8", 0.44, 0.5, 0.5], ["#22d0e8", "#8a3ff0", 0.36, 0.52, 0.48], ["#8a3ff0", "#ff3d9a", 0.28, 0.54, 0.47],
      ["#ff3d9a", "#ff8a1f", 0.2, 0.55, 0.46], ["#ff8a1f", "#ffe32a", 0.12, 0.56, 0.45]]
      .map(([outside, inside, r, cx, cy]) => disc(cx, cy, r, outside, inside)),
  ]),
  // Peter Max, Cosmic Runner: flowing rainbow ribbons in hot pink, orange, yellow, aqua and violet.
  preset("petermax-rainbow-flow", "Peter Max flow", "Flowing psychedelic ribbons of hot pink, orange, lemon, aqua and violet, swirled like a cosmic runner.",
    bandStack([0.2, 0.42, 0.64, 0.84].map((y, i) =>
      graphNodes((x) => y + 0.1 * Math.sin(FULL_TURN * 0.8 * x + 0.7 * i + 0.4) * (0.7 + x * 0.6), 8)),
    ["#3a1f9a", "#ff3d9a", "#ff8a1f", "#ffe32a", "#22d0e8"])),
];
