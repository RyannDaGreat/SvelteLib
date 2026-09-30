/**
 * "Botanical art" — native Multipoint presets. Botanical art and printed florals, beginning with Morris.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes } from "../multipoint_shapes.js";
import { blossomNodes, leafNodes, frame } from "./botanical_helpers.js";

// A leaf/petal has two anchors (tip, base): a closed ramp [a, b, a] runs tip -> base -> tip.
const tipToBase = (tip, base) => [tip, base, tip];

const leaf = (cx, cy, length, width, angle, taper, ground, tip, base) =>
  boundary(leafNodes({ cx, cy, length, width, angle, taper }), tipToBase(ground, ground), tipToBase(tip, base), true);

export const PRESETS = [
  // Morris, The Strawberry Thief (1883): indigo-discharge ground, madder-pink blossoms, woad-blue acanthus, berry red.
  preset("strawberry-thief-indigo", "Strawberry thief indigo", "William Morris's indigo-discharge ground with madder-pink blossoms, woad-blue acanthus leaves and berry-red fruit.", [
    frame(["#26307a"]),
    point(0.3, 0.3, "#f6e6c8"),
    boundary(blossomNodes({ cx: 0.3, cy: 0.3, radius: 0.22, depth: 0.3, petals: 6, phase: 0.3 }), ["#26307a"], ["#ee9c8a"], true),
    boundary(ellipseNodes(0.3, 0.3, 0.05), ["#ee9c8a"], ["#e8b04a"], true),
    point(0.72, 0.7, "#f6e6c8"),
    boundary(blossomNodes({ cx: 0.72, cy: 0.7, radius: 0.19, depth: 0.3, petals: 5, phase: 1.1 }), ["#26307a"], ["#ee9c8a"], true),
    leaf(0.72, 0.24, 0.36, 0.15, 2.4, 0.4, "#26307a", "#a9bcf0", "#5670c0"),
    leaf(0.24, 0.74, 0.36, 0.15, -0.6, 0.4, "#26307a", "#a9bcf0", "#5670c0"),
    point(0.5, 0.5, "#c0243c"), point(0.58, 0.44, "#c0243c"),
  ]),
];
