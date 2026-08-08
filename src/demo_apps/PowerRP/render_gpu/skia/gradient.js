/**
 * Skia gradient shaders for the Axis-1 PAINT seam. Turns a parsed gradient Paint
 * (render_gpu/ir.js parsePaint — {type:"linearGradient"|"radialGradient", stops,
 * from/to | center/r}) into a CanvasKit SkShader a Paint can setShader().
 *
 * COORDINATE CONTRACT: a gradient's from/to/center are in objectBoundingBox space
 * (0..1 over the shape's LOCAL bbox — the SVG default). We build the shader in
 * that unit space and hand CanvasKit a localMatrix = translate(bbox origin) ·
 * scale(bbox size), so the unit gradient maps onto the shape's bbox and a radial
 * gradient stretches into the bbox ellipse exactly like SVG gradientUnits=
 * "objectBoundingBox". The SAME 0..1 numbers therefore render identically through
 * the Skia shader here and the native SVG <linearGradient>/<radialGradient> defs.
 *
 * DOM-free; imported by paint_skia.js (shapes) and text_layout.js (gradient text).
 */

export { isGradientPaint } from "../ir.js";
import { isGradientPaint, linearGradientRender, collapsedGradientColor, paintDepth } from "../ir.js";
import { depthShader } from "./dither_shader.js";

/**
 * Pure function. A spread mode ("mirror" | "loop" | "pad") → the CanvasKit TileMode
 * that expresses it. This is the whole cost of the spread feature on the raster
 * side: the three modes ARE Skia's three native tile modes, so nothing is emulated.
 *
 * Args:
 *   CanvasKit: the CanvasKit module (TileMode is an enum on it)
 *   tile (string): the mode linearGradientRender resolved
 *
 * Returns:
 *   TileMode
 *
 * @example // skTileMode(CanvasKit, "mirror") === CanvasKit.TileMode.Mirror
 * @example // skTileMode(CanvasKit, "loop")   === CanvasKit.TileMode.Repeat
 * @example // skTileMode(CanvasKit, "pad")    === CanvasKit.TileMode.Clamp
 */
export function skTileMode(CanvasKit, tile) {
  if (tile === "mirror") return CanvasKit.TileMode.Mirror;
  if (tile === "loop") return CanvasKit.TileMode.Repeat;
  if (tile === "pad") return CanvasKit.TileMode.Clamp;
  throw new Error(`skTileMode: unknown gradient spread ${JSON.stringify(tile)} (expected mirror, loop or pad)`);
}

/**
 * Query→build (allocates a CanvasKit Shader — caller deletes). Builds the SkShader
 * for a parsed gradient Paint over a LOCAL bbox. `opacity` folds into every stop's
 * alpha (the item/group opacity, matching the solid fillPaint alpha fold).
 *
 * THE DITHER WRAPS EVERY RETURN PATH (core/properties.js PAINT_DITHER_*), which is
 * why it is applied at this one exit rather than inside the three branches: a
 * linear ramp, a radial ramp AND a collapsed wavelength-0 solid all band, and a
 * collapsed ramp is still an authored gradient whose author asked for dither.
 * `ditheredShader` returns the shader UNCHANGED when the paint carries no dither
 * (the overwhelming majority), so an undithered gradient allocates nothing extra
 * and renders byte-identically to before the feature.
 *
 * `ctm` is `canvas.getTotalMatrix()` — the local→device mapping in force for this
 * draw, which the dither needs because its threshold must land on the DEVICE pixel
 * grid rather than on the shape's local one (see dither_shader.js's header). It is
 * ignored entirely when the paint is not dithered, which is why every existing
 * caller may keep passing nothing.
 *
 * Args:
 *   CanvasKit: the CanvasKit module
 *   paint (object): a parsed gradient Paint (isGradientPaint(paint) === true)
 *   bounds ({x, y, w, h}): the shape's LOCAL bbox the objectBoundingBox maps onto
 *   opacity (number): 0..1, folded into stop alpha
 *   ctm (number[]|null): canvas.getTotalMatrix(), or null for identity
 *
 * Returns:
 *   Shader
 */
export function skShaderForPaint(CanvasKit, paint, bounds, opacity = 1, ctm = null) {
  return depthShader(CanvasKit, unditheredShaderForPaint(CanvasKit, paint, bounds, opacity), paintDepth(paint), ctm);
}

/**
 * Query→build (allocates a Shader — consumed by skShaderForPaint's wrapper, which
 * owns it from the moment it is returned). The gradient shader ITSELF, with no
 * dither: split out so the dither wrap is one unconditional line at a single exit
 * instead of three returns each remembering to wrap.
 */
function unditheredShaderForPaint(CanvasKit, paint, bounds, opacity = 1) {
  if (!isGradientPaint(paint)) throw new Error("skShaderForPaint: expected a gradient Paint (solid paints use setColor, not a shader)");
  const colors = paint.stops.map((s) => CanvasKit.Color4f(s.color[0], s.color[1], s.color[2], s.color[3] * opacity));
  const positions = paint.stops.map((s) => s.offset);
  // Unit-space (objectBoundingBox) → local: translate to the bbox origin, scale by
  // its size. A zero-size axis collapses to a hair-width so the matrix stays
  // invertible (an empty shape draws nothing anyway).
  const lm = CanvasKit.Matrix.multiply(
    CanvasKit.Matrix.translated(bounds.x, bounds.y),
    CanvasKit.Matrix.scaled(bounds.w || 1e-6, bounds.h || 1e-6),
  );
  if (paint.type === "linearGradient") {
    // CENTER + WAVELENGTH + PHASE + SPREAD fold in here (ir.js linearGradientRender):
    // the ramp is centered at `center` (shifted by `phase` of THIS SPREAD MODE's
    // period) and spans wavelength·axis, tiling outside itself per `tile`. A
    // default/legacy paint returns the untouched axis with tile "pad", so its Clamp
    // shader is byte-identical to before the feature.
    const { from, to, tile, collapsed } = linearGradientRender(paint);
    // WAVELENGTH 0: the ramp has no extent and its limit is a SOLID of the ramp's
    // average colour. A zero-length axis would make Skia paint the last stop (or
    // divide by zero); one flat colour shader is the true picture, and the same one
    // the SVG and PDF backends emit.
    if (collapsed) return solidAverageShader(CanvasKit, paint, opacity);
    return CanvasKit.Shader.MakeLinearGradient(
      [from.x, from.y], [to.x, to.y],
      colors, positions, skTileMode(CanvasKit, tile), lm,
    );
  }
  return CanvasKit.Shader.MakeRadialGradient(
    [paint.center.x, paint.center.y], paint.r,
    colors, positions, CanvasKit.TileMode.Clamp, lm,
  );
}

/**
 * Query→build (allocates a Shader — caller deletes). THE COLLAPSED-RAMP SHADER: one
 * flat colour, the ramp's average (ir.js collapsedGradientColor). Built as a shader
 * rather than returned as a colour so the wavelength-0 case slots into the existing
 * `setShader` call site unchanged — every caller keeps one code path, and a scrub
 * through wavelength 0 never changes which branch of the painter runs.
 */
function solidAverageShader(CanvasKit, paint, opacity) {
  const [r, g, b, a] = collapsedGradientColor(paint);
  return CanvasKit.Shader.MakeColor(CanvasKit.Color4f(r, g, b, a * opacity), CanvasKit.ColorSpace.SRGB);
}
