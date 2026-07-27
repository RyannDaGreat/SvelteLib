/**
 * Magnifier — a DEMO WIDGET (plugins/demo/, the showcase folder) and the SAMPLER
 * member of the reusable MATERIAL FAMILY. A lens that magnifies the content
 * beneath it, clipped to a chosen SILHOUETTE: a CIRCLE (inscribed in the box), a
 * sharp SQUARE (the full box), or an n-pointed STAR (core/shapes.js starPathD
 * geometry). The magnified backdrop is clipped to that outline, so a star lens
 * shows a star-shaped loupe.
 *
 * Magnify is NOT an SkSL RuntimeEffect like Liquid Glass / CRT: it SAMPLES the
 * composite-so-far with a SCALE (and, on the crisp path, RE-RENDERS just the
 * minimal lens footprint at magnified zoom) — something no in-place distortion
 * shader can do. It is therefore registered in the material registry
 * (render_gpu/skia/materials.js MAGNIFY_MATERIAL) as the third material KIND, a
 * SAMPLER (isSamplerMaterial): it keeps its own IR op (`magnifyBackdrop`) +
 * handler (paint_skia handleMagnifyBackdrop, whose minimal-bbox footprint clamp is
 * the recent backdrop-perf work), while still "joining the family" so any widget
 * can discover it through the ONE registry.
 *
 * Like Liquid Glass / CRT it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (standard resize handles); every knob is a CUSTOM self.* property
 * (core/properties.js customProps — the Blender-style mechanism), so shape /
 * magnification / points / innerRatio / supersample are each equation-capable
 * (edit as a literal, an expression, or a `= …` equation; reference as self.<name>)
 * with ZERO evaluation-engine changes.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte).
 * DOM-free / bare-node-safe at import time (mirrors glass.js / crt.js).
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { ellipsePoints } from "../../core/shapes.js";
import * as T from "../../core/transform.js";
import { magnifyBackdrop } from "../../render_gpu/ir.js";

// The lens knobs, all self.* custom properties. `shape` selects the silhouette;
// `points`/`innerRatio` shape the STAR only; `supersample` picks the crisp
// re-render vs the soft backdrop-sample fill.
const CUSTOM = customProps([
  { name: "shape", kind: "select", default: "circle", options: ["circle", "square", "star"],
    optionLabels: { circle: "Circle", square: "Square", star: "Star" },
    help: "The lens silhouette the magnified backdrop is clipped to: a Circle (inscribed in the box), a sharp Square (the full box), or an n-pointed Star." },
  { name: "magnification", kind: "number", default: 2.5, min: 0.01,
    help: "How much the lens enlarges what is beneath it. 2.5 shows a region 1/2.5 the lens size, blown up to fill the lens. Used when the per-axis overrides below are 0 (auto)." },
  // Per-axis (anisotropic) zoom. 0 = AUTO → fall back to the isotropic
  // `magnification` (so a plain magnifier is unchanged / byte-identical). Set
  // both (e.g. = self.w/@source.w and = self.h/@source.h) to make the lens show
  // a source region and STRETCH it to fill a differently-proportioned lens box.
  { name: "magnificationX", kind: "number", default: 0, min: 0,
    help: "Horizontal zoom. 0 = auto (use Magnification). Set independently of Y to squish/stretch the magnified content (anisotropic loupe)." },
  { name: "magnificationY", kind: "number", default: 0, min: 0,
    help: "Vertical zoom. 0 = auto (use Magnification). Set independently of X for an anisotropic loupe." },
  { name: "points", kind: "number", default: 5, min: 2,
    help: "STAR only: how many points the star has. Ignored by the circle and square lenses." },
  { name: "innerRatio", kind: "number", default: 0.5, min: 0, max: 1,
    help: "STAR only: how deep the notches cut — the inner radius as a fraction of the outer. Smaller is spikier." },
  { name: "supersample", kind: "boolean", default: true,
    help: "Re-render the content under the lens at magnified resolution (crisp). Off samples the already-drawn backdrop scaled up (softer, cheaper)." },
]);

/**
 * Pure function. The lens geometry for a bbox of size (w, h): the LOCAL region
 * center (w/2, h/2), the inscribed-circle radius min(w,h)/2, and the box/star
 * half-extents. emit() emits LOCAL-space commands (sceneIR wraps them in the
 * node's world), so x/y do not enter here.
 *
 * @example lensGeom({w: 200, h: 120}) // {cx: 100, cy: 60, r: 60, halfW: 100, halfH: 60}
 * @example lensGeom({w: 160, h: 160}) // {cx: 80, cy: 80, r: 80, halfW: 80, halfH: 80}
 */
export function lensGeom(s) {
  return { cx: s.w / 2, cy: s.h / 2, r: Math.min(s.w, s.h) / 2, halfW: s.w / 2, halfH: s.h / 2 };
}

/**
 * Pure function. The LOCAL-space point the lens magnifies FROM. state.origin.{x,y}
 * are WORLD coordinates (the equation pair, defaulting to the lens's own center);
 * the IR op wants LOCAL, so this maps world→local via the inverse world. A
 * missing/non-numeric origin (hand-built state) falls back to the lens center.
 *
 * @example originLocal({origin: {x: 100, y: 60}}, {cx: 100, cy: 60}, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 100, y: 60}
 * @example originLocal({}, {cx: 80, cy: 80}, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 80, y: 80} (no origin → center)
 */
export function originLocal(state, center, world) {
  const o = state.origin;
  if (!o || typeof o.x !== "number" || typeof o.y !== "number") return { x: center.cx, y: center.cy };
  return T.apply(T.invert(world), o.x, o.y);
}

/**
 * Pure function. The vertices of an n-pointed STAR inscribed in the (w, h) box,
 * pointing up — the SAME geometry the star LENS clips to (core/shapes.js starPathD
 * and paint_skia lensStarPoints): outer tips on the box ellipse, inner notches
 * scaled by innerRatio. Reuses ellipsePoints for the outer ring so the hit-test
 * silhouette matches what is rendered. Returns 2·points [x, y] vertices.
 *
 * @example starVerts(200, 200, 5, 0.5).length // 10
 * @example starVerts(200, 200, 5, 0.5)[0].map(Math.round) // [100, 0] (top tip)
 */
export function starVerts(w, h, points, innerRatio) {
  const p = Math.max(2, Math.round(points));
  const inner = Math.max(0, Math.min(1, innerRatio));
  const cx = w / 2, cy = h / 2;
  return ellipsePoints(w, h, p * 2).map(([x, y], i) => {
    const sc = i % 2 === 0 ? 1 : inner; // even = outer tip, odd = inner notch
    return [cx + (x - cx) * sc, cy + (y - cy) * sc];
  });
}

/**
 * Pure function. Even-odd point-in-polygon test (ray cast).
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<[number,number]>} verts - closed polygon vertices (order matters)
 * @returns {boolean}
 *
 * @example pointInPolygon(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]) // true
 * @example pointInPolygon(20, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]) // false
 */
export function pointInPolygon(x, y, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const magnifyPlugin = {
  type: "demo_magnify",
  title: "Magnifier",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "demo_magnify", x: 260, y: 170, w: 200, h: 200, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // The world point the lens magnifies FROM (its target). Default = its own
    // center, so a fresh magnifier magnifies about itself. Equation-capable pair,
    // exactly like rotationAnchor.
    origin: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // The rim/border — the shared stroked-box bundle. strokeWidth 0 = no rim.
    stroke: "#000000", strokeWidth: 4,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // shape / magnification / points / innerRatio / supersample (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    // TARGET (origin) — the world point the lens magnifies FROM (default = center).
    { key: "origin.x", label: "Target X", kind: "number", category: "positioning" },
    { key: "origin.y", label: "Target Y", kind: "number", category: "positioning" },
    ...props("stroke", "strokeWidth", { stroke: { label: "Rim color" }, strokeWidth: { label: "Rim width" } }),
    // OPACITY: the default is already spread above and emit() already sends it to
    // the op — it simply had no Inspector row, so the knob existed and was
    // unreachable. (Found by the universal-effects sweep.)
    ...props("opacity"),
    ...CUSTOM.rows, // the lens knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State → display-list: ONE magnifyBackdrop op, its silhouette
   * chosen by `shape`. square → the box path with sharp corners; star → the star
   * path (points/innerRatio); circle → the inscribed disk. `world` (sceneIR's 3rd
   * arg) maps the evaluated WORLD origin back to LOCAL (see originLocal).
   */
  emit(s, _targetWorldIR, world = T.identity()) {
    const g = lensGeom(s);
    const o = originLocal(s, g, world);
    const strokeW = s.strokeWidth ?? 0;
    // Per-axis zoom: 0 = auto → the isotropic `magnification` (so a plain lens is
    // byte-identical). When both resolve equal, the op stays isotropic.
    const magX = s.magnificationX > 0 ? s.magnificationX : s.magnification;
    const magY = s.magnificationY > 0 ? s.magnificationY : s.magnification;
    const common = {
      originX: o.x, originY: o.y,
      magnification: s.magnification, magnificationX: magX, magnificationY: magY,
      opacity: s.opacity ?? 1,
      supersample: s.supersample ?? true,
      stroke: strokeW > 0 ? s.stroke : null, strokeWidth: strokeW,
    };
    if (s.shape === "square")
      return [magnifyBackdrop({ ...common, shape: "box", cx: g.cx, cy: g.cy, halfW: g.halfW, halfH: g.halfH, cornerRadius: 0 })];
    if (s.shape === "star")
      return [magnifyBackdrop({ ...common, shape: "star", cx: g.cx, cy: g.cy, halfW: g.halfW, halfH: g.halfH, points: s.points, innerRatio: s.innerRatio })];
    return [magnifyBackdrop({ ...common, shape: "circle", cx: g.cx, cy: g.cy, r: g.r })];
  },
  hitTest(s, lx, ly) {
    const g = lensGeom(s);
    if (s.shape === "square") return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
    if (s.shape === "star") return pointInPolygon(lx, ly, starVerts(s.w, s.h, s.points, s.innerRatio));
    return (lx - g.cx) ** 2 + (ly - g.cy) ** 2 <= g.r * g.r;
  },
  snapFeatures(s) {
    const { cx, cy } = lensGeom(s);
    return [{ kind: "point", x: cx, y: cy, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
