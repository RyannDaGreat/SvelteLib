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
import { ensureCanvasKit, loadFontCollection } from "./browser_canvaskit.js";
import { sceneMedia } from "./browser_media.js";
import { clampSurfaceSize, MAX_SURFACE_DIM } from "../../core/clip.js";
import { reportOnce } from "../../core/report.js";

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
    const maxTex = gl2 ? gl2.getParameter(gl2.MAX_TEXTURE_SIZE) : 0;
    this.maxDim = Math.max(MAX_SURFACE_DIM, Number.isFinite(maxTex) ? maxTex : 0);
    // GPU-backed offscreen factory for paintIR's backdrop/lens/effect surfaces —
    // keeps the magnifier/blur/effects on the GPU (MakeRenderTarget) instead of a
    // CPU software surface (the old per-frame killer). Falls back to CPU if null.
    // CLAMPED: every requested size is bounded to this.maxDim before allocation
    // (never let MakeRenderTarget/MakeSurface see an oversized/invalid dim).
    this._makeSurface = (w, h) => {
      const c = clampSurfaceSize(w, h, this.maxDim);
      if (!c.safe) reportOnce(`skia-offscreen-clamp:${w}x${h}`, `SkiaSurface: offscreen surface ${w}×${h} exceeds max ${this.maxDim} (or is invalid) — clamped to ${c.w}×${c.h} to avoid a CanvasKit heap overrun.`);
      return this.CanvasKit.MakeRenderTarget(this.grContext, c.w, c.h) || this.CanvasKit.MakeSurface(c.w, c.h);
    };
    this.surface = null;
    this._w = 0;
    this._h = 0;
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
   */
  render(ir, view, { background = [0, 0, 0, 0], media = null, scissor = null } = {}) {
    this._ensureSurface();
    if (!this.surface) return; // collapsed pane (zero-size canvas) — nothing to draw
    const canvas = this.surface.getCanvas();
    const built = media == null ? sceneMedia(this.CanvasKit, ir) : { media, release() {} };
    try {
      paintIR(this.CanvasKit, canvas, ir, view, { media: built.media, background, fontCollection: this.fontCollection, scissor, makeSurface: this._makeSurface });
      this.surface.flush();
    } finally {
      built.release(); // free per-paint video frame Images even if paint throws (review MED)
    }
  }

  /** Command. Frees WASM/GPU resources. */
  dispose() {
    this.surface?.delete();
    this.grContext?.delete();
    if (this.ctxHandle) this.CanvasKit.deleteContext(this.ctxHandle);
    this.surface = null;
  }
}
