/**
 * Shared offscreen Skia raster service for PIXEL consumers — slide thumbnails,
 * the minimap, PNG export. The interactive viewport and the presenter own their
 * own on-screen SkiaSurface; everything that needs BYTES shares this one CPU
 * raster path, which — unlike the old WebGPU compositor — has NO adapter and NO
 * secure-context requirement, so it works over plain HTTP (the whole point of
 * the Skia rewrite: navigator.gpu was "no adapter" on a LAN IP). Renders go
 * through the SAME paint_skia.paintIR the editor and the Node/CLI path use, so
 * thumbnails match the viewport and the headless renderer byte-for-byte.
 *
 * Command module: inits CanvasKit + the shared FontCollection once (shared with
 * browser_surface.js via browser_canvaskit.js), and SERIALIZES renders through a
 * promise queue so concurrent callers can't stomp each other mid-frame. Each job
 * allocates a fresh CPU surface (cheap; CanvasKit/fonts are the expensive part
 * and are cached) and reads its pixels back into a fresh 2D <canvas> — the exact
 * return contract callers depend on (thumb.toDataURL, out.toBlob for PNG).
 */

import { cameraRect } from "../core/derive.js";
import { fitRectView } from "../core/view.js";
import { clampSurfaceSize, MAX_SURFACE_DIM } from "../core/clip.js";
import { reportOnce } from "../core/report.js";
import { parseColor } from "../render_gpu/ir.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { renderWithDither, cameraDither } from "../render_gpu/skia/dither_shader.js";
import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";
import { ensureCanvasKit, loadFontCollection } from "../render_gpu/skia/browser_canvaskit.js";
import { sceneMedia, prepareSceneScrubFrames } from "../render_gpu/skia/browser_media.js";
import { cameraFrameIR, evaluatedStateAt } from "./cameraFrame.js";

let ckPromise = null;
let queue = Promise.resolve();

/** Command (inits + memoizes CanvasKit and its shared FontCollection). Returns {CanvasKit, fontCollection}. */
function ensure() {
  if (!ckPromise) {
    ckPromise = ensureCanvasKit().then(async (CanvasKit) => ({
      CanvasKit,
      fontCollection: await loadFontCollection(CanvasKit),
    }));
  }
  return ckPromise;
}

/** Serialized render → fresh 2D canvas with the pixels (the shared core). */
function renderJob(reqWidth, reqHeight, buildIR) {
  const job = queue.then(async () => {
    const { CanvasKit, fontCollection } = await ensure();
    // Clamp BEFORE allocation: an oversized/invalid (width,height) would OOM the
    // CanvasKit wasm heap at MakeSurface (the reported crash) and corrupt the
    // instance. A CPU raster surface must fit the heap, so the cap is the static
    // MAX_SURFACE_DIM (no GL context here to query). The clamped dims are used
    // consistently for the surface, readback, and output canvas.
    const { w: width, h: height, safe } = clampSurfaceSize(reqWidth, reqHeight, MAX_SURFACE_DIM);
    if (!safe) reportOnce(`gpuService-clamp:${reqWidth}x${reqHeight}`, `gpuService: requested raster ${reqWidth}×${reqHeight} exceeds MAX_SURFACE_DIM ${MAX_SURFACE_DIM} (or is invalid) — clamped to ${width}×${height} to avoid a CanvasKit heap overrun.`);
    const surface = CanvasKit.MakeSurface(width, height);
    if (!surface) throw new Error(`gpuService: MakeSurface(${width}x${height}) returned null`);
    try {
      const { ir, view, background, dither = null, antialias = true, quality = "full" } = buildIR();
      // SCRUBBER seek-and-await: park + decode every video_scrub frame the scene
      // needs BEFORE painting, so this one-shot pixel path (thumbnails / minimap /
      // PNG export / the puppeteer render hook) is DETERMINISTIC — sceneMedia's
      // sync getScrubFrame then finds each frame already in the LRU. No-op when
      // the scene has no scrubbers.
      await prepareSceneScrubFrames(CanvasKit, ir);
      // Resolve the scene's image/video refs to CanvasKit Images so thumbnails/
      // minimap/PNG export show media too (the same seam the on-screen surface
      // uses); release frees the per-paint video frames after readback.
      const { media, release } = sceneMedia(CanvasKit, ir);
      try {
        // THE dither seam: renderWithDither composites into an RGBA16F
        // intermediate and de-bands on the downconvert (when dither is active).
        // Camera-frame consumers (thumbnails/minimap/PNG export) pass the camera's
        // dither settings; the PDF raster-region callback passes none (dither is a
        // RASTER post-pass — vector PDF/SVG export stays untouched).
        renderWithDither(CanvasKit, surface, width, height, dither, (canvas) =>
          paintIR(CanvasKit, canvas, ir, view, { media, background, fontCollection, antialias, quality }));
        const img = surface.makeImageSnapshot();
        if (!img) throw new Error("gpuService: makeImageSnapshot returned null");
        const px = img.readPixels(0, 0, {
          width,
          height,
          colorType: CanvasKit.ColorType.RGBA_8888,
          alphaType: CanvasKit.AlphaType.Unpremul,
          colorSpace: CanvasKit.ColorSpace.SRGB,
        });
        img.delete();
        if (!px) throw new Error("gpuService: readPixels returned null");
        const out = document.createElement("canvas");
        out.width = width;
        out.height = height;
        out.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px), width, height), 0, 0);
        return out;
      } finally {
        release();
      }
    } finally {
      surface.delete();
    }
  });
  // The queue must survive a failed job (callers still see their rejection).
  queue = job.catch(() => {});
  return job;
}

/**
 * Command (async). One document frame THROUGH THE CAMERA at width×height
 * device px → fresh 2D canvas. The camera rect defines the view and its
 * background is the first draw — thumbnail/export semantics.
 *
 * `quality` picks the render path:
 *   - "full" (default) — the editor/export path: THE camera's dither final pass
 *     PLUS the full glass/material/magnify backdrop machinery. Byte-identical to
 *     before this control existed, so every non-thumbnail caller (PNG export, the
 *     presenter, the minimap, the CLI parity probe) stays exactly as it was.
 *   - "proxy" — the CHEAP thumbnail/minimap path: NO dither (skips the RGBA16F
 *     intermediate — the single biggest per-thumbnail cost) and cheap backdrop
 *     stand-ins (paint_skia's proxy branch: no composite re-render, no full-screen
 *     blur, no SkSL), with invisible quality loss at ~100px.
 *
 * @example // renderCameraFrame(doc, {slideIndex: 0, alpha: 1, registry, width: 256, height: 144}) → Promise<canvas>
 * @example // renderCameraFrame(doc, {slideIndex: 0, registry, width: 96, height: 54, quality: "proxy"}) → cheap thumbnail
 */
export function renderCameraFrame(doc, { slideIndex, alpha = 1, registry, width, height, quality = "full" }) {
  return renderJob(width, height, () => {
    const state = evaluatedStateAt(doc, slideIndex, alpha, registry);
    const rect = cameraRect(state, doc.meta);
    return {
      view: fitRectView(rect, width, height, 1),
      background: parseColor(rect.background),
      ir: cameraFrameIR(state, doc.meta, registry),
      // PROXY skips the dither final pass entirely (dither:null ⇒ renderWithDither
      // stays on the direct 8-bit paint — no RGBA16F intermediate). FULL keeps THE
      // camera's dither settings, byte-identical to before.
      dither: quality === "proxy" ? null : cameraDither(state),
      antialias: antialiasCoverage(cameraAntialias(state)), // THE camera's coverage-AA → setAntiAlias
      quality,
    };
  });
}

/**
 * Command (async). Rasterizes an arbitrary IR command list at an explicit
 * view into PNG bytes — the PDF exporter's raster-region callback (the
 * HYBRID RULE: blur regions embed as images among the vector elements;
 * signature per render_gpu/pdf_backend.js irToPDF `rasterize`).
 *
 * @example // rasterizeIrPng(cmds, {zoom: 2, panX: 0, panY: 0, dpr: 1}, 800, 600, "#ffffff") → Promise<Uint8Array PNG>
 */
export async function rasterizeIrPng(ir, view, width, height, background = null) {
  const bg = background == null ? [0, 0, 0, 0]
    : Array.isArray(background) ? background : parseColor(background);
  const out = await renderJob(width, height, () => ({ ir, view, background: bg }));
  const blob = await new Promise((res) => out.toBlob(res, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
// (renderViewFrame — the old explicit-view minimap render — was removed with
// the minimap's camera rebase: the minimap now renders THROUGH the camera via
// renderCameraFrame, like the slide thumbnails. cruft audit #2.)
