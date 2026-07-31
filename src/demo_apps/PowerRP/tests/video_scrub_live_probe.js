/**
 * VIDEO SCRUBBER live-viewport probe — proves the scrubber works in the ACTUAL
 * editor viewport (the on-screen Skia surface: browser_surface.render →
 * sceneMedia sync getScrubFrame → async requestScrubFrame → video_registry
 * notify → CanvasView onVideoFrame → imageEpoch repaint), NOT just the offscreen
 * render hook the determinism test exercises.
 *
 * Mounts the editor, loads a 2-slide doc whose scrubber shows scrubTime 0.5
 * (slide 0) and 2.5 (slide 1), and SCREENSHOTS the real scene <canvas> — the
 * seeked frame only appears after the async seek lands + the reactive repaint
 * fires, so a correct color confirms the whole live pipeline. slide 0 → red,
 * slide 1 → blue (the RGB-per-second fixture). Screenshots go to
 * .claude_vlm_checks/ for VLM inspection.
 * Run: node src/demo_apps/PowerRP/tests/video_scrub_live_probe.js
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
const W = 480, H = 360;

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

const doc = {
  meta: { name: "scrub-live", slideW: W, slideH: H },
  slides: [
    { id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: {
      cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#222222" },
      vs: { type: "video_scrub", src: SRC, x: 0, y: 0, w: W, h: H, z: 1, rotation: 0, scale: 1, active: true, scrubTime: 0.5, scrubWrap: "clamp" },
    }, vars: {} } },
    { id: "s1", name: "B", transition: { type: "fade", seconds: 1 }, delta: { items: { vs: { scrubTime: 2.5 } }, vars: {} } },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("pageerror:", e.message); failed = true; });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction("!!window.__powerrp_app", { timeout: 20000 });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000)); // Skia init + first paint

  await page.evaluate((doc) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.runCommand("reset-view"); // zoom-to-fit THE camera so it fills the viewport
  }, doc);

  await mkdir(vlmDir, { recursive: true });
  const dominant = ([r, g, b]) => (r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");
  const saturated = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 40; // a colored frame vs any gray backdrop

  /** Command (async). Poll the on-screen scene canvas center pixel until it is a
   * SATURATED color (the seek landed + the reactive repaint drew the frame; any
   * gray = the camera backdrop / editor canvas, i.e. no frame yet). */
  async function liveCenter(label) {
    const el = await page.$("canvas.scene");
    const box = await el.boundingBox();
    let rgb = [0, 0, 0];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const clip = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: 1, height: 1 };
      const b64 = await page.screenshot({ clip, encoding: "base64" });
      rgb = await page.evaluate(async (b64) => {
        const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
        const c = document.createElement("canvas"); c.width = 1; c.height = 1;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
        const p = ctx.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2]];
      }, b64);
      if (saturated(rgb)) break;
    }
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    await writeFile(resolve(vlmDir, `scrub_live_${label}.png`), shot);
    return rgb;
  }

  const s0 = await liveCenter("slide0_red");
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; window.__powerrp_app.runCommand("reset-view"); });
  const s1 = await liveCenter("slide1_blue");

  console.log(`live slide0 center → ${dominant(s0)} ${s0}`);
  console.log(`live slide1 center → ${dominant(s1)} ${s1}`);
  assert.equal(dominant(s0), "red", "live viewport slide 0 (scrubTime 0.5) should show the red frame");
  assert.equal(dominant(s1), "blue", "live viewport slide 1 (scrubTime 2.5) should show the blue frame");
  console.log("\nOK video_scrub_live_probe — the live editor viewport seeks + repaints the correct frame. VLM shots in .claude_vlm_checks/");
} catch (e) {
  console.error("\nFAIL video_scrub_live_probe:", e?.message ?? e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
