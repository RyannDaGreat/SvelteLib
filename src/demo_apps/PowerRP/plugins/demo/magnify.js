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
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte).
 * DOM-free / bare-node-safe at import time (mirrors glass.js / crt.js).
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { ellipsePoints } from "../../core/shapes.js";
import { closestPointOnCircle, closestPointOnOutlines } from "../../core/outline.js";
import { closestPointOnRectBorder } from "../../core/geometry.js";
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
  { name: "magnificationX", kind: "number", default: 0, min: 0, scrub: 0.01,
    help: "Horizontal zoom. 0 = auto (use Magnification). Set independently of Y to squish/stretch the magnified content (anisotropic loupe)." },
  { name: "magnificationY", kind: "number", default: 0, min: 0, scrub: 0.01,
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

/**
 * THE TWELVE LENSES: NINE ON THE POWER LADDER, THEN THREE THIS WIDGET ALONE CAN DO.
 * One FLAT family.
 *
 * PAIRED BY NAME WITH plugins/magnifier.js. A preset applies to ONE item and the
 * mechanism is deliberately not extended to reach siblings, so the house answer for
 * a look that spans two widgets is to give the matching rows THE SAME NAME and say
 * so in the description. The first nine here run the same 1.5x -> 20x ladder under
 * the same nine names, so the two panes read alike. Two names are deliberately
 * handled differently and BOTH say so rather than diverging in silence: "Map Reader"
 * is absent because it needs a rounded box and this widget has no `cornerRadius`,
 * and "Screenshot Inset" is here with SHARP corners for the same reason.
 * tests/instrument_presets_test.js gates that pairing — a name unique to one family
 * must be justified by a key or an enum value the sibling's schema cannot express.
 *
 * A SEPARATE SHARED PRESET MODULE IS NOT JUSTIFIED, even with nine shared names. A
 * shared data module is for several plugins sharing THE SAME ROWS
 * (plugins/graph_presets.js serves four graph widgets identical rows); these two
 * share no row at all — every entry differs in `cornerRadius` present-vs-absent,
 * `box` vs `square`, and the per-axis keys — so a shared module would be nine pairs
 * of near-duplicates plus a divergence, which is worse than two honest tables.
 *
 * ONE FLAT FAMILY, and the mechanical test is not the reason. A split into
 * "silhouette" (shape/points/innerRatio) and "optics" (magnification/X/Y/supersample)
 * WOULD pass the disjointness gate, unlike on the sibling. It is still wrong: these
 * presets are named INSTRUMENTS, not composable aspects. "Jeweller's Loupe" is a
 * circle AND 10x; splitting it would let someone pick that from one family and
 * "Sunburst Seal" from the other and get a 10x twelve-pointed star that models
 * nothing. plugins/demo/glass.js's legal material/silhouette split works because a
 * glass panel genuinely IS a material on a silhouette and every combination is
 * meaningful. That is not true of instruments.
 *
 * THE LAST THREE ARE THIS WIDGET'S OWN VOCABULARY, and the two stars differ by a
 * DETERMINED number rather than by taste: a regular pentagram's inner vertices sit
 * at cos(2pi/5)/cos(pi/5) = 0.382 of the outer radius (that is 1/phi^2), which is
 * derivable straight from starVerts above, so 0.382 is the TRUE five-pointed star
 * and the familiar 0.5 badge star is a fattened one. Twelve points notched at 0.72
 * stops reading as a star at all and becomes the rosette a wax seal is. Neither is
 * optics, and neither description pretends it is.
 *
 * EVERY PRESET SETS `points`, `innerRatio` AND BOTH PER-AXIS ZOOMS even where they
 * are inert, because application is an OVERLAY: without it, a circle picked after
 * "Sunburst Seal" would carry points:12 in its state, invisible until someone
 * switched the shape and got a dodecagram they never asked for. This is the widget
 * where that rule does the most work — the two star knobs are inert on ten of twelve
 * rows and the per-axis zooms on eleven.
 *
 * NO PRESET SETS `origin` (the world point the author retargeted the lens to) and
 * NO PRESET SETS AN EFFECT, for the same unverified backdrop-sampler reason recorded
 * on the sibling. If effects are ever cleared for a sampler, BOTH families should
 * gain them together so the paired names keep matching.
 */
const PRESETS = [
  { name: "Fresnel Sheet", description: "The flat page magnifier: concentric ring lenses spread over a whole paragraph — wide, weak, frameless, and soft the way a sheet lens really is.", props: { shape: "square", magnification: 1.5, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: false, stroke: "#000000", strokeWidth: 0 } },
  { name: "Reading Glass", description: "The handheld reading glass at the bottom of the 2-6x range, in the thick horn-coloured frame those are always mounted in.", props: { shape: "circle", magnification: 2, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#3b2f2a", strokeWidth: 10 } },
  { name: "Screenshot Inset", description: "The software zoom callout: a rectangular crop of the pixels beneath, held by a hairline light rim — sharp-cornered here, where the canonical magnifier rounds it.", props: { shape: "square", magnification: 3, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#e6e8ec", strokeWidth: 2 } },
  { name: "Comic Zoom", description: "The comic-panel blow-up: a fat white ring punched over the artwork, at the modest power a printed panel can stand.", props: { shape: "circle", magnification: 3.5, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#ffffff", strokeWidth: 14 } },
  { name: "Soft Loupe", description: "A thick simple lens worked at the edge of what it can resolve: rimless, and deliberately sampled rather than re-rendered, so it goes soft the way cheap glass does.", props: { shape: "circle", magnification: 4, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: false, stroke: "#000000", strokeWidth: 0 } },
  { name: "Watchmaker's Eyeglass", description: "The eyeglass a movement is assembled under: mid power in a brass cylinder, and sharp, because the whole point is seeing the jewel.", props: { shape: "circle", magnification: 5, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#b08d3f", strokeWidth: 8 } },
  { name: "Linen Tester", description: "The thread counter on its folding stand — the one instrument here whose field of view is genuinely SQUARE, in a thin steel frame.", props: { shape: "square", magnification: 6, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#8a9099", strokeWidth: 3 } },
  { name: "Jeweller's Loupe", description: "The 10x triplet a stone is graded through: the standard clarity-grading power, in a plain black barrel, above which depth of field stops being useful.", props: { shape: "circle", magnification: 10, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#101012", strokeWidth: 5 } },
  { name: "Microscope Field", description: "The top of what a head-worn loupe manages before a microscope is the right tool: very high power behind a thin dark ring.", props: { shape: "circle", magnification: 20, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.5, supersample: true, stroke: "#1a1a1a", strokeWidth: 3 } },
  { name: "Pentagram Lens", description: "The true five-pointed star: notches cut to one over phi squared of the outer radius, which is where a regular pentagram's inner vertices actually fall — sharper than the star anyone draws freehand.", props: { shape: "star", magnification: 4, magnificationX: 0, magnificationY: 0, points: 5, innerRatio: 0.382, supersample: true, stroke: "#1b1b22", strokeWidth: 4 } },
  { name: "Sunburst Seal", description: "The twelve-pointed rosette of a wax seal or a certificate mark: so many points, notched so shallowly, that it stops reading as a star and becomes a sun.", props: { shape: "star", magnification: 3, magnificationX: 0, magnificationY: 0, points: 12, innerRatio: 0.72, supersample: true, stroke: "#a8862c", strokeWidth: 6 } },
  { name: "Anamorphic Squeeze", description: "The only anisotropic lens in the set: twice the zoom across as down, so the field beneath is stretched sideways instead of enlarged evenly.", props: { shape: "square", magnification: 2, magnificationX: 2, magnificationY: 1, points: 5, innerRatio: 0.5, supersample: true, stroke: "#101010", strokeWidth: 3 } },
];

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
  presets: PRESETS,
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
  // THE LENS RIM, case for case with hitTest above and from the same geometry,
  // so the two cannot disagree about where this widget is. It also puts this
  // widget's bbox corner anchors on the lens instead of in the empty corners
  // around it, through THE INK RULE (core/derive.js withInkAnchors) — a star
  // lens is the sharpest case, since seven of its nine used to be off the ink.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const g = lensGeom(state);
    if (state.shape === "square")
      return closestPointOnRectBorder({ x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 }, local.x, local.y);
    if (state.shape === "star")
      return closestPointOnOutlines([starVerts(state.w, state.h, state.points, state.innerRatio)], local.x, local.y, { x: g.cx, y: g.cy });
    return closestPointOnCircle({ x: g.cx, y: g.cy }, g.r, local.x, local.y);
  },
  anchors: standardBBoxAnchors,
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};
