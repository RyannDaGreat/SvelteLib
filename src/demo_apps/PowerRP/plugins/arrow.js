/**
 * Arrow widget — endpoints are plain {x, y} pairs whose coordinates, like any
 * numeric property, may be EQUATIONS (THE UNIFICATION): binding an endpoint
 * to an anchor just writes equation strings ("@<itemId>_tm.x") into from/to.
 * By paint time the derivation stage has evaluated every equation, so this
 * plugin only ever sees numbers. Legacy {item, anchor} binding objects are
 * migrated to equation pairs on load (core/expressions.withBindingsMigrated).
 *
 * The arrow has no transform of its own (world == local); shaft drags
 * translate the endpoints directly via the moveBy hook — equation-bound
 * coordinates stay put (they're anchored), free ones translate.
 */

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    color: "#1a1a2e", width: 3, headSize: 14, opacity: 1,
  },
  inspector: [
    // Endpoint rows are equation-aware number fields (dotted keys = nested
    // paths) — the Property Panel shows "@…" bindings as editable equations.
    { key: "from.x", label: "From X", kind: "number" },
    { key: "from.y", label: "From Y", kind: "number" },
    { key: "to.x", label: "To X", kind: "number" },
    { key: "to.y", label: "To Y", kind: "number" },
    { key: "color", label: "Color", kind: "color" },
    { key: "width", label: "Width", kind: "number", min: 0 },
    { key: "headSize", label: "Head size", kind: "number", min: 0 },
    { key: "z", label: "Z order", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  paint(ctx, s) {
    const { from, to } = s;
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = s.headSize;
    // Shorten the shaft so it doesn't poke through the head tip.
    const shaftEnd = { x: to.x - Math.cos(angle) * head * 0.6, y: to.y - Math.sin(angle) * head * 0.6 };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - 0.44) * head, to.y - Math.sin(angle - 0.44) * head);
    ctx.lineTo(to.x - Math.cos(angle + 0.44) * head, to.y - Math.sin(angle + 0.44) * head);
    ctx.closePath();
    ctx.fill();
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

/**
 * Pure function. Distance from point to segment ab.
 *
 * @example distToSegment(0, 5, {x: 0, y: 0}, {x: 10, y: 0}) // 5
 * @example distToSegment(-3, 0, {x: 0, y: 0}, {x: 10, y: 0}) // 3
 */
export function distToSegment(px, py, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2));
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}
