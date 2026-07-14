/**
 * Video external-texture proof: a `video` IR command rendered by the WebGPU
 * compositor via device.importExternalTexture — the zero-copy video path
 * (no per-frame CPU readback, no drawImage).
 *
 * The <video> plays a MediaStream captured from a procedurally animated
 * canvas (no video asset needed, works offline/headless), which exercises the
 * exact same HTMLVideoElement → GPUExternalTexture import as a file-backed
 * video. A magnifier lens sits on top of the video to prove effect passes
 * compose over external-texture content.
 *
 * Headless hook: window.__video_test() → {ok, movingPixels, samples} — reads
 * back two frames 300ms apart and checks the video region actually shows
 * moving, non-background content.
 */

import { GpuCompositor } from "../gpu/compositor.js";
import { rect, text, video, pushTransform, popTransform, magnifyBackdrop } from "../ir.js";
import { fitRectView } from "../../render/compositor.js";

const WORLD_W = 1600, WORLD_H = 900;
const VIDEO_W = 640, VIDEO_H = 360; // source stream resolution
const hud = document.getElementById("hud");
const canvas = document.getElementById("canvas");
window.__video_error = null;

/** Command. Builds a <video> playing a procedurally-animated canvas stream. */
async function makeTestVideo() {
  const src = document.createElement("canvas");
  src.width = VIDEO_W;
  src.height = VIDEO_H;
  const ctx = src.getContext("2d");
  const draw = (t) => {
    const hue = (t * 60) % 360;
    ctx.fillStyle = `hsl(${hue}, 70%, 45%)`;
    ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    ctx.fillStyle = "#ffffff";
    const R = 40;
    const x = VIDEO_W / 2 + Math.cos(t * 2) * (VIDEO_W / 2 - R);
    const y = VIDEO_H / 2 + Math.sin(t * 3) * (VIDEO_H / 2 - R);
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 48px system-ui";
    ctx.fillText(`t=${t.toFixed(1)}s`, 24, 64);
  };
  draw(0);
  const start = performance.now();
  setInterval(() => draw((performance.now() - start) / 1000), 1000 / 30); // 30fps source
  const STREAM_FPS = 30;
  const videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.srcObject = src.captureStream(STREAM_FPS);
  await videoEl.play();
  return videoEl;
}

function sceneIRForVideo(t) {
  const vx = (WORLD_W - 960) / 2, vy = 120; // 960×540 video panel centered
  return [
    text({ text: "video → importExternalTexture → textured quad", x: 30, y: 24, size: 36, color: "#e6e6f0", bold: true }),
    rect({ x: vx - 12, y: vy - 12, w: 960 + 24, h: 540 + 24, cornerRadius: 16, fill: "#0f0f1c" }),
    pushTransform({ x: vx, y: vy, rotation: Math.sin(t * 0.7) * 0.05, scale: 1 }),
    video({ ref: "clip", x: 0, y: 0, w: 960, h: 540 }),
    popTransform(),
    pushTransform({ x: WORLD_W / 2 + Math.cos(t * 0.5) * 250, y: vy + 270 + Math.sin(t * 0.8) * 120 }),
    magnifyBackdrop({ cx: 0, cy: 0, r: 110, magnification: 2, rimColor: "#e6e6f0", rimWidth: 4 }),
    popTransform(),
  ];
}

async function main() {
  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const videoEl = await makeTestVideo();
  const comp = await GpuCompositor.create(canvas, { media: { clip: videoEl } });

  const start = performance.now();
  const loop = () => {
    const t = (performance.now() - start) / 1000;
    const view = fitRectView({ x: 0, y: 0, w: WORLD_W, h: WORLD_H }, canvas.clientWidth, canvas.clientHeight, dpr);
    comp.render(sceneIRForVideo(t), view, { background: [0.1, 0.1, 0.18, 1] });
    hud.textContent = `external texture: ${videoEl.readyState >= 2 ? "LIVE" : "waiting"}  t=${t.toFixed(1)}s`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  /** Reads the rendered scene texture at the video panel center (GPU readback). */
  const readCenter = async () => {
    const view = fitRectView({ x: 0, y: 0, w: WORLD_W, h: WORLD_H }, canvas.clientWidth, canvas.clientHeight, dpr);
    const cx = Math.round((WORLD_W / 2) * view.zoom * dpr + view.panX * dpr);
    const cy = Math.round(390 * view.zoom * dpr + view.panY * dpr); // video panel vertical center
    return [...(await comp.readPixels(cx, cy, 1, 1))];
  };

  window.__video_test = async () => {
    const WAIT_FIRST_MS = 500, WAIT_BETWEEN_MS = 300;
    await new Promise((r) => setTimeout(r, WAIT_FIRST_MS));
    const a = await readCenter();
    await new Promise((r) => setTimeout(r, WAIT_BETWEEN_MS));
    const b = await readCenter();
    const bgDark = (px) => px[0] < 40 && px[1] < 40 && px[2] < 60; // page background is #1a1a2e-ish
    const movingPixels = a.some((v, i) => Math.abs(v - b[i]) > 8);
    return { ok: !bgDark(a) && movingPixels, movingPixels, samples: [a, b], readyState: videoEl.readyState };
  };
  window.__video_ready = true;
}

main().catch((e) => {
  window.__video_error = String(e?.stack ?? e);
  hud.textContent = `FATAL: ${e}`;
  throw e;
});
