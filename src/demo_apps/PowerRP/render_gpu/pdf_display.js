/**
 * THE render-time PDF display re-raster pre-pass (manifest RENDER PIVOT
 * 2026-07-23). emit() is PURE of the camera; the resolution decision lives HERE,
 * at render time, in the ONE layer that knows the live view.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────
 * Given the derived render tree + the live view, it finds every visible
 * `pdf_page` node, computes its on-screen VISIBLE REGION at the current display
 * resolution via the shared pure primitive core/clip.visibleSourceRect (widget
 * box ∩ viewport ∩ crop → {localRect, sourceRect, deviceRect}), and ensures that
 * SUB-RECT of the page is rasterized at that resolution
 * (pdf_page_raster.ensurePdfPageRegionRasterized). It returns a
 * Map<itemId, {ref, x, y, w, h}> — the DISPLAY DESCRIPTOR each pdf_page node's
 * emit() consumes (threaded through render_gpu/ports.sceneIR as emit's 4th arg)
 * to draw the crisp region bitmap at its local placement.
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
import {
  ensurePdfDoc, pdfPageCount, pdfPagePointSize, ensurePdfPagePointSize,
  ensurePdfPageRegionRasterized, clampPage,
} from "./gpu/pdf_page_raster.js";

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
  // crisp up to the cap.
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
    scale *= boost;
    const { ref } = ensurePdfPageRegionRasterized(s.src, page, vsr.sourceRect, scale, point);
    map.set(node.itemId, { ref, x: vsr.localRect.x, y: vsr.localRect.y, w: vsr.localRect.w, h: vsr.localRect.h });
  }
  return map;
}
