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
import { closestPointOnCircle } from "../core/outline.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
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

/**
 * THE TEN LENSES, IN ORDER OF POWER — one FLAT family.
 *
 * ONE FLAT `presets`. These are alternative WHOLE instruments over the same six
 * keys, not composable aspects: a "silhouette" family and an "optics" family would
 * both have to name `strokeWidth` and `magnification` for the overlay rule to hold,
 * so the split is the kind core/registry.js's disjointness requirement forbids.
 * (plugins/demo/glass.js IS a legal two-family split — material against silhouette,
 * genuinely disjoint keys. This widget has too few knobs to divide that way.)
 *
 * THE ORDER IS THE CONTENT: magnification runs 1.5x -> 20x down the pane, because
 * power is what a magnifier IS. The sourced anchors on that ladder are 2-6x for a
 * handheld reading glass, ~5x for judging a 35 mm slide, 10x as the gemological
 * clarity-grading standard (above which depth of field and field of view stop being
 * instructive), and ~25x as the ceiling before a microscope is the right tool. The
 * values between them are interpolated, not claimed.
 *
 * SILHOUETTE IS NOT DECORATION. A box lens is here because ONE researched instrument
 * genuinely has a square field: the linen tester, whose cheap form is a square
 * opening in the foot with a scale along its edges. The other box presets are
 * software and paper artefacts — a screenshot crop, a chart magnifier, a sheet
 * magnifier — which are rectangular for the same reason a page is.
 *
 * `supersample: false` IS A LOOK, not a performance setting, and two presets use it
 * that way: a thick simple lens really is soft at the edge of its resolving power,
 * and a sheet magnifier really does lose detail between its concentric rings.
 * Everything else re-renders crisp.
 *
 * `cornerRadius` IS INERT ON EVERY CIRCLE PRESET AND IS WRITTEN ANYWAY. Application
 * is an overlay, so omitting it would leave a circle picked after "Screenshot Inset"
 * carrying a 12-unit radius that does nothing today and surfaces the moment the user
 * switches the shape to box.
 *
 * NO PRESET SETS `origin`. That is the world point the author retargeted the lens
 * to — the same class as a dragged light position — and a preset must not move it.
 * NO PRESET SETS AN EFFECT either: the registry injects the whole effects bundle
 * here, and render_gpu/ports.js would apply it even though emit() never calls
 * applyEffects, but a magnifier is a BACKDROP SAMPLER and what the effect substrate
 * does to an op whose entire content is "the composite so far" is unverified.
 * Shipping that blind across ten presets — the overlay rule makes it
 * all-or-nothing — is not a risk worth taking; a loupe with a drop shadow is a good
 * idea awaiting one render check.
 *
 * SIBLING PAIRING (core/registry.js's cross-widget answer is to share the NAME, not
 * the mechanism): nine of these names are carried verbatim by plugins/demo/magnify.js.
 * If either table is edited, edit both. "Map Reader" is this widget's alone because
 * it needs `cornerRadius`, which the sibling has not got, and "Screenshot Inset"
 * renders ROUNDED here and sharp there — its description says so rather than letting
 * the two silently diverge.
 */
const PRESETS = [
  { name: "Fresnel Sheet", description: "The flat page magnifier: concentric ring lenses spread over a whole paragraph — wide, weak, frameless, and soft the way a sheet lens really is.", props: { shape: "box", magnification: 1.5, supersample: false, stroke: "#000000", strokeWidth: 0, cornerRadius: 0 } },
  { name: "Map Reader", description: "The chart magnifier laid flat across a map: a wide, low-power window with lightly rounded corners and a dark plastic edge.", props: { shape: "box", magnification: 1.8, supersample: true, stroke: "#2a2f36", strokeWidth: 3, cornerRadius: 6 } },
  { name: "Reading Glass", description: "The handheld reading glass at the bottom of the 2-6x range, in the thick horn-coloured frame those are always mounted in.", props: { shape: "circle", magnification: 2, supersample: true, stroke: "#3b2f2a", strokeWidth: 10, cornerRadius: 0 } },
  { name: "Screenshot Inset", description: "The software zoom callout: a rounded rectangular crop of the pixels beneath it, held by a hairline light rim.", props: { shape: "box", magnification: 3, supersample: true, stroke: "#e6e8ec", strokeWidth: 2, cornerRadius: 12 } },
  { name: "Comic Zoom", description: "The comic-panel blow-up: a fat white ring punched over the artwork, at the modest power a printed panel can stand.", props: { shape: "circle", magnification: 3.5, supersample: true, stroke: "#ffffff", strokeWidth: 14, cornerRadius: 0 } },
  { name: "Soft Loupe", description: "A thick simple lens worked at the edge of what it can resolve: rimless, and deliberately sampled rather than re-rendered, so it goes soft the way cheap glass does.", props: { shape: "circle", magnification: 4, supersample: false, stroke: "#000000", strokeWidth: 0, cornerRadius: 0 } },
  { name: "Watchmaker's Eyeglass", description: "The eyeglass a movement is assembled under: mid power in a brass cylinder, and sharp, because the whole point is seeing the jewel.", props: { shape: "circle", magnification: 5, supersample: true, stroke: "#b08d3f", strokeWidth: 8, cornerRadius: 0 } },
  { name: "Linen Tester", description: "The thread counter on its folding stand — the one instrument here whose field of view is genuinely SQUARE, in a thin steel frame.", props: { shape: "box", magnification: 6, supersample: true, stroke: "#8a9099", strokeWidth: 3, cornerRadius: 0 } },
  { name: "Jeweller's Loupe", description: "The 10x triplet a stone is graded through: the standard clarity-grading power, in a plain black barrel, above which depth of field stops being useful.", props: { shape: "circle", magnification: 10, supersample: true, stroke: "#101012", strokeWidth: 5, cornerRadius: 0 } },
  { name: "Microscope Field", description: "The top of what a head-worn loupe manages before a microscope is the right tool: very high power behind a thin dark ring.", props: { shape: "circle", magnification: 20, supersample: true, stroke: "#1a1a1a", strokeWidth: 3, cornerRadius: 0 } },
];

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
  presets: PRESETS,
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
  // THE LENS RIM, case for case with hitTest above — which is the point: the two
  // answer the same question about the same silhouette, so they are written from
  // the same lensGeom and cannot drift into disagreeing about where this widget
  // is. Declaring it does two things at once: `closest_to_rim` accepts a
  // magnifier for the first time, and THE INK RULE (core/derive.js
  // withInkAnchors) moves the four bbox CORNER anchors off the empty corners of
  // a round lens and onto its rim — six of nine were off the ink before this.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const g = lensGeom(state);
    if (state.shape === "box")
      return closestPointOnRectBorder({ x: g.cx - g.halfW, y: g.cy - g.halfH, w: g.halfW * 2, h: g.halfH * 2 }, local.x, local.y);
    return closestPointOnCircle({ x: g.cx, y: g.cy }, g.r, local.x, local.y);
  },
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-magnifier", title: "Add Magnifier", icon: "mdi:magnify", run: (app) => app.armCrosshairPlacement(magnifierPlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP)
  ],
};
