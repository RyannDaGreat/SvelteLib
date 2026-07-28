/**
 * TEXTURE-BRUSH probe (browser) — the gate for render_gpu/skia/texture_brush.js,
 * the texture-ribbon stroke material (the JS twin of rp.skia_draw_trail).
 *
 * WHY IT DRIVES render() DIRECTLY (not __powerrp_render): the texture brush is not
 * yet registered in render_gpu/skia/stroke_materials.js — that ONE-LINE
 * registration is the wave-2 integrator's job, and this agent may not edit that
 * file. __powerrp_render renders through the page's OWN (module-private) stroke
 * registry, which therefore does not know "textureBrush". So this probe imports
 * texture_brush.js directly (via Vite's /@fs), makes a REAL browser WebGL2 Skia
 * surface (swiftshader under headless Chromium — the same GL backend the editor
 * uses), pre-warms the textures through image_registry, and calls
 * renderTextureBrush on hand-built shape paths. That exercises the actual mesh +
 * texture + jitter code on the actual GPU raster path.
 *
 * FIVE SHAPES per the stroke-material matrix: rounded rect · circle · 5-point
 * star · custom polygon blob · OPEN polyline. Assertions per cell, vs a
 * no-stroke baseline (only the outline can differ):
 *   OUTLINE  — the ribbon must paint SOMETHING near the outline (changed pixels
 *              clear a floor).
 *   INTERIOR — for the filled silhouettes, deep-interior points must MATCH the
 *              baseline (the ribbon must not bleed into the fill). The open
 *              polyline asserts OUTLINE only.
 * DETERMINISM — the same doc rendered TWICE is byte-identical (property state /
 *              Δt law): all pixel comparisons run IN-PAGE and return booleans, so
 *              the puppeteer Uint8Array-drift trap never touches the assertions.
 *
 * Contact-sheet PNGs (≥8 textures + the presets, each on an S-curve) land in
 * .claude_vlm_checks/texture_brush_*.png for the VLM look. Spawns its own Vite +
 * headless Chromium (the stroke_material_probe pattern). Frontend-only.
 * Run: node src/demo_apps/PowerRP/tests/texture_brush_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

// Absolute module paths → Vite /@fs URLs the page can dynamic-import (main.js
// already imports these files, so they are within the dev server's fs.allow).
const fsUrl = (rel) => "/@fs" + resolve(HERE, rel);
const MODS = {
  tb: fsUrl("../render_gpu/skia/texture_brush.js"),
  ck: fsUrl("../render_gpu/skia/browser_canvaskit.js"),
  reg: fsUrl("../render_gpu/gpu/image_registry.js"),
  man: fsUrl("../render_gpu/skia/brush_textures/manifest.js"),
  palette: fsUrl("../web/BrushPalette.svelte"),
};

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const fails = [];
// Node-side compile gate for BrushPalette.svelte: transformRequest runs it through
// Vite's Svelte compiler here (independent of the browser), so a syntax error in
// the component fails the probe loudly even if the page never mounts it.
try {
  const out = await server.transformRequest(MODS.palette);
  if (out && out.code && out.code.length > 0) console.log("  ok   BrushPalette.svelte compiles (Vite transform)");
  else fails.push("BrushPalette.svelte transform produced no code");
} catch (e) {
  fails.push(`BrushPalette.svelte failed to compile: ${e.message}`);
}

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });

  // THE in-page harness: import the modules, build a GL Skia surface, pre-warm
  // textures, render, and do all pixel maths in-page. Returns JSON (Svelte/proxy
  // + Uint8Array drift both avoided by never returning a live object).
  const raw = await page.evaluate(async (MODS) => {
    const tb = await import(MODS.tb);
    const { ensureCanvasKit } = await import(MODS.ck);
    const { ensureImage } = await import(MODS.reg);
    const man = await import(MODS.man);
    const CanvasKit = await ensureCanvasKit();

    const W = 960, H = 320, CELL = 170, STROKE_W = 18, BG = "#123f5a";
    // ── a REAL on-screen GL Skia surface (browser_surface's recipe) ──
    const el = document.createElement("canvas"); el.width = W; el.height = H;
    const handle = CanvasKit.GetWebGLContext(el, { alpha: 1, premultipliedAlpha: 1, antialias: 1, majorVersion: 2 });
    if (!handle) return JSON.stringify({ fatal: "GetWebGLContext returned 0 (no WebGL2)" });
    const gr = CanvasKit.MakeWebGLContext(handle);
    if (!gr) return JSON.stringify({ fatal: "MakeWebGLContext returned null" });

    const col4 = (hex) => CanvasKit.parseColorString(hex);
    // ── shape path builders (LOCAL px, placed at cell origin) ──
    function rrect(x, y, w, h, r) { const b = new CanvasKit.PathBuilder(); b.addRRect(CanvasKit.RRectXY(CanvasKit.LTRBRect(x, y, x + w, y + h), r, r)); const p = b.detach(); b.delete(); return p; }
    function circle(x, y, w, h) { const b = new CanvasKit.PathBuilder(); b.addOval(CanvasKit.LTRBRect(x, y, x + w, y + h)); const p = b.detach(); b.delete(); return p; }
    function star(cx, cy, R, ir, pts) { const b = new CanvasKit.PathBuilder(); for (let i = 0; i < pts * 2; i++) { const rad = i % 2 ? ir : R; const a = -Math.PI / 2 + i * Math.PI / pts; const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a); if (i === 0) b.moveTo(x, y); else b.lineTo(x, y); } b.close(); const p = b.detach(); b.delete(); return p; }
    function poly(x, y, w, h, npts, closed) { const b = new CanvasKit.PathBuilder(); npts.forEach(([nx, ny], i) => { const px = x + nx * w, py = y + ny * h; if (i === 0) b.moveTo(px, py); else b.lineTo(px, py); }); if (closed) b.close(); const p = b.detach(); b.delete(); return p; }

    const CELLS = [
      { id: "rect", at: [20, 80], build: (x, y) => rrect(x, y, CELL, CELL, 30), fill: true },
      { id: "circle", at: [210, 80], build: (x, y) => circle(x, y, CELL, CELL), fill: true },
      { id: "star", at: [400, 80], build: (x, y) => star(x + CELL / 2, y + CELL / 2, CELL * 0.48, CELL * 0.22, 5), fill: true },
      { id: "custom", at: [590, 80], build: (x, y) => poly(x, y, CELL, CELL, [[0.5, 0.02], [0.9, 0.25], [0.98, 0.7], [0.6, 0.98], [0.15, 0.85], [0.02, 0.4]], true), fill: true },
      { id: "polyline", at: [770, 80], build: (x, y) => poly(x, y, CELL, CELL, [[0.05, 0.2], [0.32, 0.85], [0.62, 0.12], [0.95, 0.78]], false), fill: false },
    ];
    const INTERIOR = [[CELL / 2, CELL / 2], [CELL / 2, CELL * 0.36], [CELL * 0.36, CELL / 2], [CELL * 0.64, CELL / 2], [CELL / 2, CELL * 0.64]];

    // ── pre-warm every texture (async decode → sync render contract) ──
    await Promise.all(man.textureIds().map((id) => ensureImage(man.textureUrl(id))));

    // ── surface + readback helpers ──
    function newSurface() { const s = CanvasKit.MakeOnScreenGLSurface(gr, W, H, CanvasKit.ColorSpace.SRGB); if (!s) throw new Error("MakeOnScreenGLSurface null"); return s; }
    function drawUnderlay(canvas) {
      canvas.clear(col4(BG));
      const p = new CanvasKit.Paint();
      // discs OUTSIDE the interior sample zones, so a spilled ribbon is visible
      // against varied tone but the deep-interior probes stay pure background.
      const discs = [["#ffd166", 60, 30], ["#06d6a0", 300, 250], ["#ef476f", 520, 20], ["#118ab2", 720, 260], ["#f8f9fa", 900, 40]];
      for (const [c, x, y] of discs) { p.setColor(col4(c)); canvas.drawCircle(x, y, 34, p); }
      p.delete();
    }
    function readPixels(surface) {
      const img = surface.makeImageSnapshot();
      const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
      img.delete();
      return px; // Uint8Array length W*H*4
    }
    function encode(surface) { const img = surface.makeImageSnapshot(); const bytes = img.encodeToBytes(); img.delete(); let bin = ""; const C = 0x8000; for (let i = 0; i < bytes.length; i += C) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(bin); }
    const pxDiff = (a, b, x, y) => { const i = (y * W + x) * 4; return (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3; };

    // ── baseline (underlay only) ──
    const base = newSurface();
    drawUnderlay(base.getCanvas()); base.flush();
    const basePx = readPixels(base);

    const DEFAULTS = { texture: "wc_coral_wash", preset: "custom", sizeStart: 1, sizeEnd: 1, wobble: 0, wobbleFreq: 3, spacing: 1, tint: "#ffffff", tintStrength: 0, jitterAmount: 0, jitterColor: "#000000", opacity: 1, blend: "normal", seed: 12345 };
    function renderMatrix(params) {
      const s = newSurface();
      const canvas = s.getCanvas();
      drawUnderlay(canvas);
      for (const cell of CELLS) {
        const path = cell.build(cell.at[0], cell.at[1]);
        tb.renderTextureBrush(CanvasKit, canvas, path, params, STROKE_W, 1, true);
        path.delete();
      }
      s.flush();
      return s;
    }
    const GRID_STEP = 4, DIFF_MIN = 8, SAME_TOL = 4, MIN_CHANGED = 40;
    function assertCells(px, name, results) {
      for (const cell of CELLS) {
        let changed = 0;
        for (let dy = 2; dy < CELL - 2; dy += GRID_STEP) for (let dx = 2; dx < CELL - 2; dx += GRID_STEP) if (pxDiff(px, basePx, cell.at[0] + dx, cell.at[1] + dy) > DIFF_MIN) changed++;
        results.push({ name: `${name}/${cell.id} outline`, pass: changed >= MIN_CHANGED, detail: `${changed} changed >= ${MIN_CHANGED}` });
        if (cell.fill) for (const [dx, dy] of INTERIOR) { const d = pxDiff(px, basePx, cell.at[0] + Math.round(dx), cell.at[1] + Math.round(dy)); results.push({ name: `${name}/${cell.id} interior`, pass: d <= SAME_TOL, detail: `diff ${d.toFixed(1)} <= ${SAME_TOL}` }); }
      }
    }

    const results = [];
    const images = {};
    // MACHINE ASSERTIONS on a spread of textures (watercolor/oil/ink/dry) + a preset.
    const MATRIX_CASES = [
      { name: "wc_coral_wash", params: { ...DEFAULTS, texture: "wc_coral_wash" } },
      { name: "oil_blue_bristle", params: { ...DEFAULTS, texture: "oil_blue_bristle" } },
      { name: "oil_crimson_bristle", params: { ...DEFAULTS, texture: "oil_crimson_bristle" } },
      { name: "wc_dry_streak", params: { ...DEFAULTS, texture: "wc_dry_streak" } },
      { name: "preset_watercolorWash", params: { ...DEFAULTS, preset: "watercolorWash" } },
    ];
    for (const c of MATRIX_CASES) {
      const s = renderMatrix(c.params);
      assertCells(readPixels(s), c.name, results);
      images[`matrix_${c.name}`] = encode(s);
      s.delete();
    }

    // DETERMINISM: same params twice → byte-identical raw pixels (in-page compare).
    const d1 = renderMatrix({ ...DEFAULTS, texture: "oil_ember_smear", jitterAmount: 0.3, jitterColor: "#ffffff", seed: 77 });
    const p1 = readPixels(d1); d1.delete();
    const d2 = renderMatrix({ ...DEFAULTS, texture: "oil_ember_smear", jitterAmount: 0.3, jitterColor: "#ffffff", seed: 77 });
    const p2 = readPixels(d2); d2.delete();
    let identical = p1.length === p2.length; for (let i = 0; identical && i < p1.length; i++) if (p1[i] !== p2[i]) identical = false;
    results.push({ name: "determinism (jitter seed 77 rendered twice)", pass: identical, detail: identical ? "byte-identical" : "PIXELS DIFFER" });

    // NOT-READY loudness: a texture that never decoded must draw NOTHING (no throw,
    // no silent fill) — render onto a fresh underlay and confirm the outline is
    // untouched. (We can't force a decode failure cleanly, so this asserts the
    // GL/decode path at least did not corrupt the interior — covered above.)

    // CONTACT SHEET: an S-curve stroke per texture (≥8) + per preset, for the VLM.
    function sCurve() { const b = new CanvasKit.PathBuilder(); b.moveTo(60, 230); b.cubicTo(260, 40, 460, 40, 660, 160); b.cubicTo(760, 220, 840, 120, 900, 90); const p = b.detach(); b.delete(); return p; }
    const GALLERY_TEX = man.textureIds();
    for (const id of GALLERY_TEX) {
      const s = newSurface(); const canvas = s.getCanvas();
      canvas.clear(col4("#f4f4f7"));
      const path = sCurve();
      tb.renderTextureBrush(CanvasKit, canvas, path, { ...DEFAULTS, texture: id, sizeStart: 1.3, sizeEnd: 0.5 }, 44, 1, true);
      path.delete(); s.flush();
      images[`tex_${id}`] = encode(s); s.delete();
    }
    for (const pid of tb.presetIds()) {
      const s = newSurface(); const canvas = s.getCanvas();
      canvas.clear(col4("#f4f4f7"));
      const path = sCurve();
      tb.renderTextureBrush(CanvasKit, canvas, path, { ...DEFAULTS, preset: pid }, 44, 1, true);
      path.delete(); s.flush();
      images[`preset_${pid}`] = encode(s); s.delete();
    }
    // BrushPalette.svelte COMPILE + IMPORT-GRAPH smoke: importing the /@fs .svelte
    // runs it through Vite's Svelte compiler AND resolves its whole import graph
    // (manifest textureUrl, Tooltip, svelte runtime) — the class of breakage the
    // stash incident caused (a component that ReferenceErrors, invisible to render
    // probes). A syntax/import error rejects this import. (Full mount needs the
    // svelte runtime, which a raw page.evaluate cannot bare-import; the node-side
    // Vite transformRequest check below asserts the compile independently.)
    try {
      const palMod = await import(MODS.palette);
      results.push({ name: "BrushPalette compiles + import graph resolves", pass: typeof palMod.default === "function", detail: `default is ${typeof palMod.default}` });
    } catch (e) {
      results.push({ name: "BrushPalette compiles + import graph resolves", pass: false, detail: String(e) });
    }

    return JSON.stringify({ results, images });
  }, MODS);

  const parsed = JSON.parse(raw);
  if (parsed.fatal) { fails.push(`fatal: ${parsed.fatal}`); }
  else {
    for (const [name, b64] of Object.entries(parsed.images)) fs.writeFileSync(resolve(SHOTS, `texture_brush_${name}.png`), Buffer.from(b64, "base64"));
    for (const r of parsed.results) {
      if (r.pass) console.log(`  ok   ${r.name} (${r.detail})`);
      else { fails.push(`${r.name} — ${r.detail}`); console.log(`  FAIL ${r.name} (${r.detail})`); }
    }
    console.log(`  wrote ${Object.keys(parsed.images).length} contact PNGs to .claude_vlm_checks/texture_brush_*.png`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\nFAILED: ${fails.length} — texture brush`); for (const f of fails) console.error("  - " + f); process.exit(1); }
console.log("\nPASS — texture brush (5 shapes × textures/preset, interior clean, deterministic; contact sheet written)");
