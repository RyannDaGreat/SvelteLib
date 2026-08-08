/**
 * PROOF probe for the PROXY render quality (the slide-thumbnail perf fix).
 *
 * Renders a GLASS-over-colorfield scene and a CRT-MATERIAL-over-colorfield scene
 * through paintIR at BOTH quality:"full" and quality:"proxy", using a COUNTING
 * makeSurface so every offscreen surface paintIR allocates is tallied (the main
 * sink surface is made directly, so it is NOT counted). It proves:
 *
 *   1. Backdrop machinery — the proxy path allocates ZERO offscreen surfaces (no
 *      composite-so-far offscreen, no below-content re-render, no full-screen blur
 *      surface, no SkSL), while the full path allocates several. Timing confirms
 *      the proxy render is dramatically cheaper.
 *   2. Not a hole — the proxy glass region has high pixel variance (the backdrop
 *      colorfield shows THROUGH the frost), i.e. a sensible ~100px preview.
 *
 * PNGs land in .claude_vlm_checks/ (proxy vs full, side by side) for a VLM check.
 *
 * Run: node render_gpu/tests/skia_proxy_probe.js
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { paintIR } from "../skia/paint_skia.js";
import { rect, ellipse, pushTransform, popTransform, glassBackdrop, materialBackdrop } from "../ir.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude_vlm_checks");

const W = 480, H = 300, DPR = 2;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: DPR };
const TIMING_ITERS = 3; // renders per quality for a stable-ish average (the full path is seconds-per-render, so keep this small)
// The CRT material's uniform knobs (materialBackdrop `params`); the full path's
// packer requires ALL of them. This probe bypasses the plugin's emit(), so
// maskType is the NUMERIC shader code (0 = aperture grille), not the menu string.
// The proxy path ignores these entirely (cheap frost stand-in).
const CRT_PARAMS = {
  sourceTVL: 300, gammaIn: 2.4, gammaOut: 2.2,
  scanlineStrength: 0.4, scanlineCount: 240, brightBoost: 1.25, beamBloom: 0.4,
  maskType: 0, maskStrength: 0.35, maskPitch: 3,
  halation: 0.12, diffusion: 0.15,
  curvature: 0.08, convergence: 0.02, vignette: 0.35, bezel: 0.05,
  monochrome: 0, whiteBalance: 0, phosphorTint: "#ffffff",
};

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
// These scenes carry NO text, so an empty FontCollection satisfies paintIR's
// (required, truthy) fontCollection without needing the font files.
const fontCollection = CanvasKit.FontCollection.Make();

/** Query→build. A colorful gradient + scattered saturated dots (so a frost over it has real variance to show). */
function colorfield() {
  const cmds = [rect({ x: 0, y: 0, w: W, h: H, fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#141852" }, { offset: 0.55, color: "#962882" }, { offset: 1, color: "#f09628" }], from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } } })];
  const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff", "#b4ff78"];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) cmds.push(ellipse({ cx: rnd() * W, cy: rnd() * H, rx: 8 + rnd() * 24, ry: 8 + rnd() * 24, fill: cols[i % cols.length] + "d8" }));
  return cmds;
}

const glassScene = [
  ...colorfield(),
  pushTransform({ x: 0, y: 0 }),
  glassBackdrop({ cx: W / 2, cy: H / 2, halfW: W * 0.3, halfH: H * 0.22, cornerRadius: 28, tint: "rgba(255,255,255,0.16)", stroke: "#ffffff", strokeWidth: 2, blurRadius: 9, refractionStrength: 16 }),
  popTransform(),
];
const crtScene = [
  ...colorfield(),
  pushTransform({ x: 0, y: 0 }),
  materialBackdrop({ material: "crt", cx: W / 2, cy: H / 2, halfW: W * 0.3, halfH: H * 0.22, cornerRadius: 24, blurRadius: 6, stroke: "#8fffcf", strokeWidth: 2, params: CRT_PARAMS }),
  popTransform(),
];

/**
 * Command. Renders `commands` at `quality`, counting the offscreen surfaces
 * paintIR allocates and (over TIMING_ITERS) the average wall time. Returns the
 * count, avg ms, the PNG bytes, and the readback pixels (device W·DPR × H·DPR).
 */
function render(commands, quality) {
  const sw = W * DPR, sh = H * DPR;
  let surfaces = 0;
  const makeSurface = (w, h) => { surfaces++; return CanvasKit.MakeSurface(w, h); };
  const once = () => {
    const surface = CanvasKit.MakeSurface(sw, sh); // the SINK — made directly, so NOT counted
    if (!surface) throw new Error("probe: MakeSurface(sink) returned null");
    paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, { fontCollection, background: "#0b0f18", makeSurface, quality });
    surface.flush();
    return surface;
  };
  // Count once (makeSurface tally), then time a loop of fresh renders.
  const counted = once();
  const img = counted.makeImageSnapshot();
  const png = img.encodeToBytes();
  const px = img.readPixels(0, 0, { width: sw, height: sh, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  counted.dispose();
  const t0 = performance.now();
  for (let i = 0; i < TIMING_ITERS; i++) once().dispose();
  const ms = (performance.now() - t0) / TIMING_ITERS;
  return { surfaces, ms, png, px, sw, sh };
}

/** Pure function. Stddev of the RED channel (0..255) over the device-px box, a hole-vs-content discriminator. */
function redStddev(px, sw, x0, y0, x1, y1) {
  let n = 0, sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const r = px[(y * sw + x) * 4];
    sum += r; sum2 += r * r; n++;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`probe: ${W}x${H} @dpr${DPR} (${W * DPR}x${H * DPR} device px), ${TIMING_ITERS} timing iters\n`);

for (const [name, scene] of [["glass", glassScene], ["crt", crtScene]]) {
  const full = render(scene, "full");
  const proxy = render(scene, "proxy");
  fs.writeFileSync(path.join(OUT_DIR, `skia_proxy_${name}_full.png`), Buffer.from(full.png));
  fs.writeFileSync(path.join(OUT_DIR, `skia_proxy_${name}_proxy.png`), Buffer.from(proxy.png));

  // Panel device AABB (center 40% box, comfortably inside the panel) — variance here proves the backdrop shows through.
  const cx = (W / 2) * DPR, cy = (H / 2) * DPR;
  const hx = W * 0.3 * DPR * 0.5, hy = H * 0.22 * DPR * 0.5;
  const [x0, y0, x1, y1] = [Math.round(cx - hx), Math.round(cy - hy), Math.round(cx + hx), Math.round(cy + hy)];
  const proxyVar = redStddev(proxy.px, proxy.sw, x0, y0, x1, y1);

  console.log(`── ${name} ────────────────────────────────`);
  console.log(`  offscreen surfaces:  full=${full.surfaces}   proxy=${proxy.surfaces}`);
  console.log(`  avg render time:     full=${full.ms.toFixed(2)}ms  proxy=${proxy.ms.toFixed(2)}ms  (${(full.ms / proxy.ms).toFixed(1)}x faster)`);
  console.log(`  proxy panel red-stddev: ${proxyVar.toFixed(1)} (>10 ⇒ backdrop shows through, not a hole)\n`);

  assert.equal(proxy.surfaces, 0, `${name}: proxy must allocate ZERO offscreen surfaces (no backdrop machinery)`);
  assert.ok(full.surfaces > 0, `${name}: full must allocate offscreen surfaces (the backdrop machinery)`);
  assert.ok(proxy.ms < full.ms, `${name}: proxy must be faster than full`);
  assert.ok(proxyVar > 10, `${name}: proxy panel must show the backdrop through the frost (not a hole)`);
  assert.ok(proxy.png.length > 2000, `${name}: proxy PNG must be non-trivial`);
}

// NO DITHER SECTION HERE ANY MORE. This probe used to assert that an active
// camera dither allocated an RGBA16F intermediate and that the proxy path
// allocated none. Both halves are gone with the camera dither itself (user ruling,
// 2026-08-07): the paint-level dither that replaced it allocates NO offscreen at
// all — it rides the gradient shader's own write to the destination surface — so
// there is no longer any allocation for a proxy path to skip. Re-adding a count
// here would assert about a surface nothing creates.

console.log("OK skia_proxy_probe — proxy runs NO backdrop machinery and is not a hole");
