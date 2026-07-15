/**
 * Arrow widget — endpoints are plain {x, y} pairs whose coordinates, like any
 * numeric property, may be EQUATIONS (THE UNIFICATION): binding an endpoint
 * to an anchor just writes equation strings ("@<itemId>_tm.x") into from/to.
 * By emit time the derivation stage has evaluated every equation, so this
 * plugin only ever sees numbers. Legacy {item, anchor} binding objects are
 * migrated to equation pairs on load (core/expressions.withBindingsMigrated).
 *
 * The arrow has no transform of its own (world == local); shaft drags
 * translate the endpoints directly via the moveBy hook — equation-bound
 * coordinates stay put (they're anchored), free ones translate.
 *
 * Head parameters (manifest Round 11, "Arrow head parameters"): headLength
 * (tip to base, along the shaft axis) and headWidth (across the base) are
 * INDEPENDENT. The old single `headSize` — really a barb radius at a fixed
 * 0.44 rad flare — was renamed/split; legacy docs migrate via the
 * `legacyKeys` declaration (core/document.withLegacyKeysRenamed applies it
 * at the load boundary; values move verbatim — numbers AND equations).
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { distToSegment } from "../core/outline.js";

/** Fraction of headLength the shaft stops short of the tip — the shaft end
 * sits INSIDE the head triangle, so shaft and head always overlap seamlessly
 * (and the round cap never pokes past the tip). Same value/semantics as the
 * pre-headWidth geometry (0.6 of the old headSize). */
const SHAFT_PULLBACK = 0.6;

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // headWidth 12 ≈ the old fixed-flare head's width (2·14·sin(0.44) = 11.93):
    // the default arrow renders visually unchanged by the re-parameterization.
    color: "#1a1a2e", width: 3, headLength: 14, headWidth: 12, opacity: 1,
  },
  // Legacy top-level state keys → their current names (headSize was really
  // the head LENGTH — manifest Round 11). Applied document-wide at the load
  // boundary by core/document.withLegacyKeysRenamed; reported loudly there.
  legacyKeys: { headSize: "headLength" },
  inspector: [
    // Endpoint rows are equation-aware number fields (dotted keys = nested
    // paths) — the Property Panel shows "@…" bindings as editable equations.
    { key: "from.x", label: "From X", kind: "number" },
    { key: "from.y", label: "From Y", kind: "number" },
    { key: "to.x", label: "To X", kind: "number" },
    { key: "to.y", label: "To Y", kind: "number" },
    { key: "color", label: "Color", kind: "color" },
    { key: "width", label: "Width", kind: "number", min: 0 },
    { key: "headLength", label: "Head length", kind: "number", min: 0 },
    { key: "headWidth", label: "Head width", kind: "number", min: 0 },
    { key: "z", label: "Z order", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers, and the arrow's world transform is IDENTITY (no
   * x/y/rotation/scale state), so these local commands are world coordinates.
   * Head triangle: tip at `to`, base headLength back along the axis, base
   * corners ±headWidth/2 across it.
   */
  emit(s) {
    const { from, to } = s;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const ux = Math.cos(angle), uy = Math.sin(angle); // unit axis, from → to
    const nx = -uy, ny = ux; // unit normal
    const len = s.headLength, half = s.headWidth / 2;
    const opacity = s.opacity ?? 1;
    const shaftEnd = { x: to.x - ux * len * SHAFT_PULLBACK, y: to.y - uy * len * SHAFT_PULLBACK };
    return [
      polyline({ points: [[from.x, from.y], [shaftEnd.x, shaftEnd.y]], width: s.width, color: s.color, opacity }),
      polygon({
        points: [
          [to.x, to.y],
          [to.x - ux * len + nx * half, to.y - uy * len + ny * half],
          [to.x - ux * len - nx * half, to.y - uy * len - ny * half],
        ],
        fill: s.color, opacity,
      }),
    ];
  },
  hitTestWorld(node, wx, wy) {
    const { from, to } = node.state;
    return distToSegment(wx, wy, from, to) <= (node.state.width ?? 3) + 5;
  },
  /**
   * Generic editable-point interface: the editor renders a draggable handle
   * per entry; dragging one writes values into state[key].x/.y (numbers when
   * free, equation strings when dropped on an anchor). Any widget with
   * bindable points implements this — the UI never special-cases arrows.
   */
  editPoints(node) {
    return [
      { key: "from", x: node.state.from.x, y: node.state.from.y },
      { key: "to", x: node.state.to.x, y: node.state.to.y },
    ];
  },
  /**
   * Pure function. Shaft-drag translation (manifest round 5: "dragging the
   * middle should move BOTH endpoints"). Takes the RAW stored state and
   * returns [pathWithinItem, value] pairs for every FREE (numeric) endpoint
   * coordinate; equation-bound coordinates are anchored and stay put — an
   * arrow with both ends bound doesn't move from a shaft drag (documented).
   *
   * @example arrowPlugin.moveBy({from: {x: 0, y: 0}, to: {x: 10, y: "@c1_tm.y"}}, 5, 2) // [[["from","x"],5],[["from","y"],2],[["to","x"],15]]
   */
  moveBy(state, dx, dy) {
    const pairs = [];
    for (const end of ["from", "to"])
      for (const coord of ["x", "y"]) {
        const v = state[end]?.[coord];
        if (typeof v === "number") pairs.push([[end, coord], v + (coord === "x" ? dx : dy)]);
      }
    return pairs;
  },
  /**
   * Pure function. The toward-context for "closest" anchor references in
   * this widget's equations (core/expressions.js evaluation hook): an
   * endpoint aims at the OTHER endpoint. Coordinates may still be
   * unevaluated strings mid-pass — the evaluator roughs those to 0 and
   * fixpoints (see expressions.js).
   *
   * @example arrowPlugin.closestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
   */
  closestToward(state, path) {
    if (path[0] === "from") return state.to;
    if (path[0] === "to") return state.from;
    return null;
  },
  commands: [
    { id: "add-arrow", title: "Add Arrow", icon: "mdi:arrow-top-right", run: (app) => app.addItem(arrowPlugin.defaults) },
  ],
};
