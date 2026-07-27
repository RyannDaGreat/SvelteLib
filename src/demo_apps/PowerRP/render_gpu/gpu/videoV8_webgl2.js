/**
 * V8 video overlay — WebGL2 backend (the plain-HTTP fallback).
 *
 * WebGPU (videoV8_webgpu.js) is unavailable without a secure context, which is
 * PowerRP's HTTPS-independence tenant's whole problem. So this is the backend the
 * overlay uses on plain HTTP: a WebGL2 context on the ONE overlay `<canvas>` that
 * draws each visible video as a textured quad. The current frame is uploaded
 * GPU-side with `gl.texImage2D(target, ..., videoEl)` — the browser copies the
 * decoded frame straight into the texture with NO CPU readback and NO
 * drawImage → getImageData round-trip (the flicker/perf trap of the old path).
 *
 * FULL resolution, FULL frame rate: the upload is the video's native frame at its
 * native size (no downscale, no rate cap). It uploads a texture ONLY when the
 * element presents a NEW frame (frameMarker changed) — so a repaint burst
 * (pan/drag) that outruns the ~30fps decode reuses the last texture instead of
 * re-uploading the same frame at paint-rate. The last frame stays bound between
 * uploads, so a paused/steady clip shows a continuous image (no flicker, the
 * failure the boss called out).
 *
 * PREMULTIPLIED ALPHA: the context is premultiplied so the transparent clear lets
 * the Skia scene beneath show through, and per-widget `opacity` composites
 * correctly. Video frames are opaque (a=1); the fragment shader outputs
 * (rgb*opacity, opacity) — premultiplied — and blending is ONE, ONE_MINUS_SRC_ALPHA.
 *
 * ORIENTATION: no UNPACK_FLIP_Y. texImage2D loads the video's top row into texel
 * row 0, and the overlay's quad UVs are (localX/w, localY/h) — so widget-top-left
 * (uv 0,0) samples video-top-left: upright, matching the WebGPU backend's
 * textureSampleBaseClampToEdge orientation. (Verified by the headless
 * split-color probe, not assumed.)
 *
 * DOM/WebGL-facing (not core/): needs a real WebGL2 canvas + HTMLVideoElement.
 */

/** Floats per vertex in the quad VBO: clip-space x,y + texcoord u,v + opacity. */
const FLOATS_PER_VERTEX = 5;
/** Vertices per quad — two triangles (0,1,2) + (0,2,3), 6 vertices. */
const VERTS_PER_QUAD = 6;
/** Corner draw order that fans a 4-corner quad into two CCW triangles. */
const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3];

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;      // clip space (NDC)
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_opacity;
out vec2 v_uv;
out float v_opacity;
void main() {
  v_uv = a_uv;
  v_opacity = a_opacity;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_opacity;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  vec3 rgb = texture(u_tex, v_uv).rgb;      // video frame is opaque
  outColor = vec4(rgb * v_opacity, v_opacity); // PREMULTIPLIED (matches context)
}`;

/**
 * Near-pure helper (throws loudly on a compile error — no silent fallback).
 * Compiles one shader stage.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} type gl.VERTEX_SHADER | gl.FRAGMENT_SHADER
 * @param {string} src GLSL ES 3.00 source
 * @returns {WebGLShader}
 */
function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`videoV8 WebGL2: shader compile failed — ${log}`);
  }
  return sh;
}

/**
 * Near-pure helper (throws on link error). Links the quad program.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {WebGLProgram}
 */
function linkProgram(gl) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`videoV8 WebGL2: program link failed — ${log}`);
  }
  return prog;
}

/**
 * Pure function. Fills a Float32Array with a quad's two triangles (6 vertices ×
 * {x, y, u, v, opacity}) from its 4 corners, into `out` at `offset` floats.
 * Corners are clip-space {x, y, u, v}; triangles fan via TRIANGLE_CORNERS. The
 * per-vertex opacity is constant across the quad. Returns the next write offset.
 *
 * @param {Float32Array} out destination buffer (length >= offset + 30)
 * @param {number} offset starting float index
 * @param {{x:number,y:number,u:number,v:number}[]} corners 4 clip-space corners
 * @param {number} opacity 0..1
 * @returns {number} offset + VERTS_PER_QUAD * FLOATS_PER_VERTEX
 * @example writeQuadVerts(new Float32Array(30), 0, [{x:0,y:0,u:0,v:0},{x:1,y:0,u:1,v:0},{x:1,y:1,u:1,v:1},{x:0,y:1,u:0,v:1}], 1) // 30
 */
export function writeQuadVerts(out, offset, corners, opacity) {
  let o = offset;
  for (const ci of TRIANGLE_CORNERS) {
    const c = corners[ci];
    out[o++] = c.x; out[o++] = c.y; out[o++] = c.u; out[o++] = c.v; out[o++] = opacity;
  }
  return o;
}

/**
 * Command (creates GPU resources). Builds the WebGL2 overlay backend on `canvas`.
 * THROWS loudly if a WebGL2 context can't be created (no silent fallback — the
 * selector decides what to do). Returns a backend {kind, draw, dispose}.
 *
 * `draw(quads)` renders one frame: quads is an array of
 *   {src, el, corners: [{x,y,u,v}×4 clip space], opacity, frameMarker}
 * The canvas backing size (canvas.width/height, device px) is set by the caller
 * before draw; draw reads it for the viewport. Each quad uploads its element's
 * current frame to a per-src texture ONLY when frameMarker changed since the last
 * upload, then draws the textured quad. The frame is CLEARED to transparent first
 * so uncovered pixels show the Skia scene beneath.
 *
 * @param {HTMLCanvasElement} canvas the overlay canvas
 * @returns {{kind: string, draw: (quads: Array) => void, dispose: () => void}}
 */
export function createVideoV8WebGL2Backend(canvas) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error("videoV8 WebGL2: getContext('webgl2') returned null (WebGL2 unavailable)");

  const program = linkProgram(gl);
  const texLoc = gl.getUniformLocation(program, "u_tex");
  const vbo = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const stride = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
  gl.bindVertexArray(null);

  /** src → {tex, marker}. One texture per source, reused across frames. */
  const textures = new Map();
  /** Scratch vertex buffer for one quad, reused each draw (no per-frame alloc). */
  const scratch = new Float32Array(VERTS_PER_QUAD * FLOATS_PER_VERTEX);

  function ensureTexture(src) {
    let entry = textures.get(src);
    if (entry) return entry;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    entry = { tex, marker: null };
    textures.set(src, entry);
    return entry;
  }

  function draw(quads) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (quads.length === 0) return;

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(texLoc, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    for (const q of quads) {
      const entry = ensureTexture(q.src);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      // Upload only a genuinely new decoded frame (frameMarker changed). A repaint
      // burst that outruns the decode reuses the last texture — no re-upload of an
      // unchanged frame at paint-rate.
      if (entry.marker !== q.frameMarker) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, q.el);
        entry.marker = q.frameMarker;
      }
      writeQuadVerts(scratch, 0, q.corners, q.opacity);
      gl.bufferData(gl.ARRAY_BUFFER, scratch, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, VERTS_PER_QUAD);
    }
    gl.bindVertexArray(null);
  }

  function dispose() {
    for (const { tex } of textures.values()) gl.deleteTexture(tex);
    textures.clear();
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  }

  return { kind: "webgl2", draw, dispose };
}
