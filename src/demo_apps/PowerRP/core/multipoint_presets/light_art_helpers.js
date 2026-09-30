/**
 * Geometry and paint helpers shared by the "Light art" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { finiteGeometry } from "../multipoint_shapes.js";
import { sampledNodes } from "./swirls.js";

const DIFFERENCE_STEP = 1e-6;

/**
 * Pure function. Editable nodes for a parametric curve pushed a constant distance along its LEFT normal
 * (screen-up for eastward travel, y down), with tangents by central difference — parallel guard / halo curves.
 * @param {function} curve - t -> [x, y] in the unit box.
 * @param {number} t0 - First parameter.
 * @param {number} t1 - Last parameter (> t0).
 * @param {number} spans - Positive integer cubic count (spans + 1 nodes).
 * @param {number} offset - Signed distance; positive = left of travel.
 * @returns {number[][]} [spans+1, 6] tuples.
 * @example offsetCurveNodes((t) => [t, 0.5], 0, 1, 2, 0.1)[0].slice(0, 2) // [0,0.4]
 */
export function offsetCurveNodes(curve, t0, t1, spans, offset) {
  finiteGeometry([t0, t1, spans, offset]);
  if (!(t1 > t0) || !Number.isInteger(spans) || spans < 1) throw new Error("offsetCurveNodes needs t1 > t0 and a positive integer span count");
  const at = (t) => {
    const [x, y] = curve(t), [xa, ya] = curve(t - DIFFERENCE_STEP), [xb, yb] = curve(t + DIFFERENCE_STEP), len = Math.hypot(xb - xa, yb - ya);
    if (!len) throw new Error("offsetCurveNodes needs a regular curve (nonzero speed)");
    // Left of travel on a y-down screen: (dy, -dx) / |d|.
    return [x + offset * (yb - ya) / len, y - offset * (xb - xa) / len];
  };
  return sampledNodes((t) => {
    const [x, y] = at(t), [xa, ya] = at(t - DIFFERENCE_STEP), [xb, yb] = at(t + DIFFERENCE_STEP);
    return [x, y, (xb - xa) / (2 * DIFFERENCE_STEP), (yb - ya) / (2 * DIFFERENCE_STEP)];
  }, t0, t1, spans);
}
