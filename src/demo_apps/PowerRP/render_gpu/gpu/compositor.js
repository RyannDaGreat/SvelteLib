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
 *      drawing resumes on the scene. Blur ping-pongs through TEMP; a
 *      supersample:false magnifier lens samples BACKDROP directly (soft:
 *      1/M of screen resolution); a supersample:true magnifier RE-RENDERS
 *      the batches BELOW it (command order is z-order, so "before the lens
 *      op" = "below the lens's z") into a LENS texture under a lens view
 *      (magnification·zoom, pan recentered so the lens circle stays at the
 *      same device pixels), scissored to the lens's device rect so the
 *      re-render cost is bounded by the lens area — then the lens quad
 *      samples THAT texture 1:1 (sharp: a true re-render at display
 *      resolution). The encode loop is re-entrant (_encodeScene); recursion
 *      is capped at MAX_SUPERSAMPLE_DEPTH — a lens replayed inside another
 *      lens's re-render falls back to backdrop sampling.
 *   4. The scene is copied to the canvas swapchain texture.
 *
 * ANTIALIASING (browser setting "powerrp.antialiasing", DEFAULT ON, no UI —
 * manifest "ANTIALIASING — GO"): MSAA 4× on every CONTENT target. Each
 * content target (the scene, each lens depth) gets a multisampled companion
 * texture; content passes render into the MSAA attachment and RESOLVE into
 * the logical texture at every pass end (storeOp "store" keeps the samples
 * authoritative across effect-interrupted passes). Every READER — backdrop
 * snapshot, lens quad sampling, readPixels, the final swapchain copy — binds
 * the RESOLVED texture, so nothing downstream knows MSAA exists. The blur's
 * H pass targets the single-sampled TEMP (a fullscreen triangle has no
 * geometric edges to antialias) and needs a sampleCount-1 pipeline variant;
 * its V pass composites INTO the content target and must go through the MSAA
 * attachment like every content draw (bypassing it would leave the stored
 * samples stale, and the next pass's resolve would wipe the blur). SDF
 * shapes/text keep their superior shader AA regardless; MSAA is what fixes
 * the mesh (polygon) pipeline's jagged edges — arrowheads, fancy arrows.
 * Cost: one 4-sample canvas-size texture (+ one per live lens depth, lazy).
 *
 * The `view` argument is the SAME camera mapping as the canvas compositor
 * ({zoom, panX, panY, dpr}; fitRectView-compatible) — the camera region stays
 * the one view function for every render target.
 *
 * Stateful service object (owns device, pipelines, textures, buffers).
 * Errors are loud: adapter/device failures throw at create(); device-lost and
 * uncaptured GPU errors throw on the next render().
 */

import { flattenIR, DRAW_OPS, rect, ellipse, polyline, polygon, text, blurBackdrop, magnifyBackdrop } from "../ir.js";
import * as T from "../../core/transform.js";
import { SHAPE_WGSL, MESH_WGSL, TEX_WGSL, VIDEO_WGSL, BLUR_WGSL, MAGNIFY_WGSL, SHAPE_KIND, TEX_MODE, MAX_HALF_KERNEL } from "./shaders.js";
import { GlyphAtlas, bucketFor } from "./glyph_atlas.js";
import { ensureImage, getImage } from "./image_registry.js";
import { ensureVideo, getVideo } from "./video_registry.js";

/** Extra device px around each SDF quad so antialiased edges never clip. */
const AA_MARGIN_DEVICE = 2;
/** MSAA sample count when antialiasing is on — 4× per the approved plan
 * (manifest "ANTIALIASING — GO": MSAA 4× on the scene texture). */
const MSAA_SAMPLES = 4;
/**
 * Lens re-render recursion cap: a magnifier replayed INSIDE another lens's
 * re-render falls back to backdrop sampling (soft) instead of recursing —
 * the same depth-1 guard the canvas2D renderRegion path used (see
 * plugins/magnifier.js's nested-magnifier note). Each on-screen lens still
 * supersamples ITSELF at depth 0. Raising this enables true recursive lenses
 * (one full-canvas texture per extra depth; each level's fragment cost is
 * already scissor-bounded to its lens rect) — a user decision, not a tweak.
 */
const MAX_SUPERSAMPLE_DEPTH = 1;
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

/**
 * Pure function. The view a supersampling lens re-renders its sub-scene
 * under: zoom scaled by `magnification`, pan recentered so the lens's WORLD
 * center stays at the SAME device pixel as in `view`. Rendering into a
 * canvas-sized texture under this view puts the magnified source region
 * (plugins/magnifier.js lensSourceRect: the 2r/M square about the center)
 * exactly over the lens's on-screen circle — the lens quad then samples the
 * texture 1:1. This is the GPU form of the old canvas renderRegion's
 * fitRectView(lensSourceRect(...), diam, diam) lens view.
 *
 * Args:
 *   view (object): {zoom, panX, panY, dpr} outer view
 *   centerWorld (object): {x, y} lens center in world space
 *   magnification (number): the lens's M (> 0)
 *
 * Returns:
 *   object: {zoom, panX, panY, dpr}
 *
 * @example lensRenderView({zoom: 1, panX: 0, panY: 0, dpr: 1}, {x: 100, y: 50}, 2) // {zoom: 2, panX: -100, panY: -50, dpr: 1}
 * @example lensRenderView({zoom: 2, panX: 10, panY: 0, dpr: 2}, {x: 0, y: 0}, 3) // {zoom: 6, panX: 10, panY: 0, dpr: 2} (center at origin: pan unchanged)
 */
export function lensRenderView(view, centerWorld, magnification) {
  return {
    zoom: view.zoom * magnification,
    panX: view.panX - centerWorld.x * view.zoom * (magnification - 1),
    panY: view.panY - centerWorld.y * view.zoom * (magnification - 1),
    dpr: view.dpr,
  };
}

/**
 * Pure function. Maps a device-px rect under `fromView` to the device-px rect
 * covering the same WORLD region under `toView` (same-dpr views over
 * same-sized textures). Carries an outer scissor (the presenter's letterbox)
 * into a lens re-render, so a lens near the camera edge cannot leak
 * outside-camera content.
 *
 * @example deviceRectThroughViews({x: 0, y: 0, w: 100, h: 100}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {zoom: 2, panX: 0, panY: 0, dpr: 1}) // {x: 0, y: 0, w: 200, h: 200}
 * @example deviceRectThroughViews({x: 50, y: 0, w: 50, h: 50}, {zoom: 1, panX: 0, panY: 0, dpr: 1}, {zoom: 1, panX: -50, panY: 0, dpr: 1}) // {x: 0, y: 0, w: 50, h: 50}
 */
export function deviceRectThroughViews(rect, fromView, toView) {
  const map = (dx, dy) => {
    const wx = (dx / fromView.dpr - fromView.panX) / fromView.zoom;
    const wy = (dy / fromView.dpr - fromView.panY) / fromView.zoom;
    return [(wx * toView.zoom + toView.panX) * toView.dpr, (wy * toView.zoom + toView.panY) * toView.dpr];
  };
  const [x0, y0] = map(rect.x, rect.y);
  const [x1, y1] = map(rect.x + rect.w, rect.y + rect.h);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Pure function. Intersection of two rects (x,y,w,h); zero-area (w or h 0)
 * when disjoint — a zero-area scissor legally draws nothing.
 *
 * @example intersectRects({x: 0, y: 0, w: 10, h: 10}, {x: 5, y: 5, w: 10, h: 10}) // {x: 5, y: 5, w: 5, h: 5}
 * @example intersectRects({x: 0, y: 0, w: 4, h: 4}, {x: 8, y: 0, w: 2, h: 2}).w // 0
 */
export function intersectRects(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x, y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  };
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
   *   opts.alphaMode (string): canvas compositing mode — "opaque" (default;
   *     presenter/CLI/thumbnails own their full frame) or "premultiplied"
   *     (the EDITOR: its transparent clear must show the grid underlay and
   *     app background beneath the canvas; the scene texture is already
   *     premultiplied by the blend mode, so the copy composites correctly).
   *   opts.antialiasing (boolean|null): MSAA 4× on content targets. null
   *     (default) reads the BROWSER SETTING "powerrp.antialiasing"
   *     (localStorage, default ON — same viewer-preference pattern as
   *     powerrp.retina); pass an explicit boolean to pin it (tests).
   */
  static async create(canvas, { media = {}, alphaMode = "opaque", antialiasing = null } = {}) {
    if (!navigator.gpu)
      throw new Error("WebGPU unavailable (navigator.gpu missing — insecure context or unsupported browser)");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU: no adapter (GPU blocklisted or disabled)");
    const device = await adapter.requestDevice();
    const aa = antialiasing ?? globalThis.localStorage?.getItem("powerrp.antialiasing") !== "off";
    const comp = new GpuCompositor(canvas, device, media, { alphaMode, sampleCount: aa ? MSAA_SAMPLES : 1 });
    comp.warmup();
    return comp;
  }

  /**
   * Command. Renders one tiny frame exercising every pipeline (shape, mesh,
   * text/atlas, blur, magnifier) so Metal/D3D compile shaders at init instead
   * of stalling the FIRST USER FRAME (~0.5-1.2s measured; FINDINGS). Called
   * by create(); the frame is immediately overwritten by the first real
   * render.
   */
  warmup() {
    this.render([
      rect({ x: 0, y: 0, w: 2, h: 2, cornerRadius: 1, fill: [0, 0, 0, 1], stroke: [0, 0, 0, 1], strokeWidth: 1 }),
      ellipse({ cx: 1, cy: 1, rx: 1, ry: 1, fill: [0, 0, 0, 1] }),
      polyline({ points: [[0, 0], [2, 2]], width: 1, color: [0, 0, 0, 1] }),
      polygon({ points: [[0, 0], [2, 0], [1, 2]], fill: [0, 0, 0, 1] }),
      text({ text: "w", x: 0, y: 0, size: 8, color: [0, 0, 0, 1] }),
      blurBackdrop({ radius: 1, opacity: 1 }),
      magnifyBackdrop({ cx: 1, cy: 1, r: 1, magnification: 2, rimColor: [0, 0, 0, 1], rimWidth: 1 }),
    ], { zoom: 1, panX: 0, panY: 0, dpr: 1 }, { background: [0, 0, 0, 0] });
  }

  /** Use create() — the constructor assumes a ready device. */
  constructor(canvas, device, media, { alphaMode = "opaque", sampleCount = 1 } = {}) {
    this.canvas = canvas;
    this.device = device;
    this.media = media;
    this.sampleCount = sampleCount; // 1 = no MSAA; MSAA_SAMPLES when antialiasing
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
      alphaMode,
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
    this._blurPool = [];            // per-blur-use-ordinal {uboH, uboV, bgH, bgV}
    this._lensPool = [];            // per-recursion-depth {tex, view} lens re-render targets (canvas-sized, lazy)
    this._lensUsePool = [];         // per-lens-use-ordinal {viewBuf, viewBG, rectBuf, bgByDepth}
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
    // Magnify group(1): sampler + texture + the sample-rect uniform (which
    // device-px region of the target the texture covers — see MAGNIFY_WGSL).
    this.magnifyBGL = d.createBindGroupLayout({
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
    // Content pipelines carry the compositor's sample count (they render into
    // the MSAA attachment when antialiasing is on); a pipeline's multisample
    // state must match its pass's attachment, so pipelines that target
    // single-sampled textures (blur H → TEMP) get an explicit count of 1.
    const make = (label, code, bgls, buffers, sampleCount = this.sampleCount) => {
      const module = d.createShaderModule({ label, code });
      return d.createRenderPipeline({
        label,
        layout: d.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module, entryPoint: "vs", buffers },
        fragment: { module, entryPoint: "fs", targets: [target] },
        primitive: { topology: "triangle-list" },
        multisample: { count: sampleCount },
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
    this.magnifyPipe = make("ir-magnify", MAGNIFY_WGSL, [this.viewBGL, this.magnifyBGL], [cornerLayout, quadInstLayout]);
    // Blur V composites INTO the content target (MSAA attachment — content
    // sample count); blur H renders into the single-sampled TEMP and needs a
    // count-1 variant. Same shader; only the pipeline multisample state
    // differs. With antialiasing off the two are the same descriptor — reuse.
    this.blurPipe = make("ir-blur", BLUR_WGSL, [this.blurBGL], []);
    this.blurPipeTemp = this.sampleCount > 1 ? make("ir-blur-temp", BLUR_WGSL, [this.blurBGL], [], 1) : this.blurPipe;

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

  /** Command. (Re)creates the offscreen scene/backdrop/temp/lens (+ MSAA) textures. */
  _ensureTargets(w, h) {
    if (this._texW === w && this._texH === h) return;
    for (const t of [this.sceneTex, this.backdropTex, this.tempTex, this.msaaTex]) t?.destroy();
    for (const l of this._lensPool) { l.tex.destroy(); l.msaaTex?.destroy(); }
    const mk = (label, usage) => this.device.createTexture({ label, size: [w, h], format: this.format, usage });
    const RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    const CS = GPUTextureUsage.COPY_SRC, CD = GPUTextureUsage.COPY_DST;
    this.sceneTex = mk("ir-scene", RT | TB | CS);
    this.backdropTex = mk("ir-backdrop", TB | CD);
    this.tempTex = mk("ir-temp", RT | TB);
    // The scene's MSAA companion: content passes render here and resolve into
    // sceneTex (multisampled textures are attachment-only — never sampled).
    this.msaaTex = this.sampleCount > 1
      ? this.device.createTexture({ label: "ir-scene-msaa", size: [w, h], format: this.format, usage: RT, sampleCount: this.sampleCount })
      : null;
    this.msaaView = this.msaaTex?.createView() ?? null;
    this.sceneView = this.sceneTex.createView();
    this.backdropView = this.backdropTex.createView();
    this.tempView = this.tempTex.createView();
    // Backdrop sampling covers the whole target: sample rect = (0, 0, w, h).
    this.backdropRectBuf ??= this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.backdropRectBuf, 0, new Float32Array([0, 0, w, h]));
    this.backdropBG = this.device.createBindGroup({
      layout: this.magnifyBGL,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.backdropView },
        { binding: 2, resource: { buffer: this.backdropRectBuf } },
      ],
    });
    this._blurPool = [];    // bind groups referenced the old texture views
    this._lensPool = [];    // canvas-sized: recreated lazily at the new size
    for (const u of this._lensUsePool) { u.viewBuf.destroy(); u.rectBuf.destroy(); }
    this._lensUsePool = []; // bgByDepth entries referenced the old lens views
    this._texW = w;
    this._texH = h;
  }

  /**
   * Query+Command (allocates on first use). The lens re-render target for a
   * recursion depth: ONE canvas-sized texture per depth, allocated once per
   * canvas size (no per-frame churn). Only the visible lens intersection is
   * ever RENDERED into it (its top-left corner), so the supersample cost is
   * ≤ one screen of pixels regardless of zoom — the canvas bound also keeps
   * the size below device.limits.maxTextureDimension2D by construction
   * (guarded loudly anyway: an unbounded size request is a bug, not a case).
   */
  _lensTarget(depth) {
    if (!this._lensPool[depth]) {
      const limit = this.device.limits.maxTextureDimension2D;
      let w = this._texW, h = this._texH;
      if (w > limit || h > limit) {
        console.error(`GpuCompositor: lens texture ${w}x${h} exceeds maxTextureDimension2D ${limit} — clamping (this should be impossible: lens work is bounded by the canvas)`);
        w = Math.min(w, limit);
        h = Math.min(h, limit);
      }
      const tex = this.device.createTexture({
        label: `ir-lens-${depth}`,
        size: [w, h],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      // Each lens depth is a CONTENT target, so it gets its own MSAA
      // companion — the scene's is mid-frame live while a lens re-renders
      // (its stored samples must survive the recursion), so sharing is
      // impossible. Lazy like the lens texture itself: costs nothing until
      // a supersampling lens is actually on screen.
      const msaaTex = this.sampleCount > 1
        ? this.device.createTexture({ label: `ir-lens-msaa-${depth}`, size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT, sampleCount: this.sampleCount })
        : null;
      this._lensPool[depth] = { tex, view: tex.createView(), msaaTex, msaaView: msaaTex?.createView() ?? null };
    }
    return this._lensPool[depth];
  }

  /**
   * Query+Command (allocates on first use). Per-lens-USE GPU resources for one
   * frame: the sub-render's view uniform and the lens quad's sample-rect
   * uniform + bind group. Pooled by use ordinal because every use needs its
   * OWN buffers — queue writes all land before the encoder's passes execute,
   * so one buffer written twice per frame would make the last write win for
   * every pass. bgByDepth caches the bind group per lens texture (per depth).
   */
  _lensUseEntry(ordinal, depth) {
    if (!this._lensUsePool[ordinal]) {
      const viewBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const viewBG = this.device.createBindGroup({
        layout: this.viewBGL,
        entries: [{ binding: 0, resource: { buffer: viewBuf } }],
      });
      const rectBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._lensUsePool[ordinal] = { viewBuf, viewBG, rectBuf, bgByDepth: [] };
    }
    const entry = this._lensUsePool[ordinal];
    if (!entry.bgByDepth[depth]) {
      entry.bgByDepth[depth] = this.device.createBindGroup({
        layout: this.magnifyBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this._lensTarget(depth).view },
          { binding: 2, resource: { buffer: entry.rectBuf } },
        ],
      });
    }
    return entry;
  }

  /**
   * Query+Command (near-pure: kicks an idempotent decode). The drawable image
   * SOURCE for a ref, or null if it is not ready yet. Resolution order:
   *   1. this.media[ref] — a source the web layer registered explicitly (a
   *      <video>/<canvas> element, or an image a caller pre-registered).
   *   2. the shared image_registry — a decoded ImageBitmap for a src string
   *      (URL/data-URI), THE path an image widget uses: no web-layer media
   *      plumbing needed. If the src isn't decoded yet, ensureImage kicks the
   *      async decode and this returns null (draw nothing this frame; the
   *      registry's onImageLoad wakes a repaint when the bitmap lands).
   * Returns null instead of throwing on an un-decoded src (in-flight is normal,
   * not an error — the manifest async rule); a genuine decode FAILURE is the
   * registry's loud console.error, and stays null here.
   */
  _imageSource(ref) {
    const explicit = this.media[ref];
    if (explicit) return explicit;
    const bitmap = getImage(ref);
    if (bitmap) return bitmap;
    ensureImage(ref); // idempotent; safe every frame
    return null;
  }

  /**
   * Query+Command (near-pure: kicks idempotent element creation). The
   * `<video>` element for a ref if it has a current frame, else null.
   * Resolution order mirrors _imageSource:
   *   1. this.media[ref] — a `<video>`/`<canvas>` the web layer registered
   *      explicitly (the media-map override path; unused by the plugin today).
   *   2. the shared video_registry — the `<video>` element for a src string,
   *      THE path the video widget uses (no web-layer media plumbing). If the
   *      element doesn't exist yet, ensureVideo creates it (default flags:
   *      autoplay+loop+muted, the plugin defaults — a widget that overrode a
   *      flag already called ensureVideo with its own, so this is a no-op
   *      there) and this returns null (draw nothing this frame; the registry's
   *      onVideoFrame wakes a repaint when a frame lands).
   * Returns null instead of throwing on a not-yet-decoded src (in-flight is
   * normal — the manifest async rule); a genuine load FAILURE is the registry's
   * loud console.error, and stays null here.
   */
  _videoSource(ref) {
    const explicit = this.media[ref];
    if (explicit) return explicit;
    const el = getVideo(ref);
    if (el) return el;
    ensureVideo(ref); // idempotent; default flags — a flagged widget created it first
    return null;
  }

  /** Query+Command (uploads on first use). GPU texture for a READY image ref
   * (caller guarantees _imageSource(ref) was non-null this frame). */
  _imageBindGroup(ref) {
    const cached = this.imageTextures.get(ref);
    if (cached) return cached;
    const src = this._imageSource(ref);
    if (!src) throw new Error(`GpuCompositor: image ref "${ref}" packed but its source is not ready (should have been skipped in _buildFrame)`);
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
  render(commands, view, { background = [1, 1, 1, 1], scissor = null } = {}) {
    if (this._fatal) throw this._fatal;
    const w = this.canvas.width, h = this.canvas.height;
    if (w === 0 || h === 0) throw new Error("GpuCompositor.render: zero-sized canvas");
    this._ensureTargets(w, h);

    const d = this.device;
    this._writeView(this.viewBuf, view);

    const flat = flattenIR(commands);
    let frame;
    try {
      frame = this._buildFrame(flat, view);
    } catch (e) {
      if (!e.atlasPageFull) throw e;
      // Generation eviction: the shelf packer can't free single cells, so a
      // full glyph page evicts ALL cached glyphs (LOUDLY — never silent) and
      // the frame rebuilds against the empty page, re-rasterizing only the
      // glyphs it actually draws (per-glyph culling keeps that set small at
      // deep zoom). A frame that STILL overflows genuinely exceeds one page
      // — that error stands and propagates.
      console.warn(`PowerRP GlyphAtlas: ${e.message} — evicting all cached glyphs and rebuilding this frame`);
      this.atlas.reset();
      frame = this._buildFrame(flat, view);
    }
    const { batches } = frame;
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

    // Per-frame effect-use ordinals, shared across lens re-renders: every
    // blur/lens USE gets its own uniform buffers, because queue writes all
    // land before the encoder's passes execute — one buffer written twice in
    // a frame would make the last write win for every pass that reads it.
    this._blurOrdinal = 0;
    this._lensOrdinal = 0;
    const encoder = d.createCommandEncoder();
    this._encodeScene(encoder, batches, view, this.viewBG,
      { tex: this.sceneTex, view: this.sceneView, msaaView: this.msaaView, contentW: w, contentH: h },
      { background, scissor }, 0);
    encoder.copyTextureToTexture({ texture: this.sceneTex }, { texture: this.context.getCurrentTexture() }, [w, h]);
    d.queue.submit([encoder.finish()]);
  }

  /** Command. Writes a view uniform buffer: world→device mapping + the device resolution of the (canvas-sized) render targets. */
  _writeView(buf, view) {
    this.device.queue.writeBuffer(buf, 0, new Float32Array([
      view.zoom * view.dpr, view.panX * view.dpr, view.panY * view.dpr, 0,
      this._texW, this._texH, 0, 0,
    ]));
  }

  /**
   * Command (encodes GPU passes). The batch-walking core of render(), made
   * RE-ENTRANT so a supersampling magnifier can replay the batches below
   * itself (batch order is z-order) into a lens texture under a lens view.
   *
   * `target` is {tex, view, msaaView, contentW, contentH}: the scene texture
   * at depth 0 (content = whole canvas), a lens texture in re-renders
   * (content = the visible lens intersection, rendered into the texture's
   * top-left corner — the manifest rule "Magnifier renders only the VISIBLE
   * lens intersection"). msaaView (null when antialiasing is off) is the
   * target's multisampled companion: content passes attach IT and resolve
   * into `view`, so `tex`/`view` always hold the resolved-so-far image for
   * every reader. All targets share the canvas's texture size, so a device
   * px means the same thing at every depth; only the content rect shrinks.
   *
   * `viewBG` binds the uniform holding `view` — every re-render has its own
   * (see render()'s ordinal note). `depth` caps lens recursion.
   */
  _encodeScene(encoder, batches, view, viewBG, target, { background, scissor }, depth) {
    const d = this.device;
    const cw = target.contentW, ch = target.contentH;
    let pass = null;
    let cleared = false;
    const [br, bg, bb, ba] = background;
    // Content attachment: through the MSAA companion (resolving into the
    // logical texture every pass end) when antialiasing is on, direct
    // otherwise. storeOp "store" keeps the MSAA samples authoritative across
    // effect-interrupted passes (loadOp "load" resumes from them).
    const contentAttachment = (loadOp) => ({
      view: target.msaaView ?? target.view,
      ...(target.msaaView ? { resolveTarget: target.view } : {}),
      loadOp,
      clearValue: { r: br, g: bg, b: bb, a: ba },
      storeOp: "store",
    });
    const ensurePass = () => {
      if (pass) return pass;
      pass = encoder.beginRenderPass({
        colorAttachments: [contentAttachment(cleared ? "load" : "clear")],
      });
      cleared = true;
      pass.setBindGroup(0, viewBG);
      // Optional device-px scissor on CONTENT passes (the presenter's
      // letterbox; a lens re-render's visible intersection). Effect passes
      // (blur) run their own full-texture passes and stay unscissored,
      // matching canvas2D where the backdrop snapshot already contains the
      // clipped scene. Clamped to the content rect: WebGPU throws on
      // out-of-bounds scissors.
      if (scissor) {
        const sx = Math.max(0, Math.min(cw, Math.round(scissor.x)));
        const sy = Math.max(0, Math.min(ch, Math.round(scissor.y)));
        pass.setScissorRect(
          sx, sy,
          Math.max(0, Math.min(cw - sx, Math.round(scissor.w))),
          Math.max(0, Math.min(ch - sy, Math.round(scissor.h))),
        );
      }
      return pass;
    };
    const endPass = () => { pass?.end(); pass = null; };
    const snapshotBackdrop = () => {
      endPass();
      if (!cleared) { ensurePass(); endPass(); } // effect before any draw: snapshot the cleared background
      encoder.copyTextureToTexture({ texture: target.tex }, { texture: this.backdropTex }, [this._texW, this._texH]);
    };

    for (let idx = 0; idx < batches.length; idx++) {
      const batch = batches[idx];
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
          // The source resolves through the shared video_registry (or an
          // explicit media-map override) — _videoSource returns the `<video>`
          // ONLY when it has a current frame, else null (still loading/seeking:
          // nothing to draw, by design — the frame genuinely doesn't exist; the
          // registry's onVideoFrame nudges a repaint when it lands). Mirrors the
          // image path's _imageSource skip-and-notify; NO media registration
          // required, so no create() call site needs a media map.
          const source = this._videoSource(batch.ref);
          if (!source) break;
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
          const ordinal = this._blurOrdinal++;
          if (!pool[ordinal]) {
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
            pool[ordinal] = { uboH, uboV, bgH: mkBG(this.backdropView, uboH), bgV: mkBG(this.tempView, uboV) };
          }
          const { uboH, uboV, bgH, bgV } = pool[ordinal];
          // Sigma is stored in WORLD units and scaled by the CURRENT view, so
          // a blur replayed inside a lens re-render blurs M× more device px —
          // magnified blur looks magnified, matching the old lens-view
          // re-render semantics.
          const sigmaDevice = batch.sigmaWorld * view.zoom * view.dpr;
          d.queue.writeBuffer(uboH, 0, new Float32Array([1, 0, sigmaDevice, 0, 1, 0, 0, 0]));
          d.queue.writeBuffer(uboV, 0, new Float32Array([0, 1, sigmaDevice, 0, batch.opacity, 0, 0, 0]));
          // Blur output only matters inside the content rect, so both passes
          // are scissored to it — at depth 0 that's the whole canvas (no
          // change); inside a lens re-render it bounds the blur cost by the
          // lens rect (the manifest visible-intersection rule; unbounded
          // full-canvas sub-blurs were a measured 3× frame regression). The
          // H pass pads by the kernel's tap reach so the V pass's vertical
          // taps near the content edge read valid H-blurred texels.
          const reach = Math.min(Math.ceil(sigmaDevice * 3), MAX_HALF_KERNEL);
          const clampRect = (r) => {
            const x = Math.max(0, Math.min(this._texW, Math.round(r.x)));
            const y = Math.max(0, Math.min(this._texH, Math.round(r.y)));
            return [x, y,
              Math.max(0, Math.min(this._texW - x, Math.round(r.w))),
              Math.max(0, Math.min(this._texH - y, Math.round(r.h)))];
          };
          // H pass → single-sampled TEMP (count-1 pipeline variant; a
          // fullscreen triangle has no geometric edges — MSAA is pure cost).
          const hPass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.tempView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
          });
          hPass.setPipeline(this.blurPipeTemp);
          hPass.setBindGroup(0, bgH);
          hPass.setScissorRect(...clampRect({ x: -reach, y: -reach, w: cw + 2 * reach, h: ch + 2 * reach }));
          hPass.draw(3);
          hPass.end();
          // V pass composites INTO the content target — through the MSAA
          // attachment (writing the resolved texture directly would leave
          // the stored samples stale, and the next resolve would wipe the
          // blur; see the header's antialiasing note).
          const vPass = encoder.beginRenderPass({
            colorAttachments: [contentAttachment("load")],
          });
          vPass.setPipeline(this.blurPipe);
          vPass.setBindGroup(0, bgV);
          vPass.setScissorRect(...clampRect({ x: 0, y: 0, w: cw, h: ch }));
          vPass.draw(3);
          vPass.end();
          break;
        }
        case "magnify": {
          // Everything the lens can SHOW is bounded by the intersection of
          // its device rect with the content rect (manifest: "Magnifier
          // renders only the VISIBLE lens intersection") — empty means the
          // lens is offscreen: skip it entirely (free culling), soft or sharp.
          const rDev = batch.rWorld * view.zoom * view.dpr;
          const cDevX = (batch.centerWorld.x * view.zoom + view.panX) * view.dpr;
          const cDevY = (batch.centerWorld.y * view.zoom + view.panY) * view.dpr;
          const pad = rDev + AA_MARGIN_DEVICE;
          const visible = intersectRects(
            // Integer-aligned so the re-render's pixel grid lands exactly on
            // the target's (crisp 1:1 sampling), floor/ceil = conservative.
            {
              x: Math.floor(cDevX - pad), y: Math.floor(cDevY - pad),
              w: Math.ceil(pad * 2) + 1, h: Math.ceil(pad * 2) + 1,
            },
            { x: 0, y: 0, w: cw, h: ch },
          );
          if (visible.w === 0 || visible.h === 0) break;
          if (batch.supersample && depth < MAX_SUPERSAMPLE_DEPTH) {
            endPass();
            // Lens view: magnified about the lens center, then shifted so
            // the visible intersection's origin renders at the texture's
            // top-left (device px shift ⇒ pan shift of rect.origin/dpr).
            const lensView = lensRenderView(view, batch.centerWorld, batch.magnification);
            lensView.panX -= visible.x / lensView.dpr;
            lensView.panY -= visible.y / lensView.dpr;
            // Carry an outer scissor (presenter letterbox) into the lens
            // view so an edge lens can't leak outside-camera content.
            let subScissor = { x: 0, y: 0, w: visible.w, h: visible.h };
            if (scissor) subScissor = intersectRects(subScissor, deviceRectThroughViews(scissor, view, lensView));
            const lens = this._lensTarget(depth);
            const use = this._lensUseEntry(this._lensOrdinal++, depth);
            this._writeView(use.viewBuf, lensView);
            // Sample rect: fragment device px q maps to texel (q - origin) /
            // textureSize — the re-render sits in the texture's corner.
            d.queue.writeBuffer(use.rectBuf, 0, new Float32Array([visible.x, visible.y, this._texW, this._texH]));
            this._encodeScene(encoder, batches.slice(0, idx), lensView, use.viewBG,
              { tex: lens.tex, view: lens.view, msaaView: lens.msaaView, contentW: visible.w, contentH: visible.h },
              { background: [0, 0, 0, 0], scissor: subScissor }, depth + 1);
            const p = ensurePass();
            p.setPipeline(this.magnifyPipe);
            p.setBindGroup(1, use.bgByDepth[depth]);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, this.quadBuf);
            p.draw(6, 1, 0, batch.firstSharp); // magnification-1 instance: 1:1 sample of the sharp re-render
          } else {
            snapshotBackdrop();
            const p = ensurePass();
            p.setPipeline(this.magnifyPipe);
            p.setBindGroup(1, this.backdropBG);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, this.quadBuf);
            p.draw(6, 1, 0, batch.firstSoft); // contract-by-1/M instance over the backdrop snapshot
          }
          break;
        }
        default:
          throw new Error(`GpuCompositor: unknown batch type "${batch.type}"`);
      }
    }
    if (!cleared) ensurePass(); // empty scene still clears to background
    endPass();
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
      if (!(current?.type === type && current?.ref === ref) || type === "video") {
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
          // PER-GLYPH VISIBILITY CULLING: only glyphs whose quad touches the
          // canvas rasterize and draw. This is what makes the raised
          // MAX_BUCKET safe — a deep zoom shows only a handful of huge
          // glyphs, so the atlas page holds exactly what's visible instead
          // of entire runs. measure() supplies metrics WITHOUT allocating
          // atlas space; advances accrue for culled glyphs so layout holds.
          const [ma, mb, mtx, mty] = xf; // packXform: [s·cosθ, s·sinθ, tx, ty]
          const panDx = view.panX * view.dpr, panDy = view.panY * view.dpr;
          const cW = this.canvas.width, cH = this.canvas.height;
          // Scale-1 quads (the exact-raster regime, unclamped) can be
          // INTEGER-SNAPPED when unrotated: a 1:1 texture sampled at a
          // fractional device offset loses edge contrast to bilinear blending
          // (measured: top-decile gradient 208 vs 243 native at half-texel);
          // the platform rasterizer handles subpixel coverage internally, a
          // texture copy can't — so align it. Shift ≤ 0.5 device px.
          const snap = mb === 0 && Math.abs(devicePx / bucket - 1) < 0.01;
          let pen = cmd.x;
          for (const ch of cmd.text) {
            const m = this.atlas.measure(ch, bucket, cmd.bold, cmd.font);
            let qx = pen - m.pad * localScale, qy = cmd.y - m.pad * localScale;
            const qw = m.cellW * localScale, qh = m.cellH * localScale;
            pen += m.advance * localScale;
            if (snap) {
              const dScale = ma * scaleDev; // local→device (uniform, unrotated)
              const dx0 = (ma * qx + mtx) * scaleDev + panDx;
              const dy0 = (ma * qy + mty) * scaleDev + panDy;
              qx += (Math.round(dx0) - dx0) / dScale;
              qy += (Math.round(dy0) - dy0) / dScale;
            }
            // Quad's device-space AABB (4 corners — the world may rotate).
            let minDX = Infinity, minDY = Infinity, maxDX = -Infinity, maxDY = -Infinity;
            for (const [lx, ly] of [[qx, qy], [qx + qw, qy], [qx, qy + qh], [qx + qw, qy + qh]]) {
              const dx = (ma * lx - mb * ly + mtx) * scaleDev + panDx;
              const dy = (mb * lx + ma * ly + mty) * scaleDev + panDy;
              if (dx < minDX) minDX = dx;
              if (dx > maxDX) maxDX = dx;
              if (dy < minDY) minDY = dy;
              if (dy > maxDY) maxDY = dy;
            }
            if (maxDX < 0 || minDX > cW || maxDY < 0 || minDY > cH) continue;
            const e = this.atlas.get(ch, bucket, cmd.bold, cmd.font);
            const at = quadInstance("tex", null);
            const f = this.quadArr.f32;
            f.set([qx, qy, qw, qh], at);
            f.set(xf, at + 4);
            f.set([e.u0, e.v0, e.du, e.dv], at + 8);
            f.set(cmd.color, at + 12);
            // Color glyphs (emoji) carry their own RGB in the atlas texel —
            // TEX_MODE.colorGlyph samples it as-is; cmd.color is packed
            // regardless (harmless, ignored by that mode) so the instance
            // layout stays uniform. Monochrome glyphs keep the tinted path.
            f.set([e.color ? TEX_MODE.colorGlyph : TEX_MODE.glyph, cmd.opacity, 0, 0], at + 16);
          }
          break;
        }
        case "image": {
          // A still image draws only once its bitmap is DECODED. An undecoded
          // src → skip the instance entirely (nothing packed, no batch): the
          // frame draws nothing for it, _imageSource has kicked the async
          // decode, and image_registry.onImageLoad wakes a repaint when it
          // lands (the manifest async rule — no silent placeholder graphic).
          if (!this._imageSource(cmd.ref)) break;
          const at = quadInstance("tex", cmd.ref);
          const f = this.quadArr.f32;
          f.set([cmd.x, cmd.y, cmd.w, cmd.h], at);
          f.set(xf, at + 4);
          f.set([0, 0, 1, 1], at + 8);
          f.set([1, 1, 1, 1], at + 12);
          f.set([TEX_MODE.image, cmd.opacity, 0, 0], at + 16);
          break;
        }
        case "video": {
          // A video draws only once its element has a CURRENT frame. No frame
          // yet → skip the instance entirely (nothing packed, no batch): the
          // frame draws nothing for it, _videoSource has kicked element
          // creation, and video_registry.onVideoFrame wakes a repaint when a
          // frame lands (the manifest async rule — no silent placeholder). This
          // mirrors the image op's skip; importExternalTexture re-checks
          // readiness at encode time regardless (see _encodeScene's "video").
          if (!this._videoSource(cmd.ref)) break;
          const at = quadInstance("video", cmd.ref);
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
          // WORLD sigma: the device sigma is view-dependent, and the same
          // batch replays under a lens view inside a lens re-render.
          batches.push({ type: "blur", sigmaWorld: cmd.radius * world.scale, opacity: cmd.opacity });
          break;
        }
        case "magnifyBackdrop": {
          // TWO instances per lens, identical except the magnification param:
          // firstSharp carries 1 (a lens re-render is already magnified —
          // sample it 1:1) and firstSoft carries M (contract the backdrop
          // sample by 1/M). Which one draws is an ENCODE-time choice
          // (supersample flag + recursion depth) — the same batch replays at
          // different depths inside other lenses' re-renders, so both must
          // exist. Instance params are WORLD units; MAGNIFY_WGSL's vertex
          // shader converts through the bound view — view-independent
          // instances are what make the replays correct.
          const centerWorld = T.apply(world, cmd.cx, cmd.cy);
          const rWorld = cmd.r * world.scale;
          const rimW = cmd.rimColor ? cmd.rimWidth : 0;
          const m = rimW / 2 + aaLocal;
          const packLens = (magnification) => {
            const at = this.quadArr.alloc(QUAD_FLOATS);
            const f = this.quadArr.f32;
            f.set([cmd.cx - cmd.r - m, cmd.cy - cmd.r - m, 2 * (cmd.r + m), 2 * (cmd.r + m)], at);
            f.set(xf, at + 4);
            f.set([centerWorld.x, centerWorld.y, rWorld, magnification], at + 8);
            f.set(cmd.rimColor ?? NO_COLOR, at + 12);
            f.set([rimW * world.scale, cmd.opacity, 0, 0], at + 16);
            return at / QUAD_FLOATS;
          };
          batches.push({
            type: "magnify",
            firstSharp: packLens(1),
            firstSoft: packLens(cmd.magnification),
            supersample: cmd.supersample ?? true, // ?? guards hand-built IR that bypassed the builder
            magnification: cmd.magnification,
            centerWorld, rWorld,
          });
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
    for (const t of [this.sceneTex, this.backdropTex, this.tempTex, this.msaaTex, this.atlas.texture]) t?.destroy();
    for (const l of this._lensPool) { l.tex.destroy(); l.msaaTex?.destroy(); }
    for (const u of this._lensUsePool) { u.viewBuf.destroy(); u.rectBuf.destroy(); }
    for (const { texture } of this.imageTextures.values()) texture.destroy();
    this.device.destroy();
  }
}
