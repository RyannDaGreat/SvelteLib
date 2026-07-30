/**
 * BOOT SPLASH — STATIC BUILD REHEARSAL. The dev server is not the deployment
 * the bug was reported against: the user said "GitHub Pages static site
 * especially", which is a `vite build --base /SvelteLib/` bundle served from a
 * subpath. This probe builds exactly that and serves it with `vite preview`,
 * then re-checks the splash contract there.
 *
 * WHAT IS DIFFERENT FROM boot_splash_probe.js, and why this exists separately:
 *   · THE BASE PATH. Every asset URL is emitted with the /SvelteLib/ prefix at
 *     BUILD time. The wasm prefetch is base-correct only because it reuses the
 *     Vite `?url` import rather than composing a path at runtime — this probe is
 *     what proves that claim, by asserting the wasm actually loads under the
 *     prefix and the boot completes. A hand-built "/canvaskit.wasm" would 404
 *     here while passing every dev-server test.
 *   · NO Vite module graph. In the built bundle there is no "?import&url"
 *     wrapper request, so the wasm payload count is checked directly.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/boot_splash_static_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BASE = "/SvelteLib/"; // the Pages project-site subpath the workflow deploys under
const BOOT_SETTLE_MS = 25000;

const { build, preview } = await import("vite");

// BUILD with the deploy base. POWERRP_BASE is the env var web/vite.config.js
// reads (it cannot be discovered at runtime — Vite bakes it into the bundle).
process.env.POWERRP_BASE = BASE;
console.log(`building static bundle with base ${BASE} …`);
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });

const server = await preview({
  configFile: resolve(webRoot, "vite.config.js"),
  preview: { port: 0, host: "127.0.0.1", open: false },
});
const port = server.httpServer.address().port;
const baseUrl = `http://127.0.0.1:${port}${BASE}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});

// A static build has NO backend, so the app runs in static/IndexedDB storage
// mode and the asset APIs legitimately 404. Same GPU-less container note as the
// other probes.
const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|404|500 Internal Server Error|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect|no WebGPU adapter/i;

const failures = [];
const consoleErrors = [];
const wasmPayloads = [];
const notFound = [];
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (/\.wasm(\?|$)/.test(url) && /application\/wasm/i.test(res.headers()["content-type"] || "")) wasmPayloads.push(url);
    // A 404 on our OWN bundle assets is the base-path bug this probe exists for.
    if (res.status() === 404 && /\.(js|css|wasm|ttf)(\?|$)/.test(url)) notFound.push(`${res.status()} ${url}`);
  });

  await page.evaluateOnNewDocument(() => {
    window.__probe = { splashAtStart: null, history: null };
    document.addEventListener("DOMContentLoaded", () => {
      window.__probe.splashAtStart = !!document.getElementById("boot-splash");
      window.__probe.history = window.__powerrp_boot ? window.__powerrp_boot.history : null;
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  const atStart = await page.evaluate(() => window.__probe.splashAtStart);
  if (!atStart) failures.push("splash was not inline in the BUILT index.html — the build must preserve it");

  await page
    .waitForFunction(() => !document.getElementById("boot-splash"), { timeout: BOOT_SETTLE_MS })
    .catch(() => failures.push(`splash never lifted in the static build after ${BOOT_SETTLE_MS}ms — boot did not reach a first frame under base ${BASE}`));

  const after = await page.evaluate(() => ({
    gone: !document.getElementById("boot-splash"),
    frames: window.__powerrp_app ? window.__powerrp_app.renderFrameCount : 0,
    history: window.__probe.history || [],
  }));

  if (!(after.frames >= 1)) failures.push(`renderFrameCount=${after.frames} — the static build never painted a real frame`);

  const wasmStages = after.history.filter((h) => h.id === "wasm" && typeof h.loaded === "number");
  if (!wasmStages.length) {
    failures.push("no wasm byte progress in the static build");
  } else {
    const last = wasmStages[wasmStages.length - 1];
    if (!(last.loaded > 0)) failures.push("wasm stage counted no bytes in the static build");
    console.log(`static wasm stage: ${wasmStages.length} updates, final ${last.loaded}${last.total ? "/" + last.total : " (indeterminate)"} bytes`);
  }

  // THE BASE-PATH ASSERTIONS.
  if (wasmPayloads.length !== 1)
    failures.push(`wasm payload fetched ${wasmPayloads.length} times in the static build:\n  ${wasmPayloads.join("\n  ")}`);
  for (const url of wasmPayloads)
    if (!url.includes(BASE)) failures.push(`wasm URL does not respect the deploy base ${BASE}: ${url}`);
  if (notFound.length) failures.push(`bundle assets 404ed under base ${BASE} (the classic static-deploy break):\n  ${notFound.join("\n  ")}`);
  if (consoleErrors.length) failures.push("console errors:\n  " + consoleErrors.join("\n  "));

  if (failures.length) {
    console.log("BOOT SPLASH STATIC PROBE FAILED:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log(`BOOT SPLASH STATIC OK — base ${BASE}, splash inline in the built HTML, wasm fetched once under the base, lifted after frame ${after.frames}`);
} finally {
  await browser.close();
  await server.httpServer.close();
}
