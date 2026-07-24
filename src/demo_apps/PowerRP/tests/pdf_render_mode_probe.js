/**
 * PDF RENDER-MODE probe — drives the REAL editor (self-spun frontend-only Vite +
 * headless Chromium) to prove the two `renderMode`s behave as designed:
 *
 *   LIVE  (default) — re-rasterizes the visible region at the current zoom EVERY
 *     time the view changes: zooming to NEW levels creates NEW rasters (crisp),
 *     and even an extreme zoom never crashes (the #37 device-scale/clampDim
 *     guards hold).
 *   RASTER — rasters the page ONCE at a fixed DPI/size and caches it: zooming to
 *     the SAME page at many levels creates ZERO further rasters (the cached
 *     bitmap is merely scaled) — the "render once, never re-raster" invariant.
 *
 * Observability: every raster (whole-page proxy AND visible-region) ends in a
 * `createImageBitmap(canvas)` call. We patch that global (pre-navigation) to
 * count invocations, so the DELTA across a zoom sequence is exactly the number
 * of (re-)rasters that zoom sequence triggered — 0 for raster mode, >0 for live.
 *
 * It also writes VLM screenshots to POWERRP/.claude_vlm_checks/ and reports an
 * objective edge-energy (sharpness) proxy: at a high zoom, LIVE (screen-res
 * re-raster) should read sharper than RASTER (an upscaled cached bitmap).
 *
 * Self-contained: `node tests/pdf_render_mode_probe.js` (no server needed).
 * Optional arg: an already-running editor URL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks");
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const TEXT_PAGE = 2; // the fixture's text page (page 1 is pure vector graphics)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixture PDF as a data URI (frontend-only Vite has no /asset backend, and
// pdf.js getDocument accepts a data: URI directly).
const PDF_DATA_URI = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");

const externalUrl = process.argv[2] && /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : null;

async function main() {
  const webRoot = path.resolve(HERE, "../web");
  let server = null, baseUrl = externalUrl;
  if (!externalUrl) {
    const { createServer } = await import("vite");
    server = await createServer({ configFile: path.resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  }

  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

  const errors = [];
  const IGNORE = /Failed to load resource|thumbnail|\/api\/thumb|\/api\/assets|listAssets|could not list project assets|500 Internal Server Error|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect/i;
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  // Count every rasterization: both PDF raster paths finish with createImageBitmap.
  await page.evaluateOnNewDocument(() => {
    const orig = window.createImageBitmap.bind(window);
    window.__pdfRasterCount = 0;
    window.createImageBitmap = function (...args) { window.__pdfRasterCount++; return orig(...args); };
  });

  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 30000 });

  fs.mkdirSync(SHOTS, { recursive: true });
  const rasterCount = () => page.evaluate(() => window.__pdfRasterCount);
  const shot = async (name) => { const el = await page.$("canvas.scene"); await el.screenshot({ path: path.join(SHOTS, name) }); console.log(`  wrote ${name}`); };

  // Objective sharpness proxy: mean |horizontal luminance gradient| over the
  // canvas screenshot (crisp edges → high; blurry upscales → low).
  async function sharpness() {
    const b64 = await page.screenshot({ encoding: "base64" });
    return page.evaluate(async (data) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + data; });
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
      const { data: px, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
      let sum = 0, n = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 1; x < width; x++) {
          const i = (y * width + x) * 4, j = (y * width + x - 1) * 4;
          const l1 = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
          const l0 = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
          sum += Math.abs(l1 - l0); n++;
        }
      }
      return n ? sum / n : 0;
    }, b64);
  }

  // Place a PDF page widget (default renderMode = "live"), showing the text page.
  const box = await page.evaluate((src, pg) => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("pdf_page").defaults;
    const b = { x: 200, y: 150, w: 400, h: 520 };
    app.addItem({ ...defaults, src, page: pg, ...b });
    return b;
  }, PDF_DATA_URI, TEXT_PAGE);
  const id = await page.evaluate(() => window.__powerrp_app.selection);

  const setView = (zoom, cx, cy) => page.evaluate((zoom, cx, cy) => {
    const rect = document.querySelector(".render-area").getBoundingClientRect();
    window.__powerrp_app.canvasActions.setViewport({ zoom, panX: rect.width / 2 - cx * zoom, panY: rect.height / 2 - cy * zoom });
  }, zoom, cx, cy);
  const setMode = (mode) => page.evaluate((id, mode) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "renderMode"], mode]]);
    app.commitPreview();
  }, id, mode);
  const cx = box.x + box.w * 0.5, cy = box.y + box.h * 0.3; // a text-dense band

  await sleep(5000); // doc open + first rasters land

  const results = {};

  // ── LIVE: zoom to several NEW levels → re-rasters each time; extreme zoom → no crash ──
  await setView(3, cx, cy); await sleep(2500);
  const liveBefore = await rasterCount();
  for (const z of [6, 12, 24]) { await setView(z, cx, cy); await sleep(2500); }
  const liveAfter = await rasterCount();
  results.liveZoomRasters = liveAfter - liveBefore;
  await shot("rendermode_live_zoom.png");
  const liveSharp = await sharpness();

  // Extreme zoom crash-guard check (the #37 OOM must NOT return).
  await setView(200, cx, cy); await sleep(3000);
  await shot("rendermode_live_extreme_zoom.png");
  const errAfterExtreme = errors.length;

  // ── RASTER: switch mode, let the single cached raster land, then zoom to the
  // SAME NEW levels → ZERO further rasters. ─────────────────────────────────────
  await setView(3, cx, cy); await sleep(1500);
  await setMode("raster");
  await sleep(3000); // the one fixed-DPI raster lands
  const rasterBefore = await rasterCount();
  for (const z of [6, 12, 24]) { await setView(z, cx, cy); await sleep(2500); }
  const rasterAfter = await rasterCount();
  results.rasterZoomRasters = rasterAfter - rasterBefore;
  await shot("rendermode_raster_zoom.png");
  const rasterSharp = await sharpness();

  await browser.close();
  if (server) await server.close();

  // ── verdict ──
  console.log("\n=== PDF render-mode probe results ===");
  console.log(`LIVE   : rasters created while zooming to 3 new levels = ${results.liveZoomRasters}  (expect > 0 — re-rasters per zoom)`);
  console.log(`RASTER : rasters created while zooming to 3 new levels = ${results.rasterZoomRasters}  (expect 0 — render once, cache)`);
  console.log(`sharpness @ high zoom — LIVE ${liveSharp.toFixed(3)} vs RASTER ${rasterSharp.toFixed(3)} (LIVE should read sharper)`);
  console.log(`console/page errors during LIVE extreme (200x) zoom: ${errAfterExtreme}`);
  if (errors.length) { console.log("ERRORS:"); errors.slice(0, 10).forEach((e) => console.log("  " + e.slice(0, 200))); }

  const problems = [];
  if (!(results.liveZoomRasters > 0)) problems.push("LIVE did not re-raster on zoom (expected > 0)");
  if (results.rasterZoomRasters !== 0) problems.push(`RASTER re-rastered on zoom (expected 0, got ${results.rasterZoomRasters})`);
  if (errAfterExtreme !== 0) problems.push("errors during extreme-zoom crash-guard check");
  if (problems.length) { console.log("\nFAIL:\n  " + problems.join("\n  ")); process.exit(1); }
  console.log("\nPASS — live re-rasters per zoom (crisp, no crash); raster renders once and never re-rasters.");
}

main().catch((e) => { console.error("pdf_render_mode_probe ERROR:", e); process.exit(1); });
