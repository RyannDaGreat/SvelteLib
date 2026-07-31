/**
 * BLEND MODES ON THE REAL GPU (browser probe). Spawns its own Vite + headless
 * Chromium (swiftshader WebGL2) — the glass_probe.js / demo_widget_probe.js
 * pattern — and proves the blend modes work on the EDITOR'S backend, not just on
 * the Node CPU surface every other blend suite uses.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/render_gpu/tests/blend_browser_probe.js
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * Seventeen of the 26 modes are Skia's own `SkBlendMode` and would be fine
 * anywhere. The other nine are SkSL RUNTIME BLENDERS (paint.setBlender), and a
 * custom blender is the one construct whose backend support genuinely differs:
 * on GL, blending against `dst` inside a shader forces Skia onto a
 * dst-read/texture-copy transfer processor. If that path were unsupported or
 * silently dropped, the nine modes would render as Normal in the editor while
 * every Node suite stayed green — a defect invisible to the whole rest of this
 * test family. So this probe runs on a REAL MakeRenderTarget GPU surface, in the
 * browser, and reads the pixels back.
 *
 * Two checks:
 *   1. GPU PIXELS — all 26 modes on a GPU render target, compared against
 *      blend_oracle.js. Whatever tolerance the CPU path needs, the GPU must meet
 *      the same one; and no mode may collapse onto Normal.
 *   2. LIVE EDITOR — a real document with 26 blended rects on a colourful
 *      backdrop renders with ZERO page errors and is screenshotted for a look.
 *      This is what catches a blender that throws only under the app's own
 *      surface/effect plumbing.
 *
 * Frontend-only: backend-absent 404s are ignored (the demo_widget_probe rule).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";
import { BLEND_MODES, BLEND_MODE_LABELS } from "../../core/properties.js";
import { compositeReference } from "./blend_oracle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERRP = resolve(HERE, "../.."); // render_gpu/tests → PowerRP root
const webRoot = resolve(POWERRP, "web");
const SHOTS = resolve(POWERRP, ".claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

// TWO probe pairs, in unpremultiplied 0..1. Each is chosen so every mode lands
// strictly inside its own branch: per-channel sums clear Hard Mix's 1.0 threshold
// by ≥ 0.15, and the channel totals clear a Darker/Lighter Color tie by ≥ 0.40.
//
// WHY TWO: Darker Color and Lighter Color each return one of the two colours
// WHOLE, so at any SINGLE pair exactly one of them is identical to Normal by
// definition — which would make a one-pair "did it collapse onto Normal?" check
// accuse a correct mode. The pairs invert which side is lighter (pair A: source
// total 1.75 > backdrop 1.35; pair B: source 0.95 < backdrop 1.90), so every mode
// must differ from Normal in at LEAST one of them.
const PROBE_PAIRS = [
  { dst: [0.75, 0.35, 0.25, 1], src: [0.40, 0.40, 0.95, 1] }, // sums 1.15/0.75/1.20; totals 1.35 vs 1.75
  { dst: [0.30, 0.80, 0.80, 1], src: [0.55, 0.25, 0.15, 1] }, // sums 0.85/1.05/0.95; totals 1.90 vs 0.95
];
// The GPU is a different rasterizer with its own precision; these are the CPU
// tolerances from blend_modes_test.js, reused unchanged so the GPU is held to the
// same standard rather than given slack.
const LEVEL_TOLERANCE = 1;
const RECIPROCAL_TOLERANCE = 5;
const RECIPROCAL_MODES = ["colorBurn", "colorDodge", "vividLight", "divide"];
const NONSEPARABLE_TOLERANCE = 2;
const NONSEPARABLE_MODES = ["hue", "saturation", "color", "luminosity"];
const toleranceFor = (m) => (RECIPROCAL_MODES.includes(m) ? RECIPROCAL_TOLERANCE : NONSEPARABLE_MODES.includes(m) ? NONSEPARABLE_TOLERANCE : LEVEL_TOLERANCE);

const SLIDE_W = 1200, SLIDE_H = 700;
const GRID_COLS = 7, TILE = 150, TILE_GAP = 12, GRID_ORIGIN = 30;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("../../tests/puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const check = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Environment noise, not blend-mode signal: absent backend (frontend-only run),
  // and swiftshader's missing WebGPU adapter, which only the videoV7 experiment
  // asks for (the boolean_uniformity_probe IGNORE_BOOT precedent).
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no WebGPU adapter|WebGPU init failed/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 30000 });
  await sleep(2500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── 1. GPU PIXELS: every mode on a real MakeRenderTarget surface ────────────
  const CK_URL = `/@fs${resolve(POWERRP, "render_gpu/skia/browser_canvaskit.js")}`;
  const SURF_URL = `/@fs${resolve(POWERRP, "render_gpu/skia/browser_surface.js")}`;
  const BLEND_URL = `/@fs${resolve(POWERRP, "render_gpu/skia/blend_modes.js")}`;

  const gpu = await page.evaluate(async (ckUrl, surfUrl, blendUrl, modes, pairs) => {
    const ck = await (await import(ckUrl)).ensureCanvasKit();
    const { SkiaSurface } = await import(surfUrl);
    const { SKIA_NATIVE_BLEND_MODES, blendNeedsSkSL, blenderFor } = await import(blendUrl);
    // A real GL context + grContext, then GPU render targets through the app's own
    // guarded factory — the exact surfaces handleEffectSubtree composites into.
    const host = document.createElement("canvas");
    host.width = 64; host.height = 64;
    const skia = await SkiaSurface.create(host);
    const out = { backend: skia.grContext ? "webgl2-grcontext" : "NO-GRCONTEXT", pixels: pairs.map(() => ({})), threw: {} };
    for (let pi = 0; pi < pairs.length; pi++) {
      const { dst, src } = pairs[pi];
      for (const mode of modes) {
        try {
          const surface = skia._makeSurface(1, 1);
          if (!surface) { out.threw[mode] = "MakeRenderTarget returned null"; continue; }
          const canvas = surface.getCanvas();
          canvas.clear(ck.Color4f(0, 0, 0, 0));
          const pd = new ck.Paint();
          pd.setColor(ck.Color4f(...dst));
          pd.setBlendMode(ck.BlendMode.Src);
          canvas.drawPaint(pd); pd.delete();
          const ps = new ck.Paint();
          ps.setColor(ck.Color4f(...src));
          if (blendNeedsSkSL(mode)) ps.setBlender(blenderFor(ck, mode));
          else ps.setBlendMode(ck.BlendMode[SKIA_NATIVE_BLEND_MODES[mode]]);
          canvas.drawPaint(ps); ps.delete();
          surface.flush();
          const bytes = canvas.readPixels(0, 0, {
            width: 1, height: 1,
            colorType: ck.ColorType.RGBA_8888,
            alphaType: ck.AlphaType.Unpremul,
            colorSpace: ck.ColorSpace.SRGB,
          });
          out.pixels[pi][mode] = [bytes[0], bytes[1], bytes[2], bytes[3]];
          surface.dispose ? surface.dispose() : surface.delete?.();
        } catch (e) { out.threw[mode] = String(e && e.message ? e.message : e).slice(0, 200); }
      }
    }
    skia.dispose();
    return out;
  }, CK_URL, SURF_URL, BLEND_URL, BLEND_MODES, PROBE_PAIRS);

  check(gpu.backend === "webgl2-grcontext", `the probe ran on a REAL GL grContext (${gpu.backend})`);
  check(Object.keys(gpu.threw).length === 0, `no mode threw on the GPU${Object.keys(gpu.threw).length ? ` — ${JSON.stringify(gpu.threw)}` : ""}`);

  const to8 = (c) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  let worst = 0;
  const rows = [];
  for (const mode of BLEND_MODES) {
    const shown = [];
    for (let pi = 0; pi < PROBE_PAIRS.length; pi++) {
      const got = gpu.pixels[pi][mode];
      if (!got) { fails.push(`no GPU pixel for "${mode}" (pair ${pi})`); continue; }
      const { dst, src } = PROBE_PAIRS[pi];
      const want = to8(compositeReference(mode, src, dst));
      const delta = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
      worst = Math.max(worst, delta);
      shown.push(`Δ${delta}`);
      if (delta > toleranceFor(mode))
        fails.push(`GPU "${mode}" pair ${pi} = ${got} but the formula says ${want} (Δ ${delta} > ${toleranceFor(mode)}) — the mode does not compute correctly on WebGL2`);
    }
    rows.push(`       ${BLEND_MODE_LABELS[mode].padEnd(20)} gpu ${String(gpu.pixels[0][mode]).padEnd(22)} want ${String(to8(compositeReference(mode, PROBE_PAIRS[0].src, PROBE_PAIRS[0].dst))).padEnd(22)} ${shown.join(" ")}`);
  }
  console.log(rows.join("\n"));
  check(worst <= RECIPROCAL_TOLERANCE, `every mode matches its formula on the GPU, on BOTH pairs (worst Δ ${worst}/255)`);

  // A blender that failed to run would render Normal — i.e. exactly the source.
  // That is the silent failure this probe exists for, so it gets its own explicit
  // assertion: differing from Normal in at least one pair (see PROBE_PAIRS on why
  // one pair is not enough for the whole-colour modes).
  const differsFromNormal = (m) => PROBE_PAIRS.some((_, pi) => String(gpu.pixels[pi][m]) !== String(gpu.pixels[pi].normal));
  const collapsed = BLEND_MODES.filter((m) => m !== "normal" && !differsFromNormal(m));
  check(collapsed.length === 0, `no mode collapsed onto Normal on the GPU${collapsed.length ? ` — ${collapsed.join(", ")}` : ""}`);
  const SKSL_MODES = ["linearBurn", "darkerColor", "lighterColor", "vividLight", "linearLight", "pinLight", "hardMix", "subtract", "divide"];
  const skslCollapsed = SKSL_MODES.filter((m) => !differsFromNormal(m));
  check(skslCollapsed.length === 0, `all nine SkSL runtime blenders really ran on GL${skslCollapsed.length ? ` — collapsed: ${skslCollapsed.join(", ")}` : ""}`);

  // ── 2. LIVE EDITOR: a real document using all 26 modes ─────────────────────
  await page.evaluate((modes, labels, geom) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const { SLIDE_W, SLIDE_H, GRID_COLS, TILE, TILE_GAP, GRID_ORIGIN } = geom;
    const items = {
      cam: { ...def("camera"), name: "Camera", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, z: 1000, active: true, background: "#101018" },
    };
    // A colourful backdrop for the blends to interact with: a bright bar plus
    // saturated circles (the glass_probe backdrop recipe).
    items.bar = { ...def("rect"), name: "Bar", x: -40, y: 300, w: SLIDE_W + 80, h: 110, z: 1, rotation: -0.1, fill: "#eef2ff", active: true };
    const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff", "#b4ff78", "#c37bff"];
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 24; i++) {
      const d = 60 + rnd() * 120;
      items["c" + i] = { ...def("circle"), name: "C" + i, x: rnd() * (SLIDE_W - d), y: rnd() * (SLIDE_H - d), w: d, h: d, z: 2, fill: cols[i % cols.length], active: true };
    }
    // One blended tile per mode, over that backdrop.
    modes.forEach((mode, i) => {
      const col = i % GRID_COLS, row = Math.floor(i / GRID_COLS);
      items["b" + i] = {
        ...def("rect"), name: labels[mode], z: 50 + i, active: true,
        x: GRID_ORIGIN + col * (TILE + TILE_GAP), y: GRID_ORIGIN + row * (TILE + TILE_GAP),
        w: TILE, h: TILE, cornerRadius: 8, fill: "#5878e0",
        blendMode: mode,
      };
    });
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    app.commit(app.repaired({ meta: { name: "blend-qa", slideW: SLIDE_W, slideH: SLIDE_H }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items } }] }));
    app.slideIndex = 0;
  }, BLEND_MODES, BLEND_MODE_LABELS, { SLIDE_W, SLIDE_H, GRID_COLS, TILE, TILE_GAP, GRID_ORIGIN });
  await sleep(2500); // Skia paint + the nine blender compiles

  const shot = resolve(SHOTS, "blend_live_editor.png");
  await page.screenshot({ path: shot });
  check(true, `live editor screenshot → ${shot}`);

  // The state must actually carry the modes (a repair that dropped an unknown
  // blend id would leave every tile Normal and the screenshot would look fine).
  const stored = await page.evaluate((modes) => {
    const app = window.__powerrp_app;
    const state = app.state().items;
    return modes.map((mode, i) => state["b" + i]?.blendMode);
  }, BLEND_MODES);
  const wrong = BLEND_MODES.filter((mode, i) => stored[i] !== mode);
  check(wrong.length === 0, `all 26 modes survive repair + fold into item state${wrong.length ? ` — lost: ${wrong.join(", ")}` : ""}`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length}): ${fails.join("; ")}` : `\nALL BLEND BROWSER-PROBE ASSERTIONS PASSED (26 modes on WebGL2)`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
