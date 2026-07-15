/**
 * EFFECTS SUBSTRATE pixel probe (manifest Round 12D) — the REAL GPU
 * compositor, headless (Vite + puppeteer, the filmstrip_cli_render harness
 * pattern), with per-pixel assertions:
 *
 *   1. SHADOW: offset dark region beyond the widget's bottom-right; clean
 *      background beyond its top-left (the offset direction); shadow color.
 *   2. BLOOM: additive glow outside the shape's rim vs a bloomless twin.
 *   3. MULTIPLY: out = src·dst (fixed-function (dst, 1−sa)) within tolerance.
 *   4. ADD: out = min(src + dst, 1) within tolerance.
 *   5. UNDER-MAGNIFIER: an effected widget's shadow appears INSIDE a
 *      supersampling lens at the magnified position (the manifest "an
 *      effected widget under a lens must magnify with its effects").
 *   6. EFFECT-OFF IR REGRESSION: the committed demo document emits ZERO
 *      effectSubtree ops (the byte-identity guarantee at the IR level — the
 *      emit-level SAME-ARRAY identity is render_gpu/tests/effects_test.js).
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/effects_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

// ── IR built in NODE through the REAL plugin emit path (JSON-serializable) ──
const { rectPlugin } = await import("../plugins/rect.js");
const { circlePlugin } = await import("../plugins/circle.js");
const { pushTransform, popTransform, magnifyBackdrop, rect } = await import("../render_gpu/ir.js");

/** The sceneIR node wrap for a widget state (the pdf_scenes node() idiom). */
function node(plugin, state) {
  const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
  const local = { ...state, x: 0, y: 0 };
  return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
}

const W = 400, H = 300;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

// 1. SHADOW: 100×80 blue rect at (100,80); shadow dx=20 dy=20 blur=4 black @1.
const shadowIR = [
  rect({ x: 0, y: 0, w: W, h: H, fill: "#ffffff" }),
  ...node(rectPlugin, { ...rectPlugin.defaults, x: 100, y: 80, w: 100, h: 80, strokeWidth: 0, shadow: { dx: 20, dy: 20, blur: 4, color: "#000000", opacity: 1 } }),
];

// 2. BLOOM: twin amber circles on dark bg — bloomed at (60,60), plain at (240,60).
const bloomIR = [
  rect({ x: 0, y: 0, w: W, h: H, fill: "#101018" }),
  ...node(circlePlugin, { ...circlePlugin.defaults, x: 60, y: 60, w: 100, h: 100, fill: "#e0af68", strokeWidth: 0, bloom: { radius: 10, strength: 1.5 } }),
  ...node(circlePlugin, { ...circlePlugin.defaults, x: 240, y: 60, w: 100, h: 100, fill: "#e0af68", strokeWidth: 0 }),
];

// 3+4. BLEND MATH: mid-gray rects multiplied/added over a green backdrop.
const GREEN = [0x9e, 0xce, 0x6a], GRAY = 0x80;
const blendIR = [
  rect({ x: 0, y: 0, w: W, h: H, fill: "#9ece6a" }),
  ...node(rectPlugin, { ...rectPlugin.defaults, x: 40, y: 40, w: 100, h: 80, fill: "#808080", strokeWidth: 0, blendMode: "multiply" }),
  ...node(rectPlugin, { ...rectPlugin.defaults, x: 240, y: 40, w: 100, h: 80, fill: "#808080", strokeWidth: 0, blendMode: "add" }),
];

// 5. UNDER-MAGNIFIER: the shadow doc + a supersampling 2× lens centered on the
// shadow's corner region so the magnified shadow fills the lens.
const lensCx = 230, lensCy = 190, lensR = 60, MAG = 2;
const lensIR = [
  ...shadowIR,
  magnifyBackdrop({ cx: lensCx, cy: lensCy, r: lensR, magnification: MAG, rimColor: "#1a1a2e", rimWidth: 2 }),
];

// Probe points per scenario (world px = device px at zoom 1 dpr 1).
const probes = {
  shadow: [
    ["inRect", 150, 120],        // widget fill (blue)
    ["shadowBR", 210, 170],      // 10px beyond bottom-right, inside dx/dy 20 offset
    ["cleanTL", 92, 72],         // 8px beyond top-left: shadow must NOT reach here
    ["farBg", 350, 30],          // untouched background
  ],
  bloom: [
    ["bloomRim", 110, 172],      // 12px below the bloomed circle's rim (glow zone)
    ["plainRim", 290, 172],      // same offset on the bloomless twin
  ],
  blend: [
    ["multiplied", 90, 80],
    ["added", 290, 80],
    ["backdrop", 200, 200],
  ],
  lens: [
    // Lens shows q = C + (p − C)/M. The world shadow point (210,170) appears at
    // p = C + (q − C)·M = (230,190) + (−20,−20)·2 = (190, 150).
    ["lensShadow", 190, 150],
    // The world clean point beyond the rect's top-left maps outside the lens —
    // instead check a lens pixel showing clean white bg: q=(240,195) → white;
    // p = (250, 200).
    ["lensClean", 250, 200],
  ],
};

let viteServer, browser;
try {
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: join(REPO_ROOT, "vite.config.js"),
    root: REPO_ROOT,
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  const pageErrors = [];
  // Boot noise ignore-list (the colorfield_probe IGNORE_BOOT precedent): the
  // bare Vite index page 404s a favicon-class resource at load — unrelated to
  // any GPU/effect path. Everything else stays fatal.
  const IGNORE = [/Failed to load resource: the server responded with a status of 404/];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) pageErrors.push(m.text());
  });
  await page.goto(`${pageBase}/index.html`, { waitUntil: "domcontentloaded" });

  const results = await page.evaluate(async (scenarios, w, h, view) => {
    const M = {
      compositor: await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js"),
    };
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const gpu = await M.compositor.GpuCompositor.create(canvas);
    const out = {};
    for (const [name, { ir, points }] of Object.entries(scenarios)) {
      gpu.render(ir, view, { background: [1, 1, 1, 1] });
      const px = await gpu.readPixels(0, 0, w, h);
      out[name] = {};
      for (const [label, x, y] of points) {
        const i = (y * w + x) * 4;
        out[name][label] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      }
    }
    return out;
  }, {
    shadow: { ir: shadowIR, points: probes.shadow },
    bloom: { ir: bloomIR, points: probes.bloom },
    blend: { ir: blendIR, points: probes.blend },
    lens: { ir: lensIR, points: probes.lens },
  }, W, H, VIEW);

  let checks = 0;
  const ok = (name, cond, detail) => {
    assert.ok(cond, `${name}: ${detail}`);
    checks++;
    console.log(`  ok  ${name}`);
  };
  const lum = ([r, g, b]) => (r + g + b) / 3;

  // ── shadow ──
  const s = results.shadow;
  ok("shadow: widget fill intact", s.inRect[2] > 150 && s.inRect[0] < 150, `expected blue-ish fill, got ${s.inRect}`);
  ok("shadow: dark at the +dx/+dy offset", lum(s.shadowBR) < 110, `expected shadow-darkened px at bottom-right offset, got ${s.shadowBR}`);
  ok("shadow: is black-tinted (not colored)", Math.abs(s.shadowBR[0] - s.shadowBR[1]) < 12 && Math.abs(s.shadowBR[1] - s.shadowBR[2]) < 12, `expected neutral gray/black, got ${s.shadowBR}`);
  ok("shadow: does NOT reach the −dx/−dy side", lum(s.cleanTL) > 230, `top-left must stay white, got ${s.cleanTL}`);
  ok("shadow: far background untouched", lum(s.farBg) > 245, `got ${s.farBg}`);

  // ── bloom ──
  const b = results.bloom;
  ok("bloom: additive glow outside the rim", lum(b.bloomRim) > lum(b.plainRim) + 15,
    `bloomed rim-outside ${b.bloomRim} must outshine plain twin ${b.plainRim}`);

  // ── blend math (fixed-function states) ──
  const bl = results.blend;
  const expMul = GREEN.map((c) => Math.round((c * GRAY) / 255));
  const expAdd = GREEN.map((c) => Math.min(255, c + GRAY));
  ok("multiply: out = src·dst", expMul.every((e, i) => Math.abs(bl.multiplied[i] - e) <= 8),
    `expected ~${expMul}, got ${bl.multiplied}`);
  ok("add: out = src+dst (clamped)", expAdd.every((e, i) => Math.abs(bl.added[i] - e) <= 8),
    `expected ~${expAdd}, got ${bl.added}`);
  ok("blend: backdrop untouched elsewhere", Math.abs(bl.backdrop[1] - GREEN[1]) <= 6, `got ${bl.backdrop}`);

  // ── effected widget under a supersampling magnifier ──
  const l = results.lens;
  ok("lens: magnified shadow visible inside the lens", lum(l.lensShadow) < 110,
    `lens px mapping to the shadow region must be dark, got ${l.lensShadow}`);
  ok("lens: clean region inside the lens stays white", lum(l.lensClean) > 230, `got ${l.lensClean}`);

  // ── effect-off IR regression on the committed demo document ──
  {
    const { createRegistry } = await import("../core/registry.js");
    const { allPlugins } = await import("../plugins/index.js");
    const doc = await import("../core/document.js");
    const expr = await import("../core/expressions.js");
    const derive = await import("../core/derive.js");
    const ports = await import("../render_gpu/ports.js");
    const registry = createRegistry();
    for (const p of allPlugins) registry.register(p);
    const demo = JSON.parse(readFileSync(join(HERE, "../examples/demo.powerrp.json"), "utf8"));
    for (let i = 0; i < demo.slides.length; i++) {
      const state = expr.evaluateState(doc.foldState(demo, i, 1), registry).state;
      const ir = ports.sceneIR(derive.deriveRenderTree(state, registry));
      const walk = (cmds) => cmds.every((c) => c.op !== "effectSubtree" && (!Array.isArray(c.content) || walk(c.content)));
      assert.ok(walk(ir), `demo slide ${i} must emit ZERO effectSubtree ops (effects off by default)`);
    }
    checks++;
    console.log("  ok  effect-off demo doc emits zero effect ops (byte-identity gate)");
  }

  // Zero console errors during the effect renders (shader/pipeline health).
  ok("zero page console errors", pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);

  console.log(`\nEFFECTS PROBE: ${checks} checks passed`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
}
