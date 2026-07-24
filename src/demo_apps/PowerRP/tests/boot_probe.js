/**
 * MINIMAL BOOT PROBE — self-spins Vite + headless Chromium, loads the editor at
 * "/", and captures pageerror / console.error during app initialization. This
 * REPLICATES a boot crash (e.g. the App.svelte:719 "addEventListener of
 * undefined") headlessly so it can be diagnosed + confirmed fixed. Filters the
 * known-benign noise (backend-absent 404s, a browser extension's crypto.randomUUID
 * / Credentials-API warnings) so only real app errors fail it. cwd-independent.
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

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

// Backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no server.py),
// so asset/thumbnail API calls 500/ECONNREFUSED. Plus a browser extension's
// crypto.randomUUID / Credentials warnings, and the loud-but-benign repair reports.
const IGNORE = /Failed to load resource|thumbnail|\/api\/thumb|\/api\/assets|listAssets|could not list project assets|500 Internal Server Error|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect/i;
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // Capture EVERYTHING verbatim (pageerror w/ stack, unhandled rejections, all
  // console) — attached BEFORE navigation so nothing is missed.
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !IGNORE.test(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener("unhandledrejection", (ev) => console.error("UNHANDLED_REJECTION: " + (ev.reason?.stack || ev.reason?.message || ev.reason)));
    window.addEventListener("error", (ev) => console.error("WINDOW_ERROR: " + (ev.error?.stack || ev.message)));
  });
  await page.goto(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/", { waitUntil: "networkidle0" }).catch((e) => errors.push(`goto: ${e.message}`));
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const alive = await page.evaluate(() => !!window.__powerrp_app);
  if (errors.length || !alive) {
    console.log(`BOOT FAILED (alive=${alive}):\n` + (errors.join("\n") || "(no captured error, but __powerrp_app never initialized)"));
    process.exit(1);
  }
  console.log("BOOT OK — app initialized (__powerrp_app present), no page errors");
} finally {
  await browser.close();
  if (server) await server.close();
}
