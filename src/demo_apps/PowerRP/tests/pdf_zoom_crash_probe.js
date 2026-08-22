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
 * The sibling pdf_pan_leak_probe covers the OTHER failure mode — a CUMULATIVE
 * leak over many pans. This one owns the single oversized allocation.
 *
 * NO SCREENSHOTS, DELIBERATELY (the pdf_drop_probe note): every assertion is a
 * `page.evaluate` read or a console line, so this probe is unaffected by the host
 * Chrome capture hang that turns 64 other probes into bare ProtocolErrors
 * (CLAUDE.md's preflight note). A wasm OOM is an exception, not a picture.
 *
 * ── SELF-CONTAINED, AS OF 2026-08-22, AND NO LONGER VACUOUS ──────────────────
 * TWO environment dependencies were making this probe measure the host instead of
 * the product, and the second one was worse than the first:
 *
 *   1. It did `page.goto("http://localhost:3637")` — the dev server a HUMAN
 *      happens to run. Under the gate nothing listens there, so it died at `goto`
 *      with net::ERR_CONNECTION_REFUSED and a puppeteer stack. It now spins its
 *      OWN Vite on port 0, the idiom its ~160 siblings use (copied from
 *      pdf_pan_leak_probe.js / route_insert_probe.js).
 *
 *   2. Its default PDF was `/asset/Untitled/Delta%20Denoising%20Score.pdf` — one
 *      reporter's file in one local project folder. THAT FILE DOES NOT EXIST in
 *      this repo and no project under server/PROJECTS_DIR has ever contained it
 *      (verified 2026-08-22: zero .pdf files under projects/). So even WITH a
 *      backend answering, the placed pdf_page's src 404s, pdf.js latches the doc
 *      "error", nothing is ever rasterized — and the probe prints
 *      "PASS: no wasm OOM" having allocated no surface at all. A probe that
 *      cannot fail is worse than one that is red. The default is now the repo's
 *      own tests/fixtures/pdf_vector_fixture.pdf as a data: URI, which pdf.js
 *      accepts directly and which needs no backend (the technique
 *      pdf_pan_leak_probe, pdf_drop_probe, drain_probe and shatter_probe already
 *      use for the same subsystem).
 *
 * And because a silent 404 is exactly what hid defect 2, the load is now ASSERTED
 * rather than assumed: `pdfDocStatus(src)` must read "ready" before the zoom
 * escalation begins, so a source that does not load reds the probe with a
 * sentence instead of passing it with a lie.
 *
 * Run (spins its own server, no backend needed):
 *   node src/demo_apps/PowerRP/tests/pdf_zoom_crash_probe.js
 * Optional overrides — an editor you already have running, a different PDF src
 * (a data: URI or an /asset/… path served by that editor), and a page number:
 *   node src/demo_apps/PowerRP/tests/pdf_zoom_crash_probe.js http://localhost:3637 /asset/Proj/paper.pdf 1
 */
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POWERRP = path.resolve(HERE, ".."); // tests/ → PowerRP root
/** An explicit http(s) first argument means "use the editor already running
 *  there"; anything else (including no argument) means "spin your own". */
const EXTERNAL_URL = process.argv[2] && /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : null;
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const SRC = process.argv[3] || "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");
const PAGE = Number(process.argv[4] ?? 1);
/** The app's OWN raster module, reached through the same Vite URL the app's
 *  bundle imports it by (files outside the web/ root are served under /@fs), so
 *  this reads the SAME module instance and therefore the SAME doc table — not a
 *  second copy that would answer "unloaded" forever. */
const RASTER = `/@fs${path.join(POWERRP, "render_gpu/gpu/pdf_page_raster.js")}`;

/** How long the app gets to publish `window.__powerrp_app`. Generous for the same
 *  reason pdf_pan_leak_probe.js states: the gate runs three browser probes at
 *  once, so a cold Vite start plus CanvasKit init can take past a minute under
 *  that contention. A genuinely dead boot still fails, just later. (Was 20 s,
 *  sized for a warm server a human had already started.) */
const APP_READY_MS = 180_000;

/** How long pdf.js gets to open the document before "it never loaded" is the
 *  honest answer. Same contention argument as APP_READY_MS: the fixture opens in
 *  well under a second on an idle host, and a src that is genuinely a 404 latches
 *  "error" immediately, so this deadline is only ever paid by a load that is
 *  really hung. */
const DOC_READY_MS = 60_000;

/** The placed page's world box. Kept at US-Letter points even though the fixture
 *  is 300×240: the item box is what the zoom/pan math below is written against,
 *  and holding it fixed keeps this probe's viewport arithmetic identical to the
 *  version that reproduced the user's crash. pdf_pan_leak_probe places the same
 *  fixture in the same box for the same reason. */
const BOX = { x: 100, y: 100, w: 612, h: 792 };

// Escalating zooms — well past any real use, into the regime the user hit.
const ZOOMS = [10, 50, 200, 1000, 5000, 50000, 500000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure function. Is `msg` a CanvasKit wasm OOM / corruption signature? */
function isWasmCrash(msg) {
  return /memory access out of bounds|table index is out of bounds|RuntimeError|Aborted\(|index out of bounds/i.test(msg);
}

async function main() {
  const webRoot = path.resolve(HERE, "../web");
  let server = null, url = EXTERNAL_URL;
  if (!EXTERNAL_URL) {
    const { createServer } = await import("vite");
    // HMR OFF + no watcher: a source edit mid-run would reload the page and kill
    // the run (cli/render_job.js disables it for a render for the same reason).
    server = await createServer({
      configFile: path.resolve(webRoot, "vite.config.js"),
      server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }

  const browser = await launchBrowser();
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

  /** Command. Tears the run down and exits with `code`, printing `lines` first.
   *  Every exit goes through here so the self-spun Vite is never left listening. */
  const finish = async (code, lines = []) => {
    await browser.close().catch(() => {});
    await server?.close().catch(() => {});
    for (const l of lines) console.log(l);
    process.exit(code);
  };

  await page.goto(url, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: APP_READY_MS });

  const box = await page.evaluate((src, pg, b) => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("pdf_page").defaults;
    app.addItem({ ...defaults, src, page: pg, ...b });
    return b;
  }, SRC, PAGE, BOX);
  await sleep(6000); // let the base whole-page raster land (the doc open is POLLED below)

  // THE PDF MUST ACTUALLY BE LOADED. Without this the whole run below is a tour
  // of an empty canvas that allocates nothing and reports "no wasm OOM" — the
  // exact false green a dead hardcoded asset path produced for this probe.
  //
  // POLLED, NOT READ ONCE AFTER A FIXED SLEEP: the gate runs three browser probes
  // at a time, so "6 s is surely enough for pdf.js to open a document" is exactly
  // the kind of timing assumption that turns a correct app red under contention.
  // pdf_page_raster LATCHES "error" and never retries, so the loop can also stop
  // the moment the answer is final rather than always paying the deadline.
  const readDoc = () => page.evaluate(async (RASTER, src) =>
    import(RASTER).then((m) => ({ status: m.pdfDocStatus(src), pages: m.pdfPageCount(src) })),
    RASTER, SRC).catch((e) => ({ status: "probe-error", pages: null, error: String(e).slice(0, 200) }));
  let doc = await readDoc();
  for (const deadline = Date.now() + DOC_READY_MS; doc.status !== "ready" && doc.status !== "error" && Date.now() < deadline; ) {
    await sleep(500);
    doc = await readDoc();
  }
  console.log(`  pdf doc: status=${doc.status} pages=${doc.pages}`);
  if (doc.status !== "ready")
    await finish(1, [
      `\nFAIL: the PDF never loaded (pdfDocStatus = ${doc.status}${doc.error ? `; ${doc.error}` : ""}).`,
      `  src: ${SRC.slice(0, 90)}${SRC.length > 90 ? "…" : ""}`,
      "  Nothing would be rasterized, so no surface would be allocated and this probe",
      "  would report 'no wasm OOM' having tested nothing. Fix the src, not this check.",
    ]);

  for (const zoom of ZOOMS) {
    await page.evaluate((box, zoom) => {
      const app = window.__powerrp_app;
      const a = app.canvasActions;
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      const wx = box.x + box.w * 0.5, wy = box.y + box.h * 0.12; // deep inside the page
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

  console.log(`\nGuard reports (clamp events, expected WITH the fix): ${guardReports.length}`);
  for (const g of guardReports.slice(0, 6)) console.log("  GUARD: " + g.slice(0, 200));
  if (crashes.length)
    await finish(1, [
      `\nFAIL: ${crashes.length} wasm OOM/corruption error(s):`,
      ...crashes.slice(0, 6).map((c) => "  CRASH: " + c.slice(0, 200)),
    ]);
  await finish(0, [`\nPASS: no wasm OOM/corruption across zooms ${ZOOMS.join(", ")} + magnifier. (${allErrors.length} other console error(s).)`]);
}

main().catch((e) => { console.error("pdf_zoom_crash_probe ERROR:", e); process.exit(2); });
