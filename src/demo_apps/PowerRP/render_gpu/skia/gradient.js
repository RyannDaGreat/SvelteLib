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
import { isGradientPaint } from "../ir.js";

/**
 * Query→build (allocates a CanvasKit Shader — caller deletes). Builds the SkShader
 * for a parsed gradient Paint over a LOCAL bbox. `opacity` folds into every stop's
 * alpha (the item/group opacity, matching the solid fillPaint alpha fold).
 *
 * Args:
 *   CanvasKit: the CanvasKit module
 *   paint (object): a parsed gradient Paint (isGradientPaint(paint) === true)
 *   bounds ({x, y, w, h}): the shape's LOCAL bbox the objectBoundingBox maps onto
 *   opacity (number): 0..1, folded into stop alpha
 *
 * Returns:
 *   Shader
 */
export function skShaderForPaint(CanvasKit, paint, bounds, opacity = 1) {
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
    return CanvasKit.Shader.MakeLinearGradient(
      [paint.from.x, paint.from.y], [paint.to.x, paint.to.y],
      colors, positions, CanvasKit.TileMode.Clamp, lm,
    );
  }
  return CanvasKit.Shader.MakeRadialGradient(
    [paint.center.x, paint.center.y], paint.r,
    colors, positions, CanvasKit.TileMode.Clamp, lm,
  );
}
