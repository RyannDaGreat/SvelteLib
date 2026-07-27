/**
 * Shared WebGPU device for the Video V7 overlay — ONE GPUDevice + pipeline +
 * sampler for ALL per-widget video canvases.
 *
 * WHY ONE SHARED DEVICE (the engineering choice the brief asks to justify): a
 * GPUDevice + render pipeline + shader module + sampler are heavyweight, and
 * every V7 canvas draws the identical program (a fullscreen quad sampling an
 * external video texture). Creating them once and reusing across N canvases
 * avoids N device inits and N pipeline compiles. A GPUCanvasContext is
 * necessarily per-canvas (it binds to one canvas), and the external texture +
 * bind group are per-FRAME per-canvas because an imported external texture
 * EXPIRES at the end of the task it was imported in — so those are the only
 * per-canvas/per-frame allocations. This mirrors a normal single-device app.
 *
 * SECURE-CONTEXT GATE (PowerRP is HTTPS-independent): WebGPU requires a secure
 * context, so on plain HTTP `navigator.gpu` is absent. Callers MUST check
 * webgpuAvailable() and fall back (the overlay uses a 2D drawImage path). This
 * module NEVER silently no-ops: acquireVideoV7Gpu() rejects loudly if device
 * creation fails, and the caller logs it.
 */

/** Fullscreen quad = 2 triangles = 6 vertices. */
const QUAD_VERTEX_COUNT = 6;
/** Transparent clear so canvas edges outside the video stay see-through. */
const TRANSPARENT_CLEAR = { r: 0, g: 0, b: 0, a: 0 };

/** WGSL: emit a fullscreen quad, sample the external video texture with
 * textureSampleBaseClampToEdge (REQUIRED for texture_external — plain
 * textureSample is a compile error for external textures). Alpha forced to 1;
 * per-widget opacity is applied in CSS on the canvas element, not here. */
const VIDEO_V7_WGSL = /* wgsl */ `
  @group(0) @binding(0) var samp: sampler;
  @group(0) @binding(1) var tex: texture_external;
  struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
  @vertex fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
    var corners = array<vec2f, 6>(
      vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
      vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1)
    );
    var out: VertexOut;
    let q = corners[i];
    out.pos = vec4f(q, 0, 1);
    // Flip V so the texture's top row maps to the top of the canvas.
    out.uv = vec2f((q.x + 1) * 0.5, (1 - q.y) * 0.5);
    return out;
  }
  @fragment fn fs(in: VertexOut) -> @location(0) vec4f {
    return vec4f(textureSampleBaseClampToEdge(tex, samp, in.uv).rgb, 1.0);
  }`;

let bundlePromise = null; // memoized shared-device bundle (created once)

/**
 * Query. Whether WebGPU is usable in this context (secure context with a GPU).
 * Returns false on plain HTTP or any browser lacking WebGPU — the signal the
 * overlay uses to pick the 2D fallback.
 *
 * @returns {boolean}
 * @example webgpuAvailable() // false (on a plain-HTTP origin)
 */
export function webgpuAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * Command (creates + caches GPU objects). Resolves the shared V7 GPU bundle:
 * { device, format, pipeline, sampler, bindGroupLayout }. Memoized — every
 * caller shares the one device. Rejects LOUDLY if WebGPU is unavailable or the
 * adapter/device request fails (never a silent null); the overlay catches, logs
 * via console.error, and uses the 2D fallback.
 *
 * @returns {Promise<{device:GPUDevice,format:string,pipeline:GPURenderPipeline,sampler:GPUSampler,bindGroupLayout:GPUBindGroupLayout}>}
 */
export function acquireVideoV7Gpu() {
  if (!bundlePromise) bundlePromise = buildBundle();
  return bundlePromise;
}

/** Command. Builds the shared device/pipeline/sampler once. */
async function buildBundle() {
  if (!webgpuAvailable()) throw new Error("VideoV7: navigator.gpu unavailable (needs a secure context)");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("VideoV7: no WebGPU adapter");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: VIDEO_V7_WGSL });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  return { device, format, pipeline, sampler, bindGroupLayout };
}

/**
 * Command. Configures a canvas's WebGPU context with the shared device and
 * returns the GPUCanvasContext. `premultiplied` alpha so a transparent clear
 * composites correctly over the Skia scene beneath.
 *
 * @param {object} gpu the bundle from acquireVideoV7Gpu()
 * @param {HTMLCanvasElement} canvas the per-widget canvas
 * @returns {GPUCanvasContext}
 */
export function configureV7Canvas(gpu, canvas) {
  const ctx = canvas.getContext("webgpu");
  if (!ctx) throw new Error("VideoV7: canvas.getContext('webgpu') returned null");
  ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: "premultiplied" });
  return ctx;
}

/**
 * Command (zero-copy per-frame draw). Imports the video's CURRENT frame as an
 * external texture (re-imported every call because it expires per task) and
 * draws it as a fullscreen quad into the canvas context. Draws NOTHING and
 * returns false if the video has no decoded frame yet (readyState < 2) — no
 * placeholder, no error.
 *
 * @param {object} gpu the bundle from acquireVideoV7Gpu()
 * @param {GPUCanvasContext} ctx the canvas's configured context
 * @param {HTMLVideoElement} video the source element
 * @returns {boolean} whether a frame was drawn
 */
export function drawV7External(gpu, ctx, video) {
  const HAVE_CURRENT_DATA = 2; // HTMLMediaElement.HAVE_CURRENT_DATA
  if (video.readyState < HAVE_CURRENT_DATA) return false;
  const external = gpu.device.importExternalTexture({ source: video });
  const bindGroup = gpu.device.createBindGroup({
    layout: gpu.bindGroupLayout,
    entries: [
      { binding: 0, resource: gpu.sampler },
      { binding: 1, resource: external },
    ],
  });
  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: TRANSPARENT_CLEAR }],
  });
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(QUAD_VERTEX_COUNT);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
  return true;
}
