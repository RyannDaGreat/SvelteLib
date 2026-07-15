/**
 * FOUR-SIDE PENUMBRA probe (Round 15.5 integration + Round 16.1 regression).
 * Boots the REAL main GPU compositor (analytic shadow now DEFAULT ON) and
 * verifies a drop shadow with a POSITIVE offset (dx=3, dy=3) has a SOFT
 * penumbra on ALL FOUR sides — including the TOP and LEFT leading edges
 * (opposite the offset), which is exactly the 16.1 clip case. Two shapes are
 * probed:
 *   - ELLIPSE (analytic-eligible → the analytic path renders it): proves the
 *     analytic shadow is soft on all four sides by construction (its quad
 *     inflates by blur·3 + |offset| every side; there is no texture to clip).
 *   - a STROKED rect (analytic-INELIGIBLE → falls back to the substrate blur):
 *     proves the fallback path (OpusQ's 16.1 per-side effectSourceRect fix)
 *     is ALSO soft on all four sides — so the two paths agree.
 *
 * A hard fill→background jump on any side with NO grey run = a clipped
 * penumbra (the 16.1 bug) and FAILS.
 *
 * Run (exit-code gated): node src/demo_apps/PowerRP/tests/effects_fourside_probe.js [shot_dir]
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const SHOT_DIR = process.argv[2] || join(HERE, "../.claude_shots/effects_fourside");
mkdirSync(SHOT_DIR, { recursive: true });

const { circlePlugin } = await import("../plugins/circle.js");
const { rectPlugin } = await import("../plugins/rect.js");
const { pushTransform, popTransform, rect } = await import("../render_gpu/ir.js");

function node(plugin, state) {
  const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
  const local = { ...state, x: 0, y: 0 };
  return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
}

const W = 700, H = 450, DPR = 2;
// Positive offset shadow — the 16.1 case (top+left are the leading edges).
const SHADOW = { dx: 3, dy: 3, blur: 18, color: "#000000", opacity: 1 };
const SIZE = { w: 160, h: 120 };

// Scene builders: an analytic-eligible ellipse, and an ineligible STROKED rect.
const ellScene = [
  rect({ x: -100000, y: -100000, w: 200000, h: 200000, fill: "#ffffff" }),
  ...node(circlePlugin, { ...circlePlugin.defaults, x: -SIZE.w / 2, y: -SIZE.h / 2, w: SIZE.w, h: SIZE.h, fill: "#3b6ea5", strokeWidth: 0, shadow: SHADOW }),
];
const strokedRectScene = [
  rect({ x: -100000, y: -100000, w: 200000, h: 200000, fill: "#ffffff" }),
  // A STROKE makes it analytic-INELIGIBLE → exercises the substrate fallback.
  ...node(rectPlugin, { ...rectPlugin.defaults, x: -SIZE.w / 2, y: -SIZE.h / 2, w: SIZE.w, h: SIZE.h, fill: "#3b6ea5", stroke: "#102030", strokeWidth: 4, shadow: SHADOW }),
];

const zoom = 2;
const view = { zoom, panX: W / 2, panY: H / 2, dpr: DPR }; // shape centered at origin → screen center

let browser, viteServer;
try {
  const { createServer } = await import("vite");
  viteServer = await createServer({ configFile: join(REPO_ROOT, "vite.config.js"), root: REPO_ROOT, server: { port: 0, open: false, host: "127.0.0.1" } });
  await viteServer.listen();
  const base = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => { throw e; });
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) pageErrors.push(m.text()); });
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });

  const rendered = await page.evaluate(async (ellIR, strokedIR, v, w, h, dpr) => {
    const M = await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js");
    const dw = w * dpr, dh = h * dpr;
    const canvas = document.createElement("canvas");
    canvas.width = dw; canvas.height = dh;
    const gpu = await M.GpuCompositor.create(canvas);
    // Analytic shadow is DEFAULT ON — confirm the flag exists and is on.
    const analyticDefaultOn = gpu.useAnalyticShadow === true;
    const grab = async (ir) => { gpu.render(ir, v, { background: [1, 1, 1, 1] }); return Array.from(await gpu.readPixels(0, 0, dw, dh)); };
    return { ell: await grab(ellIR), stroked: await grab(strokedIR), dw, dh, analyticDefaultOn };
  }, ellScene, strokedRectScene, view, W, H, DPR);

  const { ell, stroked, dw, dh, analyticDefaultOn } = rendered;
  for (const [name, px] of [["ellipse", ell], ["stroked", stroked]]) {
    const bytes = Buffer.alloc(dw * dh * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { bytes[j] = px[i]; bytes[j + 1] = px[i + 1]; bytes[j + 2] = px[i + 2]; }
    writeFileSync(join(SHOT_DIR, `fourside_${name}.ppm`), Buffer.concat([Buffer.from(`P6\n${dw} ${dh}\n255\n`, "ascii"), bytes]));
  }

  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const at = (px, x, y) => { const i = (clampI(y, 0, dh - 1) * dw + clampI(x, 0, dw - 1)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const lum = ([r, g, b]) => (r + g + b) / 3;
  const FILL_MAX = 175, BG_MIN = 248;

  const cx = Math.round(W / 2 * DPR), cy = Math.round(H / 2 * DPR);
  const halfWpx = SIZE.w / 2 * zoom * DPR, halfHpx = SIZE.h / 2 * zoom * DPR;

  let checks = 0;
  const ok = (n, c, d) => { assert.ok(c, `${n}: ${d}`); checks++; console.log(`  ok  ${n}`); };
  ok("analytic shadow is DEFAULT ON", analyticDefaultOn, "gpu.useAnalyticShadow !== true");

  // For each shape and each of the 4 cardinal directions, scan OUTWARD from the
  // fill edge and require a run of penumbra greys before the background (a soft
  // edge), on EVERY side — including top/left (the 16.1 leading edges).
  const DIRS = [
    { name: "right", dx: 1, dy: 0, edge: () => [cx + halfWpx, cy] },
    { name: "left", dx: -1, dy: 0, edge: () => [cx - halfWpx, cy] },
    { name: "bottom", dx: 0, dy: 1, edge: () => [cx, cy + halfHpx] },
    { name: "top", dx: 0, dy: -1, edge: () => [cx, cy - halfHpx] },
  ];
  const scanLen = Math.ceil((SHADOW.blur * 3 + Math.max(SHADOW.dx, SHADOW.dy)) * zoom * DPR) + 12;
  for (const [shape, px] of [["ellipse(analytic)", ell], ["stroked-rect(fallback)", stroked]]) {
    for (const dir of DIRS) {
      const [ex, ey] = dir.edge();
      const scan = [];
      for (let k = 0; k < scanLen; k++) scan.push(lum(at(px, Math.round(ex + dir.dx * k), Math.round(ey + dir.dy * k))));
      let firstBg = scan.findIndex((L) => L > BG_MIN); if (firstBg < 0) firstBg = scan.length;
      let penStart = 0; while (penStart < firstBg && scan[penStart] < FILL_MAX) penStart++;
      const penWidth = firstBg - penStart;
      const greys = scan.slice(penStart, firstBg);
      const darkest = greys.length ? Math.min(...greys) : 255;
      ok(`${shape} ${dir.name}: soft penumbra (no clip cliff)`, penWidth >= 3, `penumbra only ${penWidth}px on the ${dir.name} side — a hard fill→bg cliff (16.1 clip)`);
      ok(`${shape} ${dir.name}: shadow darkens`, darkest < 240, `no darkening on ${dir.name}, min grey ${darkest}`);
      ok(`${shape} ${dir.name}: no black-blob core`, darkest > 110, `${dir.name} dipped to near-black ${darkest} (clipped blob)`);
    }
  }
  ok("zero page console errors", pageErrors.length === 0, pageErrors.join(" | "));

  console.log(`\nFOUR-SIDE PENUMBRA PROBE: ${checks} checks passed`);
  console.log(`  analytic default ON: ${analyticDefaultOn}; screenshots: ${SHOT_DIR}`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
}
