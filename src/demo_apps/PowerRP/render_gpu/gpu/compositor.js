/**
 * The WebGPU IR compositor: consumes the render_gpu/ir.js display list and
 * rasterizes it into a canvas — the prototype replacement for
 * render/compositor.js's canvas2D painter.
 *
 * Architecture (per frame, all inside one command submit):
 *   1. flattenIR resolves the transform stack (pure CPU).
 *   2. buildFrame walks the flattened commands IN ORDER (z-order) and packs
 *      per-instance typed arrays, splitting batches only where the pipeline
 *      or bound texture changes — consecutive shapes collapse into ONE
 *      instanced draw (DiskVis's single-draw-call pattern; 20k rects = 1 draw).
 *   3. Draw batches render into an offscreen SCENE texture. A backdrop-effect
 *      command ends the pass, snapshots scene → BACKDROP via
 *      copyTextureToTexture (a GPU-GPU blit — this is what replaces the
 *      canvas2D full-canvas snapshotCanvas()), runs its shader pass(es), and
 *      drawing resumes on the scene. Blur ping-pongs through TEMP; the
 *      magnifier lens samples BACKDROP directly.
 *   4. The scene is copied to the canvas swapchain texture.
 *
 * The `view` argument is the SAME camera mapping as the canvas compositor
 * ({zoom, panX, panY, dpr}; fitRectView-compatible) — the camera region stays
 * the one view function for every render target.
 *
 * Stateful service object (owns device, pipelines, textures, buffers).
 * Errors are loud: adapter/device failures throw at create(); device-lost and
 * uncaptured GPU errors throw on the next render().
 */

import { flattenIR, DRAW_OPS } from "../ir.js";
import * as T from "../../core/transform.js";
import { SHAPE_WGSL, MESH_WGSL, TEX_WGSL, VIDEO_WGSL, BLUR_WGSL, MAGNIFY_WGSL, SHAPE_KIND, TEX_MODE } from "./shaders.js";
import { GlyphAtlas, bucketFor } from "./glyph_atlas.js";

/** Extra device px around each SDF quad so antialiased edges never clip. */
const AA_MARGIN_DEVICE = 2;
/** Floats per instance — must match the WGSL attribute layouts. */
const SHAPE_FLOATS = 24; // 6 × vec4
const QUAD_FLOATS = 20;  // 5 × vec4 (tex, video, magnify share this stride)
const MESH_FLOATS = 6;   // pos.xy + rgba

/**
 * Pure function. Packs a similarity transform for the shaders' apply_xform:
 * (a, b, tx, ty) with a = s·cosθ, b = s·sinθ.
 *
 * @example packXform({x: 1, y: 2, rotation: 0, scale: 2}) // [2, 0, 1, 2]
 * @example packXform({x: 0, y: 0, rotation: Math.PI / 2, scale: 1}) // [~0, 1, 0, 0]
 */
export function packXform(world) {
  return [
    world.scale * Math.cos(world.rotation),
    world.scale * Math.sin(world.rotation),
    world.x,
    world.y,
  ];
}

/** Pure function. Smallest power of two ≥ n (buffer growth policy).
 * @example nextPow2(1000) // 1024
 */
export function nextPow2(n) {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(n, 1))));
}

/** Growable Float32Array staging buffer, reused across frames. */
class GrowF32 {
  constructor(capacity) {
    this.f32 = new Float32Array(capacity);
    this.used = 0;
  }
  reset() { this.used = 0; }
  /** Command. Reserves n floats; returns the write offset. */
  alloc(n) {
    if (this.used + n > this.f32.length) {
      const grown = new Float32Array(nextPow2(this.used + n));
      grown.set(this.f32.subarray(0, this.used));
      this.f32 = grown;
    }
    const at = this.used;
    this.used += n;
    return at;
  }
}

export class GpuCompositor {
  /**
   * Command (async). Initializes WebGPU on `canvas`. Throws loudly when
   * WebGPU or an adapter is unavailable (no fallback — WebGPU is the only
   * runtime raster mode by decree).
   *
   * Args:
   *   canvas (HTMLCanvasElement)
   *   opts.media (object): ref → HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
   */
  static async create(canvas, { media = {} } = {}) {
    if (!navigator.gpu)
      throw new Error("WebGPU unavailable (navigator.gpu missing — insecure context or unsupported browser)");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU: no adapter (GPU blocklisted or disabled)");
    const device = await adapter.requestDevice();
    return new GpuCompositor(canvas, device, media);
  }

  /** Use create() — the constructor assumes a ready device. */
  constructor(canvas, device, media) {
    this.canvas = canvas;
    this.device = device;
    this.media = media;
    this._fatal = null;
    device.addEventListener("uncapturederror", (e) => { this._fatal = new Error(`WebGPU uncaptured error: ${e.error.message}`); });
    device.lost.then((info) => {
      if (info.reason !== "destroyed") this._fatal = new Error(`WebGPU device lost: ${info.message}`);
    });

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context = canvas.getContext("webgpu");
    this.context.configure({
      device,
      format: this.format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.atlas = new GlyphAtlas(device);
    this._buildPipelines();

    // Staging arrays + GPU buffers (grow-only, reused every frame)
    const INITIAL_FLOATS = 1 << 16; // 256 KB staging start; grows on demand
    this.shapeArr = new GrowF32(INITIAL_FLOATS);
    this.quadArr = new GrowF32(INITIAL_FLOATS);  // tex + video + magnify instances
    this.meshArr = new GrowF32(INITIAL_FLOATS);
    this.shapeBuf = null;
    this.quadBuf = null;
    this.meshBuf = null;

    this.viewBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBG = device.createBindGroup({
      layout: this.viewBGL,
      entries: [{ binding: 0, resource: { buffer: this.viewBuf } }],
    });

    this.imageTextures = new Map(); // ref → {texture, bindGroup}
    this._blurPool = [];            // per-effect-ordinal {uboH, uboV, bgH, bgV}
    this._texW = 0;
    this._texH = 0;
  }

  _buildPipelines() {
    const d = this.device;
    this.viewBGL = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    this.texBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.videoBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      ],
    });
    this.blurBGL = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });

    const blend = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    };
    const target = { format: this.format, blend };
    const vec4attrs = (locations, startOffset = 0) =>
      locations.map((loc, i) => ({ shaderLocation: loc, offset: startOffset + i * 16, format: "float32x4" }));
    const cornerLayout = {
      arrayStride: 8, stepMode: "vertex",
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
    };
    const make = (label, code, bgls, buffers) => {
      const module = d.createShaderModule({ label, code });
      return d.createRenderPipeline({
        label,
        layout: d.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module, entryPoint: "vs", buffers },
        fragment: { module, entryPoint: "fs", targets: [target] },
        primitive: { topology: "triangle-list" },
      });
    };

    this.shapePipe = make("ir-shape", SHAPE_WGSL, [this.viewBGL], [
      cornerLayout,
      { arrayStride: SHAPE_FLOATS * 4, stepMode: "instance", attributes: vec4attrs([1, 2, 3, 4, 5, 6]) },
    ]);
    this.meshPipe = make("ir-mesh", MESH_WGSL, [this.viewBGL], [
      {
        arrayStride: MESH_FLOATS * 4, stepMode: "vertex",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "float32x4" },
        ],
      },
    ]);
    const quadInstLayout = { arrayStride: QUAD_FLOATS * 4, stepMode: "instance", attributes: vec4attrs([1, 2, 3, 4, 5]) };
    this.texPipe = make("ir-tex", TEX_WGSL, [this.viewBGL, this.texBGL], [cornerLayout, quadInstLayout]);
    this.videoPipe = make("ir-video", VIDEO_WGSL, [this.viewBGL, this.videoBGL], [cornerLayout, quadInstLayout]);
    this.magnifyPipe = make("ir-magnify", MAGNIFY_WGSL, [this.viewBGL, this.texBGL], [cornerLayout, quadInstLayout]);
    this.blurPipe = make("ir-blur", BLUR_WGSL, [this.blurBGL], []);

    // Static unit-quad corner buffer (two triangles)
    this.cornerBuf = d.createBuffer({ size: 6 * 2 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.cornerBuf, 0, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));

    this.atlasBG = d.createBindGroup({
      layout: this.texBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.atlas.texture.createView() },
      ],
    });
  }

  /** Command. (Re)creates the offscreen scene/backdrop/temp textures. */
  _ensureTargets(w, h) {
    if (this._texW === w && this._texH === h) return;
    for (const t of [this.sceneTex, this.backdropTex, this.tempTex]) t?.destroy();
    const mk = (label, usage) => this.device.createTexture({ label, size: [w, h], format: this.format, usage });
    const RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    const CS = GPUTextureUsage.COPY_SRC, CD = GPUTextureUsage.COPY_DST;
    this.sceneTex = mk("ir-scene", RT | TB | CS);
    this.backdropTex = mk("ir-backdrop", TB | CD);
    this.tempTex = mk("ir-temp", RT | TB);
    this.sceneView = this.sceneTex.createView();
    this.backdropView = this.backdropTex.createView();
    this.tempView = this.tempTex.createView();
    this.backdropBG = this.device.createBindGroup({
      layout: this.texBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.backdropView },
      ],
    });
    this._blurPool = []; // bind groups referenced the old texture views
    this._texW = w;
    this._texH = h;
  }

  /** Query+Command (uploads on first use). GPU texture for an image ref. */
  _imageBindGroup(ref) {
    const cached = this.imageTextures.get(ref);
    if (cached) return cached;
    const src = this.media[ref];
    if (!src) throw new Error(`GpuCompositor: no media registered for image ref "${ref}"`);
    const w = src.naturalWidth ?? src.videoWidth ?? src.width;
    const h = src.naturalHeight ?? src.videoHeight ?? src.height;
    const texture = this.device.createTexture({
      label: `ir-image-${ref}`,
      size: [w, h],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: src }, { texture, premultipliedAlpha: true }, [w, h]);
    const bindGroup = this.device.createBindGroup({
      layout: this.texBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
    const entry = { texture, bindGroup };
    this.imageTextures.set(ref, entry);
    return entry;
  }

  /**
   * Command (draws a frame). Renders the IR command list through `view`
   * ({zoom, panX, panY, dpr}) with an opaque `background` (parsed rgba array
   * or [r,g,b,a] floats).
   */
  render(commands, view, { background = [1, 1, 1, 1] } = {}) {
    if (this._fatal) throw this._fatal;
    const w = this.canvas.width, h = this.canvas.height;
    if (w === 0 || h === 0) throw new Error("GpuCompositor.render: zero-sized canvas");
    this._ensureTargets(w, h);

    const d = this.device;
    const scaleDev = view.zoom * view.dpr;
    d.queue.writeBuffer(this.viewBuf, 0, new Float32Array([
      scaleDev, view.panX * view.dpr, view.panY * view.dpr, 0,
      w, h, 0, 0,
    ]));

    const { batches } = this._buildFrame(flattenIR(commands), view);
    this.atlas.flush();

    // Upload staging arrays (grow GPU buffers as needed)
    const upload = (arr, buf, name) => {
      if (arr.used === 0) return buf;
      if (!buf || buf.size < arr.used * 4) {
        buf?.destroy();
        buf = d.createBuffer({ label: name, size: nextPow2(arr.used * 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      d.queue.writeBuffer(buf, 0, arr.f32, 0, arr.used);
      return buf;
    };
    this.shapeBuf = upload(this.shapeArr, this.shapeBuf, "ir-shape-inst");
    this.quadBuf = upload(this.quadArr, this.quadBuf, "ir-quad-inst");
    this.meshBuf = upload(this.meshArr, this.meshBuf, "ir-mesh-verts");

    const encoder = d.createCommandEncoder();
    let pass = null;
    let cleared = false;
    const [br, bg, bb, ba] = background;
    const ensurePass = () => {
      if (pass) return pass;
      pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.sceneView,
          loadOp: cleared ? "load" : "clear",
          clearValue: { r: br, g: bg, b: bb, a: ba },
          storeOp: "store",
        }],
      });
      cleared = true;
      pass.setBindGroup(0, this.viewBG);
      return pass;
    };
    const endPass = () => { pass?.end(); pass = null; };
    const snapshotBackdrop = () => {
      endPass();
      if (!cleared) { ensurePass(); endPass(); } // effect before any draw: snapshot the cleared background
      encoder.copyTextureToTexture({ texture: this.sceneTex }, { texture: this.backdropTex }, [w, h]);
    };

    let blurOrdinal = 0;
    for (const batch of batches) {
      switch (batch.type) {
        case "shape": {
          const p = ensurePass();
          p.setPipeline(this.shapePipe);
          p.setVertexBuffer(0, this.cornerBuf);
          p.setVertexBuffer(1, this.shapeBuf);
          p.draw(6, batch.count, 0, batch.first);
          break;
        }
        case "mesh": {
          const p = ensurePass();
          p.setPipeline(this.meshPipe);
          p.setVertexBuffer(0, this.meshBuf);
          p.draw(batch.vertexCount, 1, batch.firstVertex);
          break;
        }
        case "tex": {
          const p = ensurePass();
          p.setPipeline(this.texPipe);
          p.setBindGroup(1, batch.ref === null ? this.atlasBG : this._imageBindGroup(batch.ref).bindGroup);
          p.setVertexBuffer(0, this.cornerBuf);
          p.setVertexBuffer(1, this.quadBuf);
          p.draw(6, batch.count, 0, batch.first);
          break;
        }
        case "video": {
          const source = this.media[batch.ref];
          if (!source) throw new Error(`GpuCompositor: no media registered for video ref "${batch.ref}"`);
          // No decoded frame yet (still loading/seeking) → nothing to draw,
          // by design: the frame genuinely doesn't exist.
          if (source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) break;
          const external = d.importExternalTexture({ source });
          const bindGroup = d.createBindGroup({
            layout: this.videoBGL,
            entries: [
              { binding: 0, resource: this.sampler },
              { binding: 1, resource: external },
            ],
          });
          const p = ensurePass();
          p.setPipeline(this.videoPipe);
          p.setBindGroup(1, bindGroup);
          p.setVertexBuffer(0, this.cornerBuf);
          p.setVertexBuffer(1, this.quadBuf);
          p.draw(6, 1, 0, batch.first);
          break;
        }
        case "blur": {
          snapshotBackdrop();
          const pool = this._blurPool;
          if (!pool[blurOrdinal]) {
            const mkUbo = () => d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const uboH = mkUbo(), uboV = mkUbo();
            const mkBG = (srcView, ubo) => d.createBindGroup({
              layout: this.blurBGL,
              entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: srcView },
                { binding: 2, resource: { buffer: ubo } },
              ],
            });
            pool[blurOrdinal] = { uboH, uboV, bgH: mkBG(this.backdropView, uboH), bgV: mkBG(this.tempView, uboV) };
          }
          const { uboH, uboV, bgH, bgV } = pool[blurOrdinal];
          blurOrdinal++;
          d.queue.writeBuffer(uboH, 0, new Float32Array([1, 0, batch.sigmaDevice, 0, 1, 0, 0, 0]));
          d.queue.writeBuffer(uboV, 0, new Float32Array([0, 1, batch.sigmaDevice, 0, batch.opacity, 0, 0, 0]));
          const hPass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.tempView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
          });
          hPass.setPipeline(this.blurPipe);
          hPass.setBindGroup(0, bgH);
          hPass.draw(3);
          hPass.end();
          const vPass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.sceneView, loadOp: "load", storeOp: "store" }],
          });
          vPass.setPipeline(this.blurPipe);
          vPass.setBindGroup(0, bgV);
          vPass.draw(3);
          vPass.end();
          break;
        }
        case "magnify": {
          snapshotBackdrop();
          const p = ensurePass();
          p.setPipeline(this.magnifyPipe);
          p.setBindGroup(1, this.backdropBG);
          p.setVertexBuffer(0, this.cornerBuf);
          p.setVertexBuffer(1, this.quadBuf);
          p.draw(6, 1, 0, batch.first);
          break;
        }
        default:
          throw new Error(`GpuCompositor: unknown batch type "${batch.type}"`);
      }
    }
    if (!cleared) ensurePass(); // empty scene still clears to background
    endPass();
    encoder.copyTextureToTexture({ texture: this.sceneTex }, { texture: this.context.getCurrentTexture() }, [w, h]);
    d.queue.submit([encoder.finish()]);
  }

  /**
   * Command (fills staging arrays). Packs flattened commands into per-pipeline
   * instance arrays + an ordered batch list. Splits a batch only when the
   * pipeline or bound texture changes, preserving exact z-order.
   */
  _buildFrame(flat, view) {
    this.shapeArr.reset();
    this.quadArr.reset();
    this.meshArr.reset();
    const batches = [];
    let current = null; // {type, ref} accumulating batch

    const shapeInstance = () => {
      if (!(current?.type === "shape")) {
        current = { type: "shape", first: this.shapeArr.used / SHAPE_FLOATS, count: 0 };
        batches.push(current);
      }
      current.count++;
      return this.shapeArr.alloc(SHAPE_FLOATS);
    };
    const quadInstance = (type, ref) => {
      if (!(current?.type === type && current?.ref === ref) || type === "video" || type === "magnify") {
        current = { type, ref, first: this.quadArr.used / QUAD_FLOATS, count: 0 };
        batches.push(current);
      }
      current.count++;
      return this.quadArr.alloc(QUAD_FLOATS);
    };

    const scaleDev = view.zoom * view.dpr;
    const NO_COLOR = [0, 0, 0, 0];

    for (const { cmd, world } of flat) {
      const xf = packXform(world);
      const aaLocal = AA_MARGIN_DEVICE / Math.max(scaleDev * world.scale, 1e-6);
      switch (cmd.op) {
        case "rect": {
          const at = shapeInstance();
          const f = this.shapeArr.f32;
          const m = (cmd.strokeWidth ?? 0) / 2 + aaLocal;
          f.set([cmd.x - m, cmd.y - m, cmd.w + 2 * m, cmd.h + 2 * m], at);
          f.set(xf, at + 4);
          f.set(cmd.fill ?? NO_COLOR, at + 8);
          f.set(cmd.stroke ?? NO_COLOR, at + 12);
          f.set([cmd.x + cmd.w / 2, cmd.y + cmd.h / 2, cmd.w / 2, cmd.h / 2], at + 16);
          f.set([SHAPE_KIND.rect, cmd.strokeWidth ?? 0, cmd.opacity, cmd.cornerRadius], at + 20);
          break;
        }
        case "ellipse": {
          const at = shapeInstance();
          const f = this.shapeArr.f32;
          const m = (cmd.strokeWidth ?? 0) / 2 + aaLocal;
          f.set([cmd.cx - cmd.rx - m, cmd.cy - cmd.ry - m, 2 * (cmd.rx + m), 2 * (cmd.ry + m)], at);
          f.set(xf, at + 4);
          f.set(cmd.fill ?? NO_COLOR, at + 8);
          f.set(cmd.stroke ?? NO_COLOR, at + 12);
          f.set([cmd.cx, cmd.cy, cmd.rx, cmd.ry], at + 16);
          f.set([SHAPE_KIND.ellipse, cmd.strokeWidth ?? 0, cmd.opacity, 0], at + 20);
          break;
        }
        case "polyline": {
          const m = cmd.width / 2 + aaLocal;
          for (let i = 0; i + 1 < cmd.points.length; i++) {
            const [x0, y0] = cmd.points[i];
            const [x1, y1] = cmd.points[i + 1];
            const at = shapeInstance();
            const f = this.shapeArr.f32;
            const qx = Math.min(x0, x1) - m, qy = Math.min(y0, y1) - m;
            f.set([qx, qy, Math.abs(x1 - x0) + 2 * m, Math.abs(y1 - y0) + 2 * m], at);
            f.set(xf, at + 4);
            f.set(cmd.color, at + 8);
            f.set(NO_COLOR, at + 12);
            f.set([x0, y0, x1, y1], at + 16);
            f.set([SHAPE_KIND.segment, cmd.width, cmd.opacity, 0], at + 20);
          }
          break;
        }
        case "polygon": {
          // Fan triangulation (convex by IR contract), CPU world transform —
          // polygons are tiny (arrowheads) so per-vertex CPU math is fine.
          const alpha = cmd.fill[3] * cmd.opacity;
          const [cr, cg, cb] = cmd.fill;
          const pts = cmd.points.map(([x, y]) => T.apply(world, x, y));
          const triCount = pts.length - 2;
          if (!(current?.type === "mesh")) {
            current = { type: "mesh", firstVertex: this.meshArr.used / MESH_FLOATS, vertexCount: 0 };
            batches.push(current);
          }
          const at = this.meshArr.alloc(triCount * 3 * MESH_FLOATS);
          current.vertexCount += triCount * 3;
          const f = this.meshArr.f32;
          for (let i = 0; i < triCount; i++) {
            const tri = [pts[0], pts[i + 1], pts[i + 2]];
            tri.forEach((p, j) => {
              const o = at + (i * 3 + j) * MESH_FLOATS;
              f.set([p.x, p.y, cr * alpha, cg * alpha, cb * alpha, alpha], o);
            });
          }
          break;
        }
        case "text": {
          const devicePx = cmd.size * world.scale * scaleDev;
          const bucket = bucketFor(devicePx);
          const localScale = cmd.size / bucket;
          let pen = cmd.x;
          for (const ch of cmd.text) {
            const e = this.atlas.get(ch, bucket, cmd.bold);
            const at = quadInstance("tex", null);
            const f = this.quadArr.f32;
            f.set([
              pen - e.pad * localScale, cmd.y - e.pad * localScale,
              e.cellW * localScale, e.cellH * localScale,
            ], at);
            f.set(xf, at + 4);
            f.set([e.u0, e.v0, e.du, e.dv], at + 8);
            f.set(cmd.color, at + 12);
            f.set([TEX_MODE.glyph, cmd.opacity, 0, 0], at + 16);
            pen += e.advance * localScale;
          }
          break;
        }
        case "image":
        case "video": {
          const at = quadInstance(cmd.op === "image" ? "tex" : "video", cmd.ref);
          const f = this.quadArr.f32;
          f.set([cmd.x, cmd.y, cmd.w, cmd.h], at);
          f.set(xf, at + 4);
          f.set([0, 0, 1, 1], at + 8);
          f.set([1, 1, 1, 1], at + 12);
          f.set([TEX_MODE.image, cmd.opacity, 0, 0], at + 16);
          break;
        }
        case "blurBackdrop": {
          current = null;
          batches.push({ type: "blur", sigmaDevice: cmd.radius * world.scale * scaleDev, opacity: cmd.opacity });
          break;
        }
        case "magnifyBackdrop": {
          const at = quadInstance("magnify", null);
          const f = this.quadArr.f32;
          const centerWorld = T.apply(world, cmd.cx, cmd.cy);
          const rimW = cmd.rimColor ? cmd.rimWidth : 0;
          const m = rimW / 2 + aaLocal;
          f.set([cmd.cx - cmd.r - m, cmd.cy - cmd.r - m, 2 * (cmd.r + m), 2 * (cmd.r + m)], at);
          f.set(xf, at + 4);
          f.set([
            centerWorld.x * scaleDev + view.panX * view.dpr,
            centerWorld.y * scaleDev + view.panY * view.dpr,
            cmd.r * world.scale * scaleDev,
            cmd.magnification,
          ], at + 8);
          f.set(cmd.rimColor ?? NO_COLOR, at + 12);
          f.set([rimW * world.scale * scaleDev, cmd.opacity, 0, 0], at + 16);
          current = null; // effects never merge with a following batch
          break;
        }
        default:
          throw new Error(`GpuCompositor: unknown IR op "${cmd.op}" (known: ${DRAW_OPS.join(", ")})`);
      }
    }
    return { batches };
  }

  /**
   * Query (async GPU readback). Reads an RGBA pixel rect from the rendered
   * scene texture — the reliable readback path (drawImage from a WebGPU
   * canvas is not dependable post-present) and the seam the headless CLI's
   * PNG export will use. Coordinates in device px.
   *
   * Returns:
   *   Uint8ClampedArray: w*h*4 RGBA bytes
   */
  async readPixels(x, y, w, h) {
    if (!this.sceneTex) throw new Error("readPixels: nothing rendered yet");
    const d = this.device;
    const BYTES_PER_PX = 4;
    const ROW_ALIGN = 256; // WebGPU copyTextureToBuffer row alignment requirement
    const bytesPerRow = Math.ceil((w * BYTES_PER_PX) / ROW_ALIGN) * ROW_ALIGN;
    const buf = d.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = d.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.sceneTex, origin: { x, y } },
      { buffer: buf, bytesPerRow },
      [w, h],
    );
    d.queue.submit([encoder.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(w * h * BYTES_PER_PX);
    const bgra = this.format === "bgra8unorm"; // macOS preferred format — swizzle to RGBA
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const src = row * bytesPerRow + col * BYTES_PER_PX;
        const dst = (row * w + col) * BYTES_PER_PX;
        out[dst + 0] = mapped[src + (bgra ? 2 : 0)];
        out[dst + 1] = mapped[src + 1];
        out[dst + 2] = mapped[src + (bgra ? 0 : 2)];
        out[dst + 3] = mapped[src + 3];
      }
    }
    buf.unmap();
    buf.destroy();
    return out;
  }

  /** Command. Releases GPU resources. */
  destroy() {
    for (const t of [this.sceneTex, this.backdropTex, this.tempTex, this.atlas.texture]) t?.destroy();
    for (const { texture } of this.imageTextures.values()) texture.destroy();
    this.device.destroy();
  }
}
