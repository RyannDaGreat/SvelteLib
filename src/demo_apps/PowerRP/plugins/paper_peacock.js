/**
 * PAPER PEACOCK widget — a fan of a PDF's pages arranged like a peacock tail
 * (the MotionV2V hero figure: N pages of a paper, splayed evenly about a shared
 * pivot below them, page 1 on top, each sheet casting its own soft shadow).
 *
 * ── THE REFERENCE ALGORITHM (rp/git/Figures/paper_peacock.py, emulated) ───────
 *   · Load the PDF's first `pageCount` pages (default 8) starting at `firstPage`.
 *   · Every page occupies the SAME base rect, horizontally centered; each pivots
 *     about ONE shared point on the vertical centerline, `hRatio` page-heights
 *     BELOW the page's TOP edge (1 = bottom-center; >1 fans out with a gap
 *     below the sheets; <1 overlaps; 0.5 = page center).
 *   · The pages rotate evenly across [-fanAngle, +fanAngle] degrees (page 1 at
 *     -fanAngle, the last page at +fanAngle).
 *   · Drawn back-to-front, so PAGE 1 IS ON TOP (the last page lies deepest).
 *   · Each page gets its OWN drop shadow: blur = shadowBlur·pageW (default 0.2,
 *     the reference's pageW/5), offset (shadowDx·blur, shadowDy·blur) (defaults
 *     0.2·blur each, the reference's down-right offset), black at shadowOpacity
 *     (default 0.5).
 *
 * ── FIT-TO-BOX (the documented v1 layout choice) ──────────────────────────────
 * The widget box (w×h) is treated as the FAN'S BOUNDING BOX: the layout is
 * computed in page-width units (fanBounds), then uniformly scaled + centered so
 * the rotated fan's ink exactly fits the box (letterboxed on the short axis,
 * like preserveAspect media). This is the simpler of the two options the task
 * allowed and it keeps every helper a small pure function; a future variant
 * could instead solve the page size so the fan FILLS both axes.
 *
 * ── PDF PLUMBING (copied from plugins/pdf_page.js's camera-free path) ─────────
 * Each sheet is a plain `image()` op whose ref is the shared whole-page raster
 * cache key (render_gpu/gpu/pdf_page_raster.js pdfPageRef) — zero new backend
 * code, async contract identical to pdf_page: a not-yet-rasterized page draws
 * nothing that frame and the repaint wakes when the bitmap lands. The peacock
 * deliberately does NOT use the display region pre-pass (its sheets are small
 * and rotated; the whole-page raster at the sheet's own density is the right
 * tool). Out-of-range page requests are clamped LOUDLY (reportOnce), never
 * silently: the fan is TRIMMED to the pages that exist rather than padding it
 * with duplicates of the last page (clampFanCount — the reference loads "the
 * first N pages", and a 5-page paper has five of them, not eight).
 *
 * SHADOWS DRAW EVEN WHILE THE PDF IS LOADING (or absent): they are pure
 * geometry of the widget's own state — not a media placeholder — so the fan's
 * layout is visible/editable immediately, and the bare-node CLI (which cannot
 * decode PDFs and REPORTS the omitted image ops) still renders the true
 * silhouette for geometry checks.
 *
 * ── SHATTER: THE FAN BECOMES ITS SHEETS ───────────────────────────────────────
 * User, 2026-08-02: "Shatter should work for paper peacock too." It does, and
 * this is the one widget whose shatter loses NOTHING: a sheet IS a whole-page
 * raster at a rect, which is exactly what plugins/pdf_page.js draws, so every
 * part comes back as a native editable widget (vectorRecovery 1) rather than as
 * a picture. See `shatter` below for what each sheet carries, and
 * `sheetTransform` for why the shared pivot is written as a NUMERIC
 * rotationAnchor — the one thing the per-item `self.anchors.center` default
 * structurally cannot express.
 *
 * ── THE THREE KINDS OF STATE ──────────────────────────────────────────────────
 * Property state only: the whole render is pure(document, [[slide, alpha]]).
 * No clock, no randomness, no frame-to-frame carry.
 */

import { convergesOnRefPrefixes } from "../render_gpu/gpu/settled.js";
import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { closestPointOnSegment } from "../core/outline.js";
import { image, path, pushTransform, popTransform, SUPERSAMPLE_DENSITY } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { reportOnce } from "../core/report.js";
import { partKey } from "../core/shatter.js"; // core, not a plugin — the mermaid/svg precedent
import {
  ensurePdfDoc, ensurePdfPagePointSize, pdfPageRasterRefForDisplay, PDF_PLACEHOLDER_PAPER,
  pdfPageCount, pdfPagePointSize,
} from "../render_gpu/gpu/pdf_page_raster.js";

/** The fanAngle handle's allowed range, degrees (0 = a flat stack, 90 = a full
 * half-circle splay — past 90 the sheets flip upside-down, which the reference
 * figure never does). */
export const FAN_ANGLE_MIN = 0;
export const FAN_ANGLE_MAX = 90;

/** The hRatio handle's allowed range: 0.5 pivots at the page CENTER (sheets
 * spin in place), 3 pushes the pivot two page-heights below the sheets (a wide,
 * gappy fan). Below 0.5 the pivot would sit ABOVE the page center — an
 * upside-down fan the reference never draws. */
export const H_RATIO_MIN = 0.5;
export const H_RATIO_MAX = 3;

/** Page aspect (height/width) assumed until the PDF's own point size is known:
 * US Letter, 612×792 PDF points — what arXiv papers (the reference use case)
 * are. Self-corrects on the emit() after pdfPagePointSize resolves. */
export const DEFAULT_PAGE_ASPECT = 792 / 612;

/** Shadow ink — the reference casts pure black (softened by blur + opacity). */
export const SHADOW_INK = "#000000";

/** Device px per world unit for the whole-page rasters — the same shared
 * supersample factor pdf_page's PDF_RASTER_DENSITY uses (the retina-dpr 2×
 * precedent), so a peacock sheet and a pdf_page of the same size share cache
 * entries. */
export const PEACOCK_RASTER_DENSITY = SUPERSAMPLE_DENSITY;

/** No PDF chosen yet — same representation as pdf_page.js's NO_SRC (an empty
 * string; a PDF ref must be a real fetchable document, so "none" is "nothing
 * to open"). Declared here because NO plugin may import another plugin. */
export const NO_SRC = "";

/**
 * Pure function. The fan's page angles in DEGREES, page 1 first: `count` values
 * evenly spaced across [-fanAngle, +fanAngle]. A single page sits upright.
 *
 * Args:
 *   count (number): how many pages (>= 1)
 *   fanAngle (number): the half-spread, degrees
 *
 * Returns:
 *   number[]: one angle per page, degrees
 *
 * @example fanAngles(3, 45) // [-45, 0, 45]
 * @example fanAngles(1, 45) // [0]
 * @example fanAngles(4, 30) // [-30, -10, 10, 30]
 */
export function fanAngles(count, fanAngle) {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => -fanAngle + (i * 2 * fanAngle) / (count - 1));
}

/**
 * Pure function. A point rotated about a pivot by `deg` degrees (y-down frame,
 * like all local widget space: +90° carries +x onto +y).
 *
 * Args:
 *   x, y (number): the point
 *   cx, cy (number): the pivot
 *   deg (number): rotation, degrees
 *
 * Returns:
 *   {x: number, y: number}
 *
 * @example rotatedAbout(1, 0, 0, 0, 90) // {x: 0, y: 1}
 * @example rotatedAbout(3, 4, 3, 4, 137) // {x: 3, y: 4} (the pivot is fixed)
 * @example rotatedAbout(2, 0, 0, 0, 180) // {x: -2, y: 0}
 */
export function rotatedAbout(x, y, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - cx, dy = y - cy;
  return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy };
}

/**
 * Pure function. The pushTransform frame that rotates the CURRENT local space
 * by `deg` degrees about the pivot (cx, cy) — i.e. the frame F with
 * F(p) = pivot + R(θ)·(p − pivot), spelled as ir.js's {x, y, rotation, scale}.
 *
 * Args:
 *   cx, cy (number): the pivot, local units
 *   deg (number): rotation, degrees
 *
 * Returns:
 *   {x: number, y: number, rotation: number, scale: number} — rotation in RADIANS
 *
 * @example rotationAboutPivot(10, 10, 0) // {x: 0, y: 0, rotation: 0, scale: 1}
 * @example rotationAboutPivot(10, 0, 90) // {x: 10, y: -10, rotation: 1.5707963267948966, scale: 1}
 */
export function rotationAboutPivot(cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: cx - (c * cx - s * cy), y: cy - (s * cx + c * cy), rotation: r, scale: 1 };
}

/**
 * Pure function. The fan's ink bounding box in PAGE-WIDTH UNITS: pages are
 * 1 × aspect, top-left at (0, 0), all sharing the pivot (0.5, aspect·hRatio);
 * the box is the union of every rotated page's corners (the SHEETS' ink only —
 * a gap between sheets and pivot is not ink).
 *
 * Args:
 *   count (number): pages in the fan (>= 1)
 *   fanAngle (number): half-spread, degrees
 *   hRatio (number): pivot depth in page heights below the page top
 *   aspect (number): page height / page width
 *
 * Returns:
 *   {x: number, y: number, w: number, h: number}
 *
 * @example fanBounds(1, 0, 1.5, 1) // {x: 0, y: 0, w: 1, h: 1}
 * @example fanBounds(2, 90, 1, 1) // {x: -0.5, y: 0.5, w: 2, h: 1}
 */
export function fanBounds(count, fanAngle, hRatio, aspect) {
  const pivot = { x: 0.5, y: aspect * hRatio };
  const corners = [[0, 0], [1, 0], [1, aspect], [0, aspect]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const deg of fanAngles(count, fanAngle))
    for (const [x, y] of corners) {
      const p = rotatedAbout(x, y, pivot.x, pivot.y, deg);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. The fan laid out in the widget's LOCAL box (see the module
 * header's FIT-TO-BOX choice): fanBounds uniformly scaled to fit w×h and
 * centered. Returns the shared base-page rect (the same rect every sheet
 * occupies before its rotation), the shared pivot, and the per-page angles.
 * The base rect may poke outside the box — only its ROTATED instances are ink,
 * and those fit by construction.
 *
 * Args:
 *   w, h (number): the widget box, local units (> 0)
 *   count (number): pages in the fan (>= 1)
 *   fanAngle (number): half-spread, degrees
 *   hRatio (number): pivot depth in page heights below the page top
 *   aspect (number): page height / page width
 *
 * Returns:
 *   {pageX, pageY, pageW, pageH, pivotX, pivotY, angles} — angles in DEGREES
 *
 * @example peacockLayout(100, 100, 1, 0, 1, 1) // {pageX: 0, pageY: 0, pageW: 100, pageH: 100, pivotX: 50, pivotY: 100, angles: [0]}
 * @example peacockLayout(200, 100, 2, 90, 1, 1) // {pageX: 50, pageY: -50, pageW: 100, pageH: 100, pivotX: 100, pivotY: 50, angles: [-90, 90]}
 */
export function peacockLayout(w, h, count, fanAngle, hRatio, aspect) {
  const b = fanBounds(count, fanAngle, hRatio, aspect);
  const s = Math.min(w / b.w, h / b.h);
  const ox = -s * b.x + (w - s * b.w) / 2;
  const oy = -s * b.y + (h - s * b.h) / 2;
  return {
    pageX: ox, pageY: oy, pageW: s, pageH: s * aspect,
    pivotX: ox + s * 0.5, pivotY: oy + s * aspect * hRatio,
    angles: fanAngles(count, fanAngle),
  };
}

/**
 * Pure function. The fan trimmed to the pages a `realCount`-page document
 * actually has: `first` clamped into [1, realCount], `count` clamped so
 * first + count − 1 never exceeds realCount (and never below 1). `trimmed`
 * reports whether anything had to change — the caller's cue to be LOUD.
 * A count of Infinity means "real count unknown yet" (nothing to trim against).
 *
 * Args:
 *   requestedFirst (number): the (possibly equation-evaluated) first page, 1-based
 *   requestedCount (number): how many pages the fan asks for
 *   realCount (number): the document's page count, or Infinity if unknown
 *
 * Returns:
 *   {first: number, count: number, trimmed: boolean}
 *
 * @example clampFanCount(1, 8, 20) // {first: 1, count: 8, trimmed: false}
 * @example clampFanCount(1, 8, 5) // {first: 1, count: 5, trimmed: true}
 * @example clampFanCount(7, 4, 5) // {first: 5, count: 1, trimmed: true}
 * @example clampFanCount(1, 8, Infinity) // {first: 1, count: 8, trimmed: false}
 */
export function clampFanCount(requestedFirst, requestedCount, realCount) {
  const wantFirst = Number.isFinite(requestedFirst) ? Math.floor(requestedFirst) : 1;
  const wantCount = Number.isFinite(requestedCount) ? Math.floor(requestedCount) : 1;
  const first = Math.min(Math.max(1, wantFirst), realCount);
  const count = Math.max(1, Math.min(Math.max(1, wantCount), realCount - first + 1));
  return { first, count, trimmed: first !== wantFirst || count !== wantCount };
}

/**
 * Pure function. The point on the fan-angle ARC (center = pivot, radius r) at
 * `deg` degrees clockwise from straight UP — the fanAngle handle's track. 0° is
 * directly above the pivot (a closed fan), 90° level with it (a full splay).
 *
 * @example pointOnFanArc(0, 0, 10, 0) // {x: 0, y: -10}
 * @example pointOnFanArc(0, 0, 10, 90) // {x: 10, y: 0}
 */
export function pointOnFanArc(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/**
 * Pure function. The inverse of pointOnFanArc: the angle (degrees clockwise
 * from straight up, in (-180, 180]) at which a point sits around the pivot.
 * Radius is irrelevant — only the direction matters (the projection onto the
 * arc happens in `constrain`, which clamps this and re-evaluates the point).
 *
 * @example fanArcAngle(0, 0, 10, 0) // 90
 * @example fanArcAngle(0, 0, 0, -10) // 0
 * @example fanArcAngle(5, 5, 5, -5) // 0
 */
export function fanArcAngle(cx, cy, x, y) {
  return (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
}

/**
 * Pure function. The hRatio handle's y-position on the widget's centerline: the
 * [H_RATIO_MIN, H_RATIO_MAX] range mapped linearly onto the box height (top =
 * shallowest pivot, bottom = deepest). Anchored to the BOX rather than to the
 * fitted fan on purpose — writing hRatio re-fits the whole fan (fit-to-box), so
 * a fan-anchored track would slide out from under its own handle and break THE
 * HANDLE-CONSTRAINT PROTOCOL's round-trip law (tests/handle_constraints_test.js).
 *
 * Args:
 *   h (number): the widget box height, local units
 *   hRatio (number): pivot depth in [H_RATIO_MIN, H_RATIO_MAX]
 *
 * Returns:
 *   number: local y
 *
 * @example hRatioY(100, 0.5) // 0
 * @example hRatioY(100, 3) // 100
 * @example hRatioY(100, 1.75) // 50
 */
export function hRatioY(h, hRatio) {
  return (h * (hRatio - H_RATIO_MIN)) / (H_RATIO_MAX - H_RATIO_MIN);
}

/**
 * Pure function. The inverse of hRatioY, clamped into the legal range: which
 * hRatio a y-position on the centerline track denotes.
 *
 * Args:
 *   h (number): the widget box height, local units (> 0)
 *   y (number): local y on the track
 *
 * Returns:
 *   number: hRatio in [H_RATIO_MIN, H_RATIO_MAX]
 *
 * @example yToHRatio(100, 50) // 1.75
 * @example yToHRatio(100, 0) // 0.5
 * @example yToHRatio(100, 999) // 3 (clamped)
 */
export function yToHRatio(h, y) {
  const t = H_RATIO_MIN + (y / h) * (H_RATIO_MAX - H_RATIO_MIN);
  return Math.min(Math.max(t, H_RATIO_MIN), H_RATIO_MAX);
}

/**
 * Pure function. An axis-aligned rectangle as an SVG path string (the shadow
 * sheets' geometry — ir.js `path` with `blur` softens it into a drop shadow).
 * Uses only M/L/Z, the PDF-export-safe subset.
 *
 * @example rectPathD(0, 0, 10, 5) // "M0 0L10 0L10 5L0 5Z"
 * @example rectPathD(2, 3, 1, 1) // "M2 3L3 3L3 4L2 4Z"
 */
export function rectPathD(x, y, w, h) {
  return `M${x} ${y}L${x + w} ${y}L${x + w} ${y + h}L${x} ${y + h}Z`;
}

/**
 * Pure function. THE SHATTER GEOMETRY — one sheet of a fan as a free-standing
 * widget's stored transform, in WORLD units.
 *
 * The fan draws each sheet as `pushTransform(rotationAboutPivot(...))` over the
 * SHARED base rect; a shattered sheet has no such enclosing frame, so the same
 * pose has to be expressed in the terms a stored item owns: an unrotated box at
 * the base rect, plus `rotation`, plus a rotationAnchor at the SHARED PIVOT. That
 * pivot is the whole reason the anchor is written NUMERICALLY here rather than
 * left at the `self.anchors.center` default every other widget keeps — the pages
 * pivot about ONE point they all share, which is precisely the thing a per-item
 * self-center anchor cannot say. Written as numbers rather than as an equation
 * naming a sibling because the pivot is a POSITION, not a relationship: binding
 * it to one arbitrary sheet's anchor would make that sheet's deletion silently
 * re-pose the other seven.
 *
 * `rotation` is RADIANS (core stores radians; degrees are a DISPLAY unit —
 * web/displayUnits.js), which is why the layout's degrees are converted here and
 * not left for a caller to remember.
 *
 * Args:
 *   layout (object): peacockLayout's shape, in the host's LOCAL units
 *   i (number): the sheet's index into layout.angles (0 = the top sheet, page `first`)
 *   box ({x, y, w, h}): the host's WORLD box — local (0,0) lands at its origin
 *
 * Returns:
 *   {x, y, w, h, rotation, rotationAnchor: {x, y}} — a stored item's transform
 *
 * @example // an unrotated single-sheet fan is just the base rect, offset into the box
 * @example sheetTransform(peacockLayout(100, 100, 1, 0, 1, 1), 0, {x: 10, y: 20, w: 100, h: 100})
 * {"x":10,"y":20,"w":100,"h":100,"rotation":0,"rotationAnchor":{"x":60,"y":120}}
 * @example // the pivot is SHARED: every sheet of a fan reports the same anchor
 * @example sheetTransform(peacockLayout(200, 100, 2, 90, 1, 1), 1, {x: 0, y: 0, w: 200, h: 100}).rotationAnchor.x
 * 100
 * @example sheetTransform(peacockLayout(200, 100, 2, 90, 1, 1), 1, {x: 0, y: 0, w: 200, h: 100}).rotation
 * 1.5707963267948966
 */
export function sheetTransform(layout, i, box) {
  return {
    x: box.x + layout.pageX, y: box.y + layout.pageY,
    w: layout.pageW, h: layout.pageH,
    rotation: (layout.angles[i] * Math.PI) / 180,
    rotationAnchor: { x: box.x + layout.pivotX, y: box.y + layout.pivotY },
  };
}

/**
 * Query (reads the shared PDF caches — pdfPageCount / pdfPagePointSize — but
 * kicks nothing and mutates nothing; emit() owns the ensure* side effects).
 * The fan a STATE resolves to right now: its local layout, the trimmed
 * (first, count) page window, and whether trimming occurred. The one shared
 * geometry source for emit() and the modifier points, so handles always sit on
 * the geometry actually painted.
 *
 * Args:
 *   s (object): widget state ({w, h, src, firstPage, pageCount, fanAngle, hRatio})
 *
 * Returns:
 *   {layout, first, count, trimmed, src} — layout is peacockLayout's shape
 *
 * @example stateLayout({w: 100, h: 100, src: "", firstPage: 1, pageCount: 1, fanAngle: 0, hRatio: 1}).layout.pivotY // 100 (no src → DEFAULT_PAGE_ASPECT; at hRatio 1 the pivot is the page's bottom edge, which the fit puts at the box bottom)
 * @example stateLayout({w: 100, h: 100, src: "", firstPage: 1, pageCount: 3, fanAngle: 45, hRatio: 1.5}).count // 3
 * @example stateLayout({w: 100, h: 100, src: "", firstPage: 0, pageCount: 2, fanAngle: 0, hRatio: 1}).trimmed // true (firstPage 0 is not a page)
 */
export function stateLayout(s) {
  const src = typeof s.src === "string" && s.src.length > 0 ? s.src : null;
  const real = src ? pdfPageCount(src) : null;
  const fit = clampFanCount(s.firstPage ?? 1, s.pageCount ?? 1, real ?? Infinity);
  const point = src ? pdfPagePointSize(src, fit.first) : null;
  const aspect = point && point.w > 0 ? point.h / point.w : DEFAULT_PAGE_ASPECT;
  return {
    layout: peacockLayout(s.w, s.h, fit.count, s.fanAngle ?? 0, s.hRatio ?? 1, aspect),
    first: fit.first,
    count: fit.count,
    // Only a KNOWN real count makes a trim reportable against the document; a
    // bad firstPage/pageCount value alone (floor/min against Infinity) is too.
    trimmed: fit.trimmed,
    src,
  };
}

export const paperPeacockPlugin = {
  type: "paper_peacock",
  // CONVERGES: it draws an async raster (the fanned page rasters). settled.js owns what
  // “ready” means so this cannot drift from its thirteen siblings.
  // CONVERGES: it draws async rasters (one per fanned page). BY NAMESPACE, not by
  // exact ref: the pdfPageRef scale is derived inside emit() from the live camera,
  // which a settled(state) predicate never sees — see convergesOnRefPrefixes for
  // the measured defect this replaces (`s.__pdfRef` was never assigned by
  // anything, so this widget declared itself permanently settled).
  ephemeral: convergesOnRefPrefixes(["pdfpage:"]),
  title: "Paper Peacock",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // DOUBLE-CLICK ACTIVATION: open the asset picker on `src`, exactly like
  // pdf_page/image/video (web/widget_handlers.js reads these two declarations).
  activate: "asset_picker",
  primaryAsset: "src",
  defaults: {
    type: "paper_peacock", x: 100, y: 100, w: 520, h: 340, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an
    // equation) — identical to pdf_page.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    src: NO_SRC,
    firstPage: 1, // 1-based first sheet of the fan, equation-capable
    pageCount: 8, // sheets in the fan (the reference's N=8 default)
    fanAngle: 45, // half-spread, degrees — pages span [-fanAngle, +fanAngle]
    hRatio: 1.5, // pivot depth, page heights below the page top (reference default)
    shadowBlur: 0.2, // shadow blur as a FRACTION of page width (reference: pageW/5)
    shadowOpacity: 0.5, // reference: black at 50%
    shadowDx: 0.2, // shadow x-offset as a fraction of the blur (reference: 0.2·blur)
    shadowDy: 0.2, // shadow y-offset as a fraction of the blur
    ...defaults("rasterDensity", "opacity"), // rasterDensity:1 (= today's automatic density), opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("transform"),
    ...props("src", { src: { label: "PDF", assetKinds: ["pdf"], help: "The PDF whose pages fan out — pick from the project's assets, upload a file, or drag one in from the Asset Explorer or Finder." } }),
    { key: "firstPage", label: "First page", kind: "number", min: 1, max: (state) => pdfPageCount(state.src) ?? null, category: "formatting", help: "The 1-based page the fan starts at (the sheet drawn ON TOP). Out-of-range values are clamped to the nearest real page and reported in the console." },
    { key: "pageCount", label: "Pages", kind: "number", min: 1, category: "formatting", help: "How many consecutive pages the fan shows. Trimmed (loudly) to the pages the PDF actually has." },
    // NO knob cap on either: the layout fits-to-box, so past 90 (sheets flipping)
    // or outside 0.5..3 (pivot above center) is just a different — still valid —
    // fan, not a degeneracy. The FAN_ANGLE_*/H_RATIO_* constants still bound the
    // ON-CANVAS handle tracks (a screen-reach limit), which is a separate constraint.
    { key: "fanAngle", label: "Fan angle", kind: "number", min: FAN_ANGLE_MIN, category: "formatting", help: "Half-spread of the fan in degrees: the pages rotate evenly across ±this angle. 0 stacks them; 90 splays a full half-circle; past 90 the sheets flip over (no upper cap). Drag the yellow arc handle on canvas to set it." },
    { key: "hRatio", label: "Pivot depth", kind: "number", category: "formatting", help: "Where the shared pivot sits, in page heights below each page's top edge: 1 = the page's bottom edge, above 1 fans out with a gap below the sheets, 0.5 = the page center, below 0.5 pivots above center for an upside-down fan (no bounds — the fan re-fits to the box at any value). Drag the yellow handle on the centerline to set it." },
    { key: "shadowBlur", label: "Sheet shadow blur", kind: "number", min: 0, category: "formatting", help: "Each sheet's drop-shadow blur, as a fraction of the page width (0.2 = the reference figure's look; 0 = no shadow)." },
    { key: "shadowOpacity", label: "Sheet shadow opacity", kind: "number", min: 0, max: 1, category: "formatting", help: "Each sheet's drop-shadow darkness, 0 (none) to 1 (solid black)." },
    { key: "shadowDx", label: "Sheet shadow offset X", kind: "number", category: "formatting", help: "The shadow's horizontal offset, as a fraction of the blur radius (positive = right)." },
    { key: "shadowDy", label: "Sheet shadow offset Y", kind: "number", category: "formatting", help: "The shadow's vertical offset, as a fraction of the blur radius (positive = down)." },
    ...props("rasterDensity"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (kicks idempotent async PDF loads/rasterizations and
   * reportOnce's a trimmed fan; the RETURNED IR is a pure function of state +
   * the caches' current answers — the pdf_page emit contract). State →
   * display-list commands in LOCAL space.
   *
   * Per sheet, DEEPEST FIRST (command order is z-order, so the last-emitted
   * sheet — page `firstPage` — lands on top):
   *   pushTransform(rotation about the shared pivot)
   *     → blurred black rect path (the sheet's own drop shadow)
   *     → whole-page raster image op (async; nothing until the bitmap lands)
   *   popTransform
   * Shadows draw even with no/loading PDF (see the module header); the whole
   * op list then wraps in the universal effects bundle over the widget box.
   */
  emit(s, _targetWorldIR, world, renderCtx) {
    if (!(s.w > 0) || !(s.h > 0)) return [];
    const { layout: L, first, count, trimmed, src } = stateLayout(s);
    if (src) {
      ensurePdfDoc(src); // idempotent; safe every emit()
      ensurePdfPagePointSize(src, first); // fills the aspect for a LATER emit()
      const real = pdfPageCount(src);
      if (trimmed && real != null)
        reportOnce(
          `paper_peacock:range:${src}:${s.firstPage}:${s.pageCount}`,
          `PowerRP paper_peacock: pages ${s.firstPage}..${(s.firstPage ?? 1) + (s.pageCount ?? 1) - 1} do not all exist in "${src}" (${real} page${real === 1 ? "" : "s"}) — fanning pages ${first}..${first + count - 1} instead.`,
        );
    }
    const opacity = s.opacity ?? 1;
    const blur = (s.shadowBlur ?? 0) * L.pageW;
    const shadowOpacity = (s.shadowOpacity ?? 0) * opacity;
    // Device px per world unit — the pdf_page precedent, times the author's own
    // `rasterDensity` multiplier (core/properties.js has the full reasoning for
    // why it multiplies rather than naming an absolute DPI). Absent ⇒ 1 ⇒ the
    // computed scale, its rounded cache key and the pixels are byte-identical to
    // before this knob existed.
    const density = (world?.scale ?? 1) * PEACOCK_RASTER_DENSITY * (s.rasterDensity ?? 1);
    const ops = [];
    for (let i = count - 1; i >= 0; i--) { // deepest sheet first → page `first` on top
      ops.push(pushTransform(rotationAboutPivot(L.pivotX, L.pivotY, L.angles[i])));
      if (blur > 0 && shadowOpacity > 0)
        ops.push(path({
          d: rectPathD(L.pageX + (s.shadowDx ?? 0) * blur, L.pageY + (s.shadowDy ?? 0) * blur, L.pageW, L.pageH),
          fill: SHADOW_INK, opacity: shadowOpacity, blur,
        }));
      if (src) {
        const page = first + i;
        const point = pdfPagePointSize(src, page);
        ensurePdfPagePointSize(src, page); // idempotent; measures for a later emit()
        // pdfjs scale = (local px this sheet spans · density) / (PDF points that
        // fills); density alone until the point size is known — self-corrects.
        const scale = point && point.w > 0 ? (L.pageW * density) / point.w : density;
        // INTERACTION LOD: while a gesture is live this asks for NO new raster and
        // returns whatever scale is already resident — the fix for "It's laggy to
        // drag around", which on this widget cost one pdf.js render per SHEET per
        // scale bucket. Null means this page has no raster at all yet, and only
        // then does a sheet draw as blank paper.
        const ref = pdfPageRasterRefForDisplay(src, page, scale, renderCtx?.interactive !== false);
        ops.push(ref
          ? image({ ref, x: L.pageX, y: L.pageY, w: L.pageW, h: L.pageH, opacity })
          : path({ d: rectPathD(L.pageX, L.pageY, L.pageW, L.pageH), fill: PDF_PLACEHOLDER_PAPER, opacity }));
      }
      ops.push(popTransform());
    }
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w, h: s.h });
  },
  /** Pure function. BOUNDS protocol: the fan is scaled to exactly fit the box
   *  (peacockLayout), so the widget's ink IS the box. */
  localBounds(s) {
    return { x: 0, y: 0, w: s.w, h: s.h };
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  /**
   * Pure function. TWO modifier points, THE HANDLE-CONSTRAINT PROTOCOL
   * (donut.js's shape). BOTH tracks are anchored to the widget BOX, not to the
   * fitted fan: writing either parameter re-fits the whole fan (the FIT-TO-BOX
   * choice), so a fan-anchored track would slide out from under its own handle
   * the moment it wrote — violating the protocol's round-trip law ("apply puts
   * the handle AT allowed", tests/handle_constraints_test.js). The box is
   * invariant under both writes, so these round-trip exactly.
   *
   *   "fanAngle" — rides the ARC centered at the box's bottom-center, radius
   *     h/2, at fanAngle degrees clockwise from straight up (0° = box center,
   *     90° = level with the pivot side). `constrain` projects a desired point
   *     radially onto that arc's [FAN_ANGLE_MIN, FAN_ANGLE_MAX] sweep — the
   *     metric projection onto an arc segment; `apply` reads the allowed
   *     point's arc angle back as fanAngle.
   *
   *   "hRatio" — drags the vertical CENTERLINE of the box, [H_RATIO_MIN,
   *     H_RATIO_MAX] mapped linearly top→bottom (hRatioY). `constrain` projects
   *     onto that segment; `apply` reads the y back as hRatio (yToHRatio).
   */
  modifierPoints(s) {
    const arcC = { x: s.w / 2, y: s.h }; // the box's bottom-center — the fan opens upward from here
    const arcR = s.h / 2;
    const fanDeg = Math.min(Math.max(s.fanAngle ?? 0, FAN_ANGLE_MIN), FAN_ANGLE_MAX);
    const arcPos = pointOnFanArc(arcC.x, arcC.y, arcR, fanDeg);
    return [
      {
        id: "fanAngle",
        x: arcPos.x,
        y: arcPos.y,
        constrain(state, desired) {
          const deg = Math.min(Math.max(fanArcAngle(state.w / 2, state.h, desired.x, desired.y), FAN_ANGLE_MIN), FAN_ANGLE_MAX);
          return pointOnFanArc(state.w / 2, state.h, state.h / 2, deg);
        },
        apply(state, allowed) {
          return { fanAngle: Math.min(Math.max(fanArcAngle(state.w / 2, state.h, allowed.x, allowed.y), FAN_ANGLE_MIN), FAN_ANGLE_MAX) };
        },
      },
      {
        id: "hRatio",
        x: s.w / 2,
        y: hRatioY(s.h, Math.min(Math.max(s.hRatio ?? H_RATIO_MIN, H_RATIO_MIN), H_RATIO_MAX)),
        constrain(state, desired) {
          return closestPointOnSegment(
            { x: state.w / 2, y: hRatioY(state.h, H_RATIO_MIN) },
            { x: state.w / 2, y: hRatioY(state.h, H_RATIO_MAX) },
            desired,
          );
        },
        apply(state, allowed) {
          // A zero-height box has no track to read a ratio off — a technical
          // division guard, not a bound on hRatio (the donut precedent).
          if (!(state.h > 0)) return { hRatio: H_RATIO_MIN };
          return { hRatio: yToHRatio(state.h, allowed.y) };
        },
      },
    ];
  },
  /**
   * Pure function (two cache reads). Why this fan cannot be shattered YET, or
   * null. Cheap on purpose — it is a command GATE, re-evaluated on every palette
   * render (core/shatter.js shatterNotReadyReason).
   *
   * TWO conditions, and the second is the one that earns this hook. A fan with no
   * PDF has nothing to become. But a fan whose PDF has not OPENED yet is worse
   * than empty: `stateLayout` falls back to DEFAULT_PAGE_ASPECT and to the
   * REQUESTED page count, so shattering then would bake US-Letter proportions and
   * an untrimmed page window into eight permanent items — silently wrong, and
   * wrong in a way the author would have to undo rather than notice. Waiting for
   * `pdfPageCount` costs a moment; not waiting costs a re-do.
   *
   * @example paperPeacockPlugin.shatterNotReady({src: ""})
   * 'a PDF chosen — an empty peacock has no sheets to shatter into'
   */
  shatterNotReady(s) {
    const src = typeof s.src === "string" && s.src.length > 0 ? s.src : null;
    if (!src) return "a PDF chosen — an empty peacock has no sheets to shatter into";
    if (pdfPageCount(src) === null)
      return "a PDF that has finished opening (its page count and page size are not known yet, and shattering now would bake in guesses)";
    return null;
  },
  /**
   * Pure function. THE FAN, BECOME ITS SHEETS: one `pdf_page` widget per sheet,
   * each posed exactly where the fan drew it.
   *
   * ── WHY `pdf_page` AND NOT A RASTER ──────────────────────────────────────────
   * core/shatter.js's whole argument is fidelity versus EDITABILITY: an image
   * floor is always available and always useless. Here the native widget is
   * exact — a peacock sheet IS a whole-page PDF raster at a rect, which is
   * literally what `pdf_page` emits — so every part comes back as vector-grade
   * editable content and `vectorRecovery` is 1. Nothing is approximated, so
   * nothing is disclosed as raster.
   *
   * ── WHAT EACH SHEET CARRIES ──────────────────────────────────────────────────
   *   · its POSE — the shared base rect plus its own rotation about the SHARED
   *     pivot, via `sheetTransform` (see there for why the anchor is numeric).
   *   · its SHADOW — the fan's baked shadow rect becomes the sheet's own
   *     `effects` shadow bundle, in the units that bundle wants (the fan stores
   *     blur as a FRACTION of page width and the offsets as fractions of the
   *     blur; a stored item stores canvas units). This is a real gain in
   *     editability: eight shadows that could only move together become eight
   *     that can be tuned one at a time.
   *   · its Z — parts are written in plan order with RISING z (core/shatter.js
   *     shatteredDocument), and the fan draws DEEPEST FIRST, so the plan is
   *     emitted deepest-first too and page `first` lands on top exactly as it
   *     did before. Back-to-front is preserved by ordering, not by a z field.
   *
   * The host's own `opacity` is NOT pushed onto the sheets: it survives on the
   * GROUP (retype RULE 1 fills the group's own keys), so the group still fades
   * the fan as one — pushing it down as well would square it.
   *
   * NEITHER IS `rasterDensity`, and that is a decision rather than an omission.
   * It is not a `pdf_page` property, so copying it across would write a key the
   * receiving plugin never reads — a dormant value that looks like a working
   * control and silently does nothing. A shattered sheet gets its resolution
   * from pdf_page's OWN density story instead (`renderMode` + rasterWidth/
   * rasterHeight/rasterDPI), which is richer than the multiplier and is the
   * reason pdf_page was deliberately left off the shared row.
   *
   * @param {object} s - the item's evaluated state
   * @param {{box: {x, y, w, h}}} ctx - the host's WORLD box; sheets are placed in it
   * @returns {{parts: Array<{key: string, label: string, state: object}>, notes: string[]}}
   */
  shatter(s, ctx) {
    const { layout, first, count, src } = stateLayout(s);
    if (!src) throw new Error("Paper Peacock: no PDF is chosen, so there are no sheets to shatter into.");
    // The fan is fitted to the host's LOCAL box; ctx.box is the host's WORLD box.
    // Re-fit to the world box so the sheets land where they are drawn even when
    // the host carries a scale (the mermaid/svg precedent: ctx.box is the frame).
    const worldLayout = peacockLayout(
      ctx.box.w, ctx.box.h, count, s.fanAngle ?? 0, s.hRatio ?? 1,
      layout.pageH / layout.pageW,
    );
    const blur = (s.shadowBlur ?? 0) * worldLayout.pageW;
    const shadow = {
      blur,
      dx: (s.shadowDx ?? 0) * blur,
      dy: (s.shadowDy ?? 0) * blur,
      color: SHADOW_INK,
      opacity: s.shadowOpacity ?? 0,
    };
    const parts = [];
    for (let i = count - 1; i >= 0; i--) { // DEEPEST FIRST — rising z restores page `first` on top
      const page = first + i;
      parts.push({
        key: partKey(`sheet${page}`),
        label: `page ${page}`,
        state: { type: "pdf_page", src, page, ...sheetTransform(worldLayout, i, ctx.box), shadow },
      });
    }
    return { parts, notes: [] };
  },
  presets: [
    {
      name: "Classic ±45°",
      description: "The MotionV2V hero look: eight sheets fanned across ±45°, pivot half a page below them, soft down-right shadows.",
      props: { pageCount: 8, fanAngle: 45, hRatio: 1.5, shadowBlur: 0.2, shadowOpacity: 0.5, shadowDx: 0.2, shadowDy: 0.2 },
    },
    {
      name: "Tight fan ±20°",
      description: "A restrained spread — the sheets mostly overlap, like a hand of cards barely opened.",
      props: { fanAngle: 20, hRatio: 1.2 },
    },
    {
      name: "Full splay ±80° low pivot",
      description: "Nearly a half-circle with the pivot close to the sheets, so they wheel around it like a paper turbine.",
      props: { fanAngle: 80, hRatio: 0.8 },
    },
    {
      name: "Subtle shadow",
      description: "Keeps the current fan but drops the shadows to a faint, close-set haze.",
      props: { shadowBlur: 0.08, shadowOpacity: 0.25, shadowDx: 0.15, shadowDy: 0.15 },
    },
  ],
  commands: [
    { id: "add-paper-peacock", title: "Add Paper Peacock", icon: "mdi:feather", run: (app) => app.armCrosshairPlacement(paperPeacockPlugin) }, // crosshair bbox placement, the donut/pdf_page pattern
  ],
};
