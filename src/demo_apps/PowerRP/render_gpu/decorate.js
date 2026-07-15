/**
 * The RENDER half of the SHARED STROKED-BOX BUNDLE (manifest "SHARED STYLE
 * BUNDLES — stroke/rounding compose across widgets"). The property half lives
 * in core/properties.js (the `strokedBox`/`strokedBorder` bundles give box-like
 * widgets their fill/stroke/strokeWidth/cornerRadius ROWS + defaults); THIS
 * module gives them the matching RENDER decoration so the properties actually
 * paint — one shared function every box-like consumer (image, video, filmstrip,
 * and any future box widget) calls, so a new stroke feature added here reaches
 * every consumer at once (the manifest's "I'd like everything to inherit them
 * at once, including images and videos").
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────
 * Given a widget's OWN content ops (e.g. an image quad) plus a stroked-box
 * style (cornerRadius/stroke/strokeWidth/fill), it returns the content wrapped
 * in a rounded border + rounded-corner clip WHEN there is any decoration to
 * draw, and returns the content UNCHANGED when there is none. "None" =
 * strokeWidth <= 0 AND cornerRadius <= 0 AND no visible fill — in that case the
 * widget renders byte-identically to how it did before this bundle existed
 * (critical: undecorated image/video parity and the row-equivalence guarantee
 * both depend on the no-decoration path being a pure pass-through).
 *
 * ── HOW (reusing the crop-box machinery, per the manifest) ────────────────────
 * The decoration is emitted as ONE `cropSubtree` op (render_gpu/ir.js) whose
 * `content` is the widget's own ops:
 *   - rounded-corner CLIPPING of the content = cropSubtree's rounded-rect clip
 *     region (the same sdRoundBox clip a crop box uses — "reuse the crop-box
 *     rounded-clip machinery for content");
 *   - the border RING = cropSubtree's stroke, which is the SAME rounded-rect
 *     stroke ring a plain `rect` paints (CROP_WGSL's stroke term mirrors
 *     SHAPE_WGSL's — "the rect stroke ring for the border");
 *   - an optional background `fill` painted behind the content (a transparent
 *     region of the content shows the fill through — matching a plain box).
 * This needs NO new IR op and NO new backend code: both the WebGPU compositor
 * (gpu/compositor.js cropSubtree batch → CROP_WGSL) and the PDF backend
 * (pdf_backend.js emitCrop) already implement cropSubtree with a rounded clip +
 * stroke ring. A crop box is literally "a box that clips a foreign target"; a
 * decorated image is "a box that clips its OWN content" — the same op, a
 * different content source.
 *
 * ── THE ABSOLUTE-WORLD CONTRACT (why `world` is a parameter) ───────────────────
 * cropSubtree's `content` is an INDEPENDENTLY-flattened IR list (both backends
 * flattenIR() it fresh from identity — see ports.sceneIR's doc comment and the
 * compositor's `packList(flattenIR(cmd.content))`), so it must carry its OWN
 * ABSOLUTE world transform, exactly like a crop box's target content carries
 * pushTransform(node.cropTarget.world). A plugin's emit() is wrapped by sceneIR
 * in pushTransform(node.world), but that wrap does NOT reach into a cropSubtree
 * op's `content` (it is flattened separately) — so decorateStrokedBox takes the
 * node's `world` and wraps the content in pushTransform(world)/popTransform()
 * itself. sceneIR passes node.world to emit() as a 3rd argument precisely so a
 * media plugin can hand it here. (An UNDECORATED widget never builds a
 * cropSubtree, so it never needs `world` — sceneIR's outer wrap alone is
 * correct for the plain content path.)
 *
 * DOM-free pure JS (bare-node testable, like ir.js).
 */

import { cropSubtree, pushTransform, popTransform } from "./ir.js";

/**
 * Pure function. Converts EDGE-CROP INSETS (cropTop/cropLeft/cropRight/
 * cropBottom, in canvas units — manifest "Edge-crop insets") on a w×h media
 * quad into the shrunk destination rect PLUS the normalized source UV rect that
 * crops the texture to match. A source crop, NOT a stretch: the drawn quad
 * shrinks by the insets and the sampled texture region contracts by the SAME
 * fractions, so the surviving pixels keep their scale.
 *
 * Insets are clamped non-negative and to at most the full extent (opposite
 * insets summing past w/h collapse to a zero-size, zero-source rect — a
 * fully-cropped-away image draws nothing, matching the GPU's empty-UV case).
 * All-zero insets return the full quad + full frame {0,0,1,1} — the caller then
 * takes the byte-identical no-crop path.
 *
 * Args:
 *   w, h (number): the media quad's local size
 *   insets ({cropTop?, cropLeft?, cropRight?, cropBottom?}): per-edge trims
 *
 * Returns:
 *   {x, y, w, h, sx, sy, sw, sh}: the shrunk dest rect (local, top-left origin)
 *     + the normalized source UV rect
 *
 * @example cropInsetsToSource(100, 80, {}) // {x: 0, y: 0, w: 100, h: 80, sx: 0, sy: 0, sw: 1, sh: 1}
 * @example cropInsetsToSource(100, 80, {cropLeft: 10, cropTop: 8}) // {x: 10, y: 8, w: 90, h: 72, sx: 0.1, sy: 0.1, sw: 0.9, sh: 0.9}
 * @example cropInsetsToSource(100, 100, {cropLeft: 60, cropRight: 60}).w // 0 (over-cropped → empty)
 */
export function cropInsetsToSource(w, h, insets = {}) {
  const W = Math.max(0, w), H = Math.max(0, h);
  const left = Math.max(0, Math.min(insets.cropLeft ?? 0, W));
  const right = Math.max(0, Math.min(insets.cropRight ?? 0, W - left));
  const top = Math.max(0, Math.min(insets.cropTop ?? 0, H));
  const bottom = Math.max(0, Math.min(insets.cropBottom ?? 0, H - top));
  const dw = W - left - right, dh = H - top - bottom;
  return {
    x: left, y: top, w: dw, h: dh,
    sx: W > 0 ? left / W : 0,
    sy: H > 0 ? top / H : 0,
    sw: W > 0 ? dw / W : 0,
    sh: H > 0 ? dh / H : 0,
  };
}

/**
 * Pure function. True iff a set of edge-crop insets trims nothing (all absent
 * or zero) — the caller's fast-path test to skip source-crop math and keep the
 * byte-identical no-crop op.
 *
 * @example hasNoCrop({}) // true
 * @example hasNoCrop({cropTop: 0, cropLeft: 0}) // true
 * @example hasNoCrop({cropRight: 5}) // false
 */
export function hasNoCrop(insets = {}) {
  return (insets.cropTop ?? 0) <= 0 && (insets.cropLeft ?? 0) <= 0
    && (insets.cropRight ?? 0) <= 0 && (insets.cropBottom ?? 0) <= 0;
}

/**
 * Pure function. Is a stroked-box style visually a no-op (nothing to decorate)?
 * True iff there is no border (strokeWidth <= 0) AND no rounding (cornerRadius
 * <= 0) AND no visible fill. Fully-transparent fills ("#00000000", rgba alpha 0,
 * or an [r,g,b,0] array) count as no fill — they paint nothing, so they must not
 * force the (more expensive, offscreen) crop path. A widget with a visible fill
 * but square/borderless still needs the crop path to paint that fill behind its
 * content, so a visible fill alone is enough to decorate.
 *
 * Args:
 *   style ({cornerRadius?, stroke?, strokeWidth?, fill?}): the stroked-box style
 *
 * Returns:
 *   boolean
 *
 * @example isUndecorated({}) // true
 * @example isUndecorated({strokeWidth: 2, stroke: "#000"}) // false
 * @example isUndecorated({cornerRadius: 8}) // false
 * @example isUndecorated({fill: "#ff0000"}) // false (visible fill paints behind)
 * @example isUndecorated({fill: "#00000000"}) // true (transparent fill paints nothing)
 */
export function isUndecorated({ cornerRadius = 0, stroke = null, strokeWidth = 0, fill = null } = {}) {
  const hasBorder = (strokeWidth ?? 0) > 0 && stroke != null;
  const hasRounding = (cornerRadius ?? 0) > 0;
  const hasFill = fillIsVisible(fill);
  return !hasBorder && !hasRounding && !hasFill;
}

/**
 * Pure function. Does a fill value paint anything? null/undefined → no. A string
 * hex with a trailing "00" alpha byte ("#rrggbb00") or an rgba() with alpha 0 →
 * no. An [r,g,b,a] array with a===0 → no. Anything else → yes. This is a cheap
 * surface check (it does NOT fully parse the color — parseColor does that at IR
 * build time); it only needs to catch the common "invisible fill" spellings so
 * a transparent-filled widget stays on the fast no-decoration path.
 *
 * @example fillIsVisible(null) // false
 * @example fillIsVisible("#7aa2f7") // true
 * @example fillIsVisible("#00000000") // false
 * @example fillIsVisible([0.1, 0.2, 0.3, 0]) // false
 * @example fillIsVisible([0.1, 0.2, 0.3, 1]) // true
 */
export function fillIsVisible(fill) {
  if (fill == null) return false;
  if (Array.isArray(fill)) return (fill[3] ?? 1) > 0;
  if (typeof fill === "string") {
    const hex8 = fill.match(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/);
    if (hex8) return parseInt(hex8[1], 16) > 0;
    const rgba = fill.match(/^rgba?\([^)]*,\s*([\d.]+)\s*\)$/);
    if (rgba && /rgba/.test(fill)) return parseFloat(rgba[1]) > 0;
    return true; // #rgb/#rrggbb/rgb(...) — opaque
  }
  return true;
}

/**
 * Pure function. Wraps a box-like widget's own content ops in the shared
 * stroked-box render decoration (rounded-corner clip + border ring + optional
 * fill), reusing the crop-box cropSubtree machinery. Returns `content`
 * UNCHANGED (a pure pass-through) when the style has nothing to draw
 * (isUndecorated), so an undecorated widget is byte-identical to its pre-bundle
 * rendering.
 *
 * The clip region is the widget's LOCAL bbox (x/y default 0,0 — top-left origin,
 * matching every box plugin's emit() local space); `content` is re-anchored to
 * the ABSOLUTE `world` (see the module header's absolute-world contract). The
 * region itself stays in local space: sceneIR wraps the returned cropSubtree op
 * in pushTransform(world) just as it wraps any other node's emitted ops, so the
 * region maps to world through the outer wrap while the content carries its own
 * absolute world inside — exactly the two-transform arrangement a real crop box
 * uses (region at the box's world, content at the target's world; here both
 * worlds are the same node).
 *
 * OPACITY CONTRACT (backend-consistent by construction): the widget `opacity`
 * rides on the CONTENT ops (the caller builds its image/video op at s.opacity);
 * the cropSubtree wrapper is emitted at opacity 1. WHY this split and not the
 * reverse (opacity on the crop, content at 1): the GPU crop shader multiplies
 * its FINAL composite by the crop's opacity (so opacity-on-crop fades content +
 * fill + border together), but the PDF emitCrop applies the crop's opacity ONLY
 * to its own fill/stroke — its re-emitted `content` keeps the content ops' own
 * alpha. So opacity-on-crop would fade the whole unit on GPU yet leave the
 * content solid on PDF — a parity BREAK (measured: it sank the bordered image
 * parity scene). Opacity-on-CONTENT fades the content op identically in BOTH
 * backends (each op carries its own alpha, drawn once); the border/fill stay at
 * full strength in both. Net: the CONTENT fades, the FRAME does not — a
 * consistent, parity-safe semantic (fading the frame too would need a PDF
 * transparency GROUP around emitCrop's content, a shared-crop-machinery change
 * deferred and flagged). So the caller passes opacity on `content` AND leaves it
 * off `style` (or the crop wrapper forces opacity 1 regardless — it does below).
 *
 * Args:
 *   content (object[]): the widget's own IR ops in LOCAL space (e.g. an image
 *     quad at the widget's opacity, or a filmstrip's row of image ops)
 *   style ({x?, y?, w, h, cornerRadius?, stroke?, strokeWidth?, fill?}):
 *     the box geometry + stroked-box style. x/y default 0 (top-left origin).
 *     `opacity` is IGNORED for the wrapper (forced to 1 — see the contract); the
 *     content carries the widget opacity.
 *   world ({x, y, rotation, scale}): the node's ABSOLUTE world transform
 *     (core/transform.js shape) — required only on the decorated path; sceneIR
 *     supplies it as emit()'s 3rd argument.
 *
 * Returns:
 *   object[]: either `content` unchanged, or [cropSubtree(...)] wrapping it
 *
 * @example decorateStrokedBox([{op: "image"}], {w: 10, h: 10}, {x: 0, y: 0, rotation: 0, scale: 1}) // [{op: "image"}] (no decoration → pass-through)
 * @example decorateStrokedBox([{op: "image"}], {w: 10, h: 10, cornerRadius: 3}, {x: 0, y: 0, rotation: 0, scale: 1})[0].op // "cropSubtree"
 * @example decorateStrokedBox([{op: "image"}], {w: 10, h: 10, cornerRadius: 3}, {x: 0, y: 0, rotation: 0, scale: 1})[0].opacity // 1 (wrapper always opaque; content carries opacity)
 */
export function decorateStrokedBox(content, style, world) {
  if (isUndecorated(style)) return content;
  if (!world) throw new Error("decorateStrokedBox: a decorated box needs the node's absolute `world` (sceneIR passes it as emit's 3rd arg); got undefined");
  const { x = 0, y = 0, w, h, cornerRadius = 0, stroke = null, strokeWidth = 0, fill = null } = style;
  return [cropSubtree({
    x, y, w, h,
    cornerRadius,
    // Only pass a visible fill through (a transparent fill would still be a
    // valid parseColor input, but leaving it null keeps the op minimal and
    // matches "no fill behind the media" semantics for image/video).
    fill: fillIsVisible(fill) ? fill : null,
    stroke: (strokeWidth ?? 0) > 0 ? stroke : null,
    strokeWidth: strokeWidth ?? 0,
    // WRAPPER opacity forced to 1 (the OPACITY CONTRACT): the widget opacity
    // rides on `content` so it fades identically on GPU and PDF; opacity here
    // would fade the whole unit on GPU but not the PDF content (parity break).
    opacity: 1,
    content: [pushTransform(world), ...content, popTransform()],
  })];
}
