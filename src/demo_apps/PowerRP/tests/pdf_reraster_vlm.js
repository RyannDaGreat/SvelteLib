/**
 * FLAGSHIP VLM harness — PDF display RE-RASTER at display resolution (manifest
 * RENDER PIVOT 2026-07-23). Drives the REAL editor over the dev server: places a
 * PDF page, zooms in ~8×, and captures the transition from the (pixelated)
 * whole-page base raster to the (crisp) visible-region re-raster — proof the
 * pixelation is gone. Also captures a CROP case (only the visible∩crop region
 * rasterizes).
 *
 * Run (dev server must be up):
 *   node tests/pdf_reraster_vlm.js [http://localhost:3637] [/asset/<proj>/<file.pdf>] [page]
 *
 * Screenshots → POWERRP/.claude_vlm_checks/:
 *   pdf_reraster_zoom_before.png  (base raster at 8× — pixelated, the OLD look)
 *   pdf_reraster_zoom.png         (region re-raster at 8× — crisp, the fix)
 *   pdf_reraster_crop.png         (crop case — only the visible∩crop region)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks");
const URL = process.argv[2] || "http://localhost:3637";
const SRC = process.argv[3] || "/asset/Untitled/Delta%20Denoising%20Score.pdf";
const PAGE = Number(process.argv[4] ?? 1);

const ZOOM = 8; // the reported pixelation zoom (~8×)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const el = await page.$("canvas.scene");
  await el.screenshot({ path: path.join(SHOTS, name) });
  console.log(`  wrote ${name}`);
}

async function main() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 20000 });

  // Place a PDF page widget (letter-ish box) at world (100,100).
  const box = await page.evaluate((src, pg) => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("pdf_page").defaults;
    const w = 612, h = 792, x = 100, y = 100;
    app.addItem({ ...defaults, src, page: pg, x, y, w, h });
    return { x, y, w, h };
  }, SRC, PAGE);

  // Wait for the doc to open + the whole-page base raster to land (35 MB paper —
  // be generous). The base is what makes the "before" shot show something.
  await sleep(6000);

  // BEFORE: DISABLE the re-raster (the OLD behavior — whole-page raster scaled
  // up), then zoom ~8× on the page's TOP (title/abstract text — the crispness
  // tell). This is exactly what shipped before the pivot: a stale low-res bitmap
  // magnified → pixelation.
  await page.evaluate((box, zoom) => {
    window.__powerrp_noPdfReraster = true;
    const app = window.__powerrp_app;
    const a = app.canvasActions;
    const rect = document.querySelector(".render-area").getBoundingClientRect();
    const wx = box.x + box.w * 0.5;      // horizontal center of the page
    const wy = box.y + box.h * 0.12;     // ~12% down = title/abstract band
    a.setViewport({ zoom, panX: rect.width / 2 - wx * zoom, panY: rect.height / 2 - wy * zoom });
  }, box, ZOOM);
  await sleep(3000);
  await shot(page, "pdf_reraster_zoom_before.png");

  // AFTER: RE-ENABLE the re-raster and nudge a fresh paint (a hair-different
  // zoom forces a new viewport event → the pre-pass runs → the visible-region
  // raster lands, onImageLoad wakes the repaint) → crisp.
  await page.evaluate((box, zoom) => {
    window.__powerrp_noPdfReraster = false;
    const app = window.__powerrp_app;
    const a = app.canvasActions;
    const rect = document.querySelector(".render-area").getBoundingClientRect();
    const z = zoom * 1.0001;
    const wx = box.x + box.w * 0.5, wy = box.y + box.h * 0.12;
    a.setViewport({ zoom: z, panX: rect.width / 2 - wx * z, panY: rect.height / 2 - wy * z });
  }, box, ZOOM);
  await sleep(5000);
  await shot(page, "pdf_reraster_zoom.png");

  // CROP case: crop the widget hard on every side, reset to a moderate zoom that
  // shows the whole cropped box, and confirm ONLY the visible∩crop region shows.
  await page.evaluate((box) => {
    const app = window.__powerrp_app;
    const id = app.selection;
    app.setPreview([
      [["items", id, "cropLeft"], box.w * 0.25],
      [["items", id, "cropRight"], box.w * 0.25],
      [["items", id, "cropTop"], box.h * 0.15],
      [["items", id, "cropBottom"], box.h * 0.55],
    ]);
    app.commitPreview();
    const a = app.canvasActions;
    const rect = document.querySelector(".render-area").getBoundingClientRect();
    const wx = box.x + box.w * 0.5, wy = box.y + box.h * 0.3, zoom = 2;
    a.setViewport({ zoom, panX: rect.width / 2 - wx * zoom, panY: rect.height / 2 - wy * zoom });
  }, box);
  await sleep(4000);
  await shot(page, "pdf_reraster_crop.png");

  // MAGNIFIER-OVER-PDF (user CRITICAL acid test): clear the crop, view the whole
  // page (~fit), drop a supersample magnifier (4×) over the title, and confirm
  // the MAGNIFIED PDF region is CRISP — not an upscaled base-res bitmap. The
  // pre-pass boosts the covered page's raster scale by the lens magnification, so
  // the lens re-render draws a dense bitmap → crisp, exactly like text/vectors.
  await page.evaluate((box) => {
    window.__powerrp_noPdfReraster = false;
    const app = window.__powerrp_app;
    const pdfId = app.selection;
    app.setPreview([
      [["items", pdfId, "cropLeft"], 0], [["items", pdfId, "cropRight"], 0],
      [["items", pdfId, "cropTop"], 0], [["items", pdfId, "cropBottom"], 0],
    ]);
    app.commitPreview();
    // Fit the whole page into view.
    app.canvasActions.zoomToFit({ x: box.x, y: box.y, w: box.w, h: box.h });
    // A 3× supersample lens over the abstract body text (clearly rendered in the
    // base, left column ~30–65% down) — the crispness tell for magnifier+PDF.
    const md = app.registry.get("magnifier").defaults;
    app.addItem({ ...md, x: box.x + box.w * 0.05, y: box.y + box.h * 0.34, w: box.w * 0.45, h: box.h * 0.22, magnification: 3, supersample: true });
  }, box);
  await sleep(10000);
  await shot(page, "pdf_reraster_magnifier.png");

  // CONTRAST: disable the re-raster (so the lens magnifies the whole-page BASE
  // bitmap — the OLD behavior) and re-shoot. The lens text should be visibly
  // softer/coarser than the boosted version above.
  await page.evaluate(() => {
    window.__powerrp_noPdfReraster = true;
    const app = window.__powerrp_app;
    const vp = app.lastViewport;
    app.canvasActions.setViewport({ ...vp, zoom: vp.zoom * 1.0001 }); // nudge a repaint
  });
  await sleep(4000);
  await shot(page, "pdf_reraster_magnifier_before.png");

  await browser.close();
  if (errors.length) {
    console.log(`\nWARN: ${errors.length} console error(s)/pageerror(s):`);
    for (const e of errors.slice(0, 8)) console.log("  " + e.slice(0, 200));
  }
  console.log(`\nDONE — screenshots in ${SHOTS}`);
}

main().catch((e) => { console.error("pdf_reraster_vlm ERROR:", e); process.exit(1); });
