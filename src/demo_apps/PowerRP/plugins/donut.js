/**
 * ══ OFF THE ROSTER: THIS IS THE PARITY BASELINE, NOT THE SHIPPED WIDGET ══════
 *
 * The `donut` widget now SHIPS as a built-in plugin ASSET —
 * `assets/builtin/library/donut.plugin.js`, registered through the sandbox by
 * core/builtin_plugin_assets.js. This module is no longer on plugins/index.js's
 * roster, so the object it exports is NOT what the editor, the CLI or a render job
 * uses. Read core/builtin_plugin_assets.js for why the migration happened.
 *
 * IT IS KEPT ON PURPOSE, for exactly two jobs:
 *   1. THE PARITY BASELINE. tests/builtin_plugin_assets_test.js drives THIS emit
 *      and the registered ASSET's emit over the same fixed states and asserts the
 *      display lists are deep-equal. Deleting this file would leave the migration
 *      unpinned: the asset could drift and nothing would notice, because "it draws
 *      something" is not the same claim as "it draws what it used to".
 *   2. Its pure helper exports, which other suites already import by name.
 *
 * SO: A CHANGE HERE IS NOT A CHANGE TO THE WIDGET. Edit the asset; then edit this
 * file to match, or the parity test fails — which is the point.
 * ═════════════════════════════════════════════════════════════════════════════
 */

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
 * RENDER (WIDGET RENDER PARITY cornerstone): the ring is ONE `path` IR op whose
 * `d` is donutOutline's keyhole loop, filled with the NON-ZERO winding rule. All
 * three backends consume that one op vertex-for-vertex — Skia
 * (paint_skia.js drawPathOp), SVG (`<path d>`), PDF (svgPathToPdfOps + `f`) — so
 * they render the SAME figure by construction, not by coincidence.
 *
 * THIS USED TO BE N TRIANGLES, AND THAT WAS THE R6-11 BUG. The ring was
 * ear-clipped through core/outline.js's `triangulated` and emitted as ~128
 * separate convex `polygon` ops, because the polygon op was the only fill the
 * RETIRED WebGPU mesh renderer could draw (render_gpu/FINDINGS.md: "mesh polygons
 * are not [antialiased]"). Two abutting ANTIALIASED fills conflate to 192/255
 * along their shared edge, so every internal ear-clip diagonal showed as a visible
 * crack on any surface that is not multisampled — which is every surface in this
 * app except the editor viewport (thumbnails, minimap, PNG/PDF export, every
 * exported video frame, and the bare-node CLI's software raster). It also
 * re-anchored every gradient and material frame PER TRIANGLE, because the polygon
 * case passes `pointsBounds(cmd.points)` where drawPathOp uses the whole path's
 * bounds. The `path` op with `fillRule` landed in all three backends on
 * 2026-07-23, which is the condition this file's old comment said to revisit on;
 * MEASURED after the switch: zero interior seam pixels at 100/200/400/600 px on
 * the 1-sample software surface that used to crack at min 163.
 *
 * WHY NONZERO AND NOT EVENODD, and why the fill is separate from the stroke:
 * donutOutline walks the outer rim forward and the inner rim BACKWARD, so the two
 * loops have OPPOSITE winding and non-zero already reads the inner disc as a hole.
 * Both rules were rendered and measured identical (silhouette diff 0 px), so the
 * one that keeps `donutRingOutline` a single flat point list wins: hitTest shares
 * that exact list via pointInPolygon, and one geometry means the picture and the
 * hit region cannot disagree. The rim stroke stays TWO polylines rather than
 * riding on the path op, because a filled-AND-stroked keyhole path strokes the
 * zero-width bridge too — two hairlines across the ring in the PDF backend's `B`
 * operator.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { donutOutline, pointInPolygon, closestPointOnSegment } from "../core/outline.js";
import { polygonPathD } from "../core/shapes.js";
import { path, polyline } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

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
  ephemeral: EPHEMERAL.NONE,
  title: "Donut",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "donut", x: 460, y: 200, w: 140, h: 140, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#bb9af7", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
    inner: 0.5, // hole radius as a PROPORTION (0..1) of the outer radius
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: positioning + fill/stroke/
  // strokeWidth + opacity. No cornerRadius (a ring has no square corners). The
  // plugin-specific `inner` row (the donut's hole, a FORMATTING property that
  // shapes the fill like cornerRadius does for rect) stays declared here; its
  // min 0 / max 1 gives it range-scaled scrub sensitivity for free
  // (NumericField, the same mechanism opacity uses).
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
    { key: "inner", label: "Inner radius", kind: "number", min: 0, max: 1, category: "formatting", help: "The hole's size as a fraction of the donut's radius, from 0 (a full disc) to 1 (a thin ring). Drag the yellow handle on canvas to set it." },
  ],
  /**
   * Pure function. State → display-list commands: the annulus as ONE `path` op
   * (see the RENDER note above for why it is one op and not N triangles, and why
   * the winding rule is non-zero). A zero-size donut (w or h <= 0) emits nothing.
   */
  emit(s, _targetWorldIR, world) {
    const geom = ringGeom(s);
    if (geom.rx <= 0 || geom.ry <= 0) return [];
    const outline = donutRingOutline(geom, s.inner ?? 0.5);
    const opacity = s.opacity ?? 1;
    // fillRule is spelled out even though "nonzero" is the op's default: here it
    // is a LOAD-BEARING claim about donutOutline's opposite-wound rims, not a
    // shrug (plugins/paint_path.js states its rule for the same reason).
    const ringPath = path({ d: polygonPathD(outline), fill: s.fill, fillRule: "nonzero", opacity });
    // Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE, render_gpu/
    // effects.js) wrap the finished op list; all-off = pass-through. The
    // effect bbox is the bbox (the ring's outer extent, stroke pad below).
    const fx = (cmds) => applyEffects(cmds, s, world, {
      x: -(s.strokeWidth ?? 0) / 2, y: -(s.strokeWidth ?? 0) / 2,
      w: (s.w ?? 0) + (s.strokeWidth ?? 0), h: (s.h ?? 0) + (s.strokeWidth ?? 0),
    });
    // Stroke: two polylines (outer rim + inner rim) — matches the IR's
    // polyline op (round caps/joins) rather than inventing a new stroked-
    // ring primitive; circle.js's ellipse stroke has no direct equivalent
    // for a ring, so this is thin, donut-specific glue.
    if ((s.strokeWidth ?? 0) <= 0) return fx([ringPath]);
    const half = outline.length / 2;
    const outer = [...outline.slice(0, half), outline[0]];
    const inner = [...outline.slice(half), outline[half]];
    return fx([
      ringPath,
      polyline({ points: outer, width: s.strokeWidth, color: s.stroke, opacity }),
      polyline({ points: inner, width: s.strokeWidth, color: s.stroke, opacity }),
    ]);
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
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
   * toward/away from the center scrubs `inner`.
   *
   * THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js), the showcase case:
   *   `constrain` — the allowed set is the SEGMENT from the center to the
   *     horizontal rim, {(cx + t·rx, cy) : t ∈ [0, 1]}. Both restrictions the
   *     drag used to perform imperatively are that one set: dropping the drag's
   *     y-component IS the projection onto the line y = cy, and clamping to
   *     [0, 1] IS the segment's extent (donutOutline's own domain).
   *   `apply` — reads the already-allowed point's distance from the center as a
   *     fraction of rx. No clamp of its own: the set already said so.
   * Rotation/scale live in node.world (nodeModifierPoints wraps for display,
   * CanvasView inverts back to local first), so neither hook sees them.
   */
  modifierPoints(s) {
    const { cx, cy, rx } = ringGeom(s);
    const inner = Math.max(0, Math.min(s.inner ?? 0.5, 1));
    return [{
      id: "inner",
      x: cx + rx * inner,
      y: cy,
      constrain(state, desired) {
        const g = ringGeom(state);
        return closestPointOnSegment({ x: g.cx, y: g.cy }, { x: g.cx + g.rx, y: g.cy }, desired);
      },
      apply(state, allowed) {
        const g = ringGeom(state);
        // A zero-extent donut has no radius to take a fraction OF — a technical
        // division guard, not a bound on `inner` (the lens_flare precedent).
        if (g.rx <= 0) return { inner: 0 };
        return { inner: (allowed.x - g.cx) / g.rx };
      },
    }];
  },
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): bbox placement — click-drag
  // sizes the rect, a plain click places the default size (CanvasView.placementUp;
  // bbox is the default placement kind, no `placement` field needed).
  commands: [
    { id: "add-donut", title: "Add Donut", icon: "mdi:circle-double", run: (app) => app.armCrosshairPlacement(donutPlugin) },
  ],
};
