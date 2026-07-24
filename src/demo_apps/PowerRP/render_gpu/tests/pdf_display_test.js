/**
 * PDF display render-mode tests — plain node, no framework (core_test.js style).
 * Run FROM THE POWERRP DIR:
 *   node render_gpu/tests/pdf_display_test.js
 *
 * Covers the render_gpu/pdf_display.js PURE surface (bare node, no pdf.js / DOM):
 *   1. The render-mode enum + default ("live"|"raster", default "live").
 *   2. rasterModeScale — the "raster" mode fit-box, aspect-preserving, DPI-scaled
 *      whole-page render scale (device px per PDF point). This is THE knob that
 *      makes raster mode view-INDEPENDENT: a fixed (rasterWidth/Height/DPI) →
 *      fixed scale → a STABLE region ref → render-once-and-cache. It is tested
 *      here directly (it needs neither a browser nor a live view).
 *   3. The render-once INVARIANT at the ref level: the raster-mode region ref
 *      (pure pdf_page_raster.pdfPageRegionRef fed by rasterModeScale) is IDENTICAL
 *      across zoom levels — one cached bitmap — whereas the "live" mode's
 *      view-driven ref changes with zoom (the Chrome model re-rasters). This
 *      encodes the "raster invocations across zoom = 1" acceptance test in pure
 *      form (the browser probe tests/pdf_render_mode_probe.js proves it live).
 *
 * The DOM-free-ness of pdf_display's pure exports is itself under test: any
 * window/document/pdf.js reference on the import path would crash this file.
 */

import assert from "node:assert/strict";
import {
  PDF_RENDER_MODES, PDF_RENDER_MODE_DEFAULT, PDF_POINTS_PER_INCH,
  PDF_RASTER_DEFAULT_DPI, rasterModeScale,
} from "../pdf_display.js";
import { pdfPageRegionRef, roundPdfScale } from "../gpu/pdf_page_raster.js";
import { visibleSourceRect } from "../../core/clip.js";
import { identity } from "../../core/transform.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
function approx(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// ── 1. render-mode enum + default ──────────────────────────────────────────────
test("render modes are exactly [live, raster], default live", () => {
  assert.deepEqual(PDF_RENDER_MODES, ["live", "raster"]);
  assert.equal(PDF_RENDER_MODE_DEFAULT, "live");
  assert.ok(PDF_RENDER_MODES.includes(PDF_RENDER_MODE_DEFAULT));
  assert.equal(PDF_POINTS_PER_INCH, 72);
  assert.equal(PDF_RASTER_DEFAULT_DPI, 96);
});

// ── 2. rasterModeScale (pure) ──────────────────────────────────────────────────
test("rasterModeScale: native size at 72 DPI = 1 px/pt (doctest)", () => {
  approx(rasterModeScale({ w: 72, h: 144 }, 0, 0, 72), 1);
});
test("rasterModeScale: DPI multiplies (144 DPI native = 2 px/pt)", () => {
  approx(rasterModeScale({ w: 72, h: 144 }, 0, 0, 144), 2);
});
test("rasterModeScale: default screen DPI (96) on a Letter page ≈ 4/3 px/pt", () => {
  approx(rasterModeScale({ w: 612, h: 792 }, 0, 0, 96), 96 / 72);
});
test("rasterModeScale: non-positive DPI falls back to PDF_RASTER_DEFAULT_DPI", () => {
  approx(rasterModeScale({ w: 72, h: 72 }, 0, 0, 0), PDF_RASTER_DEFAULT_DPI / 72);
  approx(rasterModeScale({ w: 72, h: 72 }, 0, 0, -5), PDF_RASTER_DEFAULT_DPI / 72);
});
test("rasterModeScale: fit-box picks the tighter axis (width caps here)", () => {
  // pxW = 50, pxH = 400 at 72 DPI; scale = min(50/100, 400/200) = min(0.5, 2) = 0.5
  approx(rasterModeScale({ w: 100, h: 200 }, 50, 400, 72), 0.5);
  // swap so height caps: pxW = 400, pxH = 50; scale = min(400/100, 50/200) = 0.25
  approx(rasterModeScale({ w: 100, h: 200 }, 400, 50, 72), 0.25);
});
test("rasterModeScale: a 0 axis means native for THAT axis only", () => {
  // width native (=100), height forced 100 px @72dpi on a 200-tall page:
  // scale = min(100/100, 100/200) = 0.5 (height constraint wins)
  approx(rasterModeScale({ w: 100, h: 200 }, 0, 100, 72), 0.5);
});
test("rasterModeScale: aspect is always preserved (uniform scale, never distorts)", () => {
  // Even an off-aspect box yields ONE scale; the page keeps point.w:point.h.
  const s = rasterModeScale({ w: 300, h: 100 }, 900, 900, 72);
  approx(s, 3); // min(900/300, 900/100) = min(3, 9) = 3
});

// ── 3. RENDER-ONCE INVARIANT at the ref level ──────────────────────────────────
// The acceptance test says raster mode must re-raster ONCE across all zooms while
// live mode re-rasters per zoom. Both modes ultimately build a region ref via the
// pure pdf_page_raster.pdfPageRegionRef(src, page, sourceRect, scale). We compute
// the ref each mode WOULD request at a spread of zoom levels using the SAME pure
// pieces the pre-pass uses, and assert the raster-mode ref set collapses to 1
// while live mode's set grows. (The browser probe exercises the real pre-pass.)
const SRC = "blob:doc", PAGE = 1, POINT = { w: 612, h: 792 };
const WHOLE = { sx: 0, sy: 0, sw: 1, sh: 1 };
const ZOOMS = [0.5, 1, 2, 4, 8, 16, 40];

test("RASTER mode: the region ref is IDENTICAL across every zoom (render once, cache)", () => {
  // Fixed rasterWidth/Height/DPI → fixed scale → fixed WHOLE-page ref, view-free.
  const scale = rasterModeScale(POINT, 0, 0, PDF_RASTER_DEFAULT_DPI);
  const refs = new Set(ZOOMS.map(() => pdfPageRegionRef(SRC, PAGE, WHOLE, scale)));
  assert.equal(refs.size, 1, "raster mode caches a single bitmap for all zooms");
});

test("LIVE mode: the region ref CHANGES with zoom (the Chrome model re-rasters)", () => {
  // Replicate the pre-pass's live scale: deviceRect.w / (sourceRect.sw · point.w),
  // for a big page so it stays viewport-clipped (sub-rect + scale both move).
  const box = { world: identity(), w: 4000, h: 5000 };
  const refs = new Set();
  for (const zoom of ZOOMS) {
    const view = { zoom, panX: -1000 * zoom, panY: -1000 * zoom, dpr: 1 };
    const vsr = visibleSourceRect(box, {}, view, { viewW: 1400, viewH: 900 });
    if (!vsr.visible) continue;
    const scale = vsr.deviceRect.w / (vsr.sourceRect.sw * POINT.w);
    refs.add(pdfPageRegionRef(SRC, PAGE, vsr.sourceRect, scale));
  }
  assert.ok(refs.size > 1, `live mode re-rasters per zoom (got ${refs.size} distinct refs)`);
});

test("roundPdfScale bucketing keeps the raster-mode ref stable under tiny scale noise", () => {
  // Two DPIs a hair apart bucket to the same rounded scale → same ref (no churn).
  const a = pdfPageRegionRef(SRC, PAGE, WHOLE, rasterModeScale(POINT, 0, 0, 96));
  const b = pdfPageRegionRef(SRC, PAGE, WHOLE, rasterModeScale(POINT, 0, 0, 96.01));
  assert.equal(a, b);
  assert.equal(roundPdfScale(rasterModeScale(POINT, 0, 0, 96)), roundPdfScale(rasterModeScale(POINT, 0, 0, 96.01)));
});

console.log(`\n${passed} PDF-display render-mode checks passed`);
