/**
 * LIVE FADE-THROUGH-THE-PRESENTER PROBE (verification, ephemeral — OpusJ /
 * Round 14.7).
 *
 * WHY THIS EXISTS (and how it differs from fade_probe.js): fade_probe.js calls
 * renderTransitionFrame(doc, 1, alpha, …) DIRECTLY at hand-picked alphas
 * (0/0.5/1). That proves the pure crossfade PLANNER works, but it never drives
 * the PRESENTER — so it tests a layer BELOW the real playback path and stays
 * green even if the presenter never feeds a fade its intermediate alphas. This
 * probe closes that gap: it runs the ACTUAL core/presentation.js presenter,
 * captures every {index, alpha, transition} frame it emits during a fade step,
 * and renders each one exactly as web/PresentMode.paint() does (isFadeFrame →
 * renderTransitionFrame). It then asserts a captured MID-fade frame is a genuine
 * blend strictly between the two endpoints. If the presenter cuts instead of
 * fading, a mid frame will read as a pure endpoint and this probe fails.
 *
 * Spawns its OWN vite (never the dev server on :3637). Run from the SvelteLib
 * repo root:
 *   node src/demo_apps/PowerRP/tests/fade_presenter_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

// Same two-slide deck as fade_probe: slide 1 fills the camera with RED, slide 2
// with BLUE, slide 2's transition is a FADE (linear curve → ~50/50 midpoint).
// seconds is nonzero so the presenter actually ANIMATES (rAF ticks) rather than
// snapping — that is the whole point of driving the presenter.
const doc = {
  meta: { name: "fade-presenter-probe", slideW: 200, slideH: 200 },
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
      transition: { type: "fade", seconds: 0.5, curve: "linear", sound: null },
      delta: { items: { box: { fill: "#0000ff" } } }, // same box, now blue
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const url = `${base}/?cli=1`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });

  const appDir = resolve(webRoot, "..");
  const W = 200, H = 200;
  const result = await page.evaluate(async (docObj, base, appDir, W, H) => {
    const fs = (p) => `${base}/@fs${appDir}/${p}`;
    const { createPresenter } = await import(fs("core/presentation.js"));
    const { renderTransitionFrame, isFadeFrame } = await import(fs("web/transitionRender.js"));
    const { createRegistry } = await import(fs("core/registry.js"));
    const { createCommands } = await import(fs("core/commands.js"));
    const { registerAll } = await import(fs("plugins/index.js"));
    const registry = createRegistry();
    registerAll(registry, createCommands());

    const centerOf = (canvas) => {
      const px = canvas.getContext("2d").getImageData(W / 2, H / 2, 1, 1).data;
      return [px[0], px[1], px[2], px[3]];
    };

    // Drive the REAL presenter. Its onFrame is exactly PresentMode's onFrame
    // seam; we record every emitted frame (index, alpha, whether it's a fade
    // frame, and its rendered center pixel through the SAME path paint() uses).
    const frames = [];
    const captured = [];
    const presenter = createPresenter(
      () => docObj,
      (f) => frames.push({ ...f }),
      () => {}, // no transition-sound seam in this probe
      requestAnimationFrame, // inject THE frame scheduler (browser rAF) — core is scheduler-agnostic
      cancelAnimationFrame,
    );

    presenter.goTo(0); // settle on slide 1 (red), alpha 1
    // Advance into slide 2 (fade). transitionTo drives an rAF alpha ramp; we
    // wait for it to complete (seconds=0.5 → ~0.5s of rAF ticks), collecting
    // frames the whole time.
    presenter.next();
    await new Promise((r) => setTimeout(r, 900)); // > seconds, let the ramp finish
    presenter.stop();

    // Render each captured frame the way PresentMode.paint() does: fade frames
    // go through renderTransitionFrame (crossfade), endpoints through the same
    // helper (single completed slide). Record alpha + center + isFade.
    for (const f of frames) {
      const canvas = await renderTransitionFrame(docObj, f.index, f.alpha, registry, W, H);
      captured.push({
        index: f.index,
        alpha: f.alpha,
        type: f.transition?.type ?? null,
        isFade: isFadeFrame(docObj, f.index, f.alpha),
        center: centerOf(canvas),
      });
    }

    return {
      frameCount: frames.length,
      alphas: frames.map((f) => f.alpha),
      captured,
    };
  }, doc, base, appDir, W, H);

  const assert = (cond, msg) => {
    if (!cond) throw new Error(`FADE PRESENTER PROBE FAIL: ${msg}\n  ${JSON.stringify(result, null, 2)}`);
  };

  // The presenter must have EMITTED intermediate alphas (an rAF ramp), not just
  // jumped 1 → 1. A cut would show a single terminal frame at alpha 1.
  const midAlphas = result.alphas.filter((a) => a > 0 && a < 1);
  assert(result.frameCount >= 3, `presenter should emit multiple frames during a 0.5s fade (got ${result.frameCount})`);
  assert(midAlphas.length >= 1, `presenter emitted no intermediate alpha — it CUT instead of ramping (alphas=${JSON.stringify(result.alphas)})`);

  // At least one captured frame must be a genuine MID-fade crossfade: flagged
  // isFade AND its center a red↔blue blend strictly between the endpoints.
  const RED = [255, 0, 0], BLUE = [0, 0, 255];
  const between = (c) => c[0] > 40 && c[0] < 220 && c[2] > 40 && c[2] < 220; // both channels partial
  const fadeFrames = result.captured.filter((c) => c.isFade);
  assert(fadeFrames.length >= 1, `no captured frame was a fade frame — presenter never drove a mid-fade (isFade all false)`);
  const genuineBlend = fadeFrames.find((c) => between(c.center));
  assert(
    genuineBlend != null,
    `no mid-fade frame was a genuine blend between RED ${JSON.stringify(RED)} and BLUE ${JSON.stringify(BLUE)} — fade CUT instead of crossfading`,
  );

  // The final settled frame must be the completed NEW slide (BLUE).
  const last = result.captured.at(-1);
  const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;
  assert(last.index === 1 && near(last.center[2], 255) && near(last.center[0], 0), `final frame should be completed BLUE slide (got ${JSON.stringify(last.center)})`);

  if (errors.length) throw new Error(`Console errors during presenter-driven fade:\n${errors.join("\n")}`);
  console.log(`FADE PRESENTER PROBE OK: presenter emitted ${result.frameCount} frames (${midAlphas.length} intermediate alphas);`);
  console.log(`  genuine mid-fade blend at alpha=${genuineBlend.alpha.toFixed(3)} center=${JSON.stringify(genuineBlend.center)}; final=BLUE. Zero console errors.`);
} finally {
  await browser.close();
  await server.close();
}
