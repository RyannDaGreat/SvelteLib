/**
 * Bare-node gate — THE ASK-VS-GOT LAW for PDF rasters:
 *
 *   the scale pdf.js is asked to render at and the size of the canvas it renders
 *   into MUST come from the same number.
 *
 * When they do not, clamping the canvas does not shrink the picture, it TRUNCATES
 * it: pdf.js draws through its viewport's transform, so the canvas receives the
 * page's top-left corner and the rest falls off. The region bitmap is then
 * stretched into the widget's box, so the user sees a fraction of the page blown
 * up to fill the frame — with no error, because a clamp is not a failure.
 *
 * Measured before the fix, using the real rasterModeScale + clampDim: a US-Letter
 * page in "raster" render mode at rasterDPI 600 asked for 5080x6574 px, got a
 * 4096x4096 canvas, and so lost 19.4% of its width and 37.7% of its height. At
 * rasterDPI 1200 it lost 35.3% and 50.0%. Both are ordinary Inspector values on an
 * ordinary page — this needed no extreme zoom to reach.
 *
 * The test asserts the law directly rather than restating the fixed numbers: for a
 * sweep of DPIs it recomputes what the module would allocate and requires the
 * requested extent to FIT the canvas it would get. It is a pure-function test, so
 * it runs in bare node with no browser.
 *
 * Run: node render_gpu/tests/pdf_raster_fit_test.js
 */
import { rasterModeScale } from "../pdf_display.js";
import {
  clampDim, roundPdfScale, PDF_MAX_RASTER_DIM, PDF_MAX_DEVICE_DIM,
} from "../gpu/pdf_page_raster.js";
// The fit factor moved to core/clip.js when a SECOND consumer appeared — the backdrop
// materials, whose surfaces hit the identical ask-vs-got defect against MAX_SURFACE_DIM
// (render_gpu/tests/backdrop_fit_test.js is the other half of this law).
import { rasterFitFactor } from "../../core/clip.js";

let failures = 0;
const check = (ok, what) => {
  if (!ok) { failures++; console.log(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`);
};

/** US Letter, the size every rasterDPI case below is computed against. */
const LETTER = { w: 612, h: 792 };

/** A tall, narrow page — so the law is not accidentally satisfied by width alone. */
const SLIVER = { w: 200, h: 1400 };

/**
 * Pure function. Replays exactly what ensurePdfPageRegionRasterized computes for an
 * UNCROPPED region: the capped device scale, the fit-corrected raster scale, and
 * the canvas edges that follow. Mirrors the module's arithmetic using the module's
 * OWN exported helpers, so it cannot drift into agreeing with a stale copy of it.
 *
 * @example // regionPlan({w: 612, h: 792}, 1.33).canvas // {w: 815, h: 1055}
 */
function regionPlan(point, requestedScale) {
  const rounded = roundPdfScale(requestedScale);
  const deviceScale = Math.min(rounded, PDF_MAX_DEVICE_DIM / Math.max(point.w, point.h));
  const rasterScale = deviceScale * rasterFitFactor(point.w * deviceScale, point.h * deviceScale, PDF_MAX_RASTER_DIM);
  return {
    rasterScale,
    want: { w: point.w * rasterScale, h: point.h * rasterScale },
    canvas: { w: clampDim(Math.round(point.w * rasterScale)), h: clampDim(Math.round(point.h * rasterScale)) },
  };
}

console.log("pdf raster ask-vs-got:");

// THE LAW, over the whole reachable rasterDPI range of the "raster" render mode.
for (const point of [LETTER, SLIVER]) {
  for (const dpi of [96, 150, 300, 600, 1200, 2400]) {
    const plan = regionPlan(point, rasterModeScale(point, 0, 0, dpi));
    // Rounding may cost at most half a pixel per edge; anything more is truncation.
    const fitsW = plan.want.w <= plan.canvas.w + 0.5;
    const fitsH = plan.want.h <= plan.canvas.h + 0.5;
    check(fitsW && fitsH,
      `${point.w}x${point.h}pt @${dpi}dpi: asks ${plan.want.w.toFixed(0)}x${plan.want.h.toFixed(0)} px, canvas ${plan.canvas.w}x${plan.canvas.h} — the whole region fits`);
  }
}

// The cap must DOWNSCALE, never exceed the ceiling.
for (const point of [LETTER, SLIVER]) {
  const plan = regionPlan(point, rasterModeScale(point, 0, 0, 2400));
  check(plan.canvas.w <= PDF_MAX_RASTER_DIM && plan.canvas.h <= PDF_MAX_RASTER_DIM,
    `${point.w}x${point.h}pt @2400dpi: canvas ${plan.canvas.w}x${plan.canvas.h} stays within the ${PDF_MAX_RASTER_DIM}px ceiling`);
}

// Aspect must survive the cap — one factor scales both edges, so the ratio is fixed.
{
  const uncapped = regionPlan(LETTER, rasterModeScale(LETTER, 0, 0, 96));
  const capped = regionPlan(LETTER, rasterModeScale(LETTER, 0, 0, 2400));
  const a = uncapped.want.w / uncapped.want.h, b = capped.want.w / capped.want.h;
  check(Math.abs(a - b) < 1e-9, `aspect is preserved through the cap (${a.toFixed(6)} vs ${b.toFixed(6)})`);
}

// rasterFitFactor itself: it is the shared primitive, so pin its contract.
check(rasterFitFactor(800, 600, 4096) === 1, "rasterFitFactor is exactly 1 when the request already fits");
check(rasterFitFactor(8192, 1000, 4096) === 0.5, "rasterFitFactor is decided by the LARGEST edge (wide)");
check(rasterFitFactor(1000, 8192, 4096) === 0.5, "rasterFitFactor is decided by the LARGEST edge (tall)");

console.log(failures ? `\nFAIL: ${failures} check(s) failed` : "\nPASS: pdf raster ask-vs-got");
process.exit(failures ? 1 : 0);
