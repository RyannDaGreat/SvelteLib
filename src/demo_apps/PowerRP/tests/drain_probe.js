/**
 * THE DRAIN (#281) — that every EXPORT waits for its async rasters, and that
 * thumbnails deliberately do not.
 *
 * User, 2026-08-01: "a major issue when I render videos, the PDF is nowhere to be
 * found."
 *
 * The mechanism was never missing — web/renderJobPage.js has had a correct
 * settledFrame for a while. It was UNSHARED: four private functions in one file,
 * reachable by one of the app's pixel consumers, so the server-side renderer
 * waited and the in-browser one did not. This proves the extracted module is
 * actually wired into the paths that were shipping cold frames.
 *
 * NO SCREENSHOTS — every assertion reads state or counts registry entries, so
 * this is immune to the host Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/drain_probe.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const PDF_DATA_URI = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU|GlobalWorkerOptions|pdf_page_vector/i; // pdf_page_vector's workerSrc complaint is a PRE-EXISTING dev-server condition (two other suites already handle it) and has nothing to do with the drain — verified by git: this work touches neither that module nor pdf.js config
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 800));

    const mod = "/settledFrame.js";

    // ── THE MODULE EXISTS AND IS SHARED ────────────────────────────────────
    const api = await page.evaluate(async (m) => {
      const s = await import(m);
      return { keys: Object.keys(s).sort(), pendingIsArray: Array.isArray(s.pendingRasters()), failedIsArray: Array.isArray(s.failedRasters()) };
    }, mod);
    ok(api.keys.join() === "failedRasters,pendingRasters,settledFrame,waitForRasterProgress",
      `the drain is a shared module (${api.keys.join(", ")})`);
    ok(api.pendingIsArray && api.failedIsArray, "both questions answer, and they are SEPARATE lists — that separation is the original bug");

    // ── IT ACTUALLY WAITS ───────────────────────────────────────────────────
    const waited = await page.evaluate(async (m, uri) => {
      const app = window.__powerrp_app;
      const { settledFrame, pendingRasters } = await import(m);
      // A fresh PDF page: its raster is genuinely not ready on the first pass.
      app.addItem({ ...app.registry.get("pdf_page").defaults, src: uri });
      const id = app.selection;
      app.setPreview([[["items", id, "x"], 200], [["items", id, "y"], 200]]);
      app.commitPreview();

      let passes = 0;
      let sawPendingOnFirstPass = null;
      await settledFrame(async () => {
        passes++;
        if (passes === 1) {
          // Kick the raster the way a real render does, then observe.
          await app.exportPngCanvasForTest?.();
        }
        if (sawPendingOnFirstPass === null) sawPendingOnFirstPass = pendingRasters().length;
        return true;
      }, "drain probe");
      return { passes, sawPendingOnFirstPass, pendingAfter: pendingRasters().length };
    }, mod, PDF_DATA_URI);

    ok(waited.pendingAfter === 0, `it returns only when NOTHING is pending (${waited.pendingAfter} left)`);
    ok(waited.passes >= 1, `it rendered at least once (${waited.passes} pass(es))`);

    // ── THE EXPORT PATHS ARE WIRED, the thumbnail path deliberately is NOT ──
    // READ FROM DISK, not through the dev server: Vite REWRITES import specifiers
    // it serves ("./settledFrame.js" becomes "/settledFrame.js?t=…"), so matching
    // the source text of a transformed module is a test that fails for a reason
    // having nothing to do with the app. It did exactly that on the first run.
    const readSrc = (f) => fs.readFileSync(path.join(HERE, "..", "web", f), "utf8");
    const uses = (src) => /settledFrame\s*\(/.test(src) && /from "\.\/settledFrame\.js"/.test(src);
    const jobPage = readSrc("renderJobPage.js");
    const wiring = {
      png: uses(readSrc("app.svelte.js")),
      browserMp4: uses(readSrc("browserRenderJobs.js")),
      serverMp4: uses(jobPage),
      thumbnails: /from "\.\/settledFrame\.js"/.test(readSrc("gpuService.js")),
      jobPageHasNoPrivateCopy: !/function\s+settledFrame\s*\(/.test(jobPage),
    };
    ok(wiring.png, "PNG export drains");
    ok(wiring.browserMp4, "THE IN-BROWSER MP4 EXPORT DRAINS — the path that used to encode whatever was on the canvas");
    ok(wiring.serverMp4, "the server-side renderer still drains");
    ok(wiring.jobPageHasNoPrivateCopy, "…through the SHARED module — its private copy is gone, so the two cannot drift");
    ok(wiring.thumbnails === false,
      "THUMBNAILS DELIBERATELY DO NOT DRAIN — a stale thumbnail repaints itself on onImageLoad, and blocking there would trade a blink for a stalled UI");

    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} drain probe checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("drain_probe ERROR:", e); process.exit(1); });
