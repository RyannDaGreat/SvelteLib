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
 * the hybrid rule precedent" — a PDF-exported pdf_page widget is a raster
 * PNG region among the vector page content, exactly like the effects bundle's
 * hybrid raster regions; a future VECTOR re-embed of the source page is
 * FLAGGED future work in that module's footer, not built here).
 *
 * ── RASTERIZATION SCALE (render at the DISPLAYED pixel density) ──────────────
 * emit() is a pure function of state with no viewport/dpr context (the same
 * contract every plugin emit() has — sceneIR passes only state + the node's
 * own local `world` transform, never the outer camera zoom/dpr). So "render
 * at the displayed pixel density" is approximated the same way
 * render_gpu/pdf_backend.js's hybrid raster regions already do it (its
 * `rasterScale` constant, RASTER_SCALE=2 in svg_backend.js — "the retina-dpr
 * 2× supersample precedent"): rasterize at RASTER_SCALE device px per WORLD
 * unit at this widget's OWN world-space size (state.w/h × world.scale). A
 * resize or zoom-driven world.scale change lands a new rounded scale bucket
 * (pdf_page_raster's PDF_SCALE_STEP) and re-rasterizes; a resize that stays
 * within one bucket reuses the cached bitmap (same "re-render on page/size
 * change, cache by (src,page,scale)" spec as a bare pixel-scale change would
 * cost nothing extra visually). This mirrors the thumbnail/gpuService
 * "displayed size × dpr" convention (concerns.md dpr sweep) using the ONE
 * context emit() actually has: the node's own world transform.
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
    { key: "page", label: "Page", kind: "number", min: 1, category: "formatting", help: "Which page of the PDF to show (page 1 is the first page). Out-of-range values are clamped to the nearest real page and reported in the console." },
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
  emit(s, _targetWorldIR, world) {
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

    const worldScale = world?.scale ?? 1;
    const density = worldScale * PDF_RASTER_DENSITY; // device px per world unit, the rasterScale precedent
    const point = pdfPagePointSize(s.src, page);
    ensurePdfPagePointSize(s.src, page); // idempotent; fills `point` for a LATER emit() once known
    // scale (pdfjs "device px per PDF point") = (world-space px we want) /
    // (PDF points that fills). Falls back to plain `density` (treating one
    // PDF point as one world unit) until the true point size is known — a
    // reasonable first guess (US Letter/A4 are both ~1:1.3 world-unit-ish at
    // density 1) that self-corrects the instant pdfPagePointSize resolves.
    const scale = point && point.w > 0 ? (c.w * density) / point.w : density;
    ensurePdfPageRasterized(s.src, page, scale); // idempotent; safe every emit()
    const ref = pdfPageRef(s.src, page, scale);

    const style = { x: c.x, y: c.y, w: c.w, h: c.h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
    const quad = image({ ref, x: c.x, y: c.y, w: c.w, h: c.h, opacity: s.opacity ?? 1, sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh });
    // Effects wrap OUTSIDE the border decoration (render_gpu/effects.js order
    // rule): the shadow/bloom silhouette the FRAMED page, border included.
    return applyEffects(decorateStrokedBox([quad], style, world), s, world, { x: c.x, y: c.y, w: c.w, h: c.h });
  },
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
