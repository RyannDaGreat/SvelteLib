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
 * ── RENDER MODES (the widget's `renderMode` property) ─────────────────────────
 * Each pdf_page picks how its interactive DISPLAY is produced (see the
 * PDF_RENDER_MODES block below): "raster" (unthrottled per-frame region
 * re-raster), "hybrid" (DEFAULT — persistent whole-page proxy + a hysteresis-
 * throttled region overlay, the native-viewer model), or "vector" (this pre-pass
 * SKIPS the node so emit() draws crisp GPU vector). The crash guards
 * (device-scale cap + generation-gate + graceful null-skip) hold in every mode.
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
  ensurePdfPageRegionRasterized, pdfRegionReady, clampPage,
  PDF_MAX_RASTER_DIM,
} from "./gpu/pdf_page_raster.js";

// ── RENDER MODES (the pdf_page widget's `renderMode` property) ────────────────
// A placed PDF page picks HOW its interactive DISPLAY is produced. All three
// modes keep the crash guards (device-scale cap + generation-gate + graceful
// null-skip) intact — they only change WHICH bitmap/vector the display draws.
//
//   "raster" — the re-raster pre-pass, unthrottled: every frame requests the
//     EXACT visible region at the current zoom (crisp as soon as it lands; may
//     re-kick a fresh region every frame of a fast zoom — the generation gate
//     discards the stale ones). The whole-page raster (emit's wholeQuad) is the
//     base drawn under it.
//   "hybrid" (DEFAULT) — the user's native-viewer design. The persistent
//     whole-page raster is the ALWAYS-instant proxy (drawn by emit under the
//     region, transforms/zooms/rotates with zero wait); on top we overlay the
//     highest-res region we have and RE-RASTER it asynchronously WITH HYSTERESIS
//     (retargetNeeded below), so a fast zoom shows the proxy (a pixelated frame
//     or two) then sharpens instead of thrashing one render per frame. Between
//     retargets we keep showing the last READY region (glued to its own local
//     rect — blurry-but-correct as the camera moves past it), swapping to the
//     fresher one the instant it lands (even mid-zoom).
//   "vector" — no descriptor is produced (this pre-pass skips the node), so
//     pdf_page emit() takes its camera-free path and draws the crisp GPU VECTOR
//     `path` ops (render_gpu/pdf_vector via gpu/pdf_page_vector) for a
//     vector-safe page, falling back to the whole-page raster otherwise.
//
// renderMode governs the INTERACTIVE display only. Camera-free consumers
// (export/thumbnail/CLI) never run this pre-pass, so they are byte-identical
// across all three modes (vector-if-safe else whole-page raster) — see
// plugins/pdf_page.js emit()'s fallback path.
export const PDF_RENDER_MODES = ["raster", "hybrid", "vector"];
export const PDF_RENDER_MODE_DEFAULT = "hybrid";

/** HYBRID retarget threshold — the display scale (device px per PDF point) must
 * change by more than this FACTOR (either direction) before the in-flight region
 * target is moved to a sharper/coarser raster. 1.5 = a 50% resolution swing: big
 * enough that a continuous zoom re-kicks ~once per 1.5× (roughly log_1.5 kicks
 * across a zoom range, not one per frame), small enough that the transient
 * blur/sharpness of the held region stays modest. Named, tunable; the value is a
 * fluency/kick-rate trade-off, not a correctness constant. */
export const REGION_RETARGET_SCALE_RATIO = 1.5;

/** HYBRID retarget threshold — the desired visible sub-rect may pan/grow this
 * FRACTION of the current target region's extent past its edges before a fresh
 * region is kicked. 0.15 = a 15% margin of pan/zoom-out headroom, so small drags
 * reuse the held region (cache hit, no re-kick) and only a real move retargets.
 * Named, tunable; a fluency/kick-rate trade-off like the scale ratio. */
export const REGION_RETARGET_MARGIN_FRAC = 0.15;

/** Bound on distinct HYBRID hysteresis records (keyed per widget × display
 * surface). Each record is a few numbers/strings — this only bounds bookkeeping,
 * never a bitmap (the region bitmaps live in the image registry). Oldest-first
 * eviction (Map insertion order) when exceeded; a re-seen widget simply
 * re-seeds. Sized for a healthy count of PDF widgets across the editor, minimap,
 * and presenter surfaces. */
export const HYBRID_STATE_MAX = 128;

/** hysteresisKey → {target, shown} — the HYBRID mode's per-(widget, surface)
 * cross-frame memory. `target` = {sourceRect, scale, ref, local} of the region
 * currently kicked/awaited; `shown` = {ref, local} of the last region that
 * became READY (what we DISPLAY). Keyed also by the device canvas size so the
 * editor, minimap, and presenter (different sizes, different live views of the
 * SAME page) keep INDEPENDENT hysteresis and never fight over one slot; two
 * surfaces of identical size would share a record, which at worst causes a few
 * extra re-kicks (self-correcting) — never wrong pixels or a crash, because the
 * region CACHE + generation gate remain keyed on (src,page,sub-rect,scale). */
const hybridState = new Map();

/**
 * Pure function. The HYBRID hysteresis key for a widget on a display surface. The
 * canvas device size (viewW×viewH) is the stable surface discriminator (it does
 * NOT change under zoom/pan, so a surface keeps ONE record across a whole
 * gesture) — see hybridState's doc for why surfaces must stay independent.
 *
 * @example hybridKey("pdf1", 1280, 720) // "pdf1|1280x720"
 */
function hybridKey(itemId, viewW, viewH) {
  return `${itemId}|${viewW}x${viewH}`;
}

/**
 * Pure function. Whether HYBRID must abandon the current region `target` and kick
 * a fresh one for `desired`. True when there is no target yet, OR the display
 * scale swung past REGION_RETARGET_SCALE_RATIO (need a sharper/coarser raster),
 * OR the desired visible sub-rect escaped the target's sub-rect expanded by
 * REGION_RETARGET_MARGIN_FRAC (panned/zoomed to page area the held region does
 * not cover). A `desired`/`target` that stays within BOTH thresholds is served by
 * the held region (a cache hit — no re-kick), which is the whole point of the
 * hysteresis: no per-frame thrash during a gesture.
 *
 * @param {{sourceRect:{sx,sy,sw,sh}, scale:number}|null} target current region, or null
 * @param {{sourceRect:{sx,sy,sw,sh}, scale:number}} desired region for this frame's view
 * @returns {boolean}
 *
 * @example retargetNeeded(null, {sourceRect:{sx:0,sy:0,sw:1,sh:1}, scale:2}) // true (no target yet)
 * @example retargetNeeded({sourceRect:{sx:0,sy:0,sw:1,sh:1}, scale:2}, {sourceRect:{sx:0,sy:0,sw:1,sh:1}, scale:2.1}) // false (5% scale swing, contained)
 * @example retargetNeeded({sourceRect:{sx:0,sy:0,sw:1,sh:1}, scale:2}, {sourceRect:{sx:0,sy:0,sw:1,sh:1}, scale:4}) // true (2x scale swing)
 * @example retargetNeeded({sourceRect:{sx:0.4,sy:0.4,sw:0.2,sh:0.2}, scale:5}, {sourceRect:{sx:0.7,sy:0.4,sw:0.2,sh:0.2}, scale:5}) // true (panned out of the region + margin)
 */
export function retargetNeeded(target, desired) {
  if (!target) return true;
  const ratio = Math.max(desired.scale / target.scale, target.scale / desired.scale);
  if (ratio > REGION_RETARGET_SCALE_RATIO) return true;
  const t = target.sourceRect, d = desired.sourceRect;
  const mx = t.sw * REGION_RETARGET_MARGIN_FRAC, my = t.sh * REGION_RETARGET_MARGIN_FRAC;
  const contained =
    d.sx >= t.sx - mx && d.sy >= t.sy - my &&
    d.sx + d.sw <= t.sx + t.sw + mx && d.sy + d.sh <= t.sy + t.sh + my;
  return !contained;
}

/**
 * Command (near-pure: idempotently kicks the region raster). The RASTER render
 * mode's per-widget step: request the EXACT visible region at this frame's
 * display scale and return its descriptor immediately — the existing re-raster
 * behavior, no hysteresis. A not-yet-ready ref draws nothing until it lands
 * (emit's whole-page proxy shows meanwhile); a fast zoom re-kicks a fresh region
 * per frame and the generation gate discards the stale ones.
 *
 * Args:
 *   src (string), page (number): the (already page-clamped) PDF page.
 *   sourceRect ({sx,sy,sw,sh}): the visible sub-rect. scale (number): display
 *     scale (device px per PDF point, already boosted + capped). point ({w,h}):
 *     native point size. localRect ({x,y,w,h}): widget-local placement.
 *
 * Returns:
 *   {ref, x, y, w, h}: the region-raster ref + widget-local placement.
 */
function rasterDescriptor(src, page, sourceRect, scale, point, localRect) {
  const { ref } = ensurePdfPageRegionRasterized(src, page, sourceRect, scale, point);
  return { ref, x: localRect.x, y: localRect.y, w: localRect.w, h: localRect.h };
}

/**
 * Command (near-pure: mutates the bounded hybridState cache; idempotently kicks a
 * region raster only on a retarget). The HYBRID render mode's per-widget step:
 * given this frame's desired region, decide whether to kick a fresher raster
 * (hysteresis), promote a landed target to "shown", and return the display
 * DESCRIPTOR to draw THIS frame. ALWAYS returns a descriptor (so pdf_page emit()
 * takes its proxy+region display path, never the vector fallback): the last READY
 * region when we have one, else the (not-yet-ready) target ref — which draws
 * nothing until it lands, letting emit's whole-page proxy show through
 * meanwhile (the "instant proxy, sharpen later" behavior).
 *
 * Args:
 *   itemId (string), viewW/viewH (number): identify the widget + display surface.
 *   src (string), page (number): the (already page-clamped) PDF page.
 *   sourceRect ({sx,sy,sw,sh}): this frame's desired visible sub-rect.
 *   scale (number): this frame's desired display scale (device px per PDF point,
 *     already magnifier-boosted + device-scale-capped by the caller).
 *   localRect ({x,y,w,h}): this frame's desired widget-local placement rect.
 *   point ({w,h}): the page's native point size (passed through to the raster).
 *
 * Returns:
 *   {ref, x, y, w, h}: the region-raster ref + widget-local placement to draw.
 */
function hybridDescriptor(itemId, viewW, viewH, src, page, sourceRect, scale, localRect, point) {
  const key = hybridKey(itemId, viewW, viewH);
  let st = hybridState.get(key);
  if (!st) {
    st = { target: null, shown: null };
    if (hybridState.size >= HYBRID_STATE_MAX) hybridState.delete(hybridState.keys().next().value);
    hybridState.set(key, st);
  }
  const desired = { sourceRect, scale };
  if (retargetNeeded(st.target, desired)) {
    const { ref } = ensurePdfPageRegionRasterized(src, page, sourceRect, scale, point); // idempotent kick
    st.target = { sourceRect, scale, ref, local: { x: localRect.x, y: localRect.y, w: localRect.w, h: localRect.h } };
  }
  // Promote the awaited target to "shown" the instant its bitmap lands — even
  // mid-zoom, so the crisp overlay refreshes without waiting for the gesture to
  // settle. Until then keep the previous "shown" (blurry-but-correct) if we have
  // one; otherwise fall through to the target ref (draws nothing → proxy shows).
  if (pdfRegionReady(st.target.ref)) st.shown = { ref: st.target.ref, local: st.target.local };
  const chosen = st.shown ?? st.target;
  return { ref: chosen.ref, x: chosen.local.x, y: chosen.local.y, w: chosen.local.w, h: chosen.local.h };
}

/**
 * Command. Drops all HYBRID hysteresis records. For tests that need a clean
 * pre-pass; mirrors resetPdfPageRaster/resetPdfPageVector.
 */
export function resetPdfDisplay() {
  hybridState.clear();
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
  // crisp up to the cap.
  const lenses = nodes.filter((n) => n.type === "magnifier").map(lensSourceRegion).filter(Boolean);

  for (const node of nodes) {
    if (node.type !== "pdf_page") continue;
    const s = node.state;
    if (typeof s.src !== "string" || s.src.length === 0) continue;
    const mode = s.renderMode ?? PDF_RENDER_MODE_DEFAULT;
    // VECTOR mode is served by emit()'s camera-free vector path, so this pre-pass
    // supplies NO descriptor for the node — sceneIR then hands emit() a null
    // renderCtx.pdfDisplay and emit draws the crisp GPU `path` ops (or the
    // whole-page raster when the page is not vector-safe). raster/hybrid fall
    // through and get a region descriptor below.
    if (mode === "vector") continue;

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
    // RASTER requests the exact visible region every frame (crisp ASAP; the
    // generation gate absorbs the fast-zoom re-kick stampede). HYBRID throttles
    // re-kicks and keeps the last-ready region as the crisp overlay while the
    // whole-page proxy shows through until a fresher region lands — the user's
    // native-viewer design. Both hand emit() a region descriptor (proxy+region
    // display path); only the region SELECTION differs.
    const descriptor = mode === "raster"
      ? rasterDescriptor(s.src, page, vsr.sourceRect, scale, point, vsr.localRect)
      : hybridDescriptor(node.itemId, viewW, viewH, s.src, page, vsr.sourceRect, scale, vsr.localRect, point);
    map.set(node.itemId, descriptor);
  }
  return map;
}
