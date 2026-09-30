/**
 * "Architecture & light" — native Multipoint presets. Coloured walls and light in built space, beginning with Barragán.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary } from "./builders.js";
import { polylineNodes } from "../multipoint_shapes.js";
import { facet, boxEdge, box } from "./architecture_helpers.js";

const JOINT_WHITE = "#f3eee4";

export const PRESETS = [
  // Cuadra San Cristobal (ref barragan_cuadra.jpg): a hot-pink portal over sand, an aqua pool seen through it.
  preset("barragan-pink-wall", "Barragan pink wall", "A hot-pink stucco portal opening on an aqua pool and long low house, over raw-sienna sand.", [
    boxEdge("top", ["#c8d0d8", "#d6dce2"]),
    boxEdge("bottom", ["#c58a6c", "#b9795f"]),
    boundary(polylineNodes([[0, 0.2], [1, 0.2], [1, 0.8], [0.84, 0.8], [0.84, 0.44], [0.16, 0.44], [0.16, 0.8], [0, 0.8]]),
      ["#cfd6dd", "#cfd6dd", "#cfd6dd", "#cfd6dd"], ["#ee5a94", "#e63e80", "#d92f70", "#ee5a94"], true),
    box(0.3, 0.5, 0.7, 0.545, "#7a5a44", "#d4dbe0"),
    box(0.3, 0.553, 0.7, 0.6, "#f4eee4", "#d4dbe0"),
    box(0.2, 0.635, 0.8, 0.672, "#a6e6e0", "#cfe6e6"),
    box(0.2, 0.68, 0.8, 0.735, "#4fb2b3", "#cfe6e6"),
    boundary(polylineNodes([[0.18, 0.79], [0.82, 0.79]]), ["#cfa080"]),
  ]),
  // Casa Gilardi corridor: yellow, magenta, white reveals and a cobalt pool.
  preset("barragan-gilardi", "Barragan corridor", "A yellow wall, a magenta wall and a cobalt pool receding between white reveals.", [
    facet([[0, 0], [0.32, 0.2], [0.32, 0.72], [0, 1]].map(([x, y]) => [x, y]), "#f6c62c", JOINT_WHITE),
    facet([[1, 0], [0.68, 0.2], [0.68, 0.72], [1, 1]], "#d0327f", JOINT_WHITE),
    facet([[0.02, 0], [0.98, 0], [0.66, 0.18], [0.34, 0.18]], "#f3eef0", JOINT_WHITE),
    facet([[0.34, 0.2], [0.66, 0.2], [0.66, 0.7], [0.34, 0.7]], "#e88fbb", JOINT_WHITE),
    facet([[0.34, 0.72], [0.66, 0.72], [0.82, 0.86], [0.18, 0.86]], "#4f7ee0", JOINT_WHITE),
    facet([[0.16, 0.88], [0.84, 0.88], [0.98, 1], [0.02, 1]], "#1b3da8", JOINT_WHITE),
  ]),
];
