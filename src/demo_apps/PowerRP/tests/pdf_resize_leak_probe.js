/**
 * REPRO + REGRESSION probe — the WHOLE-PAGE PDF raster leak that kills the editor.
 *
 * ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────────
 * User report (#213): `RuntimeError: memory access out of bounds` at
 * `getSkiaImage (image_registry.js)` via `sceneMedia (browser_media.js)` inside a
 * CanvasView $effect, plus a second at `makeJobSurface (gpuService.js)` — while
 * "zooming into a PDF and panning, once in a while".
 *
 * The two crash sites are in different subsystems and neither is the cause: both
 * are ordinary wasm allocations that happened to be the ones standing when the heap
 * ran out. The cause is that plugins/pdf_page.js emit() asks for a WHOLE-PAGE raster
 * at
 *   wholeScale = croppedWidth · world.scale · PDF_RASTER_DENSITY / pagePointWidth
 * — a CONTINUOUS function of the widget's SIZE, bucketed to PDF_SCALE_STEP — and the
 * cache behind it (pdf_page_raster.`pages`) had NO budget and NO eviction. Every 0.1
 * of scale a resize drag sweeps through minted another raster of up to
 * PDF_MAX_RASTER_DIM² · 4 = 64 MB, kept forever, each with a second copy in the
 * CanvasKit wasm heap the moment getSkiaImage converted it for paint.
 *
 * The sibling pdf_pan_leak_probe covers the REGION cache and passed throughout this
 * bug, because zoom and pan never change `wholeScale` — only SIZE does. That is also
 * why the user saw it "once in a while": you resize a figure occasionally, and each
 * drag dumps hundreds of MB that never come back.
 *
 * ── WHAT IT ASSERTS AND WHY THAT SHAPE ────────────────────────────────────────
 * Measured on the pre-fix code with a bigger PDF: 139 CanvasKit Images alive and
 * ZERO ever deleted, 1976.9 MB of them, heap pinned at exactly 2048.0 MB — CanvasKit
 * declares its wasm memory max at 32768 pages × 64 KiB — and then the reported
 * crash. So the probe asserts the two things that were false:
 *   1. the tab SURVIVES the sweep (no wasm OOM / corruption), and
 *   2. the CanvasKit Images the sweep leaves ALIVE stay within the module's declared
 *      budget, allowing the documented over-subscription slack.
 *
 * ASSERTION 2 IS THE REAL GATE and 1 is its symptom. Whether the tab actually dies
 * depends on the host's memory and on the page's size in points — a bigger machine
 * just dies later, and the small self-contained fixture below balloons to ~1 GB
 * rather than all the way to the ceiling. What does NOT vary is that the pre-fix
 * code deletes NONE of what it allocates. So the measurement is live-vs-made
 * CanvasKit Images, taken by wrapping MakeImageFromCanvasImageSource (the ONE call
 * that copies a bitmap into the wasm heap — image_registry.getSkiaImage) and its
 * handles' own delete(). That is the physical quantity the crash is about, and it
 * is readable identically before and after the fix, which a module-internal
 * accounting call is not: the pre-fix code had no accounting for this cache at all,
 * which is precisely why it grew.
 *
 * Self-contained: `node tests/pdf_resize_leak_probe.js` (spins its own frontend-only
 * Vite; the fixture PDF goes in as a data URI, no backend needed).
 * Optional arg: an already-running editor URL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The resize sweep, in world units of widget WIDTH. A page rasters at
 *  `width · PDF_RASTER_DENSITY / pagePointWidth` device px per point, so this span
 *  crosses ~90 distinct PDF_SCALE_STEP buckets — enough that an unbudgeted cache is
 *  unambiguously past the 256 MiB budget (measured: it reached the 2 GiB heap
 *  ceiling before the sweep finished), while a budgeted one settles at it. */
const WIDTH_FROM = 200;
const WIDTH_TO = 2400;

/** World units of width per step. Small enough that consecutive steps land in
 *  DIFFERENT scale buckets (which is what a real drag does — one preview per
 *  pointer-move); large enough that the sweep is ~90 steps rather than thousands. */
const WIDTH_STEP = 25;

/** Milliseconds per step — enough for the reactive canvas to run its effect, kick
 *  the raster for this bucket and let it land. A shorter gap merely coalesces
 *  steps, which would understate the leak rather than fabricate one. */
const STEP_MS = 220;

/** The page's native aspect (the fixture is US Letter, 612 × 792 pt). Held constant
 *  through the sweep so the widget scales rather than distorting. */
const PAGE_ASPECT = 792 / 612;

/** How far past the module's declared budget the LIVE CanvasKit Images may sit at
 *  the end of the sweep. NOT slop, and not one number pulled from the air — it is the
 *  sum of the two things that legitimately live outside the budgeted caches:
 *    · the frame's own live set, which trimPdfRasterCache deliberately keeps even
 *      past the budget (a frame must paint) — at most one PDF_MAX_RASTER_DIM raster,
 *      4096² · 4 = 64 MB, since this sweep has ONE page on screen; and
 *    · every OTHER CanvasKit Image on the page, which this census cannot tell apart
 *      from a PDF one — the glyph atlas and the app's own chrome. Measured at 25.5 MB
 *      on a deck holding nothing but one PDF, so 64 MB again covers it with room.
 *  A leak overshoots this by an order of magnitude (1976.9 MB measured), so the
 *  threshold separates the two answers by ~6x and sits near neither. */
const OVER_BUDGET_SLACK_BYTES = 128 * 1024 * 1024;

/**
 * The sweep must produce AT LEAST this many CanvasKit Images or the run is void.
 *
 * THIS EXISTS BECAUSE THE GATE ONCE PASSED WITHOUT TESTING ANYTHING. A harness in
 * which the PDF never rasterizes at all — a dev server that cannot reach pdf.js's
 * worker script, a page that reloaded mid-run — reports 0 Images made, 0 alive, and
 * "0 MB is within budget" is trivially, uselessly true. That is the "a gate that
 * cannot fail is not a gate" failure mode, and it was observed, not imagined. The
 * sweep crosses ~90 PDF_SCALE_STEP buckets and measured 175 Images on both sides of
 * the fix, so a floor of 20 is an order of magnitude below the real answer and
 * cannot fire on a working run — it only catches a harness that did nothing.
 */
const MIN_RASTERS_FOR_A_VALID_RUN = 20;

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
  });

  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  // Generous: the gate runs several browser probes at once, so a cold Vite start
  // plus CanvasKit init can take well past a minute under that contention.
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 180000 });

  // THE CENSUS. MakeImageFromCanvasImageSource is the ONE call that copies a decoded
  // bitmap into the CanvasKit wasm heap (image_registry.getSkiaImage), and the only
  // way that copy is ever released is the handle's own delete() (image_registry
  // .releaseImage). Wrapping both gives exact live-vs-made bytes — the physical
  // quantity #213 is about. Done through the SAME module instance the app uses: Vite
  // dedupes by resolved URL and the app reaches CanvasKit through this same /@fs
  // path, so this is the app's CanvasKit, not a second one.
  await page.evaluate(async (dir) => {
    const ck = await (await import(`${location.origin}/@fs${dir}/render_gpu/skia/browser_canvaskit.js`)).ensureCanvasKit();
    const census = { live: 0, made: 0, bytes: 0 };
    const make = ck.MakeImageFromCanvasImageSource.bind(ck);
    ck.MakeImageFromCanvasImageSource = (bitmap) => {
      const img = make(bitmap);
      if (!img) return img;
      const bytes = (bitmap?.width ?? 0) * (bitmap?.height ?? 0) * 4; // RGBA8888
      census.live++; census.made++; census.bytes += bytes;
      const del = img.delete.bind(img);
      let gone = false;
      img.delete = () => { if (!gone) { gone = true; census.live--; census.bytes -= bytes; } return del(); };
      return img;
    };
    const pr = await import(`${location.origin}/@fs${dir}/render_gpu/gpu/pdf_page_raster.js`);
    window.__stat = () => ({
      heap: Math.max(0, ...window.__wasmMems.map((m) => m.buffer.byteLength)),
      live: census.live,
      made: census.made,
      liveBytes: census.bytes,
      // The budget the module declares for its own caches. Read from the module so
      // this probe can never disagree with the code about what the limit IS.
      budget: pr.PDF_RASTER_CACHE_BYTES,
    });
  }, path.resolve(HERE, ".."));

  const dataUri = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");
  await page.evaluate((src, w) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("pdf_page").defaults, src, page: 1, x: 100, y: 100, w, h: Math.round(w * 792 / 612) });
  }, dataUri, WIDTH_FROM);
  await sleep(8000); // pdf.js opens the doc + the first whole-page raster lands

  const mb = (b) => (b / 1048576).toFixed(1);
  const stat = () => page.evaluate(() => window.__stat()).catch((e) => ({ dead: String(e).slice(0, 160) }));
  const fail = async (lines) => {
    await browser.close();
    await server?.close();
    for (const l of lines) console.log(l);
    process.exit(1);
  };

  const first = await stat();
  if (first.dead) await fail([`FAIL: the page was already dead before the sweep — ${first.dead}`]);
  console.log(`  baseline @${WIDTH_FROM}px wide: heap ${mb(first.heap)} MB, ${first.live}/${first.made} CanvasKit Images live = ${mb(first.liveBytes)} MB`);

  let last = first;
  for (let w = WIDTH_FROM + WIDTH_STEP; w <= WIDTH_TO; w += WIDTH_STEP) {
    // What a resize DRAG does: preview one geometry pair per pointer-move. The
    // document is never committed, which is exactly the point — a leak that needs no
    // undo entry to happen is a leak the user cannot even see themselves causing.
    const ok = await page.evaluate((w, aspect) => {
      const app = window.__powerrp_app;
      const items = app.state().items;
      const id = Object.keys(items).find((k) => items[k].type === "pdf_page");
      if (!id) return false;
      app.setPreview([[["items", id, "w"], w], [["items", id, "h"], Math.round(w * aspect)]]);
      return true;
    }, w, PAGE_ASPECT).catch(() => false);
    if (!ok) { crashes.push(`the page context vanished at width ${w} (the tab died)`); break; }
    await sleep(STEP_MS);
    if ((w - WIDTH_FROM) % (WIDTH_STEP * 16) === 0) {
      const s = await stat();
      if (s.dead) { crashes.push(`the page died at width ${w}: ${s.dead}`); break; }
      last = s;
      console.log(`  w=${String(w).padStart(5)}: heap ${mb(s.heap).padStart(7)} MB, Images ${String(s.live).padStart(4)}/${String(s.made).padEnd(4)} live = ${mb(s.liveBytes).padStart(7)} MB`);
    }
    if (crashes.length) break;
  }

  if (crashes.length)
    await fail([
      `\nFAIL: the editor died during the resize sweep (${crashes.length} event(s)):`,
      ...crashes.slice(0, 5).map((c) => "  " + c.slice(0, 300)),
      "  That is the whole-page PDF raster cache growing without bound — one raster per",
      "  PDF_SCALE_STEP bucket the drag sweeps through, none ever freed — until CanvasKit's",
      "  2 GiB wasm heap runs out and whichever allocation is next reports the failure.",
    ]);

  const s = await stat();
  const end = s.dead ? last : s;
  const allowed = end.budget + OVER_BUDGET_SLACK_BYTES;
  const freed = end.made - end.live;
  console.log(`\n  after the sweep: ${end.live}/${end.made} CanvasKit Images live = ${mb(end.liveBytes)} MB`);
  console.log(`  (budget ${mb(end.budget)} MB, allowed ≤ ${mb(allowed)} MB; ${freed} of ${end.made} were freed), heap ${mb(end.heap)} MB`);

  await browser.close();
  await server?.close();

  if (end.made < MIN_RASTERS_FOR_A_VALID_RUN) {
    console.log(`\nFAIL (VOID RUN, not a regression): the sweep produced only ${end.made} CanvasKit Images, under the`);
    console.log(`  ${MIN_RASTERS_FOR_A_VALID_RUN} a working run cannot help but make — so the PDF never rasterized and this run measured`);
    console.log("  NOTHING. Check that the dev server can serve pdf.js's worker script (a `?url` import");
    console.log("  of pdfjs-dist resolving outside server.fs.allow yields no URL and pdf.js then refuses");
    console.log("  every document with \"Invalid `workerSrc` type\"), and that the page did not reload.");
    process.exit(1);
  }
  if (end.liveBytes > allowed) {
    console.log(`\nFAIL: ${end.live} CanvasKit Images are still alive holding ${mb(end.liveBytes)} MB of the wasm heap,`);
    console.log(`  past the ${mb(end.budget)} MB the PDF raster cache budgets plus ${mb(OVER_BUDGET_SLACK_BYTES)} MB for the live`);
    console.log(`  frame and the app's own images — and only ${freed} of ${end.made} were ever freed. Stale whole-page`);
    console.log("  rasters from earlier widget SIZES are accumulating instead of being evicted; continue the");
    console.log("  sweep far enough and the next allocation reports `memory access out of bounds` (#213).");
    process.exit(1);
  }
  console.log(`\nPASS: survived the sweep; ${freed} of ${end.made} Images freed, ${mb(end.liveBytes)} MB still live — bounded, not accumulating.`);
}

main().catch((e) => { console.error("pdf_resize_leak_probe ERROR:", e); process.exit(2); });
