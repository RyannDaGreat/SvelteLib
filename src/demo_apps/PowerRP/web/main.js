import "../../../styles/theme.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { loadFonts } from "./fontLoader.js";

// Load the committed font FILES (../fonts/) into the browser BEFORE any text
// rasterizes — the WebGPU glyph atlas draws through canvas2D, which silently
// substitutes any font that isn't loaded yet (manifest "Text fonts", offline
// rule). Kicked at module load so BOTH the editor mount and the CLI render hook
// share one memoized promise; each awaits it before its first frame.
const fontsLoaded = loadFonts();
import { deserialize, repairedDocument, printRepairReports } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { parseColor } from "../render_gpu/ir.js";
import { rasterizeIrPng } from "./gpuService.js";
import { cameraFrameIR, evaluatedStateAt } from "./cameraFrame.js";
import { videoUploadCount, videoPlaybackState } from "../render_gpu/gpu/video_registry.js";
import { videoV5UploadCount, videoV5State } from "../render_gpu/skia/video_v5.js";

// Dev/test seams (like __powerrp_render / __powerrp_app): the running total of
// <video>→GPU-texture uploads (probe confirms the frame-advance gate keeps uploads
// at ~video-rate, not paint-rate), and a per-src playback snapshot (probe confirms
// off-view players PAUSE and RESUME from their prior currentTime). Zero prod effect.
window.__powerrp_videoUploadCount = videoUploadCount;
window.__powerrp_videoState = videoPlaybackState;
// V5 off-main-thread video diagnostics (its own registry): ImageBitmap→texture
// upload count (the seq gate keeps it at ~video-rate) and a per-src snapshot
// ({status, mode, paused, currentTime, seq, hasBitmap}) — a probe asserts motion
// (seq advances), off-view PAUSE/RESUME, and the active pipeline mode. Zero prod effect.
window.__powerrp_videoV5UploadCount = videoV5UploadCount;
window.__powerrp_videoV5State = videoV5State;

/**
 * Browser render hook (a few in-browser pixel-parity probes await it via
 * puppeteer): renders one frame of a document at (slide, alpha) to width×height
 * and returns a PNG data URL — now through the Skia OFFSCREEN rasterizer
 * (gpuService.rasterizeIrPng), so it is WebGPU-free like the rest of the app.
 * The headless CLI no longer uses this hook (cli/render.js renders in Node via
 * canvaskit); it remains only for in-browser probe parity.
 */
window.__powerrp_render = async function (docJson, { slide = 0, alpha = 1, width = 1280, height = 720 } = {}) {
  await fontsLoaded;
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // EXACTLY the editor's load-boundary repair — the SAME repairedDocument the
  // app runs — so probe and editor can never drift (silent repairs forbidden).
  const raw = typeof docJson === "string" ? deserialize(docJson) : docJson;
  const { doc, reports } = repairedDocument(raw, registry);
  printRepairReports(reports);
  // fold → EVALUATE → derive → emit the SAME camera-frame IR the pixel service
  // and editor thumbnails build, then rasterize it through Skia offscreen.
  const state = evaluatedStateAt(doc, slide, alpha, registry);
  const rect = cameraRect(state, doc.meta);
  const view = fitRectView(rect, width, height, 1);
  const png = await rasterizeIrPng(cameraFrameIR(state, doc.meta, registry), view, width, height, parseColor(rect.background));
  return pngBytesToDataUrl(png);
};

/** Pure function. PNG bytes → a data: URL (chunked base64 so large frames don't blow the call stack). */
function pngBytesToDataUrl(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return "data:image/png;base64," + btoa(bin);
}

// `?cli=1` skips mounting the editor UI — the page then exists only to host
// __powerrp_render for the CLI (faster, and headless-safe).
if (!new URLSearchParams(location.search).has("cli")) {
  // AWAIT fonts before the first mount so the editor's opening GPU frame never
  // rasterizes text in a not-yet-loaded face (canvas2D would substitute with no
  // repaint to fix it — there is no font-load repaint nudge on the canvas path,
  // unlike images). Local files load in ~tens of ms; the GPU's ~1s Metal warmup
  // dwarfs it, so this adds no perceptible boot delay while making correctness
  // deterministic rather than timing-dependent. (A font that FAILS to load is
  // reported loudly inside loadFonts and still lets the mount proceed.)
  fontsLoaded.then(() => mount(App, { target: document.getElementById("app") }));
}
