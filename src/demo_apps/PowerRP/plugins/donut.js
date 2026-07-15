/**
 * Donut widget — a circle with a hole; the MODIFIER-POINT showcase widget
 * (manifest ARCHITECTURE PLAN #1: "the DONUT widget" is the first modifier-
 * point consumer). ONE modifier point sits on the inner rim (the 3 o'clock
 * point, same convention as the outer bbox's east edge) and drags toward/away
 * from the center to scrub `inner` — the hole radius as a PROPORTION (0..1)
 * of the outer radius, so the hole scales correctly with the widget's own
 * resize (unlike a stored absolute radius, which would need re-deriving on
 * every w/h change).
 *
 * Shape: bbox widget (x,y,w,h) like circle.js, so it gets the standard resize
 * handles for free; the outer ellipse fits the bbox exactly (rx=w/2, ry=h/2 —
 * same convention as circle.js) and the hole is a proportionally-scaled
 * concentric ellipse (rx·inner, ry·inner).
 *
 * RENDER (WIDGET RENDER PARITY cornerstone): neither backend has a native
 * ring/even-odd primitive (verified — see core/outline.js's DONUT_SEGMENTS
 * comment: no evenodd/fillRule anywhere in render_gpu, and the PDF backend's
 * polygon case is a single non-zero-winding "h f" subpath), so the ring is
 * emitted as a triangulated polygon via core/outline.js's donutOutline — the
 * SAME approach fancy_arrow.js already uses for its curved dimple geometry.
 * Because BOTH the GPU compositor and the PDF backend consume the identical
 * IR `polygon` op (vertex-for-vertex, from the same donutOutline call), they
 * render the SAME triangles — parity by construction, not by coincidence.
 * (An SVG/PDF path with fillRule:"evenodd" would be more elegant and truly
 * circular, but would require a NEW IR op implemented in both backends; the
 * polygon route reuses an already-proven, already-parity-tested path and
 * ships today. Revisit if/when an IR path op with fill-rule support lands —
 * flagged, not a permanent design commitment.)
 */

import { standardBBoxAnchors } from "../core/derive.js";
import * as T from "../core/transform.js";
import { donutOutline, triangulated, pointInPolygon } from "../core/outline.js";
import { polygon, polyline } from "../render_gpu/ir.js";

/**
 * Pure function. The donut's outer-ellipse-fitted-to-bbox geometry, in LOCAL
 * (bbox) space: center + radii. Non-uniform w/h gives an elliptical donut —
 * donutOutline is drawn on a UNIT circle then non-uniformly scaled per axis,
 * matching how circle.js's ellipse fits rx/ry independently to w/h.
 *
 * @example ringGeom({w: 140, h: 140}) // {cx: 70, cy: 70, rx: 70, ry: 70}
 * @example ringGeom({w: 200, h: 100}) // {cx: 100, cy: 50, rx: 100, ry: 50}
 */
export function ringGeom(s) {
  return { cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2 };
}

/**
 * Pure function. donutOutline's unit-circle output, scaled per-axis by
 * (rx, ry) and translated to (cx, cy) — the donut's actual elliptical ring
 * outline in local space. Kept separate from donutOutline (which stays a
 * pure CIRCLE generator, reusable for non-elliptical rings elsewhere) so the
 * ellipse-fitting is this plugin's own thin glue, not baked into the generic
 * geometry module.
 *
 * @example donutRingOutline({cx: 10, cy: 10, rx: 10, ry: 10}, 0.5)[0] // [20, 10]
 */
export function donutRingOutline(geom, inner) {
  const { cx, cy, rx, ry } = geom;
  return donutOutline({ cx: 0, cy: 0, outerR: 1, inner }).map(([x, y]) => [cx + x * rx, cy + y * ry]);
}

export const donutPlugin = {
  type: "donut",
  title: "Donut",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "donut", x: 460, y: 200, w: 140, h: 140, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#bb9af7", stroke: "#1a1a2e", strokeWidth: 2, opacity: 1,
    inner: 0.5, // hole radius as a PROPORTION (0..1) of the outer radius
  },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"); `inner` is a FORMATTING
  // property (it shapes the fill, like cornerRadius does for rect) with
  // min 0 / max 1 — bounded rows get range-scaled scrub sensitivity for free
  // (NumericField: (max-min)/RANGE_DRAG_PX when both bounds are set, the same
  // mechanism opacity already uses — no new scrub wiring needed here).
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" },
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" },
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "fill", label: "Fill", kind: "color", category: "formatting" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "inner", label: "Inner radius", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /**
   * Near-pure function (console.errors ONCE per unique degenerate-geometry
   * message via reportOnce; otherwise pure — same contract as
   * fancy_arrow.js's emit). State → display-list commands: the annulus
   * outline ear-clips into convex triangles for the IR's convex-only polygon
   * op. A zero-size donut (w or h <= 0) emits nothing.
   */
  emit(s) {
    const geom = ringGeom(s);
    if (geom.rx <= 0 || geom.ry <= 0) return [];
    const outline = donutRingOutline(geom, s.inner ?? 0.5);
    const tris = triangulated(outline);
    const opacity = s.opacity ?? 1;
    const fillTris = tris.map((tri) => polygon({ points: tri, fill: s.fill, opacity }));
    // Stroke: two polylines (outer rim + inner rim) — matches the IR's
    // polyline op (round caps/joins) rather than inventing a new stroked-
    // ring primitive; circle.js's ellipse stroke has no direct equivalent
    // for a ring, so this is thin, donut-specific glue.
    if ((s.strokeWidth ?? 0) <= 0) return fillTris;
    const half = outline.length / 2;
    const outer = [...outline.slice(0, half), outline[0]];
    const inner = [...outline.slice(half), outline[half]];
    return [
      ...fillTris,
      polyline({ points: outer, width: s.strokeWidth, color: s.stroke, opacity }),
      polyline({ points: inner, width: s.strokeWidth, color: s.stroke, opacity }),
    ];
  },
  hitTest(s, lx, ly) {
    const geom = ringGeom(s);
    if (geom.rx <= 0 || geom.ry <= 0) return false;
    return pointInPolygon(donutRingOutline(geom, s.inner ?? 0.5), lx, ly);
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Radial point on the OUTER ellipse toward the target — identical
    // convention to circle.js's closestAnchor (exact when w === h).
    const local = T.apply(T.invert(world), wx, wy);
    const { cx, cy, rx, ry } = ringGeom(state);
    const theta = Math.atan2((local.y - cy) / ry, (local.x - cx) / rx);
    return { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) };
  },
  /**
   * Pure function. ONE modifier point on the inner rim's 3-o'clock position
   * (local space, same convention as the east resize handle): dragging it
   * toward/away from the center scrubs `inner`. `apply` projects the dragged
   * LOCAL point onto the handle's one-dimensional trajectory (the horizontal
   * radius from center through the handle) and returns the resulting `inner`
   * as a partial-state write — the derivation-stage rotation/scale live in
   * node.world (nodeModifierPoints wraps this for display; CanvasView inverts
   * the drag back to local before calling apply), so this function never
   * reasons about rotation itself.
   */
  modifierPoints(s) {
    const { cx, cy, rx } = ringGeom(s);
    const inner = Math.max(0, Math.min(s.inner ?? 0.5, 1));
    return [{
      id: "inner",
      x: cx + rx * inner,
      y: cy,
      apply(state, localPoint) {
        const g = ringGeom(state);
        if (g.rx <= 0) return { inner: 0 };
        // Project onto the horizontal radius (the handle's ONE constrained
        // axis) — the y-component of the drag is ignored by design (a
        // modifier point's trajectory is intentionally restricted; the
        // manifest: "highly-constrained... often parameterized by ONE
        // number"). Clamped to [0, 1] (donutOutline's own domain).
        const t = (localPoint.x - g.cx) / g.rx;
        return { inner: Math.max(0, Math.min(t, 1)) };
      },
    }];
  },
  commands: [
    { id: "add-donut", title: "Add Donut", icon: "mdi:circle-double", run: (app) => app.addItem(donutPlugin.defaults) },
  ],
};
