/**
 * BOOT SPLASH SCREENSHOT SEQUENCE (WORKSTREAM AH) — not a probe, a camera.
 *
 * Deliberately NOT named `*_probe` so the gate never collects it: it asserts
 * nothing, it photographs. It exists because the claim "the splash shows real,
 * granular progress" is a claim about what a HUMAN SEES, and the only honest
 * evidence for that is pictures of the thing while it boots.
 *
 * Builds the static bundle, boots it COLD in a fresh browser context (no service
 * worker, no cache — see boot_timeline_measure.mjs for why that distinction ate
 * two rounds of measurement) under network throttling so the stages are legible,
 * and captures a frame every SHOT_INTERVAL_MS until the splash lifts. Then boots
 * WARM in the same context to photograph the no-flash path.
 *
 * Usage: node src/demo_apps/PowerRP/tests/boot_splash_shots.mjs [outDir]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BASE = "/SvelteLib/";
const OUT = resolve(process.argv[2] || resolve(HERE, "../.claude_shots/boot_ah"));
const SHOT_INTERVAL_MS = 1500;   // fast enough to catch each stage, slow enough not to perturb the boot
const MAX_SHOTS = 60;
const BOOT_SETTLE_MS = 300000;
/** Fast-3G. Slow enough that each stage occupies several frames instead of all
 *  of them collapsing into one screenshot on a localhost-speed link. */
const THROTTLE = { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 };

mkdirSync(OUT, { recursive: true });
process.env.POWERRP_BASE = BASE;
const { build, preview } = await import("vite");
console.log(`building static bundle …`);
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });
const server = await preview({ configFile: resolve(webRoot, "vite.config.js"), preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const url = `${origin}${BASE}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ protocolTimeout: 300000 });
const ctx = await browser.createBrowserContext(); // cold by construction
const page = await ctx.newPage();
await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
await page.setCacheEnabled(false);
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", THROTTLE);

const shots = [];
let lifted = false;
const t0 = Date.now();
page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS }).catch(() => {});
// Wait for the splash to EXIST before the first frame. Shooting immediately
// caught the previous document (about:blank), reported "(splash gone)" and
// exited after one frame — a camera pointed at the wrong moment.
await page.waitForFunction(() => !!document.getElementById("boot-splash"), { timeout: 60000, polling: 20 }).catch(() => {});
page.waitForFunction(() => !document.getElementById("boot-splash"), { timeout: BOOT_SETTLE_MS, polling: 100 })
  .then(() => { lifted = true; })
  .catch(() => {});

for (let i = 0; i < MAX_SHOTS && !lifted; i++) {
  const t = Date.now() - t0;
  const name = `cold_${String(i).padStart(2, "0")}_${t}ms.png`;
  await page.screenshot({ path: resolve(OUT, name) }).catch(() => {});
  // The visible stage text, captured alongside the pixels so the sequence is
  // greppable without opening 40 PNGs.
  const rows = await page.evaluate(() => {
    const el = document.getElementById("boot-stages");
    if (!el) return null;
    return [...el.querySelectorAll(".boot-row")].map((r) => ({
      stage: r.getAttribute("data-stage"),
      state: r.getAttribute("data-state"),
      text: r.textContent.replace(/\s+/g, " ").trim(),
    }));
  }).catch(() => null);
  shots.push({ t, name, rows });
  console.log(`  +${t}ms ${rows ? rows.filter((r) => r.state !== "pending").map((r) => `${r.state === "done" ? "✓" : "›"}${r.text}`).join(" | ") : "(splash gone)"}`);
  await new Promise((r) => setTimeout(r, SHOT_INTERVAL_MS));
}
console.log(`cold boot: splash lifted after ${Date.now() - t0}ms, ${shots.length} frames`);

// WARM: same context (cache + worker retained), no throttle — the path that must
// stay silent and fast, with no progress UI flash.
// Network.disable is how emulation is actually lifted; passing -1 throughputs to
// emulateNetworkConditions left Fast-3G in force and made the "warm" boot take
// 301 s, which would have been reported as a warm-path regression that did not exist.
await cdp.send("Network.disable");
await page.setCacheEnabled(true);
const w0 = Date.now();
page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
for (let i = 0; i < 4; i++) {
  await page.screenshot({ path: resolve(OUT, `warm_${i}_${Date.now() - w0}ms.png`) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}
await page.waitForFunction(() => !document.getElementById("boot-splash"), { timeout: 60000, polling: 50 }).catch(() => {});
console.log(`warm boot: splash lifted after ${Date.now() - w0}ms`);

writeFileSync(resolve(OUT, "sequence.json"), JSON.stringify(shots, null, 2));
console.log(`wrote ${OUT}`);
await browser.close();
server.httpServer.close();
process.exit(0);
