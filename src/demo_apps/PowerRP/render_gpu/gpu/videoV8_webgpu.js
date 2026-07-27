/**
 * V8 video overlay — WebGPU backend (the zero-copy path, secure-context only).
 *
 * This is the "played videos perfectly" technique the boss remembered: each
 * frame, import the PLAYING `<video>` element's CURRENT frame as a
 * `GPUExternalTexture` and sample it in a textured quad — NO copy, NO
 * texImage2D, NO CPU readback. A GPUExternalTexture EXPIRES at the end of the
 * task it was imported in, so it is re-imported (and its bind group rebuilt)
 * EVERY draw. External textures use the SPECIAL sampler function
 * `textureSampleBaseClampToEdge`, not `textureSample`.
 *
 * SECURE-CONTEXT GATE: `navigator.gpu` exists only in a secure context, so the
 * selector (videoV8_backend.js) only reaches this backend when an adapter+device
 * actually resolve; on plain HTTP the WebGL2 backend runs instead. This module
 * NEVER silently degrades — if device creation fails it throws and the selector
 * falls back (a reported decision, not a swallowed error).
 *
 * PREMULTIPLIED ALPHA: the context is configured alphaMode "premultiplied" so the
 * transparent areas show the Skia scene beneath and per-widget opacity composites
 * correctly. The fragment shader returns (rgb*opacity, opacity) — premultiplied.
 *
 * ORIENTATION: external-texture UV origin is the video's top-left, and the quad
 * UVs are (localX/w, localY/h), so widget-top-left samples video-top-left:
 * upright, identical to the WebGL2 backend.
 *
 * DOM/WebGPU-facing (not core/): needs a real WebGPU device + HTMLVideoElement.
 */

/** Floats per vertex: clip-space x,y + texcoord u,v + opacity. */
const FLOATS_PER_VERTEX = 5;
/** Vertices per quad (two triangles). */
const VERTS_PER_QUAD = 6;
/** Corner order fanning a 4-corner quad into two triangles. */
const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3];
/** Bytes per vertex in the packed vertex buffer. */
const VERTEX_STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;

const SHADER_SRC = `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacity: f32,
};
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) opacity: f32) -> VOut {
  var o: VOut;
  o.pos = vec4f(pos, 0.0, 1.0);
  o.uv = uv;
  o.opacity = opacity;
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let rgb = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;
  return vec4f(rgb * in.opacity, in.opacity);  // PREMULTIPLIED
}`;

/**
 * Pure function. Fills `out` at `offset` with a quad's 6 vertices
 * ({x,y,u,v,opacity}) from its 4 clip-space corners. Returns the next offset.
 * (Same packing the WebGL2 backend uses; duplicated here to keep the two backend
 * modules independent — neither imports the other.)
 *
 * @param {Float32Array} out destination (length >= offset + 30)
 * @param {number} offset starting float index
 * @param {{x:number,y:number,u:number,v:number}[]} corners 4 clip-space corners
 * @param {number} opacity 0..1
 * @returns {number} next offset
 * @example packQuad(new Float32Array(30), 0, [{x:0,y:0,u:0,v:0},{x:1,y:0,u:1,v:0},{x:1,y:1,u:1,v:1},{x:0,y:1,u:0,v:1}], 0.5) // 30
 */
export function packQuad(out, offset, corners, opacity) {
  let o = offset;
  for (const ci of TRIANGLE_CORNERS) {
    const c = corners[ci];
    out[o++] = c.x; out[o++] = c.y; out[o++] = c.u; out[o++] = c.v; out[o++] = opacity;
  }
  return o;
}

/**
 * Command (async; creates a GPU device). Builds the WebGPU overlay backend on
 * `canvas`, or THROWS if no adapter/device is available (the selector then falls
 * back to WebGL2 — a reported decision, never silent). Returns
 * {kind, draw, dispose}.
 *
 * `draw(quads)` renders one frame: quads is
 *   {src, el, corners: [{x,y,u,v}×4 clip space], opacity, frameMarker}[]
 * (frameMarker is unused here — external-texture import always samples the
 * element's live current frame, so there is nothing to cache-gate; it is accepted
 * for a uniform backend interface.) Every quad's element is imported as a fresh
 * GPUExternalTexture and drawn as a textured quad; uncovered pixels are the
 * transparent clear (the Skia scene shows through).
 *
 * @param {HTMLCanvasElement} canvas the overlay canvas
 * @returns {Promise<{kind: string, draw: (quads: Array) => void, dispose: () => void}>}
 */
export async function createVideoV8WebGPUBackend(canvas) {
  if (!navigator.gpu) throw new Error("videoV8 WebGPU: navigator.gpu is undefined (not a secure context)");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("videoV8 WebGPU: requestAdapter() resolved no adapter");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("videoV8 WebGPU: getContext('webgpu') returned null");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const module = device.createShaderModule({ code: SHADER_SRC });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [{
        arrayStride: VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 2 * Float32Array.BYTES_PER_ELEMENT, format: "float32x2" },
          { shaderLocation: 2, offset: 4 * Float32Array.BYTES_PER_ELEMENT, format: "float32" },
        ],
      }],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          // Premultiplied source-over (matches alphaMode "premultiplied").
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  let vbuf = null;         // grows to hold all quads' vertices
  let vbufFloats = 0;

  function ensureVertexBuffer(floatCount) {
    if (vbuf && vbufFloats >= floatCount) return;
    if (vbuf) vbuf.destroy();
    vbufFloats = floatCount;
    vbuf = device.createBuffer({ size: floatCount * Float32Array.BYTES_PER_ELEMENT, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  function draw(quads) {
    const encoder = device.createCommandEncoder();
    const view = context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    if (quads.length > 0) {
      const floats = quads.length * VERTS_PER_QUAD * FLOATS_PER_VERTEX;
      ensureVertexBuffer(floats);
      const verts = new Float32Array(floats);
      let off = 0;
      for (const q of quads) off = packQuad(verts, off, q.corners, q.opacity);
      device.queue.writeBuffer(vbuf, 0, verts);

      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vbuf);
      quads.forEach((q, i) => {
        // GPUExternalTexture expires per task → import + bind-group EVERY draw.
        const external = device.importExternalTexture({ source: q.el });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: external },
          ],
        });
        pass.setBindGroup(0, bindGroup);
        pass.draw(VERTS_PER_QUAD, 1, i * VERTS_PER_QUAD);
      });
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function dispose() {
    if (vbuf) vbuf.destroy();
    vbuf = null;
    device.destroy();
  }

  return { kind: "webgpu", draw, dispose };
}
