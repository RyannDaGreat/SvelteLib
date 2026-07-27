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

  /** Command (async). Load a doc, park the editor on `slideIndex`, fit the camera,
   * and set the minimap visibility (FIX 1 shows only when the minimap is on). */
  async function load(doc, slideIndex, { minimap = false } = {}) {
    await page.evaluate((doc, slideIndex, minimap) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(doc));
      app.slideIndex = slideIndex;
      app.minimapVisible = minimap;
      app.anchorsVisible = false;
      app.runCommand("reset-view");
    }, doc, slideIndex, minimap);
    await new Promise((r) => setTimeout(r, 2500)); // let videos decode + start playing
  }

  /** Query (async). Over WINDOW_MS: rAF fps (main-thread responsiveness), editor
   * paints/s, and <video>→texture uploads/s. When `drag` is set, forces a paint
   * every rAF tick (toggling app.anchorsVisible) to SIMULATE dragging while a clip
   * plays — that is where the frame-advance gate (FIX 2) shows: uploads/s should
   * stay ~video-rate while paints/s climbs toward display-rate. */
  async function measure({ drag = false } = {}) {
    return await page.evaluate((ms, drag) => new Promise((resolve) => {
      const app = window.__powerrp_app;
      // Counter hook may be absent (a stashed BEFORE run) — then uploads/s = -1.
      const uploadCount = () => (typeof window.__powerrp_videoUploadCount === "function" ? window.__powerrp_videoUploadCount() : NaN);
      const paints0 = app.renderFrameCount;
      const uploads0 = uploadCount();
      let frames = 0; const t0 = performance.now(); let maxGap = 0, prev = t0;
      function tick(now) {
        frames++; maxGap = Math.max(maxGap, now - prev); prev = now;
        if (drag) app.anchorsVisible = !app.anchorsVisible; // force a paint this frame
        if (now - t0 >= ms) {
          const secs = (now - t0) / 1000;
          const du = uploadCount() - uploads0;
          resolve({
            fps: +(frames / secs).toFixed(1),
            paintsPerSec: +((app.renderFrameCount - paints0) / secs).toFixed(1),
            uploadsPerSec: Number.isNaN(du) ? -1 : +(du / secs).toFixed(1),
            maxGapMs: +maxGap.toFixed(1),
          });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }), WINDOW_MS, drag);
  }

  const rows = [];
  async function scenario(label, doc, slideIndex, opts = {}) {
    await load(doc, slideIndex, opts);
    const m = await measure(opts);
    rows.push({ label, ...m });
    console.log(`  ${label.padEnd(26)} fps=${String(m.fps).padStart(6)}  paints/s=${String(m.paintsPerSec).padStart(6)}  uploads/s=${String(m.uploadsPerSec).padStart(6)}  maxGap=${m.maxGapMs}ms`);
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

  // FIX 1 — minimap visible + a playing video, IDLE. Before the throttle, the
  // minimap re-rendered (offscreen slide render + full-res video CPU readback +
  // PNG encode) 30×/s on the main thread; after, ≤ ~8×/s. Compare fps to
  // "N=1 visible" (same scene, minimap OFF).
  await scenario("N=1 +minimap idle", makeDoc(videoItems(1), {}), 0, { minimap: true });

  // FIX 2 — a SMALL on-screen video (cheap raster ⇒ paints can outrun the 30 fps
  // decode) while DRAGGING (forced repaint every rAF). uploads/s should stay
  // ~video-rate (gate skips redundant re-uploads), NOT track paints/s.
  const smallVideoDoc = makeDoc({
    cam: videoItems(0).cam,
    v0: { type: "video", src: SRCS[0], x: 20, y: 20, w: 160, h: 90, z: 1, rotation: 0, scale: 1, active: true },
  }, {});
  await scenario("N=1 small drag+video", smallVideoDoc, 0, { drag: true });

  // FIX A (Round 3) — an OFF-VIEW player must PAUSE (zero decode CPU) and RESUME
  // from its prior currentTime on re-entry. One clip: shown on-screen (plays) →
  // moved OFF-screen (culled ⇒ must pause, paints/s + uploads/s = 0) → back
  // on-screen (must resume, NOT restart). Moving the widget off-camera culls it
  // exactly as panning the viewport would; the src (⇒ the <video> element) is
  // unchanged, so currentTime carries across.
  const onDoc = makeDoc({ cam: videoItems(0).cam, v0: { type: "video", src: SRCS[0], x: 20, y: 20, w: 300, h: 169, z: 1, rotation: 0, scale: 1, active: true } }, {});
  const offDoc = makeDoc({ cam: videoItems(0).cam, v0: { type: "video", src: SRCS[0], x: 100000, y: 100000, w: 300, h: 169, z: 1, rotation: 0, scale: 1, active: true } }, {});
  const move = async (doc) => { await page.evaluate((d) => { const a = window.__powerrp_app; a.commit(a.repaired(d)); a.slideIndex = 0; a.runCommand("reset-view"); }, doc); };
  const stateOf = async () => page.evaluate((s) => window.__powerrp_videoState(s), SRCS[0]);

  await load(onDoc, 0);
  await new Promise((r) => setTimeout(r, 2500)); // play a while (currentTime climbs well past 0)
  const sPlay = await stateOf();
  await move(offDoc);
  await new Promise((r) => setTimeout(r, 800)); // let the cull→pause paint settle
  const sOff = await stateOf();
  const offCost = await measure(); // paints/s + uploads/s while the clip is off-view
  await move(onDoc);
  await new Promise((r) => setTimeout(r, 400)); // resume + a little playback
  const sBack = await stateOf();

  const pass = sPlay && !sPlay.paused && sOff && sOff.paused && offCost.paintsPerSec === 0 && offCost.uploadsPerSec === 0 && sBack && !sBack.paused && sBack.currentTime >= sOff.currentTime - 0.1;
  console.log(`\nFIX A off-view pause/resume:`);
  console.log(`  visible → paused=${sPlay?.paused} t=${sPlay?.currentTime?.toFixed(2)}`);
  console.log(`  off-screen → paused=${sOff?.paused} t=${sOff?.currentTime?.toFixed(2)}  (off-view cost: paints/s=${offCost.paintsPerSec} uploads/s=${offCost.uploadsPerSec}, rAF fps=${offCost.fps})`);
  console.log(`  back in view → paused=${sBack?.paused} t=${sBack?.currentTime?.toFixed(2)}  (resumed from ~${sOff?.currentTime?.toFixed(2)}, not 0 ⇒ ${sBack && sBack.currentTime >= sOff.currentTime - 0.1 ? "RESUME" : "RESTART (FAIL)"})`);
  console.log(`  ${pass ? "PASS" : "FAIL"}`);
  if (!pass) failed = true;

  // MINIMAP CORRECTNESS (FIX 1 must keep it right, just refresh less): a 2-slide
  // doc with DISTINCT camera backgrounds (dark + video, then red) — the minimap
  // must show slide 0, and must UPDATE (differ) when the slide changes.
  const minimapDoc = makeDoc(
    { cam: { ...videoItems(1).cam }, v0: videoItems(1).v0 },
    { cam: { background: "#ff2020" }, v0: { active: false } }, // slide-1 delta: red camera, video removed
  );
  await load(minimapDoc, 0, { minimap: true });
  await new Promise((r) => setTimeout(r, 1200)); // minimap render (edit-driven, immediate)
  const dock = await page.$(".minimap-dock");
  const shot0 = await dock.screenshot();
  await writeFile(resolve(vlmDir, "video_perf_minimap_slide0.png"), shot0);
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; window.__powerrp_app.runCommand("reset-view"); });
  await new Promise((r) => setTimeout(r, 1200));
  const shot1 = await (await page.$(".minimap-dock")).screenshot();
  await writeFile(resolve(vlmDir, "video_perf_minimap_slide1.png"), shot1);
  const minimapUpdated = !shot0.equals(shot1);
  console.log(`\nminimap updates on slide change: ${minimapUpdated ? "YES" : "NO (FAIL)"}`);
  if (!minimapUpdated) failed = true;

  console.log("\nVLM shots: .claude_vlm_checks/video_perf_visible.png (3 distinct clips, not black) + video_perf_minimap_slide0.png (dark+video) / _slide1.png (red)");
  console.log(`\nDONE video_perf_probe (N=3 visible fps=${n3.fps}). Run again with the fix git-stashed for the BEFORE column.`);
} catch (e) {
  console.error("\nFAIL video_perf_probe:", e?.stack ?? e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
