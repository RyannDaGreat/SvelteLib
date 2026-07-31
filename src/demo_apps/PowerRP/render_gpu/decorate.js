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
 * This needs NO new IR op and NO new backend code: both the runtime painter
 * (render_gpu/skia/paint_skia.js's cropSubtree case) and the PDF backend
 * (pdf_backend.js emitCrop) already implement cropSubtree with a rounded clip +
 * stroke ring.
 *   SUPERSEDED — HISTORICAL: this sentence used to name "the WebGPU compositor
 *   (gpu/compositor.js cropSubtree batch → CROP_WGSL)". That file and those
 *   shader constants went with the retired prototype backend; see
 *   render_gpu/FINDINGS.md. The two bullets above name CROP_WGSL and SHAPE_WGSL
 *   for the same reason and are dead names too — read them as "the rounded-rect
 *   clip" and "the rect stroke ring", which is what they described.
 * A crop box is literally "a box that clips a foreign target"; a
 * decorated image is "a box that clips its OWN content" — the same op, a
 * different content source.
 *
 * ── THE ABSOLUTE-WORLD CONTRACT (why `world` is a parameter) ───────────────────
 * cropSubtree's `content` is an INDEPENDENTLY-flattened IR list (both backends
 * flattenIR() it fresh from identity — see ports.sceneIR's doc comment and
 * paint_skia.js's cropSubtree case), so it must carry its OWN
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
 * True iff there is no border (strokeWidth <= 0, OR a strokeWidth with no live
 * paint to draw it in) AND no rounding (cornerRadius <= 0) AND no visible fill.
 * Fully-transparent fills ("#00000000", rgba alpha 0, or an [r,g,b,0] array)
 * count as no fill — they paint nothing, so they must not force the (more
 * expensive, offscreen) crop path. A widget with a visible fill but
 * square/borderless still needs the crop path to paint that fill behind its
 * content, so a visible fill alone is enough to decorate.
 *
 * A `stroke` of `null`/`undefined` is "no paint chosen" and a NON-null OFF tag
 * ({type:"none"} — render_gpu/ir.js isPaintOff) is "a paint chosen, then turned
 * off" — both mean the same thing here: nothing draws. The bug this guards (user
 * ruling: "when stroke material is off, you should have nothing — even if
 * stroke width is non-zero") was `stroke != null` alone, which is true for the
 * OFF tag (it IS a non-null object), so a nonzero width kept drawing a border
 * ring after the user turned the material off. strokeIsVisible below is the
 * fillIsVisible of this slot, checked the same way.
 *
 * Args:
 *   style ({cornerRadius?, stroke?, strokeWidth?, fill?}): the stroked-box style
 *
 * Returns:
 *   boolean
 *
 * @example isUndecorated({}) // true
 * @example isUndecorated({strokeWidth: 2, stroke: "#000"}) // false
 * @example isUndecorated({strokeWidth: 5, stroke: {type: "none"}}) // true (OFF material, any width)
 * @example isUndecorated({cornerRadius: 8}) // false
 * @example isUndecorated({fill: "#ff0000"}) // false (visible fill paints behind)
 * @example isUndecorated({fill: "#00000000"}) // true (transparent fill paints nothing)
 */
export function isUndecorated({ cornerRadius = 0, stroke = null, strokeWidth = 0, fill = null } = {}) {
  const hasBorder = (strokeWidth ?? 0) > 0 && strokeIsVisible(stroke);
  const hasRounding = (cornerRadius ?? 0) > 0;
  const hasFill = fillIsVisible(fill);
  return !hasBorder && !hasRounding && !hasFill;
}

/**
 * Pure function. Does a stroke paint value paint anything? Same rule as
 * fillIsVisible with one addition: the tagged OFF paint ({type:"none"}, the
 * PaintField "Off" tab every paint:true row can be set to — render_gpu/ir.js
 * PAINT_NONE_TYPE/isPaintOff) is not visible. null/undefined (no paint chosen)
 * is also not visible — decorateStrokedBox's callers pass `null` for an
 * unauthored stroke, and that must keep meaning "nothing", exactly as before
 * this OFF check existed.
 *
 * @example strokeIsVisible(null) // false
 * @example strokeIsVisible("#000000") // true
 * @example strokeIsVisible({ type: "none" }) // false (the OFF tag)
 * @example strokeIsVisible({ type: "linearGradient", stops: [] }) // true
 */
export function strokeIsVisible(stroke) {
  if (stroke == null) return false;
  if (typeof stroke === "object" && !Array.isArray(stroke) && stroke.type === "none") return false;
  return fillIsVisible(stroke);
}

/**
 * Pure function. Does a fill value paint anything? null/undefined → no. A string
 * hex with a trailing "00" alpha byte ("#rrggbb00") or an rgba() with alpha 0 →
 * no. An [r,g,b,a] array with a===0 → no. Anything else → yes. This is a cheap
 * surface check (it does NOT fully parse the color — parseColor does that at IR
 * build time); it only needs to catch the common "invisible fill" spellings so
 * a transparent-filled widget stays on the fast no-decoration path.
 *
 * A GRADIENT Paint (a tagged {type,...} object — Axis-1) always paints something,
 * so it counts as a visible fill (a fully-transparent-stop gradient is a
 * degenerate case not worth a deep scan here).
 *
 * @example fillIsVisible(null) // false
 * @example fillIsVisible("#7aa2f7") // true
 * @example fillIsVisible("#00000000") // false
 * @example fillIsVisible([0.1, 0.2, 0.3, 0]) // false
 * @example fillIsVisible([0.1, 0.2, 0.3, 1]) // true
 * @example fillIsVisible({type: "linearGradient", stops: [], from: {x: 0, y: 0}, to: {x: 1, y: 0}}) // true (a gradient paints)
 */
export function fillIsVisible(fill) {
  if (fill == null) return false;
  if (Array.isArray(fill)) return (fill[3] ?? 1) > 0;
  if (typeof fill === "object") return true; // a gradient (or other tagged Paint) paints
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
    // strokeIsVisible (not a bare `!= null`) is what makes an OFF-tagged stroke
    // ({type:"none"}) null out here too: a rounded/filled box with strokeWidth
    // > 0 but its material switched OFF still takes the cropSubtree path (for
    // the rounding/fill), and must not forward the raw OFF tag as `cmd.stroke`
    // — the painters expect a real paint or null, never the tag object itself.
    stroke: (strokeWidth ?? 0) > 0 && strokeIsVisible(stroke) ? stroke : null,
    strokeWidth: strokeWidth ?? 0,
    // WRAPPER opacity forced to 1 (the OPACITY CONTRACT): the widget opacity
    // rides on `content` so it fades identically on GPU and PDF; opacity here
    // would fade the whole unit on GPU but not the PDF content (parity break).
    opacity: 1,
    content: [pushTransform(world), ...content, popTransform()],
  })];
}

/**
 * Pure function. The SVG/iconify SIBLING of decorateStrokedBox: SAME rounded-
 * corner clip + fill + border-ring machinery (identical cropSubtree op, identical
 * pass-through-when-undecorated contract), but the border traces the widget's own
 * GLYPH SILHOUETTE — the union of its content ops' filled outlines — instead of
 * the plain rect ring every OTHER decorateStrokedBox consumer draws. This is the
 * ONLY difference: the returned op is `{...cropSubtree(...), silhouette: true}`,
 * a plain sibling tag a painter/exporter reads to pick the silhouette-tracing
 * border path instead of the rect at PAINT time (paint_skia.js handleCropSubtree)
 * or EXPORT-STAMP time (a resolveSilhouetteBorders pre-pass — this module stays
 * DOM-free/CanvasKit-free, so it cannot compute the union itself).
 *
 * Called ONLY from plugins/svg.js and plugins/iconify.js — every other
 * decorateStrokedBox consumer (image, video, filmstrip, latex, mermaid, pdf_page,
 * video_scrub, video_time_scrub, video_v2, video_v5_scrub) is UNTOUCHED, since
 * their own content ops are already rectangular and a rect border is already
 * correct for them (byte-identical by construction: decorateStrokedBox's body is
 * not edited by this function's existence).
 *
 * @param {object[]} content - the widget's own content ops (LOCAL space) — an
 *   SVG/iconify flatten's shape ops (rect/ellipse/polygon/path), possibly mixed
 *   with non-shape ops (the error/warning affordance's `text`) that the
 *   silhouette builder skips
 * @param {object} style - see decorateStrokedBox
 * @param {object} world - see decorateStrokedBox
 *
 * @returns {object[]} either `content` unchanged, or [{...cropSubtree, silhouette: true}]
 *
 * `silhouetteContent` carries the RAW, pre-wrap local-space content ops onto the
 * returned op (as `cmd.silhouetteContent`) alongside the usual absolute-world-
 * wrapped `cmd.content` cropSubtree already carries for re-rendering. The
 * silhouette builder (render_gpu/skia/silhouette.js, called from paint_skia.js
 * and the export pre-pass) needs the ops in their OWN local space to union their
 * geometry directly — unwrapping `cmd.content`'s push/popTransform pair at paint
 * time would work too (the wrapped world equals the box's own world here, since
 * decorateStrokedBox always calls cropSubtree with the SAME `world` for both),
 * but carrying the plain array is simpler than teaching every consumer to strip
 * a known transform pair back off.
 *
 * @example decorateSilhouetteBorder([{op: "path", d: "M0 0h10v10h-10z"}], {w: 10, h: 10}, {x: 0, y: 0, rotation: 0, scale: 1}) // [{op: "path", d: "M0 0h10v10h-10z"}] (no decoration -> pass-through, same as decorateStrokedBox)
 * @example decorateSilhouetteBorder([{op: "path", d: "M0 0h10v10h-10z"}], {w: 10, h: 10, strokeWidth: 2, stroke: "#000"}, {x: 0, y: 0, rotation: 0, scale: 1})[0].silhouette // true
 */
export function decorateSilhouetteBorder(content, style, world) {
  const decorated = decorateStrokedBox(content, style, world);
  if (decorated === content) return content; // isUndecorated pass-through, unchanged
  return [{ ...decorated[0], silhouette: true, silhouetteContent: content }];
}
