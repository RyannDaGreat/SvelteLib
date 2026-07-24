/**
 * VIDEO PLAYER performance probe — measures the editor's rAF frame rate while
 * video PLAYER widgets are on the scene, to prove the "adding videos drops the
 * editor from 120 fps to ~16-30, even off-screen / on another slide" regression
 * is fixed. Boots the REAL editor (on-screen Skia surface + SlideNav thumbnails,
 * exactly the two paths implicated), places N video widgets, lets them play, and
 * samples requestAnimationFrame ticks (main-thread responsiveness) + the editor's
 * own paint count (app.renderFrameCount) over a fixed window.
 *
 * State-agnostic: it measures whatever code is on disk, so run it once with the
 * fix and once with the fix `git stash`ed for a BEFORE/AFTER table. Scenarios:
 *   baseline (no video), N=1 visible, N=3 visible, N=3 off-screen (culled),
 *   N=3 off-slide (videos on slide 1, editor on slide 0 — the thumbnail-spawned
 *   playing-element storm). Saves a VLM screenshot of the N=1 visible scene so a
 *   human/VLM can confirm the GPU-texture path draws CORRECT pixels, not black.
 *
 * Clips (ephemeral, regenerate with ffmpeg; distinct patterns so N videos = N
 * real decodes — refsForOp dedups identical sources):
 *   ffmpeg -y -f lavfi -i testsrc=size=1920x1080:rate=30      -t 5 -pix_fmt yuv420p /tmp/perf_test_0.mp4
 *   ffmpeg -y -f lavfi -i testsrc2=size=1920x1080:rate=30     -t 5 -pix_fmt yuv420p /tmp/perf_test_1.mp4
 *   ffmpeg -y -f lavfi -i smptehdbars=size=1920x1080:rate=30  -t 5 -pix_fmt yuv420p /tmp/perf_test_2.mp4
 * Override paths with PERF_CLIPS=a.mp4,b.mp4,c.mp4.
 *
 * Run: node src/demo_apps/PowerRP/tests/video_perf_probe.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
// DISTINCT 1080p clips — one per video widget, so N videos = N real decodes
// (refsForOp dedups by src, so identical sources would collapse to one grab).
const CLIPS = (process.env.PERF_CLIPS || "/tmp/perf_test_0.mp4,/tmp/perf_test_1.mp4,/tmp/perf_test_2.mp4").split(",");
const W = 960, H = 540;
const WINDOW_MS = 2500; // fps sampling window per scenario

const SRCS = await Promise.all(CLIPS.map(async (p) => `data:video/mp4;base64,${(await readFile(p.trim())).toString("base64")}`));

/** Pure function. N video-player items tiled across the camera (or shoved
 * off-camera when `offscreen`), plus the mandatory camera. */
function videoItems(n, { offscreen = false } = {}) {
  const items = {
    cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#101018" },
  };
  const cols = Math.ceil(Math.sqrt(n));
  const cw = W / cols, ch = H / cols;
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    items["v" + i] = {
      type: "video", src: SRCS[i % SRCS.length], z: i + 1, rotation: 0, scale: 1, active: true,
      x: offscreen ? 100000 + i * 10 : col * cw, y: offscreen ? 100000 : row * ch, w: cw, h: ch,
    };
  }
  return items;
}

/** Pure function. A doc: slide 0 carries `s0` items, slide 1 carries `s1`. */
function makeDoc(s0Items, s1Items) {
  return {
    meta: { name: "perf", slideW: W, slideH: H },
    slides: [
      { id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: s0Items, vars: {} } },
      { id: "s1", name: "B", transition: { type: "fade", seconds: 1 }, delta: { items: s1Items, vars: {} } },
    ],
  };
}

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("pageerror:", e.message); failed = true; });
  page.on("console", (m) => { if (m.type() === "error" && /video_registry|makeImageFromTextureSource|updateTextureFromSource|texture/i.test(m.text())) console.error("page:", m.text()); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction("!!window.__powerrp_app", { timeout: 20000 });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000)); // Skia init + first paint

  /** Command (async). Load a doc, park the editor on `slideIndex`, fit the camera. */
  async function load(doc, slideIndex) {
    await page.evaluate((doc, slideIndex) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(doc));
      app.slideIndex = slideIndex;
      app.runCommand("reset-view");
    }, doc, slideIndex);
    await new Promise((r) => setTimeout(r, 2500)); // let videos decode + start playing
  }

  /** Query (async). rAF fps + editor paints over WINDOW_MS. High rAF fps = the
   * main thread is responsive (not stalled by per-frame GPU→CPU readbacks). */
  async function measure() {
    return await page.evaluate((ms) => new Promise((resolve) => {
      const app = window.__powerrp_app;
      const paints0 = app.renderFrameCount;
      let frames = 0; const t0 = performance.now(); let maxGap = 0, prev = t0;
      function tick(now) {
        frames++; maxGap = Math.max(maxGap, now - prev); prev = now;
        if (now - t0 >= ms) {
          const secs = (now - t0) / 1000;
          resolve({ fps: +(frames / secs).toFixed(1), paintsPerSec: +((app.renderFrameCount - paints0) / secs).toFixed(1), maxGapMs: +maxGap.toFixed(1) });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }), WINDOW_MS);
  }

  const rows = [];
  async function scenario(label, doc, slideIndex) {
    await load(doc, slideIndex);
    const m = await measure();
    rows.push({ label, ...m });
    console.log(`  ${label.padEnd(22)} fps=${String(m.fps).padStart(6)}  paints/s=${String(m.paintsPerSec).padStart(6)}  maxGap=${m.maxGapMs}ms`);
    return m;
  }

  await mkdir(vlmDir, { recursive: true });
  console.log(`\nVIDEO PERF (window ${WINDOW_MS}ms, ${SRCS.length} distinct 1080p clips, ${W}x${H} camera):`);

  await scenario("baseline (no video)", makeDoc({ cam: videoItems(0).cam }, { cam2: videoItems(0).cam }), 0);
  await scenario("N=1 visible", makeDoc(videoItems(1), {}), 0);
  const n3 = await scenario("N=3 visible", makeDoc(videoItems(3), {}), 0);

  // VLM: screenshot the N=3 visible scene (already loaded) — confirms the
  // GPU-texture upload draws real video pixels, not black.
  {
    const el = await page.$("canvas.scene");
    const box = await el.boundingBox();
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    await writeFile(resolve(vlmDir, "video_perf_visible.png"), shot);
  }

  await scenario("N=3 off-screen", makeDoc(videoItems(3, { offscreen: true }), {}), 0);
  await scenario("N=3 off-slide", makeDoc({ cam: videoItems(0).cam }, videoItems(3)), 0);

  console.log("\nVLM shot: .claude_vlm_checks/video_perf_visible.png (should show the colorful testsrc pattern, not black)");
  console.log(`\nDONE video_perf_probe (N=3 visible fps=${n3.fps}). Run again with the fix git-stashed for the BEFORE column.`);
} catch (e) {
  console.error("\nFAIL video_perf_probe:", e?.stack ?? e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
