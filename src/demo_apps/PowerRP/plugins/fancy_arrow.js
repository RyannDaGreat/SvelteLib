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
 * local), shaft drags translate only FREE coordinates via moveBy. The
 * endpoint plumbing (editPoints/moveBy/closestToward + padded shaft grab)
 * comes from core/endpoints.js — the shared home, since plugins may not
 * import each other (registry rule).
 */

import { polygon } from "../render_gpu/ir.js";
import { fancyArrowOutline, triangulated, pointInPolygon } from "../core/outline.js";
import { endpointPairHooks, hitsShaft } from "../core/endpoints.js";

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
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). Endpoints/z → positioning;
  // color/opacity → formatting; tip/shaft geometry → an "arrow" extras category.
  inspector: [
    { key: "from.x", label: "From X", kind: "number", category: "positioning" },
    { key: "from.y", label: "From Y", kind: "number", category: "positioning" },
    { key: "to.x", label: "To X", kind: "number", category: "positioning" },
    { key: "to.y", label: "To Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "color", label: "Color", kind: "color", category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "tipLength", label: "Tip length", kind: "number", min: 0, category: "arrow" },
    { key: "tipWidth", label: "Tip width", kind: "number", min: 0, category: "arrow" },
    { key: "tipDimple", label: "Tip dimple", kind: "number", min: 0, category: "arrow" },
    { key: "startWidth", label: "Start width", kind: "number", min: 0, category: "arrow" },
    { key: "endWidth", label: "End width", kind: "number", min: 0, category: "arrow" },
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
    // The body (exact, concavity-aware) plus the shared padded-shaft grab
    // (core/endpoints.js SHAFT_GRAB_PAD) so a hairline shaft stays clickable.
    const outline = fancyArrowOutline(outlineParams(s));
    if (!outline) return false;
    if (pointInPolygon(outline, wx, wy)) return true;
    return hitsShaft(s, wx, wy, Math.max(s.startWidth ?? 0, s.endWidth ?? 0) / 2);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js), identical semantics to the basic arrow by construction.
  ...endpointPairHooks(),
  commands: [
    { id: "add-fancy-arrow", title: "Add Fancy Arrow", icon: "mdi:arrow-right-bold", run: (app) => app.addItem(fancyArrowPlugin.defaults) },
  ],
};
