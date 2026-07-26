/**
 * PROOF probe for the HEAVY-MATERIAL proxy stand-in (the slide-thumbnail perf fix
 * for GENERATIVE foreground materials — lens flare + the sky family).
 *
 * Unlike backdrop materials (glass/CRT), these are `materialFill` ops: no
 * below-content re-render, no children — so they allocate ZERO offscreen surfaces
 * on BOTH the full and proxy paths. Their cost is pure per-pixel SkSL raster of a
 * heavy shader (the lens flare is a 21-knob starburst + ghost chain + halo +
 * chromatic + bloom + procedural dirt; the sky is an analytic atmosphere). Because
 * their default size is CAMERA-BOUND (fills the whole frame), a thumbnail runs the
 * full shader over every device pixel — ~1.5s per lens-flare thumbnail on the CPU
 * software surface the minimap/thumbnails use.
 *
 * This probe renders each heavy material at a THUMBNAIL size through paintIR at
 * BOTH quality:"full" and quality:"proxy" and prints the wall time, proving the
 * proxy stand-in (a cheap gradient, no SkSL) is dramatically faster while the full
 * path is untouched. PNGs land in .claude_vlm_checks/ for a VLM check that (a) the
 * proxy reads as a sensible preview and (b) full is unchanged.
 *
 * Run: node render_gpu/tests/skia_material_proxy_probe.js
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { paintIR } from "../skia/paint_skia.js";
import { rect, pushTransform, popTransform, materialFill } from "../ir.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", ".claude_vlm_checks");

// THUMBNAIL sizes (device px; DPR 1 so surface px == local px, the minimap/grid case).
const THUMB = { w: 256, h: 144 };  // the measured 256x144 case
const TINY = { w: 178, h: 100 };   // ~100px case
const TIMING_ITERS = 3;            // the full path is ~1s/render for a lens flare — keep small

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // scenes carry no text

// The full param sets each heavy material's packer requires (mirrors the plugins'
// emit() defaults). The proxy path reads only a few (light pos + tint / sky colours).
const LENS_FLARE_PARAMS = {
  lightX: 0.72, lightY: 0.3, brightness: 1.0,
  ghostCount: 5, ghostSpacing: 0.32, ghostSize: 0.08, ghostIntensity: 0.25,
  anamorphic: 0.38, streakLength: 0.3, streakColor: "#8fb0ff",
  halo: 0.35, haloRadius: 0.45,
  starburst: 0.4, blades: 8, starburstSharp: 24, starburstRotation: 0,
  chromatic: 0.012, bloom: 0.6, dirt: 0.2,
  colorTemp: 5200, tint: "#fff2e6",
};
const SKY_PARAMS = {
  time: 0, horizon: -0.15, turbidity: 3, atmosphere: 1, exposure: 1.1,
  starDensity: 46, milkyWay: 1, timeOfDay: 0.2, moonlight: 0,
  zenith: "#ffffff", ground: "#0d1017", night: "#04060e", galaxyTint: "#46567c",
  suns: [{ sx: 0.3, sy: -0.5, color: "#fff4d6", intensity: 3 }],
};
const SKY_CLOUDS_PARAMS = {
  time: 0, coverage: 0.46, softness: 0.32, cloudScale: 2.4, speed: 1,
  ambient: "#8fa6c8", base: "#eef1f6",
  suns: [{ sx: 0.3, sy: -0.4, color: "#ffddaa", intensity: 1 }],
};
const SKY_SUN_PARAMS = { time: 0, color: "#fff4d6", intensity: 3, size: 0.26, glow: 0.9, glowRadius: 0.18 };
const SKY_MOON_PARAMS = { time: 0, color: "#e8e6de", phase: 0.72, limbAngle: 0, earthshine: 0.5, maria: 0.6, size: 0.74 };
const RAYCAST_DITHER_PARAMS = {
  time: 2, speed: 1, zoom: 0.58, streakAngle: 0.785, elongation: 4.2, softness: 0.17,
  warp: 0.18, grain: 0.09, grainScale: 1, grainSpeed: 18, background: "#050608",
  color0: "#ff5e73", color1: "#eb1f36", color2: "#990d1c", color3: "#ff4257", color4: "#520814",
};
const CORKBOARD_PARAMS = {
  seed: 7, grainScale: 0.2, mottleScale: 0.02, mottleStrength: 0.12, pitStrength: 0.34,
  fleckStrength: 0.24, baseColor: "#be8f56", vignette: 0.2, frameWidth: 20, frameColor: "#5c3a1e", lightAngle: -2.16,
};

/** Query→build. A dark scene backdrop the material composites over (so the proxy reads). */
function backdrop(w, h) {
  return [rect({ x: 0, y: 0, w, h, fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#0a1230" }, { offset: 1, color: "#241a10" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } } } })];
}

/** Query→build. A camera-bound generative material filling the whole `size` frame. */
function heavyScene(material, params, size) {
  const { w, h } = size;
  return [
    ...backdrop(w, h),
    pushTransform({ x: 0, y: 0 }),
    materialFill({ material, cx: w / 2, cy: h / 2, halfW: w / 2, halfH: h / 2, params }),
    popTransform(),
  ];
}

/**
 * Command. Renders `commands` onto a fresh `size` sink at `quality`, counting the
 * offscreen surfaces paintIR allocates and (over TIMING_ITERS) the average wall
 * time. Returns count, avg ms, PNG bytes, readback pixels.
 */
function render(commands, size, quality) {
  const { w: sw, h: sh } = size;
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  let surfaces = 0;
  const makeSurface = (w, h) => { surfaces++; return CanvasKit.MakeSurface(w, h); };
  const once = () => {
    const surface = CanvasKit.MakeSurface(sw, sh); // the SINK — not counted
    if (!surface) throw new Error("probe: MakeSurface(sink) returned null");
    paintIR(CanvasKit, surface.getCanvas(), commands, view, { fontCollection, background: "#05060c", makeSurface, quality });
    surface.flush();
    return surface;
  };
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

/** Pure function. Mean of the max(r,g,b) channel (0..255) over the whole frame — a not-black discriminator. */
function meanLuma(px, sw, sh) {
  let sum = 0;
  const n = sw * sh;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sum += Math.max(px[o], px[o + 1], px[o + 2]);
  }
  return sum / n;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`probe: thumbnail ${THUMB.w}x${THUMB.h} + tiny ${TINY.w}x${TINY.h}, ${TIMING_ITERS} timing iters\n`);

const CASES = [
  ["lens_flare", LENS_FLARE_PARAMS],
  ["sky", SKY_PARAMS],
  ["skyClouds", SKY_CLOUDS_PARAMS],
  ["skySun", SKY_SUN_PARAMS],
  ["skyMoon", SKY_MOON_PARAMS],
  ["raycast_dither", RAYCAST_DITHER_PARAMS],
  ["corkboard", CORKBOARD_PARAMS],
];

const results = [];
for (const [material, params] of CASES) {
  for (const [label, size] of [["256x144", THUMB], ["~100px_", TINY]]) {
    const scene = heavyScene(material, params, size);
    const full = render(scene, size, "full");
    const proxy = render(scene, size, "proxy");
    if (label === "256x144") {
      fs.writeFileSync(path.join(OUT_DIR, `matproxy_${material}_full.png`), Buffer.from(full.png));
      fs.writeFileSync(path.join(OUT_DIR, `matproxy_${material}_proxy.png`), Buffer.from(proxy.png));
    }
    const proxyLuma = meanLuma(proxy.px, proxy.sw, proxy.sh);
    console.log(`── ${material} @ ${label} ────────────────────`);
    console.log(`  offscreen surfaces:  full=${full.surfaces}   proxy=${proxy.surfaces}`);
    console.log(`  avg render time:     full=${full.ms.toFixed(1)}ms  proxy=${proxy.ms.toFixed(1)}ms  (${(full.ms / proxy.ms).toFixed(1)}x faster)`);
    console.log(`  proxy mean luma:     ${proxyLuma.toFixed(1)} (>3 => not black)\n`);
    results.push({ material, label, full: full.ms, proxy: proxy.ms, proxyLuma });
  }
}

// ── asserts (AFTER the fix): proxy is much faster and not black ────────────────
for (const r of results) {
  assert.ok(r.proxy < r.full, `${r.material} @ ${r.label}: proxy must be faster than full`);
  assert.ok(r.proxyLuma > 3, `${r.material} @ ${r.label}: proxy must not be black`);
}
// The headline: the lens flare thumbnail proxy must be a small fraction of full.
const lf = results.find((r) => r.material === "lens_flare" && r.label === "256x144");
assert.ok(lf.proxy < lf.full * 0.5, `lens_flare 256x144 proxy (${lf.proxy.toFixed(1)}ms) must be < half of full (${lf.full.toFixed(1)}ms)`);

console.log("OK skia_material_proxy_probe — heavy generative materials use a cheap proxy stand-in (no SkSL) at thumbnail size");
