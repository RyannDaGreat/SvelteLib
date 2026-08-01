/**
 * Magnifying glass — the "PowerPoint can't do this" demo widget, and the
 * proof of the backdrop-sampling capability. Ported concept from pimgui's
 * MagnifyingGlass (mask_animator/pimgui_skia.py): sample the composite
 * beneath, upscale about the origin, composite through a shaped clip.
 *
 * SHAPED LENS (manifest "BOX-SHAPED MAGNIFIERS + magnifier ORIGIN"): the lens
 * region is either a CIRCLE (`shape:"circle"`, radius min(w,h)/2 centered in
 * the box) or a ROUNDED RECT (`shape:"box"`, the w×h box with cornerRadius —
 * the SAME box geometry a crop box / image / video uses, via the shared
 * stroked-box bundle). Both flow through ONE shaped-lens code path in every
 * backend (a lens = shaped clip + magnified re-emit + rim/border); a crop box
 * is the magnification-1 sibling of the same family.
 *
 * Bbox widget (x,y,w,h) so it gets the STANDARD resize handles (manifest rule).
 *
 * ORIGIN (manifest "magnifier target"): `origin.{x,y}` is a pair of equations
 * naming the world point the lens magnifies FROM (what shows at the lens
 * center), defaulting to the lens's own center (self.anchors.center) so a fresh
 * magnifier magnifies about itself exactly as before origin existed;
 * retargetable to any anchor. (Opus24 owns the origin/target ROW plumbing and
 * equation UX; this file only reads the evaluated origin in emit() and declares
 * the default equation pair — the state-key handshake with the lead: origin.x/
 * origin.y, defaults "self.anchors.center.{x,y}".)
 *
 * BORDER = the shared stroked-box bundle's stroke/strokeWidth (+ cornerRadius
 * for the box shape). The old rimColor/rimWidth are MIGRATED to stroke/
 * strokeWidth on load (legacyKeys, the arrow's color/width→stroke/strokeWidth
 * precedent) — the circular rim and the box border are the SAME stroke ring.
 *
 * Two lens-fill paths, chosen by the `supersample` state prop:
 *   supersample:false — sample the composite-so-far backdrop and upscale it by
 *     `magnification` about the origin. The lens content is an already-
 *     rasterized backdrop upscaled, i.e. effectively 1/M of screen resolution —
 *     soft by nature (the manifest's known physics note).
 *   supersample:true (default) — RE-RENDER just the world region under the lens
 *     (only nodes with z strictly below the magnifier) into an offscreen canvas,
 *     then composite that through the shaped clip. A true re-render at display
 *     resolution, so it's sharp. A lens NESTED inside another lens's replay
 *     falls back to the sampling path (the MAX_SUPERSAMPLE_DEPTH recursion guard,
 *     which lives in render_gpu/skia/paint_skia.js beside the replay it bounds —
 *     NOT in gpu/compositor.js, which this comment named until the retired
 *     prototype backend took that file with it; see render_gpu/FINDINGS.md).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import * as T from "../core/transform.js";
import { bundle, defaults, props } from "../core/properties.js";
import { magnifyBackdrop } from "../render_gpu/ir.js";

/**
 * Pure function. Normalizes state to the bbox lens geometry, accepting legacy
 * center+radius magnifier states from older saves. Returns the circle geometry
 * (cx, cy, r) AND the box geometry (halfW, halfH) — the shaped lens uses
 * whichever its `shape` selects; `r` is min(w,h)/2 (the inscribed circle),
 * (halfW, halfH) are the box half-extents. (cx, cy) is the LOCAL region center
 * (w/2, h/2) — emit() emits local-space commands that sceneIR wraps in the
 * node's world (so x/y do not enter here for the bbox form).
 *
 * @example lensGeom({x: 10, y: 20, w: 100, h: 60}) // {cx: 50, cy: 30, r: 30, halfW: 50, halfH: 30}
 * @example lensGeom({x: 50, y: 50, radius: 40}) // {cx: 50, cy: 50, r: 40, halfW: 40, halfH: 40} (legacy center-based)
 */
export function lensGeom(s) {
  if (s.w === undefined && s.radius !== undefined)
    return { cx: s.x, cy: s.y, r: s.radius, halfW: s.radius, halfH: s.radius };
  return { cx: s.w / 2, cy: s.h / 2, r: Math.min(s.w, s.h) / 2, halfW: s.w / 2, halfH: s.h / 2 };
}

/**
 * Pure function. The LOCAL-space origin point a magnifier magnifies from, given
 * its evaluated state and the node's world transform. `state.origin.{x,y}` are
 * evaluated to WORLD coordinates (the lead's origin handshake — same as
 * rotationAnchor); the IR op wants LOCAL coordinates (sceneIR re-wraps emit()'s
 * output in the node's world), so this maps world→local via the inverse world.
 * A missing origin (hand-built state / pre-origin saves) falls back to the lens
 * CENTER — byte-identical to before origin existed.
 *
 * @example originLocal({origin: {x: 60, y: 50}}, {cx: 60, cy: 50}, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 60, y: 50}
 * @example originLocal({}, {cx: 30, cy: 20}, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 30, y: 20} (no origin → center)
 */
export function originLocal(state, center, world) {
  const o = state.origin;
  if (!o || typeof o.x !== "number" || typeof o.y !== "number") return { x: center.cx, y: center.cy };
  return T.apply(T.invert(world), o.x, o.y);
}

/**
 * Pure function. The WORLD-space source square a lens of world-radius `r`
 * centered at (cwx, cwy) samples at magnification `m`: a square of side 2r/m
 * (magnifying by m shows a 1/m-sized region). Returned as {x, y, w, h}.
 *
 * @example lensSourceRect(100, 100, 50, 2) // {x: 75, y: 75, w: 50, h: 50}
 * @example lensSourceRect(0, 0, 10, 1) // {x: -10, y: -10, w: 20, h: 20}
 */
export function lensSourceRect(cwx, cwy, r, m) {
  const half = r / Math.max(m, 0.01);
  return { x: cwx - half, y: cwy - half, w: half * 2, h: half * 2 };
}

export const magnifierPlugin = {
  type: "magnifier",
  title: "Magnifier",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "magnifier", shape: "circle", x: 270, y: 170, w: 160, h: 160, z: 100,
    // ORIGIN (Opus24's territory; default declared here per the lead's key
    // handshake): the world point the lens magnifies FROM. Default = the lens's
    // own center, so a fresh magnifier magnifies about itself (byte-identical
    // to before origin existed). Same equation-pair shape as rotationAnchor.
    origin: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    magnification: 2.5, supersample: true,
    // Border = the shared stroked-box bundle (migrated from rimColor/rimWidth
    // via legacyKeys below). cornerRadius applies to the box shape only.
    stroke: "#000000",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth 0, cornerRadius 0, opacity 1
    strokeWidth: 4, // the old rimWidth default (border shows by default)
  },
  // rimColor/rimWidth → stroke/strokeWidth: the circular rim IS the box border,
  // one stroke ring (manifest "the circular rim maps to the same stroke
  // properties"). Same declarative load-time rename as the arrow's color/width
  // (core/document.js legacyKeyRenames). radius→(none): the legacy center+radius
  // form is still read by lensGeom at emit time (older than the key-rename seam).
  legacyKeys: { rimColor: "stroke", rimWidth: "strokeWidth" },
  // `category` groups rows into the Inspector's collapsible accordion regions.
  // POSITIONING rows stay hand-written: they are Opus24's active territory (it
  // merges the origin/target equation rows in around them — the lead's Q2
  // ruling). SHAPE + the stroked-box BORDER bundle rows are mine (this task's
  // fence); the border bundle composes from core/properties.js exactly as
  // rect/image/video do, so a future stroke aspect reaches the magnifier free.
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    // ── TARGET (Opus24's territory) — the world point the lens magnifies FROM.
    // Equation-aware number rows (default self.anchors.center → the lens's own
    // center; retarget via the anchor picker / an equation to any anchor). The
    // lens renders the region around THIS point instead of its own center.
    { key: "origin.x", label: "Target X", kind: "number", category: "positioning" }, // world point; default self.anchors.center
    { key: "origin.y", label: "Target Y", kind: "number", category: "positioning" },
    // ── SHAPE (this task's fence) ──────────────────────────────────────────
    { key: "shape", label: "Shape", kind: "select", options: ["circle", "box"], optionLabels: { circle: "Circle", box: "Box" }, category: "lens" },
    { key: "magnification", label: "Magnification", kind: "number", min: 0.01, category: "lens" },
    { key: "supersample", label: "Supersample", kind: "boolean", category: "lens" },
    // The stroked-BORDER bundle (stroke/strokeWidth/cornerRadius) in the lens
    // category — the rim/border ring. cornerRadius only affects the box shape.
    ...bundle("strokedBorder", {
      stroke: { label: "Rim color", category: "lens" },
      strokeWidth: { label: "Rim width", category: "lens" },
      cornerRadius: { label: "Corner radius", category: "lens" },
    }),
    // OPACITY: emit() has always sent `s.opacity ?? 1` to the op, but the widget
    // had neither the default nor the row — the knob was unreachable AND absent
    // from item state. (Found by the universal-effects sweep.)
    ...props("opacity"),
  ],
  /**
   * Pure function. One shaped-lens op — the backend samples or re-renders its
   * own backdrop per `supersample`, clipped to the circle | box region and
   * magnified about the ORIGIN. `world` (sceneIR's 3rd arg) maps the evaluated
   * WORLD origin back to LOCAL for the op (see originLocal).
   */
  emit(s, _targetWorldIR, world = T.identity()) {
    const g = lensGeom(s);
    const o = originLocal(s, g, world);
    const strokeW = s.strokeWidth ?? 0;
    const border = strokeW > 0 ? s.stroke : null; // width 0 = NO rim/border (manifest spec)
    const common = {
      originX: o.x, originY: o.y,
      magnification: s.magnification,
      opacity: s.opacity ?? 1,
      supersample: s.supersample ?? true, // re-render below the lens (sharp); false = backdrop sampling (soft)
    };
    if (s.shape === "box") {
      return [magnifyBackdrop({
        ...common, shape: "box", cx: g.cx, cy: g.cy,
        halfW: g.halfW, halfH: g.halfH, cornerRadius: s.cornerRadius ?? 0,
        stroke: border, strokeWidth: strokeW,
      })];
    }
    return [magnifyBackdrop({
      ...common, shape: "circle", cx: g.cx, cy: g.cy, r: g.r,
      stroke: border, strokeWidth: strokeW, // ONE stroke bundle for both shapes (collapsed; the circle rim IS the border)
    })];
  },
  hitTest(s, lx, ly) {
    const g = lensGeom(s);
    if (s.shape === "box")
      return Math.abs(lx - g.cx) <= g.halfW && Math.abs(ly - g.cy) <= g.halfH;
    return (lx - g.cx) ** 2 + (ly - g.cy) ** 2 <= g.r * g.r;
  },
  snapFeatures(s) {
    const { cx, cy } = lensGeom(s);
    return [{ kind: "point", x: cx, y: cy, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-magnifier", title: "Add Magnifier", icon: "mdi:magnify", run: (app) => app.armCrosshairPlacement(magnifierPlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP)
  ],
};
