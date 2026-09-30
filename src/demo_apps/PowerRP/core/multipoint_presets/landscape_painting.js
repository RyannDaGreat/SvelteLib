/**
 * "Landscape painting" — native Multipoint presets. Landscape painting traditions, beginning with Friedrich.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { catmullRomNodes } from "../multipoint_shapes.js";
import { skyField, floor, row } from "./skies_helpers.js";

export const PRESETS = [
  (() => {
    const H = 0.76, sky = skyField(["#7a929a", "#bcc3bd", "#7d8a84", "#213c2e"], [0, 0.4, 0.78, 1], H);
    return preset("monk-by-the-sea", "Monk by the sea", "Friedrich's 1810 Monk by the Sea: a luminous grey-teal sky sinking into a black-green squall band over a dark sea and a pale strip of dune.", [
      ...sky.rails, row(0.2, [sky.at(0.2)]), row(0.4, [sky.at(0.4), "#e2e4dd", sky.at(0.4)], { sag: -0.02 }), row(0.58, [sky.at(0.58)]),
      boundary(catmullRomNodes([[0, H], [0.5, H - 0.004], [1, H]]), ["#213c2e"], ["#0d2216"]),
      boundary(catmullRomNodes([[0, 0.91], [0.3, 0.9], [0.6, 0.915], [1, 0.9]]), ["#0d2216"], ["#c1b9a0"]),
      floor(["#5e5a44"]),
    ]);
  })(),
];
