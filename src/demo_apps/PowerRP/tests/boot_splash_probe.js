/**
 * BOOT SPLASH PROBE — the cold-load contract for the fix to "when loading the
 * site for the first time its a big gray box with no loading bar."
 *
 * Self-spins Vite + headless Chromium with a COLD CACHE and asserts, in order:
 *   1. THE SPLASH EXISTS AT DOCUMENT-START — checked from an
 *      evaluateOnNewDocument hook that runs before any bundle executes, because
 *      "covers the gray box from t=0" is exactly the property that a splash
 *      mounted by the app bundle would fail.
 *   2. REAL STAGES, MONOTONIC. The wasm stage must report byte progress that
 *      only ever grows and must reach its own total; the whole history must
 *      contain the wasm + font stages. A fake percentage would show up here as
 *      progress with no matching byte counts.
 *   3. THE WASM IS FETCHED EXACTLY ONCE. This is the regression guard for the
 *      prefetch: the naive `wasmBinary` version downloaded 7 MB twice (this
 *      CanvasKit build ignores that option), which the network log catches.
 *   4. THE SPLASH IS GONE AFTER THE FIRST FRAME, and its removal is tied to a
 *      real paint — app.renderFrameCount must be ≥ 1 when the splash is gone.
 *   5. NO console errors beyond the documented environment noise.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/boot_splash_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BOOT_SETTLE_MS = 20000; // cold wasm + ~12.5 MB of fonts on a software GL stack

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

// Same documented baseline noise the existing boot_probe.js filters: a
// frontend-only Vite (no server.py) 500s the asset APIs, and this GPU-less
// container exposes navigator.gpu but resolves no adapter.
const IGNORE = /Failed to load resource|thumbnail|\/api\/thumb|\/api\/assets|listAssets|could not list project assets|500 Internal Server Error|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect|no WebGPU adapter/i;

const failures = [];
const consoleErrors = [];
const wasmRequests = [];
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false); // COLD LOAD — the reported bug's condition
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (!IGNORE.test(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
  });
  // Count only requests that actually TRANSFER THE WASM PAYLOAD. In dev, Vite
  // resolves the `?url` import with a second request to the same path carrying
  // "?import" — that one returns a ~700-byte JS wrapper (the module exporting
  // the asset's URL string), not the 7 MB binary, so counting raw request lines
  // would report 2 downloads where only 1 payload moved. The response's
  // content-type is the honest discriminator: application/wasm vs text/javascript.
  page.on("response", async (res) => {
    const url = res.url();
    if (!/canvaskit/i.test(url) || !/\.wasm(\?|$)/.test(url)) return;
    const type = res.headers()["content-type"] || "";
    if (/application\/wasm/i.test(type)) wasmRequests.push(url);
  });

  // (1) Runs before ANY page script: record whether the splash was already in
  // the parsed document, and keep a copy of the stage history because the
  // splash element is REMOVED on success and would take its history with it.
  await page.evaluateOnNewDocument(() => {
    window.__probe = { splashAtStart: null, history: null };
    document.addEventListener("readystatechange", () => {
      if (window.__probe.splashAtStart === null && document.getElementById("boot-splash"))
        window.__probe.splashAtStart = true;
    });
    // The interactive check above can miss a very fast parse; also snapshot at
    // DOMContentLoaded, which is guaranteed to be after the inline splash.
    document.addEventListener("DOMContentLoaded", () => {
      if (window.__probe.splashAtStart === null)
        window.__probe.splashAtStart = !!document.getElementById("boot-splash");
      window.__probe.history = window.__powerrp_boot ? window.__powerrp_boot.history : null;
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  const atStart = await page.evaluate(() => ({
    splashAtStart: window.__probe.splashAtStart,
    hasBootApi: typeof window.__powerrp_boot === "object" && window.__powerrp_boot !== null,
  }));
  if (!atStart.splashAtStart) failures.push("splash #boot-splash was NOT in the document at DOMContentLoaded — it must be inline, before the bundle");
  if (!atStart.hasBootApi) failures.push("window.__powerrp_boot was not installed by the inline script");

  // Wait for the splash to be REMOVED — the success condition, tied to the first
  // real paint. Polls the live DOM rather than sleeping a fixed time.
  await page
    .waitForFunction(() => !document.getElementById("boot-splash"), { timeout: BOOT_SETTLE_MS })
    .catch(() => failures.push(`splash was still present after ${BOOT_SETTLE_MS}ms — it never lifted (the gray-box-forever failure mode)`));

  const after = await page.evaluate(() => ({
    splashGone: !document.getElementById("boot-splash"),
    frames: window.__powerrp_app ? window.__powerrp_app.renderFrameCount : 0,
    history: window.__probe.history,
  }));

  // (4) Removal must be caused by a real paint, not a timer.
  if (!after.splashGone) failures.push("splash still in the DOM after boot settled");
  if (!(after.frames >= 1)) failures.push(`splash lifted but renderFrameCount=${after.frames} — removal must follow a REAL painted frame, not a timer`);

  // (2) Stages: the history captured at DOMContentLoaded is the same live array
  // the splash pushes into, so it keeps filling after that snapshot.
  const history = after.history || [];
  const ids = [...new Set(history.map((h) => h.id))];
  for (const required of ["wasm", "fonts"])
    if (!ids.includes(required)) failures.push(`boot stage "${required}" never reported (saw: ${ids.join(", ") || "none"})`);

  const wasmStages = history.filter((h) => h.id === "wasm" && typeof h.loaded === "number");
  if (wasmStages.length < 2) {
    failures.push(`wasm stage reported ${wasmStages.length} progress events — expected a stream of byte updates`);
  } else {
    // Monotonic bytes, and it must actually finish rather than stall partway.
    for (let i = 1; i < wasmStages.length; i++)
      if (wasmStages[i].loaded < wasmStages[i - 1].loaded) {
        failures.push(`wasm byte progress went BACKWARDS: ${wasmStages[i - 1].loaded} → ${wasmStages[i].loaded}`);
        break;
      }
    const last = wasmStages[wasmStages.length - 1];
    if (!last.done) failures.push("wasm stage never reported done");
    if (!(last.loaded > 0)) failures.push(`wasm stage finished with loaded=${last.loaded} — no real bytes were counted`);
    // Honesty gate: whenever a total is claimed it must be the real byte total,
    // i.e. the final loaded count must equal it. A synthetic denominator fails here.
    if (typeof last.total === "number" && last.total > 0 && last.loaded !== last.total)
      failures.push(`wasm stage ended at ${last.loaded}/${last.total} — a claimed total must be the true byte count`);
    console.log(`wasm stage: ${wasmStages.length} updates, final ${last.loaded}${last.total ? "/" + last.total : " (indeterminate)"} bytes`);
  }

  const fontStages = history.filter((h) => h.id === "fonts" && typeof h.loaded === "number");
  if (fontStages.length) {
    const lastFont = fontStages[fontStages.length - 1];
    if (lastFont.loaded !== lastFont.total)
      failures.push(`font stage ended at ${lastFont.loaded}/${lastFont.total} faces — every face must be accounted for`);
    console.log(`fonts stage: ${fontStages.length} updates, final ${lastFont.loaded}/${lastFont.total} faces`);
  }

  // (3) THE single-download guard. Exactly one wasm PAYLOAD may cross the
  // network: the progress prefetch. CanvasKitInit then reads the same bytes back
  // through a blob: URL, which never touches the network — so a second
  // application/wasm response here means the prefetch is being paid twice.
  if (wasmRequests.length !== 1)
    failures.push(`canvaskit.wasm payload was fetched ${wasmRequests.length} times — the prefetched bytes must be handed to CanvasKitInit (blob: URL) so the 7 MB crosses the network exactly ONCE:\n  ${wasmRequests.join("\n  ")}`);
  console.log(`canvaskit.wasm payload fetches: ${wasmRequests.length}`);

  // (5)
  if (consoleErrors.length) failures.push("console errors during boot:\n  " + consoleErrors.join("\n  "));

  if (failures.length) {
    console.log("BOOT SPLASH PROBE FAILED:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log(`BOOT SPLASH OK — inline at document-start, ${ids.length} stages (${ids.join(", ")}), wasm fetched once, lifted after frame ${after.frames}`);
} finally {
  await browser.close();
  await server.close();
}
