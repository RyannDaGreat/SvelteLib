/**
 * MINIMAL BOOT PROBE — self-spins Vite + headless Chromium, loads the editor at
 * "/", and captures pageerror / console.error during app initialization. This
 * REPLICATES a boot crash (e.g. the App.svelte:719 "addEventListener of
 * undefined") headlessly so it can be diagnosed + confirmed fixed. Filters the
 * known-benign noise (backend-absent 404s, a browser extension's crypto.randomUUID
 * / Credentials-API warnings, and the GPU-less container's ONE no-adapter line — see
 * IGNORE_NO_GPU_ADAPTER) so only real app errors fail it, and PRINTS everything it
 * filtered so the allowlist cannot rot unseen. cwd-independent.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BOOT_SETTLE_MS = 4000; // Skia wasm + fonts + first paint

// If a URL is passed (argv[2]), probe that ALREADY-RUNNING server (reproduces a
// real user session, incl. its backend-loaded doc). Otherwise self-spin a fresh
// FRONTEND-ONLY Vite (empty doc, no backend).
const externalUrl = process.argv[2] && /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : null;
let server = null, baseUrl = externalUrl;
if (!externalUrl) {
  const { createServer } = await import("vite");
  server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
}

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

// Backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no server.py),
// so asset/thumbnail API calls 500/ECONNREFUSED. Plus a browser extension's
// crypto.randomUUID / Credentials warnings and the legacy preserveAspect notice.
// NOT repair reports: this probe boots an EMPTY document (nothing is seeded into
// localStorage), so the load-boundary repair has nothing to migrate and says nothing.
const IGNORE = /Failed to load resource|thumbnail|\/api\/thumb|\/api\/assets|listAssets|could not list project assets|500 Internal Server Error|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect/i;

// THE NO-ADAPTER CONDITION, and nothing wider. CanvasView mounts VideoV7Overlay
// unconditionally and its $effect runs at mount, so the overlay eagerly initializes
// a WebGPU device on EVERY boot — even here, where the document is empty and no
// video widget exists. This container exposes `navigator.gpu` but `requestAdapter()`
// resolves null, so that init reports a loud 2D fallback (correctly: silent
// fallbacks are forbidden). That is an ENVIRONMENT fact about a GPU-less container,
// not a product defect, and it is the whole of this probe's baseline redness.
// Deliberately NOT /VideoV7/ or /WebGPU/: a context-creation failure, a device-lost
// error, or any other overlay fault must still fail this probe. Same literal
// tests/boolean_uniformity_probe.js uses.
const IGNORE_NO_GPU_ADAPTER = /no WebGPU adapter/;
const errors = [];
const ignored = []; // filtered lines — always printed, so a stale filter stays visible
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // Capture EVERYTHING verbatim (pageerror w/ stack, unhandled rejections, all
  // console) — attached BEFORE navigation so nothing is missed.
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const line = `console.${m.type()}: ${m.text()}`;
    (IGNORE.test(m.text()) || IGNORE_NO_GPU_ADAPTER.test(m.text()) ? ignored : errors).push(line);
  });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener("unhandledrejection", (ev) => console.error("UNHANDLED_REJECTION: " + (ev.reason?.stack || ev.reason?.message || ev.reason)));
    window.addEventListener("error", (ev) => console.error("WINDOW_ERROR: " + (ev.error?.stack || ev.message)));
  });
  await page.goto(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/", { waitUntil: "networkidle0" }).catch((e) => errors.push(`goto: ${e.message}`));
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const alive = await page.evaluate(() => !!window.__powerrp_app);
  // Print what was filtered EITHER WAY. A filter nobody can see is how a stale
  // console allowlist hides a real error for a whole session.
  if (ignored.length) console.log(`IGNORED (known-benign) x${ignored.length}:\n` + ignored.join("\n"));
  if (errors.length || !alive) {
    console.log(`BOOT FAILED (alive=${alive}):\n` + (errors.join("\n") || "(no captured error, but __powerrp_app never initialized)"));
    process.exit(1);
  }
  console.log("BOOT OK — app initialized (__powerrp_app present), no page errors");
} finally {
  await browser.close();
  if (server) await server.close();
}
