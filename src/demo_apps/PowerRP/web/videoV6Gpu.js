/**
 * Video V6 — the overlay's raster engine (a COMMAND module: owns a GPU/GL
 * device and draws to the overlay canvas).
 *
 * PRIMARY PATH — WebGPU zero-copy external texture. Every frame, each visible
 * clip's PLAYING <video> is imported as a GPUExternalTexture
 * (device.importExternalTexture) and sampled in a textured quad with
 * textureSampleBaseClampToEdge — NO texImage2D, NO drawImage, NO CPU readback.
 * A GPUExternalTexture EXPIRES per task, so it is re-imported (and its bind
 * group re-created) every frame. This is the faithful revival of the deleted
 * "perfect" WebGPU video path (git 604ad83^ render_gpu/gpu/{compositor,shaders}.js).
 *
 * FALLBACK PATH — WebGL2 texImage2D upload. navigator.gpu exists ONLY in a
 * secure context; PowerRP must run on plain HTTP (the HTTPS-independence
 * tenant), where navigator.gpu is undefined. There the engine falls back —
 * LOUDLY (console.warn naming the reason) — to a WebGL2 program that uploads the
 * current frame with texImage2D and draws the same quad. Not zero-copy, but the
 * widget stays fully functional (full res, full rate) on plain HTTP.
 *
 * Both paths clear the overlay to TRANSPARENT and blend PREMULTIPLIED
 * (src=one, dst=one-minus-src-alpha) so the Skia scene shows through everywhere
 * a video isn't — one shared overlay canvas for all V6 video widgets.
 */

import { quadVertexData, FLOATS_PER_VERTEX } from "./videoV6Layout.js";

const BYTES_PER_FLOAT = 4;
const VERTS_PER_QUAD = 6; // two triangles
const VERTEX_STRIDE = FLOATS_PER_VERTEX * BYTES_PER_FLOAT; // bytes per vertex
const HAVE_CURRENT_DATA = 2; // HTMLMediaElement.readyState: a frame is decoded & drawable

/** WGSL: passthrough clip-space quad + external-texture sample (premultiplied by
 *  per-vertex opacity). External textures REQUIRE textureSampleBaseClampToEdge,
 *  not textureSample. */
export const VIDEO_V6_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) op: f32,
};

@vertex
fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) op: f32) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(pos, 0.0, 1.0);
  out.uv = uv;
  out.op = op;
  return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let rgb = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;
  return vec4f(rgb, 1.0) * in.op; // premultiplied (opaque frame × opacity)
}
`;

const GL_VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_op;
out vec2 v_uv;
out float v_op;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
  v_op = a_op;
}`;

const GL_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_op;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
  vec3 rgb = texture(u_tex, v_uv).rgb;
  fragColor = vec4(rgb, 1.0) * v_op; // premultiplied
}`;

/**
 * Command. Builds the overlay's raster engine on `canvas`: WebGPU if available
 * (secure context + adapter), else a LOUD fallback to WebGL2. Throws only if
 * NEITHER backend is available (a real, reportable failure — never silent).
 *
 * @param {HTMLCanvasElement} canvas The overlay canvas to render into.
 * @returns {Promise<{mode:string, drawFrame:Function, dispose:Function}>}
 *   `mode` is "webgpu" or "webgl2"; `drawFrame(drawList, deviceW, deviceH)`
 *   clears + draws the quads whose <video> has a current frame; `dispose()`
 *   releases the device/context.
 */
export async function createVideoV6Engine(canvas) {
  const webgpu = await tryCreateWebGPUEngine(canvas);
  if (webgpu) return webgpu;
  const webgl2 = createWebGL2Engine(canvas);
  if (webgl2) return webgl2;
  throw new Error("Video V6: neither WebGPU nor WebGL2 is available — cannot render the video overlay");
}

/**
 * Command. Attempts the WebGPU external-texture engine. Returns null (after a
 * LOUD console.warn naming why) when WebGPU is unavailable — the caller then
 * falls back to WebGL2. Only genuine internal inconsistencies throw.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<object|null>} The engine, or null to signal "fall back".
 */
async function tryCreateWebGPUEngine(canvas) {
  if (!navigator.gpu) {
    console.warn("Video V6: navigator.gpu absent (insecure origin / no WebGPU) — falling back to WebGL2 upload path");
    return null;
  }
  let adapter, device;
  try {
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.warn("Video V6: no WebGPU adapter — falling back to WebGL2 upload path");
      return null;
    }
    device = await adapter.requestDevice();
  } catch (e) {
    // Expected, capability-based condition (not ignorance): report + fall back.
    console.warn("Video V6: WebGPU device init failed — falling back to WebGL2 upload path:", e);
    return null;
  }
  device.lost.then((info) => console.error("Video V6: WebGPU device lost:", info.message)); // loud, never swallowed

  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });

  const module = device.createShaderModule({ code: VIDEO_V6_WGSL });
  const premultipliedBlend = {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  };
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module, entryPoint: "vs",
      buffers: [{
        arrayStride: VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },                  // clip pos
          { shaderLocation: 1, offset: 2 * BYTES_PER_FLOAT, format: "float32x2" }, // uv
          { shaderLocation: 2, offset: 4 * BYTES_PER_FLOAT, format: "float32" },   // opacity
        ],
      }],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format, blend: premultipliedBlend }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const bgl = pipeline.getBindGroupLayout(0);

  let vbuf = null; // grown on demand to fit the frame's quads
  function ensureCapacity(byteLength) {
    if (vbuf && vbuf.size >= byteLength) return;
    vbuf?.destroy();
    vbuf = device.createBuffer({ size: Math.max(byteLength, VERTS_PER_QUAD * VERTEX_STRIDE), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  function drawFrame(drawList, deviceW, deviceH) {
    const ready = drawList.filter((d) => d.el.readyState >= HAVE_CURRENT_DATA);
    if (ready.length > 0) {
      const verts = new Float32Array(ready.length * VERTS_PER_QUAD * FLOATS_PER_VERTEX);
      ready.forEach((d, i) => verts.set(quadVertexData(d.corners, d.opacity, deviceW, deviceH), i * VERTS_PER_QUAD * FLOATS_PER_VERTEX));
      ensureCapacity(verts.byteLength);
      device.queue.writeBuffer(vbuf, 0, verts);
    }
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    if (ready.length > 0) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vbuf);
      ready.forEach((d, i) => {
        // GPUExternalTexture expires per task → import + bind-group every frame.
        const external = device.importExternalTexture({ source: d.el });
        const bindGroup = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: external }] });
        pass.setBindGroup(0, bindGroup);
        pass.draw(VERTS_PER_QUAD, 1, i * VERTS_PER_QUAD);
      });
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function dispose() { vbuf?.destroy(); device.destroy(); }
  return { mode: "webgpu", drawFrame, dispose };
}

/**
 * Command. The plain-HTTP fallback engine: a WebGL2 program that uploads each
 * clip's current frame with texImage2D and draws the same textured quad. Returns
 * null if WebGL2 is unavailable (the caller then throws — a real failure).
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {object|null}
 */
function createWebGL2Engine(canvas) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return null;

  const program = linkProgram(gl, GL_VERT_SRC, GL_FRAG_SRC);
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  for (let loc = 0; loc <= 2; loc++) gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_STRIDE, 0);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_STRIDE, 2 * BYTES_PER_FLOAT);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, VERTEX_STRIDE, 4 * BYTES_PER_FLOAT);
  gl.bindVertexArray(null);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function drawFrame(drawList, deviceW, deviceH) {
    gl.viewport(0, 0, deviceW, deviceH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const ready = drawList.filter((d) => d.el.readyState >= HAVE_CURRENT_DATA);
    if (ready.length === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);

    const verts = new Float32Array(ready.length * VERTS_PER_QUAD * FLOATS_PER_VERTEX);
    ready.forEach((d, i) => verts.set(quadVertexData(d.corners, d.opacity, deviceW, deviceH), i * VERTS_PER_QUAD * FLOATS_PER_VERTEX));
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

    ready.forEach((d, i) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, d.el); // per-frame upload (the copy the WebGPU path avoids)
      gl.drawArrays(gl.TRIANGLES, i * VERTS_PER_QUAD, VERTS_PER_QUAD);
    });
    gl.bindVertexArray(null);
  }

  function dispose() {
    gl.deleteTexture(tex);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  }
  return { mode: "webgl2", drawFrame, dispose };
}

/**
 * Command. Compiles + links a WebGL2 program, THROWING with the driver info-log
 * on any shader/link error (loud — never a silent black screen).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 * @returns {WebGLProgram}
 */
function linkProgram(gl, vertSrc, fragSrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("Video V6 WebGL2 shader compile failed: " + gl.getShaderInfoLog(sh));
    return sh;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Video V6 WebGL2 program link failed: " + gl.getProgramInfoLog(program));
  return program;
}
