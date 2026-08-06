/**
 * Shared offscreen Skia raster service for PIXEL consumers — slide thumbnails,
 * the minimap, PNG export, the PDF/SVG raster regions, and the presenter's fade
 * snapshots. The interactive viewport and the presenter own their own on-screen
 * SkiaSurface; everything that needs BYTES shares this one path. Renders go
 * through the SAME paint_skia.paintIR the editor and the Node/CLI path use, so
 * thumbnails match the viewport and the headless renderer byte-for-byte.
 *
 * THE SURFACE IS GL-BACKED. This service used to raster on a SOFTWARE surface
 * (CanvasKit.MakeSurface). That runs every generative material's per-pixel
 * shader (lens flare, metaballs, halftone, glass, crt) on the CPU — measured at
 * ~0.28 ms/px, so ONE full camera frame of such a deck cost tens of seconds to
 * minutes of BLOCKED MAIN THREAD. That was the reported freeze on a slide fade
 * (two completed-state snapshots) and on PDF export (whose raster regions are
 * additionally supersampled, so 4x the pixels). The viewport never froze because
 * it draws on a GL surface. So this service now owns its own GL context and
 * allocates render targets from it, mirroring render_gpu/skia/browser_surface.js;
 * a software surface remains only as a LOUDLY reported last resort. The GL path
 * is the same one the viewport proves works over plain HTTP — it has no adapter
 * and no secure-context requirement.
 *
 * VIDEO FRAMES UPLOAD STRAIGHT TO A TEXTURE. Owning a GL context also retires the
 * last continuously-hit CPU pixel path here: the service used to grab video frames
 * with the portable CPU uploader (drawImage → getImageData →
 * MakeImageFromCanvasImageSource), a FULL-RESOLUTION readback per frame per job —
 * ~45 ms for 1080p, paid by the minimap (~8 Hz, on by default), every slide
 * thumbnail, project previews, PNG/PDF/SVG export and the presenter's fade
 * snapshots. It was the one cost `quality:"proxy"` could not cut, because proxy
 * reduces SHADER work while this is MEDIA work. The service now keeps ONE GPU
 * uploader on ONE scope, so frames upload to a texture and refresh in place.
 *
 * Command module: inits CanvasKit + the shared FontCollection once (shared with
 * browser_surface.js via browser_canvaskit.js), and SERIALIZES renders through a
 * promise queue so concurrent callers can't stomp each other mid-frame. Each job
 * allocates a fresh surface (cheap; CanvasKit/fonts/the GL context are the
 * expensive parts and are cached) and reads its pixels back into a fresh 2D
 * <canvas> — the exact return contract callers depend on (thumb.toDataURL,
 * out.toBlob for PNG).
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
import { makeCpuUploader, makeGpuUploader } from "../render_gpu/gpu/video_registry.js";
import { cameraFrameIR, evaluatedStateAt } from "./cameraFrame.js";
import { withSimulationFrozen } from "../core/simulation_history.js";

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

// ── The service's own GL context (THE freeze fix) ─────────────────────────────
// One context for the whole service, created lazily and reused by every job.
// CanvasKit makes a surface's context current for us on every operation that
// needs it (render-target creation, flush, snapshot readback), so this context
// coexists safely with the viewport's and the presenter's.
// The backing canvas only exists to own the context — its size is irrelevant
// because jobs render into off-screen render targets, never into it.
const CONTEXT_CANVAS_PX = 1;

let glContext = null;        // {canvas, handle, grContext, maxDim} once created
let glContextChecked = false; // so a failed init is attempted ONCE, not per job

// The offscreen-surface factory paintIR uses for backdrop/material/lens scratch
// renders, and THE VIDEO UPLOADER — both are per-SERVICE singletons, never per
// job, because downstream caches are keyed by their identity:
//   · render_gpu/skia/video_v2.js keys its texture buckets by ctx.makeSurface
//     FUNCTION IDENTITY (identity ≙ one GrContext). A fresh closure per job
//     therefore minted a fresh bucket per job — a helper render target plus a
//     full-resolution video texture leaked on every thumbnail/minimap/export.
//   · the video registry keys texture-backed Images by uploader SCOPE, and reuse
//     (updateTextureFromSource instead of a fresh upload) only happens within one
//     scope. A per-job uploader could never reuse anything.
// Jobs are serialized through `queue`, so exactly one is live at a time and a
// single mutable `jobSurface` is a safe target for the uploader's thunk.
const UPLOADER_SCOPE = "gpuService"; // stable for the page — one GL context, one scope
let offscreenFactory = null; // (w, h) => Surface on the service's context, identity-stable
let gpuUploader = null;      // the service's ONE GPU uploader (null until a GL context exists)
let cpuUploader = null;      // the reported no-GL-context fallback uploader
let jobSurface = null;       // the surface the CURRENT job renders into (uploader thunk target)

/**
 * Command (creates + memoizes a GL context; reports loudly on failure). Returns
 * the context record, or null when this browser cannot give the service one —
 * in which case the caller rasters on a software surface and the user has been
 * told why that is slow. Never throws: a missing context must degrade the
 * pixel consumers, not break them.
 */
function ensureGlContext(CanvasKit) {
  if (glContextChecked) return glContext;
  glContextChecked = true;
  const canvas = document.createElement("canvas");
  canvas.width = CONTEXT_CANVAS_PX;
  canvas.height = CONTEXT_CANVAS_PX;
  // Same attributes as the on-screen surface, minus multisampling: these targets
  // are read back as pixels, and coverage AA is applied per draw by paintIR.
  const handle = CanvasKit.GetWebGLContext(canvas, { alpha: 1, premultipliedAlpha: 1, antialias: 0, majorVersion: 2 });
  if (!handle) return reportNoGlContext("GetWebGLContext returned 0 (no WebGL2 context available)");
  const grContext = CanvasKit.MakeWebGLContext(handle);
  if (!grContext) {
    CanvasKit.deleteContext(handle);
    return reportNoGlContext("MakeWebGLContext returned null");
  }
  // The dither final pass composites through an RGBA16F intermediate, which is
  // only an allocatable render target with these extensions (the same
  // requirement the on-screen surface documents). Without them renderWithDither
  // reports and degrades to a direct 8-bit paint — it does not fail the render.
  const gl2 = canvas.getContext("webgl2");
  gl2?.getExtension("EXT_color_buffer_float");
  gl2?.getExtension("OES_texture_float_linear");
  // This context's real texture limit bounds every surface, never below the
  // static floor — a bigger edge overruns the CanvasKit heap (see core/clip.js).
  const maxTex = gl2 ? gl2.getParameter(gl2.MAX_TEXTURE_SIZE) : 0;
  glContext = { canvas, handle, grContext, maxDim: Math.max(MAX_SURFACE_DIM, Number.isFinite(maxTex) ? maxTex : 0) };
  return glContext;
}

/** Command (reports once, returns null). THE single explanation of why the
 *  offscreen pixel path is on the slow software surface. */
function reportNoGlContext(reason) {
  reportOnce("gpuService-no-gl-context", `gpuService: ${reason} — the offscreen pixel service has NO GL context and must raster in software. Generative material widgets (lens flare, metaballs, halftone, glass, crt) run their per-pixel shaders on the CPU there, so slide fades, PNG/PDF export and thumbnails will be extremely slow on decks that use them.`);
  return null;
}

/**
 * Query (async — needs CanvasKit). True when the offscreen pixel service can
 * render on the GPU. Callers that would otherwise queue a very expensive
 * full-quality render (the presenter's fade snapshots) use this to pick a
 * cheaper quality instead of blocking the main thread for minutes.
 */
export async function gpuAccelerated() {
  const { CanvasKit } = await ensure();
  return ensureGlContext(CanvasKit) !== null;
}

/**
 * Command. Allocates one surface of the job's size: a GL render target when the
 * service has a context, else a software surface. A render target that comes
 * back null is REPORTED and retried in software — the render still happens, but
 * never silently on the slow path.
 */
function makeJobSurface(CanvasKit, gl, width, height) {
  if (gl) {
    const target = CanvasKit.MakeRenderTarget(gl.grContext, width, height);
    if (target) return target;
    reportOnce(`gpuService-target-null:${width}x${height}`, `gpuService: MakeRenderTarget(${width}×${height}) returned null — falling back to a software surface for this size, which rasters generative materials on the CPU and is very slow.`);
  }
  const surface = CanvasKit.MakeSurface(width, height);
  if (!surface) throw new Error(`gpuService: MakeSurface(${width}x${height}) returned null`);
  return surface;
}

/**
 * Command (creates + memoizes). The service's ONE offscreen-surface factory, for
 * the nested backdrop/material/lens surfaces paintIR allocates. They must come
 * from the SAME context as the job surface — otherwise the heavy material scratch
 * renders would stay in software and the freeze with them. Identity-stable for the
 * service's life: see the UPLOADER_SCOPE block above for why that matters.
 */
function ensureOffscreenFactory(CanvasKit, gl) {
  if (offscreenFactory) return offscreenFactory;
  const maxDim = gl ? gl.maxDim : MAX_SURFACE_DIM;
  offscreenFactory = (w, h) => {
    const c = clampSurfaceSize(w, h, maxDim);
    if (!c.safe) reportOnce(`gpuService-offscreen-clamp:${w}x${h}`, `gpuService: offscreen surface ${w}×${h} exceeds the ${maxDim} surface limit (or is invalid) — clamped to ${c.w}×${c.h} to avoid a CanvasKit heap overrun.`);
    return makeJobSurface(CanvasKit, gl, c.w, c.h);
  };
  return offscreenFactory;
}

/**
 * Command (creates + memoizes). The service's video-frame uploader.
 *
 * GPU when the service has a context: frames upload STRAIGHT to a texture on it
 * (makeImageFromTextureSource, then updateTextureFromSource in place on frame
 * advance). The CPU uploader this replaces went drawImage → getImageData →
 * MakeImageFromCanvasImageSource, i.e. a FULL-RESOLUTION readback of every video
 * frame on the main thread — measured ~45 ms per 1080p grab, paid by every
 * offscreen job on a deck containing video: the minimap (~8 Hz, on by default),
 * every slide thumbnail, project previews, PNG/PDF/SVG export, fade snapshots. It
 * was also the one cost `quality:"proxy"` could not cut, because proxy reduces
 * SHADER work and this is MEDIA work — a 150×84 proxy thumbnail still paid a full
 * 1920×1080 readback. (That path was correct only while this service had no GL
 * context; it has owned one since the freeze fix above, so the old comment here
 * about keeping "the portable uploader" was stale.)
 *
 * Software only when there is NO GL context — already reported loudly by
 * reportNoGlContext, so the slow path is never silent.
 *
 * No disposal seam: unlike an on-screen SkiaSurface (per component, hence
 * disposeUploaderScope), this service and its GL context live as long as the page,
 * so its ONE scope holds at most one reused texture per distinct video source.
 */
function ensureUploader(CanvasKit, gl) {
  if (!gl) return (cpuUploader ??= makeCpuUploader(CanvasKit));
  return (gpuUploader ??= makeGpuUploader(CanvasKit, () => jobSurface, UPLOADER_SCOPE));
}

/** Serialized render → fresh 2D canvas with the pixels (the shared core). */
function renderJob(reqWidth, reqHeight, buildIR) {
  const job = queue.then(async () => {
    const { CanvasKit, fontCollection } = await ensure();
    const gl = ensureGlContext(CanvasKit);
    // Clamp BEFORE allocation: an oversized/invalid (width,height) would OOM the
    // CanvasKit wasm heap at allocation (the reported crash) and corrupt the
    // instance. The cap is this GL context's real texture limit when there is
    // one, else the static MAX_SURFACE_DIM floor. The clamped dims are used
    // consistently for the surface, readback, and output canvas.
    const maxDim = gl ? gl.maxDim : MAX_SURFACE_DIM;
    const { w: width, h: height, safe } = clampSurfaceSize(reqWidth, reqHeight, maxDim);
    if (!safe) reportOnce(`gpuService-clamp:${reqWidth}x${reqHeight}`, `gpuService: requested raster ${reqWidth}×${reqHeight} exceeds the ${maxDim} surface limit (or is invalid) — clamped to ${width}×${height} to avoid a CanvasKit heap overrun.`);
    const surface = makeJobSurface(CanvasKit, gl, width, height);
    const makeSurface = ensureOffscreenFactory(CanvasKit, gl);
    // The uploader's thunk reads THIS surface (jobSurface) — set before any grab
    // and cleared with the surface, so a grab outside a job fails loudly instead
    // of uploading onto a deleted surface. Safe because jobs are serialized.
    jobSurface = surface;
    try {
      const { ir, view, background, dither = null, antialias = true, quality = "full" } = buildIR();
      const uploader = ensureUploader(CanvasKit, gl);
      // SCRUBBER seek-and-await: park + decode every video_scrub frame the scene
      // needs BEFORE painting, so this one-shot pixel path (thumbnails / minimap /
      // PNG export / the puppeteer render hook) is DETERMINISTIC — sceneMedia's
      // sync getScrubFrame then finds each frame already in the LRU. No-op when
      // the scene has no scrubbers.
      await prepareSceneScrubFrames(uploader, ir);
      // Resolve the scene's image/video refs to CanvasKit Images so thumbnails/
      // minimap/PNG export show media too (the same seam the on-screen surface
      // uses). release() frees only what this paint OWNS: with the GPU uploader
      // the frames are registry-owned textures reused in place, so sceneMedia
      // deliberately does not list them (uploader.isGpu) and release is a no-op
      // for video — deleting them would destroy the cache we just populated.
      const { media, release } = sceneMedia(uploader, ir);
      try {
        // THE dither seam: renderWithDither composites into an RGBA16F
        // intermediate and de-bands on the downconvert (when dither is active).
        // Camera-frame consumers (thumbnails/minimap/PNG export) pass the camera's
        // dither settings; the PDF raster-region callback passes none (dither is a
        // RASTER post-pass — vector PDF/SVG export stays untouched).
        renderWithDither(CanvasKit, surface, width, height, dither, (canvas) =>
          paintIR(CanvasKit, canvas, ir, view, { media, background, fontCollection, makeSurface, antialias, quality }));
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
      jobSurface = null;
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
 * `project` is the OWNING project's name/key, threaded straight to
 * `cameraFrameIR` for asset-ref resolution — see that function's docblock for
 * why this can't default to `doc.meta.name` for every caller. Any caller
 * rendering the app's OWN currently-open document must pass `app.projectName()`
 * (which answers the draft key while a draft is open); a caller rendering a
 * DIFFERENT, already-saved project's doc (e.g. the Open Project preview grid)
 * passes that project's own name instead.
 *
 * ── THIS SERVICE IS READ-ONLY TOWARDS THE SIMULATION ─────────────────────────
 * SIMULATED STATE (manifest R7-9) keeps a module-global history table keyed by
 * SLOT, and core/simulation_history.js's scoping invariant is that EXACTLY ONE
 * consumer per process may advance it. Every caller here is a STILL consumer that
 * can run while the presenter's clock is live — the slide thumbnails and the
 * minimap keep rendering behind a fullscreen presentation, because PresentMode is
 * mounted ALONGSIDE the editor rather than instead of it (web/App.svelte:3060) —
 * so the evaluation runs inside withSimulationFrozen.
 *
 * FROZEN MEANS NO WRITE, NOT MERELY dt = 0, and the difference is the whole point:
 * a dt-FREE simulated equation (`= @ * 0.9`, a decay) still computes f(prev) at
 * dt = 0, so a thumbnail of SLIDE 5 would otherwise land its value in the slot the
 * presenter's timeline owns and the next roll would inherit it. Verified in the
 * module: recordSimulationValue returns early at frozenDepth > 0 and
 * beginSimulationStep cannot roll, so a frozen pass reads `prev` and writes
 * nothing (core/simulation_history.js).
 *
 * AND THE VIDEO EXPORT IS NOT AN EXCEPTION TO THIS, WHICH IS WHY IT STILL MOVES.
 * A movie's frames come through here too (web/transitionRender.js's letterbox
 * renderer → renderTransitionFrame → this), so freezing here would freeze an
 * export if this were the only evaluation. It is not: createLetterboxFrameRenderer
 * evaluates the state ITSELF, for the camera rect, BEFORE it asks for pixels
 * (transitionRender.js:260) — one unfrozen pass per sub-frame, at the controlled
 * time the sampler has just set, and evaluateState advances every slot in the
 * document, not just the camera's. That pass is the export's single advancing
 * consumer; this one re-reads the same step and agrees with it exactly (same
 * `prev`, same `dt`). The ORDER is load-bearing — pinned by
 * tests/simulated_export_test.js.
 *
 * @example // renderCameraFrame(doc, {slideIndex: 0, alpha: 1, registry, width: 256, height: 144, project: "RobotSim"}) → Promise<canvas>
 * @example // renderCameraFrame(doc, {slideIndex: 0, registry, width: 96, height: 54, quality: "proxy", project: "RobotSim"}) → cheap thumbnail
 */
export function renderCameraFrame(doc, { slideIndex, alpha = 1, registry, width, height, quality = "full", project = "" }) {
  return renderJob(width, height, () => withSimulationFrozen(() => {
    const state = evaluatedStateAt(doc, slideIndex, alpha, registry);
    const rect = cameraRect(state, doc.meta);
    return {
      view: fitRectView(rect, width, height, 1),
      background: parseColor(rect.background),
      ir: cameraFrameIR(state, doc.meta, registry, { project }),
      // PROXY skips the dither final pass entirely (dither:null ⇒ renderWithDither
      // stays on the direct 8-bit paint — no RGBA16F intermediate). FULL keeps THE
      // camera's dither settings, byte-identical to before.
      dither: quality === "proxy" ? null : cameraDither(state),
      antialias: antialiasCoverage(cameraAntialias(state)), // THE camera's coverage-AA → setAntiAlias
      quality,
    };
  }));
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
