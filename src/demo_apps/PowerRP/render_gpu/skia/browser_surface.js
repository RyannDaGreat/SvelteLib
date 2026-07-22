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

import CanvasKitInit from "canvaskit-wasm/bin/canvaskit.js";
import canvaskitWasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { paintIR } from "./paint_skia.js";
import { committedFaces, DEFAULT_FONT } from "../fonts.js";

// Vite inlines every committed TTF at build time (offline-safe, hashed URLs) —
// the same mechanism web/fontLoader.js uses, resolved relative to THIS file.
const FONT_URLS = import.meta.glob("../../fonts/*.ttf", { query: "?url", import: "default", eager: true });

let _ckPromise = null;
/** Command (inits the WASM module once; memoized). Returns the CanvasKit module. */
function ensureCanvasKit() {
  if (!_ckPromise) _ckPromise = CanvasKitInit({ locateFile: () => canvaskitWasmUrl });
  return _ckPromise;
}

/**
 * Query→build (fetches font files). Builds the `${id}:${bold}` → Typeface map.
 * A missing/failed face is reported loudly and skipped (fonts.js contract: a
 * missing font must never throw in the render path); `system` stands in as Inter.
 */
async function loadTypefaces(CanvasKit) {
  const map = new Map();
  await Promise.all(
    committedFaces().map(async (face) => {
      const url = FONT_URLS[`../../fonts/${face.file}`];
      if (!url) { console.error(`SkiaSurface: committed font "${face.file}" has no bundled URL — check fonts.js vs fonts/.`); return; }
      const buf = await (await fetch(url)).arrayBuffer();
      const tf = CanvasKit.Typeface.MakeTypefaceFromData(buf);
      if (!tf) { console.error(`SkiaSurface: MakeTypefaceFromData failed for ${face.file}`); return; }
      map.set(`${face.id}:${face.bold ? "b" : "r"}`, tf);
    }),
  );
  const interR = map.get("inter:r"), interB = map.get("inter:b");
  if (interR) map.set(`${DEFAULT_FONT}:r`, interR);
  if (interB) map.set(`${DEFAULT_FONT}:b`, interB);
  return map;
}

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

  /** Command. (Re)creates the on-screen GL surface when the canvas size changes. */
  _ensureSurface() {
    const w = this.canvasEl.width, h = this.canvasEl.height;
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
   */
  render(ir, view, { background = [0, 0, 0, 0], media = {} } = {}) {
    this._ensureSurface();
    const canvas = this.surface.getCanvas();
    paintIR(this.CanvasKit, canvas, ir, view, { media, background, typefaces: this.typefaces });
    this.surface.flush();
  }

  /** Command. Frees WASM/GPU resources. */
  dispose() {
    this.surface?.delete();
    this.grContext?.delete();
    if (this.ctxHandle) this.CanvasKit.deleteContext(this.ctxHandle);
    this.surface = null;
  }
}
