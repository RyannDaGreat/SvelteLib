/**
 * REPRO + REGRESSION probe — the CUMULATIVE PDF pan/zoom leak that kills the editor.
 *
 * ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────────
 * User report: "when I zoom in to a PDF and I move around once in a while, it
 * segfaults." Console, verbatim:
 *
 *   Uncaught RuntimeError: memory access out of bounds
 *       in $effect / in CanvasView.svelte / … / in App.svelte
 *       at getSkiaImage (image_registry.js:97)
 *       at sceneMedia (browser_media.js:155)
 *
 * "live" render mode re-rasterizes a placed PDF's VISIBLE REGION at the current
 * zoom, keyed by (src, page, sub-rect, scale) — so panning a zoomed page mints a
 * NEW ref roughly every frame. Each ref's pixels were then retained FOREVER: an
 * ImageBitmap in image_registry's map, plus a second copy inside the CanvasKit WASM
 * HEAP as soon as getSkiaImage converted it for paint. CanvasKit's wasm linear
 * memory has a HARD 2 GiB maximum (canvaskit.wasm declares max 32768 pages ×
 * 64 KiB; its JS glue also refuses any resize above 2147483648), so the leak has a
 * cliff, and the crash lands on whichever allocation happens to cross it.
 *
 * The sibling pdf_zoom_crash_probe covers the OTHER failure mode — ONE oversized
 * allocation at extreme zoom — and passed throughout this bug, because it jumps
 * between a few zoom levels and never pans. A cumulative leak is invisible to a
 * test that performs a handful of gestures.
 *
 * ── WHY IT MEASURES FLATTENING, NOT A SIZE ────────────────────────────────────
 * Asserting "the tab survived" would need ~1150 pan steps and ~6 minutes, and the
 * step count where it dies depends on the host's free memory. Asserting "the heap
 * stayed under N MB" is barely better: the fixed code is ALLOWED to hold a bounded
 * region cache (pdf_page_raster.PDF_REGION_CACHE_BYTES = 256 MiB), which is the
 * same order as what the broken code leaks over a short session, so any single
 * threshold sits uncomfortably close to both answers.
 *
 * So this measures the SHAPE of the curve, which is what "leak" actually means. It
 * pans in two equal halves, sized so the bounded cache is already saturated well
 * before the halfway mark, and compares the heap growth of the second half against
 * the first. A bounded cache grows to its budget and then STOPS (freed blocks get
 * reused), so the second half is flat. An unbounded one grows linearly, so the two
 * halves match. Measured before the fix: heap growth tracked raster pixels 1:1 —
 * 1674 MB of growth for 1717 MB of rasters over 1000 steps — dying at exactly
 * 2048.0 MB. That is budget-independent and needs no absolute constant.
 *
 * Measurement seam: WebAssembly.instantiate/instantiateStreaming are patched
 * pre-navigation to stash every exported WebAssembly.Memory — found by TYPE
 * because CanvasKit's build minifies its export names — so buffer.byteLength IS
 * the live wasm heap. That is the exact quantity the crash is about, not a proxy.
 *
 * Self-contained: `node tests/pdf_pan_leak_probe.js` (spins its own frontend-only
 * Vite; the fixture PDF goes in as a data URI, no backend needed).
 * Optional arg: an already-running editor URL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Zoom the page is viewed at while panning. High enough that the visible region is
 *  a strict sub-rect of the page (so every pan step is a genuinely new region to
 *  rasterize), low enough to stay far from the extreme-zoom regime the sibling
 *  pdf_zoom_crash_probe owns. */
const PAN_ZOOM = 8;

/**
 * Pan steps per half. At this viewport and zoom a region raster measures ~868×519,
 * i.e. ~1.8 MB of pixels per step, so 200 steps produce ~360 MB — comfortably past
 * the 256 MiB region-cache budget, which is the point: the cache must be SATURATED
 * before the halfway mark, or "the second half is flat" would merely mean "the
 * budget had room left" and the probe would pass a broken build.
 */
const PAN_STEPS_PER_HALF = 200;

/** Milliseconds between pan steps — enough for the reactive canvas to run its
 *  effect and rasterize one region per step (a shorter gap merely coalesces steps,
 *  which would understate the leak rather than fabricate one). */
const STEP_MS = 140;

/**
 * The second half's heap growth may exceed neither this many MB nor
 * SECOND_HALF_RATIO of the first half's. The absolute floor exists because
 * Emscripten grows its heap GEOMETRICALLY, so even a perfectly bounded cache can
 * cross one more resize step late in the run: the measured step size in this size
 * range is ~96 MB (e.g. 936.7 → 1032.8 MB in the pre-fix curve), and 128 covers one
 * such step with headroom. Without the floor, a run whose first half happened to be
 * flat would make the ratio test divide into noise.
 */
const SECOND_HALF_SLACK_MB = 128;

/** …and the relative bound, for when growth IS happening: a leak grows the two
 *  halves EQUALLY (ratio ≈ 1), a saturated cache grows the second one hardly at all
 *  (ratio ≈ 0). A quarter separates those two answers by 4x in either direction. */
const SECOND_HALF_RATIO = 0.25;

async function main() {
  const externalUrl = process.argv[2] && /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : null;
  const webRoot = path.resolve(HERE, "../web");
  let server = null, baseUrl = externalUrl;
  if (!externalUrl) {
    const { createServer } = await import("vite");
    // HMR OFF: a source edit mid-run reloads the page and destroys the measurement
    // (the same reason cli/render_job.js disables it for a render).
    server = await createServer({
      configFile: path.resolve(webRoot, "vite.config.js"),
      server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } },
    });
    await server.listen();
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  }

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

  const crashes = [];
  const isCrash = (s) => /memory access out of bounds|table index is out of bounds|Aborted\(|RuntimeError/i.test(s);
  page.on("pageerror", (e) => { if (isCrash(String(e))) crashes.push(String(e)); });
  page.on("error", (e) => crashes.push(`renderer died: ${e}`)); // the tab itself, not a JS throw
  page.on("console", (m) => { if (isCrash(m.text())) crashes.push(`console.${m.type()}: ${m.text()}`); });

  await page.evaluateOnNewDocument(() => {
    window.__wasmMems = [];
    window.__rasters = 0;
    window.__rasterBytes = 0;
    // CanvasKit's build MINIFIES its export names (its memory is exported as `wd`,
    // not `memory`), so the memory is found by TYPE, not by name.
    const grab = (res) => {
      const inst = res.instance ?? res;
      for (const v of Object.values(inst?.exports ?? {})) if (v instanceof WebAssembly.Memory) window.__wasmMems.push(v);
      return res;
    };
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = (...a) => instantiate(...a).then(grab);
    if (WebAssembly.instantiateStreaming) {
      const streaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
      WebAssembly.instantiateStreaming = (...a) => streaming(...a).then(grab);
    }
    // Every PDF raster (whole-page and visible-region) ends in createImageBitmap,
    // so this counts re-rasters and the pixels they produced.
    const make = window.createImageBitmap.bind(window);
    window.createImageBitmap = (src, ...rest) => {
      window.__rasters++;
      if (src && src.width && src.height) window.__rasterBytes += src.width * src.height * 4;
      return make(src, ...rest);
    };
    window.__leakStat = () => ({
      heap: Math.max(0, ...window.__wasmMems.map((m) => m.buffer.byteLength)),
      rasters: window.__rasters,
      rasterBytes: window.__rasterBytes,
    });
  });

  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  // Generous: the gate runs three browser probes at once, so a cold Vite start plus
  // CanvasKit init can take well past a minute under that contention.
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 180000 });

  const dataUri = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");
  const box = await page.evaluate((src) => {
    const app = window.__powerrp_app;
    const b = { x: 100, y: 100, w: 612, h: 792 };
    app.addItem({ ...app.registry.get("pdf_page").defaults, src, page: 1, ...b });
    return b;
  }, dataUri);
  await sleep(8000); // pdf.js opens the doc + the first whole-page raster lands

  const stat = () => page.evaluate(() => window.__leakStat()).catch((e) => ({ dead: String(e).slice(0, 140) }));
  const setView = (step) => page.evaluate((box, zoom, i) => {
    const el = document.querySelector(".render-area");
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    // step 0 = centre (the starting view); later steps tour the page interior, each
    // a genuinely different visible region, i.e. a fresh raster in "live" mode.
    const t = i * 0.11;
    const r = i === 0 ? 0 : 0.22;
    const wx = box.x + box.w * (0.5 + r * Math.cos(t));
    const wy = box.y + box.h * (0.5 + r * Math.sin(t));
    window.__powerrp_app.canvasActions.setViewport({ zoom, panX: rect.width / 2 - wx * zoom, panY: rect.height / 2 - wy * zoom });
    return true;
  }, box, PAN_ZOOM, step).catch(() => false);

  const mb = (bytes) => bytes / 1048576;
  const fail = async (lines) => {
    await browser.close();
    await server?.close();
    for (const l of lines) console.log(l);
    process.exit(1);
  };

  await setView(0);
  await sleep(4000);
  const marks = [await stat()];
  if (marks[0].dead) await fail([`FAIL: the page was already dead before panning — ${marks[0].dead}`]);
  console.log(`  baseline @${PAN_ZOOM}x: heap ${mb(marks[0].heap).toFixed(1)} MB, ${marks[0].rasters} rasters`);

  for (let half = 1; half <= 2; half++) {
    for (let i = 1; i <= PAN_STEPS_PER_HALF; i++) {
      const step = (half - 1) * PAN_STEPS_PER_HALF + i;
      if (!(await setView(step))) { crashes.push(`the page context vanished at pan step ${step} (the tab died)`); break; }
      await sleep(STEP_MS);
      if (i % 50 === 0) {
        const s = await stat();
        if (s.dead) { crashes.push(`the page died at pan step ${step}: ${s.dead}`); break; }
        console.log(`  pan ${String(step).padStart(3)}: heap ${mb(s.heap).toFixed(1)} MB  rasters ${s.rasters} (${mb(s.rasterBytes).toFixed(0)} MB of pixels)`);
      }
      if (crashes.length) break;
    }
    if (crashes.length) break;
    marks.push(await stat());
  }

  if (crashes.length)
    await fail([`\nFAIL: the editor died during the pan session (${crashes.length} event(s)):`, ...crashes.slice(0, 5).map((c) => "  " + c.slice(0, 300))]);

  const first = mb(marks[1].heap - marks[0].heap);
  const second = mb(marks[2].heap - marks[1].heap);
  const rastered = mb(marks[2].rasterBytes - marks[0].rasterBytes);
  const allowed = Math.max(SECOND_HALF_SLACK_MB, SECOND_HALF_RATIO * first);
  console.log(`\n  ${2 * PAN_STEPS_PER_HALF} pan steps produced ${rastered.toFixed(0)} MB of region rasters.`);
  console.log(`  wasm heap growth: first half +${first.toFixed(0)} MB, second half +${second.toFixed(0)} MB (allowed ≤ ${allowed.toFixed(0)} MB)`);

  await browser.close();
  await server?.close();

  if (second > allowed) {
    console.log(`\nFAIL: the heap kept growing through the second half (+${second.toFixed(0)} MB > ${allowed.toFixed(0)} MB), so region`);
    console.log(`  rasters are ACCUMULATING rather than being freed — growth is tracking the ${rastered.toFixed(0)} MB of rasters produced.`);
    console.log("  That is the leak that walks CanvasKit's 2 GiB wasm heap into `memory access out of bounds` at getSkiaImage.");
    process.exit(1);
  }
  console.log(`\nPASS: growth flattened (second half +${second.toFixed(0)} MB) — the region cache is bounded, not accumulating.`);
}

main().catch((e) => { console.error("pdf_pan_leak_probe ERROR:", e); process.exit(2); });
