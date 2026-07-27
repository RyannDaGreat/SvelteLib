/**
 * Browser Skia surface — the on-screen render backend for the editor viewport.
 *
 * Drop-in replacement for gpu/compositor.js GpuCompositor in CanvasView: same
 * `static async create(canvasEl)` + `render(ir, view, {background})` shape, so
 * the render loop is unchanged. Backed by CanvasKit on a WebGL2 context, which —
 * unlike WebGPU — has NO secure-context requirement, so the editor renders over
 * plain HTTP (LAN IP, etc.) instead of the navigator.gpu crash. Shares
 * paint_skia.js with the Node/CLI path, so browser and headless output match.
 *
 * Browser-only (WebGL, fetch, Vite ?url asset imports) — the counterpart to the
 * Node entry node_render.js, exactly as gpu/compositor.js is browser-only.
 */

import { paintIR } from "./paint_skia.js";
import { renderWithDither } from "./dither_shader.js";
import { ensureCanvasKit, loadFontCollection } from "./browser_canvaskit.js";
import { sceneMedia } from "./browser_media.js";
import { makeGpuUploader, disposeUploaderScope } from "../gpu/video_registry.js";
import { disposeVideoV5Scope } from "./video_v5.js"; // free V5's texture Images for this scope on teardown (additive)
import { clampSurfaceSize, MAX_SURFACE_DIM } from "../../core/clip.js";
import { reportOnce } from "../../core/report.js";

/** Monotonic tag so each SkiaSurface's GPU uploader gets a UNIQUE cache scope:
 * a texture-backed video Image is usable only on its own GL context (editor and
 * presenter surfaces have different contexts), so the video registry must never
 * share one surface's texture with another. */
let _scopeSeq = 0;

export class SkiaSurface {
  /**
   * Command (inits WASM + fonts + a WebGL2 context on canvasEl). The async
   * factory the editor awaits, mirroring GpuCompositor.create.
   *
   * `antialias` surfaces THE camera's "Anti-aliasing" render toggle (the
   * scene-global setting, plugins/camera.js): it selects the WebGL2 context's
   * MSAA flag (was hardcoded on). Default true = today's behavior (back-compat).
   * The GL context is created ONCE, so the caller (CanvasView) must re-create
   * the surface when the camera prop flips — see the lead-report threading note.
   *
   * @param {HTMLCanvasElement} canvasEl Target canvas.
   * @param {{antialias?: boolean}} [opts] Render options (antialias: MSAA on/off).
   */
  static async create(canvasEl, { antialias = true } = {}) {
    const CanvasKit = await ensureCanvasKit();
    const fontCollection = await loadFontCollection(CanvasKit);
    return new SkiaSurface(CanvasKit, canvasEl, fontCollection, { antialias });
  }

  constructor(CanvasKit, canvasEl, fontCollection, { antialias = true } = {}) {
    this.CanvasKit = CanvasKit;
    this.canvasEl = canvasEl;
    this.fontCollection = fontCollection;
    // alpha + premultiplied so the transparent clear lets the grid underlay +
    // app background show through (the editor's premultiplied-alpha contract).
    // `antialias` is the camera's Anti-aliasing toggle (was a hardcoded 1).
    this.ctxHandle = CanvasKit.GetWebGLContext(canvasEl, { alpha: 1, premultipliedAlpha: 1, antialias: antialias ? 1 : 0, majorVersion: 2 });
    if (!this.ctxHandle) throw new Error("SkiaSurface: GetWebGLContext returned 0 (WebGL2 unavailable in this browser)");
    this.grContext = CanvasKit.MakeWebGLContext(this.ctxHandle);
    if (!this.grContext) throw new Error("SkiaSurface: MakeWebGLContext returned null");
    // THE per-instance surface-dim cap: this GL context's real MAX_TEXTURE_SIZE
    // (a legitimately large display is honoured), never below the MAX_SURFACE_DIM
    // floor. No surface (on-screen OR offscreen) may exceed it — a bigger edge
    // OOMs the CanvasKit wasm heap (the reported crash), so it is clamped +
    // reported instead of allocated. Queried off the SAME canvas CanvasKit bound
    // its GL context to (getContext returns that same context).
    const gl2 = canvasEl.getContext("webgl2");
    // DITHER NEEDS THIS: the dither final pass (dither_shader.renderWithDither)
    // composites into an RGBA16F offscreen, and RGBA16F is only a COLOR-RENDERABLE
    // FBO attachment once EXT_color_buffer_float is enabled (linear-filterable via
    // OES_texture_float_linear). WITHOUT them, surface.makeSurface(f16) fails on
    // this on-screen context, so renderWithDither degrades to no-dither and the
    // camera's dither is INVISIBLE while editing (it worked in node/CLI export,
    // which always has F16). Enable on THE context CanvasKit renders through
    // (getContext returns the same one) so the F16 intermediate is allocatable and
    // dither (a camera render setting) shows live in the viewport — one camera,
    // one look, everywhere.
    gl2?.getExtension("EXT_color_buffer_float");
    gl2?.getExtension("OES_texture_float_linear");
    const maxTex = gl2 ? gl2.getParameter(gl2.MAX_TEXTURE_SIZE) : 0;
    this.maxDim = Math.max(MAX_SURFACE_DIM, Number.isFinite(maxTex) ? maxTex : 0);
    // GPU-backed offscreen factory for paintIR's backdrop/lens/effect surfaces —
    // keeps the magnifier/blur/effects/materials on the GPU (MakeRenderTarget)
    // instead of a software surface (the old per-frame killer).
    // CLAMPED: every requested size is bounded to this.maxDim before allocation
    // (never let MakeRenderTarget/MakeSurface see an oversized/invalid dim).
    // A null render target used to fall back to a software surface SILENTLY, so a
    // scene whose materials suddenly rastered per-pixel on the CPU looked like an
    // unexplained freeze. The fallback still happens — a frame drawn slowly beats
    // a frame not drawn — but it is REPORTED, so the cause is never a mystery.
    this._makeSurface = (w, h) => {
      const c = clampSurfaceSize(w, h, this.maxDim);
      if (!c.safe) reportOnce(`skia-offscreen-clamp:${w}x${h}`, `SkiaSurface: offscreen surface ${w}×${h} exceeds max ${this.maxDim} (or is invalid) — clamped to ${c.w}×${c.h} to avoid a CanvasKit heap overrun.`);
      const target = this.CanvasKit.MakeRenderTarget(this.grContext, c.w, c.h);
      if (target) return target;
      reportOnce(`skia-offscreen-target-null:${c.w}x${c.h}`, `SkiaSurface: MakeRenderTarget(${c.w}×${c.h}) returned null — this frame's backdrop/material compositing falls back to a software surface, which rasters per-pixel shaders on the CPU and will stutter.`);
      return this.CanvasKit.MakeSurface(c.w, c.h);
    };
    this.surface = null;
    this._w = 0;
    this._h = 0;
    // THE GPU media uploader for this context: uploads <video> frames STRAIGHT to
    // GL textures (no CPU readback) for sceneMedia. A THUNK reads the live surface
    // (recreated on resize; the GrContext that owns the textures is stable). Its
    // scope is unique per instance so the video registry never crosses contexts.
    this._uploader = makeGpuUploader(CanvasKit, () => this.surface, "gl:" + (_scopeSeq++));
  }

  /** Command. (Re)creates the on-screen GL surface when the canvas size changes.
   *  A zero-size canvas (a collapsed pane) is left with NO surface — render()
   *  early-returns — because MakeOnScreenGLSurface(…, 0, 0) returns null and
   *  would throw every frame otherwise. An oversized/invalid canvas is CLAMPED to
   *  this.maxDim (+ reported) before allocation so it can never OOM the CanvasKit
   *  wasm heap; a null result (even after clamping) leaves NO surface and reports
   *  — render() then skips the frame rather than throwing on every rAF tick. */
  _ensureSurface() {
    const rawW = this.canvasEl.width, rawH = this.canvasEl.height;
    if (rawW === 0 || rawH === 0) { this.surface?.delete(); this.surface = null; this._w = rawW; this._h = rawH; return; }
    const { w, h, safe } = clampSurfaceSize(rawW, rawH, this.maxDim);
    if (!safe) reportOnce(`skia-onscreen-clamp:${rawW}x${rawH}`, `SkiaSurface: on-screen canvas ${rawW}×${rawH} exceeds max ${this.maxDim} (or is invalid) — clamped to ${w}×${h} to avoid a CanvasKit heap overrun; the viewport is capped.`);
    if (this.surface && this._w === w && this._h === h) return;
    this.surface?.delete();
    this.surface = this.CanvasKit.MakeOnScreenGLSurface(this.grContext, w, h, this.CanvasKit.ColorSpace.SRGB);
    if (!this.surface) {
      reportOnce(`skia-onscreen-null:${w}x${h}`, `SkiaSurface: MakeOnScreenGLSurface(${w}×${h}) returned null — skipping this frame's draw (no on-screen surface).`);
      this._w = 0; this._h = 0;
      return;
    }
    this._w = w;
    this._h = h;
  }

  /**
   * Command (draws to the canvas). Renders the IR display list — same signature
   * as GpuCompositor.render so CanvasView's paint() is unchanged.
   *
   * MEDIA: the caller normally passes no `media`, so we BUILD it from the scene
   * here (render_gpu/skia/browser_media.sceneMedia) — resolving each image/video
   * ref to a CanvasKit Image through the shared registries, and freeing the
   * per-paint video frames after the draw is submitted. A caller that supplies
   * `media` (node/tests) is respected verbatim (the no-media path stays intact).
   *
   * SCISSOR: an optional device-px clip rect ({x,y,w,h}) — the presenter's
   * letterbox. Forwarded to paintIR, which clears the WHOLE surface to
   * `background` (the bars) and clips the SCENE to it so off-camera content
   * cannot bleed into the bars. Ignored (full surface) when absent.
   *
   * DITHER: THE camera's dither settings ({mode, emphasis} — dither_shader
   * cameraDither), read from the scene by the caller (CanvasView) and applied as
   * the whole-frame final pass right before present. Omitted / {mode:"off"} =
   * no-op (today's behavior byte-for-byte).
   *
   * ANTIALIAS: THE camera's per-draw COVERAGE anti-aliasing boolean
   * (render_settings.cameraAntialias/antialiasCoverage), read from the scene by
   * the caller and forwarded to paintIR's setAntiAlias. This is the LIVE
   * edge-smoothing control — it takes effect every frame with NO surface
   * recreation. (The GL context's MSAA flag set in create() is a separate,
   * coarser knob that only applies at surface creation.) Default true = today's
   * smooth look; false ⇒ crisp, jagged edges.
   */
  render(ir, view, { background = [0, 0, 0, 0], media = null, scissor = null, dither = null, antialias = true } = {}) {
    this._ensureSurface();
    if (!this.surface) return; // collapsed pane (zero-size canvas) — nothing to draw
    const built = media == null ? sceneMedia(this._uploader, ir) : { media, release() {} };
    try {
      // THE dither seam: renderWithDither composites into an RGBA16F intermediate
      // and de-bands on the downconvert to this 8-bit GL surface (when dither is
      // active); "off" paints straight in + flushes, byte-identical to before.
      renderWithDither(this.CanvasKit, this.surface, this._w, this._h, dither, (canvas) =>
        paintIR(this.CanvasKit, canvas, ir, view, { media: built.media, background, fontCollection: this.fontCollection, scissor, makeSurface: this._makeSurface, antialias }));
    } finally {
      built.release(); // free per-paint video frame Images even if paint throws (review MED)
    }
  }

  /** Command. Frees WASM/GPU resources. */
  dispose() {
    // Free this context's reused video textures BEFORE the GrContext dies — a
    // later eviction .delete() on a torn-down context would fault the wasm heap.
    disposeUploaderScope(this._uploader.scopeId);
    disposeVideoV5Scope(this._uploader.scopeId); // V5 keeps its own per-scope texture Images

    this.surface?.delete();
    this.grContext?.delete();
    if (this.ctxHandle) this.CanvasKit.deleteContext(this.ctxHandle);
    this.surface = null;
  }
}
