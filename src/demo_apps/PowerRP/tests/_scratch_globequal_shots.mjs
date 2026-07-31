/**
 * SCRATCH — one-off before/after screenshot capture for the globequal_ fix.
 * Not part of the test gate (leading underscore). Deletes/regenerates
 * .claude_logs/globequal/*.png. Reuses globe_map_probe.js's fixture-tile
 * interception pattern but skips its strict page-error assertion, which is
 * broken at baseline by a stale project-storage artifact unrelated to this fix
 * (confirmed via git stash: the same failure occurs with core/geo_tiles.js and
 * plugins/demo/globe_map.js reverted to HEAD).
 *
 * Run: node src/demo_apps/PowerRP/tests/_scratch_globequal_shots.mjs
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "globequal");
await mkdir(outDir, { recursive: true });

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const SLIDE = { w: 1280, h: 720 };
const MAP_BOX = { x: 240, y: 60, w: 800, h: 800 };
// A separate, larger box for the limb-crop shot specifically: at the app's
// default camera fit a 800-wide box renders at ~300px on-screen radius
// (24 subdivisions); presentation-scale globes are much bigger on screen, and
// the fix's effect (feathering that spans MULTIPLE quads instead of one) only
// becomes visually distinguishable through the checkerboard fixture's coarse
// cells once subdivision is high enough that each cell's own facets are
// finer than the feather band itself.
const LIMB_MAP_BOX = { x: -400, y: -400, w: 2400, h: 2400 };
const TILE_HOST_RE = /^https:\/\/[abc]\.tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/;

/** Pure function. A deterministic checkerboard PNG buffer for a given tile
 *  coordinate, so every screenshot run looks the same. */
function checkerTilePng(z, x, y) {
  const size = 256, cell = 32;
  const png = new PNG({ width: size, height: size });
  const hue = (x * 37 + y * 17 + z * 7) % 6;
  const colors = [[230, 90, 90], [230, 180, 80], [180, 220, 90], [90, 200, 170], [90, 150, 230], [170, 110, 220]];
  const [r, g, b] = colors[hue];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (size * py + px) << 2;
      const on = ((px / cell | 0) + (py / cell | 0)) % 2 === 0;
      png.data[idx] = on ? r : Math.floor(r * 0.6);
      png.data[idx + 1] = on ? g : Math.floor(g * 0.6);
      png.data[idx + 2] = on ? b : Math.floor(b * 0.6);
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("console", () => {}); // intentionally silent — this is a screenshot tool, not an assertion gate
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const m = TILE_HOST_RE.exec(req.url());
    if (!m) return void req.continue();
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    req.respond({ status: 200, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: checkerTilePng(z, x, y) });
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  /** Command (writes a PNG of the canvas). */
  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    const out = resolve(outDir, `${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  shot  ${name} -> ${out}`);
  };

  /** Command. Clears any existing item, deselects, then adds a fresh globe
   *  with the given overrides — a clean slate per shot so shots do not
   *  accumulate widgets or show selection handles. */
  const setGlobe = async (over) => {
    await page.evaluate((MAP_BOX, over) => {
      const app = window.__powerrp_app;
      for (const id of [...(app.state().items ? Object.keys(app.state().items) : [])]) {
        try { app.deleteItem?.(id); } catch {}
      }
      app.addItem({ ...app.registry.get("demo_globe_map").defaults, x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h, style: "osm", ...over });
      app.selectNone?.() ?? (app.selection = null);
    }, MAP_BOX, over);
    await new Promise((r) => setTimeout(r, 1800));
  };

  /** Command. Reads and re-writes a PNG scaled up by an integer factor
   *  (nearest-neighbour), for a close crop that is legible at review size. */
  const upscale = async (srcPath, destPath, factor) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = PNG.sync.read(await readFile(srcPath));
    const out = new PNG({ width: raw.width * factor, height: raw.height * factor });
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const si = (raw.width * (y / factor | 0) + (x / factor | 0)) << 2, di = (out.width * y + x) << 2;
      for (let c = 0; c < 4; c++) out.data[di + c] = raw.data[si + c];
    }
    await writeFile(destPath, PNG.sync.write(out));
  };

  // 1. WHOLE GLOBE at the widget's typical size, no selection chrome.
  await setGlobe({ centerLon: 10, centerLat: 20, zoom: 0.6 });
  await shoot("01_whole_globe");

  // 2. LIMB CLOSE-CROP: the SAME globe as shot 1 (devicePerWorld from the live
  //    editor's own camera at its default fit), cropped tightly around the
  //    limb and upscaled — the exact acceptance crop the user will judge at
  //    the size this widget is actually used at. A separate, artificially
  //    huge globe was tried to force finer adaptive subdivision, but that
  //    changes what is being measured (a presentation-scale globe, not this
  //    widget's typical size) without a real camera-zoom API to drive it
  //    faithfully — dropped in favour of measuring the size that matters.
  {
    const { readFile, writeFile } = await import("node:fs/promises");
    const full = PNG.sync.read(await readFile(resolve(outDir, "01_whole_globe.png")));
    // Find the disc: scan each row for the widest run of "space-dark or glow"
    // pixels (the globe + its atmosphere halo are the only large dark/blue
    // region against the app's light canvas background). Simple heuristic:
    // the darkest pixel's row/col cluster IS the globe, since nothing else in
    // an otherwise-blank slide is that dark.
    let minLum = 255, darkX = 0, darkY = 0;
    for (let y = 0; y < full.height; y += 2) for (let x = 0; x < full.width; x += 2) {
      const i = (full.width * y + x) << 2;
      const lum = (full.data[i] + full.data[i + 1] + full.data[i + 2]) / 3;
      if (lum < minLum) { minLum = lum; darkX = x; darkY = y; }
    }
    // From the darkest point (near the globe's own centre, since the space
    // fill is the darkest fully-opaque colour in the scene), walk right along
    // its row until the pixel returns to background brightness — that is the
    // limb (the atmosphere halo fades out gradually, so "well past the halo,
    // clearly background" is the stopping rule, not the first brightening).
    const rowY = darkY;
    let limbX = darkX;
    const bgLum = 250; // this app's canvas background is near-white
    for (let x = darkX; x < full.width; x++) {
      const i = (full.width * rowY + x) << 2;
      const lum = (full.data[i] + full.data[i + 1] + full.data[i + 2]) / 3;
      if (lum > bgLum - 5) { limbX = x; break; }
    }
    const cropSize = 160;
    const cropX = Math.round(limbX - cropSize / 2), cropY = Math.round(rowY - cropSize / 2);
    const crop = new PNG({ width: cropSize, height: cropSize });
    for (let y = 0; y < cropSize; y++) for (let x = 0; x < cropSize; x++) {
      const sx = cropX + x, sy = cropY + y;
      const di = (cropSize * y + x) << 2;
      if (sx < 0 || sy < 0 || sx >= full.width || sy >= full.height) { crop.data[di + 3] = 0; continue; }
      const si = (full.width * sy + sx) << 2;
      for (let c = 0; c < 4; c++) crop.data[di + c] = full.data[si + c];
    }
    await writeFile(resolve(outDir, "02_limb_close_crop.png"), PNG.sync.write(crop));
    await upscale(resolve(outDir, "02_limb_close_crop.png"), resolve(outDir, "02_limb_close_crop_4x.png"), 4);
    console.log(`  shot  02_limb_close_crop_4x -> ${resolve(outDir, "02_limb_close_crop_4x.png")} (limb found at x=${limbX}, y=${rowY})`);
  }

  // 3. POLE REGION: tilt the view so a pole is near the top of the disc.
  await setGlobe({ centerLon: 10, centerLat: 75, zoom: 0.6 });
  await shoot("03_pole_region");

  // 4. MID-ZOOM (near the globe/flat crossover), where curvature is still
  //    visible but the tiles are deeper.
  await setGlobe({ centerLon: 10, centerLat: 45, zoom: 4.4 });
  await shoot("04_mid_zoom");

  console.log("\nDONE");
} finally {
  await browser.close();
  await server.close();
}
