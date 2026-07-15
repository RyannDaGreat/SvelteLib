/**
 * Shared offscreen WebGPU raster service for PIXEL consumers — slide
 * thumbnails, the minimap, PNG export. The interactive viewport and the
 * presenter own their own swapchain compositors; everything that needs BYTES
 * shares this one device (pipelines are expensive) and reads back via
 * GpuCompositor.readPixels — the reliable path (drawImage from a WebGPU
 * canvas is not dependable post-present; FINDINGS).
 *
 * Command module: owns one lazily-created compositor + canvas; renders are
 * SERIALIZED through a promise queue so concurrent callers can't resize the
 * shared canvas under each other's frames.
 */

import { foldState } from "../core/document.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { fitRectView } from "../core/view.js";
import { sceneIR } from "../render_gpu/ports.js";
import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";
import { GpuCompositor } from "../render_gpu/gpu/compositor.js";

let canvas = null;
let gpuPromise = null;
let queue = Promise.resolve();

function ensure() {
  if (!gpuPromise) {
    canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    gpuPromise = GpuCompositor.create(canvas);
  }
  return gpuPromise;
}

/** Serialized render → fresh 2D canvas with the pixels (the shared core). */
function renderJob(width, height, buildIR) {
  const job = queue.then(async () => {
    const gpu = await ensure();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const { ir, view, background } = buildIR();
    gpu.render(ir, view, { background });
    const px = await gpu.readPixels(0, 0, width, height);
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    out.getContext("2d").putImageData(new ImageData(px, width, height), 0, 0);
    return out;
  });
  // The queue must survive a failed job (callers still see their rejection).
  queue = job.catch(() => {});
  return job;
}

/**
 * Command (async). One document frame THROUGH THE CAMERA at width×height
 * device px → fresh 2D canvas. The camera rect defines the view and its
 * background is the first draw — thumbnail/export semantics.
 *
 * @example // renderCameraFrame(doc, {slideIndex: 0, alpha: 1, registry, width: 256, height: 144}) → Promise<canvas>
 */
export function renderCameraFrame(doc, { slideIndex, alpha = 1, registry, width, height }) {
  return renderJob(width, height, () => {
    const state = evaluateState(foldState(doc, slideIndex, alpha), registry).state;
    const rect = cameraRect(state, doc.meta);
    return {
      view: fitRectView(rect, width, height, 1),
      background: parseColor(rect.background),
      ir: [
        rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: parseColor(rect.background) }),
        ...sceneIR(deriveRenderTree(state, registry)),
      ],
    };
  });
}

/**
 * Command (async). Rasterizes an arbitrary IR command list at an explicit
 * view into PNG bytes — the PDF exporter's raster-region callback (the
 * HYBRID RULE: blur regions embed as images among the vector elements;
 * signature per render_gpu/pdf_backend.js irToPDF `rasterize`).
 *
 * @example // rasterizeIrPng(cmds, {zoom: 2, panX: 0, panY: 0, dpr: 1}, 800, 600, "#ffffff") → Promise<Uint8Array PNG>
 */
export async function rasterizeIrPng(ir, view, width, height, background = null) {
  const bg = background == null ? [0, 0, 0, 0]
    : Array.isArray(background) ? background : parseColor(background);
  const out = await renderJob(width, height, () => ({ ir, view, background: bg }));
  const blob = await new Promise((res) => out.toBlob(res, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Command (async). One document frame at an EXPLICIT view (world mapping) —
 * the minimap's overview semantics. Transparent clear unless `background`
 * (a parsed [r,g,b,a]) is given.
 *
 * @example // renderViewFrame(doc, {slideIndex, registry, width, height, view: {zoom, panX: 0, panY: 0, dpr}}) → Promise<canvas>
 */
export function renderViewFrame(doc, { slideIndex, alpha = 1, registry, width, height, view, background = [0, 0, 0, 0] }) {
  return renderJob(width, height, () => {
    const state = evaluateState(foldState(doc, slideIndex, alpha), registry).state;
    const rect = cameraRect(state, doc.meta);
    return {
      view,
      background,
      ir: [
        rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: parseColor(rect.background) }),
        ...sceneIR(deriveRenderTree(state, registry)),
      ],
    };
  });
}
