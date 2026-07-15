import "../../../styles/theme.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { deserialize, foldState, withCameraEnsured, withOrphanedItemsDropped } from "../core/document.js";
import { cameraRect, deriveRenderTree } from "../core/derive.js";
import { evaluateState, withBindingsMigrated } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../render/compositor.js";
import { sceneIR } from "../render_gpu/ports.js";
import { parseColor } from "../render_gpu/ir.js";
import { GpuCompositor } from "../render_gpu/gpu/compositor.js";

/**
 * Headless render hook for cli/render.js (puppeteer awaits the promise):
 * renders one frame of a document at (slide, alpha) to width×height and
 * returns a PNG data URL. WebGPU is THE raster renderer (manifest "RENDER
 * MODES DECISION"); readback goes through GpuCompositor.readPixels — the
 * reliable path (FINDINGS: drawImage from a WebGPU canvas is not dependable
 * post-present).
 */
window.__powerrp_render = async function (docJson, { slide = 0, alpha = 1, width = 1280, height = 720 } = {}) {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // Same load-time migrations as the editor: drop orphaned items LOUDLY,
  // inject THE camera, convert legacy {item, anchor} bindings to equations.
  const raw = typeof docJson === "string" ? deserialize(docJson) : docJson;
  const { doc: repairedDoc, dropped } = withOrphanedItemsDropped(raw, new Set(registry.all().map((p) => p.type)));
  for (const { id, reason } of dropped) console.error(`PowerRP repair: dropped item "${id}" — ${reason}`);
  const doc = withBindingsMigrated(withCameraEnsured(repairedDoc));
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
  // parseColor returns normalized [r,g,b,a] floats — exactly render()'s space.
  gpu.render(sceneIR(deriveRenderTree(state, registry)), view, { background: parseColor(rect.background) });
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
  mount(App, { target: document.getElementById("app") });
}
