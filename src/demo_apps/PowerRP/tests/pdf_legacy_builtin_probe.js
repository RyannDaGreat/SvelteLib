/**
 * PDF THUMBNAILS MUST RENDER ON A BROWSER WITHOUT `Map.prototype.getOrInsertComputed`.
 *
 * The user's live-site console (2026-08-02, WORKSTREAM AX):
 *   AssetThumb: thumbnail render failed for "…dnd_character_sheet.pdf":
 *   TypeError: i(...).getOrInsertComputed is not a function
 *     at VA.ph → VA.getOptionalContentConfig → og.render
 *
 * pdfjs-dist 5.7's MODERN build calls `Map.prototype.getOrInsertComputed` — the
 * TC39 upsert proposal — as a native builtin with no polyfill. Chrome shipped
 * that method only very recently, so on an ordinary slightly-older Chrome every
 * PDF page render throws and every PDF asset thumbnail fails. The fix is the
 * LEGACY pdf.js build (main AND worker), which bundles core-js's polyfill for
 * exactly this method; see the block comment in gpu/pdf_page_raster.js.
 *
 * ── WHY THIS PROBE HAS TO DELETE A BUILTIN ────────────────────────────────────
 * THE GATE'S OWN CHROME HAS THE METHOD. That is the entire reason this bug
 * reached a user: a probe that merely renders a PDF thumbnail passes on the
 * modern build too, on this host, forever. So the probe must MANUFACTURE the
 * user's browser rather than wait to be run on one — `delete
 * Map.prototype.getOrInsertComputed` (plus the WeakMap twin, which the same
 * pdf.js code paths use) in an evaluateOnNewDocument hook, i.e. BEFORE any app
 * or pdf.js module evaluates. Under that deletion the modern build throws the
 * user's exact TypeError and the legacy build does not, which is what makes this
 * a real assertion instead of a tautology.
 *
 * Deleting a builtin is legitimate here and nowhere near a general-purpose trick:
 * absence is a genuine state of a real browser we ship to, and simulating it is
 * strictly more honest than pinning our correctness to whatever Chrome the CI
 * host happens to have installed this month.
 *
 * ── WHAT IT ASSERTS, IN THE PLACE THAT FAILED ─────────────────────────────────
 * Both modes (deleted / present) run the SAME three checks through the SAME seam
 * the user's crash came from — `app.ensureAssetThumbnail`, not a hand-rolled
 * pdfjs call:
 *   1. it resolves (no throw);
 *   2. its data: URL decodes to a bitmap with NON-BLANK pixels — a thumbnail
 *      that renders a uniform white rectangle is a silent failure, and the
 *      point of this widget is that a PDF's page is visible;
 *   3. zero page errors / console errors naming the builtin.
 * Check 2 is why this probe decodes rather than trusting a non-empty string:
 * pdf.js can hand back a correctly-sized canvas it never drew into.
 *
 * NO page.screenshot, deliberately — every read is a page.evaluate, so this
 * probe is immune to the host Chrome capture hang that turns 64 other probes
 * into bare ProtocolErrors (CLAUDE.md's preflight note).
 *
 * FAILS-ON-PARENT, MEASURED (not asserted). Running this probe against the
 * pre-fix `pdf_page_raster.js` (the modern build) reproduces the user's crash
 * with the same three-frame stack, unminified:
 *   FAIL WITHOUT the builtin: ensureAssetThumbnail returned a thumbnail —
 *   __privateGet(...).getOrInsertComputed is not a function
 *     WorkerTransport.cacheSimpleMethod_fn
 *     WorkerTransport.getOptionalContentConfig
 *     _PDFPageProxy.render
 * Compare the live-site console at the top of this file (`VA.ph →
 * VA.getOptionalContentConfig → og.render`) — the same three frames, minified.
 * That correspondence is what makes this probe a pin on the USER'S bug rather
 * than on a plausible-looking reconstruction of it.
 *
 * Self-contained: `node src/demo_apps/PowerRP/tests/pdf_legacy_builtin_probe.js`
 * (spins its own Vite; no backend needed — the fixture rides in as a data: URI,
 * which pdf.js accepts directly).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const PDF_DATA_URI = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");

/** A thumbnail is at most this many px on its long edge (asset_thumbnail.js
 *  THUMBNAIL_MAX_EDGE). Asserting the decoded bitmap fits inside it is a cheap
 *  check that we decoded the THUMBNAIL and not something else. */
const MAX_EDGE = 256;
/** Channel distance from pure white beyond which a pixel counts as ink. Well
 *  above 8-bit/JPEG-ish noise, well below any real mark on a page. */
const INK_THRESHOLD = 24;
/** A page fixture must put at least this fraction of its pixels above the ink
 *  threshold. A blank-page render scores 0; the fixture measures far above this,
 *  so the margin is deliberately generous rather than tuned. */
const MIN_INK_FRACTION = 0.005;

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

/**
 * Command (drives a real browser). Boots the app in a fresh page, optionally
 * deleting the upsert builtins first, renders a PDF thumbnail through
 * app.ensureAssetThumbnail, and measures its ink.
 *
 * Args:
 *   browser: a puppeteer Browser
 *   baseUrl (string): the Vite origin
 *   deleteBuiltin (boolean): simulate a browser that never shipped the method
 *
 * Returns:
 *   {hadBuiltin, thumbnailOk, width, height, inkFraction, errors: string[]}
 *
 * @example // await renderThumbnailUnder(browser, url, true)
 * //   → {hadBuiltin: false, thumbnailOk: true, width: 198, height: 256,
 * //      inkFraction: 0.031, errors: []}
 */
async function renderThumbnailUnder(browser, baseUrl, deleteBuiltin) {
  const page = await browser.newPage();
  try {
    if (deleteBuiltin) {
      // BEFORE any document script — this must beat pdf.js's own evaluation, or
      // a module that captured the method at load time would keep working and
      // the probe would prove nothing.
      await page.evaluateOnNewDocument(() => {
        delete Map.prototype.getOrInsertComputed;
        delete WeakMap.prototype.getOrInsertComputed;
        // The `getOrInsert` sibling from the same proposal ships alongside it;
        // a browser lacking one lacks the other, so simulate the real pairing.
        delete Map.prototype.getOrInsert;
        delete WeakMap.prototype.getOrInsert;
      });
    }
    const errors = [];
    // Host facts and unrelated-subsystem noise, ignored on the same grounds as
    // tests/pdf_drop_probe.js's identical list (a GPU-less CI host reporting no
    // WebGPU adapter is the house loudness rule WORKING, not a defect). The
    // thumbnail path is NOT ignored here even though that probe ignores it —
    // this probe exists to read exactly those messages.
    const IGNORE = /Failed to load resource|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });

    // Read the simulation's own state in its OWN evaluate, BEFORE the render.
    // Folded into the render's return value it would be lost whenever the render
    // throws — which is precisely the case this probe is about, and the case
    // where "did the delete actually take?" matters most.
    const hadBuiltin = await page.evaluate(() => typeof Map.prototype.getOrInsertComputed === "function");

    const measured = await page.evaluate(async (uri, maxEdge, inkThreshold) => {
      const app = window.__powerrp_app;
      // THE SEAM FROM THE CRASH REPORT. An asset with no `thumbnail` field is
      // what makes assetTilePresentation report needsClientThumbnail, which is
      // the branch that rasterizes.
      const res = await app.ensureAssetThumbnail(
        { name: "probe_fixture.pdf", kind: "pdf", url: uri, mtime: 1 },
        app.projectName(),
      );
      if (!res || typeof res.thumbnail !== "string")
        return { thumbnailOk: false, reason: `no thumbnail returned (${JSON.stringify(res)})` };

      // Decode and measure ink — a correctly-sized but never-drawn canvas is the
      // silent failure this check exists to catch.
      const bmp = await createImageBitmap(await (await fetch(res.thumbnail)).blob());
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      let inked = 0;
      for (let i = 0; i < data.length; i += 4) {
        const dist = Math.max(255 - data[i], 255 - data[i + 1], 255 - data[i + 2]);
        if (dist > inkThreshold) inked++;
      }
      return {
        thumbnailOk: true,
        width: bmp.width,
        height: bmp.height,
        withinMaxEdge: Math.max(bmp.width, bmp.height) <= maxEdge,
        inkFraction: inked / (bmp.width * bmp.height),
      };
    }, PDF_DATA_URI, MAX_EDGE, INK_THRESHOLD).catch((e) => ({ thumbnailOk: false, reason: String(e && e.message ? e.message : e) }));

    return { hadBuiltin, ...measured, errors };
  } finally {
    await page.close();
  }
}

async function main() {
  const webRoot = path.resolve(HERE, "../web");
  const { createServer } = await import("vite");
  // HMR OFF, for the same reason cli/render_job.js turns it off: a source edit
  // landing mid-run reloads the page and destroys the execution context this
  // probe is awaiting inside ("Execution context was destroyed, most likely
  // because of a navigation" — observed, from another agent touching
  // core/properties.js while this ran). That is not a PDF fact, and letting it
  // through would make this probe report a rival's keystroke as a pdf.js
  // regression.
  const server = await createServer({
    configFile: path.resolve(webRoot, "vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
  });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    for (const deleteBuiltin of [true, false]) {
      const mode = deleteBuiltin ? "WITHOUT the builtin (the user's browser)" : "WITH the builtin (modern Chrome)";
      const r = await renderThumbnailUnder(browser, baseUrl, deleteBuiltin);

      // The simulation itself must be real — if the delete silently failed, every
      // check below would pass for the wrong reason.
      ok(r.hadBuiltin === !deleteBuiltin,
        `${mode}: the page's Map.prototype.getOrInsertComputed is ${deleteBuiltin ? "absent" : "present"} as intended (saw ${r.hadBuiltin ? "present" : "absent"})`);

      ok(r.thumbnailOk === true,
        `${mode}: ensureAssetThumbnail returned a thumbnail${r.thumbnailOk ? "" : ` — ${r.reason}`}`);
      if (r.thumbnailOk) {
        ok(r.withinMaxEdge === true,
          `${mode}: the decoded thumbnail fits the ${MAX_EDGE}px max edge (${r.width}x${r.height})`);
        ok(r.inkFraction > MIN_INK_FRACTION,
          `${mode}: the thumbnail has real ink, not a blank rectangle (${(r.inkFraction * 100).toFixed(2)}% of pixels, need >${(MIN_INK_FRACTION * 100).toFixed(2)}%)`);
      }

      const builtinErrors = r.errors.filter((e) => /getOrInsertComputed|getOrInsert\b/.test(e));
      ok(builtinErrors.length === 0,
        `${mode}: nothing reported a missing upsert builtin${builtinErrors.length ? ` — ${builtinErrors.join(" | ")}` : ""}`);
      ok(r.errors.length === 0,
        `${mode}: zero page/console errors${r.errors.length ? ` — ${r.errors.join(" | ")}` : ""}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = checks.filter(([pass]) => !pass);
  for (const [pass, label] of checks) console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
  console.log(`\npdf_legacy_builtin_probe: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
