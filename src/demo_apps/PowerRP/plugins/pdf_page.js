/**
 * PDF PAGE widget (manifest ROUND 13.1) — displays ONE page of a PDF asset,
 * like a photo. "adding a PDF as a widget so that I can actually add pages
 * from a PDF. Like so I can display a paper or something in here. I should
 * be able to control the page number as one of the parameters" (user,
 * verbatim). `page` is a first-class, equation-capable NUMBER property
 * (1-based) — it tweens/keyframes/equation-references exactly like x/y/w/h.
 *
 * ── BOX SHAPE IS A GENERIC TERM (standing ruling, manifest 2026-07-15
 * "AGAIN FOR THE LAST FUCKING TIME") ──────────────────────────────────────────
 * A PDF page is a BOX exactly like an image: it composes the SAME shared
 * bundles (core/properties.js) — positioning, the stroked-BORDER slice
 * (stroke/strokeWidth/cornerRadius — a framed page, not a fill), crop insets,
 * and effects (shadow/bloom/blend) — so it inherits every current AND future
 * box feature for free, with zero widget-specific decoration code. This file
 * is deliberately near-identical to plugins/image.js/video.js; the only new
 * concern is `page` + the PDF→bitmap raster pipeline underneath `src`.
 *
 * ── HOW IT REACHES THE RENDERER (reusing the image path, not a new one) ──────
 * A rasterized PDF page is a bitmap. Rather than inventing a new IR op +
 * three new backend cases, emit() builds a plain `image()` op whose `ref` is
 * a SYNTHETIC key from render_gpu/gpu/pdf_page_raster.js (pdfPageRef(src,
 * page, scale)) — the GPU compositor, the PDF backend, and the SVG backend
 * all already resolve an image ref uniformly (gpu/image_registry.js's
 * getImage, and both backends' generic string-ref image-byte loaders), so
 * this widget needs ZERO new backend code. See pdf_page_raster.js's header
 * for the full reasoning (the manifest's "raster embed acceptable for v1,
 * the hybrid rule precedent").
 *
 * ── DISPLAY = RE-RASTER AT DISPLAY RES (manifest RENDER PIVOT 2026-07-23) ─────
 * The EDITOR/PRESENTER display re-rasterizes only the page's VISIBLE REGION at
 * the CURRENT zoom (the Chrome model), so text/vectors stay crisp at any
 * magnification while the cost stays bounded by the SCREEN. emit() stays PURE of
 * the camera (sceneIR passes only state + the node's own local `world`, never
 * the outer zoom/pan/dpr); the resolution decision lives in a RENDER-TIME
 * pre-pass (render_gpu/pdf_display.preRasterizePdfPages) that the display
 * surfaces run BEFORE sceneIR — it computes the visible region via the shared
 * core/clip.visibleSourceRect primitive, rasterizes that sub-rect
 * (pdf_page_raster.ensurePdfPageRegionRasterized), and hands emit() the
 * resulting DISPLAY DESCRIPTOR as its 4th argument (renderCtx.pdfDisplay). emit()
 * draws that crisp region bitmap when the descriptor is present.
 *
 * ── VECTOR = EXPORT-ONLY (PDF P1 — the latexVector dual pattern) ──────────────
 * A page whose source content is pure vector graphics still renders as real
 * vector `path` ops (extracted once via render_gpu/gpu/pdf_page_vector.js from
 * pdf.js's operator list, mapped by the pure render_gpu/pdf_vector.js) — but ONLY
 * on the CAMERA-FREE fallback path (no display descriptor): SVG/PDF export
 * (a bitmap embedded in an SVG export would be wrong — manifest), thumbnails, the
 * CLI, and the first display frame before the region raster lands. The
 * interactive editor never takes this path (it always has a descriptor), so
 * vector is gated OUT of the display path per the pivot. The whole-page raster
 * stays the ALWAYS-available fallback (async not-ready, or a page that must
 * raster: text is P2, images P3, shadings/clips/blends/CMYK per classifyPdfPage).
 * Still no new IR op and ZERO backend changes — vector content is the existing
 * `path` op, the region raster the existing `image` op.
 *
 * ── PAGE CLAMPING: LOUD, NOT SILENT (this task's flagged house-rule choice) ──
 * `page` is clamped into [1, pageCount] so the widget ALWAYS shows something
 * rather than going blank on a stale/out-of-range page (matches the
 * repair-pipeline's "never brick the render" principle — deleting pages from
 * a PDF, or an equation drifting past the last page, must not blank the
 * widget or throw mid-render). But the clamp is NOT silent: an out-of-range
 * request reports ONCE via core/report.js reportOnce (console.error, the
 * codebase's one "loud but not spammy" idiom — filmstrip's unresolved-media
 * report is the direct precedent). FLAGGED TO THE LEAD: the task brief asked
 * for "clamped to page count with a LOUD out-of-range report, not a silent
 * clamp — pick per house rules and flag your choice" — this is that choice;
 * an alternative (draw NOTHING when out of range, like an unresolved image)
 * was rejected because a page-count equation typo would blank a whole slide
 * instead of degrading to the nearest valid page, which seemed harsher than
 * the manifest's established "loud-repair, never brick" pattern elsewhere.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — identical to
 * image/video, so it composites under magnifiers/blur and culls for free
 * (core/view.js canSkipNode's default bbox-intersection rule).
 *
 * ── ASYNC (manifest F3 + the round-12 async rule) ─────────────────────────────
 * PDF parse + page rasterization are async; emit() is sync and PURE (same
 * state → same image op, always). The compositor draws NOTHING for a
 * (src,page,scale) whose bitmap hasn't rasterized yet and repaints when it
 * lands (gpu/image_registry.js's onImageLoad — pdf_page_raster.js registers
 * into that SAME registry, so the repaint-on-load wiring is unchanged) — no
 * silent placeholder, no blocking. A load/rasterize FAILURE is reported
 * loudly by pdf_page_raster.js (console.error), never swallowed.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { image } from "../render_gpu/ir.js";
import { decorateStrokedBox, cropInsetsToSource } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { reportOnce } from "../core/report.js";
import {
  ensurePdfDoc, ensurePdfPagePointSize, ensurePdfPageRasterized,
  pdfPageCount, pdfPagePointSize, pdfPageRef, clampPage,
} from "../render_gpu/gpu/pdf_page_raster.js";
import { ensurePdfPageVector, pdfPageVectorIRFor } from "../render_gpu/gpu/pdf_page_vector.js";

/** Device px per world (canvas) unit at this widget's OWN world-space size —
 * LINKED to render_gpu/svg_backend.js RASTER_SCALE / pdf_backend.js's
 * rasterScale default (both 2, "the retina-dpr 2× supersample precedent" per
 * svg_backend.js's own comment) — the same supersample factor every other
 * hybrid raster region in this codebase already uses, not a fresh guess. */
const PDF_RASTER_DENSITY = 2;

/** No PDF asset chosen yet — the widget's default `src`. An empty string (NOT
 * a blank image data URI like image.js's BLANK_SRC): a PDF ref must be a real
 * fetchable document for pdfjs-dist to open, so "no PDF yet" is representable
 * only as "nothing to open" — emit() below returns [] for it, exactly like
 * image.js returns [] for an empty src. */
export const NO_SRC = "";

export const pdfPagePlugin = {
  type: "pdf_page",
  title: "PDF Page",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // positioning, the stroked-BORDER slice (a page has a frame, not a fill),
  // crop insets, and effects are all inherited — identical composition to
  // image.js/video.js (manifest "BOX SHAPE IS A GENERIC TERM").
  defaults: {
    type: "pdf_page", x: 100, y: 100, w: 320, h: 414, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an
    // equation — manifest Round 11). Absent on old docs → derive falls back
    // to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: NO_SRC,
    // THE new property (manifest 13.1): 1-based, equation-capable like every
    // other numeric slot. Default 1 (the first page) — a fresh widget with no
    // PDF yet just shows nothing (src is empty) until sourced, then shows
    // page 1 immediately with no extra step.
    page: 1,
    // stroke COLOR default matches every other stroked shape (rect/circle/
    // donut/image/video all use INK #1a1a2e); it only paints once
    // strokeWidth > 0 (0 by default → an undecorated page is byte-identical
    // to the bare image op).
    stroke: "#1a1a2e",
    ...defaults("strokeWidth", "cornerRadius", "opacity"), // strokeWidth:0, cornerRadius:0, opacity:1
    ...defaults("cropTop", "cropLeft", "cropRight", "cropBottom"), // all 0 → no crop
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  inspector: [
    ...bundle("positioning"),
    // The PDF asset — the registry `src` row (kind:"asset"), restricted to
    // the "pdf" asset kind (manifest task brief: "accept=pdf" — SonnetA's
    // AssetField renders the picker/upload/drag-drop UI from this same
    // declaration image.js/video.js use; this widget only NAMES the kind).
    // FLAGGED TO THE LEAD: server/server.py's asset_kind() (IMAGE_EXTS/
    // VIDEO_EXTS/SOUND_EXTS) does not yet classify ".pdf" — today it falls
    // through to "other", so the asset picker/explorer will not surface a
    // PDF as kind "pdf" until the server (out of this fence) adds it.
    ...props("src", { src: { label: "PDF", assetKinds: ["pdf"], help: "The PDF this widget shows one page of — pick from the project's assets, upload a file, or drag one in from the Asset Explorer or Finder." } }),
    // THE page control (manifest 13.1) — a plain number row; equation-capable
    // like every numeric property (no special-casing needed, the equation
    // grammar treats any plugin default that's a number as an equation slot).
    // `max` is a STATE-DERIVED FUNCTION (the general dynamic-bounds mechanism —
    // Inspector.svelte resolves `row.max` as `(state) => number` before passing
    // it to the numeric field): the last valid page IS pageCount for the current
    // src, so the field can't scrub past the last page. Null until the doc has
    // loaded (pdfPageCount → null) — unbounded for that async window; emit()
    // still clamps + loud-reports an out-of-range render meanwhile.
    { key: "page", label: "Page", kind: "number", min: 1, max: (state) => pdfPageCount(state.src) ?? null, category: "formatting", help: "Which page of the PDF to show (page 1 is the first page). Out-of-range values are clamped to the nearest real page and reported in the console." },
    // The stroked-BORDER bundle (manifest "SHARED STYLE BUNDLES" — images,
    // videos, and now PDF pages inherit stroke/rounding at once). No `fill`
    // row: the page's own pixels ARE its interior, like an image.
    ...bundle("strokedBorder"),
    // EDGE-CROP INSETS — trim the rendered page from each side; all-0
    // default = byte-identical to no crop.
    ...bundle("cropInsets"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (kicks idempotent async PDF loads/rasterizations as a
   * side effect; the RETURNED IR is a pure function of state — same state,
   * same op, always, exactly like image.js/video.js). State → display-list
   * commands (local space) — THE render API.
   *
   * PAGE CLAMP + LOUD REPORT (see module header): reads pdfPageCount(src)
   * (sync; null until the doc has loaded) and clamps the requested page into
   * range via pdf_page_raster.clampPage, reporting once per (src,
   * requestedPage) when the raw request was out of range. Unknown page count
   * (doc still loading) renders the requested page optimistically once
   * rasterized — clamping only applies once the true count is known.
   *
   * SCALE: PDF_RASTER_DENSITY device px per world unit at this widget's OWN
   * (cropped) size × world.scale (see module header) converted to a pdfjs
   * `scale` via the cached native point-size (pdfPagePointSize) — the "how
   * big is one PDF point in canvas units" factor. Unknown point size (doc
   * not open yet) falls back to scale 1 (pdfjs default) for the FIRST
   * render; ensurePdfPagePointSize kicks the measurement, and a later
   * emit() (state changed, or the repaint-on-load wake — pdf_page_raster
   * registers into the SAME image_registry, so onImageLoad already covers
   * this) picks up the true density once known.
   */
  emit(s, _targetWorldIR, world, renderCtx) {
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const c = cropInsetsToSource(s.w ?? 0, s.h ?? 0, s);
    if (c.w <= 0 || c.h <= 0) return []; // fully cropped away → nothing to draw

    ensurePdfDoc(s.src); // idempotent; safe every emit()
    const pageCount = pdfPageCount(s.src);
    const requestedPage = s.page ?? 1;
    let page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    if (pageCount != null) {
      const clamped = clampPage(requestedPage, pageCount);
      page = clamped.page;
      if (clamped.outOfRange) {
        reportOnce(
          `pdf_page:range:${s.src}:${requestedPage}`,
          `PowerRP pdf_page: page ${requestedPage} is out of range for "${s.src}" (${pageCount} page${pageCount === 1 ? "" : "s"}) — showing page ${page} instead.`,
        );
      }
    }

    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const bbox = { x: c.x, y: c.y, w: c.w, h: c.h };
    const opacity = s.opacity ?? 1;
    const opaque = opacity >= 1;

    // THE WHOLE-PAGE RASTER (always kept available). Its scale is the "displayed
    // pixel density at this widget's OWN world-space size" approximation emit can
    // make with no camera (PDF_RASTER_DENSITY device px per world unit × world.scale,
    // → a pdfjs scale via the native point size). It is BOTH the camera-free
    // fallback (export/thumbnail/CLI) AND the smooth BASE the display path draws
    // under the crisp region so a not-yet-ready region never flashes blank.
    const worldScale = world?.scale ?? 1;
    const density = worldScale * PDF_RASTER_DENSITY; // device px per world unit, the rasterScale precedent
    const point = pdfPagePointSize(s.src, page);
    ensurePdfPagePointSize(s.src, page); // idempotent; fills `point` for a LATER emit() once known
    // scale (pdfjs "device px per PDF point") = (world-space px we want) /
    // (PDF points that fills). Falls back to plain `density` (one PDF point ≈ one
    // world unit) until the true point size is known — self-corrects the instant
    // pdfPagePointSize resolves.
    const wholeScale = point && point.w > 0 ? (c.w * density) / point.w : density;
    ensurePdfPageRasterized(s.src, page, wholeScale); // whole-page raster — always kept available
    const wholeRef = pdfPageRef(s.src, page, wholeScale);
    const wholeQuad = image({ ref: wholeRef, x: c.x, y: c.y, w: c.w, h: c.h, opacity, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });

    // ── DISPLAY RE-RASTER (manifest RENDER PIVOT 2026-07-23, the Chrome model) ──
    // A render-time pre-pass (render_gpu/pdf_display.preRasterizePdfPages, run by
    // the surfaces that know the live view — CanvasView/PresentMode) supplied the
    // crisp VISIBLE-REGION bitmap for THIS node, sized to the current display
    // resolution and bounded to the on-screen window. Draw that bitmap at the
    // descriptor's local rect: crisp at ANY zoom, cost bounded by the SCREEN.
    // Crop is baked into the region (the pre-pass intersected box ∩ viewport ∩
    // crop), so the op needs no source sub-rect; opacity is draw-time alpha. When
    // OPAQUE, the whole-page raster is drawn UNDER as a base so a not-yet-ready
    // region (first frame / zoom-bucket change) shows the (cached, lower-res)
    // page instead of flashing blank — the region overdraws it crisply where
    // ready (Chrome's blurry-then-sharp tile behavior). A TRANSLUCENT page draws
    // the region ALONE (stacking two translucent layers would double-fade the
    // overlap — the decorate.js opacity contract). This SUPERSEDES the vector
    // path below for display — vector is now EXPORT-ONLY.
    const disp = renderCtx?.pdfDisplay ?? null;
    if (disp) {
      const regionQuad = image({ ref: disp.ref, x: disp.x, y: disp.y, w: disp.w, h: disp.h, opacity });
      const content = opaque ? [wholeQuad, regionQuad] : [regionQuad];
      return applyEffects(decorateStrokedBox(content, style, world), s, world, bbox);
    }

    // ── NO pre-pass: the camera-free fallback (export / thumbnail / CLI / the
    // first display frame before the region lands) ─────────────────────────────
    ensurePdfPageVector(s.src, page); // VECTOR ingest — EXPORT-ONLY now (extract op list + classify; async, idempotent)
    // TRUE VECTOR (EXPORT-ONLY — the latexVector dual pattern): once the page is
    // extracted AND classified vector-safe (render_gpu/pdf_vector.classifyPdfPage),
    // emit its `path` ops mapped into the box — crisp AND real vector in SVG/PDF
    // export (a bitmap embedded in an SVG export would be wrong — manifest). The
    // interactive editor never reaches here (it always has a `disp` descriptor);
    // this path serves the SVG/PDF exporters, thumbnails, and the CLI, plus the
    // very first display frame before the region raster lands. Fall back to the
    // whole-page raster quad (honoring the crop sub-rect + opacity) when the
    // vector isn't ready, the page must raster (text is P2 / images / shadings /
    // clips / blends / CMYK per classifyPdfPage), OR a crop inset / opacity < 1
    // can't be faithfully drawn as solid vector paths (raster honors sx/sy/sw/sh
    // and fades the page as one — the same hybrid rule latex.js uses).
    const cropped = c.sw < 1 || c.sh < 1 || c.sx > 0 || c.sy > 0;
    const vectorOps = cropped || !opaque ? null : pdfPageVectorIRFor(s.src, page, { x: c.x, y: c.y, w: c.w, h: c.h });
    const content = vectorOps ? vectorOps : [wholeQuad];
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): the shadow/bloom silhouette the FRAMED page, border included.
    return applyEffects(decorateStrokedBox(content, style, world), s, world, bbox);
  },
  // CLIP POLICY (manifest "OVERRIDABLE"): the DEFAULT shared bounded visible-
  // region raster (core/clip.visibleSourceRect via render_gpu/pdf_display) — a
  // PDF page needs no less/more-restrictive override (a shadow spilling past the
  // ON-SCREEN window is itself off-screen, so widening the raster there buys
  // nothing). Declared explicitly (returns the neutral default) so the widget's
  // clip policy is visible AT the widget and the pre-pass has one hook to read;
  // other raster widgets may return {margin} (less restrictive) or {full:true}
  // (opt out of view-bounding).
  clipPolicy: () => ({}),
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-pdf-page", title: "Add PDF Page", icon: "mdi:file-pdf-box", run: (app) => app.armCrosshairPlacement(pdfPagePlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP), matching image/video's own add command
  ],
};
