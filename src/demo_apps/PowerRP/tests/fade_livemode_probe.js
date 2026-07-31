/**
 * LIVE PRESENT-MODE FADE PROBE (verification, ephemeral — OpusJ / Round 14.7).
 *
 * The TRUE end-to-end fade test: it boots the editor, enters REAL present mode
 * (app.mode = "present" → web/PresentMode.svelte mounts its own presenter +
 * GPU/2D surfaces), triggers the fade with ArrowRight, and samples the ACTUAL
 * visible on-screen canvas pixel repeatedly during the transition. It asserts a
 * genuine mid-fade blend is actually PAINTED (not that the pure helper could
 * produce one — fade_probe.js already proves that below the presenter). If the
 * on-screen surface cuts red→blue, no sampled frame is a blend and this fails.
 *
 * The fade is deliberately SLOW (3s) so the async GPU crossfade has time to be
 * on screen when we sample — a headless flake-guard, not a behavior change.
 *
 * Spawns its OWN vite (never :3637). Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/fade_livemode_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

// Two-slide deck, RED → BLUE, slide 2 = a SLOW fade (linear → ~50/50 midpoint).
const doc = {
  meta: { name: "fade-livemode-probe", slideW: 200, slideH: 200 },
  slides: [
    {
      id: "s0",
      name: "Slide 1",
      transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 200, h: 200, z: 1000, rotation: 0, scale: 1, active: true, background: "#000000" },
          box: { type: "rect", name: "Box", x: 0, y: 0, w: 200, h: 200, z: 1, rotation: 0, scale: 1, active: true, fill: "#ff0000", stroke: null, strokeWidth: 0, cornerRadius: 0, opacity: 1, rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } },
        },
      },
    },
    {
      id: "s1",
      name: "Slide 2",
      transition: { type: "fade", seconds: 3, curve: "linear", sound: null },
      delta: { items: { box: { fill: "#0000ff" } } },
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400, deviceScaleFactor: 1 });
  // The minimal hand-authored deck omits some effect props on purpose; the
  // loader fills them with defaults and reports it LOUDLY (a repair message, not
  // a fade bug). Ignore ONLY that expected repair line.
  const ignore = (t) => /PowerRP repair: item .* was missing/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !ignore(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  // Seed the deck via autosave (App loads it), then boot.
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(doc));
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  // Wait for the app hook to exist (boot + autosave load can race the fixed
  // sleep — poll instead of guessing).
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // Enter present mode on slide 1 (index 0). PresentMode mounts + goTo(0).
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; window.__powerrp_app.mode = "present"; });
  await new Promise((r) => setTimeout(r, 800)); // GPU device init + first paint

  // Diagnostic: dump the present-mode canvas DOM state so a null sample is
  // explainable (missing canvas vs zero-size vs all-hidden vs GPU-not-up).
  const diag = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll(".present canvas")];
    return {
      presentExists: !!document.querySelector(".present"),
      count: canvases.length,
      canvases: canvases.map((c) => ({ w: c.width, h: c.height, hidden: c.classList.contains("hidden"), cw: c.clientWidth, ch: c.clientHeight })),
    };
  });
  console.log("DIAG present DOM:", JSON.stringify(diag));

  // Sample the CENTER pixel of what is TRULY on screen via a page screenshot
  // (captures the composited page including the WebGPU swapchain — drawImage of a
  // WebGPU canvas is not dependable post-present, per gpuService.js, so an
  // in-page canvas copy reads transparent; the screenshot is the ground truth).
  // The PNG is decoded IN-PAGE through an <img> → 2D canvas → getImageData.
  const sampleVisible = async () => {
    const b64 = await page.screenshot({ encoding: "base64" });
    return page.evaluate(async (dataUrl) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return [px[0], px[1], px[2], px[3]];
    }, `data:image/png;base64,${b64}`);
  };

  const before = await sampleVisible(); // slide 1 settled — should be RED

  // Trigger the fade into slide 2 and sample the visible surface repeatedly for
  // the whole 3s ramp, recording every sample.
  await page.keyboard.press("ArrowRight");
  const samples = [];
  for (let i = 0; i < 40; i++) { // ~40 * 60ms ≈ 2.4s, inside the 3s ramp
    await new Promise((r) => setTimeout(r, 60));
    const s = await sampleVisible();
    if (s) samples.push(s);
  }
  await new Promise((r) => setTimeout(r, 1800)); // let it settle
  const after = await sampleVisible(); // slide 2 settled — should be BLUE
  console.log("SAMPLES before:", JSON.stringify(before), "after:", JSON.stringify(after));
  console.log("SAMPLES mid:", JSON.stringify(samples));

  const assert = (cond, msg) => {
    if (!cond) throw new Error(`FADE LIVEMODE PROBE FAIL: ${msg}\n  before=${JSON.stringify(before)} after=${JSON.stringify(after)}\n  samples=${JSON.stringify(samples)}`);
  };
  const near = (a, b, tol = 24) => Math.abs(a - b) <= tol;

  assert(before && near(before[0], 255) && near(before[2], 0), "before ArrowRight the visible surface should be RED (slide 1)");
  assert(after && near(after[2], 255) && near(after[0], 0), "after settling the visible surface should be BLUE (slide 2)");

  // A genuine crossfade is ON SCREEN if some sample has BOTH red and blue
  // partial (a red↔blue mix). A hard cut only ever shows pure red then pure blue.
  const blend = samples.find((c) => c[0] > 40 && c[0] < 220 && c[2] > 40 && c[2] < 220);
  assert(blend != null, "no sampled on-screen frame was a red↔blue blend — the fade CUT instead of crossfading on the visible surface");

  if (errors.length) throw new Error(`Console errors during live present-mode fade:\n${errors.join("\n")}`);
  console.log(`FADE LIVEMODE PROBE OK: on-screen crossfade painted — before=RED, mid blend=${JSON.stringify(blend)}, after=BLUE. ${samples.length} samples, zero console errors.`);
} finally {
  await browser.close();
  await server.close();
}
