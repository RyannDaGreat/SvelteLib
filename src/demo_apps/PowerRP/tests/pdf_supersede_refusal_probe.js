/**
 * A SUPERSEDED RASTER IS NOT A FAILED ONE — the browser gate for the 2026-08-02
 * report: "rendering a mp4 with pdfs in it is failing even if they're raster even
 * if they're not live it's still failing I don't know why."
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────
 * The render's own report named `pdfregion:`/`pdfpage:` refs wrapping `blob:` URLs,
 * which reads like a dead object URL — it is NOT. That `blob:` is the resolved PDF
 * src embedded inside a SYNTHETIC image-registry cache key
 * (pdf_page_raster.pdfPageRegionRef), and the PDF had already loaded fine.
 *
 * The real mechanism is a THREE-WAY state collapsed into two.
 * `image_registry.abandonImageSlot` retires a reserved-but-never-filled slot, and it
 * is called for two unrelated reasons:
 *   · the raster genuinely FAILED — an export must refuse rather than write a hole;
 *   · the raster was SUPERSEDED by a newer view — pdf_page_raster's generation gate,
 *     entirely normal, and the newer ref holds the pixels.
 * Both were marked `"error"`, so `failedImageRefs()` reported the benign one and
 * `settledFrame` (web/settledFrame.js — THE DRAIN) refused the frame over a raster
 * that had been deliberately replaced by a better one.
 *
 * ── WHY THE OBVIOUS PROBE DOES NOT CATCH IT (measured, and why this file exists) ──
 * A server-side render-job page is CAMERA-FREE: web/gpuService.js calls
 * `cameraFrameIR(state, meta, registry, {project})` with no `view`, so
 * `preRasterizePdfPages` never runs, nothing is ever superseded, and a PDF deck
 * rendered through the headless worker passes EVEN WITH THE BUG PRESENT. Verified
 * during the fix: a 2-frame worker render of a PDF deck was green either way.
 * The failure needs a LIVE CANVAS — the editor tab, which is exactly where the user
 * hit it (web/browserRenderJobs.js, "render in this browser", sharing the
 * module-global registry with the viewport that has been rasterizing regions).
 * `failedRasters()` reads the WHOLE registry, not just the refs this frame needs,
 * so one stale supersede from any earlier view refuses every subsequent export.
 * That asymmetry is the whole reason this probe drives the pre-pass directly
 * instead of rendering a movie.
 *
 * Measured on the 2026-08-02 code: 6 view changes over one PDF page left 2 refs
 * latched "error" with the frame's own region "ready" and nothing pending — a
 * WHOLE frame, refused. With the fix: 0.
 *
 * Run:  node src/demo_apps/PowerRP/tests/pdf_supersede_refusal_probe.js
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERRP = resolve(HERE, "..");
const webRoot = resolve(POWERRP, "web");
/** Camera size. Small: this probe measures registry bookkeeping, not pixels. */
const W = 320, H = 180;
/** How many distinct views to sweep. Each one kicks a region raster for a new
 *  (sub-rect, scale) key, so each has the chance to outrun the previous one —
 *  the stampede the generation gate exists for. */
const VIEW_STEPS = 6;
/** Let a render actually start before the next view supersedes it. Too short and
 *  nothing is in flight to supersede; too long and each finishes first. */
const KICK_GAP_MS = 12;
/** Drain time for the last in-flight rasters to resolve or be abandoned. */
const SETTLE_MS = 2500;

const pdfBytes = await readFile(resolve(HERE, "fixtures/pdf_vector_fixture.pdf"));
const PDF_SRC = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
await server.waitForRequestsIdle();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("pageerror:", e.message); failed = true; });
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "load", timeout: 60000 });

  const r = await page.evaluate(async (dir, src, w, h, steps, gapMs, settleMs) => {
    const fs = (rel) => import(`/@fs${dir}/${rel}`);
    const [pdfDisplay, raster, drain, reg, registryMod, commandsMod, pluginsMod] = await Promise.all([
      fs("render_gpu/pdf_display.js"), fs("render_gpu/gpu/pdf_page_raster.js"),
      fs("web/settledFrame.js"), fs("render_gpu/gpu/image_registry.js"),
      fs("core/registry.js"), fs("core/commands.js"), fs("plugins/index.js"),
    ]);

    const registry = registryMod.createRegistry();
    pluginsMod.registerAll(registry, commandsMod.createCommands());
    const state = { type: "pdf_page", src, page: 1, renderMode: "live", x: 0, y: 0, w, h, rotation: 0, scale: 1, active: true, z: 1 };
    const node = { itemId: "pdf", type: "pdf_page", state, plugin: registry.get("pdf_page"), world: { x: 0, y: 0, rotation: 0, scale: 1 } };

    // The pre-pass only takes its REGION branch once the page's point size is known.
    await raster.ensurePdfDoc(src);
    await raster.ensurePdfPagePointSize(src, 1);

    // THE LIVE CANVAS: a zoom/pan sweep, one pre-pass per view, exactly as
    // CanvasView/PresentMode drive it. Each view mints a different region ref.
    const refs = [];
    for (let i = 0; i < steps; i++) {
      const view = { zoom: 1 + i * 0.37, panX: -i * 11, panY: -i * 7, dpr: 1 };
      const d = pdfDisplay.preRasterizePdfPages([node], view, w, h).get("pdf");
      if (d) refs.push(d.ref);
      await new Promise((res) => setTimeout(res, gapMs));
    }
    await new Promise((res) => setTimeout(res, settleMs));

    return {
      kicked: new Set(refs).size,
      lastRefStatus: reg.imageStatus(refs[refs.length - 1]),
      pending: drain.pendingRasters().length,
      failed: drain.failedRasters(),
    };
  }, POWERRP, PDF_SRC, W, H, VIEW_STEPS, KICK_GAP_MS, SETTLE_MS);

  console.log(`  region refs kicked over ${VIEW_STEPS} views: ${r.kicked}`);
  console.log(`  the settled view's own raster: ${r.lastRefStatus};  pending: ${r.pending}`);

  if (r.kicked < 2) {
    failed = true;
    console.error(`FAIL  only ${r.kicked} distinct region ref(s) — the sweep never exercised the supersede path, so this probe proved nothing`);
  } else if (r.failed.length > 0) {
    failed = true;
    console.error(`FAIL  ${r.failed.length} SUPERSEDED raster(s) are reported as permanent failures, so settledFrame refuses a frame whose pixels are all present:\n      ${r.failed.map((s) => s.slice(0, 72)).join("\n      ")}`);
  } else {
    console.log("PASS  a superseded raster refuses nothing — an export from a live tab may proceed");
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) { console.error("\npdf_supersede_refusal_probe: FAILED"); process.exit(1); }
console.log("\npdf_supersede_refusal_probe: passed");
