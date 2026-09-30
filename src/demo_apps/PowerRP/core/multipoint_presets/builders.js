/**
 * Feature/paint builders shared by every Multipoint preset family: authored rows
 * become native features {nodes, stops, twoSided, closed, weight} with even
 * arc-length stops, and entries become {id, label, description, paint}.
 */
import { MULTIPOINT_TYPE, multipointFeature } from "../multipoint.js";
import { ellipseNodes } from "../multipoint_shapes.js";

const GLOW_SHOULDER_RATIO = 0.55;

/**
 * Pure function. Builds a feature with independent, evenly spaced arc-length stops.
 * Explicit right palette means two-sided; a single palette constrains both sides.
 * @param {number[][]} nodes - [N,6] geometry, copied into the result.
 * @param {string[]} colors - Main/left colors; one color means a constant boundary.
 * @param {string[]|null} rightColors - Matching opposite-side palette, or null.
 * @param {boolean} closed - Connect last node to first.
 * @returns {object} Editable native feature with unit weight.
 * @example boundary(ellipseNodes(0.5,0.5,0.2), ["#ff0000"], null, true).closed // true
 */
export function boundary(nodes, colors, rightColors = null, closed = false) {
  if (!colors.length || (rightColors && rightColors.length !== colors.length))
    throw new Error("Boundary palettes must be nonempty with matching lengths");
  return { nodes: nodes.map((node) => [...node]), stops: colors.map((color, i) => ({
    offset: colors.length === 1 ? 0 : i / (colors.length - 1), color, rightColor: rightColors ? rightColors[i] : color,
  })), twoSided: rightColors !== null, closed, weight: 1 };
}

/**
 * Pure function. A point source at a chosen anchor, using the native point schema.
 * @param {number} x - Anchor x.
 * @param {number} y - Anchor y.
 * @param {string} color - Main color.
 * @returns {object} Feature with [1,6] nodes and one stop.
 * @example point(0.2,0.3,"#ff0000").nodes // [[0.2,0.3,0,0,0,0]]
 */
export function point(x, y, color) {
  return { ...multipointFeature("point", color), nodes: [[x, y, 0, 0, 0, 0]] };
}

/**
 * Pure function. Concentric glow constraints: light center, colored shoulder, dark rim.
 * The contours share their center geometrically; no hidden linkage or radius field.
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} radius - Outer contour radius.
 * @param {string[]} colors - [center,shoulder,rim] palette.
 * @returns {object[]} Three editable features, with 1 + 4 + 4 nodes.
 * @example glow(0.5,0.5,0.2,["#ffffff","#ff8800","#221100"]).length // 3
 */
export function glow(cx, cy, radius, [center, shoulder, rim]) {
  return [point(cx, cy, center),
    boundary(ellipseNodes(cx, cy, radius * GLOW_SHOULDER_RATIO), [shoulder], null, true),
    boundary(ellipseNodes(cx, cy, radius), [rim], null, true)];
}

/**
 * Pure function. Wraps authored features in the public stored-paint schema.
 * @param {string} id - Permanent kebab-case key, independent of display text.
 * @param {string} label - Menu label.
 * @param {string} description - Authored design intent, not a render guarantee.
 * @param {object[]} features - Native features; owned by the new entry.
 * @returns {object} {id,label,description,paint}.
 * @example preset("red-dot","Red dot","Single red source",[point(0.5,0.5,"#f00")]).paint.type // "multipointGradient"
 */
export function preset(id, label, description, features) {
  return { id, label, description, paint: { type: MULTIPOINT_TYPE, multipoint: { features } } };
}
