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

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

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
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const alive = await page.evaluate(() => !!window.__powerrp_app);
  if (errors.length || !alive) {
    console.log(`BOOT FAILED (alive=${alive}):\n` + (errors.join("\n") || "(no captured error, but __powerrp_app never initialized)"));
    process.exit(1);
  }
  console.log("BOOT OK — app initialized (__powerrp_app present), no page errors");
} finally {
  await browser.close();
  await server.close();
}
