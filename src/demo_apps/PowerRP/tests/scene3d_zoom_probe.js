/**
 * ZOOMING THE CANVAS INTO A 3D VIEWPORT SHOWS MORE DETAIL, NOT BIGGER PIXELS.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/scene3d_zoom_probe.js [shot_dir]
 *
 * THE REQUIREMENT (todo #257), in the user's words: "whatever my screen-space
 * resolution is when I view it is what it should render, and it should render A
 * CROP of it to be faster… So I can never see the pixels. THIS IS A GENERAL
 * PRINCIPLE." The Mandelbrot is the bar he is holding this to.
 *
 * ── WHY THIS IS AN A/B AND NOT A THRESHOLD ───────────────────────────────────
 * "Is this image crisp" has no absolute test — any fixed number would be a
 * magic threshold tuned to one host's fixture. But the OLD behaviour is still in
 * the product as a mode ("Follow widget size" magnifies its raster, deliberately,
 * for authors who want a deck to read the same at every magnification), so the
 * before and the after can be photographed in ONE run, at one zoom, of one
 * widget. That comparison cannot rot with the host and needs no baseline file.
 *
 * ── AND THE COST, BECAUSE HALF THE REQUIREMENT IS "TO BE FASTER" ─────────────
 * A crispness check alone would miss the point. This also reports what a
 * whole-object render at the same crispness WOULD have cost, computed from the
 * descriptor's own numbers, and times a real render at both sizes. The honest
 * answer for splats is in the report, not assumed here: most of a splat frame is
 * the SORT, which is resolution-independent, so the crop saves less than the
 * pixel ratio suggests. This probe measures rather than claims.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const shots = process.argv[2] ?? "/tmp/scene3d_zoom_probe";
await mkdir(shots, { recursive: true });

/** A viewport large enough that a deep zoom leaves plenty of it on screen. */
const BOX = { x: 200, y: 160, w: 480, h: 360 };
const SETTLE_MS = 220;
const RASTER_TIMEOUT_MS = 60000;
/** How far to zoom the canvas for the comparison. Deep enough that a magnified
 *  raster is unmistakably soft, shallow enough that a good chunk of the widget is
 *  still on screen so both clips show the same subject. */
const DEEP_ZOOM = 8;
/** The app-wide supersample every raster widget renders at (ir.js
 *  SUPERSAMPLE_DENSITY, re-exported by the raster module). Imported rather than
 *  restated so the screen bound below cannot drift from the value the descriptor
 *  actually used — a test that hardcoded 2 would silently stop testing anything
 *  the day the density moved. */
const { SCENE3D_RASTER_DENSITY } = await import("../render_gpu/gpu/scene3d_raster.js");

const splatPath = fileURLToPath(new URL("../assets/builtin/splats/spz-test-scene.ply", import.meta.url));
const SPLAT_URL = `/@fs${splatPath}`;
const DISPLAY_URL = `/@fs${fileURLToPath(new URL("../render_gpu/scene3d_display.js", import.meta.url))}`;
const RASTER_URL = `/@fs${fileURLToPath(new URL("../render_gpu/gpu/scene3d_raster.js", import.meta.url))}`;

const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  cacheDir: await mkdtemp(join(tmpdir(), "powerrp-zoom3d-vite-")),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 120000 });
  await sleep(SETTLE_MS * 4);

  const splatId = await page.evaluate((extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("scene3d_splat").defaults, ...extra });
    return app.selection;
  }, { ...BOX, src: SPLAT_URL });

  await page.evaluate(async (d, r, regPath) => {
    window.__zoom3d = {
      display: await import(/* @vite-ignore */ d),
      raster: await import(/* @vite-ignore */ r),
      registryPath: regPath,
    };
  }, DISPLAY_URL, RASTER_URL, fileURLToPath(new URL("../render_gpu/gpu/image_registry.js", import.meta.url)));

  const setMode = (mode) => page.evaluate((id, mode) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "renderMode"], mode]]);
    app.commitPreview();
  }, splatId, mode);

  /** Query. The image op this node currently draws, as seen through the SAME
   *  walker the canvas uses — with the live pre-pass supplied, because the whole
   *  subject of this probe is what that pre-pass decides. */
  const drawn = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const { display, raster } = window.__zoom3d;
    const node = app.nodes().find((n) => n.itemId === id);
    if (!node) return null;
    const view = app.canvasActions.view ?? null;
    const desc = display.prepareScene3dViews([node], window.__zoom3d.view, window.__zoom3d.vw, window.__zoom3d.vh).get(id) ?? null;
    return { desc, view, stats: raster.scene3dRasterStats() };
  }, splatId);

  /** Command. Reads the LIVE view + canvas device size out of the app, so the
   *  descriptor this probe computes is the one the canvas computed rather than a
   *  parallel guess at it.
   *
   *  THE VIEWPORT COMES FROM `app.lastViewport`, which CanvasView's onviewport
   *  keeps fresh — NOT from `canvasActions`, which exposes no such field. Reading
   *  a name that does not exist gave `zoom: 1` for every zoom and made the whole
   *  measurement collapse to the un-zoomed case while still reporting numbers,
   *  which is why this comment exists. */
  const syncView = () => page.evaluate(() => {
    const cv = document.querySelector(".canvas-wrap canvas") ?? document.querySelector("canvas");
    const app = window.__powerrp_app;
    const vp = app.lastViewport ?? { zoom: 1, panX: 0, panY: 0 };
    const overlay = document.querySelector(".overlay").getBoundingClientRect();
    window.__zoom3d.vw = cv?.width ?? 0;
    window.__zoom3d.vh = cv?.height ?? 0;
    // dpr DERIVED from the canvas rather than read off `window`, because the two
    // disagree whenever the surface is capped, and the descriptor must use the
    // one the renderer actually allocated.
    const dpr = overlay.width > 0 ? window.__zoom3d.vw / overlay.width : 1;
    window.__zoom3d.view = { zoom: vp.zoom, panX: vp.panX, panY: vp.panY, dpr };
    return { view: window.__zoom3d.view, vw: window.__zoom3d.vw, vh: window.__zoom3d.vh };
  });

  /** Command. Puts the canvas at `zoom` with the widget's centre in the middle of
   *  the view — computed rather than animated, because zoomToFit/zoomTo tween and
   *  a probe that raced the tween would measure an arbitrary intermediate zoom. */
  const zoomTo = (zoom) => page.evaluate((zoom, box) => {
    const app = window.__powerrp_app;
    const overlay = document.querySelector(".overlay").getBoundingClientRect();
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    app.canvasActions.setViewport({
      zoom,
      panX: overlay.width / 2 - cx * zoom,
      panY: overlay.height / 2 - cy * zoom,
    });
  }, zoom, BOX);

  // Wait for the first raster.
  const deadline = Date.now() + RASTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.__zoom3d.raster.scene3dRasterStats());
    if (s.ready > 0) break;
    await sleep(300);
  }
  const vp0 = await syncView();
  ok(vp0.vw > 0 && vp0.vh > 0, `the canvas reports a device size (${vp0.vw}x${vp0.vh})`);

  // ── 1. AT REST, THE VIEWPORT MODE IS THE DEFAULT ──────────────────────────
  const mode0 = await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id)?.state.renderMode, splatId);
  ok(mode0 === "viewport", `a freshly inserted viewport defaults to screen-resolution rendering (got ${JSON.stringify(mode0)})`);

  // ── 2. ZOOM IN, AND MEASURE WHAT EACH MODE ASKS FOR ───────────────────────
  await zoomTo(DEEP_ZOOM);
  await sleep(SETTLE_MS * 3);
  const zoomed = await syncView();
  ok(Math.abs(zoomed.view.zoom - DEEP_ZOOM) < 0.01, `the canvas really zoomed (zoom ${zoomed.view.zoom})`);

  const info = await drawn();
  ok(info.desc !== null, "the zoomed viewport gets a descriptor");
  const px = info.desc.deviceW * info.desc.deviceH;
  const wholeAtSameCrispness = info.desc.viewOffset.fullW * info.desc.viewOffset.fullH;
  ok(px < wholeAtSameCrispness,
    `THE CROP IS THE SAVING: this frame renders ${info.desc.deviceW}x${info.desc.deviceH} = ${(px / 1e6).toFixed(2)} Mpx, where the whole object at the same crispness would be ${Math.round(info.desc.viewOffset.fullW)}x${Math.round(info.desc.viewOffset.fullH)} = ${(wholeAtSameCrispness / 1e6).toFixed(1)} Mpx — a ${(wholeAtSameCrispness / px).toFixed(1)}x reduction in pixels`);
  // BOUNDED BY THE SCREEN, at the app-wide 2x supersample every raster widget
  // uses — so the ceiling is one canvas times the density SQUARED (2x on each
  // axis), and it does not move when the zoom does. Stating the density in the
  // bound rather than padding the number is the difference between a law and a
  // fudge factor: this assertion fails if the raster ever starts tracking the
  // zoom, and would not if the ceiling were merely generous.
  const screenBound = zoomed.vw * zoomed.vh * SCENE3D_RASTER_DENSITY * SCENE3D_RASTER_DENSITY;
  ok(px <= screenBound * 1.05,
    `and it is bounded by the SCREEN, not the zoom: ${(px / 1e6).toFixed(2)} Mpx against a ${(zoomed.vw * zoomed.vh / 1e6).toFixed(2)} Mpx canvas at ${SCENE3D_RASTER_DENSITY}x density (ceiling ${(screenBound / 1e6).toFixed(2)} Mpx)`);

  // ── 3. THE PIXELS: crisp against the old magnify-the-raster behaviour ─────
  const clip = { x: 400, y: 250, width: 500, height: 380 };
  const shot = () => page.screenshot({ encoding: "base64", clip });

  // WAIT FOR CONVERGENCE BEFORE PHOTOGRAPHING, and this is not a settle sleep —
  // it is the difference between measuring the feature and measuring the HOLD.
  // Mid-zoom the widget deliberately shows its previous frame (todo #255), so a
  // shot taken too early photographs a stale raster and reports it as the new
  // mode's output. That happened on this probe's first run: the clip showed the
  // whole scene where a crop belonged, which looked exactly like a broken
  // sub-frustum and was not one. The condition is "the ref being DRAWN is the ref
  // this view ASKS for" — no proxy, no stopwatch.
  const converged = async () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const { ports, disp, raster } = { ...window.__zoom3d, ports: window.__zoom3d.ports };
    const node = app.nodes().find((n) => n.itemId === id);
    const scene3d = window.__zoom3d.display.prepareScene3dViews([node], window.__zoom3d.view, window.__zoom3d.vw, window.__zoom3d.vh);
    const desc = scene3d.get(id);
    if (!desc) return false;
    const ops = node.plugin.emit(node.state, null, node.world, { scene3d: desc, live: true });
    const img = ops.find((o) => o.op === "image");
    // Drawn AT the window the current view asks for, and ready: a held frame
    // fails the first half, an in-flight one the second.
    return !!img && raster.scene3dStatus(img.ref) === "ready" && Math.abs(img.w - desc.w) < 1e-6;
  }, splatId);
  const convergeDeadline = Date.now() + RASTER_TIMEOUT_MS;
  let settled = false;
  while (Date.now() < convergeDeadline) {
    settled = await converged();
    if (settled) break;
    await sleep(200);
  }
  ok(settled, "the zoomed view converged on its OWN raster (not the held one) before the pixel comparison");
  await sleep(SETTLE_MS * 2);
  const crisp = await shot();
  await setMode("live");
  // Follow-widget-size renders at the widget's own scale and then MAGNIFIES,
  // which is what the default did before this work. Same widget, same zoom, same
  // clip: the only difference is the resolution decision.
  const softDeadline = Date.now() + RASTER_TIMEOUT_MS;
  let soft = null;
  while (Date.now() < softDeadline) {
    soft = await shot();
    if (soft !== crisp) break;
    await sleep(400);
  }
  writeFileSync(`${shots}/01-viewport-crisp.png`, Buffer.from(crisp, "base64"));
  writeFileSync(`${shots}/02-followsize-magnified.png`, Buffer.from(soft, "base64"));
  ok(soft !== crisp, "the two modes really do render differently at this zoom");
  // A MAGNIFIED raster is large flat blocks and compresses hard; a re-rendered one
  // carries real high-frequency detail. Comparing the two PNGs of the SAME region
  // of the SAME scene at the SAME zoom makes the direction meaningful without any
  // absolute threshold: the only variable is where the pixels came from.
  ok(crisp.length > soft.length,
    `zooming in RE-RENDERS instead of magnifying: ${crisp.length} b64 chars of detail against ${soft.length} for the magnified raster (+${Math.round((100 * (crisp.length - soft.length)) / soft.length)}%)`);
  await setMode("viewport");
  await sleep(SETTLE_MS * 2);

  // ── 4. THE COST, TIMED ────────────────────────────────────────────────────
  // Both halves of "render a crop to be faster", measured on the real engine:
  // the cropped frame this zoom actually asks for, against the whole-object frame
  // that would be needed for the same crispness. Reported, never asserted — a
  // wall-clock threshold in a gate is a flake on a shared host.
  const timing = await page.evaluate(async (id, desc) => {
    const { raster } = window.__zoom3d;
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    const s = node.state;
    const pose = { targetX: s.camTargetX, targetY: s.camTargetY, targetZ: s.camTargetZ, yaw: s.camYaw, pitch: s.camPitch, roll: s.camRoll, distance: s.camDistance, fov: s.camFov };
    const base = { kind: "splat", src: s.src, pose, look: `t${Math.random()}`, lit: false, exposure: 1, near: 0.01, far: 300 };
    const time = async (spec) => {
      const t0 = performance.now();
      const ref = raster.ensureScene3dRasterized(spec);
      const deadline = Date.now() + 120000;
      while (raster.scene3dStatus(ref) === "loading" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 4));
      return { ms: Math.round(performance.now() - t0), status: raster.scene3dStatus(ref) };
    };
    const cropped = await time({ ...base, look: `crop${Math.random()}`, w: desc.deviceW, h: desc.deviceH, viewOffset: desc.viewOffset });
    const wholeW = Math.min(8192, Math.round(desc.viewOffset.fullW));
    const wholeH = Math.min(8192, Math.round(desc.viewOffset.fullH));
    const whole = await time({ ...base, look: `whole${Math.random()}`, w: wholeW, h: wholeH, viewOffset: null });
    return { cropped, whole, croppedPx: desc.deviceW * desc.deviceH, wholePx: wholeW * wholeH, wholeW, wholeH };
  }, splatId, info.desc);
  console.log(`\n  COST, measured on the real engine at zoom ${DEEP_ZOOM}:`);
  console.log(`    cropped (what this mode renders): ${info.desc.deviceW}x${info.desc.deviceH} = ${(timing.croppedPx / 1e6).toFixed(2)} Mpx in ${timing.cropped.ms} ms`);
  console.log(`    whole object at the same crispness: ${timing.wholeW}x${timing.wholeH} = ${(timing.wholePx / 1e6).toFixed(2)} Mpx in ${timing.whole.ms} ms`);
  console.log(`    pixels: ${(timing.wholePx / timing.croppedPx).toFixed(1)}x fewer    time: ${(timing.whole.ms / Math.max(1, timing.cropped.ms)).toFixed(2)}x faster\n`);
  ok(timing.cropped.status === "ready" && timing.whole.status === "ready",
    `both timing renders completed (${JSON.stringify(timing)})`);

  // ── 5. THE CROP IS A CROP OF THE RENDER, NOT OF A BITMAP ──────────────────
  // The claim that makes this worth doing at all. If the sub-frustum were being
  // ignored, a cropped render would be the WHOLE scene squeezed into the window —
  // same content, different size. Rendering the same window at two different
  // OFFSETS must therefore give two different pictures; if it did not, the
  // viewOffset would be decorative and every zoomed frame would be silently
  // showing the whole object.
  // COMPARE PIXELS, NOT REFS. The first version of this check asserted the two
  // refs differed — which they must, by construction, because the offset is part
  // of the key. That is a gate that cannot fail, and four of those were found in
  // this codebase in one day. These read the actual decoded bitmaps out of the
  // image registry and hash them.
  const offsets = await page.evaluate(async (id) => {
    const { raster } = window.__zoom3d;
    const reg = await import("/@fs" + window.__zoom3d.registryPath);
    const app = window.__powerrp_app;
    const s = app.nodes().find((n) => n.itemId === id).state;
    const pose = { targetX: s.camTargetX, targetY: s.camTargetY, targetZ: s.camTargetZ, yaw: s.camYaw, pitch: s.camPitch, roll: s.camRoll, distance: s.camDistance, fov: s.camFov };
    const base = { kind: "splat", src: s.src, pose, lit: false, exposure: 1, near: 0.01, far: 300, w: 160, h: 120 };
    const digest = async (viewOffset) => {
      const ref = raster.ensureScene3dRasterized({ ...base, viewOffset });
      const deadline = Date.now() + 60000;
      while (raster.scene3dStatus(ref) === "loading" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 4));
      const bmp = reg.getImage(ref);
      if (!bmp) return { ref, hash: null };
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const g = cv.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < px.length; i += 4) { h ^= px[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      return { ref, hash: h.toString(16) };
    };
    const full = { fullW: 480, fullH: 360 };
    const tl = await digest({ ...full, x: 0, y: 0 });
    const br = await digest({ ...full, x: 320, y: 240 });
    const tlAgain = await digest({ ...full, x: 0, y: 0 });
    const whole = await digest(null);
    return { tl, br, tlAgain, whole };
  }, splatId);
  ok(offsets.tl.hash !== null && offsets.br.hash !== null,
    `both sub-frustum renders produced real bitmaps (${JSON.stringify(offsets)})`);
  ok(offsets.tl.hash !== offsets.br.hash,
    `THE SUB-FRUSTUM IS HONOURED: two offsets into one virtual image are two DIFFERENT PICTURES (${offsets.tl.hash} vs ${offsets.br.hash}) — a crop that were merely the whole scene squeezed into the window would hash the same`);
  ok(offsets.tl.hash !== offsets.whole.hash,
    `and a cropped render differs from the uncropped one at the same surface size (${offsets.tl.hash} vs ${offsets.whole.hash})`);
  ok(offsets.tl.hash === offsets.tlAgain.hash,
    `while the SAME offset is byte-identical on a repeat (${offsets.tl.hash}) — the crop is deterministic, so a frame-range-sharded render still agrees with itself`);
  await page.screenshot({ path: `${shots}/03-final.png` });
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length} zoom checks passed — shots in ${shots}`);
