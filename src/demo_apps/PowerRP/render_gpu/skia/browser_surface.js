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
import { ensureCanvasKit, loadTypefaces } from "./browser_canvaskit.js";
import { sceneMedia } from "./browser_media.js";

export class SkiaSurface {
  /**
   * Command (inits WASM + fonts + a WebGL2 context on canvasEl). The async
   * factory the editor awaits, mirroring GpuCompositor.create.
   */
  static async create(canvasEl) {
    const CanvasKit = await ensureCanvasKit();
    const typefaces = await loadTypefaces(CanvasKit);
    return new SkiaSurface(CanvasKit, canvasEl, typefaces);
  }

  constructor(CanvasKit, canvasEl, typefaces) {
    this.CanvasKit = CanvasKit;
    this.canvasEl = canvasEl;
    this.typefaces = typefaces;
    // alpha + premultiplied so the transparent clear lets the grid underlay +
    // app background show through (the editor's premultiplied-alpha contract).
    this.ctxHandle = CanvasKit.GetWebGLContext(canvasEl, { alpha: 1, premultipliedAlpha: 1, antialias: 1, majorVersion: 2 });
    if (!this.ctxHandle) throw new Error("SkiaSurface: GetWebGLContext returned 0 (WebGL2 unavailable in this browser)");
    this.grContext = CanvasKit.MakeWebGLContext(this.ctxHandle);
    if (!this.grContext) throw new Error("SkiaSurface: MakeWebGLContext returned null");
    this.surface = null;
    this._w = 0;
    this._h = 0;
  }

  /** Command. (Re)creates the on-screen GL surface when the canvas size changes.
   *  A zero-size canvas (a collapsed pane) is left with NO surface — render()
   *  early-returns — because MakeOnScreenGLSurface(…, 0, 0) returns null and
   *  would throw every frame otherwise. */
  _ensureSurface() {
    const w = this.canvasEl.width, h = this.canvasEl.height;
    if (w === 0 || h === 0) { this.surface?.delete(); this.surface = null; this._w = w; this._h = h; return; }
    if (this.surface && this._w === w && this._h === h) return;
    this.surface?.delete();
    this.surface = this.CanvasKit.MakeOnScreenGLSurface(this.grContext, w, h, this.CanvasKit.ColorSpace.SRGB);
    if (!this.surface) throw new Error(`SkiaSurface: MakeOnScreenGLSurface(${w}x${h}) returned null`);
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
    paintIR(this.CanvasKit, canvas, ir, view, { media: built.media, background, typefaces: this.typefaces, scissor });
    this.surface.flush();
    built.release(); // free per-paint video frame Images now the draw is submitted
  }

  /** Command. Frees WASM/GPU resources. */
  dispose() {
    this.surface?.delete();
    this.grContext?.delete();
    if (this.ctxHandle) this.CanvasKit.deleteContext(this.ctxHandle);
    this.surface = null;
  }
}
