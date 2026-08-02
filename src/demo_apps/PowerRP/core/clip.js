/**
 * THE shared, OVERRIDABLE visible-region raster-sizing primitive (manifest
 * "RENDER PIVOT 2026-07-23 — UNIFIED PRINCIPLE / OVERRIDABLE").
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────────
 * A raster-producing widget (a placed PDF page, a supersampled image/video, a
 * magnifier lens) must NOT rasterize its whole virtual surface at the current
 * zoom — a page 50× zoomed would need a 50×-larger bitmap. Chrome's model (and
 * this codebase's magnifier-footprint precedent) is: rasterize only the part of
 * the surface that is ACTUALLY ON SCREEN, at the CURRENT display resolution.
 * That "on-screen part" is the SAME three-way intersection every such widget
 * needs — widget box ∩ viewport ∩ crop — so it lives here as ONE pure function
 * instead of being re-derived per widget (the user's "this three-way crop
 * should be standard practice among ALL widgets ... Unified").
 *
 * ── WHAT IT COMPUTES ──────────────────────────────────────────────────────────
 * visibleSourceRect(box, cropInsets, view, opts) intersects the widget's cropped
 * local box with the viewport (back-projected into the widget's LOCAL space),
 * then reports:
 *   - localRect  : the visible sub-rect in the widget's LOCAL coords (where the
 *                  raster is DRAWN, ⊆ the cropped box);
 *   - sourceRect : that sub-rect as a NORMALIZED [0,1] source UV rect, COMPOSED
 *                  with the edge-crop (reuses render_gpu/decorate.cropInsetsToSource
 *                  — the ONE crop→source mapping image/video/pdf already share),
 *                  so it maps straight onto a page/texture region;
 *   - deviceRect : the device-pixel size that sub-rect occupies on screen — THE
 *                  raster resolution to render at (device px per local unit =
 *                  view.zoom · view.dpr · world.scale);
 *   - scale      : that device-px-per-local-unit factor.
 *
 * ── THE BOUND (why this is the whole point) ───────────────────────────────────
 * For an axis-aligned (unrotated) widget, deviceRect is bounded by the viewport
 * in device px REGARDLESS OF ZOOM: it is a WINDOW into a huge virtual surface,
 * never the whole zoomed surface. Proof (world.scale = S, zoom = Z, dpr = D):
 * worldViewRect gives a world-visible width viewW/(D·Z); inverting the world
 * (÷S) gives local-visible width viewW/(D·Z·S); the visible sub-rect is ⊆ that;
 * its device width = (localVisible.w)·(Z·D·S) ≤ viewW. Same for height. (A
 * ROTATED widget over-covers by at most the rotated box's AABB — the diagonal —
 * which is the documented conservative bound; the raster caller clamps the
 * allocation.) clip_test.js verifies the unrotated bound at 1×, 10×, 50×.
 *
 * ── THE OVERRIDE (manifest "OVERRIDABLE") ─────────────────────────────────────
 * The DEFAULT is the exact viewport∩box∩crop window. A widget/plugin declares a
 * clip POLICY through `opts` to be LESS restrictive, MORE restrictive, or opt
 * out — one shared code path, each widget's deviation explicit:
 *   - opts.margin > 0 : inflate the visible window by `margin` WORLD units — the
 *     LESS-restrictive override. Directly analogous to the existing cull-margin
 *     precedent (core/view.effectsCullMargin): a widget whose effects (shadow/
 *     bloom) spill past its box rasterizes that spill too.
 *   - opts.margin < 0 : shrink — the MORE-restrictive override.
 *   - opts.full = true : IGNORE the viewport entirely and size to the whole
 *     cropped box — the OPT-OUT (a widget that always rasters its full region,
 *     e.g. today's image/video whose bitmap IS the source). deviceRect is then
 *     the full box at display scale (unbounded by the viewport — the caller owns
 *     the allocation cap); use only for widgets whose full region is cheap.
 *
 * DOM-free pure JS (bare-node testable, like view.js/decorate.js). Reuses
 * cropInsetsToSource (render_gpu/decorate.js) for the crop→source half and
 * worldViewRect (core/view.js) for the exact world-space viewport — no third
 * copy of either.
 */

import * as T from "./transform.js";
import { worldViewRect } from "./view.js";
import { cropInsetsToSource } from "../render_gpu/decorate.js";

/**
 * THE hard ceiling (device px) for any single raster surface / texture edge —
 * the guard EVERY CanvasKit surface-allocation site clamps to before calling
 * MakeSurface / MakeRenderTarget / MakeOnScreenGLSurface (render_gpu/skia/
 * browser_surface.js, web/gpuService.js) and the ceiling the PDF raster caps sit
 * under (render_gpu/gpu/pdf_page_raster.js PDF_MAX_RASTER_DIM ≤ this).
 *
 * WHY: a CanvasKit raster surface allocates edge·edge·4 bytes IN THE WASM HEAP.
 * An oversized (or non-finite) edge overruns the heap → the user-reported
 * `RuntimeError: memory access out of bounds` at MakeSurface, which then
 * CORRUPTS the whole CanvasKit instance (every later frame throws
 * `table index is out of bounds`). Clamping the edge BEFORE the allocation keeps
 * every request inside a safe envelope: 8192² · 4 = 256 MB, comfortably inside
 * the wasm heap. 8192 is the conservative WebGL2 MAX_TEXTURE_SIZE every target
 * browser guarantees; a site with a LIVE GL context should prefer the queried
 * gl.MAX_TEXTURE_SIZE (larger displays are legitimate) and fall back to this.
 */
export const MAX_SURFACE_DIM = 8192;

/**
 * Pure function. Sanitizes a requested surface size (w, h in device px) into a
 * SAFE allocation: each edge is coerced into [1, max]; a non-finite (NaN/±∞) or
 * < 1 edge floors to 1; an oversized edge clamps to `max`. Returns
 * {w, h, safe} where `safe` is false exactly when the request was invalid or
 * oversized (so the caller reports loudly and degrades) — the single choke point
 * ensuring no MakeSurface ever sees a heap-overrunning or NaN dimension.
 *
 * @example clampSurfaceSize(200, 100) // {w: 200, h: 100, safe: true}
 * @example clampSurfaceSize(50000, 100, 8192) // {w: 8192, h: 100, safe: false}
 * @example clampSurfaceSize(NaN, 100) // {w: 1, h: 100, safe: false}
 * @example clampSurfaceSize(0, 100) // {w: 1, h: 100, safe: false}
 */
export function clampSurfaceSize(w, h, max = MAX_SURFACE_DIM) {
  const edge = (v) => {
    if (!Number.isFinite(v) || v < 1) return { v: 1, ok: false };
    if (v > max) return { v: max, ok: false };
    return { v: Math.floor(v), ok: true };
  };
  const ew = edge(w), eh = edge(h);
  return { w: ew.v, h: eh.v, safe: ew.ok && eh.ok };
}

/**
 * Pure function. The largest factor ≤ 1 by which a requested raster size must be
 * multiplied so that NEITHER edge exceeds `maxEdge` — exactly 1 when it already
 * fits. Aspect is preserved by construction (one factor, both edges).
 *
 * THE ASK-VS-GOT LAW, and why this lives beside clampSurfaceSize rather than at
 * either call site. Clamping the ALLOCATION does not make an oversized raster
 * smaller, it makes it SHORTER: whoever draws into it is still working through a
 * transform built for the size that was ASKED for, so the surface receives the
 * top-left corner of the picture and the rest falls off the edge. Whoever sizes a
 * surface must derive the render scale from THE SAME number; this is that number,
 * and clampSurfaceSize then only ever acts as the NaN/negative backstop it
 * describes itself as. Two independent instances of the defect have shipped:
 *   · pdf.js drew a page through a viewport built at the uncapped scale into a
 *     canvas capped independently — the page came out truncated and then stretched
 *     across the widget's whole box (render_gpu/gpu/pdf_page_raster.js).
 *   · a backdrop material asked for deviceW·backdropScale px and built its
 *     sampleMatrix from `backdropScale` regardless of what it got — past the cap
 *     the texture does not exist and TileMode.Clamp smears one column across the
 *     rest (render_gpu/skia/paint_skia.js glassBackdropImages).
 * Both are silent, because a clamp is not an error.
 *
 * Args:
 *   wantW, wantH (number): the requested raster size, device px.
 *   maxEdge (number): the hard per-edge ceiling.
 *
 * Returns:
 *   number in (0, 1].
 *
 * @example rasterFitFactor(800, 600, 4096) // 1 (already fits)
 * @example rasterFitFactor(6330, 8192, 4096) // 0.5 (a 612x792pt page asked for at rasterDPI 1200)
 * @example rasterFitFactor(8192, 1000, 4096) // 0.5 (the WIDE edge decides)
 * @example rasterFitFactor(8400, 300, 8192) // 0.9752380952380952 (a 5600px-wide frame at backdropScale 1.5)
 */
export function rasterFitFactor(wantW, wantH, maxEdge) {
  const largest = Math.max(wantW, wantH);
  return largest > maxEdge ? maxEdge / largest : 1;
}

/**
 * Pure function. The axis-aligned intersection of two rects (x,y,w,h), or null
 * when they do not overlap (touching edges count as no interior overlap — a
 * zero-area intersection is "not visible").
 *
 * @example intersectRect({x: 0, y: 0, w: 10, h: 10}, {x: 5, y: 5, w: 10, h: 10}) // {x: 5, y: 5, w: 5, h: 5}
 * @example intersectRect({x: 0, y: 0, w: 10, h: 10}, {x: 20, y: 0, w: 5, h: 5}) // null
 * @example intersectRect({x: 0, y: 0, w: 10, h: 10}, {x: 10, y: 0, w: 5, h: 5}) // null (edge touch = no interior)
 */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Pure function. The axis-aligned bounding box of `rect`'s four corners mapped
 * through the transform `xf`. Exact when `xf` has no rotation; conservative (never
 * smaller than the true footprint) when it does — the same rotation-conservative
 * discipline as core/view.rotatedBBoxAABB.
 *
 * DIRECTION IS THE CALLER'S. Named for its first caller, which passes a world→local
 * INVERSE, but the fold is direction-agnostic: the PDF and SVG backends pass a
 * forward local→world frame to place an effect region on the page.
 *
 * `apply` EXISTS BECAUSE A BACKEND FRAME MAY BE REFLECTED. The default is the plain
 * similarity map; an IR pushTransform inside a backend that draws at the device root
 * can carry signX/signY, and only render_gpu/ir.js signedApply reads those. Passing
 * it in keeps this module free of any dependency on the IR while letting the ONE fold
 * serve both — before this parameter existed the signed variant was written out by
 * hand three more times (pdf_backend emitEffect + rasterOpPlaceRect, svg_backend
 * emitEffectSVG), two of them byte-identical.
 *
 * Args:
 *   rect ({x,y,w,h}): the rect whose corners are mapped
 *   xf (transform): the similarity to map through
 *   apply (fn): (xf, x, y) → {x, y}; defaults to core/transform.js apply
 *
 * @example aabbOfMappedRect({x: 0, y: 0, w: 10, h: 20}, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 0, y: 0, w: 10, h: 20}
 * @example aabbOfMappedRect({x: 0, y: 0, w: 10, h: 20}, {x: -5, y: 0, rotation: 0, scale: 0.5}) // {x: -5, y: 0, w: 5, h: 10}
 * @example // a quarter turn about the origin swaps the extents:
 * aabbOfMappedRect({x: 0, y: 0, w: 10, h: 20}, {x: 0, y: 0, rotation: Math.PI / 2, scale: 1}).w // 20
 */
export function aabbOfMappedRect(rect, xf, apply = T.apply) {
  const corners = [
    [rect.x, rect.y], [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h],
  ].map(([px, py]) => apply(xf, px, py));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Pure function. The on-screen visible sub-region of a raster widget's cropped
 * box, plus the device resolution to rasterize it at — THE shared, overridable
 * raster-sizing primitive (see the module header for the full contract + the
 * device-bound proof).
 *
 * Args:
 *   box ({world, w, h}): the widget's LOCAL size (w,h, local units) and its
 *     ABSOLUTE world transform (core/transform.js {x,y,rotation,scale}).
 *   cropInsets ({cropTop?, cropLeft?, cropRight?, cropBottom?}): edge-crop insets
 *     in LOCAL units (the same shape image/video/pdf pass to cropInsetsToSource).
 *   view ({zoom, panX, panY, dpr}): the camera mapping (device = (world·zoom +
 *     pan)·dpr).
 *   opts ({viewW, viewH, margin?, full?}): viewW/viewH = the device-px canvas
 *     size (REQUIRED, positive); margin = world-unit inflate/shrink of the
 *     visible window (the LESS/MORE-restrictive override, default 0); full =
 *     ignore the viewport and size to the whole cropped box (the OPT-OUT).
 *
 * Returns:
 *   {visible, localRect, sourceRect, deviceRect, scale}
 *     visible (boolean): false ⇒ widget fully off-screen or fully cropped away
 *       (the other fields are null/0).
 *     localRect ({x,y,w,h}|null): the visible sub-rect in the widget's LOCAL
 *       coords (⊆ the cropped box) — where the raster is drawn.
 *     sourceRect ({sx,sy,sw,sh}|null): localRect as a normalized [0,1] source UV
 *       rect, crop-composed.
 *     deviceRect ({w,h}|null): the device-pixel size of localRect on screen —
 *       the raster resolution.
 *     scale (number): device px per LOCAL unit (view.zoom·view.dpr·world.scale).
 *
 * @example visibleSourceRect({world: {x: 0, y: 0, rotation: 0, scale: 1}, w: 1000, h: 1000}, {}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {viewW: 200, viewH: 100}).deviceRect // {w: 200, h: 100}
 * @example visibleSourceRect({world: {x: 0, y: 0, rotation: 0, scale: 1}, w: 1000, h: 1000}, {}, {zoom: 50, panX: 0, panY: 0, dpr: 1}, {viewW: 200, viewH: 100}).deviceRect // {w: 200, h: 100} (bound holds at 50× — a window, not the whole zoomed page)
 * @example visibleSourceRect({world: {x: 0, y: 0, rotation: 0, scale: 1}, w: 1000, h: 1000}, {}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {viewW: 200, viewH: 100}).sourceRect // {sx: 0, sy: 0, sw: 0.2, sh: 0.1}
 * @example visibleSourceRect({world: {x: 0, y: 0, rotation: 0, scale: 1}, w: 10, h: 10}, {}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {viewW: 200, viewH: 200}).localRect // {x: 0, y: 0, w: 10, h: 10} (whole small widget visible)
 * @example visibleSourceRect({world: {x: 500, y: 0, rotation: 0, scale: 1}, w: 10, h: 10}, {}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {viewW: 200, viewH: 200}).visible // false (off-screen)
 */
export function visibleSourceRect(box, cropInsets, view, opts = {}) {
  const { viewW, viewH, margin = 0, full = false } = opts;
  if (!(viewW > 0) || !(viewH > 0)) throw new Error(`visibleSourceRect: opts.viewW/viewH (device px) must be positive; got ${viewW}×${viewH}`);
  const world = box.world;
  const c = cropInsetsToSource(box.w ?? 0, box.h ?? 0, cropInsets ?? {});
  const empty = { visible: false, localRect: null, sourceRect: null, deviceRect: null, scale: 0 };
  if (!(c.w > 0) || !(c.h > 0)) return empty; // fully cropped away → nothing to raster
  const croppedBox = { x: c.x, y: c.y, w: c.w, h: c.h };

  // The visible LOCAL rect: the whole cropped box when opting out (full), else
  // the cropped box ∩ the viewport back-projected into local space (margin-inflated).
  let vis;
  if (full) {
    vis = croppedBox;
  } else {
    const wv0 = worldViewRect(view, viewW, viewH); // exact world-space viewport AABB
    const wv = margin !== 0
      ? { x: wv0.x - margin, y: wv0.y - margin, w: wv0.w + 2 * margin, h: wv0.h + 2 * margin }
      : wv0;
    if (wv.w <= 0 || wv.h <= 0) return empty; // shrunk past nothing (margin < 0)
    const localView = aabbOfMappedRect(wv, T.invert(world));
    vis = intersectRect(localView, croppedBox);
    if (!vis) return empty; // widget fully off-screen
  }

  const sourceRect = {
    sx: c.sx + ((vis.x - c.x) / c.w) * c.sw,
    sy: c.sy + ((vis.y - c.y) / c.h) * c.sh,
    sw: (vis.w / c.w) * c.sw,
    sh: (vis.h / c.h) * c.sh,
  };
  const scale = view.zoom * view.dpr * (world.scale ?? 1); // device px per LOCAL unit
  const deviceRect = { w: vis.w * scale, h: vis.h * scale };
  return { visible: true, localRect: vis, sourceRect, deviceRect, scale };
}

/**
 * Pure function. THE SCREEN-SPACE STROKE DIVISOR — what a stored width is divided
 * by so it renders at a constant number of the CAMERA'S LOGICAL PIXELS.
 *
 * THREE ARGUMENTS, AND THE THIRD IS THE WHOLE SUBTLETY. The obvious divisor is
 * `worldScale · zoom`, read straight off paint_skia's chain (scale(zoom·dpr) →
 * translate(world) → scale(world.scale)), and IT IS WRONG FOR EVERY EXPORT.
 * core/view.js fitRectView returns `zoom = min(w/rect.w, h/rect.h)`, so a 4K render
 * of a 1080p camera has zoom 2 BECAUSE OF THE OUTPUT RESOLUTION, not because
 * anything was magnified. Cancelling that would render screen-space strokes at half
 * thickness in every export while looking perfect on canvas — a silent GPU↔PDF/mp4
 * parity break, which is the class THE RENDERER IS ONE CODE PATH exists to stop.
 *
 * So what is cancelled is MAGNIFICATION RELATIVE TO THE CAMERA'S OWN FIT:
 * `zoom / fitZoom`, where fitZoom is the zoom at which the camera exactly fills the
 * output. In an export the two are equal, the ratio is 1, and the stroke scales with
 * resolution exactly as the user's DPI ruling requires ("screen pixels is literally
 * just logical pixels; the camera defines pixels, and it changes when we do high DPI
 * vs low DPI"). In the editor the ratio IS the user's magnification, which is
 * precisely what must go.
 *
 * `worldScale` is cancelled unconditionally: a stroke inside a 2x-scaled group must
 * not thicken either, for the same reason a UI element does not.
 *
 * @param {number} worldScale - the node's world.scale
 * @param {number} zoom - the view's zoom
 * @param {number} fitZoom - the zoom at which the camera fills the output; pass
 *   `zoom` itself when unknown, which degrades to cancelling scale alone
 * @returns {number} the divisor; 1 when any input is unusable, so a caller lacking
 *   them degrades to ordinary world space rather than emitting a NaN width
 *
 * @example screenSpaceDivisor(1, 4, 1) // 4 (editor, zoomed 4x in)
 * @example screenSpaceDivisor(1, 2, 2) // 1 (a 2x EXPORT: resolution, not zoom — untouched)
 * @example screenSpaceDivisor(2, 3, 1) // 6 (a 2x group at 3x magnification)
 * @example screenSpaceDivisor(1, 1, 1) // 1
 * @example screenSpaceDivisor(1, 0.5, 1) // 0.5 (zoomed OUT: drawn thicker in world units)
 * @example screenSpaceDivisor(0, 2, 1) // 2 (a degenerate SCALE falls back to 1 for that term only — the zoom ratio still applies)
 * @example screenSpaceDivisor(1, NaN, 1) // 1 (an unusable zoom degrades to no magnification, never a NaN width)
 */
export function screenSpaceDivisor(worldScale, zoom, fitZoom) {
  const sc = Number.isFinite(worldScale) && worldScale > 0 ? worldScale : 1;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const f = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : z;
  const d = sc * (z / f);
  return d > 0 ? d : 1;
}
