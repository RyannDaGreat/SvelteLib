/**
 * THE render-time PDF display re-raster pre-pass (manifest RENDER PIVOT
 * 2026-07-23). emit() is PURE of the camera; the resolution decision lives HERE,
 * at render time, in the ONE layer that knows the live view.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────
 * Given the derived render tree + the live view, it finds every visible
 * `pdf_page` node and builds its DISPLAY DESCRIPTOR — a Map<itemId, {ref, x, y,
 * w, h}> that each pdf_page node's emit() consumes (threaded through
 * render_gpu/ports.sceneIR as emit's 4th arg) to draw the region bitmap at its
 * local placement. HOW the descriptor's bitmap is produced depends on the
 * widget's `renderMode` (below).
 *
 * ── RENDER MODES (the pdf_page widget's `renderMode` property) ────────────────
 * A placed PDF page picks HOW its interactive DISPLAY is produced. Both modes
 * keep the crash guards intact (device-scale cap + generation-gate + clampDim,
 * all in pdf_page_raster.ensurePdfPageRegionRasterized) — they only change WHICH
 * region/resolution the display draws.
 *
 *   "live" (DEFAULT) — the Chrome model. Every frame re-rasterizes ONLY the
 *     page's on-screen VISIBLE REGION at the CURRENT zoom (via the shared pure
 *     primitive core/clip.visibleSourceRect → widget box ∩ viewport ∩ crop), so
 *     text/vectors stay CRISP at ANY magnification while the cost stays bounded
 *     by the SCREEN, not the zoom. A fast zoom re-kicks a fresh region per frame;
 *     the generation gate discards the stale ones. This is the good single-path
 *     GPU display (tasks #20/#37) that predated the reverted 3-mode experiment.
 *   "raster" — render ONCE, cache, never re-render. The page's (crop-trimmed)
 *     area is rasterized a single time at a FIXED resolution derived from the
 *     widget's rasterWidth/rasterHeight/rasterDPI props (NOT the live view), so
 *     the region ref is STABLE across zoom/pan and the compositor merely SCALES
 *     the one cached bitmap. Very fast/cheap; it SOFTENS when zoomed past its DPI
 *     — the documented speed trade-off. No per-frame re-raster, no zoom re-raster.
 *
 * renderMode governs the INTERACTIVE display only. Camera-free consumers
 * (export/thumbnail/CLI) never run this pre-pass, so they are byte-identical
 * across both modes (vector-if-safe else whole-page raster) — see
 * plugins/pdf_page.js emit()'s fallback path.
 *
 * ── WHY A PRE-PASS (not inside emit) ──────────────────────────────────────────
 * A plugin's emit(state, …) is deliberately camera-free (sceneIR passes only
 * state + the node's own local world, never the outer zoom/pan/dpr) so the SAME
 * emit output feeds the editor, the presenter, thumbnails, the CLI, and the
 * SVG/PDF exporters. The zoom-dependent resolution decision therefore CANNOT
 * live in emit. The display surfaces that DO know the view (CanvasView,
 * PresentMode) run this pre-pass BEFORE sceneIR and hand emit the resulting
 * descriptor per node. Surfaces with no pre-pass (export, thumbnails, CLI) pass
 * no descriptor, so emit falls back to its vector (export) / whole-page raster
 * path — see plugins/pdf_page.js emit().
 *
 * ── THE OVERRIDE (manifest "OVERRIDABLE") ─────────────────────────────────────
 * A plugin may declare `clipPolicy(state) → {margin?, full?}` to make its raster
 * region LESS restrictive (margin > 0: rasterize effect/shadow spill past the
 * box — the cull-margin precedent), MORE restrictive (margin < 0), or opt out
 * of view-bounding entirely (full: true — raster the whole cropped region). The
 * DEFAULT (no hook) is the exact viewport∩box∩crop window. This is the single
 * seam where a widget's clip policy is applied; the primitive itself is neutral.
 * (Applies to "live" mode; "raster" mode always rasters the whole cropped page.)
 *
 * ── ASYNC ─────────────────────────────────────────────────────────────────────
 * A page whose native point size is not measured yet (doc still opening) is
 * SKIPPED this pass (no descriptor) — emit's whole-page fallback draws meanwhile
 * and also kicks the measurement; the region lands on a later repaint (the
 * region raster registers into the shared image registry, so onImageLoad already
 * wakes the reactive canvas — no new repaint wiring). Nothing here awaits.
 *
 * Browser/CLI-facing (drives pdf_page_raster, which needs a canvas + pdf.js), NOT
 * part of the DOM-free core/.
 */

import { visibleSourceRect } from "../core/clip.js";
import { rotatedBBoxAABB, rectsIntersect } from "../core/view.js";
import { cropInsetsToSource } from "./decorate.js";
import {
  ensurePdfDoc, pdfPageCount, pdfPagePointSize, ensurePdfPagePointSize,
  ensurePdfPageRegionRasterized, clampPage, PDF_MAX_RASTER_DIM,
} from "./gpu/pdf_page_raster.js";

// ── RENDER MODES (the pdf_page widget's `renderMode` property) ────────────────
// See the module header for the full rationale. "live" is the default single GPU
// screen-resolution re-raster path (crisp at any zoom); "raster" renders once at
// a fixed DPI/size and caches (fast, softens past its DPI).
export const PDF_RENDER_MODES = ["live", "raster"];
export const PDF_RENDER_MODE_DEFAULT = "live";

/** PDF's canonical unit: 72 points per inch (1 pt = 1/72"). The base density at
 * which a page's point size equals its pixel size (its "native pixel size"). */
export const PDF_POINTS_PER_INCH = 72;

/** Default "raster" mode render density (dots per inch). 96 is the CSS reference
 * pixel density (1 CSS px = 1/96"), so a page rasters at ~screen resolution by
 * default — crisp at 100% on a typical display, and the softening trade-off only
 * shows past that. Named/overridable via the widget's rasterDPI prop. */
export const PDF_RASTER_DEFAULT_DPI = 96;

/**
 * Pure function. The "raster" mode whole-page render scale (device px per PDF
 * point): the LARGEST uniform scale that fits the page into a rasterWidth ×
 * rasterHeight PIXEL box at rasterDPI, preserving the page's native aspect. A
 * non-positive rasterWidth/rasterHeight means "native" for that axis (the page's
 * own point size, imposing no extra constraint); a non-positive rasterDPI falls
 * back to PDF_RASTER_DEFAULT_DPI. rasterDPI multiplies the whole box (the density
 * knob). Aspect is always preserved — a single uniform scale never distorts the
 * page; the widget's box handles any box-vs-page aspect at draw time.
 *
 *   px box  = (rasterWidth·dpi/72, rasterHeight·dpi/72)   // native axis ⇒ point size
 *   scale   = min(pxW / point.w, pxH / point.h)           // fit-box, aspect-preserving
 *
 * Args:
 *   point ({w,h}): native page size in PDF points (both > 0).
 *   rasterWidth, rasterHeight (number): target pixel box; ≤ 0 ⇒ native for that axis.
 *   rasterDPI (number): render density in DPI; ≤ 0 ⇒ PDF_RASTER_DEFAULT_DPI.
 *
 * Returns:
 *   number — device px per PDF point (> 0).
 *
 * @example rasterModeScale({ w: 72, h: 144 }, 0, 0, 72) // 1 (native @72dpi: 1px/pt)
 * @example rasterModeScale({ w: 72, h: 144 }, 0, 0, 144) // 2 (native @144dpi: 2px/pt)
 * @example rasterModeScale({ w: 100, h: 200 }, 50, 400, 72) // 0.5 (width caps the fit: 50/100)
 * @example rasterModeScale({ w: 612, h: 792 }, 0, 0, 96) // 1.3333333333333333 (native @96dpi ≈ screen)
 */
export function rasterModeScale(point, rasterWidth, rasterHeight, rasterDPI) {
  const dpi = rasterDPI > 0 ? rasterDPI : PDF_RASTER_DEFAULT_DPI;
  const dpiFactor = dpi / PDF_POINTS_PER_INCH;
  const pxW = (rasterWidth > 0 ? rasterWidth : point.w) * dpiFactor;
  const pxH = (rasterHeight > 0 ? rasterHeight : point.h) * dpiFactor;
  return Math.min(pxW / point.w, pxH / point.h);
}

/**
 * Command (near-pure: idempotently kicks ONE cached whole-page raster). The
 * "raster" render mode's per-widget step: rasterize the page's (crop-trimmed)
 * area ONCE at the FIXED rasterModeScale resolution (from the widget's
 * rasterWidth/rasterHeight/rasterDPI props — NOT the live view), so the region
 * ref is STABLE across zoom/pan and the compositor merely SCALES the one cached
 * bitmap. The region raster's own crash guards (device-scale cap + clampDim)
 * bound the allocation even at an extreme rasterDPI.
 *
 * Args:
 *   s (object): the pdf_page state — reads rasterWidth/rasterHeight/rasterDPI + crop insets.
 *   src (string), page (number): the (already page-clamped) PDF page.
 *   point ({w,h}): the page's native point size.
 *
 * Returns:
 *   {ref, x, y, w, h}: the region-raster ref + widget-local (cropped-box)
 *   placement, or null when the page is fully cropped away (nothing to draw).
 */
function rasterModeDescriptor(s, src, page, point) {
  const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
  if (!(c.w > 0) || !(c.h > 0)) return null; // fully cropped away → nothing to draw
  const scale = rasterModeScale(point, s.rasterWidth ?? 0, s.rasterHeight ?? 0, s.rasterDPI ?? 0);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  // The crop sub-rect is the normalized [0,1] page region to raster (the page
  // fills the box 1:1, so cropInsetsToSource's sx..sh ARE the page sub-rect).
  const sourceRect = { sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh };
  const { ref } = ensurePdfPageRegionRasterized(src, page, sourceRect, scale, point);
  return { ref, x: c.x, y: c.y, w: c.w, h: c.h };
}

/**
 * Query (pure). The world-space SOURCE region a supersample magnifier samples —
 * the small area (around its origin) it shows magnified. A lens of world
 * footprint half-extent (hx,hy) at magnification M shows a region of half-size
 * (hx/M, hy/M) centered on its origin (default: the footprint centre). This is
 * exactly what determines which content the lens RE-RENDERS, so it is the right
 * region to test PDF coverage against (a retargeted origin is honoured — the
 * lens can magnify a PDF that its own footprint does not overlap).
 *
 * @param {object} node A magnifier render node ({state, world}).
 * @returns {{rect:{x,y,w,h}, m:number, z:number}|null} world source rect +
 *   magnification (≥1) + z, or null if not a usable supersample lens.
 */
function lensSourceRegion(node) {
  const s = node.state;
  if (!(s.supersample ?? true)) return null;         // soft (sampling) lens can't be made crisp by a denser raster
  const m = Math.max(1, s.magnification ?? 1);        // minify (<1) needs no boost
  const aabb = rotatedBBoxAABB(node);                 // world footprint AABB
  if (!aabb) return null;
  const cx = typeof s.origin?.x === "number" ? s.origin.x : aabb.x + aabb.w / 2;
  const cy = typeof s.origin?.y === "number" ? s.origin.y : aabb.y + aabb.h / 2;
  const hx = aabb.w / 2 / m, hy = aabb.h / 2 / m;
  return { rect: { x: cx - hx, y: cy - hy, w: hx * 2, h: hy * 2 }, m, z: node.state.z ?? 0 };
}

/**
 * Query→command (near-pure: idempotently kicks async region rasters; the
 * returned map is a deterministic function of the inputs + registry state).
 * Builds the per-node PDF display descriptor map for one frame.
 *
 * Args:
 *   nodes (object[]): the derived render tree (nodes carry itemId/type/state/
 *     world/plugin — deriveRenderTree output, already culled is fine).
 *   view ({zoom, panX, panY, dpr}): the live camera mapping.
 *   viewW, viewH (number): the device-px canvas size (e.g. canvasEl.width/height).
 *
 * Returns:
 *   Map<string, {ref, x, y, w, h}>: itemId → {region-raster ref, local placement
 *     rect}. Only visible pdf_page nodes whose point size is known appear.
 *
 * @example // preRasterizePdfPages(nodes, {zoom:1,panX:0,panY:0,dpr:1}, 1280, 720) → Map { "pdf1" => {ref:"pdfregion:…", x:0,y:0,w:320,h:414} }
 */
export function preRasterizePdfPages(nodes, view, viewW, viewH) {
  const map = new Map();
  if (!(viewW > 0) || !(viewH > 0)) return map; // collapsed surface — nothing to size

  // MAGNIFIER COMPOSITION (user CRITICAL, 2026-07-23): "render at a resolution"
  // is recursive — a supersample magnifier is a re-render of its footprint at a
  // MAGNIFIED effective resolution, so text/vectors are crisp under it for free
  // (Skia re-rasterizes them per pass). A PDF is drawn as a RASTER, so it must be
  // rastered dense enough for the lens too. We collect the supersample lenses and
  // BOOST a covered PDF's raster scale by the lens magnification: ONE dense bitmap
  // then serves BOTH the main pass (drawn downscaled — crisp) AND the lens
  // re-render (drawn magnified — crisp), bounded by the SAME PDF_MAX_RASTER_DIM
  // cap. This composes the two features without restructuring paint_skia's
  // replay-based lens recursion (a per-pass re-emit is the North-Star recursive
  // render(), out of this rewrite's scope). Photos legitimately pixelate at
  // extreme magnification (fixed native res); PDF is vector-source, so it stays
  // crisp up to the cap. (Applies to "live" mode; "raster" mode is fixed-DPI and
  // deliberately ignores lenses — a magnifier over it scales the cached bitmap.)
  const lenses = nodes.filter((n) => n.type === "magnifier").map(lensSourceRegion).filter(Boolean);

  for (const node of nodes) {
    if (node.type !== "pdf_page") continue;
    const s = node.state;
    if (typeof s.src !== "string" || s.src.length === 0) continue;

    ensurePdfDoc(s.src); // idempotent
    const pageCount = pdfPageCount(s.src);
    const requested = s.page ?? 1;
    let page = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
    if (pageCount != null) page = clampPage(requested, pageCount).page; // reporting is emit()'s job (loud, once)

    const point = pdfPagePointSize(s.src, page);
    ensurePdfPagePointSize(s.src, page); // idempotent; fills `point` for a later frame
    if (!point || !(point.w > 0) || !(point.h > 0)) continue; // not measured yet → emit's whole-page fallback covers this frame

    // "raster" MODE: render the whole (cropped) page ONCE at a FIXED DPI/size and
    // cache it — the descriptor is view-INDEPENDENT, so zoom/pan reuse the one
    // bitmap (no re-raster). Falls through to the "live" path otherwise.
    const mode = s.renderMode ?? PDF_RENDER_MODE_DEFAULT;
    if (mode === "raster") {
      const descriptor = rasterModeDescriptor(s, s.src, page, point);
      if (descriptor) map.set(node.itemId, descriptor);
      continue;
    }

    // ── "live" MODE (the Chrome model): re-raster the on-screen visible region at
    // the current display resolution every frame ─────────────────────────────
    // OVERRIDE hook: the plugin may widen/shrink/opt-out its raster region.
    const policy = node.plugin.clipPolicy ? node.plugin.clipPolicy(s) : {};
    const vsr = visibleSourceRect(
      { world: node.world, w: s.w ?? 0, h: s.h ?? 0 },
      s,
      view,
      { viewW, viewH, margin: policy.margin ?? 0, full: policy.full ?? false },
    );
    if (!vsr.visible || vsr.deviceRect.w <= 0 || vsr.deviceRect.h <= 0) continue;

    // Display resolution = device px per PDF point across the visible region's
    // width (the region bitmap is stretched into localRect at draw, so a uniform
    // scale from the width suffices; box-vs-page aspect distortion is handled by
    // the image op's src→dest stretch).
    let scale = vsr.deviceRect.w / (vsr.sourceRect.sw * point.w);
    if (!(scale > 0) || !Number.isFinite(scale)) continue;
    // Boost by the strongest supersample lens whose sampled source region covers
    // this page AND that sits ABOVE it in z (a lens only re-renders content below
    // it) — so the lens re-render draws this page's dense bitmap crisply.
    const pdfAabb = rotatedBBoxAABB(node);
    let boost = 1;
    if (pdfAabb) {
      for (const lens of lenses) {
        if (lens.z > (s.z ?? 0) && rectsIntersect(lens.rect, pdfAabb)) boost = Math.max(boost, lens.m);
      }
    }
    // BOUND THE BOOST (the reported crash's suspect): deviceRect is viewport-
    // bounded at ANY zoom (core/clip proof), but the lens boost multiplies the
    // raster scale — the region canvas the raster allocates is ≈ deviceRect·boost
    // device px, which a large magnification could push past PDF_MAX_RASTER_DIM.
    // Cap the boost so the requested raster stays within the cap on its larger
    // edge. ensurePdfPageRegionRasterized's clampDim is the HARD backstop; capping
    // here keeps the pdf.js viewport scale sane (no runaway offset math) and makes
    // the bound provable at the boost site (a photo pixelates past its native res;
    // a boosted PDF stays crisp up to the cap, then holds — never OOMs).
    const projected = Math.max(vsr.deviceRect.w, vsr.deviceRect.h) * boost;
    if (projected > PDF_MAX_RASTER_DIM) boost = Math.max(1, boost * (PDF_MAX_RASTER_DIM / projected));
    scale *= boost;
    const { ref } = ensurePdfPageRegionRasterized(s.src, page, vsr.sourceRect, scale, point);
    map.set(node.itemId, { ref, x: vsr.localRect.x, y: vsr.localRect.y, w: vsr.localRect.w, h: vsr.localRect.h });
  }
  return map;
}
