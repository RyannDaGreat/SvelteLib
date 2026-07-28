/**
 * The draw-command IR — PowerRP's device-independent display list.
 *
 * THE SEAM of the renderer architecture: widgets emit these commands instead of
 * painting a ctx directly; the Skia backend (render_gpu/skia/paint_skia.js, on
 * WebGL2 in the browser and a CPU surface in Node/CLI) rasterizes them, and the
 * vector backends (svg_backend.js, pdf_backend.js) serialize them. The camera
 * region is just the `view` every backend maps world space through — no backend
 * owns the camera.
 *
 * This module is DOM-free pure JS (bare-node testable, like core/).
 *
 * ── Command schema ──────────────────────────────────────────────────────────
 * Geometry is in the CURRENT LOCAL SPACE (the transform stack maps local →
 * world, exactly like the canvas compositor's save/translate/rotate/scale).
 * Colors are [r,g,b,a] float arrays in 0..1 (builders accept CSS hex too).
 *
 *   {op:"rect", x, y, w, h, cornerRadius, fill, stroke, strokeWidth, opacity}
 *   {op:"ellipse", cx, cy, rx, ry, fill, stroke, strokeWidth, opacity}
 *   {op:"polyline", points:[[x,y],...], width, color, opacity}   // round caps/joins
 *   {op:"polygon", points:[[x,y],...], fill, opacity}            // CONVEX fill (fan-triangulated)
 *   {op:"text", text, x, y, size, color, bold, opacity, font}    // top-left origin, single run; font = registry id (fonts.js)
 *   {op:"image", ref, x, y, w, h, opacity}                       // ref → media registry key
 *   {op:"video", ref, x, y, w, h, opacity}                       // ref → <video> registry key
 *   {op:"latexVector", ref, x, y, w, h, glyphs, viewBox, opacity}// dual: vector glyph <path>s (SVG/PDF) + raster ref (GPU/hybrid)
 *   {op:"mermaidVector", ref, x, y, w, h, paths, texts, viewBox, opacity} // dual: vector shapes+text (SVG/PDF/GPU) + raster ref (hybrid); mirrors latexVector
 *   {op:"pushTransform", x, y, rotation, scale, signX, signY}    // SIGNED similarity, composes
 *   {op:"popTransform"}
 *   {op:"blurBackdrop", radius, opacity}                         // radius in WORLD units
 *   {op:"magnifyBackdrop", shape, cx, cy, r, halfW, halfH, cornerRadius, points, innerRatio, originX, originY, magnification, magnificationX, magnificationY, stroke, strokeWidth, opacity, supersample}  // shape "circle"|"box"|"star" (points/innerRatio = star silhouette; rimColor/rimWidth accepted as legacy builder aliases → stroke/strokeWidth; magnificationX/Y = per-axis zoom, default to magnification)
 *   {op:"glassBackdrop", cx, cy, halfW, halfH, cornerRadius, blurRadius, refractionStrength, edgeFalloff, lightAngle, lightIntensity, tint, saturation, materialize, squircle, surfaceTension, sheen, specularPower, contactShadow, caustic, edgeLight, tintAdaptivity, chromatic, backdropScale, shadowStrength, stroke, strokeWidth, opacity}  // macOS Liquid Glass; WORLD-unit lengths; SkSL refraction+chromatic+adaptive tint+specular; backdropScale = below-content sample resolution
 *   {op:"cropSubtree", x, y, w, h, cornerRadius, fill, stroke, strokeWidth, opacity, content}
 *   {op:"effectSubtree", x, y, w, h, content, shadow, bloom, blend, innerShadow, softEdges, shadowOnly, margin}  // Round 12D effects substrate (+inner shadow, +soft edges)
 *   {op:"materialBackdrop", material, cx, cy, halfW, halfH, cornerRadius, blurRadius, backdropScale, params, stroke, strokeWidth, opacity}  // registry-dispatched backdrop MATERIAL (SkSL); generalizes glassBackdrop
 *
 * Backdrop-effect nodes consume the composite-so-far (everything already
 * emitted), replacing the canvas2D full-canvas snapshot with a GPU texture
 * pass. Command order IS z-order: the scene compositor sorts nodes by z
 * before emitting, and backends never reorder across a backdrop boundary.
 * cropSubtree is NOT a backdrop sampler (it doesn't read the composite-so-far
 * — its `content` is a self-contained re-interpretable IR list, the target
 * item's own commands) but backends implement it with the same "re-render a
 * sub-list through a clip" machinery as magnifyBackdrop (manifest: reuse the
 * lens clip+replay machinery with a rounded-rect region).
 *
 * `ref` keeps the IR JSON-serializable: raster backends resolve refs through
 * a media registry {ref → HTMLImageElement/HTMLVideoElement}; vector backends
 * embed a data URL or href.
 */

import * as T from "../core/transform.js";
import { DEFAULT_FONT } from "./fonts.js";
import { angleToLinearEndpoints, GRADIENT_DEFAULT_ANGLE, GRADIENT_DEFAULT_CENTER, GRADIENT_DEFAULT_WAVELENGTH, GRADIENT_STOPS_LIST, SCRUB_WRAP_MODES, BLEND_MODES, STROKE_CAP_MODES, STROKE_CAP_FLAT, STROKE_TRIM_KEYS } from "../core/properties.js";
import { visibleElements } from "../core/lists.js";

// ── colors ──────────────────────────────────────────────────────────────────

/**
 * Pure function. Parses a color to an [r,g,b,a] float array (0..1 channels).
 * Accepts #rgb, #rrggbb, #rrggbbaa, rgb(...)/rgba(...), or an already-parsed
 * array (returned as a copy). Anything else throws — no silent fallback.
 *
 * Args:
 *   color (string|number[]): CSS-ish color or [r,g,b,a?] array
 *
 * Returns:
 *   number[]: [r, g, b, a], each 0..1
 *
 * @example parseColor("#ff0000")           // [1, 0, 0, 1]
 * @example parseColor("#0f8")              // [0, 1, 0.5333] (#0f8 → #00ff88), alpha 1
 * @example parseColor("rgba(255,0,0,0.5)") // [1, 0, 0, 0.5]
 * @example parseColor([0.1, 0.2, 0.3])     // [0.1, 0.2, 0.3, 1]
 */
export function parseColor(color) {
  if (Array.isArray(color)) {
    if (color.length < 3 || color.length > 4) throw new Error(`parseColor: bad array length ${color.length}`);
    return [color[0], color[1], color[2], color[3] ?? 1];
  }
  // A PAINT OBJECT reaching parseColor is a SINGLE-COLOR consumer (a magnifier /
  // crop-box border, a shadow, a background) reading a property (fill/stroke)
  // that is now a polymorphic paint. Those consumers cannot paint a gradient, so
  // resolve the paint to its representative SOLID color and render THAT instead
  // of throwing — the fill/stroke that SHOULD render as a gradient go through
  // parsePaint (rect/ellipse builders), never here. (Genuinely-unrecognized
  // objects still throw loudly inside paintSolidColor.)
  if (color && typeof color === "object") return parseColor(paintSolidColor(color));
  if (typeof color !== "string") throw new Error(`parseColor: unsupported color ${JSON.stringify(color)}`);
  // Memoized per string (near-pure: cache lookup, result copied so callers
  // can't corrupt the cache). Scenes re-emit IR every frame; without this,
  // 20k rects = 20k regex parses per frame — measured as a real bottleneck.
  const cached = PARSE_COLOR_CACHE.get(color);
  if (cached) return [cached[0], cached[1], cached[2], cached[3]];
  const parsed = parseColorUncached(color);
  PARSE_COLOR_CACHE.set(color, parsed);
  return [parsed[0], parsed[1], parsed[2], parsed[3]];
}

const PARSE_COLOR_CACHE = new Map();

/** Pure function. The actual string parsing behind parseColor's memo. */
function parseColorUncached(color) {
  const hex = color.match(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) {
    const h = hex[1];
    // Shorthand #rgb / #rgba: every digit doubles ("#f08c" → "#ff0088cc").
    // The 4-digit form MUST be accepted here because core/interpolators.js
    // isHexColor has always accepted it, so a document can legitimately store
    // one. Rejecting it threw inside CanvasView's render $effect, which tears
    // down the Svelte reactive root and freezes the editor permanently.
    const bytes = h.length <= 4
      ? [...h].map((c) => parseInt(c + c, 16) / 255)
      : h.match(/../g).map((b) => parseInt(b, 16) / 255);
    return bytes.length === 3 ? [...bytes, 1] : bytes;
  }
  const fn = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) return [+fn[1] / 255, +fn[2] / 255, +fn[3] / 255, fn[4] === undefined ? 1 : +fn[4]];
  throw new Error(`parseColor: unsupported color "${color}"`);
}

/**
 * Pure function. [r,g,b,a] floats → CSS rgba() string (for SVG/PDF output).
 *
 * @example rgbaToCss([1, 0, 0, 1])   // "rgba(255,0,0,1)"
 * @example rgbaToCss([0, 0.5, 1, 0.25]) // "rgba(0,128,255,0.25)"
 */
export function rgbaToCss(rgba) {
  const [r, g, b, a] = rgba;
  const byte = (v) => Math.round(v * 255);
  return `rgba(${byte(r)},${byte(g)},${byte(b)},${+a.toFixed(4)})`;
}

// ── paint (Axis-1 PAINT seam) ─────────────────────────────────────────────────
// A Paint is the polymorphic value a fill/stroke field holds. SOLID stays the
// plain [r,g,b,a] array parseColor returns (so every existing op, doctest and
// baseline is byte-identical); a GRADIENT is a tagged object. Backends branch on
// isGradientPaint(): array ⇒ solid setColor, object ⇒ setShader. pattern/image/
// shader Paint variants are DECLARED but throw a loud "not implemented" (the
// Axis-1 phasing: build the common cases, stub the fancy ones).

export const GRADIENT_TYPES = ["linearGradient", "radialGradient"];
const STUB_PAINT_TYPES = ["pattern", "image", "shader"];

/**
 * Pure function. True iff a paint value is a MATERIAL paint — the fill mode
 * that shades the shape with a registered material (render_gpu/skia/
 * materials.js) instead of a color/gradient. Stored SPARSE:
 *   {type: "material", material: {id, params?}}
 * where `params` holds ONLY the knobs the user has written; the full knob set
 * is resolved against the material's fillParams schema at scene-build time
 * (render_gpu/ports.js resolveMaterialFillPaints) — the "no stored state until
 * written" rule. A resolved paint additionally carries `resolvedParams`
 * (complete, scene-inputs folded in); painters REQUIRE it and throw when
 * absent, so a paint that skipped resolution can never silently render with
 * half its knobs missing.
 *
 * @param {*} paint - any paint value
 * @returns {boolean}
 *
 * @example isMaterialPaint({type: "material", material: {id: "comic"}}) // true
 * @example isMaterialPaint({type: "solid", solid: "#fff"}) // false
 * @example isMaterialPaint("#ff0000") // false
 * @example isMaterialPaint(null) // false
 */
export function isMaterialPaint(paint) {
  return !!(paint && typeof paint === "object" && !Array.isArray(paint) && paint.type === "material");
}

/**
 * Pure function. Does this display-list op carry a MATERIAL fill? The predicate
 * the painters route on and the vector exporters use to send an otherwise-
 * vector shape op into the raster-embed fallback (a PDF/SVG cannot express a
 * shader fill as vectors).
 *
 * @param {object} cmd - a display-list op
 * @returns {boolean}
 *
 * @example opHasMaterialFill({op: "rect", fill: {type: "material", material: {id: "comic"}}}) // true
 * @example opHasMaterialFill({op: "rect", fill: "#fff"}) // false
 * @example opHasMaterialFill({op: "image", ref: "x"}) // false
 */
export function opHasMaterialFill(cmd) {
  return isMaterialPaint(cmd.fill);
}

/**
 * Pure function. Does this op carry a MATERIAL stroke? The STROKE twin of
 * opHasMaterialFill — the stroke-material framework's routing predicate
 * (along-path gradients, width profiles, brush stamping). The slot is named
 * and resolved from day one; painters that predate the stroke renderers throw
 * loudly via parsePaint rather than silently drawing a gray outline.
 *
 * @param {object} cmd - a display-list op
 * @returns {boolean}
 *
 * @example opHasMaterialStroke({op: "path", stroke: {type: "material", material: {id: "brush"}}}) // true
 * @example opHasMaterialStroke({op: "path", stroke: "#000"}) // false
 */
export function opHasMaterialStroke(cmd) {
  return isMaterialPaint(cmd.stroke);
}

/**
 * Pure function. The representative SOLID color of a paint OBJECT (its remembered
 * `solid`, else the active gradient's first stop, else a legacy inline gradient's
 * first stop). This is how a SINGLE-COLOR consumer (parseColor) reduces a
 * polymorphic paint it cannot render as a gradient — a magnifier/crop-box border,
 * a shadow, a background. Throws LOUDLY on an object it cannot reduce (never a
 * silent black). The returned color may be a hex string OR an already-parsed
 * rgba array (a parsed gradient's stop) — parseColor handles both.
 *
 * @example paintSolidColor({type: "solid", solid: "#1a1a2e"}) // "#1a1a2e"
 * @example paintSolidColor({type: "linearGradient", solid: "#1a1a2e", linear: {stops: [{offset: 0, color: "#f00"}]}}) // "#1a1a2e"
 * @example paintSolidColor({type: "linearGradient", stops: [{offset: 0, color: "#f00"}, {offset: 1, color: "#00f"}]}) // "#f00" (legacy inline, no remembered solid)
 */
export function paintSolidColor(paint) {
  if (typeof paint.solid === "string" || Array.isArray(paint.solid)) return paint.solid;
  // A MATERIAL paint with no remembered solid reduces to neutral gray — a
  // single-color consumer (a border, a shadow tint) has no meaningful "the
  // color of a comic-halftone shader"; gray is the documented stand-in, the
  // same role the proxy tints play for whole materials.
  if (paint.type === "material") return "#888888";
  const g = paint.type === "radialGradient" ? (paint.radial ?? paint) : (paint.linear ?? paint);
  const stops = Array.isArray(g?.stops) ? g.stops : Array.isArray(paint.stops) ? paint.stops : null;
  if (stops && stops[0] && stops[0].color != null) return stops[0].color;
  throw new Error(`parseColor: cannot resolve a solid color from paint ${JSON.stringify(paint)}`);
}

/**
 * Pure function. True iff a (parsed) paint is a GRADIENT (a tagged object) rather
 * than a SOLID ([r,g,b,a] array) or null. The one-line branch every backend uses
 * to choose setShader vs setColor.
 *
 * @example isGradientPaint([1, 0, 0, 1]) // false (solid)
 * @example isGradientPaint(null) // false
 * @example isGradientPaint({type: "linearGradient", stops: [], from: {x: 0, y: 0}, to: {x: 1, y: 0}}) // true
 */
export function isGradientPaint(paint) {
  return !!(paint && typeof paint === "object" && !Array.isArray(paint));
}

/**
 * Pure function. Parses a Paint value — the Axis-1 PAINT seam. BACKWARD
 * COMPATIBLE: a bare CSS string or rgba array is a SOLID paint and returns the
 * SAME [r,g,b,a] array parseColor returns (existing ops/docs/baselines unchanged).
 * A tagged object selects a paint mode. TWO object shapes are accepted:
 *
 *   MULTI-SUB-STATE (what the PaintField now stores — every mode remembered at
 *   once so switching type never forgets):
 *     {type:"solid",          solid:"#rrggbb[aa]", linear?, radial?}
 *     {type:"linearGradient", linear:{stops, from, to}, solid?, radial?}
 *     {type:"radialGradient", radial:{stops, center, r}, solid?, linear?}
 *   LEGACY INLINE (older docs / fixtures — the gradient fields sit on the object
 *   itself, no sub-state wrapper):
 *     {type:"linearGradient", stops:[{offset,color},...], from:{x,y}, to:{x,y}}
 *     {type:"radialGradient", stops:[{offset,color},...], center:{x,y}, r}
 *
 * The active sub-state is read per `type` (nested wrapper preferred, else the
 * inline fields); the inactive sub-states are the editor's memory and are
 * IGNORED by the renderer. A "solid" object renders BYTE-IDENTICALLY to the
 * bare-string solid of the same color. A linear gradient's from/to endpoints are
 * DERIVED from its authoritative `angle` (degrees) via linearAxis — a keyframed
 * angle tweens as a rotating axis; a stored from/to is only a fallback for an
 * un-migrated in-memory paint. center/r are objectBoundingBox space (0..1 over
 * the LOCAL bbox). Stops are normalized (offset clamped 0..1, color parseColor'd
 * to rgba); a gradient needs >= 2 stops. pattern/image/shader types throw a loud
 * not-implemented stub.
 *
 * @example parsePaint("#ff0000") // [1, 0, 0, 1]
 * @example parsePaint([0.1, 0.2, 0.3]) // [0.1, 0.2, 0.3, 1]
 * @example parsePaint(null) // null
 * @example parsePaint({type: "solid", solid: "#ff0000", linear: {stops: [], from: {x:0,y:0}, to: {x:1,y:0}}}) // [1, 0, 0, 1]
 * @example parsePaint({type: "linearGradient", linear: {stops: [{offset: 0, color: "#000"}, {offset: 1, color: "#fff"}], angle: 90}}).from // {x: 0.5, y: 0} (endpoints derived from angle)
 * @example parsePaint({type: "linearGradient", linear: {stops: [{offset: 0, color: "#000"}, {offset: 1, color: "#fff"}], from: {x: 0, y: 0}, to: {x: 1, y: 0}}}).stops[1].color // [1, 1, 1, 1]
 * @example parsePaint({type: "linearGradient", stops: [{offset: 0, color: "#000"}, {offset: 1, color: "#fff"}], from: {x: 0, y: 0}, to: {x: 1, y: 0}}).stops[1].color // [1, 1, 1, 1] (legacy inline)
 * @example parsePaint({type: "radialGradient", radial: {stops: [{offset: 0, color: "#f00"}, {offset: 1, color: "#00f"}], center: {x: 0.5, y: 0.5}, r: 0.5}}).r // 0.5
 */
export function parsePaint(paint) {
  if (paint === null || paint === undefined) return null;
  if (!isGradientPaint(paint)) return parseColor(paint); // string / rgba array ⇒ solid
  const type = paint.type;
  // Multi-sub-state SOLID: parse the remembered solid color (byte-identical to a
  // bare-string solid) — the render never sees the stashed linear/radial state.
  if (type === "solid") {
    if (typeof paint.solid !== "string" && !Array.isArray(paint.solid))
      throw new Error(`parsePaint: a solid paint object needs a "solid" color, got ${JSON.stringify(paint.solid)}`);
    return parseColor(paint.solid);
  }
  // A MATERIAL paint IS its own normalized form (sparse {material: {id,
  // params}}; ports.resolveMaterialFillPaints adds resolvedParams): the op
  // builders normalize every fill through parsePaint, so it must pass THROUGH.
  // A consumer that can only draw colors/gradients still fails loudly — the
  // gradient shader's type switch throws on the unknown type (never a silent
  // gray fill).
  if (type === "material") return paint;
  if (STUB_PAINT_TYPES.includes(type)) throw new Error(`parsePaint: "${type}" paint is not implemented yet (Axis-1 stub — only solid + ${GRADIENT_TYPES.join("/")} are wired)`);
  if (!GRADIENT_TYPES.includes(type)) throw new Error(`parsePaint: unknown paint type ${JSON.stringify(type)} (known: solid, ${GRADIENT_TYPES.join(", ")}, solid string/array)`);
  // Active gradient sub-state: the nested wrapper for this type, else the legacy
  // inline fields on the paint object itself.
  const g = type === "linearGradient" ? (paint.linear ?? paint) : (paint.radial ?? paint);
  const stops = normalizeStops(visibleStops(g));
  if (type === "linearGradient") {
    return { type, stops, ...linearAxis(g), ...linearCenterWavelength(g) };
  }
  const center = requirePoint("radialGradient.center", g.center);
  if (typeof g.r !== "number" || !(g.r >= 0)) throw new Error(`parsePaint: radialGradient "r" must be a non-negative number, got ${JSON.stringify(g.r)}`);
  return { type, stops, center, r: g.r };
}

/**
 * Pure function. A gradient sub-state's VISIBLE stops — the ones a hidden stop's
 * visibility companion has NOT taken out of the picture.
 *
 * THIS IS THE RENDER HALF OF PER-STOP HIDE, and it lives here because parsePaint
 * is the ONE funnel every backend's gradient goes through (the Skia painter, the
 * SVG <stop> emitter and the PDF stitching function all consume its output), so
 * one filter serves all three and none of them can disagree about which stops
 * exist. The companion is the declaration's `activeKey` sibling INSIDE the same
 * sub-state (fill.linear.stopsActive), exactly where core/lists.activeListPath
 * puts it and where core/expressions.listDeclAt resolves it.
 *
 * Filtering here rather than in normalizeStops is deliberate: what reaches the
 * backends is then BYTE-IDENTICAL to the hand-authored gradient without that stop
 * (core/lists.js's "acts like it's not there" rule — there is no transparent hole,
 * the ramp simply spans the surviving neighbours). A list with nothing hidden is
 * returned BY IDENTITY, so every existing document allocates nothing and renders
 * unchanged. A non-array `stops` passes straight through for normalizeStops to
 * report, which is where that report already lived.
 *
 * @example visibleStops({stops: [{offset: 0}, {offset: 1}]}) // [{offset: 0}, {offset: 1}] (no companion: all visible, same array)
 * @example visibleStops({stops: [{offset: 0}, {offset: 0.5}, {offset: 1}], stopsActive: [true, false, true]}) // [{offset: 0}, {offset: 1}]
 */
function visibleStops(g) {
  if (!Array.isArray(g.stops)) return g.stops;
  return visibleElements(GRADIENT_STOPS_LIST, { list: g.stops, active: g[GRADIENT_STOPS_LIST.activeKey] });
}

/** Pure function. Normalizes a gradient stop list: each {offset, color} → offset
 * clamped 0..1, color parseColor'd to rgba. Requires >= 2 stops (a gradient with
 * one color is a solid — caller should use a string instead). */
function normalizeStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) throw new Error(`parsePaint: a gradient needs >= 2 stops, got ${JSON.stringify(stops)}`);
  return stops.map((s) => {
    if (typeof s.offset !== "number" || !Number.isFinite(s.offset)) throw new Error(`parsePaint: stop "offset" must be a finite number, got ${JSON.stringify(s.offset)}`);
    return { offset: Math.max(0, Math.min(1, s.offset)), color: parseColor(s.color) };
  });
}

/** Pure function. Validates a {x, y} objectBoundingBox point (finite numbers). */
function requirePoint(name, pt) {
  if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number" || !Number.isFinite(pt.x) || !Number.isFinite(pt.y))
    throw new Error(`parsePaint: ${name} must be a {x, y} point with finite numbers, got ${JSON.stringify(pt)}`);
  return { x: pt.x, y: pt.y };
}

/**
 * Pure function. The objectBoundingBox {from, to} endpoints of a linear paint's
 * axis. The stored `angle` (degrees) is AUTHORITATIVE — the render direction is
 * derived from it via angleToLinearEndpoints, so a keyframed angle tweens as a
 * ROTATING axis (0°→180° passes through 90°, a vertical gradient) instead of two
 * endpoints lerping through a degenerate collapsed midpoint. Falls back to a
 * stored from/to (un-migrated in-memory paints), then a GRADIENT_DEFAULT_ANGLE
 * default, ONLY when `angle` is absent.
 *
 * Args:
 *   g (object): the linear sub-state — {angle?, from?, to?, stops}
 *
 * Returns:
 *   {from: {x, y}, to: {x, y}} — objectBoundingBox (0..1) endpoints
 *
 * @example linearAxis({angle: 90})  // {from: {x: 0.5, y: 0}, to: {x: 0.5, y: 1}}  (angle authoritative)
 * @example linearAxis({from: {x: 0, y: 0}, to: {x: 1, y: 0}})  // {from: {x: 0, y: 0}, to: {x: 1, y: 0}}  (fallback: no angle)
 * @example linearAxis({stops: []})  // {from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}}  (0° default: neither angle nor from/to)
 */
function linearAxis(g) {
  if (g.angle !== null && g.angle !== undefined) {
    if (typeof g.angle !== "number" || !Number.isFinite(g.angle))
      throw new Error(`parsePaint: linearGradient "angle" must be a finite number, got ${JSON.stringify(g.angle)}`);
    return angleToLinearEndpoints(g.angle);
  }
  if (g.from != null && g.to != null)
    return { from: requirePoint("linearGradient.from", g.from), to: requirePoint("linearGradient.to", g.to) };
  return angleToLinearEndpoints(GRADIENT_DEFAULT_ANGLE);
}

/**
 * Pure function. A linear paint's CENTER (objectBoundingBox) and WAVELENGTH, the
 * two gradient-handle fields (core/paint_handles.js). Both default to the "today"
 * values (box-center / whole-axis), so an ABSENT pair is byte-identical to before
 * the feature (linearGradientRender returns the untouched axis in that case).
 * Validates loudly: a present center must be a finite point and a present
 * wavelength a positive finite number (a zero/negative axis is degenerate).
 *
 * Args:
 *   g (object): the linear sub-state — {center?, wavelength?, ...}
 *
 * Returns:
 *   {center: {x, y}, wavelength: number}
 *
 * @example linearCenterWavelength({})  // {center: {x: 0.5, y: 0.5}, wavelength: 1}  (absent → defaults)
 * @example linearCenterWavelength({center: {x: 0.2, y: 0.8}, wavelength: 0.25})  // {center: {x: 0.2, y: 0.8}, wavelength: 0.25}
 */
function linearCenterWavelength(g) {
  const center = g.center != null ? requirePoint("linearGradient.center", g.center) : { ...GRADIENT_DEFAULT_CENTER };
  let wavelength = GRADIENT_DEFAULT_WAVELENGTH;
  if (g.wavelength != null) {
    if (typeof g.wavelength !== "number" || !Number.isFinite(g.wavelength) || g.wavelength <= 0)
      throw new Error(`parsePaint: linearGradient "wavelength" must be a positive finite number, got ${JSON.stringify(g.wavelength)}`);
    wavelength = g.wavelength;
  }
  return { center, wavelength };
}

/**
 * Pure function. THE render endpoints + tile mode of a parsed linear paint, once
 * its CENTER and WAVELENGTH are folded in. Every backend goes through this so the
 * Skia shader, the SVG <linearGradient> and the PDF axial shading agree.
 *
 * The parsed `from`/`to` are the whole-box axis (the chord through the box).
 * `half = (to − from)/2` is the axis half-vector; one full ramp of wavelength `w`
 * centered at `c` spans `w·half` each side:
 *   from' = c − w·half,   to' = c + w·half
 * `mirror` is true iff w ≠ 1 (the ramp then tiles with a mirror repeat outside
 * [from', to']). When c is the box center AND w = 1 the untouched `from`/`to` are
 * returned by IDENTITY (mirror false), so a default/legacy paint renders
 * BYTE-IDENTICALLY to before the center/wavelength feature — the endpoints and
 * clamp tile mode are the same objects/values it always used.
 *
 * Args:
 *   paint (object): a parsed linearGradient paint (carries from, to, center?, wavelength?)
 *
 * Returns:
 *   {from: {x, y}, to: {x, y}, mirror: boolean}
 *
 * @example linearGradientRender({from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}})  // {from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}, mirror: false}  (default: untouched axis)
 * @example linearGradientRender({from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}, center: {x: 0.5, y: 0.5}, wavelength: 0.5})  // {from: {x: 0.25, y: 0.5}, to: {x: 0.75, y: 0.5}, mirror: true}  (half-length ramp, mirror-tiled)
 * @example linearGradientRender({from: {x: 0, y: 0.5}, to: {x: 1, y: 0.5}, center: {x: 0.25, y: 0.5}, wavelength: 1}).from  // {x: -0.25, y: 0.5}  (center shifted, w=1 → clamp)
 */
export function linearGradientRender(paint) {
  const w = paint.wavelength ?? GRADIENT_DEFAULT_WAVELENGTH;
  const c = paint.center ?? GRADIENT_DEFAULT_CENTER;
  if (w === 1 && c.x === GRADIENT_DEFAULT_CENTER.x && c.y === GRADIENT_DEFAULT_CENTER.y)
    return { from: paint.from, to: paint.to, mirror: false };
  const hx = (paint.to.x - paint.from.x) / 2, hy = (paint.to.y - paint.from.y) / 2;
  return {
    from: { x: c.x - w * hx, y: c.y - w * hy },
    to: { x: c.x + w * hx, y: c.y + w * hy },
    mirror: w !== 1,
  };
}

/**
 * Pure function. Does this op carry a MIRROR-TILED linear-gradient FILL (a linear
 * gradient whose wavelength ≠ 1)? The routing predicate the VECTOR PDF backend
 * uses to send such a fill into its raster fallback — a PDF axial shading extends
 * (clamps) its ends but cannot express a mirror-repeat tiling, so a tiled ramp is
 * rasterized rather than silently drawn as a single clamped ramp. The SVG backend
 * needs no such route (spreadMethod="reflect" expresses it vectorially) and a
 * clamp/center-only gradient (wavelength === 1) stays a true PDF shading.
 *
 * @example opHasMirrorLinearFill({op: "rect", fill: {type: "linearGradient", wavelength: 0.25}}) // true
 * @example opHasMirrorLinearFill({op: "rect", fill: {type: "linearGradient", wavelength: 1}}) // false
 * @example opHasMirrorLinearFill({op: "rect", fill: {type: "radialGradient", r: 0.5}}) // false
 * @example opHasMirrorLinearFill({op: "rect", fill: "#fff"}) // false
 */
export function opHasMirrorLinearFill(cmd) {
  const p = cmd.fill;
  return !!(p && typeof p === "object" && !Array.isArray(p) && p.type === "linearGradient" && (p.wavelength ?? GRADIENT_DEFAULT_WAVELENGTH) !== 1);
}

// ── THE STROKE-TRIM framework (manifest E.12-15) ─────────────────────────────
// strokeStart/strokeEnd (0..1 of the outline's arc length), strokePhase (a turn,
// period 1) and the two caps (STROKE_CAP_MODES) are UNIVERSAL stroke options that
// ride on a stroked op as plain fields. The default is the IDENTITY — full stroke
// (start 0, end 1), no phase, flat caps — and the identity is ABSENT: a field is
// only present on an op when it moves off identity, so an untrimmed flat-capped
// stroke carries none of them and renders byte-identically (the gradient
// center/wavelength absent-is-legacy precedent). paint_skia reads these off the
// op; the vector exporters route the ones with no vector form to the raster
// fallback (opStrokeNeedsRaster).

/** Identity trim window bounds — a stroke drawn from its very start to its very
 *  end (the whole outline). Off either of these ⇒ the stroke is trimmed. */
export const STROKE_TRIM_FULL_START = 0;
export const STROKE_TRIM_FULL_END = 1;
/** Identity phase — position 0 sits at the outline's natural origin. */
export const STROKE_PHASE_NONE = 0;

/**
 * Pure function. Is a cap id a real (non-flat) cap? A flat/absent cap is the
 * identity finish (a flush butt end), so it needs no path work in either the
 * painter or the exporter.
 *
 * @example capIsActive("round") // true
 * @example capIsActive("taper") // true
 * @example capIsActive("flat") // false
 * @example capIsActive(undefined) // false
 */
export function capIsActive(cap) {
  return cap != null && cap !== STROKE_CAP_FLAT;
}

/**
 * Pure function. Does an op's stroke carry a non-identity TRIM WINDOW or PHASE
 * (start ≠ 0, end ≠ 1, or phase ≠ 0)? This is the part of the framework that
 * changes WHICH arc of the outline is drawn — distinct from the caps, which only
 * change how its ends are finished.
 *
 * @example strokeIsTrimmed({strokeEnd: 0.5}) // true
 * @example strokeIsTrimmed({strokeStart: 0.2}) // true
 * @example strokeIsTrimmed({strokePhase: 0.3}) // true
 * @example strokeIsTrimmed({}) // false (absent = full, byte-identical legacy)
 * @example strokeIsTrimmed({strokeStart: 0, strokeEnd: 1, strokePhase: 0}) // false
 */
export function strokeIsTrimmed(cmd) {
  return (cmd.strokeStart ?? STROKE_TRIM_FULL_START) !== STROKE_TRIM_FULL_START
    || (cmd.strokeEnd ?? STROKE_TRIM_FULL_END) !== STROKE_TRIM_FULL_END
    || (cmd.strokePhase ?? STROKE_PHASE_NONE) !== STROKE_PHASE_NONE;
}

/**
 * Pure function. Must paint_skia stroke this op through the arc-length TRIM PATH
 * (ContourMeasure preprocessing) rather than its direct drawRRect/drawOval fast
 * path? True when the stroke is trimmed/phased OR carries any non-flat cap —
 * either needs a real path to act on. A plain, full, flat-capped stroke returns
 * false and keeps the byte-identical direct draw.
 *
 * @example opStrokeNeedsTrimPath({strokeEnd: 0.5}) // true
 * @example opStrokeNeedsTrimPath({strokeCapStart: "round"}) // true
 * @example opStrokeNeedsTrimPath({strokeCapEnd: "taper"}) // true
 * @example opStrokeNeedsTrimPath({}) // false
 * @example opStrokeNeedsTrimPath({strokeCapStart: "flat"}) // false
 */
export function opStrokeNeedsTrimPath(cmd) {
  return strokeIsTrimmed(cmd) || capIsActive(cmd.strokeCapStart) || capIsActive(cmd.strokeCapEnd);
}

/**
 * Pure function. Must a VECTOR exporter (PDF/SVG) send this op to the region
 * RASTER FALLBACK because its stroke has no trivial vector form? True when the
 * stroke is trimmed/phased or carries a TAPER cap (a variable-width outline) —
 * the same "no vector form ⇒ rasterize its own region" rule material fills and
 * mirror gradients already follow (opHasMaterialFill / opHasMirrorLinearFill).
 * A ROUND cap alone is NOT here: SVG/PDF express round caps natively (linecap),
 * so a round-capped-but-untrimmed stroke stays vector.
 *
 * @example opStrokeNeedsRaster({strokeEnd: 0.5}) // true
 * @example opStrokeNeedsRaster({strokeCapStart: "taper"}) // true
 * @example opStrokeNeedsRaster({strokeCapStart: "round"}) // false (round is vector-expressible)
 * @example opStrokeNeedsRaster({}) // false
 */
export function opStrokeNeedsRaster(cmd) {
  return strokeIsTrimmed(cmd) || cmd.strokeCapStart === "taper" || cmd.strokeCapEnd === "taper";
}

/**
 * Near-pure helper (throws on bad input — the parsePaint/requireFinite
 * discipline). Validates the raw stroke-trim aspects and returns ONLY the
 * non-identity ones (so an identity/absent set returns {}, keeping the op minimal
 * and byte-identical — absent-is-legacy). The trim window bounds are physical
 * ([0,1] of arc length); phase is a periodic turn (any finite number wraps);
 * caps must be a STROKE_CAP_MODES id.
 *
 * @param {string} cmdName - the op name, for error messages
 * @param {object} src - {strokeStart?, strokeEnd?, strokePhase?, strokeCapStart?, strokeCapEnd?}
 * @returns {object} the non-identity subset, ready to spread onto an op
 *
 * @example normalizeStrokeTrim("rect", {}) // {}
 * @example normalizeStrokeTrim("rect", {strokeStart: 0, strokeEnd: 1, strokePhase: 0, strokeCapStart: "flat"}) // {}
 * @example normalizeStrokeTrim("rect", {strokeEnd: 0.5}) // {strokeEnd: 0.5}
 * @example normalizeStrokeTrim("rect", {strokeCapStart: "round", strokePhase: 0.25}) // {strokePhase: 0.25, strokeCapStart: "round"}
 */
export function normalizeStrokeTrim(cmdName, src = {}) {
  const out = {};
  const num = (name, v) => {
    if (v == null) return null;
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`${cmdName}: stroke-trim "${name}" must be a finite number, got ${JSON.stringify(v)}`);
    return v;
  };
  const start = num("strokeStart", src.strokeStart);
  const end = num("strokeEnd", src.strokeEnd);
  const phase = num("strokePhase", src.strokePhase);
  if (start != null && (start < 0 || start > 1))
    throw new Error(`${cmdName}: strokeStart is a fraction of arc length in [0,1], got ${JSON.stringify(src.strokeStart)}`);
  if (end != null && (end < 0 || end > 1))
    throw new Error(`${cmdName}: strokeEnd is a fraction of arc length in [0,1], got ${JSON.stringify(src.strokeEnd)}`);
  if (start != null && start !== STROKE_TRIM_FULL_START) out.strokeStart = start;
  if (end != null && end !== STROKE_TRIM_FULL_END) out.strokeEnd = end;
  if (phase != null && phase !== STROKE_PHASE_NONE) out.strokePhase = phase;
  for (const key of ["strokeCapStart", "strokeCapEnd"]) {
    const cap = src[key];
    if (cap == null) continue;
    if (!STROKE_CAP_MODES.includes(cap))
      throw new Error(`${cmdName}: ${key} must be one of ${JSON.stringify(STROKE_CAP_MODES)}, got ${JSON.stringify(cap)}`);
    if (capIsActive(cap)) out[key] = cap;
  }
  return out;
}

/**
 * Pure function. Stamps a widget's UNIVERSAL STROKE-TRIM options (read from its
 * STATE) onto the stroked ops it emitted — the ports-seam counterpart of the
 * universal EFFECTS seam (render_gpu/effects.applyNodeEffects). Every stroked box
 * inherits trim/phase/caps here without any per-plugin emit change; a widget
 * whose state carries no trim (the overwhelming majority, and EVERY existing
 * document) returns `cmds` UNCHANGED and byte-identical.
 *
 * OWNERSHIP RULE (why the recursion is shaped as it is): the stamp targets the
 * node's OWN stroke. It recurses through an effectSubtree's `content` — that is a
 * widget's own ops wrapped by its own effects (shadow/bloom) — but NOT through a
 * cropSubtree's `content`, which holds a FOREIGN target/member whose stroke was
 * already stamped during its own emit. A cropSubtree's own border stroke (an
 * image/video/crop-box frame) IS stamped, on the cropSubtree op itself. Container
 * nodes (group/cropbox target) carry no trim of their own, so this is never even
 * entered for them (the identity short-circuit).
 *
 * @param {object} state - the widget's evaluated state (numbers, not equations)
 * @param {object[]} cmds - the node's emitted IR
 * @returns {object[]} cmds, with trim stamped onto stroked ops (or unchanged)
 *
 * @example applyStrokeTrim({}, [{op: "rect", stroke: [0,0,0,1]}]) // [{op: "rect", stroke: [0,0,0,1]}]
 * @example applyStrokeTrim({strokeEnd: 0.5}, [{op: "rect", stroke: [0,0,0,1], strokeWidth: 2}])[0].strokeEnd // 0.5
 * @example applyStrokeTrim({strokeEnd: 0.5}, [{op: "rect", fill: [1,0,0,1]}])[0].strokeEnd // undefined (no stroke to trim)
 */
export function applyStrokeTrim(state, cmds) {
  // STORED strokePhase is an ANGLE IN DEGREES (an angle-kind row — the rotation
  // dial; user ruling: "phase can be represented as an angle property"). The OP
  // contract stays in TURNS: this seam divides by 360 once, and every consumer
  // wraps turns via mod1, so a 0° → 360° keyframe marches the pattern exactly
  // once around the outline, seamlessly.
  const src = state ?? {};
  const trim = normalizeStrokeTrim("applyStrokeTrim",
    typeof src.strokePhase === "number"
      ? { ...src, strokePhase: src.strokePhase / 360 }
      : src);
  if (Object.keys(trim).length === 0) return cmds;
  return cmds.map((cmd) => stampStrokeTrim(cmd, trim));
}

/** Pure helper for applyStrokeTrim: stamp `trim` onto one op's OWN stroke and,
 *  for a self-effect wrapper, its content — but never a cropSubtree's foreign
 *  content (see the ownership rule above). */
function stampStrokeTrim(cmd, trim) {
  let out = cmd;
  if (cmd.stroke != null) out = { ...out, ...trim };
  if (cmd.op === "effectSubtree" && Array.isArray(cmd.content))
    out = { ...out, content: cmd.content.map((c) => stampStrokeTrim(c, trim)) };
  return out;
}

/**
 * Pure function. Wraps a turn count into [0, 1) — the modulus for stroke-phase
 * and closed-contour trim positions (frac for positives, folding negatives in).
 *
 * @example mod1(0.3) // 0.3
 * @example mod1(1.25) // 0.25
 * @example mod1(-0.6) // 0.4
 * @example mod1(1) // 0
 */
export function mod1(x) {
  return ((x % 1) + 1) % 1;
}

/**
 * Pure function. THE arc-length trim math: the DISTANCE segment(s) [d0, d1] to
 * KEEP from one contour of length `L`, given the trim window (`start`/`end`,
 * fractions of the contour) rotated by `phase` (turns). Returns 0, 1 or 2
 * segments — two when a CLOSED trim wraps across the seam (d0..L then 0..d1).
 * paint_skia turns each pair into a sub-path via ContourMeasure.getSegment.
 *
 * The kept WIDTH is (end − start), taken modulo a full turn on a closed contour
 * (so 0.8 → 0.2 keeps the 0.4-long arc across the seam) and clamped on an open
 * one. Phase rotates the ORIGIN by phase·L, wrapping on a closed contour and
 * sliding-then-clamping on an open one (a phase is only meaningful on a closed
 * outline — the manifest — but an open contour must still degrade sanely).
 *
 * Args:
 *   L (number): contour arc length (device-independent local units)
 *   start (number): window start, fraction of the contour [0,1]
 *   end (number): window end, fraction of the contour [0,1]
 *   phase (number): origin rotation, in turns (any finite value; wraps)
 *   closed (boolean): does the contour close (from ContourMeasure.isClosed)?
 *
 * Returns:
 *   Array<[number, number]>: kept [startDist, stopDist] pairs, in arc distance
 *
 * @example trimSegments(100, 0, 0.5, 0, false) // [[0, 50]]
 * @example trimSegments(100, 0.25, 0.75, 0, true) // [[25, 75]]
 * @example trimSegments(100, 0, 1, 0.25, true) // [[25, 100], [0, 25]]
 * @example trimSegments(100, 0.8, 0.2, 0, true) // [[80, 100], [0, 20]]
 * @example trimSegments(100, 0.25, 0.25, 0, true) // [] (zero-width window keeps nothing)
 */
export function trimSegments(L, start, end, phase, closed) {
  if (!(L > 0)) return [];
  if (closed) {
    const width = (end - start >= 1) ? 1 : mod1(end - start);
    const keep = width * L;
    if (!(keep > 0)) return [];
    const ds = mod1(start + phase) * L;
    const de = ds + keep;
    if (de <= L + 1e-6) return [[ds, Math.min(de, L)]];
    return [[ds, L], [0, de - L]];
  }
  // Open: slide by phase, clamp into the contour, keep the forward span.
  const s = Math.min(Math.max(start + phase, 0), 1) * L;
  const e = Math.min(Math.max(end + phase, 0), 1) * L;
  const lo = Math.min(s, e), hi = Math.max(s, e);
  return hi - lo > 1e-6 ? [[lo, hi]] : [];
}

// ── command builders ─────────────────────────────────────────────────────────
// Each builder validates + normalizes (colors → rgba arrays, defaults filled)
// so backends never re-check. Missing required fields throw loudly.

/** Near-pure helper (throws on bad input — that's its job). */
function requireFinite(cmdName, fields) {
  for (const [name, v] of Object.entries(fields))
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`${cmdName}: "${name}" must be a finite number, got ${JSON.stringify(v)}`);
}

/**
 * Pure function. Rounded-rect fill+stroke command.
 *
 * @example rect({x: 0, y: 0, w: 10, h: 5, fill: "#fff"}).op // "rect"
 * @example rect({x: 0, y: 0, w: 10, h: 5, fill: "#f00", cornerRadius: 2}).fill // [1, 0, 0, 1]
 */
export function rect({ x, y, w, h, cornerRadius = 0, fill = null, stroke = null, strokeWidth = 0, opacity = 1, ...trim }) {
  requireFinite("rect", { x, y, w, h, cornerRadius, strokeWidth, opacity });
  return {
    op: "rect", x, y, w, h,
    cornerRadius: Math.max(0, cornerRadius), // negative radii are meaningless (same domain clamp as the canvas plugin)
    fill: fill === null ? null : parsePaint(fill),
    stroke: stroke === null ? null : parsePaint(stroke),
    strokeWidth, opacity,
    ...normalizeStrokeTrim("rect", trim), // stroke-trim fields ride along only when non-identity (absent-is-legacy)
  };
}

/**
 * Pure function. Ellipse fill+stroke command (center + radii).
 *
 * @example ellipse({cx: 5, cy: 5, rx: 5, ry: 3, fill: "#000"}).ry // 3
 */
export function ellipse({ cx, cy, rx, ry, fill = null, stroke = null, strokeWidth = 0, opacity = 1, ...trim }) {
  requireFinite("ellipse", { cx, cy, rx, ry, strokeWidth, opacity });
  return {
    op: "ellipse", cx, cy, rx, ry,
    fill: fill === null ? null : parsePaint(fill),
    stroke: stroke === null ? null : parsePaint(stroke),
    strokeWidth, opacity,
    ...normalizeStrokeTrim("ellipse", trim),
  };
}

/**
 * Pure function. Stroked polyline (round caps and joins — GPU renders each
 * segment as a capsule, so joins are inherently round).
 *
 * @example polyline({points: [[0, 0], [10, 0]], width: 2, color: "#000"}).points.length // 2
 */
export function polyline({ points, width, color, opacity = 1 }) {
  if (!Array.isArray(points) || points.length < 2) throw new Error(`polyline: need >= 2 points, got ${JSON.stringify(points)}`);
  requireFinite("polyline", { width, opacity });
  return { op: "polyline", points: points.map(([x, y]) => [x, y]), width, color: parseColor(color), opacity };
}

/**
 * Pure function. Filled CONVEX polygon (fan-triangulated by raster backends —
 * concave input silently renders wrong, so callers must pre-triangulate;
 * arrowheads are triangles so V1 needs nothing fancier).
 *
 * @example polygon({points: [[0, 0], [10, 0], [5, 8]], fill: "#000"}).op // "polygon"
 */
export function polygon({ points, fill, opacity = 1 }) {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`polygon: need >= 3 points, got ${JSON.stringify(points)}`);
  requireFinite("polygon", { opacity });
  return { op: "polygon", points: points.map(([x, y]) => [x, y]), fill: parsePaint(fill), opacity };
}

/**
 * Pure function. Text command, top-left origin (matches canvas textBaseline=
 * "top"). Two shapes, both handled by the SAME op:
 *
 *  1. SINGLE RUN (legacy / parity scenes): {text, x, y, size, color, bold,
 *     font, opacity}. `font` is a font-registry id (render_gpu/fonts.js),
 *     default "system", so an omitted font is fully back-compatible. Backends
 *     lay out this one run's glyphs at (x, y). Unchanged from before.
 *
 *  2. RICH (the text widget): additionally carries `rich` = a canonical
 *     {runs, paras} rich value (core/richtext.js), a `boxW` (wrap width in
 *     local units; Infinity ⇒ no wrap), `boxH` (box height, for the SET-2
 *     overflow question — carried through, not clipped here), and `boxStyle`
 *     (widget-level paragraph defaults). When `rich` is present a backend runs
 *     the SHARED pure layout (core/richtext.layoutRichText) with its OWN metric
 *     seam and draws the positioned runs + underline/strike lines — ONE layout,
 *     two backends (the parity lever). `text`/`size`/`color`/etc. still carry a
 *     plain-text fallback so a rich op degrades to a single-run draw if a
 *     backend can't lay out (never a silent blank).
 *
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000"}).size // 36
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000"}).font // "system"
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000", font: "inter"}).font // "inter"
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000", rich: {runs: [{text: "Hi"}], paras: [{}]}, boxW: 200}).boxW // 200
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000"}).rich // null
 */
export function text({ text: str, x, y, size, color, bold = false, opacity = 1, font = DEFAULT_FONT, rich = null, boxW = Infinity, boxH = Infinity, boxStyle = null }) {
  if (typeof str !== "string") throw new Error(`text: "text" must be a string, got ${JSON.stringify(str)}`);
  if (typeof font !== "string") throw new Error(`text: "font" must be a string id, got ${JSON.stringify(font)}`);
  requireFinite("text", { x, y, size, opacity });
  if (rich !== null && !(rich && Array.isArray(rich.runs))) throw new Error(`text: "rich" must be a {runs,paras} value or null, got ${JSON.stringify(rich)}`);
  // boxW/boxH may be Infinity (no wrap / no height limit) — allowed, not a finite check.
  if (boxW !== Infinity && (typeof boxW !== "number" || !Number.isFinite(boxW))) throw new Error(`text: "boxW" must be a finite number or Infinity, got ${JSON.stringify(boxW)}`);
  return {
    op: "text", text: str, x, y, size, color: parsePaint(color), bold: !!bold, opacity, font,
    rich, boxW, boxH, boxStyle,
  };
}

/**
 * Pure function. Image quad by media-registry ref.
 *
 * SOURCE RECT (manifest "Edge-crop insets"): `sx, sy, sw, sh` name a
 * sub-rectangle of the source texture in NORMALIZED UV coords (0..1), defaulting
 * to the full frame {0, 0, 1, 1}. A cropped source ({sx>0, sw<1, ...}) draws
 * that sub-region of the texture stretched across the quad's x/y/w/h — the
 * caller sets the quad to the inset-shrunk rect AND the source rect to the
 * matching UV fraction, so the visible pixels keep their scale (a crop, not a
 * squash). Omitted → the full-frame default is byte-identical to a pre-crop
 * image op (backends pack {0,0,1,1} exactly as before). The source rect is
 * clamped to [0,1] and to non-negative extents — an inverted/out-of-range crop
 * is a caller bug, clamped to a valid (possibly empty) region rather than
 * producing garbage UVs.
 *
 * @example image({ref: "logo", x: 0, y: 0, w: 64, h: 64}).ref // "logo"
 * @example image({ref: "logo", x: 0, y: 0, w: 64, h: 64}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 * @example image({ref: "logo", x: 0, y: 0, w: 64, h: 64, sx: 0.1, sy: 0.2, sw: 0.7, sh: 0.6}).src // {sx: 0.1, sy: 0.2, sw: 0.7, sh: 0.6}
 */
export function image({ ref, x, y, w, h, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1 }) {
  if (typeof ref !== "string") throw new Error(`image: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("image", { x, y, w, h, opacity, sx, sy, sw, sh });
  return { op: "image", ref, x, y, w, h, opacity, src: sourceRect(sx, sy, sw, sh) };
}

/**
 * Pure function. PAPER CURL — one sheet of a corner-stapled packet mid-turn:
 * the render_gpu/page_curl.js developable roll of the x/y/w/h sheet around the
 * fold implied by (staple, angleDeg, t), textured by `ref` on the front, plain
 * paper on the back, with a geometry-derived cast shadow. `ref: null` = a
 * blank sheet (an already-turned page showing its back). The Skia painter owns
 * the mesh; export backends take the generic raster fallback (not in
 * VECTOR_OPS — the cd7ca00 rule).
 *
 * @param {object} o
 * @param {string|null} o.ref image-registry ref of the sheet's FRONT face
 * @param {number} o.x, o.y, o.w, o.h the sheet rect (local)
 * @param {{x:number,y:number}} o.staple staple point (local)
 * @param {number} o.angleDeg flip direction (deg, the free corner's travel)
 * @param {number} o.t turn progress 0..1
 * @param {number} [o.curlScale=1] curl-radius handle
 * @param {string} [o.paper="#fbfaf7"] the sheet's paper color (back face + untextured front)
 * @param {number} [o.shadowOpacity=0.4] cast-shadow strength (0 disables)
 * @param {number} [o.opacity=1]
 *
 * @example paperCurl({ref: "p1", x: 0, y: 0, w: 200, h: 300, staple: {x: 14, y: 14}, angleDeg: 62, t: 0.3}).op // "paperCurl"
 * @example paperCurl({ref: null, x: 0, y: 0, w: 200, h: 300, staple: {x: 14, y: 14}, angleDeg: 62, t: 1}).ref // null
 */
export function paperCurl({ ref, x, y, w, h, staple, angleDeg, t, curlScale = 1, paper = "#fbfaf7", shadowOpacity = 0.4, opacity = 1 }) {
  if (ref !== null && typeof ref !== "string") throw new Error(`paperCurl: "ref" must be a string or null, got ${JSON.stringify(ref)}`);
  requireFinite("paperCurl", { x, y, w, h, angleDeg, t, curlScale, shadowOpacity, opacity, stapleX: staple?.x, stapleY: staple?.y });
  return { op: "paperCurl", ref, x, y, w, h, staple: { x: staple.x, y: staple.y }, angleDeg, t, curlScale, paper, shadowOpacity, opacity };
}

/**
 * Pure function. Video quad by media-registry ref (raster backends import the
 * current frame each render — WebGPU via importExternalTexture). Carries the
 * SAME `sx/sy/sw/sh` source rect as image() (see it for the edge-crop
 * semantics); omitted → full frame, byte-identical to a pre-crop video op.
 *
 * @example video({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).op // "video"
 * @example video({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 */
export function video({ ref, x, y, w, h, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1 }) {
  if (typeof ref !== "string") throw new Error(`video: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("video", { x, y, w, h, opacity, sx, sy, sw, sh });
  return { op: "video", ref, x, y, w, h, opacity, src: sourceRect(sx, sy, sw, sh) };
}

/**
 * Pure function. Video quad for the V2 DIRECT-UPLOAD Skia path (a distinct op from
 * `video`, handled by render_gpu/skia/video_v2.js — a texture-backed frame minted
 * with makeImageFromTextureSource/updateTextureFromSource, no CPU readback). Same
 * quad + `sx/sy/sw/sh` edge-crop source rect + opacity as video(), but ALSO
 * carries the playback flags (autoplay/loop/muted) IN the op — unlike the `video`
 * op, whose flags are read off document state by the shared registry. Video V2
 * owns its own element registry, so the flags travel with the draw command that
 * configures the `<video>` on first sight.
 *
 * @example videoV2({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).op // "videoV2"
 * @example videoV2({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).autoplay // true
 * @example videoV2({ref: "clip1", x: 0, y: 0, w: 320, h: 180, muted: false}).muted // false
 * @example videoV2({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 */
export function videoV2({ ref, x, y, w, h, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1, autoplay = true, loop = true, muted = true }) {
  if (typeof ref !== "string") throw new Error(`videoV2: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("videoV2", { x, y, w, h, opacity, sx, sy, sw, sh });
  return { op: "videoV2", ref, x, y, w, h, opacity, src: sourceRect(sx, sy, sw, sh), autoplay: !!autoplay, loop: !!loop, muted: !!muted };
}

/**
 * Pure function. Video quad drawn through the OFF-MAIN-THREAD V5 frame pipeline
 * (render_gpu/skia/video_v5.js resolves the ref to a CanvasKit Image from a
 * worker-produced ImageBitmap). Byte-identical op SHAPE to video() — same
 * ref/quad/opacity/source-rect — so paint_skia and the export backends draw it
 * exactly like a `video` op; only the media-resolution SOURCE differs (V5's own
 * registry, not gpu/video_registry.js). Additive: the core `video` op is
 * untouched, so the two paths coexist for an A/B.
 *
 * @example videoV5({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).op // "videoV5"
 * @example videoV5({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 */
export function videoV5({ ref, x, y, w, h, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1 }) {
  if (typeof ref !== "string") throw new Error(`videoV5: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("videoV5", { x, y, w, h, opacity, sx, sy, sw, sh });
  return { op: "videoV5", ref, x, y, w, h, opacity, src: sourceRect(sx, sy, sw, sh) };
}

// ── videoFrame (the SCRUBBER's deterministic frame-at-time op) ─────────────────
// The video PLAYER's `video` op draws the element's WALL-CLOCK current frame
// (non-deterministic while playing). The SCRUBBER's `videoFrame` op instead
// names an EXPLICIT decode time — the displayed frame is pure(document, slide,
// alpha) because `seekTime` is evaluated document state (a keyframed/equation-
// bound number), so the SAME (slide, alpha) always decodes the SAME frame. The
// two ops never mix: `video` = "this source's live frame", `videoFrame` = "this
// source at exactly t seconds". A raster backend resolves it by PARKING a paused
// decoder at `seekTime` and awaiting the decoded frame (video_registry
// requestScrubFrame + the async seek-and-await in web/gpuService.js /
// render_gpu/skia/browser_media.js), then draws the resolved frame exactly like
// an image/video quad.

/** How many decimal places of `seekTime` the media-cache key keeps. 4 = 0.1 ms,
 * finer than any real video frame (≥1/240 s ≈ 4 ms) so two distinct frames never
 * collapse, yet coarse enough to fold float jitter so IDENTICAL requested times
 * (two scrubbers bound to the SAME equation) map to ONE key and share ONE decoded
 * frame — the "multiple synchronized videos" property, by construction. */
export const SCRUB_TIME_KEY_DECIMALS = 4;

/**
 * Pure function. The media-map KEY a scrubber frame is stored/looked up under.
 * Distinct from a plain `ref` (the player's key) because two scrubbers can share
 * ONE source at DIFFERENT times in one scene — the time (and wrap) must be part
 * of the key. Two `videoFrame` ops with the SAME (ref, seekTime, wrap) therefore
 * resolve to the SAME key and SAME decoded frame (frame-lockstep sync); the
 * seekTime is quantized to SCRUB_TIME_KEY_DECIMALS so float-identical equations
 * agree exactly.
 *
 * @example scrubFrameKey("clip.mp4", 1.5, "clamp") // "clip.mp4@1.5000@clamp"
 * @example scrubFrameKey("clip.mp4", 1.50000001, "clamp") // "clip.mp4@1.5000@clamp" (jitter folded)
 * @example scrubFrameKey("clip.mp4", 2, "loop") // "clip.mp4@2.0000@loop"
 */
export function scrubFrameKey(ref, seekTime, wrap) {
  const t = Number.isFinite(seekTime) ? seekTime : 0;
  return `${ref}@${t.toFixed(SCRUB_TIME_KEY_DECIMALS)}@${wrap === "loop" ? "loop" : "clamp"}`;
}

/**
 * Pure function. Deterministic video FRAME-AT-TIME quad — the scrubber's op.
 * Mirrors video()/image() (same x/y/w/h quad + sx/sy/sw/sh edge-crop source
 * rect + opacity) but adds `seekTime` (seconds, the evaluated scrub time) and
 * `wrap` ("clamp"|"loop", past-end behavior). A raster backend seeks a paused
 * decoder to `seekTime` and awaits the frame before compositing; the displayed
 * frame is a pure function of state, so a headless render at (slide, alpha)
 * reproduces it exactly.
 *
 * @example videoFrame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 1.5}).op // "videoFrame"
 * @example videoFrame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 1.5}).seekTime // 1.5
 * @example videoFrame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0}).wrap // "clamp"
 * @example videoFrame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 */
export function videoFrame({ ref, x, y, w, h, seekTime, wrap = "clamp", opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1 }) {
  if (typeof ref !== "string") throw new Error(`videoFrame: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("videoFrame", { x, y, w, h, seekTime, opacity, sx, sy, sw, sh });
  if (!SCRUB_WRAP_MODES.includes(wrap)) throw new Error(`videoFrame: "wrap" must be one of ${SCRUB_WRAP_MODES.join("/")}, got ${JSON.stringify(wrap)}`);
  return { op: "videoFrame", ref, x, y, w, h, seekTime, wrap, opacity, src: sourceRect(sx, sy, sw, sh) };
}

// ── videoV5Frame (the V5 scrubber's deterministic frame-at-time op) ────────────
// The A/B twin of `videoFrame` for the OFF-MAIN-THREAD V5 pipeline, exactly as
// `videoV5` is the A/B twin of `video`. Same deterministic contract (an EXPLICIT
// decode time → pure(document, slide, alpha)) and same op SHAPE as videoFrame, so
// paint_skia + the vector-export raster fallback draw it identically. It differs
// ONLY in the media-resolution SOURCE: a videoV5Frame resolves through the V5
// registry's OWN paused scrub decoders (render_gpu/skia/video_v5.js) — which
// convert the seeked frame off the main thread via createImageBitmap — not through
// gpu/video_registry.js. A DISTINCT media-map key (videoV5FrameKey) keeps a V5
// scrubber and a core scrubber on the same (ref, time, wrap) in one scene from
// colliding, since two different pipelines decode them into separate caches.

/**
 * Pure function. The media-map KEY a V5 scrubber frame is stored/looked up under.
 * The core scrubber's scrubFrameKey PREFIXED by "v5|", so a V5 scrubber and a core
 * scrubber pointed at the SAME (ref, seekTime, wrap) resolve to DISTINCT map
 * entries (they are decoded by different pipelines into different caches) while two
 * V5 scrubbers on the same (ref, seekTime, wrap) still share ONE key + ONE decoded
 * frame (frame-lockstep sync, exactly like the core path).
 *
 * @example videoV5FrameKey("clip.mp4", 1.5, "clamp") // "v5|clip.mp4@1.5000@clamp"
 * @example videoV5FrameKey("clip.mp4", 2, "loop") // "v5|clip.mp4@2.0000@loop"
 */
export function videoV5FrameKey(ref, seekTime, wrap) {
  return "v5|" + scrubFrameKey(ref, seekTime, wrap);
}

/**
 * Pure function. Deterministic V5-pipeline video FRAME-AT-TIME quad — the V5
 * scrubber's op. Byte-identical SHAPE to videoFrame (same x/y/w/h quad +
 * sx/sy/sw/sh edge-crop source rect + opacity + seekTime + wrap); only `op`
 * differs so the media resolver routes it to the V5 scrub path (off-main-thread
 * createImageBitmap convert of a paused, seeked decoder) instead of the core
 * scrubber's path. The displayed frame is still a pure function of state, so a
 * headless render at (slide, alpha) reproduces it exactly.
 *
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 1.5}).op // "videoV5Frame"
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 1.5}).seekTime // 1.5
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0}).wrap // "clamp"
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0}).preserveAspect // false
 * @example videoV5Frame({ref: "clip1", x: 0, y: 0, w: 320, h: 180, seekTime: 0, preserveAspect: true}).preserveAspect // true
 */
export function videoV5Frame({ ref, x, y, w, h, seekTime, wrap = "clamp", opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1, preserveAspect = false }) {
  if (typeof ref !== "string") throw new Error(`videoV5Frame: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("videoV5Frame", { x, y, w, h, seekTime, opacity, sx, sy, sw, sh });
  if (!SCRUB_WRAP_MODES.includes(wrap)) throw new Error(`videoV5Frame: "wrap" must be one of ${SCRUB_WRAP_MODES.join("/")}, got ${JSON.stringify(wrap)}`);
  // preserveAspect (default FALSE, unlike latexVector's TRUE): a media quad's
  // established behaviour is a box→box STRETCH, and image/video/videoFrame/videoV5 all
  // rely on it — so the letterbox is strictly opt-in and today only plugins/filmstrip.js
  // opts in (its cells are shaped by the STRIP, so a stretch squashes the pictures).
  // Handled by whichever backend knows the decoded frame's intrinsic size, which is the
  // latexVector/mermaidVector contract; the plugin cannot, since emit() is media-free.
  return { op: "videoV5Frame", ref, x, y, w, h, seekTime, wrap, opacity, preserveAspect: preserveAspect === true, src: sourceRect(sx, sy, sw, sh) };
}

// ── latexVector (Round 15.1 — TRUE VECTOR EQUATION EXPORT) ────────────────────
// A DUAL-PAYLOAD op: the ONE display-list command for a typeset LaTeX equation,
// carrying both the glyph VECTOR geometry (SVG/PDF backends embed real <path>s /
// PDF path operators — true vector, crisp at any zoom, the paper-figure use
// case) AND the raster `ref` fallback (the GPU compositor draws the existing
// MathJax-rasterized quad, and the HYBRID RULE's raster split hands this raw op
// to the GPU/rasterize callback — a latex UNDER a blurBackdrop rasterizes,
// exactly like real text). WHY dual-payload, not a plain image op the vector
// backends special-case: the split is POSITIONAL and forwards raw IR to the GPU,
// so the GPU MUST render this op — and drawing the raster quad (no MSDF/path GPU
// renderer, explicitly out of scope) keeps the LIVE view + every raster fallback
// byte-identical to the pre-vector image path. See plugins/latex.js and
// render_gpu/gpu/latex_raster.js for how the glyph data + ref are produced.

/**
 * Pure function. TRUE-VECTOR LaTeX equation command (Round 15.1). Draws the
 * equation as vector glyph <path>s in SVG/PDF and as the raster quad `ref` in
 * the GPU (and every hybrid raster fallback). Geometry is in LOCAL space: the
 * box {x, y, w, h} is where the equation draws; `glyphs` are MathJax-derived
 * filled sub-paths whose `d` coordinates live in `viewBox` space and map onto
 * the box (a straight box→box scale, y-DOWN already — the raster and vector
 * agree). Each glyph carries its own `fill` (a CSS color string — usually the
 * widget's single ink color, but per-path so multi-color equations survive).
 *
 * `ref` (the raster fallback) + `src` (edge-crop UV rect, image() semantics) let
 * the GPU + hybrid split reuse the image path verbatim; a vector backend ignores
 * `ref`/`src` and consumes `glyphs`/`viewBox`/box.
 *
 * Args:
 *   ref (string): raster media-registry key (GPU / hybrid raster fallback)
 *   x, y, w, h (number): the equation's local draw box
 *   glyphs (array): [{ d: SVG-path-string, fill: cssColor }] in viewBox space
 *   viewBox ({minX, minY, w, h}): the glyph coordinate frame (MathJax units)
 *   opacity (number), sx/sy/sw/sh (number): raster source-rect (image() crop)
 *
 * @example latexVector({ref: "latex:x^2:1", x: 0, y: 0, w: 40, h: 20, glyphs: [{d: "M0 0L10 10", fill: "#000"}], viewBox: {minX: 0, minY: 0, w: 100, h: 50}}).op // "latexVector"
 * @example latexVector({ref: "r", x: 0, y: 0, w: 4, h: 2, glyphs: [], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).glyphs // []
 * @example latexVector({ref: "r", x: 0, y: 0, w: 4, h: 2, glyphs: [{d: "M0 0", fill: "#f00"}], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).src // {sx: 0, sy: 0, sw: 1, sh: 1}
 * @example latexVector({ref: "r", x: 0, y: 0, w: 4, h: 2, glyphs: [], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).preserveAspect // true
 * @example latexVector({ref: "r", x: 0, y: 0, w: 4, h: 2, glyphs: [], viewBox: {minX: 0, minY: 0, w: 1, h: 1}, preserveAspect: false}).preserveAspect // false
 */
export function latexVector({ ref, x, y, w, h, glyphs, viewBox, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1, preserveAspect = true }) {
  if (typeof ref !== "string") throw new Error(`latexVector: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("latexVector", { x, y, w, h, opacity, sx, sy, sw, sh });
  if (!Array.isArray(glyphs)) throw new Error(`latexVector: "glyphs" must be an array, got ${JSON.stringify(glyphs)}`);
  if (!viewBox || typeof viewBox !== "object") throw new Error(`latexVector: "viewBox" must be a {minX,minY,w,h} object, got ${JSON.stringify(viewBox)}`);
  requireFinite("latexVector.viewBox", { minX: viewBox.minX, minY: viewBox.minY, w: viewBox.w, h: viewBox.h });
  if (!(viewBox.w > 0) || !(viewBox.h > 0)) throw new Error(`latexVector: viewBox must have positive w/h, got ${JSON.stringify(viewBox)}`);
  const outGlyphs = glyphs.map((g) => {
    if (typeof g.d !== "string") throw new Error(`latexVector: glyph "d" must be a string, got ${JSON.stringify(g.d)}`);
    // fill kept as a CSS string (parsed by the vector backends via parseColor,
    // the rich-text-highlight precedent) — the op never rasterizes color itself.
    return { d: g.d, fill: g.fill };
  });
  return {
    op: "latexVector", ref, x, y, w, h, opacity,
    // preserveAspect (default TRUE): the backends UNIFORM-scale the equation to
    // FIT the box (centered/letterboxed, no squash) instead of a non-uniform
    // box→box stretch. The user's default for latex is aspect-preserved.
    preserveAspect: preserveAspect !== false,
    src: sourceRect(sx, sy, sw, sh),
    glyphs: outGlyphs,
    viewBox: { minX: viewBox.minX, minY: viewBox.minY, w: viewBox.w, h: viewBox.h },
  };
}

// ── mermaidVector (TRUE-VECTOR MERMAID DIAGRAM) ───────────────────────────────
// The mermaid analog of latexVector, and its direct mirror: the ONE display-list
// command for a rendered Mermaid diagram, carrying both the flattened VECTOR
// geometry (viewBox-space `paths` = filled/stroked shapes + edges + arrowheads,
// and `texts` = positioned label runs — SVG/PDF backends embed real vector; the
// GPU draws crisp vector at any zoom) AND the raster `ref` fallback (the HYBRID
// RULE's raster split hands this raw op to the GPU/rasterize callback — a mermaid
// UNDER a blurBackdrop rasterizes, exactly like latex/text). It differs from
// latexVector ONLY in payload richness: a diagram has multi-color fills+strokes
// and text labels, where an equation is single-ink fill-only glyphs. See
// plugins/mermaid.js + render_gpu/gpu/mermaid_vector.js for how the geometry is
// produced (a getComputedStyle/getScreenCTM flatten reusing core/svg_paths.js).

/**
 * Pure function. TRUE-VECTOR Mermaid diagram command — the mirror of latexVector.
 * Draws the diagram as vector `paths` (shapes/edges/arrowheads) + `texts` (label
 * runs) in SVG/PDF and on the GPU, and as the raster quad `ref` in every hybrid
 * raster fallback. Geometry is in `viewBox` space and maps onto the local box
 * {x, y, w, h} (preserveAspect ⇒ centered uniform fit; else a box→box stretch),
 * y-DOWN already. Each path keeps its own CSS-string fill/stroke (parsed by the
 * backends, the latexVector precedent); each text keeps its top-left origin +
 * size + color + font id (render_gpu/fonts.js).
 *
 * `ref` (raster fallback) + `src` (edge-crop UV rect, image() semantics) let the
 * GPU + hybrid split reuse the image path verbatim; a vector backend ignores
 * `ref`/`src` and consumes `paths`/`texts`/`viewBox`/box.
 *
 * Args:
 *   ref (string): raster media-registry key (hybrid raster fallback)
 *   x, y, w, h (number): the diagram's local draw box
 *   paths (array): [{d, fill, stroke, strokeWidth, fillRule, opacity}] in viewBox space
 *   texts (array): [{text, x, y, size, color, bold, font}] in viewBox space, top-left
 *   viewBox ({minX, minY, w, h}): the geometry coordinate frame (Mermaid layout units)
 *   opacity (number), sx/sy/sw/sh (number): raster source-rect (image() crop)
 *   preserveAspect (bool): uniform scale-to-fit (default true), else box→box stretch
 *
 * @example mermaidVector({ref: "mermaid:default:1:x", x: 0, y: 0, w: 40, h: 20, paths: [{d: "M0 0L10 0", stroke: "#333", strokeWidth: 1}], texts: [], viewBox: {minX: 0, minY: 0, w: 100, h: 50}}).op // "mermaidVector"
 * @example mermaidVector({ref: "r", x: 0, y: 0, w: 4, h: 2, paths: [], texts: [], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).paths // []
 * @example mermaidVector({ref: "r", x: 0, y: 0, w: 4, h: 2, paths: [], texts: [{text: "Hi", x: 1, y: 2, size: 16, color: "#333"}], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).texts[0].text // "Hi"
 * @example mermaidVector({ref: "r", x: 0, y: 0, w: 4, h: 2, paths: [], texts: [], viewBox: {minX: 0, minY: 0, w: 1, h: 1}}).preserveAspect // true
 */
export function mermaidVector({ ref, x, y, w, h, paths, texts, viewBox, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1, preserveAspect = true }) {
  if (typeof ref !== "string") throw new Error(`mermaidVector: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("mermaidVector", { x, y, w, h, opacity, sx, sy, sw, sh });
  if (!Array.isArray(paths)) throw new Error(`mermaidVector: "paths" must be an array, got ${JSON.stringify(paths)}`);
  if (!Array.isArray(texts)) throw new Error(`mermaidVector: "texts" must be an array, got ${JSON.stringify(texts)}`);
  if (!viewBox || typeof viewBox !== "object") throw new Error(`mermaidVector: "viewBox" must be a {minX,minY,w,h} object, got ${JSON.stringify(viewBox)}`);
  requireFinite("mermaidVector.viewBox", { minX: viewBox.minX, minY: viewBox.minY, w: viewBox.w, h: viewBox.h });
  if (!(viewBox.w > 0) || !(viewBox.h > 0)) throw new Error(`mermaidVector: viewBox must have positive w/h, got ${JSON.stringify(viewBox)}`);
  const outPaths = paths.map((p) => {
    if (typeof p.d !== "string" || p.d.trim() === "") throw new Error(`mermaidVector: path "d" must be a non-empty string, got ${JSON.stringify(p.d)}`);
    requireFinite("mermaidVector.path", { strokeWidth: p.strokeWidth ?? 0, opacity: p.opacity ?? 1 });
    // fill/stroke kept as CSS strings (or null) — parsed by the backends via
    // parseColor, exactly like latexVector's glyph fill; the op never rasterizes
    // color itself. fillRule mirrors the `path` op's winding choice.
    return {
      d: p.d,
      fill: p.fill ?? null,
      stroke: p.stroke ?? null,
      strokeWidth: p.strokeWidth ?? 0,
      fillRule: p.fillRule === "evenodd" ? "evenodd" : "nonzero",
      opacity: p.opacity ?? 1,
    };
  });
  const outTexts = texts.map((t) => {
    if (typeof t.text !== "string") throw new Error(`mermaidVector: text "text" must be a string, got ${JSON.stringify(t.text)}`);
    requireFinite("mermaidVector.text", { x: t.x, y: t.y, size: t.size, opacity: t.opacity ?? 1 });
    return {
      text: t.text, x: t.x, y: t.y, size: t.size,
      color: t.color ?? "#000000",
      bold: !!t.bold,
      font: typeof t.font === "string" ? t.font : DEFAULT_FONT,
      opacity: t.opacity ?? 1,
    };
  });
  return {
    op: "mermaidVector", ref, x, y, w, h, opacity,
    preserveAspect: preserveAspect !== false,
    src: sourceRect(sx, sy, sw, sh),
    paths: outPaths,
    texts: outTexts,
    viewBox: { minX: viewBox.minX, minY: viewBox.minY, w: viewBox.w, h: viewBox.h },
  };
}

/**
 * Pure function. Generic VECTOR PATH command (Wave 2 — unified path shapes). `d`
 * is an SVG path-data string in the CURRENT LOCAL SPACE (same frame as rect/
 * ellipse geometry); the transform stack maps it to world like every other op.
 * The ONE op behind the preset-shape library (core/shapes.js) and any future
 * arbitrary-path widget: paint_skia rasterizes it with CanvasKit.Path.
 * MakeFromSVGString (the proven latexVector path), svg_backend emits a native
 * `<path d>`, pdf_backend converts it through the existing svgPathToPdfOps. Fill
 * and stroke are independent (either may be null); `fillRule` picks the winding
 * rule for self-intersecting/holed paths ("nonzero" like a normal filled shape,
 * "evenodd" for star/donut-style holes). Shadow/glow/border come FREE — a path
 * widget wraps in applyEffects exactly like rect, and effects operate on the
 * rendered silhouette.
 *
 * Args:
 *   d (string): SVG path data, non-empty. PDF-export-safe subset: M L H V C Q T Z
 *     (abs+rel). NOTE: S (smooth-cubic) and A (arc) rasterize in Skia + emit in
 *     SVG, but pdf_backend's svgPathToPdfOps rejects them — a path intended for
 *     PDF export must avoid S/A (every core/shapes.js preset does).
 *   fill (string|number[]|null): fill color, or null for no fill
 *   stroke (string|number[]|null): stroke color, or null for no stroke
 *   strokeWidth (number): stroke width in local units (0 ⇒ no stroke)
 *   fillRule ("nonzero"|"evenodd"): winding rule for the fill
 *   opacity (number): per-item group opacity
 *
 * @example path({d: "M0 0L10 0L5 8Z", fill: "#f00"}).op // "path"
 * @example path({d: "M0 0L10 0L5 8Z", fill: "#f00"}).fill // [1, 0, 0, 1]
 * @example path({d: "M0 0h10v10h-10z", fill: "#000", fillRule: "evenodd"}).fillRule // "evenodd"
 * @example path({d: "M0 0L10 0", stroke: "#000", strokeWidth: 2}).fill // null
 */
export function path({ d, fill = null, stroke = null, strokeWidth = 0, fillRule = "nonzero", opacity = 1, blur = 0, ...trim }) {
  if (typeof d !== "string" || d.trim() === "") throw new Error(`path: "d" must be a non-empty SVG path string, got ${JSON.stringify(d)}`);
  if (fillRule !== "nonzero" && fillRule !== "evenodd") throw new Error(`path: "fillRule" must be "nonzero" or "evenodd", got ${JSON.stringify(fillRule)}`);
  requireFinite("path", { strokeWidth, opacity, blur });
  return {
    op: "path", d, fillRule,
    fill: fill === null ? null : parsePaint(fill),
    stroke: stroke === null ? null : parsePaint(stroke),
    ...normalizeStrokeTrim("path", trim),
    // `blur` (optional): a Gaussian MASK-blur radius in LOCAL units — a general
    // soft-path enhancement any consumer can reuse (the corkboard YARN uses it for
    // its soft cast shadow, a blurred stroke, avoiding a heavier effectSubtree
    // wrap). 0 = crisp (byte-identical to a path built without the field). The
    // backend scales the sigma by the CTM, so the softness tracks zoom.
    strokeWidth, opacity, blur: Math.max(0, blur),
  };
}

/**
 * Pure function. Normalizes a source UV rect (sx, sy, sw, sh) to a
 * {sx, sy, sw, sh} object clamped into the unit square: origins to [0,1],
 * extents to [0, 1−origin] (so the rect can't spill past the texture). An empty
 * (sw or sh === 0) rect is legal — it draws nothing, matching a fully-cropped-
 * away edge.
 *
 * @example sourceRect(0, 0, 1, 1) // {sx: 0, sy: 0, sw: 1, sh: 1}
 * @example sourceRect(0.2, 0.1, 0.5, 0.6) // {sx: 0.2, sy: 0.1, sw: 0.5, sh: 0.6}
 * @example sourceRect(-0.5, 0, 2, 1) // {sx: 0, sy: 0, sw: 1, sh: 1} (clamped into the unit square)
 */
export function sourceRect(sx, sy, sw, sh) {
  const ox = Math.max(0, Math.min(sx, 1)), oy = Math.max(0, Math.min(sy, 1));
  return {
    sx: ox, sy: oy,
    sw: Math.max(0, Math.min(sw, 1 - ox)),
    sh: Math.max(0, Math.min(sh, 1 - oy)),
  };
}

/**
 * Pure function. Pushes a SIGNED similarity transform onto the stack; composes
 * with the current one.
 *
 * The similarity part (translate/rotate/uniform scale, NO skew) is exactly
 * core/transform.js's model. `signX`/`signY` are ±1 per-axis REFLECTION signs,
 * and they live HERE rather than in core/transform.js on purpose: the stored pose
 * of a widget is a pure similarity and must stay one (parent chains compose there
 * and the model's whole guarantee is that they can never manufacture a shear or a
 * handedness flip). A reflection is instead denoted by a NEGATIVE STORED w/h
 * (core/geometry.js flippedBox) and realized only at PAINT time, which is this
 * op — the display list is the first place a mirror can exist, and the last place
 * it needs to.
 *
 * The signed similarities are closed under composition, so the stack still folds
 * to a single frame (signedCompose): sign·sign multiplies elementwise and an odd
 * number of reflections REVERSES the inner rotation, because
 * diag(sx,sy)·R(φ)·diag(sx,sy) = R(sx·sy·φ).
 *
 * A sign of +1 is OMITTED from the emitted op, so the display list of a scene with
 * no flip in it is byte-identical to the one this codebase emitted before signs
 * existed (the same optional-key idiom as core/derive.js's `node.mirror`).
 *
 * @example pushTransform({x: 5, y: 6}) // {op: "pushTransform", x: 5, y: 6, rotation: 0, scale: 1}
 * @example // the mirror-about-the-box-center push a flipped node gets (see sceneIR):
 * @example pushTransform({x: 100, signX: -1}) // {op: "pushTransform", x: 100, y: 0, rotation: 0, scale: 1, signX: -1}
 */
export function pushTransform({ x = 0, y = 0, rotation = 0, scale = 1, signX = 1, signY = 1 }) {
  requireFinite("pushTransform", { x, y, rotation, scale });
  if (Math.abs(signX) !== 1 || Math.abs(signY) !== 1)
    throw new Error(`pushTransform: signX/signY must be exactly +1 or -1 (a reflection, not a scale); got ${signX}, ${signY}`);
  const op = { op: "pushTransform", x, y, rotation, scale };
  if (signX !== 1) op.signX = signX;
  if (signY !== 1) op.signY = signY;
  return op;
}

/**
 * Pure function. Does this frame carry a reflection? The gate that keeps the
 * unmirrored path on core/transform.js's plain compose (see flattenIR).
 *
 * @example isReflected({x: 0, y: 0, rotation: 0, scale: 1}) // false
 * @example isReflected({x: 0, y: 0, rotation: 0, scale: 1, signX: -1}) // true
 */
export function isReflected(t) {
  return (t.signX ?? 1) !== 1 || (t.signY ?? 1) !== 1;
}

/**
 * Pure function. Maps a LOCAL point through a SIGNED frame → world. The
 * sign-aware twin of core/transform.js `apply`, which it reduces to exactly when
 * there is no reflection.
 *
 * WHY IT IS NEEDED, AND WHERE (a defect this caught, worth stating). Most backend
 * code never maps a point by hand — it concats the frame onto the canvas CTM and
 * lets local geometry ride through (paint_skia applyView, pdf cmSimilarity, svg
 * similarityTransform), and those three learned the signs directly. But the
 * per-pixel MATERIAL and BACKDROP handlers (glass, materialFill, materialBackdrop,
 * the magnifier lens) are different: they compute their region's DEVICE-space
 * center + half-extents themselves and draw at the device root, so they map the
 * center point explicitly. Doing that with a sign-blind `apply` put a flipped
 * material's center on the far side of its box — the widget rendered in the wrong
 * place entirely (measured: a 160-wide corkboard at x 40 drew at x 200). Half-
 * extents are NOT the hazard there (core/derive normalizes the sign away before
 * emit, so they are always positive); the CENTER is.
 *
 * @param {object} t - a signed frame {x, y, rotation, scale, signX?, signY?}
 * @param {number} px - local x
 * @param {number} py - local y
 * @returns {{x: number, y: number}} the world point
 *
 * @example signedApply({x: 10, y: 0, rotation: 0, scale: 2}, 3, 4) // {x: 16, y: 8}
 * @example // an x-mirrored frame reflects the local point before placing it:
 * @example signedApply({x: 200, y: 0, rotation: 0, scale: 1, signX: -1}, 80, 50) // {x: 120, y: 50}
 * @example // the box center is the mirror's FIXED point, which is why a flipped
 * @example // widget's center is where it always was:
 * @example signedApply({x: 200, y: 0, rotation: 0, scale: 1, signX: -1}, 200, 0) // {x: 0, y: 0}
 */
export function signedApply(t, px, py) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const x = (t.signX ?? 1) * px, y = (t.signY ?? 1) * py;
  return { x: t.x + t.scale * (c * x - s * y), y: t.y + t.scale * (s * x + c * y) };
}

/**
 * Pure function. Composes two SIGNED similarities — `outer ∘ inner`, i.e. "apply
 * inner, then outer", the same reading as core/transform.js compose (which this
 * reduces to EXACTLY when both signs are +1, so an unmirrored scene folds
 * byte-identically).
 *
 * The group of similarities-plus-reflections IS closed, which is what lets the
 * flattened stack stay a single frame instead of degenerating into matrices.
 * Writing a frame as p ↦ t + s·R(θ)·D·p with D = diag(signX, signY):
 *
 *   D_o·R(θ_i)·D_o = R(det_o·θ_i)   where det_o = signX_o·signY_o
 *
 * so the product's rotation is θ_o + det_o·θ_i, its signs are the elementwise
 * products, its scale is the product, and its translation is the outer frame
 * applied to the inner translation.
 *
 * @example signedCompose({x: 0, y: 0, rotation: 0, scale: 1, signX: 1, signY: 1}, {x: 5, y: 6, rotation: 0, scale: 2, signX: 1, signY: 1}) // {x: 5, y: 6, rotation: 0, scale: 2, signX: 1, signY: 1}
 * @example // an x-mirror outside a rotation REVERSES that rotation (det = -1):
 * @example signedCompose({x: 0, y: 0, rotation: 0, scale: 1, signX: -1, signY: 1}, {x: 0, y: 0, rotation: 1, scale: 1, signX: 1, signY: 1}) // {x: 0, y: 0, rotation: -1, scale: 1, signX: -1, signY: 1}
 * @example // the outer frame maps the inner translation, reflecting it too:
 * @example signedCompose({x: 100, y: 0, rotation: 0, scale: 1, signX: -1, signY: 1}, {x: 30, y: 5, rotation: 0, scale: 1, signX: 1, signY: 1}) // {x: 70, y: 5, rotation: 0, scale: 1, signX: -1, signY: 1}
 */
export function signedCompose(outer, inner) {
  const sxo = outer.signX ?? 1, syo = outer.signY ?? 1;
  const c = Math.cos(outer.rotation), s = Math.sin(outer.rotation);
  const px = sxo * inner.x, py = syo * inner.y; // reflect, then rotate+scale+translate
  return {
    x: outer.x + outer.scale * (c * px - s * py),
    y: outer.y + outer.scale * (s * px + c * py),
    rotation: outer.rotation + sxo * syo * inner.rotation,
    scale: outer.scale * inner.scale,
    signX: sxo * (inner.signX ?? 1),
    signY: syo * (inner.signY ?? 1),
  };
}

/**
 * Pure function. Pops the innermost transform.
 *
 * @example popTransform() // {op: "popTransform"}
 */
export function popTransform() {
  return { op: "popTransform" };
}

/**
 * Pure function. Backdrop blur effect node: Gaussian-blurs the composite-so-far
 * and composites the result back at `opacity` (canvas equivalent: snapshot +
 * ctx.filter blur + drawImage; GPU equivalent: separable blur passes over the
 * offscreen scene texture). `radius` is in WORLD units, like the blur plugin.
 *
 * @example blurBackdrop({radius: 6}).opacity // 1
 */
export function blurBackdrop({ radius, opacity = 1 }) {
  requireFinite("blurBackdrop", { radius, opacity });
  return { op: "blurBackdrop", radius: Math.max(0, radius), opacity };
}

/**
 * Pure function. Magnifier effect node — a SHAPED LENS (manifest "BOX-SHAPED
 * MAGNIFIERS + magnifier ORIGIN"): composites a magnified view of the scene
 * below the lens, clipped to a region SHAPE (circle | rounded rect), plus a
 * rim/border ring. This is one half of the shaped-lens family — cropSubtree is
 * the other (a lens = shaped clip + magnified re-emit + rim/border; a crop box
 * is magnification 1 sourcing a NAMED subtree instead of the z-prefix). Two
 * lens-fill paths, chosen by `supersample`:
 *   supersample:false — sample the composite-so-far backdrop texture with UVs
 *     contracted by 1/magnification about the ORIGIN (soft: the lens content is
 *     a rasterized backdrop upscaled, effectively 1/M of screen resolution).
 *   supersample:true (default) — the backend RE-RENDERS the sub-list emitted
 *     BELOW this op (command order is z-order, so everything before the lens is
 *     below it) under a lens view at magnification·zoom about the ORIGIN, then
 *     samples that sharp re-render. Depth-capped: a magnifier inside a
 *     re-render falls back to backdrop sampling (compositor's recursion guard).
 *
 * SHAPE — `shape:"circle"` (default) uses (cx, cy, r); `shape:"box"` uses
 * (cx, cy) center + (halfW, halfH) half-extents + cornerRadius (a rounded-rect
 * lens, the SAME sdRoundBox region a crop box / a plain rect uses); `shape:"star"`
 * uses (cx, cy) + (halfW, halfH) as the inscribing bbox plus (points, innerRatio)
 * — an n-pointed star silhouette (core/shapes.js starPathD geometry). The border
 * is ONE stroke ring for EVERY shape: (stroke, strokeWidth), the shared
 * stroked-box bundle (core/properties.js). `rimColor`/`rimWidth` are accepted as
 * LEGACY INPUT ALIASES (the pre-shape circle rim) and FOLD into stroke/
 * strokeWidth — the op itself carries only the unified stroke fields, so every
 * backend reads one border regardless of shape (the circle rim IS the box
 * border). A circle built from rimColor/rimWidth is byte-identical to before.
 *
 * ORIGIN — (originX, originY) is the LOCAL-space point the lens magnifies
 * AROUND (the manifest "magnifier target": defaults to the lens center, so the
 * old center-magnifying behavior is byte-identical; retargetable to any anchor
 * via plugins/magnifier.js's origin.{x,y} equations). Distinct from (cx, cy),
 * which is where the lens region SITS on screen: the origin decouples "what the
 * lens magnifies" from "where the lens is drawn".
 *
 * ANISOTROPIC ZOOM — `magnification` is the ISOTROPIC zoom (both axes). For a
 * per-axis zoom (a lens whose box aspect differs from the source region it
 * shows — e.g. a WIDE region mapped into a TALL lens), pass `magnificationX` /
 * `magnificationY`; each defaults to `magnification`, so an isotropic op is
 * unchanged and renders BYTE-IDENTICALLY. The backend scales the sampled scene
 * by (magX, magY) about the origin.
 *
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).strokeWidth // 0
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).shape // "circle"
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).originX // 0 (defaults to the lens center cx)
 * @example magnifyBackdrop({cx: 10, cy: 20, r: 50, magnification: 2, originX: 5, originY: 8}).originY // 8
 * @example magnifyBackdrop({shape: "box", cx: 0, cy: 0, halfW: 80, halfH: 50, cornerRadius: 12, magnification: 2}).shape // "box"
 * @example magnifyBackdrop({shape: "star", cx: 0, cy: 0, halfW: 80, halfH: 80, points: 5, innerRatio: 0.5, magnification: 2}).shape // "star"
 * @example magnifyBackdrop({shape: "star", cx: 0, cy: 0, halfW: 60, halfH: 60, points: 6.4, magnification: 2}).points // 6 (rounded to a whole star)
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2, rimColor: "#000", rimWidth: 4}).strokeWidth // 4 (legacy rim folds into stroke)
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2, supersample: false}).supersample // false
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).magnificationX // 2 (per-axis defaults to isotropic)
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2, magnificationX: 3, magnificationY: 1.5}).magnificationY // 1.5
 */
export function magnifyBackdrop({
  shape = "circle", cx, cy, r = 0, halfW = 0, halfH = 0, cornerRadius = 0,
  points = 5, innerRatio = 0.5,
  originX = cx, originY = cy, magnification, magnificationX, magnificationY,
  stroke = null, strokeWidth = 0, rimColor = null, rimWidth = 0,
  opacity = 1, supersample = true,
}) {
  if (shape !== "circle" && shape !== "box" && shape !== "star")
    throw new Error(`magnifyBackdrop: shape must be "circle", "box" or "star", got ${JSON.stringify(shape)}`);
  // Geometry validated per shape: circle → r; box → half-extents + corner; star →
  // half-extents (bbox the star is inscribed in) + point count + inner-notch ratio.
  const geom = shape === "box" ? { halfW, halfH, cornerRadius }
    : shape === "star" ? { halfW, halfH, points, innerRatio }
    : { r };
  // Collapse the legacy rim aliases into the ONE stroke bundle (stroke/strokeWidth
  // win when given; else the pre-shape circle rim folds in). The op carries only
  // stroke/strokeWidth — every shape renders one border ring.
  const borderColor = stroke ?? rimColor;
  const borderWidth = strokeWidth > 0 ? strokeWidth : rimWidth;
  // Per-axis zoom, each defaulting to the isotropic magnification (so an op
  // without the new params is unchanged → byte-identical render).
  const magX = magnificationX ?? magnification;
  const magY = magnificationY ?? magnification;
  requireFinite("magnifyBackdrop", { cx, cy, ...geom, originX, originY, magnification, magnificationX: magX, magnificationY: magY, strokeWidth: borderWidth, opacity });
  if (magnification <= 0) throw new Error(`magnifyBackdrop: magnification must be > 0, got ${magnification}`);
  if (magX <= 0 || magY <= 0) throw new Error(`magnifyBackdrop: per-axis magnification must be > 0, got (${magX}, ${magY})`);
  return {
    op: "magnifyBackdrop", shape, cx, cy, r, halfW, halfH,
    cornerRadius: Math.max(0, cornerRadius),
    // Star silhouette params (harmless defaults for circle/box): point count
    // clamped to a real star (≥2), inner-notch ratio to [0,1] — mirrors starPathD.
    points: Math.max(2, Math.round(points)), innerRatio: Math.max(0, Math.min(1, innerRatio)),
    originX, originY, magnification, magnificationX: magX, magnificationY: magY,
    stroke: borderColor === null ? null : parseColor(borderColor),
    strokeWidth: borderWidth,
    opacity, supersample: !!supersample,
  };
}

/**
 * Pure function. Liquid Glass backdrop node — a rounded-rect region of macOS
 * "Liquid Glass" material (design.md). A backdrop sampler in the SAME family as
 * blurBackdrop/magnifyBackdrop: it reads the composite-so-far (everything below
 * in z-order), builds a BLURRED copy, and draws the region through the REAL SkSL
 * glass shader (render_gpu/skia/glass_shader.js) — edge-weighted refraction +
 * luminance-adaptive tint + top-light specular + squircle corners. The op is a
 * rounded BOX only (a capsule when cornerRadius >= min(halfW, halfH)); it reuses
 * magnifyBackdrop's box geometry (cx, cy, halfW, halfH, cornerRadius) and stroke
 * bundle (stroke/strokeWidth = the optional bright hairline border).
 *
 * ALL LENGTHS ARE WORLD UNITS (halfW/halfH/cornerRadius/edgeFalloff/
 * refractionStrength/blurRadius) — the backend converts to device px/sigma at
 * render time by world.scale·zoom·dpr, exactly like blurBackdrop's radius.
 * `tint` is a PAINT (solid or gradient); the shader consumes its representative
 * solid rgba as a color cast + strength (alpha). `lightAngle` is radians (screen
 * space; -PI/2 = straight above). `materialize` (0..1) is the appear ramp.
 *
 * `squircle` and `surfaceTension` together decide the SILHOUETTE: the exponent of
 * the corner curve, and how far the straight edges have relaxed into that same
 * curve (0 = a rectangle with squircle corners, 1 = the superellipse inscribed in
 * the box, with no flat edge left anywhere). Everything that draws the boundary —
 * the shader, the hairline stroke, the drop shadow, the thumbnail stand-in — reads
 * that one curve from render_gpu/skia/glass_shader.js.
 *
 * The MATERIAL-CHARACTER knobs (squircle, sheen, specularPower, contactShadow,
 * caustic, edgeLight, tintAdaptivity, chromatic) are the shader-uniform tuning
 * values, and `backdropScale` / `shadowStrength` are CPU-side render controls —
 * the demo widget surfaces them all as self.* custom props so the material is
 * user-tweakable. `backdropScale` is the RESOLUTION FACTOR the below-content is
 * re-rendered at for sampling: 1 = device zoom resolution, 2 = supersample
 * (crisper distortion, slower), 0.5 = half res (faster, softer). Clamped [0.25, 2].
 *
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40, cornerRadius: 30}).op // "glassBackdrop"
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40}).materialize // 1 (settled by default)
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40, tint: "rgba(255,255,255,0.14)"}).tint // [1, 1, 1, 0.14]
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40, cornerRadius: -5}).cornerRadius // 0 (negative radii clamped)
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40, surfaceTension: 2}).surfaceTension // 1 (fully relaxed is the end of the family)
 * @example glassBackdrop({cx: 0, cy: 0, halfW: 80, halfH: 40, backdropScale: 5}).backdropScale // 5 (no upper cap; min 0.25)
 */
export function glassBackdrop({
  cx, cy, halfW, halfH, cornerRadius = 0,
  blurRadius = 8, refractionStrength = 14, edgeFalloff = 22,
  lightAngle = -Math.PI / 2, lightIntensity = 0.8,
  tint = null, saturation = 0.92, materialize = 1,
  squircle = 4, surfaceTension = 0, sheen = 0.1, specularPower = 8, contactShadow = 0.26,
  caustic = 0.12, edgeLight = 0.14, tintAdaptivity = 1, chromatic = 0.08,
  backdropScale = 1, shadowStrength = 0.3,
  stroke = null, strokeWidth = 0, opacity = 1,
}) {
  requireFinite("glassBackdrop", {
    cx, cy, halfW, halfH, cornerRadius, blurRadius, refractionStrength,
    edgeFalloff, lightAngle, lightIntensity, saturation, materialize,
    squircle, surfaceTension, sheen, specularPower, contactShadow, caustic, edgeLight,
    tintAdaptivity, chromatic, backdropScale, shadowStrength, strokeWidth, opacity,
  });
  return {
    op: "glassBackdrop", cx, cy, halfW, halfH,
    cornerRadius: Math.max(0, cornerRadius),
    blurRadius: Math.max(0, blurRadius),
    refractionStrength: Math.max(0, refractionStrength),
    edgeFalloff: Math.max(0, edgeFalloff),
    lightAngle, lightIntensity,
    // tint is a PAINT (paint:true prop) but the shader is single-color: keep the
    // full parsed paint here (parsePaint), and the backend reduces it to a solid
    // rgba (parseColor) — the same single-color-consumer path a magnifier border
    // or a shadow uses. Null tint ⇒ no skin overlay.
    tint: tint === null ? null : parsePaint(tint),
    saturation: Math.max(0, Math.min(1, saturation)),
    materialize: Math.max(0, Math.min(1, materialize)),
    // material-character knobs (shader uniforms) — clamped to sane domains
    squircle: Math.max(2, squircle),          // >=2: never concave (2 == circular arc)
    // [0,1] is the DEFINITION of the family, not a taste limit: 0 is the
    // un-relaxed rectangle-plus-corners and 1 is the point at which the inner
    // rectangle has collapsed entirely, so there is nothing left to relax.
    surfaceTension: Math.max(0, Math.min(1, surfaceTension)),
    sheen: Math.max(0, sheen),
    specularPower: Math.max(1, specularPower),
    contactShadow: Math.max(0, contactShadow),
    caustic: Math.max(0, caustic),
    edgeLight: Math.max(0, edgeLight),
    tintAdaptivity: Math.max(0, Math.min(1, tintAdaptivity)),
    chromatic: Math.max(0, chromatic),
    // CPU-side render controls
    backdropScale: Math.max(0.25, backdropScale),
    shadowStrength: Math.max(0, shadowStrength),
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth: Math.max(0, strokeWidth),
    opacity,
  };
}

/**
 * Pure function. THE MATERIAL BACKDROP node — the reusable GENERALIZATION of
 * glassBackdrop. A backdrop sampler (same family as blur/magnify/glass) that
 * reads the composite-so-far, builds a BLURRED copy, and draws a rounded-rect
 * region through a REGISTERED SkSL MATERIAL selected by `material` (a string id
 * resolved by render_gpu/skia/materials.js). Every material shares ONE piece of
 * machinery — the below-content re-render, the sharp+blurred child image
 * shaders, and the RuntimeEffect compile+cache (paint_skia.js
 * handleMaterialBackdrop, reusing the glass groundwork) — so a NEW material is
 * just a new SkSL shader + a uniform packer + a one-line registry entry; it does
 * NOT re-hack this op or the backend. (Liquid Glass predates this op and keeps
 * its bespoke handleGlassBackdrop; new materials — CRT, and the follow-up
 * dirty/distorted-glass + magnify materials — ride this general path.)
 *
 * `params` is the material's OWN flat knob map ({name: value}); numeric values
 * must be finite, everything else (e.g. a color string a material's packer will
 * parse) passes through untouched. Because `params` are ordinary
 * already-evaluated item-state values, ANY of them may be authored as a `=`
 * equation upstream (the universal eval path) with zero engine change — exactly
 * like glass's self.* knobs.
 *
 * ALL LENGTHS ARE WORLD UNITS (halfW/halfH/cornerRadius/blurRadius) — the
 * backend converts to device px/sigma by world.scale·zoom·dpr, like glass.
 * `blurRadius` is the frost blur of the sampled backdrop (every material gets a
 * sharp AND a blurred child). `backdropScale` is the below-content sample
 * resolution factor (1 = device zoom res; clamped [0.25, 2]), like glass.
 *
 * @example materialBackdrop({material: "crt", cx: 0, cy: 0, halfW: 80, halfH: 60}).op // "materialBackdrop"
 * @example materialBackdrop({material: "crt", cx: 0, cy: 0, halfW: 80, halfH: 60, params: {curvature: 0.2}}).params.curvature // 0.2
 * @example materialBackdrop({material: "crt", cx: 0, cy: 0, halfW: 80, halfH: 60, cornerRadius: -3}).cornerRadius // 0 (negative radii clamped)
 * @example materialBackdrop({material: "crt", cx: 0, cy: 0, halfW: 80, halfH: 60, backdropScale: 9}).backdropScale // 9 (no upper cap; min 0.25)
 */
export function materialBackdrop({
  material, cx, cy, halfW, halfH, cornerRadius = 0,
  blurRadius = 8, backdropScale = 1, params = {},
  stroke = null, strokeWidth = 0, opacity = 1,
}) {
  if (typeof material !== "string" || material.length === 0) throw new Error(`materialBackdrop: "material" must be a non-empty id string, got ${JSON.stringify(material)}`);
  requireFinite("materialBackdrop", { cx, cy, halfW, halfH, cornerRadius, blurRadius, backdropScale, strokeWidth, opacity });
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error(`materialBackdrop: "params" must be a plain object, got ${JSON.stringify(params)}`);
  // Numeric knobs must be finite (a NaN uniform silently blackens a whole shader
  // region); non-numbers (a color string a packer will parse) pass through.
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`materialBackdrop: param "${k}" is a non-finite number (${v})`);
  }
  return {
    op: "materialBackdrop", material,
    cx, cy, halfW, halfH,
    cornerRadius: Math.max(0, cornerRadius),
    blurRadius: Math.max(0, blurRadius),
    backdropScale: Math.max(0.25, backdropScale),
    params: { ...params },
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth: Math.max(0, strokeWidth),
    opacity,
  };
}

/**
 * Pure function. FOREGROUND-material fill — the sibling of `materialBackdrop` and
 * the key architectural half the corkboard family adds. Draws a rounded-rect region
 * through a REGISTERED SkSL material (a `backdrop: false` descriptor in
 * render_gpu/skia/materials.js) that synthesizes its ENTIRE look from uniforms +
 * procedural noise. Unlike `materialBackdrop` there is NO below-content re-render
 * and NO children — so no `blurRadius` / `backdropScale`: paint_skia.js
 * handleMaterialFill just compiles+caches the SkSL, `effect.makeShader(uniforms)`,
 * clips to the AABB, and fills (the shader returns premultiplied 0 outside its own
 * SDF).
 *
 * `params` is the material's OWN flat knob map ({name: value}); numeric values must
 * be finite, everything else (a colour string a packer will parse) passes through
 * — so ANY knob may be a `=` equation upstream (zero engine change), exactly like
 * glass/CRT. ALL LENGTHS ARE WORLD UNITS (halfW/halfH/cornerRadius) — the backend
 * scales to device by world.scale·zoom·dpr.
 *
 * `shadow` (optional) is a soft blurred rounded-rect drawn BENEATH the fill (the
 * glass drawGlassShadow precedent, generalized): `{dx, dy, blur, alpha, grow}`, all
 * WORLD units except the 0..1 `alpha` — the fill's own rounded-rect grown by `grow`,
 * offset by (dx, dy), mask-blurred by `blur`, filled black at `alpha`. The PLUGIN
 * computes dx/dy from the light direction and the object's apparent height (a proud
 * tack casts a larger, more-offset shadow than a pressed-in one), so the handler
 * stays a dumb draw. Absent ⇒ no handler-side shadow (the note curl's SELF shadow
 * still lives in the shader).
 *
 * @example materialFill({material: "corkboard", cx: 0, cy: 0, halfW: 400, halfH: 300}).op // "materialFill"
 * @example materialFill({material: "corkboardNote", cx: 0, cy: 0, halfW: 80, halfH: 100, params: {curlAmount: 0.7}}).params.curlAmount // 0.7
 * @example materialFill({material: "corkboardThumbtack", cx: 0, cy: 0, halfW: 20, halfH: 20, cornerRadius: -3}).cornerRadius // 0 (negative radii clamped)
 * @example materialFill({material: "corkboardThumbtack", cx: 0, cy: 0, halfW: 20, halfH: 20, shadow: {dx: 4, dy: 6, blur: 8, alpha: 0.3, grow: 2}}).shadow.grow // 2
 */
export function materialFill({
  material, cx, cy, halfW, halfH, cornerRadius = 0, params = {},
  shadow = null, stroke = null, strokeWidth = 0, opacity = 1,
}) {
  if (typeof material !== "string" || material.length === 0) throw new Error(`materialFill: "material" must be a non-empty id string, got ${JSON.stringify(material)}`);
  requireFinite("materialFill", { cx, cy, halfW, halfH, cornerRadius, strokeWidth, opacity });
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error(`materialFill: "params" must be a plain object, got ${JSON.stringify(params)}`);
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`materialFill: param "${k}" is a non-finite number (${v})`);
  }
  let shadowOut = null;
  if (shadow !== null) {
    if (typeof shadow !== "object" || Array.isArray(shadow)) throw new Error(`materialFill: "shadow" must be a plain object or null, got ${JSON.stringify(shadow)}`);
    requireFinite("materialFill.shadow", { dx: shadow.dx, dy: shadow.dy, blur: shadow.blur, alpha: shadow.alpha, grow: shadow.grow });
    shadowOut = {
      dx: shadow.dx, dy: shadow.dy,
      blur: Math.max(0, shadow.blur),
      alpha: Math.max(0, Math.min(1, shadow.alpha)),
      grow: Math.max(0, shadow.grow),
    };
  }
  return {
    op: "materialFill", material,
    cx, cy, halfW, halfH,
    cornerRadius: Math.max(0, cornerRadius),
    params: { ...params },
    shadow: shadowOut,
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth: Math.max(0, strokeWidth),
    opacity,
  };
}

/**
 * Pure function. Crop-box effect node (manifest ARCHITECTURE PLAN #3): fills a
 * rounded-rect region, then clips+re-emits `content` (the target item's OWN
 * local-space commands, already wrapped in a pushTransform/popTransform pair
 * mapping the target's local space into the crop box's local space — the
 * caller, sceneIR, builds that composed transform since it alone knows both
 * nodes' world transforms), then strokes the border. `content` is plain IR
 * (JSON-serializable, re-interpretable) — the SAME "re-emit a sub-list
 * through a clip" trick as magnifyBackdrop, generalized from a circle to a
 * rounded-rect region and from "everything below in z-order" to ONE named
 * subtree. An empty/absent `content` (dangling target) still paints the
 * fill/border (the crop box's ghost outline covers pickability; this covers
 * its visible chrome, matching a plain box with nothing inside it).
 *
 * GROUP SUBTREE CROP (the subtree-effects gap): the SAME op also clips a GROUP's
 * whole member composite to the group's own (inset) region — `content` is then
 * the members' already-absolute-world IR (render_gpu/ports.sceneIR), with no
 * fill/border. Nothing here changes: content is opaque re-interpretable IR
 * (plugins/group.emit reuses this op verbatim).
 *
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, content: []}).op // "cropSubtree"
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, cornerRadius: 2, content: []}).cornerRadius // 2
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, content: []}).fill // null
 */
export function cropSubtree({ x, y, w, h, cornerRadius = 0, fill = null, stroke = null, strokeWidth = 0, opacity = 1, content = [], ...trim }) {
  requireFinite("cropSubtree", { x, y, w, h, cornerRadius, strokeWidth, opacity });
  if (!Array.isArray(content)) throw new Error(`cropSubtree: "content" must be an array, got ${JSON.stringify(content)}`);
  return {
    op: "cropSubtree", x, y, w, h,
    cornerRadius: Math.max(0, cornerRadius),
    fill: fill === null ? null : parseColor(fill),
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth, opacity, content,
    ...normalizeStrokeTrim("cropSubtree", trim), // a crop/media FRAME's border trims too
  };
}

/** The widget-composite blend modes (manifest Round 12D "BLEND MODES"): how a
 * widget's own draw composites against the backdrop. RE-EXPORTED from
 * core/properties.js, the option-list home — the same single-sourcing this module
 * already uses for SCRUB_WRAP_MODES, replacing a hand-kept duplicate literal that
 * a test had to police. `effectSubtree` validates `blend` against it; the raster
 * mapping is render_gpu/skia/blend_modes.js and the export classification is
 * pdf_backend.js (blendNeedsBelowRaster / gsBlend), both keyed off this list. */
export { BLEND_MODES } from "../core/properties.js";

/**
 * How many standard deviations of a Gaussian blur reach beyond its center — the
 * kernel-support bound used to size an effect's halo margin. Beyond 3σ a
 * Gaussian's weight is negligible (<0.3% total), so a halo of blur·3 contains
 * essentially all the spill. ONE shared value for both this module's
 * effectSubtree build-time margin and effects.js effectsCullMargin (they must
 * agree, or culling clips a halo the compositor still draws). Was duplicated as
 * a local `= 3` in both, citing the retired gpu/shaders.js MAX_HALF_KERNEL.
 */
export const BLUR_SUPPORT_SIGMAS = 3;

/**
 * The SUPERSAMPLE / raster density — device px per output px for every hybrid
 * RASTER region (a vector backend's blurred/effected sub-image, a rasterized
 * LaTeX/PDF-page quad). ONE shared value so a PDF and an SVG of the same scene,
 * and the GPU's LaTeX/PDF rasters, all embed EQUAL-resolution raster regions.
 * 2 = the retina-dpr precedent (a 2× supersample reads crisp on a 1× display).
 * Was duplicated as a local `= 2` in svg_backend (RASTER_SCALE), pdf_backend
 * (rasterScale default), gpu/latex_raster (LATEX_RASTER_DENSITY) and pdf_page
 * (PDF_RASTER_DENSITY) — those now import this.
 */
export const SUPERSAMPLE_DENSITY = 2;

/**
 * The shaped-lens re-render recursion cap: ONE level of true vector/supersample
 * lens re-interpretation; a lens NESTED inside a lens's replay falls back to a
 * raster embed (vector backends) / backdrop sampling (GPU + Skia). ONE shared
 * value across every backend's lens handler — was triplicated as MAX_LENS_DEPTH
 * (svg_backend, pdf_backend) and MAX_SUPERSAMPLE_DEPTH (skia paint_skia), each
 * citing the GPU compositor's bound; they now import this.
 */
export const MAX_LENS_DEPTH = 1;

/**
 * Pure function. The EFFECTS SUBSTRATE node (manifest Round 12D: "ALL FOUR
 * reuse one substrate: per-widget render-to-texture + blurred/blended
 * composite"). ONE op carries all three effects because they share ONE
 * offscreen render of the widget: `content` (the widget's own ops) renders to
 * a texture ONCE, then up to three composites read it —
 *
 *   SHADOW (shadow: {dx, dy, blur, color, opacity}) — the texture's blurred
 *     alpha silhouette, tinted `color` × `opacity`, drawn UNDER the widget at
 *     the canvas-space offset (dx, dy). Blur is a Gaussian SIGMA in world
 *     units (the blurBackdrop radius convention).
 *   BLOOM (bloom: {radius, strength}) — the texture's own Gaussian-blurred
 *     copy (sigma `radius`, world units) scaled by `strength`, ADD-composited
 *     ON TOP of the widget.
 *   BLEND (blend: any BLEND_MODES id — Photoshop's set) — the composite op of
 *     the widget's own draw against the backdrop.
 *
 * (x, y, w, h) is the widget's LOCAL bbox (the render footprint); `margin` is
 * computed here at build time — the local-unit halo the effects add around
 * that bbox (blur spill = 3σ, the BLUR_WGSL kernel-support bound, plus the
 * shadow offset length, which covers a canvas-space offset in every direction
 * even under rotation) — so backends and culling read one consistent number
 * instead of re-deriving it.
 *
 * `content` follows cropSubtree's contract exactly: a self-contained,
 * independently-flattened IR list that carries its OWN absolute world
 * (callers wrap it in pushTransform(world) — render_gpu/effects.js
 * applyEffects does this; see decorate.js's absolute-world contract).
 *
 * GROUP SUBTREE (the subtree-effects gap): the SAME op also wraps a GROUP's
 * WHOLE member subtree — `content` is then the members' already-absolute-world IR
 * (built by render_gpu/ports.sceneIR), so one drop shadow is cast by the group
 * silhouette, one blend composites the group against the backdrop, etc. Nothing
 * here changes for that case: content is opaque re-interpretable IR either way
 * (plugins/group.emit reuses this op verbatim through applyEffects).
 *
 * `shadowOnly: true` renders ONLY the shadow composite (no widget, no bloom,
 * no blend) — the PDF hybrid rule's vector-preserving split uses it to raster
 * just the shadow region under the widget's untouched VECTOR content (the
 * manifest's verbatim "compositing a shadow png under a vector thingy").
 *
 *   INNER SHADOW (innerShadow: {dx, dy, blur, color, opacity}) — the same
 *     {dx, dy, blur, color, opacity} shape as SHADOW, but composited INSIDE the
 *     widget's own silhouette (a recessed/inset look), so it darkens the
 *     interior near the edges instead of casting a silhouette beneath. Clipped
 *     to the shape ⇒ it adds NO outward halo (absent from `margin`).
 *
 *   SOFT EDGES (softEdges: canvas-unit amount) — FEATHERS the widget's own
 *     coverage: the offscreen render's ALPHA is eroded inward by `softEdges` and
 *     blurred, so the edges fade to transparent over that band (PowerPoint "Soft
 *     Edges"). Applied to the content BEFORE the shadow/inner-shadow/bloom
 *     composites (the Skia backend feathers `contentImg` first), so every one of
 *     them follows the softened silhouette. It only shrinks coverage INWARD ⇒ NO
 *     outward halo, so it too is absent from `margin`. 0 = off (no feather).
 *
 * The EFFECT-OFF pass-through lives in render_gpu/effects.js applyEffects
 * (returns `content` unchanged when nothing is on), so this builder always
 * has real work — mirroring decorateStrokedBox/isUndecorated.
 *
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 0.5}}).op // "effectSubtree"
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], shadow: {dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5}}).margin // 11 (3·2 blur spill + 5 offset length)
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], bloom: {radius: 5, strength: 1}}).margin // 15 (3·5 bloom spill)
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], blend: "multiply"}).margin // 0 (blend alone adds no halo)
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], blend: "multiply"}).shadow // null
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], innerShadow: {dx: 2, dy: 2, blur: 4, color: "#000", opacity: 0.6}}).margin // 0 (inner shadow is clipped inside → no halo)
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], innerShadow: {dx: 2, dy: 2, blur: 4, color: "#000000", opacity: 0.6}}).innerShadow.opacity // 0.6
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], softEdges: 6}).softEdges // 6 (soft edges alone is a valid effect)
 * @example effectSubtree({x: 0, y: 0, w: 10, h: 10, content: [], softEdges: 6}).margin // 0 (soft edges only erodes inward → no halo)
 */
export function effectSubtree({ x, y, w, h, content = [], shadow = null, bloom = null, blend = "normal", innerShadow = null, softEdges = 0, shadowOnly = false }) {
  requireFinite("effectSubtree", { x, y, w, h });
  requireFinite("effectSubtree.softEdges", { softEdges });
  if (!Array.isArray(content)) throw new Error(`effectSubtree: "content" must be an array, got ${JSON.stringify(content)}`);
  if (!BLEND_MODES.includes(blend)) throw new Error(`effectSubtree: unknown blend "${blend}" (known: ${BLEND_MODES.join(", ")})`);
  const soft = Math.max(0, softEdges);
  if (shadow === null && bloom === null && innerShadow === null && blend === "normal" && soft <= 0) throw new Error("effectSubtree: no effect is on (shadow/bloom/innerShadow null, blend normal, softEdges 0) — callers must pass content through instead (render_gpu/effects.js applyEffects)");
  let sh = null;
  if (shadow !== null) {
    const { dx, dy, blur, color, opacity } = shadow;
    requireFinite("effectSubtree.shadow", { dx, dy, blur, opacity });
    sh = { dx, dy, blur: Math.max(0, blur), color: parseColor(color), opacity };
  }
  let bl = null;
  if (bloom !== null) {
    const { radius, strength } = bloom;
    requireFinite("effectSubtree.bloom", { radius, strength });
    bl = { radius: Math.max(0, radius), strength: Math.max(0, strength) };
  }
  // INNER SHADOW: the SAME {dx, dy, blur, color, opacity} shape as the drop
  // shadow, but composited INSIDE the widget silhouette (a recess). It adds NO
  // outward halo (clipped to the shape), so it is DELIBERATELY absent from the
  // `margin` below — culling/source rects stay exactly as before.
  let inner = null;
  if (innerShadow !== null) {
    const { dx, dy, blur, color, opacity } = innerShadow;
    requireFinite("effectSubtree.innerShadow", { dx, dy, blur, opacity });
    inner = { dx, dy, blur: Math.max(0, blur), color: parseColor(color), opacity };
  }
  // Blur spill is BLUR_SUPPORT_SIGMAS·σ each side (the Gaussian kernel-support
  // bound); the shadow offset length covers the canvas-space (dx, dy) in every
  // local direction (rotation-safe: a rotation preserves lengths, so a halo of
  // hypot(dx, dy) contains the offset however the widget is turned). Inner shadow
  // and SOFT EDGES contribute nothing — inner shadow never reaches outside the
  // widget's bbox, and soft edges only ERODES coverage inward (fades edges to
  // transparent), so both leave the outward cull bound exactly as before.
  const margin = Math.max(
    sh ? sh.blur * BLUR_SUPPORT_SIGMAS + Math.hypot(sh.dx, sh.dy) : 0,
    bl ? bl.radius * BLUR_SUPPORT_SIGMAS : 0,
  );
  return { op: "effectSubtree", x, y, w, h, content, shadow: sh, bloom: bl, blend, innerShadow: inner, softEdges: soft, shadowOnly: !!shadowOnly, margin };
}

// ── flattening ───────────────────────────────────────────────────────────────

/**
 * Pure function. Resolves the transform stack: strips pushTransform/popTransform
 * and attaches to every remaining command a `world` similarity transform
 * ({x, y, rotation, scale} — core/transform.js shape) mapping its local
 * geometry to world space. Backends consume flattened commands only.
 *
 * Unbalanced pops throw; unclosed pushes throw (a widget that forgets a pop
 * would corrupt everything after it — fail loudly instead).
 *
 * Args:
 *   commands (object[]): raw IR command list
 *
 * Returns:
 *   object[]: commands (originals, not copies) wrapped as {cmd, world}
 *
 * @example flattenIR([rect({x: 0, y: 0, w: 1, h: 1, fill: "#fff"})])[0].world // {x: 0, y: 0, rotation: 0, scale: 1}
 * @example flattenIR([pushTransform({x: 10, scale: 2}), rect({x: 0, y: 0, w: 1, h: 1, fill: "#fff"}), popTransform()])[0].world // {x: 10, y: 0, rotation: 0, scale: 2}
 */
export function flattenIR(commands) {
  const stack = [T.identity()];
  const out = [];
  for (const cmd of commands) {
    if (cmd.op === "pushTransform") {
      // A scene with NO flip in it takes core/transform.js's plain compose, so its
      // flattened frames keep the exact {x, y, rotation, scale} shape (and the exact
      // float results) they always had; signedCompose is entered only once a
      // reflection is actually on the stack.
      const top = stack[stack.length - 1];
      stack.push(isReflected(top) || isReflected(cmd) ? signedCompose(top, cmd) : T.compose(top, cmd));
    } else if (cmd.op === "popTransform") {
      if (stack.length === 1) throw new Error("flattenIR: popTransform without matching push");
      stack.pop();
    } else {
      out.push({ cmd, world: stack[stack.length - 1] });
    }
  }
  if (stack.length !== 1) throw new Error(`flattenIR: ${stack.length - 1} unclosed pushTransform(s)`);
  return out;
}

/** Every op a backend must understand — backends throw on anything else. */
export const DRAW_OPS = ["rect", "ellipse", "polyline", "polygon", "path", "text", "image", "video", "videoV5", "videoFrame", "videoV5Frame", "latexVector", "blurBackdrop", "magnifyBackdrop", "glassBackdrop", "materialBackdrop", "materialFill", "cropSubtree", "effectSubtree"];
