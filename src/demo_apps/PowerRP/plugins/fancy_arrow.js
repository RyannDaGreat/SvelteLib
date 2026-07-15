/**
 * Fancy Arrow widget — the FIRST of the parameterized-geometry subclass
 * (manifest Round 11, "FANCY ARROW"): its shape comes from a pure OUTLINE
 * GENERATOR in core/outline.js (fancyArrowOutline — a faithful port of the
 * Figures library's parametric arrow, refs/Figures/arrow/arrow.py
 * `_arrow_contours`), so this plugin is thin glue: state → generator params →
 * triangulated() → convex IR polygons. The NEXT parametric shape should be
 * another generator + a plugin this shape, not bespoke geometry code.
 *
 * Parameters (Figures naming; see the generator for the Python mapping):
 * tipLength/tipWidth (the head), tipDimple (concave notch into the head's
 * base), startWidth/endWidth (tapered shaft). All are ordinary equation-aware
 * numeric slots.
 *
 * Endpoint semantics are identical to the basic arrow: from/to coordinates
 * may be equations (anchor bindings), no transform of its own (world ==
 * local), shaft drags translate only FREE coordinates via moveBy. Those tiny
 * endpoint hooks are duplicated from plugins/arrow.js verbatim — plugins may
 * not import each other (registry rule); the shared home for an
 * "endpoint-pair capability" helper is a future core module (flagged in the
 * task report), not a cross-plugin import.
 */

import { polygon } from "../render_gpu/ir.js";
import { fancyArrowOutline, triangulated, pointInPolygon, distToSegment } from "../core/outline.js";

// Degenerate-geometry reports, once per unique message (the expressions.js
// loggedErrors pattern) — emit runs every frame and must not spam.
const loggedDegenerate = new Set();

/** Pure function. The generator params for a state (evaluated OR raw — only
 * the caller knows; emit/hit-test pass evaluated states).
 *
 * @example // outlineParams({from: {x: 0, y: 0}, to: {x: 100, y: 0}, tipLength: 15, ...}) → {x0: 0, y0: 0, x1: 100, y1: 0, tipLength: 15, ...}
 */
function outlineParams(s) {
  return {
    x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y,
    tipLength: s.tipLength, tipWidth: s.tipWidth, tipDimple: s.tipDimple,
    startWidth: s.startWidth, endWidth: s.endWidth,
  };
}

export const fancyArrowPlugin = {
  type: "fancy_arrow",
  title: "Fancy Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "fancy_arrow", z: 1,
    from: { x: 200, y: 340 }, to: { x: 420, y: 340 },
    // The Figures library's own defaults (arrow.py:354): tip_width=15 is the
    // PER-SIDE barb offset there, so full tipWidth = 30 here; the rest map 1:1.
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    color: "#1a1a2e", opacity: 1,
  },
  inspector: [
    { key: "from.x", label: "From X", kind: "number" },
    { key: "from.y", label: "From Y", kind: "number" },
    { key: "to.x", label: "To X", kind: "number" },
    { key: "to.y", label: "To Y", kind: "number" },
    { key: "tipLength", label: "Tip length", kind: "number", min: 0 },
    { key: "tipWidth", label: "Tip width", kind: "number", min: 0 },
    { key: "tipDimple", label: "Tip dimple", kind: "number", min: 0 },
    { key: "startWidth", label: "Start width", kind: "number", min: 0 },
    { key: "endWidth", label: "End width", kind: "number", min: 0 },
    { key: "color", label: "Color", kind: "color" },
    { key: "z", label: "Z order", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  /**
   * Near-pure function (console.errors ONCE per unique degenerate-geometry
   * message; otherwise pure). State → display-list commands: the outline
   * (concave at the dimple) ear-clips into convex triangles for the IR's
   * convex-only polygon op. Shared triangle vertices are verbatim-identical,
   * so raster edges tile watertight. A zero-length arrow emits nothing
   * (generator returns null — the Python skia_draw_arrow precedent).
   *
   * The triangulated() guard covers the generator's residual self-intersecting
   * parameter corners (documented in core/outline.js): a degenerate config is
   * REPORTED and draws nothing — a bad state must never brick the render loop
   * (the app's loud-repair philosophy; evaluateState's fail-loud precedent).
   */
  emit(s) {
    const outline = fancyArrowOutline(outlineParams(s));
    if (!outline) return []; // zero-length arrow: no geometry
    let tris;
    try {
      tris = triangulated(outline);
    } catch (e) {
      const message = `PowerRP fancy_arrow: geometry not rendered — ${e.message} (tipLength ${s.tipLength}, tipWidth ${s.tipWidth}, tipDimple ${s.tipDimple}, startWidth ${s.startWidth}, endWidth ${s.endWidth})`;
      if (!loggedDegenerate.has(message)) {
        loggedDegenerate.add(message);
        console.error(message);
      }
      return [];
    }
    const opacity = s.opacity ?? 1;
    return tris.map((tri) => polygon({ points: tri, fill: s.color, opacity }));
  },
  hitTestWorld(node, wx, wy) {
    const s = node.state;
    // The body (exact, concavity-aware) plus the basic arrow's padded-shaft
    // grab (same +5 screen-feel slack as plugins/arrow.js) so a hairline
    // shaft stays clickable.
    const outline = fancyArrowOutline(outlineParams(s));
    if (!outline) return false;
    if (pointInPolygon(outline, wx, wy)) return true;
    const grab = Math.max(s.startWidth ?? 0, s.endWidth ?? 0) / 2 + 5;
    return distToSegment(wx, wy, s.from, s.to) <= grab;
  },
  /** Generic editable-point interface (same contract as plugins/arrow.js). */
  editPoints(node) {
    return [
      { key: "from", x: node.state.from.x, y: node.state.from.y },
      { key: "to", x: node.state.to.x, y: node.state.to.y },
    ];
  },
  /**
   * Pure function. Shaft-drag translation — duplicated verbatim from
   * plugins/arrow.js (see module header: no cross-plugin imports).
   *
   * @example fancyArrowPlugin.moveBy({from: {x: 0, y: 0}, to: {x: 10, y: "@c1_tm.y"}}, 5, 2) // [[["from","x"],5],[["from","y"],2],[["to","x"],15]]
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
   * Pure function. "closest" anchor toward-context: an endpoint aims at the
   * OTHER endpoint (same contract as plugins/arrow.js).
   *
   * @example fancyArrowPlugin.closestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
   */
  closestToward(state, path) {
    if (path[0] === "from") return state.to;
    if (path[0] === "to") return state.from;
    return null;
  },
  commands: [
    { id: "add-fancy-arrow", title: "Add Fancy Arrow", icon: "mdi:arrow-right-bold", run: (app) => app.addItem(fancyArrowPlugin.defaults) },
  ],
};
