/**
 * MANUAL REAL-GIBS SCREENSHOT PASS — not a gate test (no `_test`/`_probe` suffix,
 * so tests/run_all.mjs does not collect it). Boots the real editor with NO tile
 * interception, so every request is a REAL fetch against gibs.earthdata.nasa.gov —
 * the one-time acceptance check the globe4326_ mission asked for: whole globe with
 * real polar imagery, a pole close-up, and a crossfade pair either side of
 * GLOBE_FLAT_CROSSOVER. Run by hand, not in CI, for the same reason
 * tests/_scratch_globequal_shots.mjs is (OSM/GIBS policy: no automated suite may
 * bulk-fetch real tiles on every run).
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/_scratch_real_gibs_shot.mjs
 * PNGs land in .claude_logs/geotiles/, prefixed REAL_.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const webRoot = resolve(appRoot, "web");
const outDir = resolve(appRoot, ".claude_logs", "geotiles");
await mkdir(outDir, { recursive: true });

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    const out = resolve(outDir, name);
    await canvas.screenshot({ path: out });
    console.log("shot", name);
  };

  // 1. WHOLE GLOBE, real satellite imagery, pinned to globe view.
  const built = await page.evaluate((MAP_BOX) => {
    const app = window.__powerrp_app;
    app.addItem({
      ...app.registry.get("demo_globe_map").defaults,
      x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h,
      style: "satellite", viewMode: "globe", centerLon: 8, centerLat: 24, zoom: 0.6,
    });
    return { id: app.selection };
  }, { x: 240, y: 60, w: 600, h: 600 });
  await new Promise((r) => setTimeout(r, 6000)); // real network fetch — allow real time
  await shoot("REAL_01_whole_globe_real_imagery.png");

  // 2. POLE CLOSE-UP with real imagery.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "centerLat"], 89], [["items", id, "zoom"], 2]]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, 5000));
  await shoot("REAL_02_pole_closeup_real_imagery.png");

  // 3. CROSSFADE PAIR at the threshold, real imagery.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "viewMode"], "auto"], [["items", id, "zoom"], 4.9],
      [["items", id, "centerLon"], 8], [["items", id, "centerLat"], 24],
    ]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, 30000));
  await shoot("REAL_03a_crossfade_below.png");
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "zoom"], 5.6]]);
    app.commitPreview();
  }, built.id);
  await new Promise((r) => setTimeout(r, 5000));
  await shoot("REAL_03b_crossfade_above.png");

  console.log("done");
} finally {
  await browser.close();
  await server.close();
}
