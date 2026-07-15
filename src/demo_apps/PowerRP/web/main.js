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
import { deserialize, foldState, repairedDocument, printRepairReports } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { parseColor } from "../render_gpu/ir.js";
import { GpuCompositor } from "../render_gpu/gpu/compositor.js";
import { cameraFrameIR } from "./cameraFrame.js";

/**
 * Headless render hook for cli/render.js (puppeteer awaits the promise):
 * renders one frame of a document at (slide, alpha) to width×height and
 * returns a PNG data URL. WebGPU is THE raster renderer (manifest "RENDER
 * MODES DECISION"); readback goes through GpuCompositor.readPixels — the
 * reliable path (FINDINGS: drawImage from a WebGPU canvas is not dependable
 * post-present).
 */
window.__powerrp_render = async function (docJson, { slide = 0, alpha = 1, width = 1280, height = 720 } = {}) {
  await fontsLoaded; // committed fonts must be loaded before the atlas rasterizes text (CLI path too)
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // EXACTLY the editor's load-boundary repair — the SAME repairedDocument the
  // app's repaired() runs (orphans→renames→fps-strip→fill→duration→camera→
  // bindings), so the CLI and editor can never drift. The cruft audit caught
  // this pair drifting: the CLI used to MISS the meta.fps strip. Reports are
  // console.errored (silent repairs are forbidden).
  const raw = typeof docJson === "string" ? deserialize(docJson) : docJson;
  const { doc, reports } = repairedDocument(raw, registry);
  printRepairReports(reports);
  // The one pipeline: fold → EVALUATE (equations become numbers) → derive → emit.
  const state = evaluateState(foldState(doc, slide, alpha), registry).state;
  // The view is THE CAMERA's bbox at this (slide, alpha); its background
  // clears the frame, letterbox edges included.
  const rect = cameraRect(state, doc.meta);
  const view = fitRectView(rect, width, height, 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gpu = await GpuCompositor.create(canvas);
  // The SAME camera-frame IR the pixel service builds (cameraFrameIR: bg rect +
  // scene) — so the CLI and the editor's thumbnails/export emit byte-identical
  // frames. The bg rect is redundant with the clear here (fitRectView fills the
  // canvas), so pixels are unchanged; parseColor returns render()'s float space.
  gpu.render(cameraFrameIR(state, doc.meta, registry), view, { background: parseColor(rect.background) });
  const px = await gpu.readPixels(0, 0, width, height);
  // Encode via a plain 2D canvas fed the GPU pixels — an encode surface for
  // toDataURL, not a render mode.
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d").putImageData(new ImageData(px, width, height), 0, 0);
  return out.toDataURL("image/png");
};

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
