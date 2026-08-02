/**
 * PDF DROP — the user-reported bug, proven in a real browser.
 *
 * "PowerRP: nothing on the canvas can show a 'pdf' asset
 * (MagickWithSupplementary.pdf) — it stays in the asset library."
 *
 * That message came from `insertDroppedAsset`'s default branch because the
 * classifier tested `kind === "image" || kind === "video"`. `pdf_page` had
 * shipped long before, so the sentence was true about one line of code and false
 * about the app. tests/asset_drop_test.js gates the CLASSIFICATION in bare node;
 * this proves the whole path end to end, in the place it actually failed — an
 * inserted widget of the right type, at the PDF's own page size.
 *
 * NO SCREENSHOTS, DELIBERATELY. Every assertion here is a `page.evaluate` read of
 * document state, so this probe is unaffected by the host Chrome capture hang
 * that turns 64 other probes into bare ProtocolErrors (CLAUDE.md's preflight
 * note). Nothing about this bug needs a picture: the question is whether an item
 * exists and how big it is.
 *
 * Self-contained: `node src/demo_apps/PowerRP/tests/pdf_drop_probe.js`
 * (spins its own Vite; no backend needed — the fixture rides in as a data: URI,
 * which pdf.js accepts directly).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "pdf_vector_fixture.pdf");
const PDF_DATA_URI = "data:application/pdf;base64," + fs.readFileSync(FIXTURE).toString("base64");

/** The generic box a fresh, unsourced pdf_page carries (plugins/pdf_page.js
 *  defaults). A dropped PDF must NOT land at this — landing at its own page size
 *  is the whole point of measuring, and this is what proves it was measured. */
const UNSOURCED_DEFAULT = { w: 320, h: 414 };

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

async function main() {
  const webRoot = path.resolve(HERE, "../web");
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: path.resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    // `no WebGPU adapter` / VideoV7 is a HOST FACT, not a defect, and eight other
    // probes already ignore it (activation, asset_ux, boot, boot_splash, …). The
    // demo VideoV7 widget probes for WebGPU at boot, does not find one on a
    // GPU-less CI host, and REPORTS that it fell back to 2D — which is the house
    // rule working, so treating its own loudness as a red would punish it.
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 800));

    // ── THE CLASSIFICATION, on the live registry the app actually built ──────
    const classified = await page.evaluate(async () => {
      const app = window.__powerrp_app;
      const { assetDropKind } = await import("/pluginAssetLoader.js");
      return {
        pdf: assetDropKind({ name: "MagickWithSupplementary.pdf", kind: "pdf" }, app.registry),
        image: assetDropKind({ name: "logo.png", kind: "image" }, app.registry),
        sound: assetDropKind({ name: "ding.wav", kind: "sound" }, app.registry),
      };
    });
    ok(classified.pdf === "media", `the user's own filename classifies as media, not the refusal (got "${classified.pdf}")`);
    ok(classified.image === "media", `an image still classifies as media (got "${classified.image}")`);
    ok(classified.sound === "none", `a sound still classifies as none — the refusal is still reachable for kinds that deserve it (got "${classified.sound}")`);

    // ── THE INSERT, through the same method the drop handler calls ───────────
    // Vite's root is web/, so a module OUTSIDE it is reached through the /@fs/
    // absolute-path form rather than a relative escape (a plain "../" 404s).
    const rasterModule = "/@fs" + path.resolve(HERE, "../render_gpu/gpu/pdf_page_raster.js");
    const placed = await page.evaluate(async (uri, rasterMod) => {
      const app = window.__powerrp_app;
      const before = Object.keys(app.state().items).length;
      await app.insertAssetWidget({ name: "MagickWithSupplementary.pdf", kind: "pdf", url: uri }, { x: 500, y: 400 });
      const items = app.state().items;
      const added = Object.entries(items).filter(([, s]) => s.type === "pdf_page").map(([id, s]) => ({ id, ...s }));
      // What pdf.js itself says the page measures — the assertion's other half.
      const { pdfPagePointSize } = await import(/* @vite-ignore */ rasterMod);
      return { grew: Object.keys(items).length - before, item: added.at(-1) ?? null, measured: pdfPagePointSize(uri, 1) };
    }, PDF_DATA_URI, rasterModule);

    ok(placed.grew === 1, `exactly one item was added (got ${placed.grew})`);
    ok(placed.item !== null, "THE FIX: dropping a PDF creates a pdf_page widget on the canvas");
    if (placed.item) {
      ok(placed.item.src?.length > 0, "the widget's src points at the dropped PDF");
      const { w, h } = placed.item;
      ok(placed.measured !== null, "pdf.js measured the page (the measurement seam ran at all)");
      if (placed.measured) {
        ok(Math.abs(w - placed.measured.w) < 1 && Math.abs(h - placed.measured.h) < 1,
          `it landed at the PDF's OWN page size — ${w}x${h} vs pdf.js's ${placed.measured.w}x${placed.measured.h}`);
      }
      ok(!(w === UNSOURCED_DEFAULT.w && h === UNSOURCED_DEFAULT.h),
        `it did NOT land at the unsourced default ${UNSOURCED_DEFAULT.w}x${UNSOURCED_DEFAULT.h} — that would mean nothing measured it`);
      // Centered on the drop point, the same contract as an image drop.
      ok(Math.abs((placed.item.x + w / 2) - 500) < 1 && Math.abs((placed.item.y + h / 2) - 400) < 1,
        `it is CENTERED on the drop point (center ${placed.item.x + w / 2},${placed.item.y + h / 2} vs 500,400)`);
    }

    // ── AND THE REFUSAL STILL WORKS for a kind nothing claims ────────────────
    const refused = await page.evaluate(async (uri) => {
      const app = window.__powerrp_app;
      try { await app.insertAssetWidget({ name: "ding.wav", kind: "sound", url: uri }); return "no error"; }
      catch (e) { return e.message; }
    }, PDF_DATA_URI);
    ok(/no widget claims/.test(refused), `an unclaimed kind refuses LOUDLY rather than inserting something arbitrary (got "${refused}")`);

    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} pdf-drop checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("pdf_drop_probe ERROR:", e); process.exit(1); });
