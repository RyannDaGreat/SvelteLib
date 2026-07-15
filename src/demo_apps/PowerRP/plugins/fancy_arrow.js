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
 *
 * MODIFIER POINTS (manifest ARCHITECTURE PLAN #1, round 12B follow-up: "the
 * fancy arrow could use the yellow squares"): tipLength, tipWidth, tipDimple,
 * startWidth, endWidth each get ONE handle, dragged directly on the head/
 * shaft instead of inspector-numbers-only. Since this plugin has no transform
 * of its own (world == local, identical to the basic arrow), the handles are
 * placed directly in the same from/to coordinate space emit() already uses —
 * no separate local frame to convert between. Each handle sits ON a real
 * outline vertex (core/outline.js's axisNormalFrame/projectOntoAxis/
 * projectOntoNormal decompose the shaft axis into the two directions a
 * modifier point can be constrained to, the same decomposition
 * bezierControlFromBend uses for the curved arrow) and `apply()` projects the
 * drag back onto that ONE-dimensional trajectory — donut's apply pattern,
 * generalized from "one radius" to "one axis or one normal".
 *
 * STROKE NAMING MIGRATION (manifest ARCHITECTURE PLAN #6): fancy_arrow has no
 * generic `width` property (only shape params tipWidth/startWidth/endWidth,
 * which are NOT the migration's target — they stay as-is), so only
 * color→stroke applies here (unlike the basic arrow, which also renames
 * width→strokeWidth).
 */

import { polygon } from "../render_gpu/ir.js";
import { fancyArrowOutline, triangulated, pointInPolygon, axisNormalFrame, projectOntoAxis, projectOntoNormal } from "../core/outline.js";
import { endpointPairHooks, hitsShaft } from "../core/endpoints.js";
import { reportOnce } from "../core/report.js";

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
    stroke: "#1a1a2e", opacity: 1,
  },
  // color → stroke only (manifest ARCHITECTURE PLAN #6, "arrows are
  // line-objects"): fancy_arrow has no generic `width` property, so
  // width→strokeWidth (the basic arrow's second rename) doesn't apply here.
  legacyKeys: { color: "stroke" },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). Endpoints/z → positioning;
  // color/opacity → formatting; tip/shaft geometry → an "arrow" extras category.
  inspector: [
    { key: "from.x", label: "From X", kind: "number", category: "positioning" },
    { key: "from.y", label: "From Y", kind: "number", category: "positioning" },
    { key: "to.x", label: "To X", kind: "number", category: "positioning" },
    { key: "to.y", label: "To Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
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
      // Once per unique message (core/report.js throttle semantics) — emit
      // runs every frame and must not spam.
      reportOnce(`PowerRP fancy_arrow: geometry not rendered — ${e.message} (tipLength ${s.tipLength}, tipWidth ${s.tipWidth}, tipDimple ${s.tipDimple}, startWidth ${s.startWidth}, endWidth ${s.endWidth})`);
      return [];
    }
    const opacity = s.opacity ?? 1;
    return tris.map((tri) => polygon({ points: tri, fill: s.stroke, opacity }));
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
  /**
   * Pure function. FIVE modifier points, one per parametric-geometry
   * parameter (manifest round 12B follow-up), each sitting on the outline
   * vertex it controls and each `apply()` projecting the drag onto that
   * parameter's ONE-dimensional trajectory (axial = along the shaft, or
   * normal = perpendicular to it — core/outline.js's axisNormalFrame). A
   * degenerate (zero-length) arrow has no defined axis, so it emits no
   * modifier points (nothing to drag along an undefined direction — the
   * same "no geometry" territory fancyArrowOutline's null return covers).
   *
   * Domain clamps mirror fancyArrowOutline's own (documented there): widths/
   * lengths floor at 0, tipLength cannot exceed the arrow's span, tipDimple
   * cannot exceed the head-back-edge bound — so a modifier drag can never
   * push the STORED state somewhere emit() would itself have re-clamped
   * silently (the handle's visible position always matches where the drag
   * left it).
   */
  modifierPoints(s) {
    const from = s.from, to = s.to;
    const frame = axisNormalFrame(from, to);
    if (frame.length === 0) return []; // no axis to constrain a handle to
    const { nx, ny, length: span } = frame;
    const tipLength = Math.min(Math.max(s.tipLength ?? 0, 0), span);
    const halfTip = Math.max(s.tipWidth ?? 0, 0) / 2;
    const halfStart = Math.max(s.startWidth ?? 0, 0) / 2;
    const halfEnd = Math.max(s.endWidth ?? 0, 0) / 2;
    const maxDimple = halfTip > 0 ? tipLength * (1 - Math.min(halfEnd / halfTip, 1)) : 0;
    const tipDimple = Math.min(Math.max(s.tipDimple ?? 0, 0), maxDimple);
    // Points ON the axis (normal offset 0) at a given distance back from `to`.
    const onAxisFromTip = (back) => ({ x: to.x - frame.ux * back, y: to.y - frame.uy * back });
    const barbBase = onAxisFromTip(tipLength); // the barb base line's on-axis point
    const dimplePt = onAxisFromTip(tipLength - tipDimple); // the dimple's on-axis point

    return [
      {
        // tipLength: slides barbBase along the axis (distance from `to`).
        id: "tipLength", x: barbBase.x, y: barbBase.y,
        apply: (state, p) => {
          const f = axisNormalFrame(state.from, state.to);
          if (f.length === 0) return {};
          const back = f.length - projectOntoAxis(state.from, f, p); // distance from `to`
          return { tipLength: Math.min(Math.max(back, 0), f.length) };
        },
      },
      {
        // tipWidth: the barbR point, offset halfTip along the normal from barbBase.
        id: "tipWidth", x: barbBase.x + nx * halfTip, y: barbBase.y + ny * halfTip,
        apply: (state, p) => {
          const f = axisNormalFrame(state.from, state.to);
          if (f.length === 0) return {};
          const back = Math.min(Math.max(state.tipLength ?? 0, 0), f.length);
          const base = { x: state.to.x - f.ux * back, y: state.to.y - f.uy * back };
          return { tipWidth: Math.max(2 * Math.abs(projectOntoNormal(base, f, p)), 0) };
        },
      },
      {
        // tipDimple: slides dimplePt along the axis, between the tip and barbBase.
        id: "tipDimple", x: dimplePt.x, y: dimplePt.y,
        apply: (state, p) => {
          const f = axisNormalFrame(state.from, state.to);
          if (f.length === 0) return {};
          const backOfTip = f.length - projectOntoAxis(state.from, f, p); // distance from `to`
          const tl = Math.min(Math.max(state.tipLength ?? 0, 0), f.length);
          return { tipDimple: Math.min(Math.max(tl - backOfTip, 0), tl) };
        },
      },
      {
        // startWidth: the startR point, offset halfStart along the normal from `from`.
        id: "startWidth", x: from.x + nx * halfStart, y: from.y + ny * halfStart,
        apply: (state, p) => {
          const f = axisNormalFrame(state.from, state.to);
          if (f.length === 0) return {};
          return { startWidth: Math.max(2 * Math.abs(projectOntoNormal(state.from, f, p)), 0) };
        },
      },
      {
        // endWidth: the dimpleR point, offset halfEnd along the normal from dimplePt.
        id: "endWidth", x: dimplePt.x + nx * halfEnd, y: dimplePt.y + ny * halfEnd,
        apply: (state, p) => {
          const f = axisNormalFrame(state.from, state.to);
          if (f.length === 0) return {};
          const tl = Math.min(Math.max(state.tipLength ?? 0, 0), f.length);
          const halfTipNow = Math.max(state.tipWidth ?? 0, 0) / 2;
          const maxD = halfTipNow > 0 ? tl : 0;
          const td = Math.min(Math.max(state.tipDimple ?? 0, 0), maxD);
          const dp = { x: state.to.x - f.ux * (tl - td), y: state.to.y - f.uy * (tl - td) };
          return { endWidth: Math.max(2 * Math.abs(projectOntoNormal(dp, f, p)), 0) };
        },
      },
    ];
  },
  commands: [
    { id: "add-fancy-arrow", title: "Add Fancy Arrow", icon: "mdi:arrow-right-bold", run: (app) => app.addItem(fancyArrowPlugin.defaults) },
  ],
};
