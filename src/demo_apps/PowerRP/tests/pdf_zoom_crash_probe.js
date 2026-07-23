/**
 * REPRO + VERIFY probe — the "zoom into a placed PDF too far" CanvasKit wasm OOM.
 *
 * User repro: place a PDF page, zoom in to an extreme magnification. Before the
 * fix, a Skia surface (or a PDF region raster) is allocated at an oversized/
 * invalid dimension → CanvasKit wasm `RuntimeError: memory access out of bounds`
 * at MakeSurface / getCanvas → the wasm instance is corrupted → every later frame
 * throws `table index is out of bounds`.
 *
 * This probe escalates the viewport zoom over a placed PDF (and drops a
 * supersample magnifier over it at extreme zoom), collecting every pageerror /
 * console error. It FAILS (exit 1) if a wasm memory/table error is seen, PASSES
 * (exit 0) otherwise. With the fix, the surface-allocation guards clamp+report
 * (a loud console.error via reportOnce) instead of OOMing — those guard reports
 * are surfaced but do NOT fail the probe (they are the intended loud-but-safe
 * degrade); only genuine wasm OOM/corruption fails it.
 *
 * Run (dev server must be up):
 *   node tests/pdf_zoom_crash_probe.js [http://localhost:3637] [/asset/<proj>/<file.pdf>] [page]
 */
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || "http://localhost:3637";
const SRC = process.argv[3] || "/asset/Untitled/Delta%20Denoising%20Score.pdf";
const PAGE = Number(process.argv[4] ?? 1);

// Escalating zooms — well past any real use, into the regime the user hit.
const ZOOMS = [10, 50, 200, 1000, 5000, 50000, 500000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure function. Is `msg` a CanvasKit wasm OOM / corruption signature? */
function isWasmCrash(msg) {
  return /memory access out of bounds|table index is out of bounds|RuntimeError|Aborted\(|index out of bounds/i.test(msg);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const crashes = [];
  const guardReports = [];
  const allErrors = [];
  page.on("pageerror", (e) => {
    const s = String(e);
    allErrors.push(s);
    if (isWasmCrash(s)) crashes.push(s);
  });
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const s = m.text();
    if (/MAX_SURFACE_DIM|surface-clamp|clamp/i.test(s)) guardReports.push(s);
    if (m.type() === "error") { allErrors.push(s); if (isWasmCrash(s)) crashes.push(s); }
  });

  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 20000 });

  const box = await page.evaluate((src, pg) => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("pdf_page").defaults;
    const w = 612, h = 792, x = 100, y = 100;
    app.addItem({ ...defaults, src, page: pg, x, y, w, h });
    return { x, y, w, h };
  }, SRC, PAGE);
  await sleep(6000); // let the doc open + base raster land

  for (const zoom of ZOOMS) {
    await page.evaluate((box, zoom) => {
      const app = window.__powerrp_app;
      const a = app.canvasActions;
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      const wx = box.x + box.w * 0.5, wy = box.y + box.h * 0.12; // title band
      a.setViewport({ zoom, panX: rect.width / 2 - wx * zoom, panY: rect.height / 2 - wy * zoom });
    }, box, zoom);
    await sleep(2500);
    const alive = await page.evaluate(() => {
      try { return typeof window.__powerrp_app?.renderFrameCount === "number"; } catch { return false; }
    });
    console.log(`  zoom ${zoom}: appAlive=${alive} crashes=${crashes.length}`);
    if (crashes.length) break;
  }

  // MAGNIFIER over PDF at a still-extreme zoom (the acid test hypothesis: the
  // lens scale-boost multiplies the raster scale). Only if we survived the above.
  if (!crashes.length) {
    await page.evaluate((box) => {
      const app = window.__powerrp_app;
      const a = app.canvasActions;
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      const zoom = 2000;
      const wx = box.x + box.w * 0.5, wy = box.y + box.h * 0.34;
      a.setViewport({ zoom, panX: rect.width / 2 - wx * zoom, panY: rect.height / 2 - wy * zoom });
      const md = app.registry.get("magnifier").defaults;
      app.addItem({ ...md, x: wx - box.w * 0.1, y: wy - box.h * 0.05, w: box.w * 0.2, h: box.h * 0.1, magnification: 8, supersample: true });
    }, box);
    await sleep(4000);
    console.log(`  magnifier@2000x (mag 8): crashes=${crashes.length}`);
  }

  await browser.close();

  console.log(`\nGuard reports (clamp events, expected WITH the fix): ${guardReports.length}`);
  for (const g of guardReports.slice(0, 6)) console.log("  GUARD: " + g.slice(0, 200));
  if (crashes.length) {
    console.log(`\nFAIL: ${crashes.length} wasm OOM/corruption error(s):`);
    for (const c of crashes.slice(0, 6)) console.log("  CRASH: " + c.slice(0, 200));
    process.exit(1);
  }
  console.log(`\nPASS: no wasm OOM/corruption across zooms ${ZOOMS.join(", ")} + magnifier. (${allErrors.length} other console error(s).)`);
}

main().catch((e) => { console.error("pdf_zoom_crash_probe ERROR:", e); process.exit(2); });
