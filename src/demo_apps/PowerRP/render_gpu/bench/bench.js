/**
 * Benchmark page driver: renders scene.js's IR every rAF through EITHER the
 * WebGPU compositor or the canvas2D reference interpreter, and measures real
 * frame rate at devicePixelRatio.
 *
 * URL params:
 *   mode=webgpu|canvas2d   renderer (default webgpu)
 *   n=<int>                square count (default 2000)
 *   fx=0                   disable blur+magnifier effects
 *
 * Headless hook: window.__bench_run(seconds) → Promise<stats>. Frame stats
 * are measured from rAF timestamps; run Chrome with
 * --disable-frame-rate-limit --disable-gpu-vsync to uncap beyond the display
 * refresh (otherwise fps saturates at vsync — still a valid "holds N Hz?"
 * answer). Fatal init/render errors surface on window.__bench_error AND the
 * HUD — nothing is swallowed.
 */

import { GpuCompositor } from "../gpu/compositor.js";
import { paintIR } from "./ir_canvas2d.js";
import { benchScene, WORLD_W, WORLD_H } from "./scene.js";
import { fitRectView } from "../../render/compositor.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "webgpu";
const n = +(params.get("n") ?? 2000);
const effects = params.get("fx") !== "0";

const canvas = document.getElementById("canvas");
const hud = document.getElementById("hud");
const dpr = window.devicePixelRatio;

const frameDurations = []; // seconds; rolling for the HUD, uncapped while measuring
let measuring = false;
let lastStamp = null;
window.__bench_error = null;

/**
 * Pure function. Percentile of a sorted array (nearest-rank).
 *
 * @example percentileSorted([1, 2, 3, 4], 0.5) // 2
 * @example percentileSorted([5], 0.95) // 5
 */
export function percentileSorted(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Pure function. Summarizes frame durations (seconds) into benchmark stats.
 * @example summarize([0.01, 0.01, 0.01, 0.01]).fps // 100
 */
export function summarize(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((s, d) => s + d, 0);
  const MS = 1000;
  return {
    frames: durations.length,
    fps: +(durations.length / total).toFixed(1),
    p50_ms: +(percentileSorted(sorted, 0.5) * MS).toFixed(2),
    p95_ms: +(percentileSorted(sorted, 0.95) * MS).toFixed(2),
    worst_ms: +(sorted[sorted.length - 1] * MS).toFixed(2),
  };
}

function resize() {
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

async function main() {
  resize();
  window.addEventListener("resize", () => { resize(); });

  // Split timing: IR emission (CPU, renderer-independent) vs rasterization —
  // at high N the display-list build itself becomes measurable, and the split
  // tells us WHERE the next optimization lives.
  let buildMsSum = 0, renderMsSum = 0, timedFrames = 0;
  let renderFrame;
  const timed = (raster) => (t, view) => {
    const t0 = performance.now();
    const ir = benchScene(t, { n, effects });
    const t1 = performance.now();
    raster(ir, view);
    buildMsSum += t1 - t0;
    renderMsSum += performance.now() - t1;
    timedFrames++;
  };
  if (mode === "webgpu") {
    const comp = await GpuCompositor.create(canvas);
    renderFrame = timed((ir, view) => comp.render(ir, view, { background: [1, 1, 1, 1] }));
  } else if (mode === "canvas2d") {
    const ctx = canvas.getContext("2d");
    renderFrame = timed((ir, view) => paintIR(ctx, ir, view, { background: "#ffffff" }));
  } else {
    throw new Error(`unknown mode "${mode}" (webgpu|canvas2d)`);
  }

  const start = performance.now();
  let hudStamp = 0;
  const loop = (stamp) => {
    const view = fitRectView({ x: 0, y: 0, w: WORLD_W, h: WORLD_H }, canvas.clientWidth, canvas.clientHeight, dpr);
    renderFrame((stamp - start) / 1000, view);
    if (lastStamp !== null) {
      frameDurations.push((stamp - lastStamp) / 1000);
      const ROLLING = 240; // keep a few seconds of history for the HUD
      if (!measuring && frameDurations.length > ROLLING) frameDurations.shift();
    }
    lastStamp = stamp;
    const HUD_INTERVAL_MS = 250;
    if (stamp - hudStamp > HUD_INTERVAL_MS && frameDurations.length > 10) {
      hudStamp = stamp;
      const s = summarize(frameDurations);
      hud.innerHTML = `<b>${mode}</b>  n=${n}  fx=${effects ? "on" : "off"}  dpr=${dpr}\n` +
        `${canvas.width}×${canvas.height} device px\n` +
        `<b>${s.fps} fps</b>  p50 ${s.p50_ms} ms  p95 ${s.p95_ms} ms\n` +
        `<a href="?mode=${mode === "webgpu" ? "canvas2d" : "webgpu"}&n=${n}${effects ? "" : "&fx=0"}">switch renderer</a>`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  /** Headless measurement: settle, then collect for `seconds`. */
  window.__bench_run = async (seconds = 4) => {
    const SETTLE_MS = 750; // let JIT/pipelines/atlas warm up before measuring
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    measuring = true;
    frameDurations.length = 0;
    buildMsSum = renderMsSum = timedFrames = 0;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    measuring = false;
    if (frameDurations.length === 0) throw new Error("no frames rendered during measurement window");
    return {
      mode, n, effects, dpr, deviceW: canvas.width, deviceH: canvas.height,
      build_ms: +(buildMsSum / timedFrames).toFixed(2),   // IR emission (CPU)
      raster_ms: +(renderMsSum / timedFrames).toFixed(2), // renderer submit (JS side)
      ...summarize(frameDurations),
    };
  };
  window.__bench_ready = true;
}

main().catch((e) => {
  window.__bench_error = String(e?.stack ?? e);
  hud.textContent = `FATAL: ${e}`;
  throw e;
});
