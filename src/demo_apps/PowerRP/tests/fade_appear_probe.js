/**
 * FADE APPEAR/DISAPPEAR PROBE (verification — OpusJ / Round 14.7 REOPENED).
 *
 * THE probe a user would recognize as "fade" (lead mandate). The earlier
 * fade_livemode_probe faded a color on a PERSISTENT item — a scenario the tween
 * fold renders just as smoothly, so it could not distinguish the fade path from
 * the tween path, and it never covered the real user scenario: items that
 * APPEAR or DISAPPEAR between the two slides (the discrete-value tween rule
 * flips `active` at alpha>0, so on the TWEEN path an appearing item POPS in at
 * the very start instead of fading).
 *
 * Deck: slide A has an item that ONLY exists on A (red, left), slide B has an
 * item that ONLY exists on B (blue, right), plus one PERSISTENT item (gray,
 * center). Slide B's transition is a SLOW linear FADE. Mid-transition, a true
 * crossfade must show BOTH unique items at partial opacity (red fading out,
 * blue fading in) with the persistent item steady.
 *
 * Drives BOTH surfaces:
 *   1. PRESENTER (PresentMode): ArrowRight, then screenshot-samples the real
 *      composited screen through the whole ramp.
 *   2. EDITOR navigation: steps app.slideIndex and samples — to DETERMINE
 *      (not assume) whether the editor animates transitions at all. The editor
 *      finding is REPORTED (rule: editor-instant-by-design is a user question,
 *      not something a probe silently decides), so no assertion fails on it.
 *
 * Spawns its OWN vite (never :3637). Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/fade_appear_probe.js [shot_dir]
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const shotDir = process.argv[2] ?? resolve(webRoot, "../../../../../.claude_logs/opusJ_fade_appear");
mkdirSync(shotDir, { recursive: true });

// 200x200 black camera. Three full-height strips:
//   only_a — RED,  x 10..60   (exists ONLY on slide A: active:false keyed on B)
//   stay   — GRAY, x 75..125  (persistent, unchanged)
//   only_b — BLUE, x 140..190 (exists ONLY on slide B: created there)
const strip = (x, fill) => ({ type: "rect", x, y: 0, w: 50, h: 200, z: 1, rotation: 0, scale: 1, active: true, fill, stroke: null, strokeWidth: 0, cornerRadius: 0, opacity: 1, rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } });
const doc = {
  meta: { name: "fade-appear-probe", slideW: 200, slideH: 200 },
  slides: [
    {
      id: "sA",
      name: "Slide A",
      transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 200, h: 200, z: 1000, rotation: 0, scale: 1, active: true, background: "#000000" },
          only_a: { ...strip(10, "#ff0000"), name: "OnlyA" },
          stay: { ...strip(75, "#808080"), name: "Stay" },
        },
      },
    },
    {
      id: "sB",
      name: "Slide B",
      transition: { type: "fade", seconds: 3, curve: "linear", sound: null },
      delta: {
        items: {
          only_a: { active: false }, // disappears on B
          only_b: { ...strip(140, "#0000ff"), name: "OnlyB" }, // created on B (imaginary-slide rule: full initial state + active:true keyed here)
        },
      },
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
  const ignore = (t) => /zero-sized canvas/.test(t) || /PowerRP repair: item .* was missing/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !ignore(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(doc));
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // Screenshot-sample: the composited page is the ground truth (drawImage of a
  // WebGPU canvas is unreliable — see gpuService.js / concerns.md). Decodes the
  // PNG in-page and reads one pixel per strip center at the given viewport
  // coords. Returns {a, stay, b} each [r,g,b,alpha].
  const sampleAt = async (coords, savePath = null) => {
    const b64 = await page.screenshot({ encoding: "base64" });
    if (savePath) writeFileSync(savePath, Buffer.from(b64, "base64"));
    return page.evaluate(async (dataUrl, coords) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => [...ctx.getImageData(Math.round(x * (c.width / innerWidth)), Math.round(y * (c.height / innerHeight)), 1, 1).data];
      return { a: px(coords.a[0], coords.a[1]), stay: px(coords.stay[0], coords.stay[1]), b: px(coords.b[0], coords.b[1]) };
    }, `data:image/png;base64,${b64}`, coords);
  };

  // ── SURFACE 1: the PRESENTER ────────────────────────────────────────────────
  // 200-world camera fitted to a 400px viewport → zoom 2, no letterbox (1:1
  // aspect): world x → screen 2x. Strip centers: only_a 35→70, stay 100→200,
  // only_b 165→330; y 100→200.
  const P = { a: [70, 200], stay: [200, 200], b: [330, 200] };
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; window.__powerrp_app.mode = "present"; });
  await new Promise((r) => setTimeout(r, 800)); // GPU init + settle on slide A

  const presBefore = await sampleAt(P, resolve(shotDir, "presenter_before.png"));
  await page.keyboard.press("ArrowRight"); // start the 3s fade into slide B
  const presSamples = [];
  for (let i = 0; i < 36; i++) { // ~36×75ms ≈ 2.7s of the 3s ramp
    await new Promise((r) => setTimeout(r, 75));
    presSamples.push(await sampleAt(P, i === 18 ? resolve(shotDir, "presenter_mid.png") : null));
  }
  await new Promise((r) => setTimeout(r, 1200)); // settle
  const presAfter = await sampleAt(P, resolve(shotDir, "presenter_after.png"));
  await page.evaluate(() => { window.__powerrp_app.mode = "edit"; }); // leave present mode
  await new Promise((r) => setTimeout(r, 400));

  // ── SURFACE 2: EDITOR navigation (observe, do not assert) ──────────────────
  // The editor viewport is panel-framed (not a fullscreen camera fit), so pixel
  // coords are unknown — instead detect blending by DIFFING whole screenshots
  // over time after the slide switch: an instant cut settles immediately (all
  // post-switch shots identical); an animated transition keeps changing.
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await new Promise((r) => setTimeout(r, 500));
  const edShots = [];
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; }); // the editor "navigation"
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 150));
    edShots.push(await page.screenshot({ encoding: "base64" }));
  }
  const editorChangesAfterSwitch = new Set(edShots.slice(1)).size > 1; // any post-switch animation?

  // ── Assertions (presenter only — the editor finding is reported, not asserted)
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`FADE APPEAR PROBE FAIL: ${msg}\n  before=${JSON.stringify(presBefore)}\n  after=${JSON.stringify(presAfter)}\n  samples=${JSON.stringify(presSamples)}`);
  };
  const near = (v, t, tol = 24) => Math.abs(v - t) <= tol;
  const partial = (v) => v > 40 && v < 215; // strictly between off (0) and full (255)

  // Endpoints: A = red + gray, no blue; B = gray + blue, no red.
  assert(near(presBefore.a[0], 255) && near(presBefore.b[2], 0), "slide A settled: only_a RED visible, only_b absent");
  assert(near(presAfter.a[0], 0) && near(presAfter.b[2], 255), "slide B settled: only_a gone, only_b BLUE visible");
  assert(near(presBefore.stay[0], 128, 32) && near(presAfter.stay[0], 128, 32), "persistent gray item visible on both endpoints");

  // THE CORE MANDATE: some mid-transition frame shows BOTH unique items at
  // partial opacity — red fading OUT while blue fades IN, simultaneously.
  const crossfading = presSamples.filter((s) => partial(s.a[0]) && partial(s.b[2]));
  assert(
    crossfading.length >= 1,
    "NO mid-fade frame showed BOTH unique items at partial opacity — appearing/disappearing content pops instead of crossfading (the 14.7 REOPENED symptom)",
  );
  // And the ramp is genuinely progressive (red monotonically-ish down, blue up
  // across the blend frames), not a single lucky compositing artifact.
  assert(crossfading.length >= 3, `only ${crossfading.length} genuine crossfade frames in ~2.7s of a 3s fade — blending is not actually ramping on screen`);

  if (errors.length) throw new Error(`Console errors during appear/disappear fade:\n${errors.join("\n")}`);
  const mid = crossfading[Math.floor(crossfading.length / 2)];
  console.log(`FADE APPEAR PROBE OK (presenter): ${crossfading.length} genuine crossfade frames;`);
  console.log(`  mid sample: only_a(red)=${JSON.stringify(mid.a)} only_b(blue)=${JSON.stringify(mid.b)} stay=${JSON.stringify(mid.stay)}`);
  console.log(`EDITOR NAVIGATION FINDING (reported, not asserted): slide switch ${editorChangesAfterSwitch ? "ANIMATES (post-switch frames kept changing)" : "is INSTANT (no post-switch animation — fade never engages in the editor)"}.`);
  console.log(`  screenshots: ${shotDir}`);
} finally {
  await browser.close();
  await server.close();
}
