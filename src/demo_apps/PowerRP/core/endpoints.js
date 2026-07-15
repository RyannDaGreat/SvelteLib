/**
 * Endpoint-pair capability — ONE home (manifest rule: "things that can be
 * generic should be, and generic things need a designated place") for the
 * plumbing shared by every widget whose geometry hangs off point-valued
 * properties like an arrow's from/to: {x, y} pairs whose coordinates may be
 * EQUATIONS (anchor bindings — THE UNIFICATION). Plugins may not import each
 * other (registry rule), so before this module existed the arrow variants
 * copied these hooks verbatim (plugins/arrow.js ↔ plugins/fancy_arrow.js).
 * Every arrow-family widget (arrow, fancy arrow, future elbow/curved
 * variants — manifest Round 12B) spreads endpointPairHooks() and adds only
 * its own geometry.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { distToSegment } from "./outline.js";

/**
 * Extra grab slack around a shaft segment, in world px — a hairline shaft
 * stays clickable. One home for the pad both arrow plugins carried as a
 * literal `+ 5` (same value, same screen-feel rationale).
 */
export const SHAFT_GRAB_PAD = 5;

/**
 * Fraction of a head's length the shaft stops short of the tip — the shaft
 * end sits INSIDE the head triangle, so shaft and head always overlap
 * seamlessly (and a round shaft cap never pokes past the tip). Originated in
 * arrow.js as a local constant (0.6, same value/semantics preserved here
 * verbatim) — promoted to this shared home now that elbow/curved arrows and
 * headMode's mirrored start-head all need the identical pullback math
 * (manifest ARCHITECTURE PLAN #6: headMode on ALL arrow kinds).
 */
export const SHAFT_PULLBACK = 0.6;

/**
 * Pure function. Editable-point descriptors for the editor's draggable
 * endpoint handles: the generic editable-point interface (the editor writes
 * values into state[key].x/.y — numbers when free, equation strings when
 * dropped on an anchor; the UI never special-cases arrows).
 *
 * Args:
 *     state (object): item state holding {x, y} pairs at `keys`
 *     keys (string[]): the point-valued property names, in handle order
 *
 * Returns:
 *     {key, x, y}[]
 *
 * @example endpointEditPoints({from: {x: 1, y: 2}, to: {x: 3, y: 4}}) // [{key: "from", x: 1, y: 2}, {key: "to", x: 3, y: 4}]
 */
export function endpointEditPoints(state, keys = ["from", "to"]) {
  return keys.map((key) => ({ key, x: state[key].x, y: state[key].y }));
}

/**
 * Pure function. Shaft-drag translation (manifest round 5: "dragging the
 * middle should move BOTH endpoints"). Takes the RAW stored state and
 * returns [pathWithinItem, value] pairs for every FREE (numeric) endpoint
 * coordinate; equation-bound coordinates are anchored and stay put — a
 * widget with every endpoint bound doesn't move from a shaft drag.
 *
 * @example endpointMoveBy({from: {x: 0, y: 0}, to: {x: 10, y: "@c1_tm.y"}}, 5, 2) // [[["from","x"],5],[["from","y"],2],[["to","x"],15]]
 */
export function endpointMoveBy(state, dx, dy, keys = ["from", "to"]) {
  const pairs = [];
  for (const end of keys)
    for (const coord of ["x", "y"]) {
      const v = state[end]?.[coord];
      if (typeof v === "number") pairs.push([[end, coord], v + (coord === "x" ? dx : dy)]);
    }
  return pairs;
}

/**
 * Pure function. The toward-context for "closest" anchor references in a
 * widget's equations (core/expressions.js evaluation hook): an endpoint aims
 * at the OTHER endpoint of the pair. Coordinates may still be unevaluated
 * strings mid-pass — the evaluator roughs those to 0 and fixpoints (see
 * expressions.js). Non-endpoint paths return null (no toward-context).
 *
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["to", "y"]) // {x: 1, y: 2}
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["width"]) // null
 */
export function endpointClosestToward(state, path, keys = ["from", "to"]) {
  const i = keys.indexOf(path[0]);
  if (i === -1) return null;
  return state[keys[(i + 1) % keys.length]] ?? null;
}

/**
 * Pure function. Padded-shaft hit test: is world point (wx, wy) within
 * `radius` + SHAFT_GRAB_PAD of the keys[0]→keys[1] segment? `radius` is the
 * widget's own half-thickness contribution (the basic arrow passes its
 * stroke width, the fancy arrow its widest half-shaft).
 *
 * @example hitsShaft({from: {x: 0, y: 0}, to: {x: 10, y: 0}}, 5, 3, 0) // true (3 ≤ 0 + 5 pad)
 * @example hitsShaft({from: {x: 0, y: 0}, to: {x: 10, y: 0}}, 5, 9, 0) // false (9 > 5)
 */
export function hitsShaft(state, wx, wy, radius, keys = ["from", "to"]) {
  return distToSegment(wx, wy, state[keys[0]], state[keys[1]]) <= radius + SHAFT_GRAB_PAD;
}

/**
 * Pure function (factory returning pure hooks). The three plugin hooks an
 * endpoint-pair widget spreads into its definition — editPoints(node),
 * moveBy(state, dx, dy), closestToward(state, path) — all delegating to the
 * pure functions above with the same `keys`.
 *
 * @example // export const arrowPlugin = { type: "arrow", ...endpointPairHooks(), emit(s) {...} };
 * @example endpointPairHooks().closestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
 */
export function endpointPairHooks(keys = ["from", "to"]) {
  return {
    editPoints: (node) => endpointEditPoints(node.state, keys),
    moveBy: (state, dx, dy) => endpointMoveBy(state, dx, dy, keys),
    closestToward: (state, path) => endpointClosestToward(state, path, keys),
  };
}

/**
 * Enum values for the shared `headMode` property (manifest ARCHITECTURE PLAN
 * #6: "Head options on ALL arrows: headMode enum none|start|end|both (legacy
 * = end)"). Exported as data (not just documented in a comment) so plugin
 * `inspector` row declarations and tests reference the same list instead of
 * repeating string literals.
 *
 * @example HEAD_MODES // ["none", "start", "end", "both"]
 */
export const HEAD_MODES = ["none", "start", "end", "both"];

/**
 * Pure function. Which ends of an endpoint-pair widget get an arrowhead, for
 * a given `headMode` — the ONE place this enum's meaning is defined, so
 * arrow/elbow/curved plugins can't drift on what "both" means.
 *
 * @example headEnds("end") // {start: false, end: true}
 * @example headEnds("both") // {start: true, end: true}
 * @example headEnds("none") // {start: false, end: false}
 * @example headEnds(undefined) // {start: false, end: true} (legacy default)
 */
export function headEnds(headMode = "end") {
  return { start: headMode === "start" || headMode === "both", end: headMode === "end" || headMode === "both" };
}

/**
 * Pure function. A triangular arrowhead's 3 world-space vertices: tip at
 * `tip`, base `len` back along the tip←from axis, base corners ±half across
 * it — the SAME geometry arrow.js has always used for its single (end) head,
 * generalized to be called once per active end (mirrored for `start`: the
 * axis simply reverses, which the caller achieves by swapping which point is
 * `tip` and which is `from`).
 *
 * Args:
 *   tip ({x,y}): the point the head's point sits at (an endpoint)
 *   from ({x,y}): the OTHER endpoint (defines the axis the head points along)
 *   len (number): tip-to-base length along the axis
 *   width (number): full base width across the axis
 *
 * Returns:
 *   number[][]: [tip, baseCornerA, baseCornerB] — a triangle, ready for
 *     render_gpu/ir.js's polygon()
 *
 * @example headTriangle({x: 100, y: 0}, {x: 0, y: 0}, 14, 12) // [[100, 0], [86, 6], [86, -6]]
 * @example headTriangle({x: 0, y: 100}, {x: 0, y: 0}, 14, 12) // [[0, 100], [-6, 86], [6, 86]]
 */
export function headTriangle(tip, from, len, width) {
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const axisLen = Math.hypot(dx, dy) || 1; // degenerate (coincident points): axis is arbitrary, triangle collapses to a point anyway
  const ux = dx / axisLen, uy = dy / axisLen; // unit axis, from → tip
  const nx = -uy, ny = ux; // unit normal
  const half = width / 2;
  return [
    [tip.x, tip.y],
    [tip.x - ux * len + nx * half, tip.y - uy * len + ny * half],
    [tip.x - ux * len - nx * half, tip.y - uy * len - ny * half],
  ];
}

/**
 * Pure function. How far a shaft should stop short of an active head's tip
 * (the shaft end sits INSIDE the head triangle so shaft and head always
 * overlap seamlessly — same SHAFT_PULLBACK convention arrow.js originated).
 * Returns 0 for an inactive end (no head there — shaft runs the full way).
 *
 * @example shaftPullback(true, 14) // 8.4
 * @example shaftPullback(false, 14) // 0
 */
export function shaftPullback(active, headLength) {
  return active ? headLength * SHAFT_PULLBACK : 0;
}
