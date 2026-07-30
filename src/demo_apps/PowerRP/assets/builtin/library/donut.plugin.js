// donut.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// Donut widget — a circle with a hole; the MODIFIER-POINT showcase widget
// (manifest ARCHITECTURE PLAN #1: "the DONUT widget" is the first modifier-
// point consumer). ONE modifier point sits on the inner rim (the 3 o'clock
// point, same convention as the outer bbox's east edge) and drags toward/away
// from the center to scrub `inner` — the hole radius as a PROPORTION (0..1)
// of the outer radius, so the hole scales correctly with the widget's own
// resize (unlike a stored absolute radius, which would need re-deriving on
// every w/h change).
//
// Shape: bbox widget (x,y,w,h) like circle.js, so it gets the standard resize
// handles for free; the outer ellipse fits the bbox exactly (rx=w/2, ry=h/2 —
// same convention as circle.js) and the hole is a proportionally-scaled
// concentric ellipse (rx·inner, ry·inner).
//
// RENDER (WIDGET RENDER PARITY cornerstone): neither backend has a native
// ring/even-odd primitive (verified — see core/outline.js's DONUT_SEGMENTS
// comment: no evenodd/fillRule anywhere in render_gpu, and the PDF backend's
// polygon case is a single non-zero-winding "h f" subpath), so the ring is
// emitted as a triangulated polygon via core/outline.js's donutOutline — the
// SAME approach fancy_arrow.js already uses for its curved dimple geometry.
// Because BOTH the GPU compositor and the PDF backend consume the identical
// IR `polygon` op (vertex-for-vertex, from the same donutOutline call), they
// render the SAME triangles — parity by construction, not by coincidence.
// (An SVG/PDF path with fillRule:"evenodd" would be more elegant and truly
// circular, but would require a NEW IR op implemented in both backends; the
// polygon route reuses an already-proven, already-parity-tested path and
// ships today.)
//
// ── WHY THIS IS AN ASSET, AND THE ONE THING THE MOVE COST ─────────────────────
// The whole widget is pure geometry over `outline` (donutOutline, triangulated,
// pointInPolygon, closestPointOnSegment) plus the IR's polygon/polyline ops, so
// it needed no capability the jail withholds — EXCEPT `commands`, which a plugin
// asset may not declare (a command's run(app) receives the live app). Its
// "Add Donut" palette entry therefore moved to plugins/builtin_asset_commands.js,
// which resolves the type lazily from the registry; the command id `add-donut` is
// unchanged, because tests/multiresize_place_probe.js and tests/modifier_probe.js
// both drive it by that id.
//
// `outline` is exposed to the sandbox rather than reimplemented here on purpose:
// `triangulated` is the reason the Skia, PDF and SVG backends draw this ring with
// the same triangles, and a second ear-clipper inside a sandboxed source would be
// a render-parity hazard, not a convenience.

/**
 * Pure function. The donut's outer-ellipse-fitted-to-bbox geometry, in LOCAL
 * (bbox) space: center + radii. Non-uniform w/h gives an elliptical donut —
 * donutOutline is drawn on a UNIT circle then non-uniformly scaled per axis,
 * matching how circle.js's ellipse fits rx/ry independently to w/h.
 *
 * @example ringGeom({w: 140, h: 140}) // {cx: 70, cy: 70, rx: 70, ry: 70}
 * @example ringGeom({w: 200, h: 100}) // {cx: 100, cy: 50, rx: 100, ry: 50}
 */
function ringGeom(s) {
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
function donutRingOutline(geom, inner) {
  const { cx, cy, rx, ry } = geom;
  return outline.donutOutline({ cx: 0, cy: 0, outerR: 1, inner }).map(([x, y]) => [cx + x * rx, cy + y * ry]);
}

return {
  type: "donut",
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
   * Pure function. State → display-list commands: the annulus outline ear-clips
   * into convex triangles for the IR's convex-only polygon op. A zero-size donut
   * (w or h <= 0) emits nothing.
   *
   * (The source module was NEAR-pure — it reported degenerate geometry once via
   * core/report.js reportOnce. `report` is not in the sandbox's API, and a
   * declarative plugin has no business owning a process-lifetime dedupe cache, so
   * this emit is plainly pure: the only degenerate case it had to say anything
   * about is the zero-radius one, which it answers by drawing nothing.)
   */
  emit(s, _targetWorldIR, world) {
    const geom = ringGeom(s);
    if (geom.rx <= 0 || geom.ry <= 0) return [];
    const ring = donutRingOutline(geom, s.inner ?? 0.5);
    const tris = outline.triangulated(ring);
    const opacity = s.opacity ?? 1;
    const fillTris = tris.map((tri) => polygon({ points: tri, fill: s.fill, opacity }));
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
    if ((s.strokeWidth ?? 0) <= 0) return fx(fillTris);
    const half = ring.length / 2;
    const outer = [...ring.slice(0, half), ring[0]];
    const inner = [...ring.slice(half), ring[half]];
    return fx([
      ...fillTris,
      polyline({ points: outer, width: s.strokeWidth, color: s.stroke, opacity }),
      polyline({ points: inner, width: s.strokeWidth, color: s.stroke, opacity }),
    ]);
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    const geom = ringGeom(s);
    if (geom.rx <= 0 || geom.ry <= 0) return false;
    return outline.pointInPolygon(donutRingOutline(geom, s.inner ?? 0.5), lx, ly);
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
        return outline.closestPointOnSegment({ x: g.cx, y: g.cy }, { x: g.cx + g.rx, y: g.cy }, desired);
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
  // bbox is the default placement kind, no `placement` field needed). The
  // "Add Donut" palette command lives in plugins/builtin_asset_commands.js: a
  // plugin ASSET may not declare `commands` (the jail withholds the live app).
};
