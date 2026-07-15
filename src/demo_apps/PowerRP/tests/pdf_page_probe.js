/**
 * PDF PAGE WIDGET end-to-end probe (manifest ROUND 13.1 — plugins/pdf_page.js
 * + render_gpu/gpu/pdf_page_raster.js). Drives a REAL browser (ephemeral Vite
 * dev server + puppeteer, ALWAYS an isolated port — never 3637) through the
 * SAME window.__powerrp_render hook the CLI renderer uses, so the widget is
 * exercised through its true GPU render path (pdfjs-dist rasterize →
 * gpu/image_registry.js registration → the compositor's normal image draw).
 *
 * Generates its OWN tiny 2-page PDF in-memory via pdf-lib (already a
 * dependency) — writes NOTHING into the user's real projects (manifest rule
 * 13.7: "tests/probes must NEVER write into user projects").
 *
 * Checks:
 *   1. A pdf_page widget on page 1 renders NON-BLANK pixels (the page has a
 *      solid red background — trivially distinguishable from the camera's
 *      white background).
 *   2. Page 2 (solid blue) renders DIFFERENT non-blank pixels — proves the
 *      `page` property actually switches which page rasterizes, not just
 *      "a PDF renders at all".
 *   3. An OUT-OF-RANGE page (99, doc has 2 pages) still renders NON-BLANK
 *      (clamped to the last page, not silently blanked) — the clamp-not-drop
 *      design choice from the module header.
 *   4. Zero page console errors OTHER than the expected once-only
 *      "out of range" report from check 3 (the codebase's "no unexpected
 *      console errors" convention — editor_smoke's zero-error gate is the
 *      precedent; this probe is more targeted since it EXPECTS one specific
 *      loud report and must not mask any OTHER error alongside it).
 *
 * IMPORTANT: this plugin is NOT registered in plugins/index.js by default
 * (SonnetC's fence forbids touching that shared file) — this probe imports
 * pdfPagePlugin directly and monkeypatches a throwaway registry via the same
 * createRegistry() core API real code uses, so it never depends on index.js
 * having the line added.
 *
 * Run (exit-code gated): node src/demo_apps/PowerRP/tests/pdf_page_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../../../..");

/** Query. A tiny 2-page PDF (page 1 solid red, page 2 solid blue, 200×260pt)
 * as a base64 data: URI — generated fresh every run via pdf-lib (already a
 * PowerRP dependency; no fixture file, no user-project writes). */
async function makeTwoPagePdfDataUri() {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([200, 260]);
  p1.drawRectangle({ x: 0, y: 0, width: 200, height: 260, color: rgb(1, 0, 0) });
  const p2 = doc.addPage([200, 260]);
  p2.drawRectangle({ x: 0, y: 0, width: 200, height: 260, color: rgb(0, 0, 1) });
  const bytes = await doc.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** A minimal doc: one pdf_page item over the default camera. `page` and `src`
 * come from the caller so the same builder serves all three checks. */
function makeDoc(src, page) {
  return {
    meta: { name: "pdf_page_probe", slideW: 200, slideH: 260 },
    slides: [{
      id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0, curve: "smooth" },
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: 200, h: 260, z: 1000, rotation: 0, scale: 1, active: true, background: "#ffffff" },
          pg: { type: "pdf_page", x: 0, y: 0, w: 200, h: 260, z: 0, rotation: 0, scale: 1, active: true, src, page },
        },
      },
    }],
  };
}

/** Pure function. RGBA Uint8ClampedArray → {r,g,b} mean over all pixels
 * (ignores alpha) — cheap "what color is this frame mostly" fingerprint,
 * enough to tell "blank white / red / blue" apart without a PNG decode.
 *
 * @example meanColor(new Uint8ClampedArray([255,0,0,255, 255,0,0,255])) // {r: 255, g: 0, b: 0}
 */
function meanColor(rgba) {
  let r = 0, g = 0, b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++) { r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const pdfDataUri = await makeTwoPagePdfDataUri();

// The REPO-ROOT vite.config.js (pdf_parity_test.js's own precedent) — NOT
// PowerRP's own web/vite.config.js, whose `root` is the web/ subfolder and
// would make absolute "/src/demo_apps/PowerRP/…" import paths 404. Serving
// from the repo root lets the in-page dynamic imports below use the exact
// same absolute paths pdf_parity_test.js's warmup() uses.
const { createServer } = await import("vite");
// port: 0 → an OS-assigned EPHEMERAL port (never a fixed number, never 3637 —
// the manifest's "never 3637" rule for probe servers).
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: true });

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  // NOT thrown (unlike a real app-boot smoke test): index.html mounts the
  // REPO-WIDE component hub (src/App.svelte, auto-discovering every demo),
  // not PowerRP itself — this probe never depends on that hub mounting
  // cleanly, only on being able to dynamically import PowerRP's own modules
  // from the same origin (pdf_parity_test.js's exact precedent). A hub-mount
  // error from an unrelated concurrent fleet edit to shared hub/lib files
  // must not fail THIS widget's probe.
  page.on("pageerror", (e) => console.log(`  (hub pageerror, ignored — not this widget's concern): ${e.message}`));
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });

  /** Command (in-page setup). Builds a throwaway registry with pdf_page
   * registered (bypassing plugins/index.js entirely, per the fence — this
   * proves pdf_page.js is self-sufficient without depending on the lead
   * having landed the registration line yet) and installs
   * window.__pdfPageProbeRender, the SAME fold→evaluate→derive→emit→GPU
   * pipeline window.__powerrp_render (web/main.js) uses. */
  async function installRenderHook(page) {
    await page.evaluate(async () => {
      const { createRegistry } = await import("/src/demo_apps/PowerRP/core/registry.js");
      const { createCommands } = await import("/src/demo_apps/PowerRP/core/commands.js");
      const { registerAll } = await import("/src/demo_apps/PowerRP/plugins/index.js");
      const { pdfPagePlugin } = await import("/src/demo_apps/PowerRP/plugins/pdf_page.js");
      const { foldState, repairedDocument } = await import("/src/demo_apps/PowerRP/core/document.js");
      const { cameraRect } = await import("/src/demo_apps/PowerRP/core/derive.js");
      const { evaluateState } = await import("/src/demo_apps/PowerRP/core/expressions.js");
      const { fitRectView } = await import("/src/demo_apps/PowerRP/core/view.js");
      const { parseColor } = await import("/src/demo_apps/PowerRP/render_gpu/ir.js");
      const { GpuCompositor } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js");
      const { cameraFrameIR } = await import("/src/demo_apps/PowerRP/web/cameraFrame.js");

      const registry = createRegistry();
      registerAll(registry, createCommands());
      // Registered defensively: once the lead lands the plugins/index.js
      // line, registerAll() above will have already registered "pdf_page" —
      // re-registering the same type would throw ("Duplicate plugin type").
      try { registry.get("pdf_page"); } catch { registry.register(pdfPagePlugin); }

      window.__pdfPageProbeRender = async function (doc, { slide = 0, alpha = 1, width, height } = {}) {
        const { doc: repaired, reports } = repairedDocument(doc, registry);
        for (const r of reports) console.error(`repair: ${JSON.stringify(r)}`); // loud, never silent (house rule)
        const state = evaluateState(foldState(repaired, slide, alpha), registry).state;
        const rect = cameraRect(state, repaired.meta);
        const view = fitRectView(rect, width, height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const gpu = await GpuCompositor.create(canvas);
        gpu.render(cameraFrameIR(state, repaired.meta, registry), view, { background: parseColor(rect.background) });
        return Array.from(await gpu.readPixels(0, 0, width, height));
      };
    });
  }

  // Vite pre-bundles each NEW dependency on FIRST import and force-reloads
  // the page mid-evaluate (pdf_parity_test.js's documented gotcha —
  // concerns.md "GOTCHA: the FIRST run after pdf-lib was added dies
  // mid-run"). pdfjs-dist is a NEW heavy dep this widget introduces (loaded
  // LAZILY inside loadPdfjs() per the lead's fleet-blocking fix — see
  // pdf_page_raster.js — so the optimizer discovers it on the FIRST actual
  // rasterization call, not at page load); runAcrossReloads retries ANY
  // in-page call across that one-time reload, re-installing the render hook
  // (a fresh page load has none of it) before retrying the caller's step.
  const RELOAD_TIMEOUT_MS = 90_000;
  const WARMUP_TRIES = 5;
  async function runAcrossReloads(step) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (e) {
        if (attempt >= WARMUP_TRIES || !/Execution context was destroyed|Failed to fetch dynamically imported module/.test(String(e))) throw e;
        console.log(`  (vite re-optimized deps and reloaded — warmup retry ${attempt})`);
        await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: RELOAD_TIMEOUT_MS });
        await installRenderHook(page); // the reload wiped window.__pdfPageProbeRender — reinstall before the next attempt
      }
    }
  }

  await runAcrossReloads(() => installRenderHook(page));

  const W = 100, H = 130; // half the PDF's own pt size — exercises non-1:1 raster scale too

  // Force pdfjs-dist's dependency optimization (and its one-time reload) to
  // happen HERE, deterministically, rather than mid-poll inside
  // renderUntilNonBlank below — a throwaway 1-page PDF, rendered once and
  // discarded, whose only job is to trigger the FIRST real ensurePdfDoc call.
  const warmupPdf = await makeTwoPagePdfDataUri();
  await runAcrossReloads(() => page.evaluate(
    (d, w, h) => window.__pdfPageProbeRender(d, { width: w, height: h }),
    makeDoc(warmupPdf, 1), W, H,
  ));

  /** Query (in-page). Renders `doc`, polling (the async rasterize-then-repaint
   * contract — pdf_page_raster.js/image_registry.js draw nothing until the
   * bitmap lands) until the frame stops being the plain white camera
   * background, or `tries` is exhausted. */
  async function renderUntilNonBlank(doc, tries = 40) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const px = await runAcrossReloads(() => page.evaluate(
        (d, w, h) => window.__pdfPageProbeRender(d, { width: w, height: h }),
        doc, W, H,
      ));
      const rgba = new Uint8ClampedArray(px);
      const mean = meanColor(rgba);
      last = mean;
      // The camera background is #ffffff — a frame that is still ~pure white
      // means the page hasn't rasterized (and repainted) yet.
      if (mean.r < 250 || mean.g < 250 || mean.b < 250) return { mean, tries: i + 1 };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { mean: last, tries, timedOut: true };
  }

  // ── check 1: page 1 (red) renders non-blank ────────────────────────────────
  const r1 = await renderUntilNonBlank(makeDoc(pdfDataUri, 1));
  check("page 1 renders non-blank pixels", !r1.timedOut, `mean=${JSON.stringify(r1.mean)} after ${r1.tries} tries`);
  check("page 1 reads as RED-dominant", r1.mean.r > r1.mean.b + 40, `mean=${JSON.stringify(r1.mean)}`);

  // ── check 2: page 2 (blue) renders non-blank AND differs from page 1 ───────
  const r2 = await renderUntilNonBlank(makeDoc(pdfDataUri, 2));
  check("page 2 renders non-blank pixels", !r2.timedOut, `mean=${JSON.stringify(r2.mean)} after ${r2.tries} tries`);
  check("page 2 reads as BLUE-dominant", r2.mean.b > r2.mean.r + 40, `mean=${JSON.stringify(r2.mean)}`);
  check("page switching changes the rendered pixels", Math.abs(r1.mean.r - r2.mean.r) > 40 || Math.abs(r1.mean.b - r2.mean.b) > 40,
    `page1=${JSON.stringify(r1.mean)} page2=${JSON.stringify(r2.mean)}`);

  // ── check 3: out-of-range page clamps to the last page, still non-blank ───
  const rOOR = await renderUntilNonBlank(makeDoc(pdfDataUri, 99));
  check("out-of-range page (99 of 2) still renders non-blank (clamped, not blanked)", !rOOR.timedOut, `mean=${JSON.stringify(rOOR.mean)}`);
  check("out-of-range page clamps to the LAST page (blue), not page 1", rOOR.mean.b > rOOR.mean.r + 40, `mean=${JSON.stringify(rOOR.mean)}`);

  // ── check 4: exactly the expected loud report, nothing else ───────────────
  const rangeReports = consoleErrors.filter((m) => m.includes("pdf_page: page 99 is out of range"));
  // "Unexpected" is scoped to THIS WIDGET's own logic (pdf_page/pdf_page_raster/
  // image_registry) plus generic app-level "repair:" noise from the doc
  // repair pipeline this probe's fold→evaluate path runs through — a bare
  // resource-loading 404 (e.g. the repo hub's favicon, or another concurrent
  // fleet agent's in-flight edit to shared hub/lib files this probe's shared
  // dev server also serves) is orthogonal to whether pdf_page.js itself
  // behaves correctly, so it is NOT this probe's concern to gate on.
  const mine = consoleErrors.filter((m) => /pdf_page|pdf_page_raster|image_registry|pdfjs/.test(m));
  const unexpectedMine = mine.filter((m) => !m.includes("pdf_page: page 99 is out of range"));
  check("the out-of-range request was reported loudly (reportOnce)", rangeReports.length >= 1, `console errors: ${JSON.stringify(consoleErrors)}`);
  check("no OTHER unexpected console errors from pdf_page/pdf_page_raster/image_registry", unexpectedMine.length === 0, `unexpected: ${JSON.stringify(unexpectedMine)}; ALL console errors (incl. unrelated app/hub noise): ${JSON.stringify(consoleErrors)}`);

  console.log(failures === 0 ? "\nAll pdf_page probe checks passed." : `\n${failures} pdf_page probe check(s) FAILED.`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(failures === 0 ? 0 : 1);
