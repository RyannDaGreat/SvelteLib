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
 *      lens's re-render falls back to backdrop sampling. A "crop" batch
 *      (manifest ARCHITECTURE PLAN #3, cropSubtree op) is the SAME re-render-
 *      into-a-shared-lens-texture machinery, minimally extended: no
 *      magnification (its view is the outer view, shifted only), a
 *      ROUNDED-RECT SDF mask instead of a circle (gpu/shaders.js CROP_WGSL),
 *      and its "sub-scene" is always ONE self-contained IR list (the crop
 *      target's own commands, packed into their OWN batch array by
 *      _buildFrame's packList — never a slice of the OUTER batches, unlike a
 *      lens, because the target's normal render was already suppressed at
 *      the derivation stage; core/derive.resolveCropTargets).
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

import { flattenIR, DRAW_OPS, rect, ellipse, polyline, polygon, text, blurBackdrop, magnifyBackdrop, cropSubtree, effectSubtree, parseColor } from "../ir.js";
import { richTextDraws } from "../../core/richtext.js";
import { reportOnce } from "../../core/report.js";
import * as T from "../../core/transform.js";
import { SHAPE_WGSL, MESH_WGSL, TEX_WGSL, VIDEO_WGSL, BLUR_WGSL, MAGNIFY_WGSL, CROP_WGSL, EFFECT_WGSL, SHAPE_KIND, TEX_MODE, MAX_HALF_KERNEL } from "./shaders.js";
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
/**
 * Crop-box re-render recursion cap — same guard shape as
 * MAX_SUPERSAMPLE_DEPTH, but a crop box's ONLY fallback for exceeding it is
 * to draw nothing inside the region (unlike a lens, there is no backdrop-
 * sampling soft path to fall back to — a crop box's content is one named
 * subtree, not "everything below"). In practice a crop box's target is
 * suppressed from the normal tree (core/derive.resolveCropTargets), so its
 * own subtree contains no NESTED cropSubtree op targeting the SAME box —
 * this cap exists only to bound a pathological document (e.g. two crop boxes
 * each targeting the other's container) rather than recurse unboundedly.
 */
const MAX_CROP_DEPTH = 1;
/**
 * Effect (shadow/bloom/blend, ir.js effectSubtree) re-render recursion cap —
 * MAX_SUPERSAMPLE_DEPTH + 1, LINKED: an effect must still render inside a
 * lens's depth-1 replay (the manifest's "an effected widget under a lens must
 * magnify with its effects"), one deeper than the lens cap. Depths past the
 * cap are unreachable from plugin-emitted documents (a widget's effect
 * content is its OWN ops — plugins cannot nest effectSubtree inside
 * effectSubtree); only hand-built nested-effect IR gets here, and it skips
 * LOUDLY (reportOnce) rather than recursing unboundedly.
 */
const MAX_EFFECT_DEPTH = MAX_SUPERSAMPLE_DEPTH + 1;
/**
 * The overall re-render nesting bound for CROP batches (replaces the old
 * `depth < MAX_CROP_DEPTH else throw`, whose "unreachable" claim was wrong:
 * a crop batch legitimately appears at depth ≥ 1 inside a supersampling
 * lens's replay — the lens replays every batch below it, crops included —
 * and inside an effect's content, e.g. a bordered image with a drop shadow;
 * throwing there halted the paint loop for a plain crop-box-under-magnifier
 * document). Derivation: the deepest LEGITIMATE chain is lens replay (1) →
 * effect content (2) → stroked-box decoration crop (3), so 4 bounds every
 * real composition with one level of headroom while still stopping a
 * pathological hand-built recursion. PENDING RATIFICATION (a new constant,
 * derived not precedented). At the cap the crop batch skips LOUDLY
 * (reportOnce) — drawing its quad without a re-render would sample stale
 * texels, and throwing bricks the frame for a document the model allows.
 */
const MAX_REENDER_DEPTH = 4;
/** Floats per instance — must match the WGSL attribute layouts. */
const SHAPE_FLOATS = 24; // 6 × vec4
const QUAD_FLOATS = 20;  // 5 × vec4 (tex, video, magnify, effect share this stride)
const MESH_FLOATS = 6;   // pos.xy + rgba
const CROP_FLOATS = 28;  // 7 × vec4 (own stride — see shaders.js CROP_WGSL header for why)

/**
 * The widget blend modes (ir.js BLEND_MODES) as FIXED-FUNCTION premultiplied
 * blend states — no backdrop texture read needed (shaders.js EFFECT_WGSL
 * header derives each): normal = the standard over; add = plain additive;
 * multiply = s·d + d·(1−sa); screen = s + d·(1−s). Alpha channel composites
 * OVER in all but add (coverage accumulates normally; add saturates).
 */
const EFFECT_BLEND_STATES = {
  normal: {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  },
  add: {
    color: { srcFactor: "one", dstFactor: "one" },
    alpha: { srcFactor: "one", dstFactor: "one" },
  },
  multiply: {
    color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  },
  screen: {
    color: { srcFactor: "one", dstFactor: "one-minus-src" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  },
};

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
 * Pure function. A source rect ({sx,sy,sw,sh}, ir.js image/video edge-crop
 * insets) → the quad shader's UV instance [u0, v0, du, dv]. Undefined (a
 * pre-crop op / hand-built IR that predates the source rect) → the full frame
 * [0,0,1,1], keeping such ops byte-identical to before edge-crop existed.
 *
 * @example srcUV(undefined) // [0, 0, 1, 1]
 * @example srcUV({sx: 0.1, sy: 0.2, sw: 0.7, sh: 0.6}) // [0.1, 0.2, 0.7, 0.6]
 */
export function srcUV(src) {
  return src ? [src.sx, src.sy, src.sw, src.sh] : [0, 0, 1, 1];
}

/**
 * Pure function. The view a supersampling lens re-renders its sub-scene under:
 * zoom scaled by `magnification`, pan positioned so the lens's ORIGIN world
 * point renders at the SAME device pixel where the lens CENTER rendered in
 * `view` (i.e. the origin — what the lens magnifies FROM — appears at the lens
 * region center, magnified by M). Rendering into a canvas-sized texture under
 * this view puts the magnified source region exactly over the lens's on-screen
 * region — the lens quad then samples the texture 1:1. This is the GPU form of
 * the old canvas renderRegion's fitRectView(lensSourceRect(...)) lens view.
 *
 * `originWorld` defaults to `centerWorld` (the manifest default: a magnifier
 * with no target magnifies about its own center), which reduces this to the
 * pre-origin behavior — pan recentered so the CENTER stays put — byte-identical.
 *
 * Args:
 *   view (object): {zoom, panX, panY, dpr} outer view
 *   centerWorld (object): {x, y} lens region center in world space
 *   magnification (number): the lens's M (> 0)
 *   originWorld (object): {x, y} the point the lens magnifies FROM (shown at
 *     the region center); defaults to centerWorld
 *
 * Returns:
 *   object: {zoom, panX, panY, dpr}
 *
 * @example lensRenderView({zoom: 1, panX: 0, panY: 0, dpr: 1}, {x: 100, y: 50}, 2) // {zoom: 2, panX: -100, panY: -50, dpr: 1}
 * @example lensRenderView({zoom: 2, panX: 10, panY: 0, dpr: 2}, {x: 0, y: 0}, 3) // {zoom: 6, panX: 10, panY: 0, dpr: 2} (center at origin: pan unchanged)
 * @example lensRenderView({zoom: 1, panX: 0, panY: 0, dpr: 1}, {x: 100, y: 50}, 2, {x: 20, y: 10}) // {zoom: 2, panX: 60, panY: 30, dpr: 1} (origin 20 renders where center 100 was: 100 - 20*2 = 60)
 */
export function lensRenderView(view, centerWorld, magnification, originWorld = centerWorld) {
  return {
    zoom: view.zoom * magnification,
    panX: view.panX + centerWorld.x * view.zoom - originWorld.x * view.zoom * magnification,
    panY: view.panY + centerWorld.y * view.zoom - originWorld.y * view.zoom * magnification,
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
   * text/atlas, blur, magnifier, crop box) so Metal/D3D compile shaders at
   * init instead of stalling the FIRST USER FRAME (~0.5-1.2s measured;
   * FINDINGS). Called by create(); the frame is immediately overwritten by
   * the first real render.
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
      cropSubtree({ x: 0, y: 0, w: 2, h: 2, cornerRadius: 0.5, fill: [0, 0, 0, 1], stroke: [0, 0, 0, 1], strokeWidth: 1, content: [rect({ x: 0, y: 0, w: 2, h: 2, fill: [0, 0, 0, 1] })] }),
      // Effects substrate: shadow + bloom + a non-normal blend in one op —
      // compiles all four EFFECT_WGSL blend-variant pipelines + the blur path.
      effectSubtree({
        x: 0, y: 0, w: 2, h: 2,
        shadow: { dx: 1, dy: 1, blur: 1, color: [0, 0, 0, 1], opacity: 0.5 },
        bloom: { radius: 1, strength: 1 },
        blend: "multiply",
        content: [rect({ x: 0, y: 0, w: 2, h: 2, fill: [0, 0, 0, 1] })],
      }),
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
    this.cropArr = new GrowF32(INITIAL_FLOATS);  // crop-box instances (own stride — CROP_FLOATS)
    this.shapeBuf = null;
    this.quadBuf = null;
    this.meshBuf = null;
    this.cropBuf = null;

    this.viewBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBG = device.createBindGroup({
      layout: this.viewBGL,
      entries: [{ binding: 0, resource: { buffer: this.viewBuf } }],
    });

    this.imageTextures = new Map(); // ref → {texture, bindGroup}
    this._blurPool = [];            // per-blur-use-ordinal {uboH, uboV, bgH, bgV}
    this._lensPool = [];            // per-recursion-depth {tex, view} lens re-render targets (canvas-sized, lazy)
    this._lensUsePool = [];         // per-lens-use-ordinal {viewBuf, viewBG, rectBuf, bgByDepth}
    this._effectPool = [];          // per-recursion-depth {tex, view, msaaTex, msaaView, texB, viewB} effect targets (canvas-sized, lazy)
    this._effectUsePool = [];       // per-effect-use-ordinal {viewBuf, viewBG, rectBuf, uboSH, uboSV, uboBH, uboBV, byDepth}
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
    const make = (label, code, bgls, buffers, sampleCount = this.sampleCount, blendState = null) => {
      const module = d.createShaderModule({ label, code });
      return d.createRenderPipeline({
        label,
        layout: d.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module, entryPoint: "vs", buffers },
        fragment: { module, entryPoint: "fs", targets: [blendState ? { format: this.format, blend: blendState } : target] },
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
    // Crop box: reuses magnifyBGL verbatim (identical group(1) shape: sampler +
    // texture + sample-rect uniform — see shaders.js CROP_WGSL header) with its
    // OWN instance layout (CROP_FLOATS; box+radius+fill+stroke don't fit the
    // quad stride's 5 vec4s).
    const cropInstLayout = { arrayStride: CROP_FLOATS * 4, stepMode: "instance", attributes: vec4attrs([1, 2, 3, 4, 5, 6, 7]) };
    this.cropPipe = make("ir-crop", CROP_WGSL, [this.viewBGL, this.magnifyBGL], [cornerLayout, cropInstLayout]);
    // Blur V composites INTO the content target (MSAA attachment — content
    // sample count); blur H renders into the single-sampled TEMP and needs a
    // count-1 variant. Same shader; only the pipeline multisample state
    // differs. With antialiasing off the two are the same descriptor — reuse.
    this.blurPipe = make("ir-blur", BLUR_WGSL, [this.blurBGL], []);
    this.blurPipeTemp = this.sampleCount > 1 ? make("ir-blur-temp", BLUR_WGSL, [this.blurBGL], [], 1) : this.blurPipe;
    // Effect composite quads (shaders.js EFFECT_WGSL — the Round-12D effects
    // substrate): ONE shader, FOUR pipeline variants differing only in their
    // fixed-function blend state (EFFECT_BLEND_STATES). The widget quad draws
    // through effectPipes[batch.blend]; the shadow quad always through
    // `normal` (a shadow composites over); bloom always through `add` (the
    // manifest's ADD-composited own blur). Group(1) = magnifyBGL (the shared
    // sampler + texture + sample-rect layout), instances in the QUAD stride.
    this.effectPipes = Object.fromEntries(Object.entries(EFFECT_BLEND_STATES).map(([mode, blendState]) =>
      [mode, make(`ir-effect-${mode}`, EFFECT_WGSL, [this.viewBGL, this.magnifyBGL], [cornerLayout, quadInstLayout], this.sampleCount, blendState)]));

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
    for (const e of this._effectPool) { e.tex.destroy(); e.msaaTex?.destroy(); e.texB.destroy(); }
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
    this._effectPool = []; // canvas-sized: recreated lazily at the new size
    for (const u of this._effectUsePool) { u.viewBuf.destroy(); u.rectBuf.destroy(); u.uboSH.destroy(); u.uboSV.destroy(); u.uboBH.destroy(); u.uboBV.destroy(); }
    this._effectUsePool = []; // byDepth entries referenced the old effect views
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
   * Query+Command (allocates on first use). The EFFECT re-render targets for a
   * recursion depth (the Round-12D effects substrate — ir.js effectSubtree):
   * `tex` (A) holds the widget's own isolated render (+ MSAA companion, a
   * content target like a lens); `texB` (B) holds its Gaussian-blurred copy
   * (blur output — single-sampled, fullscreen passes have no geometric edges).
   * A DISTINCT pool from _lensPool: an effect inside a lens replay runs at the
   * SAME depth index the lens texture is mid-use at, so sharing would clobber.
   * Canvas-sized + only the visible intersection rendered (corner convention),
   * so cost is bounded by the screen exactly like a lens (the manifest
   * lens ∩ viewport rule).
   */
  _effectTarget(depth) {
    if (!this._effectPool[depth]) {
      const limit = this.device.limits.maxTextureDimension2D;
      let w = this._texW, h = this._texH;
      if (w > limit || h > limit) {
        console.error(`GpuCompositor: effect texture ${w}x${h} exceeds maxTextureDimension2D ${limit} — clamping (this should be impossible: effect work is bounded by the canvas)`);
        w = Math.min(w, limit);
        h = Math.min(h, limit);
      }
      const RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
      const tex = this.device.createTexture({ label: `ir-effect-${depth}`, size: [w, h], format: this.format, usage: RT | TB });
      const msaaTex = this.sampleCount > 1
        ? this.device.createTexture({ label: `ir-effect-msaa-${depth}`, size: [w, h], format: this.format, usage: RT, sampleCount: this.sampleCount })
        : null;
      const texB = this.device.createTexture({ label: `ir-effect-blur-${depth}`, size: [w, h], format: this.format, usage: RT | TB });
      this._effectPool[depth] = {
        tex, view: tex.createView(),
        msaaTex, msaaView: msaaTex?.createView() ?? null,
        texB, viewB: texB.createView(),
      };
    }
    return this._effectPool[depth];
  }

  /**
   * Query+Command (allocates on first use). Per-effect-USE GPU resources for
   * one frame (the _lensUseEntry pattern — every use needs its OWN uniform
   * buffers because queue writes all land before the encoder executes):
   * the content re-render's view uniform, the quads' shared sample-rect
   * uniform, FOUR blur uniform buffers (shadow H/V + bloom H/V — two blurs
   * with different sigmas may run in one use), and per-depth bind groups:
   * bgA (sample the widget render), bgB (sample the blurred copy),
   * bgBlurH (blur pass reading A), bgBlurV (blur pass reading TEMP).
   */
  _effectUseEntry(ordinal, depth) {
    const d = this.device;
    if (!this._effectUsePool[ordinal]) {
      const viewBuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const viewBG = d.createBindGroup({ layout: this.viewBGL, entries: [{ binding: 0, resource: { buffer: viewBuf } }] });
      const rectBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const mkUbo = () => d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._effectUsePool[ordinal] = { viewBuf, viewBG, rectBuf, uboSH: mkUbo(), uboSV: mkUbo(), uboBH: mkUbo(), uboBV: mkUbo(), byDepth: [] };
    }
    const entry = this._effectUsePool[ordinal];
    if (!entry.byDepth[depth]) {
      const pool = this._effectTarget(depth);
      const mkQuadBG = (texView) => d.createBindGroup({
        layout: this.magnifyBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texView },
          { binding: 2, resource: { buffer: entry.rectBuf } },
        ],
      });
      const mkBlurBG = (srcView, ubo) => d.createBindGroup({
        layout: this.blurBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: srcView },
          { binding: 2, resource: { buffer: ubo } },
        ],
      });
      entry.byDepth[depth] = {
        bgA: mkQuadBG(pool.view),
        bgB: mkQuadBG(pool.viewB),
        bgBlurSH: mkBlurBG(pool.view, entry.uboSH),
        bgBlurSV: mkBlurBG(this.tempView, entry.uboSV),
        bgBlurBH: mkBlurBG(pool.view, entry.uboBH),
        bgBlurBV: mkBlurBG(this.tempView, entry.uboBV),
      };
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
    this.cropBuf = upload(this.cropArr, this.cropBuf, "ir-crop-inst");

    // Per-frame effect-use ordinals, shared across lens re-renders: every
    // blur/lens USE gets its own uniform buffers, because queue writes all
    // land before the encoder's passes execute — one buffer written twice in
    // a frame would make the last write win for every pass that reads it.
    this._blurOrdinal = 0;
    this._lensOrdinal = 0;
    this._effectOrdinal = 0;
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
          // A CIRCLE lens uses its radius; a BOX lens (shape === "box") uses
          // its half-extents (the crop case's convention) and draws through the
          // rounded-rect crop pipeline instead — the SHAPED-LENS family: one
          // encode path, two region shapes.
          const isBox = batch.shape === "box";
          const cDevX = (batch.centerWorld.x * view.zoom + view.panX) * view.dpr;
          const cDevY = (batch.centerWorld.y * view.zoom + view.panY) * view.dpr;
          const padX = (isBox ? batch.halfWWorld : batch.rWorld) * view.zoom * view.dpr + AA_MARGIN_DEVICE;
          const padY = (isBox ? batch.halfHWorld : batch.rWorld) * view.zoom * view.dpr + AA_MARGIN_DEVICE;
          const visible = intersectRects(
            // Integer-aligned so the re-render's pixel grid lands exactly on
            // the target's (crisp 1:1 sampling), floor/ceil = conservative.
            {
              x: Math.floor(cDevX - padX), y: Math.floor(cDevY - padY),
              w: Math.ceil(padX * 2) + 1, h: Math.ceil(padY * 2) + 1,
            },
            { x: 0, y: 0, w: cw, h: ch },
          );
          if (visible.w === 0 || visible.h === 0) break;
          const pipe = isBox ? this.cropPipe : this.magnifyPipe;
          const instBuf = isBox ? this.cropBuf : this.quadBuf;
          if (batch.supersample && depth < MAX_SUPERSAMPLE_DEPTH) {
            endPass();
            // Lens view: magnified about the ORIGIN (positioned so the origin
            // renders where the lens center did — magnifier "target"; default
            // origin=center reduces to magnify-about-center), then shifted so
            // the visible intersection's origin renders at the texture's
            // top-left (device px shift ⇒ pan shift of rect.origin/dpr).
            const lensView = lensRenderView(view, batch.centerWorld, batch.magnification, batch.originWorld);
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
            p.setPipeline(pipe);
            p.setBindGroup(1, use.bgByDepth[depth]);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, instBuf);
            p.draw(6, 1, 0, batch.firstSharp); // magnification-1 instance: 1:1 sample of the sharp re-render
          } else {
            snapshotBackdrop();
            const p = ensurePass();
            p.setPipeline(pipe);
            p.setBindGroup(1, this.backdropBG);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, instBuf);
            p.draw(6, 1, 0, batch.firstSoft); // contract-by-1/M instance over the backdrop snapshot
          }
          break;
        }
        case "crop": {
          // Same visible-intersection bound as a lens (manifest: bound re-
          // render work by lens ∩ viewport — the SAME rule applies to a crop
          // box's re-render, it's just a rounded-rect region instead of a
          // circle). Empty intersection = offscreen: skip entirely.
          const cDevX = (batch.centerWorld.x * view.zoom + view.panX) * view.dpr;
          const cDevY = (batch.centerWorld.y * view.zoom + view.panY) * view.dpr;
          const padX = batch.halfWWorld * view.zoom * view.dpr + AA_MARGIN_DEVICE;
          const padY = batch.halfHWorld * view.zoom * view.dpr + AA_MARGIN_DEVICE;
          const visible = intersectRects(
            { x: Math.floor(cDevX - padX), y: Math.floor(cDevY - padY), w: Math.ceil(padX * 2) + 1, h: Math.ceil(padY * 2) + 1 },
            { x: 0, y: 0, w: cw, h: ch },
          );
          if (visible.w === 0 || visible.h === 0) break;
          if (depth < MAX_REENDER_DEPTH) {
            endPass();
            // No magnification (see shaders.js CROP_WGSL header) — the crop's
            // own view IS the outer view, just shifted so the visible
            // intersection's origin renders at the re-render texture's
            // top-left (the same device-px-shift-⇒-pan-shift trick a lens
            // uses, with magnification pinned to 1).
            const cropView = { zoom: view.zoom, panX: view.panX - visible.x / view.dpr, panY: view.panY - visible.y / view.dpr, dpr: view.dpr };
            let subScissor = { x: 0, y: 0, w: visible.w, h: visible.h };
            if (scissor) subScissor = intersectRects(subScissor, deviceRectThroughViews(scissor, view, cropView));
            const lens = this._lensTarget(depth); // shared pool — see gpu/shaders.js CROP_WGSL header
            const use = this._lensUseEntry(this._lensOrdinal++, depth);
            this._writeView(use.viewBuf, cropView);
            d.queue.writeBuffer(use.rectBuf, 0, new Float32Array([visible.x, visible.y, this._texW, this._texH]));
            this._encodeScene(encoder, batch.contentBatches, cropView, use.viewBG,
              { tex: lens.tex, view: lens.view, msaaView: lens.msaaView, contentW: visible.w, contentH: visible.h },
              { background: [0, 0, 0, 0], scissor: subScissor }, depth + 1);
            const p = ensurePass();
            p.setPipeline(this.cropPipe);
            p.setBindGroup(1, use.bgByDepth[depth]);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, this.cropBuf);
            p.draw(6, 1, 0, batch.first);
          } else {
            // Nesting cap (see MAX_REENDER_DEPTH's doc — the old throw's
            // "unreachable" claim was wrong: crops legitimately replay inside
            // lens re-renders and effect contents). Unreachable for real
            // documents (deepest legit chain is 3); a pathological hand-built
            // nesting skips the crop LOUDLY — its quad would sample stale
            // texels without a re-render, and throwing would brick the frame.
            reportOnce("crop-reender-depth", `GpuCompositor: crop re-render nesting exceeded MAX_REENDER_DEPTH (${MAX_REENDER_DEPTH}) — skipping the crop region (pathological nesting)`);
          }
          break;
        }
        case "effect": {
          // THE EFFECTS SUBSTRATE (manifest Round 12D; ir.js effectSubtree):
          // re-render the widget's own content into the effect texture A
          // (crop's corner/device-shift convention, magnification 1), blur
          // A→TEMP→B where needed, then composite quads: SHADOW (B, tinted,
          // offset, over) UNDER → WIDGET (A, through the blend-mode pipeline)
          // → BLOOM (B re-blurred, additive) ON TOP.
          const zd = view.zoom * view.dpr;
          const cDevX = (batch.centerWorld.x * view.zoom + view.panX) * view.dpr;
          const cDevY = (batch.centerWorld.y * view.zoom + view.panY) * view.dpr;
          const offDev = { x: batch.offsetWorld.x * zd, y: batch.offsetWorld.y * zd };
          const marginDev = batch.marginWorld * zd;
          const offLen = Math.hypot(offDev.x, offDev.y);
          // Skip test: the drawn OUTPUT (widget + halo + shifted shadow) vs
          // the content rect — empty = fully offscreen, free culling.
          const padX = batch.halfWWorld * zd + marginDev + offLen + AA_MARGIN_DEVICE;
          const padY = batch.halfHWorld * zd + marginDev + offLen + AA_MARGIN_DEVICE;
          const outVisible = intersectRects(
            { x: Math.floor(cDevX - padX), y: Math.floor(cDevY - padY), w: Math.ceil(padX * 2) + 1, h: Math.ceil(padY * 2) + 1 },
            { x: 0, y: 0, w: cw, h: ch },
          );
          if (outVisible.w === 0 || outVisible.h === 0) break;
          if (depth >= MAX_EFFECT_DEPTH) {
            // Unreachable from plugin-emitted documents (see the constant's
            // doc); pathological hand-built nesting skips LOUDLY.
            reportOnce("effect-reender-depth", `GpuCompositor: effect re-render nesting exceeded MAX_EFFECT_DEPTH (${MAX_EFFECT_DEPTH}) — skipping the effected widget (pathological nesting)`);
            break;
          }
          // Source region: the widget footprint ∩ the content rect INFLATED
          // by the blur reach + shadow offset — the offscreen-but-nearby
          // source pixels whose blurred halo / shifted shadow lands on
          // screen. Bounded by the canvas texture size (integer-aligned,
          // corner convention — the lens rule: cost ≤ one screen).
          const sigmaSDev = batch.shadowSigmaWorld * zd;
          const sigmaBDev = batch.bloomSigmaWorld * zd;
          const reach = Math.min(Math.ceil(Math.max(sigmaSDev, sigmaBDev) * 3), MAX_HALF_KERNEL);
          const srcPadX = batch.halfWWorld * zd + AA_MARGIN_DEVICE;
          const srcPadY = batch.halfHWorld * zd + AA_MARGIN_DEVICE;
          const inflate = Math.ceil(reach + offLen);
          const rawSrc = intersectRects(
            { x: Math.floor(cDevX - srcPadX), y: Math.floor(cDevY - srcPadY), w: Math.ceil(srcPadX * 2) + 1, h: Math.ceil(srcPadY * 2) + 1 },
            { x: -inflate, y: -inflate, w: cw + 2 * inflate, h: ch + 2 * inflate },
          );
          // Cap at the texture size (the lens economics: a source region can
          // never exceed one canvas of pixels; a truncated far edge only ever
          // affects content already offscreen past the inflation band).
          const srcVisible = { x: rawSrc.x, y: rawSrc.y, w: Math.min(rawSrc.w, this._texW), h: Math.min(rawSrc.h, this._texH) };
          if (srcVisible.w === 0 || srcVisible.h === 0) break; // widget itself fully out of reach
          endPass();
          // Content re-render at the OUTER view, shifted so srcVisible's
          // origin lands at the texture corner (the crop-view trick, mag 1).
          const effView = { zoom: view.zoom, panX: view.panX - srcVisible.x / view.dpr, panY: view.panY - srcVisible.y / view.dpr, dpr: view.dpr };
          let subScissor = { x: 0, y: 0, w: srcVisible.w, h: srcVisible.h };
          if (scissor) {
            // The incoming scissor is an OUTPUT bound (presenter letterbox, or
            // a lens replay's visible-intersection). The effect's SOURCE
            // legitimately extends (blur reach + shadow offset) beyond the
            // output it feeds — a widget just past the bound still casts its
            // shadow/halo into it — so inflate before mapping onto the source
            // re-render (without this, a lens's carried scissor clipped the
            // source to a sliver and the lens showed a blank effect).
            const inflated = { x: scissor.x - inflate, y: scissor.y - inflate, w: scissor.w + 2 * inflate, h: scissor.h + 2 * inflate };
            subScissor = intersectRects(subScissor, deviceRectThroughViews(inflated, view, effView));
          }
          const pool = this._effectTarget(depth);
          const use = this._effectUseEntry(this._effectOrdinal++, depth);
          this._writeView(use.viewBuf, effView);
          d.queue.writeBuffer(use.rectBuf, 0, new Float32Array([srcVisible.x, srcVisible.y, this._texW, this._texH]));
          this._encodeScene(encoder, batch.contentBatches, effView, use.viewBG,
            { tex: pool.tex, view: pool.view, msaaView: pool.msaaView, contentW: srcVisible.w, contentH: srcVisible.h },
            { background: [0, 0, 0, 0], scissor: subScissor }, depth + 1);
          const bgs = use.byDepth[depth];
          // Separable Gaussian A→TEMP→B at `sigma` (BLUR_WGSL, opacity 1 both
          // passes — B holds the PLAIN blurred copy; strength/opacity apply on
          // the composite quad). Whole-attachment clears keep out-of-region
          // texels transparent; scissors pad by the tap reach so edge taps
          // read valid blurred texels (the blurBackdrop scissor rule).
          const blurAtoB = (sigma, uboH, uboV, bgH, bgV) => {
            endPass(); // a content pass may be open (e.g. the widget quad before a bloom blur) — one pass at a time per encoder
            d.queue.writeBuffer(uboH, 0, new Float32Array([1, 0, sigma, 0, 1, 0, 0, 0]));
            d.queue.writeBuffer(uboV, 0, new Float32Array([0, 1, sigma, 0, 1, 0, 0, 0]));
            const r = Math.min(Math.ceil(sigma * 3), MAX_HALF_KERNEL);
            const sw = Math.min(this._texW, srcVisible.w + 2 * r), sh = Math.min(this._texH, srcVisible.h + 2 * r);
            const runPass = (targetView, bg) => {
              const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: targetView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
              });
              pass.setPipeline(this.blurPipeTemp); // count-1: TEMP and B are single-sampled
              pass.setBindGroup(0, bg);
              pass.setScissorRect(0, 0, sw, sh);
              pass.draw(3);
              pass.end();
            };
            runPass(this.tempView, bgH);
            runPass(pool.viewB, bgV);
          };
          const drawQuad = (pipe, bg, first) => {
            const p = ensurePass();
            p.setPipeline(pipe);
            p.setBindGroup(1, bg);
            p.setVertexBuffer(0, this.cornerBuf);
            p.setVertexBuffer(1, this.quadBuf);
            p.draw(6, 1, 0, first);
          };
          if (batch.firstShadow >= 0) {
            blurAtoB(sigmaSDev, use.uboSH, use.uboSV, bgs.bgBlurSH, bgs.bgBlurSV);
            drawQuad(this.effectPipes.normal, bgs.bgB, batch.firstShadow); // shadow composites OVER, under the widget
          }
          if (!batch.shadowOnly) {
            drawQuad(this.effectPipes[batch.blend], bgs.bgA, batch.firstContent);
            if (batch.firstBloom >= 0) {
              blurAtoB(sigmaBDev, use.uboBH, use.uboBV, bgs.bgBlurBH, bgs.bgBlurBV);
              drawQuad(this.effectPipes.add, bgs.bgB, batch.firstBloom); // ADD-composited own blur (Round 12D)
            }
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
   * Query (touches the atlas ctx.font). The per-RUN measure seam the SHARED
   * rich-text layout (core/richtext.layoutRichText) needs: (text, runStyle) →
   * {width, ascent, descent} at the run's NOMINAL size, from the atlas's
   * canvas2D. This is what makes ONE layout serve both backends — the GPU
   * injects THIS, the PDF backend injects its own equivalent, and both get the
   * SAME positions. Rebuilt per rich op (cheap: a bound closure).
   */
  _richMeasure() {
    return (str, style) => this.atlas.measureText(str, style.size ?? 36, !!style.bold, style.font ?? "system", !!style.italic);
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
    this.cropArr.reset();

    const scaleDev = view.zoom * view.dpr;
    const NO_COLOR = [0, 0, 0, 0];

    // packList packs one flattened IR list into its OWN batch array (so a
    // cropSubtree's `content` — a SEPARATE self-contained IR list, the
    // target's own commands, NOT a prefix of the outer command stream like a
    // lens's z-order slice — gets batches the outer walk never iterates
    // directly, only the crop's own re-render pass does) while sharing the
    // SAME underlying staging float arrays (shapeArr/quadArr/meshArr/cropArr
    // reset ONCE per _buildFrame call, at the top — see render()'s call
    // site; a second reset mid-build would destroy everything packed so
    // far, so content is packed by RECURSIVE CALL, never a second
    // _buildFrame). Returns that content's own batch list.
    const packList = (flatList) => {
      const batches = [];
      const box = { current: null }; // {type, ref} accumulating batch, scoped to THIS list
      const shapeInstance = () => {
        if (!(box.current?.type === "shape")) {
          box.current = { type: "shape", first: this.shapeArr.used / SHAPE_FLOATS, count: 0 };
          batches.push(box.current);
        }
        box.current.count++;
        return this.shapeArr.alloc(SHAPE_FLOATS);
      };
      const quadInstance = (type, ref) => {
        if (!(box.current?.type === type && box.current?.ref === ref) || type === "video") {
          box.current = { type, ref, first: this.quadArr.used / QUAD_FLOATS, count: 0 };
          batches.push(box.current);
        }
        box.current.count++;
        return this.quadArr.alloc(QUAD_FLOATS);
      };
      const meshInstance = (vertexCount) => {
        if (!(box.current?.type === "mesh")) {
          box.current = { type: "mesh", firstVertex: this.meshArr.used / MESH_FLOATS, vertexCount: 0 };
          batches.push(box.current);
        }
        box.current.vertexCount += vertexCount;
        return this.meshArr.alloc(vertexCount * MESH_FLOATS);
      };
      for (const flatCmd of flatList) packOne(flatCmd, batches, box, shapeInstance, quadInstance, meshInstance);
      return batches;
    };

    const packOne = ({ cmd, world }, batches, box, shapeInstance, quadInstance, meshInstance) => {
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
          const at = meshInstance(triCount * 3);
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
          const [ma, mb, mtx, mty] = xf; // packXform: [s·cosθ, s·sinθ, tx, ty]
          const panDx = view.panX * view.dpr, panDy = view.panY * view.dpr;
          const cW = this.canvas.width, cH = this.canvas.height;

          // packRun draws ONE single-run text run (chars from `str`) whose glyph
          // TOPS sit at localY, pen starting at localX. Extracted so the rich
          // path calls it once per laid-out glyph run (top-anchored to the
          // SHARED line baseline) and the legacy single-run path calls it once.
          // `italic` selects the synthesized-oblique face IN THE ATLAS (real
          // italic if the face has one, else rasterizer oblique) — a true
          // oblique glyph shape, no shader change (see glyph_atlas.fontString).
          const packRun = (str, localX, localY, size, bold, font, color, opacity, italic) => {
            const devicePx = size * world.scale * scaleDev;
            const bucket = bucketFor(devicePx);
            const localScale = size / bucket;
            // Scale-1 quads (exact-raster, unrotated) INTEGER-SNAP: a 1:1 texture
            // at a fractional device offset loses edge contrast to bilinear
            // blending — align it (shift ≤ 0.5 device px).
            const snap = mb === 0 && Math.abs(devicePx / bucket - 1) < 0.01;
            let pen = localX;
            for (const ch of str) {
              const m = this.atlas.measure(ch, bucket, bold, font, italic);
              let qx = pen - m.pad * localScale, qy = localY - m.pad * localScale;
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
              const e = this.atlas.get(ch, bucket, bold, font, italic);
              const at = quadInstance("tex", null);
              const f = this.quadArr.f32;
              f.set([qx, qy, qw, qh], at);
              f.set(xf, at + 4);
              f.set([e.u0, e.v0, e.du, e.dv], at + 8);
              f.set(color, at + 12);
              // Color glyphs (emoji) carry their own RGB — TEX_MODE.colorGlyph
              // samples as-is; monochrome glyphs are tinted by `color`.
              f.set([e.color ? TEX_MODE.colorGlyph : TEX_MODE.glyph, opacity, 0, 0], at + 16);
            }
          };

          if (cmd.rich) {
            // RICH TEXT: run the SHARED pure layout (core/richtext.js) with an
            // atlas-backed measure seam, then pack each positioned run + each
            // underline/strike line. ONE layout, two backends (parity lever).
            const draws = richTextDraws(cmd, this._richMeasure());
            for (const d of draws.textDraws) {
              // Top-anchor this run at (baselineY − its face ascent) so mixed-
              // size runs share the layout's baseline (matches packRun's own
              // top-anchor convention: glyph baseline = top + ascent·localScale).
              const devicePx = d.size * world.scale * scaleDev;
              const bkt = bucketFor(devicePx);
              const ls = d.size / bkt;
              const asc = this.atlas.measure("Mg", bkt, d.bold, d.font, d.italic).ascent * ls;
              // Run colors are hex strings (runs store hex) — parse to rgba
              // floats (parseColor is memoized, so per-run parsing is cheap).
              packRun(d.text, d.x, d.baselineY - asc, d.size, d.bold, d.font, parseColor(d.color), d.opacity, d.italic);
            }
            // Underline / strike as thin axis-aligned filled rects in local
            // space (crisp bars via the rect SDF; local, so the run's world
            // xform rotates/scales them with the text).
            for (const ln of draws.lines) {
              const at = shapeInstance();
              const f = this.shapeArr.f32;
              const half = ln.thickness / 2;
              f.set([ln.x, ln.y - half, ln.w, ln.thickness], at);
              f.set(xf, at + 4);
              f.set(parseColor(ln.color), at + 8); // fill (hex → rgba floats)
              f.set(NO_COLOR, at + 12);            // no stroke
              f.set([ln.x + ln.w / 2, ln.y, ln.w / 2, half], at + 16); // rect center/half for the SDF
              f.set([SHAPE_KIND.rect, 0, ln.opacity, 0], at + 20);
            }
          } else {
            // LEGACY single-run text op (parity scenes, hand-built IR): one run
            // top-anchored at cmd.y, exactly as before.
            packRun(cmd.text, cmd.x, cmd.y, cmd.size, cmd.bold, cmd.font, cmd.color, cmd.opacity, false);
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
          // Source UV rect (edge-crop insets): the (u0,v0,du,dv) the quad
          // shader samples. Full-frame default {0,0,1,1} → unchanged from the
          // pre-crop op; a cropped source draws that sub-rect over the quad.
          f.set(srcUV(cmd.src), at + 8);
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
          // Source UV rect (edge-crop insets) — same as the image op.
          f.set(srcUV(cmd.src), at + 8);
          f.set([1, 1, 1, 1], at + 12);
          f.set([TEX_MODE.image, cmd.opacity, 0, 0], at + 16);
          break;
        }
        case "blurBackdrop": {
          box.current = null;
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
          // exist. Instance params are WORLD units; the vertex shader converts
          // through the bound view — view-independent instances are what make
          // the replays correct. The ORIGIN (what the lens magnifies AROUND —
          // manifest "magnifier target") defaults to the region center, so a
          // magnifier with no target is byte-identical to before origin existed.
          const centerWorld = T.apply(world, cmd.cx, cmd.cy);
          const originWorld = T.apply(world, cmd.originX, cmd.originY);
          if (cmd.shape === "box") {
            // BOX magnifier — the ROUNDED-RECT half of the shaped-lens family.
            // Renders through the SAME crop pipeline (rrect SDF + border) a crop
            // box uses, but with magnification (crop = magnification 1) and the
            // z-prefix as content (crop = a named subtree). Border = the shared
            // stroked-box bundle (stroke/strokeWidth). Two crop-style instances
            // (sharp mag=1 / soft mag=M), mirroring the circle lens's split.
            const halfWWorld = cmd.halfW * world.scale, halfHWorld = cmd.halfH * world.scale;
            const strokeW = cmd.stroke ? cmd.strokeWidth : 0;
            const m = strokeW / 2 + aaLocal;
            // Same sampleAnchor rule as the circle path (CROP_WGSL's rDev.zw):
            // center for the sharp instance, origin for the soft.
            const packBoxLens = (magnification, anchor) => {
              const at = this.cropArr.alloc(CROP_FLOATS);
              const f = this.cropArr.f32;
              f.set([cmd.cx - cmd.halfW - m, cmd.cy - cmd.halfH - m, 2 * (cmd.halfW + m), 2 * (cmd.halfH + m)], at);
              f.set(xf, at + 4);
              f.set([centerWorld.x, centerWorld.y, halfWWorld, halfHWorld], at + 8);
              // rDev = (cornerRadius, magnification, sampleAnchorWorldX, sampleAnchorWorldY)
              f.set([cmd.cornerRadius * world.scale, magnification, anchor.x, anchor.y], at + 12);
              f.set(NO_COLOR, at + 16);                       // a magnifier has no fill (lens content fills it)
              f.set(cmd.stroke ?? NO_COLOR, at + 20);
              f.set([strokeW * world.scale, cmd.opacity, 0, 0], at + 24);
              return at / CROP_FLOATS;
            };
            batches.push({
              type: "magnify", shape: "box",
              firstSharp: packBoxLens(1, centerWorld),
              firstSoft: packBoxLens(cmd.magnification, originWorld),
              supersample: cmd.supersample ?? true,
              magnification: cmd.magnification,
              centerWorld, originWorld, halfWWorld, halfHWorld,
            });
            box.current = null;
            break;
          }
          const rWorld = cmd.r * world.scale;
          const rimW = cmd.rimColor ? cmd.rimWidth : 0;
          const m = rimW / 2 + aaLocal;
          // sampleAnchor = the world point shown at the lens center: the CENTER
          // for the sharp instance (the re-render was positioned so origin maps
          // there — the shader samples 1:1) and the ORIGIN for the soft
          // instance (over the un-repositioned backdrop). Default origin=center
          // ⇒ both are center ⇒ byte-identical to before origin.
          const packLens = (magnification, anchor) => {
            const at = this.quadArr.alloc(QUAD_FLOATS);
            const f = this.quadArr.f32;
            f.set([cmd.cx - cmd.r - m, cmd.cy - cmd.r - m, 2 * (cmd.r + m), 2 * (cmd.r + m)], at);
            f.set(xf, at + 4);
            f.set([centerWorld.x, centerWorld.y, rWorld, magnification], at + 8);
            f.set(cmd.rimColor ?? NO_COLOR, at + 12);
            // misc = (rimWidthWorld, opacity, sampleAnchorWorldX, sampleAnchorWorldY)
            f.set([rimW * world.scale, cmd.opacity, anchor.x, anchor.y], at + 16);
            return at / QUAD_FLOATS;
          };
          batches.push({
            type: "magnify", shape: "circle",
            firstSharp: packLens(1, centerWorld),
            firstSoft: packLens(cmd.magnification, originWorld),
            supersample: cmd.supersample ?? true, // ?? guards hand-built IR that bypassed the builder
            magnification: cmd.magnification,
            centerWorld, originWorld, rWorld,
          });
          box.current = null; // effects never merge with a following batch
          break;
        }
        case "cropSubtree": {
          // ONE instance (no sharp/soft split — a crop box always re-renders
          // its named target 1:1; see shaders.js CROP_WGSL header). `content`
          // is a SEPARATE self-contained IR list (the target's own commands,
          // already wrapped in the relative transform by sceneIR) — packed by
          // a RECURSIVE packList call into its OWN batch array (contentBatches)
          // so the outer walk (and _encodeScene's top-level loop) never draws
          // it directly; only the crop's own re-render pass does. This is the
          // structural difference from a magnify lens (whose sub-content is a
          // PREFIX of the outer stream, legitimately drawn both normally and
          // replayed) — a crop target's normal render was already SUPPRESSED
          // at the derivation stage (core/derive.resolveCropTargets), so its
          // IR exists ONLY inside this op.
          const m = (cmd.strokeWidth ?? 0) / 2 + aaLocal;
          const at = this.cropArr.alloc(CROP_FLOATS);
          const f = this.cropArr.f32;
          const cxWorld = cmd.x + cmd.w / 2, cyWorld = cmd.y + cmd.h / 2;
          const centerWorld = T.apply(world, cxWorld, cyWorld);
          f.set([cmd.x - m, cmd.y - m, cmd.w + 2 * m, cmd.h + 2 * m], at);
          f.set(xf, at + 4);
          f.set([centerWorld.x, centerWorld.y, (cmd.w / 2) * world.scale, (cmd.h / 2) * world.scale], at + 8);
          // rDev = (cornerRadius, magnification, originWorldX, originWorldY). A
          // crop box re-renders its target 1:1 → magnification 1 + origin =
          // center makes CROP_WGSL's contraction a no-op (q_src = p), so this
          // is byte-identical to the pre-shaped-lens crop packing (the two
          // trailing zeros became mag=1 + the center, all consumed to q_src=p).
          f.set([cmd.cornerRadius * world.scale, 1, centerWorld.x, centerWorld.y], at + 12);
          f.set(cmd.fill ?? NO_COLOR, at + 16);
          f.set(cmd.stroke ?? NO_COLOR, at + 20);
          f.set([(cmd.strokeWidth ?? 0) * world.scale, cmd.opacity, 0, 0], at + 24);
          const contentBatches = packList(flattenIR(cmd.content));
          batches.push({
            type: "crop",
            first: at / CROP_FLOATS,
            centerWorld,
            halfWWorld: cmd.w / 2, halfHWorld: cmd.h / 2,
            contentBatches,
          });
          box.current = null; // effects never merge with a following batch
          break;
        }
        case "effectSubtree": {
          // THE EFFECTS SUBSTRATE (manifest Round 12D; shaders.js EFFECT_WGSL
          // header). Up to THREE quad instances share the QUAD stride
          // (shadow / widget / bloom — which draw is an encode-time choice,
          // like the lens's sharp/soft split): local rect = the widget bbox
          // inflated by the effect margin (blur halo; the shadow offset is
          // inside `margin` too — ir.js computes it) + the AA hair. Instance
          // lanes (EFFECT_WGSL): quad | xform | (offsetWorld, 0, 0) | tint |
          // (mode, alpha, 0, 0). Offsets/sigmas are WORLD units scaled by
          // world.scale — view-independent instances replay correctly inside
          // lens re-renders (the shaped-lens nesting rule).
          const m = cmd.margin + aaLocal;
          const qx = cmd.x - m, qy = cmd.y - m, qw = cmd.w + 2 * m, qh = cmd.h + 2 * m;
          const packEffectQuad = (offX, offY, tint, mode, alpha) => {
            const at = this.quadArr.alloc(QUAD_FLOATS);
            const f = this.quadArr.f32;
            f.set([qx, qy, qw, qh], at);
            f.set(xf, at + 4);
            f.set([offX, offY, 0, 0], at + 8);
            f.set(tint, at + 12);
            f.set([mode, alpha, 0, 0], at + 16);
            return at / QUAD_FLOATS;
          };
          const sh = cmd.shadow, bl = cmd.bloom;
          const offsetWorld = sh ? { x: sh.dx * world.scale, y: sh.dy * world.scale } : { x: 0, y: 0 };
          // mode 1 = shadow tint (B's blurred alpha × color); mode 0 = sample.
          const firstShadow = sh ? packEffectQuad(offsetWorld.x, offsetWorld.y, sh.color, 1, sh.opacity) : -1;
          const firstContent = packEffectQuad(0, 0, NO_COLOR, 0, 1);
          const firstBloom = bl ? packEffectQuad(0, 0, NO_COLOR, 0, bl.strength) : -1;
          // Rotation-aware conservative half-extents of the WIDGET footprint
          // (no halo — the halo is OUTPUT, not source): the exact AABB of the
          // rotated local bbox. The crop case skips this (its region rarely
          // rotates); an effected widget rotates routinely, and an
          // underestimated source rect would clip the re-render's corners.
          const cxL = cmd.x + cmd.w / 2, cyL = cmd.y + cmd.h / 2;
          const centerWorld = T.apply(world, cxL, cyL);
          const co = Math.abs(Math.cos(world.rotation)), si = Math.abs(Math.sin(world.rotation));
          const hwL = cmd.w / 2 + aaLocal, hhL = cmd.h / 2 + aaLocal;
          const contentBatches = packList(flattenIR(cmd.content));
          batches.push({
            type: "effect",
            firstShadow, firstContent, firstBloom,
            shadowSigmaWorld: sh ? sh.blur * world.scale : 0,
            bloomSigmaWorld: bl ? bl.radius * world.scale : 0,
            offsetWorld,
            marginWorld: cmd.margin * world.scale,
            blend: cmd.blend ?? "normal",
            shadowOnly: !!cmd.shadowOnly,
            centerWorld,
            halfWWorld: (hwL * co + hhL * si) * world.scale,
            halfHWorld: (hwL * si + hhL * co) * world.scale,
            contentBatches,
          });
          box.current = null; // effects never merge with a following batch
          break;
        }
        default:
          throw new Error(`GpuCompositor: unknown IR op "${cmd.op}" (known: ${DRAW_OPS.join(", ")})`);
      }
    };
    return { batches: packList(flat) };
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
