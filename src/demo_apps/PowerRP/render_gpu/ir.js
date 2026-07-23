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
 *   {op:"pushTransform", x, y, rotation, scale}                  // similarity, composes
 *   {op:"popTransform"}
 *   {op:"blurBackdrop", radius, opacity}                         // radius in WORLD units
 *   {op:"magnifyBackdrop", shape, cx, cy, r, halfW, halfH, cornerRadius, originX, originY, magnification, rimColor, rimWidth, stroke, strokeWidth, opacity, supersample}  // shape "circle"|"box"
 *   {op:"cropSubtree", x, y, w, h, cornerRadius, fill, stroke, strokeWidth, opacity, content}
 *   {op:"effectSubtree", x, y, w, h, content, shadow, bloom, blend, shadowOnly, margin}  // Round 12D effects substrate
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
  const hex = color.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return [...h].map((c) => parseInt(c + c, 16) / 255).concat([1]);
    const bytes = h.match(/../g).map((b) => parseInt(b, 16) / 255);
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
export function rect({ x, y, w, h, cornerRadius = 0, fill = null, stroke = null, strokeWidth = 0, opacity = 1 }) {
  requireFinite("rect", { x, y, w, h, cornerRadius, strokeWidth, opacity });
  return {
    op: "rect", x, y, w, h,
    cornerRadius: Math.max(0, cornerRadius), // negative radii are meaningless (same domain clamp as the canvas plugin)
    fill: fill === null ? null : parseColor(fill),
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth, opacity,
  };
}

/**
 * Pure function. Ellipse fill+stroke command (center + radii).
 *
 * @example ellipse({cx: 5, cy: 5, rx: 5, ry: 3, fill: "#000"}).ry // 3
 */
export function ellipse({ cx, cy, rx, ry, fill = null, stroke = null, strokeWidth = 0, opacity = 1 }) {
  requireFinite("ellipse", { cx, cy, rx, ry, strokeWidth, opacity });
  return {
    op: "ellipse", cx, cy, rx, ry,
    fill: fill === null ? null : parseColor(fill),
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth, opacity,
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
  return { op: "polygon", points: points.map(([x, y]) => [x, y]), fill: parseColor(fill), opacity };
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
    op: "text", text: str, x, y, size, color: parseColor(color), bold: !!bold, opacity, font,
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
 */
export function latexVector({ ref, x, y, w, h, glyphs, viewBox, opacity = 1, sx = 0, sy = 0, sw = 1, sh = 1 }) {
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
    src: sourceRect(sx, sy, sw, sh),
    glyphs: outGlyphs,
    viewBox: { minX: viewBox.minX, minY: viewBox.minY, w: viewBox.w, h: viewBox.h },
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
 * Pure function. Pushes a similarity transform (translate/rotate/scale — the
 * core/transform.js model, NO skew) onto the stack; composes with the current.
 *
 * @example pushTransform({x: 5, y: 6}) // {op: "pushTransform", x: 5, y: 6, rotation: 0, scale: 1}
 */
export function pushTransform({ x = 0, y = 0, rotation = 0, scale = 1 }) {
  requireFinite("pushTransform", { x, y, rotation, scale });
  return { op: "pushTransform", x, y, rotation, scale };
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
 * lens, the SAME sdRoundBox region a crop box / a plain rect uses). The border
 * is the rim ring: a circle lens reads (rimColor, rimWidth) — kept byte-
 * identical to the pre-shape op; a box lens reads (stroke, strokeWidth) — the
 * shared stroked-box bundle (core/properties.js), migrated from the rim
 * (plugins/magnifier.js legacyKeys). Both render as the SAME centered stroke
 * band around the region edge.
 *
 * ORIGIN — (originX, originY) is the LOCAL-space point the lens magnifies
 * AROUND (the manifest "magnifier target": defaults to the lens center, so the
 * old center-magnifying behavior is byte-identical; retargetable to any anchor
 * via plugins/magnifier.js's origin.{x,y} equations). Distinct from (cx, cy),
 * which is where the lens region SITS on screen: the origin decouples "what the
 * lens magnifies" from "where the lens is drawn".
 *
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).rimWidth // 0
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).shape // "circle"
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).originX // 0 (defaults to the lens center cx)
 * @example magnifyBackdrop({cx: 10, cy: 20, r: 50, magnification: 2, originX: 5, originY: 8}).originY // 8
 * @example magnifyBackdrop({shape: "box", cx: 0, cy: 0, halfW: 80, halfH: 50, cornerRadius: 12, magnification: 2}).shape // "box"
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2, supersample: false}).supersample // false
 */
export function magnifyBackdrop({
  shape = "circle", cx, cy, r = 0, halfW = 0, halfH = 0, cornerRadius = 0,
  originX = cx, originY = cy, magnification,
  rimColor = null, rimWidth = 0, stroke = null, strokeWidth = 0,
  opacity = 1, supersample = true,
}) {
  if (shape !== "circle" && shape !== "box")
    throw new Error(`magnifyBackdrop: shape must be "circle" or "box", got ${JSON.stringify(shape)}`);
  const geom = shape === "box" ? { halfW, halfH, cornerRadius } : { r };
  requireFinite("magnifyBackdrop", { cx, cy, ...geom, originX, originY, magnification, rimWidth, strokeWidth, opacity });
  if (magnification <= 0) throw new Error(`magnifyBackdrop: magnification must be > 0, got ${magnification}`);
  return {
    op: "magnifyBackdrop", shape, cx, cy, r, halfW, halfH,
    cornerRadius: Math.max(0, cornerRadius), originX, originY, magnification,
    // Circle border = rim (rimColor/rimWidth, unchanged); box border = the
    // stroked-box bundle (stroke/strokeWidth). The plugin's rim→stroke
    // migration keeps these in sync; both backends render one stroke band.
    rimColor: rimColor === null ? null : parseColor(rimColor),
    rimWidth,
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth,
    opacity, supersample: !!supersample,
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
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, content: []}).op // "cropSubtree"
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, cornerRadius: 2, content: []}).cornerRadius // 2
 * @example cropSubtree({x: 0, y: 0, w: 10, h: 10, content: []}).fill // null
 */
export function cropSubtree({ x, y, w, h, cornerRadius = 0, fill = null, stroke = null, strokeWidth = 0, opacity = 1, content = [] }) {
  requireFinite("cropSubtree", { x, y, w, h, cornerRadius, strokeWidth, opacity });
  if (!Array.isArray(content)) throw new Error(`cropSubtree: "content" must be an array, got ${JSON.stringify(content)}`);
  return {
    op: "cropSubtree", x, y, w, h,
    cornerRadius: Math.max(0, cornerRadius),
    fill: fill === null ? null : parseColor(fill),
    stroke: stroke === null ? null : parseColor(stroke),
    strokeWidth, opacity, content,
  };
}

/** The widget-composite blend modes (manifest Round 12D "BLEND MODES"): how a
 * widget's own draw composites against the backdrop. All four are expressible
 * as FIXED-FUNCTION premultiplied blend states on the GPU (no backdrop texture
 * read needed — see gpu/compositor.js effect pipelines) and as PDF /BM blend
 * modes or the raster-below split in the vector backends. */
export const BLEND_MODES = ["normal", "multiply", "add", "screen"];

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
 *   BLEND (blend: "normal"|"multiply"|"add"|"screen") — the composite op of
 *     the widget's own draw against the backdrop (BLEND_MODES).
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
 * `shadowOnly: true` renders ONLY the shadow composite (no widget, no bloom,
 * no blend) — the PDF hybrid rule's vector-preserving split uses it to raster
 * just the shadow region under the widget's untouched VECTOR content (the
 * manifest's verbatim "compositing a shadow png under a vector thingy").
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
 */
export function effectSubtree({ x, y, w, h, content = [], shadow = null, bloom = null, blend = "normal", shadowOnly = false }) {
  requireFinite("effectSubtree", { x, y, w, h });
  if (!Array.isArray(content)) throw new Error(`effectSubtree: "content" must be an array, got ${JSON.stringify(content)}`);
  if (!BLEND_MODES.includes(blend)) throw new Error(`effectSubtree: unknown blend "${blend}" (known: ${BLEND_MODES.join(", ")})`);
  if (shadow === null && bloom === null && blend === "normal") throw new Error("effectSubtree: no effect is on (shadow/bloom null, blend normal) — callers must pass content through instead (render_gpu/effects.js applyEffects)");
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
  // Blur spill is 3σ each side (the BLUR_WGSL kernel-support bound — sigma·3,
  // see MAX_HALF_KERNEL's derivation); the shadow offset length covers the
  // canvas-space (dx, dy) in every local direction (rotation-safe: a rotation
  // preserves lengths, so a halo of hypot(dx, dy) contains the offset however
  // the widget is turned).
  const BLUR_SUPPORT_SIGMAS = 3;
  const margin = Math.max(
    sh ? sh.blur * BLUR_SUPPORT_SIGMAS + Math.hypot(sh.dx, sh.dy) : 0,
    bl ? bl.radius * BLUR_SUPPORT_SIGMAS : 0,
  );
  return { op: "effectSubtree", x, y, w, h, content, shadow: sh, bloom: bl, blend, shadowOnly: !!shadowOnly, margin };
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
      stack.push(T.compose(stack[stack.length - 1], cmd));
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
export const DRAW_OPS = ["rect", "ellipse", "polyline", "polygon", "text", "image", "video", "latexVector", "blurBackdrop", "magnifyBackdrop", "cropSubtree", "effectSubtree"];
