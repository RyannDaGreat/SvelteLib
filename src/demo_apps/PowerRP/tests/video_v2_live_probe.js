/**
 * VIDEO V2 (Skia direct-upload) live-viewport probe — proves the from-scratch V2
 * path (render_gpu/skia/video_v2.js + the `videoV2` IR op + plugins/demo/video_v2.js)
 * actually works on the REAL editor on-screen Skia surface, where makeSurface is
 * non-null ⇒ ctx.liveGpu true ⇒ the GPU direct-upload branch
 * (surface.makeImageFromTextureSource / updateTextureFromSource) runs — NOT the CPU
 * poster fallback the offscreen render hook (__powerrp_render / gpuService) would.
 *
 * The editor's CanvasView repaints on its private imageEpoch and my fresh widget
 * type cannot nudge it (that would need a CanvasView edit, outside this agent's
 * additive-only scope). So — exactly like tests/video_perf_probe.js — the probe
 * EXTERNALLY drives a repaint every rAF by toggling app.anchorsVisible. That forces
 * the real paintIR → my `case "videoV2"` → drawVideoV2 → GPU upload path each frame,
 * which is precisely the code under test.
 *
 * Pixels are read with page.screenshot (the compositor's copy — reliable regardless
 * of the WebGL drawing-buffer preservation), matching tests/video_scrub_live_probe.js.
 *
 * Checks (all first-hand, on the live GPU canvas):
 *   1. PIXEL MOTION over >=250ms: the center pixel CHANGES as a continuous-motion
 *      clip plays (proves live decode → GPU texture → draw).
 *   2. FRAME-ADVANCE UPLOAD GATE: uploadCount climbs while playing but stays far
 *      below paint count (uploads track the ~30fps decode, not the display rate).
 *   3. OFF-VIEW PAUSE / RESUME: move the widget off-camera (culled ⇒ never drawn) →
 *      playbackState.paused===true, currentTime frozen, uploadCount static; move it
 *      back → resumes from the prior currentTime (not a restart).
 *   4. PERF: rAF fps + paints/s + uploads/s while a visible clip plays.
 * A VLM screenshot of the playing scene is saved so a human/VLM can confirm real
 * video pixels (not black).
 *
 * Clip (ephemeral, continuous motion so consecutive frames differ):
 *   ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=30 -t 4 -pix_fmt yuv420p /tmp/video_v2_motion.mp4
 * Override with V2_CLIP=path.mp4.
 *
 * Run: node src/demo_apps/PowerRP/tests/video_v2_live_probe.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
const CLIP = process.env.V2_CLIP || "/tmp/video_v2_motion.mp4";
const W = 480, H = 360;
const MOTION_SAMPLES = 8;       // center-pixel screenshots ...
const MOTION_GAP_MS = 150;      // ... spaced this far apart (⇒ ~1.05s span, well over 250ms)
const PERF_WINDOW_MS = 2000;    // fps / uploads sampling window
const OFF_VIEW = 100000;        // far off-camera x/y ⇒ culled
const MOTION_THRESHOLD = 12;    // a real inter-frame pixel change (SwiftShader is noise-free)

const SRC = `data:video/mp4;base64,${(await readFile(CLIP)).toString("base64")}`;

/** Pure function. A one-slide doc: mandatory camera + one video_v2 widget at (x,y). */
function makeDoc(x, y) {
  return {
    meta: { name: "video-v2", slideW: W, slideH: H },
    slides: [
      { id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: {
        cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#101018" },
        v: { type: "video_v2", src: SRC, x, y, w: W, h: H, z: 1, rotation: 0, scale: 1, active: true, autoplay: true, loop: true, muted: true, animated: true },
      }, vars: {} } },
    ],
  };
}

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
  page.on("console", (m) => { if (m.type() === "error" && /video_v2|makeImageFromTextureSource|updateTextureFromSource|texture/i.test(m.text())) console.error("page:", m.text()); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction("!!window.__powerrp_app", { timeout: 20000 });
  await page.waitForFunction("!!window.__powerrp_videoV2", { timeout: 20000 });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000)); // Skia init + first paint

  /** Command (async). Load a doc, park on slide 0, fit the camera. */
  async function load(doc) {
    await page.evaluate((doc) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(doc));
      app.slideIndex = 0;
      app.anchorsVisible = false;
      app.runCommand("reset-view");
    }, doc);
    await new Promise((r) => setTimeout(r, 2500)); // decode + start playing
  }

  /** Command. Start/stop a background rAF that forces a real editor repaint every
   * frame (toggling anchorsVisible, like the perf probe) so my videoV2 draw path
   * runs continuously while Node samples pixels/counters. */
  const startDrive = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const loop = () => { app.anchorsVisible = !app.anchorsVisible; window.__v2_drive = requestAnimationFrame(loop); };
    window.__v2_drive = requestAnimationFrame(loop);
  });
  const stopDrive = () => page.evaluate(() => { if (window.__v2_drive) cancelAnimationFrame(window.__v2_drive); window.__v2_drive = null; });

  /** Query (async). The scene-canvas center pixel via page.screenshot (compositor
   * copy — reliable off a WebGL canvas). Returns [r,g,b]. */
  async function centerPixel(box) {
    const clip = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: 1, height: 1 };
    const b64 = await page.screenshot({ clip, encoding: "base64" });
    return await page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
      const c = document.createElement("canvas"); c.width = 1; c.height = 1;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const p = g.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2]];
    }, b64);
  }

  const counters = () => page.evaluate(() => ({ uploads: window.__powerrp_videoV2.uploadCount(), paints: window.__powerrp_app.renderFrameCount }));
  const stateOf = () => page.evaluate((s) => window.__powerrp_videoV2.playbackState(s), SRC);
  const maxChannelDelta = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

  await mkdir(vlmDir, { recursive: true });
  console.log(`\nVIDEO V2 live probe (${W}x${H} camera, clip ${CLIP}):`);

  // ── on-screen, playing ──────────────────────────────────────────────────────
  await load(makeDoc(0, 0));
  const sceneEl = await page.$("canvas.scene");
  const box = await sceneEl.boundingBox();

  // 1 + 2. PIXEL MOTION + UPLOAD GATE while visible.
  await startDrive();
  const c0 = await counters();
  const rgbs = [];
  for (let i = 0; i < MOTION_SAMPLES; i++) { rgbs.push(await centerPixel(box)); await new Promise((r) => setTimeout(r, MOTION_GAP_MS)); }
  const c1 = await counters();
  const sPlay = await stateOf();
  await stopDrive();

  let maxDelta = 0;
  for (let i = 1; i < rgbs.length; i++) maxDelta = Math.max(maxDelta, maxChannelDelta(rgbs[0], rgbs[i]));
  const spanMs = (rgbs.length - 1) * MOTION_GAP_MS;
  const moved = maxDelta > MOTION_THRESHOLD;
  const upl = c1.uploads - c0.uploads, pnt = c1.paints - c0.paints;
  console.log(`  1) pixel motion: maxΔ=${maxDelta} over ~${spanMs}ms (${rgbs.length} samples) → ${moved ? "MOTION" : "STATIC (FAIL)"}`);
  console.log(`     first=${rgbs[0]} last=${rgbs[rgbs.length - 1]}  playing=${!sPlay.paused} t=${sPlay.currentTime.toFixed(2)} ${sPlay.videoWidth}x${sPlay.videoHeight} rs=${sPlay.readyState}`);
  console.log(`  2) upload gate: uploads=${upl} vs paints=${pnt} over ~${spanMs}ms → ${upl > 0 && upl <= pnt ? "GATED (0 < uploads <= paints)" : "check"}`);
  if (!moved) failed = true;
  if (sPlay.paused) { console.log("     FAIL: clip is paused while visible"); failed = true; }

  // VLM: screenshot the playing scene (real video pixels, not black).
  {
    await startDrive();
    await new Promise((r) => setTimeout(r, 100));
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    await writeFile(resolve(vlmDir, "video_v2_playing.png"), shot);
    await stopDrive();
  }

  // 4. PERF while visible + playing (steady-state uploads/s ~ decode rate).
  const perf = await page.evaluate((ms) => new Promise((res) => {
    const app = window.__powerrp_app;
    const p0 = app.renderFrameCount, u0 = window.__powerrp_videoV2.uploadCount();
    let frames = 0; const t0 = performance.now();
    function tick(now) {
      frames++; app.anchorsVisible = !app.anchorsVisible;
      if (now - t0 >= ms) { const s = (now - t0) / 1000; res({ fps: +(frames / s).toFixed(1), paintsPerSec: +((app.renderFrameCount - p0) / s).toFixed(1), uploadsPerSec: +((window.__powerrp_videoV2.uploadCount() - u0) / s).toFixed(1) }); return; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), PERF_WINDOW_MS);
  console.log(`  4) perf (visible+playing): rAF fps=${perf.fps}  paints/s=${perf.paintsPerSec}  uploads/s=${perf.uploadsPerSec}`);

  // 3. OFF-VIEW PAUSE / RESUME. Move the widget far off-camera (culled ⇒ never
  // drawn ⇒ pause sweep pauses it). Let the grace window + a couple sweeps pass.
  await page.evaluate((d) => { const a = window.__powerrp_app; a.commit(a.repaired(d)); a.slideIndex = 0; a.runCommand("reset-view"); }, makeDoc(OFF_VIEW, OFF_VIEW));
  await new Promise((r) => setTimeout(r, 800)); // > ACTIVE_GRACE_MS + sweep
  const uOff0 = (await counters()).uploads;
  const sOff1 = await stateOf();
  await new Promise((r) => setTimeout(r, 900)); // confirm frozen while off-view
  const sOff2 = await stateOf();
  const uOff1 = (await counters()).uploads;
  const frozen = sOff1.paused && sOff2.paused && Math.abs(sOff2.currentTime - sOff1.currentTime) < 0.02 && uOff1 === uOff0;
  console.log(`  3) off-view: paused=${sOff1.paused}→${sOff2.paused}  t=${sOff1.currentTime.toFixed(2)}→${sOff2.currentTime.toFixed(2)} (frozen=${Math.abs(sOff2.currentTime - sOff1.currentTime) < 0.02})  uploads ${uOff0}→${uOff1} (static=${uOff1 === uOff0}) → ${frozen ? "PAUSED+FROZEN" : "FAIL"}`);
  if (!frozen) failed = true;

  // Move back on-screen → resume from prior currentTime (not restart).
  await page.evaluate((d) => { const a = window.__powerrp_app; a.commit(a.repaired(d)); a.slideIndex = 0; a.runCommand("reset-view"); }, makeDoc(0, 0));
  await startDrive();
  await new Promise((r) => setTimeout(r, 600));
  const uBack = (await counters()).uploads;
  const sBack = await stateOf();
  await stopDrive();
  const resumed = !sBack.paused && sBack.currentTime >= sOff2.currentTime - 0.05;
  console.log(`     back in view: paused=${sBack.paused} t=${sBack.currentTime.toFixed(2)} (resumed from ~${sOff2.currentTime.toFixed(2)} ⇒ ${resumed ? "RESUME" : "RESTART (FAIL)"})  uploads resumed=${uBack > uOff1}`);
  if (!resumed) failed = true;

  console.log(`\nVLM shot: .claude_vlm_checks/video_v2_playing.png (should show a live testsrc2 frame, not black)`);
  console.log(failed ? "\nFAIL video_v2_live_probe" : "\nOK video_v2_live_probe — direct-upload GPU path plays, gates uploads, and pauses off-view on the LIVE editor surface.");
} catch (e) {
  console.error("\nFAIL video_v2_live_probe:", e?.stack ?? e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
