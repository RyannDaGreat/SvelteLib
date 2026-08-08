/**
 * PAINT-LEVEL GRADIENT DITHER — IN THE REAL EDITOR VIEWPORT.
 * Run: node tests/gradient_dither_viewport_probe.js
 *
 * ── WHY THIS PROBE EXISTS, AND WHY A NODE TEST CANNOT REPLACE IT ─────────────
 * The camera-wide dither this feature replaces was, in the user's words, "a total
 * failure": it "just does nothing when I activate it". It shipped with tests, and
 * those tests were green, because it worked EVERYWHERE EXCEPT WHERE THE USER WAS.
 *
 * The autopsy (measured 2026-08-07 on the user's own M4 Max, and reproduced under
 * SwiftShader): that design de-banded by compositing the whole frame into an
 * RGBA16F offscreen and dithering on the F16 → 8-bit downconvert. But
 * render_gpu/skia/browser_surface.js builds the on-screen WebGL2 context with
 * `antialias: 1` whenever the camera's AA is "standard" — the DEFAULT — so the
 * on-screen surface is 4x MSAA. Skia's `makeSurface` INHERITS the source surface's
 * sample count, so it asked for a 4x-MSAA RGBA16F render target, which Skia's GLES
 * caps refuse. It returned null, a try/catch swallowed it, one console.warn nobody
 * read went out, and the frame painted undithered. Every bare-node test passed
 * (a software surface is 1-sample); web/gpuService.js was unaffected (its
 * MakeRenderTarget surfaces are always 1-sample), which is exactly why dither
 * worked in PNG/video export and never on screen — a split nobody could explain.
 *
 * SO THE ONE THING NO NODE TEST CAN CHECK IS "does it work on the MSAA on-screen
 * surface the editor actually renders through". That is this probe's entire job.
 * The paint-level dither should be immune by construction — it needs no offscreen
 * at all, because a paint shader's output is a float Skia quantizes as it writes
 * to the destination — but "should be immune by construction" is precisely the
 * kind of reasoning that shipped the last one. This measures it instead.
 *
 * IT ALSO PINS THE MSAA PRECONDITION. If a future change made the on-screen
 * context 1-sample, this probe would still pass while no longer testing anything —
 * so it asserts `gl.SAMPLES > 1` first and fails loudly if the case it exists to
 * cover has quietly stopped existing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { imageDistance, readPng } from "./imageDistinctness.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const shots = resolve(here, "..", ".claude_vlm_checks");

const BOOT_TIMEOUT_MS = 60_000;
const BOOT_MS = 1200;
const SETTLE_MS = 400;

// The banding torture ramp: a near-black vertical gradient over a big box. A
// full-range gradient bands one pixel at a time and would make a working dither
// measure the same as a broken one.
const RAMP = {
  type: "linearGradient",
  linear: {
    stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#0a0a12" }],
    from: { x: 0, y: 0 }, to: { x: 0, y: 1 },
  },
};
const BIG_BOX = { x: 120, y: 60, w: 1000, h: 700 };
// Emphasis 16 is deliberately LOUD. This probe answers "does anything happen at
// all on this surface", and a one-code-value change compressed through a PNG
// screenshot of a scaled viewport is not a measurement anyone should build a gate
// on. The one-LSB claim is pinned on real pixels in render_gpu/tests/gradient_dither_test.js.
const EMPHASIS = 16;
// Whole-frame mean distance that counts as "the picture changed". The widget
// covers most of the viewport, so a working dither at emphasis 16 moves this well
// clear of it; a no-op dither scores exactly 0.
const CHANGED_BOUND = 0.05;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  root: webRoot,
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

const browser = await launchBrowser();
const failures = [];
/** Command. Records one check's outcome and prints it. */
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};

try {
  await mkdir(shots, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  await new Promise((r) => setTimeout(r, BOOT_MS));
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  // ── (0) THE PRECONDITION: the on-screen surface really is multisampled ─────
  // This is the condition that killed the camera dither. If it is false, this
  // probe is no longer testing the case it was written for and must say so.
  const samples = await page.evaluate(() => {
    // EVERY canvas in the viewport, not one guessed selector: CanvasView stacks a
    // video overlay canvas over the Skia one, so picking "the first canvas" is a
    // coin flip. The MSAA surface is whichever has SAMPLES > 1.
    const all = [...document.querySelectorAll("canvas")];
    const counts = all.map((c) => {
      // getContext returns the SAME context CanvasKit bound, so this observes the
      // real on-screen surface rather than making a second one.
      try { const gl = c.getContext("webgl2"); return gl ? gl.getParameter(gl.SAMPLES) : null; } catch { return null; }
    });
    return { counts, max: Math.max(0, ...counts.filter((n) => typeof n === "number")) };
  });
  check("the editor's on-screen GL surface is MSAA (the case that broke the camera dither)",
    samples.max > 1,
    `gl.SAMPLES across ${samples.counts.length} canvas(es) = ${JSON.stringify(samples.counts)} — if none exceeds 1 the probe still runs but no longer covers the MSAA path`);

  // ── (1) a big near-black gradient rect, undithered ─────────────────────────
  const id = await page.evaluate(({ box, fill }) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("rect").defaults, type: "rect", ...box, fill, stroke: null, strokeWidth: 0 });
    return app.selectedNode()?.id ?? null;
  }, { box: BIG_BOX, fill: RAMP });
  await settle();
  check("a gradient rect was inserted and selected", !!id, String(id));

  /** Query. A PNG of the canvas region — what the viewport actually painted. */
  const canvasShot = async () => (await page.$(".canvas-wrap")).screenshot();

  const before = await canvasShot();
  await writeFile(`${shots}/viewport_dither_off.png`, before);

  // ── (2) turn the dither on, ON THE PAINT ──────────────────────────────────
  const wrote = await page.evaluate(({ itemId, emphasis }) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", itemId, "fill", "ditherMode"], "bayer"],
      [["items", itemId, "fill", "ditherEmphasis"], emphasis],
    ]);
    app.commitPreview();
    const st = app.state().items[itemId];
    return { mode: st?.fill?.ditherMode ?? null, emphasis: st?.fill?.ditherEmphasis ?? null };
  }, { itemId: id, emphasis: EMPHASIS });
  await settle();
  check("the dither leaves landed on the PAINT in the evaluated state",
    wrote.mode === "bayer" && wrote.emphasis === EMPHASIS, JSON.stringify(wrote));

  const after = await canvasShot();
  await writeFile(`${shots}/viewport_dither_bayer.png`, after);

  // ── (3) THE ASSERTION THE OLD DESIGN WOULD HAVE FAILED ────────────────────
  const dist = imageDistance(readPng(before), readPng(after));
  check("turning dither ON visibly changes the EDITOR VIEWPORT",
    dist.meanAbs > CHANGED_BOUND,
    `whole-frame mean |delta| ${dist.meanAbs.toFixed(4)} over ${(100 * dist.fraction).toFixed(1)}% of pixels, max ${dist.maxAbs} (bound ${CHANGED_BOUND}); 0.0000 means the viewport is painting undithered — exactly the camera dither's failure`);

  // ── (3b) BIT DEPTH renders on the same surface, with dither OFF ───────────
  // Hard posterization is the capability that survived the row-visibility ruling
  // (core/properties.paintDitherIsOn), so it needs its own viewport evidence: it
  // takes the shader path with emphasis 0, which no other check here exercises.
  await page.evaluate((itemId) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", itemId, "fill", "ditherMode"], "off"], [["items", itemId, "fill", "bitDepth"], 1]]);
    app.commitPreview();
  }, id);
  await settle();
  const posterized = await canvasShot();
  await writeFile(`${shots}/viewport_posterize_1bit.png`, posterized);
  const posterDist = imageDistance(readPng(before), readPng(posterized));
  check("a 1-bit bitDepth POSTERIZES the viewport with the dither OFF",
    posterDist.meanAbs > CHANGED_BOUND,
    `mean |delta| ${posterDist.meanAbs.toFixed(4)} over ${(100 * posterDist.fraction).toFixed(1)}% of pixels (bound ${CHANGED_BOUND}); 0 means bitDepth is inert here — the hard-posterize look is unreachable`);

  await page.evaluate((itemId) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", itemId, "fill", "bitDepth"], 8]]);
    app.commitPreview();
  }, id);
  await settle();

  // ── (4) and turning it back off restores the undithered picture ───────────
  // Guards the other direction: a "dither" that merely perturbed the scene once
  // (a relayout, a selection halo, a repaint artefact) would pass (3) and fail here.
  await page.evaluate((itemId) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", itemId, "fill", "ditherMode"], "off"]]);
    app.commitPreview();
  }, id);
  await settle();
  const restored = await canvasShot();
  const backDist = imageDistance(readPng(before), readPng(restored));
  check("switching the dither back to \"off\" restores the undithered picture",
    backDist.meanAbs < CHANGED_BOUND / 5,
    `mean |delta| from the original ${backDist.meanAbs.toFixed(4)} over ${(100 * backDist.fraction).toFixed(1)}% of pixels — should be ~0`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAIL gradient_dither_viewport_probe — ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nOK gradient_dither_viewport_probe — the paint-level dither renders on the editor's MSAA on-screen surface");
