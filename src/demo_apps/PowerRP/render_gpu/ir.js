/**
 * The draw-command IR — PowerRP's device-independent display list.
 *
 * THE SEAM of the two-render-mode architecture (manifest: RENDER MODES
 * DECISION): widgets emit these commands instead of painting a canvas2D ctx;
 * the WebGPU backend (gpu/compositor.js) rasterizes them, the vector backend
 * (svg_backend.js, future PDF) serializes them. The camera region is just the
 * `view` every backend maps world space through — no backend owns the camera.
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
 *   {op:"pushTransform", x, y, rotation, scale}                  // similarity, composes
 *   {op:"popTransform"}
 *   {op:"blurBackdrop", radius, opacity}                         // radius in WORLD units
 *   {op:"magnifyBackdrop", cx, cy, r, magnification, rimColor, rimWidth, opacity, supersample}
 *
 * Backdrop-effect nodes consume the composite-so-far (everything already
 * emitted), replacing the canvas2D full-canvas snapshot with a GPU texture
 * pass. Command order IS z-order: the scene compositor sorts nodes by z
 * before emitting, and backends never reorder across a backdrop boundary.
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
 * Pure function. Single-run text command, top-left origin (matches the canvas
 * plugin's textBaseline="top"). Layout (glyph advances) is backend work.
 * `font` is a font-registry id (render_gpu/fonts.js); it defaults to "system"
 * (the pre-fonts-task OS stack), so an omitted `font` is fully back-compatible.
 * This field is per-RUN by design — rich text will emit one text op per styled
 * run, each carrying its own font (manifest RICH TEXT), so nothing here needs
 * to change when runs land.
 *
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000"}).size // 36
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000"}).font // "system"
 * @example text({text: "Hi", x: 0, y: 0, size: 36, color: "#000", font: "inter"}).font // "inter"
 */
export function text({ text: str, x, y, size, color, bold = false, opacity = 1, font = DEFAULT_FONT }) {
  if (typeof str !== "string") throw new Error(`text: "text" must be a string, got ${JSON.stringify(str)}`);
  if (typeof font !== "string") throw new Error(`text: "font" must be a string id, got ${JSON.stringify(font)}`);
  requireFinite("text", { x, y, size, opacity });
  return { op: "text", text: str, x, y, size, color: parseColor(color), bold: !!bold, opacity, font };
}

/**
 * Pure function. Image quad by media-registry ref.
 *
 * @example image({ref: "logo", x: 0, y: 0, w: 64, h: 64}).ref // "logo"
 */
export function image({ ref, x, y, w, h, opacity = 1 }) {
  if (typeof ref !== "string") throw new Error(`image: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("image", { x, y, w, h, opacity });
  return { op: "image", ref, x, y, w, h, opacity };
}

/**
 * Pure function. Video quad by media-registry ref (raster backends import the
 * current frame each render — WebGPU via importExternalTexture).
 *
 * @example video({ref: "clip1", x: 0, y: 0, w: 320, h: 180}).op // "video"
 */
export function video({ ref, x, y, w, h, opacity = 1 }) {
  if (typeof ref !== "string") throw new Error(`video: "ref" must be a string, got ${JSON.stringify(ref)}`);
  requireFinite("video", { x, y, w, h, opacity });
  return { op: "video", ref, x, y, w, h, opacity };
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
 * Pure function. Magnifier effect node: composites a magnified circular view of
 * the scene below the lens, centered at local (cx, cy) with local radius r, plus
 * a rim ring. Two lens-fill paths, chosen by `supersample`:
 *   supersample:false — sample the composite-so-far backdrop texture with UVs
 *     contracted by 1/magnification (soft: the lens content is a rasterized
 *     backdrop upscaled, effectively 1/M of screen resolution).
 *   supersample:true (default) — the backend RE-RENDERS the sub-list emitted
 *     BELOW this op (command order is z-order, so everything before the lens is
 *     below it) under a lens view at magnification·zoom, then samples that sharp
 *     re-render. The re-render is depth-capped: a magnifier inside a re-render
 *     falls back to backdrop sampling (see the compositor's recursion guard).
 *
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).rimWidth // 0
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2}).supersample // true
 * @example magnifyBackdrop({cx: 0, cy: 0, r: 50, magnification: 2, supersample: false}).supersample // false
 */
export function magnifyBackdrop({ cx, cy, r, magnification, rimColor = null, rimWidth = 0, opacity = 1, supersample = true }) {
  requireFinite("magnifyBackdrop", { cx, cy, r, magnification, rimWidth, opacity });
  if (magnification <= 0) throw new Error(`magnifyBackdrop: magnification must be > 0, got ${magnification}`);
  return {
    op: "magnifyBackdrop", cx, cy, r, magnification,
    rimColor: rimColor === null ? null : parseColor(rimColor),
    rimWidth, opacity, supersample: !!supersample,
  };
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
export const DRAW_OPS = ["rect", "ellipse", "polyline", "polygon", "text", "image", "video", "blurBackdrop", "magnifyBackdrop"];
